// Deterministic UTF-8 JSON budgets. Required semantic/controller sections never disappear.
export const PACKET_LIMIT = 128 * 1024;
const size = value => Buffer.byteLength(JSON.stringify(value));
const requiredOrder = ['contract', 'baseline_commit', 'current_commit', 'changed_files', 'unauthorized_files',
  'reviewed_git_state', 'file_byte_evidence', 'controller_evidence', 'baseline_state', 'current_config_hash',
  'staged_files', 'test_execution_evidence', 'file_rpc_operation_evidence', 'baseline', 'current', 'command_execution_evidence'];
export function packetSizeDiagnostic(sections, blocked, total, limit = PACKET_LIMIT) {
  return { code: 'EVIDENCE_SIZE_LIMIT', limit_bytes: limit, measured_bytes: total, required_section: blocked,
    section_bytes: sections, action: 'Reduce task scope or split the task; required evidence was not silently removed. No reviewer session was created.' };
}
function fail(sections, blocked, total) {
  const error = Object.assign(new Error('EVIDENCE_SIZE_LIMIT'), { code: 'EVIDENCE_SIZE_LIMIT', diagnostic: packetSizeDiagnostic(sections, blocked, total) });
  throw error;
}
export function budgetPacket(input) {
  const data = structuredClone(input), original = Object.fromEntries(Object.entries(data).map(([k,v]) => [k,size(v)]));
  const metadata = { limit_bytes: PACKET_LIMIT, encoding: 'compact UTF-8 JSON', metadata_reserve_bytes: PACKET_LIMIT,
    policy: 'Required sections first in declared order; command output bounded independently. Diff may be deduplicated only when complete before/after text is retained. Missing/truncated required evidence is still FAIL.',
    required_order: requiredOrder, sections: {} };
  for (const [name, value] of Object.entries(data)) metadata.sections[name] = { original_bytes: size(value), retained_bytes: size(value), budget_bytes: null, complete: true, representation: 'full' };
  const cmd = metadata.sections.command_execution_evidence;
  if (cmd) {
    cmd.complete = data.command_execution_evidence.items_scan_complete && !data.command_execution_evidence.omitted_command_records && !data.command_execution_evidence.records.some(r => r.truncated);
    cmd.representation = 'bounded command records; per-record output truncation and source scan gaps are explicit';
  }
  if (metadata.sections.file_rpc_operation_evidence) metadata.sections.file_rpc_operation_evidence.complete = data.file_rpc_operation_evidence?.capture_complete ?? false;
  if (metadata.sections.test_execution_evidence) {
    metadata.sections.test_execution_evidence.complete = !data.test_execution_evidence.some(r => r.truncated) && !data.command_execution_evidence.required_test_commands_missing?.length && data.command_execution_evidence.items_scan_complete;
  }
  // Existing controller sub-observations carry their own unavailable/conflict/truncation flags.
  if (metadata.sections.controller_evidence) metadata.sections.controller_evidence.representation = 'full controller observations; consult nested status/truncated flags for source completeness';
  // Reserve a measured upper bound for the envelope, including the longest
  // deduplication explanation and six-digit allocation fields (not a guessed pad).
  const deduplication = 'deduplicated: compare complete baseline/current maps by changed_files; absent keys mean file absent. Full patch text omitted, no semantic text omitted.';
  const worstMetadata = structuredClone(metadata);
  for (const section of Object.values(worstMetadata.sections)) section.budget_bytes = PACKET_LIMIT;
  Object.assign(worstMetadata.sections.diff, { representation: deduplication, semantic_text_complete: true, omitted_bytes: original.diff });
  const reserve = size({ ...Object.fromEntries(Object.keys(data).map(k => [k, null])), packet_budget: worstMetadata }) - 4 * Object.keys(data).length;
  metadata.metadata_reserve_bytes = reserve;
  let available = PACKET_LIMIT - reserve;
  for (const name of requiredOrder) {
    if (!(name in data)) continue;
    const bytes = size(data[name]);
    metadata.sections[name].budget_bytes = Math.min(available, ['command_execution_evidence','test_execution_evidence'].includes(name) ? 32768 : available);
    if (bytes > metadata.sections[name].budget_bytes) fail(original, name, size(data) + size(metadata));
    available -= bytes;
  }
  const diffBytes = size(data.diff);
  metadata.sections.diff.budget_bytes = available;
  if (diffBytes > available) {
    // Full ordinary text files preserve every semantic before/after fact. Retain
    // non-text/mode-only/rename patches: they cannot be inferred from text alone.
    const reconstructable = data.changed_files.every(name =>
      (data.baseline[name] === undefined || typeof data.baseline[name] === 'string') &&
      (data.current[name] === undefined || typeof data.current[name] === 'string') &&
      (data.baseline[name] !== undefined || data.current[name] !== undefined)) &&
      !/^(?:old mode|new mode|new file mode 100755|deleted file mode 100755|similarity index|rename from|rename to|Binary files|GIT binary patch|new file mode 120000|deleted file mode 120000)/m.test(data.diff);
    if (!reconstructable) fail(original, 'diff', size(data) + size(metadata));
    data.diff = '';
    metadata.sections.diff.retained_bytes = size(data.diff);
    metadata.sections.diff.complete = false;
    metadata.sections.diff.representation = deduplication;
    metadata.sections.diff.semantic_text_complete = true;
    metadata.sections.diff.omitted_bytes = diffBytes;
  }
  data.evidence_version = 5;
  data.packet_budget = metadata;
  const text = JSON.stringify(data), bytes = Buffer.byteLength(text);
  if (bytes > PACKET_LIMIT) fail(original, 'packet_metadata', bytes);
  return { text, bytes };
}
