import { reviewerInstructions } from './reviewer-instructions.mjs';
import { budgetPacket, packetSizeDiagnostic } from './packet-budget.mjs';
import { captureFileRpcEvidence } from './file-rpc-evidence.mjs';
import OpenAI from 'openai';
import { GitHubPublisher, reviewedGitState, publicationState, publishReviewedTask, publicationResult } from './publication.mjs';
import { captureBefore, repositoryReviewEvidence } from './review-evidence.mjs';
import { resolveRepository, createTaskWorktree, verifyTaskWorktree, removeTaskWorktree } from './repositories.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const MAX_PACKET = 128 * 1024;
const MAX_FILES = 100;
const DEBUG_WINDOW = 30 * 86400000;
const message = text => ({ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text }] }] });
export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export class BridgeError extends Error { constructor(code) { super(code); this.code = code; } }
export function redact(text, secrets = []) {
  let s = String(text);
  for (const secret of secrets.filter(Boolean)) s = s.split(secret).join('[REDACTED]');
  return s.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
}
export function safeRelative(name) {
  if (typeof name !== 'string' || !name || name.length > 200 || name.includes('\\') || name.includes('\0') || path.isAbsolute(name) || name.split('/').some(x => !x || x === '.' || x === '..' || x === '.git') || name === 'TASK.md') throw new BridgeError('INVALID_WORKSPACE_PATH');
  return name;
}
export function processIdentity(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return `${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}`;
  } catch { return null; }
}
export async function privateDirectory(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw new BridgeError('UNSAFE_DIRECTORY');
  if (await fs.realpath(dir) !== path.resolve(dir)) throw new BridgeError('SYMLINKED_DIRECTORY');
  for (let p = path.resolve(dir); ; p = path.dirname(p)) {
    if (await fs.lstat(path.join(p, '.git')).then(() => true, () => false)) throw new BridgeError('DIRECTORY_INSIDE_REPOSITORY');
    if (p === path.dirname(p)) break;
  }
  await fs.chmod(dir, 0o700);
}
function git(cwd, ...args) {
  try { return execFileSync('/usr/bin/git', ['--literal-pathspecs', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'utf8', maxBuffer: MAX_PACKET * 2, timeout: 10000, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' } }); }
  catch (e) { if (args.includes('--no-index') && e.status === 1) return e.stdout; throw e; }
}
async function workspaceFiles(dir, prefix = '') {
  const out = [];
  for (const d of await fs.readdir(path.join(dir, prefix), { withFileTypes: true })) {
    if (!prefix && d.name === '.git') continue;
    const rel = prefix ? `${prefix}/${d.name}` : d.name;
    if (d.isSymbolicLink() || (!d.isFile() && !d.isDirectory())) throw new BridgeError('UNSAFE_WORKSPACE_ENTRY');
    if (d.isDirectory()) out.push(...await workspaceFiles(dir, rel)); else out.push(rel);
    if (out.length > MAX_FILES) throw new BridgeError('EVIDENCE_FILE_LIMIT');
  }
  return out.sort();
}
const clarify = { type: 'function', name: 'request_clarification', description: 'Stop execution and ask the human to resolve ambiguity or approve a scope change. Do not proceed until answered.', parameters: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'], additionalProperties: false } };
// Shared by TASK.md, review packets and implementer instructions. Keep default
// execution boundaries distinct from the user's explicit behavioral restrictions.
const executionRules = `This contract is authoritative. If ambiguous, use request_clarification and wait.
Only edit allowed files. Never modify TASK.md, .codex, Git history/index/configuration, protected controller paths, or the normal checkout.
No commits, pushes, merges, rebases, tags, remote branch changes, dependency installations, network calls, or subagents.
For repository tasks, require controller attestation of these structural boundaries: writes outside the task worktree/task scratch are prohibited; command/file-worker networking is denied; protected Git/controller paths remain read-only; the normal checkout must remain unmodified.
Repository sandbox read access is broad. These execution rules add no credential-read or external-path-read prohibition. Follow explicit task read prohibitions and any actual sandbox read denials; write protection does not imply read protection.
Use python3 -B when running Python. Report actual test commands and exit results.
`;
export function contractMarkdown(c) {
  return `# Task contract\n\n## Goal\n${c.goal}\n\n## Allowed files\n${c.allowed_files.map(x => `- ${x}`).join('\n')}\n\n## Requirements\n${c.requirements.map(x => `- ${x.id}: ${x.text}`).join('\n')}\n\n## Invariants\n${c.invariants.map(x => `- ${x.id}: ${x.text}`).join('\n')}\n\n## Required test commands\n${c.test_commands.map(x => '```sh\n' + x + '\n```').join('\n')}\n\n## Execution rules\n${executionRules}`;
}
// Built only from the controller's successful executor startup acknowledgement.
// Never accept an attestation from a contract, repository file, or model output.
export function repositorySandboxMetadata(t, workspace, runtime) {
  const e = t.implementer?.executor?.isolation_evidence;
  const reject = () => { throw new BridgeError('REPOSITORY_SANDBOX_ATTESTATION_UNAVAILABLE'); };
  const probes = ['scratch_write', 'outside_create_denied', 'outside_truncate_denied', 'inet_inet6_unix_connect_denied'];
  if (!e || e.provenance !== 'controller' || e.wrapper !== 'codex sandbox RPC boundary' || e.profile !== 'bridge_task' ||
      !/^[a-f0-9]{64}$/.test(e.policy_sha256 || '') || e.initialized !== true || e.command_network_access !== false ||
      e.filesystem_rpc_sandboxed !== true || e.policy?.network?.enabled !== false || probes.some(k => e.preflight?.[k] !== true)) reject();
  const filesystem = e.policy?.filesystem || {};
  const writable = Object.entries(filesystem).filter(([, permission]) => permission === 'write').map(([root]) => root);
  const scratch = writable.find(root => root !== workspace);
  if (writable.length !== 2 || !writable.includes(workspace) || !scratch || path.basename(scratch) !== 'scratch' ||
      path.dirname(path.dirname(scratch)) !== runtime || !/^sandbox-[A-Za-z0-9]+$/.test(path.basename(path.dirname(scratch)))) reject();
  const expected = { '/': 'read', [scratch]: 'write', [workspace]: 'write' };
  for (const name of ['.git', 'TASK.md', '.codex']) expected[path.join(workspace, name)] = 'read';
  if (Object.keys(filesystem).length !== Object.keys(expected).length || Object.entries(expected).some(([p, value]) => filesystem[p] !== value)) reject();
  const metadata = { provenance: 'controller', type: 'controller_repository_sandbox', version: 1, task_id: t.id,
    repository: { repository_id: t.repository.repository_id, base_ref: t.repository.base_ref, baseline_commit: t.baseline,
      worktree_id: t.repository.worktree_id, worktree_path: workspace, branch: t.repository.branch },
    effective_sandbox: { profile: e.profile, policy_sha256: e.policy_sha256, initialized: true,
      probes: Object.fromEntries(probes.map(k => [k, e.preflight[k]])), command_network_access: false,
      writable_roots: writable.sort(), filesystem_policy: filesystem, command_execution_covered: true, file_write_rpcs_covered: true,
      coverage_from_first_executor: e.coverage_from_first_executor === true },
    outer_executor: { transport_network_access: true,
      distinction: 'The outer exec-server/harness may report sandbox_mode=danger-full-access or sandboxType=none. These labels describe the outer dispatch layer, not the effective repository policy. Every command is wrapped by codex sandbox -P bridge_task; file RPCs run in a worker inside the same policy. The bridge does not obtain the harness-injected sandbox_mode through the session API.' },
    requirements: 'Use this controller startup observation as sandbox evidence, not the outer label or implementer prose. Stop before commands/writes if this attestation is absent, incomplete, failed, mismatched to this task/worktree, or contradicted by actual behavior. Contract scope and required human clarifications remain authoritative. Current enforcement does not establish historical coverage when coverage_from_first_executor is false.' };
  if (Buffer.byteLength(JSON.stringify(metadata)) > 16384) reject();
  return metadata;
}
export class LocalExecutor {
  constructor({ secrets = [], binary = process.env.CODEX_BINARY || `${homedir()}/.local/bin/codex`, executorKey = process.env.OPENAI_EXECUTOR_API_KEY || process.env.CODEX_API_KEY } = {}) { this.secrets = secrets; this.binary = binary; this.executorKey = executorKey; this.children = new Map(); }
  async start(ref, workspace, runtime, role) {
    if (!this.executorKey) throw new BridgeError('EXECUTOR_CREDENTIAL_MISSING');
    if (this.executorKey === process.env.OPENAI_API_KEY) throw new BridgeError('SEPARATE_EXECUTOR_CREDENTIAL_REQUIRED');
    await fs.mkdir(path.join(runtime, 'codex'), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(runtime, 'tmp'), { recursive: true, mode: 0o700 });
    const binary = await fs.realpath(this.binary);
    if (ref.repository_task) return this.startRepository(ref, workspace, runtime, role, binary);
    const gitStore = path.join(path.dirname(workspace), 'git-store');
    const gitReadRoot = role === 'implementer' && await fs.lstat(gitStore).then(s => s.isDirectory() && !s.isSymbolicLink(), () => false) ? gitStore : '';
    const child = spawn('/usr/bin/python3', ['-B', path.join(HERE, 'isolate.py'), workspace, runtime, role, binary, 'exec-server', '--remote', ref.remote_url, '--environment-id', ref.environment_id, '--exit-on-stdin-close'], {
      cwd: workspace, detached: true, stdio: ['pipe', 'ignore', 'ignore'],
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: runtime, CODEX_HOME: path.join(runtime, 'codex'), TMPDIR: path.join(runtime, 'tmp'), PYTHONDONTWRITEBYTECODE: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', CODEX_API_KEY: this.executorKey, RUST_LOG: 'off', GIT_OPTIONAL_LOCKS: '0', BRIDGE_GIT_READ_ROOT: gitReadRoot }
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(new BridgeError('EXECUTOR_START_FAILED'))); });
    child.once('exit', (code, signal) => this.onExit?.({ pid: child.pid, code, signal }));
    this.children.set(child.pid, child);
    const identity = processIdentity(child.pid);
    if (!identity) throw new BridgeError('EXECUTOR_EXITED');
    return { pid: child.pid, identity, isolation_evidence: { provenance: 'controller',
      wrapper: 'isolate.py', wrapper_sha256: createHash('sha256').update(await fs.readFile(path.join(HERE, 'isolate.py'))).digest('hex'),
      policy: 'Landlock fail-closed; task worktree/runtime writable; task-private Git store read-only; no normal-checkout grant',
      private_git_read_root: gitReadRoot || null, network_isolation: false } };
  }
  async startRepository(ref, workspace, runtime, role, binary) {
    const child = spawn(process.execPath, [path.join(HERE, 'repository-sandbox.mjs'), binary, workspace, runtime, role, ref.remote_url, ref.environment_id], {
      cwd: HERE, detached: true, stdio: ['pipe', 'ignore', 'ignore', 'pipe'],
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH || '', CODEX_API_KEY: this.executorKey }
    });
    let evidence;
    try {
      evidence = await new Promise((resolve, reject) => {
        let text = '';
        const timer = setTimeout(() => reject(new BridgeError('REPOSITORY_SANDBOX_FAILED')), 30000);
        const finish = (error, result) => { clearTimeout(timer); error ? reject(new BridgeError('REPOSITORY_SANDBOX_FAILED')) : resolve(result); };
        child.once('error', finish); child.once('exit', () => finish(true));
        child.stdio[3].on('data', data => {
          text += data;
          if (text.length > 16384) return finish(true);
          if (text.includes('\n')) {
            try { const e = JSON.parse(text); if (!e.initialized || e.command_network_access !== false || e.filesystem_rpc_sandboxed !== true) return finish(true); finish(null, e); }
            catch { finish(true); }
          }
        });
      });
    } catch (e) {
      child.stdin.end();
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      throw e;
    }
    child.once('exit', (code, signal) => this.onExit?.({ pid: child.pid, code, signal }));
    this.children.set(child.pid, child);
    const identity = processIdentity(child.pid);
    if (!identity) throw new BridgeError('EXECUTOR_EXITED');
    return { pid: child.pid, identity, isolation_evidence: evidence };
  }
  async stop(owner) {
    if (!owner) return true;
    if (!processIdentity(owner.pid)) return true;
    if (processIdentity(owner.pid) !== owner.identity) throw new BridgeError('EXECUTOR_IDENTITY_MISMATCH');
    const child = this.children.get(owner.pid);
    child?.stdin?.end();
    try { process.kill(-owner.pid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    for (let i = 0; i < 30 && processIdentity(owner.pid) === owner.identity; i++) await delay(100);
    if (processIdentity(owner.pid) === owner.identity) { try { process.kill(-owner.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
    if (child && child.exitCode === null && child.signalCode === null) await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(2000)]);
    this.children.delete(owner.pid);
    return processIdentity(owner.pid) !== owner.identity;
  }
}
export class Controller {
  constructor({ stateRoot = `${homedir()}/.local/state/personal-agents-bridge`, workspaceRoot = '/var/tmp/personal-agents-bridge', api, executor, publisher = new GitHubPublisher(), secrets, model = 'gpt-6-astra', timeoutMs = 900000 } = {}) {
    this.stateRoot = path.resolve(stateRoot); this.workspaceRoot = path.resolve(workspaceRoot); this.model = model;
    this.secrets = secrets || ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_EXECUTOR_API_KEY', 'CONTROL_PLANE_API_KEY'].map(k => process.env[k]).filter(Boolean);
    this.api = api || new OpenAI({ maxRetries: 0, timeout: 30000, logLevel: 'off' }).beta.agents.sessions;
    this.publisher = publisher;
    this.executor = executor || new LocalExecutor({ secrets: this.secrets });
    this.context = new AsyncLocalStorage(); this.instanceId = randomUUID();
    this.executor.onExit = status => this.executorExited(status);
    this.timeoutMs = timeoutMs; this.jobs = new Map(); this.streams = new Map(); this.cache = new Map(); this.locks = new Map(); this.closed = false;
  }
  async init() {
    await privateDirectory(this.stateRoot); await privateDirectory(this.workspaceRoot);
    this.db = new DatabaseSync(path.join(this.stateRoot, 'controller.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, task_id TEXT NOT NULL, status TEXT NOT NULL);');
    await fs.chmod(path.join(this.stateRoot, 'controller.sqlite'), 0o600);
    this.db.exec('CREATE TABLE IF NOT EXISTS failures (session_id TEXT, turn_id TEXT, expires INTEGER, value TEXT, PRIMARY KEY(session_id,turn_id)); CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, created INTEGER, value TEXT);');
    this.pruneDiagnostics();
    // No automatic replay of potentially accepted mutations after restart.
    for (const row of this.db.prepare('SELECT value FROM tasks').all()) {
      const t = JSON.parse(row.value);
      if (!t.cleaned) for (const role of ['implementer', 'reviewer']) if (t[role]?.session_id && !t[role].deleted) this.observe(t.id, role).catch(() => {});
    }
    this.sweeper = setInterval(() => this.expire().catch(() => {}), 30000); this.sweeper.unref();
    return this;
  }
  save(t) {
    this.db.prepare('INSERT OR REPLACE INTO tasks VALUES (?,?)').run(t.id, JSON.stringify(t));
    for (const row of this.db.prepare('SELECT id,value FROM audit').all()) {
      const a = JSON.parse(row.value); if (a.task_id !== t.id) continue;
      const ref = t[a.role];
      if (ref && a.bridge_request_id === (ref.active_request || ref.creation_request)) {
        a.session_id ||= ref.session_id || null;
        if (!a.turn_id && ref.turn_id && ref.turn_id !== a.previous_turn_id) a.turn_id = ref.turn_id;
        this.db.prepare('UPDATE audit SET value=? WHERE id=?').run(JSON.stringify(a), row.id);
      }
    }
  }
  pruneDiagnostics() {
    this.db.prepare('DELETE FROM failures WHERE expires < ?').run(Date.now());
    this.db.prepare('DELETE FROM audit WHERE created < ?').run(Date.now() - DEBUG_WINDOW);
  }
  bounded(value, limit = 256) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    return this.safe(String(value)).replace(/https?:\/\/[^\s<>"']+/gi, '[URL REDACTED]')
      .replace(/((?:api[_-]?key|token|secret|password|authorization)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]').slice(0, limit);
  }
  async invoke(name, input, extra, handler) {
    const id = randomUUID(), role = name === 'review_task' ? 'reviewer' : 'implementer';
    const a = { id, instance_id: this.instanceId, mcp_request_id: this.bounded(extra?.requestId), tool: name,
      bridge_request_id: this.bounded(input.request_id), task_id: input.task_id || null, role,
      session_id: null, turn_id: null, timestamp: new Date().toISOString() };
    if (a.task_id) { const ref = this.task(a.task_id)[role]; a.session_id = ref?.session_id || null; a.previous_turn_id = name === 'continue_task' ? ref?.turn_id : null; if (!input.request_id) a.turn_id = ref?.turn_id || null; }
    this.db.prepare('INSERT INTO audit VALUES (?,?,?)').run(id, Date.now(), JSON.stringify(a));
    return this.context.run(id, async () => {
      try { return await handler(input); }
      finally { const row = this.db.prepare('SELECT value FROM audit WHERE id=?').get(id); const v = JSON.parse(row.value); if (v.task_id && this.db.prepare('SELECT id FROM tasks WHERE id=?').get(v.task_id)) this.save(this.task(v.task_id)); }
    });
  }
  diagnostic(ref) {
    if (!ref?.session_id) return null;
    const row = this.db.prepare('SELECT value FROM failures WHERE session_id=? AND expires>=? ORDER BY expires DESC LIMIT 1').get(ref.session_id, Date.now());
    return row ? JSON.parse(row.value) : null;
  }
  outputFrom(items, turnId) {
    for (const item of items || []) {
      if (turnId && item.turn_id !== turnId) continue;
      let text;
      if (item.type === 'message' && item.role === 'assistant') text = (item.content || []).filter(c => c.type === 'output_text').map(c => c.text).join('\n');
      else if (item.type === 'command_execution' && typeof item.output === 'string') text = item.output;
      else if (item.type === 'function_call_output') text = typeof item.output === 'string' ? item.output : Array.isArray(item.output) ? item.output.filter(c => c.type === 'input_text').map(c => c.text).join('\n') : typeof item.error === 'string' ? item.error : null;
      if (text) return { type: item.type, text: this.bounded(text, 4096), truncated: text.length > 4096 };
    }
    return null;
  }
  recordFailure(id, role, { turn, session, event, items, reason = 'API returned no customer-safe failure details' } = {}) {
    const t = this.task(id), ref = t[role]; if (!ref) return;
    const turnId = turn?.id || event?.turn_id || ref.turn_id || null;
    const oldRow = this.db.prepare('SELECT value FROM failures WHERE session_id=? AND turn_id=?').get(ref.session_id || id, turnId || 'unknown');
    const old = oldRow ? JSON.parse(oldRow.value) : null;
    const raw = turn?.error || session?.error || event?.error;
    const apiError = raw && { type: this.bounded(raw.type), code: this.bounded(raw.code), message: this.bounded(raw.message, 2048) };
    const useful = apiError && Object.values(apiError).some(Boolean);
    const d = { status: useful || old?.status === 'api_failure' ? 'api_failure' : 'diagnostic_unavailable',
      reason: useful || old?.status === 'api_failure' ? null : this.bounded(reason === 'API returned no customer-safe failure details' ? old?.reason || reason : reason, 512),
      terminal_event_type: this.bounded(event?.type) || old?.terminal_event_type || null,
      api_error: useful ? Object.fromEntries(['type', 'code', 'message'].map(k => [k, apiError[k] || old?.api_error?.[k] || null])) : old?.api_error || null,
      session_id: ref.session_id || null, turn_id: turnId, environment_id: ref.environment_id || null,
      executor_connection_state: ref.connection_state || 'unknown', executor_exit: ref.executor_exit || null,
      timestamp: old?.timestamp || new Date().toISOString(), timestamp_source: 'controller_observed',
      latest_output: this.outputFrom(items, turnId) || old?.latest_output || null,
      action: 'Inspect this diagnostic and task correlation before authorizing another execution.' };
    this.db.prepare('INSERT OR REPLACE INTO failures VALUES (?,?,?,?)').run(ref.session_id || id, turnId || 'unknown', Date.parse(d.timestamp) + DEBUG_WINDOW, JSON.stringify(d));
    ref.state = 'failed'; ref.turn_id = turnId; this.save(t);
    return d;
  }
  executorExited({ pid, code, signal }) {
    if (this.closed) return;
    for (const row of this.db.prepare('SELECT value FROM tasks').all()) {
      const t = JSON.parse(row.value);
      for (const role of ['implementer', 'reviewer']) {
        const ref = t[role]; if (ref?.executor?.pid !== pid) continue;
        ref.executor_exit = { code: Number.isInteger(code) ? code : null, signal: this.bounded(signal, 32), status: 'exited', timestamp: new Date().toISOString() };
        this.save(t);
        if (ref.state === 'failed') this.recordFailure(t.id, role);
        if (!ref.deleted && !ref.stopping) this.reconcileFailure(t.id, role).catch(() => {});
      }
    }
  }
  async reconcileFailure(id, role) {
    let ref = this.task(id)[role]; if (!ref?.session_id) return;
    if (ref.deleted) { if (ref.state === 'failed' && !this.diagnostic(ref)) this.recordFailure(id, role, { reason: 'Remote session already deleted; original diagnostic was not retained' }); return; }
    let session, turns = [], items = [], reason = 'API returned no customer-safe failure details';
    try { session = await this.api.retrieve(ref.session_id); } catch (e) { reason = `Session reconciliation unavailable (HTTP ${Number(e.status) || 'unknown'})`; }
    try { turns = (await this.api.turns.list(ref.session_id, { order: 'desc', limit: 100 })).data || []; } catch { reason = 'Turn reconciliation unavailable'; }
    const latest = turns.find(t => !t.subagent_id);
    const failed = latest?.status === 'failed' ? [latest] : [];
    if (failed.length || session?.status === 'failed' || (!latest && ref.state === 'failed')) {
      try { items = (await this.api.items.list(ref.session_id, { order: 'desc', limit: 100 })).data || []; } catch { /* Preserve error even if output is unavailable. */ }
      for (const turn of failed.length ? failed : [latest]) this.recordFailure(id, role, { turn, session, items, reason });
    }
  }
  task(id) { const row = this.db.prepare('SELECT value FROM tasks WHERE id=?').get(id); if (!row) throw new BridgeError('UNKNOWN_TASK'); return JSON.parse(row.value); }
  safe(s) { return redact(s, this.secrets); }
  rejectSecret(input) { const s = JSON.stringify(input); if (this.safe(s) !== s) throw new BridgeError('CREDENTIAL_IN_INPUT'); }
  async locked(id, fn) {
    const prev = this.locks.get(id) || Promise.resolve();
    const job = prev.catch(() => {}).then(fn); this.locks.set(id, job);
    try { return await job; } finally { if (this.locks.get(id) === job) this.locks.delete(id); }
  }
  operation(requestId, kind, payload, taskId) {
    this.rejectSecret(payload);
    const auditId = this.context.getStore();
    if (auditId) { const a = JSON.parse(this.db.prepare('SELECT value FROM audit WHERE id=?').get(auditId).value); a.task_id = this.db.prepare('SELECT task_id FROM operations WHERE id=?').get(requestId)?.task_id || taskId; this.db.prepare('UPDATE audit SET value=? WHERE id=?').run(JSON.stringify(a), auditId); }
    const fingerprint = digest({ kind, payload }); const old = this.db.prepare('SELECT * FROM operations WHERE id=?').get(requestId);
    if (old) { if (old.fingerprint !== fingerprint) throw new BridgeError('REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT'); return old; }
    this.db.prepare('INSERT INTO operations VALUES (?,?,?,?)').run(requestId, fingerprint, taskId, 'pending'); return null;
  }
  opDone(id, status = 'accepted') { this.db.prepare('UPDATE operations SET status=? WHERE id=?').run(status, id); }
  launch(taskId, role, fn) {
    const key = `${taskId}:${role}`;
    const job = fn().catch(e => { if (!this.closed) { const t = this.task(taskId); t[role] ||= {}; t[role].error = e instanceof BridgeError ? e.code : `REMOTE_OPERATION_FAILED${e.status ? `_${e.status}` : ''}`; t[role].state = 'needs_attention'; this.save(t); } }).finally(() => this.jobs.delete(key));
    this.jobs.set(key, job);
  }
  async start(input) {
    const { contract, request_id, repository_id, base_ref = 'HEAD' } = input;
    if (Object.keys(input).some(k => !['contract', 'request_id', 'repository_id', 'base_ref'].includes(k))) throw new BridgeError('INVALID_START_INPUT');
    if (!repository_id && input.base_ref !== undefined) throw new BridgeError('BASE_REF_REQUIRES_REPOSITORY');
    this.rejectSecret(contract);
    for (const name of contract.allowed_files) safeRelative(name);
    for (const name of Object.keys(contract.initial_files || {})) safeRelative(name);
    const ids = [...contract.requirements, ...contract.invariants].map(r => r.id);
    if (new Set(ids).size !== ids.length || ids.some(id => ['SCOPE', 'TEST_EVIDENCE'].includes(id))) throw new BridgeError('DUPLICATE_OR_RESERVED_REQUIREMENT_ID');
    const id = `task_${randomUUID()}`;
    // Validate allowlisting and pin the commit before accepting any paid work.
    let repository;
    if (repository_id !== undefined) {
      if (Object.keys(contract.initial_files || {}).length) throw new BridgeError('REPOSITORY_INITIAL_FILES_UNSUPPORTED');
      try { repository = await resolveRepository(path.join(this.stateRoot, 'repositories.json'), repository_id, base_ref, this.workspaceRoot, this.stateRoot); }
      catch (e) { throw new BridgeError(/^[A-Z_]+$/.test(e.code || '') ? e.code : 'REPOSITORY_VALIDATION_FAILED'); }
    }
    const old = this.operation(request_id, 'start', repository ? { contract, repository_id, base_ref } : contract, id);
    if (old) return this.get(old.task_id);
    const active = this.db.prepare('SELECT value FROM tasks').all().filter(r => !JSON.parse(r.value).cleaned);
    if (active.length >= 3) { this.db.prepare('DELETE FROM operations WHERE id=?').run(request_id); throw new BridgeError('ACTIVE_TASK_LIMIT'); }
    const t = { id, created: Date.now(), deadline: Date.now() + this.timeoutMs, baseline: repository?.baseline_commit || null, ...(repository ? { repository } : {}), implementer: { state: 'starting' }, request_id };
    this.save(t);
    this.launch(id, 'implementer', async () => {
      const taskRoot = path.join(this.workspaceRoot, id); const repo = path.join(taskRoot, 'repo');
      await fs.mkdir(taskRoot, { recursive: true, mode: 0o700 });
      if (repository) {
        const identity = await createTaskWorktree(taskRoot, id, repository);
        const fresh = this.task(id); fresh.repository = identity; this.save(fresh);
      } else await fs.mkdir(repo, { mode: 0o700 });
      // Never overwrite repository-owned instructions (including symlinks).
      try { await fs.writeFile(path.join(repo, 'TASK.md'), contractMarkdown(contract), { mode: 0o600, flag: 'wx' }); }
      catch (e) { if (e.code === 'EEXIST') throw new BridgeError('REPOSITORY_TASK_FILE_CONFLICT'); throw e; }
      await fs.writeFile(path.join(taskRoot, 'contract.json'), JSON.stringify(contract), { mode: 0o600 });
      for (const [name, content] of Object.entries(contract.initial_files || {})) {
        await fs.mkdir(path.dirname(path.join(repo, name)), { recursive: true });
        await fs.writeFile(path.join(repo, name), content, { mode: 0o600 });
      }
      if (!repository) {
        git(repo, 'init', '--initial-branch=main'); git(repo, 'add', '--all');
        git(repo, '-c', 'user.name=Personal Agents Bridge', '-c', 'user.email=bridge@example.invalid', 'commit', '-m', 'Task baseline');
      }
      const fresh = this.task(id); fresh.baseline = git(repo, 'rev-parse', 'HEAD').trim(); this.save(fresh);
      await fs.writeFile(path.join(taskRoot, 'baseline-state.json'), JSON.stringify({ head: fresh.baseline, staged_files: git(repo, 'diff', '--cached', '--name-only'), config_hash: digest(await fs.readFile(path.join(taskRoot, repository ? 'git-store/config' : 'repo/.git/config'), 'utf8')) }), { mode: 0o600 });
      if (repository) {
        const evidence = await captureBefore(this.task(id), this.stateRoot, this.workspaceRoot, this.bounded.bind(this));
        const current = this.task(id); current.review_evidence_before = JSON.parse(this.safe(JSON.stringify(evidence))); this.save(current);
      }
      await this.openSession(id, 'implementer', repo, `Read TASK.md in ${repo}. Follow it as authoritative. Implement only allowed files, run the test commands and report actual evidence. Ask any required human question using request_clarification; wait for its result. Do not commit.`, request_id);
    });
    return this.get(id, false);
  }
  async recoverSession(t, role) {
    // Creation has no documented idempotency parameter: discover by ownership metadata, never recreate blindly.
    const matches = []; let count = 0;
    for await (const s of this.api.list({ limit: 100, order: 'desc' })) {
      if (++count > 1000) throw new BridgeError('SESSION_RECONCILIATION_LIMIT');
      if (s.metadata?.bridge_task === t.id && s.metadata?.bridge_role === role && (!t[role]?.creation_request || s.metadata?.bridge_request === t[role].creation_request)) matches.push(s);
    }
    if (matches.length > 1) throw new BridgeError('AMBIGUOUS_OWNED_SESSIONS');
    if (!matches.length) throw new BridgeError('SESSION_CREATION_OUTCOME_UNKNOWN');
    return matches[0];
  }
  async openSession(id, role, workspace, input, requestId) {
    let t = this.task(id); t[role] = { ...t[role], state: 'creating_session', active_request: requestId, creation_attempted: true, creation_request: requestId }; this.save(t);
    let s;
    const instructions = role === 'implementer'
      ? `You are the implementer. TASK.md is authoritative. Use request_clarification for missing decisions or scope conflicts, and wait. Run required tests and report commands/output accurately.\n${executionRules}`
      : reviewerInstructions;
    const repositoryInstructions = t.repository && role === 'implementer' ? ' Require controller_repository_sandbox metadata supplied by the bridge in the start/continuation input before any command or write. This metadata is generated from the executor startup acknowledgement and probes, not from TASK.md or implementer assertions. The outer executor mode and effective bridge repository policy are distinct layers. Use the attested effective policy to evaluate sandbox requirements; stop if its initialization, coverage, policy, task identity or worktree is missing or conflicting. A matching successful attestation supplies sandbox evidence without needing a human to restate it; it does not relax contract scope or other required clarifications.' : '';
    try { s = await this.api.create({ agent: { model: this.model, instructions: instructions + repositoryInstructions, ...(role === 'implementer' ? { tools: [clarify] } : {}) }, environment: { type: 'self_hosted', workspace_directory: workspace }, metadata: { bridge_task: id, bridge_role: role, bridge_request: requestId } }); }
    catch { s = await this.recoverSession(t, role); }
    t = this.task(id); t[role] = { ...t[role], session_id: s.id, environment_id: s.environment.id, state: 'connecting' }; this.save(t);
    await this.observe(id, role);
    const runtime = path.join(this.workspaceRoot, id, role === 'reviewer' ? `reviewer-runtime-${t[role].packet_directory}` : 'implementer-runtime');
    const owner = await this.executor.start({ remote_url: s.environment.remote_url, environment_id: s.environment.id, repository_task: !!t.repository }, workspace, runtime, role);
    t = this.task(id);
    if (owner.isolation_evidence?.file_rpc_capture_initialized) { owner.isolation_evidence.file_rpc_generation = (t[role].executor?.isolation_evidence?.file_rpc_generation || 0) + 1; owner.isolation_evidence.file_rpc_coverage_from_first_executor = !t[role].executor || t[role].executor.isolation_evidence?.file_rpc_coverage_from_first_executor === true; }
    if (owner.isolation_evidence?.initialized) owner.isolation_evidence.coverage_from_first_executor = !t[role].executor || t[role].executor.isolation_evidence?.coverage_from_first_executor === true;
    t[role].executor = owner; this.save(t);
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      s = await this.api.retrieve(s.id);
      if (s.environment?.status === 'connected' || this.cache.get(`${id}:${role}:environment`) === 'connected') break;
      if (s.environment?.status === 'failed') throw new BridgeError('ENVIRONMENT_FAILED');
      await delay(500);
    }
    if (s.environment?.status !== 'connected' && this.cache.get(`${id}:${role}:environment`) !== 'connected') throw new BridgeError('EXECUTOR_CONNECTION_TIMEOUT');
    t = this.task(id);
    if (t.repository && role === 'implementer') input = this.repositoryInput(t, workspace, runtime, input);
    t[role].state = 'submitting'; this.save(t);
    try { await this.api.events.create(s.id, { 'Idempotency-Key': `${id}:${role}:${requestId}`, events: [message(input)] }); }
    catch { throw new BridgeError('INPUT_SUBMISSION_UNCERTAIN_CHECK_GET_TASK'); }
    this.opDone(requestId);
    t = this.task(id); if (!TERMINAL.has(t[role].state)) t[role].state = 'running'; t[role].connection_state = 'connected'; this.save(t);
  }
  repositoryInput(t, workspace, runtime, input) {
    const metadata = JSON.stringify(repositorySandboxMetadata(t, workspace, runtime));
    if (this.safe(metadata) !== metadata) throw new BridgeError('REPOSITORY_SANDBOX_ATTESTATION_UNAVAILABLE');
    return `BEGIN CONTROLLER REPOSITORY SANDBOX ATTESTATION\n${metadata}\nEND CONTROLLER REPOSITORY SANDBOX ATTESTATION\n\n${input}`;
  }
  async observe(id, role) {
    const key = `${id}:${role}`; if (this.streams.has(key) || this.closed) return;
    const ref = this.task(id)[role]; if (!ref?.session_id || ref.deleted || ref.stale) return;
    this.streams.set(key, null);
    try {
      const stream = await this.api.events.stream(ref.session_id, { timeout: 30000 }); this.streams.set(key, stream);
      (async () => {
        try { for await (const event of stream) {
          if (this.closed) break;
          if (event.turn?.subagent_id) continue;
          if (event.environment?.status) {
            this.cache.set(`${id}:${role}:environment`, event.environment.status);
            const t = this.task(id); t[role].connection_state = this.bounded(event.environment.status, 64); this.save(t);
          }
          if (event.turn_id) { const t = this.task(id); t[role].turn_id = event.turn_id; this.save(t); }
          if (event.type === 'agent.session.turn.failed' || event.type === 'agent.session.failed' || event.type === 'error') {
            this.recordFailure(id, role, { event, turn: event.turn, session: event.session });
            await this.reconcileFailure(id, role);
          } else if (/\.turn\.(completed|cancelled)$/.test(event.type)) {
            const t = this.task(id); t[role].state = event.turn?.status || event.type.split('.').at(-1); this.save(t);
          }
        } } catch { /* get_task reconciles from persisted API state */ }
        finally { if (this.streams.get(key) === stream) this.streams.delete(key); }
      })();
    } catch (e) { this.streams.delete(key); throw e; }
  }
  async viewRole(t, role) {
    await this.reconcileFailure(t.id, role);
    const ref = this.task(t.id)[role]; if (!ref) return null;
    const failure = this.diagnostic(ref);
    const view = { state: ref.state, session_id: ref.session_id || null, turn_id: ref.turn_id || null, environment_id: ref.environment_id || null, clarification_required: false, stale: !!ref.stale, latest_output: null, error: failure ? failure.api_error?.code || failure.status : ref.error || null, failure_diagnostic: failure };
    if (failure) view.latest_output = failure.latest_output?.text || null;
    if (!ref.session_id || ref.deleted) return view;
    let s; try { s = await this.api.retrieve(ref.session_id); } catch (e) { if (failure) return view; throw e; }
    const turns = await this.api.turns.list(ref.session_id, { order: 'desc', limit: 1 }); const turn = turns.data?.[0];
    if (turn) { view.turn_id = turn.id; view.state = turn.status === 'in_progress' ? 'running' : turn.status; }
    if (s.status === 'failed') view.state = 'failed';
    if (view.state !== 'failed') { view.error = ref.error || null; view.latest_output = null; }
    const actions = s.required_actions || [];
    const pending = actions.find(x => x.type === 'function_call' && x.name === 'request_clarification');
    if (pending) {
      let args; try { args = typeof pending.arguments === 'string' ? JSON.parse(pending.arguments) : pending.arguments; } catch { throw new BridgeError('INVALID_CLARIFICATION'); }
      view.state = 'waiting_for_clarification'; view.clarification_required = true; view.question = this.safe(args.question).slice(0, 8000);
    } else if (actions.some(x => x.type === 'function_call')) { view.state = 'needs_attention'; view.error = 'UNSUPPORTED_REQUIRED_ACTION'; }
    const page = await this.api.items.list(ref.session_id, { order: 'desc', limit: 100 });
    const item = page.data.find(x => x.type === 'message' && x.role === 'assistant' && (!turn || x.turn_id === turn.id));
    if (item) {
      const text = item.content.filter(c => c.type === 'output_text').map(c => c.text).join('\n');
      view.latest_output = this.safe(text).slice(-16000); view.output_truncated = text.length > 16000;
    }
    if (role === 'reviewer' && view.state === 'completed') {
      try {
        if (digest(await fs.readFile(path.join(this.workspaceRoot, t.id, ref.packet_directory || 'review', 'evidence.json'), 'utf8')) !== ref.packet_hash) throw Error('packet changed');
        const raw = JSON.parse(view.latest_output?.replace(/^```(?:json)?\s*|\s*```$/g, ''));
        const c = JSON.parse(await fs.readFile(path.join(this.workspaceRoot, t.id, 'contract.json'), 'utf8'));
        const required = [...c.requirements, ...c.invariants].map(x => x.id).concat(['SCOPE', 'TEST_EVIDENCE']);
        if (!raw || !Array.isArray(raw.findings) || raw.findings.length !== required.length || required.some(id => raw.findings.filter(f => f.id === id && ['PASS', 'FAIL'].includes(f.status) && typeof f.evidence === 'string' && f.evidence.trim()).length !== 1) || raw.overall !== (raw.findings.every(f => f.status === 'PASS') ? 'PASS' : 'FAIL')) throw Error();
        view.findings = raw.findings; view.overall = raw.overall;
      } catch { view.state = 'needs_attention'; view.error = 'INVALID_REVIEW_OUTPUT'; }
    }
    const fresh = this.task(t.id); fresh[role].state = view.state; fresh[role].turn_id = view.turn_id;
    if (role === 'reviewer') fresh[role].review_result = view.overall ? { overall: view.overall, findings: view.findings, packet_hash: ref.packet_hash, turn_id: view.turn_id } : null;
    this.save(fresh);
    return view;
  }
  async get(id, refresh = true) {
    let t = this.task(id);
    const result = { ...(t.review_packet_diagnostic ? { review_packet_diagnostic: t.review_packet_diagnostic } : {}), task_id: id, state: t.cleaned ? 'cleaned' : t.implementer.state, implementer: null, reviewer: null, cleanup: t.cleanup || null, expires_at: new Date(t.deadline).toISOString() };
    for (const role of ['implementer', 'reviewer']) {
      if (!t[role]) continue;
      if (refresh && t[role].session_id && !t[role].deleted) {
        try { await this.observe(id, role); result[role] = await this.viewRole(t, role); }
        catch (e) {
          const d = this.diagnostic(this.task(id)[role]);
          result[role] = { state: d ? 'failed' : 'unavailable', session_id: t[role].session_id,
            turn_id: d?.turn_id || t[role].turn_id || null, environment_id: t[role].environment_id || null,
            error: d ? d.api_error?.code || d.status : e instanceof BridgeError ? e.code : 'API_RECONCILIATION_FAILED',
            failure_diagnostic: d, latest_output: d?.latest_output?.text || null };
        }
      } else {
        if (t[role].state === 'failed' && !this.diagnostic(t[role])) this.recordFailure(id, role, { reason: t[role].deleted ? 'Remote session already deleted; original diagnostic was not retained' : 'No retained API diagnostic' });
        const d = this.diagnostic(t[role]);
        result[role] = { state: t[role].state, session_id: t[role].session_id || null, turn_id: t[role].turn_id || null, environment_id: t[role].environment_id || null, error: d ? d.api_error?.code || d.status : t[role].error || null, failure_diagnostic: d, latest_output: d?.latest_output?.text || null };
      }
    }
    if (t.repository) {
      if (!t.workspace_deleted) {
        try { await this.repositoryEvidence(id); }
        catch { const fresh = this.task(id); fresh.repository_evidence_error = 'REPOSITORY_EVIDENCE_UNAVAILABLE'; this.save(fresh); }
      }
      const fresh = this.task(id);
      result.repository = { repository_id: t.repository.repository_id, base_ref: t.repository.base_ref,
        baseline_commit: t.baseline, branch: t.repository.branch || null, worktree_id: t.repository.worktree_id || id,
        ...fresh.repository_evidence, error: fresh.repository_evidence_error || null };
    }
    const published = this.task(id).publication;
    if (published) result.publication = published.phase === 'complete' ? publicationResult(published) : { phase: published.phase, reviewed_tree_sha: published.reviewed_tree_sha, commit_sha: published.commit_sha, error: this.task(id).publication_error || null };
    else if (this.task(id).publication_frozen) result.publication = { phase: 'frozen', error: this.task(id).publication_error || null };
    if (!t.cleaned) result.state = result.implementer.state;
    return result;
  }
  async continue({ task_id: id, instruction, request_id }) {
    this.rejectSecret(instruction);
    return this.locked(id, async () => {
      let t = this.task(id); if (t.publication_frozen) throw new BridgeError('TASK_FROZEN_FOR_PUBLICATION'); if (t.cleaned) throw new BridgeError('TASK_CLEANED');
      if (this.jobs.has(`${id}:implementer`)) throw new BridgeError('TASK_STARTING');
      const old = this.operation(request_id, 'continue', { id, instruction }, id);
      if (old) return this.get(id); // Uncertain submissions are never automatically repeated.
      if (t.reviewer && !t.reviewer.stale && !t.reviewer.deleted) {
        await this.reconcileFailure(id, 'reviewer'); t = this.task(id);
        const reviewer = await this.api.retrieve(t.reviewer.session_id);
        if (reviewer.status !== 'idle' && reviewer.status !== 'failed') throw new BridgeError('REVIEW_IN_PROGRESS');
        if (!await this.executor.stop(t.reviewer.executor)) throw new BridgeError('EXECUTOR_NOT_STOPPED');
        this.streams.get(`${id}:reviewer`)?.controller?.abort(); this.streams.delete(`${id}:reviewer`);
        t.reviewer.stale = true; this.save(t);
      }
      try {
        await this.reconcileFailure(id, 'implementer'); t = this.task(id);
        const s = await this.api.retrieve(t.implementer.session_id);
        const pending = (s.required_actions || []).find(x => x.type === 'function_call' && x.name === 'request_clarification');
        if (pending && this.context.getStore()) { const aid = this.context.getStore(); const a = JSON.parse(this.db.prepare('SELECT value FROM audit WHERE id=?').get(aid).value); a.turn_id = pending.turn_id; this.db.prepare('UPDATE audit SET value=? WHERE id=?').run(JSON.stringify(a), aid); }
        if (!pending && s.status !== 'idle') throw new BridgeError('TASK_NOT_IDLE');
        await this.observe(id, 'implementer');
        // An executor killed on controller exit must be explicitly reconnected.
        if (!processIdentity(t.implementer.executor?.pid)) {
          const owner = await this.executor.start({ remote_url: s.environment.remote_url, environment_id: s.environment.id, repository_task: !!t.repository }, path.join(this.workspaceRoot, id, 'repo'), path.join(this.workspaceRoot, id, 'implementer-runtime'), 'implementer');
          t = this.task(id);
          if (owner.isolation_evidence?.file_rpc_capture_initialized) { owner.isolation_evidence.file_rpc_generation = (t.implementer.executor?.isolation_evidence?.file_rpc_generation || 0) + 1; owner.isolation_evidence.file_rpc_coverage_from_first_executor = !t.implementer.executor || t.implementer.executor.isolation_evidence?.file_rpc_coverage_from_first_executor === true; }
          if (owner.isolation_evidence?.initialized) owner.isolation_evidence.coverage_from_first_executor = !t.implementer.executor || t.implementer.executor.isolation_evidence?.coverage_from_first_executor === true;
          t.implementer.executor = owner; this.save(t);
        }
        if (t.repository) instruction = this.repositoryInput(t, path.join(this.workspaceRoot, id, 'repo'), path.join(this.workspaceRoot, id, 'implementer-runtime'), instruction);
        const event = pending ? { type: 'agent.session.input.tool_result', turn_id: pending.turn_id, call_id: pending.call_id, success: true, output: instruction } : message(instruction);
        t = this.task(id); t.implementer.active_request = request_id; this.save(t);
        this.opDone(request_id, 'submitting');
        await this.api.events.create(s.id, { 'Idempotency-Key': `${id}:continue:${request_id}`, events: [event] });
        this.opDone(request_id); t = this.task(id); t.implementer.state = 'running'; t.deadline = Date.now() + this.timeoutMs; this.save(t);
        return this.get(id);
      } catch (e) { this.opDone(request_id, e instanceof BridgeError ? 'rejected' : 'uncertain'); throw e; }
    });
  }
  async repositoryDiff(repo, baseline) {
    let diff = git(repo, 'diff', '--no-ext-diff', '--no-textconv', baseline, '--');
    for (const name of git(repo, 'ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean)) {
      safeRelative(name);
      const file = path.join(repo, name), stat = await fs.lstat(file);
      if ((!stat.isFile() && !stat.isSymbolicLink()) || (!stat.isSymbolicLink() && stat.nlink > 1) || stat.size > MAX_PACKET || await fs.realpath(path.dirname(file)) !== path.dirname(file)) throw new BridgeError('UNSAFE_OR_OVERSIZE_EVIDENCE');
      diff += git(repo, 'diff', '--no-ext-diff', '--no-textconv', '--no-index', '--', '/dev/null', name);
      if (Buffer.byteLength(diff) > MAX_PACKET * 2) throw Object.assign(new BridgeError('EVIDENCE_SIZE_LIMIT'), { diagnostic: packetSizeDiagnostic({ diff: Buffer.byteLength(diff) }, 'diff', Buffer.byteLength(diff)) });
    }
    return diff;
  }
  async repositoryEvidence(id) {
    const t = this.task(id), root = path.join(this.workspaceRoot, id), repo = path.join(root, 'repo');
    await verifyTaskWorktree(root, t.repository);
    const contract = JSON.parse(await fs.readFile(path.join(root, 'contract.json'), 'utf8'));
    const taskFile = path.join(repo, 'TASK.md'), taskStat = await fs.lstat(taskFile);
    if (!taskStat.isFile() || taskStat.isSymbolicLink() || taskStat.size > MAX_PACKET ||
        await fs.readFile(taskFile, 'utf8') !== contractMarkdown(contract)) throw new BridgeError('TASK_CONTRACT_CHANGED');
    const changed = [...new Set([...git(repo, 'diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', t.baseline, '--').split('\0'),
      ...git(repo, 'ls-files', '--others', '--exclude-standard', '-z').split('\0')].filter(Boolean))];
    if (changed.length > MAX_FILES || changed.some(name => name.length > 200)) throw new BridgeError('EVIDENCE_FILE_LIMIT');
    const diff = await this.repositoryDiff(repo, t.baseline);
    const status = git(repo, 'status', '--porcelain=v1', '--untracked-files=all');
    t.repository_evidence = { changed_files: changed.map(name => this.bounded(name, 200)),
      final_diff: this.bounded(diff, 64000), diff_truncated: diff.length > 64000,
      final_status: this.bounded(status, 16000), status_truncated: status.length > 16000 };
    const fresh = this.task(id); fresh.repository_evidence = t.repository_evidence; fresh.repository_evidence_error = null; this.save(fresh);
    return changed;
  }
  async buildPacket(t) {
    try {
      const result = await this.buildPacketData(t);
      const saved = this.task(t.id); delete saved.review_packet_diagnostic; this.save(saved);
      return result;
    } catch (error) {
      if (error.diagnostic) {
        const saved = this.task(t.id); saved.review_packet_diagnostic = error.diagnostic; this.save(saved);
        const failure = new BridgeError(error instanceof BridgeError ? error.code : 'EVIDENCE_SIZE_LIMIT'); failure.diagnostic = error.diagnostic; throw failure;
      }
      if (error.code === 'ENOBUFS') { const diagnostic = packetSizeDiagnostic({ git_capture_limit: MAX_PACKET * 2 }, 'git_capture', MAX_PACKET * 2); const saved = this.task(t.id); saved.review_packet_diagnostic = diagnostic; this.save(saved); const failure = new BridgeError('EVIDENCE_SIZE_LIMIT'); failure.diagnostic = diagnostic; throw failure; }
      throw error;
    }
  }
  async buildPacketData(t) {
    const root = path.join(this.workspaceRoot, t.id); const repo = path.join(root, 'repo');
    const contract = JSON.parse(await fs.readFile(path.join(root, 'contract.json'), 'utf8'));
    const reviewedState = t.repository ? await reviewedGitState(root, t) : null;
    const repositoryChanges = t.repository ? await this.repositoryEvidence(t.id) : null;
    const selected = t.repository ? [...new Set([...contract.allowed_files, ...repositoryChanges])] : null;
    if (selected && selected.length > MAX_FILES) throw new BridgeError('EVIDENCE_FILE_LIMIT');
    const files = selected || await workspaceFiles(repo); const current = {}; const baseline = {}; const fileBytes = {};
    let bytes = 0;
    for (const name of files) {
      if (t.repository) safeRelative(name);
      const p = path.join(repo, name);
      let st; try { st = await fs.lstat(p); } catch (e) { if (t.repository && e.code === 'ENOENT') continue; throw e; }
      const symlink = t.repository && st.isSymbolicLink();
      if ((!st.isFile() && !symlink) || await fs.realpath(path.dirname(p)) !== path.dirname(p)) throw new BridgeError('UNSAFE_WORKSPACE_ENTRY');
      if (st.nlink > 1) throw new BridgeError('UNSAFE_OR_OVERSIZE_EVIDENCE');
      if (st.size > MAX_PACKET) throw Object.assign(new BridgeError('UNSAFE_OR_OVERSIZE_EVIDENCE'), { diagnostic: packetSizeDiagnostic({ current_file_raw: st.size }, 'current', st.size) });
      const buffer = symlink ? Buffer.from(await fs.readlink(p)) : await fs.readFile(p);
      let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { text = null; }
      if (text?.includes('\0')) text = null;
      if (text === null && !t.repository) throw new BridgeError('NON_TEXT_EVIDENCE');
      bytes += buffer.length;
      if (bytes > MAX_PACKET) throw Object.assign(new BridgeError('EVIDENCE_SIZE_LIMIT'), { diagnostic: packetSizeDiagnostic({ current_files_raw: bytes }, 'current', bytes) });
      current[name] = symlink ? { symlink_target: text } : text === null ? { encoding: 'binary', sha256: createHash('sha256').update(buffer).digest('hex'), byte_length: buffer.length } : text;
      fileBytes[name] = { provenance: 'controller', git_mode: symlink ? '120000' : st.mode & 0o111 ? '100755' : '100644', byte_length: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex'),
        hex: buffer.length <= 1024 && text !== null && this.bounded(text, text.length + 1) === text ? buffer.toString('hex') : null,
        hex_omitted_reason: buffer.length > 1024 ? 'file exceeds 1024-byte hex limit' : text === null ? 'binary content; SHA-256 and Git blob/tree identity retained' : this.bounded(text, text.length + 1) !== text ? 'sensitive content redacted' : null };
    }
    const tracked = git(repo, 'ls-tree', '-r', '-z', '--name-only', t.baseline, ...(selected ? ['--', ...selected] : [])).split('\0').filter(Boolean);
    let baselineBytes = 0;
    for (const name of selected ? selected.filter(name => tracked.includes(name)) : tracked) {
      const blobBytes = Number(git(repo, 'cat-file', '-s', `${t.baseline}:${name}`).trim()); baselineBytes += blobBytes;
      if (baselineBytes > MAX_PACKET) throw Object.assign(new BridgeError('EVIDENCE_SIZE_LIMIT'), { diagnostic: packetSizeDiagnostic({ baseline_files_raw: baselineBytes }, 'baseline', baselineBytes) });
      const buffer = execFileSync('/usr/bin/git', ['--literal-pathspecs', 'show', `${t.baseline}:${name}`], { cwd: repo, maxBuffer: MAX_PACKET, timeout: 10000, env: { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' } });
      let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { text = null; }
      if (text?.includes('\0')) text = null;
      baseline[name] = text === null ? { encoding: 'binary', byte_length: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') } : text;
    }
    const changed = repositoryChanges || [...new Set([...git(repo, 'diff', '--name-only', t.baseline).trim().split('\n'), ...git(repo, 'ls-files', '--others').trim().split('\n')].filter(Boolean))];
    const tests = [], commands = [], candidates = []; let count = 0, commandBytes = 0, omitted = 0, complete = true;
    let commandError = null; const matchedTests = new Set();
    try {
      for await (const item of this.api.items.list(t.implementer.session_id, { order: 'asc', limit: 100 })) {
        if (++count > 500) { complete = false; commandError = 'ITEM_SCAN_LIMIT'; break; }
        if (item.type !== 'command_execution') continue;
        const required = contract.test_commands.filter(cmd => typeof item.command === 'string' && item.command.includes(cmd));
        const outputLimit = required.length ? 2048 : 256;
        const relevantGit = /\bgit\b[\s\S]*\b(?:commit|push|merge|rebase|tag|config|update-ref|reset|fetch|pull|checkout|switch)\b/.test(String(item.command || ''));
        const sourceTruncated = item.truncated === true || item.output_truncated === true || item.stdout_truncated === true || item.stderr_truncated === true;
        const output = this.bounded(item.output, outputLimit);
        const record = { provenance: 'agents_api_command_execution', item_id: this.bounded(item.id),
          session_id: this.bounded(t.implementer.session_id), turn_id: this.bounded(item.turn_id),
          command: this.bounded(item.command, 2048), cwd: this.bounded(item.cwd, 1024), output,
          source_truncated: sourceTruncated,
          output_bytes: { observed: Buffer.byteLength(String(item.output || '')), retained: Buffer.byteLength(output || ''), limit_characters: outputLimit },
          ...(typeof item.stdout === 'string' ? { stdout: this.bounded(item.stdout, outputLimit), stdout_truncated: item.stdout.length > outputLimit } : {}),
          ...(typeof item.stderr === 'string' ? { stderr: this.bounded(item.stderr, outputLimit), stderr_truncated: item.stderr.length > outputLimit } : {}),
          exit_code: Number.isInteger(item.exit_code) ? item.exit_code : null,
          truncated: sourceTruncated || String(item.command || '').length > 2048 || String(item.output || '').length > outputLimit || String(item.stdout || '').length > outputLimit || String(item.stderr || '').length > outputLimit || String(item.cwd || '').length > 1024 };
        if (required.length) { tests.push(record); required.forEach(cmd => matchedTests.add(cmd)); }
        candidates.push({ record, order: count, priority: relevantGit ? 0 : required.length ? 1 : 2 });

      }
    } catch { complete = false; commandError = 'COMMAND_RECORDS_UNAVAILABLE'; }
    const retained = [];
    for (const candidate of candidates.sort((a,b) => a.priority - b.priority || a.order - b.order)) {
      const size = Buffer.byteLength(JSON.stringify(candidate.record));
      if (retained.length >= 100 || commandBytes + size > 30000) { omitted++; continue; }
      retained.push(candidate); commandBytes += size;
    }
    commands.push(...retained.sort((a,b) => a.order - b.order).map(x => x.record));
    const controllerEvidence = t.repository ? await repositoryReviewEvidence(this.task(t.id), this.stateRoot, this.workspaceRoot, this.bounded.bind(this)) : null;
    const commandEvidence = { provenance: 'agents_api_command_execution', session_id: t.implementer.session_id,
      records: commands, required_test_commands_missing: contract.test_commands.filter(cmd => !matchedTests.has(cmd)), items_scan_complete: complete, omitted_command_records: omitted, error: commandError,
      coverage: 'Git-operation records are retained before required-test and inspection records, then presented in source order. Only command_execution items are retained. Hidden reasoning, assistant prose and unrestricted raw logs are excluded. This is not an exhaustive network/syscall audit.' };
    const fileRpcEvidence = t.repository ? await captureFileRpcEvidence(this.task(t.id), this.workspaceRoot) : null;
    if (t.repository) { const saved = this.task(t.id); saved.file_rpc_evidence = fileRpcEvidence; this.save(saved); }
    const data = { evidence_version: 4, file_rpc_operation_evidence: fileRpcEvidence, reviewed_git_state: reviewedState, controller_evidence: controllerEvidence, command_execution_evidence: commandEvidence, file_byte_evidence: fileBytes, baseline_state: JSON.parse(await fs.readFile(path.join(root, 'baseline-state.json'), 'utf8')), current_config_hash: digest(await fs.readFile(path.join(root, t.repository ? 'git-store/config' : 'repo/.git/config'), 'utf8')), contract: contractMarkdown(contract), baseline_commit: t.baseline, current_commit: git(repo, 'rev-parse', 'HEAD').trim(), staged_files: git(repo, 'diff', '--cached', '--name-only'), changed_files: changed, unauthorized_files: changed.filter(x => !contract.allowed_files.includes(x)), baseline, current, diff: t.repository ? await this.repositoryDiff(repo, t.baseline) : git(repo, 'diff', '--no-ext-diff', '--no-textconv', t.baseline, '--'), test_execution_evidence: tests };
    if (reviewedState && JSON.stringify(await publicationState(repo)) !== JSON.stringify(reviewedState.state)) throw new BridgeError('WORKTREE_CHANGED_DURING_REVIEW');
    const packet = budgetPacket(JSON.parse(this.safe(JSON.stringify(data))));
    return { ...packet, hash: digest(packet.text) };
  }
  async packet(t) {
    const packet = await this.buildPacket(t);
    const name = t.reviewer ? `review-${(t.previous_reviewers?.length || 0) + 2}` : 'review';
    const dir = path.join(this.workspaceRoot, t.id, name); await fs.mkdir(dir, { mode: 0o700 });
    await fs.writeFile(path.join(dir, 'evidence.json'), packet.text, { mode: 0o400 });
    return { directory: dir, hash: packet.hash, bytes: packet.bytes };
  }
  async review({ task_id: id, request_id }) {
    return this.locked(id, async () => {
      const t = this.task(id); if (t.publication_frozen) throw new BridgeError('TASK_FROZEN_FOR_PUBLICATION'); if (t.cleaned) throw new BridgeError('TASK_CLEANED');
      if (t.reviewer && !t.reviewer.stale) return this.get(id);
      if (this.jobs.has(`${id}:implementer`)) throw new BridgeError('TASK_STARTING');
      const view = await this.viewRole(t, 'implementer');
      if (!TERMINAL.has(view.state)) throw new BridgeError('REVIEW_REQUIRES_TERMINAL_TURN');
      const old = this.operation(request_id, 'review', { id }, id); if (old) return this.get(id);
      // Stop the implementer before taking the immutable snapshot.
      if (!await this.executor.stop(t.implementer.executor)) throw new BridgeError('EXECUTOR_NOT_STOPPED');
      const packet = await this.packet(t); const fresh = this.task(id);
      if (fresh.reviewer) { fresh.previous_reviewers ||= []; fresh.previous_reviewers.push(fresh.reviewer); }
      fresh.reviewer = { state: 'starting', packet_hash: packet.hash, packet_bytes: packet.bytes, packet_directory: path.basename(packet.directory) }; fresh.deadline = Date.now() + this.timeoutMs; this.save(fresh);
      this.launch(id, 'reviewer', () => this.openSession(id, 'reviewer', packet.directory, 'Read evidence.json. Independently assess the original contract against the baseline/current files, patch and test execution records. Return the required JSON findings for every requirement and invariant plus SCOPE and TEST_EVIDENCE. Never modify files.', request_id));
      return this.get(id, false);
    });
  }
  async publish(input) {
    if (!input || Object.keys(input).some(k => !['task_id', 'title', 'body', 'draft'].includes(k)) ||
        typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200 || /[\x00-\x1f]/.test(input.title) ||
        (input.body !== undefined && (typeof input.body !== 'string' || input.body.length > 16000)) || (input.draft !== undefined && input.draft !== true)) throw new BridgeError('INVALID_PUBLISH_INPUT');
    this.rejectSecret(input);
    return this.locked(input.task_id, async () => {
      let t = this.task(input.task_id);
      try {
        if (!t.repository) throw new BridgeError('PUBLICATION_REQUIRES_REPOSITORY');
        if (['implementer', 'reviewer'].some(role => this.jobs.has(`${t.id}:${role}`))) throw new BridgeError('TASK_EXECUTION_PENDING');
        for (const role of ['implementer', 'reviewer']) if (t[role]?.session_id && !t[role].deleted) await this.viewRole(t, role);
        t = this.task(t.id);
        if (t.implementer.state !== 'completed') throw new BridgeError('PUBLICATION_REQUIRES_COMPLETED_IMPLEMENTATION');
        if (!t.reviewer || t.reviewer.stale || t.reviewer.state !== 'completed' || t.reviewer.session_id === t.implementer.session_id ||
            t.reviewer.review_result?.overall !== 'PASS' || t.reviewer.review_result.packet_hash !== t.reviewer.packet_hash) throw new BridgeError('PUBLICATION_REQUIRES_PASS_REVIEW');
        const registered = await resolveRepository(path.join(this.stateRoot, 'repositories.json'), t.repository.repository_id, t.repository.base_ref, this.workspaceRoot, this.stateRoot);
        if (JSON.stringify(registered.registered_identity) !== JSON.stringify(t.repository.registered_identity)) throw new BridgeError('REPOSITORY_PATH_CHANGED');
        for (const role of ['implementer', 'reviewer']) {
          t[role].stopping = true; this.save(t);
          if (!await this.executor.stop(t[role].executor)) throw new BridgeError('EXECUTOR_NOT_STOPPED');
        }
        t = this.task(t.id);
        const result = await publishReviewedTask(this, t, { title: input.title, body: input.body || '', draft: true });
        t = this.task(t.id); t.publication_error = null; this.save(t);
        const auditId = this.context.getStore();
        if (auditId) {
          const row = this.db.prepare('SELECT value FROM audit WHERE id=?').get(auditId);
          const audit = JSON.parse(row.value); audit.publication = { ...result, review_packet_sha256: t.reviewer.packet_hash };
          this.db.prepare('UPDATE audit SET value=? WHERE id=?').run(JSON.stringify(audit), auditId);
        }
        return result;
      } catch (e) {
        const code = /^[A-Z_]+$/.test(e.code || '') ? e.code : 'PUBLICATION_FAILED';
        const fresh = this.task(t.id); fresh.publication_error = code; this.save(fresh);
        const auditId = this.context.getStore();
        if (auditId) { const row = this.db.prepare('SELECT value FROM audit WHERE id=?').get(auditId); const audit = JSON.parse(row.value); audit.publication_error = code; this.db.prepare('UPDATE audit SET value=? WHERE id=?').run(JSON.stringify(audit), auditId); }
        throw new BridgeError(code);
      }
    });
  }
  async cleanup({ task_id: id, delete_workspace = false }) {
    return this.locked(id, async () => {
      // Provisioning is bounded. Wait before collecting all owned resources.
      await Promise.allSettled(['implementer', 'reviewer'].map(role => this.jobs.get(`${id}:${role}`)).filter(Boolean));
      for (const role of ['implementer', 'reviewer']) {
        const saved = this.task(id);
        if (saved[role]?.session_id && !saved[role].deleted) { try { await this.viewRole(saved, role); } catch {} }
        await this.reconcileFailure(id, role);
      }
      let t = this.task(id); const results = {}, diagnostics = new Set();
      const owned = [['implementer', t.implementer], ['reviewer', t.reviewer], ...(t.previous_reviewers || []).map((ref, n) => [`previous_reviewer_${n + 1}`, ref])];
      for (const [role, ref] of owned) {
        if (!ref) continue;
        const r = results[role] = { executor_stopped: false, session_deleted: !!ref.deleted };
        if (!ref.deleted && ['implementer', 'reviewer'].includes(role)) { await this.reconcileFailure(id, role); Object.assign(ref, this.task(id)[role]); }
        ref.stopping = true; this.save(t);
        try { r.executor_stopped = await this.executor.stop(ref.executor); } catch { r.error = 'EXECUTOR_STOP_FAILED'; }
        if (!r.executor_stopped) diagnostics.add(r.error || 'EXECUTOR_STOP_UNCONFIRMED');
        const stream = this.streams.get(`${id}:${role}`); stream?.controller?.abort(); this.streams.delete(`${id}:${role}`);
        if (!ref.deleted && ['implementer', 'reviewer'].includes(role)) { await this.reconcileFailure(id, role); Object.assign(ref, this.task(id)[role]); }
        if (!ref.session_id && ref.creation_attempted) {
          try { const s = await this.recoverSession(t, role); ref.session_id = s.id; this.save(t); } catch { r.error = 'SESSION_CREATION_OUTCOME_UNKNOWN'; diagnostics.add(r.error); continue; }
        }
        if (!ref.session_id) { r.session_deleted = true; continue; }
        if (ref.deleted) continue;
        try { await this.api.events.create(ref.session_id, { events: [{ type: 'agent.session.input.cancel' }] }); } catch { diagnostics.add('SESSION_CANCEL_FAILED'); /* delete still attempted */ }
        for (let n = 0; n < 4; n++) {
          try { await this.api.delete(ref.session_id); r.session_deleted = true; break; }
          catch (e) { if (e.status === 404) { r.session_deleted = true; break; } if (e.status !== 409) break; await delay(1000); }
        }
        if (r.session_deleted) {
          try { await this.api.retrieve(ref.session_id); r.session_deleted = false; }
          catch (e) { if (e.status !== 404) r.session_deleted = false; }
        }
        const currentRef = this.task(id)[role];
        if (currentRef?.executor_exit) ref.executor_exit = currentRef.executor_exit;
        ref.deleted = r.session_deleted; if (!r.session_deleted) { r.error = 'SESSION_DELETE_UNCONFIRMED'; diagnostics.add(r.error); }
      }
      const executorStopped = Object.values(results).every(r => r.executor_stopped);
      const sessionDeleted = Object.values(results).every(r => r.session_deleted);
      if (t.repository) { t.file_rpc_evidence = await captureFileRpcEvidence(t, this.workspaceRoot); this.save(t); }
      const workspace = path.join(this.workspaceRoot, id);
      t.cleanup = { ...results, executor_stopped: executorStopped, remote_session_deleted: sessionDeleted,
        workspace_deletion_requested: delete_workspace, workspace_deleted: false,
        ...(t.repository ? { worktree_deletion_requested: delete_workspace, worktree_deleted: false, worktree_id: this.bounded(id) } : {}),
        workspace_id: this.bounded(id), workspace_path: this.bounded(workspace, 1024), cleanup_diagnostic: null };
      t.cleaned = executorStopped && sessionDeleted; this.save(t);
      for (const role of ['implementer', 'reviewer']) if (t[role]?.state === 'failed') this.recordFailure(id, role);
      if (delete_workspace) {
        if (t.cleaned) {
          try {
            if (t.repository) {
              if (!t.workspace_deleted) {
                try { await this.repositoryEvidence(id); t = this.task(id); }
                catch { diagnostics.add('REPOSITORY_EVIDENCE_UNAVAILABLE'); }
              }
              await removeTaskWorktree(workspace, t.repository);
              t.cleanup.worktree_deleted = true;
            }
            await fs.rm(workspace, { recursive: true, force: true });
          }
          catch { diagnostics.add('WORKSPACE_DELETE_FAILED'); }
        } else diagnostics.add('WORKSPACE_DELETE_SKIPPED_RESOURCES_NOT_CLEANED');
      }
      // Only ENOENT proves absence; permission errors and dangling symlinks do not.
      try { await fs.lstat(workspace); }
      catch (e) {
        if (e.code === 'ENOENT') t.cleanup.workspace_deleted = true;
        else diagnostics.add('WORKSPACE_VERIFICATION_FAILED');
      }
      if (delete_workspace && !t.cleanup.workspace_deleted) diagnostics.add('WORKSPACE_DELETE_UNCONFIRMED');
      if (t.repository) {
        try { await fs.lstat(path.join(workspace, 'repo')); t.cleanup.worktree_deleted = false; }
        catch (e) { t.cleanup.worktree_deleted = e.code === 'ENOENT'; if (e.code !== 'ENOENT') diagnostics.add('WORKTREE_VERIFICATION_FAILED'); }
        if (delete_workspace && !t.cleanup.worktree_deleted) diagnostics.add('WORKTREE_DELETE_UNCONFIRMED');
      }
      t.workspace_deleted = t.cleanup.workspace_deleted;
      t.cleanup.cleanup_diagnostic = diagnostics.size ? this.bounded([...diagnostics].join('; '), 512) : null;
      // Task/audit records live in stateRoot and survive disposable workspace removal.
      this.save(t);
      return this.get(id, false);
    });
  }
  async expire() {
    if (this.closed) return;
    this.pruneDiagnostics();
    for (const row of this.db.prepare('SELECT value FROM tasks').all()) {
      const t = JSON.parse(row.value); if (!t.cleaned && Date.now() > t.deadline) await this.cleanup({ task_id: t.id });
    }
  }
  async close() {
    clearInterval(this.sweeper); this.closed = true;
    await Promise.allSettled([...this.jobs.values()]);
    for (const stream of this.streams.values()) stream?.controller?.abort();
    for (const row of this.db.prepare('SELECT value FROM tasks').all()) {
      const t = JSON.parse(row.value); for (const ref of [t.implementer, t.reviewer, ...(t.previous_reviewers || [])]) if (ref?.executor) await this.executor.stop(ref.executor).catch(() => {});
    }
    this.db.close();
  }
}
