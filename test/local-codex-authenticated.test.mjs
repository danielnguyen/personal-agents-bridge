import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { SessionLedger } from '../feasibility/local-codex/state.mjs';
import { configuration, environment, validateConfiguration, accountBinding, validateAuthFile, validateThread,
  newReport, TurnEvidence, runProtocol, loadFixture, prepare, diagnosticLauncher, PROFILE, FIXTURE, RESPONSE } from '../feasibility/local-codex/authenticated-acceptance.mjs';

const clone = value => structuredClone(value);
const binary = '/opt/synthetic-codex';
const account = () => ({ account: { type: 'chatgpt', email: 'synthetic@example.invalid', planType: 'pro' }, requiresOpenaiAuth: true });
const requirements = () => ({ requirements: { allowedLoginMethods: ['chatgpt'], modelProvider: null } });
const config = root => ({ config: configuration(root, binary), layers: [{ name: { type: 'user', file: path.join(root, 'codex', 'config.toml'), profile: null }, config: configuration(root, binary) }] });
const thread = root => ({ thread: { id: 'synthetic-thread', sessionId: 'synthetic-session', forkedFromId: null, parentThreadId: null,
  ephemeral: true, modelProvider: 'openai', cwd: path.join(root, 'work'), turns: [] }, model: 'fixture-model', modelProvider: 'openai',
  cwd: path.join(root, 'work'), approvalPolicy: 'never', approvalsReviewer: 'user', activePermissionProfile: { id: PROFILE, extends: null },
  sandbox: { type: 'readOnly', networkAccess: false }, instructionSources: [] });
const usage = () => ({ totalTokens: 20, inputTokens: 15, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0 });
function events(root) {
  const binding = { threadId: 'synthetic-thread', turnId: 'synthetic-turn' };
  const command = { id: 'synthetic-command', type: 'commandExecution', command: 'cat fixture.txt', cwd: path.join(root, 'work') };
  return [
    { method: 'turn/started', params: { threadId: binding.threadId, turn: { id: binding.turnId, status: 'inProgress' } } },
    { method: 'item/started', params: { ...binding, item: { ...command, status: 'inProgress' } } },
    { method: 'item/completed', params: { ...binding, item: { ...command, status: 'completed', aggregatedOutput: FIXTURE, exitCode: 0 } } },
    { method: 'item/completed', params: { ...binding, item: { id: 'synthetic-answer', type: 'agentMessage', text: RESPONSE } } },
    { method: 'thread/tokenUsage/updated', params: { ...binding, tokenUsage: { last: usage(), total: usage() } } },
    { method: 'turn/completed', params: { threadId: binding.threadId, turn: { id: binding.turnId, status: 'completed', error: null } } },
  ];
}
async function fixture(context, overrides = {}) {
  const root = await fs.mkdtemp('/tmp/pab-auth-unit-');
  const ledger = new SessionLedger(path.join(root, 'ledger.sqlite')), report = newReport(), evidence = new TurnEvidence(root, report), calls = [];
  context.after(async () => { ledger.close(); await fs.rm(root, { recursive: true, force: true }); });
  const rpc = { failure: null, initialize: async () => {
    overrides.initialize?.({ evidence, rpc });
    return { codexHome: path.join(root, 'codex'), platformOs: 'linux' };
  },
    async request(method, params) {
      calls.push({ method, params });
      if (overrides[method]) return overrides[method]({ root, evidence, rpc, calls, params });
      if (method === 'config/read') return config(root);
      if (method === 'configRequirements/read') return requirements();
      if (method === 'command/exec') return { exitCode: 0, stdout: 'PAB_BOUNDARY_OK\n', stderr: '' };
      if (method === 'account/read') return account();
      if (method === 'model/list') return { data: [{ model: 'fixture-model', isDefault: true, hidden: false }], nextCursor: null };
      if (method === 'thread/start') return thread(root);
      if (method === 'turn/start') {
        events(root).forEach(event => evidence.receive(event));
        return { turn: { id: 'synthetic-turn', status: 'inProgress', error: null } };
      }
      throw Error('Unexpected fake method');
    } };
  const options = { rpc, root, binary, ledger, evidence, report, timeoutMs: 30,
    claim: async () => { const handle = await fs.open(path.join(root, 'attempt.claim'), 'wx'); await handle.close(); }, validateFiles: async () => {} };
  return { ...options, calls, run: changes => runProtocol({ ...options, ...changes }) };
}

