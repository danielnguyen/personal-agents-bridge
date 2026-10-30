import test from 'node:test';
import assert from 'node:assert/strict';
import { budgetLocalPacket, reconstructLocalDiff } from '../local-evidence.mjs';
import { localScopeQualification } from '../local-reviewer-instructions.mjs';
import { PACKET_LIMIT } from '../packet-budget.mjs';

const bytes = value => Buffer.byteLength(JSON.stringify(value));
function fixture() {
  const current = { 'answer.js': 'const example = 42;\n'.repeat(1458) };
  current['answer.js'] += 'x'.repeat(53425 - bytes(current));
  const diff = 'diff --git a/answer.js b/answer.js\nnew file mode 100644\n--- /dev/null\n+++ b/answer.js\n@@ -0,0 +1,1459 @@\n' +
    current['answer.js'].split('\n').map(line => '+' + line + '\n').join('') + '\\ No newline at end of file\n';
  const data = { baseline: {}, current, diff, native_activity: { retained: 'n'.repeat(24546) },
    independent_validation: { status: 'completed', provenance: 'controller_process_observation' },
    controller_evidence: '', coverage: { exhaustive_command_history: false } };
  const envelope = { ...data, packet_budget: { limit_bytes: PACKET_LIMIT, policy: 'All sections retained; overflow rejects construction without silent removal.' } };
  data.controller_evidence = 'e'.repeat(157677 - bytes(envelope));
  return data;
}

test('157677-byte C11-shaped synthetic packet fits without losing a single patch byte', context => {
  const data = fixture(), original = structuredClone(data), result = budgetLocalPacket(data), packet = JSON.parse(result.text);
  assert.equal(bytes(data.current), 53425);
  assert.equal(bytes(data.diff), 55012);
  assert.equal(bytes(data.native_activity), 24561);
  assert.equal(bytes({ ...data, packet_budget: { limit_bytes: PACKET_LIMIT, policy: 'All sections retained; overflow rejects construction without silent removal.' } }), 157677);
  assert(result.bytes < PACKET_LIMIT); assert.deepEqual(data, original);
  assert.equal(reconstructLocalDiff(packet), data.diff);
  for (const key of Object.keys(data).filter(key => key !== 'diff')) assert.deepEqual(packet[key], data[key]);
  assert.equal(result.text, budgetLocalPacket(data).text);
  context.diagnostic(`Synthetic C11 envelope: 157677 -> ${result.bytes} bytes; exact patch reconstruction verified.`);
});

for (const ending of ['\n', '', '\r\n']) test(`exact Unicode and final-newline reconstruction ${JSON.stringify(ending)}`, () => {
  const source = '🌱'.repeat(17000) + ending;
  const encodedLine = '+' + source + (ending.endsWith('\n') ? '' : '\n\\ No newline at end of file\n');
  const data = { baseline: {}, current: { 'unicode.txt': source }, diff: 'header\n' + encodedLine };
  const packet = JSON.parse(budgetLocalPacket(data).text);
  assert.equal(reconstructLocalDiff(packet), data.diff);
});

test('complete removed-file references retain headers and mode-only or binary evidence literally', () => {
  const source = 'removed\n'.repeat(9000);
  const headers = 'old mode 100755\nnew mode 100644\nBinary files a/bin and b/bin differ\n';
  const data = { baseline: { 'removed.txt': source }, current: {}, diff: headers + source.split('\n').slice(0, -1).map(line => '-' + line + '\n').join('') };
  const packet = JSON.parse(budgetLocalPacket(data).text);
  assert.equal(reconstructLocalDiff(packet), data.diff);
  assert(packet.diff.fragments.includes(headers));
});

for (const mutation of ['missing', 'binary', 'different']) test(`unprovable ${mutation} content remains literal when the expanded packet fits`, () => {
  const data = fixture();
  if (mutation === 'missing') delete data.current['answer.js'];
  if (mutation === 'binary') data.current['answer.js'] = { encoding: 'binary' };
  if (mutation === 'different') data.current['answer.js'] = 'unrelated';
  data.controller_evidence += 'z'.repeat(60000);
  const packet = JSON.parse(budgetLocalPacket(data).text);
  assert.equal(packet.diff,data.diff);
});

