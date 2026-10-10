import { spawn } from 'node:child_process';

export class AppServerRpc {
  constructor(binary, args, { cwd, env, onMessage = () => {}, timeoutMs = 10000 }) {
    this.pending = new Map(); this.nextId = 0; this.buffer = Buffer.alloc(0);
    this.timeoutMs = timeoutMs; this.failure = null;
    this.child = spawn(binary, ['app-server', '--listen', 'stdio://', ...args], { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] });
    this.exited = new Promise(resolve => this.child.once('close', resolve));
    this.child.on('error', () => this.fail('APP_SERVER_START_FAILED'));
    this.child.on('exit', () => this.fail('APP_SERVER_DISCONNECTED'));
    this.child.stdin.on('error', () => this.fail('APP_SERVER_WRITE_FAILED'));
    this.child.stdout.on('data', chunk => {
      try {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        let newline;
        while ((newline = this.buffer.indexOf(10)) !== -1) {
          if (newline > 1024 * 1024) throw Error();
          const message = JSON.parse(this.buffer.subarray(0, newline).toString('utf8'));
          this.buffer = this.buffer.subarray(newline + 1);
          if (!message || typeof message !== 'object' || Array.isArray(message)) throw Error();
          if (typeof message.method === 'string') {
            if (message.id !== undefined) {
              this.send({ id: message.id, error: { code: -32601, message: 'No server requests accepted by offline probe' } });
              this.fail('UNEXPECTED_SERVER_REQUEST');
              return;
            }
            onMessage(message);
          } else {
            const pending = this.pending.get(message.id);
            if (!pending || (Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error'))) throw Error();
            clearTimeout(pending.timer); this.pending.delete(message.id);
            if (message.error) pending.reject(new Error('APP_SERVER_RPC_REJECTED'));
            else pending.resolve(message.result);
          }
        }
        if (this.buffer.length > 1024 * 1024) throw Error();
      } catch { this.fail('APP_SERVER_PROTOCOL_FAILED'); }
    });
  }
  fail(code) {
    this.failure ||= new Error(code);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(this.failure); }
    this.pending.clear();
    this.child.kill('SIGTERM');
  }
  send(message) {
    if (this.failure) throw this.failure;
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method, params = {}) {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => this.fail('APP_SERVER_RPC_TIMEOUT'), this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  async initialize() {
    const result = await this.request('initialize', { clientInfo: { name: 'pab_feasibility', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized', params: {} });
    return result;
  }
  async close() {
    this.fail('APP_SERVER_CLOSED');
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 1000);
    try { await this.exited; } finally { clearTimeout(timer); }
  }
}

export function isolatedEnvironment(home, codexHome, scratch) {
  return { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: home, CODEX_HOME: codexHome,
    TMPDIR: scratch, RUST_LOG: 'off', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
}

export function requireSubscription(account) {
  if (account?.account?.type !== 'chatgpt' || account.requiresOpenaiAuth !== true) throw new Error('SUBSCRIPTION_AUTH_UNVERIFIED');
  return { method: 'chatgpt', inferenceVerified: false };
}
