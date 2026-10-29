import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { Controller } from '../controller.mjs';
import { GitHubRegistration, GitHubRegistrationTransport, bridgeGitHubRepositoryId } from '../github-registration.mjs';
import { repoGit, registrationProcess, repositoryIdentity, readRegistry, resolveRepository, withRegistryLock, writeRegistry } from '../repositories.mjs';
import { synchronizeCheckout } from '../github-repository-integrity.mjs';
import { GitHubPublisher } from '../publication.mjs';
import { createServer } from '../server.mjs';
import { FakeAPI, FakeExecutor } from './helpers.mjs';
import { checkoutSnapshot, compareSnapshots } from '../review-evidence.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const input = { repository: 'owner/fixture' };
async function setup(context, changes = {}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'pab-registration-test-')), upstream = path.join(root, 'upstream');
  await fs.mkdir(upstream, { mode: 0o700 });
  repoGit(upstream, 'init', '--template=', '--initial-branch=main');
  await fs.writeFile(path.join(upstream, 'answer.txt'), 'baseline\n');
  repoGit(upstream, 'add', '.');
  repoGit(upstream, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture');
  const baseline = repoGit(upstream, 'rev-parse', 'HEAD').trim(), calls = [];
  const metadata = { id: 1234, full_name: input.repository, owner: { id: 12, login: 'owner', type: 'User' },
    private: false, permissions: { pull: true }, archived: false, disabled: false, default_branch: 'main', size: 1 };
  const transport = {
    api(endpoint) {
      calls.push(endpoint);
      if (endpoint === 'user') return { id: 12, login: 'owner', type: 'User' };
      if (endpoint.endsWith('/commits/main')) return { sha: repoGit(upstream, 'rev-parse', 'HEAD').trim() };
      return structuredClone(metadata);
    },
    fetch(directory, target, signal, commit) {
      calls.push('fetch');
      repoGit(directory, '-c', 'protocol.file.allow=always', 'fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', upstream, commit ?? `refs/heads/${target.default_branch}:refs/remotes/origin/${target.default_branch}`);
    },
  };
  const config = { stateRoot: path.join(root, 'state'), workspaceRoot: path.join(root, 'tasks'), secrets: [], executor: new FakeExecutor(),
    registrationFactory: options => new GitHubRegistration({ ...options, root: path.join(root, 'managed'), transport, ...changes }),
    localBackendFactory: options => ({
      async run() {
        const identity = { model: 'mock', threadId: 'mock-thread', turnId: 'mock-turn', turnSubmissionAttempted: true, turnSubmissionAcknowledged: true, terminalObserved: true };
        options.onLifecycle({ ...identity, phase: 'turn_acknowledged' });
        options.onLifecycle({ ...identity, phase: 'terminal_observed', status: 'completed' });
        return { ...identity, status: 'completed', authentication: 'chatgpt', uncertainties: [], commands: [], messages: [] };
      }, async close() { return true; }, async cancel() {},
    }),
  };
  const controller = await new Controller(config).init();
  context.after(async () => { await controller.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, upstream, baseline, metadata, transport, calls, config, controller, file: path.join(config.stateRoot, 'repositories.json'), destination: path.join(root, 'managed/github_1234') };
}

test('F1 real registration subprocess does not delay unrelated Controller cleanup', async context => {
  const value = await setup(context);
  await writeRegistry(value.file, { version: 1, repositories: { legacy: await repositoryIdentity(value.upstream) } });
  const task = await value.controller.start({ repository_id: 'legacy', execution_backend: 'local_codex', request_id: 'concurrent_cleanup',
    contract: { goal: 'Mock task', allowed_files: ['answer.txt'], requirements: [{ id: 'ANSWER', text: 'fixture' }], invariants: [], test_commands: [], initial_files: {} } });
  await Promise.all([...value.controller.jobs.values()]);
  let cleanupObserved = false;
  const cleanup = new Promise(resolve => setTimeout(() => {
    value.controller.cleanup({ task_id: task.task_id }).then(() => { cleanupObserved = true; resolve(); });
  }, 30));
  const transport = new GitHubRegistrationTransport();
  let active = false;
  transport.run = async (...args) => { active = true; const result = await registrationProcess('/bin/sh', ['-c', 'sleep 0.4; printf "{}"'], args[2]); active = false; return result; };
  const original = value.transport.api;
  value.transport.api = async endpoint => { if (endpoint === 'user') await transport.api('user'); return original(endpoint); };
  const registration = value.controller.registerGitHubRepository(input);
  await cleanup;
  assert.equal(cleanupObserved, true);
  assert.equal(active, true);
  await registration;
});

test('F1 shutdown cancels a real registration process group, settles auditing and prevents descendant writes', async context => {
  const value = await setup(context), marker = path.join(value.root, 'late-write');
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  value.transport.fetch = async (directory, target, signal) => {
    const running = registrationProcess('/bin/sh', ['-c', '(sleep 0.5; touch "$1") & wait', 'fixture', marker], {
      cwd: directory, env: { PATH: '/usr/bin:/bin' }, signal, timeout: 2000,
    });
    started(); await running;
  };
  const registration = assert.rejects(value.controller.invoke('register_github_repository', input, {}, args => value.controller.registerGitHubRepository(args)), /REGISTRATION_INTERRUPTED/);
  await ready;
  assert.equal(JSON.parse(value.controller.db.prepare('SELECT value FROM audit').get().value).registration_outcome, 'uncertain');
  const before = Date.now(); await value.controller.close(); await registration;
  assert(Date.now() - before < 1500);
  await new Promise(resolve => setTimeout(resolve, 600));
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
  assert.deepEqual((await readRegistry(value.file)).repositories, {});
  const restarted = await new Controller(value.config).init();
  try {
    const audit = JSON.parse(restarted.db.prepare('SELECT value FROM audit').get().value);
    assert.equal(audit.registration_outcome, 'failure');
    assert.equal(audit.registration_diagnostic, 'REGISTRATION_INTERRUPTED');
  } finally { await restarted.close(); }
});

test('F1 bounded output terminates a real subprocess without retaining its error text', async () => {
  await assert.rejects(registrationProcess('/bin/sh', ['-c', 'printf secret; sleep 10'], {
    env: { PATH: '/usr/bin:/bin' }, maxBuffer: 3, timeout: 2000,
  }), error => error.code === 'REGISTRATION_OUTPUT_LIMIT' && !String(error).includes('secret'));
});

test('F1 uncertain process termination retains the registry lock for inspection', async context => {
  const value = await setup(context);
  await assert.rejects(withRegistryLock(value.file, async () => { throw Object.assign(Error('uncertain'), { code: 'REGISTRATION_TERMINATION_UNCERTAIN' }); }));
  await assert.rejects(value.controller.registerGitHubRepository(input), /REPOSITORY_REGISTRY_BUSY/);
  assert((await fs.stat(`${value.file}.lock`)).isDirectory());
});

for (const damage of ['blob', 'file']) test(`F2 retry and discovery reject missing ${damage}`, async context => {
  const value = await setup(context); await value.controller.registerGitHubRepository(input);
  if (damage === 'file') await fs.unlink(path.join(value.destination, 'answer.txt'));
  else {
    const blob = repoGit(value.destination, 'rev-parse', 'HEAD:answer.txt').trim();
    await fs.unlink(path.join(value.destination, '.git/objects', blob.slice(0, 2), blob.slice(2)));
  }
  await assert.rejects(value.controller.registerGitHubRepository(input));
  assert.equal((await value.controller.listRegisteredRepositories()).repositories[0].status, 'unavailable');
});

test('F3 historical symlink baseline is rejected before task materialization', async context => {
  const value = await setup(context);
  await fs.symlink('/etc/passwd', path.join(value.upstream, 'historical'));
  repoGit(value.upstream, 'add', '.');
  repoGit(value.upstream, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'historical symlink');
  const historical = repoGit(value.upstream, 'rev-parse', 'HEAD').trim();
  repoGit(value.upstream, 'rm', 'historical');
  repoGit(value.upstream, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'safe tip');
  await value.controller.registerGitHubRepository(input);
  await assert.rejects(resolveRepository(value.file, 'github_1234', historical, value.config.workspaceRoot, value.config.stateRoot), /REGISTRATION_UNSUPPORTED_ENTRY/);
  await assert.rejects(value.controller.start({ repository_id: 'github_1234', base_ref: historical, execution_backend: 'local_codex', request_id: 'historical_rejected',
    contract: { goal: 'Mock task', allowed_files: ['answer.txt'], requirements: [{ id: 'ANSWER', text: 'fixture' }], invariants: [], test_commands: [], initial_files: {} } }), /REGISTRATION_UNSUPPORTED_ENTRY/);
  assert.equal(value.controller.db.prepare('SELECT count(*) AS count FROM tasks').get().count, 0);
  assert.equal(value.controller._api, undefined);
});

test('F4 distinct legacy origin prefix does not conflict', async context => {
  const value = await setup(context);
  repoGit(value.upstream, 'remote', 'add', 'origin', 'https://github.com/owner/fixture-extra.git');
  await writeRegistry(value.file, { version: 1, repositories: { legacy: await repositoryIdentity(value.upstream) } });
  assert.equal((await value.controller.registerGitHubRepository(input)).status, 'registered');
});

test('F5 denied registration records requested identity and Controller outcome', async context => {
  const value = await setup(context); value.metadata.owner.id = 987;
  await assert.rejects(value.controller.invoke('register_github_repository', input, {}, args => value.controller.registerGitHubRepository(args)));
  const audit = JSON.parse(value.controller.db.prepare('SELECT value FROM audit').get().value);
  assert.equal(audit.role, 'controller');
  assert.equal(audit.requested_repository, input.repository);
  assert.equal(audit.registration_outcome, 'denied');
});

for (const damage of ['contents', 'mode', 'unexpected_file', 'missing_storage', 'corrupt_object', 'alternate', 'index', 'git_symlink']) {
  test(`F2 exact checkout revalidation rejects ${damage} without repairing it`, async context => {
    const value = await setup(context); await value.controller.registerGitHubRepository(input);
    if (damage === 'contents') await fs.writeFile(path.join(value.destination, 'answer.txt'), 'changed!\n');
    if (damage === 'mode') await fs.chmod(path.join(value.destination, 'answer.txt'), 0o755);
    if (damage === 'unexpected_file') await fs.writeFile(path.join(value.destination, 'extra'), 'unexpected');
    if (damage === 'missing_storage') await fs.rm(path.join(value.destination, '.git/objects'), { recursive: true });
    if (damage === 'corrupt_object') {
      const blob = repoGit(value.destination, 'rev-parse', 'HEAD:answer.txt').trim();
      const file = path.join(value.destination, '.git/objects', blob.slice(0, 2), blob.slice(2));
      await fs.chmod(file, 0o600); await fs.writeFile(file, 'corrupt');
    }
    if (damage === 'alternate') await fs.writeFile(path.join(value.destination, '.git/objects/info/alternates'), `${value.upstream}/.git/objects\n`);
    if (damage === 'index') await fs.writeFile(path.join(value.destination, '.git/index'), 'corrupt');
    if (damage === 'git_symlink') {
      await fs.rename(path.join(value.destination, '.git/objects'), path.join(value.root, 'moved-objects'));
      await fs.symlink(path.join(value.root, 'moved-objects'), path.join(value.destination, '.git/objects'));
    }
    const registry = await fs.readFile(value.file);
    await assert.rejects(value.controller.registerGitHubRepository(input));
    assert.equal((await value.controller.listRegisteredRepositories()).repositories[0].status, 'unavailable');
    assert.deepEqual(await fs.readFile(value.file), registry);
    assert.equal(value.calls.filter(call => call === 'fetch').length, 1);
  });
}

test('F2 missing fetched blob cannot reach registry publication', async context => {
  const value = await setup(context), fetch = value.transport.fetch;
  value.transport.fetch = async (directory, target) => {
    await fetch(directory, target);
    const blob = repoGit(directory, 'rev-parse', 'refs/remotes/origin/main:answer.txt').trim();
    await fs.unlink(path.join(directory, '.git/objects', blob.slice(0, 2), blob.slice(2)));
  };
  await assert.rejects(value.controller.registerGitHubRepository(input));
  assert.deepEqual((await readRegistry(value.file)).repositories, {});
  assert((await fs.stat(path.join(value.root, 'managed/.stage-github_1234'))).isDirectory());
});

for (const boundary of ['sync', 'after_sync', 'rename', 'after_rename']) test(`F2 failure at ${boundary} retains untrusted state without registry publication`, async context => {
  const changes = {};
  if (boundary === 'sync') changes.synchronize = (directory, signal) => synchronizeCheckout(directory, signal, async handle => { await handle.close(); await handle.sync(); });
  if (boundary === 'after_sync') changes.synchronize = async (directory, signal) => { await synchronizeCheckout(directory, signal); await fs.unlink(path.join(directory, 'answer.txt')); };
  if (boundary === 'rename') changes.publish = async () => { throw Error('interrupted before rename'); };
  if (boundary === 'after_rename') changes.publish = async (stage, destination) => { await fs.rename(stage, destination); throw Error('directory sync failed'); };
  const value = await setup(context, changes);
  await assert.rejects(value.controller.registerGitHubRepository(input));
  assert.deepEqual((await readRegistry(value.file)).repositories, {});
  const retained = boundary === 'after_rename' ? value.destination : path.join(value.root, 'managed/.stage-github_1234');
  assert((await fs.stat(retained)).isDirectory());
  await assert.rejects(value.controller.registerGitHubRepository(input), /REGISTRATION_(INCOMPLETE_REQUIRES_INSPECTION|DESTINATION_EXISTS)/);
});

test('F2 synchronization precedes checkout publication and atomic registry publication', async context => {
  const order = [];
  const value = await setup(context, {
    synchronize: async (...args) => { await synchronizeCheckout(...args); order.push('synced'); },
    publish: async (stage, destination) => {
      assert.deepEqual(order, ['synced']); await fs.rename(stage, destination);
      const handle = await fs.open(path.dirname(destination), 'r'); try { await handle.sync(); } finally { await handle.close(); }
      order.push('published_checkout');
    },
    commitRegistry: async (file, registry) => { assert.deepEqual(order, ['synced', 'published_checkout']); await writeRegistry(file, registry); order.push('registry'); },
  });
  await value.controller.registerGitHubRepository(input);
  assert.deepEqual(order, ['synced', 'published_checkout', 'registry']);
});

test('F3 safe historical baselines retain legitimate base_ref functionality', async context => {
  const value = await setup(context);
  await fs.writeFile(path.join(value.upstream, 'answer.txt'), 'new tip\n'); repoGit(value.upstream, 'add', '.');
  repoGit(value.upstream, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'tip');
  await value.controller.registerGitHubRepository(input);
  const resolved = await resolveRepository(value.file, 'github_1234', value.baseline, value.config.workspaceRoot, value.config.stateRoot);
  assert.equal(resolved.baseline_commit, value.baseline);
});

for (const origin of ['https://github.com/OWNER/fixture.git', 'git@github.com:owner/fixture', 'ssh://git@github.com/owner/fixture.git', 'https://GITHUB.COM/owner/fixture.git']) {
  test(`F4 exact normalized legacy duplicate rejected: ${origin}`, async context => {
    const value = await setup(context);
    repoGit(value.upstream, 'remote', 'add', 'origin', origin);
    await writeRegistry(value.file, { version: 1, repositories: { legacy: await repositoryIdentity(value.upstream) } });
    await assert.rejects(value.controller.registerGitHubRepository(input), /GITHUB_REPOSITORY_ALREADY_LOCAL/);
  });
}

for (const outcome of ['success', 'interrupted', 'uncertain', 'invalid']) test(`F5 sanitized Controller audit for ${outcome}`, async context => {
  const value = await setup(context, outcome === 'uncertain' ? { commitRegistry: async (file, registry) => { await writeRegistry(file, registry); throw Error('secret /private/path'); } } : {});
  if (outcome === 'interrupted') value.controller.registration.cancel();
  const args = outcome === 'invalid' ? { repository: '/private/secret' } : input;
  const call = value.controller.invoke('register_github_repository', args, {}, supplied => value.controller.registerGitHubRepository(supplied));
  if (outcome === 'success') await call; else await assert.rejects(call);
  const audit = JSON.parse(value.controller.db.prepare('SELECT value FROM audit').get().value);
  assert.equal(audit.role, 'controller');
  assert.equal(audit.requested_repository, outcome === 'invalid' ? null : input.repository);
  assert.equal(audit.registration_outcome, { success: 'success', interrupted: 'failure', uncertain: 'uncertain', invalid: 'denied' }[outcome]);
  if (outcome === 'interrupted') assert.equal(audit.registration_diagnostic, 'REGISTRATION_INTERRUPTED');
  if (outcome === 'uncertain') assert.equal(audit.registration_diagnostic, 'REGISTRATION_PUBLICATION_UNCERTAIN');
  assert(!JSON.stringify(audit).includes('secret')); assert(!JSON.stringify(audit).includes(value.root));
});

for (const privateRepository of [false, true]) test(`authorized ${privateRepository ? 'private' : 'public'} repository registers an exact baseline with no inference client`, async context => {
  const value = await setup(context); value.metadata.private = privateRepository;
  const result = await value.controller.registerGitHubRepository(input);
  assert.equal(result.status, 'registered'); assert.equal(result.repository_id, 'github_1234');
  assert.equal(result.github_repository.private, privateRepository); assert.equal(result.baseline_commit, value.baseline);
  assert.equal(value.controller._api, undefined); assert.equal(value.controller.db.prepare('SELECT count(*) AS count FROM tasks').get().count, 0);
  assert.equal((await fs.stat(value.file)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(value.destination))).mode & 0o777, 0o700);
  const resolved = await resolveRepository(value.file, result.repository_id, 'HEAD', value.config.workspaceRoot, value.config.stateRoot);
  assert.equal(resolved.github_identity.repository_id, 1234); assert.equal(resolved.baseline_commit, value.baseline);
  const discovery = await value.controller.listRegisteredRepositories();
  assert.equal(discovery.repositories[0].github_repository.full_name, input.repository);
  assert(!JSON.stringify(discovery).includes(value.root));
  assert.equal(repoGit(value.destination, 'remote', 'get-url', 'origin').trim(), 'https://github.com/owner/fixture.git');
});

