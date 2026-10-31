import { PACKET_LIMIT, NEW_PACKET_LIMIT, INLINE_REVIEW_OPTIMIZATION_BYTES, packetSizeDiagnostic } from './packet-budget.mjs';
import { createHash } from 'node:crypto';

export const LOCAL_EVIDENCE_VERSION = 'pab.local-codex-review.v1';
// Native command/file-change retention is separate from the 64 MiB review-packet cap.
// Store the serialized record-array length incrementally to avoid quadratic remeasurement.
export const LOCAL_RECORD_LIMIT = 512;
export const LOCAL_RECORD_BYTES = 4 * 1024 * 1024;
export const LOCAL_OUTPUT_LIMIT = 256;
export const LOCAL_REFERENCE_LIMIT = 4;
export const LOCAL_REFERENCE_BYTES = 32768;
const size = value => Buffer.byteLength(JSON.stringify(value));
const count = value => Math.min(Number.MAX_SAFE_INTEGER, value + 1);
const outputHash = value => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');

export function createLocalEvidence(taskId) {
  return { version: 1, task_id: taskId, provenance: 'controller_retained_codex_app_server_notifications',
    commands: [], file_changes: [], record_bytes: 2, rejected_events: 0, omitted_events: 0,
    exhaustive: false, output_completeness: 'unverified',
    limitations: ['Notifications are not independent command or filesystem verification.',
      'Missing notifications and operations outside these channels cannot be ruled out.',
      'Optional command output retains at most 256 characters per event; truncation does not imply empty or complete output.',
      'No negative claim about prohibited operations or independent test PASS follows from this ledger.'] };
}

function retained(value, maximum, bound) {
  if (typeof value !== 'string') return { value: null, missing: true, truncated: false, redacted: false };
  const sanitized = bound(value, value.length + 64);
  return { value: sanitized.slice(0, maximum), missing: false, truncated: sanitized.length > maximum,
    redacted: sanitized !== value };
}

