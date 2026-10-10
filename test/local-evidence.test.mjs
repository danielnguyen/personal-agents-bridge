import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalEvidence, observeLocalEvidence, localTestCorrelation, localEvidencePacket, budgetLocalPacket,
  LOCAL_EVIDENCE_VERSION, LOCAL_RECORD_BYTES, LOCAL_RECORD_LIMIT } from '../local-evidence.mjs';
import { PACKET_LIMIT } from '../packet-budget.mjs';
import { Controller } from '../controller.mjs';

const identity = { thread_id: 'thread', turn_id: 'turn' };
const bound = Controller.prototype.bounded.bind({ safe: value => value });
const command = { id: 'cmd', type: 'commandExecution', command: 'python3 check.py', cwd: '/task', status: 'completed', exitCode: 0, aggregatedOutput: 'ok\n' };
const notification = (item = command, method = 'item/completed', params = {}) => ({ method, params: { threadId: 'thread', turnId: 'turn', item, ...params } });
const observe = (ledger, event) => observeLocalEvidence(ledger, event, identity, bound);
function started(ledger, item = command) { observe(ledger, notification({ ...item, status: 'inProgress' }, 'item/started')); }

test('completed native commands retain exact provenance and results, never an independent PASS', () => {
  const ledger = createLocalEvidence('task'); started(ledger); observe(ledger, notification());
  const record = ledger.commands[0];
  assert.equal(record.task_id, 'task'); assert.equal(record.thread_id, 'thread'); assert.equal(record.turn_id, 'turn');
  assert.equal(record.provenance, 'codex_app_server_notification'); assert.equal(record.item_id, 'cmd');
  assert.equal(record.command.value, command.command); assert.equal(record.cwd.value, '/task');
  assert.equal(record.exit_code, 0); assert.equal(record.output.value, 'ok\n'); assert.deepEqual(record.missing, []);
  assert.equal(record.output.source_truncated, null);
  assert.equal(record.output.completeness, 'unverified'); assert.equal(ledger.exhaustive, false);
  const correlation = localTestCorrelation(ledger, [command.command], '/task');
  assert.equal(correlation.independently_verified, false); assert.deepEqual(correlation.tests[0].item_ids, ['cmd']);
  assert(!JSON.stringify(correlation).includes('passed'));
});

for (const [label, prepare, field] of [
  ['missing start', ledger => observe(ledger, notification()), 'start'],
  ['missing completion', ledger => started(ledger), 'completion'],
  ['missing exit code', ledger => { started(ledger); observe(ledger, notification({ ...command, exitCode: null })); }, 'exit_code'],
  ['missing output', ledger => { started(ledger); observe(ledger, notification({ ...command, aggregatedOutput: null })); }, 'output'],
  ['missing status', ledger => { started(ledger); observe(ledger, notification({ ...command, status: null })); }, 'status'],
]) test(label + ' is explicit, not replaced by a success assertion', () => {
  const ledger = createLocalEvidence('task'); prepare(ledger);
  assert(ledger.commands[0].missing.includes(field)); assert.equal(ledger.commands[0].output.completeness, 'unverified');
});

test('bounded/redacted output and source truncation stay distinguishable from missing output', () => {
  const ledger = createLocalEvidence('task'); started(ledger);
  observe(ledger, notification({ ...command, aggregatedOutput: 'token=private https://private.invalid ' + '🙂'.repeat(3000), outputTruncated: true }));
  const output = ledger.commands[0].output;
  assert.equal(output.truncated, true); assert.equal(output.redacted, true); assert.equal(output.source_truncated, true);
  assert.equal(output.missing, false); assert(output.value.length <= 2048);
  assert(!JSON.stringify(ledger).includes('private.invalid')); assert(!JSON.stringify(ledger).includes('token=private'));
});

test('native file-change claims are separate from command observations and actual file bytes', () => {
  const ledger = createLocalEvidence('task');
  const item = { id: 'file', type: 'fileChange', status: 'completed', changes: [
    { path: '/task/answer.txt', kind: { type: 'update', move_path: null }, diff: '+42\n' },
  ] };
  started(ledger, item); observe(ledger, notification(item));
  assert.equal(ledger.commands.length, 0); assert.equal(ledger.file_changes.length, 1);
  const record = ledger.file_changes[0];
  assert.equal(record.provenance, 'codex_app_server_notification'); assert.equal(record.changes[0].diff.value, '+42\n');
  assert.deepEqual(record.missing, []); assert.equal(record.changes[0].kind, 'update');
  assert.equal(record.changes[0].path.value, '/task/answer.txt');
});

test('malformed, omitted and oversized file-change fields are explicit', () => {
  const ledger = createLocalEvidence('task');
  observe(ledger, notification({ id: 'file', type: 'fileChange', changes: [null, ...Array.from({ length: 20 }, () => ({ path: 'a', kind: { type: 'add' }, diff: 'x'.repeat(4000) }))] }));
  const record = ledger.file_changes[0];
  assert(record.missing.includes('start')); assert(record.missing.includes('change_fields')); assert(record.missing.includes('status'));
  assert.equal(record.changes_omitted, 5); assert(record.changes[1].diff.truncated);
  observe(ledger, notification({ id: 'empty', type: 'fileChange', status: 'completed' }));
  assert(ledger.file_changes[1].missing.includes('changes'));
});