for (const kind of ['other_owner', 'organization', 'collaborator', 'identity_mismatch', 'missing_identity', 'access', 'self', 'archived', 'branch', 'empty', 'large']) {
  test(`authorization rejects ${kind} before fetch or registration`, async context => {
    const value = await setup(context), original = value.transport.api;
    if (kind === 'other_owner') value.metadata.owner.id = 14;
    if (kind === 'organization') value.metadata.owner.type = 'Organization';
    if (kind === 'collaborator') value.metadata.owner = { id: 14, login: 'owner', type: 'User' };
    if (kind === 'identity_mismatch') value.metadata.full_name = 'owner/different';
    if (kind === 'missing_identity') value.metadata.id = '1234';
    if (kind === 'access') value.transport.api = () => { throw Error('secret-access-token'); };
    if (kind === 'self') value.metadata.id = bridgeGitHubRepositoryId;
    if (kind === 'archived') value.metadata.archived = true;
    if (kind === 'branch') value.metadata.default_branch = '../../bad';
    if (kind === 'empty') value.transport.api = endpoint => endpoint.includes('/commits/') ? {} : original(endpoint);
    if (kind === 'large') value.metadata.size = 999999;
    await assert.rejects(value.controller.registerGitHubRepository(input), error => !String(error).includes('secret-access-token'));
    assert.equal(value.calls.includes('fetch'), false);
    assert.deepEqual((await readRegistry(value.file)).repositories, {});
    assert.equal(value.controller._api, undefined);
  });
}