export function observeLocalEvidence(ledger, event, identity, bound) {
  if (!['item/started', 'item/completed'].includes(event.method)) return false;
  const params = event.params || {}, item = params.item;
  if (!['commandExecution', 'fileChange'].includes(item?.type)) return false;
  const reject = () => { ledger.rejected_events = count(ledger.rejected_events); return true; };
  if (!identity.thread_id || !identity.turn_id || params.threadId !== identity.thread_id || params.turnId !== identity.turn_id ||
      typeof item.id !== 'string' || !item.id || item.id.length > 200 || bound(item.id, 200) !== item.id) return reject();
  const records = item.type === 'commandExecution' ? ledger.commands : ledger.file_changes;
  const other = item.type === 'commandExecution' ? ledger.file_changes : ledger.commands;
  if (other.some(record => record.item_id === item.id)) return reject();
  const index = records.findIndex(record => record.item_id === item.id);
  const previous = records[index], completed = event.method === 'item/completed';
  if (previous && (previous.completion_observed || !completed)) return reject();
  const record = { provenance: 'codex_app_server_notification', task_id: ledger.task_id,
    thread_id: identity.thread_id, turn_id: identity.turn_id, item_id: item.id,
    start_observed: previous?.start_observed || !completed, completion_observed: completed,
    status: retained(item.status, 64, bound), missing: [] };
  if (!record.start_observed) record.missing.push('start');
  if (!completed) record.missing.push('completion');
  const statuses = completed ? ['completed', 'failed', 'declined'] : ['inProgress'];
  if (!statuses.includes(item.status)) record.missing.push('status');
  if (item.type === 'commandExecution') {
    record.command = retained(item.command, 2048, bound);
    record.cwd = retained(item.cwd, 1024, bound);
    record.exit_code = completed && Number.isInteger(item.exitCode) ? item.exitCode : null;
    record.output = retained(item.aggregatedOutput, LOCAL_OUTPUT_LIMIT, bound);
    record.output.availability = item.aggregatedOutput === undefined ? 'absent' : item.aggregatedOutput === null ? 'null' :
      typeof item.aggregatedOutput !== 'string' ? 'malformed' : item.aggregatedOutput === '' ? 'empty' : 'present';
    record.output.source_truncated = item.truncated === true || item.outputTruncated === true || item.output_truncated === true ? true : null;
    record.output.completeness = 'unverified';
    const outputText = typeof item.aggregatedOutput === 'string' && !record.output.redacted ? item.aggregatedOutput : null;
    if (outputText) record.output.comparison = { encoding: 'json-string-utf8', characters: outputText.length, sha256: outputHash(outputText) };
    let outputConflict = false;
    if (previous?.output.value) {
      const comparison = previous.output.comparison;
      if (comparison) {
        const prefix = outputText === null ? null : outputText.slice(0, comparison.characters);
        const prefixHash = prefix === null ? null : outputHash(prefix);
        record.start_output_comparison = { ...comparison, completion_prefix_sha256: prefixHash };
        outputConflict = previous.output.redacted || comparison.encoding !== 'json-string-utf8' || !Number.isSafeInteger(comparison.characters) || comparison.characters < previous.output.value.length ||
          !/^[a-f0-9]{64}$/.test(comparison.sha256) || outputText === null || outputText.length < comparison.characters || prefixHash !== comparison.sha256;
      } else outputConflict = previous.output.truncated || previous.output.redacted || record.output.missing || !record.output.value.startsWith(previous.output.value);
    }
    for (const field of ['command', 'cwd', 'output']) if (record[field].missing || (field !== 'output' && !record[field].value)) record.missing.push(field);
    if (record.exit_code === null) record.missing.push('exit_code');
    if (record.output.availability === 'malformed') record.missing.push('output_format');
    record.start_completion_conflict = !!previous && (previous.status.value !== 'inProgress' || previous.output.availability === 'malformed' ||
      ['command', 'cwd'].some(field => previous[field].value !== record[field].value || previous[field].truncated || previous[field].redacted) ||
      outputConflict);
    if (record.start_completion_conflict) record.start_fields = { command: previous.command, cwd: previous.cwd, status: previous.status, output: previous.output };
  } else {
    record.changes = [];
    record.changes_omitted = Array.isArray(item.changes) ? Math.max(0, item.changes.length - 16) : 0;
    if (!Array.isArray(item.changes) || !item.changes.length) record.missing.push('changes');
    for (const change of (Array.isArray(item.changes) ? item.changes.slice(0, 16) : [])) {
      const kind = ['add', 'delete', 'update'].includes(change?.kind?.type) ? change.kind.type : null;
      if (!kind || typeof change?.path !== 'string' || typeof change?.diff !== 'string') {
        if (!record.missing.includes('change_fields')) record.missing.push('change_fields');
      }
      record.changes.push({ path: retained(change?.path, 1024, bound), kind,
        move_path: retained(change?.kind?.move_path, 1024, bound), diff: retained(change?.diff, 1024, bound) });
    }
    record.start_completion_conflict = !!previous && JSON.stringify(previous.changes) !== JSON.stringify(record.changes);
    if (record.start_completion_conflict) record.start_changes = previous.changes;
  }
  const total = ledger.commands.length + ledger.file_changes.length;
  // JSON array bytes: brackets (2), each serialized record, and one comma
  // between adjacent records. A completed event replaces its existing start.
  // Legacy ledgers without the meter remain readable; only the size check
  // falls back to a full measurement.
  const retainedBytes = Number.isSafeInteger(ledger.record_bytes) && ledger.record_bytes >= 2
    ? ledger.record_bytes : size([...ledger.commands, ...ledger.file_changes]);
  const bytes = retainedBytes + size(record) - (previous ? size(previous) : 0) +
    (!previous && total > 0 ? 1 : 0);
  if ((!previous && total >= LOCAL_RECORD_LIMIT) || bytes > LOCAL_RECORD_BYTES) {
    ledger.omitted_events = count(ledger.omitted_events); return true;
  }
  if (previous) records[index] = record; else records.push(record);
  ledger.record_bytes = bytes;
  return true;
}

export function localTestCorrelation(ledger, required, cwd) {
  return { provenance: 'controller_exact_match_of_native_command_fields', independently_verified: false,
    matching: 'Exact command and approved cwd only; shell wrappers and substring matches are not inferred.',
    tests: required.map(command => {
      const matches = (ledger?.commands || []).filter(record => record.command.value === command && record.cwd.value === cwd &&
        !record.command.truncated && !record.command.redacted && !record.cwd.truncated && !record.cwd.redacted && !record.start_completion_conflict);
      return { required_command: command, status: matches.length ? 'native_observations_only' : 'unmatched',
        item_ids: matches.map(record => record.item_id) };
    }) };
}

