import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRepositorySandbox } from '../repository-sandbox.mjs';
import { Controller } from '../controller.mjs';
import { repositoryIdentity, repoGit } from '../repositories.mjs';
import { createServer } from '../server.mjs';
import { FakeAPI, FakeExecutor, contract } from './helpers.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const source = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
async function setup(t) {
  const root = await fs.mkdtemp('/var/tmp/personal-agents-bridge/repository-');
  const normal = path.join(root, 'normal'); await fs.mkdir(normal);
  repoGit(normal, 'init', '--initial-branch=main');
  await fs.writeFile(path.join(normal, 'greeting.txt'), 'baseline\n');
  repoGit(normal, 'add', '.');
  repoGit(normal, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'baseline');
  const baseline = repoGit(normal, 'rev-parse', 'HEAD').trim();
  repoGit(normal, 'branch', 'approved-base', baseline);
  await fs.writeFile(path.join(normal, 'greeting.txt'), 'new main\n');
  repoGit(normal, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-am', 'new main');
  await fs.writeFile(path.join(normal, 'greeting.txt'), 'uncommitted user work\n');
  const api = new FakeAPI(), executor = new FakeExecutor();
  const c = await new Controller({ stateRoot: path.join(root, 'state'), workspaceRoot: path.join(root, 'work'), api, executor, secrets: [] }).init();
  const registryFile = path.join(c.stateRoot, 'repositories.json');
  const registry = { version: 1, repositories: { fixture: await repositoryIdentity(normal) } };
  await fs.writeFile(registryFile, JSON.stringify(registry), { mode: 0o600 });
  t.after(async () => { await c.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const input = { contract: contract(), request_id: 'repository_start', repository_id: 'fixture', base_ref: 'approved-base' };
  const start = async (overrides = {}) => {
    const x = await c.start({ ...input, ...overrides }); await Promise.all([...c.jobs.values()]);
    const result = await c.get(x.task_id);
    assert.equal(result.implementer.error, null);
    return result;
  };
  return { c, api, executor, normal, root, registryFile, registry, baseline, input, start };
}

test('allowlisted repository uses exact baseline in a private worktree without changing normal checkout', async t => {
  const { c, api, normal, baseline, start } = await setup(t);
  const refs = repoGit(normal, 'show-ref'), status = repoGit(normal, 'status', '--porcelain'), worktrees = repoGit(normal, 'worktree', 'list', '--porcelain');
  const x = await start(), repo = path.join(c.workspaceRoot, x.task_id, 'repo');
  assert.equal(x.repository.baseline_commit, baseline);
  assert.equal(x.repository.base_ref, 'approved-base');
  assert.equal(x.repository.repository_id, 'fixture');
  assert.equal(x.repository.branch, `bridge/${x.task_id}`);
  assert.equal(c.task(x.task_id).repository.canonical_path, normal);
  assert(!JSON.stringify(x).includes(normal));
  assert.equal(repoGit(repo, 'rev-parse', 'HEAD').trim(), baseline);
  assert.equal(await fs.readFile(path.join(repo, 'greeting.txt'), 'utf8'), 'baseline\n');
  assert((await fs.lstat(path.join(repo, '.git'))).isFile());
  assert.equal(repoGit(repo, 'remote'), '');
  assert.equal(api.created[0].environment.workspace_directory, repo);
  await fs.writeFile(path.join(repo, 'greeting.txt'), 'task change\n');
  assert.equal(await fs.readFile(path.join(normal, 'greeting.txt'), 'utf8'), 'uncommitted user work\n');
  assert.equal(repoGit(normal, 'show-ref'), refs);
  assert.equal(repoGit(normal, 'status', '--porcelain'), status);
  assert.equal(repoGit(normal, 'worktree', 'list', '--porcelain'), worktrees);
});

test('unknown IDs, arbitrary paths and missing base refs fail before API calls', async t => {
  const { c, api, input, normal } = await setup(t);
  await assert.rejects(c.start({ ...input, repository_id: 'unknown' }), /UNKNOWN_REPOSITORY_ID/);
  await assert.rejects(c.start({ ...input, repository_id: normal }), /INVALID_REPOSITORY_ID/);
  await assert.rejects(c.start({ ...input, repository_path: normal }), /INVALID_START_INPUT/);
  await assert.rejects(c.start({ ...input, base_ref: 'does-not-exist' }), /BASE_REF_NOT_FOUND/);
  await assert.rejects(c.start({ ...input, base_ref: '--all' }), /INVALID_BASE_REF/);
  assert.equal(api.created.length, 0);
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0);
});

test('MCP rejects arbitrary path arguments instead of silently dropping them', async t => {
  const { c, api, input, normal } = await setup(t);
  const server = createServer(c, async () => {}), client = new Client({ name: 'repository-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  for (const args of [{ ...input, repository_path: normal }, { ...input, repository_id: normal }]) {
    assert.equal((await client.callTool({ name: 'start_task', arguments: args })).isError, true);
  }
  assert.equal(api.created.length, 0);
  const result = await client.callTool({ name: 'start_task', arguments: input });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.repository.repository_id, 'fixture');
});

test('bridge source cannot be registered', async t => {
  const { c, api, input, registryFile } = await setup(t);
  await assert.rejects(repositoryIdentity(source), /BRIDGE_SELF_TARGET/);
  await fs.writeFile(registryFile, JSON.stringify({ version: 1, repositories: { fixture: { path: source } } }));
  await assert.rejects(c.start(input), /BRIDGE_SELF_TARGET/);
  assert.equal(api.created.length, 0);
});

test('changed configured directory identity is rejected before starting', async t => {
  const { c, api, input, registry, registryFile } = await setup(t);
  registry.repositories.fixture.directory_identity.ino = '0';
  await fs.writeFile(registryFile, JSON.stringify(registry));
  await assert.rejects(c.start(input), /REPOSITORY_PATH_CHANGED/);
  assert.equal(api.created.length, 0);
});

test('changed files and independent review use the exact baseline and worktree diff', async t => {
  const { c, api, baseline, start } = await setup(t);
  const x = await start(), repo = path.join(c.workspaceRoot, x.task_id, 'repo');
  await fs.writeFile(path.join(repo, 'greeting.txt'), 'review this change\n');
  await fs.writeFile(path.join(repo, 'unauthorized.txt'), 'outside contract\n');
  const view = await c.get(x.task_id);
  assert.deepEqual(view.repository.changed_files.sort(), ['greeting.txt', 'unauthorized.txt']);
  assert.match(view.repository.final_diff, /-baseline\n\+review this change/);
  assert.match(view.repository.final_status, /unauthorized.txt/);
  assert.match(view.repository.final_diff, /\+outside contract/);
  api.completed(x.implementer.session_id);
  await c.review({ task_id: x.task_id, request_id: 'repository_review' }); await Promise.all([...c.jobs.values()]);
  const ref = c.task(x.task_id).reviewer;
  assert.notEqual(ref.session_id, x.implementer.session_id);
  const packet = JSON.parse(await fs.readFile(path.join(c.workspaceRoot, x.task_id, ref.packet_directory, 'evidence.json'), 'utf8'));
  assert.equal(packet.baseline_commit, baseline);
  assert.equal(packet.baseline['greeting.txt'], 'baseline\n');
  assert.equal(packet.current['greeting.txt'], 'review this change\n');
  assert.equal(packet.current['unauthorized.txt'], 'outside contract\n');
  assert.deepEqual(packet.unauthorized_files, ['unauthorized.txt']);
  assert.match(packet.diff, /-baseline\n\+review this change/);
});

test('cleanup removes only the task worktree and retains final evidence', async t => {
  const { c, normal, start } = await setup(t);
  const x = await start(), repo = path.join(c.workspaceRoot, x.task_id, 'repo');
  await fs.writeFile(path.join(repo, 'greeting.txt'), 'final change\n');
  const result = await c.cleanup({ task_id: x.task_id, delete_workspace: true });
  assert.equal(result.cleanup.worktree_deletion_requested, true);
  assert.equal(result.cleanup.worktree_deleted, true);
  assert.equal(result.cleanup.workspace_deleted, true);
  assert.equal(result.cleanup.cleanup_diagnostic, null);
  await assert.rejects(fs.lstat(repo), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(normal, 'greeting.txt'), 'utf8'), 'uncommitted user work\n');
  assert.equal(repoGit(normal, 'branch', '--show-current').trim(), 'main');
  assert.deepEqual(result.repository.changed_files, ['greeting.txt']);
  assert.match((await c.get(x.task_id)).repository.final_diff, /final change/);
  assert.equal((await c.cleanup({ task_id: x.task_id, delete_workspace: true })).cleanup.worktree_deleted, true);
});

test('concurrent repository tasks use distinct branches and worktrees', async t => {
  const { c, start } = await setup(t);
  const [a, b] = await Promise.all([start({ request_id: 'concurrent_first' }), start({ request_id: 'concurrent_second' })]);
  assert.notEqual(a.repository.worktree_id, b.repository.worktree_id);
  assert.notEqual(a.repository.branch, b.repository.branch);
  const first = path.join(c.workspaceRoot, a.task_id, 'repo'), second = path.join(c.workspaceRoot, b.task_id, 'repo');
  await fs.writeFile(path.join(first, 'greeting.txt'), 'first only\n');
  assert.equal(await fs.readFile(path.join(second, 'greeting.txt'), 'utf8'), 'baseline\n');
  await c.cleanup({ task_id: a.task_id, delete_workspace: true });
  assert((await fs.lstat(second)).isDirectory());
});

test('Linux executor isolation permits task edits and Git reads but denies normal checkout and Git metadata writes', async t => {
  const { c, normal, start } = await setup(t);
  const x = await start(), root = path.join(c.workspaceRoot, x.task_id), repo = path.join(root, 'repo'), runtime = path.join(root, 'implementer-runtime');
  await fs.mkdir(runtime);
  const code = `import pathlib,subprocess,sys\np=pathlib.Path('greeting.txt')\np.write_text('isolated edit')\nassert subprocess.check_output(['/usr/bin/git','rev-parse','HEAD']).strip()\nassert subprocess.check_output(['/usr/bin/git','status','--porcelain']).strip()\nassert subprocess.run(['/usr/bin/git','add','greeting.txt'],capture_output=True).returncode != 0\nfor target in sys.argv[1:]:\n try:\n  pathlib.Path(target).write_text('forbidden')\n  raise AssertionError('write escaped isolation')\n except PermissionError: pass\ntry:\n pathlib.Path(sys.argv[1]).read_text()\n raise AssertionError('normal checkout readable')\nexcept PermissionError: pass\nprint('isolated')\n`;
  const out = execFileSync('/usr/bin/python3', ['-B', path.join(source, 'isolate.py'), repo, runtime, 'implementer', '/usr/bin/python3', '-B', '-c', code,
    path.join(normal, 'greeting.txt'), path.join(root, 'git-store/config')], {
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', BRIDGE_GIT_READ_ROOT: path.join(root, 'git-store'), GIT_OPTIONAL_LOCKS: '0' }, encoding: 'utf8'
  });
  assert.equal(out.trim(), 'isolated');
  assert.equal(await fs.readFile(path.join(normal, 'greeting.txt'), 'utf8'), 'uncommitted user work\n');
});

test('non-Git paths and symlink replacement are rejected before API work', async t => {
  const { c, api, input, registryFile, registry, root, normal } = await setup(t);
  const plain = path.join(root, 'plain'); await fs.mkdir(plain);
  await fs.writeFile(registryFile, JSON.stringify({ version: 1, repositories: { fixture: { path: plain } } }));
  await assert.rejects(c.start(input), /REPOSITORY_VALIDATION_FAILED/);
  await fs.writeFile(registryFile, JSON.stringify(registry));
  await fs.rename(normal, normal + '-moved'); await fs.symlink(normal + '-moved', normal);
  await assert.rejects(c.start(input), /REPOSITORY_PATH_CHANGED/);
  assert.equal(api.created.length, 0);
});

test('bridge Git directory aliases are rejected even outside the bridge source path', async t => {
  const { root } = await setup(t);
  const alias = path.join(root, 'bridge-alias'); await fs.mkdir(alias);
  const gitDirectory = repoGit(source, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim();
  await fs.writeFile(path.join(alias, '.git'), `gitdir: ${gitDirectory}\n`);
  await assert.rejects(repositoryIdentity(alias), /BRIDGE_SELF_TARGET/);
});

test('worktree retention and failed identity verification never remove normal checkout', async t => {
  const { c, normal, start } = await setup(t);
  const x = await start(), repo = path.join(c.workspaceRoot, x.task_id, 'repo');
  const kept = await c.cleanup({ task_id: x.task_id, delete_workspace: false });
  assert.equal(kept.cleanup.worktree_deletion_requested, false);
  assert.equal(kept.cleanup.worktree_deleted, false);
  assert((await fs.lstat(repo)).isDirectory());
  const pointer = await fs.readFile(path.join(repo, '.git'), 'utf8');
  await fs.writeFile(path.join(repo, '.git'), `gitdir: ${normal}/.git\n`);
  const failed = await c.cleanup({ task_id: x.task_id, delete_workspace: true });
  assert.equal(failed.cleanup.worktree_deleted, false);
  assert.equal(failed.cleanup.workspace_deleted, false);
  assert.match(failed.cleanup.cleanup_diagnostic, /WORKTREE_DELETE_UNCONFIRMED/);
  assert.equal(await fs.readFile(path.join(normal, 'greeting.txt'), 'utf8'), 'uncommitted user work\n');
  await fs.writeFile(path.join(repo, '.git'), pointer);
  assert.equal((await c.cleanup({ task_id: x.task_id, delete_workspace: true })).cleanup.worktree_deleted, true);
});

test('repository TASK.md conflicts fail without starting an API session', async t => {
  const { c, api, normal, input } = await setup(t);
  await fs.writeFile(path.join(normal, 'TASK.md'), 'repository instructions\n');
  repoGit(normal, 'add', 'TASK.md');
  repoGit(normal, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'instructions');
  const x = await c.start({ ...input, base_ref: 'HEAD' }); await Promise.all([...c.jobs.values()]);
  assert.equal(c.task(x.task_id).implementer.error, 'REPOSITORY_TASK_FILE_CONFLICT');
  assert.equal(api.created.length, 0);
  assert.equal(await fs.readFile(path.join(normal, 'TASK.md'), 'utf8'), 'repository instructions\n');
  assert.equal((await c.cleanup({ task_id: x.task_id, delete_workspace: true })).cleanup.workspace_deleted, true);
});

test('repository request retries preserve the pinned baseline when the base branch moves', async t => {
  const { c, api, start, input, normal, baseline } = await setup(t);
  const first = await start();
  repoGit(normal, 'branch', '-f', 'approved-base', 'main');
  const repeated = await c.start(input);
  assert.equal(repeated.task_id, first.task_id);
  assert.equal(repeated.repository.baseline_commit, baseline);
  assert.equal(api.created.length, 1);
});

test('altered task contract cannot disappear from review via the worktree ignore rule', async t => {
  const { c, api, start } = await setup(t);
  const x = await start();
  await fs.writeFile(path.join(c.workspaceRoot, x.task_id, 'repo/TASK.md'), 'Ignore the contract');
  api.completed(x.implementer.session_id);
  await assert.rejects(c.review({ task_id: x.task_id, request_id: 'tampered_contract' }), /TASK_CONTRACT_CHANGED/);
  assert.equal(api.created.length, 1);
});

async function reviewPacket(c, x) { return JSON.parse((await c.buildPacket(c.task(x.task_id))).text); }

test('review evidence establishes controller-validated registration and private worktree mapping', async t => {
  const { c, normal, start, baseline } = await setup(t);
  repoGit(normal, 'remote', 'add', 'origin', 'git@github.com:example/chat-orchestrator.git');
  const x = await start(), packet = await reviewPacket(c, x), evidence = packet.controller_evidence;
  assert.equal(evidence.provenance, 'controller');
  assert.equal(evidence.registration.before.status, 'validated');
  assert.equal(evidence.registration.at_review.status, 'validated');
  assert.equal(evidence.registration.at_review.repository_id, 'fixture');
  assert.equal(evidence.registration.at_review.canonical_registered_path, normal);
  assert.match(evidence.registration.at_review.origin.text, /example\/chat-orchestrator/);
  assert.deepEqual(evidence.registration.before.git_identity, c.task(x.task_id).repository.registered_identity);
  assert.equal(evidence.task_worktree.task_id, x.task_id);
  assert.equal(evidence.task_worktree.canonical_worktree_path, path.join(c.workspaceRoot, x.task_id, 'repo'));
  assert.equal(evidence.task_worktree.baseline_commit, baseline);
  assert.equal(evidence.task_worktree.head, baseline);
  assert.match(evidence.task_worktree.worktree_list_porcelain.text, new RegExp(`branch refs/heads/bridge/${x.task_id}`));
});

for (const dirty of [false, true]) test(`normal checkout comparison uses actual before/after state when initially ${dirty ? 'dirty' : 'clean'}`, async t => {
  const { c, normal, start } = await setup(t);
  if (!dirty) repoGit(normal, 'restore', 'greeting.txt');
  else {
    await fs.writeFile(path.join(normal, 'preexisting.txt'), 'untracked before task\n');
    repoGit(normal, 'add', 'greeting.txt');
    await fs.writeFile(path.join(normal, 'greeting.txt'), 'unstaged user work\n');
  }
  const x = await start();
  await fs.writeFile(path.join(c.workspaceRoot, x.task_id, 'repo/greeting.txt'), 'isolated change\n');
  const evidence = (await reviewPacket(c, x)).controller_evidence.normal_checkout;
  assert.equal(evidence.before.status, 'captured');
  assert.equal(evidence.at_review.status, 'captured');
  assert.equal(evidence.comparison.status, 'unchanged');
  assert.equal(Boolean(evidence.before.index_worktree_status.text), dirty);
  assert.equal(evidence.before.contents.sha256, evidence.at_review.contents.sha256);
  assert.equal(evidence.before.git.index_sha256, evidence.at_review.git.index_sha256);
  if (dirty) {
    // Same dirty status, different bytes: status equality alone must not hide a change.
    await fs.writeFile(path.join(normal, 'greeting.txt'), 'changed user work\n');
    assert.equal((await reviewPacket(c, x)).controller_evidence.normal_checkout.comparison.status, 'conflicting');
  }
});

test('Git restriction evidence includes all command records and conflicting metadata without issuing PASS', async t => {
  const { c, api, start } = await setup(t); const x = await start();
  const repo = path.join(c.workspaceRoot, x.task_id, 'repo');
  api.rows.get(x.implementer.session_id).items.push(
    { type: 'command_execution', id: 'cmd_push', command: 'git push https://example.invalid/repo HEAD', output: 'denied', exit_code: 1, cwd: repo, turn_id: 'turn_test' },
    { type: 'command_execution', id: 'cmd_rebase', command: 'git rebase main', output: 'denied', exit_code: 1, cwd: repo, turn_id: 'turn_test' });
  const legacy = c.task(x.task_id); delete legacy.implementer.executor.isolation_evidence; c.save(legacy);
  const packet = await reviewPacket(c, x);
  assert.equal(packet.controller_evidence.git_operations.comparison.status, 'unchanged');
  assert.equal(packet.command_execution_evidence.records.length, 2);
  assert.equal(packet.command_execution_evidence.records[0].item_id, 'cmd_push');
  assert.equal(packet.command_execution_evidence.records[0].exit_code, 1);
  assert.equal(packet.controller_evidence.git_operations.remote_operations_verification, 'not_independently_observed');
  assert.equal(packet.overall, undefined);
  // Simulate a forbidden mutation by the local test harness, not the sandboxed executor.
  repoGit(repo, 'config', 'bridge.unexpected', 'true');
  repoGit(repo, 'tag', 'unexpected-tag');
  const conflict = (await reviewPacket(c, x)).controller_evidence.git_operations;
  assert.equal(conflict.comparison.status, 'conflicting');
  assert(conflict.comparison.changed_fields.includes('config_sha256'));
  assert(conflict.comparison.changed_fields.includes('refs'));
});

test('legacy missing snapshots and registry conflicts remain explicit evidence gaps', async t => {
  const { c, start, registryFile, registry } = await setup(t); const x = await start();
  const legacy = c.task(x.task_id); delete legacy.review_evidence_before; c.save(legacy);
  let evidence = (await reviewPacket(c, x)).controller_evidence;
  assert.equal(evidence.normal_checkout.comparison.status, 'unavailable');
  assert.equal(evidence.git_operations.comparison.status, 'unavailable');
  assert.equal(evidence.registration.before.status, 'unavailable');
  registry.repositories.fixture.directory_identity.ino = '0';
  await fs.writeFile(registryFile, JSON.stringify(registry));
  evidence = (await reviewPacket(c, x)).controller_evidence;
  assert.equal(evidence.registration.at_review.status, 'unavailable');
  assert.equal(evidence.normal_checkout.comparison.status, 'unavailable');
});

test('exact new-file bytes and changed-file scope are controller evidence', async t => {
  const { c, start } = await setup(t); const x = await start();
  const repo = path.join(c.workspaceRoot, x.task_id, 'repo');
  await fs.writeFile(path.join(repo, 'bridge_acceptance_probe.txt'), 'EXAMPLE_BRIDGE_PASS\n');
  const packet = await reviewPacket(c, x);
  assert.deepEqual(packet.changed_files, ['bridge_acceptance_probe.txt']);
  assert.deepEqual(packet.unauthorized_files, ['bridge_acceptance_probe.txt']);
  assert.equal(packet.file_byte_evidence['bridge_acceptance_probe.txt'].byte_length, Buffer.byteLength('EXAMPLE_BRIDGE_PASS\n'));
  assert.equal(packet.file_byte_evidence['bridge_acceptance_probe.txt'].hex, Buffer.from('EXAMPLE_BRIDGE_PASS\n').toString('hex'));
  assert.equal(packet.file_byte_evidence['bridge_acceptance_probe.txt'].provenance, 'controller');
});

test('review packets bound/redact command records and exclude reasoning and implementer assertions', async t => {
  const { c, api, start } = await setup(t); const x = await start();
  c.secrets = ['sensitive-fixture-secret'];
  const items = api.rows.get(x.implementer.session_id).items;
  items.push({ type: 'reasoning', text: 'PRIVATE_REASONING_CANARY' }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'TRUST_ME_NO_PUSH_CANARY' }] });
  for (let i = 0; i < 110; i++) items.push({ type: 'command_execution', command: 'echo sensitive-fixture-secret', output: 'sensitive-fixture-secret ' + 'x'.repeat(6000), exit_code: 0 });
  const result = await c.buildPacket(c.task(x.task_id)), packet = JSON.parse(result.text);
  assert(result.bytes <= 128 * 1024);
  assert(!result.text.includes('sensitive-fixture-secret'));
  assert(!result.text.includes('PRIVATE_REASONING_CANARY'));
  assert(!result.text.includes('TRUST_ME_NO_PUSH_CANARY'));
  assert(packet.command_execution_evidence.omitted_command_records > 0);
  assert(packet.command_execution_evidence.records.every(r => r.truncated));
  api.items.list = () => { throw Error('unavailable'); };
  const missing = await reviewPacket(c, x);
  assert.equal(missing.command_execution_evidence.items_scan_complete, false);
  assert.equal(missing.command_execution_evidence.error, 'COMMAND_RECORDS_UNAVAILABLE');
});