test('invalid identifiers and extra filesystem/credential arguments never reach GitHub', async context => {
  const value = await setup(context);
  for (const repository of ['../repo', '/tmp/repo', 'https://github.com/owner/fixture', 'owner/..', 'owner/.', 'owner/repo.git', 'owner/repo\n', 'owner/repo;id', 'owner/repo/extra', '-owner/repo']) {
    await assert.rejects(value.controller.registerGitHubRepository({ repository }), /INVALID_GITHUB_REPOSITORY/);
  }
  for (const extra of ['path', 'token', 'clone_url', 'args', 'root']) await assert.rejects(value.controller.registerGitHubRepository({ ...input, [extra]: 'secret' }), /INVALID_GITHUB_REPOSITORY/);
  assert.deepEqual(value.calls, []);
});

test('concurrent identical requests are serialized and restart returns existing verified registration', async context => {
  const value = await setup(context);
  const results = await Promise.all(Array.from({ length: 4 }, () => value.controller.registerGitHubRepository(input)));
  assert.deepEqual(results.map(result => result.status), ['registered', 'already_registered', 'already_registered', 'already_registered']);
  assert.equal(value.calls.filter(call => call === 'fetch').length, 1);
  await value.controller.close();
  const restarted = await new Controller(value.config).init();
  try {
    assert.equal((await restarted.registerGitHubRepository(input)).status, 'already_registered');
    assert.equal(value.calls.filter(call => call === 'fetch').length, 1);
    assert.equal(restarted._api, undefined);
  } finally { await restarted.close(); }
});

test('registry lock excludes other processes and crash leftovers require inspection without replay', async context => {
  const value = await setup(context);
  await withRegistryLock(value.file, async () => {
    await assert.rejects(value.controller.registerGitHubRepository(input), /REPOSITORY_REGISTRY_BUSY/);
    await assert.rejects(withRegistryLock(value.file, () => assert.fail('must not enter')), /REPOSITORY_REGISTRY_BUSY/);
  });
  await fs.mkdir(`${value.file}.lock`, { mode: 0o700 });
  await value.controller.close();
  const restarted = await new Controller(value.config).init();
  try { await assert.rejects(restarted.registerGitHubRepository(input), /REPOSITORY_REGISTRY_BUSY/); }
  finally { await restarted.close(); }
  assert.equal(value.calls.includes('fetch'), false);
});

test('concurrent distinct registrations preserve both identities without lost registry updates', async context => {
  const value = await setup(context), api = value.transport.api;
  value.transport.api = endpoint => endpoint === 'repos/owner/second' ? { ...value.metadata, id: 5678, full_name: 'owner/second' } : api(endpoint);
  const results = await Promise.all([value.controller.registerGitHubRepository(input), value.controller.registerGitHubRepository({ repository: 'owner/second' })]);
  assert.deepEqual(results.map(result => result.repository_id), ['github_1234', 'github_5678']);
  assert.deepEqual(Object.keys((await readRegistry(value.file)).repositories).sort(), ['github_1234', 'github_5678']);
  assert.equal(value.calls.filter(call => call === 'fetch').length, 2);
});

test('interrupted clone retains a quarantined stage, never trusts or reuses it', async context => {
  const value = await setup(context);
  value.transport.fetch = directory => { repoGit(directory, 'config', 'fixture.incomplete', 'true'); throw Error('private stderr'); };
  await assert.rejects(value.controller.registerGitHubRepository(input), /^Error: REPOSITORY_REGISTRATION_FAILED$/);
  assert.deepEqual((await readRegistry(value.file)).repositories, {});
  const stage = path.join(value.root, 'managed/.stage-github_1234');
  assert((await fs.stat(stage)).isDirectory());
  await assert.rejects(value.controller.registerGitHubRepository(input), /REGISTRATION_INCOMPLETE_REQUIRES_INSPECTION/);
});

