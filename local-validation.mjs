import { spawn, execFileSync } from 'node:child_process';
import { promises as fs, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const VALIDATION_VERSION = 'pab.controller-local-validation.v1';
const OUTPUT_LIMIT = 2048;
const fail = code => { throw Object.assign(new Error(code), { code }); };
export const validationEnvironment = home => ({ PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: home,
  CODEX_HOME: home, TMPDIR: path.join(home, 'tmp'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', PYTHONDONTWRITEBYTECODE: '1', RUST_LOG: 'off' });

function treeGit(repo, args) {
  return execFileSync('/usr/bin/git', ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
    { cwd: repo, env: { ...validationEnvironment('/nonexistent'), GIT_ALLOW_PROTOCOL: '' }, timeout: 10000, maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
}

export async function materializeValidationTree(repo, tree, destination, signal) {
  if (!/^[a-f0-9]{40,64}$/.test(tree)) fail('VALIDATION_TREE_INVALID');
  const entries = new TextDecoder('utf-8', { fatal: true }).decode(treeGit(repo, ['ls-tree', '-rz', tree])).split('\0').filter(Boolean);
  if (entries.length > 2000) fail('VALIDATION_TREE_SIZE_LIMIT');
  let bytes = 0; const deadline = Date.now() + 10000;
  for (const entry of entries) {
    if (signal?.aborted || Date.now() > deadline) fail('VALIDATION_CAPTURE_INTERRUPTED');
    const match = /^(100644|100755) blob ([a-f0-9]{40,64})\t(.+)$/s.exec(entry);
    if (!match) fail('VALIDATION_TREE_ENTRY_UNSUPPORTED');
    const [, mode, object, name] = match;
    if (path.isAbsolute(name) || name.includes('\\') || name.split('/').some(part => !part || ['.', '..', '.git'].includes(part))) fail('VALIDATION_TREE_PATH_UNSAFE');
    const contents = treeGit(repo, ['cat-file', 'blob', object]);
    bytes += contents.length;
    if (bytes > 16 * 1024 * 1024) fail('VALIDATION_TREE_SIZE_LIMIT');
    const target = path.join(destination, name);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, contents, { flag: 'wx', mode: mode === '100755' ? 0o755 : 0o644 });
    await fs.chmod(target, mode === '100755' ? 0o755 : 0o644);
  }
  return { files: entries.length, bytes, source: 'git_tree_blobs', filters_applied: false };
}

function groupAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return true;
  try {
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      let stat;
      try { stat = readFileSync(`/proc/${name}/stat`, 'utf8'); }
      catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') continue; return true; }
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(fields[2]) === pid && !['Z', 'X'].includes(fields[0])) return true;
    }
    return false;
  } catch { return true; }
}

export function observeValidationProcess(binary, args, { cwd, env, signal, timeoutMs, bound, spawnProcess = spawn, alive = groupAlive, kill = process.kill }) {
  return new Promise(resolve => {
    const output = { stdout: { data: Buffer.alloc(0), bytes: 0 }, stderr: { data: Buffer.alloc(0), bytes: 0 } };
    let child, timer, grace, settled = false, closed = false, spawned = false, spawnFailed = false;
    let timedOut = false, cancelled = signal?.aborted === true, background = false, exitCode = null, exitSignal = null;
    const finish = () => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(grace); signal?.removeEventListener('abort', abort);
      const terminationConfirmed = spawnFailed || (spawned && closed && !alive(child.pid));
      const streams = Object.fromEntries(Object.entries(output).map(([name, value]) => {
        let text, encodingError = false;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(value.data); }
        catch { text = value.data.toString('utf8'); encodingError = true; }
        const sanitized = bound(text, OUTPUT_LIMIT);
        return [name, { text: sanitized, bytes_observed: value.bytes, truncated: value.bytes > OUTPUT_LIMIT,
          redacted: sanitized !== text, encoding_error: encodingError, available: spawned && closed }];
      }));
      const status = !terminationConfirmed ? 'uncertain' : cancelled || background ? 'interrupted' : timedOut ? 'timed_out' :
        !closed || !Number.isInteger(exitCode) ? 'unavailable' : exitCode !== 0 || exitSignal ? 'failed' :
          Object.values(streams).some(value => value.truncated || value.redacted || value.encoding_error || !value.available) ? 'incomplete' : 'passed';
      resolve({ status, start_observed: spawned, completion_observed: closed, exit_code: exitCode, signal: exitSignal,
        timeout: timedOut, cancelled, background_processes_observed: background, termination_confirmed: terminationConfirmed,
        independently_observed: true, ...streams });
    };
    const terminate = () => {
      if (spawned) { try { kill(-child.pid, 'SIGKILL'); } catch {} }
      if (!grace) grace = setTimeout(finish, 1000);
    };
    const abort = () => { cancelled = true; terminate(); };
    if (cancelled) { spawnFailed = true; finish(); return; }
    try { child = spawnProcess(binary, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { spawnFailed = true; finish(); return; }
    for (const name of ['stdout', 'stderr']) child[name]?.on('data', buffer => {
      const value = output[name], remaining = Math.max(0, OUTPUT_LIMIT - value.bytes);
      value.bytes += buffer.length; value.data = Buffer.concat([value.data, buffer.subarray(0, remaining)]);
    });
    child.once('spawn', () => { spawned = true; if (cancelled) terminate(); });
    child.once('error', () => { spawnFailed = !spawned; if (spawned) terminate(); else finish(); });
    child.once('close', (code, observedSignal) => {
      closed = true; exitCode = Number.isInteger(code) ? code : null; exitSignal = observedSignal || null;
      if (spawned && alive(child.pid)) { background = true; terminate(); }
      else finish();
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
  });
}

export class LocalValidation {
  constructor({ root, binary = process.env.CODEX_BINARY || `${homedir()}/.local/bin/codex`, timeoutMs = 60000, bound = value => value }) {
    this.root = root; this.binary = binary; this.timeoutMs = Math.min(timeoutMs, 60000); this.bound = bound;
    this.abort = new AbortController(); this.terminationConfirmed = true;
  }
  cancel() { this.abort.abort(); }
  async run({ repo, tree, commands, attemptId, onRecord }) {
    if (!Array.isArray(commands) || commands.length > 10 || commands.some(command => typeof command !== 'string' || !command || command.length > 1000 || command.includes('\0'))) fail('VALIDATION_COMMANDS_INVALID');
    const results = [];
    let persistenceFailed = false;
    const persist = record => {
      try { onRecord(structuredClone(record)); }
      catch (error) { persistenceFailed = true; this.cancel(); throw error; }
    };
    for (const [index, command] of commands.entries()) {
      if (this.abort.signal.aborted) break;
      const record = { attempt_id: randomUUID(), validation_attempt_id: attemptId, command_index: index, command,
        candidate_tree: tree, cwd: null, status: 'preparing', start_attempted: false, start_observed: false,
        completion_observed: false, independently_observed: true, termination_confirmed: true,
        termination_scope: 'launched_process_group_only', escaped_descendants_verified: false,
        exit_code: null, signal: null, timeout: false, cancelled: false, started_at: null, completed_at: null,
        stdout: { text: '', available: false, bytes_observed: 0, truncated: false, redacted: false },
        stderr: { text: '', available: false, bytes_observed: 0, truncated: false, redacted: false } };
      results.push(record); persist(record);
      try {
        const directory = await fs.mkdtemp(path.join(this.root, 'validation-'));
        const cwd = path.join(directory, 'candidate'), control = path.join(directory, 'control'), scratch = path.join(directory, 'scratch');
        for (const folder of [cwd, control, scratch, path.join(control, 'tmp'), path.join(scratch, 'tmp')]) await fs.mkdir(folder, { mode: 0o700 });
        record.cwd = cwd;
        const identity = await fs.stat(cwd);
        record.cwd_identity = { realpath: await fs.realpath(cwd), device: identity.dev, inode: identity.ino };
        record.materialization = await materializeValidationTree(repo, tree, cwd, this.abort.signal);
        if (this.abort.signal.aborted) { record.status = 'interrupted'; persist(record); break; }
        const filesystem = { '/': 'read', [cwd]: 'write', [scratch]: 'write', [path.join(cwd, '.git')]: 'read', [path.join(cwd, '.codex')]: 'read' };
        const table = `{ bridge_task = { filesystem = { ${Object.entries(filesystem).map(([name, access]) => `${JSON.stringify(name)} = ${JSON.stringify(access)}`).join(', ')} }, network = { enabled = false } } }`;
        const env = validationEnvironment(control), commandEnv = validationEnvironment(scratch);
        const args = ['sandbox', '-c', `permissions=${table}`, '-P', 'bridge_task', '-C', control, '--', '/usr/bin/env', '-i',
          ...Object.entries(commandEnv).map(([name, value]) => `${name}=${value}`), '/bin/sh', '-c', 'cd -- "$1" && exec /bin/sh -c "$2"', 'pab-validation', cwd, command];
        record.status = 'running'; record.start_attempted = true; record.started_at = new Date().toISOString();
        persist(record);
        this.terminationConfirmed = false;
        const observed = await observeValidationProcess(this.binary, args, { cwd: control, env, signal: this.abort.signal,
          timeoutMs: this.timeoutMs, bound: this.bound });
        this.terminationConfirmed = observed.termination_confirmed;
        Object.assign(record, observed, { completed_at: new Date().toISOString() });
      } catch (error) {
        if (persistenceFailed) throw error;
        record.status = this.terminationConfirmed ? 'unavailable' : 'uncertain';
        record.diagnostic = /^VALIDATION_[A-Z_]+$/.test(error.code || '') ? error.code : 'VALIDATION_EXECUTION_UNAVAILABLE';
        record.termination_confirmed = this.terminationConfirmed;
      }
      persist(record);
      if (!this.terminationConfirmed || this.abort.signal.aborted) break;
    }
    return results;
  }
}

export function independentValidationPassed(validation, commands, reviewedState, taskId) {
  return !!reviewedState?.tree_sha && validation?.version === VALIDATION_VERSION && validation.provenance === 'controller_process_observation' &&
    typeof taskId === 'string' && validation.task_id === taskId &&
    validation.status === 'completed' && validation.original_unchanged === true && validation.termination_confirmed === true &&
    JSON.stringify(validation.reviewed_git_state) === JSON.stringify(reviewedState) && typeof validation.attempt_id === 'string' &&
    Array.isArray(validation.results) && validation.results.length === commands.length &&
    new Set(validation.results.map(record => record?.attempt_id)).size === commands.length &&
    validation.results.every((record, index) => record && record.command === commands[index] && record.command_index === index &&
      record.validation_attempt_id === validation.attempt_id && typeof record.attempt_id === 'string' && typeof record.cwd === 'string' &&
      record.cwd_identity?.realpath === record.cwd && Number.isInteger(record.cwd_identity.device) && Number.isInteger(record.cwd_identity.inode) &&
      record.materialization?.source === 'git_tree_blobs' && record.materialization.filters_applied === false &&
      record.candidate_tree === reviewedState.tree_sha && record.status === 'passed' && record.independently_observed === true &&
      record.start_attempted === true && record.start_observed === true && record.completion_observed === true && record.termination_confirmed === true &&
      record.exit_code === 0 && record.signal === null && record.timeout === false && record.cancelled === false && record.background_processes_observed === false &&
      ['stdout', 'stderr'].every(name => record[name]?.available === true && record[name].truncated === false && record[name].redacted === false && record[name].encoding_error === false && typeof record[name].text === 'string'));
}