test('explicit launch environment contains no inherited keys, tokens, proxies or Codex configuration', () => {
  const before = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'synthetic-never-forward';
  try {
    const env = environment('/tmp/disposable');
    assert.deepEqual(Object.keys(env).sort(), ['CODEX_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'HOME', 'LANG', 'PATH', 'RUST_LOG', 'TMPDIR']);
    assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.CODEX_API_KEY, undefined); assert.equal(env.CODEX_ACCESS_TOKEN, undefined);
    assert.equal(env.CODEX_HOME, '/tmp/disposable/codex');
    assert(!JSON.stringify(env).includes('synthetic-never-forward'));
  } finally { if (before === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = before; }
});

test('fresh file auth rejects API keys, missing tokens, alternate modes and unknown credential fields', () => {
  const valid = { auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { access_token: 'synthetic', refresh_token: 'synthetic', id_token: 'synthetic', account_id: 'synthetic-account' } };
  assert.match(validateAuthFile(valid), /^[a-f0-9]{64}$/);
  for (const bad of [null, {}, { ...valid, auth_mode: 'apikey' }, { ...valid, OPENAI_API_KEY: 'synthetic-key' },
    { ...valid, tokens: {} }, { ...valid, credentials: 'synthetic-extra' }]) assert.throws(() => validateAuthFile(bad), /CHATGPT_FILE_AUTH_REQUIRED/);
});

test('account identity must be unambiguous ChatGPT authentication', () => {
  for (const value of [null, {}, { account: null }, { ...account(), requiresOpenaiAuth: false },
    { ...account(), account: { type: 'apiKey' } }, { ...account(), account: { type: 'chatgpt', email: null, planType: 'pro' } },
    ...['free', 'unknown', 'self_serve_business_usage_based'].map(planType => ({ ...account(), account: { ...account().account, planType } }))]) assert.throws(() => accountBinding(value));
  assert.notEqual(accountBinding(account()), accountBinding({ ...account(), account: { ...account().account, email: 'different@example.invalid' } }));
});

test('effective configuration accepts only known null defaults and owned layers', () => {
  const root = '/tmp/example', response = config(root);
  response.config.permissions[PROFILE].extends = null;
  response.config.shell_environment_policy.include_only = null;
  response.config.profiles = {};
  response.layers.push({ name: { type: 'system', file: '/etc/codex/config.toml' }, config: {} });
  assert.doesNotThrow(() => validateConfiguration(response, requirements(), root, binary));
  for (const mutate of [
    value => value.config.model_provider = 'custom',
    value => value.config.model_providers = { openai: { env_key: 'SYNTHETIC_KEY' } },
    value => value.config.openai_base_url = 'https://example.invalid',
    value => value.config.chatgpt_base_url = 'https://example.invalid',
    value => value.config.forced_login_method = null,
    value => value.config.cli_auth_credentials_store = 'auto',
    value => value.config.mcp_servers = { unrelated: {} },
    value => value.config.permissions[PROFILE].network.enabled = true,
    value => value.config.permissions[PROFILE].filesystem['/'] = 'write',
    value => value.config.shell_environment_policy.set.OPENAI_API_KEY = 'synthetic',
    value => value.config.features.hooks = true,
    value => value.layers.push({ name: { type: 'system', file: '/etc/codex/config.toml' }, config: { approval_policy: 'never' } }),
    value => value.layers[0].config.arbitrary = 'unrelated',
    value => value.layers = null,
  ]) { const changed = clone(response); mutate(changed); assert.throws(() => validateConfiguration(changed, requirements(), root, binary)); }
  assert.throws(() => validateConfiguration(response, { requirements: null }, root, binary), /MANAGED_CONFIGURATION_UNVERIFIED/);
  assert.throws(() => validateConfiguration(response, { requirements: { ...requirements().requirements, chatgptBaseUrl: 'https://example.invalid' } }, root, binary));
});

test('synthetic complete turn records separate criteria, sanitized command provenance and usage without billing claims', async context => {
  const value = await fixture(context); const result = await value.run();
  for (const key of ['authentication', 'inference', 'apiKeyFallbackExcluded', 'identityBinding', 'modelCommand']) assert.equal(result[key], 'VERIFIED');
  assert.equal(result.subscriptionUsageAttribution, 'UNVERIFIED'); assert.equal(result.nextSandboxStage, 'BLOCKED');
  assert.equal(result.migrationReady, false); assert.equal(result.modelTurnsSubmitted, 1);
  assert.equal(result.commandEvidence.provenance, 'codex_app_server_item'); assert.deepEqual(result.usage, usage());
  for (const forbidden of [value.root, 'synthetic@example.invalid', 'synthetic-thread', 'synthetic-session', 'synthetic-turn']) assert(!JSON.stringify(result).includes(forbidden));
  const turnCalls = value.calls.filter(call => call.method === 'turn/start');
  assert.equal(turnCalls.length, 1); assert.equal(turnCalls[0].params.permissions, PROFILE);
  assert.equal(value.calls.some(call => /login|logout|config\/.*write|resume/.test(call.method)), false);
});

for (const [name, overrides] of [
  ['missing authentication', { 'account/read': () => ({ account: null, requiresOpenaiAuth: true }) }],
  ['API-key account', { 'account/read': () => ({ account: { type: 'apiKey' }, requiresOpenaiAuth: true }) }],
  ['configuration failure', { 'config/read': () => ({}) }],
  ['policy failure', { 'command/exec': () => ({ exitCode: 1, stdout: '', stderr: '' }) }],
  ['ambiguous model', { 'model/list': () => ({ data: [], nextCursor: null }) }],
  ['custom provider fallback', { 'thread/start': ({ root }) => ({ ...thread(root), modelProvider: 'custom' }) }],
  ['inherited instructions', { 'thread/start': ({ root }) => ({ ...thread(root), instructionSources: ['/unrelated/AGENTS.md'] }) }],
  ['unbound policy', { 'thread/start': ({ root }) => ({ ...thread(root), activePermissionProfile: null }) }],
]) test(`${name} prevents inference`, async context => {
  const value = await fixture(context, overrides);
  await assert.rejects(value.run()); assert.equal(value.calls.filter(call => call.method === 'turn/start').length, 0);
  assert.equal(value.report.inference, 'UNVERIFIED'); assert.equal(value.report.apiKeyFallbackExcluded, 'UNVERIFIED');
});

test('missing fresh-login/file validation prevents thread creation', async context => {
  const value = await fixture(context);
  await assert.rejects(value.run({ validateFiles: async () => { throw Error('fresh login absent'); } }));
  assert(!value.calls.some(call => call.method === 'thread/start' || call.method === 'turn/start'));
});

test('lost turn acknowledgement is persisted uncertain and cannot resubmit', async context => {
  const value = await fixture(context, { 'turn/start': () => { throw Error('lost acknowledgement'); } });
  await assert.rejects(value.run());
  const stored = new SessionLedger(path.join(value.root, 'ledger.sqlite'));
  try { assert.equal(stored.db.prepare('SELECT status FROM operations WHERE id=?').get('infer').status, 'uncertain'); } finally { stored.close(); }
  await assert.rejects(value.run()); assert.equal(value.calls.filter(call => call.method === 'turn/start').length, 1);
  assert.equal(value.report.inference, 'UNVERIFIED');
});

test('transport death after turn acceptance cannot pass or retry', async context => {
  const value = await fixture(context, { 'turn/start': ({ rpc }) => { rpc.failure = Error('EOF'); return { turn: { id: 'synthetic-turn', status: 'inProgress' } }; } });
  await assert.rejects(value.run(), /TRANSPORT_UNCERTAIN/);
  assert.equal(value.calls.filter(call => call.method === 'turn/start').length, 1); assert.equal(value.report.inference, 'UNVERIFIED');
});

test('silent incomplete turn times out without automatic inference retry', async context => {
  const value = await fixture(context, { 'turn/start': () => ({ turn: { id: 'synthetic-turn', status: 'inProgress' } }) });
  await assert.rejects(value.run(), /TURN_OUTCOME_UNCERTAIN/);
  assert.equal(value.calls.filter(call => call.method === 'turn/start').length, 1);
});

test('account identity change after inference invalidates qualification', async context => {
  const value = await fixture(context, { 'account/read': ({ calls }) => {
    const result = account(); if (calls.filter(call => call.method === 'account/read').length === 4) result.account.email = 'other@example.invalid'; return result;
  } });
  await assert.rejects(value.run(), /ACCOUNT_CHANGED/);
  assert.equal(value.report.inference, 'UNVERIFIED'); assert.equal(value.report.apiKeyFallbackExcluded, 'UNVERIFIED');
});

test('response validation rejects missing or conflicting session and policy bindings', () => {
  for (const change of [{ model: 'different' }, { sandbox: { type: 'dangerFullAccess' } }, { sandbox: { type: 'readOnly', networkAccess: true } },
    { approvalPolicy: 'on-request' }, { thread: { ...thread('/tmp/example').thread, parentThreadId: 'parent' } }]) {
    assert.throws(() => validateThread({ ...thread('/tmp/example'), ...change }, '/tmp/example', 'fixture-model'));
  }
});

test('evidence rejects wrong identity, arbitrary tools, duplicates, missing results, false response and usage ambiguity', () => {
  const root = '/tmp/example';
  const mutations = [
    stream => stream[2].params.turnId = 'different',
    stream => stream[2].params.item.type = 'fileChange',
    stream => stream[1].params.item.command = 'cat fixture.txt; touch outside',
    stream => stream[2].params.item.aggregatedOutput = 'incorrect',
    stream => stream[2].params.item.exitCode = null,
    stream => stream[3].params.item.text = 'unverified response',
    stream => stream[4].params.tokenUsage.last.outputTokens = -1,
    stream => stream[4].params.tokenUsage.last.totalTokens = Number.MAX_SAFE_INTEGER + 1,
    stream => stream[5].params.turn.status = 'failed',
    stream => stream.splice(1, 1),
    stream => stream.splice(4, 1),
    stream => stream.splice(3, 0, clone(stream[2])),
  ];
  for (const mutate of mutations) {
    const evidence = new TurnEvidence(root), stream = events(root); mutate(stream);
    assert.throws(() => { evidence.bind('synthetic-thread', 'synthetic-turn'); stream.forEach(message => evidence.receive(message)); evidence.result(); });
  }
});

test('unknown warnings, live remote control, auth changes and unsupported notifications stop capture', () => {
  for (const message of [{ method: 'configWarning', params: { summary: 'configuration ignored' } },
    { method: 'remoteControl/status/changed', params: { status: 'enabled' } }, { method: 'account/updated', params: { authMode: 'apikey' } },
    { method: 'hook/started', params: {} }, { method: 'mcpServer/startupStatus/updated', params: {} }, { method: 'future/unknown', params: {} }]) {
    assert.throws(() => new TurnEvidence('/tmp/example').receive(message));
  }
});

test('unauthenticated preflight mode never reads an account, selects a model, creates a thread or starts inference', async context => {
  const value = await fixture(context); await value.run({ inference: false });
  assert.deepEqual(value.calls.map(call => call.method), ['config/read', 'configRequirements/read', 'command/exec']);
  assert.equal(value.report.modelTurnsSubmitted, 0); assert.equal(value.report.authentication, 'UNVERIFIED');
});

test('fixture loader rejects arbitrary roots and symlinked disposable roots before launching a process', async context => {
  await assert.rejects(loadFixture('/home/operator/.codex'), /INVALID_DISPOSABLE_ROOT/);
  const root = await fs.mkdtemp('/tmp/pab-auth-acceptance-'), linked = `${root}link`;
  context.after(async () => { await fs.rm(linked, { force: true }); await fs.rm(root, { recursive: true, force: true }); });
  await fs.symlink(root, linked);
  await assert.rejects(loadFixture(linked), /UNSAFE_DISPOSABLE_ROOT/);
});

const authUpdate = (params = { authMode: 'chatgpt', planType: 'pro' }) => ({ method: 'account/updated', params });

test('pre-inference auth notices are reconciled with two stable snapshots, configuration and fresh file checks', async context => {
  const value = await fixture(context, {
    initialize: ({ evidence }) => evidence.receive(authUpdate()),
    'config/read': ({ root, evidence, calls }) => {
      if (calls.filter(call => call.method === 'config/read').length === 1) evidence.receive(authUpdate());
      return config(root);
    },
    'command/exec': ({ evidence }) => { evidence.receive(authUpdate()); return { exitCode: 0, stdout: 'PAB_BOUNDARY_OK\n', stderr: '' }; },
    'account/read': ({ evidence, calls, params }) => {
      assert.deepEqual(params, { refreshToken: false });
      if (calls.filter(call => call.method === 'account/read').length <= 2) evidence.receive(authUpdate());
      return account();
    },
  });
  let fileChecks = 0;
  const result = await value.run({ validateFiles: async () => { fileChecks++; } });
  assert.equal(result.inference, 'VERIFIED'); assert.equal(fileChecks, 5);
  assert.deepEqual(result.notificationDiagnostics, ['initialization', 'configuration', 'boundary', 'authentication', 'authentication']
    .map(phase => ({ category: 'account_updated', phase })));
  assert.equal(value.calls.filter(call => call.method === 'turn/start').length, 1);
});

test('read-only diagnostic never invokes models, commands, threads, claims or ledgers, including with inference flag set', async context => {
  const value = await fixture(context, { 'account/read': ({ evidence }) => { evidence.receive(authUpdate()); return account(); } });
  await fs.writeFile(path.join(value.root, 'attempt.claim'), 'uncertain prior attempt');
  const result = await value.run({ diagnostic: true,
    claim: () => assert.fail('claim forbidden'), ledger: new Proxy({}, { get: () => assert.fail('ledger forbidden') }) });
  assert.deepEqual(value.calls.map(call => call.method), ['config/read', 'configRequirements/read', 'account/read', 'account/read', 'config/read', 'configRequirements/read']);
  assert.equal(await fs.readFile(path.join(value.root, 'attempt.claim'), 'utf8'), 'uncertain prior attempt');
  assert.equal(result.authentication, 'VERIFIED'); assert.equal(result.modelTurnsSubmitted, 0);
  for (const key of ['inference', 'subscriptionUsageAttribution', 'apiKeyFallbackExcluded', 'modelCommand', 'standaloneBoundary']) assert.equal(result[key], 'UNVERIFIED');
  assert.equal(result.nextSandboxStage, 'BLOCKED'); assert.equal(result.migrationReady, false);
});

test('missing, changed or unqualified auth cannot be reconciled before inference', async context => {
  for (const response of [{ account: null, requiresOpenaiAuth: true }, { ...account(), account: { type: 'apiKey' } },
    { ...account(), account: { ...account().account, email: 'different@example.invalid' } }]) {
    const value = await fixture(context, { 'account/read': ({ evidence, calls }) => {
      evidence.receive(authUpdate()); return calls.filter(call => call.method === 'account/read').length === 1 ? account() : response;
    } });
    await assert.rejects(value.run());
    assert(!value.calls.some(call => ['model/list', 'thread/start', 'turn/start'].includes(call.method)));
    assert.equal(value.report.authentication, 'UNVERIFIED');
  }
});

test('auth notice must exactly match the supported mode and reconciled plan; malformed and transient changes fail closed', async context => {
  for (const params of [null, {}, { authMode: 'apikey', planType: 'pro' }, { authMode: null, planType: null },
    { authMode: 'chatgptAuthTokens', planType: 'pro' }, { authMode: 'chatgpt', planType: 'free' },
    { authMode: 'chatgpt', planType: 'plus' }, { authMode: 'chatgpt', planType: 'pro', unexpected: 'private-sentinel' }]) {
    const value = await fixture(context, { 'account/read': ({ evidence }) => { evidence.receive(authUpdate(params)); return account(); } });
    await assert.rejects(value.run());
    assert.equal(value.report.authentication, 'UNVERIFIED'); assert.equal(value.report.modelTurnsSubmitted, 0);
    assert(!JSON.stringify(value.report).includes('private-sentinel'));
  }
});

test('file or transport uncertainty during reconciliation never qualifies authentication or retries', async context => {
  for (const reason of ['file', 'transport', 'read-failed']) {
    const value = await fixture(context, { 'account/read': ({ evidence, rpc, calls }) => {
      evidence.receive(authUpdate());
      if (calls.filter(call => call.method === 'account/read').length === 2) {
        if (reason === 'transport') rpc.failure = Error('private transport failure');
        if (reason === 'read-failed') throw Error('private response failure');
      }
      return account();
    } });
    let checks = 0;
    await assert.rejects(value.run({ diagnostic: true, validateFiles: async () => {
      if (++checks === 3 && reason === 'file') throw Error('private credential mutation');
    } }));
    assert.equal(value.report.authentication, 'UNVERIFIED'); assert.equal(value.report.modelTurnsSubmitted, 0);
    assert.equal(value.calls.filter(call => call.method === 'account/read').length, 2);
    assert(!JSON.stringify(value.report).includes('private'));
  }
});

test('every post-reconciliation account notice invalidates active, completed and shutdown results even for the same mode/plan', () => {
  for (const phase of ['model_selection', 'thread_creation', 'pre_inference', 'inference', 'post_inference', 'complete', 'shutdown']) {
    const report = newReport(), evidence = new TurnEvidence('/tmp/example', report);
    for (const key of ['authentication', 'inference', 'identityBinding', 'apiKeyFallbackExcluded', 'modelCommand']) report[key] = 'VERIFIED';
    evidence.notifications.setPhase(phase);
    assert.throws(() => evidence.receive(authUpdate()), /RUNTIME_UNCERTAINTY/);
    assert.deepEqual(report.notificationDiagnostics, [{ category: 'account_updated', phase }]);
    for (const key of ['authentication', 'inference', 'identityBinding', 'apiKeyFallbackExcluded', 'modelCommand']) assert.equal(report[key], 'UNVERIFIED');
    assert.equal(report.outcome, 'BLOCKED');
    assert.throws(() => evidence.notifications.check(), /RUNTIME_UNCERTAINTY/);
  }
});

test('runtime errors and every hook/MCP prefix retain fail-closed category/phase diagnostics without payloads', async context => {
  for (const [method, category] of [['error', 'runtime_error'], ['hook/started', 'hook_activity'], ['hook/completed', 'hook_activity'],
    ['hook/future-private-name', 'hook_activity'], ['mcpServer/startupStatus/updated', 'mcp_activity'], ['mcpServer/future-private-name', 'mcp_activity']]) {
    const value = await fixture(context, { 'account/read': ({ evidence }) => {
      evidence.receive({ method, params: { error: 'private-error', token: 'private-token', account: 'private-account' } }); return account();
    } });
    await assert.rejects(value.run(), /RUNTIME_UNCERTAINTY/);
    assert.deepEqual(value.report.notificationDiagnostics, [{ category, phase: 'authentication' }]);
    assert.equal(value.report.configuration, 'VERIFIED'); assert.equal(value.report.standaloneBoundary, 'VERIFIED');
    assert.equal(value.report.authentication, 'UNVERIFIED'); assert.equal(value.report.modelTurnsSubmitted, 0);
    assert(!JSON.stringify(value.report).includes('private'));
  }
});

test('notification storage is bounded and diagnostics never retain arbitrary method names or params', () => {
  const report = newReport(), evidence = new TurnEvidence('/tmp/example', report);
  for (let count = 0; count < 32; count++) evidence.receive({ method: 'remoteControl/status/changed', params: { status: 'disabled', environmentId: null, hostName: 'private-host' } });
  assert.throws(() => evidence.receive({ method: 'remoteControl/status/changed', params: {} }), /NOTIFICATION_DIAGNOSTICS_LIMIT/);
  assert.equal(report.notificationDiagnostics.length, 32); assert(!JSON.stringify(report).includes('private-host'));
  const unknown = newReport();
  assert.throws(() => new TurnEvidence('/tmp/example', unknown).receive({ method: 'private-method-secret', params: 'private-payload' }), /UNSUPPORTED_NOTIFICATION/);
  assert.deepEqual(unknown.notificationDiagnostics, [{ category: 'unsupported_notification', phase: 'initialization' }]);
});

test('pre-inference notification flooding is bounded without extending the reconciliation window', async context => {
  const value = await fixture(context, { 'account/read': ({ evidence }) => {
    for (let count = 0; count < 9; count++) evidence.receive(authUpdate()); return account();
  } });
  await assert.rejects(value.run({ diagnostic: true }), /AUTH_NOTIFICATION_LIMIT/);
  assert.equal(value.report.notificationDiagnostics.length, 9); assert.equal(value.report.authentication, 'UNVERIFIED');
  assert.equal(value.calls.filter(call => call.method === 'account/read').length, 1);
});

test('diagnostic rejects unsolicited model activity without creating a thread', async context => {
  const value = await fixture(context, { initialize: ({ evidence }) => evidence.receive({ method: 'thread/started', params: { thread: 'private-thread' } }) });
  await assert.rejects(value.run({ diagnostic: true }), /DIAGNOSTIC_MODEL_ACTIVITY/);
  assert.equal(value.calls.length, 0);
  assert.deepEqual(value.report.notificationDiagnostics, [{ category: 'model_activity', phase: 'initialization' }]);
});

test('diagnostic outer sandbox denies synthetic auth/claim/root writes and networking without reading operator state', async context => {
  const root = await fs.mkdtemp('/tmp/pab-auth-diagnostic-unit-');
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const name of ['home', 'codex', 'scratch']) await fs.mkdir(path.join(root, name), { mode: 0o700 });
  const files = ['codex/auth.json', 'inference.claim', 'acceptance.sqlite'];
  for (const name of files) await fs.writeFile(path.join(root, name), 'synthetic-unchanged', { mode: 0o600 });
  const runtime = await fs.realpath(process.env.CODEX_BINARY || path.join(homedir(), '.local/bin/codex'));
  const launcher = await diagnosticLauncher({ root, binary: runtime });
  context.after(() => launcher.close());
  const program = `import os,socket,errno\nfor name in ${JSON.stringify(files)}:\n target=${JSON.stringify(root)}+'/'+name\n assert open(target).read()=='synthetic-unchanged'\n for operation in [lambda:os.open(target,os.O_WRONLY),lambda:os.truncate(target,0),lambda:os.unlink(target)]:\n  try: operation()\n  except OSError as error: assert error.errno in [errno.EACCES,errno.EPERM,errno.EROFS]\n  else: raise RuntimeError('write allowed')\ntry: open(${JSON.stringify(path.join(root, 'new-file'))},'w')\nexcept OSError: pass\nelse: raise RuntimeError('create allowed')\ntry: socket.socket().connect(('127.0.0.1',9))\nexcept OSError as error: assert error.errno in [errno.EACCES,errno.EPERM]\nelse: raise RuntimeError('network allowed')\nprint('SYNTHETIC_READ_ONLY_OK')`;
  const checked = await launcher.runCheck(program);
  assert.equal(checked.stdout, 'SYNTHETIC_READ_ONLY_OK\n');
  for (const name of files) assert.equal(await fs.readFile(path.join(root, name), 'utf8'), 'synthetic-unchanged');
});

test('pinned diagnostic CLI fails closed on read-only startup and preserves a wholly synthetic root and uncertain claim', async context => {
  const runtime = await fs.realpath(process.env.CODEX_BINARY || path.join(homedir(), '.local/bin/codex'));
  const root = await prepare(runtime);
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const script = path.resolve('feasibility/local-codex/authenticated-acceptance.mjs');
  await promisify(execFile)(process.execPath, [script, 'preflight', root], { timeout: 25000, maxBuffer: 16384 });
  const claims = { email: 'synthetic@example.invalid', 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account', chatgpt_plan_type: 'free' } };
  const token = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.synthetic`;
  const auth = { auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { access_token: 'synthetic', refresh_token: 'synthetic', id_token: token, account_id: 'synthetic-account' } };
  await fs.writeFile(path.join(root, 'codex', 'auth.json'), JSON.stringify(auth), { mode: 0o600 });
  await fs.writeFile(path.join(root, 'operator-login.json'), JSON.stringify({ source: 'fresh-device-login', binding: validateAuthFile(auth) }), { mode: 0o600 });
  await fs.writeFile(path.join(root, 'inference.claim'), 'uncertain synthetic attempt', { mode: 0o600 });
  await fs.writeFile(path.join(root, 'codex', 'installation_id'), '00000000-0000-4000-8000-000000000000', { mode: 0o600 });
  const snapshot = async () => {
    const names = (await fs.readdir(root, { recursive: true })).sort(), result = [];
    for (const name of names) {
      const stat = await fs.lstat(path.join(root, name));
      result.push([name, stat.mode, stat.isFile() ? createHash('sha256').update(await fs.readFile(path.join(root, name))).digest('hex') : null]);
    }
    return result;
  };
  const before = await snapshot();
  let stdout;
  try {
    ({ stdout } = await promisify(execFile)(process.execPath, [script, 'diagnose-auth', root], { timeout: 25000, maxBuffer: 16384 }));
    assert.fail('synthetic invalid authentication cannot qualify');
  } catch (error) { assert.equal(error.code, 1); stdout = error.stdout; }
  const report = JSON.parse(stdout);
  assert.equal(report.configuration, 'UNVERIFIED'); assert.equal(report.authentication, 'UNVERIFIED');
  assert.equal(report.blocker, 'APP_SERVER_DISCONNECTED'); assert.equal(report.blockerPhase, 'initialization');
  assert.deepEqual(report.notificationDiagnostics, []);
  assert.equal(report.modelTurnsSubmitted, 0); assert.equal(report.nextSandboxStage, 'BLOCKED');
  assert.deepEqual(await snapshot(), before);
  assert(!stdout.includes('synthetic-account')); assert(!stdout.includes(token)); assert(!stdout.includes(root));
});

test('unrecognized raw errors, including uppercase messages, never become published blocker text', async context => {
  const value = await fixture(context, { 'account/read': () => { throw Object.assign(Error('PRIVATE_ACCOUNT_SECRET'), { code: 'PRIVATE_TOKEN_SECRET' }); } });
  await assert.rejects(value.run({ diagnostic: true }), /ACCEPTANCE_UNCERTAIN/);
  assert.equal(value.report.blocker, 'ACCEPTANCE_UNCERTAIN'); assert.equal(value.report.blockerPhase, 'authentication');
  assert(!JSON.stringify(value.report).includes('PRIVATE_'));
});
