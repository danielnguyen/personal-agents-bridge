import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { repoGit } from '../repositories.mjs';
import { LocalValidation, VALIDATION_VERSION, validationEnvironment, materializeValidationTree, observeValidationProcess, independentValidationPassed } from '../local-validation.mjs';
import { validateLocalReview } from '../local-reviewer-instructions.mjs';
import { LOCAL_EVIDENCE_VERSION, budgetLocalPacket } from '../local-evidence.mjs';
import { contract } from './helpers.mjs';

async function fixture(context) {
  const root = await fs.mkdtemp('/tmp/pab-independent-validation-'), repo = path.join(root, 'repo');
  await fs.mkdir(repo); repoGit(repo, 'init', '-q');
  await fs.writeFile(path.join(repo, 'answer.txt'), '42\n'); repoGit(repo, 'add', '.');
  repoGit(repo, '-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture');
  const tree = repoGit(repo, 'rev-parse', 'HEAD^{tree}').trim();
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, repo, tree };
}

test('native sandbox independently validates an exact tree, denies networking/outside writes and excludes inherited credentials', async context => {
  const value = await fixture(context), before = repoGit(value.repo, 'status', '--porcelain=v1');
  const script = `import os,pathlib,socket
assert pathlib.Path('answer.txt').read_bytes()==b'42\\n'
assert not any('KEY' in name or 'TOKEN' in name or name=='SSH_AUTH_SOCK' for name in os.environ)
assert not pathlib.Path(os.environ['HOME'],'auth.json').exists()
for family,address in [(socket.AF_INET,('127.0.0.1',9)),(socket.AF_INET6,('::1',9)),(socket.AF_UNIX,'/tmp/pab-no-socket')]:
 try: socket.socket(family).connect(address)
 except PermissionError: pass
 else: raise AssertionError('network allowed')
try: pathlib.Path(${JSON.stringify(path.join(value.repo, 'answer.txt'))}).write_text('bad')
except PermissionError: pass
except OSError as error: assert error.errno==30
else: raise AssertionError('outside write allowed')
pathlib.Path('answer.txt').write_text('test artifact')
print('independently checked')`;
  const exact = 'python3 -B -c ' + "'" + script.replaceAll("'", "'\\''") + "'";
  const runner = new LocalValidation({ root: value.root });
  const records = [];
  const results = await runner.run({ ...value, commands: [exact, 'test "$(cat answer.txt)" = 42'], attemptId: 'validation-attempt', onRecord: record => records.push(record) });
  assert.equal(results.length, 2);
  for (const result of results) assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.equal(results[0].command, exact); assert.equal(results[0].candidate_tree, value.tree);
  assert.match(results[0].stdout.text, /independently checked/); assert.equal(results[0].exit_code, 0);
  assert.notEqual(results[0].cwd, value.repo); assert.notEqual(results[0].cwd, results[1].cwd);
  assert.equal(records[0].start_attempted, false); assert.equal(records[1].status, 'running');
  assert.equal(await fs.readFile(path.join(value.repo, 'answer.txt'), 'utf8'), '42\n');
  assert.equal(repoGit(value.repo, 'status', '--porcelain=v1'), before);
  assert.equal(runner.terminationConfirmed, true);
});

test('environment construction is an allowlist, not an inherited environment', () => {
  const previous = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'synthetic-fixture-key';
  try {
    const env = validationEnvironment('/tmp/empty-home');
    assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.CODEX_API_KEY, undefined);
    assert.equal(env.SSH_AUTH_SOCK, undefined); assert.equal(env.GITHUB_TOKEN, undefined);
    assert.deepEqual(Object.keys(env).sort(), ['CODEX_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_OPTIONAL_LOCKS', 'GIT_TERMINAL_PROMPT', 'HOME', 'LANG', 'PATH', 'PYTHONDONTWRITEBYTECODE', 'RUST_LOG', 'TMPDIR'].sort());
  } finally { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; }
});

