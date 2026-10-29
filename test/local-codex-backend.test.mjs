import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { LocalCodexBackend, childEnvironment, APPROVAL_LIMITATION } from '../local-codex-backend.mjs';
import { createLocalEvidence, observeLocalEvidence } from '../local-evidence.mjs';

const account = () => ({ account: { type: 'chatgpt', email: 'fixture@example.invalid', planType: 'pro' }, requiresOpenaiAuth: true });
const configuration = () => ({ model: 'gpt-6.1-sol', model_provider: 'openai', model_providers: {}, chatgpt_base_url: 'https://chatgpt.com/backend-api/',
  sandbox_mode: 'workspace-write', sandbox_workspace_write: { network_access: false }, approval_policy: 'on-request', approvals_reviewer: 'user',
  shell_environment_policy: { inherit: 'none', set: { PATH: '/usr/local/bin:/usr/bin:/bin' } },
  web_search: 'disabled', features: { apps: false, plugins: false, hooks: false, multi_agent: false, remote_control: false, api_key_model_discovery: false } });
const model = (name = 'gpt-6-astra', isDefault = true) => ({ id: name, model: name, hidden: false, isDefault });

async function fixture(context, overrides = {}, options = {}) {
  const cwd = await mkdtemp('/tmp/pab-local-backend-test-');
  const requests = [], replies = [], launches = [];
  let child, turnCount = 0;
  const send = message => child.stdout.write(JSON.stringify(message) + '\n');
  const event = (method, params) => send({ method, params });
  const complete = (status = 'completed', turnId = `turn-${turnCount}`) => event('turn/completed', { threadId: 'thread-fixture', turn: { id: turnId, status } });
  const items = (change = {}) => {
    const binding = { threadId: 'thread-fixture', turnId: `turn-${turnCount}` };
    const item = { id: `command-${turnCount}`, type: 'commandExecution', command: 'python3 -B check.py', cwd, status: 'inProgress' };
    event('item/started', { ...binding, item });
    event('item/completed', { ...binding, item: { ...item, status: 'completed', exitCode: 0, aggregatedOutput: 'ok\n', ...change } });
    event('item/completed', { ...binding, item: { id: 'answer', type: 'agentMessage', text: 'Tests passed.' } });
  };
  const spawnProcess = (binary, args, config) => {
    launches.push({ binary, args, config });
    child = new EventEmitter(); child.stdout = new PassThrough();
    child.kill = () => { if (!child.dead) { child.dead = true; queueMicrotask(() => child.emit('close', 0)); } };
    child.stdin = new Writable({ write(chunk, encoding, callback) {
      const message = JSON.parse(String(chunk));
      if (!message.method) { replies.push(message); overrides.reply?.({ message, event, complete }); callback(); return; }
      if (message.id === undefined) { callback(); return; }
      requests.push(message);
      queueMicrotask(async () => {
        const { method, params, id } = message;
        const handlers = {
          initialize: () => ({ codexHome: config.env.CODEX_HOME }),
          'config/read': () => ({ config: configuration() }),
          'account/read': account,
          'model/list': () => ({ data: [model(), model('gpt-6-sol', false)], nextCursor: null }),
          'thread/read': () => ({ thread: { id: 'thread-fixture', model: 'gpt-6-astra' } }),
          'thread/start': () => ({ thread: { id: 'thread-fixture', turns: [] }, model: 'gpt-6-astra', cwd, modelProvider: 'openai', approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'workspaceWrite', networkAccess: false } }),
          'thread/resume': () => handlers['thread/start'](),
          'turn/start': () => {
            turnCount++;
            setImmediate(() => { items(); complete(); });
            return { turn: { id: `turn-${turnCount}`, status: 'inProgress' } };
          },
          'turn/interrupt': () => { complete('interrupted'); return {}; },
        };
        const handler = overrides[method] || handlers[method];
        try {
          const value = await handler({ params, event, send, complete, items, child, requests, cwd, defaults: handlers,
            nextTurn: () => ++turnCount });
          if (value !== undefined) send({ id, result: value });
        } catch { send({ id, error: { code: -32000, message: 'synthetic error' } }); }
      });
      callback();
    } });
    return child;
  };
  const backend = new LocalCodexBackend({ cwd, env: { HOME: '/tmp/synthetic-home', PATH: '/usr/bin:/bin', OPENAI_API_KEY: 'never-forward' },
    spawnProcess, timeoutMs: 5000, ...options });
  context.after(async () => { await backend.close(); await rm(cwd, { recursive: true, force: true }); });
  return { backend, requests, replies, launches, event, complete, items, run: changes => backend.run({ prompt: 'Update the fixture.', allowedFiles: ['fixture.py'], ...changes }) };
}

