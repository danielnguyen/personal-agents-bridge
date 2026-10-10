import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SessionLedger } from '../feasibility/local-codex/state.mjs';
import { configuration, environment, validateConfiguration, accountBinding, validateAuthFile, validateThread,
  newReport, TurnEvidence, runProtocol, loadFixture, PROFILE, FIXTURE, RESPONSE } from '../feasibility/local-codex/authenticated-acceptance.mjs';

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
  const ledger = new SessionLedger(path.join(root, 'ledger.sqlite')), report = newReport(), evidence = new TurnEvidence(root), calls = [];
  context.after(async () => { ledger.close(); await fs.rm(root, { recursive: true, force: true }); });
  const rpc = { failure: null, initialize: async () => ({ codexHome: path.join(root, 'codex'), platformOs: 'linux' }),
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
    const result = account(); if (calls.filter(call => call.method === 'account/read').length === 3) result.account.email = 'other@example.invalid'; return result;
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
