import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalEvidence, observeLocalEvidence, localTestCorrelation, localEvidencePacket, budgetLocalPacket,
  LOCAL_EVIDENCE_VERSION, LOCAL_RECORD_BYTES, LOCAL_OUTPUT_LIMIT } from '../local-evidence.mjs';
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

test('moderate native activity retains essential command and file records despite large optional output', () => {
  const ledger = createLocalEvidence('task');
  for (let index = 0; index < 13; index++) {
    const item = { ...command, id: `command-${index}`, command: `printf fixture-${index}`, aggregatedOutput: null };
    started(ledger, item);
    observe(ledger, notification({ ...item, aggregatedOutput: 'x'.repeat(16000) }));
  }
  const file = { id: 'change', type: 'fileChange', status: 'completed', changes: [{ path: '/task/doc.md', kind: { type: 'add' }, diff: '+documentation\n' }] };
  started(ledger, file); observe(ledger, notification(file));
  assert.equal(ledger.omitted_events, 0); assert.equal(ledger.rejected_events, 0);
  assert.equal(ledger.commands.length, 13); assert.equal(ledger.file_changes.length, 1);
  assert.equal(ledger.record_bytes, Buffer.byteLength(JSON.stringify([...ledger.commands, ...ledger.file_changes])));
  assert(Buffer.byteLength(JSON.stringify([...ledger.commands, ...ledger.file_changes])) <= LOCAL_RECORD_BYTES);
  for (const [index, record] of ledger.commands.entries()) {
    assert.equal(record.command.value, `printf fixture-${index}`); assert.equal(record.cwd.value, '/task');
    assert(record.start_observed && record.completion_observed); assert.equal(record.exit_code, 0);
    assert.equal(record.start_completion_conflict, false); assert.deepEqual(record.missing, []);
    assert.equal(record.output.value.length, LOCAL_OUTPUT_LIMIT); assert.equal(record.output.truncated, true);
    assert.equal(record.output.completeness, 'unverified'); assert.equal(record.output.source_truncated, null);
  }
});