for (const mutation of ['hash', 'reference', 'content', 'length', 'incomplete']) test(`corrupted ${mutation} encoding fails closed`, () => {
  const packet = JSON.parse(budgetLocalPacket(fixture()).text);
  if (mutation === 'hash') packet.diff.sha256 = '0'.repeat(64);
  if (mutation === 'reference') packet.diff.fragments.find(value => typeof value === 'object').file = 'missing';
  if (mutation === 'content') packet.current['answer.js'] += 'tampered';
  if (mutation === 'length') packet.diff.utf8_bytes++;
  if (mutation === 'incomplete') packet.diff.complete = false;
  assert.throws(() => reconstructLocalDiff(packet), { code: 'INVALID_LOCAL_DIFF_ENCODING' });
  const result = localScopeQualification({ allowed_files: [] }, packet);
  assert(result.blockers.includes('SCOPE_DIFF_ENCODING_INVALID'));
});

test('under-budget packets keep the original patch and unreducible required evidence still fails', () => {
  assert.equal(JSON.parse(budgetLocalPacket({ diff: 'original' }).text).diff, 'original');
  const data = fixture(); data.native_activity.retained += 'x'.repeat(PACKET_LIMIT);
  assert.throws(() => budgetLocalPacket(data), { code: 'EVIDENCE_SIZE_LIMIT' });
});

test('CCP-sized multi-megabyte evidence is complete and available without one-prompt embedding', () => {
  const source = 'const boundedSource = "file with evidence";\n'.repeat(180000);
  const diff = 'diff --git a/large.js b/large.js\nnew file mode 100644\n--- /dev/null\n+++ b/large.js\n' +
    source.split('\n').slice(0,-1).map(line=>'+'+line+'\n').join('');
  const data = { baseline:{},current:{'large.js':source},diff,
    independent_validation:{status:'completed',provenance:'controller_process_observation'},
    controller_evidence:{status:'captured'},native_activity:{commands:[]}};
  const packet = budgetLocalPacket(data), parsed = JSON.parse(packet.text);
  assert(packet.bytes > 5*1024*1024 && packet.bytes < PACKET_LIMIT);
  assert.equal(parsed.current['large.js'],source);
  assert.equal(reconstructLocalDiff(parsed),diff);
  assert.equal(parsed.packet_budget.limit_bytes,PACKET_LIMIT);
});


test('the original 132331-byte acceptance envelope retains exact content', context => {
  const data = { current: { 'acceptance.txt': '' }, baseline: {}, diff: '', native_activity: { commands: [] } };
  const overhead = budgetLocalPacket(data).bytes;
  data.current['acceptance.txt'] = 'a'.repeat(132331 - overhead);
  const result = budgetLocalPacket(data), packet = JSON.parse(result.text);
  assert.equal(result.bytes, 132331); assert.equal(packet.current['acceptance.txt'], data.current['acceptance.txt']);
  assert.deepEqual(packet.baseline, data.baseline); assert.deepEqual(packet.native_activity, data.native_activity);
  context.diagnostic(`Acceptance envelope: ${result.bytes} UTF-8 bytes preserved.`);
});

test('local admission accepts the exact 64 MiB serialized ceiling and rejects one byte beyond', context => {
  const data = { current: { 'ceiling.txt': '' }, baseline: {}, diff: '' };
  const overhead = budgetLocalPacket(data).bytes;
  data.current['ceiling.txt'] = 'x'.repeat(PACKET_LIMIT - overhead);
  const result = budgetLocalPacket(data);
  assert.equal(result.bytes, PACKET_LIMIT);
  assert.equal(JSON.parse(result.text).current['ceiling.txt'], data.current['ceiling.txt']);
  data.current['ceiling.txt'] += 'x';
  assert.throws(() => budgetLocalPacket(data), error => error.code === 'EVIDENCE_SIZE_LIMIT' &&
    error.diagnostic.limit_bytes === PACKET_LIMIT && error.diagnostic.measured_bytes === PACKET_LIMIT + 1);
  context.diagnostic(`Exact serialized ceiling: ${PACKET_LIMIT} accepted; ${PACKET_LIMIT + 1} rejected.`);
});
