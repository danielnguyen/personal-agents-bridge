import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { realpath } from 'node:fs/promises';

const error = code => Object.assign(new Error(code), { code });
const text = value => typeof value === 'string' && value.length > 0;
const limit = 1024 * 1024;
const endpoint = 'https://chatgpt.com/backend-api/';
const features = { apps: false, plugins: false, hooks: false, multi_agent: false, remote_control: false, api_key_model_discovery: false };
export const humanRequestMethods = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput'];
const nativeId = value => (text(value) && value.length <= 200) || Number.isSafeInteger(value);
export function validateHumanResponse(method, questions, response, decisions = ['accept', 'decline', 'cancel']) {
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object(response)) throw error('INVALID_HUMAN_RESPONSE');
  if (humanRequestMethods.slice(0, 2).includes(method)) {
    if (Object.keys(response).length !== 1 || !['accept', 'decline', 'cancel'].includes(response.decision) || !Array.isArray(decisions) || !decisions.includes(response.decision)) throw error('INVALID_APPROVAL_DECISION');
  } else if (method === 'item/tool/requestUserInput') {
    const answers = response.answers;
    if (Object.keys(response).length !== 1 || !object(answers) || !Array.isArray(questions) || !questions.length || questions.length > 8 ||
        new Set(questions.map(question => question.id)).size !== questions.length || Object.keys(answers).length !== questions.length ||
        questions.some(question => !text(question.id) || !Object.hasOwn(answers, question.id) || !object(answers[question.id]) ||
          Object.keys(answers[question.id]).length !== 1 || !Array.isArray(answers[question.id].answers) ||
          !answers[question.id].answers.length || answers[question.id].answers.length > 10 ||
          answers[question.id].answers.some(answer => !text(answer) || !answer.trim() || answer.length > 4000 ||
            (question.options?.length && question.isOther !== true && !question.options.some(option => option.label === answer)))) ||
        JSON.stringify(response).length > 16000) throw error('INVALID_CLARIFICATION_ANSWER');
  } else throw error('UNSUPPORTED_HUMAN_REQUEST');
  return response;
}
export const APPROVAL_LIMITATION = 'Native approval requests are handled; in-sandbox sensitive operations and file scope are behavioral restrictions, not universal pre-execution enforcement.';
export const INSTRUCTIONS = `Work only in the approved repository and file scope. Read code, edit approved files and run ordinary tests, builds and linters autonomously.
Before dependency installation or updates, destructive operations, credential or secret access, network access beyond the model service (including LAN/Tailscale), or changes outside the approved scope, ask the human and wait. If no approval channel is available, stop and explain the requested operation. Never assume approval.
Never commit, push, merge, deploy, or change Git history/configuration. Publication belongs to PAB's controller.
Report actual commands and exit results; never describe an unexecuted test as passed.`;