test('essential evidence overflow and prohibited indications are not discarded to obtain complete coverage', () => {
  const ledger = createLocalEvidence('task');
  for (let index = 0; index < 532; index++) {
    const item = { ...command, id: `required-${index}`, command: 'git push ' + 'x'.repeat(1700), aggregatedOutput: null };
    started(ledger, item); observe(ledger, notification(item));
  }
  assert(ledger.omitted_events > 0);
  assert(ledger.commands.every(record => record.command.value.startsWith('git push ')));
  assert(Buffer.byteLength(JSON.stringify([...ledger.commands, ...ledger.file_changes])) <= LOCAL_RECORD_BYTES);
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

test('optional output absence, null, explicit empty, nonempty and malformed values remain distinct', () => {
  for (const [availability, output] of [['absent', undefined], ['null', null], ['empty', ''], ['present', 'ok'], ['malformed', {}]]) {
    const ledger = createLocalEvidence('task'); started(ledger, { ...command, aggregatedOutput: null });
    observe(ledger, notification({ ...command, aggregatedOutput: output }));
    const record = ledger.commands[0];
    assert.equal(record.output.availability, availability);
    assert.equal(record.output.value, typeof output === 'string' ? output : null);
    assert.equal(record.output.missing, typeof output !== 'string');
    assert.equal(record.missing.includes('output_format'), availability === 'malformed');
    assert.equal(record.start_completion_conflict, false);
  }
});

test('malformed starts and conflicting output cannot be concealed by optional completion output', () => {
  for (const [initial, final] of [
    [{ ...command, status: 'completed' }, command],
    [{ ...command, aggregatedOutput: {} }, command],
    [{ ...command, aggregatedOutput: 'prefix' }, { ...command, aggregatedOutput: null }],
    [{ ...command, aggregatedOutput: 'prefix' }, { ...command, aggregatedOutput: 'different' }],
  ]) {
    const ledger = createLocalEvidence('task');
    observe(ledger, notification(initial, 'item/started')); observe(ledger, notification(final));
    assert.equal(ledger.commands[0].start_completion_conflict, true);
    assert(ledger.commands[0].start_fields);
  }
});

for (const suffix of ['', '\nmore', 'different']) test(`long optional output comparison distinguishes ${suffix || 'identical'} output`, () => {
  const ledger = createLocalEvidence('task'), output = 'x'.repeat(4096);
  started(ledger, { ...command, aggregatedOutput: output });
  observe(ledger, notification({ ...command, aggregatedOutput: suffix === 'different' ? 'x'.repeat(4095) + 'y' : output + suffix }));
  const record = ledger.commands[0];
  assert.equal(record.start_completion_conflict, suffix === 'different');
  assert(record.output.truncated); assert.equal(record.output.value.length, LOCAL_OUTPUT_LIMIT);
  assert.equal(record.output.completeness, 'unverified'); assert.equal(record.output.source_truncated, null);
});

test('output comparison rejects missing, shortened, redacted, malformed and legacy-unverifiable long starts', () => {
  const text = 'x'.repeat(4096);
  for (const final of [null, {}, text.slice(0, -1), 'token=private' + text]) {
    const ledger = createLocalEvidence('task'); started(ledger, { ...command, aggregatedOutput: text });
    observe(ledger, notification({ ...command, aggregatedOutput: final }));
    assert.equal(ledger.commands[0].start_completion_conflict, true);
  }
  for (const mutate of [record => delete record.output.comparison, record => record.output.comparison.characters = -1,
    record => record.output.comparison.sha256 = 'invalid', record => record.output.comparison.encoding = 'unknown']) {
    const ledger = createLocalEvidence('task'); started(ledger, { ...command, aggregatedOutput: text });
    mutate(ledger.commands[0]); observe(ledger, notification({ ...command, aggregatedOutput: text }));
    assert.equal(ledger.commands[0].start_completion_conflict, true);
  }
});

test('comparison hashes distinguish escaped lone surrogates beyond the retained output prefix', () => {
  const ledger = createLocalEvidence('task'), prefix = 'x'.repeat(4096);
  started(ledger, { ...command, aggregatedOutput: prefix + '\ud800' });
  observe(ledger, notification({ ...command, aggregatedOutput: prefix + '\ud801' }));
  assert.equal(ledger.commands[0].start_completion_conflict, true);
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

test('a conflicting file-change completion retains the original prohibited-path indication', () => {
  const ledger = createLocalEvidence('task');
  const item = { id: 'file', type: 'fileChange', status: 'completed', changes: [{ path: '/task/TASK.md', kind: { type: 'update' }, diff: '+bad' }] };
  started(ledger, item);
  observe(ledger, notification({ ...item, changes: [{ ...item.changes[0], path: '/task/allowed.txt' }] }));
  assert.equal(ledger.file_changes[0].start_completion_conflict, true);
  assert.equal(ledger.file_changes[0].start_changes[0].path.value, '/task/TASK.md');
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

// These workloads come from the acceptance requirement, independently of the
// implementation constants: 512 records, a 513th record, and 4,194,304 bytes.
const recordBytes = ledger => Buffer.byteLength(JSON.stringify([...ledger.commands, ...ledger.file_changes]));
function assertMeter(ledger) { assert.equal(ledger.record_bytes, recordBytes(ledger)); }

test('512 distinct records survive start/completion replacement; the fixed 513th is omitted', () => {
  const ledger = createLocalEvidence('task');
  const items = Array.from({ length: 512 }, (_, index) => ({ ...command, id: `normal-${index}`,
    command: `python3 -B check.py --case=${index}`, aggregatedOutput: undefined }));
  for (const item of items) { started(ledger, item); assertMeter(ledger); }
  // Complete in reverse order, at the count limit, so replacements cannot be
  // mistaken for appends or depend on the record being last.
  for (const item of [...items].reverse()) {
    observe(ledger, notification({ ...item, aggregatedOutput: '検証🙂\n'.repeat(80) })); assertMeter(ledger);
  }
  assert.equal(ledger.commands.length, 512);
  assert.deepEqual(ledger.commands.map(record => record.item_id), items.map(item => item.id));
  assert(ledger.commands.every(record => record.start_observed && record.completion_observed && record.exit_code === 0));
  assert.equal(ledger.omitted_events, 0); assert.equal(ledger.rejected_events, 0);
  const before = JSON.stringify(ledger.commands), bytes = ledger.record_bytes;
  started(ledger, { ...command, id: 'record-513' });
  observe(ledger, notification({ ...command, id: 'record-513' }));
  assert.equal(ledger.omitted_events, 2); assert.equal(ledger.rejected_events, 0);
  assert.equal(JSON.stringify(ledger.commands), before); assert.equal(ledger.record_bytes, bytes); assertMeter(ledger);
});

// Construct a fixed-size, valid notification workload using per-field UTF-8
// content, never by assigning the meter or padding retained records afterward.
// A pending command leaves room for each file's larger start representation;
// its completion consumes that room and lands exactly on the required ceiling.
function exactByteWorkload() {
  const ledger = createLocalEvidence('task');
  const final = { ...command, id: 'boundary-command', aggregatedOutput: '検'.repeat(128) };
  const probe = createLocalEvidence('task');
  started(probe, { ...final, aggregatedOutput: undefined }); observe(probe, notification(final));
  const files = Array.from({ length: 96 }, (_, index) => ({ id: `file-${index}`, type: 'fileChange', status: 'completed',
    changes: Array.from({ length: 16 }, (_, part) => ({ path: `/task/source-${index}-${part}.mjs`,
      kind: { type: 'update' }, diff: '+' })) }));
  let baseline = recordBytes(probe) + files.length; // one comma per added record
  for (const item of files) {
    const single = createLocalEvidence('task'); started(single, item); observe(single, notification(item));
    baseline += recordBytes(single) - 2;
  }
  let remaining = 4_194_304 - baseline;
  assert(remaining > 1_048_576, 'the fixed workload must exceed the old 1 MiB ceiling');
  for (const item of files) for (const change of item.changes) {
    const characters = Math.min(1023, Math.floor(remaining / 3));
    change.diff += '検'.repeat(characters); remaining -= characters * 3;
    const ascii = Math.min(1024 - change.diff.length, remaining);
    change.diff += 'x'.repeat(ascii); remaining -= ascii;
  }
  assert.equal(remaining, 0, 'the accepted per-field bounds must represent the exact target');
  started(ledger, { ...final, aggregatedOutput: undefined }); assertMeter(ledger);
  for (const item of files) {
    started(ledger, item); assertMeter(ledger);
    observe(ledger, notification(item)); assertMeter(ledger);
  }
  assert.equal(ledger.file_changes.length, 96);
  assert.equal(ledger.commands.length, 1);
  assert.equal(ledger.omitted_events, 0); assert.equal(ledger.rejected_events, 0);
  return { ledger, final };
}

test('exact 4,194,304-byte UTF-8 retention accepts completion and rejects the next event', () => {
  const { ledger, final } = exactByteWorkload();
  observe(ledger, notification(final)); assertMeter(ledger);
  assert.equal(recordBytes(ledger), 4_194_304);
  assert.equal(ledger.omitted_events, 0); assert.equal(ledger.rejected_events, 0);
  assert(ledger.commands[0].completion_observed);
  assert(ledger.file_changes.every(record => record.start_observed && record.completion_observed && !record.start_completion_conflict));
  assert.equal(new Set(ledger.file_changes.map(record => record.item_id)).size, 96);
  const before = JSON.stringify([...ledger.commands, ...ledger.file_changes]);
  observe(ledger, notification({ ...command, id: 'beyond-byte-budget' }));
  assert.equal(ledger.omitted_events, 1); assert.equal(ledger.rejected_events, 0);
  assert.equal(JSON.stringify([...ledger.commands, ...ledger.file_changes]), before); assertMeter(ledger);
  assert.equal(ledger.record_bytes, 4_194_304);
});

test('genuine byte overflow cannot fabricate completion or results for a retained start', () => {
  const { ledger, final } = exactByteWorkload();
  const before = structuredClone(ledger.commands[0]), bytes = ledger.record_bytes;
  observe(ledger, notification({ ...final, aggregatedOutput: '検'.repeat(256) }));
  assert.equal(ledger.omitted_events, 1); assert.equal(ledger.rejected_events, 0);
  assert.deepEqual(ledger.commands[0], before); assert.equal(ledger.record_bytes, bytes); assertMeter(ledger);
  assert(ledger.commands[0].missing.includes('completion'));
  assert.equal(ledger.commands[0].exit_code, null); assert.equal(ledger.commands[0].completion_observed, false);
  // A later fitting event does not erase the earlier coverage failure.
  observe(ledger, notification(final)); assertMeter(ledger);
  assert.equal(ledger.record_bytes, 4_194_304); assert.equal(ledger.omitted_events, 1);
});

test('legacy meter fallback accounts for interleaved UTF-8 records and rejected events', () => {
  const ledger = createLocalEvidence('task');
  started(ledger, { ...command, aggregatedOutput: undefined });
  const file = { id: 'unicode-file', type: 'fileChange', status: 'completed',
    changes: [{ path: '/task/検証.txt', kind: { type: 'update' }, diff: '+café🙂\n' }] };
  started(ledger, file); delete ledger.record_bytes;
  observe(ledger, notification({ ...command, aggregatedOutput: 'café🙂\n' })); assertMeter(ledger);
  delete ledger.record_bytes; observe(ledger, notification(file)); assertMeter(ledger);
  const before = JSON.stringify([...ledger.commands, ...ledger.file_changes]), bytes = ledger.record_bytes;
  for (const event of [notification(), notification(command, 'item/completed', { threadId: 'foreign' }),
    notification({ ...file, id: command.id }), notification({ ...command, id: null })]) {
    observe(ledger, event); assertMeter(ledger);
  }
  assert.equal(ledger.rejected_events, 4); assert.equal(ledger.omitted_events, 0);
  assert.equal(JSON.stringify([...ledger.commands, ...ledger.file_changes]), before); assert.equal(ledger.record_bytes, bytes);
});

for (const state of ['completed', 'interrupted', 'uncertain', 'failed']) test(`packet preserves ${state} execution and excludes model prose and human responses`, () => {
  const task = { id: 'task', implementer: { local: { ...identity, execution_state: state, latest_model_output: 'I independently verified PASS', human_requests: [{ response: 'private' }], terminal_observed: state !== 'uncertain' } } };
  const packet = localEvidencePacket(task, ['python3 check.py'], '/task');
  assert.equal(packet.evidence_version, LOCAL_EVIDENCE_VERSION); assert.equal(packet.execution.state, state);
  assert.equal(packet.native_activity.status, 'unavailable'); assert.equal(packet.independent_validation.status, 'unavailable');
  assert.equal(packet.required_test_correlation.tests[0].status, 'unmatched'); assert.equal(packet.gates.local_review, 'bounded_evidence_qualification');
  assert(!JSON.stringify(packet).includes('I independently verified')); assert(!JSON.stringify(packet).includes('private'));
});

test('model/reasoning and output-delta events cannot become trusted records', () => {
  const ledger = createLocalEvidence('task');
  for (const item of [{ id: 'message', type: 'agentMessage', text: 'PASS' }, { id: 'reason', type: 'reasoning', text: 'secret' }]) assert.equal(observe(ledger, notification(item)), false);
  assert.equal(observe(ledger, { method: 'item/commandExecution/outputDelta', params: { delta: 'ignored partial output' } }), false);
  assert.deepEqual(ledger.commands, []); assert.deepEqual(ledger.file_changes, []);
});

test('local packet retains large Unicode evidence without changing version or omitting sections', () => {
  const input = { evidence_version: LOCAL_EVIDENCE_VERSION, current: { 'a.txt': 'ok' } };
  const packet = budgetLocalPacket(input);
  assert.equal(packet.bytes, Buffer.byteLength(packet.text)); assert(packet.bytes <= PACKET_LIMIT);
  assert.deepEqual(JSON.parse(packet.text).current, input.current);
  assert.equal(JSON.parse(packet.text).evidence_version, LOCAL_EVIDENCE_VERSION);
  const unicode = '🙂'.repeat(40000);
  const expanded = budgetLocalPacket({ ...input, current: { 'a.txt': unicode } });
  assert.equal(JSON.parse(expanded.text).current['a.txt'], unicode);
  assert(expanded.bytes > 128 * 1024 && expanded.bytes < PACKET_LIMIT);
});