test('origin credentials and small-file hex cannot bypass packet redaction', async t => {
  const { c, normal, start } = await setup(t);
  repoGit(normal, 'remote', 'add', 'origin', 'https://operator:origin-password@example.invalid/team/example.git?token=private');
  const x = await start(); c.secrets = ['file-secret-canary'];
  await fs.writeFile(path.join(c.workspaceRoot, x.task_id, 'repo/greeting.txt'), 'file-secret-canary\n');
  const built = await c.buildPacket(c.task(x.task_id)), packet = JSON.parse(built.text);
  assert(!built.text.includes('origin-password'));
  assert(!built.text.includes('token=private'));
  assert(!built.text.includes('file-secret-canary'));
  assert(!built.text.includes(Buffer.from('file-secret-canary').toString('hex')));
  assert.match(packet.controller_evidence.registration.before.origin.text, /example.invalid:team\/example.git/);
  assert.equal(packet.file_byte_evidence['greeting.txt'].hex, null);
});

test('ignored normal-checkout changes remain conflicts even with identical Git status', async t => {
  const { c, normal, start } = await setup(t);
  await fs.writeFile(path.join(normal, '.gitignore'), 'ignored-output\n');
  await fs.writeFile(path.join(normal, 'ignored-output'), 'before');
  const x = await start();
  await fs.writeFile(path.join(normal, 'ignored-output'), 'after');
  const evidence = (await reviewPacket(c, x)).controller_evidence.normal_checkout;
  assert.equal(evidence.before.index_worktree_status.sha256, evidence.at_review.index_worktree_status.sha256);
  assert.equal(evidence.comparison.status, 'conflicting');
  assert(evidence.comparison.changed_fields.includes('contents'));
});

