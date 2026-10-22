import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, constants as sqlite } from 'node:sqlite';
import { Controller, safeRelative, redact, digest } from '../controller.mjs';
import { authorizePersonalTunnel, createServer } from '../server.mjs';
import { FakeAPI, FakeExecutor, contract } from './helpers.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { repoGit, repositoryIdentity } from '../repositories.mjs';

async function setup(t) {
  const root = await fs.mkdtemp('/var/tmp/personal-agents-bridge/unit-');
  const api = new FakeAPI(), executor = new FakeExecutor();
  const c = await new Controller({ stateRoot: path.join(root, 'state'), workspaceRoot: path.join(root, 'work'), api, executor, secrets: ['test-sensitive-value'], timeoutMs: 600000 }).init();
  t.after(async () => { await c.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { c, api, executor, root };
}
async function started(c) { const x = await c.start({ contract: contract(), request_id: 'request_start' }); await Promise.all([...c.jobs.values()]); return await c.get(x.task_id); }

const attemptRows = (c, id) => c.db.prepare('SELECT * FROM automatic_attempts WHERE task_id=? ORDER BY rowid').all(id);
async function automaticAttempt(t, mode = {}) {
  const value = await setup(t), { c, root } = value, normal = path.join(root, 'normal'), calls = [];
  let active;
  const reviewerActive = new Promise(resolve => active = resolve), stops = [];
  await fs.mkdir(normal); repoGit(normal, 'init', '--initial-branch=main');
  await fs.writeFile(path.join(normal, 'greeting.txt'), 'baseline\n'); repoGit(normal, 'add', '.');
  repoGit(normal, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'baseline');
  await fs.writeFile(path.join(c.stateRoot, 'repositories.json'), JSON.stringify({ version: 1, repositories: { fixture: await repositoryIdentity(normal) } }), { mode: 0o600 });
  c.publisher = { async target() { throw Error('Publication forbidden for failed review'); } };
  c.localBackendFactory = options => {
    let stopped;
    const wait = new Promise(resolve => stopped = resolve);
    return {
    async run() {
      calls.push(options.reviewOnly ? 'reviewer' : 'implementer');
      const identity = { model: 'fixture-model', threadId: options.reviewOnly ? 'review-thread' : 'implement-thread', turnId: 'fixture-turn',
        turnSubmissionAttempted: true, turnSubmissionAcknowledged: true, terminalObserved: true };
      options.onLifecycle({ ...identity, terminalObserved: false, phase: 'turn_acknowledged' });
      if (options.reviewOnly && mode.activeReviewer) {
        active(); await wait;
        return { ...identity, terminalObserved: false, status: 'uncertain', authentication: 'chatgpt', uncertainties: ['INTERRUPTION_UNCONFIRMED'], messages: [] };
      }
      if (!options.reviewOnly) await fs.writeFile(path.join(options.cwd, 'greeting.txt'), 'candidate\n');
      options.onLifecycle({ ...identity, phase: 'terminal_observed', status: 'completed' });
      const findings = ['R1', 'R2', 'I1', 'SCOPE', 'TEST_EVIDENCE'].map(id => ({ id, status: id === 'R1' ? 'FAIL' : 'PASS',
        evidence: id === 'R1' ? 'greeting.txt contains candidate; replace it with the required greeting.' : 'Synthetic complete evidence assessment.' }));
      return { ...identity, status: 'completed', authentication: 'chatgpt', uncertainties: options.reviewOnly && mode.uncertain ? ['Unknown execution'] : [],
        messages: options.reviewOnly ? [{ provenance: 'model', text: mode.incomplete ? '{"overall":"FAIL","findings":[]}' : JSON.stringify({ overall: 'FAIL', findings }) }] : [] };
    }, async close() { if (options.reviewOnly && mode.activeReviewer) { stops.push('close'); stopped(); return mode.closeResult ?? true; } return true; },
    async cancel() { if (options.reviewOnly && mode.activeReviewer) { stops.push('cancel'); return mode.cancelResult ?? true; } },
  }; };
  if (mode.validationFailure) c.localValidationFactory = () => ({ terminationConfirmed: true, async run() { throw Error('Synthetic validator failure'); }, cancel() {} });
  const input = { repository_id: 'fixture', execution_backend: 'local_codex', request_id: 'automatic_evidence', contract: contract(),
    automatic: { publish: { title: 'Fixture', draft: true }, max_duration_seconds: 120, max_codex_turns: 2, max_corrections: 0 } };
  if (mode.validationFailure) input.contract.test_commands = ['true'];
  mode.configure?.(c);
  const result = await c.start(input);
  if (mode.activeReviewer) await reviewerActive;
  else { await Promise.all([...c.jobs.values()]); await Promise.all([...c.automaticJobs.values()]); }
  return { ...value, id: result.task_id, calls, stops, input, normal };
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

test('restart cannot fabricate a completed review whose receipt never became durable', async t => {
  const value = await automaticAttempt(t, { configure: c => sqliteAbort(c, 'tasks', "json_extract(NEW.value,'$.reviewer.pending_review_result.sha256') IS NOT NULL") });
  const { id } = value;
  assert(value.c.pendingReviewResults.has(id)); assert.equal(value.c.task(id).reviewer.pending_review_result, undefined);
  const c = await restartEvidenceController(t, value);
  const reconciled = await c.cleanup({ task_id: id, delete_workspace: false });
  assert.match(reconciled.cleanup.cleanup_diagnostic, /AUTOMATIC_REVIEW_RESULT_NOT_DURABLY_RECEIVED/);
  assert.equal((await c.cleanup({ task_id: id, delete_workspace: true })).cleanup.workspace_deleted, false);
  assert(!attemptRows(c, id).some(row => JSON.parse(row.value).review_result));
  assert.equal(c.automaticJobs.size, 0);
});

test('SQLite failure while verifying completed review evidence stays unresolved across restart', async t => {
  let fault;
  const value = await automaticAttempt(t, { configure(c) {
    fault = sqliteAbort(c, 'tasks', "json_extract(NEW.value,'$.reviewer.local.phase')='validating' AND json_extract(NEW.value,'$.reviewer.local.server_closed')=1");
    fault.skip = 1; // Allow closure persistence, then abort packet verification's task write.
  } });
  const { id } = value;
  assert.equal(fault.hits, 1); assert.equal(value.c.task(id).reviewer.evidence_retention.review, 'awaiting_receipt');
  const c = await restartEvidenceController(t, value);
  const result = await c.cleanup({ task_id: id, delete_workspace: false });
  assert.match(result.cleanup.cleanup_diagnostic, /AUTOMATIC_REVIEW_RESULT_NOT_DURABLY_RECEIVED/);
  assert.equal((await c.cleanup({ task_id: id, delete_workspace: true })).cleanup.workspace_deleted, false);
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
  assert.deepEqual(observations.map(item => item.kind), ['review_packet', 'review_result', 'outcome']);
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
test('MCP advertises exactly eight tools; schema/authorization failures cannot execute', async t => {
  const { c, api } = await setup(t); let allowed = false;
  const server = createServer(c, async () => { if (!allowed) throw Error('private'); });
  const client = new Client({ name: 'local-test', version: '1' }); const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  const list = await client.listTools(); assert.deepEqual(list.tools.map(x => x.name).sort(), ['cleanup_task', 'continue_task', 'get_task', 'list_registered_repositories', 'publish_task', 'register_github_repository', 'review_task', 'start_task']);
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
