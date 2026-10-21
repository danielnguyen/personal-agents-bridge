import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Controller, LocalExecutor } from '../controller.mjs';
import { FakeAPI, FakeExecutor, contract } from './helpers.mjs';

async function setup(t) {
  const root = await fs.mkdtemp('/var/tmp/personal-agents-bridge/failure-');
  const api = new FakeAPI(), executor = new FakeExecutor();
  const opts = { stateRoot: path.join(root, 'state'), workspaceRoot: path.join(root, 'work'), api, executor, secrets: ['sensitive-canary'] };
  let c = await new Controller(opts).init();
  t.after(async () => { await c.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { api, executor, get c() { return c; }, restart: async () => { await c.close(); c = await new Controller(opts).init(); return c; } };
}
async function start(c) {
  const x = await c.invoke('start_task', { contract: contract(), request_id: 'request_failure' }, { requestId: 'rpc_failure' }, input => c.start(input));
  await Promise.all([...c.jobs.values()]); return c.get(x.task_id);
}
function fail(api, sid, error = { code: 'server_error', message: 'Customer-safe failure' }) {
  const s = api.rows.get(sid); s.status = 'idle'; s.turns[0].status = 'failed'; s.turns[0].error = error; return s;
}
test('failure before assistant output returns bounded diagnostic and correlation', async t => {
  const { c, api } = await setup(t); const x = await start(c); fail(api, x.implementer.session_id);
  const d = (await c.get(x.task_id)).implementer;
  assert.equal(d.error, 'server_error'); assert.equal(d.latest_output, null);
  assert.equal(d.failure_diagnostic.api_error.message, 'Customer-safe failure');
  assert.equal(d.failure_diagnostic.session_id, x.implementer.session_id);
  assert.equal(d.failure_diagnostic.turn_id, x.implementer.turn_id);
  assert.equal(d.failure_diagnostic.executor_connection_state, 'connected');
  const a = JSON.parse(c.db.prepare('SELECT value FROM audit').get().value);
  assert.equal(a.mcp_request_id, 'rpc_failure'); assert.equal(a.bridge_request_id, 'request_failure');
  assert.equal(a.task_id, x.task_id); assert.equal(a.session_id, x.implementer.session_id); assert.equal(a.turn_id, x.implementer.turn_id);
});
test('asynchronous failed event persists without get_task, including reviewer', async t => {
  const { c, api } = await setup(t); let emit;
  api.events.stream = async () => { let end; const wait = new Promise(r => end = r); const event = new Promise(r => emit = r); return { controller: { abort: () => { emit(null); end(); } }, async *[Symbol.asyncIterator]() { const e = await event; if (e) yield e; await wait; } }; };
  const x = await start(c); const s = fail(api, x.implementer.session_id);
  emit({ type: 'agent.session.turn.failed', turn_id: s.turns[0].id, turn: s.turns[0] });
  await new Promise(r => setTimeout(r, 30));
  assert.equal(c.diagnostic(c.task(x.task_id).implementer).terminal_event_type, 'agent.session.turn.failed');
  api.completed(s.id); await c.get(x.task_id);
  await c.review({ task_id: x.task_id, request_id: 'request_review_fail' }); await Promise.all([...c.jobs.values()]);
  const ref = c.task(x.task_id).reviewer, rs = fail(api, ref.session_id);
  emit({ type: 'agent.session.turn.failed', turn_id: rs.turns[0].id, turn: rs.turns[0] });
  await new Promise(r => setTimeout(r, 30));
  assert.equal(c.diagnostic(c.task(x.task_id).reviewer).api_error.code, 'server_error');
});
test('missed event is reconciled before cleanup and survives process restart', async t => {
  const h = await setup(t); const x = await start(h.c); const s = fail(h.api, x.implementer.session_id);
  s.items.push({ type: 'command_execution', turn_id: s.turns[0].id, output: 'tool output' });
  const cleaned = await h.c.cleanup({ task_id: x.task_id }); assert.equal(cleaned.state, 'cleaned');
  assert.equal(cleaned.implementer.failure_diagnostic.latest_output.text, 'tool output');
  const c = await h.restart(); const after = await c.get(x.task_id);
  assert.equal(after.implementer.error, 'server_error'); assert.equal(after.implementer.latest_output, 'tool output');
  assert.equal(h.api.rows.size, 0);
});
test('executor exit metadata is persisted with failure', async t => {
  const { c, api, executor } = await setup(t); const x = await start(c);
  executor.onExit({ pid: 2147483647, code: 7, signal: null });
  fail(api, x.implementer.session_id);
  const d = (await c.get(x.task_id)).implementer.failure_diagnostic;
  assert.equal(d.executor_exit.code, 7); assert.equal(d.executor_exit.status, 'exited');
});
test('missing diagnostic returns explicit reason even if API is unavailable', async t => {
  const { c, api } = await setup(t); const x = await start(c); fail(api, x.implementer.session_id, null);
  assert.equal((await c.get(x.task_id)).implementer.error, 'diagnostic_unavailable');
  api.rows.clear(); const result = await c.get(x.task_id);
  assert.equal(result.implementer.failure_diagnostic.status, 'diagnostic_unavailable');
  assert.match(result.implementer.failure_diagnostic.reason, /unavailable/);
});
test('redaction, truncation and reasoning exclusion apply before persistence', async t => {
  const { c, api } = await setup(t); const x = await start(c);
  const s = fail(api, x.implementer.session_id, { code: 'server_error', type: 'sensitive-canary', message: 'sensitive-canary Bearer token-canary https://host/secret?token=value ' + 'x'.repeat(10000), reasoning: 'HIDDEN_CANARY' });
  s.items.push({ type: 'reasoning', turn_id: s.turns[0].id, text: 'HIDDEN_CANARY' }, { type: 'message', role: 'assistant', turn_id: s.turns[0].id, content: [{ type: 'reasoning', text: 'HIDDEN_CANARY' }, { type: 'output_text', text: 'sensitive-canary password=unlisted-secret ' + 'y'.repeat(10000) }] });
  await c.get(x.task_id);
  const raw = c.db.prepare('SELECT value FROM failures').get().value;
  for (const bad of ['sensitive-canary', 'token-canary', 'HIDDEN_CANARY', 'unlisted-secret', 'https://host']) assert(!raw.includes(bad), bad);
  const d = JSON.parse(raw); assert(d.api_error.message.length <= 2048); assert(d.latest_output.text.length <= 4096); assert(raw.length < 10000);
});
test('session failure without turn error is retained, and retention is 30 days', async t => {
  const { c, api } = await setup(t); const x = await start(c); const s = api.rows.get(x.implementer.session_id);
  s.status = 'failed'; s.error = { type: 'runtime', code: 'sandbox_error', message: 'Session failed' };
  assert.equal((await c.get(x.task_id)).implementer.error, 'sandbox_error');
  const row = c.db.prepare('SELECT expires,value FROM failures').get();
  assert.equal(row.expires - Date.parse(JSON.parse(row.value).timestamp), 30 * 86400000);
  c.db.prepare('UPDATE failures SET expires=0').run(); c.pruneDiagnostics(); assert.equal(c.db.prepare('SELECT count(*) AS n FROM failures').get().n, 0);
});

test('actual executor child exit is observed without logging its environment', async t => {
  const root = await fs.mkdtemp('/var/tmp/personal-agents-bridge/exit-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const executor = new LocalExecutor({ binary: '/usr/bin/false', executorKey: 'fake-executor-key' });
  const exited = new Promise(resolve => executor.onExit = resolve);
  await executor.start({ remote_url: 'https://example.invalid', environment_id: 'env_test' }, root, path.join(root, 'runtime'), 'implementer');
  const result = await exited; assert.equal(result.code, 1); assert.equal(result.signal, null);
});

test('failure diagnostic remains visible when turn/item APIs are unavailable', async t => {
  const { c, api } = await setup(t); const x = await start(c);
  const s = api.rows.get(x.implementer.session_id); s.status = 'failed'; s.error = { code: 'sandbox_error', message: 'Failure' };
  api.turns.list = async () => { throw { status: 503 }; };
  api.items.list = async () => { throw { status: 503 }; };
  const result = await c.get(x.task_id);
  assert.equal(result.implementer.state, 'failed'); assert.equal(result.implementer.error, 'sandbox_error');
  assert.equal(result.implementer.failure_diagnostic.api_error.message, 'Failure');
});

test('reconciliation preserves error type supplied only by the stream', async t => {
  const { c, api } = await setup(t); const x = await start(c); const s = fail(api, x.implementer.session_id);
  c.recordFailure(x.task_id, 'implementer', { event: { type: 'error', error: { type: 'runtime_error', code: 'server_error', message: 'Failure' } } });
  const result = await c.get(x.task_id);
  assert.equal(result.implementer.failure_diagnostic.api_error.type, 'runtime_error');
  assert.equal(result.implementer.failure_diagnostic.terminal_event_type, 'error');
});