for (const [label, command, status] of [
  ['nonzero exit', 'printf failure >&2; exit 7', 'failed'],
  ['truncated output', "python3 -B -c 'print(\"x\"*5000)'", 'incomplete'],
  ['redacted output', "printf 'token=synthetic'", 'incomplete'],
  ['non-UTF8 output', "python3 -B -c 'import os; os.write(1,bytes([255]))'", 'incomplete'],
]) test(`independent ${label} cannot qualify as PASS`, async context => {
  const value = await fixture(context), runner = new LocalValidation({ root: value.root, bound: text => text.replace('token=synthetic', 'token=[REDACTED]') });
  const [result] = await runner.run({ ...value, commands: [command], attemptId: 'attempt', onRecord: () => {} });
  assert.equal(result.status, status); assert.equal(result.completion_observed, true);
  if (label === 'nonzero exit') { assert.equal(result.exit_code, 7); assert.equal(result.stderr.text, 'failure'); }
  if (label === 'truncated output') { assert.equal(result.stdout.truncated, true); assert(result.stdout.text.length <= 2048); }
  if (label === 'redacted output') { assert.equal(result.stdout.redacted, true); assert(!result.stdout.text.includes('synthetic')); }
});

for (const action of ['timeout', 'cancel']) test(`independent ${action} terminates execution without PASS`, async context => {
  const value = await fixture(context), runner = new LocalValidation({ root: value.root, timeoutMs: action === 'timeout' ? 500 : 10000 });
  let cancellation;
  const results = await runner.run({ ...value, commands: ['sleep 60'], attemptId: 'attempt', onRecord: record => {
    if (action === 'cancel' && record.status === 'running') cancellation = setTimeout(() => runner.cancel(), 500);
  } });
  clearTimeout(cancellation);
  assert.equal(results[0].status, action === 'timeout' ? 'timed_out' : 'interrupted');
  assert.equal(results[0].termination_confirmed, true); assert.equal(results[0].exit_code, null);
});

test('missing completion stays uncertain even after attempted termination', async () => {
  const child = new EventEmitter(); child.pid = 424242; child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let kills = 0;
  const result = await observeValidationProcess('synthetic', [], { cwd: '/tmp', env: {}, timeoutMs: 5, bound: value => value,
    spawnProcess: () => { queueMicrotask(() => child.emit('spawn')); return child; }, alive: () => true, kill: () => { kills++; } });
  assert.equal(result.status, 'uncertain'); assert.equal(result.completion_observed, false);
  assert.equal(result.termination_confirmed, false); assert.equal(result.stdout.available, false); assert.equal(kills, 1);
});

test('pre-spawn persistence failure prevents execution and cannot produce observed PASS', async context => {
  const value = await fixture(context), runner = new LocalValidation({ root: value.root });
  await assert.rejects(runner.run({ ...value, commands: ['echo must-not-run'], attemptId: 'attempt', onRecord: () => { throw Error('disk failure'); } }), /disk failure/);
  assert.equal(runner.terminationConfirmed, true);
  assert.deepEqual((await fs.readdir(value.root)).sort(), ['repo']);
});

test('output-size controls retain independent results or reject the complete packet', () => {
  assert.throws(() => budgetLocalPacket({ independent_validation: { results: [{ stdout: { text: 'x'.repeat(128 * 1024) } }] } }), /EVIDENCE_SIZE_LIMIT/);
});

test('observed process close without an exit code is not a verified PASS', async () => {
  const child = new EventEmitter(); child.pid = 424242; child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const result = await observeValidationProcess('synthetic', [], { cwd: '/tmp', env: {}, timeoutMs: 1000, bound: value => value,
    spawnProcess: () => { queueMicrotask(() => { child.emit('spawn'); child.emit('close', null, 'SIGTERM'); }); return child; }, alive: () => false });
  assert.equal(result.status, 'unavailable'); assert.equal(result.exit_code, null); assert.equal(result.signal, 'SIGTERM');
  assert.equal(result.completion_observed, true); assert.equal(result.termination_confirmed, true);
});

