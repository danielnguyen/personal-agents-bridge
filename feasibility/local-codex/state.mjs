import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => { throw new Error(code); };

export class SessionLedger {
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    chmodSync(filename, 0o600);
    this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS sessions (role TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, status TEXT NOT NULL);');
  }
  close() { this.db.close(); }
  get(role) {
    const row = this.db.prepare('SELECT value FROM sessions WHERE role=?').get(role);
    return row ? JSON.parse(row.value) : null;
  }
  save(role, value) {
    this.db.prepare('INSERT OR REPLACE INTO sessions VALUES (?,?)').run(role, JSON.stringify(value));
  }
  bind(role, threadId, sessionId, generation) {
    if (!['implementer', 'reviewer'].includes(role) || [threadId, sessionId, generation].some(value => typeof value !== 'string' || !value || value.length > 256)) fail('INVALID_SESSION');
    if (this.get(role)) fail('SESSION_ALREADY_BOUND');
    const other = this.get(role === 'reviewer' ? 'implementer' : 'reviewer');
    if (other && (other.threadId === threadId || other.sessionId === sessionId)) fail('REVIEW_SESSION_NOT_INDEPENDENT');
    this.save(role, { threadId, sessionId, generation, turnId: null, status: 'idle', question: null, evidenceGaps: [] });
  }
  beginOperation(id, method, params) {
    if (!['thread/start', 'thread/resume', 'turn/start', 'turn/interrupt'].includes(method)) fail('UNSUPPORTED_OPERATION');
    const fingerprint = digest({ method, params });
    const prior = this.db.prepare('SELECT * FROM operations WHERE id=?').get(id);
    if (prior) {
      if (prior.fingerprint !== fingerprint) fail('REQUEST_ID_CONFLICT');
      return { dispatch: false, status: prior.status };
    }
    this.db.prepare('INSERT INTO operations VALUES (?,?,?)').run(id, fingerprint, 'uncertain');
    return { dispatch: true, status: 'uncertain' };
  }
  acknowledgeOperation(id) {
    if (this.db.prepare("UPDATE operations SET status='acknowledged' WHERE id=?").run(id).changes !== 1) fail('UNKNOWN_OPERATION');
  }
  turnStarted(role, turnId) {
    const state = this.get(role);
    if (!state || state.status !== 'idle' || typeof turnId !== 'string' || !turnId) fail('TURN_NOT_IDLE');
    state.turnId = turnId; state.status = 'running'; this.save(role, state);
  }
  clarification(role, generation, message) {
    const state = this.get(role), params = message.params;
    if (role !== 'implementer' || !state || state.generation !== generation || state.status !== 'running' ||
        message.method !== 'item/tool/requestUserInput' || !['string', 'number'].includes(typeof message.id) ||
        params?.threadId !== state.threadId || params.turnId !== state.turnId || params.isBlocking !== true || params.autoResolutionMs !== null ||
        !Array.isArray(params.questions) || !params.questions.length || params.questions.length > 3 ||
        new Set(params.questions.map(question => question.id)).size !== params.questions.length ||
        params.questions.some(question => typeof question.id !== 'string' || !question.id || question.id.length > 128 ||
          typeof question.question !== 'string' || !question.question || question.question.length > 8000 || question.isSecret !== false)) fail('UNSUPPORTED_CLARIFICATION');
    state.question = { requestId: message.id, itemId: params.itemId, questions: params.questions.map(({ id, question }) => ({ id, question })), status: 'pending' };
    state.status = 'waiting_for_clarification'; this.save(role, state);
  }
  answer(role, generation, requestId, answers) {
    const state = this.get(role);
    if (!state || state.generation !== generation || state.status !== 'waiting_for_clarification' ||
        state.question?.status !== 'pending' || state.question.requestId !== requestId) fail('CLARIFICATION_NOT_PENDING');
    if (!answers || Object.keys(answers).length !== state.question.questions.length || state.question.questions.some(question =>
      !Array.isArray(answers[question.id]?.answers) || answers[question.id].answers.length !== 1 ||
      typeof answers[question.id].answers[0] !== 'string' || !answers[question.id].answers[0] || answers[question.id].answers[0].length > 8000)) fail('INVALID_ANSWERS');
    state.question.status = 'reply_uncertain'; state.question.answerHash = digest(answers);
    this.save(role, state);
    return { id: requestId, result: { answers } };
  }
  resolved(role, generation, params) {
    const state = this.get(role);
    if (!state || state.generation !== generation || params.threadId !== state.threadId || params.requestId !== state.question?.requestId) fail('UNKNOWN_RESOLUTION');
    state.question.status = 'resolved_outcome_unknown'; state.status = 'needs_attention';
    this.save(role, state);
  }
  interruptRequested(role) {
    const state = this.get(role);
    if (!state || !['running', 'waiting_for_clarification'].includes(state.status)) fail('NO_ACTIVE_TURN');
    state.status = 'interrupting'; this.save(role, state);
  }
  turnCompleted(role, generation, params) {
    const state = this.get(role);
    if (!state || state.generation !== generation || params.threadId !== state.threadId || params.turn?.id !== state.turnId ||
        !['running', 'waiting_for_clarification', 'interrupting', 'needs_attention'].includes(state.status) ||
        !['completed', 'interrupted', 'failed'].includes(params.turn.status)) fail('INVALID_COMPLETION');
    state.status = state.question ? 'needs_attention' : params.turn.status;
    if (state.question) state.question.status = 'interrupted_or_unverified';
    this.save(role, state);
  }
  disconnect(role) {
    const state = this.get(role);
    if (!state) fail('UNKNOWN_SESSION');
    state.status = 'needs_attention';
    if (!state.evidenceGaps.includes('TRANSPORT_GAP')) state.evidenceGaps.push('TRANSPORT_GAP');
    if (state.question) state.question.status = 'interrupted_or_unverified';
    this.save(role, state);
  }
  recover() {
    for (const role of ['implementer', 'reviewer']) if (this.get(role)) this.disconnect(role);
  }
}

export function commandObservation(message, expected) {
  const params = message?.params, item = params?.item;
  if (message?.method !== 'item/completed' || item?.type !== 'commandExecution') return null;
  if (params.threadId !== expected.threadId || params.turnId !== expected.turnId ||
      typeof item.id !== 'string' || typeof item.command !== 'string' || typeof item.cwd !== 'string' ||
      !['completed', 'failed', 'declined'].includes(item.status)) fail('INVALID_COMMAND_EVIDENCE');
  const bounded = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : null;
  return { provenance: 'codex_app_server_item', threadId: params.threadId, turnId: params.turnId, itemId: item.id,
    command: bounded(item.command, 2048), cwd: bounded(item.cwd, 1024), output: bounded(item.aggregatedOutput, 2048),
    exitCode: Number.isInteger(item.exitCode) ? item.exitCode : null, status: item.status,
    locallyTruncated: item.command.length > 2048 || item.cwd.length > 1024 || (item.aggregatedOutput?.length || 0) > 2048,
    upstreamCompleteness: 'unknown', executionBoundaryVerified: false };
}

export function migrationDecision() {
  return { authorized: false, blockers: ['SUBSCRIPTION_INFERENCE_UNVERIFIED', 'MODEL_TOOL_ENFORCEMENT_UNVERIFIED',
    'DURABLE_CLARIFICATION_RECONCILIATION_UNVERIFIED', 'COMMAND_AND_FILE_EVIDENCE_COVERAGE_UNVERIFIED',
    'PROCESS_TREE_QUIESCENCE_UNVERIFIED'] };
}