test('correlation uses exact commands and cwd, not substrings, shell inference, redacted or conflicting fields', () => {
  const ledger = createLocalEvidence('task'); started(ledger); observe(ledger, notification());
  assert.equal(localTestCorrelation(ledger, ['check.py', 'python3 absent.py'], '/task').tests.every(item => item.status === 'unmatched'), true);
  assert.equal(localTestCorrelation(ledger, [command.command], '/other').tests[0].status, 'unmatched');
  ledger.commands[0].command.redacted = true;
  assert.equal(localTestCorrelation(ledger, [command.command], '/task').tests[0].status, 'unmatched');
  const conflict = createLocalEvidence('task'); started(conflict, { ...command, command: 'different' }); observe(conflict, notification());
  assert(conflict.commands[0].start_completion_conflict);
  assert.equal(conflict.commands[0].start_fields.command.value, 'different');
  assert.equal(localTestCorrelation(conflict, [command.command], '/task').tests[0].status, 'unmatched');
});

test('duplicate, out-of-order, cross-thread/turn and invalid identity notifications leave a coverage gap', () => {
  const ledger = createLocalEvidence('task'); started(ledger); started(ledger); observe(ledger, notification());
  observe(ledger, notification()); started(ledger);
  observe(ledger, notification({ ...command, id: 'other' }, 'item/completed', { threadId: 'other-thread' }));
  observe(ledger, notification({ ...command, id: 'other' }, 'item/completed', { turnId: null }));
  observe(ledger, notification({ ...command, id: null }));
  observe(ledger, notification({ id: 'cmd', type: 'fileChange' }));
  assert.equal(ledger.rejected_events, 7); assert.equal(ledger.commands.length, 1); assert.equal(ledger.file_changes.length, 0);
});

test('record and UTF-8 byte limits retain explicit omission counters', () => {
  const ledger = createLocalEvidence('task');
  for (let index = 0; index < 100; index++) observe(ledger, notification({ ...command, id: `cmd-${index}`, aggregatedOutput: '🙂'.repeat(2000) }));
  assert(ledger.omitted_events > 0); assert(ledger.commands.length <= LOCAL_RECORD_LIMIT);
  assert(Buffer.byteLength(JSON.stringify([...ledger.commands, ...ledger.file_changes])) <= LOCAL_RECORD_BYTES);
  const small = createLocalEvidence('task');
  for (let index = 0; index < 100; index++) observe(small, notification({ id: `file-${index}`, type: 'fileChange' }));
  assert(small.file_changes.length <= LOCAL_RECORD_LIMIT); assert(small.omitted_events > 0);
});

test('an omitted completion never fabricates results for the retained start', () => {
  const ledger = createLocalEvidence('task'); started(ledger);
  for (let index = 0; index < 100; index++) observe(ledger, notification({ ...command, id: `cmd-${index}`, aggregatedOutput: 'x'.repeat(2048) }));
  observe(ledger, notification({ ...command, command: 'x'.repeat(2048), cwd: 'x'.repeat(1024), aggregatedOutput: '🙂'.repeat(2000) }));
  assert(ledger.commands[0].missing.includes('completion')); assert.equal(ledger.commands[0].exit_code, null);
  assert(ledger.omitted_events > 0);
});

for (const state of ['completed', 'interrupted', 'uncertain', 'failed']) test(`packet preserves ${state} execution and excludes model prose and human responses`, () => {
  const task = { id: 'task', implementer: { local: { ...identity, execution_state: state, latest_model_output: 'I independently verified PASS', human_requests: [{ response: 'private' }], terminal_observed: state !== 'uncertain' } } };
  const packet = localEvidencePacket(task, ['python3 check.py'], '/task');
  assert.equal(packet.evidence_version, LOCAL_EVIDENCE_VERSION); assert.equal(packet.execution.state, state);
  assert.equal(packet.native_activity.status, 'unavailable'); assert.equal(packet.independent_validation.status, 'unavailable');
  assert.equal(packet.required_test_correlation.tests[0].status, 'unmatched'); assert.equal(packet.gates.local_review, 'analysis_only');
  assert(!JSON.stringify(packet).includes('I independently verified')); assert(!JSON.stringify(packet).includes('private'));
});

test('model/reasoning and output-delta events cannot become trusted records', () => {
  const ledger = createLocalEvidence('task');
  for (const item of [{ id: 'message', type: 'agentMessage', text: 'PASS' }, { id: 'reason', type: 'reasoning', text: 'secret' }]) assert.equal(observe(ledger, notification(item)), false);
  assert.equal(observe(ledger, { method: 'item/commandExecution/outputDelta', params: { delta: 'ignored partial output' } }), false);
  assert.deepEqual(ledger.commands, []); assert.deepEqual(ledger.file_changes, []);
});

test('local packet uses shared byte limit without changing version or silently removing required sections', () => {
  const input = { evidence_version: LOCAL_EVIDENCE_VERSION, current: { 'a.txt': 'ok' } };
  const packet = budgetLocalPacket(input);
  assert.equal(packet.bytes, Buffer.byteLength(packet.text)); assert(packet.bytes <= PACKET_LIMIT);
  assert.deepEqual(JSON.parse(packet.text).current, input.current);
  assert.equal(JSON.parse(packet.text).evidence_version, LOCAL_EVIDENCE_VERSION);
  assert.throws(() => budgetLocalPacket({ ...input, current: { 'a.txt': '🙂'.repeat(PACKET_LIMIT) } }), error =>
    error.code === 'EVIDENCE_SIZE_LIMIT' && error.diagnostic.limit_bytes === PACKET_LIMIT && error.diagnostic.required_section === 'local_packet');
});