export function childEnvironment(source = process.env, codexHome = source.CODEX_HOME || path.join(source.HOME || homedir(), '.codex')) {
  return { HOME: source.HOME || homedir(), CODEX_HOME: path.resolve(codexHome),
    PATH: source.PATH || '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
}

function settings() {
  return { model_provider: 'openai', chatgpt_base_url: endpoint, approval_policy: 'on-request', approvals_reviewer: 'user',
    sandbox_mode: 'workspace-write', 'sandbox_workspace_write.network_access': false,
    'shell_environment_policy.inherit': 'none', 'shell_environment_policy.set': { PATH: '/usr/local/bin:/usr/bin:/bin' },
    web_search: 'disabled', check_for_update_on_startup: false, 'analytics.enabled': false,
    ...Object.fromEntries(Object.entries(features).map(([name, enabled]) => [`features.${name}`, enabled])) };
}
const toml = value => value && typeof value === 'object'
  ? `{ ${Object.entries(value).map(([key, child]) => `${JSON.stringify(key)} = ${toml(child)}`).join(', ')} }` : JSON.stringify(value);

export function validateRoute(config, response) {
  const account = response?.account;
  if (account?.type !== 'chatgpt' || response.requiresOpenaiAuth !== true || !text(account.email)) throw error('CHATGPT_AUTHENTICATION_REQUIRED');
  if (!['go', 'plus', 'pro', 'prolite', 'team', 'business', 'enterprise', 'edu', 'edu_plus', 'edu_pro'].includes(account.planType)) throw error('SUBSCRIPTION_PLAN_UNVERIFIED');
  if (config?.model_provider !== 'openai' || config.chatgpt_base_url !== endpoint || config.openai_base_url ||
      Object.keys(config.model_providers || {}).length || (config.forced_login_method && config.forced_login_method !== 'chatgpt')) throw error('SUBSCRIPTION_ROUTE_UNVERIFIED');
  if (config.sandbox_mode !== 'workspace-write' || config.sandbox_workspace_write?.network_access !== false ||
      config.approval_policy !== 'on-request' || config.approvals_reviewer !== 'user' || config.web_search !== 'disabled' ||
      config.shell_environment_policy?.inherit !== 'none' ||
      JSON.stringify(config.shell_environment_policy?.set) !== JSON.stringify({ PATH: '/usr/local/bin:/usr/bin:/bin' }) ||
      Object.keys(features).some(name => config.features?.[name] !== false)) throw error('CODEX_POLICY_MISMATCH');
  if (Object.values(config.mcp_servers || {}).some(server => server.enabled !== false)) throw error('ENABLED_MCP_SERVER_UNSUPPORTED');
  return JSON.stringify([account.type, account.email, account.planType]);
}

class Rpc {
  constructor(binary, args, options, receive, failed, spawnProcess) {
    this.nextId = 0; this.pending = new Map(); this.buffer = ''; this.failed = failed;
    this.child = spawnProcess(binary, ['app-server', '--listen', 'stdio://', ...args], { ...options, detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
    this.exited = new Promise(resolve => this.child.once('close', () => { this.dead = true; resolve(); }));
    this.child.on('error', () => this.fail('CODEX_START_FAILED'));
    this.child.on('close', () => this.fail('CODEX_DISCONNECTED'));
    this.child.stdin.on('error', () => this.fail('CODEX_WRITE_FAILED'));
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      try {
        this.buffer += chunk;
        let newline;
        while ((newline = this.buffer.indexOf('\n')) >= 0) {
          if (newline > limit) throw error('CODEX_FRAME_TOO_LARGE');
          const message = JSON.parse(this.buffer.slice(0, newline)); this.buffer = this.buffer.slice(newline + 1);
          if (message.method) receive(message);
          else {
            const pending = this.pending.get(message.id);
            if (!pending || (Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error'))) throw error('CODEX_PROTOCOL_ERROR');
            this.pending.delete(message.id); clearTimeout(pending.timer);
            if (message.error) pending.reject(error('CODEX_REQUEST_REJECTED')); else pending.resolve(message.result);
          }
        }
        if (this.buffer.length > limit) throw error('CODEX_FRAME_TOO_LARGE');
      } catch (failure) { this.fail(failure.code || 'CODEX_PROTOCOL_ERROR'); }
    });
  }
  send(message) {
    if (this.failure) throw this.failure;
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method, params = {}, timeoutMs = 15000) {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => this.fail('CODEX_REQUEST_UNCERTAIN'), timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch { this.fail('CODEX_WRITE_FAILED'); }
    });
  }
  fail(code) {
    if (this.failure) return;
    this.failure = error(code);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(this.failure); }
    this.pending.clear(); this.failed(code);
  }
  async close() {
    this.fail('CODEX_CLOSED');
    if (this.dead) return;
    const kill = signal => {
      try { if (this.child.pid) process.kill(-this.child.pid, signal); else this.child.kill(signal); } catch {}
    };
    kill('SIGTERM');
    const timer = setTimeout(() => kill('SIGKILL'), 500);
    let deadline;
    await Promise.race([this.exited, new Promise(resolve => { deadline = setTimeout(resolve, 1500); })]);
    clearTimeout(timer); clearTimeout(deadline);
    if (!this.dead) { kill('SIGKILL'); this.child.stdin.destroy(); this.child.stdout.destroy(); }
  }
}