test('failed registry publication retains an unregistered destination and never silently adopts it', async context => {
  const value = await setup(context, { commitRegistry: async () => { throw Error('disk error secret'); } });
  await assert.rejects(value.controller.registerGitHubRepository(input), /REGISTRATION_PUBLICATION_UNCERTAIN/);
  assert.deepEqual((await readRegistry(value.file)).repositories, {});
  assert((await fs.stat(value.destination)).isDirectory());
  await assert.rejects(value.controller.registerGitHubRepository(input), /REGISTRATION_DESTINATION_EXISTS/);
});

test('lost registry-write acknowledgement reconciles only a complete matching registration', async context => {
  const value = await setup(context, { commitRegistry: async (file, registry) => { await writeRegistry(file, registry); throw Error('fsync outcome unavailable'); } });
  await assert.rejects(value.controller.registerGitHubRepository(input));
  assert.equal((await value.controller.registerGitHubRepository(input)).status, 'already_registered');
  assert.equal(value.calls.filter(call => call === 'fetch').length, 1);
});

for (const kind of ['directory', 'symlink', 'root_symlink', 'unsafe_root', 'overlap']) test(`provisioning rejects ${kind} without touching existing content`, async context => {
  const value = await setup(context), managed = path.join(value.root, 'managed');
  await fs.writeFile(path.join(value.upstream, 'untouched'), 'owner work');
  if (kind === 'root_symlink') await fs.symlink(value.upstream, managed);
  else if (kind === 'overlap') value.controller.registration.root = value.config.stateRoot;
  else {
    await fs.mkdir(managed, { mode: kind === 'unsafe_root' ? 0o755 : 0o700 });
    if (kind === 'directory') await fs.mkdir(value.destination);
    if (kind === 'symlink') await fs.symlink(value.upstream, value.destination);
  }
  await assert.rejects(value.controller.registerGitHubRepository(input));
  assert.equal(await fs.readFile(path.join(value.upstream, 'untouched'), 'utf8'), 'owner work');
  assert.equal(value.calls.includes('fetch'), false);
  assert.deepEqual((await readRegistry(value.file)).repositories, {});
});

test('registration preserves legacy records and rejects a colliding logical ID', async context => {
  const value = await setup(context), legacy = await repositoryIdentity(value.upstream);
  await writeRegistry(value.file, { version: 1, repositories: { legacy } });
  await value.controller.registerGitHubRepository(input);
  assert.deepEqual((await readRegistry(value.file)).repositories.legacy, legacy);
  const list = await value.controller.listRegisteredRepositories();
  assert.equal(list.repositories.find(entry => entry.repository_id === 'legacy').diagnostics[0], 'LOCAL_OPERATOR_REGISTRATION');
  const registry = await readRegistry(value.file); delete registry.github_repositories; await writeRegistry(value.file, registry);
  await assert.rejects(value.controller.registerGitHubRepository(input), /GITHUB_REGISTRATION_CONFLICT/);
});

test('existing host registration of the same GitHub origin is not silently duplicated', async context => {
  const value = await setup(context);
  repoGit(value.upstream, 'remote', 'add', 'origin', 'git@github.com:owner/fixture.git');
  await writeRegistry(value.file, { version: 1, repositories: { legacy: await repositoryIdentity(value.upstream) } });
  await assert.rejects(value.controller.registerGitHubRepository(input), /GITHUB_REPOSITORY_ALREADY_LOCAL/);
  assert.equal((await value.controller.listRegisteredRepositories()).repositories[0].github_repository.full_name, input.repository);
});

for (const mutation of ['origin', 'baseline', 'directory', 'remote_id', 'owner_transfer']) test(`duplicate rejects changed ${mutation}`, async context => {
  const value = await setup(context); await value.controller.registerGitHubRepository(input);
  if (mutation === 'origin') repoGit(value.destination, 'remote', 'set-url', 'origin', 'https://github.com/owner/elsewhere.git');
  if (mutation === 'baseline') repoGit(value.destination, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'changed');
  if (mutation === 'directory') { await fs.rename(value.destination, `${value.destination}-old`); await fs.mkdir(value.destination); }
  if (mutation === 'remote_id') value.metadata.id = 4567;
  if (mutation === 'owner_transfer') value.metadata.owner.id = 45;
  await assert.rejects(value.controller.registerGitHubRepository(input));
  assert.equal(value.calls.filter(call => call === 'fetch').length, 1);
});

test('identity changes during provisioning and changed remote baseline fail before registry publication', async context => {
  const value = await setup(context), fetch = value.transport.fetch;
  value.transport.fetch = (...args) => { fetch(...args); value.metadata.id = 77; };
  await assert.rejects(value.controller.registerGitHubRepository(input), /GITHUB_REGISTRATION_IDENTITY_CHANGED/);
  assert.deepEqual((await readRegistry(value.file)).repositories, {});
});

test('API baseline must match actual fetched Git object identity', async context => {
  const value = await setup(context), api = value.transport.api;
  value.transport.api = endpoint => endpoint.includes('/commits/') ? { sha: 'a'.repeat(40) } : api(endpoint);
  await assert.rejects(value.controller.registerGitHubRepository(input), /GITHUB_REGISTRATION_BASELINE_CHANGED/);
  assert.deepEqual((await readRegistry(value.file)).repositories, {});
});

for (const kind of ['symlink', 'submodule']) test(`untrusted ${kind} tree is rejected without checkout`, async context => {
  const value = await setup(context);
  if (kind === 'symlink') { await fs.symlink('/etc/passwd', path.join(value.upstream, 'outside')); repoGit(value.upstream, 'add', '.'); }
  else repoGit(value.upstream, 'update-index', '--add', '--cacheinfo', `160000,${value.baseline},nested`);
  repoGit(value.upstream, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'unsupported');
  await assert.rejects(value.controller.registerGitHubRepository(input), /REGISTRATION_UNSUPPORTED_ENTRY/);
  assert.deepEqual((await readRegistry(value.file)).repositories, {});
});

