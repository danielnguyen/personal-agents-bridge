import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { registrationProcess } from '../repositories.mjs';
import { observeValidationProcess } from '../local-validation.mjs';

const env = { PATH: '/usr/bin:/bin' };
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const run = (script, options = {}, args = []) => registrationProcess('/bin/sh', ['-c', script, 'fixture', ...args], { env, timeout: 3000, ...options });
async function fixture(context) {
  const root = await fs.mkdtemp('/tmp/pab-process-test-');
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('short command preserves output and fixed umask', async () => {
  assert.equal(await run('printf ok; umask'), 'ok0022\n');
});

test('healthy long execution never scans the process table', async context => {
  const original = fs.readdir.bind(fs);
  let scans = 0;
  context.mock.method(fs, 'readdir', async (...args) => { if (args[0] === '/proc') scans++; return original(...args); });
  const running = run('sleep 0.4; printf ok');
  await sleep(150);
  const healthyScans = scans;
  assert.equal(await running, 'ok');
  assert.equal(healthyScans, 0);
  assert.equal(scans, 0);
});

test('GNU timeout establishes its own group before running the command', async () => {
  const output = await registrationProcess('/usr/bin/python3', ['-B', '-c',
    'import os,json; print(json.dumps([os.getpid(),os.getppid(),os.getpgrp(),os.getpgid(os.getppid())]))'], { env });
  const [command, parent, group, parentGroup] = JSON.parse(output);
  assert.notEqual(command, parent);
  assert.equal(group, parent);
  assert.equal(parentGroup, parent);
});

test('nonzero exit remains sanitized with actual status', async () => {
  await assert.rejects(run('echo private-detail >&2; exit 7'), error => error.code === 'REGISTRATION_PROCESS_FAILED' && error.status === 7 && !error.message.includes('private'));
});

test('real spawn error with missing cwd settles without a process', async context => {
  await assert.rejects(run('true', { cwd: path.join(await fixture(context), 'absent') }), { code: 'REGISTRATION_PROCESS_FAILED' });
});

test('missing executable remains a sanitized failure', async () => {
  await assert.rejects(registrationProcess('/nonexistent/pab-private-executable', [], { env }), error => error.code === 'REGISTRATION_PROCESS_FAILED' && !error.message.includes('private'));
});

test('preaborted operation never starts', async context => {
  const marker = path.join(await fixture(context), 'marker'), abort = new AbortController();
  abort.abort();
  await assert.rejects(run('touch "$1"', { signal: abort.signal }, [marker]), { code: 'REGISTRATION_INTERRUPTED' });
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
});

for (const timing of ['immediate', 'running']) test(`${timing} cancellation terminates the owned group`, async context => {
  const marker = path.join(await fixture(context), 'marker'), abort = new AbortController();
  const running = assert.rejects(run('(sleep 0.3; touch "$1") & wait', { signal: abort.signal }, [marker]), { code: 'REGISTRATION_INTERRUPTED' });
  if (timing === 'running') await sleep(80);
  abort.abort();
  await running;
  await sleep(350);
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
});

test('deadline kills descendants before their scheduled side effect', async context => {
  const marker = path.join(await fixture(context), 'marker');
  await assert.rejects(run('(sleep 0.3; touch "$1") & wait', { timeout: 80 }, [marker]), { code: 'REGISTRATION_PROCESS_TIMEOUT' });
  await sleep(350);
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
});

for (const stream of ['stdout', 'stderr']) test(`${stream} overflow terminates the group and remains sanitized`, async context => {
  const marker = path.join(await fixture(context), 'marker');
  await assert.rejects(run(`(sleep 0.3; touch "$1") & printf private-output${stream === 'stderr' ? ' >&2' : ''}; wait`,
    { maxBuffer: 3 }, [marker]), error => error.code === 'REGISTRATION_OUTPUT_LIMIT' && !error.message.includes('private'));
  await sleep(350);
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
});

for (const pipes of ['inherited', 'closed']) test(`parent exit with ${pipes} descendant descriptors is not success`, async context => {
  const marker = path.join(await fixture(context), 'marker');
  await assert.rejects(run(`(sleep 0.4; touch "$1") ${pipes === 'closed' ? '>/dev/null 2>&1' : ''} & exit 0`, {}, [marker]), { code: 'REGISTRATION_DESCENDANTS_REMAINED' });
  await sleep(450);
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
});

test('verification failure cannot claim termination, and stops scanning after rejection', async context => {
  const original = fs.readdir.bind(fs), marker = path.join(await fixture(context), 'marker');
  let scans = 0;
  context.mock.method(fs, 'readdir', async (...args) => {
    if (args[0] === '/proc') { scans++; throw Object.assign(Error('private proc error'), { code: 'EACCES' }); }
    return original(...args);
  });
  await assert.rejects(run('(sleep 0.3; touch "$1") & exit 0', {}, [marker]), { code: 'REGISTRATION_TERMINATION_UNCERTAIN' });
  const settledScans = scans;
  await sleep(350);
  assert(scans > 0);
  assert.equal(scans, settledScans);
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
});

test('stalled final verification is bounded and cannot continue scanning after settlement', async context => {
  const original = fs.readdir.bind(fs), marker = path.join(await fixture(context), 'marker');
  let release, scans = 0;
  const blocked = new Promise(resolve => { release = resolve; });
  context.mock.method(fs, 'readdir', async (...args) => {
    if (args[0] === '/proc') { scans++; await blocked; }
    return original(...args);
  });
  const start = Date.now();
  try {
    await assert.rejects(run('(sleep 4; touch "$1") & exit 0', { timeout: 5000 }, [marker]), { code: 'REGISTRATION_TERMINATION_UNCERTAIN' });
    assert(Date.now() - start < 3000);
    assert.equal(scans, 1);
  } finally { release(); }
  await sleep(100);
  assert.equal(scans, 1);
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
});

test('failed group signal remains uncertain even if subsequent cleanup succeeds', async context => {
  const original = process.kill.bind(process), marker = path.join(await fixture(context), 'marker');
  const abort = new AbortController();
  let denied = false;
  context.mock.method(process, 'kill', (pid, signal) => {
    if (pid < 0 && signal === 'SIGKILL' && !denied) {
      denied = true;
      throw Object.assign(Error('private denial'), { code: 'EPERM' });
    }
    return original(pid, signal);
  });
  const running = assert.rejects(run('(sleep 0.4; touch "$1") & wait', { signal: abort.signal }, [marker]), { code: 'REGISTRATION_TERMINATION_UNCERTAIN' });
  await sleep(80); abort.abort(); await running;
  await sleep(450);
  assert.equal(denied, true);
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
});

test('unrelated real validation deadline and cancellation finish during healthy registration', async () => {
  let active = true;
  const running = run('sleep 0.6').finally(() => { active = false; });
  const abort = new AbortController();
  const deadline = observeValidationProcess('/bin/sleep', ['5'], { env, timeoutMs: 60, bound: value => value });
  const cancelled = observeValidationProcess('/bin/sleep', ['5'], { env, timeoutMs: 3000, signal: abort.signal, bound: value => value });
  await sleep(40); abort.abort();
  const [timed, stopped] = await Promise.all([deadline, cancelled]);
  assert.equal(timed.status, 'timed_out'); assert.equal(timed.termination_confirmed, true);
  assert.equal(stopped.status, 'interrupted'); assert.equal(stopped.termination_confirmed, true);
  assert.equal(active, true);
  await running;
});
