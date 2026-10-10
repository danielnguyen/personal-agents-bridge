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
const fail = code => { throw Object.assign(new Error(code), { code }); };
const hash = value => createHash('sha256').update(value).digest('hex');
const same = (actual, expected, code) => { if (!isDeepStrictEqual(actual, expected)) fail(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const safeCode = error => /^[A-Z_]+$/.test(error.code || error.message || '') ? error.code || error.message : 'ACCEPTANCE_UNCERTAIN';
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
  if (!nonempty(response.account.email) || !['go', 'plus', 'pro', 'prolite', 'team', 'business', 'enterprise', 'edu', 'edu_plus', 'edu_pro'].includes(response.account.planType)) fail('ACCOUNT_IDENTITY_UNVERIFIED');
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
    usage: null, commandEvidence: null, outcome: 'BLOCKED', nextSandboxStage: 'BLOCKED', migrationReady: false,
    limitations: ['Usage counters are not billing attribution.', 'One read-only command is not full tool security equivalence.',
      'Runtime internal inference retries are not observable here; PAB never resubmits an uncertain turn.', 'Process-tree quiescence remains unverified.'] };
}

export class TurnEvidence {
  constructor(root) { this.root = root; this.pending = []; this.started = false; this.completed = false; this.commands = new Map(); this.answer = null; this.usage = null; }
  bind(threadId, turnId) {
    if (!nonempty(threadId) || !nonempty(turnId)) fail('TURN_IDENTITY_UNVERIFIED');
    this.binding = { threadId, turnId };
    for (const message of this.pending) this.receive(message);
    this.pending = [];
  }
  receive(message) {
    const method = message.method, params = message.params;
    if (method === 'configWarning') {
      if (params?.summary !== 'Codex could not find bubblewrap on PATH. Install bubblewrap with your OS package manager. See the sandbox prerequisites: https://developers.openai.com/codex/concepts/sandboxing#prerequisites. Codex will use the bundled bubblewrap in the meantime.' || params.details !== null) fail('CONFIG_WARNING_UNVERIFIED');
      return;
    }
    if (method === 'remoteControl/status/changed') {
      if (params?.status !== 'disabled' || params.environmentId !== null) fail('REMOTE_CONTROL_NOT_DISABLED');
      return;
    }
    if (method === 'error' || method === 'account/updated' || method.startsWith('hook/') || method.startsWith('mcpServer/')) fail('RUNTIME_UNCERTAINTY');
    if (['thread/started', 'thread/status/changed', 'account/rateLimits/updated', 'item/agentMessage/delta',
      'item/reasoning/summaryTextDelta', 'item/reasoning/summaryPartAdded', 'item/reasoning/textDelta', 'item/commandExecution/outputDelta'].includes(method)) return;
    if (!['turn/started', 'turn/completed', 'item/started', 'item/completed', 'thread/tokenUsage/updated'].includes(method)) fail('UNSUPPORTED_NOTIFICATION');
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

export async function runProtocol({ rpc, root, binary, ledger, evidence, report, claim, validateFiles, inference = true, timeoutMs = 90000 }) {
  const initialized = await rpc.initialize();
  if (initialized?.codexHome !== path.join(root, 'codex') || initialized.platformOs !== 'linux') fail('RUNTIME_HOME_UNVERIFIED');
  const config = await rpc.request('config/read', { includeLayers: true, cwd: path.join(root, 'work') });
  validateConfiguration(config, await rpc.request('configRequirements/read'), root, binary); report.configuration = 'VERIFIED';
  const command = `import pathlib,socket,errno\nassert pathlib.Path('fixture.txt').read_text()==${JSON.stringify(FIXTURE)}\nfor target,mode in [(${JSON.stringify(path.join(root, 'work', 'must-not-create'))},'w'),(${JSON.stringify(path.join(root, 'codex', 'boundary-sentinel'))},'r')]:\n try: open(target,mode)\n except OSError as error: assert error.errno in [errno.EACCES,errno.EPERM,errno.EROFS]\n else: raise RuntimeError('boundary')\ntry: socket.socket().connect(('127.0.0.1',9))\nexcept OSError as error: assert error.errno in [errno.EACCES,errno.EPERM]\nelse: raise RuntimeError('network')\nprint('PAB_BOUNDARY_OK')`;
  const boundary = await rpc.request('command/exec', { command: ['/usr/bin/python3', '-B', '-c', command], cwd: path.join(root, 'work'), permissionProfile: PROFILE, timeoutMs: 10000, outputBytesCap: 1024 });
  if (boundary?.exitCode !== 0 || boundary.stdout !== 'PAB_BOUNDARY_OK\n' || boundary.stderr !== '') fail('STANDALONE_BOUNDARY_FAILED');
  report.standaloneBoundary = 'VERIFIED';
  if (!inference) return report;
  await validateFiles();
  const account = accountBinding(await rpc.request('account/read', { refreshToken: false }));
  report.authentication = 'VERIFIED';
  const models = await rpc.request('model/list', { includeHidden: false });
  const defaults = models?.data?.filter(model => model.isDefault === true && model.hidden === false);
  if (models?.nextCursor !== null || defaults?.length !== 1 || !/^[a-zA-Z0-9_.-]{1,100}$/.test(defaults[0].model)) fail('MODEL_SELECTION_UNVERIFIED');
  const model = defaults[0].model;
  await claim();
  const start = { model, modelProvider: 'openai', cwd: path.join(root, 'work'), approvalPolicy: 'never', approvalsReviewer: 'user',
    permissions: PROFILE, ephemeral: true, environments: [], dynamicTools: [],
    developerInstructions: 'Read-only acceptance. Run only cat fixture.txt once. No other commands, file writes, network, tools, delegation, or questions. Reply exactly PAB_AUTH_ACCEPTANCE_OK after reading the fixture.' };
  if (!ledger.beginOperation('create', 'thread/start', start).dispatch) fail('ATTEMPT_ALREADY_CLAIMED');
  const thread = await rpc.request('thread/start', start);
  validateThread(thread, root, model);
  ledger.acknowledgeOperation('create'); ledger.bind('implementer', thread.thread.id, thread.thread.sessionId, 'acceptance');
  validateConfiguration(await rpc.request('config/read', { includeLayers: true, cwd: path.join(root, 'work') }), await rpc.request('configRequirements/read'), root, binary);
  same(accountBinding(await rpc.request('account/read', { refreshToken: false })), account, 'ACCOUNT_CHANGED');
  await validateFiles();
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
  same(accountBinding(await rpc.request('account/read', { refreshToken: false })), account, 'ACCOUNT_CHANGED');
  validateConfiguration(await rpc.request('config/read', { includeLayers: true, cwd: path.join(root, 'work') }), await rpc.request('configRequirements/read'), root, binary);
  await validateFiles();
  ledger.turnCompleted('implementer', 'acceptance', { threadId: thread.thread.id, turn: { id: turn.turn.id, status: 'completed' } });
  Object.assign(report, observed, { inference: 'VERIFIED', identityBinding: 'VERIFIED', modelCommand: 'VERIFIED', apiKeyFallbackExcluded: 'VERIFIED',
    outcome: 'AUTHENTICATED_INFERENCE_OBSERVED_ATTRIBUTION_UNVERIFIED', model });
  return report;
}

async function execute(root, inference) {
  const fixture = await loadFixture(root), report = newReport(), evidence = new TurnEvidence(root);
  let rpc, ledger;
  try {
    let binding;
    if (inference) {
      const login = JSON.parse(await checkedFile(path.join(root, 'operator-login.json')));
      binding = await loginBinding(root);
      same(login, { source: 'fresh-device-login', binding }, 'FRESH_OPERATOR_LOGIN_REQUIRED');
    }
    rpc = new AppServerRpc(fixture.binary, launchArgs(root, fixture.binary), { cwd: root, env: environment(root),
      onMessage: message => { try { evidence.receive(message); } catch (error) { report.blocker = safeCode(error); throw error; } }, timeoutMs: 15000 });
    ledger = new SessionLedger(path.join(root, 'acceptance.sqlite'));
    await runProtocol({ rpc, root, binary: fixture.binary, ledger, evidence, report, inference,
      claim: () => privateFile(path.join(root, 'inference.claim'), 'Never replay this attempt.\n'),
      validateFiles: async () => { await loadFixture(root); same(await loginBinding(root), binding, 'AUTH_FILE_IDENTITY_CHANGED'); } });
  } catch (error) {
    report.blocker ||= safeCode(error);
  } finally {
    await rpc?.close(); ledger?.close();
  }
  await privateFile(path.join(root, `result-${inference ? 'authenticated' : 'preflight'}-${Date.now()}.json`), JSON.stringify(report, null, 2) + '\n');
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
    if (extra.length || !target || !['prepare', 'preflight', 'login', 'run'].includes(mode)) fail('USAGE_PREPARE_BINARY_OR_PREFLIGHT_LOGIN_RUN_ROOT');
    if (mode === 'prepare') process.stdout.write(await prepare(target) + '\n');
    else if (mode === 'login') await login(target);
    else {
      const report = await execute(target, mode === 'run');
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      if (report.blocker) process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(safeCode(error) + '\n');
    process.exitCode = 1;
  }
}
