import { PACKET_LIMIT, packetSizeDiagnostic } from './packet-budget.mjs';

export const LOCAL_EVIDENCE_VERSION = 'pab.local-codex-review.v1';
export const LOCAL_RECORD_LIMIT = 64;
export const LOCAL_RECORD_BYTES = 24576;
const size = value => Buffer.byteLength(JSON.stringify(value));
const count = value => Math.min(Number.MAX_SAFE_INTEGER, value + 1);

export function createLocalEvidence(taskId) {
  return { version: 1, task_id: taskId, provenance: 'controller_retained_codex_app_server_notifications',
    commands: [], file_changes: [], rejected_events: 0, omitted_events: 0,
    exhaustive: false, output_completeness: 'unverified',
    limitations: ['Notifications are not independent command or filesystem verification.',
      'Missing notifications and operations outside these channels cannot be ruled out.',
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
    record.output = retained(completed ? item.aggregatedOutput : null, 2048, bound);
    record.output.source_truncated = item.truncated === true || item.outputTruncated === true || item.output_truncated === true ? true : null;
    record.output.completeness = 'unverified';
    for (const field of ['command', 'cwd', 'output']) if (record[field].missing || (field !== 'output' && !record[field].value)) record.missing.push(field);
    if (record.exit_code === null) record.missing.push('exit_code');
    record.start_completion_conflict = !!previous && ['command', 'cwd'].some(field =>
      previous[field].value !== record[field].value || previous[field].truncated || previous[field].redacted);
    if (record.start_completion_conflict) record.start_fields = { command: previous.command, cwd: previous.cwd };
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
  }
  const total = ledger.commands.length + ledger.file_changes.length;
  const bytes = size([...ledger.commands, ...ledger.file_changes]) - (previous ? size(previous) + 1 : 0) + size(record) + 1;
  if ((!previous && total >= LOCAL_RECORD_LIMIT) || bytes > LOCAL_RECORD_BYTES) {
    ledger.omitted_events = count(ledger.omitted_events); return true;
  }
  if (previous) records[index] = record; else records.push(record);
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

export function localEvidencePacket(task, required, cwd) {
  const local = task.implementer.local, ledger = task.local_execution_evidence;
  return { evidence_version: LOCAL_EVIDENCE_VERSION,
    execution: { backend: 'local_codex', task_id: task.id, thread_id: local.thread_id, turn_id: local.turn_id, model: local.model,
      state: local.execution_state, phase: local.phase, turn_submission_attempted: local.turn_submission_attempted,
      turn_submission_acknowledged: local.turn_submission_acknowledged, terminal_observed: local.terminal_observed,
      result_received: local.result_received, app_server_closed: local.server_closed, diagnostics: local.diagnostics },
    native_activity: ledger || { status: 'unavailable', reason: 'No controller-retained notification ledger; history cannot be reconstructed.', exhaustive: false },
    required_test_correlation: localTestCorrelation(ledger, required, cwd),
    independent_validation: { status: 'unavailable', results: [], reason: 'No independent validation executor is integrated for local tasks.' },
    gates: { local_review: 'disabled', local_publication: 'disabled', pr6_live_human_routing_acceptance: 'unverified' },
    coverage: { exhaustive_command_history: false, exhaustive_file_history: false, prohibited_operations_absence_verified: false,
      model_prose_included: false, agents_api_file_rpc_equivalence: false, descendant_termination_verified: false,
      limitations: ['Retained command output is bounded/redacted and upstream completeness is unverified.',
        'File-change notifications are claims, not controller-observed file bytes or a complete write history.',
        'Git/filesystem snapshots describe sampled states, not all intervening reads, writes, or network activity.',
        'An observed completed turn or exit code zero is not an independent test PASS.',
        'Task diff enumeration follows existing Git ignore semantics; ignored writes may be absent.',
        'App-server closure does not prove every descendant exited; snapshots are not an immutable filesystem freeze.'] } };
}

export function budgetLocalPacket(data) {
  const packet = { ...data, packet_budget: { limit_bytes: PACKET_LIMIT, policy: 'All sections retained; overflow rejects construction without silent removal.' } };
  const text = JSON.stringify(packet), bytes = Buffer.byteLength(text);
  if (bytes > PACKET_LIMIT) throw Object.assign(new Error('EVIDENCE_SIZE_LIMIT'), { code: 'EVIDENCE_SIZE_LIMIT',
    diagnostic: packetSizeDiagnostic(Object.fromEntries(Object.entries(packet).map(([name, value]) => [name, size(value)])), 'local_packet', bytes) });
  return { text, bytes };
}