test('an unexpected commit remains conflicting evidence, with observed HEAD and refs', async t => {
  const { c, start, baseline } = await setup(t); const x = await start();
  const repo = path.join(c.workspaceRoot, x.task_id, 'repo');
  await fs.writeFile(path.join(repo, 'greeting.txt'), 'unauthorized commit\n');
  repoGit(repo, 'add', 'greeting.txt');
  repoGit(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'forbidden commit');
  const evidence = (await reviewPacket(c, x)).controller_evidence;
  assert.equal(evidence.task_worktree.status, 'conflicting');
  assert.equal(evidence.git_operations.comparison.status, 'conflicting');
  assert.notEqual(evidence.git_operations.at_review.head, baseline);
  assert.equal(evidence.git_operations.before.remotes.text, '');
  assert.equal(evidence.git_operations.at_review.operation_markers.MERGE_HEAD, false);
});

test('sandbox evidence covers new tasks but never retroactively attests unsandboxed execution', async t => {
  const { c, api, executor, start } = await setup(t);
  const original = executor.start.bind(executor);
  executor.start = async (...args) => {
    assert.equal(args[0].repository_task, true);
    return original(...args);
  };
  const x = await start();
  let evidence = (await reviewPacket(c, x)).controller_evidence.git_operations;
  assert.equal(evidence.executor_isolation.coverage_from_first_executor, true);
  assert.equal(evidence.remote_operations_verification, 'network_denied_by_controller_sandbox');
  assert.match(evidence.filesystem_enforcement, /file RPCs also sandboxed/);
  // Model a preserved legacy task whose prior executor lacked these guarantees.
  const old = c.task(x.task_id); old.implementer.executor.isolation_evidence = { network_isolation: false }; c.save(old);
  api.completed(x.implementer.session_id);
  await c.continue({ task_id: x.task_id, request_id: 'legacy_resume', instruction: 'Continue the authorized task.' });
  evidence = (await reviewPacket(c, x)).controller_evidence.git_operations;
  assert.equal(evidence.executor_isolation.initialized, true);
  assert.equal(evidence.executor_isolation.coverage_from_first_executor, false);
  assert.equal(evidence.remote_operations_verification, 'not_independently_observed');
  assert.equal(evidence.filesystem_enforcement, 'complete_enforcement_evidence_unavailable');
});

