import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppServerRpc, isolatedEnvironment, requireSubscription } from '../feasibility/local-codex/rpc.mjs';
import { SessionLedger, commandObservation, migrationDecision } from '../feasibility/local-codex/state.mjs';

async function fixture(context) {
  const root = await fs.mkdtemp('/tmp/pab-codex-unit-');
  const filename = path.join(root, 'state.sqlite');
  let ledger = new SessionLedger(filename);
  context.after(async () => { ledger.close(); await fs.rm(root, { recursive: true, force: true }); });
  ledger.bind('implementer', 'thread-impl', 'session-impl', 'generation-1');
  return { ledger, filename, reopen: () => { ledger.close(); ledger = new SessionLedger(filename); return ledger; } };
}
const question = (overrides = {}) => ({ id: 42, method: 'item/tool/requestUserInput', params: {
  threadId: 'thread-impl', turnId: 'turn-1', itemId: 'item-1', isBlocking: true, autoResolutionMs: null,
  questions: [{ id: 'name', header: 'Name', question: 'Which name?', isSecret: false, isOther: true, options: null }], ...overrides } });

test('subscription check rejects absent, API-key, other-provider and ambiguous authentication', () => {
  for (const value of [null, {}, { account: null }, { account: { type: 'apiKey' }, requiresOpenaiAuth: true },
    { account: { type: 'amazonBedrock' }, requiresOpenaiAuth: true }, { account: { type: 'chatgpt' }, requiresOpenaiAuth: false }]) {
    assert.throws(() => requireSubscription(value), /SUBSCRIPTION_AUTH_UNVERIFIED/);
  }
  assert.deepEqual(requireSubscription({ account: { type: 'chatgpt', email: 'not-retained@example.invalid' }, requiresOpenaiAuth: true }), { method: 'chatgpt', inferenceVerified: false });
  assert.deepEqual(Object.keys(isolatedEnvironment('/home/probe', '/control/probe', '/scratch/probe')).sort(),
    ['CODEX_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'HOME', 'LANG', 'PATH', 'RUST_LOG', 'TMPDIR']);
});

test('reviewer requires independent thread AND session identities', async context => {
  const { ledger } = await fixture(context);
  assert.throws(() => ledger.bind('reviewer', 'thread-impl', 'other', 'generation-2'), /NOT_INDEPENDENT/);
  assert.throws(() => ledger.bind('reviewer', 'other', 'session-impl', 'generation-2'), /NOT_INDEPENDENT/);
  ledger.bind('reviewer', 'thread-review', 'session-review', 'generation-2');
  assert.notEqual(ledger.get('reviewer').threadId, ledger.get('implementer').threadId);
  assert.throws(() => ledger.bind('implementer', 'replacement', 'replacement', 'generation-3'), /ALREADY_BOUND/);
});

test('lost create/start/resume/interrupt acknowledgements never replay after restart', async context => {
  const value = await fixture(context);
  for (const method of ['thread/start', 'thread/resume', 'turn/start', 'turn/interrupt']) {
    assert.equal(value.ledger.beginOperation(method, method, { threadId: 'thread-impl' }).dispatch, true);
  }
  const ledger = value.reopen();
  for (const method of ['thread/start', 'thread/resume', 'turn/start', 'turn/interrupt']) {
    assert.deepEqual(ledger.beginOperation(method, method, { threadId: 'thread-impl' }), { dispatch: false, status: 'uncertain' });
    assert.throws(() => ledger.beginOperation(method, method, { threadId: 'different' }), /REQUEST_ID_CONFLICT/);
  }
  ledger.acknowledgeOperation('thread/start');
  assert.equal(ledger.beginOperation('thread/start', 'thread/start', { threadId: 'thread-impl' }).dispatch, false);
});

test('clarification persists before reply and duplicate replies cannot dispatch', async context => {
  const { ledger, filename } = await fixture(context);
  ledger.turnStarted('implementer', 'turn-1');
  ledger.clarification('implementer', 'generation-1', question());
  const reader = new SessionLedger(filename);
  assert.equal(reader.get('implementer').question.questions[0].question, 'Which name?'); reader.close();
  const response = ledger.answer('implementer', 'generation-1', 42, { name: { answers: ['Ada'] } });
  assert.deepEqual(response, { id: 42, result: { answers: { name: { answers: ['Ada'] } } } });
  assert.equal(ledger.get('implementer').question.status, 'reply_uncertain');
  assert.throws(() => ledger.answer('implementer', 'generation-1', 42, { name: { answers: ['Ada'] } }), /NOT_PENDING/);
});

test('crash with pending question or uncertain reply retains question and forbids stale RPC response', async context => {
  const value = await fixture(context);
  value.ledger.turnStarted('implementer', 'turn-1');
  value.ledger.clarification('implementer', 'generation-1', question());
  const ledger = value.reopen(); ledger.recover();
  assert.equal(ledger.get('implementer').status, 'needs_attention');
  assert.equal(ledger.get('implementer').question.questions[0].question, 'Which name?');
  assert.deepEqual(ledger.get('implementer').evidenceGaps, ['TRANSPORT_GAP']);
  for (const generation of ['generation-1', 'generation-2']) assert.throws(() => ledger.answer('implementer', generation, 42, { name: { answers: ['Ada'] } }), /NOT_PENDING/);
});

test('resolution notification cannot prove an answer was consumed', async context => {
  const { ledger } = await fixture(context);
  ledger.turnStarted('implementer', 'turn-1'); ledger.clarification('implementer', 'generation-1', question());
  ledger.answer('implementer', 'generation-1', 42, { name: { answers: ['Ada'] } });
  ledger.resolved('implementer', 'generation-1', { threadId: 'thread-impl', requestId: 42 });
  ledger.turnCompleted('implementer', 'generation-1', { threadId: 'thread-impl', turn: { id: 'turn-1', status: 'completed' } });
  assert.equal(ledger.get('implementer').status, 'needs_attention');
});

test('crash after reply persistence retains uncertainty without persisting answer plaintext', async context => {
  const value = await fixture(context);
  value.ledger.turnStarted('implementer', 'turn-1'); value.ledger.clarification('implementer', 'generation-1', question());
  value.ledger.answer('implementer', 'generation-1', 42, { name: { answers: ['sensitive-answer-fixture'] } });
  const ledger = value.reopen();
  assert.equal(ledger.get('implementer').question.status, 'reply_uncertain');
  assert(!JSON.stringify(ledger.get('implementer')).includes('sensitive-answer-fixture'));
  ledger.recover();
  assert.throws(() => ledger.answer('implementer', 'generation-1', 42, { name: { answers: ['sensitive-answer-fixture'] } }), /NOT_PENDING/);
});

test('persistence failure prevents constructing a clarification response', async context => {
  const { ledger } = await fixture(context);
  ledger.turnStarted('implementer', 'turn-1'); ledger.clarification('implementer', 'generation-1', question());
  ledger.save = () => { throw new Error('injected storage failure'); };
  assert.throws(() => ledger.answer('implementer', 'generation-1', 42, { name: { answers: ['Ada'] } }), /storage failure/);
  assert.equal(ledger.get('implementer').question.status, 'pending');
});

test('nonblocking, expiring, secret, cross-thread, cross-turn and duplicate questions fail closed', async context => {
  const { ledger } = await fixture(context); ledger.turnStarted('implementer', 'turn-1');
  for (const overrides of [{ isBlocking: false }, { autoResolutionMs: 30000 }, { threadId: 'other' }, { turnId: 'other' },
    { questions: [] }, { questions: [{ id: 'secret', question: 'Credential?', isSecret: true }] },
    { questions: [question().params.questions[0], question().params.questions[0]] }]) {
    assert.throws(() => ledger.clarification('implementer', 'generation-1', question(overrides)), /UNSUPPORTED_CLARIFICATION/);
  }
  assert.throws(() => ledger.clarification('implementer', 'stale-generation', question()), /UNSUPPORTED_CLARIFICATION/);
});

test('cancellation acknowledgement is not completion; interrupted question is never answered implicitly', async context => {
  const { ledger } = await fixture(context); ledger.turnStarted('implementer', 'turn-1');
  ledger.clarification('implementer', 'generation-1', question()); ledger.interruptRequested('implementer');
  assert.equal(ledger.get('implementer').status, 'interrupting');
  ledger.turnCompleted('implementer', 'generation-1', { threadId: 'thread-impl', turn: { id: 'turn-1', status: 'interrupted' } });
  assert.equal(ledger.get('implementer').status, 'needs_attention');
  assert.throws(() => ledger.answer('implementer', 'generation-1', 42, { name: { answers: ['Ada'] } }), /NOT_PENDING/);
});

test('normal terminal turn is distinguished from a request acknowledgement', async context => {
  const { ledger } = await fixture(context); ledger.turnStarted('implementer', 'turn-1');
  ledger.interruptRequested('implementer');
  assert.throws(() => ledger.turnCompleted('implementer', 'generation-1', { threadId: 'other', turn: { id: 'turn-1', status: 'completed' } }), /INVALID_COMPLETION/);
  ledger.turnCompleted('implementer', 'generation-1', { threadId: 'thread-impl', turn: { id: 'turn-1', status: 'interrupted' } });
  assert.equal(ledger.get('implementer').status, 'interrupted');
});

test('command evidence keeps runtime provenance, rejects prose, and exposes missing upstream completeness', () => {
  const expected = { threadId: 'thread-impl', turnId: 'turn-1' };
  const event = { method: 'item/completed', params: { ...expected, item: { id: 'cmd-1', type: 'commandExecution',
    command: 'npm test', cwd: '/work', aggregatedOutput: 'ok', exitCode: 0, status: 'completed' } } };
  const record = commandObservation(event, expected);
  assert.equal(record.exitCode, 0); assert.equal(record.upstreamCompleteness, 'unknown');
  assert.equal(record.executionBoundaryVerified, false);
  assert.equal(commandObservation({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'npm test passed' } } }, expected), null);
  assert.throws(() => commandObservation(event, { ...expected, turnId: 'other' }), /INVALID_COMMAND_EVIDENCE/);
  event.params.item.aggregatedOutput = 'x'.repeat(4096); event.params.item.exitCode = null;
  const bounded = commandObservation(event, expected);
  assert.equal(bounded.output.length, 2048); assert.equal(bounded.locallyTruncated, true); assert.equal(bounded.exitCode, null);
  assert.equal(migrationDecision().authorized, false);
});

