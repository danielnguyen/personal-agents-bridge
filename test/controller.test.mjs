import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, constants as sqlite } from 'node:sqlite';
import { Controller, safeRelative, redact, digest, discloseObservation, taskReportSchema } from '../controller.mjs';
import { authorizePersonalTunnel, createServer } from '../server.mjs';
import { FakeAPI, FakeExecutor, contract } from './helpers.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { repoGit, repositoryIdentity } from '../repositories.mjs';
import { LOCAL_ACTIONABILITY_REVIEW_VERSION, localReviewerInstructions, localActionabilityReviewerInstructions } from '../local-reviewer-instructions.mjs';
import { GitHubPublisher } from '../publication.mjs';

async function setup(t) {
  const root = await fs.mkdtemp('/var/tmp/personal-agents-bridge/unit-');
  const api = new FakeAPI(), executor = new FakeExecutor();
  const c = await new Controller({ stateRoot: path.join(root, 'state'), workspaceRoot: path.join(root, 'work'), api, executor, secrets: ['test-sensitive-value'], timeoutMs: 600000 }).init();
  t.after(async () => { await c.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { c, api, executor, root };
}
async function started(c) { const x = await c.start({ contract: contract(), request_id: 'request_start' }); await Promise.all([...c.jobs.values()]); return await c.get(x.task_id); }

const attemptRows = (c, id) => c.db.prepare('SELECT * FROM automatic_attempts WHERE task_id=? ORDER BY rowid').all(id);
const statusTables = ['tasks', 'audit', 'operations', 'automatic_attempts', 'failures'];
const statusLedger = reader => JSON.stringify(Object.fromEntries(statusTables.map(table => [table, reader.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
async function statusClient(t, c, authorize = async () => {}) {
  const server = createServer(c, authorize), client = new Client({ name: 'status-fixture', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  return { client, get: id => client.callTool({ name: 'get_task', arguments: { task_id: id } }) };
}
async function statusFiles(...roots) {
  const entries = [];
  async function walk(file) {
    const stat = await fs.lstat(file);
    entries.push([file, stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeMs, stat.ctimeMs,
      stat.isFile() ? digest(await fs.readFile(file)) : stat.isSymbolicLink() ? await fs.readlink(file) : null]);
    if (stat.isDirectory()) for (const name of (await fs.readdir(file)).sort()) await walk(path.join(file, name));
  }
  for (const root of roots) await walk(root);
  return JSON.stringify(entries);
}
async function readEvidence(c, id, section, limit = 16000) {
  let cursor, text = '', redacted = false, snapshot;
  do {
    const page = await c.invoke('get_task_evidence', { task_id: id, section, cursor, limit }, {}, input => c.taskEvidence(input));
    assert(Buffer.byteLength(page.content) <= limit);
    assert.equal(page.offset, Buffer.byteLength(text));
    snapshot ||= page.snapshot_sha256; assert.equal(page.snapshot_sha256, snapshot);
    text += page.content; redacted ||= page.redacted; cursor = page.next_cursor || undefined;
  } while (cursor);
  return { data: JSON.parse(text), text, redacted };
}
const disclosureCases = [
  'Authorization: Basic SYNTHETIC_BASIC_CREDENTIAL\r\nX-Trace: ARBITRARY_RAW_LITERAL',
  'Authorization: Digest username="SYNTHETIC_USER", response="SYNTHETIC_RESPONSE"',
  'Proxy-Authorization: Basic SYNTHETIC_PROXY_CREDENTIAL',
  '{"Authorization":["Basic SYNTHETIC_ARRAY_CREDENTIAL"]}',
  '{"Authorizatio\\u006e":"Basic SYNTHETIC_ESCAPED_CREDENTIAL"}',
  '{"nested":[{"pRoXy-AuThOrIzAtIoN":{"credential":"SYNTHETIC_OBJECT_CREDENTIAL"}}]}',
  JSON.stringify(JSON.stringify('{"Authorization":"Basic SYNTHETIC_ENCODED_CREDENTIAL"}')),
  '```json\n{"Authorization":"Basic SYNTHETIC_FENCED_CREDENTIAL"}\n```',
  '{"Authorizatio\\u006e":["Basic SYNTHETIC_MALFORMED_CREDENTIAL"]',
  '{"Authorization":"Basic SYNTHETIC_DUPLICATE_CREDENTIAL","Authorization":"[REDACTED]"}',
  '['.repeat(80) + '"SYNTHETIC_DEEP_CREDENTIAL"' + ']'.repeat(80),
  'SYNTHETIC_OVERSIZED_CREDENTIAL ' + 'x'.repeat(20000),
  'ARBITRARY_RAW_LITERAL without any sensitive key or credential pattern',
];

// Drive the existing Agents API event stream, acknowledging only after the
// Controller has finished processing each event. No status read drives it.
function reportingEvents(api) {
  const streams = new Map();
  api.events.stream = async id => {
    let wake, ended = false;
    const queue = [];
    const stream = { controller: { abort() { ended = true; wake?.(); } },
      async *[Symbol.asyncIterator]() {
        while (!ended) {
          if (!queue.length) await new Promise(resolve => { wake = resolve; });
          if (ended) break;
          const item = queue.shift(); yield item.event; item.done();
        }
      } };
    streams.set(id, { queue, wake: () => wake?.() }); return stream;
  };
  return (id, event) => new Promise(resolve => {
    const stream = streams.get(id); assert(stream, 'Owned session must already have an event stream');
    stream.queue.push({ event, done: resolve }); stream.wake();
  });
}

test('reporting lifecycle persists Agents API pending clarification before observational MCP reads', { timeout: 30000 }, async t => {
  const { c, api } = await setup(t), emit = reportingEvents(api), x = await started(c);
  api.pending(x.implementer.session_id);
  await emit(x.implementer.session_id, { type: 'agent.session.requires_action', session: api.rows.get(x.implementer.session_id) });
  const { get } = await statusClient(t, c), before = statusLedger(c.db), files = await statusFiles(c.stateRoot, c.workspaceRoot);
  const calls = [api.created.length, api.sent.length];
  for (let read = 0; read < 2; read++) {
    const response = await get(x.task_id); assert.notEqual(response.isError, true);
    const status = response.structuredContent;
    assert.equal(status.state, 'waiting_for_clarification');
    assert.equal(status.implementer.clarification_required, true); assert.equal(status.implementer.human_attention_required, true);
    assert(status.next_steps.includes('owner_resolve_attention'));
    assert.equal((await readEvidence(c, x.task_id, 'outcome', 256)).data.state, status.state);
    assert(!JSON.stringify(response).includes('Which name?'));
  }
  assert.equal(statusLedger(c.db), before); assert.equal(await statusFiles(c.stateRoot, c.workspaceRoot), files);
  assert.deepEqual([api.created.length, api.sent.length], calls);
});

test('reporting lifecycle retains qualified Agents API reviewer FAIL without a refreshing status read', { timeout: 30000 }, async t => {
  const { c, api } = await setup(t), emit = reportingEvents(api), x = await started(c);
  api.completed(x.implementer.session_id);
  await emit(x.implementer.session_id, { type: 'agent.session.turn.completed', turn_id: api.rows.get(x.implementer.session_id).turns[0].id });
  await c.review({ task_id: x.task_id, request_id: 'reporting_review' }); await Promise.all([...c.jobs.values()]);
  const sid = c.task(x.task_id).reviewer.session_id;
  api.completed(sid, JSON.stringify({ overall: 'FAIL', findings: ['R1', 'R2', 'I1', 'SCOPE', 'TEST_EVIDENCE'].map(id =>
    ({ id, status: id === 'R2' ? 'FAIL' : 'PASS', evidence: 'ARBITRARY_RAW_LITERAL Authorization: Basic SYNTHETIC_CREDENTIAL' })) }));
  await emit(sid, { type: 'agent.session.turn.completed', turn_id: api.rows.get(sid).turns[0].id });
  const { get } = await statusClient(t, c), before = statusLedger(c.db), files = await statusFiles(c.stateRoot, c.workspaceRoot);
  const calls = [api.created.length, api.sent.length];
  for (const method of ['save', 'observe', 'publish', 'continue', 'review', 'repositoryEvidence']) c[method] = () => assert.fail(`Reporting cannot invoke ${method}`);
  api.retrieve = api.items.list = api.turns.list = () => assert.fail('Reporting cannot refresh API facts');
  for (let read = 0; read < 2; read++) {
    const response = await get(x.task_id); assert.notEqual(response.isError, true); noRaw(response);
    assert.equal(response.structuredContent.reviewer.overall, 'FAIL');
    assert.deepEqual(response.structuredContent.explanation.failed_requirements, ['R2']);
    for (const section of ['outcome', 'implementer', 'validation', 'review', 'candidate', 'history']) {
      const result = await readEvidence(c, x.task_id, section, 256); noRaw(result.text);
      if (section === 'review') { assert.equal(result.data.overall, 'FAIL'); assert.equal(result.data.findings[1].id, 'R2'); }
    }
  }
  assert.equal(statusLedger(c.db), before); assert.equal(await statusFiles(c.stateRoot, c.workspaceRoot), files);
  assert.deepEqual([api.created.length, api.sent.length], calls);
});

for (const mode of ['missing_findings', 'contradictory', 'truncated', 'packet_changed', 'unverified_event'])
test(`reporting lifecycle does not qualify Agents API ${mode} reviewer output`, { timeout: 30000 }, async t => {
  const { c, api } = await setup(t), emit = reportingEvents(api), x = await started(c);
  api.completed(x.implementer.session_id);
  await c.review({ task_id: x.task_id, request_id: 'reporting_invalid_review' }); await Promise.all([...c.jobs.values()]);
  const ref = c.task(x.task_id).reviewer;
  const output = { overall: 'PASS', findings: ['R1', 'R2', 'I1', 'SCOPE', 'TEST_EVIDENCE'].map(id =>
    ({ id, status: 'PASS', evidence: 'ARBITRARY_RAW_LITERAL' })) };
  if (mode === 'missing_findings') output.findings.pop();
  if (mode === 'contradictory') output.findings[0].status = 'FAIL';
  if (mode === 'packet_changed') {
    const file = path.join(c.workspaceRoot, x.task_id, ref.packet_directory, 'evidence.json');
    await fs.chmod(file, 0o600); await fs.appendFile(file, ' ');
  }
  if (mode !== 'unverified_event') api.completed(ref.session_id, (mode === 'truncated' ? ' '.repeat(16001) : '') + JSON.stringify(output));
  await emit(ref.session_id, { type: 'agent.session.turn.completed', turn_id: api.rows.get(ref.session_id).turns[0].id,
    turn: { status: 'completed' }, output: JSON.stringify(output) });
  const before = statusLedger(c.db), status = await c.reportTask(x.task_id), review = (await readEvidence(c, x.task_id, 'review', 256)).data;
  noRaw(status); noRaw(review);
  assert.equal(status.reviewer.overall, null); assert.equal(review.overall, null); assert.equal(review.unavailable, true);
  assert.deepEqual(status.explanation.failed_requirements, []); assert.equal(status.remaining_authority.execution_authorized, false);
  if (mode === 'unverified_event') assert.equal(status.reviewer.state, 'running');
  else { assert.equal(status.reviewer.state, 'needs_attention'); assert.equal(status.reviewer.error, 'INVALID_REVIEW_OUTPUT');
    assert.equal(status.reviewer.human_attention_required, true); assert(status.next_steps.includes('owner_resolve_attention')); }
  assert.equal(statusLedger(c.db), before);
});

test('reporting lifecycle takes clarification from verified API state rather than an event claim', { timeout: 30000 }, async t => {
  const { c, api } = await setup(t), emit = reportingEvents(api), x = await started(c);
  await emit(x.implementer.session_id, { type: 'agent.session.requires_action', session: { status: 'requires_action',
    required_actions: [{ type: 'function_call', name: 'request_clarification', arguments: { question: 'ARBITRARY_RAW_LITERAL' } }] } });
  assert.equal((await c.reportTask(x.task_id)).implementer.clarification_required, false);
  api.pending(x.implementer.session_id);
  await emit(x.implementer.session_id, { type: 'agent.session.requires_action' });
  await c.continue({ task_id: x.task_id, instruction: 'Example', request_id: 'reporting_answer' });
  await emit(x.implementer.session_id, { type: 'agent.session.requires_action' });
  const status = await c.reportTask(x.task_id);
  assert.equal(status.state, 'running'); assert.equal(status.implementer.clarification_required, false);
  assert.equal(status.implementer.human_attention_required, false); assert(!status.next_steps.includes('owner_resolve_attention'));
});

test('reporting lifecycle stream attachment reconciles pending API state after restart before status reads', { timeout: 30000 }, async t => {
  const { c, api, executor } = await setup(t), x = await started(c);
  api.pending(x.implementer.session_id); await c.close();
  const emit = reportingEvents(api);
  const recovered = await new Controller({ stateRoot: c.stateRoot, workspaceRoot: c.workspaceRoot, api, executor, secrets: [] }).init();
  t.after(() => recovered.close());
  // A non-lifecycle event is only a stream-consumption barrier. It cannot
  // trigger viewRole: attachment itself must have persisted the API snapshot.
  await emit(x.implementer.session_id, { type: 'agent.session.output_text.delta', delta: 'ARBITRARY_RAW_LITERAL' });
  const before = statusLedger(recovered.db), files = await statusFiles(recovered.stateRoot, recovered.workspaceRoot);
  api.retrieve = api.items.list = api.turns.list = () => assert.fail('Reporting cannot refresh after restart');
  const status = await recovered.reportTask(x.task_id);
  assert.equal(status.state, 'waiting_for_clarification'); assert.equal(status.implementer.human_attention_required, true); noRaw(status);
  assert.equal((await readEvidence(recovered, x.task_id, 'outcome', 256)).data.state, status.state);
  assert.equal(statusLedger(recovered.db), before); assert.equal(await statusFiles(recovered.stateRoot, recovered.workspaceRoot), files);
  assert.equal(api.created.length, 1); assert.equal(api.sent.length, 1);
  await recovered.close();
});

function noRaw(value) {
  const text = JSON.stringify(value);
  for (const fragment of ['SYNTHETIC_', 'CREDENTIAL', 'ARBITRARY_RAW_LITERAL']) assert(!text.includes(fragment), `Raw content escaped disclosure: ${fragment}`);
}

test('typed disclosure uses the pinned library only for bounded decoded observation metadata', () => {
  for (const key of ['Authorization', 'pRoXy-AuThOrIzAtIoN', 'Authorizatio\u006e']) for (const payload of
    ['Basic SYNTHETIC_CREDENTIAL', ['SYNTHETIC_CREDENTIAL'], { nested: 'SYNTHETIC_CREDENTIAL' }]) {
    const input = { [key]: payload, text: 'ARBITRARY_RAW_LITERAL', exit_code: 7, command_index: 2, status: 'failed' };
    const before = JSON.stringify(input), result = discloseObservation(input);
    noRaw(result); assert.equal(result.exit_code, 7); assert.equal(result.withheld, true); assert.equal(result.status, 'failed');
    assert.equal(JSON.stringify(input), before, 'Library must not mutate retained input');
  }
  for (const payload of [{ nodes: Array(2200).fill({ x: 'SYNTHETIC_CREDENTIAL' }) },
    JSON.parse('['.repeat(80) + '{}' + ']'.repeat(80))]) {
    const result = discloseObservation({ metadata: payload }); noRaw(result);
    assert.equal(result.reason, 'UNSUPPORTED_OR_EXCESSIVE_WITHHELD');
  }
  assert.equal(discloseObservation('ARBITRARY_RAW_LITERAL').withheld, true);
  assert.equal(discloseObservation(null).unavailable, true);
  // Arbitrary strings cannot masquerade as metadata, even with familiar keys.
  noRaw(discloseObservation({ exit_code: 'SYNTHETIC_CREDENTIAL', status: 'ARBITRARY_RAW_LITERAL', redacted: 'SYNTHETIC_CREDENTIAL' }));
});

test('typed task evidence explains historical FAIL and withholds original detail through cleanup and restart', async t => {
  const { c, id, calls, publisherCalls, root } = await automaticAttempt(t, { versioned: true });
  const task = c.task(id); delete task.evidence_contract;
  task.local_validation.results = [{ provenance: 'controller_process_observation', command_index: 0, command: 'ARBITRARY_RAW_LITERAL',
    exit_code: 7, completion_observed: true, independently_observed: true, stdout: { text: 'SYNTHETIC_CREDENTIAL', truncated: true } }];
  c.save(task);
  const summary = await c.reportTask(id); noRaw(summary);
  assert(summary.explanation.failed_requirements.includes('R1')); assert.equal(summary.explanation.failed_validation_commands[0].exit_code, 7);
  const review = (await readEvidence(c, id, 'review', 256)).data;
  assert.equal(review.overall, 'FAIL'); assert.equal(review.findings[0].id, 'R1'); assert(review.findings[0].evidence.withheld);
  assert.equal(review.findings[0].classification.kind, 'implementation_defect');
  const validation = (await readEvidence(c, id, 'validation')).data;
  assert.equal(validation.results[0].exit_code, 7); assert(validation.results[0].stdout.withheld); noRaw(validation);
  const candidate = (await readEvidence(c, id, 'candidate', 256)).data;
  assert.equal(candidate.reviewed_git_state.tree_sha, task.reviewer.reviewed_git_state.tree_sha);
  assert(candidate.files[0].content.withheld); assert.equal(candidate.files[0].path, undefined);
  assert.equal(candidate.execution_authorized, false); assert.equal(candidate.files[0].candidate, undefined);
  await c.cleanup({ task_id: id, delete_workspace: true });
  assert.deepEqual((await readEvidence(c, id, 'candidate')).data, candidate);
  await c.close();
  const recovered = await new Controller({ stateRoot: path.join(root, 'state'), workspaceRoot: path.join(root, 'work'),
    api: new FakeAPI(), executor: new FakeExecutor(), localBackendFactory: () => assert.fail('Read cannot execute a model') }).init();
  try {
    const before = statusLedger(recovered.db), files = await statusFiles(recovered.stateRoot, recovered.workspaceRoot);
    for (let count = 0; count < 2; count++) {
      assert.equal((await recovered.reportTask(id)).state, 'cleaned');
      assert.deepEqual((await readEvidence(recovered, id, 'candidate')).data, candidate);
      assert.equal((await readEvidence(recovered, id, 'review')).data.overall, 'FAIL');
    }
    assert.equal(statusLedger(recovered.db), before); assert.equal(await statusFiles(recovered.stateRoot, recovered.workspaceRoot), files);
  } finally { await recovered.close(); }
  assert.deepEqual(calls, ['implementer', 'reviewer']); assert.deepEqual(publisherCalls, []);
});

test('typed disclosure withholds every raw fixture from both MCP surfaces, every section and every page without mutations', async t => {
  const { c, id, calls, publisherCalls, normal } = await automaticAttempt(t, { versioned: true });
  const { client, get } = await statusClient(t, c);
  for (const payload of disclosureCases) {
    const task = c.task(id), result = task.reviewer.review_result;
    const packet = JSON.parse(attemptRows(c, id).map(row => JSON.parse(row.value)).find(record => record.packet_utf8).packet_utf8);
    packet.current['greeting.txt'] = payload; packet.diff = payload;
    const text = JSON.stringify(packet); task.reviewer.packet_hash = digest(text); task.retained_packet = { text, sha256: digest(text) };
    result.packet_hash = task.reviewer.packet_hash; result.findings[0].evidence = payload;
    result.findings[0].classification.remedy.description = payload;
    task.reviewer.findings_sha256 = digest(result);
    task.reviewer.received_review_output.output = payload; task.reviewer.received_output_sha256 = digest(task.reviewer.received_review_output);
    task.implementer.evidence_messages = [{ provenance: 'model_statement', text: payload, redacted: true, truncated: true }];
    task.implementer.local.latest_model_output = payload; task.implementer.error = payload; task.implementer.local.diagnostics = [payload];
    task.local_execution_evidence.commands = [{ exit_code: 7, command: { value: payload }, output: { value: payload, redacted: true } }];
    task.implementer.evidence_commands = [{ command: { text: payload }, output: { text: payload }, stdout: { text: payload }, stderr: { text: payload }, exit_code: 7 }];
    task.local_validation.results = [{ command: payload, exit_code: 7, stdout: { text: payload, redacted: true }, stderr: { text: payload } }];
    task.automatic.reason = payload; task.automatic.authorization.publish.body = payload;
    task.previous_reviewers = [{ ...task.reviewer, independent_validation: task.local_validation }];
    // Existing private records can contain raw output, even when marked redacted.
    c.db.prepare('UPDATE tasks SET value=? WHERE id=?').run(JSON.stringify(task), id);
    const before = statusLedger(c.db), files = await statusFiles(c.stateRoot, c.workspaceRoot, normal);
    for (let read = 0; read < 2; read++) {
      const status = await get(id); assert.notEqual(status.isError, true); noRaw(status);
      assert.equal(status.structuredContent.disclosure, 'typed_metadata_only');
      for (const section of ['outcome', 'implementer', 'validation', 'review', 'candidate', 'history']) {
        let cursor, joined = '', pages = 0;
        do {
          const response = await client.callTool({ name: 'get_task_evidence', arguments: { task_id: id, section, limit: 256, ...(cursor ? { cursor } : {}) } });
          assert.notEqual(response.isError, true); noRaw(response);
          const page = response.structuredContent; assert(page.redacted); assert(Buffer.byteLength(page.content) <= 256);
          joined += page.content; cursor = page.next_cursor; pages++;
        } while (cursor);
        noRaw(joined); const data = JSON.parse(joined); assert.equal(data.disclosure, 'typed_metadata_only');
        assert(pages > 1); if (section === 'review') assert.equal(data.overall, 'FAIL');
      }
    }
    assert.equal(statusLedger(c.db), before); assert.equal(await statusFiles(c.stateRoot, c.workspaceRoot, normal), files);
  }
  assert.deepEqual(calls, ['implementer', 'reviewer']); assert.deepEqual(publisherCalls, []);
});

test('typed disclosure preserves private raw evidence and authority without qualifying incomplete reviewer receipts', async t => {
  const payload = 'Authorization: Basic SYNTHETIC_CREDENTIAL';
  const { c, id, calls, publisherCalls } = await automaticAttempt(t, { versioned: true, output(output) { output.findings[0].evidence = payload; } });
  const task = c.task(id), authority = JSON.stringify(task.automatic.authorization);
  assert(task.reviewer.received_review_output.output.includes('SYNTHETIC_CREDENTIAL'));
  c.retainTaskMessage(task, 'implementer', 'ARBITRARY_RAW_LITERAL'); c.save(task);
  const before = statusLedger(c.db); noRaw(await c.reportTask(id)); noRaw(await readEvidence(c, id, 'review'));
  assert.equal(statusLedger(c.db), before); assert.equal(JSON.stringify(c.task(id).automatic.authorization), authority);
  assert.equal(c.task(id).implementer.evidence_messages[0].text, 'ARBITRARY_RAW_LITERAL');
  task.reviewer.received_review_output.complete = false;
  task.reviewer.received_output_sha256 = digest(task.reviewer.received_review_output);
  c.db.prepare('UPDATE tasks SET value=? WHERE id=?').run(JSON.stringify(task), id);
  const review = (await readEvidence(c, id, 'review')).data;
  assert.equal(review.overall, null); assert(review.unavailable); assert.equal(review.model_output.qualified, false);
  assert.deepEqual(calls, ['implementer', 'reviewer']); assert.deepEqual(publisherCalls, []);
});

test('typed get_task reads manual and automatic tasks without saving, API observation, validation or authority changes', async t => {
  const { c, api, executor } = await setup(t), started = await c.start({ contract: contract(), request_id: 'manual_reporting' });
  await Promise.all([...c.jobs.values()]);
  const id = started.task_id, task = c.task(id); task.implementer.state = 'failed';
  c.db.prepare('UPDATE tasks SET value=? WHERE id=?').run(JSON.stringify(task), id);
  const { get } = await statusClient(t, c);
  const before = statusLedger(c.db), files = await statusFiles(c.stateRoot, c.workspaceRoot);
  const mocks = ['save', 'observe', 'recordFailure', 'repositoryEvidence', 'runLocalValidation', 'runCorrection', 'publish'].map(name =>
    t.mock.method(c, name, () => assert.fail(`Read cannot call ${name}`)));
  const activity = [api.created.length, api.sent.length, executor.started.length];
  try {
    for (let read = 0; read < 3; read++) { const result = await get(id); assert.notEqual(result.isError, true); assert.equal(result.structuredContent.state, 'failed'); }
    assert.equal(statusLedger(c.db), before); assert.equal(await statusFiles(c.stateRoot, c.workspaceRoot), files);
    assert.deepEqual([api.created.length, api.sent.length, executor.started.length], activity);
  } finally { for (const mock of mocks) mock.mock.restore(); }
});

for (const state of ['PASS', 'needs_attention', 'uncertain', 'interrupted', 'expired', 'publication', 'correction'])
test(`typed task evidence explains ${state} outcomes with no historical authority`, async t => {
  const { c, id } = await automaticAttempt(t, { versioned: true }); const task = c.task(id);
  if (state === 'PASS') { task.reviewer.review_result.overall = 'PASS'; task.reviewer.findings_sha256 = digest(task.reviewer.review_result); }
  else if (state === 'expired') task.deadline = 1;
  else if (state === 'publication') { task.publication = { phase: 'pr_attempted', pr_attempted: true }; task.publication_error = 'PR_RESPONSE_UNCONFIRMED'; }
  else if (state === 'correction') task.automatic.correction = { task_id: id, parent_task_id: id, rejected_tree_sha: task.reviewer.reviewed_git_state.tree_sha };
  else { task.automatic.status = state; task.automatic.reason = state === 'needs_attention' ? 'LOCAL_HUMAN_ATTENTION_REQUIRED' : 'AUTOMATIC_RESTART_NO_REPLAY'; }
  c.db.prepare('UPDATE tasks SET value=? WHERE id=?').run(JSON.stringify(task), id);
  const before = statusLedger(c.db), outcome = (await readEvidence(c, id, 'outcome')).data;
  assert.equal(outcome.execution_authorized, false);
  if (state === 'PASS') assert.equal((await readEvidence(c, id, 'review')).data.overall, 'PASS');
  else if (state === 'expired') assert(outcome.expired_now);
  else if (state === 'publication') assert.equal(outcome.publication_error, 'PR_RESPONSE_UNCONFIRMED');
  else if (state === 'correction') assert.equal(outcome.correction.task_id, id);
  else { assert.equal(outcome.state, state); assert.equal(outcome.reason, task.automatic.reason); }
  assert.equal(statusLedger(c.db), before);
});

test('typed task evidence keeps actionable findings separate from currently remaining authority', async t => {
  const { c, id } = await automaticAttempt(t, { versioned: true }); const before = statusLedger(c.db);
  const status = await c.reportTask(id), review = (await readEvidence(c, id, 'review')).data;
  assert.equal(review.findings[0].classification.kind, 'implementation_defect');
  assert.equal(status.automatic.review.potentially_correctable, true);
  assert(status.next_steps.includes('request_new_task')); assert.equal(status.automatic.review.execution_authorized, false);
  assert.equal(status.remaining_authority.remaining_corrections, 0); assert.equal(status.remaining_authority.execution_authorized, false);
  assert.equal(status.automatic.limits.max_codex_turns, c.task(id).automatic.authorization.max_codex_turns);
  assert.equal(status.automatic.limits.publish, undefined); assert.equal(statusLedger(c.db), before);
});

test('typed task evidence preserves pagination, ownership, snapshot binding and strict MCP authorization', async t => {
  const { c, id } = await automaticAttempt(t, { versioned: true }); const task = c.task(id);
  c.retainTaskMessage(task, 'implementer', 'ARBITRARY_RAW_LITERAL'); c.save(task);
  const first = await c.taskEvidence({ task_id: id, section: 'implementer', limit: 256 }); assert(first.next_cursor);
  await assert.rejects(c.taskEvidence({ task_id: id, section: 'review', cursor: first.next_cursor }), /INVALID_EVIDENCE_CURSOR/);
  const other = await c.start({ contract: contract(), request_id: 'evidence_other' }); await Promise.all([...c.jobs.values()]);
  await assert.rejects(c.taskEvidence({ task_id: other.task_id, section: 'implementer', cursor: first.next_cursor }), /INVALID_EVIDENCE_CURSOR/);
  c.retainTaskMessage(task, 'implementer', 'Changed retained output'); c.save(task);
  await assert.rejects(c.taskEvidence({ task_id: id, section: 'implementer', cursor: first.next_cursor }), /EVIDENCE_CHANGED_RESTART_PAGINATION/);
  for (const limit of [0, 255, 16001, 1.5]) await assert.rejects(c.taskEvidence({ task_id: id, limit }), /INVALID_EVIDENCE_REQUEST/);
  const { client } = await statusClient(t, c, async () => { throw Error('Denied'); });
  assert((await client.callTool({ name: 'get_task', arguments: { task_id: id } })).isError);
  assert((await client.callTool({ name: 'get_task_evidence', arguments: { task_id: id } })).isError);
  const allowed = await statusClient(t, c);
  for (const args of [{ path: '/private/auth.json' }, { command: 'true' }, { section: 'private' }, { limit: 16001 }]) {
    assert((await allowed.client.callTool({ name: 'get_task_evidence', arguments: { task_id: id, ...args } })).isError);
  }
  await assert.rejects(c.taskEvidence({ task_id: id, packet_sha256: 'a'.repeat(64), section: 'review' }), /EVIDENCE_ATTEMPT_UNAVAILABLE/);
});

test('typed task evidence reports missing packets, changed Git bindings and missing historical output without reading live source', async t => {
  const { c, id } = await automaticAttempt(t, { versioned: true }); const task = c.task(id);
  const original = (await readEvidence(c, id, 'candidate')).data;
  await fs.writeFile(path.join(c.workspaceRoot, id, 'repo/greeting.txt'), 'ARBITRARY_RAW_LITERAL');
  assert.deepEqual((await readEvidence(c, id, 'candidate')).data, original);
  task.reviewer.reviewed_git_state.tree_sha = 'a'.repeat(40);
  c.db.prepare('UPDATE tasks SET value=? WHERE id=?').run(JSON.stringify(task), id);
  assert((await readEvidence(c, id, 'candidate')).data.unavailable);
  delete task.reviewer; delete task.local_validation;
  c.db.prepare('UPDATE tasks SET value=? WHERE id=?').run(JSON.stringify(task), id);
  assert((await readEvidence(c, id, 'candidate')).data.unavailable);
  assert((await readEvidence(c, id, 'review')).data.unavailable);
  assert((await readEvidence(c, id, 'validation')).data.unavailable);
  assert((await readEvidence(c, id, 'implementer')).data.messages_unavailable);
});

test('typed task evidence fails closed on unresolved storage without repairing it', async t => {
  const { c, id } = await automaticAttempt(t, { versioned: true });
  c.db.exec('BEGIN'); const before = statusLedger(c.db);
  try { const result = await readEvidence(c, id, 'review'); assert(result.data.unavailable); assert(result.data.retention_uncertain); assert.equal(statusLedger(c.db), before); }
  finally { c.db.exec('ROLLBACK'); }
});

test('typed boundary additional schemas discard unknown fields and preserve only typed authority', () => {
  const raw = { task_id: 'task_00000000-0000-0000-0000-000000000001', state: 'failed', execution_backend: 'local_codex',
    implementer: { state: 'failed', error: 'ARBITRARY_RAW_LITERAL', latest_output: 'SYNTHETIC_CREDENTIAL' }, reviewer: null,
    cleanup: { workspace_path: '/private/SYNTHETIC_CREDENTIAL' }, expires_at: null, arbitrary: 'ARBITRARY_RAW_LITERAL',
    automatic: { status: 'stopped', phase: 'implementation', limits: { max_duration_seconds: 120, max_codex_turns: 2, max_corrections: 0,
      publish: { draft: true, title: 'SYNTHETIC_CREDENTIAL' } }, review: { state: 'pass', execution_authorized: true, blockers: ['SYNTHETIC_CREDENTIAL'] } } };
  const before = JSON.stringify(raw), result = taskReportSchema.parse(raw);
  noRaw(result); assert.equal(result.automatic.limits.max_codex_turns, 2); assert.equal(result.automatic.limits.publish, undefined);
  assert.equal(result.automatic.review.execution_authorized, false); assert.equal(result.implementer.error, 'UNCLASSIFIED_WITHHELD');
  assert.equal(JSON.stringify(raw), before);
  const findings = { packet_hash: 'a'.repeat(64), overall: 'FAIL', model_overall: 'PASS', controller_overrides: ['TEST_EVIDENCE'],
    findings: [{ id: 'TEST_EVIDENCE', status: 'FAIL', evidence: 'SYNTHETIC_CREDENTIAL' }] };
  const review = Controller.prototype.discloseReview({ packet_hash: findings.packet_hash, review_result: findings,
    findings_sha256: digest(findings) }, contract());
  assert.equal(review.overall, 'FAIL'); assert.equal(review.model_overall, 'PASS');
  assert.deepEqual(review.controller_overrides, ['TEST_EVIDENCE']); assert.equal(review.current_authority_verified, false); noRaw(review);
});

test('typed boundary additional candidate metadata fails closed on missing, changed and symlink packets', async t => {
  const { c, id } = await automaticAttempt(t, { versioned: true }), task = c.task(id);
  delete task.retained_packet; delete task.reviewer.retained_packet;
  c.db.prepare('UPDATE tasks SET value=? WHERE id=?').run(JSON.stringify(task), id);
  c.db.prepare('DELETE FROM automatic_attempts WHERE task_id=?').run(id);
  assert.equal((await readEvidence(c, id, 'candidate')).data.unavailable, false);
  const file = path.join(c.workspaceRoot, id, task.reviewer.packet_directory, 'evidence.json');
  await fs.chmod(file, 0o600); await fs.writeFile(file, '{}');
  assert((await readEvidence(c, id, 'candidate')).data.unavailable);
  await fs.unlink(file); assert((await readEvidence(c, id, 'candidate')).data.unavailable);
  await fs.symlink(path.join(c.workspaceRoot, id, 'contract.json'), file);
  assert((await readEvidence(c, id, 'candidate')).data.unavailable);
  task.reviewer.packet_directory = '../../private'; c.db.prepare('UPDATE tasks SET value=? WHERE id=?').run(JSON.stringify(task), id);
  assert((await readEvidence(c, id, 'candidate')).data.unavailable);
});

test('typed boundary additional history selects only the owning task packet without restoring authority', async t => {
  const { c, id, calls } = await automaticAttempt(t, { versioned: true }), task = c.task(id), original = task.reviewer.packet_hash;
  task.reviewer = { ...task.reviewer, packet_hash: 'a'.repeat(64), review_result: null };
  c.db.prepare('UPDATE tasks SET value=? WHERE id=?').run(JSON.stringify(task), id);
  assert((await readEvidence(c, id, 'candidate')).data.unavailable);
  const before = statusLedger(c.db);
  for (const section of ['candidate', 'review', 'validation']) {
    const data = JSON.parse((await c.taskEvidence({ task_id: id, section, packet_sha256: original })).content);
    if (section === 'candidate') { assert.equal(data.unavailable, false); assert.equal(data.execution_authorized, false); }
    if (section === 'review') { assert.equal(data.overall, 'FAIL'); assert.equal(data.current_authority_verified, false); }
    noRaw(data);
  }
  assert.equal(statusLedger(c.db), before);
  const other = await c.start({ contract: contract(), request_id: 'other_packet_owner' }); await Promise.all([...c.jobs.values()]);
  await assert.rejects(c.taskEvidence({ task_id: other.task_id, section: 'review', packet_sha256: original }), /EVIDENCE_ATTEMPT_UNAVAILABLE/);
  assert.deepEqual(calls, ['implementer', 'reviewer']);
});

async function automaticAttempt(t, mode = {}) {
  const value = await setup(t), { c, root } = value, normal = path.join(root, 'normal'), calls = [];
  let active;
  const reviewerActive = new Promise(resolve => active = resolve), stops = [], prompts = [], publisherCalls = [], submissions = [];
  await fs.mkdir(normal); repoGit(normal, 'init', '--initial-branch=main');
  await fs.writeFile(path.join(normal, 'greeting.txt'), 'baseline\n'); repoGit(normal, 'add', '.');
  if (mode.referenceFile) { await fs.writeFile(path.join(normal, 'policy.txt'), 'Original reference\n'); repoGit(normal, 'add', 'policy.txt'); }
  repoGit(normal, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'baseline');
  await fs.writeFile(path.join(c.stateRoot, 'repositories.json'), JSON.stringify({ version: 1, repositories: { fixture: await repositoryIdentity(normal) } }), { mode: 0o600 });
  c.publisher = { async target() { publisherCalls.push('target'); throw Error('Publication forbidden for failed review'); } };
  let implementations = 0, reviews = 0;
  c.localBackendFactory = options => {
    const corrective = !options.reviewOnly && implementations++ > 0;
    const correctiveReview = options.reviewOnly && reviews++ > 0;
    let stopped;
    const wait = new Promise(resolve => stopped = resolve);
    return {
    async run(input) {
      calls.push(correctiveReview ? 'corrective-reviewer' : options.reviewOnly ? 'reviewer' : corrective ? 'corrector' : 'implementer');
      if (correctiveReview) {
        await mode.beforeCorrectiveReview?.(c, options, input);
        options.onLifecycle({ phase: 'model_selected', model: 'fixture-model' });
        options.onLifecycle({ phase: 'thread_acknowledged', model: 'fixture-model', threadId: mode.correctiveReviewThread || 'corrective-review-thread' });
        options.onLifecycle({ phase: 'turn_submitting', model: 'fixture-model', threadId: 'corrective-review-thread', turnSubmissionAttempted: true });
        submissions.push('corrective-reviewer');
        if (mode.correctiveReviewAckUnknown) return { status: 'uncertain', authentication: 'chatgpt', threadId: 'corrective-review-thread', turnSubmissionAttempted: true, uncertainties: ['UNKNOWN_ACK'], messages: [] };
        if (mode.activeCorrectiveReviewer) { active(); await wait; return { status: 'interrupted', authentication: 'chatgpt', messages: [], uncertainties: ['INTERRUPTED'] }; }
      }
      if (corrective) {
        await mode.beforeCorrection?.(c, options, input);
        assert.equal(await fs.readFile(path.join(options.cwd, 'greeting.txt'), 'utf8'), 'candidate\n');
        assert.equal(input.threadId, undefined);
        assert.deepEqual(input.allowedFiles, contract().allowed_files);
        options.onLifecycle({ phase: 'model_selected', model: mode.wrongModel ? 'other-model' : 'fixture-model' });
        options.onLifecycle({ phase: 'thread_acknowledged', model: 'fixture-model', threadId: mode.reuseThread ? 'implement-thread' : 'correct-thread' });
        options.onLifecycle({ phase: 'turn_submitting', model: 'fixture-model', threadId: 'correct-thread', turnSubmissionAttempted: true });
        submissions.push('corrector');
        if (mode.ackUnknown) return { status: 'uncertain', authentication: 'chatgpt', threadId: 'correct-thread', turnSubmissionAttempted: true, uncertainties: ['UNKNOWN_ACK'], messages: [] };
        if (mode.activeCorrection) { active(); await wait; return { status: 'interrupted', authentication: 'chatgpt', messages: [], uncertainties: ['INTERRUPTED'] }; }
      }
      if (options.reviewOnly) prompts.push(input.prompt);
      const identity = { model: corrective && mode.wrongModel ? 'other-model' : 'fixture-model', threadId: correctiveReview ? 'corrective-review-thread' : options.reviewOnly ? 'review-thread' : corrective ? 'correct-thread' : 'implement-thread', turnId: correctiveReview ? mode.correctiveReviewTurn || 'corrective-review-turn' : corrective && !mode.reuseTurn ? 'correct-turn' : mode.postReview ? options.reviewOnly ? mode.originalReviewTurn || 'review-turn' : 'implement-turn' : 'fixture-turn',
        turnSubmissionAttempted: true, turnSubmissionAcknowledged: true, terminalObserved: true };
      options.onLifecycle({ ...identity, terminalObserved: false, phase: 'turn_acknowledged' });
      if (corrective && mode.correctiveHuman) {
        options.onLifecycle({ ...identity, terminalObserved: false, phase: 'human_request', request: { id: 'approval', method: 'item/commandExecution/requestApproval',
          params: { threadId: identity.threadId, turnId: identity.turnId, command: 'unsupported operation', reason: 'Human decision required' } } });
        return { ...identity, status: 'interrupted', authentication: 'chatgpt', terminalObserved: false, messages: [], uncertainties: ['HUMAN_REQUIRED'] };
      }
      if (options.reviewOnly && mode.activeReviewer) {
        active(); await wait;
        return { ...identity, terminalObserved: false, status: 'uncertain', authentication: 'chatgpt', uncertainties: ['INTERRUPTION_UNCONFIRMED'], messages: [] };
      }
      if (!options.reviewOnly) await fs.writeFile(path.join(options.cwd, 'greeting.txt'), corrective ? 'corrected\n' : 'candidate\n');
      options.onLifecycle({ ...identity, phase: 'terminal_observed', status: 'completed' });
      const findings = ['R1', 'R2', 'I1', 'SCOPE', 'TEST_EVIDENCE'].map(id => ({ id, status: id === 'R1' ? 'FAIL' : 'PASS',
        evidence: id === 'R1' ? 'greeting.txt contains candidate; replace it with the required greeting.' : 'Synthetic complete evidence assessment.' }));
      const output = mode.versioned ? { format: LOCAL_ACTIONABILITY_REVIEW_VERSION, overall: 'FAIL', findings: findings.map(finding => ({ ...finding,
        classification: finding.status === 'PASS' ? null : mode.cause && mode.cause !== 'implementation_defect' ? { kind: mode.cause } :
          { kind: 'implementation_defect', target_files: ['greeting.txt'], remedy: { kind: 'edit_files', description: mode.remedy || 'Replace the incorrect greeting.', requires_human_approval: !!mode.humanApproval } } })) } : { overall: 'FAIL', findings };
      if (options.reviewOnly) { mode.output?.(output); await mode.beforeResult?.(c, options); }
      if ((correctiveReview && !mode.correctiveReviewFail) || (!correctiveReview && mode.originalPass)) { output.overall = 'PASS'; for (const finding of output.findings) { finding.status = 'PASS'; if (mode.versioned) finding.classification = null; } }
      if (correctiveReview) mode.correctiveOutput?.(output);
      const text = (mode.incomplete || (correctiveReview && mode.correctiveReviewMalformed)) ? '{"overall":"FAIL","findings":[]}' : JSON.stringify(output);
      if (options.reviewOnly) mode.returnedOutput?.(text);
      return { ...identity, status: 'completed', authentication: 'chatgpt', uncertainties: options.reviewOnly && mode.uncertain ? ['Unknown execution'] : [],
        ...(options.reviewOnly ? mode.result : {}),
        messages: options.reviewOnly && !(correctiveReview && mode.correctiveReviewMissing) ? [{ provenance: 'reasoning', text: 'Private reasoning must not be retained.' }, { provenance: 'model', text }] : [] };
    }, async close() { if ((options.reviewOnly && mode.activeReviewer) || (corrective && mode.activeCorrection) || (correctiveReview && mode.activeCorrectiveReviewer)) { stops.push('close'); stopped(); return mode.closeResult ?? true; } return (corrective && mode.correctiveCloseUncertain) || (correctiveReview && mode.correctiveReviewerCloseUncertain) ? false : true; },
    async cancel() { if ((options.reviewOnly && mode.activeReviewer) || (corrective && mode.activeCorrection) || (correctiveReview && mode.activeCorrectiveReviewer)) { stops.push('cancel'); stopped(); return mode.cancelResult ?? true; } },
  }; };
  if (mode.validationFailure) c.localValidationFactory = () => ({ terminationConfirmed: true, async run() { throw Error('Synthetic validator failure'); }, cancel() {} });
  if (mode.activeCorrectiveValidation) {
    const factory = c.localValidationFactory; let release;
    const waiting = new Promise(resolve => { release = resolve; });
    c.localValidationFactory = options => c.task(path.basename(options.root)).correction ? {
      terminationConfirmed: false, async run() { active(); await waiting; },
      cancel() { stops.push('validation.cancel'); this.terminationConfirmed = !mode.validationTerminationUncertain; release(); },
    } : factory(options);
  }
  if (mode.beforeDispatch) {
    const run = c.runCorrection.bind(c);
    c.runCorrection = async id => { await mode.beforeDispatch(c, id); return run(id); };
  }
  if (mode.beforeReviewAdmission) {
    const run = c.runCorrectiveReview.bind(c);
    c.runCorrectiveReview = async (parentId, id) => { await mode.beforeReviewAdmission(c, parentId, id); return run(parentId, id); };
  }
  if (mode.afterCorrectiveValidation) {
    const run = c.runLocalValidation.bind(c);
    c.runLocalValidation = async id => { await run(id); if (c.task(id).correction) await mode.afterCorrectiveValidation(c, id); };
  }
  const input = { repository_id: 'fixture', execution_backend: 'local_codex', request_id: 'automatic_evidence', contract: contract(),
    automatic: { publish: { title: 'Fixture', draft: true }, max_duration_seconds: 120, max_codex_turns: 2, max_corrections: 0 } };
  if (mode.versioned) input.automatic.review_protocol = LOCAL_ACTIONABILITY_REVIEW_VERSION;
  if (mode.correction) Object.assign(input.automatic, { max_codex_turns: 3, max_corrections: 1 });
  if (mode.postReview) Object.assign(input.automatic, { max_codex_turns: 4, max_corrections: 1 });
  if (mode.requiredValidation) input.contract.test_commands = ['cat greeting.txt'];
  if (mode.referenceFile) input.contract.reference_files = ['policy.txt'];
  if (mode.manual) delete input.automatic;
  if (mode.validationFailure) input.contract.test_commands = ['true'];
  await mode.configure?.(c, input);
  const result = await c.start(input);
  if (mode.activeReviewer || mode.activeCorrection || mode.activeCorrectiveReviewer || mode.activeCorrectiveValidation) await reviewerActive;
  else { await Promise.all([...c.jobs.values()]); await Promise.all([...c.automaticJobs.values()]);
    if (mode.manual) { await c.review({ task_id: result.task_id, request_id: 'manual_review' }); await Promise.all([...c.jobs.values()]); } }
  return { ...value, id: result.task_id, calls, stops, input, normal, prompts, publisherCalls, submissions };
}

function sqliteAbort(c, table, predicate, event = 'INSERT') {
  const fault = { remaining: 1, hits: 0, skip: 0 };
  c.db.function('abort_evidence_write', () => { if (fault.skip > 0) { fault.skip--; return 0; }
    if (fault.remaining > 0) { fault.remaining--; fault.hits++; return 1; } return 0; });
  c.db.exec(`CREATE TEMP TRIGGER evidence_fault BEFORE ${event} ON ${table}
    WHEN (${predicate}) AND abort_evidence_write() BEGIN SELECT RAISE(ABORT, 'injected evidence write failure'); END;`);
  return fault;
}
async function restartEvidenceController(t, value) {
  await value.c.close();
  const c = await new Controller({ stateRoot: value.c.stateRoot, workspaceRoot: value.c.workspaceRoot, api: value.api,
    executor: value.executor, secrets: ['test-sensitive-value'], localBackendFactory: () => assert.fail('Model replay forbidden') }).init();
  t.after(() => c.close()); return c;
}

test('single correction authorization accepts only explicit local versioned 3/1 or the existing 2/0 limits', async t => {
  const { c, api } = await setup(t);
  const input = { execution_backend: 'local_codex', repository_id: 'fixture', automatic: { publish: { title: 'Fixture', draft: true },
    max_duration_seconds: 120, max_codex_turns: 3, max_corrections: 1, review_protocol: LOCAL_ACTIONABILITY_REVIEW_VERSION } };
  assert.equal(c.automaticAuthorization(input).max_corrections, 1);
  for (const changes of [{ max_codex_turns: 2 }, { max_codex_turns: 5 }, { max_corrections: 0 }, { max_corrections: 2 },
    { review_protocol: undefined }, { review_protocol: 'legacy' }, { max_duration_seconds: 901 }])
    assert.throws(() => c.automaticAuthorization({ ...input, automatic: { ...input.automatic, ...changes } }), /INVALID_AUTOMATIC_AUTHORIZATION/);
  for (const changes of [{ execution_backend: 'agents_api' }, { repository_id: undefined }])
    assert.throws(() => c.automaticAuthorization({ ...input, ...changes }), /INVALID_AUTOMATIC_AUTHORIZATION/);
  assert.equal(c.automaticAuthorization({ ...input, automatic: { ...input.automatic, max_codex_turns: 2, max_corrections: 0 } }).max_codex_turns, 2);
  assert.equal(api.created.length, 0);
});

test('explicit four-turn authority validates and reviews the corrected tree once, retains PASS, and stops without publication', async t => {
  const value = await automaticAttempt(t, { versioned: true, correction: true, postReview: true, requiredValidation: true });
  const { c, id, calls, publisherCalls } = value, parent = c.task(id), child = c.task(parent.automatic.correction.task_id);
  assert.deepEqual(calls, ['implementer', 'reviewer', 'corrector', 'corrective-reviewer'], JSON.stringify({ parent: parent.automatic, child: child.automatic, reviewer: child.reviewer }));
  assert.equal(child.reviewer?.review_result?.overall, 'PASS', JSON.stringify(child));
  assert.equal(parent.automatic.reason, 'CORRECTIVE_REVIEW_RETAINED');
  assert.equal(child.automatic.reason, 'CORRECTIVE_REVIEW_RETAINED');
  assert.deepEqual(publisherCalls, []); assert.equal(value.api.created.length, 0);
  assert.notEqual(child.reviewer.reviewed_git_state.tree_sha, parent.reviewer.reviewed_git_state.tree_sha);
  assert.equal(child.local_validation.reviewed_git_state.tree_sha, child.reviewer.reviewed_git_state.tree_sha);
  assert.notEqual(child.local_validation.attempt_id, parent.local_validation.attempt_id);
  assert.equal(child.deadline, parent.deadline); assert.equal(child.baseline, parent.baseline);
  assert.equal(new Set([parent.implementer, parent.reviewer, child.implementer, child.reviewer].map(role => role.local.thread_id)).size, 4);
  assert.equal(new Set([parent.implementer, parent.reviewer, child.implementer, child.reviewer].map(role => role.local.turn_id)).size, 4);
  assert.equal(child.local_validation.results[0].stdout.text, 'corrected\n');
  assert.equal(parent.local_validation.results[0].stdout.text, 'candidate\n');
  assert.equal(child.local_validation.results[0].exit_code, 0); assert.equal(child.local_validation.results[0].termination_confirmed, true);
  assert.notEqual(child.local_validation.results[0].cwd, parent.local_validation.results[0].cwd);
  const { get } = await statusClient(t, c), ledger = statusLedger(c.db), files = await statusFiles(value.normal, c.workspaceRoot);
  for (const taskId of [id, child.id, id]) {
    const status = (await get(taskId)).structuredContent;
    assert.equal(status.correction.review.overall, 'PASS', JSON.stringify(status));
    assert.equal(status.correction.review.qualified, true); assert.equal(status.correction.review.validation.qualified, true);
    assert.equal(status.correction.codex_turns_attempted, 4); assert.equal(status.correction.remaining_codex_turns, 0);
  }
  assert.equal(statusLedger(c.db), ledger); assert.equal(await statusFiles(value.normal, c.workspaceRoot), files);
  c.verifyAutomaticEvidence(child); c.verifyCorrectionEvidence(child);
  await assert.rejects(c.review({ task_id: child.id, request_id: 'public_fourth_review' }), /CORRECTION_REQUIRES_SEPARATE_REVIEW_AUTHORIZATION/);
  await assert.rejects(c.publish({ task_id: child.id, title: 'Forbidden' }), /CORRECTIVE_PUBLICATION_NOT_AUTHORIZED/);
});

test('four-turn authorization accepts only explicit versioned local repository 4/1', async t => {
  const { c } = await setup(t), input = { repository_id: 'fixture', execution_backend: 'local_codex', automatic: {
    publish: { title: 'Fixture', draft: true }, max_duration_seconds: 120, max_codex_turns: 4, max_corrections: 1, review_protocol: LOCAL_ACTIONABILITY_REVIEW_VERSION } };
  assert.equal(c.automaticAuthorization(input).max_codex_turns, 4);
  for (const change of [{ max_codex_turns: 5 }, { max_corrections: 0 }, { max_corrections: 2 }, { review_protocol: undefined },
    { review_protocol: 'v1' }, { authorize_review: true }, { max_duration_seconds: 901 }])
    assert.throws(() => c.automaticAuthorization({ ...input, automatic: { ...input.automatic, ...change } }), /INVALID_AUTOMATIC_AUTHORIZATION/);
  for (const change of [{ execution_backend: undefined }, { execution_backend: 'agents_api' }, { repository_id: undefined }])
    assert.throws(() => c.automaticAuthorization({ ...input, ...change }), /INVALID_AUTOMATIC_AUTHORIZATION/);
});

test('corrective draft publication authority accepts only an original literal true on versioned local 4/1', async t => {
  const { c, api } = await setup(t), input = { execution_backend: 'local_codex', repository_id: 'fixture', automatic: {
    publish: { title: 'Fixture', draft: true }, max_duration_seconds: 120, max_codex_turns: 4, max_corrections: 1,
    review_protocol: LOCAL_ACTIONABILITY_REVIEW_VERSION, publish_after_correction: true } };
  assert.equal(c.automaticAuthorization(input).publish_after_correction, true);
  for (const value of [false, null, 0, 1, 'true', {}, []]) assert.throws(() => c.automaticAuthorization({ ...input,
    automatic: { ...input.automatic, publish_after_correction: value } }), /INVALID_AUTOMATIC_AUTHORIZATION/);
  for (const change of [{ max_codex_turns: 2, max_corrections: 0 }, { max_codex_turns: 3 }, { review_protocol: undefined },
    { review_protocol: 'legacy' }, { max_corrections: 0 }, { publish: { title: 'Fixture', draft: false } }])
    assert.throws(() => c.automaticAuthorization({ ...input, automatic: { ...input.automatic, ...change } }), /INVALID_AUTOMATIC_AUTHORIZATION/);
  for (const change of [{ execution_backend: 'agents_api' }, { execution_backend: undefined }, { repository_id: undefined }])
    assert.throws(() => c.automaticAuthorization({ ...input, ...change }), /INVALID_AUTOMATIC_AUTHORIZATION/);
  assert.equal(api.created.length, 0);
});

test('a completed review-only authorization cannot acquire corrective publication through task mutation or duplicate input', async t => {
  const value = await automaticAttempt(t, { versioned: true, postReview: true }), { c, id } = value;
  const original = c.task(id); original.automatic.authorization.publish_after_correction = true;
  assert.throws(() => c.save(original), /AUTOMATIC_EVIDENCE_PERSISTENCE_UNCONFIRMED/);
  assert.equal(c.task(id).automatic.authorization.publish_after_correction, undefined);
  await assert.rejects(c.start({ ...value.input, automatic: { ...value.input.automatic, publish_after_correction: true } }), /REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT/);
  assert.deepEqual(value.publisherCalls, []); assert.equal(value.calls.length, 4);
});

test('four-turn authority rejects reused original reviewer turn identity before correction', async t => {
  const value = await automaticAttempt(t, { versioned: true, postReview: true, originalReviewTurn: 'implement-turn' });
  assert.deepEqual(value.calls, ['implementer', 'reviewer']); assert.deepEqual(value.publisherCalls, []);
  assert.equal(value.c.task(value.id).automatic.correction, undefined);
});

test('corrective review four-turn initial PASS still publishes one exact-tree draft without correction', async t => {
  let publisher, remote;
  const value = await automaticAttempt(t, { versioned: true, postReview: true, originalPass: true, async configure(c) {
    const root = path.dirname(c.stateRoot), normal = path.join(root, 'normal'); remote = path.join(root, 'remote.git');
    await fs.mkdir(remote); repoGit(remote, 'init', '--bare', '--initial-branch=main');
    repoGit(normal, 'remote', 'add', 'origin', remote); repoGit(normal, 'push', 'origin', 'HEAD:refs/heads/main');
    publisher = new class extends GitHubPublisher {
      constructor() { super(); this.creates = 0; this.pushes = 0; }
      api() { assert.fail('External GitHub API forbidden'); }
      async target() { return { repository: 'fixture/publication', base: 'main', remote }; }
      async push(...args) { this.pushes++; return super.push(...args); }
      async findPR() { return this.pr || null; }
      async createPR(target, branch, input) {
        this.creates++; assert.equal(input.draft, true);
        return this.pr = { number: 1, html_url: 'https://github.com/fixture/publication/pull/1', draft: true, state: 'open', merged_at: null,
          head: { ref: branch, sha: repoGit(remote, 'rev-parse', `refs/heads/${branch}`).trim(), repo: { full_name: target.repository } },
          base: { ref: target.base, repo: { full_name: target.repository } } };
      }
    }(); c.publisher = publisher;
  } });
  const task = value.c.task(value.id);
  assert.equal(task.automatic.status, 'succeeded', JSON.stringify(task.automatic));
  assert.deepEqual(value.calls, ['implementer', 'reviewer']); assert.equal(task.automatic.correction, undefined);
  assert.equal(publisher.pushes, 1); assert.equal(publisher.creates, 1);
  assert.equal(repoGit(remote, 'rev-parse', `${task.publication.commit_sha}^{tree}`).trim(), task.reviewer.reviewed_git_state.tree_sha);
});

for (const mode of [{ label: 'FAIL', correctiveReviewFail: true }, { label: 'malformed', correctiveReviewMalformed: true },
  { label: 'missing output', correctiveReviewMissing: true }, { label: 'wrong version', correctiveOutput: output => { output.format = 'legacy'; } },
  { label: 'unknown acknowledgment', correctiveReviewAckUnknown: true }, { label: 'unconfirmed closure', correctiveReviewerCloseUncertain: true },
  { label: 'original implementation thread', correctiveReviewThread: 'implement-thread' }, { label: 'original reviewer thread', correctiveReviewThread: 'review-thread' },
  { label: 'corrective implementation thread', correctiveReviewThread: 'correct-thread' }, { label: 'reused turn', correctiveReviewTurn: 'correct-turn' }])
test(`corrective review ${mode.label} stops without publication, another correction or replay`, async t => {
  const value = await automaticAttempt(t, { versioned: true, postReview: true, ...mode }), { c, id } = value;
  const parent = c.task(id), child = c.task(parent.automatic.correction.task_id);
  assert.deepEqual(value.publisherCalls, []); assert.equal(value.calls.filter(call => call === 'corrector').length, 1);
  assert.equal(value.calls.filter(call => call === 'corrective-reviewer').length, 1);
  const view = await c.get(id);
  assert.equal(view.correction.review.qualified, mode.label === 'FAIL');
  assert.equal(view.correction.review.overall, mode.label === 'FAIL' ? 'FAIL' : null);
  if (mode.correctiveReviewThread) assert.equal(value.submissions.filter(call => call === 'corrective-reviewer').length, 0);
  c.scheduleAutomatic(id); await c.start(value.input); await Promise.all([...c.automaticJobs.values()]);
  assert.equal(value.calls.length, 4); assert.equal(c.task(child.id).deadline, parent.deadline);
  assert.equal(c.task(id).reviewer.review_result.overall, 'FAIL');
});

for (const change of ['exit', 'identity', 'tree', 'termination', 'workspace', 'reference'])
test(`corrective review rechecks fresh validation and ${change} before fourth-turn submission`, async t => {
  const value = await automaticAttempt(t, { versioned: true, postReview: true, requiredValidation: true, referenceFile: true,
    async afterCorrectiveValidation(c, id) {
      const task = c.task(id);
      if (change === 'workspace' || change === 'reference') await fs.writeFile(path.join(c.workspaceRoot, id, 'repo', change === 'workspace' ? 'greeting.txt' : 'policy.txt'), 'changed\n');
      else {
        if (change === 'exit') task.local_validation.results[0].exit_code = 2;
        if (change === 'identity') task.local_validation.attempt_id = 'changed';
        if (change === 'tree') task.local_validation.reviewed_git_state.tree_sha = '0'.repeat(40);
        if (change === 'termination') task.local_validation.termination_confirmed = false;
        c.save(task);
      }
    } });
  assert.equal(value.submissions.filter(call => call === 'corrective-reviewer').length, 0);
  assert.equal(value.calls.filter(call => call === 'corrective-reviewer').length, 0);
  assert.deepEqual(value.publisherCalls, []);
});

for (const boundary of ['admission', 'validation', 'submission']) test(`corrective review expiry at ${boundary} preserves the original deadline and cannot submit`, async t => {
  const now = Date.now; let deadline;
  const expire = (c, id) => { deadline = c.task(id).deadline; Date.now = () => deadline + 1; };
  try {
    const value = await automaticAttempt(t, { versioned: true, postReview: true,
      ...(boundary === 'admission' ? { beforeReviewAdmission: (c, parentId) => expire(c, parentId) } :
        boundary === 'validation' ? { afterCorrectiveValidation: expire } : { beforeCorrectiveReview: c => {
          const child = c.db.prepare('SELECT value FROM tasks').all().map(row => JSON.parse(row.value)).find(task => task.correction); expire(c, child.id);
        } }) });
    assert.equal(value.c.task(value.id).deadline, deadline);
    assert.equal(value.submissions.filter(call => call === 'corrective-reviewer').length, 0);
    assert.deepEqual(value.publisherCalls, []);
  } finally { Date.now = now; }
});

for (const change of ['packet', 'parent contract', 'validation']) test(`corrective review pre-submission ${change} tampering cannot grant the fourth turn`, async t => {
  const value = await automaticAttempt(t, { versioned: true, postReview: true, beforeCorrectiveReview: async (c, options) => {
    const tasks = c.db.prepare('SELECT value FROM tasks').all().map(row => JSON.parse(row.value));
    const child = tasks.find(task => task.correction), parent = tasks.find(task => !task.correction);
    if (change === 'packet') {
      const file = path.join(options.cwd, 'evidence.json'); await fs.chmod(file, 0o600);
      const packet = JSON.parse(await fs.readFile(file, 'utf8')); packet.contract += '\nchanged';
      await fs.writeFile(file, JSON.stringify(packet)); await fs.chmod(file, 0o400);
    } else if (change === 'parent contract') await fs.writeFile(path.join(c.workspaceRoot, parent.id, 'contract.json'), '{}');
    else { child.local_validation.status = 'unavailable'; c.save(child); }
  } });
  assert.equal(value.submissions.filter(call => call === 'corrective-reviewer').length, 0); assert.deepEqual(value.publisherCalls, []);
});

for (const effect of ['ABORT', 'IGNORE']) for (const boundary of ['reservation', 'validation intent', 'validation result', 'packet', 'submission', 'acknowledgment', 'receipt', 'closure', 'history', 'acceptance'])
test(`corrective review SQLite ${effect} at ${boundary} cannot accept or replay a fourth review`, async t => {
  let hits = 0;
  const value = await automaticAttempt(t, { versioned: true, postReview: true, requiredValidation: true, configure(c) {
    c.db.function('review_fault', () => { hits++; return 1; });
    let table = 'tasks', event = 'INSERT', predicate = "json_extract(NEW.value,'$.correction.parent_task_id') IS NOT NULL AND json_extract(NEW.value,'$.automatic.review_authorization.parent_task_id') IS NOT NULL";
    const conditions = { reservation: "json_extract(NEW.value,'$.reviewer') IS NULL", 'validation intent': "json_extract(NEW.value,'$.local_validation.status')='pending'",
      'validation result': "json_extract(NEW.value,'$.local_validation.results[0].completion_observed')=1",
      submission: "json_extract(NEW.value,'$.reviewer.local.turn_submission_attempted')=1 AND json_extract(NEW.value,'$.reviewer.local.turn_submission_acknowledged')=0",
      acknowledgment: "json_extract(NEW.value,'$.reviewer.local.turn_submission_acknowledged')=1",
      receipt: "json_extract(NEW.value,'$.reviewer.received_output_sha256') IS NOT NULL AND json_extract(NEW.value,'$.reviewer.pending_review_output')=1",
      closure: "json_extract(NEW.value,'$.reviewer.received_output_sha256') IS NOT NULL AND json_extract(NEW.value,'$.reviewer.local.server_closed')=1" };
    if (boundary === 'packet' || boundary === 'history') {
      table = 'automatic_attempts'; predicate = `json_extract(NEW.value,'$.review_authorization.parent_task_id') IS NOT NULL AND json_extract(NEW.value,'$.kind')='${boundary === 'packet' ? 'review_packet' : 'review_result'}'`;
    } else if (boundary === 'acceptance') { table = 'operations'; event = 'UPDATE'; predicate = "NEW.id GLOB 'corrective_review_*' AND NEW.status='accepted'"; }
    else predicate += ` AND (${conditions[boundary]})`;
    c.db.exec(`CREATE TEMP TRIGGER fourth_fault BEFORE ${event} ON ${table} WHEN (${predicate}) AND review_fault() BEGIN SELECT RAISE(${effect}${effect === 'ABORT' ? ", 'injected corrective review fault'" : ''}); END;`);
  } });
  const { c, id } = value, child = c.task(c.task(id).automatic.correction.task_id);
  c.db.exec('DROP TRIGGER fourth_fault'); assert(hits > 0);
  assert.deepEqual(value.publisherCalls, []);
  assert(value.submissions.filter(call => call === 'corrective-reviewer').length <= (['acknowledgment', 'receipt', 'closure', 'history', 'acceptance'].includes(boundary) ? 1 : 0));
  const view = await c.get(id); assert.notEqual(view.correction.review?.qualified, true);
  if (boundary === 'receipt') assert.equal(view.correction.review.received_output, 'volatile_only');
  if (boundary === 'closure') assert.equal(view.correction.review.received_output, 'durable');
  if (child.automatic) assert.notEqual(c.db.prepare('SELECT status FROM operations WHERE id=?').get(child.automatic.review_request_id).status, 'accepted');
  assert(c.task(id).reviewer.review_result); assert(attemptRows(c, id).some(row => JSON.parse(row.value).packet_utf8));
  const count = value.calls.length, restarted = await restartEvidenceController(t, value);
  await restarted.start(value.input); restarted.scheduleAutomatic(id); await Promise.all([...restarted.automaticJobs.values()]);
  assert.equal(value.calls.length, count);
  const restored = await restarted.get(id); assert.notEqual(restored.correction.review?.qualified, true);
  if (boundary === 'receipt') assert.equal(restored.correction.review.received_output, 'unavailable');
});

test('corrective review lost Controller ownership prevents native fourth-turn submission', async t => {
  const value = await automaticAttempt(t, { versioned: true, postReview: true, beforeCorrectiveReview(c) {
    c.instanceId = 'another-controller';
  } });
  assert.equal(value.submissions.filter(call => call === 'corrective-reviewer').length, 0); assert.deepEqual(value.publisherCalls, []);
  assert.notEqual((await value.c.get(value.id)).correction.review.qualified, true);
});

test('corrective review cannot upgrade a three-turn request through child state or changed authority', async t => {
  const value = await automaticAttempt(t, { versioned: true, correction: true }), { c, id } = value;
  const parent = c.task(id), child = c.task(parent.automatic.correction.task_id);
  parent.automatic.status = 'progressing'; c.save(parent);
  await assert.rejects(c.runCorrectiveReview(id, child.id), /CORRECTIVE_REVIEW_NOT_AUTHORIZED/);
  parent.automatic.authorization.max_codex_turns = 4;
  assert.throws(() => c.save(parent), /AUTOMATIC_EVIDENCE_PERSISTENCE_UNCONFIRMED/);
  assert.equal(c.task(id).automatic.authorization.max_codex_turns, 3);
  assert.equal(c.task(child.id).automatic, undefined); assert.equal(value.calls.length, 3); assert.deepEqual(value.publisherCalls, []);
});

test('corrective review duplicate dispatch and repeated start cannot create another fourth reviewer', async t => {
  const value = await automaticAttempt(t, { versioned: true, postReview: true, activeCorrectiveReviewer: true }), { c, id } = value;
  const child = c.task(c.task(id).automatic.correction.task_id), count = c.db.prepare('SELECT count(*) AS n FROM operations').get().n;
  await assert.rejects(c.runCorrectiveReview(id, child.id), /CORRECTIVE_REVIEW_NOT_AUTHORIZED/);
  await assert.rejects(c.reviewLocal(child, child.automatic.review_request_id), /CORRECTIVE_REVIEW_REPLAY_FORBIDDEN/);
  await assert.rejects(c.runCorrection(child.id), /CORRECTION_BUDGET_EXHAUSTED/);
  await c.start(value.input);
  assert.equal(c.db.prepare('SELECT count(*) AS n FROM operations').get().n, count);
  assert.equal(value.calls.length, 4); assert.equal(value.submissions.filter(call => call === 'corrective-reviewer').length, 1);
  await c.cleanup({ task_id: id });
  assert(value.stops.includes('cancel')); assert(value.stops.includes('close')); assert.deepEqual(value.publisherCalls, []);
});

test('corrective review restart never replays an attempted native reviewer', async t => {
  const value = await automaticAttempt(t, { versioned: true, postReview: true, activeCorrectiveReviewer: true });
  const child = value.c.task(value.c.task(value.id).automatic.correction.task_id), requestId = child.automatic.review_request_id;
  const restarted = await restartEvidenceController(t, value);
  await restarted.start(value.input); restarted.scheduleAutomatic(value.id); await Promise.all([...restarted.automaticJobs.values()]);
  assert.equal(value.calls.length, 4); assert.equal(restarted.task(child.id).automatic.review_request_id, requestId);
  assert.notEqual((await restarted.get(value.id)).correction.review.qualified, true); assert.deepEqual(value.publisherCalls, []);
});

test('corrective review restart never replays a durable reservation without a submitted reviewer', async t => {
  let reserved, parentSnapshot;
  const value = await automaticAttempt(t, { versioned: true, postReview: true, configure(c) {
    const save = c.save.bind(c);
    c.save = (task, options) => {
      save(task, options);
      if (!reserved && task.correction && task.automatic && !task.reviewer) {
        reserved = structuredClone(task); parentSnapshot = c.task(task.correction.parent_task_id);
        throw Error('Simulated process loss after committed reservation');
      }
    };
  } });
  assert(reserved); assert.equal(value.calls.length, 3);
  await value.c.close();
  const db = new DatabaseSync(path.join(value.c.stateRoot, 'controller.sqlite'));
  db.prepare('UPDATE tasks SET value=? WHERE id=?').run(JSON.stringify(reserved), reserved.id);
  db.prepare('UPDATE tasks SET value=? WHERE id=?').run(JSON.stringify(parentSnapshot), parentSnapshot.id); db.close();
  const restarted = await new Controller({ stateRoot: value.c.stateRoot, workspaceRoot: value.c.workspaceRoot, api: value.api,
    executor: value.executor, localBackendFactory: () => assert.fail('Reserved reviewer replay forbidden') }).init();
  t.after(() => restarted.close());
  await restarted.start(value.input); restarted.scheduleAutomatic(value.id); await Promise.all([...restarted.automaticJobs.values()]);
  assert.equal(restarted.task(reserved.id).automatic.review_request_id, reserved.automatic.review_request_id);
  assert.equal(restarted.task(reserved.id).automatic.status, 'uncertain'); assert.equal(value.calls.length, 3);
});

for (const unavailable of ['packet', 'tree']) test(`corrective review MCP status remains observational with missing corrected ${unavailable} evidence`, async t => {
  const value = await automaticAttempt(t, { versioned: true, postReview: true }), { c, id } = value;
  const parent = c.task(id), child = c.task(parent.automatic.correction.task_id), root = path.join(c.workspaceRoot, child.id);
  if (unavailable === 'packet') await fs.rm(path.join(root, child.reviewer.packet_directory, 'evidence.json'));
  else {
    const tree = child.reviewer.reviewed_git_state.tree_sha;
    await fs.rm(path.join(root, 'git-store/objects', tree.slice(0, 2), tree.slice(2)));
  }
  const ledger = statusLedger(c.db), files = await statusFiles(value.normal, c.workspaceRoot), { get } = await statusClient(t, c);
  let writes = 0;
  const denied = new Set([sqlite.SQLITE_INSERT, sqlite.SQLITE_UPDATE, sqlite.SQLITE_DELETE]);
  c.db.setAuthorizer(action => { if (denied.has(action)) { writes++; return sqlite.SQLITE_DENY; } return sqlite.SQLITE_OK; });
  try {
    for (const taskId of [id, child.id, id, child.id]) {
      const response = await get(taskId); assert.notEqual(response.isError, true);
      assert.equal(response.structuredContent.correction.review.qualified, false);
      assert.equal(response.structuredContent.correction.review.overall, null);
      if (taskId === child.id) assert.equal(response.structuredContent.reviewer.overall, null);
    }
    assert.equal(writes, 0); assert.equal(statusLedger(c.db), ledger);
    assert.equal(await statusFiles(value.normal, c.workspaceRoot), files); assert.equal(value.calls.length, 4); assert.deepEqual(value.publisherCalls, []);
  } finally { c.db.setAuthorizer(null); }
});

for (const uncertain of [false, true]) test(`corrective review expiry cancels the owned fourth backend without SQLite; uncertain=${uncertain}`, async t => {
  const value = await automaticAttempt(t, { versioned: true, postReview: true, activeCorrectiveReviewer: true,
    cancelResult: !uncertain, closeResult: !uncertain }), { c, id } = value;
  const deadline = c.task(id).deadline;
  c.db.setAuthorizer((action, table) => action === sqlite.SQLITE_READ && table === 'tasks' ? sqlite.SQLITE_DENY : sqlite.SQLITE_OK);
  try { await assert.doesNotReject(c.expireAutomatic(id)); }
  finally { c.db.setAuthorizer(null); }
  assert(value.stops.includes('cancel')); assert(value.stops.includes('close'));
  assert.equal(c.task(id).deadline, deadline); assert.equal(value.calls.length, 4); assert.deepEqual(value.publisherCalls, []);
  assert.equal(c.expiryStops.get(id).confirmed, !uncertain);
});

for (const action of ['cleanup', 'expiry']) test(`corrective review ${action} stops its new validation runner without reviewer submission`, async t => {
  const value = await automaticAttempt(t, { versioned: true, postReview: true, activeCorrectiveValidation: true }), { c, id } = value;
  const deadline = c.task(id).deadline;
  const child = c.task(c.task(id).automatic.correction.task_id), { get } = await statusClient(t, c);
  const ledger = statusLedger(c.db);
  for (const taskId of [id, child.id]) {
    const status = (await get(taskId)).structuredContent;
    assert.equal(status.correction.codex_turns_attempted, 3);
    assert.equal(status.automatic.usage.implementer_turn_submissions_attempted, 1);
    assert.equal(status.automatic.usage.reviewer_turn_submissions_attempted, 1);
    assert.equal(status.correction.review.attempted_turns, 0);
  }
  assert.equal(statusLedger(c.db), ledger);
  if (action === 'cleanup') await c.cleanup({ task_id: id });
  else {
    c.db.setAuthorizer((kind, table) => kind === sqlite.SQLITE_READ && table === 'tasks' ? sqlite.SQLITE_DENY : sqlite.SQLITE_OK);
    try { await assert.doesNotReject(c.expireAutomatic(id)); } finally { c.db.setAuthorizer(null); }
  }
  assert(value.stops.includes('validation.cancel'));
  assert.equal(value.calls.length, 3); assert.equal(c.task(id).deadline, deadline); assert.deepEqual(value.publisherCalls, []);
});

test('single correction preserves the rejected tree and evidence, runs once in a fresh workspace, and stops for review', async t => {
  let rejected, before, history, seenPrompt;
  const value = await automaticAttempt(t, { versioned: true, correction: true, async beforeCorrection(c, options, input) {
    const parent = c.db.prepare('SELECT value FROM tasks').all().map(row => JSON.parse(row.value)).find(task => task.automatic);
    rejected = parent; seenPrompt = input.prompt;
    before = await statusFiles(path.join(c.workspaceRoot, parent.id), parent.repository.canonical_path);
    history = attemptRows(c, parent.id);
    const child = c.task(parent.automatic.correction.task_id);
    assert.equal(child.correction_state, 'running'); assert.notEqual(options.cwd, path.join(c.workspaceRoot, parent.id, 'repo'));
    assert.equal(repoGit(options.cwd, 'rev-parse', 'HEAD').trim(), parent.baseline);
    assert.equal(repoGit(options.cwd, 'write-tree').trim(), parent.reviewer.reviewed_git_state.tree_sha);
    assert.equal(c.db.prepare('SELECT status FROM operations WHERE id=?').get(child.request_id).status, 'reserved');
  } });
  const { c, id, calls, publisherCalls, input } = value, parent = c.task(id), lineage = parent.automatic.correction;
  assert(lineage, JSON.stringify(parent.automatic));
  const child = c.task(lineage.task_id);
  assert.deepEqual(calls, ['implementer', 'reviewer', 'corrector']); assert.deepEqual(publisherCalls, []); assert.equal(value.api.created.length, 0);
  assert.equal(child.correction_state, 'awaiting_review', JSON.stringify(child.implementer));
  assert.equal(parent.automatic.reason, 'CORRECTION_REQUIRES_INDEPENDENT_REVIEW');
  assert.equal(child.deadline, parent.deadline); assert.equal(child.baseline, parent.baseline);
  assert.equal(lineage.rejected_tree_sha, rejected.reviewer.reviewed_git_state.tree_sha);
  assert.equal(child.implementer.local.thread_id, 'correct-thread'); assert.equal(child.implementer.local.turn_id, 'correct-turn');
  assert.equal(await statusFiles(path.join(c.workspaceRoot, id), parent.repository.canonical_path), before);
  assert.deepEqual(parent.reviewer, rejected.reviewer);
  for (const row of history) assert(attemptRows(c, id).some(current => current.observation_sha256 === row.observation_sha256 && current.value === row.value));
  assert(attemptRows(c, child.id).length > 3);
  assert.match(seenPrompt, /Untrusted independent review findings/); assert.match(seenPrompt, /Replace the incorrect greeting/);
  assert.equal(await fs.readFile(path.join(c.workspaceRoot, child.id, 'repo/greeting.txt'), 'utf8'), 'corrected\n');
  assert.notEqual((await fs.stat(path.join(c.workspaceRoot, id, 'git-store/config'))).ino,
    (await fs.stat(path.join(c.workspaceRoot, child.id, 'git-store/config'))).ino);
  await assert.rejects(c.review({ task_id: child.id, request_id: 'forbidden_review' }), /CORRECTION_REQUIRES_SEPARATE_REVIEW_AUTHORIZATION/);
  await assert.rejects(c.publish({ task_id: child.id, title: 'No' }), /CORRECTIVE_PUBLICATION_NOT_AUTHORIZED/);
  await c.start(input); c.scheduleAutomatic(id); await Promise.all([...c.automaticJobs.values()]);
  assert.deepEqual(calls, ['implementer', 'reviewer', 'corrector']);
  const { get } = await statusClient(t, c), ledger = statusLedger(c.db), files = await statusFiles(value.normal, c.workspaceRoot);
  for (const taskId of [id, child.id, id, child.id]) {
    const result = await get(taskId); assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.correction.execution_authorized, false);
    assert.equal(result.structuredContent.correction.attempted_corrections, 1);
    assert.equal(result.structuredContent.correction.terminal_confirmed, true);
  }
  assert.equal(statusLedger(c.db), ledger); assert.equal(await statusFiles(value.normal, c.workspaceRoot), files);
});

for (const mode of [{ cause: 'missing_evidence' }, { cause: 'unknown_cause' }, { cause: 'human_decision_required' },
  { cause: 'scope_or_security_failure' }, { humanApproval: true }, { uncertain: true }, { incomplete: true },
  { validationFailure: true }, { label: 'scope', output: output => { output.findings.find(finding => finding.id === 'SCOPE').status = 'FAIL';
    output.findings.find(finding => finding.id === 'SCOPE').classification = { kind: 'scope_or_security_failure' }; } },
  { label: 'test evidence', output: output => { Object.assign(output.findings.find(finding => finding.id === 'TEST_EVIDENCE'), { status: 'FAIL', classification: { kind: 'missing_evidence' } }); } },
  { label: 'outside target', output: output => { output.findings[0].classification.target_files = ['outside.txt']; } }])
test(`single correction rejects unqualified evidence ${mode.label || mode.cause || JSON.stringify(Object.keys(mode))}`, async t => {
  const { c, id, calls, publisherCalls } = await automaticAttempt(t, { versioned: true, correction: true, ...mode });
  assert.equal(c.task(id).automatic.correction, undefined); assert(!calls.includes('corrector')); assert.deepEqual(publisherCalls, []);
});

for (const mode of [{ reuseThread: true }, { reuseTurn: true }, { wrongModel: true }, { ackUnknown: true }, { correctiveCloseUncertain: true }, { correctiveHuman: true }])
test(`single correction stops without replay for ${JSON.stringify(mode)}`, async t => {
  const value = await automaticAttempt(t, { versioned: true, correction: true, ...mode }), { c, id, calls, publisherCalls } = value;
  const child = c.task(c.task(id).automatic.correction.task_id);
  assert.notEqual(child.correction_state, 'awaiting_review'); assert.notEqual(c.task(id).automatic.status, 'succeeded');
  if (mode.reuseThread || mode.wrongModel) assert.equal(value.submissions.length, 0);
  assert.deepEqual(calls, ['implementer', 'reviewer', 'corrector']); assert.deepEqual(publisherCalls, []);
  await c.start(value.input); c.scheduleAutomatic(id); await Promise.all([...c.automaticJobs.values()]);
  assert.equal(calls.length, 3);
});

for (const boundary of ['reservation', 'history', 'preflight', 'submission', 'acknowledgment', 'terminal', 'acceptance'])
test(`single correction SQLite ABORT at ${boundary} cannot grant authority or replay execution`, async t => {
  let fault;
  const value = await automaticAttempt(t, { versioned: true, correction: true, configure(c) {
    const field = { preflight: 'instance_started', submission: 'turn_submission_attempted', acknowledgment: 'turn_submission_acknowledged', terminal: 'terminal_observed' }[boundary];
    if (boundary === 'history') fault = sqliteAbort(c, 'automatic_attempts', "json_extract(NEW.value,'$.kind')='corrective_execution'");
    else if (boundary === 'acceptance') fault = sqliteAbort(c, 'operations', "NEW.id LIKE 'correct_%' AND NEW.status='accepted'", 'UPDATE');
    else fault = sqliteAbort(c, 'tasks', "json_extract(NEW.value,'$.correction.parent_task_id') IS NOT NULL" +
      (field ? ` AND json_extract(NEW.value,'$.implementer.local.${field}')=1` : ''));
  } });
  const { c, id, submissions, calls, publisherCalls } = value;
  try {
    assert.equal(fault.hits, 1); assert.notEqual(c.task(id).automatic.status, 'succeeded');
    assert(c.task(id).reviewer.review_result); assert(attemptRows(c, id).some(row => JSON.parse(row.value).packet_utf8));
    if (['reservation', 'history', 'preflight', 'submission'].includes(boundary)) assert.equal(submissions.length, 0);
    else assert.equal(submissions.length, 1);
    const count = calls.length;
    c.scheduleAutomatic(id); await Promise.all([...c.automaticJobs.values()]); assert.equal(calls.length, count);
    assert.deepEqual(publisherCalls, []);
    if (c.task(id).automatic.correction) {
      const child = c.task(c.task(id).automatic.correction.task_id);
      assert.notEqual(child.correction_state, 'awaiting_review');
      const cleanup = await c.cleanup({ task_id: child.id, delete_workspace: true });
      assert.equal(cleanup.cleanup.workspace_deleted, false);
    }
  } finally { c.db.exec('DROP TRIGGER evidence_fault'); }
});

for (const change of ['tree', 'baseline', 'registry', 'contract', 'validation', 'packet', 'normal'])
test(`single correction revalidates qualified retained FAIL against changed ${change}`, async t => {
  let original;
  const { c, id, calls, publisherCalls } = await automaticAttempt(t, { versioned: true, correction: true, async beforeDispatch(c, id) {
    const task = c.task(id); original = task.reviewer.review_result;
    assert.equal(original.actionability_qualification.potentially_correctable, true);
    const root = path.join(c.workspaceRoot, id);
    if (change === 'tree' || change === 'baseline') {
      const oid = change === 'tree' ? task.reviewer.reviewed_git_state.tree_sha : task.baseline;
      await fs.unlink(path.join(root, 'git-store/objects', oid.slice(0, 2), oid.slice(2)));
    }
    if (change === 'registry') await fs.writeFile(path.join(c.stateRoot, 'repositories.json'), JSON.stringify({ version: 1, repositories: {} }));
    if (change === 'contract') await fs.writeFile(path.join(root, 'contract.json'), '{}');
    if (change === 'validation') { task.local_validation.status = 'failed'; c.save(task); }
    if (change === 'packet') { const file = path.join(root, task.reviewer.packet_directory, 'evidence.json'); await fs.chmod(file, 0o600); await fs.appendFile(file, 'changed'); }
    if (change === 'normal') await fs.writeFile(path.join(task.repository.canonical_path, 'greeting.txt'), 'changed\n');
  } });
  assert.equal(c.task(id).automatic.correction, undefined); assert.deepEqual(calls, ['implementer', 'reviewer']); assert.deepEqual(publisherCalls, []);
  assert.deepEqual(c.task(id).reviewer.review_result, original);
});

test('single correction expiry before reservation preserves the original deadline and submits nothing', async t => {
  const now = Date.now;
  try {
    const { c, id, calls, submissions } = await automaticAttempt(t, { versioned: true, correction: true, beforeDispatch(c, id) {
      const deadline = c.task(id).deadline; Date.now = () => deadline;
    } });
    assert.deepEqual(calls, ['implementer', 'reviewer']); assert.deepEqual(submissions, []);
    assert.equal(c.task(id).automatic.correction, undefined); assert.equal(c.task(id).automatic.reason, 'TASK_EXPIRED');
    assert.equal(c.task(id).deadline, c.task(id).automatic.deadline);
  } finally { Date.now = now; }
});

test('single correction requires committed history before native submission even when SQLite silently ignores an insert', async t => {
  let ignored = 0;
  const { c, id, submissions, publisherCalls } = await automaticAttempt(t, { versioned: true, correction: true, configure(c) {
    c.db.function('ignore_corrective_observation', () => ignored++ === 0 ? 1 : 0);
    c.db.exec(`CREATE TEMP TRIGGER ignore_history BEFORE INSERT ON automatic_attempts
      WHEN json_extract(NEW.value,'$.kind')='corrective_execution' AND json_extract(NEW.value,'$.implementer.local.turn_submission_attempted')=1
      AND json_extract(NEW.value,'$.implementer.local.turn_submission_acknowledged')=0 AND ignore_corrective_observation()
      BEGIN SELECT RAISE(IGNORE); END;`);
  } });
  assert(ignored > 0); assert.deepEqual(submissions, []); assert.deepEqual(publisherCalls, []);
  assert.notEqual(c.task(c.task(id).automatic.correction.task_id).correction_state, 'awaiting_review');
  assert(c.task(id).reviewer.review_result); c.db.exec('DROP TRIGGER ignore_history');
});

for (const boundary of ['submission', 'acknowledgment', 'acceptance', 'submission operation', 'acceptance operation'])
test(`corrective SQLite IGNORE at ${boundary} verifies intended writes and remains uncertain across a separate Controller restart`, async t => {
  let ignored = 0, original;
  const value = await automaticAttempt(t, { versioned: true, correction: true, async beforeCorrection(c) {
    const parent = c.db.prepare('SELECT value FROM tasks').all().map(row => JSON.parse(row.value)).find(task => task.automatic);
    original = { reviewer: JSON.stringify(parent.reviewer), rows: attemptRows(c, parent.id),
      packet: await fs.readFile(path.join(c.workspaceRoot, parent.id, parent.reviewer.packet_directory, 'evidence.json'), 'utf8') };
  }, configure(c) {
    c.db.function('count_ignored_correction', () => { ignored++; return 1; });
    const operation = boundary.endsWith('operation');
    const predicate = operation ? `NEW.id LIKE 'correct_%' AND NEW.status='${boundary.startsWith('submission') ? 'submitting' : 'accepted'}'` :
      "json_extract(NEW.value,'$.correction.parent_task_id') IS NOT NULL AND " + (boundary === 'acceptance' ?
        "json_extract(NEW.value,'$.correction_state')='awaiting_review'" :
        `json_extract(NEW.value,'$.implementer.local.${boundary === 'submission' ? 'turn_submission_attempted' : 'turn_submission_acknowledged'}')=1`);
    c.db.exec(`CREATE TEMP TRIGGER ignore_correction BEFORE ${operation ? 'UPDATE ON operations' : 'INSERT ON tasks'}
      WHEN (${predicate}) AND count_ignored_correction() BEGIN SELECT RAISE(IGNORE); END;`);
  } });
  const { c, id, submissions, calls, publisherCalls } = value, parent = c.task(id), child = c.task(parent.automatic.correction.task_id);
  c.db.exec('DROP TRIGGER ignore_correction');
  assert(ignored > 0);
  const beforeSubmission = boundary.startsWith('submission');
  assert.equal(submissions.length, beforeSubmission ? 0 : 1);
  assert.notEqual(child.correction_state, 'awaiting_review');
  assert.notEqual(c.db.prepare('SELECT status FROM operations WHERE id=?').get(child.request_id).status, 'accepted');
  assert.equal(parent.automatic.status, 'uncertain'); assert.deepEqual(publisherCalls, []);
  const check = async controller => {
    const { get } = await statusClient(t, controller), ledger = statusLedger(controller.db);
    for (const taskId of [id, child.id, id]) {
      const response = await get(taskId); assert.notEqual(response.isError, true);
      const status = response.structuredContent;
      assert.equal(status.correction.retention_uncertain, true);
      assert.equal(status.correction.terminal_confirmed, false);
      assert.equal(status.correction.attempted_corrections, beforeSubmission ? null : 1);
      if (status.automatic) assert.equal(status.automatic.usage.correction_turns, status.correction.attempted_corrections);
    }
    assert.equal(statusLedger(controller.db), ledger);
    const currentReview = controller.task(id).reviewer, originalReview = JSON.parse(original.reviewer);
    delete currentReview.stopping; delete originalReview.stopping;
    delete currentReview.local.human_attention_required; delete originalReview.local.human_attention_required;
    assert.deepEqual(currentReview, originalReview);
    assert.equal(await fs.readFile(path.join(controller.workspaceRoot, id, parent.reviewer.packet_directory, 'evidence.json'), 'utf8'), original.packet);
    for (const row of original.rows) assert(attemptRows(controller, id).some(current => current.value === row.value && current.observation_sha256 === row.observation_sha256));
  };
  await check(c);
  const restarted = await restartEvidenceController(t, value);
  await check(restarted);
  await restarted.start(value.input); restarted.scheduleAutomatic(id); await Promise.all([...restarted.automaticJobs.values()]);
  assert.equal(calls.length, 3); assert.deepEqual(publisherCalls, []);
});

for (const stale of ['task', 'operation']) test(`corrective status detects a stale ${stale} snapshot without losing attempted evidence across restart`, async t => {
  const value = await automaticAttempt(t, { versioned: true, correction: true }), { c, id, calls } = value;
  const parent = c.task(id), child = c.task(parent.automatic.correction.task_id);
  assert.equal(child.correction_state, 'awaiting_review'); assert.equal(value.submissions.length, 1);
  if (stale === 'task') {
    const prior = attemptRows(c, child.id).map(row => JSON.parse(row.value)).find(row => row.state === 'running' && row.implementer.local.thread_id && !row.implementer.local.turn_submission_attempted);
    assert(prior);
    child.implementer = prior.implementer; child.correction_state = prior.state; child.correction_reason = prior.reason;
    c.db.prepare('UPDATE tasks SET value=? WHERE id=?').run(JSON.stringify(child), child.id);
  } else c.db.prepare('UPDATE operations SET status=? WHERE id=?').run('result_received', child.request_id);
  const check = async controller => {
    const { get } = await statusClient(t, controller), ledger = statusLedger(controller.db), files = await statusFiles(value.normal, controller.workspaceRoot);
    for (const taskId of [id, child.id, id]) {
      const response = await get(taskId); assert.notEqual(response.isError, true);
      const status = response.structuredContent;
      assert.equal(status.correction.attempted_corrections, 1); assert.equal(status.correction.retention_uncertain, true);
      assert.equal(status.correction.terminal_confirmed, false); assert.equal(status.correction.state, 'needs_attention');
      assert.equal(status.correction.execution_authorized, false);
    }
    assert.equal(statusLedger(controller.db), ledger); assert.equal(await statusFiles(value.normal, controller.workspaceRoot), files);
    assert.deepEqual(controller.task(id).reviewer.review_result, parent.reviewer.review_result);
  };
  await check(c);
  const restarted = await restartEvidenceController(t, value); await check(restarted);
  await restarted.start(value.input); restarted.scheduleAutomatic(id); await Promise.all([...restarted.automaticJobs.values()]);
  assert.equal(calls.length, 3); assert.deepEqual(value.publisherCalls, []);
});

test('single correction restart does not resume or replace a reserved attempt', async t => {
  const value = await automaticAttempt(t, { versioned: true, correction: true, activeCorrection: true });
  const parent = value.c.task(value.id), child = value.c.task(parent.automatic.correction.task_id);
  const restarted = await restartEvidenceController(t, value);
  assert.notEqual(restarted.task(parent.id).automatic.status, 'progressing');
  assert.equal(restarted.task(child.id).correction_state, 'needs_attention');
  await restarted.start(value.input); restarted.scheduleAutomatic(parent.id); await Promise.all([...restarted.automaticJobs.values()]);
  assert.equal(value.calls.length, 3); assert.equal(restarted.automaticJobs.size, 0);
  assert.deepEqual(restarted.task(parent.id).automatic.correction, parent.automatic.correction);
});

test('single correction duplicate dispatch cannot create another backend or submit another turn', async t => {
  const value = await automaticAttempt(t, { versioned: true, correction: true, activeCorrection: true }), { c, id } = value;
  const parent = c.task(id), child = c.task(parent.automatic.correction.task_id);
  await assert.rejects(c.runAutomatic(id), /AUTOMATIC_REPLAY_FORBIDDEN/);
  await assert.rejects(c.runCorrection(id), /CORRECTION_NOT_AUTHORIZED/);
  await assert.rejects(c.runLocal(child.id, path.join(c.workspaceRoot, child.id, 'repo'), parent.automatic.contract_binding.contract), /CORRECTION_REPLAY_FORBIDDEN/);
  assert.deepEqual(value.calls, ['implementer', 'reviewer', 'corrector']); assert.equal(value.submissions.length, 1);
  await c.cleanup({ task_id: id });
});

test('single correction preserves the existing active task capacity limit', async t => {
  const { c, id, calls, publisherCalls } = await automaticAttempt(t, { versioned: true, correction: true, beforeDispatch(c, id) {
    for (const suffix of ['a', 'b']) c.save({ id: `capacity_${suffix}`, execution_backend: 'agents_api', deadline: c.task(id).deadline,
      implementer: { state: 'completed' }, request_id: `capacity_${suffix}` });
  } });
  assert.equal(c.task(id).automatic.reason, 'ACTIVE_TASK_LIMIT'); assert.equal(c.task(id).automatic.correction, undefined);
  assert.deepEqual(calls, ['implementer', 'reviewer']); assert.deepEqual(publisherCalls, []);
});

test('single correction linked MCP status cannot fetch missing promisor objects or write any ledger rows', async t => {
  const { c, id, root, normal, calls, publisherCalls } = await automaticAttempt(t, { versioned: true, correction: true });
  const childId = c.task(id).automatic.correction.task_id, { get } = await statusClient(t, c);
  const remote = path.join(root, 'local-promisor.git'); repoGit(normal, 'clone', '--bare', '--no-hardlinks', normal, remote);
  repoGit(normal, 'remote', 'add', 'fixture', remote); repoGit(normal, 'config', 'remote.fixture.promisor', 'true');
  const oid = c.task(id).baseline, object = path.join(normal, '.git/objects', oid.slice(0, 2), oid.slice(2)); await fs.unlink(object);
  const reader = new DatabaseSync(path.join(c.stateRoot, 'controller.sqlite'), { readOnly: true });
  const before = statusLedger(reader), files = await statusFiles(normal, c.workspaceRoot, path.join(c.stateRoot, 'repositories.json'), remote), writes = [];
  c.db.setAuthorizer((action, table) => { if ([sqlite.SQLITE_INSERT, sqlite.SQLITE_UPDATE, sqlite.SQLITE_DELETE].includes(action)) writes.push(table); return sqlite.SQLITE_OK; });
  try {
    for (const taskId of [id, childId, id, childId]) {
      const result = await get(taskId); assert.notEqual(result.isError, true);
      assert.equal(result.structuredContent.correction.execution_authorized, false);
      if (taskId === id) assert.equal(result.structuredContent.automatic.review.potentially_correctable, false);
      await assert.rejects(fs.access(object), { code: 'ENOENT' });
      assert.equal(await statusFiles(normal, c.workspaceRoot, path.join(c.stateRoot, 'repositories.json'), remote), files);
      assert.equal(statusLedger(reader), before);
    }
    assert.deepEqual(writes, []); assert.deepEqual(calls, ['implementer', 'reviewer', 'corrector']); assert.deepEqual(publisherCalls, []);
  } finally { c.db.setAuthorizer(null); reader.close(); }
});

for (const uncertain of [false, true]) test(`single correction expiry stops its owned backend without SQLite; uncertain=${uncertain}`, async t => {
  const value = await automaticAttempt(t, { versioned: true, correction: true, activeCorrection: true,
    cancelResult: !uncertain, closeResult: !uncertain }), { c, id } = value;
  c.db.setAuthorizer((action, table) => action === sqlite.SQLITE_READ && table === 'tasks' ? sqlite.SQLITE_DENY : sqlite.SQLITE_OK);
  try {
    await assert.doesNotReject(c.expireAutomatic(id));
    assert(value.stops.includes('cancel')); assert(value.stops.includes('close'));
    assert.equal(c.expiryStops.get(id).confirmed, !uncertain);
  } finally { c.db.setAuthorizer(null); }
  await Promise.all([...c.jobs.values()]); await Promise.all([...c.automaticJobs.values()]);
  assert.equal(value.submissions.length, 1); assert.deepEqual(value.publisherCalls, []);
});

test('versioned automatic FAIL retains authenticated actionability without correction or publication', async t => {
  const value = await automaticAttempt(t, { versioned: true, remedy: 'Do not execute this remedy: /private/work/secret --run-model' });
  const { c, id, calls, input, prompts, publisherCalls } = value, task = c.task(id), result = task.reviewer.review_result;
  assert.deepEqual(prompts, [localActionabilityReviewerInstructions]);
  assert.equal(task.automatic.status, 'stopped'); assert.equal(task.automatic.reason, 'PUBLICATION_REQUIRES_PASS_REVIEW');
  assert.equal(result.validation_contract, LOCAL_ACTIONABILITY_REVIEW_VERSION);
  assert.deepEqual(result.controller_context, { reviewerIndependent: true, executionQualified: true, authorityValid: true, uncertaintyFree: true });
  assert.equal(result.actionability_qualification.potentially_correctable, true); assert.equal(result.actionability_qualification.execution_authorized, false);
  assert.equal(result.controller_binding.task_id, id); assert.equal(result.controller_binding.baseline_commit, task.baseline);
  assert.equal(result.controller_binding.contract_sha256, digest(input.contract)); assert.equal(result.controller_binding.deadline, task.deadline);
  assert.equal(result.controller_binding.packet_sha256, task.reviewer.packet_hash);
  assert.deepEqual(result.controller_binding.reviewed_git_state, task.reviewer.reviewed_git_state);
  assert.equal(result.controller_binding.reviewer.thread_id, task.reviewer.local.thread_id);
  assert.equal(result.controller_binding.reviewer.turn_id, task.reviewer.local.turn_id);
  const rows = attemptRows(c, id), retained = rows.map(row => JSON.parse(row.value));
  assert(retained.some(row => row.findings_sha256 === digest(result) && row.review_protocol === LOCAL_ACTIONABILITY_REVIEW_VERSION));
  assert(retained.every(row => row.correction_eligibility.eligible === false));
  const before = JSON.stringify(c.db.prepare('SELECT * FROM tasks').all());
  for (const view of [await c.get(id), await c.get(id), await c.start(input)]) {
    assert.equal(view.automatic.review.state, 'potentially_correctable_fail'); assert.equal(view.automatic.review.potentially_correctable, true);
    assert.equal(view.automatic.review.execution_authorized, false); assert.equal(view.automatic.usage.correction_turns, 0);
    assert.equal(view.reviewer.review_result, null); assert.equal(view.reviewer.findings, undefined);
    assert(!JSON.stringify(view).includes('/private/work/secret')); assert(!JSON.stringify(view).includes('--run-model'));
    assert.deepEqual(view.automatic.limits, c.automaticAuthorization(input));
  }
  assert.equal(JSON.stringify(c.db.prepare('SELECT * FROM tasks').all()), before); assert.deepEqual(attemptRows(c, id), rows);
  await assert.rejects(c.start({ ...input, automatic: { ...input.automatic, review_protocol: undefined } }), /INVALID_AUTOMATIC_AUTHORIZATION/);
  const legacy = structuredClone(input); delete legacy.automatic.review_protocol;
  await assert.rejects(c.start(legacy), /REQUEST_ID_REUSED/);
  assert.deepEqual(calls, ['implementer', 'reviewer']); assert.deepEqual(publisherCalls, []); assert.equal(value.api.created.length, 0);
  assert.equal(task.deadline, task.automatic.deadline); assert.equal(task.automatic.authorization.max_codex_turns, 2); assert.equal(task.automatic.authorization.max_corrections, 0);
});

test('MCP versioned status is observational across the complete invocation and filesystem', async t => {
  const { c, id, normal, calls, publisherCalls } = await automaticAttempt(t, { versioned: true });
  let authorizations = 0;
  const { get } = await statusClient(t, c, async () => { authorizations++; });
  const reader = new DatabaseSync(path.join(c.stateRoot, 'controller.sqlite'), { readOnly: true });
  const registry = path.join(c.stateRoot, 'repositories.json'), workspace = path.join(c.workspaceRoot, id);
  const before = statusLedger(reader), files = await statusFiles(normal, workspace, registry), writes = [];
  c.db.setAuthorizer((action, table) => {
    if ([sqlite.SQLITE_INSERT, sqlite.SQLITE_UPDATE, sqlite.SQLITE_DELETE].includes(action) && statusTables.includes(table)) writes.push(table);
    return sqlite.SQLITE_OK;
  });
  try {
    for (let count = 0; count < 3; count++) {
      const result = await get(id); assert.notEqual(result.isError, true);
      assert.equal(result.structuredContent.automatic.review.potentially_correctable, true);
      assert.equal(result.structuredContent.automatic.review.execution_authorized, false);
    }
    assert.deepEqual(writes, [], 'MCP status must not even prepare a ledger write');
    assert.equal(statusLedger(reader), before); assert.equal(await statusFiles(normal, workspace, registry), files);
    assert.equal(authorizations, 3); assert.deepEqual(calls, ['implementer', 'reviewer']); assert.deepEqual(publisherCalls, []);
  } finally { c.db.setAuthorizer(null); reader.close(); }
});

test('MCP versioned status never attempts the previously failing SQLite task save', async t => {
  const { c, id } = await automaticAttempt(t, { versioned: true }), { get } = await statusClient(t, c);
  const before = statusLedger(c.db), fault = sqliteAbort(c, 'tasks', '1');
  try {
    const result = await get(id);
    assert.equal(fault.hits, 0, 'Unnecessary status task write triggered an actual SQLite ABORT');
    assert.notEqual(result.isError, true); assert.equal(result.structuredContent.automatic.review.potentially_correctable, true);
    assert.equal(c.persistenceFailures.has(id), false); assert.equal(c.transactionUnresolved, false);
    assert.equal(statusLedger(c.db), before);
  } finally { c.db.exec('DROP TRIGGER evidence_fault'); }
});

for (const [location, missing] of [['source', 'baseline'], ['source', 'tree'], ['source', 'blob'],
  ['github', 'baseline'], ['github', 'tree'], ['reference', 'baseline'], ['reference', 'tree'], ['reference', 'blob']])
test(`MCP versioned status cannot lazily fetch a missing ${location} ${missing}`, async t => {
  const { c, id, normal, root, calls, publisherCalls } = await automaticAttempt(t, { versioned: true, async configure(c, input) {
    if (location === 'github') await githubStatusFixture(c, input);
    if (location === 'reference') {
      const normal = path.join(path.dirname(c.stateRoot), 'normal');
      await fs.writeFile(path.join(normal, 'reference.txt'), 'unchanged reference\n');
      repoGit(normal, 'add', 'reference.txt');
      repoGit(normal, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'reference');
      input.contract.reference_files = ['reference.txt'];
    }
  } });
  const { get } = await statusClient(t, c);
  assert.equal((await get(id)).structuredContent.automatic.review.potentially_correctable, true);
  // Only this disposable local remote can supply the promised objects. No
  // external transport, production registration or shared repository is used.
  const remote = path.join(root, 'promisor.git');
  const workspace = path.join(c.workspaceRoot, id), repo = location === 'reference' ? path.join(workspace, 'repo') : normal;
  repoGit(repo, 'clone', '--bare', '--no-hardlinks', repo, remote);
  repoGit(repo, 'remote', 'add', 'fixture', remote);
  repoGit(repo, 'config', 'remote.fixture.promisor', 'true');
  repoGit(repo, 'config', 'remote.fixture.partialclonefilter', 'blob:none');
  const oid = missing === 'baseline' ? c.task(id).baseline : repoGit(repo, 'rev-parse', missing === 'tree' ? 'HEAD^{tree}' :
    `HEAD:${location === 'reference' ? 'reference.txt' : 'greeting.txt'}`).trim();
  const store = location === 'reference' ? path.join(workspace, 'git-store') : path.join(normal, '.git');
  const object = path.join(store, 'objects', oid.slice(0, 2), oid.slice(2));
  await fs.unlink(object);
  const reader = new DatabaseSync(path.join(c.stateRoot, 'controller.sqlite'), { readOnly: true });
  const registry = path.join(c.stateRoot, 'repositories.json');
  const before = statusLedger(reader), files = await statusFiles(normal, workspace, registry, remote), writes = [];
  const packs = await fs.readdir(path.join(store, 'objects/pack'));
  const historical = c.task(id).reviewer.review_result, deadline = c.task(id).deadline;
  const fault = sqliteAbort(c, 'tasks', '1');
  c.db.setAuthorizer((action, table) => {
    if ([sqlite.SQLITE_INSERT, sqlite.SQLITE_UPDATE, sqlite.SQLITE_DELETE].includes(action) && statusTables.includes(table)) writes.push(table);
    return sqlite.SQLITE_OK;
  });
  // These are forbidden even if a status verification fails midway through.
  const starts = [];
  c.localBackendFactory = () => { starts.push('model'); throw Error('Status started a model'); };
  c.localValidationFactory = () => { starts.push('validation'); throw Error('Status started validation'); };
  c.publisher = { target() { starts.push('publication'); throw Error('Status started publication'); } };
  try {
    for (let count = 0; count < 3; count++) {
      const result = await get(id); assert.notEqual(result.isError, true);
      assert.equal(result.structuredContent.automatic.review.potentially_correctable, false);
      assert.equal(result.structuredContent.automatic.review.execution_authorized, false);
      assert(result.structuredContent.automatic.review.blockers.includes('REVIEW_EVIDENCE_UNVERIFIED'));
      assert.deepEqual(await fs.readdir(path.join(store, 'objects/pack')), packs, 'Status lazily fetched promised objects');
      await assert.rejects(fs.access(object), { code: 'ENOENT' });
      assert.equal(await statusFiles(normal, workspace, registry, remote), files);
      assert.equal(statusLedger(reader), before);
      assert.equal(c.task(id).deadline, deadline);
      assert.deepEqual(c.task(id).reviewer.review_result, historical);
    }
    assert.equal(fault.hits, 0); assert.deepEqual(writes, []); assert.deepEqual(starts, []);
    assert.deepEqual(calls, ['implementer', 'reviewer']); assert.deepEqual(publisherCalls, []);
  } finally { c.db.setAuthorizer(null); c.db.exec('DROP TRIGGER evidence_fault'); reader.close(); }
});

test('MCP versioned status denies qualification after actual registration removal without rewriting history', async t => {
  const { c, id, input, calls, publisherCalls } = await automaticAttempt(t, { versioned: true }), { get } = await statusClient(t, c);
  const registry = path.join(c.stateRoot, 'repositories.json'), original = await fs.readFile(registry, 'utf8');
  assert.equal((await get(id)).structuredContent.automatic.review.potentially_correctable, true);
  await fs.writeFile(registry, JSON.stringify({ version: 1, repositories: {} }));
  await assert.rejects(c.start({ ...input, request_id: 'removed_registration' }), /UNKNOWN_REPOSITORY_ID/);
  const before = statusLedger(c.db), result = await get(id);
  assert.notEqual(result.isError, true); assert.equal(result.structuredContent.automatic.review.potentially_correctable, false);
  assert(result.structuredContent.automatic.review.blockers.includes('REVIEW_EVIDENCE_UNVERIFIED'));
  assert.equal(statusLedger(c.db), before); assert.equal(c.task(id).reviewer.review_result.actionability_qualification.potentially_correctable, true);
  await fs.writeFile(registry, original);
  assert.equal((await get(id)).structuredContent.automatic.review.potentially_correctable, true);
  assert.deepEqual(calls, ['implementer', 'reviewer']); assert.deepEqual(publisherCalls, []);
});

for (const location of ['source', 'candidate']) test(`MCP versioned status cannot execute a ${location} clean filter`, async t => {
  const { c, id, normal, calls, publisherCalls } = await automaticAttempt(t, { versioned: true });
  const { get } = await statusClient(t, c), workspace = path.join(c.workspaceRoot, id);
  assert.equal((await get(id)).structuredContent.automatic.review.potentially_correctable, true);
  const repo = location === 'source' ? normal : path.join(workspace, 'repo');
  const store = location === 'source' ? path.join(normal, '.git') : path.join(workspace, 'git-store');
  await fs.writeFile(path.join(store, 'info/attributes'), '*.txt filter=fixture\n');
  repoGit(repo, 'config', 'filter.fixture.clean', 'cat; printf ran > status-filter-ran');
  // Matching indexed size forces Git to compare bytes instead of stopping at
  // the stat size difference, which would hide execution of the clean filter.
  await fs.writeFile(path.join(repo, 'greeting.txt'), 'changed!\n');
  const registry = path.join(c.stateRoot, 'repositories.json'), before = await statusFiles(normal, workspace, registry);
  const ledger = statusLedger(c.db);
  for (let count = 0; count < 3; count++) {
    const result = await get(id); assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.automatic.review.potentially_correctable, false);
    assert.equal(result.structuredContent.automatic.review.execution_authorized, false);
    await assert.rejects(fs.access(path.join(repo, 'status-filter-ran')), { code: 'ENOENT' });
    assert.equal(await statusFiles(normal, workspace, registry), before);
    assert.equal(statusLedger(c.db), ledger);
  }
  assert.deepEqual(calls, ['implementer', 'reviewer']); assert.deepEqual(publisherCalls, []);
});

for (const location of ['index', 'head']) test(`MCP versioned status rejects current ${location} submodule entries before status recursion`, async t => {
  const { c, id, normal, calls, publisherCalls } = await automaticAttempt(t, { versioned: true });
  const { get } = await statusClient(t, c), task = c.task(id), workspace = path.join(c.workspaceRoot, id);
  assert.equal((await get(id)).structuredContent.automatic.review.potentially_correctable, true);
  if (location === 'head') repoGit(normal, 'switch', '-c', 'other');
  repoGit(normal, 'update-index', '--add', '--cacheinfo', `160000,${task.baseline},nested`);
  if (location === 'head') {
    repoGit(normal, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'gitlink');
    repoGit(normal, 'update-index', '--force-remove', 'nested');
  }
  const registry = path.join(c.stateRoot, 'repositories.json'), before = await statusFiles(normal, workspace, registry);
  const ledger = statusLedger(c.db);
  await assert.rejects(c.verifyLocalReviewPacket(task, { readOnly: true }), { code: 'LOCAL_REVIEW_EXECUTION_UNVERIFIED' });
  for (let count = 0; count < 3; count++) {
    const result = await get(id); assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.automatic.review.potentially_correctable, false);
    assert.equal(result.structuredContent.automatic.review.execution_authorized, false);
    assert.equal(await statusFiles(normal, workspace, registry), before);
    assert.equal(statusLedger(c.db), ledger);
  }
  assert.deepEqual(c.task(id).reviewer.review_result, task.reviewer.review_result);
  assert.deepEqual(calls, ['implementer', 'reviewer']); assert.deepEqual(publisherCalls, []);
});

for (const changed of ['identity', 'path', 'corrupt', 'missing', 'unsafe', 'symlink']) test(`MCP versioned status rejects ${changed} registry authority and recovers observationally`, async t => {
  const { c, id, normal, calls, publisherCalls } = await automaticAttempt(t, { versioned: true }), { get } = await statusClient(t, c);
  const file = path.join(c.stateRoot, 'repositories.json'), original = await fs.readFile(file, 'utf8'), registry = JSON.parse(original);
  const historical = c.task(id).reviewer.review_result, workspace = path.join(c.workspaceRoot, id);
  assert.equal((await get(id)).structuredContent.automatic.review.potentially_correctable, true);
  if (changed === 'identity') { registry.repositories.fixture.git_identity.ino = 'changed'; await fs.writeFile(file, JSON.stringify(registry)); }
  if (changed === 'path') { registry.repositories.fixture.path = path.join(normal, 'missing'); await fs.writeFile(file, JSON.stringify(registry)); }
  if (changed === 'corrupt') await fs.writeFile(file, '{"version":');
  if (changed === 'missing') await fs.unlink(file);
  if (changed === 'unsafe') await fs.chmod(file, 0o666);
  if (changed === 'symlink') { await fs.unlink(file); await fs.symlink(path.join(workspace, 'contract.json'), file); }
  const reader = new DatabaseSync(path.join(c.stateRoot, 'controller.sqlite'), { readOnly: true });
  try {
    const before = statusLedger(reader), files = await statusFiles(normal, workspace);
    for (let count = 0; count < 3; count++) {
      const result = await get(id); assert.notEqual(result.isError, true);
      assert.equal(result.structuredContent.automatic.review.potentially_correctable, false);
      assert(result.structuredContent.automatic.review.blockers.includes('REVIEW_EVIDENCE_UNVERIFIED'));
    }
    assert.equal(statusLedger(reader), before); assert.equal(await statusFiles(normal, workspace), files);
    assert.deepEqual(c.task(id).reviewer.review_result, historical);
  } finally { reader.close(); }
  if (changed === 'symlink') await fs.unlink(file);
  await fs.writeFile(file, original, { mode: 0o600 }); await fs.chmod(file, 0o600);
  assert.equal((await get(id)).structuredContent.automatic.review.potentially_correctable, true);
  assert.deepEqual(calls, ['implementer', 'reviewer']); assert.deepEqual(publisherCalls, []);
});

async function githubStatusFixture(c, input) {
  // Existing locally seeded fixture registration only; no registration service,
  // GitHub request, fetch or production registry is used by this test.
  const normal = path.join(path.dirname(c.stateRoot), 'normal');
  await fs.chmod(normal, 0o700);
  await fs.chmod(path.join(normal, 'greeting.txt'), 0o644);
  await fs.rm(path.join(normal, '.git/hooks'), { recursive: true });
  await fs.rmdir(path.join(normal, '.git/branches'));
  await fs.unlink(path.join(normal, '.git/COMMIT_EDITMSG'));
  repoGit(normal, 'remote', 'add', 'origin', 'https://github.com/fixture/repository.git');
  const baseline = repoGit(normal, 'rev-parse', 'HEAD').trim();
  input.repository_id = 'github_123';
  await fs.writeFile(path.join(c.stateRoot, 'repositories.json'), JSON.stringify({ version: 1,
    repositories: { github_123: await repositoryIdentity(normal) }, github_repositories: {
      github_123: { repository_id: 123, owner_id: 456, full_name: 'fixture/repository', private: true, default_branch: 'main', baseline_commit: baseline },
    } }));
}

for (const changed of ['metadata removed', 'origin binding', 'baseline binding', 'owner binding'])
  test(`MCP versioned status verifies current GitHub registration: ${changed}`, async t => {
    const { c, id, normal, calls, publisherCalls } = await automaticAttempt(t, { versioned: true, configure: githubStatusFixture });
    const { get } = await statusClient(t, c), file = path.join(c.stateRoot, 'repositories.json');
    const original = await fs.readFile(file, 'utf8'), registry = JSON.parse(original);
    assert.equal((await get(id)).structuredContent.automatic.review.potentially_correctable, true);
    const binding = registry.github_repositories.github_123;
    if (changed === 'metadata removed') delete registry.github_repositories;
    if (changed === 'origin binding') binding.full_name = 'fixture/another-repository';
    if (changed === 'baseline binding') binding.baseline_commit = 'f'.repeat(40);
    if (changed === 'owner binding') binding.owner_id++;
    await fs.writeFile(file, JSON.stringify(registry));
    const reader = new DatabaseSync(path.join(c.stateRoot, 'controller.sqlite'), { readOnly: true });
    try {
      const before = statusLedger(reader), files = await statusFiles(normal, path.join(c.workspaceRoot, id), file);
      for (let count = 0; count < 2; count++) {
        const result = await get(id); assert.notEqual(result.isError, true);
        assert.equal(result.structuredContent.automatic.review.potentially_correctable, false);
      }
      assert.equal(statusLedger(reader), before); assert.equal(await statusFiles(normal, path.join(c.workspaceRoot, id), file), files);
      assert.equal(c.task(id).reviewer.review_result.actionability_qualification.potentially_correctable, true);
    } finally { reader.close(); }
    await fs.writeFile(file, original);
    assert.equal((await get(id)).structuredContent.automatic.review.potentially_correctable, true);
    assert.deepEqual(calls, ['implementer', 'reviewer']); assert.deepEqual(publisherCalls, []);
  });

test('MCP versioned status preserves live personal tunnel authorization on every lookup', async t => {
  const { c, id } = await automaticAttempt(t, { versioned: true });
  const now = Date.now(), live = { id: 'tunnel_test', organization_ids: ['org_fixture'], workspace_ids: ['workspace_fixture'] };
  const file = path.join(c.stateRoot, 'personal-tunnel.json');
  await fs.writeFile(file, JSON.stringify({ tunnel_id: 'tunnel_test', personal_only: true, sole_authorized_user: true,
    verification_method: 'owner_checked_platform_settings', platform_organization_id: 'org_fixture', chatgpt_workspace_id: 'workspace_fixture',
    associated_organizations: ['org_fixture'], associated_workspaces: ['workspace_fixture'],
    verified_at: new Date(now).toISOString(), expires_at: new Date(now + 60000).toISOString() }), { mode: 0o600 });
  let lookups = 0;
  const { get } = await statusClient(t, c, () => authorizePersonalTunnel({ stateRoot: c.stateRoot, expectedTunnel: 'tunnel_test', now,
    lookup: async () => { lookups++; return live; } }));
  const before = statusLedger(c.db), confirmation = await fs.readFile(file, 'utf8');
  for (let count = 0; count < 2; count++) assert.notEqual((await get(id)).isError, true);
  live.organization_ids = ['other']; const denied = await get(id);
  assert.equal(denied.isError, true); assert.match(denied.content[0].text, /LIVE_TUNNEL_ASSOCIATION_MISMATCH/);
  assert.equal(lookups, 3); assert.equal(statusLedger(c.db), before); assert.equal(await fs.readFile(file, 'utf8'), confirmation);
});

test('MCP versioned status never repairs a conflicting backend or synthesizes a failure diagnostic', async t => {
  const { c, id } = await automaticAttempt(t, { versioned: true }), { get } = await statusClient(t, c);
  const original = c.task(id), changed = structuredClone(original);
  changed.execution_backend = 'agents_api'; changed.implementer.state = 'failed';
  // Inject an inconsistent stored record; this is not authorized admission or a
  // claim of immunity to privileged SQLite tampering.
  c.db.prepare('UPDATE tasks SET value=? WHERE id=?').run(JSON.stringify(changed), id);
  const before = statusLedger(c.db), fault = sqliteAbort(c, 'failures', '1');
  try {
    const result = await get(id); assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.automatic.review.potentially_correctable, false);
    assert.equal(fault.hits, 0); assert.equal(statusLedger(c.db), before);
  } finally {
    c.db.exec('DROP TRIGGER evidence_fault');
    c.db.prepare('UPDATE tasks SET value=? WHERE id=?').run(JSON.stringify(original), id);
  }
});

test('MCP typed status preserves mutation audits and makes manual status observational', async t => {
  const { c, api } = await setup(t), { client, get } = await statusClient(t, c);
  const started = await client.callTool({ name: 'start_task', arguments: { contract: contract(), request_id: 'mcp_mutation_start' } });
  assert.notEqual(started.isError, true); const id = started.structuredContent.task_id;
  await Promise.all([...c.jobs.values()]); api.completed(c.task(id).implementer.session_id);
  assert.notEqual((await get(id)).isError, true);
  const audited = c.db.prepare('SELECT value FROM audit').all().map(row => JSON.parse(row.value));
  assert(audited.some(row => row.tool === 'start_task' && row.task_id === id && row.session_id));
  assert(!audited.some(row => row.tool === 'get_task'));
  assert.notEqual((await client.callTool({ name: 'cleanup_task', arguments: { task_id: id, delete_workspace: false } })).isError, true);
  assert(c.db.prepare('SELECT value FROM audit').all().map(row => JSON.parse(row.value)).some(row => row.tool === 'cleanup_task' && row.task_id === id));
  const legacy = await automaticAttempt(t), status = await statusClient(t, legacy.c);
  const before = statusLedger(legacy.c.db);
  assert.notEqual((await status.get(legacy.id)).isError, true);
  assert.equal(statusLedger(legacy.c.db), before);
  assert(!legacy.c.db.prepare('SELECT value FROM audit').all().map(row => JSON.parse(row.value)).some(row => row.tool === 'get_task'));
  assert.equal(legacy.c.task(legacy.id).automatic.authorization.max_codex_turns, 2);
  assert.equal(legacy.c.task(legacy.id).automatic.authorization.max_corrections, 0);
});

for (const mode of [{ cause: 'missing_evidence' }, { cause: 'unknown_cause' }, { cause: 'human_decision_required' },
  { cause: 'scope_or_security_failure' }, { humanApproval: true }]) test(`versioned automatic non-correctable FAIL: ${mode.cause || 'human approval'}`, async t => {
  const { c, id, calls, publisherCalls } = await automaticAttempt(t, { versioned: true, ...mode });
  const task = c.task(id), view = await c.get(id);
  assert.equal(task.reviewer.review_result.overall, 'FAIL'); assert.equal(task.reviewer.review_result.actionability_qualification.potentially_correctable, false);
  assert.equal(view.automatic.review.state, 'non_correctable_fail'); assert.equal(view.automatic.review.execution_authorized, false);
  assert.equal(view.automatic.usage.correction_turns, 0); assert.deepEqual(calls, ['implementer', 'reviewer']); assert.deepEqual(publisherCalls, []);
});

for (const gate of ['SCOPE', 'TEST_EVIDENCE']) test(`versioned reviewer ${gate} FAIL remains non-correctable in the Controller`, async t => {
  const { c, id, calls, publisherCalls } = await automaticAttempt(t, { versioned: true, output(raw) {
    const finding = raw.findings.find(item => item.id === gate); finding.status = 'FAIL';
    finding.classification = { kind: gate === 'SCOPE' ? 'scope_or_security_failure' : 'missing_evidence' };
  } });
  const task = c.task(id); assert.equal(task.reviewer.review_result.actionability_qualification.potentially_correctable, false);
  assert.equal((await c.get(id)).automatic.review.state, 'non_correctable_fail');
  assert.deepEqual(calls, ['implementer', 'reviewer']); assert.deepEqual(publisherCalls, []);
});

for (const conflict of ['validation', 'publication']) test(`versioned Controller derives uncertainty from ${conflict} evidence`, async t => {
  const { c, id, calls, publisherCalls } = await automaticAttempt(t, { versioned: true, beforeResult(controller) {
    const task = JSON.parse(controller.db.prepare('SELECT value FROM tasks').get().value);
    if (conflict === 'validation') task.local_validation.status = 'unavailable';
    else task.publication_error = 'PUBLICATION_OUTCOME_UNCONFIRMED';
    controller.save(task);
  } });
  const result = c.task(id).reviewer.review_result;
  if (conflict === 'validation') assert.equal(result, null); // Original receipt's validation binding changed.
  else { assert.equal(result.controller_context.uncertaintyFree, false); assert.equal(result.actionability_qualification.potentially_correctable, false); }
  assert.equal((await c.get(id)).automatic.review.execution_authorized, false);
  assert.deepEqual(calls, ['implementer', 'reviewer']); assert.deepEqual(publisherCalls, []);
});

for (const [label, mode] of [
  ['wrong version', { output: raw => raw.format = 'pab.local-review.actionability.v999' }],
  ['missing version', { output: raw => delete raw.format }],
  ['model context injection', { output: raw => raw.reviewerIndependent = true }],
  ['reviewer uncertainty', { uncertain: true }],
  ['thread conflict', { result: { threadId: 'different-review-thread' } }],
  ['turn conflict', { result: { turnId: 'different-review-turn' } }],
  ['packet conflict', { beforeResult: async (_c, options) => { const file = path.join(options.cwd, 'evidence.json'); await fs.chmod(file, 0o600); await fs.appendFile(file, 'changed'); } }],
  ['candidate conflict', { beforeResult: async (_c, options) => fs.appendFile(path.join(options.cwd, '..', 'repo', 'greeting.txt'), 'changed') }],
]) test(`versioned automatic ${label} fails closed without replay`, async t => {
  const { c, id, calls, publisherCalls } = await automaticAttempt(t, { versioned: true, ...mode }), task = c.task(id);
  assert.equal(task.reviewer.review_result, null); assert(['stopped', 'uncertain'].includes(task.automatic.status));
  const view = await c.get(id); assert.equal(view.automatic.review.state, 'malformed_or_uncertain');
  assert.equal(view.automatic.review.potentially_correctable, false); assert.equal(view.automatic.review.execution_authorized, false);
  assert.equal(view.automatic.usage.correction_turns, 0); assert.deepEqual(calls, ['implementer', 'reviewer']); assert.deepEqual(publisherCalls, []);
});

test('legacy automatic dispatch cannot be switched by a versioned model result', async t => {
  const { c, id, prompts, calls } = await automaticAttempt(t, { versioned: true, configure: (_c, input) => delete input.automatic.review_protocol });
  assert.deepEqual(prompts, [localReviewerInstructions]); assert.equal(c.task(id).reviewer.review_result, null);
  assert.equal((await c.get(id)).automatic.review.protocol, 'pab.local-review.v2'); assert.deepEqual(calls, ['implementer', 'reviewer']);
});

test('versioned automatic expiry derives invalid authority without extending its deadline', async t => {
  let now;
  const value = await automaticAttempt(t, { versioned: true, beforeResult(c) {
    const task = JSON.parse(c.db.prepare('SELECT value FROM tasks').get().value);
    now = t.mock.method(Date, 'now', () => task.deadline + 1);
  } });
  try {
    const { c, id, calls, publisherCalls } = value, task = c.task(id), result = task.reviewer.review_result;
    assert.equal(result.controller_context.authorityValid, false); assert.equal(result.actionability_qualification.potentially_correctable, false);
    assert.equal(task.automatic.reason, 'TASK_EXPIRED'); assert.equal(task.deadline, task.automatic.review_authorization.deadline);
    assert.equal((await c.get(id)).automatic.review.potentially_correctable, false);
    assert.deepEqual(calls, ['implementer', 'reviewer']); assert.deepEqual(publisherCalls, []);
  } finally { now?.mock.restore(); }
});

for (const boundary of ['packet', 'review', 'receipt']) test(`versioned SQLite ${boundary} failure preserves evidence and reconciles without model replay`, async t => {
  const value = await automaticAttempt(t, { versioned: true, configure(c) {
    if (boundary === 'receipt') sqliteAbort(c, 'tasks', "json_extract(NEW.value,'$.reviewer.pending_review_result.sha256') IS NOT NULL");
    else sqliteAbort(c, 'automatic_attempts', `json_extract(NEW.value,'$.kind')='${boundary === 'packet' ? 'review_packet' : 'review_result'}'`);
  } });
  const { c, id, calls, publisherCalls } = value, task = c.task(id), receipt = task.reviewer.pending_review_result || c.pendingReviewResults.get(id);
  const packet = await fs.readFile(path.join(c.workspaceRoot, id, task.reviewer.packet_directory, 'evidence.json'), 'utf8');
  if (boundary !== 'packet') { assert(receipt); assert.equal(receipt.result.validation_contract, LOCAL_ACTIONABILITY_REVIEW_VERSION); assert.equal(receipt.sha256, digest(receipt.result)); }
  assert.equal((await c.cleanup({ task_id: id, delete_workspace: true })).cleanup.workspace_deleted, false);
  await c.cleanup({ task_id: id, delete_workspace: false });
  const records = attemptRows(c, id).map(row => JSON.parse(row.value));
  assert(records.some(record => record.packet_utf8 === packet));
  if (receipt) assert(records.some(record => record.findings_sha256 === receipt.sha256 && digest(record.review_result) === receipt.sha256));
  assert.equal((await c.get(id)).automatic.review.potentially_correctable, false);
  const recovered = await restartEvidenceController(t, value);
  assert.equal((await recovered.get(id)).automatic.review.execution_authorized, false);
  assert.deepEqual(calls, boundary === 'packet' ? ['implementer'] : ['implementer', 'reviewer']); assert.deepEqual(publisherCalls, []);
});

test('versioned protocol is frozen after admission and restart never grants replay authority', async t => {
  const value = await automaticAttempt(t, { versioned: true }), { c, id, calls } = value;
  const changed = c.task(id); delete changed.automatic.authorization.review_protocol;
  assert.throws(() => c.save(changed), /AUTOMATIC_EVIDENCE_PERSISTENCE_UNCONFIRMED/);
  assert.equal(c.task(id).automatic.authorization.review_protocol, LOCAL_ACTIONABILITY_REVIEW_VERSION);
  const recovered = await restartEvidenceController(t, value);
  assert.equal(recovered.task(id).reviewer.review_protocol, LOCAL_ACTIONABILITY_REVIEW_VERSION);
  const view = await recovered.get(id); assert.equal(view.automatic.review.potentially_correctable, false); assert.equal(view.automatic.review.execution_authorized, false);
  await recovered.start(value.input); assert.deepEqual(calls, ['implementer', 'reviewer']); assert.equal(view.automatic.usage.correction_turns, 0);
});

const receivedOutputFault = (c, boundary) => sqliteAbort(c, 'tasks', boundary === 'receipt' ?
  "json_extract(NEW.value,'$.reviewer.received_output_sha256') IS NOT NULL AND json_extract(NEW.value,'$.reviewer.local.result_received')=0" :
  `json_extract(NEW.value,'$.reviewer.pending_review_output')=1 AND json_extract(NEW.value,'$.reviewer.local.result_received')=1 AND
   json_extract(NEW.value,'$.reviewer.local.phase')='validating' AND json_extract(NEW.value,'$.reviewer.local.server_closed')=${boundary === 'completion' ? 0 : 1}`);

for (const versioned of [false, true]) for (const boundary of ['completion', 'closure', 'receipt']) test(`SQLite ${boundary} ABORT preserves unverified ${versioned ? 'versioned' : 'legacy'} returned output before acceptance`, async t => {
  let fault, output;
  const { c, id, calls, publisherCalls } = await automaticAttempt(t, { versioned, returnedOutput: text => output = text,
    configure(c) { fault = receivedOutputFault(c, boundary); } });
  assert.equal(fault.hits, 1);
  const before = c.task(id), durable = before.reviewer.received_review_output, memory = c.pendingReviewResults.get(id);
  assert.equal(before.reviewer.review_result, null); assert.equal(before.reviewer.pending_review_result, undefined);
  assert.equal(before.automatic.status, 'uncertain');
  assert.equal(memory.received_output.output, output); assert.equal(memory.received_output.output_sha256, digest(output));
  assert.equal(memory.sha256, digest(memory.received_output)); assert.equal(memory.server_closed, true);
  assert(!JSON.stringify(memory).includes('Private reasoning'));
  assert.equal(!!durable, boundary !== 'receipt');
  if (durable) assert.equal(durable.output, output);
  const status = await c.get(id);
  assert.equal(status.automatic.evidence_retention.received_output, durable ? 'durable' : 'volatile_only');
  assert.equal(status.automatic.evidence_retention.received_output_complete, true);
  assert.equal(status.automatic.evidence_retention.reconciliation_required, true);
  assert.notEqual(c.db.prepare('SELECT status FROM operations WHERE id=?').get(before.reviewer.request_id).status, 'accepted');
  assert(!attemptRows(c, id).some(row => JSON.parse(row.value).review_result));
  assert.equal((await c.cleanup({ task_id: id, delete_workspace: true })).cleanup.workspace_deleted, false);
  const reconciled = await c.cleanup({ task_id: id, delete_workspace: false });
  assert.equal(reconciled.automatic.evidence_retention.reconciliation_required, false);
  const task = c.task(id), records = attemptRows(c, id).map(row => JSON.parse(row.value));
  assert.equal(task.reviewer.received_review_output.output, output); assert.equal(task.reviewer.review_result.overall, 'FAIL');
  assert.deepEqual(task.reviewer.review_result.findings.map(item => item.id), JSON.parse(output).findings.map(item => item.id));
  assert(records.some(record => record.received_review_output?.output === output && record.received_output_sha256 === digest(record.received_review_output)));
  assert(records.some(record => record.findings_sha256 === digest(task.reviewer.review_result)));
  assert(!JSON.stringify(records).includes('Private reasoning'));
  assert.equal((await c.cleanup({ task_id: id, delete_workspace: true })).cleanup.workspace_deleted, true);
  assert.deepEqual(calls, ['implementer', 'reviewer']); assert.deepEqual(publisherCalls, []);
  assert.equal(task.deadline, before.deadline); assert.equal(reconciled.automatic.usage.correction_turns, 0);
});

for (const boundary of ['completion', 'closure']) test(`restart reconciles durable returned output after ${boundary} failure without restoring authority`, async t => {
  const value = await automaticAttempt(t, { versioned: true, configure(c) { receivedOutputFault(c, boundary); } });
  const { id, calls, publisherCalls } = value, original = value.c.task(id).reviewer.received_review_output;
  if (boundary === 'closure') {
    // Interrupt explicit reconciliation after it commits the observed close,
    // before the qualified receipt commits. Restart must use only those facts.
    value.c.db.exec('DROP TRIGGER evidence_fault');
    const second = sqliteAbort(value.c, 'tasks', "json_extract(NEW.value,'$.reviewer.pending_review_result.sha256') IS NOT NULL");
    await value.c.cleanup({ task_id: id, delete_workspace: false });
    assert.equal(second.hits, 1); assert.equal(value.c.task(id).reviewer.local.server_closed, true);
    assert.equal(value.c.task(id).reviewer.review_result, null);
  }
  const c = await restartEvidenceController(t, value);
  assert.equal(c.task(id).reviewer.received_review_output.output, original.output);
  await c.cleanup({ task_id: id, delete_workspace: false });
  assert.equal(c.task(id).reviewer.review_result.overall, 'FAIL');
  const view = await c.get(id);
  assert.equal(view.automatic.review.potentially_correctable, false);
  assert.equal(view.automatic.evidence_retention.received_output_complete, true);
  assert.equal(c.task(id).reviewer.received_output_sha256, digest(original));
  assert.deepEqual(calls, ['implementer', 'reviewer']); assert.deepEqual(publisherCalls, []); assert.equal(c.automaticJobs.size, 0);
});

test('restart without a durable returned-output receipt reports unrecoverable findings instead of inventing them', async t => {
  const value = await automaticAttempt(t, { configure(c) { receivedOutputFault(c, 'receipt'); } }), { id } = value;
  assert(value.c.pendingReviewResults.get(id).received_output);
  assert.equal(value.c.task(id).reviewer.received_review_output, undefined);
  const c = await restartEvidenceController(t, value);
  assert.equal(c.pendingReviewResults.has(id), false);
  const view = await c.cleanup({ task_id: id, delete_workspace: false });
  assert.match(view.cleanup.cleanup_diagnostic, /AUTOMATIC_REVIEW_RESULT_NOT_DURABLY_RECEIVED/);
  assert.equal(view.automatic.evidence_retention.received_output, 'unavailable');
  assert.equal((await c.cleanup({ task_id: id, delete_workspace: true })).cleanup.workspace_deleted, false);
  assert(!attemptRows(c, id).some(row => JSON.parse(row.value).review_result));
});

for (const change of ['output', 'digest', 'thread', 'packet', 'authority']) test(`returned-output receipt rejects ${change} tampering during reconciliation`, async t => {
  const { c, id, calls, publisherCalls } = await automaticAttempt(t, { versioned: true, configure(c) { receivedOutputFault(c, 'receipt'); } });
  const memory = c.pendingReviewResults.get(id), original = structuredClone(memory);
  if (change === 'output') memory.received_output.output += 'changed';
  if (change === 'digest') memory.sha256 = 'f'.repeat(64);
  if (change === 'thread') memory.received_output.binding.reviewer_thread = 'other-thread';
  if (change === 'packet') memory.received_output.binding.packet_hash = 'f'.repeat(64);
  if (change === 'authority') memory.received_output.binding.deadline++;
  if (!['output', 'digest'].includes(change)) memory.sha256 = digest(memory.received_output);
  await assert.rejects(c.reconcileAutomaticEvidence(id), /AUTOMATIC_REVIEW_RECEIPT_INVALID/);
  assert.equal(c.task(id).reviewer.review_result, null);
  assert.equal((await c.cleanup({ task_id: id, delete_workspace: true })).cleanup.workspace_deleted, false);
  assert.deepEqual(calls, ['implementer', 'reviewer']); assert.deepEqual(publisherCalls, []);
  // Restore test corruption to the exact original receipt for teardown only.
  c.db.prepare('UPDATE tasks SET value=? WHERE id=?').run(JSON.stringify({ ...c.task(id), reviewer: {
    ...c.task(id).reviewer, received_review_output: original.received_output, received_output_sha256: original.sha256 } }), id);
  c.pendingReviewResults.set(id, original);
});

test('second actual SQLite ABORT during receipt reconciliation preserves raw output and blocks deletion', async t => {
  const { c, id, calls } = await automaticAttempt(t, { versioned: true, configure(c) { receivedOutputFault(c, 'completion'); } });
  const original = c.task(id).reviewer.received_review_output;
  c.db.exec('DROP TRIGGER evidence_fault');
  const fault = sqliteAbort(c, 'tasks', "json_extract(NEW.value,'$.reviewer.pending_review_result.sha256') IS NOT NULL");
  const unresolved = await c.cleanup({ task_id: id, delete_workspace: false });
  assert.equal(fault.hits, 1); assert.equal(unresolved.automatic.evidence_retention.reconciliation_required, true);
  assert.deepEqual(c.task(id).reviewer.received_review_output, original);
  assert.equal((await c.cleanup({ task_id: id, delete_workspace: true })).cleanup.workspace_deleted, false);
  await c.cleanup({ task_id: id, delete_workspace: false });
  assert.equal(c.task(id).reviewer.review_result.overall, 'FAIL'); assert.deepEqual(calls, ['implementer', 'reviewer']);
});

test('missing durable reviewer termination after restart cannot qualify received output', async t => {
  const value = await automaticAttempt(t, { versioned: true, configure(c) { receivedOutputFault(c, 'closure'); } }), { id } = value;
  assert.equal(value.c.task(id).reviewer.local.server_closed, false);
  const c = await restartEvidenceController(t, value);
  const view = await c.cleanup({ task_id: id, delete_workspace: false });
  assert.match(view.cleanup.cleanup_diagnostic, /LOCAL_REVIEW_EXECUTION_UNVERIFIED/);
  assert(c.task(id).reviewer.received_review_output); assert.equal(c.task(id).reviewer.review_result, null);
  assert.equal((await c.cleanup({ task_id: id, delete_workspace: true })).cleanup.workspace_deleted, false);
});

test('manual local review uses the same recoverable receipt lifecycle after completion write failure', async t => {
  const { c, id, calls } = await automaticAttempt(t, { manual: true, configure(c) { receivedOutputFault(c, 'completion'); } });
  const output = c.task(id).reviewer.received_review_output.output;
  assert.equal((await c.cleanup({ task_id: id, delete_workspace: true })).cleanup.workspace_deleted, false);
  await c.cleanup({ task_id: id, delete_workspace: false });
  assert.equal(c.task(id).reviewer.review_result.overall, 'FAIL'); assert.equal(c.task(id).reviewer.received_review_output.output, output);
  assert.deepEqual(calls, ['implementer', 'reviewer']);
});

test('received but unverified PASS cannot authorize publication, including after explicit recovery', async t => {
  const { c, id, calls, publisherCalls } = await automaticAttempt(t, { versioned: true, configure(c) { receivedOutputFault(c, 'completion'); },
    output(raw) { raw.overall = 'PASS'; for (const finding of raw.findings) { finding.status = 'PASS'; finding.classification = null; } } });
  assert.equal(JSON.parse(c.task(id).reviewer.received_review_output.output).overall, 'PASS');
  assert.equal(c.task(id).reviewer.review_result, null); assert.equal(c.task(id).reviewer.pending_review_result, undefined);
  assert.equal((await c.get(id)).automatic.review.execution_authorized, false);
  await c.cleanup({ task_id: id, delete_workspace: false });
  assert.equal(c.task(id).reviewer.review_result.overall, 'PASS');
  assert.equal(c.task(id).reviewer.review_result.controller_context.authorityValid, false);
  assert.equal(c.task(id).automatic.status, 'uncertain');
  assert.equal((await c.get(id)).automatic.usage.correction_turns, 0);
  assert.deepEqual(calls, ['implementer', 'reviewer']); assert.deepEqual(publisherCalls, []);
});

for (const mode of [{ incomplete: true }, { uncertain: true }, { result: { status: 'failed' } }, { result: { status: 'interrupted' } }])
  test(`explicit recovery retains incomplete/uncertain output without inventing a qualified result: ${JSON.stringify(mode)}`, async t => {
    const { c, id, calls, publisherCalls } = await automaticAttempt(t, { versioned: true, ...mode, configure(c) { receivedOutputFault(c, 'completion'); } });
    const received = c.task(id).reviewer.received_review_output;
    const view = await c.cleanup({ task_id: id, delete_workspace: false });
    assert(view.cleanup.cleanup_diagnostic); assert.equal(c.task(id).reviewer.review_result, null);
    assert.deepEqual(c.task(id).reviewer.received_review_output, received);
    assert.equal((await c.cleanup({ task_id: id, delete_workspace: true })).cleanup.workspace_deleted, false);
    assert.deepEqual(calls, ['implementer', 'reviewer']); assert.deepEqual(publisherCalls, []);
  });

test('returned-output receipts redact secrets and bound oversized data without claiming complete retention', async t => {
  const { c, id, calls } = await automaticAttempt(t, { versioned: true,
    output(raw) { raw.findings[0].evidence = 'test-sensitive-value' + 'x'.repeat(20000); } });
  const received = c.task(id).reviewer.received_review_output;
  assert(received.output.length <= 16000); assert.equal(received.complete, false);
  assert(!JSON.stringify(received).includes('test-sensitive-value')); assert.equal(c.task(id).reviewer.review_result, null);
  const view = await c.get(id);
  assert.equal(view.automatic.review.potentially_correctable, false);
  assert.equal(view.automatic.evidence_retention.received_output_complete, false);
  assert.deepEqual(calls, ['implementer', 'reviewer']);
});

test('receipt recovery cannot turn a sanitized or malformed native identity into authenticated execution', async t => {
  const { c, id, calls, publisherCalls } = await automaticAttempt(t, { versioned: true, result: { threadId: 123, model: 'test-sensitive-value' },
    configure(c) { receivedOutputFault(c, 'receipt'); } });
  const receipt = c.pendingReviewResults.get(id);
  assert.equal(receipt.received_output.identity_valid, false);
  assert(!JSON.stringify(receipt).includes('test-sensitive-value'));
  const view = await c.cleanup({ task_id: id, delete_workspace: false });
  assert.match(view.cleanup.cleanup_diagnostic, /LOCAL_IDENTITY_MISMATCH/);
  assert.equal(c.task(id).reviewer.review_result, null);
  assert.equal((await c.cleanup({ task_id: id, delete_workspace: true })).cleanup.workspace_deleted, false);
  assert.deepEqual(calls, ['implementer', 'reviewer']); assert.deepEqual(publisherCalls, []);
});

for (const changed of ['contract', 'normal checkout', 'packet', 'missing evidence', 'candidate', 'expiry', 'storage']) test(`read-only status removes current correction qualification after ${changed} changes and never mutates evidence`, async t => {
  const { c, id, normal, calls, publisherCalls } = await automaticAttempt(t, { versioned: true });
  const task = c.task(id), workspace = path.join(c.workspaceRoot, id), contractFile = path.join(workspace, 'contract.json');
  const contractText = await fs.readFile(contractFile, 'utf8'), normalText = await fs.readFile(path.join(normal, 'greeting.txt'), 'utf8');
  const packetFile = path.join(workspace, task.reviewer.packet_directory, 'evidence.json'), packet = await fs.readFile(packetFile, 'utf8');
  const candidateFile = path.join(workspace, 'repo/greeting.txt'), candidate = await fs.readFile(candidateFile, 'utf8');
  assert.equal((await c.get(id)).automatic.review.potentially_correctable, true);
  let clock;
  if (changed === 'contract') await fs.writeFile(contractFile, JSON.stringify({ ...JSON.parse(contractText), goal: 'Changed contract' }));
  if (changed === 'normal checkout') await fs.writeFile(path.join(normal, 'greeting.txt'), 'Changed without moving HEAD\n');
  if (changed === 'packet') { await fs.chmod(packetFile, 0o600); await fs.writeFile(packetFile, packet + 'changed'); await fs.chmod(packetFile, 0o400); }
  if (changed === 'missing evidence') await fs.unlink(contractFile);
  if (changed === 'candidate') await fs.writeFile(candidateFile, 'Changed candidate\n');
  if (changed === 'expiry') clock = t.mock.method(Date, 'now', () => task.deadline + 1);
  if (changed === 'storage') c.persistenceFailures.add(id);
  const rows = attemptRows(c, id), tasks = c.db.prepare('SELECT * FROM tasks').all();
  const write = t.mock.method(c, 'save', () => assert.fail('get_task must never write'));
  const validation = t.mock.method(c, 'runLocalValidation', () => assert.fail('get_task must not validate'));
  const model = t.mock.method(c, 'localBackendFactory', () => assert.fail('get_task must not execute a model'));
  const scratch = t.mock.method(fs, 'mkdtemp', () => assert.fail('get_task must not create a temporary index or worktree'));
  try {
    for (let count = 0; count < 3; count++) {
      const summary = (await c.get(id)).automatic.review;
      assert.equal(summary.potentially_correctable, false); assert.equal(summary.execution_authorized, false);
      if (!['expiry', 'storage'].includes(changed)) assert(summary.blockers.includes('REVIEW_EVIDENCE_UNVERIFIED'));
    }
    assert.deepEqual(c.db.prepare('SELECT * FROM tasks').all(), tasks); assert.deepEqual(attemptRows(c, id), rows);
  } finally { write.mock.restore(); validation.mock.restore(); model.mock.restore(); scratch.mock.restore(); clock?.mock.restore(); }
  if (['contract', 'missing evidence'].includes(changed)) await fs.writeFile(contractFile, contractText);
  if (changed === 'normal checkout') await fs.writeFile(path.join(normal, 'greeting.txt'), normalText);
  if (changed === 'packet') { await fs.chmod(packetFile, 0o600); await fs.writeFile(packetFile, packet); await fs.chmod(packetFile, 0o400); }
  if (changed === 'candidate') await fs.writeFile(candidateFile, candidate);
  c.persistenceFailures.delete(id);
  // Restoring bytes cannot restore the inode/timestamp fingerprint of a file
  // already changed. No status read silently requalifies that altered snapshot.
  assert.equal((await c.get(id)).automatic.review.potentially_correctable, !['normal checkout', 'candidate'].includes(changed));
  assert.equal(repoGit(normal, 'rev-parse', 'HEAD').trim(), task.baseline);
  assert.deepEqual(calls, ['implementer', 'reviewer']); assert.deepEqual(publisherCalls, []);
  assert.equal(c.task(id).deadline, task.deadline);
});

test('permitted workspace cleanup preserves historical correctability and removes current qualification', async t => {
  const { c, id, calls, publisherCalls } = await automaticAttempt(t, { versioned: true });
  const original = c.task(id).reviewer.review_result;
  assert.equal((await c.get(id)).automatic.review.potentially_correctable, true);
  assert.equal((await c.cleanup({ task_id: id, delete_workspace: true })).cleanup.workspace_deleted, true);
  const rows = attemptRows(c, id), tasks = c.db.prepare('SELECT * FROM tasks').all();
  for (let count = 0; count < 3; count++) assert.equal((await c.get(id)).automatic.review.potentially_correctable, false);
  assert.deepEqual(c.task(id).reviewer.review_result, original);
  assert(rows.some(row => JSON.parse(row.value).actionability_qualification?.potentially_correctable));
  assert.deepEqual(attemptRows(c, id), rows); assert.deepEqual(c.db.prepare('SELECT * FROM tasks').all(), tasks);
  assert.deepEqual(calls, ['implementer', 'reviewer']); assert.deepEqual(publisherCalls, []);
});

test('read-only status rejects a missing reviewed tree object without recreating it', async t => {
  const { c, id, calls, publisherCalls } = await automaticAttempt(t, { versioned: true });
  const task = c.task(id), tree = task.reviewer.reviewed_git_state.tree_sha;
  const object = path.join(c.workspaceRoot, id, 'git-store/objects', tree.slice(0, 2), tree.slice(2));
  const bytes = await fs.readFile(object), rows = attemptRows(c, id), tasks = c.db.prepare('SELECT * FROM tasks').all();
  await fs.unlink(object);
  for (let count = 0; count < 3; count++) {
    assert.equal((await c.get(id)).automatic.review.potentially_correctable, false);
    await assert.rejects(fs.stat(object), { code: 'ENOENT' });
  }
  assert.deepEqual(attemptRows(c, id), rows); assert.deepEqual(c.db.prepare('SELECT * FROM tasks').all(), tasks);
  assert.deepEqual(calls, ['implementer', 'reviewer']); assert.deepEqual(publisherCalls, []);
  await fs.writeFile(object, bytes, { mode: 0o444 }); // Restore exact fixture object for teardown.
});

for (const boundary of ['rollback', 'release']) for (const failure of ['deny', 'throw']) test(`SQLite ${boundary} ${failure} blocks authority across the entire connection`, async t => {
  const value = await setup(t), { c, api, executor } = value;
  const reader = new DatabaseSync(path.join(c.stateRoot, 'controller.sqlite'), { readOnly: true });
  t.after(() => reader.close());
  if (boundary === 'rollback') sqliteAbort(c, 'tasks', '1');
  let hits = 0;
  c.db.setAuthorizer((action, first) => {
    if (action === sqlite.SQLITE_SAVEPOINT && first === boundary.toUpperCase()) {
      hits++;
      if (failure === 'throw') throw Error('authorizer failure without SQLite error code');
      return sqlite.SQLITE_DENY;
    }
    return sqlite.SQLITE_OK;
  });
  await assert.rejects(c.start({ contract: contract(), request_id: 'first_manual' }), /STORAGE_TRANSACTION_UNRESOLVED/);
  assert(hits > 0); assert.equal(c.transactionUnresolved, true); assert.equal(c.db.isTransaction, true);
  const committed = reader.prepare('SELECT * FROM operations').all();
  assert.equal(committed.length, 1); assert.equal(committed[0].status, 'pending');
  assert.equal(reader.prepare('SELECT count(*) AS n FROM tasks').get().n, 0);
  const authority = { max_duration_seconds: 120, max_codex_turns: 2, max_corrections: 0, publish: { title: 'Fixture', draft: true } };
  for (const input of [{ contract: contract(), request_id: 'second_manual' },
    { contract: contract(), request_id: 'second_automatic', execution_backend: 'local_codex', repository_id: 'fixture', automatic: authority }]) {
    await assert.rejects(c.start(input), /STORAGE_TRANSACTION_UNRESOLVED/);
  }
  assert.throws(() => c.opDone('first_manual'), /STORAGE_TRANSACTION_UNRESOLVED/);
  await assert.rejects(c.continue({ task_id: 'anything' }), /STORAGE_TRANSACTION_UNRESOLVED/);
  await assert.rejects(c.registerGitHubRepository({}), /STORAGE_TRANSACTION_UNRESOLVED/);
  assert.equal(api.created.length, 0); assert.equal(api.sent.length, 0); assert.equal(executor.started.length, 0);
  assert.deepEqual(reader.prepare('SELECT * FROM operations').all(), committed);
  // Explicitly remove the injected fault and roll back. Autocommit by itself
  // cannot clear a failed-release/rollback latch or authorize another operation.
  c.db.setAuthorizer(null); c.db.exec('ROLLBACK');
  assert.equal(c.db.isTransaction, false);
  await assert.rejects(c.start({ contract: contract(), request_id: 'still_blocked' }), /STORAGE_TRANSACTION_UNRESOLVED/);
  await c.close();
  const recovered = await restartEvidenceController(t, value);
  assert.equal(recovered.db.isTransaction, false); assert.equal(recovered.transactionUnresolved, false);
  assert.equal(api.created.length, 0); assert.equal(api.sent.length, 0); // No replay on restart.
  const create = api.create.bind(api);
  api.create = async body => {
    assert(reader.prepare('SELECT value FROM tasks WHERE id=?').get(body.metadata.bridge_task));
    return create(body);
  };
  await recovered.start({ contract: contract(), request_id: 'new_committed_authority' });
  await Promise.all([...recovered.jobs.values()]);
  assert.equal(api.created.length, 1); assert.equal(api.sent.length, 1);
  assert.equal(reader.prepare("SELECT count(*) AS n FROM operations WHERE status='accepted'").get().n, 1);
  assert.equal(reader.prepare("SELECT status FROM operations WHERE id='first_manual'").get().status, 'pending');
});

async function localResponseFixture(t) {
  const value = await setup(t), { c } = value;
  const task = { id: 'task_response', request_id: 'initial_response', execution_backend: 'local_codex', created: Date.now(), deadline: Date.now() + 600000,
    implementer: { state: 'waiting_for_approval', local: { owner_instance: c.instanceId, thread_id: 'thread', turn_id: 'turn',
      execution_state: 'running', instance_started: true, human_requests: [], diagnostics: [] } } };
  c.recordLocalRequest(task, { request: { id: 0, method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thread', turnId: 'turn', command: 'node --version' } } });
  c.save(task);
  const reader = new DatabaseSync(path.join(c.stateRoot, 'controller.sqlite'), { readOnly: true });
  t.after(() => reader.close());
  const responses = [];
  c.localRuns.set(task.id, { abort: new AbortController(), backend: {
    respondToRequest(response) {
      assert.equal(c.db.isTransaction, false);
      const committed = JSON.parse(reader.prepare('SELECT value FROM tasks WHERE id=?').get(task.id).value);
      assert.equal(committed.implementer.local.human_requests[0].delivery, 'prepared');
      assert.equal(reader.prepare('SELECT status FROM operations WHERE id=?').get('response_request').status, 'submitting');
      responses.push(response);
    }, async cancel() { return true; }, async close() { return true; },
  } });
  const input = { task_id: task.id, request_id: 'response_request', human_response: {
    request_ref: task.implementer.local.human_requests[0].request_ref, thread_id: 'thread', turn_id: 'turn', decision: 'accept' } };
  return { ...value, reader, responses, task, input };
}

test('owned human-response BEGIN IMMEDIATE permits nested save and delivers only committed authority', async t => {
  const { c, input, responses, reader } = await localResponseFixture(t);
  await c.continue(input);
  assert.equal(c.db.isTransaction, false); assert.equal(c.transactionOwner, null); assert.equal(c.transactionUnresolved, false);
  assert.equal(responses.length, 1);
  assert.equal(reader.prepare('SELECT status FROM operations WHERE id=?').get(input.request_id).status, 'accepted');
  await c.continue(input); assert.equal(responses.length, 1);
});

test('SQLite COMMIT failure in owned human response cannot release callback or acquire new authority', async t => {
  const value = await localResponseFixture(t), { c, input, responses, reader } = value;
  c.db.setAuthorizer((action, first) => action === sqlite.SQLITE_TRANSACTION && first === 'COMMIT' ? sqlite.SQLITE_DENY : sqlite.SQLITE_OK);
  await assert.rejects(c.continue(input), /LOCAL_RESPONSE_PERSISTENCE_FAILED/);
  assert.equal(responses.length, 0); assert.equal(c.transactionUnresolved, true); assert.equal(c.db.isTransaction, false);
  assert.equal(reader.prepare('SELECT * FROM operations WHERE id=?').get(input.request_id), undefined);
  assert.equal(JSON.parse(reader.prepare('SELECT value FROM tasks WHERE id=?').get(input.task_id).value).implementer.local.human_requests[0].status, 'pending');
  await assert.rejects(c.start({ contract: contract(), request_id: 'commit_failure_manual' }), /STORAGE_TRANSACTION_UNRESOLVED/);
  c.db.setAuthorizer(null);
  await c.close().catch(() => {}); if (!c.dbClosed) { c.db.close(); c.dbClosed = true; }
  const recovered = await restartEvidenceController(t, value);
  assert.equal(responses.length, 0); assert.equal(recovered.task(input.task_id).implementer.state, 'needs_attention');
  await assert.rejects(recovered.continue(input), /LOCAL_PENDING_REQUEST_NOT_FOUND/);
});

test('an unowned transaction permits read-only diagnostics and safe stopping but no workspace deletion', async t => {
  const { c, api, executor } = await setup(t), task = await started(c);
  const stopped = executor.stopped.length;
  c.db.exec('BEGIN');
  const state = await c.invoke('get_task', { task_id: task.task_id }, {}, input => c.get(input.task_id));
  assert.equal(state.storage_diagnostic, 'STORAGE_TRANSACTION_UNRESOLVED');
  await assert.rejects(c.cleanup({ task_id: task.task_id, delete_workspace: true }), /EVIDENCE_STORAGE_UNAVAILABLE_CLEANUP_UNCONFIRMED/);
  assert(executor.stopped.length > stopped); assert.equal(api.deleted.length, 0);
  assert(c.db.isTransaction); assert((await fs.stat(path.join(c.workspaceRoot, task.task_id))).isDirectory());
  c.db.exec('ROLLBACK');
});

test('transaction failure during session creation prevents subsequent executor start and input submission', async t => {
  const { c, api, executor } = await setup(t), create = api.create.bind(api);
  const reader = new DatabaseSync(path.join(c.stateRoot, 'controller.sqlite'), { readOnly: true });
  t.after(() => reader.close());
  api.create = async body => {
    const session = await create(body);
    sqliteAbort(c, 'tasks', '1');
    c.db.setAuthorizer((action, first) => action === sqlite.SQLITE_SAVEPOINT && first === 'ROLLBACK' ? sqlite.SQLITE_DENY : sqlite.SQLITE_OK);
    assert.throws(() => c.save(c.task(body.metadata.bridge_task)), /STORAGE_TRANSACTION_UNRESOLVED/);
    return session;
  };
  const initial = await c.start({ contract: contract(), request_id: 'inflight_authority' });
  await Promise.all([...c.jobs.values()]);
  assert.equal(api.created.length, 1); assert.equal(api.sent.length, 0); assert.equal(executor.started.length, 0);
  assert.equal(reader.prepare('SELECT status FROM operations WHERE id=?').get('inflight_authority').status, 'pending');
  assert.equal(JSON.parse(reader.prepare('SELECT value FROM tasks WHERE id=?').get(initial.task_id).value).implementer.session_id, undefined);
  c.db.setAuthorizer(null); c.db.exec('ROLLBACK');
  await assert.rejects(c.continue({ task_id: initial.task_id, instruction: 'do not replay', request_id: 'blocked_inflight' }), /STORAGE_TRANSACTION_UNRESOLVED/);
});

test('automatic error handling contains a connection failure owned by a different task', async t => {
  let fault;
  const value = await automaticAttempt(t, { configure(c) {
    const qualify = c.qualifyLocalPublication.bind(c);
    c.qualifyLocalPublication = async task => {
      fault = sqliteAbort(c, 'tasks', "NEW.id='fault_owner'");
      c.db.setAuthorizer((action, first) => action === sqlite.SQLITE_SAVEPOINT && first === 'ROLLBACK' ? sqlite.SQLITE_DENY : sqlite.SQLITE_OK);
      assert.throws(() => c.save({ id: 'fault_owner' }), /STORAGE_TRANSACTION_UNRESOLVED/);
      return qualify(task);
    };
  } });
  const { c, id, calls } = value;
  assert.equal(fault.hits, 1); assert.equal(c.transactionUnresolved, true); assert(c.persistenceFailures.has(id));
  assert.equal(c.task(id).reviewer.review_result.overall, 'FAIL');
  await assert.rejects(c.cleanup({ task_id: id, delete_workspace: true }), /EVIDENCE_STORAGE_UNAVAILABLE_CLEANUP_UNCONFIRMED/);
  assert((await fs.stat(path.join(c.workspaceRoot, id))).isDirectory());
  c.db.setAuthorizer(null); c.db.exec('ROLLBACK');
  await c.close().catch(() => {}); if (!c.dbClosed) { c.db.close(); c.dbClosed = true; }
  const recovered = await restartEvidenceController(t, value);
  assert.equal(recovered.task(id).automatic.status, 'uncertain');
  assert.equal(recovered.task(id).reviewer.review_result.overall, 'FAIL');
  await recovered.cleanup({ task_id: id, delete_workspace: false });
  assert.equal((await recovered.cleanup({ task_id: id, delete_workspace: true })).cleanup.workspace_deleted, true);
  assert.deepEqual(calls, ['implementer', 'reviewer']);
});

for (const storage of ['write', 'read']) for (const confirmed of [true, false]) test(`active automatic expiry contains SQLite ${storage} failure with shutdown ${confirmed ? 'confirmed' : 'uncertain'}`, async t => {
  const value = await automaticAttempt(t, { activeReviewer: true, cancelResult: confirmed, closeResult: confirmed });
  const { c, id, calls, stops } = value, task = c.task(id), workspace = path.join(c.workspaceRoot, id);
  const packetPath = path.join(workspace, task.reviewer.packet_directory, 'evidence.json');
  const packet = await fs.readFile(packetPath, 'utf8'), before = attemptRows(c, id);
  const owned = c.localRuns.get(`${id}:reviewer`); assert(owned);
  let fault;
  if (storage === 'write') fault = sqliteAbort(c, 'tasks', "json_extract(NEW.value,'$.automatic.status')<>'progressing'");
  else c.db.setAuthorizer(action => action === sqlite.SQLITE_READ ? sqlite.SQLITE_DENY : sqlite.SQLITE_OK);
  const timer = c.automaticTimers.get(id), now = t.mock.method(Date, 'now', () => task.deadline + 1);
  try { await assert.doesNotReject(async () => timer._onTimeout()); }
  finally { now.mock.restore(); c.db.setAuthorizer(null); }
  if (fault) assert.equal(fault.hits, 1);
  assert(owned.abort.signal.aborted); assert(stops.includes('cancel')); assert(stops.includes('close'));
  assert.equal(c.expiryStops.get(id).confirmed, confirmed);
  if (!confirmed) assert.deepEqual(c.expiryStops.get(id).diagnostics, ['LOCAL_CANCELLATION_UNCONFIRMED', 'LOCAL_CLOSE_UNCONFIRMED']);
  assert.equal(c.automaticTimers.has(id), false);
  await Promise.all([...c.jobs.values()]); await Promise.all([...c.automaticJobs.values()]);
  assert.deepEqual(calls, ['implementer', 'reviewer']); assert.equal(c.task(id).publication, undefined);
  assert.equal(c.task(id).deadline, task.deadline); assert.equal(c.task(id).automatic.deadline, task.deadline);
  assert.equal(await fs.readFile(packetPath, 'utf8'), packet);
  assert(before.every(row => attemptRows(c, id).some(saved => saved.value === row.value)));
  const retained = attemptRows(c, id).map(row => JSON.parse(row.value));
  assert(retained.some(row => row.packet_utf8 === packet && row.review_packet.sha256 === digest(packet)));
  assert(!retained.some(row => row.review_result)); // No fabricated receipt from the interrupted backend.
  const blocked = await c.cleanup({ task_id: id, delete_workspace: true });
  assert.equal(blocked.cleanup.workspace_deleted, false); assert((await fs.stat(workspace)).isDirectory());
  assert((await c.get(id)).automatic.human_attention_required);
});

for (const boundary of ['packet', 'review', 'task', 'receipt', 'operation', 'outcome']) test(`SQLite ABORT at ${boundary} preserves evidence and blocks deletion until explicit reconciliation`, async t => {
  let fault;
  const value = await automaticAttempt(t, { configure(c) {
    const conditions = {
      packet: ['automatic_attempts', "json_extract(NEW.value,'$.kind')='review_packet'"],
      review: ['automatic_attempts', "json_extract(NEW.value,'$.kind')='review_result'"],
      task: ['tasks', "json_extract(NEW.value,'$.automatic.status')='progressing' AND json_extract(NEW.value,'$.reviewer.review_result.overall')='FAIL'"],
      receipt: ['tasks', "json_extract(NEW.value,'$.reviewer.pending_review_result.sha256') IS NOT NULL"],
      operation: ['operations', "NEW.id LIKE 'automatic_review_%' AND NEW.status='accepted'", 'UPDATE'],
      outcome: ['tasks', "json_extract(NEW.value,'$.automatic.status')='stopped'"],
    };
    fault = sqliteAbort(c, ...conditions[boundary]);
  } });
  const { c, id, calls } = value, workspace = path.join(c.workspaceRoot, id), task = c.task(id);
  assert.equal(fault.hits, 1); assert.equal(task.automatic.status, 'uncertain');
  const originalPacket = await fs.readFile(path.join(workspace, task.reviewer.packet_directory, 'evidence.json'), 'utf8');
  const receipt = task.reviewer.pending_review_result || c.pendingReviewResults.get(id);
  if (!['packet', 'outcome'].includes(boundary)) {
    assert(receipt); assert.equal(receipt.result.overall, 'FAIL');
    assert(!attemptRows(c, id).some(row => JSON.parse(row.value).kind === 'review_result'));
    assert.notEqual(c.db.prepare('SELECT status FROM operations WHERE id=?').get(task.reviewer.request_id).status, 'accepted');
  }
  if (boundary === 'outcome') assert(!attemptRows(c, id).some(row => JSON.parse(row.value).outcome === 'stopped'));
  const blocked = await c.cleanup({ task_id: id, delete_workspace: true });
  assert.equal(blocked.cleanup.workspace_deleted, false);
  assert.match(blocked.cleanup.cleanup_diagnostic, /AUTOMATIC_.*(RETAINED|UNRESOLVED|RECONCILIATION|DURABLY_RECEIVED)/);
  assert.equal(await fs.readFile(path.join(workspace, task.reviewer.packet_directory, 'evidence.json'), 'utf8'), originalPacket);
  const repaired = await c.cleanup({ task_id: id, delete_workspace: false });
  assert.equal(repaired.automatic.evidence_retention.reconciliation_required, false);
  const retained = attemptRows(c, id).map(row => JSON.parse(row.value));
  assert(retained.some(row => row.packet_utf8 === originalPacket && digest(row.packet_utf8) === row.review_packet.sha256));
  if (receipt) assert(retained.some(row => JSON.stringify(row.review_result) === JSON.stringify(receipt.result) && row.findings_sha256 === receipt.sha256));
  const deleted = await c.cleanup({ task_id: id, delete_workspace: true });
  assert.equal(deleted.cleanup.workspace_deleted, true);
  assert.deepEqual(calls, boundary === 'packet' ? ['implementer'] : ['implementer', 'reviewer']);
  assert.equal(c.task(id).publication, undefined); assert.equal(c.task(id).deadline, task.deadline);
});

for (const boundary of ['packet', 'review']) test(`restart retains ${boundary} failure evidence for explicit reconciliation without replay`, async t => {
  const value = await automaticAttempt(t, { configure: c => sqliteAbort(c, 'automatic_attempts', `json_extract(NEW.value,'$.kind')='${boundary === 'packet' ? 'review_packet' : 'review_result'}'`) });
  const { id } = value, before = value.c.task(id), original = await fs.readFile(path.join(value.c.workspaceRoot, id, before.reviewer.packet_directory, 'evidence.json'), 'utf8');
  const receipt = before.reviewer.pending_review_result;
  const c = await restartEvidenceController(t, value);
  const blocked = await c.cleanup({ task_id: id, delete_workspace: true });
  assert.equal(blocked.cleanup.workspace_deleted, false);
  await c.cleanup({ task_id: id, delete_workspace: false });
  const retained = attemptRows(c, id).map(row => JSON.parse(row.value));
  assert(retained.some(row => row.packet_utf8 === original));
  if (receipt) assert(retained.some(row => JSON.stringify(row.review_result) === JSON.stringify(receipt.result)));
  assert.equal((await c.cleanup({ task_id: id, delete_workspace: true })).cleanup.workspace_deleted, true);
  assert.equal(c.automaticJobs.size, 0);
});

test('restart recovers durable unverified output when the qualified receipt write failed', async t => {
  const value = await automaticAttempt(t, { configure: c => sqliteAbort(c, 'tasks', "json_extract(NEW.value,'$.reviewer.pending_review_result.sha256') IS NOT NULL") });
  const { id } = value;
  assert(value.c.pendingReviewResults.has(id)); assert.equal(value.c.task(id).reviewer.pending_review_result, undefined);
  const original = value.c.task(id).reviewer.received_review_output;
  assert(original); assert.equal(value.c.task(id).reviewer.review_result, null);
  const c = await restartEvidenceController(t, value);
  const reconciled = await c.cleanup({ task_id: id, delete_workspace: false });
  assert.equal(reconciled.automatic.evidence_retention.reconciliation_required, false);
  assert.equal(c.task(id).reviewer.received_review_output.output, original.output);
  assert.equal(c.task(id).reviewer.review_result.overall, 'FAIL');
  assert.equal((await c.cleanup({ task_id: id, delete_workspace: true })).cleanup.workspace_deleted, true);
  assert.equal(c.automaticJobs.size, 0);
});

test('SQLite failure while verifying completed review evidence retains raw output across restart', async t => {
  let fault;
  const value = await automaticAttempt(t, { configure(c) {
    fault = sqliteAbort(c, 'tasks', "json_extract(NEW.value,'$.reviewer.local.phase')='validating' AND json_extract(NEW.value,'$.reviewer.local.server_closed')=1");
    fault.skip = 1; // Allow closure persistence, then abort packet verification's task write.
  } });
  const { id } = value;
  assert.equal(fault.hits, 1); assert.equal(value.c.task(id).reviewer.evidence_retention.review, 'awaiting_receipt');
  const c = await restartEvidenceController(t, value);
  assert(c.task(id).reviewer.received_review_output);
  const result = await c.cleanup({ task_id: id, delete_workspace: false });
  assert.equal(result.automatic.evidence_retention.reconciliation_required, false);
  assert.equal(c.task(id).reviewer.review_result.overall, 'FAIL');
  assert.equal((await c.cleanup({ task_id: id, delete_workspace: true })).cleanup.workspace_deleted, true);
});

test('unavailable SQLite writes still allow owned executor stopping and never delete evidence', async t => {
  const { c, id } = await automaticAttempt(t);
  const abort = new AbortController(); let cancelled = 0, closed = 0;
  c.localRuns.set(id, { abort, backend: { async cancel() { cancelled++; }, async close() { closed++; return true; } } });
  c.db.exec('PRAGMA query_only=ON');
  await assert.rejects(c.cleanup({ task_id: id, delete_workspace: true }), /EVIDENCE_STORAGE_UNAVAILABLE_CLEANUP_UNCONFIRMED/);
  assert(abort.signal.aborted); assert(cancelled > 0); assert(closed > 0);
  assert((await fs.stat(path.join(c.workspaceRoot, id))).isDirectory());
  c.db.exec('PRAGMA query_only=OFF');
  await c.cleanup({ task_id: id, delete_workspace: false });
  assert.equal((await c.cleanup({ task_id: id, delete_workspace: true })).cleanup.workspace_deleted, true);
});

test('closed SQLite still permits owned cancellation and reports cleanup as unconfirmed', async t => {
  const { c, id } = await automaticAttempt(t), abort = new AbortController(); let closed = false;
  c.localRuns.set(id, { abort, backend: { async cancel() {}, async close() { closed = true; return true; } } });
  c.db.close();
  try {
    await assert.rejects(c.cleanup({ task_id: id, delete_workspace: true }), /EVIDENCE_STORAGE_UNAVAILABLE_CLEANUP_UNCONFIRMED/);
    assert(abort.signal.aborted); assert(closed); assert(c.persistenceFailures.has(id));
    assert((await fs.stat(path.join(c.workspaceRoot, id))).isDirectory());
  } finally { c.dbClosed = true; clearInterval(c.sweeper); }
});

test('an unresolved SQLite transaction is not proof of committed evidence', async t => {
  const value = await automaticAttempt(t), { c, id } = value, before = attemptRows(c, id);
  c.db.exec('BEGIN');
  await assert.rejects(c.cleanup({ task_id: id, delete_workspace: true }), /EVIDENCE_STORAGE_UNAVAILABLE_CLEANUP_UNCONFIRMED/);
  assert(c.db.isTransaction); // Cleanup must not guess ownership or roll back an unknown transaction.
  assert((await fs.stat(path.join(c.workspaceRoot, id))).isDirectory());
  c.db.exec('ROLLBACK');
  assert.deepEqual(attemptRows(c, id), before);
  await assert.rejects(c.cleanup({ task_id: id, delete_workspace: false }), /EVIDENCE_STORAGE_UNAVAILABLE_CLEANUP_UNCONFIRMED/);
  assert.equal(c.db.isTransaction, false);
  await c.close().catch(() => {});
  if (!c.dbClosed) { c.db.close(); c.dbClosed = true; }
  const recovered = await restartEvidenceController(t, value);
  await recovered.cleanup({ task_id: id, delete_workspace: false });
  assert.equal((await recovered.cleanup({ task_id: id, delete_workspace: true })).cleanup.workspace_deleted, true);
});

test('packet binding failure leaves durable intent and cannot be mistaken for absent evidence after restart', async t => {
  const value = await automaticAttempt(t, { configure: c => sqliteAbort(c, 'tasks',
    "json_extract(NEW.value,'$.reviewer.packet_hash') IS NOT NULL AND json_extract(NEW.value,'$.reviewer.evidence_retention.packet')='pending'") });
  const { id } = value, workspace = path.join(value.c.workspaceRoot, id);
  assert.equal(value.c.task(id).reviewer.packet_hash, undefined);
  const directory = (await fs.readdir(workspace)).find(name => /^review-\d+$/.test(name));
  const original = await fs.readFile(path.join(workspace, directory, 'evidence.json'), 'utf8');
  const c = await restartEvidenceController(t, value);
  await c.cleanup({ task_id: id, delete_workspace: false });
  const blocked = await c.cleanup({ task_id: id, delete_workspace: true });
  assert.equal(blocked.cleanup.workspace_deleted, false);
  assert.match(blocked.cleanup.cleanup_diagnostic, /AUTOMATIC_EVIDENCE_RECONCILIATION_REQUIRED/);
  assert.equal(await fs.readFile(path.join(workspace, directory, 'evidence.json'), 'utf8'), original);
  assert(!attemptRows(c, id).some(row => JSON.parse(row.value).packet_utf8));
});

test('destructive cleanup rejects corrupted retained evidence even after successful writes', async t => {
  const { c, id } = await automaticAttempt(t);
  c.db.prepare("UPDATE automatic_attempts SET value=json_set(value,'$.packet_utf8','corrupted') WHERE task_id=? AND json_extract(value,'$.kind')='review_packet'").run(id);
  const result = await c.cleanup({ task_id: id, delete_workspace: true });
  assert.equal(result.cleanup.workspace_deleted, false);
  assert.match(result.cleanup.cleanup_diagnostic, /AUTOMATIC_RETAINED_EVIDENCE_INVALID/);
  assert((await fs.stat(path.join(c.workspaceRoot, id))).isDirectory());
});

test('automatic expiry stops resources without implicitly reconciling failed evidence writes', async t => {
  const { c, id } = await automaticAttempt(t, { configure: c => sqliteAbort(c, 'automatic_attempts', "json_extract(NEW.value,'$.kind')='review_packet'") });
  const deadline = c.task(id).deadline, now = t.mock.method(Date, 'now', () => deadline + 1);
  try { await c.expire(); } finally { now.mock.restore(); }
  assert.equal(c.task(id).reviewer.evidence_retention.packet, 'pending');
  assert(!attemptRows(c, id).some(row => JSON.parse(row.value).packet_utf8));
  assert((await fs.stat(path.join(c.workspaceRoot, id))).isDirectory());
  await c.cleanup({ task_id: id, delete_workspace: false });
  assert.equal(c.task(id).reviewer.evidence_retention.packet, 'retained');
  assert.equal(c.task(id).deadline, deadline);
});

test('qualified reviewer FAIL is durably retained without correction and repeated observations are idempotent', async t => {
  const { c, id, calls, input } = await automaticAttempt(t), task = c.task(id);
  assert.equal(task.automatic.status, 'stopped'); assert.equal(task.reviewer.review_result.overall, 'FAIL');
  assert.equal(task.reviewer.review_result.scope_qualification.status, 'qualified');
  assert.equal(task.reviewer.review_result.findings.find(f => f.id === 'TEST_EVIDENCE').status, 'PASS');
  const rows = attemptRows(c, id), observations = rows.map(row => JSON.parse(row.value));
  assert.deepEqual(observations.filter(item => item.kind !== 'review_output').map(item => item.kind), ['review_packet', 'review_result', 'outcome']);
  assert(observations.some(item => item.kind === 'review_output' && item.received_review_output && item.review_result === null));
  assert.equal(new Set(observations.map(item => item.attempt_id)).size, 1);
  const final = observations.at(-1), packet = observations[0];
  assert.equal(digest(packet.packet_utf8), packet.review_packet.sha256);
  assert.equal(JSON.parse(packet.packet_utf8).current['greeting.txt'], 'candidate\n');
  assert.equal(final.baseline_commit, task.baseline); assert.deepEqual(final.reviewed_git_state, task.reviewer.reviewed_git_state);
  assert.equal(final.validation_sha256, digest(task.local_validation)); assert.equal(final.validation_qualified, true);
  assert.equal(final.findings_sha256, digest(task.reviewer.review_result));
  assert.equal(final.implementer.thread_id, task.implementer.local.thread_id); assert.notEqual(final.implementer.thread_id, final.reviewer.thread_id);
  assert.equal(final.stop_reason, task.automatic.reason); assert.equal(final.outcome, 'stopped');
  assert.deepEqual(final.correction_eligibility.blockers, ['ACTIONABILITY_EVIDENCE_UNAVAILABLE', 'CORRECTION_EXECUTION_DISABLED']);
  assert.equal(final.correction_eligibility.eligible, false);
  await c.get(id); await c.get(id); await c.start(input); c.save(c.task(id));
  assert.deepEqual(attemptRows(c, id), rows); assert.deepEqual(calls, ['implementer', 'reviewer']);
  assert.equal((await c.get(id)).automatic.usage.correction_turns, 0);
  assert.equal(c.task(id).deadline, task.deadline); assert.equal(c.task(id).publication, undefined);
});

for (const mode of [{ validationFailure: true }, { uncertain: true }, { incomplete: true }]) test(`unqualified attempt fails closed: ${Object.keys(mode)[0]}`, async t => {
  const { c, id, calls } = await automaticAttempt(t, mode), task = c.task(id), records = attemptRows(c, id).map(row => JSON.parse(row.value));
  assert(['stopped', 'uncertain'].includes(task.automatic.status)); assert.equal(task.reviewer.review_result, null);
  assert(records.length > 0); assert(records.every(record => record.correction_eligibility.eligible === false));
  assert(records.at(-1).correction_eligibility.blockers.includes(mode.validationFailure ? 'TEST_EVIDENCE_UNQUALIFIED' : 'QUALIFIED_REVIEW_FAIL_REQUIRED'));
  assert.deepEqual(calls, mode.validationFailure ? ['implementer'] : ['implementer', 'reviewer']);
  assert.equal(task.publication, undefined);
});

test('prior candidate and findings survive later task updates, workspace deletion and restart without replay', async t => {
  const { c, id, calls, api, executor } = await automaticAttempt(t), prior = attemptRows(c, id);
  const task = c.task(id); task.reviewer.review_result = null; task.reviewer.state = 'needs_attention'; task.reviewer.error = 'LOCAL_REVIEW_INTEGRITY_CHANGED';
  c.save(task); assert.deepEqual(attemptRows(c, id).slice(0, prior.length), prior);
  await c.cleanup({ task_id: id, delete_workspace: true }); assert.equal(c.task(id).workspace_deleted, true);
  const after = attemptRows(c, id); assert.deepEqual(after.slice(0, prior.length), prior);
  await c.close();
  const restarted = await new Controller({ stateRoot: c.stateRoot, workspaceRoot: c.workspaceRoot, api, executor, secrets: [],
    localBackendFactory: () => { assert.fail('No replay'); } }).init();
  try {
    assert.deepEqual(attemptRows(restarted, id), after); assert.equal((await restarted.get(id)).automatic.status, 'stopped');
    assert.equal(restarted.automaticJobs.size, 0); assert.deepEqual(calls, ['implementer', 'reviewer']);
  } finally { await restarted.close(); }
});

test('automatic authorization still rejects every positive correction count', async t => {
  const { c } = await setup(t);
  for (const max_corrections of [1, 2, 10]) assert.throws(() => c.automaticAuthorization({ execution_backend: 'local_codex', repository_id: 'fixture',
    automatic: { publish: { title: 'Fixture', draft: true }, max_duration_seconds: 120, max_codex_turns: 2, max_corrections } }), /INVALID_AUTOMATIC_AUTHORIZATION/);
});
test('Agents API remains the default and explicit default selection preserves request fingerprints', async t => {
  const { c, api } = await setup(t);
  c.localBackendFactory = () => { assert.fail('Default tasks must not instantiate local Codex'); };
  const first = await started(c);
  assert.equal(first.execution_backend, 'agents_api'); assert.equal(c.task(first.task_id).execution_backend, 'agents_api');
  assert.equal(c.task(first.task_id).automatic, undefined); assert.equal(first.automatic, undefined);
  assert.equal(c.db.prepare('SELECT fingerprint FROM operations WHERE id=?').get('request_start').fingerprint, digest({ kind: 'start', payload: contract() }));
  assert.equal(c.automaticJobs.size, 0); assert.equal(c.automaticTimers.size, 0);
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
test('tunnel owner confirmation accepts 30 days, rejects longer and stale claims', async t => {
  const root = await fs.mkdtemp('/var/tmp/personal-agents-bridge/gate-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'personal-tunnel.json');
  const now = Date.parse('2026-10-13T15:00:00.000Z'), day = 24 * 60 * 60 * 1000;
  const live = { id: 'tunnel_test', organization_ids: ['org_personal'], workspace_ids: ['workspace_personal'] };
  const good = {
    tunnel_id: 'tunnel_test', personal_only: true, sole_authorized_user: true,
    verification_method: 'owner_checked_platform_settings',
    platform_organization_id: 'org_personal', chatgpt_workspace_id: 'workspace_personal',
    associated_organizations: ['org_personal'], associated_workspaces: ['workspace_personal'],
    verified_at: new Date(now).toISOString(), expires_at: new Date(now + 30 * day).toISOString(),
  };
  const write = async changes => fs.writeFile(file, JSON.stringify({ ...good, ...changes }), { mode: 0o600 });
  let lookups = 0;
  const opts = {
    stateRoot: root, expectedTunnel: 'tunnel_test', now,
    lookup: async () => { lookups++; return live; },
  };

  await write({});
  const before = await fs.readFile(file, 'utf8');
  assert.equal((await authorizePersonalTunnel(opts)).tunnel_id, 'tunnel_test');
  assert.equal(await fs.readFile(file, 'utf8'), before, 'successful authorization must not renew confirmation');
  assert.equal(lookups, 1, 'live association check is still required');

  await write({ expires_at: new Date(now + 30 * day + 1).toISOString() });
  await assert.rejects(authorizePersonalTunnel(opts), /PERSONAL_ASSOCIATION_UNVERIFIED_OR_EXPIRED/);
  assert.equal(lookups, 1, 'overlong confirmation must be rejected before live lookup');

  await write({});
  await assert.rejects(authorizePersonalTunnel({ ...opts, now: now + 30 * day }), /PERSONAL_ASSOCIATION_UNVERIFIED_OR_EXPIRED/);
  await write({ verified_at: new Date(now + 1).toISOString() });
  await assert.rejects(authorizePersonalTunnel(opts), /PERSONAL_ASSOCIATION_UNVERIFIED_OR_EXPIRED/);
  await write({ verified_at: new Date(now - 30 * day).toISOString(), expires_at: new Date(now + 1).toISOString() });
  await assert.rejects(authorizePersonalTunnel(opts), /PERSONAL_ASSOCIATION_UNVERIFIED_OR_EXPIRED/);

  await write({});
  await assert.rejects(
    authorizePersonalTunnel({ ...opts, lookup: async () => ({ ...live, organization_ids: ['org_personal', 'other'] }) }),
    /LIVE_TUNNEL_ASSOCIATION_MISMATCH/,
  );
});
test('MCP advertises exactly nine tools; schema/authorization failures cannot execute', async t => {
  const { c, api } = await setup(t); let allowed = false;
  const server = createServer(c, async () => { if (!allowed) throw Error('private'); });
  const client = new Client({ name: 'local-test', version: '1' }); const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  const list = await client.listTools(); assert.deepEqual(list.tools.map(x => x.name).sort(), ['cleanup_task', 'continue_task', 'get_task', 'get_task_evidence', 'list_registered_repositories', 'publish_task', 'register_github_repository', 'review_task', 'start_task']);
  assert.equal(list.tools.find(x => x.name === 'get_task').annotations.readOnlyHint, true);
  assert.equal(list.tools.find(x => x.name === 'get_task_evidence').annotations.readOnlyHint, true);
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


// Status-only fixtures use the real SQLite store, with no execution backend.
function progressTask(c) {
  const created = Date.now(), local = name => ({ adapter_contract: 'pab.local-codex-backend.v1', owner_instance: c.instanceId,
    phase: 'finished', execution_state: 'completed', thread_id: `${name}-thread`, turn_id: `${name}-turn`, model: 'fixture-model',
    authentication: 'chatgpt', turn_submission_attempted: true, turn_submission_acknowledged: true,
    terminal_observed: true, result_received: true, instance_started: true, server_closed: true,
    human_attention_required: false, human_requests: [], diagnostics: [] });
  return { id: 'task_00000000-0000-0000-0000-000000000004', execution_backend: 'local_codex', created, deadline: created + 120000,
    baseline: 'a'.repeat(40), request_id: 'progress-start', implementer: { state: 'completed', local: local('implementation') },
    automatic: { authorization: { publish: { title: 'Fixture draft', draft: true }, max_duration_seconds: 120, max_codex_turns: 2, max_corrections: 0 },
      status: 'progressing', phase: 'validation_and_review', reason: null, human_attention_required: false, owner_instance: c.instanceId,
      review_request_id: 'progress-review', publish_request_id: 'progress-publish', deadline: created + 120000,
      contract_binding: { sha256: digest(contract()), contract: contract() } },
    reviewer: { state: 'completed', request_id: 'progress-review', local: local('review'), reviewed_git_state: { tree_sha: 'b'.repeat(40) } },
    local_validation: { version: 'pab.controller-local-validation.v1', provenance: 'controller_process_observation', attempt_id: 'progress-validation',
      request_id: 'progress-review', task_id: 'task_00000000-0000-0000-0000-000000000004', reviewed_git_state: { tree_sha: 'b'.repeat(40) },
      status: 'completed', original_unchanged: true, termination_confirmed: true, results: [] } };
}

for (const phase of ['implementation', 'validation', 'review', 'publication'])
test(`durable progress preserves interrupted ${phase} identities across three restarts`, async t => {
  const { c, root } = await setup(t), task = progressTask(c), id = task.id;
  if (phase === 'implementation') { delete task.reviewer; delete task.local_validation; task.implementer.state = 'running';
    Object.assign(task.implementer.local, { result_received: false, terminal_observed: false, server_closed: false }); }
  if (phase === 'validation' || phase === 'review') {
    task.reviewer.state = 'running'; Object.assign(task.reviewer.local, { result_received: false, terminal_observed: false, server_closed: false });
    if (phase === 'validation') { task.reviewer.local.instance_started = false; task.reviewer.local.turn_submission_attempted = false;
      task.reviewer.local.thread_id = null; task.reviewer.local.turn_id = null; task.local_validation.status = 'running'; }
  }
  if (phase === 'publication') { task.automatic.phase = 'publication'; task.publication = { phase: 'prepared', push_attempted: true }; }
  c.save(task); interruptProgressController(c);
  let stable, status;
  for (let restart = 0; restart < 3; restart++) {
    const next = await new Controller({ stateRoot: path.join(root, 'state'), workspaceRoot: path.join(root, 'work'), executor: new FakeExecutor(),
      localBackendFactory() { assert.fail('Unexpected model replay'); }, localValidationFactory() { assert.fail('Unexpected validation replay'); },
      publisher: new Proxy({}, { get() { assert.fail('Unexpected publisher operation'); } }) }).init();
    try {
      const { get } = await statusClient(t, next), before = statusLedger(next.db);
      for (let read = 0; read < 3; read++) {
        status = JSON.parse((await get(id)).content[0].text);
        assert.equal(status.automatic.status, 'uncertain'); assert.equal(status.automatic.human_attention_required, true);
        assert.equal(status.automatic.progress.resume_authorized, false);
        assert(!['starting', 'running', 'finishing'].includes(status.implementer.state));
        if (status.reviewer) assert(!['starting', 'running', 'finishing'].includes(status.reviewer.state));
        assert.equal(status.automatic.progress.attempts.implementation.request_id, task.request_id);
        if (task.local_validation) assert.equal(status.automatic.progress.attempts.validation.attempt_id, task.local_validation.attempt_id);
        if (phase === 'review') assert.equal(status.automatic.progress.attempts.review.status, 'attempted_unconfirmed');
        if (phase === 'validation') assert.equal(status.automatic.progress.attempts.review.status, 'not_attempted');
        if (phase === 'publication') assert.equal(status.automatic.progress.attempts.publication.status, 'attempted_unconfirmed');
      }
      assert.equal(statusLedger(next.db), before);
      if (stable) assert.equal(before, stable); else stable = before;
      const saved = next.task(id);
      assert.equal(saved.deadline, task.deadline); assert.equal(saved.automatic.deadline, task.automatic.deadline);
      assert.deepEqual(saved.automatic.authorization, task.automatic.authorization);
      assert.deepEqual(saved.automatic.contract_binding, task.automatic.contract_binding);
      assert.equal(saved.automatic.owner_instance, task.automatic.owner_instance);
      assert.equal(saved.automatic.review_request_id, task.automatic.review_request_id);
      assert.equal(saved.automatic.publish_request_id, task.automatic.publish_request_id);
      assert.equal(next.automaticJobs.size + next.localRuns.size + next.validationRuns.size, 0);
    } finally { interruptProgressController(next); }
  }
});
function interruptProgressController(c) {
  clearInterval(c.sweeper); for (const timer of c.automaticTimers.values()) clearTimeout(timer);
  c.closed = true; c.dbClosed = true; c.db.close();
}

for (const outcome of ['not attempted', 'unknown', 'unconfirmed', 'completed', 'failed'])
test(`durable progress classifies execution ${outcome} without inventing usage`, async t => {
  const { c } = await setup(t), task = progressTask(c);
  delete task.reviewer; delete task.local_validation;
  const local = task.implementer.local;
  if (outcome === 'not attempted') local.turn_submission_attempted = false;
  if (outcome === 'unknown') delete local.turn_submission_attempted;
  if (outcome === 'unconfirmed') local.terminal_observed = false;
  if (outcome === 'failed') local.execution_state = 'failed';
  c.save(task);
  const view = await c.get(task.id), expected = { 'not attempted': 'not_attempted', unknown: 'unknown', unconfirmed: 'attempted_unconfirmed', completed: 'confirmed_completed', failed: 'confirmed_failed' }[outcome];
  assert.equal(view.automatic.progress.attempts.implementation.status, expected);
  assert.equal(view.automatic.usage.implementer_turn_submissions_attempted, outcome === 'unknown' ? null : outcome === 'not attempted' ? 0 : 1);
  assert.equal(view.automatic.progress.last_confirmed_stage, outcome === 'completed' ? 'implementation' : null);
  assert.equal(view.automatic.usage.token_usage, null);
});

for (const action of ['IGNORE', 'ABORT'])
test(`durable progress rejects silent or failed SQLite ${action} transition before dispatch`, async t => {
  const { c } = await setup(t), task = progressTask(c); c.save(task);
  const before = statusLedger(c.db);
  c.db.exec(`CREATE TEMP TRIGGER progress_loss BEFORE INSERT ON tasks BEGIN SELECT RAISE(${action}${action === 'ABORT' ? ", 'synthetic write failure'" : ''}); END;`);
  task.automatic.phase = 'publication';
  assert.throws(() => c.save(task), /AUTOMATIC_EVIDENCE_PERSISTENCE_UNCONFIRMED/);
  assert.equal(statusLedger(c.db), before);
  const view = await c.get(task.id);
  assert.equal(view.automatic.status, 'uncertain'); assert.equal(view.automatic.progress.last_confirmed_stage, null);
  assert.equal(c.automaticJobs.size + c.localRuns.size + c.validationRuns.size, 0);
  c.db.exec('DROP TRIGGER progress_loss');
});

for (const field of ['request_id', 'deadline', 'baseline', 'review_request_id', 'publish_request_id', 'owner_instance', 'contract_binding'])
test(`durable progress preserves original ${field} binding`, async t => {
  const { c } = await setup(t), task = progressTask(c); c.save(task); const before = statusLedger(c.db);
  if (['request_id', 'deadline', 'baseline'].includes(field)) task[field] = field === 'deadline' ? task.deadline + 1000 : 'replacement';
  else task.automatic[field] = field === 'contract_binding' ? { sha256: 'replacement' } : 'replacement';
  assert.throws(() => c.save(task), /AUTOMATIC_EVIDENCE_PERSISTENCE_UNCONFIRMED/);
  assert.equal(statusLedger(c.db), before);
});

test('durable progress legacy automatic MCP status is bounded sanitized and strictly observational', async t => {
  const { c, root } = await setup(t), task = progressTask(c), sensitive = 'RAW_PRIVATE_EVIDENCE_';
  task.cleaned = true; task.workspace_deleted = true; task.cleanup = { workspace_deleted: true, workspace_path: path.join(root, 'private') };
  task.automatic.status = 'stopped'; task.automatic.reason = 'AUTOMATIC_VALIDATION_FAILED';
  task.implementer.local.latest_model_output = sensitive.repeat(20000);
  task.implementer.local.diagnostics = [path.join(root, 'private')];
  task.local_validation.results = Array.from({ length: 100 }, (_, command_index) => ({ command_index, attempt_id: `command-${command_index}`,
    command: sensitive, stdout: { text: sensitive }, cwd: path.join(root, 'private'), completion_observed: false }));
  task.reviewer.received_review_output = { output: sensitive.repeat(20000) }; task.reviewer.received_output_sha256 = digest(task.reviewer.received_review_output);
  c.save(task);
  const { get } = await statusClient(t, c), before = statusLedger(c.db), files = await statusFiles(c.stateRoot, c.workspaceRoot);
  c.scheduleAutomatic = () => assert.fail('Status scheduled execution'); c.repositoryEvidence = () => assert.fail('Status wrote evidence');
  for (let repeat = 0; repeat < 3; repeat++) {
    const text = (await get(task.id)).content[0].text, view = JSON.parse(text);
    assert(text.length < 12000); assert(!text.includes(root)); assert(!text.includes(sensitive));
    assert.equal(view.automatic.progress.attempts.validation.commands.length, 10);
    assert.equal(view.automatic.progress.attempts.validation.commands_truncated, true);
    assert.equal(view.automatic.progress.attempts.validation.status, 'unknown');
    assert.equal(view.automatic.usage.token_usage, null); assert.equal(view.implementer.latest_output, undefined);
    assert.equal(view.state, 'cleaned');
  }
  assert.equal(statusLedger(c.db), before);
  assert.equal(await statusFiles(c.stateRoot, c.workspaceRoot), files);
});

test('durable progress pending completed-publication evidence is never confirmed by status', async t => {
  const { c } = await setup(t), task = progressTask(c);
  task.publication = { phase: 'complete', push_attempted: true, pr_attempted: true, commit_tree_matches_reviewed_tree: true };
  c.save(task); c.db.prepare('INSERT INTO operations VALUES (?,?,?,?)').run(task.automatic.publish_request_id, 'fixture', task.id, 'pending');
  const before = statusLedger(c.db), view = await c.get(task.id);
  assert.equal(view.automatic.progress.attempts.publication.status, 'attempted_unconfirmed');
  assert.equal(view.automatic.progress.last_confirmed_stage, 'independent_validation');
  assert.equal(statusLedger(c.db), before);
});


for (const versioned of [false, true]) for (const expiry of [false, 'before restart', 'during cancellation'])
test(`durable progress real lifecycle preserves PR27 recovery with observational reads; versioned=${versioned}; expiry=${expiry}`, async t => {
  const effects = { pushes: 0, creates: 0, reads: 0 }; let publisher;
  const value = await automaticAttempt(t, { versioned, postReview: true, originalPass: true, async configure(c, input) {
    if (!versioned) Object.assign(input.automatic, { max_codex_turns: 2, max_corrections: 0 });
    const normal = path.join(path.dirname(c.stateRoot), 'normal');
    repoGit(normal, 'remote', 'add', 'origin', 'https://github.com/fixture/progress.git');
    publisher = { async target() { effects.reads++; return { repository: 'fixture/progress', base: 'main', remote: 'https://github.com/fixture/progress.git' }; },
      async remoteHead() { effects.reads++; return this.remote || null; },
      async push(repo, target, branch, commit) { effects.pushes++; this.remote = commit; },
      async findPR() { effects.reads++; return this.pr || null; },
      async createPR(target, branch) { effects.creates++; return this.pr = { number: 1, html_url: 'https://github.com/fixture/progress/pull/1',
        draft: true, state: 'open', merged_at: null, head: { ref: branch, sha: this.remote, repo: { full_name: target.repository } },
        base: { ref: target.base, repo: { full_name: target.repository } } }; } };
    c.publisher = publisher;
    const finish = c.finishAutomatic.bind(c), done = c.opDone.bind(c);
    c.finishAutomatic = (id, status, reason) => { if (status !== 'succeeded') finish(id, status, reason); };
    c.opDone = (id, status) => { if (!id.startsWith('automatic_publish_')) done(id, status); };
  } });
  const original = value.c.task(value.id), attempts = attemptRows(value.c, value.id);
  assert.equal(original.publication.phase, 'complete'); assert.equal(original.automatic.status, 'progressing');
  assert.equal((await value.c.get(value.id)).automatic.progress.attempts.publication.status, 'attempted_unconfirmed');
  if (expiry) t.mock.method(Date, 'now', () => original.deadline + 1000);
  if (expiry === 'during cancellation') {
    let committed;
    value.c.stopLocalWithoutStorage = async () => {
      const recovered = await new Controller({ stateRoot: value.c.stateRoot, workspaceRoot: value.c.workspaceRoot, executor: value.executor, publisher,
        localBackendFactory() { assert.fail('Model replay'); }, localValidationFactory() { assert.fail('Validation replay'); } }).init();
      try {
        assert.equal(recovered.task(value.id).automatic.status, 'succeeded');
        committed = statusLedger(recovered.db);
      } finally { interruptProgressController(recovered); }
      return { confirmed: true, diagnostics: [] };
    };
    await value.c.expireAutomatic(value.id);
    assert(committed); assert.equal(statusLedger(value.c.db), committed);
    assert.equal(value.c.task(value.id).cleanup, undefined); assert.equal(value.c.task(value.id).automatic.expiry_stop, undefined);
  }
  interruptProgressController(value.c);
  let previous, progress;
  for (let restart = 0; restart < 3; restart++) {
    const c = await new Controller({ stateRoot: value.c.stateRoot, workspaceRoot: value.c.workspaceRoot, executor: value.executor, publisher,
      localBackendFactory() { assert.fail('Model replay'); }, localValidationFactory() { assert.fail('Validation replay'); } }).init();
    try {
      const ledger = statusLedger(c.db), before = { ...effects };
      for (let read = 0; read < 3; read++) {
        const view = await c.invoke('get_task', { task_id: value.id }, {}, () => c.get(value.id));
        assert.equal(view.automatic.status, 'succeeded'); assert.equal(view.automatic.reconciliation.confirmed, true);
        assert.equal(view.automatic.progress.last_confirmed_stage, 'publication');
        assert.equal(view.automatic.progress.attempts.review.result, 'PASS');
        assert.equal(view.automatic.progress.attempts.publication.status, 'confirmed_completed');
        if (progress) assert.deepEqual(view.automatic.progress, progress); else progress = view.automatic.progress;
      }
      assert.equal(statusLedger(c.db), ledger); assert.deepEqual(effects, before);
      if (previous) assert.equal(ledger, previous); else previous = ledger;
      assert.equal(c.task(value.id).deadline, original.deadline); assert.equal(c.task(value.id).automatic.owner_instance, original.automatic.owner_instance);
      const retained = attemptRows(c, value.id);
      for (const row of attempts) assert(retained.some(next => next.value === row.value && next.observation_sha256 === row.observation_sha256));
      assert.equal(retained.filter(row => JSON.parse(row.value).outcome === 'succeeded').length, 1);
    } finally { interruptProgressController(c); }
  }
  assert.deepEqual(value.calls, ['implementer', 'reviewer']); assert.equal(effects.pushes, 1); assert.equal(effects.creates, 1);
});

test('durable progress real stopped review history remains confirmed after cleanup and restart', async t => {
  const value = await automaticAttempt(t), { c, id } = value;
  const progress = (await c.get(id)).automatic.progress;
  assert.equal(progress.last_confirmed_stage, 'independent_review'); assert.equal(progress.attempts.review.result, 'FAIL');
  const cleanup = await c.cleanup({ task_id: id, delete_workspace: true }); assert.equal(cleanup.cleanup.workspace_deleted, true);
  assert.deepEqual(cleanup.automatic.progress, progress);
  const ledger = statusLedger(c.db); interruptProgressController(c);
  for (let restart = 0; restart < 3; restart++) {
    const recovered = await new Controller({ stateRoot: c.stateRoot, workspaceRoot: c.workspaceRoot, executor: value.executor,
      localBackendFactory() { assert.fail('Model replay after cleanup'); }, localValidationFactory() { assert.fail('Validation replay after cleanup'); } }).init();
    try {
      for (let read = 0; read < 3; read++) assert.deepEqual((await recovered.get(id)).automatic.progress, progress);
      assert.equal(statusLedger(recovered.db), ledger);
    } finally { interruptProgressController(recovered); }
  }
  assert.deepEqual(value.calls, ['implementer', 'reviewer']); assert.deepEqual(value.publisherCalls, []);
});


test('durable progress masks orphaned activity even when startup classification could not commit', async t => {
  const { c } = await setup(t), task = progressTask(c);
  task.automatic.owner_instance = 'previous-controller'; task.reviewer.state = 'running';
  Object.assign(task.reviewer.local, { result_received: false, server_closed: false });
  task.local_validation.status = 'running'; c.save(task); c.persistenceFailures.add(task.id);
  const before = statusLedger(c.db), view = await c.get(task.id);
  assert.equal(view.automatic.status, 'uncertain'); assert.equal(view.automatic.human_attention_required, true);
  assert.equal(view.reviewer.state, 'needs_attention'); assert.equal(view.reviewer.local.execution_state, 'uncertain');
  assert.equal(view.reviewer.independent_validation.status, 'uncertain');
  assert.equal(view.automatic.progress.last_confirmed_stage, null); assert.equal(statusLedger(c.db), before);
});


for (const postReview of [false, true])
test(`durable progress follows authorized corrective attempts without relabeling originals; reviewed=${postReview}`, async t => {
  const value = await automaticAttempt(t, { versioned: true, correction: !postReview, postReview });
  const { c, id } = value, parent = c.task(id), child = c.task(parent.automatic.correction.task_id);
  const before = statusLedger(c.db), view = await c.get(id), progress = view.automatic.progress;
  assert.equal(progress.stage, postReview ? 'independent_review' : 'correction');
  assert.equal(progress.last_confirmed_stage, postReview ? 'independent_review' : 'correction');
  assert.equal(progress.attempts.implementation.thread_id, parent.implementer.local.thread_id);
  assert.equal(view.correction.attempt_id, child.request_id); assert.equal(view.correction.execution.thread_id, child.implementer.local.thread_id);
  assert.equal(view.correction.execution_authorized, false);
  assert.notEqual(view.correction.execution.thread_id, progress.attempts.implementation.thread_id);
  if (postReview) assert.equal(view.correction.review.validation.attempt_id, child.local_validation.attempt_id);
  assert.equal(statusLedger(c.db), before);
  const restarted = await restartEvidenceController(t, value), stable = statusLedger(restarted.db);
  for (let read = 0; read < 3; read++) {
    const status = await restarted.get(id);
    assert.equal(status.automatic.progress.attempts.implementation.thread_id, parent.implementer.local.thread_id);
    assert.equal(status.correction.attempt_id, child.request_id); assert.equal(status.correction.execution.thread_id, child.implementer.local.thread_id);
  }
  assert.equal(statusLedger(restarted.db), stable); assert.equal(value.calls.length, postReview ? 4 : 3);
});

test('durable progress missing reviewer with a pending operation keeps usage unknown', async t => {
  const { c } = await setup(t), task = progressTask(c); delete task.reviewer; delete task.local_validation;
  c.save(task); c.db.prepare('INSERT INTO operations VALUES (?,?,?,?)').run(task.automatic.review_request_id, 'fixture', task.id, 'pending');
  const view = await c.get(task.id);
  assert.equal(view.automatic.usage.reviewer_turn_submissions_attempted, null);
  assert.equal(view.automatic.progress.attempts.review.status, 'unknown');
});


for (const mode of ['passed', 'failed', 'unconfirmed', 'wrong tree', 'missing evidence', 'reserved'])
test(`durable progress validation completion requires bound evidence: ${mode}`, async t => {
  const { c } = await setup(t), task = progressTask(c), validation = task.local_validation;
  const required = { ...contract(), test_commands: ['true'] };
  task.automatic.contract_binding = { sha256: digest(required), contract: required };
  const output = { available: true, truncated: false, redacted: false, encoding_error: false, text: '' };
  const record = { attempt_id: 'validation-command-original', validation_attempt_id: validation.attempt_id, command_index: 0,
    command: 'true', candidate_tree: task.reviewer.reviewed_git_state.tree_sha, cwd: '/synthetic/validator',
    cwd_identity: { realpath: '/synthetic/validator', device: 1, inode: 1 }, materialization: { source: 'git_tree_blobs', filters_applied: false },
    status: mode === 'failed' || mode === 'wrong tree' ? 'failed' : 'passed', start_attempted: true, start_observed: true,
    completion_observed: mode !== 'unconfirmed', independently_observed: true, termination_confirmed: true,
    exit_code: mode === 'failed' || mode === 'wrong tree' ? 1 : 0, signal: null, timeout: false, cancelled: false,
    background_processes_observed: false, stdout: output, stderr: output };
  validation.results = [record];
  if (mode === 'wrong tree') record.candidate_tree = 'c'.repeat(40);
  if (mode === 'missing evidence') { validation.status = 'completed'; validation.results = []; }
  if (mode === 'reserved') { validation.status = 'pending'; validation.results = []; }
  c.save(task); const before = statusLedger(c.db), view = await c.get(task.id);
  const actual = view.automatic.progress.attempts.validation;
  assert.equal(actual.status, { passed: 'confirmed_completed', failed: 'confirmed_failed', unconfirmed: 'attempted_unconfirmed',
    'wrong tree': 'attempted_unconfirmed', 'missing evidence': 'unknown', reserved: 'not_attempted' }[mode]);
  assert.equal(actual.attempt_id, validation.attempt_id);
  assert.equal(actual.commands[0]?.completion_confirmed ?? false, ['passed', 'failed'].includes(mode));
  assert.equal(statusLedger(c.db), before);
});


// Reproduce the independently reported SQLite IGNORE defects with the real store.
test('automatic operation durability rejects an ignored reservation and its repeated dispatch', async t => {
  const { c } = await setup(t), task = progressTask(c); c.save(task);
  c.db.exec("CREATE TEMP TRIGGER ignored_reservation BEFORE INSERT ON operations BEGIN SELECT RAISE(IGNORE); END;");
  let dispatched = 0, rejected = 0;
  try {
    for (let repeat = 0; repeat < 2; repeat++) {
      try { if (!c.operation(task.automatic.publish_request_id, 'automatic_publish', { task_id: task.id, ...task.automatic.authorization.publish }, task.id)) dispatched++; }
      catch (error) { assert.equal(error.code, 'AUTOMATIC_EVIDENCE_PERSISTENCE_UNCONFIRMED'); rejected++; }
    }
    assert.equal(c.db.prepare('SELECT count(*) AS n FROM operations').get().n, 0);
    assert.deepEqual({ dispatched, rejected }, { dispatched: 0, rejected: 2 });
  } finally { c.db.exec('DROP TRIGGER ignored_reservation'); }
});

test('automatic operation durability ignored publication acknowledgment cannot become success', async t => {
  const { c } = await setup(t), task = progressTask(c);
  task.automatic.phase = 'publication'; task.publication = { phase: 'complete', push_attempted: true, pr_attempted: true, commit_tree_matches_reviewed_tree: true };
  c.save(task);
  c.operation(task.automatic.publish_request_id, 'automatic_publish', { task_id: task.id, ...task.automatic.authorization.publish }, task.id);
  c.db.exec("CREATE TEMP TRIGGER ignored_ack BEFORE UPDATE ON operations WHEN NEW.status='accepted' BEGIN SELECT RAISE(IGNORE); END;");
  try {
    try { c.opDone(task.automatic.publish_request_id); c.finishAutomatic(task.id, 'succeeded', null); }
    catch (error) { assert.equal(error.code, 'AUTOMATIC_EVIDENCE_PERSISTENCE_UNCONFIRMED'); }
    const view = await c.get(task.id);
    assert.equal(c.db.prepare('SELECT status FROM operations WHERE id=?').get(task.automatic.publish_request_id).status, 'pending');
    assert.equal(view.automatic.progress.attempts.publication.status, 'attempted_unconfirmed');
    assert.equal(view.automatic.status, 'uncertain'); assert.equal(view.automatic.human_attention_required, true);
  } finally { c.db.exec('DROP TRIGGER ignored_ack'); }
});


function automaticOperationFixture(c, kind = 'automatic_publish') {
  const task = progressTask(c); task.repository = { repository_id: 'fixture', base_ref: 'HEAD', baseline_commit: task.baseline };
  task.automatic.phase = 'publication'; task.publication = { phase: 'complete', push_attempted: true, pr_attempted: true, commit_tree_matches_reviewed_tree: true };
  c.save(task);
  const request = kind === 'start' ? { id: task.request_id, payload: { execution_backend: 'local_codex', input: {
    contract: task.automatic.contract_binding.contract, repository_id: 'fixture', base_ref: 'HEAD', automatic: task.automatic.authorization } } } :
    kind === 'review' ? { id: task.automatic.review_request_id, payload: { id: task.id } } :
    kind === 'correction' ? { id: 'correction-reservation', payload: { parent_task_id: task.id, task_id: 'corrective-child' } } :
    { id: task.automatic.publish_request_id, payload: { task_id: task.id, ...task.automatic.authorization.publish } };
  return { task, ...request, kind, taskId: kind === 'correction' ? 'corrective-child' : task.id };
}

for (const effect of ['IGNORE', 'ABORT']) for (const kind of ['start', 'review', 'automatic_publish', 'correction'])
test(`automatic operation durability ${effect} reservation prevents dispatch: ${kind}`, async t => {
  const { c } = await setup(t), input = automaticOperationFixture(c, kind);
  c.db.exec(`CREATE TEMP TRIGGER operation_fault BEFORE INSERT ON operations BEGIN SELECT RAISE(${effect}${effect === 'ABORT' ? ", 'synthetic reservation failure'" : ''}); END;`);
  try {
    for (let repeat = 0; repeat < 2; repeat++) assert.throws(() => c.operation(input.id, kind, input.payload, input.taskId), /AUTOMATIC_EVIDENCE_PERSISTENCE_UNCONFIRMED/);
    assert.equal(c.db.prepare('SELECT count(*) AS n FROM operations').get().n, 0);
    assert.equal(c.automaticJobs.size + c.localRuns.size + c.validationRuns.size, 0);
  } finally { c.db.exec('DROP TRIGGER operation_fault'); }
});

for (const kind of ['start', 'review', 'automatic_publish'])
test(`automatic operation durability confirms bindings and idempotent duplicate ${kind}`, async t => {
  const { c } = await setup(t), input = automaticOperationFixture(c, kind);
  assert.equal(c.operation(input.id, kind, input.payload, input.taskId), null);
  c.opDone(input.id);
  const before = statusLedger(c.db);
  const duplicate = c.operation(input.id, kind, input.payload, kind === 'start' ? 'new-start-task-id' : input.taskId);
  assert.deepEqual({ ...duplicate }, { id: input.id, fingerprint: digest({ kind, payload: input.payload }), task_id: input.taskId, status: 'accepted' });
  assert.equal(statusLedger(c.db), before);
  assert.throws(() => c.operation(input.id, kind, { ...input.payload, changed: true }, input.taskId), /REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT/);
  assert.equal(statusLedger(c.db), before);
});

for (const field of ['id', 'fingerprint', 'task_id', 'status'])
test(`automatic operation durability rejects reservation rewritten by SQLite trigger: ${field}`, async t => {
  const { c } = await setup(t), input = automaticOperationFixture(c);
  c.db.exec(`CREATE TEMP TRIGGER operation_fault AFTER INSERT ON operations BEGIN UPDATE operations SET ${field}='conflicting' WHERE id=NEW.id; END;`);
  try {
    assert.throws(() => c.operation(input.id, input.kind, input.payload, input.taskId), /AUTOMATIC_EVIDENCE_PERSISTENCE_UNCONFIRMED/);
    assert.equal(c.db.prepare('SELECT count(*) AS n FROM operations').get().n, 0);
  } finally { c.db.exec('DROP TRIGGER operation_fault'); }
});

for (const effect of ['IGNORE', 'ABORT']) for (const boundary of ['operation', 'task', 'outcome'])
test(`automatic operation durability atomically rejects ${effect} at completion ${boundary}`, async t => {
  const { c } = await setup(t), input = automaticOperationFixture(c);
  c.operation(input.id, input.kind, input.payload, input.taskId);
  const [table, event, predicate] = boundary === 'operation' ? ['operations', 'UPDATE', "NEW.status='accepted'"] :
    boundary === 'task' ? ['tasks', 'INSERT', "json_extract(NEW.value,'$.automatic.status')='succeeded'"] :
    ['automatic_attempts', 'INSERT', "json_extract(NEW.value,'$.outcome')='succeeded'"];
  c.db.exec(`CREATE TEMP TRIGGER operation_fault BEFORE ${event} ON ${table} WHEN ${predicate} BEGIN SELECT RAISE(${effect}${effect === 'ABORT' ? ", 'synthetic completion failure'" : ''}); END;`);
  try {
    assert.throws(() => c.finishAutomatic(input.taskId, 'succeeded', null), /AUTOMATIC_EVIDENCE_PERSISTENCE_UNCONFIRMED/);
    assert.equal(c.task(input.taskId).automatic.status, 'progressing');
    assert.equal(c.db.prepare('SELECT status FROM operations WHERE id=?').get(input.id).status, 'pending');
    assert.equal(c.db.prepare("SELECT count(*) AS n FROM automatic_attempts WHERE json_extract(value,'$.outcome')='succeeded'").get().n, 0);
    const view = await c.get(input.taskId); assert.equal(view.automatic.status, 'uncertain'); assert.equal(view.automatic.human_attention_required, true);
  } finally { c.db.exec('DROP TRIGGER operation_fault'); }
});

for (const fault of ['missing', 'fingerprint', 'task_id', 'status'])
test(`automatic operation durability rejects ${fault} acknowledgment binding`, async t => {
  const { c } = await setup(t), input = automaticOperationFixture(c);
  c.operation(input.id, input.kind, input.payload, input.taskId);
  if (fault === 'missing') c.db.prepare('DELETE FROM operations WHERE id=?').run(input.id);
  else c.db.prepare(`UPDATE operations SET ${fault}='conflicting' WHERE id=?`).run(input.id);
  const before = statusLedger(c.db);
  assert.throws(() => c.opDone(input.id), /AUTOMATIC_EVIDENCE_PERSISTENCE_UNCONFIRMED/);
  assert.equal(statusLedger(c.db), before);
  assert.equal((await c.get(input.taskId)).automatic.status, 'uncertain');
});

for (const fault of ['missing', 'pending', 'fingerprint', 'task_id'])
test(`automatic operation durability observationally rejects historical success with ${fault} publication proof`, async t => {
  const { c } = await setup(t), input = automaticOperationFixture(c);
  c.operation(input.id, input.kind, input.payload, input.taskId); c.finishAutomatic(input.taskId, 'succeeded', null);
  if (fault === 'missing') c.db.prepare('DELETE FROM operations WHERE id=?').run(input.id);
  else if (fault === 'pending') c.db.prepare("UPDATE operations SET status='pending' WHERE id=?").run(input.id);
  else c.db.prepare(`UPDATE operations SET ${fault}='conflicting' WHERE id=?`).run(input.id);
  const before = statusLedger(c.db);
  for (let read = 0; read < 3; read++) {
    const view = await c.invoke('get_task', { task_id: input.taskId }, {}, () => c.get(input.taskId));
    assert.equal(view.automatic.status, 'uncertain'); assert.equal(view.automatic.human_attention_required, true);
    assert.equal(view.automatic.progress.attempts.publication.status, 'attempted_unconfirmed');
  }
  assert.equal(statusLedger(c.db), before);
});

test('automatic operation durability success and accepted acknowledgment survive repeated restart', async t => {
  const { c, root } = await setup(t), input = automaticOperationFixture(c);
  c.operation(input.id, input.kind, input.payload, input.taskId); c.finishAutomatic(input.taskId, 'succeeded', null);
  assert.equal(c.task(input.taskId).automatic.status, 'succeeded');
  const ledger = statusLedger(c.db); interruptProgressController(c);
  for (let restart = 0; restart < 3; restart++) {
    const recovered = await new Controller({ stateRoot: path.join(root, 'state'), workspaceRoot: path.join(root, 'work'), executor: new FakeExecutor(),
      localBackendFactory() { assert.fail('Model replay'); }, localValidationFactory() { assert.fail('Validation replay'); } }).init();
    try {
      const view = await recovered.get(input.taskId);
      assert.equal(view.automatic.status, 'succeeded'); assert.equal(view.automatic.human_attention_required, false);
      assert.equal(view.automatic.progress.attempts.publication.status, 'confirmed_completed');
      assert.equal(recovered.db.prepare('SELECT status FROM operations WHERE id=?').get(input.id).status, 'accepted');
      assert.equal(statusLedger(recovered.db), ledger);
    } finally { interruptProgressController(recovered); }
  }
});

for (const boundary of ['release', 'rollback'])
test(`automatic operation durability uncertain ${boundary} cannot authorize dispatch`, async t => {
  const { c, root } = await setup(t), input = automaticOperationFixture(c);
  const reader = new DatabaseSync(path.join(root, 'state/controller.sqlite'), { readOnly: true });
  if (boundary === 'rollback') c.db.exec("CREATE TEMP TRIGGER operation_fault BEFORE INSERT ON operations BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;");
  c.db.setAuthorizer((action, name) => action === sqlite.SQLITE_SAVEPOINT && name === boundary.toUpperCase() ? sqlite.SQLITE_DENY : sqlite.SQLITE_OK);
  try {
    assert.throws(() => c.operation(input.id, input.kind, input.payload, input.taskId), /AUTOMATIC_EVIDENCE_PERSISTENCE_UNCONFIRMED/);
    assert.equal(c.transactionUnresolved, true);
    assert.equal(reader.prepare('SELECT count(*) AS n FROM operations').get().n, 0);
    assert.equal(c.automaticJobs.size + c.localRuns.size + c.validationRuns.size, 0);
  } finally {
    c.db.setAuthorizer(null); if (c.db.isTransaction) c.db.exec('ROLLBACK'); reader.close();
    assert.throws(() => c.storageAuthority(), /STORAGE_TRANSACTION_UNRESOLVED/);
    interruptProgressController(c);
  }
});

test('automatic operation durability preserves a concurrent committed terminal outcome', async t => {
  const { c, root } = await setup(t), input = automaticOperationFixture(c);
  c.operation(input.id, input.kind, input.payload, input.taskId);
  const second = new Controller({ executor: new FakeExecutor() }); second.db = new DatabaseSync(path.join(root, 'state/controller.sqlite'));
  const save = c.save.bind(c); let interleaved = false;
  c.save = (task, options) => {
    if (!interleaved && task.automatic.status === 'succeeded') { interleaved = true; second.finishAutomatic(input.taskId, 'succeeded', null); }
    return save(task, options);
  };
  try {
    assert.throws(() => c.finishAutomatic(input.taskId, 'succeeded', null), /AUTOMATIC_EVIDENCE_PERSISTENCE_UNCONFIRMED/);
    const committed = statusLedger(second.db); c.persistenceAttention(input.taskId);
    assert.equal(statusLedger(second.db), committed); assert.equal(second.task(input.taskId).automatic.status, 'succeeded');
    assert.equal(second.db.prepare('SELECT status FROM operations WHERE id=?').get(input.id).status, 'accepted');
    assert.equal((await c.get(input.taskId)).automatic.status, 'uncertain'); assert.equal((await second.get(input.taskId)).automatic.status, 'succeeded');
  } finally { interruptProgressController(second); }
});


for (const versioned of [false, true]) for (const fault of ['reserve_start', 'reserve_review', 'reserve_publish', 'ack_implementation', 'ack_review', 'ack_publication', 'none'])
test(`automatic operation durability real lifecycle; versioned=${versioned}; fault=${fault}`, async t => {
  const effects = { pushes: 0, creates: 0 }, controllers = []; let publisher, executions = 0;
  const run = automaticAttempt(t, { versioned, postReview: true, originalPass: true, async configure(c, input) {
    controllers.push(c);
    if (!versioned) Object.assign(input.automatic, { max_codex_turns: 2, max_corrections: 0 });
    repoGit(path.join(path.dirname(c.stateRoot), 'normal'), 'remote', 'add', 'origin', 'https://github.com/fixture/operation-proof.git');
    const factory = c.localBackendFactory; c.localBackendFactory = options => { executions++; return factory(options); };
    publisher = { async target() { return { repository: 'fixture/operation-proof', base: 'main', remote: 'https://github.com/fixture/operation-proof.git' }; },
      async remoteHead() { return this.remote || null; }, async push(repo, target, branch, commit) { effects.pushes++; this.remote = commit; },
      async findPR() { return this.pr || null; }, async createPR(target, branch) { effects.creates++; return this.pr = {
        number: 1, html_url: 'https://github.com/fixture/operation-proof/pull/1', draft: true, state: 'open', merged_at: null,
        head: { ref: branch, sha: this.remote, repo: { full_name: target.repository } }, base: { ref: target.base, repo: { full_name: target.repository } } }; } };
    c.publisher = publisher;
    if (fault !== 'none') {
      const reservation = fault.startsWith('reserve'), which = fault.split('_')[1];
      const predicate = which === 'start' || which === 'implementation' ? "NEW.id='automatic_evidence'" :
        which === 'review' ? "NEW.id LIKE 'automatic_review_%'" : "NEW.id LIKE 'automatic_publish_%'";
      c.db.exec(`CREATE TEMP TRIGGER lifecycle_operation_fault BEFORE ${reservation ? 'INSERT' : 'UPDATE'} ON operations WHEN ${predicate}${reservation ? '' : " AND NEW.status='accepted'"} BEGIN SELECT RAISE(IGNORE); END;`);
    }
  } });
  if (fault === 'reserve_start') {
    try { await assert.rejects(run, /AUTOMATIC_EVIDENCE_PERSISTENCE_UNCONFIRMED/); assert.equal(executions, 0); assert.deepEqual(effects, { pushes: 0, creates: 0 }); }
    finally { controllers[0]?.db.exec('DROP TRIGGER lifecycle_operation_fault'); }
    return;
  }
  const value = await run, { c, id } = value;
  try {
    const view = await c.get(id), original = c.task(id);
    assert.equal(view.automatic.status, fault === 'none' ? 'succeeded' : 'uncertain');
    assert.equal(view.automatic.human_attention_required, fault !== 'none');
    assert.equal(executions, ['reserve_review', 'ack_implementation'].includes(fault) ? 1 : 2);
    assert.deepEqual(effects, fault === 'ack_publication' || fault === 'none' ? { pushes: 1, creates: 1 } : { pushes: 0, creates: 0 });
    if (fault === 'ack_publication') {
      assert.equal(original.automatic.status, 'uncertain');
      assert.equal(c.db.prepare('SELECT status FROM operations WHERE id=?').get(original.automatic.publish_request_id).status, 'pending');
      assert.equal(view.automatic.progress.attempts.publication.status, 'attempted_unconfirmed');
    }
    if (fault === 'none') {
      assert.equal(c.db.prepare('SELECT status FROM operations WHERE id=?').get(original.automatic.publish_request_id).status, 'accepted');
      assert.equal((await c.start(value.input)).task_id, id); assert.equal(executions, 2);
    }
    if (fault !== 'none') c.db.exec('DROP TRIGGER lifecycle_operation_fault');
    interruptProgressController(c);
    const recovered = await new Controller({ stateRoot: c.stateRoot, workspaceRoot: c.workspaceRoot, executor: value.executor, publisher,
      localBackendFactory() { assert.fail('Model replay'); }, localValidationFactory() { assert.fail('Validation replay'); } }).init();
    try {
      const status = await recovered.get(id), ledger = statusLedger(recovered.db);
      if (status.automatic.status === 'succeeded') assert.equal(recovered.db.prepare('SELECT status FROM operations WHERE id=?').get(original.automatic.publish_request_id).status, 'accepted');
      else assert.equal(status.automatic.human_attention_required, true);
      for (let read = 0; read < 2; read++) await recovered.get(id);
      assert.equal(statusLedger(recovered.db), ledger); assert.equal(recovered.task(id).deadline, original.deadline);
      assert.equal(executions, value.calls.length); assert.deepEqual(effects, fault === 'ack_publication' || fault === 'none' ? { pushes: 1, creates: 1 } : { pushes: 0, creates: 0 });
    } finally { interruptProgressController(recovered); }
  } finally { if (!c.dbClosed && fault !== 'none') c.db.exec('DROP TRIGGER IF EXISTS lifecycle_operation_fault'); }
});


for (const fault of ['none', 'reserve_publish', 'ack_publication'])
test(`automatic operation durability preserves authorized corrective publication: ${fault}`, async t => {
  const effects = { pushes: 0, creates: 0 };
  const value = await automaticAttempt(t, { versioned: true, postReview: true, async configure(c, input) {
    input.automatic.publish_after_correction = true;
    repoGit(path.join(path.dirname(c.stateRoot), 'normal'), 'remote', 'add', 'origin', 'https://github.com/fixture/corrective-operation.git');
    c.publisher = { async target() { return { repository: 'fixture/corrective-operation', base: 'main', remote: 'https://github.com/fixture/corrective-operation.git' }; },
      async remoteHead() { return this.remote || null; }, async push(repo, target, branch, commit) { effects.pushes++; this.remote = commit; },
      async findPR() { return this.pr || null; }, async createPR(target, branch) { effects.creates++; return this.pr = {
        number: 1, html_url: 'https://github.com/fixture/corrective-operation/pull/1', draft: true, state: 'open', merged_at: null,
        head: { ref: branch, sha: this.remote, repo: { full_name: target.repository } }, base: { ref: target.base, repo: { full_name: target.repository } } }; } };
    if (fault !== 'none') c.db.exec(`CREATE TEMP TRIGGER corrective_operation_fault BEFORE ${fault === 'reserve_publish' ? 'INSERT' : 'UPDATE'} ON operations WHEN NEW.id LIKE 'automatic_publish_%'${fault === 'reserve_publish' ? '' : " AND NEW.status='accepted'"} BEGIN SELECT RAISE(IGNORE); END;`);
  } });
  const { c, id } = value;
  try {
    const parent = c.task(id), child = c.task(parent.automatic.correction.task_id);
    assert.equal(parent.automatic.status, fault === 'none' ? 'succeeded' : 'uncertain');
    assert.equal(child.automatic.status, fault === 'none' ? 'succeeded' : 'uncertain');
    assert.equal(value.calls.length, 4);
    assert.deepEqual(effects, fault === 'reserve_publish' ? { pushes: 0, creates: 0 } : { pushes: 1, creates: 1 });
    const operation = c.db.prepare('SELECT * FROM operations WHERE id=?').get(parent.automatic.publish_request_id);
    if (fault === 'none') {
      assert.equal(operation.task_id, child.id); assert.equal(operation.status, 'accepted');
      assert.equal(operation.fingerprint, digest({ kind: 'automatic_publish', payload: child.automatic.corrective_publication.input }));
    } else assert.notEqual(operation?.status, 'accepted');
  } finally { if (fault !== 'none') c.db.exec('DROP TRIGGER corrective_operation_fault'); }
});


test('automatic operation durability late failure cannot downgrade another Controller success', async t => {
  const { c, root } = await setup(t), input = automaticOperationFixture(c);
  c.operation(input.id, input.kind, input.payload, input.taskId);
  const second = new Controller({ executor: new FakeExecutor() }); second.db = new DatabaseSync(path.join(root, 'state/controller.sqlite'));
  let committed;
  c.runAutomatic = async () => { second.finishAutomatic(input.taskId, 'succeeded', null); committed = statusLedger(second.db); throw Error('Late callback after concurrent completion'); };
  try {
    c.scheduleAutomatic(input.taskId); await Promise.all([...c.automaticJobs.values()]);
    assert.equal(statusLedger(second.db), committed);
    assert.equal(second.db.prepare('SELECT status FROM operations WHERE id=?').get(input.id).status, 'accepted');
    assert.equal((await c.get(input.taskId)).automatic.status, 'succeeded');
    assert.throws(() => c.opDone(input.id, 'uncertain'), /AUTOMATIC_EVIDENCE_PERSISTENCE_UNCONFIRMED/);
    assert.equal(statusLedger(second.db), committed);
  } finally { interruptProgressController(second); }
});


for (const path of ['finishAutomatic', 'finishAutomatic uncertain', 'persistenceAttention'])
test(`automatic concurrent writes stale ${path} cannot overwrite committed success`, async t => {
  const { c, root, api, executor } = await setup(t), input = automaticOperationFixture(c);
  c.operation(input.id, input.kind, input.payload, input.taskId);
  const second = new Controller({ executor: new FakeExecutor() }); second.db = new DatabaseSync(`${root}/state/controller.sqlite`);
  const save = c.save.bind(c); let committed, interleaved = false, failure;
  c.save = (task, options) => {
    if (!interleaved) {
      interleaved = true;
      second.finishAutomatic(input.taskId, 'succeeded', null);
      committed = statusLedger(second.db);
    }
    return save(task, options);
  };
  c.localBackendFactory = () => assert.fail('Model dispatch from stale writer');
  c.localValidationFactory = () => assert.fail('Validation dispatch from stale writer');
  c.publisher = new Proxy({}, { get() { assert.fail('Publication from stale writer'); } });
  try {
    if (path === 'persistenceAttention') c.persistenceFailures.add(input.taskId);
    try { path.startsWith('finishAutomatic') ? c.finishAutomatic(input.taskId, path.endsWith('uncertain') ? 'uncertain' : 'stopped', 'AUTOMATIC_VALIDATION_FAILED') : c.persistenceAttention(input.taskId); }
    catch (error) { failure = error; }
    assert.equal(interleaved, true);
    assert.equal(second.task(input.taskId).automatic.status, 'succeeded');
    assert.equal(statusLedger(second.db), committed);
    assert.equal(second.db.prepare('SELECT status FROM operations WHERE id=?').get(input.id).status, 'accepted');
    if (path.startsWith('finishAutomatic')) assert.equal(failure?.code, 'AUTOMATIC_EVIDENCE_PERSISTENCE_UNCONFIRMED');
    assert.equal(c.persistenceFailures.has(input.taskId), true);
    assert.equal((await c.get(input.taskId)).automatic.status, 'uncertain');
    assert.equal((await second.get(input.taskId)).automatic.status, 'succeeded');
    assert.equal(c.automaticJobs.size + c.localRuns.size + c.validationRuns.size, 0);
    assert.equal(api.created.length + api.sent.length + executor.started.length, 0);
    assert.equal(statusLedger(second.db), committed);
  } finally { interruptProgressController(second); }
  interruptProgressController(c);
  for (let restart = 0; restart < 3; restart++) {
    const recovered = await new Controller({ stateRoot: `${root}/state`, workspaceRoot: `${root}/work`, executor: new FakeExecutor(),
      localBackendFactory() { assert.fail('Model replay'); }, localValidationFactory() { assert.fail('Validation replay'); },
      publisher: new Proxy({}, { get() { assert.fail('Publication replay'); } }) }).init();
    try {
      for (let read = 0; read < 3; read++) {
        const view = await recovered.invoke('get_task', { task_id: input.taskId }, {}, () => recovered.get(input.taskId));
        assert.equal(view.automatic.status, 'succeeded'); assert.equal(view.automatic.human_attention_required, false);
        assert.equal(view.automatic.progress.attempts.publication.status, 'confirmed_completed');
      }
      assert.equal(statusLedger(recovered.db), committed);
    } finally { interruptProgressController(recovered); }
  }
});


for (const path of ['finishAutomatic', 'persistenceAttention']) for (const latched of [false, true])
test(`automatic concurrent writes wholly late ${path} preserves success and prior latch=${latched}`, async t => {
  const { c, root } = await setup(t), input = automaticOperationFixture(c);
  c.operation(input.id, input.kind, input.payload, input.taskId);
  const second = new Controller({ executor: new FakeExecutor() }); second.db = new DatabaseSync(`${root}/state/controller.sqlite`);
  try {
    second.finishAutomatic(input.taskId, 'succeeded', null);
    const committed = statusLedger(second.db);
    if (latched) c.persistenceFailures.add(input.taskId);
    path === 'finishAutomatic' ? c.finishAutomatic(input.taskId, 'stopped', 'AUTOMATIC_OPERATION_UNCONFIRMED') : c.persistenceAttention(input.taskId);
    assert.equal(statusLedger(second.db), committed);
    assert.equal(c.persistenceFailures.has(input.taskId), latched);
    const view = await c.get(input.taskId);
    assert.equal(view.automatic.status, latched ? 'uncertain' : 'succeeded');
    assert.equal(view.automatic.human_attention_required, latched);
    assert.equal(c.automaticJobs.size + c.localRuns.size + c.validationRuns.size, 0);
  } finally { interruptProgressController(second); }
});

for (const status of ['stopped', 'uncertain'])
test(`automatic concurrent writes genuine ${status} retains original behavior`, async t => {
  const { c, root } = await setup(t), input = automaticOperationFixture(c);
  c.operation(input.id, input.kind, input.payload, input.taskId);
  const reader = new DatabaseSync(`${root}/state/controller.sqlite`, { readOnly: true });
  try {
    c.finishAutomatic(input.taskId, status, 'AUTOMATIC_OPERATION_UNCONFIRMED');
    const task = JSON.parse(reader.prepare('SELECT value FROM tasks WHERE id=?').get(input.taskId).value);
    assert.deepEqual(task, { ...input.task, automatic: { ...input.task.automatic, status, reason: 'AUTOMATIC_OPERATION_UNCONFIRMED', human_attention_required: true } });
    c.verifyAutomaticEvidence(task);
    assert.equal(reader.prepare('SELECT status FROM operations WHERE id=?').get(input.id).status, 'pending');
    assert.equal(c.persistenceFailures.has(input.taskId), false);
    const view = await c.get(input.taskId); assert.equal(view.automatic.status, status); assert.equal(view.automatic.human_attention_required, true);
  } finally { reader.close(); }
});

test('automatic concurrent writes genuine persistence attention retains task identity and pending operation', async t => {
  const { c } = await setup(t), input = automaticOperationFixture(c);
  c.operation(input.id, input.kind, input.payload, input.taskId); c.persistenceFailures.add(input.taskId);
  c.persistenceAttention(input.taskId);
  assert.deepEqual(c.task(input.taskId), { ...input.task, reviewer: { ...input.task.reviewer, local: { ...input.task.reviewer.local, human_attention_required: true } },
    automatic: { ...input.task.automatic, status: 'uncertain', reason: 'AUTOMATIC_EVIDENCE_PERSISTENCE_UNCONFIRMED', human_attention_required: true } });
  assert.equal(c.db.prepare('SELECT status FROM operations WHERE id=?').get(input.id).status, 'pending');
  assert.equal(c.persistenceFailures.has(input.taskId), true);
  assert.equal((await c.get(input.taskId)).automatic.status, 'uncertain');
});

for (const path of ['finishAutomatic', 'persistenceAttention'])
test(`automatic concurrent writes ${path} storage uncertainty cannot invent success`, async t => {
  const { c, root } = await setup(t), input = automaticOperationFixture(c);
  c.operation(input.id, input.kind, input.payload, input.taskId);
  const reader = new DatabaseSync(`${root}/state/controller.sqlite`, { readOnly: true }), before = statusLedger(reader);
  c.db.exec('CREATE TEMP TRIGGER attention_fault BEFORE INSERT ON tasks BEGIN SELECT RAISE(IGNORE); END;');
  try {
    if (path === 'finishAutomatic') assert.throws(() => c.finishAutomatic(input.taskId, 'stopped', 'AUTOMATIC_VALIDATION_FAILED'), /AUTOMATIC_EVIDENCE_PERSISTENCE_UNCONFIRMED/);
    else c.persistenceAttention(input.taskId);
    assert.equal(c.persistenceFailures.has(input.taskId), true);
    assert.equal(statusLedger(reader), before);
    const view = await c.get(input.taskId); assert.equal(view.automatic.status, 'uncertain'); assert.equal(view.automatic.human_attention_required, true);
    assert.equal(view.automatic.progress.attempts.publication.status, 'attempted_unconfirmed');
  } finally { c.db.exec('DROP TRIGGER attention_fault'); reader.close(); }
});

for (const path of ['finishAutomatic', 'persistenceAttention'])
test(`automatic concurrent writes stale ${path} nonterminal conflict grants no authority`, async t => {
  const { c, root } = await setup(t), input = automaticOperationFixture(c);
  c.operation(input.id, input.kind, input.payload, input.taskId);
  const second = new Controller({ executor: new FakeExecutor() }); second.db = new DatabaseSync(`${root}/state/controller.sqlite`);
  const save = c.save.bind(c); let committed, interleaved = false;
  c.save = (task, options) => {
    if (!interleaved) {
      interleaved = true;
      const competing = second.task(input.taskId); competing.automatic.phase = 'validation_and_review'; second.save(competing);
      committed = statusLedger(second.db);
    }
    return save(task, options);
  };
  try {
    if (path === 'finishAutomatic') assert.throws(() => c.finishAutomatic(input.taskId, 'stopped', 'AUTOMATIC_VALIDATION_FAILED'), /AUTOMATIC_EVIDENCE_PERSISTENCE_UNCONFIRMED/);
    else c.persistenceAttention(input.taskId);
    assert.equal(interleaved, true); assert.equal(statusLedger(second.db), committed);
    assert.equal(c.persistenceFailures.has(input.taskId), true);
    const view = await c.get(input.taskId); assert.equal(view.automatic.status, 'uncertain'); assert.equal(view.automatic.human_attention_required, true);
    assert.equal(view.automatic.progress.attempts.publication.status, 'attempted_unconfirmed');
    assert.equal(second.task(input.taskId).automatic.status, 'progressing');
    assert.equal(second.db.prepare('SELECT status FROM operations WHERE id=?').get(input.id).status, 'pending');
    assert.equal(second.db.prepare("SELECT count(*) AS n FROM automatic_attempts WHERE json_extract(value,'$.outcome')='succeeded'").get().n, 0);
    assert.equal(c.automaticJobs.size + c.localRuns.size + c.validationRuns.size, 0);
  } finally { interruptProgressController(second); }
});

for (const path of ['finishAutomatic', 'persistenceAttention']) for (const timing of ['stale', 'late']) for (const fault of ['operation', 'outcome', 'task'])
test(`automatic concurrent writes ${timing} ${path} rejects unproven terminal ${fault} evidence`, async t => {
  const { c, root } = await setup(t), input = automaticOperationFixture(c);
  c.operation(input.id, input.kind, input.payload, input.taskId);
  const second = new Controller({ executor: new FakeExecutor() }); second.db = new DatabaseSync(`${root}/state/controller.sqlite`);
  let committed;
  const competing = () => {
    second.finishAutomatic(input.taskId, 'succeeded', null);
    // Deliberately inconsistent storage must never be qualified by the status string.
    if (fault === 'operation') second.db.prepare("UPDATE operations SET fingerprint='conflicting' WHERE id=?").run(input.id);
    if (fault === 'outcome') second.db.prepare("DELETE FROM automatic_attempts WHERE json_extract(value,'$.outcome')='succeeded'").run();
    if (fault === 'task') {
      const task = second.task(input.taskId); task.baseline = 'c'.repeat(40);
      second.db.prepare('UPDATE tasks SET value=? WHERE id=?').run(JSON.stringify(task), input.taskId);
    }
    committed = statusLedger(second.db);
  };
  const save = c.save.bind(c);
  if (timing === 'stale') c.save = (task, options) => { competing(); return save(task, options); };
  else competing();
  try {
    if (path === 'finishAutomatic' && timing === 'stale') assert.throws(() => c.finishAutomatic(input.taskId, 'stopped', 'AUTOMATIC_VALIDATION_FAILED'), /AUTOMATIC_EVIDENCE_PERSISTENCE_UNCONFIRMED/);
    else path === 'finishAutomatic' ? c.finishAutomatic(input.taskId, 'stopped', 'AUTOMATIC_VALIDATION_FAILED') : c.persistenceAttention(input.taskId);
    assert.equal(statusLedger(second.db), committed);
    assert.equal(c.persistenceFailures.has(input.taskId), true);
    const view = await c.get(input.taskId); assert.equal(view.automatic.status, 'uncertain'); assert.equal(view.automatic.human_attention_required, true);
    assert.equal(c.automaticJobs.size + c.localRuns.size + c.validationRuns.size, 0);
  } finally { interruptProgressController(second); }
});


for (const boundary of ['implementation', 'validation', 'review'])
test(`safe restart classification preserves concurrent SQLite completion at ${boundary}`, async t => {
  const { c, root } = await setup(t), task = progressTask(c), id = task.id;
  if (boundary === 'implementation') { task.implementer.state = 'running'; task.implementer.local.result_received = false; }
  if (boundary === 'validation') task.local_validation.status = 'running';
  if (boundary === 'review') task.reviewer.state = 'running';
  c.save(task); interruptProgressController(c);
  const second = new Controller({ executor: new FakeExecutor() }); second.db = new DatabaseSync(`${root}/state/controller.sqlite`);
  const next = new Controller({ stateRoot: `${root}/state`, workspaceRoot: `${root}/work`, executor: new FakeExecutor(),
    localBackendFactory() { assert.fail('Restart model replay'); }, localValidationFactory() { assert.fail('Restart validation replay'); } });
  // Let normal startup reconcile first; interleave only when it next tries
  // to classify the interrupted execution using a stale persisted predecessor.
  const save = next.save.bind(next); let committed, interleaved = false;
  next.save = (value, options) => {
    const classified = boundary === 'implementation' ? value.implementer.state === 'needs_attention' :
      boundary === 'validation' ? value.local_validation.status === 'uncertain' : value.reviewer.state === 'needs_attention';
    if (!interleaved && classified) {
      interleaved = true;
      const current = second.task(id);
      current.implementer = progressTask(second).implementer;
      current.reviewer.state = 'completed'; current.local_validation.status = 'completed';
      current.automatic.status = 'stopped'; current.automatic.reason = 'AUTOMATIC_VALIDATION_FAILED';
      second.save(current); committed = statusLedger(second.db);
    }
    return save(value, options);
  };
  try {
    await next.init();
    assert.equal(interleaved, true);
    assert.equal(statusLedger(second.db), committed);
    assert.equal(next.persistenceFailures.has(id), true);
    const before = statusLedger(next.db), view = await next.get(id);
    assert.equal(view.automatic.status, 'uncertain'); assert.equal(view.automatic.progress.resume_authorized, false);
    assert.equal(statusLedger(next.db), before);
    assert.equal(next.automaticJobs.size + next.localRuns.size + next.validationRuns.size, 0);
  } finally { interruptProgressController(next); interruptProgressController(second); }
});

for (const timing of ['before expiry', 'during cancellation', 'during bookkeeping'])
test(`safe restart expiry preserves committed publication ${timing}`, async t => {
  const { c, root } = await setup(t), input = automaticOperationFixture(c), id = input.taskId;
  c.operation(input.id, input.kind, input.payload, id);
  const second = new Controller({ executor: new FakeExecutor() }); second.db = new DatabaseSync(`${root}/state/controller.sqlite`);
  let committed, stops = 0, cleanups = 0;
  const complete = () => {
    // Model the existing recovery transaction, including its atomic operation
    // acknowledgment. Full historical proof is exercised in integration tests.
    const current = second.task(id); current.automatic.status = 'succeeded'; current.automatic.reason = null;
    current.automatic.human_attention_required = false;
    second.save(current, { operation: { id: input.id, status: 'accepted' } }); committed = statusLedger(second.db);
  };
  if (timing === 'before expiry') complete();
  c.stopLocalWithoutStorage = async () => { stops++; if (timing === 'during cancellation') complete(); return { confirmed: true, diagnostics: [] }; };
  const save = c.save.bind(c);
  c.save = (value, options) => { if (timing === 'during bookkeeping' && value.automatic.expiry_stop) complete(); return save(value, options); };
  c.cleanup = async () => { cleanups++; };
  try {
    await c.expireAutomatic(id);
    assert.equal(statusLedger(second.db), committed);
    assert.equal(stops, timing === 'before expiry' ? 0 : 1); assert.equal(cleanups, 0);
    assert.equal(second.task(id).automatic.status, 'succeeded');
    assert.equal(second.task(id).deadline, input.task.deadline);
    assert.equal(second.db.prepare('SELECT status FROM operations WHERE id=?').get(input.id).status, 'accepted');
  } finally { interruptProgressController(second); }
});


for (const fault of ['read failure', 'unproven success', 'prior latch', 'unresolved transaction'])
test(`safe restart expiry still cancels owned resources with ${fault}`, async t => {
  const { c } = await setup(t), input = automaticOperationFixture(c), id = input.taskId;
  c.operation(input.id, input.kind, input.payload, id);
  c.finishAutomatic(id, 'succeeded', null);
  if (fault === 'unproven success') c.db.prepare('DELETE FROM automatic_attempts WHERE task_id=?').run(id);
  if (fault === 'prior latch') c.persistenceFailures.add(id);
  if (fault === 'unresolved transaction') c.transactionUnresolved = true;
  const read = c.task.bind(c);
  if (fault === 'read failure') c.task = () => { throw Error('Synthetic storage unavailable'); };
  let stops = 0;
  c.stopLocalWithoutStorage = async () => { stops++; return { confirmed: true, diagnostics: [] }; };
  try {
    await c.expireAutomatic(id);
    assert.equal(stops, 1); assert.equal(c.persistenceFailures.has(id), true);
    assert.equal(read(id).automatic.status, 'succeeded');
    assert.equal(read(id).cleanup, undefined);
  } finally { c.task = read; c.transactionUnresolved = false; }
});