function submittedAttestation(api, index = 0) {
  const event = api.sent[index].payload.events[0];
  const text = event.input?.[0].content[0].text || event.output;
  const match = text.match(/^BEGIN CONTROLLER REPOSITORY SANDBOX ATTESTATION\n([^\n]+)\nEND CONTROLLER REPOSITORY SANDBOX ATTESTATION/);
  assert(match, 'controller evidence precedes implementation input');
  return JSON.parse(match[1]);
}

test('v3: outer danger-full-access with real enforced sandbox delivers controller evidence before implementation', async t => {
  const { c, api, executor, start, baseline } = await setup(t);
  const originalCreate = api.create.bind(api);
  api.create = async body => { const s = await originalCreate(body); s.environment.sandbox_mode = 'danger-full-access'; return s; };
  let sandbox;
  const originalStart = executor.start.bind(executor);
  executor.start = async (...args) => {
    assert.equal(api.sent.length, 0, 'no implementation input before initialization');
    sandbox = await createRepositorySandbox({ binary: process.env.CODEX_BINARY || process.env.HOME + '/.local/bin/codex', workspace: args[1], runtime: args[2], role: args[3] });
    return { ...await originalStart(...args), isolation_evidence: sandbox.evidence };
  };
  t.after(async () => { await sandbox?.stop(); });
  const x = await start(), metadata = submittedAttestation(api), e = c.task(x.task_id).implementer.executor.isolation_evidence;
  await sandbox.stop(); // Stop real workers before setup's fixture cleanup.
  assert.equal((await api.retrieve(x.implementer.session_id)).environment.sandbox_mode, 'danger-full-access');
  assert.equal(metadata.provenance, 'controller');
  assert.equal(metadata.task_id, x.task_id);
  assert.equal(metadata.repository.repository_id, 'fixture');
  assert.equal(metadata.repository.baseline_commit, baseline);
  assert.equal(metadata.repository.worktree_id, x.task_id);
  assert.equal(metadata.effective_sandbox.profile, 'bridge_task');
  assert.equal(metadata.effective_sandbox.policy_sha256, e.policy_sha256);
  assert.equal(metadata.effective_sandbox.initialized, true);
  assert(Object.values(metadata.effective_sandbox.probes).every(v => v === true));
  assert.equal(metadata.effective_sandbox.command_network_access, false);
  assert.equal(metadata.effective_sandbox.command_execution_covered, true);
  assert.equal(metadata.effective_sandbox.file_write_rpcs_covered, true);
  assert(metadata.effective_sandbox.writable_roots.includes(metadata.repository.worktree_path));
  assert.equal(metadata.effective_sandbox.writable_roots.length, 2);
  assert.match(metadata.outer_executor.distinction, /danger-full-access/);
  assert.match(metadata.outer_executor.distinction, /not the effective repository policy/);
  assert.match(api.created[0].agent.instructions, /without needing a human to restate it/);
  assert.match(api.created[0].agent.instructions, /stop if/);
  assert.equal(api.sent.length, 1);
  assert.equal(x.implementer.state, 'running');
});