async function rpcFixture(context, mode) {
  const root = await fs.mkdtemp('/tmp/pab-rpc-unit-');
  const binary = path.join(root, 'fake-app-server.mjs');
  await fs.copyFile(fileURLToPath(new URL('../feasibility/local-codex/fake-app-server.mjs', import.meta.url)), binary);
  await fs.chmod(binary, 0o700);
  const rpc = new AppServerRpc(binary, [mode], { cwd: root, env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    ...(process.env.LD_LIBRARY_PATH ? { LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH } : {}) }, timeoutMs: mode === 'timeout' ? 100 : 3000 });
  context.after(async () => { await rpc.close(); await fs.rm(root, { recursive: true, force: true }); });
  return rpc;
}
test('stdio transport initializes and correlates concurrent responses', async context => {
  const rpc = await rpcFixture(context, 'normal');
  assert.deepEqual(await rpc.initialize(), { method: 'initialize' });
  assert.deepEqual(await Promise.all([rpc.request('account/read'), rpc.request('thread/read')]), [{ method: 'account/read' }, { method: 'thread/read' }]);
});
for (const [mode, error] of [['disconnect', 'DISCONNECTED'], ['timeout', 'TIMEOUT'], ['oversize', 'PROTOCOL_FAILED'],
  ['malformed', 'PROTOCOL_FAILED'], ['server-request', 'UNEXPECTED_SERVER_REQUEST'], ['error', 'RPC_REJECTED']]) {
  test(`stdio transport fails closed on ${mode}`, async context => {
    const rpc = await rpcFixture(context, mode);
    await assert.rejects(rpc.request('initialize'), new RegExp(error));
  });
}