test('explicit environment excludes API keys, tokens, provider/proxy overrides and nested configuration', () => {
  const env = childEnvironment({ HOME: '/tmp/home', PATH: '/usr/bin', OPENAI_API_KEY: 'private', CODEX_API_KEY: 'private',
    OPENAI_BASE_URL: 'private', CODEX_ACCESS_TOKEN: 'private', HTTPS_PROXY: 'private', AWS_SECRET_ACCESS_KEY: 'private', NODE_OPTIONS: 'private' });
  assert.deepEqual(Object.keys(env).sort(), ['CODEX_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'HOME', 'LANG', 'PATH']);
  assert(!JSON.stringify(env).includes('private'));
  assert.equal(env.CODEX_HOME, '/tmp/home/.codex');
});

test('protected paths and traversal are rejected before any task RPC, including when already connected', async context => {
  const paths = ['TASK.md', 'nested/TASK.md', '.codex', '.codex/config.toml', '.codex/nested/policy',
    'nested/.codex/config.toml', '.git', '.git/config', 'nested/.git/config', '../fixture.py',
    'src/../TASK.md', './fixture.py', '/tmp/fixture.py', 'src//fixture.py', 'src\\fixture.py'];
  for (const connected of [false, true]) {
    const value = await fixture(context);
    if (connected) await value.backend.connect();
    const initialRequests = value.requests.slice();
    for (const file of paths) {
      for (const threadId of [undefined, 'thread-fixture']) {
        await assert.rejects(value.run({ allowedFiles: ['fixture.py', file], threadId }), { code: 'INVALID_TASK_SCOPE' });
      }
    }
    assert.deepEqual(value.requests, initialRequests);
    assert.equal(value.launches.length, connected ? 1 : 0);
    assert(!value.requests.some(request => request.method.startsWith('thread/') || request.method.startsWith('turn/')));
  }
});

test('ordinary file scopes and non-protected lookalike names remain accepted', async context => {
  const value = await fixture(context);
  const result = await value.run({ allowedFiles: ['fixture.py', 'src/file.mjs', 'TASK.md.example', '.codex-example/config.toml', '.gitignore'] });
  assert.equal(result.status, 'completed');
  assert.equal(value.requests.filter(request => request.method === 'thread/start').length, 1);
  assert.equal(value.requests.filter(request => request.method === 'turn/start').length, 1);
});

async function reviewFixture(context, overrides = {}, options = {}) {
  return fixture(context, {
    'config/read': () => ({ config: { ...configuration(), sandbox_mode: 'read-only' } }),
    'thread/start': ({ defaults }) => ({ ...defaults['thread/start'](), sandbox: { type: 'readOnly', networkAccess: false } }),
    ...overrides,
  }, { reviewOnly: true, ...options });
}

test('review-only adapter requests fresh read-only thread and network-denied turn with unchanged authentication/model checks', async context => {
  const value = await reviewFixture(context), result = await value.run({ allowedFiles: [] });
  assert.equal(result.status, 'completed'); assert.equal(result.authentication, 'chatgpt'); assert.equal(result.model, 'gpt-6-astra');
  const start = value.requests.find(request => request.method === 'thread/start');
  const turn = value.requests.find(request => request.method === 'turn/start');
  assert.equal(start.params.sandbox, 'read-only'); assert.match(start.params.developerInstructions, /Read evidence.json only/);
  assert.deepEqual(turn.params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert(value.launches[0].args.includes('sandbox_mode="read-only"'));
  assert(!value.requests.some(request => request.method === 'thread/resume'));
  assert.equal(value.launches[0].config.env.OPENAI_API_KEY, undefined);
});

test('review-only adapter rejects writable scope, resume, incompatible policy and preexisting thread history', async context => {
  const value = await reviewFixture(context);
  await assert.rejects(value.run(), /INVALID_REVIEW_SCOPE/);
  await assert.rejects(value.run({ allowedFiles: [], threadId: 'old-thread' }), /INVALID_REVIEW_SCOPE/);
  assert.equal(value.launches.length, 0);
  for (const overrides of [
    { 'config/read': () => ({ config: configuration() }) },
    { 'thread/start': ({ defaults }) => defaults['thread/start']() },
    { 'thread/start': ({ defaults }) => ({ ...defaults['thread/start'](), thread: { id: 'thread-fixture', turns: [{ id: 'old', status: 'completed' }] }, sandbox: { type: 'readOnly', networkAccess: false } }) },
    { 'thread/start': ({ defaults }) => ({ ...defaults['thread/start'](), sandbox: { type: 'readOnly', networkAccess: true } }) },
  ]) {
    const rejected = await reviewFixture(context, overrides), result = await rejected.run({ allowedFiles: [] });
    assert.equal(result.status, 'failed'); assert(!rejected.requests.some(request => request.method === 'turn/start'));
  }
});

test('review-only adapter cannot grant native approval even with an accepting caller callback', async context => {
  let approvals = 0;
  const value = await reviewFixture(context, {
    'turn/start': ({ send, nextTurn }) => {
      nextTurn(); setImmediate(() => send({ id: 93, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-fixture', turnId: 'turn-1', itemId: 'command' } }));
      return { turn: { id: 'turn-1', status: 'inProgress' } };
    },
  }, { onApproval: () => { approvals++; return 'accept'; }, deferHumanRequests: true });
  const result = await value.run({ allowedFiles: [] });
  assert.equal(approvals, 0); assert.notEqual(result.status, 'completed');
  assert(value.replies.some(reply => reply.id === 93 && reply.error));
  assert(!value.replies.some(reply => reply.result?.decision === 'accept'));
});

for (const [label, turns] of [['missing', undefined], ['null', null], ['object', {}], ['completed', [{ id: 'old', status: 'completed' }]], ['active', [{ id: 'old', status: 'inProgress' }]]])
test(`fresh native execution rejects ${label} thread history before turn submission`, async context => {
  const value = await fixture(context, { 'thread/start': ({ defaults }) => {
    const started = defaults['thread/start']();
    if (turns === undefined) delete started.thread.turns; else started.thread.turns = turns;
    return started;
  } }, { requireFreshThread: true });
  const result = await value.run();
  assert.equal(result.status, 'failed'); assert.equal(result.turnSubmissionAttempted, false);
  assert.equal(value.requests.filter(request => request.method === 'thread/start').length, 1);
  assert(!value.requests.some(request => ['turn/start', 'thread/resume'].includes(request.method)));
});

test('fresh native execution requires an empty thread/start acknowledgment and rejects resume before RPC', async context => {
  const value = await fixture(context, {}, { requireFreshThread: true });
  await assert.rejects(value.run({ threadId: 'existing-thread' }), { code: 'FRESH_THREAD_REQUIRED' });
  assert.equal(value.requests.length, 0);
  const result = await value.run();
  assert.equal(result.status, 'completed'); assert.equal(result.authentication, 'chatgpt');
  const before = value.requests.length;
  await assert.rejects(value.run({ threadId: result.threadId }), { code: 'FRESH_THREAD_REQUIRED' });
  assert.equal(value.requests.length, before);
  assert.equal(value.requests.filter(request => request.method === 'turn/start').length, 1);
  assert(!value.requests.some(request => request.method === 'thread/resume'));
});

test('start and resume use the same thread, ordinary sandbox and structured command provenance', async context => {
  const progress = [];
  const value = await fixture(context, {}, { onProgress: message => progress.push(message.method) });
  const first = await value.run(), second = await value.run({ threadId: first.threadId });
  for (const result of [first, second]) {
    assert.equal(result.status, 'completed'); assert.equal(result.terminalObserved, true);
    assert.equal(result.authentication, 'chatgpt'); assert.equal(result.subscriptionUsageAttribution, 'unverified');
    assert.equal(result.commands[0].provenance, 'codex_app_server_item');
    assert.equal(result.commands[0].exitCode, 0); assert.equal(result.commands[0].output, 'ok\n');
    assert.deepEqual(result.commands[0].missing, []); assert.equal(result.commands[0].outputCompleteness, 'unverified');
    assert.equal(result.messages[0].provenance, 'model');
    assert(!JSON.stringify(result).includes('fixture@example.invalid'));
  }
  assert.equal(value.launches.length, 1);
  const resume = value.requests.find(request => request.method === 'thread/resume');
  assert.equal(resume.params.threadId, first.threadId);
  assert.match(resume.params.developerInstructions, /Never commit, push, merge, deploy/);
  assert.match(resume.params.developerInstructions, /LAN\/Tailscale/);
  for (const request of value.requests.filter(request => request.method === 'turn/start')) {
    assert.deepEqual(request.params.input, [{ type: 'text', text: 'Update the fixture.', text_elements: [] }]);
    assert.equal(request.params.sandboxPolicy.networkAccess, false);
    assert.equal(request.params.approvalPolicy, 'on-request'); assert.equal(request.params.approvalsReviewer, 'user');
  }
  assert(value.launches[0].args.includes('model_provider="openai"'));
  assert(!value.launches[0].args.some(argument => argument.includes('forced_login_method')));
  assert(progress.includes('item/completed'));
});

test('preflight accepts ChatGPT but rejects missing, API-key, unsupported-plan and ambiguous authentication before threads', async context => {
  for (const response of [{ account: null }, { account: { type: 'apiKey' }, requiresOpenaiAuth: true },
    { ...account(), requiresOpenaiAuth: false }, { ...account(), account: { ...account().account, planType: 'free' } },
    { ...account(), account: { ...account().account, email: null } }]) {
    const value = await fixture(context, { 'account/read': () => response });
    await assert.rejects(value.backend.connect(), /AUTHENTICATION_REQUIRED|SUBSCRIPTION_PLAN_UNVERIFIED/);
    assert(!value.requests.some(request => request.method.startsWith('thread/') || request.method.startsWith('turn/')));
  }
});

test('custom providers, API routes, networking, automatic review and enabled integrations fail preflight', async context => {
  for (const mutate of [config => config.model_provider = 'custom', config => config.model_providers = { openai: { env_key: 'KEY' } },
    config => config.openai_base_url = 'https://example.invalid', config => config.chatgpt_base_url = 'https://example.invalid',
    config => config.forced_login_method = 'api', config => config.sandbox_workspace_write.network_access = true,
    config => config.approvals_reviewer = 'auto_review', config => config.approval_policy = 'never',
    config => config.shell_environment_policy.set.OPENAI_API_KEY = 'synthetic-never-forward',
    config => config.features.apps = true, config => config.mcp_servers = { server: { enabled: true } }]) {
    const value = await fixture(context, { 'config/read': () => { const config = configuration(); mutate(config); return { config }; } });
    await assert.rejects(value.backend.connect());
    assert(!value.requests.some(request => request.method === 'turn/start'));
  }
});

test('a changed account or resumed policy is rejected without inference', async context => {
  let reads = 0;
  const changed = await fixture(context, { 'account/read': () => ++reads === 1 ? account() : { ...account(), account: { ...account().account, email: 'changed@example.invalid' } } });
  assert.equal((await changed.run()).status, 'failed');
  assert(!changed.requests.some(request => request.method === 'turn/start'));
  for (const override of [{ modelProvider: 'custom' }, { sandbox: { type: 'dangerFullAccess' } }, { thread: { id: 'wrong' } },
    { thread: { id: 'thread-fixture', turns: [{ status: 'inProgress' }] } }]) {
    const value = await fixture(context, { 'thread/resume': ({ defaults }) => ({ ...defaults['thread/start'](), ...override }) });
    assert.equal((await value.run({ threadId: 'thread-fixture' })).status, 'failed');
    assert(!value.requests.some(request => request.method === 'turn/start'));
  }
});

test('failed turns and nonzero commands are distinct from successful completion', async context => {
  const value = await fixture(context, { 'turn/start': ({ nextTurn, items, complete }) => {
    nextTurn(); setImmediate(() => { items({ exitCode: 1, status: 'failed' }); complete('failed'); });
    return { turn: { id: 'turn-1' } };
  } });
  const result = await value.run(); assert.equal(result.status, 'failed'); assert.equal(result.terminalObserved, true);
  assert.equal(result.commands[0].exitCode, 1);
});

test('global thread status for another thread does not abort the active turn', async context => {
  const progress = [], lifecycle = [];
  const value = await fixture(context, { 'turn/start': ({ nextTurn, event, items, complete }) => {
    nextTurn();
    setImmediate(() => {
      event('thread/status/changed', { threadId: 'unrelated-thread', status: { type: 'idle' } });
      items(); complete();
    });
    return { turn: { id: 'turn-1' } };
  } }, { onProgress: event => { progress.push(event); }, onLifecycle: event => { lifecycle.push(event); } });
  const result = await value.run();
  assert.equal(result.status, 'completed', JSON.stringify({ status: result.status, terminalObserved: result.terminalObserved, diagnostics: result.uncertainties }));
  assert.equal(result.terminalObserved, true); assert.equal(result.turnId, 'turn-1');
  assert.equal(result.commands.length, 1); assert.deepEqual(result.messages, [{ provenance: 'model', text: 'Tests passed.' }]);
  assert(!JSON.stringify(progress).includes('unrelated-thread'));
  assert(!JSON.stringify(lifecycle).includes('unrelated-thread'));
  assert.equal(value.requests.filter(request => request.method === 'turn/start').length, 1);
  assert(!value.requests.some(request => request.method === 'turn/interrupt'));
});

test('global thread status routes only validated metadata before and after acknowledgement', async context => {
  const statuses = [{ type: 'notLoaded' }, { type: 'idle' }, { type: 'systemError' },
    { type: 'active', activeFlags: [] }, { type: 'active', activeFlags: ['waitingOnApproval'] },
    { type: 'active', activeFlags: ['waitingOnUserInput'] }, { type: 'active', activeFlags: ['waitingOnApproval', 'waitingOnUserInput'] }];
  for (const early of [false, true]) for (const foreign of [false, true]) for (const status of statuses)
    await context.test(JSON.stringify({ early, foreign, status }), async t => {
      const progress = [], lifecycle = [];
      const value = await fixture(t, { 'turn/start': ({ nextTurn, send, items, complete }) => {
        nextTurn();
        const emit = () => { send({ method: 'thread/status/changed', emittedAtMs: 123,
          params: { threadId: foreign ? 'unrelated-thread' : 'thread-fixture', status } }); items(); complete(); };
        if (early) emit(); else setImmediate(emit);
        return { turn: { id: 'turn-1' } };
      } }, { onProgress: event => { progress.push(event); }, onLifecycle: event => { lifecycle.push(event); },
        onApproval: () => assert.fail('Metadata cannot authorize approval'), onQuestion: () => assert.fail('Metadata cannot request human input') });
      const result = await value.run();
      assert.equal(result.status, 'completed'); assert.equal(result.terminalObserved, true);
      assert.equal(result.commands.length, 1); assert.equal(result.messages.length, 1); assert.deepEqual(result.files, []); assert.equal(result.usage, undefined);
      assert.equal(progress.filter(event => event.method === 'thread/status/changed').length, foreign ? 0 : 1);
      assert(!JSON.stringify(progress).includes('unrelated-thread')); assert(!JSON.stringify(lifecycle).includes('unrelated-thread'));
      assert.equal(value.replies.length, 0); assert.equal(value.requests.filter(request => request.method === 'turn/start').length, 1);
    });
});

test('global thread status exception never admits foreign execution, terminal or authority events', async context => {
  const binding = { threadId: 'foreign-thread', turnId: 'turn-1' };
  const cases = [
    { method: 'turn/completed', params: { threadId: 'foreign-thread', turn: { id: 'turn-1', status: 'completed' } } },
    { method: 'turn/completed', params: { threadId: 'thread-fixture', turn: { id: 'foreign-turn', status: 'completed' } }, code: 'INVALID_TERMINAL_EVENT' },
    { method: 'turn/started', params: { threadId: 'foreign-thread', turn: { id: 'foreign-turn', status: 'inProgress' } } },
    { method: 'item/started', params: { ...binding, item: { id: 'foreign-command', type: 'commandExecution', command: 'FOREIGN_OUTPUT' } } },
    { method: 'item/completed', params: { ...binding, item: { id: 'foreign-command', type: 'commandExecution', command: 'FOREIGN_OUTPUT', exitCode: 0 } } },
    { method: 'item/completed', params: { ...binding, item: { id: 'foreign-file', type: 'fileChange', changes: ['FOREIGN_OUTPUT'] } } },
    { method: 'item/completed', params: { ...binding, item: { id: 'foreign-message', type: 'agentMessage', text: 'FOREIGN_OUTPUT' } } },
    ...['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput'].map(method => ({ id: 0, method, params: binding })),
    { method: 'serverRequest/resolved', params: { threadId: 'foreign-thread', requestId: 0 } },
    { method: 'thread/tokenUsage/updated', params: { ...binding, tokenUsage: { foreign: true } } },
    { method: 'unknown/notification', params: binding },
    { method: 'item/started', params: { threadId: 'thread-fixture', turnId: 'foreign-turn', item: { id: 'foreign-command' } }, code: 'EVENT_TURN_MISMATCH' },
    { method: 'account/updated', params: { authMode: 'apikey' }, code: 'CHATGPT_AUTHENTICATION_CHANGED' },
  ];
  for (const [index, message] of cases.entries()) await context.test(String(index) + ' ' + message.method, async t => {
    const { code = 'EVENT_THREAD_MISMATCH', ...wire } = message, progress = [], lifecycle = [];
    const value = await fixture(t, { 'turn/start': ({ nextTurn, event, send, complete }) => {
      nextTurn(); setImmediate(() => {
        event('thread/status/changed', { threadId: 'unrelated-thread', status: { type: 'idle' } });
        send(wire); complete();
      }); return { turn: { id: 'turn-1' } };
    } }, { onProgress: event => { progress.push(event); }, onLifecycle: event => { lifecycle.push(event); },
      onApproval: () => assert.fail('Foreign approval'), onQuestion: () => assert.fail('Foreign human request') });
    const result = await value.run();
    assert.equal(result.status, 'uncertain'); assert.equal(result.terminalObserved, false); assert(result.uncertainties.includes(code));
    assert.deepEqual(result.commands, []); assert.deepEqual(result.files, []); assert.deepEqual(result.messages, []); assert.equal(result.usage, undefined);
    // The existing raw progress callback precedes nested terminal validation.
    // A same-thread/wrong-turn terminal is observable, but never retained as
    // execution evidence and never qualifies terminal completion or authority.
    assert.deepEqual(progress, code === 'INVALID_TERMINAL_EVENT' ? [wire] : []);
    const ledger = createLocalEvidence('synthetic-routing-task'), before = structuredClone(ledger);
    for (const event of progress) assert.equal(observeLocalEvidence(ledger, event,
      { thread_id: 'thread-fixture', turn_id: 'turn-1' }, text => text), false);
    assert.deepEqual(ledger, before);
    assert(!lifecycle.some(event => ['human_request', 'human_request_resolved', 'terminal_observed'].includes(event.phase)));
    assert.equal(value.replies.length, 0); assert.equal(value.requests.filter(request => request.method === 'turn/start').length, 1);
  });
});

// Literal wire frames: object construction/stringification would erase the defect.
test('raw duplicate JSON keys cannot enter the global thread status exception', async context => {
  const frames = [
    ['method', String.raw`{"method":"turn/completed","method":"thread/status/changed","params":{"threadId":"unrelated-thread","status":{"type":"idle"}}}`],
    ['escaped method', String.raw`{"method":"turn/completed","metho\u0064":"thread/status/changed","params":{"threadId":"unrelated-thread","status":{"type":"idle"}}}`],
    ['params', String.raw`{"method":"thread/status/changed","params":null,"params":{"threadId":"unrelated-thread","status":{"type":"idle"}}}`],
    ['escaped params', String.raw`{"method":"thread/status/changed","params":null,"param\u0073":{"threadId":"unrelated-thread","status":{"type":"idle"}}}`],
    ['threadId', String.raw`{"method":"thread/status/changed","params":{"threadId":"thread-fixture","threadId":"unrelated-thread","status":{"type":"idle"}}}`],
    ['escaped threadId', String.raw`{"method":"thread/status/changed","params":{"threadId":"thread-fixture","thread\u0049d":"unrelated-thread","status":{"type":"idle"}}}`],
    ['status', String.raw`{"method":"thread/status/changed","params":{"threadId":"unrelated-thread","status":{"type":"completed"},"status":{"type":"idle"}}}`],
    ['escaped status', String.raw`{"method":"thread/status/changed","params":{"threadId":"unrelated-thread","status":{"type":"completed"},"statu\u0073":{"type":"idle"}}}`],
    ['status.type', String.raw`{"method":"thread/status/changed","params":{"threadId":"unrelated-thread","status":{"type":"completed","type":"idle"}}}`],
    ['escaped status.type', String.raw`{"method":"thread/status/changed","params":{"threadId":"unrelated-thread","status":{"type":"completed","typ\u0065":"idle"}}}`],
    ['status.activeFlags', String.raw`{"method":"thread/status/changed","params":{"threadId":"unrelated-thread","status":{"type":"active","activeFlags":["unknown"],"activeFlags":[]}}}`],
    ['escaped status.activeFlags', String.raw`{"method":"thread/status/changed","params":{"threadId":"unrelated-thread","status":{"type":"active","activeFlags":["unknown"],"active\u0046lags":[]}}}`],
    ['emittedAtMs', String.raw`{"method":"thread/status/changed","emittedAtMs":null,"emittedAtMs":123,"params":{"threadId":"unrelated-thread","status":{"type":"idle"}}}`],
    ['escaped emittedAtMs', String.raw`{"method":"thread/status/changed","emittedAtMs":null,"emittedAtM\u0073":123,"params":{"threadId":"unrelated-thread","status":{"type":"idle"}}}`],
  ];
  assert.equal(frames.length, 14);
  for (const early of [true, false]) for (const [name, frame] of frames) await context.test(`${name}; early=${early}`, async t => {
    const progress = [], lifecycle = [];
    const value = await fixture(t, { 'turn/start': ({ nextTurn, child, items, complete }) => {
      nextTurn();
      const emit = () => { child.stdout.write(frame + '\n'); items(); complete(); };
      if (early) emit(); else setImmediate(emit);
      return { turn: { id: 'turn-1' } };
    } }, { onProgress: event => { progress.push(event); }, onLifecycle: event => { lifecycle.push(event); },
      onApproval: () => assert.fail('Ambiguous frame cannot approve'), onQuestion: () => assert.fail('Ambiguous frame cannot request input') });
    const result = await value.run();
    assert.equal(result.status, 'uncertain'); assert.equal(result.terminalObserved, false);
    assert(result.uncertainties.includes('CODEX_DUPLICATE_JSON_KEY'));
    assert.deepEqual(progress, []); assert.deepEqual(result.commands, []); assert.deepEqual(result.messages, []); assert.deepEqual(result.files, []);
    assert(!lifecycle.some(event => event.phase === 'terminal_observed' || event.phase === 'human_request'));
    assert.equal(value.replies.length, 0); assert.equal(value.requests.filter(request => request.method === 'turn/start').length, 1);
  });
});

test('raw admission rejects duplicate keys in active metadata and RPC responses too', async context => {
  const frames = [
    String.raw`{"method":"thread/status/changed","params":{"threadId":"thread-fixture","status":{"type":"idle","type":"idle"}}}`,
    String.raw`{"method":"thread/status/changed","params":{"threadId":"thread-fixture","status":{"typ\u0065":"idle","type":"idle"}}}`,
    String.raw`{"id":0,"id":REQUEST_ID,"result":{"turn":{"id":"turn-1"}}}`,
    String.raw`{"id":REQUEST_ID,"result":null,"result":{"turn":{"id":"turn-1"}}}`,
    String.raw`{"id":REQUEST_ID,"result":{"turn":{"id":"turn-1"},"extra":[{"key":1,"key":2}]}}`,
    String.raw`{"id":REQUEST_ID,"result":{"turn":{"id":"turn-1"},"extra":[{"__proto__":1,"\u005f_proto__":2}]}}`,
    String.raw`{"id":REQUEST_ID,"result":{"turn":{"id":"turn-1"},"extra":{"\ud83d\ude80":1,"🚀":2}}}`,
    String.raw`{"id":REQUEST_ID,"result":{"turn":{"id":"turn-1"},"extra":{"a\\b":1,"a\u005cb":2}}}`,
  ];
  for (const [index, frame] of frames.entries()) await context.test(String(index), async t => {
    const progress = [];
    const value = await fixture(t, { 'turn/start': ({ nextTurn, child, requests, complete }) => {
      nextTurn(); child.stdout.write(frame.replace('REQUEST_ID', requests.at(-1).id) + '\n'); complete();
      return undefined;
    } }, { onProgress: event => { progress.push(event); } });
    const result = await value.run();
    assert.equal(result.status, 'uncertain'); assert.equal(result.terminalObserved, false);
    assert(result.uncertainties.includes('CODEX_DUPLICATE_JSON_KEY')); assert.deepEqual(progress, []);
    assert.equal(value.requests.filter(request => request.method === 'turn/start').length, 1);
  });
});

test('raw admission preserves legal keys, strings, arrays, nesting and fragmented frames', async context => {
  const extra = String.raw`{"same":1,"Same":2,"__proto__":3,"constructor":4,"type":5,"typ\\u0065":6,"a\"b":7,"a\\b":8,"":9,"☃":10,"🚀":11,"array":[{"key":1},{"key":2},null,true,false,-2.5e+3,[],{}],"text":"{\"type\":1,\"type\":2}: [] \\ \" \b \f \n \r \t \u0061"}`;
  for (const fragmented of [false, true]) await context.test('fragmented=' + fragmented, async t => {
    const progress = [];
    const value = await fixture(t, { 'turn/start': ({ nextTurn, child, requests, items, complete }) => {
      nextTurn();
      const response = '{"id":' + requests.at(-1).id + ',"result":{"turn":{"id":"turn-1","status":"inProgress"},"extra":' + extra + ',"deep":' + '['.repeat(12000) + '0' + ']'.repeat(12000) + '}}\r\n';
      child.stdout.write(response);
      setImmediate(() => {
        const frames = String.raw`{"metho\u0064":"thread/status/changed","params":{"thread\u0049d":"unrelated-thread","status":{"typ\u0065":"active","activeFlags":["waitingOnApproval","waitingOnUserInput"]}},"emittedAtMs":123,"jsonrpc":"2.0"}` + '\n' +
          String.raw`{"method":"thread/status/changed","params":{"threadId":"thread-fixture","status":{"type":"idle"}}}` + '\n';
        if (fragmented) for (const character of frames) child.stdout.write(character);
        else child.stdout.write(frames);
        items(); complete();
      });
      return undefined;
    } }, { onProgress: event => { progress.push(event); } });
    const result = await value.run();
    assert.equal(result.status, 'completed'); assert.equal(result.terminalObserved, true);
    assert.equal(result.commands.length, 1); assert.equal(result.messages.length, 1);
    assert.equal(progress.filter(event => event.method === 'thread/status/changed').length, 1);
    assert(!JSON.stringify(progress).includes('unrelated-thread'));
  });
});

test('raw foreign execution, terminal, approval and human requests retain identity rejection', async context => {
  const frames = [
    String.raw`{"method":"item/completed","params":{"threadId":"foreign-thread","turnId":"turn-1","item":{"id":"foreign-command","type":"commandExecution","command":"FOREIGN_OUTPUT","status":"completed","exitCode":0}}}`,
    String.raw`{"method":"turn/completed","params":{"threadId":"foreign-thread","turn":{"id":"turn-1","status":"completed"}}}`,
    String.raw`{"id":0,"method":"item/commandExecution/requestApproval","params":{"threadId":"foreign-thread","turnId":"turn-1"}}`,
    String.raw`{"id":0,"method":"item/tool/requestUserInput","params":{"threadId":"foreign-thread","turnId":"turn-1"}}`,
  ];
  for (const early of [true, false]) for (const [index, frame] of frames.entries()) await context.test(`${index}; early=${early}`, async t => {
    const progress = [];
    const value = await fixture(t, { 'turn/start': ({ nextTurn, child, complete }) => {
      nextTurn(); const emit = () => { child.stdout.write(frame + '\n'); complete(); };
      if (early) emit(); else setImmediate(emit);
      return { turn: { id: 'turn-1' } };
    } }, { onProgress: event => { progress.push(event); },
      onApproval: () => assert.fail('Foreign approval'), onQuestion: () => assert.fail('Foreign human request') });
    const result = await value.run();
    assert.equal(result.status, 'uncertain'); assert.equal(result.terminalObserved, false);
    assert(result.uncertainties.includes('EVENT_THREAD_MISMATCH'));
    assert.deepEqual(result.commands, []); assert.deepEqual(result.messages, []); assert.deepEqual(result.files, []);
    assert.deepEqual(progress, []); assert.deepEqual(value.replies, []);
    assert.equal(value.requests.filter(request => request.method === 'turn/start').length, 1);
  });
});

test('raw malformed JSON remains rejected without dispatch or completion', async context => {
  const frames = [
    String.raw`{"method":"thread/status/changed","params":{"threadId":"unrelated-thread","status":{"type":"idle"}},}`,
    String.raw`{"method":"thread/status/changed","params":{"threadId":"unrelated-thread","status":{"type":"idle"}}`,
    String.raw`{"method":"thread/status/changed","params":{"threadId":"unrelated-thread","status":{"type":"idle\q"}}}`,
    String.raw`{"method":"thread/status/changed","params":{"threadId":"unrelated-thread","status":{"type":"idle\u00ZZ"}}}`,
    String.raw`{"method":"thread/status/changed","params":{"threadId":"unrelated-thread","status":{"type":"idle"}},"unterminated":"` + '\\',
    String.raw`{"method":"thread/status/changed","params":{"threadId":"unrelated-thread","status":{"type":"idle"}}} {}`,
  ];
  for (const [index, frame] of frames.entries()) await context.test(String(index), async t => {
    const progress = [];
    const value = await fixture(t, { 'turn/start': ({ nextTurn, child, complete }) => {
      nextTurn(); setImmediate(() => { child.stdout.write(frame + '\n'); complete(); }); return { turn: { id: 'turn-1' } };
    } }, { onProgress: event => { progress.push(event); } });
    const result = await value.run();
    assert.equal(result.status, 'uncertain'); assert.equal(result.terminalObserved, false);
    assert(result.uncertainties.includes('CODEX_PROTOCOL_ERROR')); assert.deepEqual(progress, []);
  });
});

test('raw admission preserves the existing complete and partial frame size limits', async context => {
  for (const terminated of [false, true]) await context.test('terminated=' + terminated, async t => {
    const value = await fixture(t, { 'turn/start': ({ nextTurn, child, complete }) => {
      nextTurn(); setImmediate(() => {
        child.stdout.write(' '.repeat(1024 * 1024 + 1) + (terminated ? '\n' : '')); complete();
      }); return { turn: { id: 'turn-1' } };
    } });
    const result = await value.run();
    assert.equal(result.status, 'uncertain'); assert.equal(result.terminalObserved, false);
    assert(result.uncertainties.includes('CODEX_FRAME_TOO_LARGE'));
  });
});

test('global thread status rejects malformed or ambiguous notifications', async context => {
  const valid = { threadId: 'unrelated-thread', status: { type: 'idle' } };
  const malformed = [null, [], {}, { status: valid.status }, { ...valid, threadId: '' }, { ...valid, threadId: 42 },
    { ...valid, threadId: ' padded ' }, { ...valid, threadId: 'x'.repeat(201) }, { ...valid, status: null },
    { ...valid, status: [] }, { ...valid, status: { type: 'completed' } }, { ...valid, status: { type: 'idle', activeFlags: [] } },
    { ...valid, turnId: 'foreign-turn' }, { ...valid, thread_id: 'ambiguous-thread' },
    ...[undefined, 'waitingOnApproval', ['unknown'], [{}], ['waitingOnApproval', 'waitingOnApproval']].map(activeFlags =>
      ({ ...valid, status: { type: 'active', activeFlags } }))];
  const messages = malformed.map(params => ({ method: 'thread/status/changed', params }));
  messages.push({ id: 0, method: 'thread/status/changed', params: valid }, { id: null, method: 'thread/status/changed', params: valid },
    { method: 'thread/status/changed', params: { threadId: 'thread-fixture', status: { type: 'idle', turn: { status: 'completed' } } } });
  for (const extra of [{ result: {} }, { error: {} }, { turnId: 'foreign-turn' }, { emittedAtMs: 'invalid' },
    { emittedAtMs: -1 }, { emittedAtMs: {} }, { jsonrpc: '1.0' }]) messages.push({ method: 'thread/status/changed', params: valid, ...extra });
  for (const [index, message] of messages.entries()) await context.test(String(index), async t => {
    const progress = [];
    const value = await fixture(t, { 'turn/start': ({ nextTurn, send, complete }) => {
      nextTurn(); setImmediate(() => { send(message); complete(); }); return { turn: { id: 'turn-1' } };
    } }, { onProgress: event => { progress.push(event); } });
    const result = await value.run(); assert.equal(result.status, 'uncertain'); assert.equal(result.terminalObserved, false);
    assert(result.uncertainties.includes('INVALID_THREAD_STATUS_EVENT')); assert.deepEqual(progress, []); assert.equal(value.replies.length, 0);
  });
});

for (const stop of ['cancel', 'transport loss', 'commands without terminal']) test('global thread status preserves ' + stop + ' and no replay', async context => {
  let value;
  value = await fixture(context, { 'turn/start': ({ nextTurn, event, child, items }) => {
    nextTurn(); setImmediate(() => {
      event('thread/status/changed', { threadId: 'unrelated-thread', status: { type: 'idle' } });
      if (stop === 'cancel') value.backend.cancel();
      else { if (stop === 'commands without terminal') items(); child.kill(); }
    }); return { turn: { id: 'turn-1' } };
  } });
  const result = await value.run(); assert.equal(result.status, stop === 'cancel' ? 'interrupted' : 'uncertain');
  assert.equal(result.terminalObserved, stop === 'cancel');
  assert.equal(value.requests.filter(request => request.method === 'turn/start').length, 1);
  assert.equal(value.requests.filter(request => request.method === 'turn/interrupt').length, stop === 'cancel' ? 1 : 0);
  if (stop === 'commands without terminal') { assert.equal(result.commands[0].exitCode, 0); assert.equal(result.messages.length, 1); }
});

for (const early of [false, true]) test('global thread status preserves event limits; early=' + early, async context => {
  const value = await fixture(context, { 'turn/start': ({ nextTurn, event }) => {
    nextTurn(); const emit = () => { for (let count = 0; count < (early ? 1001 : 10001); count++)
      event('thread/status/changed', { threadId: 'unrelated-thread', status: { type: 'idle' } }); };
    if (early) emit(); else setImmediate(emit);
    return { turn: { id: 'turn-1' } };
  } });
  const result = await value.run(); assert.equal(result.status, 'uncertain'); assert.equal(result.terminalObserved, false);
  assert(result.uncertainties.includes('EVENT_OVERFLOW'));
});

test('events preceding turn/start acknowledgement are correlated without losing evidence', async context => {
  const value = await fixture(context, { 'turn/start': ({ nextTurn, items, complete }) => {
    nextTurn(); items(); complete(); return { turn: { id: 'turn-1' } };
  } });
  const result = await value.run(); assert.equal(result.status, 'completed'); assert.equal(result.commands.length, 1);
});

test('native approval requires an explicit single-operation human decision, never session-wide acceptance', async context => {
  for (const decision of ['accept', 'decline', 'acceptForSession', undefined]) {
    const value = await fixture(context, { 'turn/start': ({ nextTurn, send }) => {
      nextTurn(); setImmediate(() => send({ id: 'approval', method: 'item/commandExecution/requestApproval',
        params: { threadId: 'thread-fixture', turnId: 'turn-1', itemId: 'command', command: 'sensitive command' } }));
      return { turn: { id: 'turn-1' } };
    }, reply: ({ complete }) => complete() }, decision ? { onApproval: async request => { assert.equal(request.command, 'sensitive command'); return decision; } } : {});
    assert.equal((await value.run()).status, 'completed');
    assert.deepEqual(value.replies[0].result, { decision: decision === 'accept' ? 'accept' : 'decline' });
    assert.match(APPROVAL_LIMITATION, /not universal pre-execution enforcement/);
  }
});

test('clarification answers are returned only to the current turn', async context => {
  const value = await fixture(context, { 'turn/start': ({ nextTurn, send }) => {
    nextTurn(); setImmediate(() => send({ id: 'question', method: 'item/tool/requestUserInput',
      params: { threadId: 'thread-fixture', turnId: 'turn-1', questions: [{ id: 'scope' }] } }));
    return { turn: { id: 'turn-1' } };
  }, reply: ({ complete }) => complete() }, { onQuestion: async () => ({ scope: { answers: ['Only the fixture.'] } }) });
  assert.equal((await value.run()).status, 'completed');
  assert.deepEqual(value.replies[0].result.answers.scope.answers, ['Only the fixture.']);
});

test('unknown approval requests interrupt instead of approving or retrying', async context => {
  const value = await fixture(context, { 'turn/start': ({ nextTurn, send }) => {
    nextTurn(); setImmediate(() => send({ id: 'permissions', method: 'item/permissions/requestApproval', params: { threadId: 'thread-fixture', turnId: 'turn-1' } }));
    return { turn: { id: 'turn-1' } };
  } });
  const result = await value.run(); assert.equal(result.status, 'interrupted');
  assert.equal(value.replies[0].error.code, -32601);
  assert.equal(value.requests.filter(request => request.method === 'turn/start').length, 1);
});

test('abort sends turn/interrupt and requires a terminal notification for confirmed interruption', async context => {
  const controller = new AbortController();
  const value = await fixture(context, { 'turn/start': ({ nextTurn }) => {
    nextTurn(); setImmediate(() => controller.abort()); return { turn: { id: 'turn-1' } };
  } });
  const result = await value.run({ signal: controller.signal });
  assert.equal(result.status, 'interrupted'); assert.equal(result.terminalObserved, true);
  assert.equal(result.cancellationRequested, true);
  assert.equal(value.requests.filter(request => request.method === 'turn/interrupt').length, 1);
});

test('pre-aborted input submits no turn and a busy backend rejects concurrent input', async context => {
  const value = await fixture(context);
  const controller = new AbortController(); controller.abort();
  assert.equal((await value.run({ signal: controller.signal })).status, 'interrupted');
  assert(!value.requests.some(request => request.method === 'turn/start'));
  const pending = value.run(); await assert.rejects(value.run(), /EXECUTION_ALREADY_ACTIVE/); await pending;
});

test('transport loss after submission yields uncertainty, never replay or fabricated success', async context => {
  const value = await fixture(context, { 'turn/start': ({ child }) => { child.kill(); } });
  const result = await value.run(); assert.equal(result.status, 'uncertain'); assert.equal(result.terminalObserved, false);
  assert.equal(value.requests.filter(request => request.method === 'turn/start').length, 1);
});

test('missing and locally truncated command output stays explicitly unverified', async context => {
  for (const change of [{ exitCode: null, aggregatedOutput: null }, { aggregatedOutput: 'x'.repeat(70000) }]) {
    const value = await fixture(context, { 'turn/start': ({ nextTurn, items, complete }) => {
      nextTurn(); setImmediate(() => { items(change); complete(); }); return { turn: { id: 'turn-1' } };
    } });
    const result = await value.run(); assert.equal(result.status, 'completed');
    assert.equal(result.commands[0].outputCompleteness, 'unverified');
    if (change.exitCode === null) assert.deepEqual(result.commands[0].missing, ['exitCode', 'output']);
    else { assert.equal(result.commands[0].locallyTruncated, true); assert.equal(result.commands[0].output.length, 65536); }
  }
});

for (const [availability, output] of [['absent', undefined], ['null', null], ['empty', ''], ['present', 'ok\n'], ['malformed', 42], ['malformed', {}]]) {
  test(`native command output ${availability} (${typeof output}) is classified without inventing contents`, async context => {
    const value = await fixture(context, { 'turn/start': ({ nextTurn, items, complete }) => {
      nextTurn(); setImmediate(() => { items({ aggregatedOutput: output }); complete(); }); return { turn: { id: 'turn-1' } };
    } });
    const result = await value.run(), record = result.commands[0];
    assert.equal(result.status, 'completed'); assert.equal(result.terminalObserved, true);
    assert.equal(record.outputAvailability, availability);
    assert.equal(record.output, typeof output === 'string' ? output : null);
    assert.equal(record.missing.includes('output'), typeof output !== 'string');
    assert.equal(result.uncertainties.length, availability === 'malformed' ? 4 : 3);
    if (availability === 'malformed') assert(result.uncertainties.some(diagnostic => diagnostic.includes('output_format')));
  });
}

for (const [label, change, diagnostic] of [
  ['missing exit with optional output', { exitCode: null, aggregatedOutput: null }, 'exitCode'],
  ['changed command', { command: 'different' }, 'start_completion_conflict'],
  ['changed cwd', { cwd: '/other' }, 'start_completion_conflict'],
  ['contradictory completed status', { exitCode: 1 }, 'status_exit_conflict'],
  ['contradictory failed status', { status: 'failed' }, 'status_exit_conflict'],
]) test(`optional output correction retains execution uncertainty: ${label}`, async context => {
  const value = await fixture(context, { 'turn/start': ({ nextTurn, items, complete }) => {
    nextTurn(); setImmediate(() => { items(change); complete(); }); return { turn: { id: 'turn-1' } };
  } });
  const result = await value.run();
  assert(result.uncertainties.some(value => value.includes(diagnostic)));
});

for (const missing of ['start', 'completion']) test(`optional output cannot hide missing command ${missing}`, async context => {
  const value = await fixture(context, { 'turn/start': ({ nextTurn, event, complete, cwd }) => {
    nextTurn(); setImmediate(() => {
      const item = { id: 'incomplete-command', type: 'commandExecution', command: 'true', cwd, aggregatedOutput: null };
      if (missing !== 'start') event('item/started', { threadId: 'thread-fixture', turnId: 'turn-1', item: { ...item, status: 'inProgress' } });
      if (missing !== 'completion') event('item/completed', { threadId: 'thread-fixture', turnId: 'turn-1', item: { ...item, status: 'completed', exitCode: 0 } });
      complete();
    });
    return { turn: { id: 'turn-1' } };
  } });
  const result = await value.run();
  assert(result.commands[0].missing.includes(missing));
  assert(result.uncertainties.some(value => value.includes(missing)));
});

test('foreign-turn and duplicate terminal item evidence fails closed', async context => {
  for (const duplicate of [false, true]) {
    const value = await fixture(context, { 'turn/start': ({ nextTurn, event, items }) => {
      nextTurn(); setImmediate(() => {
        if (duplicate) { items(); items(); }
        else event('item/completed', { threadId: 'foreign', turnId: 'turn-1', item: { id: 'foreign', type: 'commandExecution' } });
      }); return { turn: { id: 'turn-1' } };
    } });
    assert.equal((await value.run()).status, 'uncertain');
  }
});

test('unconfirmed interruption is bounded, closes the backend and never claims a terminal event', async context => {
  const value = await fixture(context, { 'turn/start': ({ nextTurn }) => { nextTurn(); return { turn: { id: 'turn-1' } }; },
    'turn/interrupt': () => ({}) }, { timeoutMs: 20 });
  const result = await value.run();
  assert.equal(result.status, 'interrupted'); assert.equal(result.terminalObserved, false);
  assert(result.uncertainties.includes('INTERRUPTION_UNCONFIRMED'));
  await assert.rejects(value.backend.connect(), /BACKEND_CLOSED/);
});

test('late human approval cannot authorize a cancelled turn', async context => {
  let decide;
  const value = await fixture(context, { 'turn/start': ({ nextTurn, send }) => {
    nextTurn(); setImmediate(() => send({ id: 'approval', method: 'item/fileChange/requestApproval', params: { threadId: 'thread-fixture', turnId: 'turn-1' } }));
    return { turn: { id: 'turn-1' } };
  } }, { onApproval: () => new Promise(resolve => { decide = resolve; setImmediate(() => value.backend.cancel()); }) });
  assert.equal((await value.run()).status, 'interrupted');
  decide('accept'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(value.replies.length, 0);
});

test('approval handler failure interrupts rather than automatically accepting', async context => {
  const value = await fixture(context, { 'turn/start': ({ nextTurn, send }) => {
    nextTurn(); setImmediate(() => send({ id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-fixture', turnId: 'turn-1' } }));
    return { turn: { id: 'turn-1' } };
  } }, { onApproval: () => { throw Error('private UI failure'); } });
  assert.equal((await value.run()).status, 'interrupted'); assert.equal(value.replies.length, 0);
});

test('API-key account changes during a turn terminate execution without fallback', async context => {
  const value = await fixture(context, { 'turn/start': ({ nextTurn, event }) => {
    nextTurn(); setImmediate(() => event('account/updated', { authMode: 'apikey', planType: null }));
    return { turn: { id: 'turn-1' } };
  } });
  const result = await value.run(); assert.equal(result.status, 'uncertain');
  assert(result.uncertainties.includes('CHATGPT_AUTHENTICATION_CHANGED'));
  assert.equal(result.authentication, 'unverified');
  assert.equal(value.requests.filter(request => request.method === 'turn/start').length, 1);
});

test('pending command completion and missing start are recorded rather than inferred from prose', async context => {
  const value = await fixture(context, { 'turn/start': ({ nextTurn, event, complete }) => {
    nextTurn(); setImmediate(() => {
      const binding = { threadId: 'thread-fixture', turnId: 'turn-1' };
      event('item/started', { ...binding, item: { id: 'pending', type: 'commandExecution', command: 'test' } });
      event('item/completed', { ...binding, item: { id: 'orphan', type: 'commandExecution', command: 'test', status: 'completed' } });
      complete();
    }); return { turn: { id: 'turn-1' } };
  } });
  const result = await value.run();
  assert.equal(result.status, 'completed'); assert(result.commands[0].missing.includes('start'));
  assert(result.uncertainties.some(reason => reason.includes('pending')));
  assert.equal(result.commands[1].command, 'test'); assert(result.commands[1].missing.includes('completion'));
});

test('resolved native requests cannot receive a late approval while the turn remains active', async context => {
  const value = await fixture(context, { 'turn/start': ({ nextTurn, send }) => {
    nextTurn(); setImmediate(() => send({ id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-fixture', turnId: 'turn-1' } }));
    return { turn: { id: 'turn-1' } };
  } }, { onApproval: async () => {
    value.event('serverRequest/resolved', { threadId: 'thread-fixture', requestId: 'approval' });
    setImmediate(() => value.complete());
    return 'accept';
  } });
  assert.equal((await value.run()).status, 'completed'); assert.equal(value.replies.length, 0);
});

test('completed turns do not convert failed tests into success claims', async context => {
  const value = await fixture(context, { 'turn/start': ({ nextTurn, items, complete }) => {
    nextTurn(); setImmediate(() => { items({ status: 'failed', exitCode: 2 }); complete(); });
    return { turn: { id: 'turn-1' } };
  } });
  const result = await value.run(); assert.equal(result.status, 'completed'); assert.equal(result.commands[0].exitCode, 2);
  assert.equal(result.testsPassed, undefined);
});

test('async progress observers are rejected without unhandled promise rejection', async context => {
  const value = await fixture(context, {}, { onProgress: async () => { throw Error('private observer failure'); } });
  const result = await value.run();
  assert.equal(result.status, 'uncertain');
  assert(result.uncertainties.includes('ASYNC_PROGRESS_HANDLER_UNSUPPORTED'));
});

test('unbound item and terminal notifications cannot qualify execution evidence', async context => {
  for (const method of ['item/completed', 'turn/completed']) {
    const value = await fixture(context, { 'turn/start': ({ nextTurn, event }) => {
      nextTurn(); setImmediate(() => event(method, { turn: { id: 'turn-1', status: 'completed' },
        item: { id: 'command', type: 'commandExecution', status: 'completed', exitCode: 0 } }));
      return { turn: { id: 'turn-1' } };
    } });
    const result = await value.run();
    assert.equal(result.status, 'uncertain'); assert.equal(result.terminalObserved, false);
    assert.equal(result.commands.length, 0);
  }
});

test('unavailable configured model is replaced explicitly by the catalog default for start, resume and turns', async context => {
  const value = await fixture(context);
  assert.equal(configuration().model, 'gpt-6.1-sol');
  const first = await value.run(), resumed = await value.run({ threadId: first.threadId });
  for (const result of [first, resumed]) {
    assert.equal(result.status, 'completed'); assert.equal(result.model, 'gpt-6-astra');
  }
  for (const request of value.requests.filter(request => ['thread/start', 'thread/resume', 'turn/start'].includes(request.method))) {
    assert.equal(request.params.model, 'gpt-6-astra');
  }
  assert.equal(value.requests.filter(request => request.method === 'model/list').length, 2);
  assert(value.requests.findIndex(request => request.method === 'thread/read') < value.requests.findIndex(request => request.method === 'thread/resume'));
  assert(!value.requests.some(request => ['config/value/write', 'config/batchWrite', 'account/login/start'].includes(request.method)));
});

test('model selection traverses the complete catalog and uses the model slug rather than picker id', async context => {
  const value = await fixture(context, { 'model/list': ({ params }) => params.cursor === null
    ? { data: [model('gpt-6-sol', false)], nextCursor: 'next' }
    : { data: [{ ...model(), id: 'picker-entry' }], nextCursor: null } });
  assert.equal((await value.run()).model, 'gpt-6-astra');
  assert.deepEqual(value.requests.filter(request => request.method === 'model/list').map(request => request.params), [
    { cursor: null, limit: 100, includeHidden: false }, { cursor: 'next', limit: 100, includeHidden: false },
  ]);
});

test('missing, ambiguous, hidden, malformed and incomplete model catalogs fail before thread creation', async context => {
  const invalid = [
    { data: [], nextCursor: null },
    { data: [model('gpt-6-sol', false)], nextCursor: null },
    { data: [model(), model('gpt-6-sol')], nextCursor: null },
    { data: [{ ...model(), hidden: true }], nextCursor: null },
    { data: [{ ...model(), model: '' }], nextCursor: null },
    { data: [{ ...model(), isDefault: 'true' }], nextCursor: null },
    { data: [model(), model()], nextCursor: null },
    { data: [model()] }, { data: null, nextCursor: null },
  ];
  for (const response of invalid) {
    const value = await fixture(context, { 'model/list': () => response });
    const result = await value.run();
    assert.equal(result.status, 'failed'); assert.equal(result.turnSubmissionAttempted, false);
    assert(!value.requests.some(request => request.method.startsWith('thread/') || request.method === 'turn/start'));
  }
  for (const cyclic of [false, true]) {
    let pages = 0;
    const value = await fixture(context, { 'model/list': () => ({ data: [model(`model-${++pages}`, pages === 1)], nextCursor: cyclic ? 'cycle' : `cursor-${pages}` }) });
    const result = await value.run();
    assert.equal(result.status, 'failed'); assert.equal(pages, cyclic ? 2 : 10);
    assert(!value.requests.some(request => request.method === 'thread/start'));
  }
});

test('a second default on a later page is rejected rather than selecting the first', async context => {
  const value = await fixture(context, { 'model/list': ({ params }) => params.cursor === null
    ? { data: [model()], nextCursor: 'next' }
    : { data: [model('gpt-6-sol')], nextCursor: null } });
  assert.equal((await value.run()).status, 'failed');
  assert(!value.requests.some(request => request.method === 'thread/start'));
});

test('resume rejects missing or different persisted models instead of silently changing them', async context => {
  for (const previousModel of [null, undefined, 'gpt-6.1-sol', 'gpt-6-sol']) {
    const value = await fixture(context, { 'thread/read': () => ({ thread: { id: 'thread-fixture', model: previousModel } }) });
    const result = await value.run({ threadId: 'thread-fixture' });
    assert.equal(result.status, 'failed'); assert(result.uncertainties.includes('RESUME_MODEL_MISMATCH'));
    assert(!value.requests.some(request => ['thread/resume', 'turn/start'].includes(request.method)));
  }
});

test('thread start and resume model substitutions are rejected before a turn', async context => {
  for (const method of ['thread/start', 'thread/resume']) {
    for (const selected of [undefined, 'gpt-6-sol']) {
      const value = await fixture(context, { [method]: ({ defaults }) => ({ ...defaults['thread/start'](), model: selected }) });
      const result = await value.run(method === 'thread/resume' ? { threadId: 'thread-fixture' } : {});
      assert.equal(result.status, 'failed'); assert(result.uncertainties.includes('THREAD_MODEL_MISMATCH'));
      assert(!value.requests.some(request => request.method === 'turn/start'));
    }
  }
});

test('model catalog errors and rejected inference never trigger a model fallback or retry', async context => {
  for (const method of ['model/list', 'turn/start']) {
    const value = await fixture(context, { [method]: () => { throw Error('synthetic unavailable model'); } });
    const result = await value.run();
    assert.equal(result.status, method === 'model/list' ? 'failed' : 'uncertain');
    assert.equal(value.requests.filter(request => request.method === method).length, 1);
    if (method === 'model/list') assert(!value.requests.some(request => request.method === 'thread/start'));
    else assert.equal(value.requests.find(request => request.method === method).params.model, 'gpt-6-astra');
  }
});

test('synchronous lifecycle exposes model and identities before submission, acknowledgement and terminal completion', async context => {
  const events = [];
  const value = await fixture(context, { 'turn/start': ({ nextTurn, items, complete }) => {
    assert.equal(events.at(-1).phase, 'turn_submitting'); assert.equal(events.at(-1).turnSubmissionAttempted, true);
    assert.equal(events.at(-1).turnSubmissionAcknowledged, false); assert.equal(events.at(-1).turnId, null);
    nextTurn(); setImmediate(() => {
      assert.equal(events.at(-1).phase, 'turn_acknowledged'); assert.equal(events.at(-1).turnId, 'turn-1');
      assert.equal(events.at(-1).terminalObserved, false); items(); complete();
    }); return { turn: { id: 'turn-1', status: 'inProgress' } };
  } }, { onLifecycle: event => events.push(event) });
  const result = await value.run();
  assert.equal(result.status, 'completed'); assert.equal(result.turnSubmissionAcknowledged, true);
  assert.deepEqual(events.map(event => event.phase), ['model_selected', 'thread_acknowledged', 'turn_submitting', 'turn_acknowledged', 'terminal_observed']);
  assert.equal(events[1].threadId, 'thread-fixture'); assert.equal(events[1].model, 'gpt-6-astra');
  assert.equal(events.at(-1).terminalObserved, true);
});

test('lifecycle persistence failures stop submission or retain uncertainty without replay', async context => {
  for (const phase of ['model_selected', 'thread_acknowledged', 'turn_submitting', 'turn_acknowledged', 'terminal_observed']) {
    const value = await fixture(context, {}, { onLifecycle: event => { if (event.phase === phase) throw Error('private storage failure'); } });
    const result = await value.run();
    assert.notEqual(result.status, 'completed'); assert(!JSON.stringify(result).includes('private storage failure'));
    assert.equal(value.requests.filter(request => request.method === 'turn/start').length, ['turn_acknowledged', 'terminal_observed'].includes(phase) ? 1 : 0);
    if (phase === 'thread_acknowledged') assert.equal(result.threadId, 'thread-fixture');
  }
});

test('async lifecycle callbacks fail closed rather than pretending identity was durably saved', async context => {
  const value = await fixture(context, {}, { onLifecycle: async () => { throw Error('private failure'); } });
  assert.equal((await value.run()).status, 'failed');
  assert(!value.requests.some(request => request.method === 'thread/start'));
});

test('unsupported human requests are observed synchronously before safe interruption', async context => {
  const events = [];
  const value = await fixture(context, { 'turn/start': ({ nextTurn, send }) => {
    nextTurn(); setImmediate(() => send({ id: 'permission', method: 'item/permissions/requestApproval', params: { threadId: 'thread-fixture', turnId: 'turn-1', reason: 'Needs permission' } }));
    return { turn: { id: 'turn-1' } };
  } }, { onLifecycle: event => events.push(event) });
  assert.equal((await value.run()).status, 'interrupted');
  const request = events.find(event => event.phase === 'human_request');
  assert.equal(request.request.method, 'item/permissions/requestApproval'); assert.equal(request.threadId, 'thread-fixture');
  assert(value.replies[0].error); assert.equal(await value.backend.close(), true);
});

test('closing during asynchronous connection setup prevents a late subprocess launch', async context => {
  const value = await fixture(context);
  const connected = value.backend.connect();
  await value.backend.close();
  await assert.rejects(connected, /BACKEND_CLOSED/); assert.equal(value.launches.length, 0);
});

test('failed human-request persistence cannot race a completed event into success', async context => {
  const value = await fixture(context, { 'turn/start': ({ nextTurn, send, complete }) => {
    nextTurn(); setImmediate(() => {
      send({ id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-fixture', turnId: 'turn-1' } });
      complete();
    }); return { turn: { id: 'turn-1' } };
  } }, { onLifecycle: event => { if (event.phase === 'human_request') throw Error('Storage failure'); } });
  const result = await value.run(); assert.equal(result.status, 'uncertain');
  assert(result.uncertainties.includes('LIFECYCLE_HANDLER_FAILED')); assert.equal(value.replies.length, 0);
});

async function deferred(context, method = 'item/commandExecution/requestApproval', options = {}, overrides = {}) {
  const value = await fixture(context, { 'turn/start': ({ nextTurn, send }) => {
    nextTurn(); setImmediate(() => send({ id: 0, method, params: { threadId: 'thread-fixture', turnId: 'turn-1', command: 'node --version',
      questions: [{ id: 'scope', question: 'Which file?', isOther: true, options: [{ label: 'fixture.txt' }] }] } }));
    return { turn: { id: 'turn-1' } };
  }, ...overrides }, { deferHumanRequests: true, ...options });
  const running = value.run();
  for (let attempt = 0; attempt < 100 && !value.backend.active?.requests.has(0); attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert(value.backend.active?.requests.has(0));
  return { ...value, running, respond: response => value.backend.respondToRequest({ requestId: 0, threadId: 'thread-fixture', turnId: 'turn-1', response }) };
}

for (const decision of ['accept', 'decline', 'cancel']) test(`deferred native ${decision} replies to the original request and turn exactly once`, async context => {
  const events = [], value = await deferred(context, 'item/commandExecution/requestApproval', { onLifecycle: event => events.push(event),
    onApproval: () => { assert.fail('Deferred requests must not invoke automatic handlers'); } },
  { reply: ({ complete }) => setImmediate(() => complete(decision === 'cancel' ? 'interrupted' : 'completed')) });
  const request = events.find(event => event.phase === 'human_request');
  assert.equal(request.request.id, 0); assert.equal(request.threadId, 'thread-fixture'); assert.equal(request.turnId, 'turn-1');
  assert.equal(value.replies.length, 0); assert.equal(value.backend.busy, true);
  value.respond({ decision });
  assert.throws(() => value.respond({ decision }), /NATIVE_REQUEST_UNAVAILABLE/);
  const result = await value.running;
  assert.equal(result.status, decision === 'cancel' ? 'interrupted' : 'completed');
  assert.deepEqual(value.replies, [{ id: 0, result: { decision } }]);
  assert.equal(value.requests.filter(request => request.method === 'turn/start').length, 1);
  assert.equal(value.requests.filter(request => request.method === 'thread/start').length, 1);
  assert(!value.requests.some(request => request.method === 'thread/resume'));
  assert.deepEqual(events.filter(event => event.phase.startsWith('human_response')).map(event => event.phase), ['human_response_submitting', 'human_response_sent']);
});

test('deferred clarification delivers exact native question IDs without starting a new turn', async context => {
  const value = await deferred(context, 'item/tool/requestUserInput', {}, { reply: ({ complete }) => setImmediate(() => complete()) });
  assert.throws(() => value.respond({ answers: { wrong: { answers: ['fixture.txt'] } } }), /INVALID_CLARIFICATION_ANSWER/);
  value.respond({ answers: { scope: { answers: ['human free text'] } } });
  assert.equal((await value.running).status, 'completed');
  assert.deepEqual(value.replies[0], { id: 0, result: { answers: { scope: { answers: ['human free text'] } } } });
  assert.equal(value.requests.filter(request => request.method === 'turn/start').length, 1);
});

test('adapter rejects wrong native request type/ID, thread, turn and malformed decisions before writing', async context => {
  const value = await deferred(context, 'item/fileChange/requestApproval');
  for (const changed of [{ requestId: '0' }, { requestId: 1 }, { threadId: 'foreign' }, { turnId: 'foreign' }]) {
    assert.throws(() => value.backend.respondToRequest({ requestId: 0, threadId: 'thread-fixture', turnId: 'turn-1', response: { decision: 'accept' }, ...changed }), /NATIVE_REQUEST_UNAVAILABLE/);
  }
  for (const response of [{ decision: 'yes' }, { decision: 'acceptForSession' }, { decision: 'accept', extra: true }, { answers: {} }]) {
    assert.throws(() => value.respond(response), /INVALID_APPROVAL_DECISION/);
  }
  assert.equal(value.replies.length, 0);
  await value.backend.cancel(); assert.equal((await value.running).status, 'interrupted');
});

for (const phase of ['human_response_submitting', 'human_response_sent']) test(`${phase} persistence failure never retries and reports uncertain delivery`, async context => {
  const value = await deferred(context, 'item/commandExecution/requestApproval', { onLifecycle: event => { if (event.phase === phase) throw Error('storage unavailable'); } });
  assert.throws(() => value.respond({ decision: 'accept' }), /HUMAN_RESPONSE_DELIVERY_UNCERTAIN/);
  const result = await value.running; assert.equal(result.status, 'uncertain');
  assert.equal(value.replies.length, phase === 'human_response_submitting' ? 0 : 1);
  assert.throws(() => value.respond({ decision: 'accept' }), /NATIVE_REQUEST_UNAVAILABLE/);
});

for (const stop of ['cancel', 'close', 'complete', 'server_resolved', 'transport_loss']) test(`${stop} invalidates a deferred request and rejects late acceptance`, async context => {
  const value = await deferred(context);
  if (stop === 'cancel') await value.backend.cancel();
  if (stop === 'close') await value.backend.close();
  if (stop === 'complete') value.complete();
  if (stop === 'server_resolved') value.event('serverRequest/resolved', { threadId: 'thread-fixture', requestId: 0 });
  if (stop === 'transport_loss') value.backend.rpc.child.kill();
  await new Promise(resolve => setImmediate(resolve));
  assert.throws(() => value.respond({ decision: 'accept' }), /NATIVE_REQUEST_UNAVAILABLE/);
  if (stop === 'server_resolved') await value.backend.cancel();
  await value.running; assert.equal(value.replies.length, 0);
});

test('duplicate native requests, including after response, cannot elicit another approval', async context => {
  for (const answered of [false, true]) {
    const value = await deferred(context);
    const request = value.backend.active.humanRequests.get(0);
    if (answered) value.respond({ decision: 'decline' });
    value.backend.rpc.child.stdout.write(JSON.stringify(request) + '\n');
    const result = await value.running;
    assert.equal(result.status, 'uncertain'); assert(result.uncertainties.includes('DUPLICATE_SERVER_REQUEST'));
    assert.equal(value.replies.length, answered ? 1 : 0);
  }
});

test('unbound resolution cannot clear a pending human request', async context => {
  const value = await deferred(context);
  value.event('serverRequest/resolved', { requestId: 0 });
  const result = await value.running; assert.equal(result.status, 'uncertain');
  assert(result.uncertainties.includes('REQUEST_RESOLUTION_MISMATCH')); assert.equal(value.replies.length, 0);
});

test('bounded timeout interrupts even while a deferred callback remains unanswered', async context => {
  const value = await deferred(context, 'item/fileChange/requestApproval', { timeoutMs: 100 });
  const result = await value.running;
  assert.equal(result.status, 'interrupted'); assert.equal(result.terminalObserved, true); assert.equal(value.replies.length, 0);
  assert.throws(() => value.respond({ decision: 'accept' }), /NATIVE_REQUEST_UNAVAILABLE/);
});

test('deferred approvals respect native available decisions instead of silently widening them', async context => {
  const value = await deferred(context);
  value.backend.active.humanRequests.get(0).params.availableDecisions = ['decline', 'cancel'];
  assert.throws(() => value.respond({ decision: 'accept' }), /INVALID_APPROVAL_DECISION/);
  value.respond({ decision: 'decline' }); value.complete();
  assert.equal((await value.running).status, 'completed'); assert.equal(value.replies.length, 1);
});