for (const [name, corrupt] of [
  ['missing evidence', owner => { delete owner.isolation_evidence; }],
  ['failed initialization', owner => { owner.isolation_evidence.initialized = false; }],
  ['missing probe', owner => { delete owner.isolation_evidence.preflight.outside_truncate_denied; }],
  ['failed network probe', owner => { owner.isolation_evidence.preflight.inet_inet6_unix_connect_denied = false; }],
  ['uncovered file writes', owner => { owner.isolation_evidence.filesystem_rpc_sandboxed = false; }],
  ['network enabled', owner => { owner.isolation_evidence.policy.network.enabled = true; }],
  ['extra writable root', owner => { owner.isolation_evidence.policy.filesystem['/tmp'] = 'write'; }],
  ['missing policy hash', owner => { delete owner.isolation_evidence.policy_sha256; }],
]) test(`repository input stops before implementation on ${name}`, async t => {
  const { c, api, executor, input } = await setup(t);
  const original = executor.start.bind(executor);
  executor.start = async (...args) => { const owner = await original(...args); corrupt(owner); return owner; };
  const x = await c.start(input); await Promise.all([...c.jobs.values()]);
  assert.equal(c.task(x.task_id).implementer.error, 'REPOSITORY_SANDBOX_ATTESTATION_UNAVAILABLE');
  assert.equal(api.sent.length, 0);
});

test('authorized repository continuation refreshes controller evidence and rejects missing attestation', async t => {
  const { c, api, executor, start } = await setup(t); const x = await start();
  api.pending(x.implementer.session_id);
  await c.continue({ task_id: x.task_id, request_id: 'attested_continue', instruction: 'Ada' });
  assert.equal(submittedAttestation(api, 1).task_id, x.task_id);
  assert.equal(api.sent[1].payload.events[0].type, 'agent.session.input.tool_result');
  assert(api.sent[1].payload.events[0].output.endsWith('Ada'));
  api.pending(x.implementer.session_id);
  const original = executor.start.bind(executor);
  executor.start = async (...args) => { const owner = await original(...args); delete owner.isolation_evidence; return owner; };
  await assert.rejects(c.continue({ task_id: x.task_id, request_id: 'missing_continue', instruction: 'Ada' }), /REPOSITORY_SANDBOX_ATTESTATION_UNAVAILABLE/);
  assert.equal(api.sent.length, 2);
});