test('background group activity prevents PASS even when the shell exits zero', async () => {
  const child = new EventEmitter(); child.pid = 424242; child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let active = true;
  const result = await observeValidationProcess('synthetic', [], { cwd: '/tmp', env: {}, timeoutMs: 10000, bound: value => value,
    spawnProcess: () => { queueMicrotask(() => { child.emit('spawn'); child.emit('close', 0, null); }); return child; },
    alive: () => active, kill: () => { active = false; } });
  assert.equal(result.status, 'interrupted'); assert.equal(result.background_processes_observed, true);
  assert.equal(result.termination_confirmed, true);
});

test('unsupported candidate entries and invalid tree identities fail closed', async context => {
  const value = await fixture(context), destination = path.join(value.root, 'copy'); await fs.mkdir(destination);
  await assert.rejects(materializeValidationTree(value.repo, 'HEAD', destination), /VALIDATION_TREE_INVALID/);
  await fs.symlink('/tmp', path.join(value.repo, 'link')); repoGit(value.repo, 'add', 'link');
  const tree = repoGit(value.repo, 'write-tree').trim();
  await assert.rejects(materializeValidationTree(value.repo, tree, destination), /VALIDATION_TREE_ENTRY_UNSUPPORTED/);
});

test('only complete independent exact-tree evidence may remove TEST_EVIDENCE floor; missing scope proof still FAILs', async context => {
  const value = await fixture(context), runner = new LocalValidation({ root: value.root });
  const results = await runner.run({ ...value, commands: ['test "$(cat answer.txt)" = 42'], attemptId: 'attempt', onRecord: () => {} });
  const reviewed = { tree_sha: value.tree, state: { head: 'baseline' } };
  const validation = { version: VALIDATION_VERSION, provenance: 'controller_process_observation', attempt_id: 'attempt', task_id: 'task-fixture',
    status: 'completed', original_unchanged: true, termination_confirmed: true, reviewed_git_state: reviewed, results };
  const commands = results.map(result => result.command);
  assert.equal(independentValidationPassed(validation, commands, reviewed, 'task-fixture'), true);
  for (const alter of [
    item => item.reviewed_git_state.tree_sha = 'different', item => item.results[0].exit_code = null,
    item => item.results[0].completion_observed = false, item => item.results[0].stdout.truncated = true,
    item => item.results[0].stderr.available = false, item => item.results[0].status = 'uncertain',
    item => item.results[0].candidate_tree = 'different', item => item.results[0].command = 'other',
    item => item.original_unchanged = false, item => item.results[0].independently_observed = false,
    item => item.results.push(item.results[0]), item => item.results[0].validation_attempt_id = 'other',
    item => item.task_id = 'other', item => item.results[0].cwd_identity = null,
  ]) {
    const changed = structuredClone(validation); alter(changed);
    assert.equal(independentValidationPassed(changed, commands, reviewed, 'task-fixture'), false);
  }
  const raw = { overall: 'PASS', findings: ['R1', 'R2', 'I1', 'SCOPE', 'TEST_EVIDENCE'].map(id => ({ id, status: 'PASS', evidence: 'Packet facts' })) };
  const result = validateLocalReview(JSON.stringify(raw), { ...contract(), test_commands: commands },
    { evidence_version: LOCAL_EVIDENCE_VERSION, execution: { task_id: 'task-fixture' }, independent_validation: validation, reviewed_git_state: reviewed }, value => value);
  assert.equal(result.overall, 'FAIL'); assert.deepEqual(result.controller_overrides, ['SCOPE']);
  assert.equal(result.findings.find(finding => finding.id === 'TEST_EVIDENCE').status, 'PASS');
});
