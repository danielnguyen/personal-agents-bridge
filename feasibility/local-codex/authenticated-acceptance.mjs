import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { AppServerRpc, isolatedEnvironment, requireSubscription } from './rpc.mjs';
import { SessionLedger, commandObservation } from './state.mjs';

export const RUNTIME = { version: 'codex-cli 0.157.1', sha256: '3e2584f3f3829a43a0495011a1cecb2facbe64a2403e2b682351fd9c2983f970' };
export const FIXTURE = 'PAB_AUTH_ACCEPTANCE_FIXTURE\n';
export const RESPONSE = 'PAB_AUTH_ACCEPTANCE_OK';
export const PROFILE = 'pab_auth_readonly';
const controlledFailure = Symbol('controlledFailure');
const fail = code => { throw Object.assign(new Error(code), { code, [controlledFailure]: true }); };
const hash = value => createHash('sha256').update(value).digest('hex');
const same = (actual, expected, code) => { if (!isDeepStrictEqual(actual, expected)) fail(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const subscriptionPlans = ['go', 'plus', 'pro', 'prolite', 'team', 'business', 'enterprise', 'edu', 'edu_plus', 'edu_pro'];
const transportCodes = new Set(['APP_SERVER_START_FAILED', 'APP_SERVER_DISCONNECTED', 'APP_SERVER_WRITE_FAILED', 'APP_SERVER_PROTOCOL_FAILED',
  'UNEXPECTED_SERVER_REQUEST', 'APP_SERVER_RPC_REJECTED', 'APP_SERVER_RPC_TIMEOUT', 'APP_SERVER_CLOSED']);
const safeCode = error => error?.[controlledFailure] ? error.code : transportCodes.has(error?.message) ? error.message : 'ACCEPTANCE_UNCERTAIN';
const withoutNulls = value => object(value) ? Object.fromEntries(Object.entries(value).filter(([, child]) => child !== null).map(([key, child]) => [key, withoutNulls(child)])) : value;
const toml = value => object(value) ? `{ ${Object.entries(value).map(([key, child]) => `${JSON.stringify(key)} = ${toml(child)}`).join(', ')} }` : JSON.stringify(value);
const configText = (root, binary) => Object.entries(configuration(root, binary)).map(([key, value]) => `${key} = ${toml(value)}\n`).join('');
export const environment = root => isolatedEnvironment(path.join(root, 'home'), path.join(root, 'codex'), path.join(root, 'scratch'));

export function configuration(root, binary) {
  if (!path.isAbsolute(binary || '')) fail('ABSOLUTE_BINARY_REQUIRED');
  return { model_provider: 'openai', model_providers: {}, forced_login_method: 'chatgpt', cli_auth_credentials_store: 'file',
    chatgpt_base_url: 'https://chatgpt.com/backend-api/', approval_policy: 'never', approvals_reviewer: 'user',
    default_permissions: PROFILE, permissions: { [PROFILE]: { filesystem: { ':minimal': 'read', [binary]: 'read',
      [path.join(root, 'work')]: 'read', [path.join(root, 'scratch')]: 'write',
      [path.join(root, 'codex')]: 'deny', [path.join(root, 'home')]: 'deny' }, network: { enabled: false } } },
    web_search: 'disabled', mcp_servers: {}, plugins: {},
    features: { apps: false, multi_agent: false, memories: false, hooks: false, remote_plugin: false, shell_snapshot: false, goals: false,
      api_key_model_discovery: false, auth_elicitation: false, background_paginated_rollout_migration: false,
      codex_apps_mcp_2026_07_28: false, mcp_2026_07_28: false, mentions_v2: false, remote_control: false, tool_suggest: false, windows_sandbox_service: false },
    shell_environment_policy: { inherit: 'none', set: { PATH: '/usr/bin:/bin', HOME: path.join(root, 'scratch'), TMPDIR: path.join(root, 'scratch') } },
    allow_login_shell: false, analytics: { enabled: false }, check_for_update_on_startup: false };
}
const launchArgs = (root, binary) => ['--strict-config', ...Object.entries(configuration(root, binary)).flatMap(([key, value]) => ['-c', `${key}=${toml(value)}`])];

async function privateFile(filename, contents) {
  const handle = await fs.open(filename, 'wx', 0o600);
  try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
  const directory = await fs.open(path.dirname(filename), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
async function checkedFile(filename, maximum = 65536) {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > maximum) fail('UNSAFE_PRIVATE_FILE');
  return fs.readFile(filename, 'utf8');
}
export async function prepare(binary) {
  if (!path.isAbsolute(binary)) fail('ABSOLUTE_BINARY_REQUIRED');
  binary = await fs.realpath(binary);
  same(hash(await fs.readFile(binary)), RUNTIME.sha256, 'RUNTIME_MISMATCH');
  const root = await fs.mkdtemp('/tmp/pab-auth-acceptance-');
  await fs.chmod(root, 0o700);
  for (const name of ['home', 'codex', 'work', 'scratch']) await fs.mkdir(path.join(root, name), { mode: 0o700 });
  const version = await promisify(execFile)(binary, ['--version'], { cwd: root, env: environment(root), timeout: 10000 });
  same(version.stdout.trim(), RUNTIME.version, 'RUNTIME_MISMATCH');
  await privateFile(path.join(root, 'codex', 'config.toml'), configText(root, binary));
  await privateFile(path.join(root, 'codex', 'boundary-sentinel'), 'private fixture');
  await privateFile(path.join(root, 'work', 'fixture.txt'), FIXTURE);
  await privateFile(path.join(root, 'manifest.json'), JSON.stringify({ binary, ...RUNTIME }));
  return root;
}
export async function loadFixture(root) {
  if (!/^\/tmp\/pab-auth-acceptance-[A-Za-z0-9]+$/.test(root)) fail('INVALID_DISPOSABLE_ROOT');
  for (const directory of [root, ...['home', 'codex', 'work', 'scratch'].map(name => path.join(root, name))]) {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077) || await fs.realpath(directory) !== directory) fail('UNSAFE_DISPOSABLE_ROOT');
  }
  const manifest = JSON.parse(await checkedFile(path.join(root, 'manifest.json')));
  same({ version: manifest.version, sha256: manifest.sha256 }, RUNTIME, 'RUNTIME_MISMATCH');
  if (!path.isAbsolute(manifest.binary) || await fs.realpath(manifest.binary) !== manifest.binary) fail('RUNTIME_MISMATCH');
  same(hash(await fs.readFile(manifest.binary)), RUNTIME.sha256, 'RUNTIME_MISMATCH');
  same(await checkedFile(path.join(root, 'codex', 'config.toml')), configText(root, manifest.binary), 'CONFIG_FILE_CHANGED');
  same(await fs.readdir(path.join(root, 'work')), ['fixture.txt'], 'WORKSPACE_CHANGED');
  same(await checkedFile(path.join(root, 'work', 'fixture.txt')), FIXTURE, 'WORKSPACE_CHANGED');
  return { root, binary: manifest.binary };
}
export function validateAuthFile(auth) {
  if (!object(auth) || auth.auth_mode !== 'chatgpt' || auth.OPENAI_API_KEY != null ||
      Object.keys(auth).some(key => !['auth_mode', 'OPENAI_API_KEY', 'tokens', 'last_refresh'].includes(key)) ||
      !object(auth.tokens) || ['access_token', 'refresh_token', 'id_token', 'account_id'].some(key => typeof auth.tokens[key] !== 'string' || !auth.tokens[key])) fail('CHATGPT_FILE_AUTH_REQUIRED');
  return hash(auth.tokens.account_id);
}
async function loginBinding(root) {
  return validateAuthFile(JSON.parse(await checkedFile(path.join(root, 'codex', 'auth.json'))));
}
export function validateConfiguration(response, requirements, root, binary) {
  if (!object(response?.config) || !Array.isArray(response.layers) || !response.layers.length || !object(requirements)) fail('CONFIGURATION_UNVERIFIED');
  same(withoutNulls(requirements.requirements), { allowedLoginMethods: ['chatgpt'] }, 'MANAGED_CONFIGURATION_UNVERIFIED');
  for (const [key, value] of Object.entries(configuration(root, binary))) same(withoutNulls(response.config[key]), value, 'CONFIGURATION_MISMATCH');
  for (const key of ['openai_base_url', 'model', 'model_instructions_file', 'instructions', 'developer_instructions', 'compact_prompt',
    'experimental_compact_prompt_file', 'model_catalog_json', 'profile', 'hooks', 'oss_provider', 'environments', 'forced_chatgpt_workspace_id']) {
    if (response.config[key] != null) fail('UNEXPECTED_CONFIGURATION');
  }
  same(response.config.profiles ?? {}, {}, 'UNEXPECTED_CONFIGURATION');
  for (const layer of response.layers) {
    if (layer.disabledReason != null || !object(layer.config)) fail('CONFIGURATION_UNVERIFIED');
    if (!Object.keys(layer.config).length) continue;
    if (layer.name?.type !== 'sessionFlags' && !(layer.name?.type === 'user' && layer.name.file === path.join(root, 'codex', 'config.toml') && layer.name.profile == null)) fail('INHERITED_CONFIGURATION');
    for (const [key, value] of Object.entries(layer.config)) same(value, configuration(root, binary)[key], 'UNEXPECTED_CONFIGURATION');
  }
}
export function accountBinding(response) {
  try { requireSubscription(response); } catch { fail('CHATGPT_ACCOUNT_REQUIRED'); }
  if (!nonempty(response.account.email) || !subscriptionPlans.includes(response.account.planType)) fail('ACCOUNT_IDENTITY_UNVERIFIED');
  return hash(JSON.stringify(response.account));
}
export function validateThread(response, root, model) {
  if (!object(response?.thread) || !nonempty(response.thread.id) || !nonempty(response.thread.sessionId) ||
      response.thread.forkedFromId !== null || response.thread.parentThreadId !== null || response.thread.ephemeral !== true ||
      response.thread.modelProvider !== 'openai' || response.thread.cwd !== path.join(root, 'work') ||
      !Array.isArray(response.thread.turns) || response.thread.turns.length || response.modelProvider !== 'openai' || response.model !== model ||
      response.cwd !== path.join(root, 'work') || response.approvalPolicy !== 'never' || response.approvalsReviewer !== 'user' ||
      !['readOnly', 'workspaceWrite'].includes(response.sandbox?.type) || response.sandbox.networkAccess !== false ||
      response.activePermissionProfile?.id !== PROFILE || response.activePermissionProfile.extends !== null ||
      !Array.isArray(response.instructionSources) || response.instructionSources.length) fail('THREAD_POLICY_OR_IDENTITY_UNVERIFIED');
}

export function newReport() {
  return { runtime: RUNTIME, authentication: 'UNVERIFIED', inference: 'UNVERIFIED', subscriptionUsageAttribution: 'UNVERIFIED',
    apiKeyFallbackExcluded: 'UNVERIFIED', modelCommand: 'UNVERIFIED', identityBinding: 'UNVERIFIED',
    configuration: 'UNVERIFIED', standaloneBoundary: 'UNVERIFIED', modelTurnsSubmitted: 0,
    usage: null, commandEvidence: null, notificationDiagnostics: [], mcpInventorySnapshots: [], zeroActiveMcpServers: 'UNVERIFIED',
    outcome: 'BLOCKED', nextSandboxStage: 'BLOCKED', migrationReady: false,
    limitations: ['Usage counters are not billing attribution.', 'One read-only command is not full tool security equivalence.',
      'Runtime internal inference retries are not observable here; PAB never resubmits an uncertain turn.', 'Process-tree quiescence remains unverified.'] };
}

export function classifyMcpNotification(message, threadId) {
  const params = message.params;
  const result = { methodCategory: 'unknown_mcp', semantics: 'unknown', schema: 'unknown',
    scope: 'unverified', identity: 'unverified', authorized: false };
  const fields = (required, optional = []) => object(params) && required.every(key => Object.hasOwn(params, key)) &&
    Object.keys(params).every(key => required.includes(key) || optional.includes(key));
  if (message.method === 'mcpServer/startupStatus/updated' || message.method === 'mcpServer/oauthLogin/completed') {
    result.scope = params?.threadId === null ? 'app' : !nonempty(params?.threadId) ? 'invalid' :
      !threadId ? 'unbound_thread' : params.threadId === threadId ? 'same_thread' : 'cross_thread';
    result.identity = nonempty(params?.name) ? 'unauthorized_server' : 'missing_server';
    let valid;
    if (message.method === 'mcpServer/startupStatus/updated') {
      result.methodCategory = 'startup_status'; result.semantics = 'server_lifecycle';
      result.status = ['starting', 'ready', 'failed', 'cancelled'].includes(params?.status) ? params.status : 'unknown';
      valid = fields(['threadId', 'name', 'status', 'error', 'failureReason']) && result.status !== 'unknown' &&
        (params.error === null || typeof params.error === 'string') && [null, 'reauthenticationRequired'].includes(params.failureReason);
    } else {
      result.methodCategory = 'oauth_completed'; result.semantics = 'oauth_activity';
      valid = fields(['name', 'threadId', 'success'], ['error']) && typeof params.success === 'boolean' &&
        (!Object.hasOwn(params, 'error') || typeof params.error === 'string');
    }
    result.schema = valid && result.scope !== 'invalid' && result.identity === 'unauthorized_server' ? 'recognized' : 'invalid';
  } else if (message.method === 'mcpServer/event/stream/notification') {
    result.methodCategory = 'event_stream'; result.semantics = 'server_event';
    result.identity = 'unauthorized_subscription';
    result.schema = fields(['subscriptionId', 'notification']) && nonempty(params.subscriptionId) && object(params.notification) &&
      isDeepStrictEqual(Object.keys(params.notification).sort(), ['method', 'params']) && nonempty(params.notification.method) ? 'recognized' : 'invalid';
  } else if (message.method === 'item/mcpToolCall/progress' ||
      (['item/started', 'item/completed'].includes(message.method) && params?.item?.type === 'mcpToolCall')) {
    result.methodCategory = message.method === 'item/mcpToolCall/progress' ? 'tool_progress' : 'tool_item';
    result.semantics = 'tool_activity'; result.identity = 'unauthorized_tool';
    result.scope = !nonempty(params?.threadId) ? 'invalid' : !threadId ? 'unbound_thread' :
      params.threadId === threadId ? 'same_thread' : 'cross_thread';
  }
  return result;
}

export function validateEmptyMcpInventory(response) {
  if (!object(response) || !isDeepStrictEqual(Object.keys(response).sort(), ['data', 'nextCursor']) ||
      !Array.isArray(response.data) || response.nextCursor !== null) fail('MCP_INVENTORY_UNVERIFIED');
  if (response.data.length) fail('MCP_SERVER_PRESENT');
}

export class NotificationGuard {
  constructor(report) { this.report = report; this.phase = 'initialization'; this.updates = []; this.locked = true; this.failure = null; }
  setPhase(phase) {
    if (!['initialization', 'configuration', 'boundary', 'authentication', 'model_selection', 'thread_creation',
      'pre_inference', 'inference', 'post_inference', 'complete', 'shutdown'].includes(phase)) fail('INVALID_DIAGNOSTIC_PHASE');
    this.phase = phase;
  }
  record(category) {
    if (!['account_updated', 'runtime_error', 'hook_activity', 'mcp_activity', 'configuration_warning',
      'remote_control', 'unsupported_notification', 'model_activity'].includes(category)) fail('INVALID_DIAGNOSTIC_CATEGORY');
    if (this.report.notificationDiagnostics.length >= 32) this.reject('NOTIFICATION_DIAGNOSTICS_LIMIT');
    this.report.notificationDiagnostics.push({ category, phase: this.phase });
  }
  reject(code) {
    this.failure ||= code;
    this.report.blocker ||= this.failure;
    this.report.blockerPhase ||= this.phase;
    for (const key of ['authentication', 'inference', 'identityBinding', 'apiKeyFallbackExcluded', 'modelCommand']) this.report[key] = 'UNVERIFIED';
    this.report.outcome = 'BLOCKED';
    fail(this.failure);
  }
  check() { if (this.failure) fail(this.failure); }
  reconcile(response) {
    this.check();
    const expected = hash(JSON.stringify({ authMode: 'chatgpt', planType: response.account.planType }));
    if (this.updates.some(update => update !== expected)) this.reject('AUTH_NOTIFICATION_MISMATCH');
    this.locked = true;
    this.updates = [];
  }
  receive(message) {
    this.check();
    const method = message.method;
    if (method === 'account/updated') {
      this.record('account_updated');
      if (this.locked || !['initialization', 'configuration', 'boundary', 'authentication'].includes(this.phase)) this.reject('RUNTIME_UNCERTAINTY');
      const params = message.params;
      if (!object(params) || !isDeepStrictEqual(Object.keys(params).sort(), ['authMode', 'planType']) ||
          params.authMode !== 'chatgpt' || !subscriptionPlans.includes(params.planType)) this.reject('AUTH_NOTIFICATION_UNVERIFIED');
      if (this.updates.length >= 8) this.reject('AUTH_NOTIFICATION_LIMIT');
      this.updates.push(hash(JSON.stringify({ authMode: params.authMode, planType: params.planType })));
      return true;
    }
    if (method?.startsWith('mcpServer/') || method === 'item/mcpToolCall/progress' ||
        (['item/started', 'item/completed'].includes(method) && message.params?.item?.type === 'mcpToolCall')) {
      this.record('mcp_activity');
      this.report.notificationDiagnostics.at(-1).mcp = classifyMcpNotification(message, this.threadId);
      this.reject('RUNTIME_UNCERTAINTY');
    }
    const category = method === 'error' ? 'runtime_error' : method?.startsWith('hook/') ? 'hook_activity' : null;
    if (category) { this.record(category); this.reject('RUNTIME_UNCERTAINTY'); }
    if (this.readOnly && /^(thread\/|turn\/|item\/)/.test(method)) { this.record('model_activity'); this.reject('DIAGNOSTIC_MODEL_ACTIVITY'); }
    return false;
  }
}

export class TurnEvidence {
  constructor(root, report = newReport()) { this.root = root; this.notifications = new NotificationGuard(report); this.pending = []; this.started = false; this.completed = false; this.commands = new Map(); this.answer = null; this.usage = null; }
  bind(threadId, turnId) {
    if (!nonempty(threadId) || !nonempty(turnId)) fail('TURN_IDENTITY_UNVERIFIED');
    this.binding = { threadId, turnId };
    for (const message of this.pending) this.receive(message);
    this.pending = [];
  }
  receive(message) {
    const method = message.method, params = message.params;
    if (this.notifications.receive(message)) return;
    if (method === 'configWarning') {
      this.notifications.record('configuration_warning');
      if (params?.summary !== 'Codex could not find bubblewrap on PATH. Install bubblewrap with your OS package manager. See the sandbox prerequisites: https://developers.openai.com/codex/concepts/sandboxing#prerequisites. Codex will use the bundled bubblewrap in the meantime.' || params.details !== null) fail('CONFIG_WARNING_UNVERIFIED');
      return;
    }
    if (method === 'remoteControl/status/changed') {
      this.notifications.record('remote_control');
      if (params?.status !== 'disabled' || params.environmentId !== null) fail('REMOTE_CONTROL_NOT_DISABLED');
      return;
    }
    if (['thread/started', 'thread/status/changed', 'account/rateLimits/updated', 'item/agentMessage/delta',
      'item/reasoning/summaryTextDelta', 'item/reasoning/summaryPartAdded', 'item/reasoning/textDelta', 'item/commandExecution/outputDelta'].includes(method)) return;
    if (!['turn/started', 'turn/completed', 'item/started', 'item/completed', 'thread/tokenUsage/updated'].includes(method)) {
      this.notifications.record('unsupported_notification'); this.notifications.reject('UNSUPPORTED_NOTIFICATION');
    }
    if (!this.binding) {
      if (this.pending.length >= 64 || Buffer.byteLength(JSON.stringify(message)) > 32768) fail('EVIDENCE_LIMIT');
      this.pending.push(message); return;
    }
    if (params?.threadId !== this.binding.threadId || (params.turn?.id ?? params.turnId) !== this.binding.turnId) fail('EVENT_IDENTITY_MISMATCH');
    if (method === 'turn/started') { if (this.started || this.completed || params.turn.status !== 'inProgress') fail('INVALID_TURN_START'); this.started = true; return; }
    if (method === 'thread/tokenUsage/updated') {
      const usage = params.tokenUsage?.last;
      const keys = ['totalTokens', 'inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens'];
      if (!object(usage) || keys.some(key => !Number.isSafeInteger(usage[key]) || usage[key] < 0) || !usage.totalTokens || !usage.outputTokens) fail('USAGE_UNVERIFIED');
      this.usage = Object.fromEntries(keys.map(key => [key, usage[key]])); return;
    }
    if (!this.started || this.completed) fail('EVENT_ORDER_UNCERTAIN');
    if (method === 'turn/completed') {
      if (params.turn.status !== 'completed' || params.turn.error != null) fail('TURN_NOT_COMPLETED');
      this.completed = true; return;
    }
    const item = params.item;
    if (item?.type === 'reasoning' || item?.type === 'userMessage') return;
    if (item?.type === 'agentMessage') {
      if (method === 'item/completed') {
        if (this.answer !== null || item.text !== RESPONSE) fail('MODEL_RESPONSE_UNVERIFIED');
        this.answer = item.text;
      }
      return;
    }
    if (item?.type !== 'commandExecution' || !nonempty(item.id)) fail('UNEXPECTED_MODEL_TOOL');
    const allowed = ['cat fixture.txt', '/usr/bin/cat fixture.txt'].flatMap(command => [command, `/bin/bash -lc '${command}'`, `/bin/bash -c '${command}'`, `/bin/sh -c '${command}'`]);
    if (!allowed.includes(item.command) || item.cwd !== path.join(this.root, 'work')) fail('UNEXPECTED_MODEL_COMMAND');
    if (method === 'item/started') {
      if (this.commands.size || item.status !== 'inProgress') fail('COMMAND_HISTORY_UNCERTAIN');
      this.commands.set(item.id, null);
    } else {
      if (!this.commands.has(item.id) || this.commands.get(item.id) !== null) fail('COMMAND_HISTORY_UNCERTAIN');
      const observed = commandObservation(message, this.binding);
      if (observed.exitCode !== 0 || observed.status !== 'completed' || observed.output !== FIXTURE || observed.locallyTruncated) fail('COMMAND_RESULT_UNVERIFIED');
      this.commands.set(item.id, observed);
    }
  }
  result() {
    if (!this.started || !this.completed || this.answer !== RESPONSE || !this.usage) fail('INFERENCE_EVIDENCE_UNVERIFIED');
    if (this.commands.size !== 1 || [...this.commands.values()].some(value => value === null)) fail('COMMAND_EVIDENCE_UNVERIFIED');
    const command = [...this.commands.values()][0];
    return { usage: this.usage, commandEvidence: { provenance: command.provenance, command: command.command,
      cwd: '<disposable-workspace>', output: FIXTURE, exitCode: command.exitCode, identityBound: true,
      upstreamCompleteness: command.upstreamCompleteness, fullToolSecurityEquivalence: 'UNVERIFIED' } };
  }
}

export async function runProtocol(options) {
  try { return await checkedProtocol(options); }
  catch (error) { options.evidence.notifications.reject(safeCode(error)); }
}

async function checkedProtocol({ rpc, root, binary, ledger, evidence, report, claim, validateFiles, inference = true, diagnostic = false, timeoutMs = 90000 }) {
  const notifications = evidence.notifications;
  const checkMcpInventory = async threadId => {
    notifications.check();
    const inventory = await rpc.request('mcpServerStatus/list', { detail: 'full', limit: 1, ...(threadId ? { threadId } : {}) });
    notifications.check();
    if (rpc.failure) fail('TRANSPORT_UNCERTAIN');
    validateEmptyMcpInventory(inventory);
    if (report.mcpInventorySnapshots.length >= 3) fail('MCP_INVENTORY_UNVERIFIED');
    report.mcpInventorySnapshots.push({ phase: notifications.phase, scope: threadId ? 'thread' : 'app', empty: true, completePage: true });
  };
  notifications.locked = !(inference || diagnostic);
  notifications.readOnly = diagnostic;
  notifications.setPhase('initialization');
  const initialized = await rpc.initialize();
  if (initialized?.codexHome !== path.join(root, 'codex') || initialized.platformOs !== 'linux') fail('RUNTIME_HOME_UNVERIFIED');
  notifications.setPhase('configuration');
  const config = await rpc.request('config/read', { includeLayers: true, cwd: path.join(root, 'work') });
  validateConfiguration(config, await rpc.request('configRequirements/read'), root, binary); report.configuration = 'VERIFIED';
  if (!diagnostic) {
    notifications.setPhase('boundary');
    const command = `import pathlib,socket,errno\nassert pathlib.Path('fixture.txt').read_text()==${JSON.stringify(FIXTURE)}\nfor target,mode in [(${JSON.stringify(path.join(root, 'work', 'must-not-create'))},'w'),(${JSON.stringify(path.join(root, 'codex', 'boundary-sentinel'))},'r')]:\n try: open(target,mode)\n except OSError as error: assert error.errno in [errno.EACCES,errno.EPERM,errno.EROFS]\n else: raise RuntimeError('boundary')\ntry: socket.socket().connect(('127.0.0.1',9))\nexcept OSError as error: assert error.errno in [errno.EACCES,errno.EPERM]\nelse: raise RuntimeError('network')\nprint('PAB_BOUNDARY_OK')`;
    const boundary = await rpc.request('command/exec', { command: ['/usr/bin/python3', '-B', '-c', command], cwd: path.join(root, 'work'), permissionProfile: PROFILE, timeoutMs: 10000, outputBytesCap: 1024 });
    if (boundary?.exitCode !== 0 || boundary.stdout !== 'PAB_BOUNDARY_OK\n' || boundary.stderr !== '') fail('STANDALONE_BOUNDARY_FAILED');
    report.standaloneBoundary = 'VERIFIED';
  }
  if (!inference && !diagnostic) return report;
  notifications.setPhase('authentication');
  await validateFiles();
  const account = accountBinding(await rpc.request('account/read', { refreshToken: false }));
  await validateFiles();
  const reconciled = await rpc.request('account/read', { refreshToken: false });
  same(accountBinding(reconciled), account, 'ACCOUNT_CHANGED');
  validateConfiguration(await rpc.request('config/read', { includeLayers: true, cwd: path.join(root, 'work') }), await rpc.request('configRequirements/read'), root, binary);
  await validateFiles();
  if (rpc.failure) fail('TRANSPORT_UNCERTAIN');
  notifications.reconcile(reconciled);
  report.authentication = 'VERIFIED';
  if (diagnostic) {
    notifications.setPhase('complete');
    report.outcome = 'READ_ONLY_AUTHENTICATION_OBSERVED_ACCEPTANCE_UNVERIFIED';
    return report;
  }
  notifications.setPhase('model_selection');
  await checkMcpInventory();
  const models = await rpc.request('model/list', { includeHidden: false });
  const defaults = models?.data?.filter(model => model.isDefault === true && model.hidden === false);
  if (models?.nextCursor !== null || defaults?.length !== 1 || !/^[a-zA-Z0-9_.-]{1,100}$/.test(defaults[0].model)) fail('MODEL_SELECTION_UNVERIFIED');
  const model = defaults[0].model;
  notifications.check();
  notifications.setPhase('thread_creation');
  await claim();
  const start = { model, modelProvider: 'openai', cwd: path.join(root, 'work'), approvalPolicy: 'never', approvalsReviewer: 'user',
    permissions: PROFILE, ephemeral: true, environments: [], dynamicTools: [],
    developerInstructions: 'Read-only acceptance. Run only cat fixture.txt once. No other commands, file writes, network, tools, delegation, or questions. Reply exactly PAB_AUTH_ACCEPTANCE_OK after reading the fixture.' };
  if (!ledger.beginOperation('create', 'thread/start', start).dispatch) fail('ATTEMPT_ALREADY_CLAIMED');
  const thread = await rpc.request('thread/start', start);
  validateThread(thread, root, model);
  notifications.threadId = thread.thread.id;
  ledger.acknowledgeOperation('create'); ledger.bind('implementer', thread.thread.id, thread.thread.sessionId, 'acceptance');
  notifications.setPhase('pre_inference');
  validateConfiguration(await rpc.request('config/read', { includeLayers: true, cwd: path.join(root, 'work') }), await rpc.request('configRequirements/read'), root, binary);
  same(accountBinding(await rpc.request('account/read', { refreshToken: false })), account, 'ACCOUNT_CHANGED');
  await validateFiles();
  await checkMcpInventory(thread.thread.id);
  notifications.check();
  notifications.setPhase('inference');
  const input = { threadId: thread.thread.id, input: [{ type: 'text', text: 'Run cat fixture.txt once, then reply exactly PAB_AUTH_ACCEPTANCE_OK. Do nothing else.' }],
    model, approvalPolicy: 'never', permissions: PROFILE, environments: [] };
  if (!ledger.beginOperation('infer', 'turn/start', input).dispatch) fail('ATTEMPT_ALREADY_CLAIMED');
  report.modelTurnsSubmitted = 1;
  const turn = await rpc.request('turn/start', input);
  if (!nonempty(turn?.turn?.id) || turn.turn.status !== 'inProgress' || turn.turn.error != null) fail('TURN_SUBMISSION_UNCERTAIN');
  ledger.acknowledgeOperation('infer'); ledger.turnStarted('implementer', turn.turn.id); evidence.bind(thread.thread.id, turn.turn.id);
  const deadline = Date.now() + timeoutMs;
  while (!evidence.completed) {
    if (rpc.failure) fail('TRANSPORT_UNCERTAIN');
    if (Date.now() >= deadline) fail('TURN_OUTCOME_UNCERTAIN');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  if (rpc.failure) fail('TRANSPORT_UNCERTAIN');
  const observed = evidence.result();
  notifications.setPhase('post_inference');
  same(accountBinding(await rpc.request('account/read', { refreshToken: false })), account, 'ACCOUNT_CHANGED');
  validateConfiguration(await rpc.request('config/read', { includeLayers: true, cwd: path.join(root, 'work') }), await rpc.request('configRequirements/read'), root, binary);
  await validateFiles();
  await checkMcpInventory(thread.thread.id);
  notifications.check();
  ledger.turnCompleted('implementer', 'acceptance', { threadId: thread.thread.id, turn: { id: turn.turn.id, status: 'completed' } });
  Object.assign(report, observed, { inference: 'VERIFIED', identityBinding: 'VERIFIED', modelCommand: 'VERIFIED', apiKeyFallbackExcluded: 'VERIFIED',
    outcome: 'AUTHENTICATED_INFERENCE_OBSERVED_ATTRIBUTION_UNVERIFIED', model });
  notifications.setPhase('complete');
  return report;
}

export async function diagnosticLauncher({ root, binary }) {
  const control = await fs.mkdtemp('/tmp/pab-auth-diagnostic-');
  const close = () => fs.rm(control, { recursive: true, force: true });
  try {
    await fs.chmod(control, 0o700);
    for (const name of ['home', 'codex', 'scratch']) await fs.mkdir(path.join(control, name), { mode: 0o700 });
    const sentinel = path.join(control, 'sentinel');
    await privateFile(sentinel, 'unchanged');
    const env = environment(control), childEnv = { ...environment(root), TMPDIR: path.join(control, 'scratch'), CODEX_SQLITE_HOME: path.join(control, 'scratch', 'sqlite') };
    const permissions = { [PROFILE]: { filesystem: { ':minimal': 'read', [binary]: 'read', [root]: 'read',
      [sentinel]: 'read', [path.join(control, 'scratch')]: 'write' }, network: { enabled: false } } };
    const args = ['sandbox', ...launchArgs(root, binary).slice(1), '-c', `permissions=${toml(permissions)}`, '-P', PROFILE, '-C', root, '--'];
    const check = `import os,socket,errno\ntry: descriptor=os.open(${JSON.stringify(sentinel)},os.O_WRONLY)\nexcept OSError as error: assert error.errno in [errno.EACCES,errno.EPERM,errno.EROFS]\nelse: os.close(descriptor); raise RuntimeError('write allowed')\ntry: socket.socket().connect(('127.0.0.1',9))\nexcept OSError as error: assert error.errno in [errno.EACCES,errno.EPERM]\nelse: raise RuntimeError('network allowed')\nprint('PAB_DIAGNOSTIC_BOUNDARY_OK')`;
    const runCheck = program => promisify(execFile)(binary, [...args, '/usr/bin/python3', '-B', '-c', program], { cwd: control, env, timeout: 10000, maxBuffer: 4096 });
    let result;
    try { result = await runCheck(check); }
    catch { fail('DIAGNOSTIC_BOUNDARY_UNAVAILABLE'); }
    if (result.stdout !== 'PAB_DIAGNOSTIC_BOUNDARY_OK\n' || await checkedFile(sentinel) !== 'unchanged') fail('DIAGNOSTIC_BOUNDARY_UNAVAILABLE');
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    const command = [binary, ...args, '/usr/bin/env', '-i', ...Object.entries(childEnv).map(([key, value]) => `${key}=${value}`), binary];
    const launcher = path.join(control, 'launch');
    await privateFile(launcher, `#!/bin/sh\nexec ${command.map(quote).join(' ')} "$@"\n`);
    await fs.chmod(launcher, 0o700);
    return { binary: launcher, env, close, runCheck };
  } catch (error) { await close(); throw error; }
}

async function execute(root, inference, diagnostic = false) {
  const fixture = await loadFixture(root), report = newReport(), evidence = new TurnEvidence(root, report);
  let rpc, ledger, launcher, fingerprint;
  try {
    let binding;
    if (inference || diagnostic) {
      const login = JSON.parse(await checkedFile(path.join(root, 'operator-login.json')));
      binding = await loginBinding(root);
      same(login, { source: 'fresh-device-login', binding }, 'FRESH_OPERATOR_LOGIN_REQUIRED');
    }
    if (diagnostic) {
      fingerprint = hash(await checkedFile(path.join(root, 'codex', 'auth.json')));
      launcher = await diagnosticLauncher(fixture);
    }
    rpc = new AppServerRpc(launcher?.binary ?? fixture.binary, launchArgs(root, fixture.binary), { cwd: root, env: launcher?.env ?? environment(root),
      onMessage: message => { try { evidence.receive(message); } catch (error) { report.blocker = safeCode(error); throw error; } }, timeoutMs: 15000 });
    if (!diagnostic) ledger = new SessionLedger(path.join(root, 'acceptance.sqlite'));
    await runProtocol({ rpc, root, binary: fixture.binary, ledger, evidence, report, inference, diagnostic,
      claim: () => privateFile(path.join(root, 'inference.claim'), 'Never replay this attempt.\n'),
      validateFiles: async () => {
        await loadFixture(root); same(await loginBinding(root), binding, 'AUTH_FILE_IDENTITY_CHANGED');
        if (diagnostic) same(hash(await checkedFile(path.join(root, 'codex', 'auth.json'))), fingerprint, 'DIAGNOSTIC_AUTH_CHANGED');
      } });
  } catch (error) {
    report.blocker ||= safeCode(error);
    report.blockerPhase ||= evidence.notifications.phase;
  } finally {
    evidence.notifications.setPhase('shutdown');
    await rpc?.close(); ledger?.close();
    await launcher?.close();
    if (diagnostic && fingerprint) {
      try { same(hash(await checkedFile(path.join(root, 'codex', 'auth.json'))), fingerprint, 'DIAGNOSTIC_AUTH_CHANGED'); }
      catch { report.blocker ||= 'DIAGNOSTIC_AUTH_CHANGED'; }
    }
  }
  if (report.blocker) {
    for (const key of ['authentication', 'inference', 'identityBinding', 'apiKeyFallbackExcluded', 'modelCommand']) report[key] = 'UNVERIFIED';
    report.outcome = 'BLOCKED';
  }
  if (!diagnostic) await privateFile(path.join(root, `result-${inference ? 'authenticated' : 'preflight'}-${Date.now()}.json`), JSON.stringify(report, null, 2) + '\n');
  return report;
}

async function login(root) {
  const fixture = await loadFixture(root);
  for (const name of ['codex/auth.json', 'operator-login.json', 'inference.claim']) {
    try { await fs.lstat(path.join(root, name)); fail('FRESH_LOGIN_ONLY'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const preflight = await execute(root, false);
  if (preflight.configuration !== 'VERIFIED' || preflight.standaloneBoundary !== 'VERIFIED' || preflight.blocker) fail('LOGIN_PREFLIGHT_FAILED');
  const child = spawn(fixture.binary, [...launchArgs(root, fixture.binary).slice(1), 'login', '--device-auth'], { cwd: root, env: environment(root), stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  if (code !== 0) fail('LOGIN_FAILED');
  await privateFile(path.join(root, 'operator-login.json'), JSON.stringify({ source: 'fresh-device-login', binding: await loginBinding(root) }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const [mode, target, ...extra] = process.argv.slice(2);
    if (extra.length || !target || !['prepare', 'preflight', 'login', 'run', 'diagnose-auth'].includes(mode)) fail('USAGE_PREPARE_BINARY_OR_PREFLIGHT_LOGIN_RUN_DIAGNOSE_AUTH_ROOT');
    if (mode === 'prepare') process.stdout.write(await prepare(target) + '\n');
    else if (mode === 'login') await login(target);
    else {
      const report = await execute(target, mode === 'run', mode === 'diagnose-auth');
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      if (report.blocker) process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(safeCode(error) + '\n');
    process.exitCode = 1;
  }
}
