import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Controller, safeRelative, redact, digest } from '../controller.mjs';
import { authorizePersonalTunnel, createServer } from '../server.mjs';
import { FakeAPI, FakeExecutor, contract } from './helpers.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

async function setup(t) {
  const root = await fs.mkdtemp('/var/tmp/personal-agents-bridge/unit-');
  const api = new FakeAPI(), executor = new FakeExecutor();
  const c = await new Controller({ stateRoot: path.join(root, 'state'), workspaceRoot: path.join(root, 'work'), api, executor, secrets: ['test-sensitive-value'], timeoutMs: 600000 }).init();
  t.after(async () => { await c.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { c, api, executor, root };
}
async function started(c) { const x = await c.start({ contract: contract(), request_id: 'request_start' }); await Promise.all([...c.jobs.values()]); return await c.get(x.task_id); }
test('Agents API remains the default and explicit default selection preserves request fingerprints', async t => {
  const { c, api } = await setup(t);
  c.localBackendFactory = () => { assert.fail('Default tasks must not instantiate local Codex'); };
  const first = await started(c);
  assert.equal(first.execution_backend, 'agents_api'); assert.equal(c.task(first.task_id).execution_backend, 'agents_api');
  const repeated = await c.start({ contract: contract(), request_id: 'request_start', execution_backend: 'agents_api' });
  assert.equal(repeated.task_id, first.task_id); assert.equal(api.created.length, 1);
  const legacy = c.task(first.task_id); delete legacy.execution_backend; c.save(legacy);
  assert.equal((await c.get(first.task_id)).execution_backend, 'agents_api');
  assert.equal((await c.start({ contract: contract(), request_id: 'request_start' })).task_id, first.task_id);
});
test('clarification uses exact same session, turn and call; retries are deduplicated', async t => {
  const { c, api } = await setup(t); const x = await started(c), id = x.implementer.session_id;
  api.pending(id); assert.equal((await c.get(x.task_id)).implementer.clarification_required, true);
  const request = { task_id: x.task_id, instruction: 'Example', request_id: 'request_answer' };
  await c.continue(request); await c.continue(request);
  assert.equal(api.created.length, 1); assert.equal(api.sent.length, 2);
  assert.equal(api.sent[1].id, id); assert.equal(api.sent[1].payload.events[0].call_id, 'call_question');
  assert.equal(api.sent[1].payload.events[0].type, 'agent.session.input.tool_result');
  await assert.rejects(c.continue({ ...request, instruction: 'different' }), /REQUEST_ID_REUSED/);
});
test('start retries, path limits, unknown tasks, and secret rejection', async t => {
  const { c, api } = await setup(t); const x = await started(c);
  assert.equal((await c.start({ contract: contract(), request_id: 'request_start' })).task_id, x.task_id); assert.equal(api.created.length, 1);
  for (const p of ['../x', '/etc/passwd', '.git/config', 'a/../b', 'TASK.md', 'a\\b']) assert.throws(() => safeRelative(p));
  await assert.rejects(c.get('unknown'), /UNKNOWN_TASK/);
  await assert.rejects(c.start({ contract: { ...contract(), goal: 'test-sensitive-value' }, request_id: 'secret_reject' }), /CREDENTIAL/);
  assert.equal(redact('test-sensitive-value', ['test-sensitive-value']), '[REDACTED]');
});
test('review packet excludes conversation/reasoning and validates all requirement findings', async t => {
  const { c, api } = await setup(t); const x = await started(c); const sid = x.implementer.session_id;
  api.rows.get(sid).items.push({ type: 'reasoning', text: 'PRIVATE_REASONING_CANARY' });
  api.completed(sid, 'PRIVATE_CONVERSATION_CANARY');
  await c.review({ task_id: x.task_id, request_id: 'request_review' }); await Promise.all([...c.jobs.values()]);
  const y = await c.get(x.task_id); assert.notEqual(y.reviewer.session_id, sid);
  const packet = await fs.readFile(path.join(c.workspaceRoot, x.task_id, 'review/evidence.json'), 'utf8');
  assert(!packet.includes('PRIVATE_REASONING')); assert(!packet.includes('PRIVATE_CONVERSATION'));
  assert.equal(digest(packet), c.task(x.task_id).reviewer.packet_hash);
  api.completed(y.reviewer.session_id, JSON.stringify({ overall: 'FAIL', findings: ['R1', 'R2', 'I1', 'SCOPE', 'TEST_EVIDENCE'].map(id => ({ id, status: 'FAIL', evidence: 'No implementation evidence.' })) }));
  assert.equal((await c.get(x.task_id)).reviewer.overall, 'FAIL');
  await c.continue({ task_id: x.task_id, instruction: 'change', request_id: 'request_change' });
  assert.equal((await c.get(x.task_id)).reviewer.stale, true);
  assert.equal(c.task(x.task_id).implementer.session_id, sid);
  api.completed(sid);
  await c.review({ task_id: x.task_id, request_id: 'request_review2' }); await Promise.all([...c.jobs.values()]);
  const z = await c.get(x.task_id); assert.notEqual(z.reviewer.session_id, y.reviewer.session_id);
  assert.equal(c.task(x.task_id).previous_reviewers.length, 1);
  await c.continue({ task_id: x.task_id, instruction: 'change', request_id: 'request_change' });
  assert.equal(c.task(x.task_id).reviewer.stale, undefined);
  const clean = await c.cleanup({ task_id: x.task_id }); assert.equal(clean.state, 'cleaned');
  assert(api.deleted.includes(y.reviewer.session_id)); assert(api.deleted.includes(z.reviewer.session_id));
});
test('cleanup affects only owned sessions and is repeatable; missing evidence is not PASS', async t => {
  const { c, api, executor } = await setup(t); const x = await started(c); const unrelated = await api.create({ metadata: {} });
  const cleaned = await c.cleanup({ task_id: x.task_id, delete_workspace: true });
  assert.equal(cleaned.state, 'cleaned'); assert(api.rows.has(unrelated.id)); assert.equal(api.deleted.length, 1); assert(executor.stopped.length > 0);
  await c.cleanup({ task_id: x.task_id }); assert.equal(api.deleted.length, 1);
});
test('restarts preserve task/session ownership and pending human clarification', async t => {
  const { c, api, executor } = await setup(t); const x = await started(c); api.pending(x.implementer.session_id);
  await c.close();
  const recovered = await new Controller({ stateRoot: c.stateRoot, workspaceRoot: c.workspaceRoot, api, executor, secrets: [] }).init();
  c.close = async () => {}; t.after(() => recovered.close());
  const y = await recovered.get(x.task_id); assert.equal(y.implementer.session_id, x.implementer.session_id); assert.equal(y.implementer.question, 'Which name?'); assert.equal(api.created.length, 1);
});
test('tunnel gate rejects missing, shared, expired, mismatched, and unsafe confirmations', async t => {
  const root = await fs.mkdtemp('/var/tmp/personal-agents-bridge/gate-'); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'personal-tunnel.json'), now = Date.now();
  const live = { id: 'tunnel_test', organization_ids: ['org_personal'], workspace_ids: ['workspace_personal'] };
  const opts = { stateRoot: root, expectedTunnel: 'tunnel_test', now, lookup: async () => live };
  await assert.rejects(authorizePersonalTunnel(opts));
  const good = { tunnel_id: 'tunnel_test', personal_only: true, sole_authorized_user: true, verification_method: 'owner_checked_platform_settings', platform_organization_id: 'org_personal', chatgpt_workspace_id: 'workspace_personal', associated_organizations: ['org_personal'], associated_workspaces: ['workspace_personal'], verified_at: new Date(now - 1000).toISOString(), expires_at: new Date(now + 100000).toISOString() };
  await fs.writeFile(file, JSON.stringify(good), { mode: 0o600 }); assert.equal((await authorizePersonalTunnel(opts)).tunnel_id, 'tunnel_test');
  await assert.rejects(authorizePersonalTunnel({ ...opts, lookup: async () => ({ ...live, workspace_ids: ['workspace_personal', 'shared'] }) }), /LIVE_TUNNEL_ASSOCIATION_MISMATCH/);
  await assert.rejects(authorizePersonalTunnel({ ...opts, lookup: async () => { throw Error('metadata unavailable'); } }));
  for (const bad of [{ personal_only: false }, { sole_authorized_user: false }, { associated_workspaces: ['workspace_personal', 'shared'] }, { expires_at: new Date(now - 1).toISOString() }, { tunnel_id: 'tunnel_wrong' }]) { await fs.writeFile(file, JSON.stringify({ ...good, ...bad })); await assert.rejects(authorizePersonalTunnel(opts)); }
  await fs.writeFile(file, JSON.stringify(good)); await fs.chmod(file, 0o644); await assert.rejects(authorizePersonalTunnel(opts));
});
test('MCP advertises exactly six tools; schema/authorization failures cannot execute', async t => {
  const { c, api } = await setup(t); let allowed = false;
  const server = createServer(c, async () => { if (!allowed) throw Error('private'); });
  const client = new Client({ name: 'local-test', version: '1' }); const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  const list = await client.listTools(); assert.deepEqual(list.tools.map(x => x.name).sort(), ['cleanup_task', 'continue_task', 'get_task', 'publish_task', 'review_task', 'start_task']);
  assert.equal(list.tools.find(x => x.name === 'get_task').annotations.readOnlyHint, true);
  assert.equal(list.tools.find(x => x.name === 'cleanup_task').annotations.destructiveHint, true);
  const input = { name: 'start_task', arguments: { contract: contract(), request_id: 'mcp_request' } };
  assert.equal((await client.callTool(input)).isError, true); assert.equal(api.created.length, 0);
  allowed = true; const result = await client.callTool(input); assert(result.structuredContent.task_id);
  assert.equal((await client.callTool({ name: 'start_task', arguments: {} })).isError, true);
});
test('oversized or symlink evidence fails closed without starting a reviewer', async t => {
  const { c, api } = await setup(t); const x = await started(c); api.completed(x.implementer.session_id);
  const repo = path.join(c.workspaceRoot, x.task_id, 'repo');
  await fs.symlink('/etc/hosts', path.join(repo, 'greeting.txt'));
  await assert.rejects(c.review({ task_id: x.task_id, request_id: 'review_symlink' }), /UNSAFE_WORKSPACE/); assert.equal(api.created.length, 1);
  await fs.unlink(path.join(repo, 'greeting.txt')); await fs.writeFile(path.join(repo, 'greeting.txt'), 'x'.repeat(140000));
  await assert.rejects(c.review({ task_id: x.task_id, request_id: 'review_oversize' }), /OVERSIZE/); assert.equal(api.created.length, 1);
});
test('incomplete or contradictory reviewer JSON cannot become PASS', async t => {
  const { c, api } = await setup(t); const x = await started(c); api.completed(x.implementer.session_id);
  await c.review({ task_id: x.task_id, request_id: 'review_invalid' }); await Promise.all([...c.jobs.values()]);
  const sid = c.task(x.task_id).reviewer.session_id;
  api.completed(sid, JSON.stringify({ overall: 'PASS', findings: [] }));
  assert.equal((await c.get(x.task_id)).reviewer.error, 'INVALID_REVIEW_OUTPUT');
});
test('uncertain event submission is not duplicated and cleanup reports deletion failures', async t => {
  const { c, api, executor } = await setup(t); const x = await started(c); api.pending(x.implementer.session_id);
  const original = api.events.create; let tries = 0;
  api.events.create = async (...args) => { tries++; await original(...args); throw Error('connection lost after acceptance'); };
  const req = { task_id: x.task_id, instruction: 'Example', request_id: 'uncertain_send' };
  await assert.rejects(c.continue(req)); await c.continue(req); assert.equal(tries, 1);
  api.delete = async () => { throw { status: 503 }; };
  const result = await c.cleanup({ task_id: x.task_id }); assert.notEqual(result.state, 'cleaned');
  assert.equal(result.cleanup.implementer.session_deleted, false); assert(executor.stopped.length > 0);
});

test('cleanup verifies workspace deletion and preserves task and audit records', async t => {
  const { c } = await setup(t); const x = await started(c);
  const input = { task_id: x.task_id, delete_workspace: true };
  const result = await c.invoke('cleanup_task', input, { requestId: 'cleanup_audit' }, v => c.cleanup(v));
  const summary = result.cleanup;
  assert.equal(summary.executor_stopped, true);
  assert.equal(summary.remote_session_deleted, true);
  assert.equal(summary.workspace_deletion_requested, true);
  assert.equal(summary.workspace_deleted, true);
  assert.equal(summary.workspace_id, x.task_id);
  assert.equal(summary.workspace_path, path.join(c.workspaceRoot, x.task_id));
  assert.equal(summary.cleanup_diagnostic, null);
  await assert.rejects(fs.lstat(summary.workspace_path), { code: 'ENOENT' });
  assert.deepEqual(c.task(x.task_id).cleanup, summary);
  assert.deepEqual((await c.get(x.task_id)).cleanup, summary);
  const audit = c.db.prepare('SELECT value FROM audit').all().map(r => JSON.parse(r.value));
  assert(audit.some(a => a.task_id === x.task_id && a.tool === 'cleanup_task'));
  const repeated = await c.cleanup(input);
  assert.equal(repeated.cleanup.workspace_deleted, true);
});

for (const failure of ['throws', 'remains', 'verification']) test(`cleanup reports requested workspace deletion when ${failure}`, async t => {
  const { c } = await setup(t); const x = await started(c);
  const workspace = path.join(c.workspaceRoot, x.task_id);
  const originalRm = fs.rm, originalLstat = fs.lstat;
  const rm = t.mock.method(fs, 'rm', async (target, ...args) => {
    if (target !== workspace) return originalRm(target, ...args);
    if (failure === 'throws') throw Error('test-sensitive-value ' + 'x'.repeat(10000));
    // Simulate an incomplete removal, including an unverifiable result.
  });
  const stat = t.mock.method(fs, 'lstat', async (target, ...args) => {
    if (target === workspace && failure === 'verification') throw Object.assign(Error('denied'), { code: 'EACCES' });
    return originalLstat(target, ...args);
  });
  let result;
  try { result = await c.cleanup({ task_id: x.task_id, delete_workspace: true }); }
  finally { rm.mock.restore(); stat.mock.restore(); }
  assert.equal(result.cleanup.executor_stopped, true);
  assert.equal(result.cleanup.remote_session_deleted, true);
  assert.equal(result.cleanup.workspace_deletion_requested, true);
  assert.equal(result.cleanup.workspace_deleted, false);
  assert.match(result.cleanup.cleanup_diagnostic, /WORKSPACE_DELETE_UNCONFIRMED/);
  if (failure === 'throws') assert.match(result.cleanup.cleanup_diagnostic, /WORKSPACE_DELETE_FAILED/);
  if (failure === 'verification') assert.match(result.cleanup.cleanup_diagnostic, /WORKSPACE_VERIFICATION_FAILED/);
  assert(result.cleanup.cleanup_diagnostic.length <= 512);
  assert(!JSON.stringify(result).includes('test-sensitive-value'));
  assert((await fs.lstat(workspace)).isDirectory());
  assert.deepEqual((await c.get(x.task_id)).cleanup, result.cleanup);
  assert.equal((await c.cleanup({ task_id: x.task_id, delete_workspace: true })).cleanup.workspace_deleted, true);
});

test('cleanup retains workspace when deletion is false', async t => {
  const { c } = await setup(t); const x = await started(c);
  const result = await c.cleanup({ task_id: x.task_id, delete_workspace: false });
  assert.equal(result.cleanup.executor_stopped, true);
  assert.equal(result.cleanup.remote_session_deleted, true);
  assert.equal(result.cleanup.workspace_deletion_requested, false);
  assert.equal(result.cleanup.workspace_deleted, false);
  assert.equal(result.cleanup.cleanup_diagnostic, null);
  assert((await fs.lstat(result.cleanup.workspace_path)).isDirectory());
});

test('cleanup reports blocked workspace deletion when executor stop is unconfirmed', async t => {
  const { c, executor } = await setup(t); const x = await started(c);
  executor.stop = async () => false;
  const result = await c.cleanup({ task_id: x.task_id, delete_workspace: true });
  assert.equal(result.cleanup.executor_stopped, false);
  assert.equal(result.cleanup.workspace_deleted, false);
  assert.equal(result.cleanup.workspace_deletion_requested, true);
  assert.match(result.cleanup.cleanup_diagnostic, /EXECUTOR_STOP_UNCONFIRMED/);
  assert.match(result.cleanup.cleanup_diagnostic, /WORKSPACE_DELETE_SKIPPED_RESOURCES_NOT_CLEANED/);
  assert((await fs.lstat(result.cleanup.workspace_path)).isDirectory());
});