export function localReferencePaths(contract) {
  const names = contract.reference_files === undefined ? [] : contract.reference_files;
  if (!Array.isArray(names) || names.length > LOCAL_REFERENCE_LIMIT || new Set(names).size !== names.length || names.some(name =>
    typeof name !== 'string' || !name || name.length > 200 || /[\\\\\x00-\x1f\x7f]/.test(name) || name.startsWith('/') ||
    name.split('/').some(part => ['', '.', '..', '.git', '.codex', 'TASK.md'].includes(part)) || contract.allowed_files.includes(name))) {
    throw Object.assign(new Error('INVALID_LOCAL_REFERENCE_FILES'), { code: 'INVALID_LOCAL_REFERENCE_FILES' });
  }
  return names;
}

export function localReferencesValid(contract, context, baseline) {
  try {
    const names = localReferencePaths(contract);
    if (!names.length) return context === undefined;
    if (!context || context.provenance !== 'controller_git_baseline' || context.complete !== true || context.baseline_commit !== baseline ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(context.baseline_tree || '') || !Array.isArray(context.files) || context.files.length !== names.length) return false;
    let bytes = 0;
    return context.files.every((file, index) => {
      if (!file || file.path !== names[index] || !['100644', '100755'].includes(file.mode) || file.encoding !== 'utf-8' ||
          typeof file.content !== 'string' || file.content.includes('\0') || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(file.blob_oid || '')) return false;
      const buffer = Buffer.from(file.content, 'utf8'); bytes += buffer.length;
      return bytes <= LOCAL_REFERENCE_BYTES && buffer.length === file.byte_length && createHash('sha256').update(buffer).digest('hex') === file.sha256 &&
        createHash(file.blob_oid.length === 40 ? 'sha1' : 'sha256').update(`blob ${buffer.length}\0`).update(buffer).digest('hex') === file.blob_oid;
    });
  } catch { return false; }
}

export function localEvidencePacket(task, required, cwd, reviewedState) {
  const local = task.implementer.local, ledger = task.local_execution_evidence;
  const validation = task.local_validation ? structuredClone(task.local_validation) :
    { status: 'unavailable', results: [], reason: 'No controller-owned independent validation has been recorded for this task.' };
  if (task.local_validation && (validation.task_id !== task.id || !reviewedState || JSON.stringify(validation.reviewed_git_state) !== JSON.stringify(reviewedState))) {
    validation.status = 'unavailable'; validation.reason = 'Validation candidate tree/state does not match this evidence snapshot.';
  }
  return { evidence_version: LOCAL_EVIDENCE_VERSION,
    execution: { backend: 'local_codex', task_id: task.id, thread_id: local.thread_id, turn_id: local.turn_id, model: local.model,
      state: local.execution_state, phase: local.phase, turn_submission_attempted: local.turn_submission_attempted,
      turn_submission_acknowledged: local.turn_submission_acknowledged, terminal_observed: local.terminal_observed,
      result_received: local.result_received, app_server_closed: local.server_closed, diagnostics: local.diagnostics,
      authentication: local.authentication, adapter_contract: local.adapter_contract, human_attention_required: local.human_attention_required,
      human_requests_resolved: Array.isArray(local.human_requests) && local.human_requests.every(request => request.status === 'resolved') },
    native_activity: ledger || { status: 'unavailable', reason: 'No controller-retained notification ledger; history cannot be reconstructed.', exhaustive: false },
    required_test_correlation: localTestCorrelation(ledger, required, cwd),
    independent_validation: validation,
    gates: { local_review: 'bounded_evidence_qualification', local_publication: 'controller_gated_exact_tree', pr6_live_human_routing_acceptance: 'unverified' },
    coverage: { exhaustive_command_history: false, exhaustive_file_history: false, prohibited_operations_absence_verified: false,
      model_prose_included: false, agents_api_file_rpc_equivalence: false, descendant_termination_verified: false,
      limitations: ['Retained command output is bounded/redacted and upstream completeness is unverified.',
        'File-change notifications are claims, not controller-observed file bytes or a complete write history.',
        'Git/filesystem snapshots describe sampled states, not all intervening reads, writes, or network activity.',
        'An observed completed turn or exit code zero is not an independent test PASS.',
        'Independent validation uses fresh Git-tree blob copies per command, without Git metadata, ignored assets, installed dependencies or checkout filters; unsupported trees remain unavailable.',
        'Validation confines writes and denies command networking using the existing native Codex sandbox policy; host reads remain broad. No exhaustive historical-operation audit is established.',
        'Validation termination observations cover the launched process group, not descendants that deliberately escape it.',
        'Task diff enumeration follows existing Git ignore semantics; ignored writes may be absent.',
        'App-server closure does not prove every descendant exited; snapshots are not an immutable filesystem freeze.'] } };
}