export class LocalCodexBackend {
  constructor({ cwd, codexPath = 'codex', codexHome, env = process.env, onApproval, onQuestion, onProgress, onLifecycle,
    timeoutMs = 180000, spawnProcess = spawn, deferHumanRequests = false } = {}) {
    if (!path.isAbsolute(cwd || '')) throw error('ABSOLUTE_WORKSPACE_REQUIRED');
    this.cwd = cwd; this.binary = codexPath; this.env = childEnvironment(env, codexHome);
    this.onApproval = onApproval; this.onQuestion = onQuestion; this.onProgress = onProgress;
    this.onLifecycle = onLifecycle;
    this.deferHumanRequests = deferHumanRequests;
    this.timeoutMs = timeoutMs; this.spawnProcess = spawnProcess; this.busy = false; this.closed = false;
  }
  async connect() {
    if (this.closed) throw error('BACKEND_CLOSED');
    if (this.connection) return this.connection;
    this.connection = (async () => {
      this.cwd = await realpath(this.cwd);
      if (this.closed) throw error('BACKEND_CLOSED');
      const args = Object.entries(settings()).flatMap(([key, value]) => ['-c', `${key}=${toml(value)}`]);
      this.rpc = new Rpc(this.binary, args, { cwd: this.cwd, env: this.env }, message => this.receive(message),
        code => this.finish('uncertain', code), this.spawnProcess);
      const initialized = await this.rpc.request('initialize', { clientInfo: { name: 'pab_local_backend', version: '0.1.0' }, capabilities: { experimentalApi: true } });
      if (initialized?.codexHome !== this.env.CODEX_HOME) throw error('CODEX_HOME_MISMATCH');
      this.rpc.send({ method: 'initialized' });
      await this.checkRoute();
      return { authentication: 'chatgpt', provider: 'openai', subscriptionUsageAttribution: 'unverified', approvalLimitation: APPROVAL_LIMITATION };
    })();
    try { return await this.connection; } catch (failure) { await this.close(); throw failure; }
  }
  async checkRoute() {
    const { config } = await this.rpc.request('config/read', { cwd: this.cwd, includeLayers: false });
    const identity = validateRoute(config, await this.rpc.request('account/read', { refreshToken: false }));
    if (this.identity && identity !== this.identity) throw error('CHATGPT_ACCOUNT_CHANGED');
    this.identity = identity;
  }
  async defaultModel() {
    const models = new Set(), cursors = new Set(), defaults = [];
    let cursor = null;
    for (let page = 0; page < 10; page++) {
      const response = await this.rpc.request('model/list', { cursor, limit: 100, includeHidden: false });
      if (!Array.isArray(response?.data) || response.data.length > 100 ||
          (response.nextCursor !== null && !text(response.nextCursor))) throw error('MODEL_CATALOG_INVALID');
      for (const entry of response.data) {
        if (!text(entry?.model) || entry.hidden !== false || typeof entry.isDefault !== 'boolean' || models.has(entry.model)) throw error('MODEL_CATALOG_INVALID');
        models.add(entry.model);
        if (entry.isDefault) defaults.push(entry.model);
      }
      if (response.nextCursor === null) {
        if (defaults.length !== 1) throw error('UNIQUE_DEFAULT_MODEL_REQUIRED');
        return defaults[0];
      }
      if (!response.data.length || cursors.has(response.nextCursor)) throw error('MODEL_CATALOG_INVALID');
      cursor = response.nextCursor; cursors.add(cursor);
    }
    throw error('MODEL_CATALOG_INCOMPLETE');
  }
  lifecycle(phase, result, extra = {}) {
    try {
      const observed = this.onLifecycle?.({ phase, threadId: result.threadId, turnId: result.turnId, model: result.model || null,
        turnSubmissionAttempted: result.turnSubmissionAttempted, turnSubmissionAcknowledged: result.turnSubmissionAcknowledged,
        terminalObserved: result.terminalObserved, ...extra });
      if (observed?.then) { Promise.resolve(observed).catch(() => {}); throw error('LIFECYCLE_HANDLER_FAILED'); }
    } catch { throw error('LIFECYCLE_HANDLER_FAILED'); }
  }
  async run({ prompt, allowedFiles, threadId, signal } = {}) {
    if (this.busy) throw error('EXECUTION_ALREADY_ACTIVE');
    if (!text(prompt) || !Array.isArray(allowedFiles) || !allowedFiles.length || allowedFiles.some(file =>
      !text(file) || path.isAbsolute(file) || file.includes('\\') || file.split('/').some(part => !part || ['..', '.', '.git', '.codex', 'TASK.md'].includes(part)))) throw error('INVALID_TASK_SCOPE');
    if (threadId !== undefined && !text(threadId)) throw error('INVALID_THREAD_ID');
    this.busy = true;
    let timer, abort;
    const result = { status: 'uncertain', threadId: threadId || null, turnId: null, turnSubmissionAttempted: false, turnSubmissionAcknowledged: false, terminalObserved: false, commands: [], files: [], messages: [],
      uncertainties: ['Upstream command/output coverage is unverified.', 'Model messages are not independent test evidence.', 'Descendant-process termination is not independently attested.'],
      authentication: 'unverified', subscriptionUsageAttribution: 'unverified', approvalLimitation: APPROVAL_LIMITATION };
    try {
      await this.connect(); await this.checkRoute(); result.authentication = 'chatgpt';
      if (signal?.aborted) { result.status = 'interrupted'; return result; }
      result.model = await this.defaultModel();
      this.lifecycle('model_selected', result);
      if (threadId) {
        const previous = await this.rpc.request('thread/read', { threadId, includeTurns: false });
        if (previous?.thread?.id !== threadId || previous.thread.model !== result.model) throw error('RESUME_MODEL_MISMATCH');
      }
      const options = { cwd: this.cwd, model: result.model, modelProvider: 'openai', approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write',
        developerInstructions: `${INSTRUCTIONS}\nApproved files: ${JSON.stringify(allowedFiles)}` };
      const started = await this.rpc.request(threadId ? 'thread/resume' : 'thread/start', { ...options, ...(threadId ? { threadId } : {}) });
      if (text(started?.thread?.id)) { result.threadId = started.thread.id; this.lifecycle('thread_acknowledged', result); }
      if (started?.model !== result.model) throw error('THREAD_MODEL_MISMATCH');
      if (!text(started?.thread?.id) || (threadId && started.thread.id !== threadId) || started.modelProvider !== 'openai' ||
          started.cwd !== this.cwd || started.approvalPolicy !== 'on-request' || started.approvalsReviewer !== 'user' ||
          started.sandbox?.type !== 'workspaceWrite' || started.sandbox.networkAccess !== false) throw error('THREAD_POLICY_MISMATCH');
      if (started.thread.turns?.some(turn => turn.status === 'inProgress')) throw error('THREAD_HAS_ACTIVE_TURN');
      result.threadId = started.thread.id;
      await this.checkRoute();
      let resolve;
      const done = new Promise(callback => { resolve = callback; });
      this.active = { result, resolve, items: new Map(), requests: new Set(), humanRequests: new Map(), early: [], settled: false, eventCount: 0 };
      abort = () => { this.cancel().catch(() => {}); };
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(abort, this.timeoutMs);
      if (signal?.aborted) { this.finish('interrupted', 'CANCELLED_BEFORE_TURN'); return await done; }
      result.turnSubmissionAttempted = true;
      this.lifecycle('turn_submitting', result);
      const turn = await this.rpc.request('turn/start', { threadId: result.threadId, model: result.model, input: [{ type: 'text', text: prompt, text_elements: [] }],
        approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxPolicy: { type: 'workspaceWrite', writableRoots: [this.cwd], networkAccess: false,
          excludeTmpdirEnvVar: true, excludeSlashTmp: true } });
      if (!text(turn?.turn?.id)) throw error('TURN_START_UNCERTAIN');
      result.turnId = turn.turn.id;
      result.turnSubmissionAcknowledged = true;
      this.lifecycle('turn_acknowledged', result);
      if (turn.turn.status !== undefined && turn.turn.status !== 'inProgress') throw error('TURN_START_UNCERTAIN');
      for (const event of this.active.early.splice(0)) this.receive(event);
      await done;
      if (this.rpc.failure) await this.close();
      if (result.status === 'completed') {
        try { await this.checkRoute(); } catch { result.status = 'uncertain'; result.authentication = 'unverified'; result.uncertainties.push('Post-turn authentication/configuration check failed.'); await this.close(); }
      }
      return result;
    } catch (failure) {
      result.status = result.turnSubmissionAttempted ? 'uncertain' : 'failed'; result.uncertainties.push(failure.code || 'EXECUTION_UNCERTAIN');
      this.finish(result.status);
      await this.close(); return result;
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort); this.active = null; this.busy = false;
    }
  }
  receive(message) {
    const active = this.active, params = message.params || {};
    if (!active || active.settled) {
      if (message.id !== undefined) this.rpc.send({ id: message.id, error: { code: -32601, message: 'No active request handler' } });
      return;
    }
    if (!active.result.turnId) {
      if (active.early.length >= 1000) return this.rpc.fail('EVENT_OVERFLOW');
      active.early.push(message); return;
    }
    if (++active.eventCount > 10000) return this.rpc.fail('EVENT_OVERFLOW');
    if (message.method === 'account/updated' && params.authMode !== 'chatgpt') {
      active.result.authentication = 'unverified';
      return this.rpc.fail('CHATGPT_AUTHENTICATION_CHANGED');
    }
    if (params.threadId && params.threadId !== active.result.threadId) return this.rpc.fail('EVENT_THREAD_MISMATCH');
    if (params.turnId && params.turnId !== active.result.turnId) return this.rpc.fail('EVENT_TURN_MISMATCH');
    if (message.method === 'serverRequest/resolved') {
      if (params.threadId !== active.result.threadId || !nativeId(params.requestId) || !active.humanRequests.has(params.requestId)) return this.rpc.fail('REQUEST_RESOLUTION_MISMATCH');
      active.requests.delete(params.requestId);
      try { this.lifecycle('human_request_resolved', active.result, { request: { id: params.requestId } }); }
      catch { return this.rpc.fail('LIFECYCLE_HANDLER_FAILED'); }
    }
    if (message.id !== undefined) {
      if (!nativeId(message.id)) return this.rpc.fail('INVALID_SERVER_REQUEST_ID');
      if (active.humanRequests.has(message.id)) return this.rpc.fail('DUPLICATE_SERVER_REQUEST');
      if (active.humanRequests.size >= 32) return this.rpc.fail('HUMAN_REQUEST_LIMIT');
      active.requests.add(message.id);
      active.humanRequests.set(message.id, structuredClone(message));
      this.approve(message, active).catch(() => {
        active.result.uncertainties.push('Approval or clarification handler failed.');
        if (this.active === active && !active.settled) this.cancel().catch(() => {});
      }); return;
    }
    try {
      const observed = this.onProgress?.(structuredClone(message));
      if (observed?.then) {
        Promise.resolve(observed).catch(() => {});
        return this.rpc.fail('ASYNC_PROGRESS_HANDLER_UNSUPPORTED');
      }
    } catch { return this.rpc.fail('PROGRESS_HANDLER_FAILED'); }
    if (message.method === 'error') active.result.uncertainties.push('Codex reported a runtime error.');
    if (message.method === 'thread/tokenUsage/updated') active.result.usage = params.tokenUsage;
    if (['item/started', 'item/completed'].includes(message.method)) {
      if (params.threadId !== active.result.threadId || params.turnId !== active.result.turnId) return this.rpc.fail('ITEM_IDENTITY_MISSING');
      const item = params.item;
      if (!text(item?.id)) return this.rpc.fail('INVALID_ITEM');
      if (active.items.size >= 1000) return this.rpc.fail('ITEM_OVERFLOW');
      if (message.method === 'item/started') {
        if (active.items.has(item.id)) return this.rpc.fail('DUPLICATE_ITEM');
        active.items.set(item.id, { item, completed: false });
      } else {
        const previous = active.items.get(item.id);
        if (previous?.completed) return this.rpc.fail('DUPLICATE_ITEM');
        active.items.set(item.id, { item, completed: true });
        if (item.type === 'commandExecution') {
          const missing = [];
          if (!previous) missing.push('start');
          if (!text(item.command)) missing.push('command');
          if (!text(item.cwd)) missing.push('cwd');
          if (!['completed', 'failed', 'declined'].includes(item.status)) missing.push('status');
          if (!Number.isInteger(item.exitCode)) missing.push('exitCode');
          if (typeof item.aggregatedOutput !== 'string') missing.push('output');
          active.result.commands.push({ provenance: 'codex_app_server_item', itemId: item.id, command: item.command ?? null, cwd: item.cwd ?? null,
            status: item.status, exitCode: item.exitCode ?? null, output: item.aggregatedOutput?.slice(0, 65536) ?? null,
            locallyTruncated: typeof item.aggregatedOutput === 'string' && item.aggregatedOutput.length > 65536, missing, outputCompleteness: 'unverified' });
          if (missing.length) active.result.uncertainties.push(`Command ${item.id} has missing evidence: ${missing.join(', ')}.`);
        } else if (item.type === 'fileChange') active.result.files.push({ provenance: 'codex_app_server_item', itemId: item.id, status: item.status, changes: item.changes });
        else if (item.type === 'agentMessage') active.result.messages.push({ provenance: 'model', text: item.text });
      }
    }
    if (message.method === 'turn/completed') {
      if (params.threadId !== active.result.threadId || params.turn?.id !== active.result.turnId || !['completed', 'failed', 'interrupted'].includes(params.turn.status)) return this.rpc.fail('INVALID_TERMINAL_EVENT');
      if (params.turn.status === 'completed' && params.turn.error) return this.rpc.fail('CONFLICTING_TERMINAL_EVENT');
      active.result.terminalObserved = true;
      this.lifecycle('terminal_observed', active.result, { status: params.turn.status });
      this.finish(params.turn.status);
    }
  }
  async approve(message, active) {
    const { id, method, params } = message;
    if (params.threadId !== active.result.threadId || params.turnId !== active.result.turnId) return this.rpc.fail('APPROVAL_IDENTITY_MISMATCH');
    try { this.lifecycle('human_request', active.result, { request: { id, method, params, item: active.items.get(params.itemId)?.item } }); }
    catch { return this.rpc.fail('LIFECYCLE_HANDLER_FAILED'); }
    if (this.deferHumanRequests && humanRequestMethods.includes(method)) return;
    let result;
    if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method)) {
      let decision = 'decline';
      if (this.onApproval) decision = await this.onApproval({ method, ...structuredClone(params) });
      if (!['accept', 'decline', 'cancel'].includes(decision)) decision = 'decline';
      result = { decision };
      if (decision !== 'accept') active.result.uncertainties.push('A native approval was declined or cancelled.');
    } else if (method === 'item/tool/requestUserInput' && this.onQuestion) {
      const answers = await this.onQuestion(structuredClone(params));
      if (!Array.isArray(params.questions) || !params.questions.every(question => Array.isArray(answers?.[question.id]?.answers) &&
        answers[question.id].answers.length && answers[question.id].answers.every(text))) throw error('INVALID_CLARIFICATION_ANSWER');
      result = { answers };
    } else {
      this.rpc.send({ id, error: { code: -32601, message: 'Unsupported approval or clarification request' } });
      active.result.uncertainties.push('Unsupported approval/clarification requires operator intervention.');
      await this.cancel(); return;
    }
    if (this.active === active && !active.settled && active.requests.delete(id)) this.rpc.send({ id, result });
  }
  respondToRequest({ requestId, threadId, turnId, response }) {
    const active = this.active;
    if (!this.deferHumanRequests || this.closed || this.rpc?.failure || !active || active.settled || active.cancelling ||
        threadId !== active.result.threadId || turnId !== active.result.turnId || !active.requests.has(requestId)) throw error('NATIVE_REQUEST_UNAVAILABLE');
    const request = active.humanRequests.get(requestId);
    validateHumanResponse(request.method, request.params.questions, response, request.params.availableDecisions ?? undefined);
    try {
      this.lifecycle('human_response_submitting', active.result, { request: { id: requestId } });
      active.requests.delete(requestId);
      this.rpc.send({ id: requestId, result: response });
      this.lifecycle('human_response_sent', active.result, { request: { id: requestId } });
    } catch {
      this.rpc.fail('HUMAN_RESPONSE_DELIVERY_UNCERTAIN');
      throw error('HUMAN_RESPONSE_DELIVERY_UNCERTAIN');
    }
  }
  finish(status, reason) {
    const active = this.active;
    if (!active || active.settled) return;
    active.settled = true; active.result.status = status;
    clearTimeout(active.cancelTimer);
    if (reason) active.result.uncertainties.push(reason);
    for (const [itemId, record] of active.items) if (!record.completed) {
      active.result.uncertainties.push(`Item ${itemId} has no completion.`);
      if (record.item.type === 'commandExecution') active.result.commands.push({ provenance: 'codex_app_server_item', itemId,
        command: record.item.command ?? null, cwd: record.item.cwd ?? null, status: 'unverified', exitCode: null, output: null,
        locallyTruncated: false, missing: ['completion', 'exitCode', 'output'], outputCompleteness: 'unverified' });
    }
    active.resolve(active.result);
  }
  async cancel() {
    const active = this.active;
    if (!active || active.settled) return;
    if (active.cancelling) return active.cancelling;
    active.result.cancellationRequested = true;
    active.cancelling = (async () => {
      active.cancelTimer = setTimeout(() => { this.finish('interrupted', 'INTERRUPTION_UNCONFIRMED'); this.rpc.close().catch(() => {}); this.closed = true; }, 2000);
      try {
        if (active.result.turnId) await this.rpc.request('turn/interrupt', { threadId: active.result.threadId, turnId: active.result.turnId }, 1500);
        else { this.finish('interrupted', 'TURN_DELIVERY_UNCERTAIN'); await this.close(); }
      } catch { this.finish('interrupted', 'INTERRUPTION_UNCONFIRMED'); await this.close(); }
      finally { if (active.settled) clearTimeout(active.cancelTimer); }
    })();
    return active.cancelling;
  }
  async close() {
    this.closed = true; this.finish('interrupted', 'BACKEND_CLOSED_WITHOUT_TERMINAL_CONFIRMATION');
    if (this.rpc) await this.rpc.close();
    return !this.rpc || this.rpc.dead === true;
  }
}
