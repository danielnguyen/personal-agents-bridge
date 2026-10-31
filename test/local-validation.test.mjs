import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, readFileSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { repoGit } from '../repositories.mjs';
import { LocalValidation, VALIDATION_VERSION, validationEnvironment, materializeValidationTree, observeValidationProcess, independentValidationPassed } from '../local-validation.mjs';
import { validateLocalReview } from '../local-reviewer-instructions.mjs';
import { LOCAL_EVIDENCE_VERSION, budgetLocalPacket } from '../local-evidence.mjs';
import { contract } from './helpers.mjs';
import { assertLocalValidationCompatibility } from '../controller.mjs';

for (const command of ['git diff --check', '/usr/bin/git status', 'true && git diff --check', 'true;git log',
  'true | git diff', 'env LANG=C git status', 'command git status', 'sh -c "git diff --check"',
  "'git' diff --check", 'git\ndiff --check', 'g\\\nit diff --check']) {
  test(`source-only admission rejects literal Git command: ${JSON.stringify(command)}`, () => {
    assert.throws(() => assertLocalValidationCompatibility(['true', command]), error => {
      assert.equal(error.code, 'LOCAL_VALIDATION_GIT_COMMAND_UNSUPPORTED');
      assert.equal(error.diagnostic.command_index, 1);
      assert.match(error.diagnostic.action, /Replace this required command with source-only validation/);
      assert.match(error.diagnostic.coverage, /not shell parsing/);
      return true;
    });
  });
}