const diffHash = text => createHash('sha256').update(text).digest('hex');
const diffLines = (text, prefix) => text ? text.split('\n').map((line, index, lines) =>
  index === lines.length - 1 ? line ? `${prefix}${line}\n\\ No newline at end of file\n` : '' : `${prefix}${line}\n`).join('') : '';

export function reconstructLocalDiff(packet) {
  if (typeof packet.diff === 'string') return packet.diff;
  const fail = () => { throw Object.assign(new Error('INVALID_LOCAL_DIFF_ENCODING'), { code: 'INVALID_LOCAL_DIFF_ENCODING' }); };
  const encoded = packet.diff;
  if (!encoded || encoded.representation !== 'pab.exact-diff-references.v1' || encoded.complete !== true ||
      !Number.isInteger(encoded.utf8_bytes) || encoded.utf8_bytes < 0 || encoded.utf8_bytes > PACKET_LIMIT * 2 ||
      !Array.isArray(encoded.fragments) || encoded.fragments.length > 4096) fail();
  let text = '';
  for (const fragment of encoded.fragments) {
    if (typeof fragment === 'string') text += fragment;
    else {
      if (!fragment || !['baseline', 'current'].includes(fragment.map) || !['+', '-'].includes(fragment.prefix) ||
          typeof fragment.file !== 'string' || !Object.hasOwn(packet[fragment.map] || {}, fragment.file)) fail();
      const source = packet[fragment.map][fragment.file];
      if (typeof source !== 'string' || source.includes('\0') || Buffer.byteLength(source) > PACKET_LIMIT || diffHash(source) !== fragment.sha256) fail();
      text += diffLines(source, fragment.prefix);
    }
    if (Buffer.byteLength(text) > PACKET_LIMIT * 2) fail();
  }
  if (Buffer.byteLength(text) !== encoded.utf8_bytes || diffHash(text) !== encoded.sha256) fail();
  return text;
}

function deduplicateLocalDiff(packet) {
  if (typeof packet.diff !== 'string' || Buffer.byteLength(packet.diff) > PACKET_LIMIT * 2) return packet;
  let fragments = [packet.diff];
  for (const [map, prefix] of [['baseline', '-'], ['current', '+']]) {
    for (const file of Object.keys(packet[map] || {}).sort()) {
      const source = packet[map][file];
      if (typeof source !== 'string' || source.includes('\0') || Buffer.byteLength(source) > PACKET_LIMIT) continue;
      const body = diffLines(source, prefix), reference = { map, file, prefix, sha256: diffHash(source) };
      if (!body || size(body) <= size(reference) + 16) continue;
      fragments = fragments.flatMap(fragment => {
        if (typeof fragment !== 'string') return [fragment];
        const offset = fragment.indexOf(body);
        if (offset < 0 || (offset > 0 && fragment[offset - 1] !== '\n')) return [fragment];
        return [fragment.slice(0, offset), reference, fragment.slice(offset + body.length)].filter(value => value !== '');
      });
    }
  }
  const candidate = { ...packet, diff: { representation: 'pab.exact-diff-references.v1', complete: true,
    utf8_bytes: Buffer.byteLength(packet.diff), sha256: diffHash(packet.diff), fragments } };
  if (size(candidate) >= size(packet)) return packet;
  if (reconstructLocalDiff(candidate) !== packet.diff) throw new Error('INVALID_LOCAL_DIFF_ENCODING');
  return candidate;
}

export function budgetLocalPacket(data) {
  const packet = { ...data, packet_budget: { limit_bytes: NEW_PACKET_LIMIT, policy: 'All sections retained; overflow rejects construction without silent removal.' } };
  let text = JSON.stringify(packet), bytes = Buffer.byteLength(text);
  if (bytes > INLINE_REVIEW_OPTIMIZATION_BYTES) {
    const candidate = deduplicateLocalDiff(packet);
    if (candidate !== packet) { text = JSON.stringify(candidate); bytes = Buffer.byteLength(text); }
  }
  if (bytes > NEW_PACKET_LIMIT) throw Object.assign(new Error('EVIDENCE_SIZE_LIMIT'), { code: 'EVIDENCE_SIZE_LIMIT',
    diagnostic: packetSizeDiagnostic(Object.fromEntries(Object.entries(packet).map(([name, value]) => [name, size(value)])), 'local_packet', bytes) });
  return { text, bytes };
}
