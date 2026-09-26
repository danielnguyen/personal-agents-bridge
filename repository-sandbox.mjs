// Trusted RPC boundary: only the forwarder has Agents API credentials/network.
import { spawn } from 'node:child_process';
import { promises as fs, writeSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

import { createFileRpcJournal } from './file-rpc-evidence.mjs';

const PROFILE = 'bridge_task';
const FS_METHODS = new Set(['fs/readFile', 'fs/open', 'fs/readBlock', 'fs/close', 'fs/writeFile', 'fs/createDirectory', 'fs/getMetadata', 'fs/canonicalize', 'fs/walk', 'fs/remove', 'fs/copy']);
const PROCESS_METHODS = new Set(['process/read', 'process/write', 'process/signal', 'process/terminate']);
const fail = () => new Error('REPOSITORY_SANDBOX_FAILED');
const within = (root, p) => p === root || p.startsWith(root + path.sep);
const hash = x => createHash('sha256').update(x).digest('hex');

class Worker {
  constructor(binary, args, options, notify, fatal) {
    this.next = 0; this.pending = new Map();
    this.child = spawn(binary, args, { ...options, stdio: ['pipe', 'pipe', 'ignore'] });
    this.child.on('error', fatal);
    this.child.on('exit', () => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(fail()); } this.pending.clear(); fatal(); });
    this.child.stdin.on('error', fatal);
    createInterface({ input: this.child.stdout }).on('line', line => {
      try {
        if (line.length > 16 * 1024 * 1024) throw fail();
        const msg = JSON.parse(line), p = this.pending.get(msg.id);
        if (p) { this.pending.delete(msg.id); clearTimeout(p.timer); p.resolve(msg); }
        else if (msg.method) notify(msg);
      } catch { fatal(); }
    });
  }
  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      const timer = setTimeout(() => { this.pending.delete(id); reject(fail()); }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  initialized() { this.child.stdin.write('{"method":"initialized","params":{}}\n'); }
  stop() { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(fail()); } this.pending.clear(); this.child.stdin.end(); this.child.kill('SIGTERM'); }
}