test('remote contents, global filters, hooks and templates are not executed during provisioning', async context => {
  const value = await setup(context), marker = path.join(value.root, 'executed'), config = path.join(value.root, 'gitconfig');
  const hooks = path.join(value.root, 'hooks'); await fs.mkdir(hooks);
  await fs.writeFile(path.join(hooks, 'post-checkout'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
  await fs.writeFile(config, `[core]\n hooksPath = ${hooks}\n[filter "hostile"]\n smudge = touch '${marker}'\n required = true\n[init]\n templateDir = ${hooks}\n`);
  await fs.writeFile(path.join(value.upstream, '.gitattributes'), '*.txt filter=hostile\n');
  await fs.writeFile(path.join(value.upstream, '.gitmodules'), '[submodule "evil"]\n path = nested\n url = https://invalid.example/evil\n');
  await fs.writeFile(path.join(value.upstream, 'package.json'), '{"scripts":{"postinstall":"touch should-not-exist"}}');
  repoGit(value.upstream, 'add', '.'); repoGit(value.upstream, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'hostile content');
  const oldConfig = process.env.GIT_CONFIG_GLOBAL, oldTemplate = process.env.GIT_TEMPLATE_DIR;
  process.env.GIT_CONFIG_GLOBAL = config; process.env.GIT_TEMPLATE_DIR = hooks;
  try { await value.controller.registerGitHubRepository(input); }
  finally {
    if (oldConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = oldConfig;
    if (oldTemplate === undefined) delete process.env.GIT_TEMPLATE_DIR; else process.env.GIT_TEMPLATE_DIR = oldTemplate;
  }
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(value.destination, 'should-not-exist')), { code: 'ENOENT' });
  assert.equal(repoGit(value.destination, 'config', '--local', '--list').includes('credential'), false);
  assert.equal(await fs.readFile(path.join(value.destination, 'answer.txt'), 'utf8'), 'baseline\n');
});

test('transport restricts executable/URL/protocol/environment and suppresses credential-bearing errors', async () => {
  const calls = [], transport = new GitHubRegistrationTransport((binary, args, options) => { calls.push({ binary, args, options }); return '{}'; });
  const old = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'must-not-leave-controller';
  try { await transport.api('user'); await transport.fetch('/trusted/stage', { full_name: 'owner/fixture', default_branch: 'main' }); }
  finally { if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old; }
  assert.equal(calls[0].binary, '/usr/bin/gh'); assert(calls[0].args.includes('GET'));
  const fetch = calls[1]; assert.equal(fetch.binary, '/usr/bin/git');
  for (const flag of ['--no-recurse-submodules', 'http.followRedirects=false', 'protocol.allow=never', 'protocol.https.allow=always', 'core.hooksPath=/dev/null']) assert(fetch.args.includes(flag));
  assert.equal(fetch.options.env.OPENAI_API_KEY, undefined); assert.equal(fetch.options.env.SSH_AUTH_SOCK, undefined);
  assert.equal(fetch.options.env.GIT_CONFIG_GLOBAL, '/dev/null'); assert.equal(fetch.options.env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(fetch.options.timeout, 120000);
  const failing = new GitHubRegistrationTransport(() => { throw Error('secret ghp_never_expose'); });
  await assert.rejects(failing.api('user'), /^Error: GITHUB_REGISTRATION_ACCESS_UNAVAILABLE$/);
  await assert.rejects(failing.fetch('/trusted', { full_name: 'owner/fixture', default_branch: 'main' }), /^Error: GITHUB_REGISTRATION_FETCH_FAILED$/);
});

test('fetch timeout kills the synthetic helper group without leaving a later writer', async context => {
  const value = await setup(context), marker = path.join(value.root, 'late-helper-write');
  const transport = new GitHubRegistrationTransport((binary, args, options) => {
    assert.equal(binary, '/usr/bin/git');
    return registrationProcess('/bin/sh', ['-c', '(sleep 0.4; touch "$1") & wait', 'fixture', marker], { ...options, timeout: 100 });
  });
  await assert.rejects(transport.fetch(value.root, { full_name: input.repository, default_branch: 'main' }), /GITHUB_REGISTRATION_FETCH_FAILED/);
  await new Promise(resolve => setTimeout(resolve, 600));
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
});

test('remote registration integrates with isolated local start_task and publication identity checks', async context => {
  const value = await setup(context), registered = await value.controller.registerGitHubRepository(input);
  const before = repoGit(value.destination, 'show-ref');
  const started = await value.controller.start({ repository_id: registered.repository_id, execution_backend: 'local_codex', request_id: 'remote_registered_start',
    contract: { goal: 'Offline mock fixture', allowed_files: ['answer.txt'], requirements: [{ id: 'ANSWER', text: 'fixture' }], invariants: [], test_commands: [], initial_files: {} } });
  await Promise.all([...value.controller.jobs.values()]);
  const task = value.controller.task(started.task_id);
  assert.equal(task.implementer.state, 'completed'); assert.equal(task.baseline, value.baseline);
  assert.equal(task.repository.github_identity.repository_id, 1234); assert.equal(value.controller._api, undefined);
  const worktree = path.join(value.config.workspaceRoot, task.id, 'repo');
  assert.equal(repoGit(worktree, 'remote'), ''); assert.equal(repoGit(value.destination, 'show-ref'), before);
  assert.equal(repoGit(worktree, 'rev-parse', 'HEAD').trim(), value.baseline);
  const publisher = new GitHubPublisher(); publisher.api = () => value.metadata;
  assert.equal((await publisher.target(task.repository)).repository, input.repository);
  value.metadata.id = 777;
  await assert.rejects(publisher.target(task.repository), /PUBLICATION_GITHUB_IDENTITY_CHANGED/);
});

test('MCP tools enforce tunnel authorization and strict schemas, return no host paths and audit registration', async context => {
  const value = await setup(context); let authorized = false;
  const server = createServer(value.controller, async () => { if (!authorized) throw Error('secret'); });
  const client = new Client({ name: 'registration-offline', version: '1' }), [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  context.after(async () => { await client.close(); await server.close(); });
  assert.equal((await client.callTool({ name: 'register_github_repository', arguments: input })).isError, true);
  assert.equal(value.calls.length, 0); authorized = true;
  for (const name of ['register_github_repository', 'list_registered_repositories']) {
    const argumentsValue = name === 'register_github_repository' ? { ...input, path: '/etc' } : { path: '/etc' };
    assert.equal((await client.callTool({ name, arguments: argumentsValue })).isError, true);
  }
  const response = await client.callTool({ name: 'register_github_repository', arguments: input });
  assert.equal(response.isError, undefined); assert.equal(response.structuredContent.repository_id, 'github_1234');
  assert(!JSON.stringify(response).includes(value.root));
  const listed = await client.callTool({ name: 'list_registered_repositories', arguments: {} });
  assert.equal(listed.structuredContent.repositories.length, 1);
  const audit = value.controller.db.prepare('SELECT value FROM audit').all().map(row => JSON.parse(row.value));
  assert(audit.some(record => record.tool === 'register_github_repository'));
  assert.equal(value.controller._api, undefined);
});

test('atomic registry writes preserve the original on overflow and reject unsafe parent locks', async context => {
  const value = await setup(context);
  const registry = { version: 1, repositories: { legacy: await repositoryIdentity(value.upstream) } };
  await writeRegistry(value.file, registry); const bytes = await fs.readFile(value.file);
  await assert.rejects(writeRegistry(value.file, { ...registry, oversized: 'x'.repeat(65536) }), /REPOSITORY_REGISTRY_LIMIT/);
  assert.deepEqual(await fs.readFile(value.file), bytes);
  await fs.chmod(value.config.stateRoot, 0o755);
  await assert.rejects(value.controller.registerGitHubRepository(input), /UNSAFE_REPOSITORY_REGISTRY/);
  await fs.chmod(value.config.stateRoot, 0o700);
});

test('registry symlink is rejected without changing its target', async context => {
  const value = await setup(context), target = path.join(value.root, 'do-not-touch');
  await fs.writeFile(target, '{"version":1,"repositories":{}}', { mode: 0o600 });
  await fs.symlink(target, value.file);
  const before = await fs.readFile(target);
  await assert.rejects(value.controller.registerGitHubRepository(input), /UNSAFE_REPOSITORY_REGISTRY/);
  assert.deepEqual(await fs.readFile(target), before); assert.equal(value.calls.includes('fetch'), false);
});

test('source and task roots cannot be selected even by trusted registrar configuration', async context => {
  const value = await setup(context);
  for (const root of [path.resolve('.'), value.config.workspaceRoot]) {
    value.controller.registration.root = root;
    await assert.rejects(value.controller.registerGitHubRepository(input), /REGISTRATION_ROOT_OVERLAP/);
  }
  assert.equal(value.calls.includes('fetch'), false);
});

test('unavailable registrations remain explicit and discovery does not repair or leak paths', async context => {
  const value = await setup(context); await value.controller.registerGitHubRepository(input);
  repoGit(value.destination, 'remote', 'set-url', 'origin', 'https://secret-user:private-token@github.com/owner/fixture.git');
  const list = await value.controller.listRegisteredRepositories();
  assert.equal(list.repositories[0].status, 'unavailable');
  assert(!JSON.stringify(list).includes('private-token')); assert(!JSON.stringify(list).includes(value.root));
  await assert.rejects(value.controller.registerGitHubRepository(input), /GITHUB_REGISTRATION_ORIGIN_CHANGED/);
});

test('Controller close settles registration and prevents new registration work', async context => {
  const value = await setup(context), original = value.transport.fetch;
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  value.transport.fetch = async (...args) => { entered(); await new Promise(resolve => { release = resolve; }); original(...args); };
  const registration = value.controller.registerGitHubRepository(input);
  await ready;
  const closing = value.controller.close();
  release(); await assert.rejects(registration); await closing;
  assert.deepEqual((await readRegistry(value.file)).repositories, {});
  await assert.rejects(value.controller.registerGitHubRepository(input), /CONTROLLER_CLOSED/);
});

test('host-side CLI preserves remote bindings and uses the same exclusive registry writer', async context => {
  const value = await setup(context); await value.controller.registerGitHubRepository(input);
  const home = path.join(value.root, 'operator');
  const state = path.join(home, '.local/state/personal-agents-bridge'); await fs.mkdir(state, { recursive: true, mode: 0o700 });
  const file = path.join(state, 'repositories.json'); await fs.copyFile(value.file, file); await fs.chmod(file, 0o600);
  const run = () => execFileSync(process.execPath, [path.resolve('register-repository.mjs'), 'legacy', value.upstream], {
    env: { HOME: home, PATH: '/usr/bin:/bin', LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH || '' }, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
  });
  await withRegistryLock(file, async () => { assert.throws(run); });
  assert.match(run(), /Registered legacy/);
  const registry = await readRegistry(file);
  assert.equal(registry.github_repositories.github_1234.repository_id, 1234); assert(registry.repositories.legacy);
});

const refreshContract = { goal: 'Offline refresh fixture', allowed_files: ['answer.txt'], requirements: [{ id: 'ANSWER', text: 'fixture' }], invariants: [], test_commands: [], initial_files: {} };
function refreshInput(request_id, base_ref = 'main') {
  return { repository_id: 'github_1234', execution_backend: 'local_codex', request_id, base_ref, contract: refreshContract };
}
async function advance(value, content) {
  await fs.writeFile(path.join(value.upstream, 'answer.txt'), content);
  repoGit(value.upstream, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-am', content.trim());
  return repoGit(value.upstream, 'rev-parse', 'HEAD').trim();
}

test('default-branch task refreshes stale registration and pins A/B/C across retries and restart', async context => {
  const value = await setup(context);
  await value.controller.registerGitHubRepository(input);
  const registry = await fs.readFile(value.file, 'utf8');
  const index = await fs.readFile(path.join(value.destination, '.git/index'));
  const snapshot = await checkoutSnapshot(value.destination, x => x);
  const commitB = await advance(value, 'commit B\n');
  // Original incident: the new explicit commit is absent from the managed store.
  await assert.rejects(value.controller.start(refreshInput('missing_commit_b', commitB)), /BASE_REF_NOT_FOUND/);
  const selected = await value.controller.start(refreshInput('select_branch_b'));
  await Promise.all([...value.controller.jobs.values()]);
  const taskB = value.controller.task(selected.task_id);
  assert.equal(taskB.baseline, commitB);
  assert.equal(taskB.repository.base_ref, commitB);
  assert.equal(taskB.implementer.state, 'completed');
  const pinned = await value.controller.start(refreshInput('select_commit_a', value.baseline));
  await Promise.all([...value.controller.jobs.values()]);
  assert.equal(value.controller.task(pinned.task_id).baseline, value.baseline);
  const commitC = await advance(value, 'commit C\n');
  const current = await value.controller.start(refreshInput('select_branch_c'));
  await Promise.all([...value.controller.jobs.values()]);
  assert.equal(value.controller.task(current.task_id).baseline, commitC);
  const calls = value.calls.length;
  assert.equal((await value.controller.start(refreshInput('select_branch_b'))).task_id, selected.task_id);
  assert.equal(value.calls.length, calls);
  await assert.rejects(value.controller.start(refreshInput('select_branch_b', commitC)), /REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT/);
  for (const [id, baseline] of [[selected.task_id, commitB], [pinned.task_id, value.baseline], [current.task_id, commitC]]) {
    const task = value.controller.task(id), worktree = path.join(value.config.workspaceRoot, id, 'repo');
    assert.equal(task.baseline, baseline);
    assert.equal(repoGit(worktree, 'rev-parse', 'HEAD').trim(), baseline);
    assert.equal(repoGit(worktree, 'remote'), '');
    assert.equal((await resolveRepository(value.file, task.repository.repository_id, task.repository.base_ref, value.config.workspaceRoot, value.config.stateRoot)).baseline_commit, baseline);
  }
  assert.equal(compareSnapshots(snapshot, await checkoutSnapshot(value.destination, x => x)).status, 'unchanged');
  assert.equal(await fs.readFile(value.file, 'utf8'), registry);
  assert.deepEqual(await fs.readFile(path.join(value.destination, '.git/index')), index);
  assert.equal(repoGit(value.destination, 'rev-parse', 'HEAD').trim(), value.baseline);
  assert.equal(await fs.readFile(path.join(value.destination, 'answer.txt'), 'utf8'), 'baseline\n');
  const networkCalls = value.calls.length;
  assert.equal((await value.controller.listRegisteredRepositories()).repositories[0].baseline_commit, value.baseline);
  assert.equal(value.calls.length, networkCalls);
  await value.controller.close();
  value.transport.api = () => { throw Error('offline after restart'); };
  const restarted = await new Controller(value.config).init();
  try {
    assert.equal((await restarted.start(refreshInput('select_branch_b'))).task_id, selected.task_id);
    assert.equal(restarted.task(selected.task_id).baseline, commitB);
    assert.equal(restarted.task(pinned.task_id).baseline, value.baseline);
  } finally { await restarted.close(); }
});


test('HEAD, explicit commits and discovery never synchronize', async context => {
  const value = await setup(context);
  await value.controller.registerGitHubRepository(input);
  await advance(value, 'new GitHub tip\n');
  const calls = value.calls.length;
  value.transport.api = () => { throw Error('offline'); };
  for (const [request, ref] of [['head_local', 'HEAD'], ['commit_local', value.baseline]]) {
    const result = await value.controller.start(refreshInput(request, ref));
    await Promise.all([...value.controller.jobs.values()]);
    assert.equal(value.controller.task(result.task_id).baseline, value.baseline);
  }
  await value.controller.listRegisteredRepositories();
  assert.equal(value.calls.length, calls);
  assert.equal(value.calls.filter(call => call === 'fetch').length, 1);
});

for (const ref of ['missing-branch', 'refs/heads/other', 'refs/tags/missing', '--all', 'main~1', 'main..HEAD', 'https://github.com/other/repo']) {
  test(`unsupported or unavailable task ref fails closed without GitHub: ${ref}`, async context => {
    const value = await setup(context);
    await value.controller.registerGitHubRepository(input);
    const calls = value.calls.length;
    await assert.rejects(value.controller.start(refreshInput('unsupported_ref', ref)), /INVALID_BASE_REF|BASE_REF_NOT_FOUND/);
    assert.equal(value.calls.length, calls);
    assert.equal(value.controller.db.prepare('SELECT count(*) AS n FROM tasks').get().n, 0);
  });
}

for (const conflict of ['repository_id', 'owner_id', 'full_name', 'default_branch', 'private', 'origin', 'working_files']) {
  test(`refresh rejects changed registered identity or checkout: ${conflict}`, async context => {
    const value = await setup(context);
    await value.controller.registerGitHubRepository(input);
    await advance(value, 'commit B\n');
    const fetches = value.calls.filter(call => call === 'fetch').length;
    if (conflict === 'repository_id') value.metadata.id++;
    if (conflict === 'owner_id') value.metadata.owner.id++;
    if (conflict === 'full_name') value.metadata.full_name = 'owner/replacement';
    if (conflict === 'default_branch') value.metadata.default_branch = 'other';
    if (conflict === 'private') value.metadata.private = true;
    if (conflict === 'origin') repoGit(value.destination, 'remote', 'set-url', 'origin', 'https://github.com/owner/replacement.git');
    if (conflict === 'working_files') await fs.writeFile(path.join(value.destination, 'answer.txt'), 'tampered\n');
    await assert.rejects(value.controller.start(refreshInput('identity_conflict')), /GITHUB_REGISTRATION_|REGISTRATION_CHECKOUT_INVALID/);
    assert.equal(value.calls.filter(call => call === 'fetch').length, fetches);
    assert.equal(value.controller.db.prepare('SELECT count(*) AS n FROM tasks').get().n, 0);
  });
}

for (const failure of ['api', 'fetch', 'missing_commit', 'invalid_commit', 'branch_race', 'identity_race', 'missing_blob', 'sync']) {
  test(`refresh admits no task on ${failure} failure`, async context => {
    const value = await setup(context);
    await value.controller.registerGitHubRepository(input);
    const registry = await fs.readFile(value.file, 'utf8');
    await advance(value, 'commit B\n');
    const api = value.transport.api, fetch = value.transport.fetch;
    if (failure === 'api') value.transport.api = () => { throw Error('private API error'); };
    if (failure === 'fetch') value.transport.fetch = () => { throw Error('private fetch error'); };
    if (['missing_commit', 'invalid_commit'].includes(failure)) {
      value.transport.api = endpoint => endpoint.includes('/commits/') ? { sha: failure === 'missing_commit' ? 'a'.repeat(40) : 'not-a-commit' } : api(endpoint);
      value.transport.fetch = () => {};
    }
    if (failure === 'sync') value.controller.registration.synchronize = () => { throw Error('disk failure'); };
    if (['branch_race', 'identity_race', 'missing_blob'].includes(failure)) value.transport.fetch = async (...args) => {
      fetch(...args);
      if (failure === 'branch_race') await advance(value, 'commit C\n');
      if (failure === 'identity_race') value.metadata.id++;
      if (failure === 'missing_blob') {
        const blob = repoGit(value.destination, 'rev-parse', `${args[3]}:answer.txt`).trim();
        await fs.unlink(path.join(value.destination, '.git/objects', blob.slice(0, 2), blob.slice(2)));
      }
    };
    await assert.rejects(value.controller.start(refreshInput('failed_refresh')), error => !String(error).includes('private'));
    assert.equal(await fs.readFile(value.file, 'utf8'), registry);
    assert.equal(repoGit(value.destination, 'rev-parse', 'HEAD').trim(), value.baseline);
    assert.equal(await fs.readFile(path.join(value.destination, 'answer.txt'), 'utf8'), 'baseline\n');
    assert.equal(value.controller.db.prepare('SELECT count(*) AS n FROM tasks').get().n, 0);
    assert.equal(value.controller.db.prepare('SELECT count(*) AS n FROM operations').get().n, 0);
    assert.equal(value.controller._api, undefined);
    if (failure === 'missing_blob') {
      // Even unreachable refreshed objects retain strict connectivity checking.
      await assert.rejects(resolveRepository(value.file, 'github_1234', value.baseline, value.config.workspaceRoot, value.config.stateRoot));
    }
  });
}

for (const kind of ['symlink', 'submodule']) test(`refreshed ${kind} tree is rejected before task admission`, async context => {
  const value = await setup(context);
  await value.controller.registerGitHubRepository(input);
  if (kind === 'symlink') { await fs.symlink('/etc/passwd', path.join(value.upstream, 'outside')); repoGit(value.upstream, 'add', '.'); }
  else repoGit(value.upstream, 'update-index', '--add', '--cacheinfo', `160000,${value.baseline},nested`);
  repoGit(value.upstream, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'unsupported');
  await assert.rejects(value.controller.start(refreshInput('unsupported_tree')), /REGISTRATION_UNSUPPORTED_ENTRY/);
  assert.equal(value.controller.db.prepare('SELECT count(*) AS n FROM tasks').get().n, 0);
  assert.equal(repoGit(value.destination, 'rev-parse', 'HEAD').trim(), value.baseline);
});

test('concurrent starts, identical retries, registration and discovery preserve source and task identities', async context => {
  const value = await setup(context);
  await value.controller.registerGitHubRepository(input);
  const before = await checkoutSnapshot(value.destination, x => x), commitB = await advance(value, 'commit B\n');
  const fetch = value.transport.fetch; let active = 0, maximum = 0;
  value.transport.fetch = async (...args) => {
    maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setTimeout(resolve, 25));
    fetch(...args); active--;
  };
  const [first, duplicate, second, pinned, registered, discovered] = await Promise.all([
    value.controller.start(refreshInput('concurrent_branch')),
    value.controller.start(refreshInput('concurrent_branch')),
    value.controller.start(refreshInput('concurrent_other', 'refs/heads/main')),
    value.controller.start(refreshInput('concurrent_pinned', value.baseline)),
    value.controller.registerGitHubRepository(input), value.controller.listRegisteredRepositories(),
  ]);
  await Promise.all([...value.controller.jobs.values()]);
  assert.equal(first.task_id, duplicate.task_id); assert.equal(maximum, 1);
  assert.equal(registered.baseline_commit, value.baseline);
  assert.equal(discovered.repositories[0].baseline_commit, value.baseline);
  for (const [result, expected] of [[first, commitB], [second, commitB], [pinned, value.baseline]]) {
    const task = value.controller.task(result.task_id);
    assert.equal(task.baseline, expected); assert.equal(task.implementer.state, 'completed');
    assert.equal(repoGit(path.join(value.config.workspaceRoot, task.id, 'repo'), 'rev-parse', 'HEAD').trim(), expected);
  }
  assert.equal(value.controller.db.prepare('SELECT count(*) AS n FROM operations').get().n, 3);
  assert.equal(compareSnapshots(before, await checkoutSnapshot(value.destination, x => x)).status, 'unchanged');
});

test('cross-process refresh contention and retained registry locks fail closed', async context => {
  const value = await setup(context);
  await value.controller.registerGitHubRepository(input);
  await advance(value, 'commit B\n');
  const other = new GitHubRegistration({ stateRoot: value.config.stateRoot, workspaceRoot: value.config.workspaceRoot, transport: value.transport });
  await withRegistryLock(value.file, async () => {
    await assert.rejects(other.resolveForTask('github_1234', 'main'), /REPOSITORY_REGISTRY_BUSY/);
    await assert.rejects(value.controller.start(refreshInput('locked_start')), /REPOSITORY_REGISTRY_BUSY/);
  });
  assert.equal(value.calls.filter(call => call === 'fetch').length, 1);
});

test('uncertain refresh termination retains lock and blocks admission across restart', async context => {
  const value = await setup(context);
  await value.controller.registerGitHubRepository(input);
  await advance(value, 'commit B\n');
  value.transport.fetch = () => { throw Object.assign(Error('uncertain'), { code: 'REGISTRATION_TERMINATION_UNCERTAIN' }); };
  await assert.rejects(value.controller.start(refreshInput('uncertain_refresh')), /REGISTRATION_TERMINATION_UNCERTAIN/);
  assert((await fs.stat(`${value.file}.lock`)).isDirectory());
  await assert.rejects(value.controller.start(refreshInput('blocked_after_uncertainty', 'HEAD')), /REPOSITORY_REGISTRY_BUSY/);
  assert.equal(value.controller.registration.terminationUncertain, true);
  await assert.rejects(value.controller.close(), /REGISTRATION_TERMINATION_UNCERTAIN/);
  // Test teardown only: production shutdown preserves the uncertainty signal.
  value.controller.registration.terminationUncertain = false;
  await value.controller.close();
  const restarted = await new Controller(value.config).init();
  try { await assert.rejects(restarted.start(refreshInput('restart_uncertain')), /REPOSITORY_REGISTRY_BUSY/); }
  finally { await restarted.close(); }
});

test('shutdown cancels a real refresh process and admits no task or late writer', async context => {
  const value = await setup(context);
  await value.controller.registerGitHubRepository(input);
  await advance(value, 'commit B\n');
  const marker = path.join(value.root, 'late-refresh-write'); let started;
  const ready = new Promise(resolve => { started = resolve; });
  value.transport.fetch = async (directory, target, signal) => {
    const running = registrationProcess('/bin/sh', ['-c', '(sleep 0.5; touch "$1") & wait', 'fixture', marker], { cwd: directory, env: { PATH: '/usr/bin:/bin' }, signal });
    started(); await running;
  };
  const pending = assert.rejects(value.controller.start(refreshInput('shutdown_refresh')), /REGISTRATION_INTERRUPTED/);
  await ready; await value.controller.close(); await pending;
  await new Promise(resolve => setTimeout(resolve, 600));
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
});

test('object-only transport fetch has no ref destination or credential delegation', async () => {
  const calls = [], transport = new GitHubRegistrationTransport((binary, args, options) => { calls.push({ binary, args, options }); return ''; });
  await transport.fetch('/trusted/managed', { full_name: 'owner/fixture', default_branch: 'main' }, undefined, 'b'.repeat(40));
  const call = calls[0];
  assert.equal(call.args.at(-1), 'b'.repeat(40));
  assert(call.args.includes('--no-write-fetch-head'));
  assert(call.args.includes('gc.auto=0')); assert(call.args.includes('maintenance.auto=false'));
  assert(!call.args.some(arg => arg.startsWith('refs/')));
  assert.equal(call.options.env.GIT_NO_REPLACE_OBJECTS, '1');
  assert.equal(call.options.env.GIT_NO_LAZY_FETCH, '1');
  await assert.rejects(transport.fetch('/trusted/managed', {}, undefined, '--all'), /GITHUB_REGISTRATION_BASELINE_UNAVAILABLE/);
  assert.equal(calls.length, 1);
});


for (const tampered of [false, true]) test(`publication after a later refresh ${tampered ? 'rejects changed candidate' : 'retains exact reviewed tree and parent'}`, async context => {
  const value = await setup(context), api = new FakeAPI(); value.controller._api = api;
  await value.controller.registerGitHubRepository(input);
  const commitB = await advance(value, 'commit B\n');
  const started = await value.controller.start({ ...refreshInput('reviewed_branch_b'), execution_backend: 'agents_api' });
  await Promise.all([...value.controller.jobs.values()]);
  const work = path.join(value.config.workspaceRoot, started.task_id, 'repo');
  await fs.writeFile(path.join(work, 'answer.txt'), 'reviewed change\n');
  api.completed(value.controller.task(started.task_id).implementer.session_id);
  await value.controller.review({ task_id: started.task_id, request_id: 'independent_review' });
  await Promise.all([...value.controller.jobs.values()]);
  let task = value.controller.task(started.task_id);
  api.completed(task.reviewer.session_id, JSON.stringify({ overall: 'PASS', findings: ['ANSWER', 'SCOPE', 'TEST_EVIDENCE'].map(id => ({ id, status: 'PASS', evidence: 'Offline independent reviewer fixture' })) }));
  assert.equal((await value.controller.get(task.id)).reviewer.overall, 'PASS');
  task = value.controller.task(task.id);
  const reviewedTree = task.reviewer.reviewed_git_state.tree_sha;
  const before = await checkoutSnapshot(value.destination, x => x);
  await advance(value, 'commit C\n');
  await value.controller.start(refreshInput('later_branch_c'));
  await Promise.all([...value.controller.jobs.values()]);
  assert.equal(compareSnapshots(before, await checkoutSnapshot(value.destination, x => x)).status, 'unchanged');
  const remote = path.join(value.root, 'publication.git'); await fs.mkdir(remote);
  repoGit(remote, 'init', '--bare', '--template=', '--initial-branch=main');
  const publisher = new GitHubPublisher(); publisher.api = () => value.metadata;
  const target = publisher.target.bind(publisher);
  publisher.target = async repository => ({ ...await target(repository), remote });
  publisher.findPR = async () => null;
  publisher.createPR = async (destination, branch, details) => {
    assert.equal(details.draft, true);
    return { number: 1, html_url: `https://github.com/${destination.repository}/pull/1`, state: 'open', draft: true, merged_at: null,
      head: { ref: branch, sha: repoGit(remote, 'rev-parse', `refs/heads/${branch}`).trim(), repo: { full_name: destination.repository } },
      base: { ref: destination.base, repo: { full_name: destination.repository } } };
  };
  value.controller.publisher = publisher;
  if (tampered) await fs.writeFile(path.join(work, 'answer.txt'), 'unreviewed change\n');
  const publish = () => value.controller.publish({ task_id: task.id, title: 'Offline refreshed fixture' });
  if (tampered) {
    await assert.rejects(publish(), /WORKTREE_CHANGED_SINCE_REVIEW/);
    assert.equal(repoGit(remote, 'for-each-ref'), '');
  } else {
    const result = await publish();
    assert.equal(result.reviewed_tree_sha, reviewedTree);
    assert.equal(repoGit(remote, 'rev-parse', `${result.commit_sha}^{tree}`).trim(), reviewedTree);
    assert.equal(repoGit(remote, 'rev-parse', `${result.commit_sha}^`).trim(), commitB);
    assert.equal((await value.controller.reportTask(task.id)).publication.confirmed, true);
  }
});

test('automatic task request binding retains the branch selector and immutable commit across deduplication', async context => {
  const value = await setup(context);
  await value.controller.registerGitHubRepository(input);
  const commitB = await advance(value, 'commit B\n');
  // Exercise admission/binding only; automatic execution has its own unchanged suites.
  value.controller.scheduleAutomatic = () => {};
  const request = { ...refreshInput('automatic_branch_b'), automatic: {
    publish: { title: 'Offline automatic fixture', draft: true }, max_duration_seconds: 120, max_codex_turns: 2, max_corrections: 0,
  } };
  const result = await value.controller.start(request);
  await Promise.all([...value.controller.jobs.values()]);
  const task = value.controller.task(result.task_id);
  assert.equal(task.baseline, commitB);
  assert.equal(task.repository.base_ref, commitB);
  assert.equal(task.repository.requested_base_ref, 'main');
  assert.equal(value.controller.automaticOperationBinding(request.request_id).fingerprint,
    value.controller.db.prepare('SELECT fingerprint FROM operations WHERE id=?').get(request.request_id).fingerprint);
  await advance(value, 'commit C\n');
  const calls = value.calls.length;
  assert.equal((await value.controller.start(request)).task_id, task.id);
  assert.equal(value.calls.length, calls);
  assert.equal(value.controller.task(task.id).baseline, commitB);
});


test('MCP default-branch refresh requires authorization and reports the pinned commit without host paths', async context => {
  const value = await setup(context);
  await value.controller.registerGitHubRepository(input);
  const commitB = await advance(value, 'commit B\n'), before = value.calls.length;
  let authorized = false;
  const server = createServer(value.controller, async () => { if (!authorized) throw Error('denied'); });
  const client = new Client({ name: 'refresh-offline', version: '1' }), [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  context.after(async () => { await client.close(); await server.close(); });
  const args = refreshInput('mcp_branch_refresh');
  assert.equal((await client.callTool({ name: 'start_task', arguments: args })).isError, true);
  assert.equal(value.calls.length, before);
  assert.equal(value.controller.db.prepare('SELECT count(*) AS n FROM tasks').get().n, 0);
  authorized = true;
  const result = await client.callTool({ name: 'start_task', arguments: args });
  assert.notEqual(result.isError, true);
  assert.equal(result.structuredContent.repository.baseline_commit, commitB);
  assert.equal(result.structuredContent.repository.base_ref, commitB);
  assert(!JSON.stringify(result).includes(value.root));
  await Promise.all([...value.controller.jobs.values()]);
  const task = value.controller.task(result.structuredContent.task_id);
  assert.equal(task.implementer.state, 'completed');
  assert.equal(repoGit(path.join(value.config.workspaceRoot, task.id, 'repo'), 'remote'), '');
  assert.equal(value.controller._api, undefined);
});