test('source-only admission supports normal tests without claiming arbitrary scripts are Git-independent', () => {
  for (const command of ['python3 -B -m unittest discover', 'python3 -B -c \'print("validation-ok")\'', 'npm test',
    'node --test test/*.test.mjs', 'test -f answer.txt', 'python3 -B check_git.py', './check.sh', '$TOOL diff --check']) {
    assert.doesNotThrow(() => assertLocalValidationCompatibility([command]));
  }
  assert.doesNotThrow(() => assertLocalValidationCompatibility([]));
});

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
  const procCheck = `/usr/bin/python3 -B -c 'import os; assert os.readlink("/proc/self")==str(os.getpid()); assert os.readlink("/proc/%d/ns/pid"%os.getpid())==os.readlink("/proc/self/ns/pid")'`;
  const results = await runner.run({ ...value, commands: [exact, 'test "$(cat answer.txt)" = 42 && ' + procCheck], attemptId: 'validation-attempt', onRecord: record => records.push(record) });
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
  ['truncated output', "python3 -B -c 'print(\"x\"*(4*1024*1024+1))'", 'incomplete'],
  ['redacted output', "printf 'token=synthetic'", 'incomplete'],
  ['non-UTF8 output', "python3 -B -c 'import os; os.write(1,bytes([255]))'", 'incomplete'],
]) test(`independent ${label} cannot qualify as PASS`, async context => {
  const value = await fixture(context), runner = new LocalValidation({ root: value.root, bound: text => text.replace('token=synthetic', 'token=[REDACTED]') });
  const [result] = await runner.run({ ...value, commands: [command], attemptId: 'attempt', onRecord: () => {} });
  assert.equal(result.status, status); assert.equal(result.completion_observed, true);
  if (label === 'nonzero exit') { assert.equal(result.exit_code, 7); assert.equal(result.stderr.text, 'failure'); }
  if (label === 'truncated output') { assert.equal(result.stdout.truncated, true); assert.equal(result.stdout.text.length, 4 * 1024 * 1024); }
  if (label === 'redacted output') { assert.equal(result.stdout.redacted, true); assert(!result.stdout.text.includes('synthetic')); }
  if (label === 'non-UTF8 output') assert.equal(result.stdout.encoding_error, true);
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

function observationFixture(events, { close = true, code = 0, observedSignal = null, stdout = [], stderr = [] } = {}) {
  const child = new EventEmitter(); child.pid = 424242; child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdio = [null, child.stdout, child.stderr, new PassThrough()];
  const kills = []; child.kill = signal => { kills.push(signal); return true; };
  return { child, kills, spawnProcess(binary, args, options) {
    assert.equal(binary, '/usr/bin/python3'); assert.equal(options.stdio[3], 'pipe');
    const request = JSON.parse(args.at(-1));
    queueMicrotask(() => {
      child.emit('spawn');
      for (const chunk of Array.isArray(stdout) ? stdout : [stdout]) child.stdout.write(chunk);
      for (const chunk of Array.isArray(stderr) ? stderr : [stderr]) child.stderr.write(chunk);
      for (const event of events) child.stdio[3].write(JSON.stringify({ nonce: request.nonce, ...event }) + '\n');
      if (close) child.emit('close', code, observedSignal);
    });
    return child;
  } };
}
const ownership = { event: 'ready', init_pid: 424243, namespace: 'pid:[123456]' };
const completion = (command = { code: 0, background: false }) => ({ event: 'complete', termination_confirmed: true, command });

const VALIDATION_CAPTURE_BYTES = 4 * 1024 * 1024;

test('ordinary verbose test output above 2 KiB qualifies when complete and sanitized', async () => {
  const output = 'test synthetic_case ... ok\n'.repeat(100);
  assert(Buffer.byteLength(output) > 2048);
  const fixture = observationFixture([ownership, completion()], { stderr: [output] });
  const result = await observeValidationProcess('synthetic', [], { timeoutMs: 1000, bound: value => value,
    spawnProcess: fixture.spawnProcess });
  assert.equal(result.status, 'passed');
  assert.equal(result.stderr.text, output);
  assert.equal(result.stderr.bytes_observed, Buffer.byteLength(output));
  assert.equal(result.stderr.truncated, false);
  assert.equal(result.termination_confirmed, true);
  assert.equal(result.exit_code, 0);
});

test('both streams retain exactly 4 MiB, including many small chunks', async () => {
  const chunk = Buffer.alloc(4096, 's'), stdout = Array.from({ length: 1024 }, () => chunk);
  const stderr = Buffer.alloc(VALIDATION_CAPTURE_BYTES, 'e');
  const fixture = observationFixture([ownership, completion()], { stdout, stderr: [stderr] });
  const result = await observeValidationProcess('synthetic', [], { timeoutMs: 1000, bound: value => value,
    spawnProcess: fixture.spawnProcess });
  assert.equal(result.status, 'passed');
  for (const [stream, character] of [['stdout', 's'], ['stderr', 'e']]) {
    assert.equal(result[stream].bytes_observed, VALIDATION_CAPTURE_BYTES);
    assert.equal(result[stream].text.length, VALIDATION_CAPTURE_BYTES);
    assert.equal(result[stream].text[0], character);
    assert.equal(result[stream].text.at(-1), character);
    assert.equal(result[stream].truncated, false);
    assert.equal(result[stream].redacted, false);
    assert.equal(result[stream].encoding_error, false);
  }
});

for (const stream of ['stdout', 'stderr']) {
  test('output beyond 4 MiB on ' + stream + ' stays incomplete and never qualifies', async () => {
    const output = Buffer.alloc(VALIDATION_CAPTURE_BYTES + 1, stream === 'stdout' ? 'a' : 'b');
    const fixture = observationFixture([ownership, completion()], { [stream]: [output] });
    const result = await observeValidationProcess('synthetic', [], { timeoutMs: 1000, bound: value => value,
      spawnProcess: fixture.spawnProcess });
    assert.equal(result.status, 'incomplete');
    assert.equal(result.exit_code, 0);
    assert.equal(result.termination_confirmed, true);
    assert.equal(result[stream].truncated, true);
    assert.equal(result[stream].bytes_observed, VALIDATION_CAPTURE_BYTES + 1);
    assert.equal(result[stream].text.length, VALIDATION_CAPTURE_BYTES);
  });
}

test('larger capture still blocks redacted output and nonzero test failures', async () => {
  const sensitive = 'token=synthetic\n'.repeat(150);
  for (const [label, code, bound, status] of [
    ['redacted', 0, value => value.replaceAll('token=synthetic', 'token=[REDACTED]'), 'incomplete'],
    ['nonzero', 2, value => value, 'failed'],
  ]) {
    const fixture = observationFixture([ownership, completion({ code, background: false })], { stderr: [sensitive] });
    const result = await observeValidationProcess('synthetic', [], { timeoutMs: 1000, bound,
      spawnProcess: fixture.spawnProcess });
    assert.equal(result.status, status, label);
    assert.equal(result.termination_confirmed, true);
    assert.equal(result.stderr.bytes_observed, Buffer.byteLength(sensitive));
    if (label === 'redacted') {
      assert.equal(result.stderr.redacted, true);
      assert(!result.stderr.text.includes('synthetic'));
    } else {
      assert.equal(result.exit_code, 2);
    }
  }
});

test('missing completion stays uncertain even after attempted termination', async () => {
  const fixture = observationFixture([ownership], { close: false });
  const result = await observeValidationProcess('synthetic', [], { cwd: '/tmp', env: {}, timeoutMs: 5, bound: value => value,
    spawnProcess: fixture.spawnProcess });
  assert.equal(result.status, 'uncertain'); assert.equal(result.completion_observed, false);
  assert.equal(result.termination_confirmed, false); assert.equal(result.stdout.available, false);
  assert.deepEqual(fixture.kills, ['SIGTERM', 'SIGKILL']);
});

test('pre-spawn persistence failure prevents execution and cannot produce observed PASS', async context => {
  const value = await fixture(context), runner = new LocalValidation({ root: value.root });
  await assert.rejects(runner.run({ ...value, commands: ['echo must-not-run'], attemptId: 'attempt', onRecord: () => { throw Error('disk failure'); } }), /disk failure/);
  assert.equal(runner.terminationConfirmed, true);
  assert.deepEqual((await fs.readdir(value.root)).sort(), ['repo']);
});

test('expanded packet capacity retains large independent validation outputs without truncation', () => {
  const text = 'x'.repeat(128 * 1024);
  const result = budgetLocalPacket({ independent_validation: { results: [{ stdout: { text } }] } });
  assert.equal(JSON.parse(result.text).independent_validation.results[0].stdout.text, text);
  assert(result.bytes > 128 * 1024);
});

test('observed supervisor close without command completion is not a verified PASS', async () => {
  const fixture = observationFixture([ownership, completion(null)]);
  const result = await observeValidationProcess('synthetic', [], { cwd: '/tmp', env: {}, timeoutMs: 1000, bound: value => value,
    spawnProcess: fixture.spawnProcess });
  assert.equal(result.status, 'unavailable'); assert.equal(result.exit_code, null);
  assert.equal(result.completion_observed, true); assert.equal(result.termination_confirmed, true);
});

test('background namespace activity prevents PASS even when the shell exits zero', async () => {
  const fixture = observationFixture([ownership, completion({ code: 0, background: true })]);
  const result = await observeValidationProcess('synthetic', [], { cwd: '/tmp', env: {}, timeoutMs: 10000, bound: value => value,
    spawnProcess: fixture.spawnProcess });
  assert.equal(result.status, 'interrupted'); assert.equal(result.background_processes_observed, true);
  assert.equal(result.termination_confirmed, true);
});

for (const [label, events, options] of [
  ['missing ownership', [completion()], {}],
  ['namespace initialization failure', [{ event: 'complete', termination_confirmed: false, command: null }], {}],
  ['unconfirmed termination', [ownership, { ...completion(), termination_confirmed: false }], {}],
  ['unobserved exit', [ownership], {}],
  ['foreign observation', [{ ...ownership, nonce: 'foreign' }, completion()], {}],
  ['duplicate completion', [ownership, completion(), completion()], {}],
  ['supervisor killed after reporting', [ownership, completion()], { code: null, observedSignal: 'SIGKILL' }],
  ['invalid command status', [ownership, completion({ code: null, background: false })], {}],
]) test(`${label} cannot claim PASS or confirmed termination`, async () => {
  const fixture = observationFixture(events, options);
  const result = await observeValidationProcess('synthetic', [], { timeoutMs: 1000, bound: value => value, spawnProcess: fixture.spawnProcess });
  assert.equal(result.status, 'uncertain'); assert.equal(result.termination_confirmed, false);
  assert.equal(result.escaped_descendants_verified, false);
});

test('pre-cancelled observation never launches a process', async () => {
  const abort = new AbortController(); abort.abort();
  const result = await observeValidationProcess('synthetic', [], { signal: abort.signal, timeoutMs: 1000, bound: value => value,
    spawnProcess: () => assert.fail('must not spawn') });
  assert.equal(result.status, 'interrupted'); assert.equal(result.start_observed, false);
  assert.equal(result.termination_confirmed, true); assert.equal(result.namespace_initialized, false);
});

test('missing command executable stays unavailable inside an owned namespace', async () => {
  const result = await observeValidationProcess('/nonexistent-pab-command', [], { timeoutMs: 3000, bound: value => value });
  assert.equal(result.status, 'unavailable'); assert.equal(result.namespace_initialized, true);
  assert.equal(result.termination_confirmed, true); assert.equal(result.exit_code, null);
});

test('ordinary real command has owned namespace and complete output', async () => {
  const result = await observeValidationProcess('/bin/sh', ['-c', 'printf namespace-ok'], { timeoutMs: 3000, bound: value => value });
  assert.equal(result.status, 'passed', JSON.stringify(result)); assert.equal(result.stdout.text, 'namespace-ok');
  assert.equal(result.termination_scope, 'linux_pid_namespace'); assert.equal(result.namespace_initialized, true);
  assert.equal(result.escaped_descendants_verified, true);
});

test('private procfs agrees with local process IDs while the outer observer retains ownership', async () => {
  const script = `import json,os
status=dict(line.split(':',1) for line in open('/proc/self/status') if ':' in line)
print(json.dumps(dict(pid=os.getpid(),proc_pid=int(status['Pid']),ids=list(map(int,status['NSpid'].split())),
 proc_self=os.readlink('/proc/self'),namespace=os.readlink('/proc/%d/ns/pid'%os.getpid()),mount=os.readlink('/proc/self/ns/mnt'))))`;
  const result = await observeValidationProcess('/usr/bin/python3', ['-B', '-c', script], { timeoutMs: 3000, bound: value => value });
  assert.equal(result.status, 'passed', JSON.stringify(result));
  const identity = JSON.parse(result.stdout.text);
  assert.equal(identity.proc_pid, identity.pid); assert.equal(identity.proc_self, String(identity.pid));
  assert.deepEqual(identity.ids, [identity.pid]);
  assert.equal(result.namespace_identity.namespace, identity.namespace);
  assert(result.namespace_identity.init_pid > 1);
  assert.notEqual(identity.namespace, await fs.readlink('/proc/self/ns/pid'));
  assert.notEqual(identity.mount, await fs.readlink('/proc/self/ns/mnt'));
  assert.equal(result.termination_confirmed, true);
});

for (const [label, script, flag] of [
  ['non-UTF8', 'import os; os.write(1,bytes([255]))', 'encoding_error'],
  ['truncated', 'print("x"*(4*1024*1024+1))', 'truncated'],
]) test(`real namespace ${label} output retains explicit incomplete evidence`, async () => {
  const result = await observeValidationProcess('/usr/bin/python3', ['-B', '-c', script], { timeoutMs: 3000, bound: value => value });
  assert.equal(result.status, 'incomplete', JSON.stringify(result)); assert.equal(result.stdout[flag], true);
  assert.equal(result.exit_code, 0); assert.equal(result.background_processes_observed, false);
  assert.equal(result.termination_confirmed, true);
});

test('a fast command exit cannot overtake its buffered completion observation', async () => {
  const result = await observeValidationProcess('/bin/true', [], { timeoutMs: 3000, bound: value => value,
    spawnProcess(binary, args, options) {
      const changed = [...args]; changed[2] = args[2].replace('os.close(gate_writer)', 'os.close(gate_writer); time.sleep(0.1)');
      assert.notEqual(changed[2], args[2]);
      return spawn(binary, changed, options);
    }
  });
  assert.equal(result.status, 'passed', JSON.stringify(result)); assert.equal(result.exit_code, 0);
  assert.equal(result.termination_confirmed, true);
});

for (const [fault, before, after] of [
  ['namespace creation', "'--map-current-user'", "'--pab-invalid-option'"],
  ['procfs mount', "'--mount-proc'", "'--mount-proc=/nonexistent-pab-proc'"],
  ['missing procfs mount', "'--mount-proc',", ''],
  ['local PID identity', "report(event='ready',pid=1,", "report(event='ready',pid=2,"],
  ['PID namespace identity', 'namespace=namespace,mount_namespace=', "namespace='pid:[0]',mount_namespace="],
  ['mount namespace identity', "mount_namespace=os.readlink('/proc/self/ns/mnt')", "mount_namespace='mnt:[0]'"],
  ['ambiguous wrapper children', 'if len(children)!=1:', 'children+=children\n     if len(children)!=1:'],
  ['ownership verification', "assert int(status['PPid'])==wrapper.pid", "assert False and int(status['PPid'])==wrapper.pid"],
]) test(`real ${fault} failure never dispatches the command or falls back`, async () => {
  const result = await observeValidationProcess('/bin/echo', ['must-not-execute'], { timeoutMs: 3000, bound: value => value,
    spawnProcess(binary, args, options) {
      const changed = [...args];
      changed[2] = args[2].replace(before, after);
      assert.notEqual(changed[2], args[2]);
      return spawn(binary, changed, options);
    }
  });
  assert.equal(result.status, 'uncertain'); assert.equal(result.namespace_initialized, false);
  assert.equal(result.termination_confirmed, false); assert.equal(result.stdout.text, '');
});

test('interrupted output processing cannot fabricate a passing result', async () => {
  const fixture = observationFixture([ownership, completion()]);
  const result = await observeValidationProcess('synthetic', [], { timeoutMs: 1000,
    bound() { throw Error('output processing failed'); }, spawnProcess: fixture.spawnProcess });
  assert.equal(result.status, 'uncertain'); assert.equal(result.termination_confirmed, false);
});

test('command output cannot substitute for the private observation channel', async () => {
  const fixture = observationFixture([]);
  fixture.child.stdout.write(JSON.stringify({ ...ownership, ...completion() }));
  const result = await observeValidationProcess('synthetic', [], { timeoutMs: 1000, bound: value => value, spawnProcess: fixture.spawnProcess });
  assert.equal(result.status, 'uncertain'); assert.equal(result.termination_confirmed, false);
});

// This observer runs in the test's namespace, holds a pidfd while the escaped
// process is alive, and requires actual exit plus /proc disappearance afterward.
const watchExit = `import json,os,select,sys,time
pid=int(sys.argv[1]); fd=os.pidfd_open(pid)
assert not select.select([fd],[],[],0)[0], 'escaped process was not observed alive'
print('WATCHING',flush=True)
assert select.select([fd],[],[],2.5)[0], 'escaped process still running before its safety alarm'
deadline=time.monotonic()+1
while os.path.exists('/proc/%d'%pid) and time.monotonic()<deadline: time.sleep(.005)
assert not os.path.exists('/proc/%d'%pid), 'escaped process not reaped'
os.close(fd)
print('EXIT_VERIFIED',flush=True)`;
const escapingCommand = `import ctypes,json,os,signal,time
reader,writer=os.pipe()
child=os.fork()
if child==0:
 os.close(reader); os.setsid()
 ctypes.CDLL(None).prctl(15,ctypes.c_char_p(b'pab-escape'),0,0,0)
 signal.signal(signal.SIGALRM,lambda *_:os._exit(124)); signal.alarm(4)
 status=dict(line.split(':',1) for line in open('/proc/self/status') if ':' in line)
 os.write(writer,(json.dumps({'pid':int(status['NSpid'].split()[0]),'inner_pid':os.getpid(),'pgid':os.getpgrp(),'sid':os.getsid(0)})+'\\n').encode())
 os.close(writer)
 while True: signal.pause()
os.close(writer)
print(os.read(reader,1024).decode(),end='',flush=True)
time.sleep(float(__import__('sys').argv[1]))`;

function findEscapedProcess(nonce) {
  const found = [];
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      if (readFileSync(`/proc/${pid}/comm`, 'utf8').trim() !== 'pab-escape') continue;
      if (!readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').includes(nonce)) continue;
      const status = readFileSync(`/proc/${pid}/stat`, 'utf8'), fields = status.slice(status.lastIndexOf(')') + 2).split(' ');
      assert.notEqual(fields[0], 'Z');
      assert.equal(Number(fields[2]), Number(pid)); assert.equal(Number(fields[3]), Number(pid));
      found.push({ pid: Number(pid), starttime: fields[19] });
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
  }
  assert(found.length <= 1, 'ambiguous escaped test process');
  return found[0];
}

for (const mode of ['background exit', 'timeout', 'cancel', 'observer loss']) test(`real escaped session is killed and reaped after ${mode}`, async context => {
  const abort = new AbortController(); let watcher, watching, identity, output = '';
  const nonce = randomUUID();
  const result = await observeValidationProcess('/usr/bin/python3', ['-B', '-c', escapingCommand, mode === 'background exit' ? '0.5' : '10', nonce], {
    timeoutMs: mode === 'timeout' ? 1000 : 3000, signal: abort.signal, bound: value => value,
    spawnProcess(binary, args, options) {
      const child = spawn(binary, args, options);
      child.stdout.on('data', data => {
        output += data;
        if (identity || !output.includes('\n')) return;
        const local = JSON.parse(output.slice(0, output.indexOf('\n')));
        assert.equal(local.pid, local.inner_pid);
        assert.equal(local.inner_pid, local.pgid); assert.equal(local.pgid, local.sid);
        identity = findEscapedProcess(nonce);
        assert(identity, 'escaped child was never independently observed');
        watcher = spawn('/usr/bin/python3', ['-B', '-c', watchExit, String(identity.pid)]);
        watching = new Promise((resolve, reject) => {
          let text = '', error = ''; watcher.stdout.on('data', data => {
            text += data;
            if (mode === 'cancel' && text.includes('WATCHING')) abort.abort();
            if (mode === 'observer loss' && text.includes('WATCHING')) child.kill('SIGKILL');
          });
          watcher.stderr.on('data', data => { error += data; });
          watcher.once('error', reject);
          watcher.once('close', code => code === 0 ? resolve(text) : reject(Error(error)));
        });
        watching.catch(() => {});
      });
      return child;
    }
  });
  assert(identity, JSON.stringify(result));
  assert.match(await watching, /EXIT_VERIFIED/);
  assert.equal(result.status, mode === 'observer loss' ? 'uncertain' : mode === 'timeout' ? 'timed_out' : 'interrupted', JSON.stringify(result));
  assert.equal(result.termination_confirmed, mode !== 'observer loss'); assert.equal(result.escaped_descendants_verified, mode !== 'observer loss');
  if (mode === 'background exit') assert.equal(result.background_processes_observed, true);
  context.diagnostic(JSON.stringify({ mode, escaped: identity, namespace: result.namespace_identity, actual_exit_verified: true }));
});

test('native validation contains an escaped session after the main command exits', async context => {
  const value = await fixture(context), runner = new LocalValidation({ root: value.root });
  const nonce = randomUUID();
  const command = '/usr/bin/python3 -B -c ' + "'" + escapingCommand.replaceAll("'", "'\\''") + "' 1 " + nonce;
  assert(command.length <= 1000);
  let settled = false, watcher, watching, identity;
  const running = runner.run({ ...value, commands: [command], attemptId: 'escaped-native', onRecord() {} }).finally(() => { settled = true; });
  // Codex may mount /proc for its own nested PID namespace. Discover the
  // uniquely tagged test child in the observer's /proc rather than confusing
  // the command's local PID with an unrelated process in the parent namespace.
  while (!settled && !identity) {
    identity = findEscapedProcess(nonce);
    if (identity) {
      watcher = spawn('/usr/bin/python3', ['-B', '-c', watchExit, String(identity.pid)]);
      watching = new Promise((resolve, reject) => {
        let output = '', error = '';
        watcher.stdout.on('data', data => { output += data; }); watcher.stderr.on('data', data => { error += data; });
        watcher.once('error', reject); watcher.once('close', code => code === 0 ? resolve(output) : reject(Error(error)));
      });
      watching.catch(() => {});
    }
    if (!identity && !settled) await new Promise(resolve => setTimeout(resolve, 10));
  }
  const [result] = await running;
  assert(['passed', 'interrupted'].includes(result.status), JSON.stringify(result));
  assert(identity, 'escaped child was never independently observed');
  assert.match(await watching, /EXIT_VERIFIED/);
  await assert.rejects(fs.stat(`/proc/${identity.pid}`), { code: 'ENOENT' });
  assert.equal(result.termination_confirmed, true); assert.equal(result.escaped_descendants_verified, true);
  context.diagnostic(JSON.stringify({ native_sandbox: true, escaped: identity, actual_exit_verified: true }));
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