export async function createRepositorySandbox({ binary, workspace, runtime, role = 'implementer', onFailure = () => {} }) {
  binary = await fs.realpath(binary); workspace = await fs.realpath(workspace);
  // runtime is controller-created and must not be in the agent's writable tree.
  await fs.mkdir(runtime, { recursive: true, mode: 0o700 });
  if (await fs.realpath(runtime) !== path.resolve(runtime) || within(workspace, runtime)) throw fail();
  const instance = await fs.mkdtemp(path.join(runtime, 'sandbox-'));
  const control = path.join(instance, 'control'), scratch = path.join(instance, 'scratch');
  for (const dir of [control, scratch]) {
    await fs.mkdir(dir, { mode: 0o700 }); // Reuse/agent-supplied directories are never accepted.
  }
  for (const dir of ['home', 'tmp']) await fs.mkdir(path.join(scratch, dir), { mode: 0o700 });
  const filesystem = { '/': 'read', [scratch]: 'write' };
  if (role === 'implementer') filesystem[workspace] = 'write';
  // Protect controller contract, worktree pointer, and local Codex configuration.
  for (const name of ['.git', 'TASK.md', '.codex']) filesystem[path.join(workspace, name)] = 'read';
  const policy = { filesystem, network: { enabled: false } };
  // Pin the WHOLE permissions table at CLI precedence. Task-local config cannot add grants.
  const table = `{ ${JSON.stringify(PROFILE)} = { filesystem = { ${Object.entries(filesystem).map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`).join(', ')} }, network = { enabled = false } } }`;
  const config = `[permissions.${PROFILE}.filesystem]\n${Object.entries(filesystem).map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`).join('\n')}\n[permissions.${PROFILE}.network]\nenabled = false\n`;
  await fs.writeFile(path.join(control, 'config.toml'), config, { mode: 0o400, flag: 'wx' });
  const env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: control, CODEX_HOME: control, TMPDIR: path.join(control, 'tmp'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', PYTHONDONTWRITEBYTECODE: '1', RUST_LOG: 'off' };
  await fs.mkdir(env.TMPDIR, { mode: 0o700 });
  const commandEnv = { ...env, HOME: path.join(scratch, 'home'), CODEX_HOME: path.join(scratch, 'home'), TMPDIR: path.join(scratch, 'tmp') };
  const sandboxArgs = ['sandbox', '-c', `permissions=${table}`, '-P', PROFILE, '-C', workspace, '--'];
  const inside = argv => [...sandboxArgs, '/usr/bin/env', '-i', ...Object.entries(commandEnv).map(([k, v]) => `${k}=${v}`), ...argv];
  const sentinel = path.join(control, 'outside-sentinel'); await fs.writeFile(sentinel, 'unchanged');
  const preflight = `import os,socket,pathlib\np=pathlib.Path(${JSON.stringify(scratch)})/'preflight'\np.write_text('ok'); p.unlink()\nfor f in [lambda:os.truncate(${JSON.stringify(sentinel)},0),lambda:open(${JSON.stringify(path.join(control, 'outside-create'))},'w')]:\n try: f()\n except OSError: pass\n else: raise RuntimeError('outside write allowed')\nfor family,addr in [(socket.AF_INET,('127.0.0.1',9)),(socket.AF_INET6,('::1',9)),(socket.AF_UNIX,'/tmp/bridge-preflight-no-socket')]:\n try: socket.socket(family).connect(addr)\n except PermissionError: pass\n else: raise RuntimeError('socket allowed')\nprint('BRIDGE_SANDBOX_READY')`;
  await new Promise((resolve, reject) => {
    const child = spawn(binary, inside(['/usr/bin/python3', '-B', '-c', preflight]), { cwd: control, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', diagnostic = ''; child.stderr.on('data', b => { diagnostic = (diagnostic + b).slice(-512); }); const timer = setTimeout(() => { child.kill('SIGKILL'); reject(fail()); }, 15000);
    child.stdout.on('data', b => { output = (output + b).slice(-100); });
    child.on('error', () => { clearTimeout(timer); reject(fail()); });
    child.on('exit', code => { clearTimeout(timer); code === 0 && output.trim() === 'BRIDGE_SANDBOX_READY' ? resolve() : reject(new Error('REPOSITORY_SANDBOX_FAILED: ' + diagnostic)); });
  });
  if (await fs.readFile(sentinel, 'utf8') !== 'unchanged') throw fail();
  const journal = createFileRpcJournal(control, workspace, scratch);
  let closing = false, socket, wss, commands, files, shutdown;
  const stop = () => {
    if (shutdown) return shutdown;
    closing = true;
    shutdown = (async () => {
      socket?.terminate(); commands?.stop(); files?.stop();
      if (wss) await new Promise(resolve => wss.close(resolve));
      await journal.close();
    })();
    return shutdown;
  };
  const fatal = () => { if (!closing) { stop().catch(() => {}); onFailure(); } };
  const notify = msg => { if (socket?.readyState === 1) socket.send(JSON.stringify(msg)); };
  try {
    commands = new Worker(binary, ['exec-server', '--listen', 'stdio'], { cwd: control, env }, notify, fatal);
    files = new Worker(binary, inside([binary, 'exec-server', '--listen', 'stdio']), { cwd: control, env }, notify, fatal);
    const [ci, fi] = await Promise.all([commands.request('initialize', { clientName: 'bridge-command-dispatch' }), files.request('initialize', { clientName: 'bridge-filesystem-worker' })]);
    if (ci.error || fi.error || closing) throw fail();
    commands.initialized(); files.initialized();
    const processes = new Set();
    async function dispatch(method, params = {}) {
      if (method === 'initialize') return { result: { ...ci.result, environmentInfo: { ...ci.result.environmentInfo, cwd: pathToFileURL(workspace).href, userHomeDir: pathToFileURL(commandEnv.HOME).href, tempDir: pathToFileURL(commandEnv.TMPDIR).href, temporaryDirectories: [pathToFileURL(commandEnv.TMPDIR).href], capabilities: { networkProxyLaunch: false, capabilityDiscoverySandbox: false, environmentConfigRead: false, httpHeaderEnvVars: false, sandboxedFileStreaming: true, shellSnapshotV2: false, windowsMxc: false } } } };
      if (method === 'initialized') return null;
      if (method === 'process/start') {
        if (!Array.isArray(params.argv) || !params.argv.length || params.argv.some(x => typeof x !== 'string' || x.includes('\0')) || typeof params.processId !== 'string' || processes.has(params.processId)) throw fail();
        const cwd = params.cwd ? fileURLToPath(params.cwd) : workspace;
        const canonical = await fs.realpath(cwd);
        if (!within(workspace, canonical)) throw fail();
        const userEnv = params.env || {};
        if (typeof userEnv !== 'object' || Array.isArray(userEnv) || Object.entries(userEnv).some(([k, v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== 'string' || v.includes('\0'))) throw fail();
        // Agent environment and cwd take effect ONLY after the sandbox has initialized.
        const argv = [binary, ...inside(['/usr/bin/env', ...Object.entries(userEnv).map(([k, v]) => `${k}=${v}`), '/bin/sh', '-c', 'cd -- "$1" && shift && exec "$@"', 'bridge', canonical, ...params.argv])];
        processes.add(params.processId);
        // Never relay shellSnapshot/envPolicy/networkProxy or future launch options.
        return commands.request(method, { processId: params.processId, argv, cwd: pathToFileURL(control).href, env: {}, tty: params.tty === true, pipeStdin: params.pipeStdin === true });
      }
      if (PROCESS_METHODS.has(method)) {
        if (!processes.has(params.processId)) throw fail();
        return commands.request(method, params);
      }
      if (FS_METHODS.has(method)) return files.request(method, params);
      // Unknown RPCs, HTTP requests, managed network/proxy launch and capability/config
      // discovery are not forwarded to a networked or unsandboxed worker.
      return { error: { code: -32601, message: 'RPC disabled by repository sandbox policy' } };
    }
    const token = randomUUID();
    wss = new WebSocketServer({ host: '127.0.0.1', port: 0, path: `/${token}`, maxPayload: 16 * 1024 * 1024, perMessageDeflate: false });
    await new Promise((resolve, reject) => { wss.once('listening', resolve); wss.once('error', reject); });
    wss.on('connection', ws => {
      if (socket) { ws.close(1008); return; } socket = ws;
      ws.on('error', fatal); ws.on('close', fatal);
      ws.on('message', async data => {
        let m;
        try {
          m = JSON.parse(data.toString());
          if (!m || typeof m.method !== 'string' || Array.isArray(m)) throw fail();
          const r = await (m.method.startsWith('fs/') ? journal.run(m.method, m.params, () => dispatch(m.method, m.params)) : dispatch(m.method, m.params));
          if (m.id !== undefined && r && ws.readyState === 1) ws.send(JSON.stringify({ ...r, id: m.id }));
        } catch {
          if (m?.id !== undefined && ws.readyState === 1) ws.send(JSON.stringify({ id: m.id, error: { code: -32602, message: 'Repository sandbox rejected request' } }));
          else fatal();
        }
      });
    });
    return { url: `ws://127.0.0.1:${wss.address().port}/${token}`, stop,
      evidence: { provenance: 'controller', wrapper: 'codex sandbox RPC boundary', profile: PROFILE, policy, policy_sha256: hash(config), dispatcher_sha256: hash(await fs.readFile(fileURLToPath(import.meta.url))), codex_binary_sha256: hash(await fs.readFile(binary)), initialized: true, file_rpc_capture_initialized: true, command_network_access: false, filesystem_rpc_sandboxed: true, preflight: { scratch_write: true, outside_create_denied: true, outside_truncate_denied: true, inet_inet6_unix_connect_denied: true }, enforcement: 'kernel sandbox; profile pinned by trusted CLI; file RPC worker sandboxed; unrecognized RPCs denied' } };
  } catch { await stop(); throw fail(); }
}

// Supervisor entry point. Only this forwarder inherits the executor credential.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let sandbox, forward, stopping = false;
  const stop = () => { if (stopping) return; stopping = true; forward?.kill('SIGTERM'); sandbox?.stop().finally(() => process.exit(1)); if (!sandbox) process.exit(1); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop); process.stdin.resume(); process.stdin.on('end', stop);
  try {
    const [binary, workspace, runtime, role, remote, environmentId] = process.argv.slice(2);
    sandbox = await createRepositorySandbox({ binary, workspace, runtime, role, onFailure: stop });
    forward = spawn(binary, ['exec-server', 'forward', '--remote', remote, '--environment-id', environmentId, '--connect', sandbox.url, '--exit-on-stdin-close'], { cwd: runtime, env: { PATH: '/usr/bin:/bin', HOME: runtime, CODEX_HOME: path.join(runtime, 'codex'), CODEX_API_KEY: process.env.CODEX_API_KEY, RUST_LOG: 'off' }, stdio: ['pipe', 'ignore', 'ignore'] });
    forward.once('error', stop); forward.once('exit', stop);
    await new Promise((resolve, reject) => { forward.once('spawn', resolve); forward.once('error', reject); });
    writeSync(3, JSON.stringify(sandbox.evidence) + '\n');
  } catch { stop(); }
}
