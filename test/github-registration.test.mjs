import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Controller } from '../controller.mjs';
import { GitHubRegistration, GitHubRegistrationTransport, bridgeGitHubRepositoryId } from '../github-registration.mjs';
import { repoGit, repositoryIdentity, readRegistry, resolveRepository, withRegistryLock, writeRegistry } from '../repositories.mjs';
import { GitHubPublisher } from '../publication.mjs';
import { createServer } from '../server.mjs';
import { FakeExecutor } from './helpers.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const input = { repository: 'owner/fixture' };
async function setup(context, changes = {}) {
  const root = await fs.mkdtemp('/tmp/pab-registration-test-'), upstream = path.join(root, 'upstream');
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
    fetch(directory, target) {
      calls.push('fetch');
      repoGit(directory, '-c', 'protocol.file.allow=always', 'fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', upstream, `refs/heads/${target.default_branch}:refs/remotes/origin/${target.default_branch}`);
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
  await assert.rejects(value.controller.registerGitHubRepository(input), /^Error: REPOSITORY_REGISTRATION_FAILED$/);
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
  try { transport.api('user'); transport.fetch('/trusted/stage', { full_name: 'owner/fixture', default_branch: 'main' }); }
  finally { if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old; }
  assert.equal(calls[0].binary, '/usr/bin/gh'); assert(calls[0].args.includes('GET'));
  const fetch = calls[1]; assert.equal(fetch.binary, '/usr/bin/timeout');
  assert.deepEqual(fetch.args.slice(0, 4), ['--signal=KILL', '120s', '/usr/bin/git', '-c']);
  for (const flag of ['--no-recurse-submodules', 'http.followRedirects=false', 'protocol.allow=never', 'protocol.https.allow=always', 'core.hooksPath=/dev/null']) assert(fetch.args.includes(flag));
  assert.equal(fetch.options.env.OPENAI_API_KEY, undefined); assert.equal(fetch.options.env.SSH_AUTH_SOCK, undefined);
  assert.equal(fetch.options.env.GIT_CONFIG_GLOBAL, '/dev/null'); assert.equal(fetch.options.env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(fetch.options.timeout, 125000); assert.equal(fetch.options.stdio, 'ignore');
  const failing = new GitHubRegistrationTransport(() => { throw Error('secret ghp_never_expose'); });
  assert.throws(() => failing.api('user'), /^Error: GITHUB_REGISTRATION_ACCESS_UNAVAILABLE$/);
  assert.throws(() => failing.fetch('/trusted', { full_name: 'owner/fixture', default_branch: 'main' }), /^Error: GITHUB_REGISTRATION_FETCH_FAILED$/);
});

test('fetch timeout kills the synthetic helper group without leaving a later writer', async context => {
  const value = await setup(context), marker = path.join(value.root, 'late-helper-write');
  const transport = new GitHubRegistrationTransport((binary, args, options) => {
    assert.equal(binary, '/usr/bin/timeout'); assert.equal(args[0], '--signal=KILL');
    return execFileSync(binary, [args[0], '0.1s', '/bin/sh', '-c', '(sleep 0.4; touch "$1") & wait', 'fixture', marker], options);
  });
  assert.throws(() => transport.fetch(value.root, { full_name: input.repository, default_branch: 'main' }), /GITHUB_REGISTRATION_FETCH_FAILED/);
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
  release(); await registration; await closing;
  assert.equal((await readRegistry(value.file)).github_repositories.github_1234.repository_id, 1234);
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
