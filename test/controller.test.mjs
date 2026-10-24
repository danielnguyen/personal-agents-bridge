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
      if ((correctiveReview && !mode.correctiveReviewFail) || (!correctiveReview && mode.originalPass)) { output.overall = 'PASS'; for (const finding of output.findings) { finding.status = 'PASS'; finding.classification = null; } }
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

test('MCP versioned status exemption preserves mutation audit and legacy/manual observation behavior', async t => {
  const { c, api } = await setup(t), { client, get } = await statusClient(t, c);
  const started = await client.callTool({ name: 'start_task', arguments: { contract: contract(), request_id: 'mcp_mutation_start' } });
  assert.notEqual(started.isError, true); const id = started.structuredContent.task_id;
  await Promise.all([...c.jobs.values()]); api.completed(c.task(id).implementer.session_id);
  assert.notEqual((await get(id)).isError, true);
  const audited = c.db.prepare('SELECT value FROM audit').all().map(row => JSON.parse(row.value));
  assert(audited.some(row => row.tool === 'start_task' && row.task_id === id && row.session_id));
  assert(audited.some(row => row.tool === 'get_task' && row.task_id === id));
  assert.notEqual((await client.callTool({ name: 'cleanup_task', arguments: { task_id: id, delete_workspace: false } })).isError, true);
  assert(c.db.prepare('SELECT value FROM audit').all().map(row => JSON.parse(row.value)).some(row => row.tool === 'cleanup_task' && row.task_id === id));
  const legacy = await automaticAttempt(t), status = await statusClient(t, legacy.c);
  assert.notEqual((await status.get(legacy.id)).isError, true);
  assert(legacy.c.db.prepare('SELECT value FROM audit').all().map(row => JSON.parse(row.value)).some(row => row.tool === 'get_task'));
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
