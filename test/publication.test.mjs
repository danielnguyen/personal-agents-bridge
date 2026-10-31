import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync, constants as sqlite } from 'node:sqlite';
import { Controller, digest, contractMarkdown } from '../controller.mjs';
import { GitHubPublisher, publicationGit, publicationState, githubRepository } from '../publication.mjs';
import { repoGit, asynchronousRepoGit, repositoryIdentity } from '../repositories.mjs';
import { gitState, checkoutSnapshot } from '../review-evidence.mjs';
import { FakeAPI, FakeExecutor } from './helpers.mjs';
import { createServer } from '../server.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { validateLocalReview, localScopeQualification, localContractBinding, LOCAL_ACTIONABILITY_REVIEW_VERSION,
  localActionabilityReviewerInstructions } from '../local-reviewer-instructions.mjs';
import { createLocalEvidence, observeLocalEvidence } from '../local-evidence.mjs';

class LocalPublisher extends GitHubPublisher {
  constructor(remote) { super(); this.remote = remote; this.pushes = 0; this.creates = 0; this.base = 'main'; this.calls = []; }
  api() { throw Error('REAL GITHUB CALL FORBIDDEN IN TESTS'); }
  async target() { this.calls.push('target'); return { repository: 'fixture/isolated-publication', base: this.base, remote: this.remote }; }
  async remoteHead(...args) { this.calls.push('remoteHead'); return super.remoteHead(...args); }
  async push(...args) { this.calls.push('push'); this.pushes++; await this.beforePush?.(...args); return super.push(...args); }
  async findPR() { this.calls.push('findPR'); return this.pr || null; }
  async createPR(target, branch, input) {
    this.calls.push('createPR'); this.creates++; this.input = structuredClone(input); assert.equal(input.draft, true);
    this.pr = { number: 7, html_url: `https://github.com/${target.repository}/pull/7`, state: 'open', draft: true, merged_at: null,
      head: { ref: branch, sha: repoGit(this.remote, 'rev-parse', `refs/heads/${branch}`).trim(), repo: { full_name: target.repository } },
      base: { ref: target.base, repo: { full_name: target.repository } } };
    if (this.losePRResponse) throw Error('response lost');
    return this.pr;
  }
}
async function setup(t, allowed = ['one.txt'], local = false, commands = [], automaticMode) {
  const root = await fs.mkdtemp('/var/tmp/personal-agents-bridge/publication-test-');
  const normal = path.join(root, 'normal'), remote = path.join(root, 'remote.git');
  await fs.mkdir(normal); await fs.mkdir(remote);
  repoGit(normal, 'init', '--initial-branch=main'); repoGit(remote, 'init', '--bare', '--initial-branch=main');
  for (const name of automaticMode?.corrective ? ['one.txt'] : ['keep.txt', 'delete.txt', 'rename.txt', 'run.sh']) await fs.writeFile(path.join(normal, name), `${name}\n`);
  repoGit(normal, 'add', '.'); repoGit(normal, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'baseline');
  repoGit(normal, 'remote', 'add', 'origin', remote); repoGit(normal, 'push', 'origin', 'HEAD:refs/heads/main');
  const baseline = repoGit(normal, 'rev-parse', 'HEAD').trim();
  const api = new FakeAPI(), executor = new FakeExecutor(), publisher = new LocalPublisher(remote), localCalls = [], localPrompts = [];
  let implementations = 0, reviews = 0;
  if (automaticMode?.publisher) automaticMode.publisher(publisher);
  const c = await new Controller({ stateRoot: path.join(root, 'state'), workspaceRoot: path.join(root, 'tasks'), api, executor, publisher, secrets: [],
    ...(local ? { localBackendFactory: options => ({
      async run(input) {
        const corrective = !options.reviewOnly && implementations++ > 0, correctiveReview = options.reviewOnly && reviews++ > 0;
        localCalls.push(correctiveReview ? 'corrective-reviewer' : options.reviewOnly ? 'reviewer' : corrective ? 'corrector' : 'implementer');
        if (options.reviewOnly) localPrompts.push(input.prompt);
        const identity = { model: 'fixture-model', threadId: correctiveReview ? 'corrective-reviewer' : options.reviewOnly ? 'independent-reviewer' : corrective ? 'corrective-implementer' : 'implementer-thread', turnId: automaticMode?.corrective ? `turn-${localCalls.length}` : 'fixture-turn',
          turnSubmissionAttempted: true, turnSubmissionAcknowledged: true, terminalObserved: true };
        if (automaticMode?.corrective) {
          options.onLifecycle({ ...identity, phase: 'thread_acknowledged', turnSubmissionAttempted: false, turnSubmissionAcknowledged: false, terminalObserved: false });
          options.onLifecycle({ ...identity, phase: 'turn_submitting', turnSubmissionAcknowledged: false, terminalObserved: false });
        }
        options.onLifecycle({ ...identity, phase: 'turn_acknowledged' });
        if (automaticMode) {
          automaticMode.onOptions?.(options);
          if (!options.reviewOnly) {
            const item = { id: 'automatic-write', type: 'commandExecution', command: "printf 'exact\\n' > one.txt", cwd: options.cwd };
            options.onProgress({ method: 'item/started', params: { threadId: identity.threadId, turnId: identity.turnId, item: { ...item, status: 'inProgress' } } });
            await fs.writeFile(path.join(options.cwd, 'one.txt'), corrective ? 'corrected\n' : 'exact\n');
            options.onProgress({ method: 'item/completed', params: { threadId: identity.threadId, turnId: identity.turnId, item: { ...item, status: 'completed', exitCode: 0 } } });
            await automaticMode.implementation?.(options, identity, input);
          } else await automaticMode.review?.(options, identity, input);
        }
        options.onLifecycle({ ...identity, phase: 'terminal_observed', status: 'completed' });
        const overall = automaticMode?.corrective ? correctiveReview ? automaticMode.correctiveVerdict || 'PASS' : automaticMode.originalPass ? 'PASS' : 'FAIL' : automaticMode?.verdict || 'PASS';
        const findings = ['R1', 'SCOPE', 'TEST_EVIDENCE'].map(id => ({ id, status: automaticMode?.versioned && id !== 'R1' ? 'PASS' : overall,
          evidence: 'Synthetic independent reviewer assessment.' }));
        const output = automaticMode?.versioned ? { format: LOCAL_ACTIONABILITY_REVIEW_VERSION, overall, findings: findings.map(finding => ({ ...finding,
          classification: finding.status === 'PASS' ? null : { kind: 'implementation_defect', target_files: ['one.txt'],
            remedy: { kind: 'edit_files', description: 'Correct the content of one.txt.', requires_human_approval: false } } })) } : { overall, findings };
        return { ...identity, status: 'completed', authentication: 'chatgpt', uncertainties: correctiveReview && automaticMode?.correctiveUncertain ? ['UNKNOWN_REVIEW_EXECUTION'] : [], commands: [],
          ...(!options.reviewOnly ? automaticMode?.result : {}),
          messages: options.reviewOnly ? [{ provenance: 'model', text: correctiveReview && automaticMode?.correctiveOutput !== undefined ? automaticMode.correctiveOutput : automaticMode?.reviewOutput || JSON.stringify(output) }] : [] };
      }, async cancel() {}, async close() { return !(automaticMode?.closeFailure === (options.reviewOnly ? 'reviewer' : 'implementer')); },
    }) } : {}) }).init();
  t.after(async () => { await c.close(); await fs.rm(root, { recursive: true, force: true }); });
  await fs.writeFile(path.join(root, 'state/repositories.json'), JSON.stringify({ version: 1, repositories: { fixture: await repositoryIdentity(normal) } }), { mode: 0o600 });
  const contract = { goal: 'Local publication fixture', allowed_files: allowed, requirements: [{ id: 'R1', text: 'Make the exact fixture change.' }], invariants: [], test_commands: commands, initial_files: {} };
  const automatic = { publish: { title: 'Automatic isolated fixture', body: 'Explicit test authorization', draft: true }, max_duration_seconds: 120, max_codex_turns: 2, max_corrections: 0 };
  if (automaticMode?.versioned) automatic.review_protocol = LOCAL_ACTIONABILITY_REVIEW_VERSION;
  if (automaticMode?.corrective) Object.assign(automatic, { max_codex_turns: 4, max_corrections: 1, review_protocol: LOCAL_ACTIONABILITY_REVIEW_VERSION });
  if (automaticMode?.publishCorrection) automatic.publish_after_correction = true;
  const startInput = { request_id: 'start_publication', repository_id: 'fixture', contract, ...(local ? { execution_backend: 'local_codex' } : {}), ...(automaticMode ? { automatic } : {}) };
  automaticMode?.configure?.(c, startInput);
  const started = await c.start(startInput); await Promise.all([...c.jobs.values()]);
  const id = started.task_id, work = path.join(c.workspaceRoot, id, 'repo');
  const review = async (verdict = 'PASS') => {
    if (local) {
      await c.review({ task_id: id, request_id: 'review_publication' }); await Promise.all([...c.jobs.values()]);
      const result = c.task(id).reviewer;
      assert.equal(result.error, undefined); assert.equal(result.review_result.overall, verdict, JSON.stringify(result.review_result)); return;
    }
    api.completed(c.task(id).implementer.session_id);
    await c.review({ task_id: id, request_id: 'review_publication' }); await Promise.all([...c.jobs.values()]);
    const row = c.task(id); assert.equal(row.reviewer.error, undefined);
    api.completed(row.reviewer.session_id, JSON.stringify({ overall: verdict, findings: ['R1', 'SCOPE', 'TEST_EVIDENCE'].map(id => ({ id, status: verdict, evidence: 'Local test reviewer fixture.' })) }));
    assert.equal((await c.get(id)).reviewer.overall, verdict);
  };
  const input = { task_id: id, title: 'Publish isolated fixture' };
  return { c, root, normal, remote, baseline, api, executor, publisher, id, work, input, review, contract, startInput, localCalls, localPrompts };
}

async function reportingPublication(c, id, client) {
  let cursor, text = '';
  do {
    const input = { task_id: id, section: 'outcome', limit: 256, ...(cursor ? { cursor } : {}) };
    const response = client ? await client.callTool({ name: 'get_task_evidence', arguments: input }) : null;
    if (response) assert.notEqual(response.isError, true);
    const page = response ? response.structuredContent : await c.taskEvidence(input);
    text += page.content; cursor = page.next_cursor;
  } while (cursor);
  const response = client ? await client.callTool({ name: 'get_task', arguments: { task_id: id } }) : null;
  if (response) assert.notEqual(response.isError, true);
  const status = response ? response.structuredContent : await c.reportTask(id);
  assert.deepEqual(status.publication, JSON.parse(text).publication);
  assert.equal(status.remaining_authority.publication_authorized, false);
  assert.equal(status.publication.execution_authorized, false);
  return status.publication;
}

test('shared publication proof rejects SSH B historical matched-absence reproduction', async context => {
  const { c, id, work, input, review } = await setup(context);
  await fs.writeFile(path.join(work, 'one.txt'), 'exact\n'); await review(); await c.publish(input);
  const task = c.task(id), p = task.publication, ref = task.reviewer;
  delete p.reviewed_tree_sha; delete ref.reviewed_git_state.tree_sha;
  delete p.review_packet_sha256; delete ref.packet_hash; delete ref.review_result.packet_hash;
  delete p.reviewer_session_id; delete ref.session_id;
  delete p.reviewer_turn_id; delete ref.turn_id; delete ref.review_result.turn_id;
  delete p.pushed_branch; delete task.repository.branch; delete ref.findings_sha256;
  // Simulate an incomplete retained historical record without asking the
  // Controller mutation/validation path to endorse it.
  c.db.prepare('UPDATE tasks SET value=? WHERE id=?').run(JSON.stringify(task), id);
  const before = c.db.prepare('SELECT value FROM tasks WHERE id=?').get(id).value;
  assert.equal((await reportingPublication(c, id)).confirmed, false);
  assert.equal(c.db.prepare('SELECT value FROM tasks WHERE id=?').get(id).value, before);
});

test('original reviewer receipt rejects SSH B hash-valid contradictory local responses', async context => {
  const { c, id, work, input, review } = await setup(context, ['one.txt'], true);
  await fs.writeFile(path.join(work, 'one.txt'), 'exact\n'); await review(); await c.publish(input);
  clearInterval(c.sweeper);
  const original = c.task(id);
  const findings = original.reviewer.review_result.findings;
  const outputs = [
    ['original FAIL with stored PASS', JSON.stringify({ overall: 'FAIL', findings: findings.map(finding => ({ ...finding, status: 'FAIL' })) })],
    ['malformed original receipt', '{malformed synthetic reviewer response'],
    ['incomplete original PASS', JSON.stringify({ overall: 'PASS', findings: findings.slice(0, 1) })],
  ];
  for (const [name, output] of outputs) await context.test(name, async () => {
    const task = structuredClone(original), ref = task.reviewer;
    ref.received_review_output.output = output;
    ref.received_review_output.output_sha256 = digest(output);
    ref.received_output_sha256 = digest(ref.received_review_output);
    c.db.prepare('UPDATE tasks SET value=? WHERE id=?').run(JSON.stringify(task), id);
    // The original execution/receipt bindings and all hashes remain valid.
    const { packet } = await c.retainedEvidencePacket(task);
    c.verifyReceivedReview(task, ref.received_review_output, ref.received_output_sha256, packet);
    const before = c.db.prepare('SELECT value FROM tasks WHERE id=?').get(id).value;
    assert.equal((await reportingPublication(c, id)).confirmed, false);
    assert.equal(c.db.prepare('SELECT value FROM tasks WHERE id=?').get(id).value, before);
  });
});

for (const mode of ['agents_api', 'local_manual', 'automatic', 'versioned', 'corrective'])
test(`shared publication proof independently rejects absent, paired and conflicting ${mode} evidence`, async context => {
  const automatic = ['automatic', 'versioned', 'corrective'].includes(mode);
  const value = await setup(context, ['one.txt'], mode !== 'agents_api', automatic ? ['cat one.txt'] : [], automatic ?
    { ...(mode !== 'automatic' ? { versioned: true } : {}), ...(mode === 'corrective' ? { corrective: true, publishCorrection: true } : {}) } : undefined);
  const { c, publisher, api } = value;
  if (automatic) await automaticSettled(value);
  else { await fs.writeFile(path.join(value.work, 'one.txt'), 'exact\n'); await value.review(); await c.publish(value.input); }
  clearInterval(c.sweeper);
  const original = c.task(value.id), target = mode === 'corrective' ? c.task(original.automatic.correction.task_id) : original;
  const ids = mode === 'corrective' ? [original.id, target.id] : [target.id];
  const originals = ids.map(id => [id, c.db.prepare('SELECT value FROM tasks WHERE id=?').get(id).value]);
  const operations = c.db.prepare('SELECT * FROM operations ORDER BY id').all();
  const server = createServer(c, async () => {}), client = new Client({ name: 'publication-proof', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  context.after(async () => { await client.close(); await server.close(); });
  const forbidden = [], methods = new Map();
  for (const method of ['save', 'observe', 'viewRole', 'publish', 'continue', 'review', 'currentReviewPacket', 'verifyLocalReviewPacket',
    'repositoryEvidence', 'reconcileAutomaticEvidence', 'reconcileAutomaticPublication']) {
    methods.set(method, c[method]); c[method] = () => { forbidden.push(method); throw Error(`Reporting invoked ${method}`); };
  }
  const apiMethods = [api.retrieve, api.items.list, api.turns.list];
  api.retrieve = api.items.list = api.turns.list = () => { forbidden.push('API'); throw Error('API forbidden'); };
  const ledger = () => JSON.stringify(['tasks', 'audit', 'operations', 'automatic_attempts', 'failures'].map(table => c.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  const files = await publicationFiles(c.workspaceRoot), source = await publicationFiles(value.normal), calls = [...publisher.calls];
  const authority = JSON.stringify([c.transactionUnresolved, [...c.persistenceFailures], [...c.jobs.keys()], value.localCalls, api.sent, api.created]);
  const cases = [];
  const remove = paths => row => { for (const name of paths) { const parts = name.split('.'), key = parts.pop(); const parent = parts.reduce((value, part) => value?.[part], row); if (parent) delete parent[key]; } };
  const fields = ['publication_frozen', 'publication.task_id', 'publication.reviewed_tree_sha', 'publication.review_packet_sha256', 'publication.commit_sha',
    'publication.pushed_branch', 'publication.reviewer_turn_id', 'publication.input_sha256', 'publication.push_attempted', 'publication.pr_attempted',
    'publication.commit_tree_matches_reviewed_tree', 'publication.review_overall', 'publication.pr_number', 'publication.pr_url',
    'publication.prepared_at', 'publication.completed_at', 'publication.target.repository', 'publication.target.base', 'baseline',
    'repository.baseline_commit', 'repository.branch', 'reviewer.packet_hash', 'reviewer.findings_sha256', 'reviewer.review_result',
    'reviewer.review_result.packet_hash', 'reviewer.review_result.turn_id', 'reviewer.review_result.findings', 'reviewer.review_result.overall',
    'reviewer.reviewed_git_state.tree_sha', automatic ? 'automatic.contract_binding.sha256' : 'evidence_contract.sha256',
    automatic ? 'automatic.contract_binding.contract' : 'evidence_contract.contract'];
  if (mode === 'agents_api') fields.push('publication.reviewer_session_id', 'reviewer.session_id', 'reviewer.turn_id', 'implementer.session_id');
  else fields.push('publication.reviewer_backend', 'publication.reviewer_session_id', 'publication.reviewer_thread_id', 'reviewer.local.thread_id', 'reviewer.local.turn_id', 'reviewer.local.model',
    'reviewer.review_result.thread_id', 'reviewer.review_result.reviewed_git_state.tree_sha', 'reviewer.received_output_sha256',
    'reviewer.received_review_output', 'reviewer.received_review_output.output_sha256');
  for (const field of fields) cases.push({ name: `missing ${field}`, mutate: remove([field]) });
  for (const paths of [
    ['publication.reviewed_tree_sha', 'reviewer.reviewed_git_state.tree_sha', 'reviewer.review_result.reviewed_git_state.tree_sha'],
    ['publication.review_packet_sha256', 'reviewer.packet_hash', 'reviewer.review_result.packet_hash'],
    ['publication.reviewer_turn_id', mode === 'agents_api' ? 'reviewer.turn_id' : 'reviewer.local.turn_id', 'reviewer.review_result.turn_id'],
    ['publication.pushed_branch', 'repository.branch'], ['reviewer.findings_sha256', 'reviewer.review_result'],
    mode === 'agents_api' ? ['publication.reviewer_session_id', 'reviewer.session_id'] :
      ['publication.reviewer_thread_id', 'reviewer.local.thread_id', 'reviewer.review_result.thread_id'],
  ]) cases.push({ name: `matched absence ${paths.join(', ')}`, mutate: remove(paths) });
  cases.push({ name: 'mismatched findings identity', mutate(row) { row.reviewer.findings_sha256 = 'a'.repeat(64); } },
    { name: 'invalid findings with matching digest', mutate(row) { row.reviewer.review_result.findings = []; row.reviewer.findings_sha256 = digest(row.reviewer.review_result); } },
    { name: 'qualification contradicts original response with matching digest', mutate(row) {
      row.reviewer.review_result.findings[0].evidence = 'Synthetic substituted qualification; absent from original response.';
      row.reviewer.findings_sha256 = digest(row.reviewer.review_result);
    } },
    { name: 'wrong tree type on both sides', mutate(row) { row.publication.reviewed_tree_sha = row.reviewer.reviewed_git_state.tree_sha = {}; } },
    { name: 'unknown attempt flags', mutate(row) { row.publication.push_attempted = 'unknown'; row.publication.pr_attempted = null; }, unknown: true });
  for (const fault of ['FAIL', 'malformed', 'incomplete PASS']) cases.push({ name: `original ${fault} contradicts stored PASS`, mutate(row) {
    const ref = row.reviewer, message = mode === 'agents_api' ? ref.evidence_messages.at(-1) : null;
    const raw = JSON.parse(message ? message.text : ref.received_review_output.output);
    if (fault === 'FAIL') { raw.overall = 'FAIL'; raw.findings[0].status = 'FAIL'; }
    if (fault === 'incomplete PASS') raw.findings.pop();
    const output = fault === 'malformed' ? '{malformed synthetic response' : JSON.stringify(raw);
    if (message) message.text = output;
    else {
      ref.received_review_output.output = output; ref.received_review_output.output_sha256 = digest(output);
      ref.received_output_sha256 = digest(ref.received_review_output);
    }
  } });
  if (mode === 'agents_api') {
    for (const fault of ['missing', 'wrong turn', 'unknown redaction', 'redacted', 'unknown truncation', 'truncated', 'omitted', 'wrong provenance', 'oversized', 'trailing unqualified message'])
      cases.push({ name: `original Agents API response ${fault}`, mutate(row) {
        const ref = row.reviewer, message = ref.evidence_messages.at(-1);
        if (fault === 'missing') delete ref.evidence_messages;
        if (fault === 'wrong turn') message.turn_id = 'unqualified-turn';
        if (fault === 'unknown redaction') delete message.redacted;
        if (fault === 'redacted') message.redacted = true;
        if (fault === 'unknown truncation') delete message.truncated;
        if (fault === 'truncated') message.truncated = true;
        if (fault === 'omitted') ref.evidence_messages_omitted = 1;
        if (fault === 'wrong provenance') message.provenance = 'unverified_statement';
        if (fault === 'oversized') message.text += ' '.repeat(16001);
        if (fault === 'trailing unqualified message') ref.evidence_messages.push({ ...message, text: 'Not a qualified reviewer response.' });
      } });
  }
  for (const operation of operations) for (const fault of ['missing', 'pending', 'uncertain', 'conflicting']) cases.push({
    name: `${fault} operation ${operation.id}`, operation, fault });
  if (automatic) cases.push({ name: 'publication input conflicts with original authorization', mutate(row) { row.publication.input_sha256 = 'a'.repeat(64); } });
  if (mode === 'corrective') {
    for (const field of ['automatic.corrective_publication', 'automatic.corrective_publication_result', 'reviewer.packet_hash',
      'reviewer.findings_sha256', 'reviewer.reviewed_git_state.tree_sha', 'reviewer.local.thread_id', 'reviewer.local.turn_id',
      'repository.branch', 'repository.baseline_commit', 'automatic.contract_binding.sha256']) {
      cases.push({ name: `missing original ${field}`, parent: remove([field]) });
    }
    cases.push({ name: 'both corrective publication bindings absent', parent: remove(['automatic.corrective_publication']), mutate: remove(['automatic.corrective_publication']) },
      { name: 'inconsistent parent/child lineage', parent(row) { row.automatic.correction.rejected_tree_sha = 'a'.repeat(40); } });
  }
  const restore = () => {
    for (const [id, text] of originals) c.db.prepare('UPDATE tasks SET value=? WHERE id=?').run(text, id);
    for (const operation of operations) c.db.prepare('INSERT OR REPLACE INTO operations(id,fingerprint,task_id,status) VALUES(?,?,?,?)')
      .run(operation.id, operation.fingerprint, operation.task_id, operation.status);
  };
  try {
    for (const id of ids) assert.equal((await reportingPublication(c, id, client)).confirmed, true);
    for (const item of cases) {
      restore();
      const row = structuredClone(target), parent = structuredClone(original);
      item.mutate?.(row); item.parent?.(parent);
      c.db.prepare('UPDATE tasks SET value=? WHERE id=?').run(JSON.stringify(row), target.id);
      if (mode === 'corrective') c.db.prepare('UPDATE tasks SET value=? WHERE id=?').run(JSON.stringify(parent), original.id);
      if (item.operation) {
        if (item.fault === 'missing') c.db.prepare('DELETE FROM operations WHERE id=?').run(item.operation.id);
        else c.db.prepare('UPDATE operations SET status=?,fingerprint=? WHERE id=?').run(
          item.fault === 'conflicting' ? 'accepted' : item.fault, item.fault === 'conflicting' ? 'a'.repeat(64) : item.operation.fingerprint, item.operation.id);
      }
      const before = ledger(); let writes = 0;
      c.db.setAuthorizer(action => {
        if ([sqlite.SQLITE_INSERT, sqlite.SQLITE_UPDATE, sqlite.SQLITE_DELETE].includes(action)) { writes++; return sqlite.SQLITE_DENY; }
        return sqlite.SQLITE_OK;
      });
      try {
        for (const id of ids) for (let count = 0; count < 2; count++) {
          const result = await reportingPublication(c, id, client);
          assert.equal(result.confirmed, false, item.name); assert.equal(result.live_github_verified, false);
          if (item.unknown || item.name.endsWith('publication.push_attempted')) assert.equal(result.push_attempted, null, item.name);
          if (item.unknown || item.name.endsWith('publication.pr_attempted')) assert.equal(result.pr_attempted, null, item.name);
        }
        assert.equal(writes, 0, item.name); assert.equal(ledger(), before, item.name);
      } finally { c.db.setAuthorizer(null); }
    }
    context.diagnostic(`${mode}: ${cases.length} independently varied negative records; both paginated interfaces, repeated reads.`);
    assert.deepEqual(forbidden, []); assert.deepEqual(publisher.calls, calls);
    assert.equal(await publicationFiles(c.workspaceRoot), files); assert.equal(await publicationFiles(value.normal), source);
    assert.equal(JSON.stringify([c.transactionUnresolved, [...c.persistenceFailures], [...c.jobs.keys()], value.localCalls, api.sent, api.created]), authority);
  } finally {
    restore(); for (const [method, original] of methods) c[method] = original;
    [api.retrieve, api.items.list, api.turns.list] = apiMethods;
  }
  for (const id of ids) await c.cleanup({ task_id: id, delete_workspace: true });
  await c.close();
  const recovered = await new Controller({ stateRoot: c.stateRoot, workspaceRoot: c.workspaceRoot, api, executor: value.executor,
    publisher, secrets: [], localBackendFactory: () => assert.fail('Historical reporting cannot execute a model') }).init();
  try {
    const before = JSON.stringify(recovered.db.prepare('SELECT * FROM tasks ORDER BY id').all()), calls = [...publisher.calls];
    for (const id of ids) for (let count = 0; count < 2; count++) assert.equal((await reportingPublication(recovered, id)).confirmed, true);
    assert.equal(JSON.stringify(recovered.db.prepare('SELECT * FROM tasks ORDER BY id').all()), before); assert.deepEqual(publisher.calls, calls);
  } finally { await recovered.close(); }
});

for (const local of [false, true]) test(`reporting publication preserves confirmed ${local ? 'local' : 'Agents API'} completion and attempt flags on both read-only surfaces`, async context => {
  const { c, id, work, input, review, publisher, api } = await setup(context, ['one.txt'], local);
  await fs.writeFile(path.join(work, 'one.txt'), 'exact\n'); await review(); await c.publish(input);
  const server = createServer(c, async () => {}), client = new Client({ name: 'publication-reporting', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  context.after(async () => { await client.close(); await server.close(); });
  const ledger = () => JSON.stringify(['tasks', 'audit', 'operations', 'automatic_attempts', 'failures'].map(table =>
    c.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  const before = ledger(), calls = [publisher.pushes, publisher.creates, api.created.length, api.sent.length];
  const files = await publicationFiles(c.workspaceRoot), databaseFiles = await publicationFiles(c.stateRoot);
  for (let read = 0; read < 2; read++) {
    const publication = await reportingPublication(c, id, client);
    assert.equal(publication.phase, 'complete');
    assert.equal(publication.push_attempted, true); assert.equal(publication.pr_attempted, true);
    assert.equal(publication.confirmed, true); assert.equal(publication.uncertain, false);
  }
  assert.equal(ledger(), before); assert.deepEqual([publisher.pushes, publisher.creates, api.created.length, api.sent.length], calls);
  assert.equal(await publicationFiles(c.workspaceRoot), files); assert.equal(await publicationFiles(c.stateRoot), databaseFiles);
  await c.cleanup({ task_id: id, delete_workspace: true });
  assert.equal((await reportingPublication(c, id)).confirmed, true);
});

test('reporting publication distinguishes retained pending, uncertain and incomplete completion records', async context => {
  const { c, id, work, input, review, publisher } = await setup(context);
  await fs.writeFile(path.join(work, 'one.txt'), 'exact\n'); await review(); await c.publish(input);
  const completed = c.task(id), calls = [...publisher.calls];
  for (const mutate of [
    task => { task.publication.phase = 'prepared'; task.publication.push_attempted = false; task.publication.pr_attempted = false; },
    task => { task.publication.phase = 'pushed'; task.publication.pr_attempted = false; },
    task => { task.publication.phase = 'pushed'; task.publication_error = 'PR_RESPONSE_UNCONFIRMED'; },
    task => { task.publication.pr_attempted = false; },
    task => { delete task.publication.pr_number; },
    task => { task.publication.reviewed_tree_sha = 'a'.repeat(40); },
    task => { task.publication.review_packet_sha256 = 'a'.repeat(64); },
    task => { task.reviewer.review_result.overall = 'FAIL'; },
    task => { task.reviewer.received_review_output = { complete: false, output: 'ARBITRARY_RAW_LITERAL' }; },
    task => { task.publication_error = 'PR_RESPONSE_UNCONFIRMED'; },
  ]) {
    const task = structuredClone(completed); mutate(task); c.save(task);
    const before = c.db.prepare('SELECT value FROM tasks WHERE id=?').get(id).value;
    for (let read = 0; read < 2; read++) {
      const p = await reportingPublication(c, id);
      assert.equal(p.confirmed, false); assert.equal(p.push_attempted, task.publication.push_attempted);
      assert.equal(p.pr_attempted, task.publication.pr_attempted);
      if (task.publication.phase === 'complete') { assert.equal(p.phase, 'confirmation_pending'); assert.equal(p.uncertain, true); }
      else assert.equal(p.phase, task.publication.phase);
    }
    assert.equal(c.db.prepare('SELECT value FROM tasks WHERE id=?').get(id).value, before);
  }
  c.save(completed); assert.deepEqual(publisher.calls, calls);
});

test('reporting publication does not turn a lost PR response into confirmed publication', async context => {
  const { c, id, work, input, review, publisher } = await setup(context);
  await fs.writeFile(path.join(work, 'one.txt'), 'exact\n'); await review(); publisher.losePRResponse = true;
  await assert.rejects(c.publish(input));
  const calls = [...publisher.calls], before = c.db.prepare('SELECT value FROM tasks WHERE id=?').get(id).value;
  const p = await reportingPublication(c, id);
  assert.equal(p.phase, 'pushed'); assert.equal(p.push_attempted, true); assert.equal(p.pr_attempted, true);
  assert.equal(p.confirmed, false); assert.equal(p.uncertain, true);
  assert.deepEqual(publisher.calls, calls); assert.equal(c.db.prepare('SELECT value FROM tasks WHERE id=?').get(id).value, before);
});

test('authorized corrective publication uses the exact fourth-reviewed tree and original baseline once', async context => {
  const value = await setup(context, ['one.txt'], true, ['cat one.txt'], { versioned: true, corrective: true, publishCorrection: true });
  const parent = await automaticSettled(value), child = value.c.task(parent.automatic.correction.task_id);
  assert.equal(parent.automatic.status, 'succeeded', JSON.stringify({ parent: parent.automatic, child: child.automatic, error: child.publication_error }));
  assert.equal(child.automatic.status, 'succeeded');
  assert.deepEqual(value.localCalls, ['implementer', 'reviewer', 'corrector', 'corrective-reviewer']);
  assert.equal(value.publisher.pushes, 1); assert.equal(value.publisher.creates, 1);
  const p = child.publication;
  assert.equal(repoGit(value.remote, 'rev-parse', `${p.commit_sha}^{tree}`).trim(), child.reviewer.reviewed_git_state.tree_sha);
  assert.equal(repoGit(value.remote, 'rev-parse', `${p.commit_sha}^`).trim(), value.baseline);
  assert.equal(repoGit(value.remote, 'show', `${p.commit_sha}:one.txt`), 'corrected\n');
  assert.notEqual(p.reviewed_tree_sha, parent.reviewer.reviewed_git_state.tree_sha);
  assert.equal(parent.reviewer.review_result.overall, 'FAIL'); assert.equal(child.reviewer.review_result.overall, 'PASS');
  assert.equal(child.local_validation.results[0].stdout.text, 'corrected\n');
  assert.equal(child.deadline, parent.deadline);
  assert.equal(await fs.readFile(path.join(value.work, 'one.txt'), 'utf8'), 'exact\n');
  const originalPacket = await fs.readFile(path.join(value.c.workspaceRoot, parent.id, parent.reviewer.packet_directory, 'evidence.json'), 'utf8');
  assert(value.c.db.prepare('SELECT value FROM automatic_attempts WHERE task_id=?').all(parent.id).some(row => JSON.parse(row.value).packet_utf8 === originalPacket));
  assert.equal(value.publisher.input.title, parent.automatic.authorization.publish.title);
  assert.equal(value.publisher.input.body, parent.automatic.authorization.publish.body);
  for (const id of [parent.id, child.id]) {
    const status = await value.c.get(id);
    assert.equal(status.publication.pr_url, p.pr_url);
    assert.equal(status.correction.publication.confirmed, true);
    assert.equal(status.correction.review.qualified, true); assert.equal(status.correction.review.overall, 'PASS');
    assert.equal(status.correction.codex_turns_attempted, 4);
    assert.equal((await reportingPublication(value.c, id)).confirmed, true);
  }
  await assert.rejects(value.c.publish({ task_id: child.id, title: 'Public denial' }), /CORRECTIVE_PUBLICATION_NOT_AUTHORIZED/);
  await value.c.start(value.startInput); value.c.scheduleAutomatic(parent.id); await Promise.all([...value.c.automaticJobs.values()]);
  assert.equal(value.publisher.pushes, 1); assert.equal(value.publisher.creates, 1); assert.equal(value.localCalls.length, 4);
});

async function correctiveWorkflow(context, mode = {}) {
  const value = await setup(context, ['one.txt'], true, ['cat one.txt'], { versioned: true, corrective: true, publishCorrection: true, ...mode,
    configure(c, input) {
      if (mode.beforePublication) {
        const run = c.runCorrectivePublication.bind(c);
        c.runCorrectivePublication = async (parent, child) => { await mode.beforePublication(c, parent, child); return run(parent, child); };
      }
      mode.configure?.(c, input);
    } });
  const parent = await automaticSettled(value);
  return { ...value, parent, child: parent.automatic.correction ? value.c.task(parent.automatic.correction.task_id) : null };
}

for (const mode of [{ label: 'omitted opt-in', publishCorrection: false }, { label: 'corrective FAIL', correctiveVerdict: 'FAIL' },
  { label: 'malformed', correctiveOutput: '{}' }, { label: 'wrong version', correctiveOutput: '{"overall":"PASS","findings":[]}' },
  { label: 'contradictory PASS', correctiveOutput: JSON.stringify({ format: LOCAL_ACTIONABILITY_REVIEW_VERSION, overall: 'PASS', findings: [
    { id: 'R1', status: 'FAIL', evidence: 'Concrete file defect.', classification: { kind: 'implementation_defect', target_files: ['one.txt'], remedy: { kind: 'edit_files', description: 'Restore the required content.', requires_human_approval: false } } },
    ...['SCOPE', 'TEST_EVIDENCE'].map(id => ({ id, status: 'PASS', evidence: 'Qualified evidence.', classification: null })) ] }) },
  { label: 'missing output', correctiveOutput: '' }, { label: 'uncertain', correctiveUncertain: true }])
test(`corrective publication denies ${mode.label} without a push or another native turn`, async context => {
  const value = await correctiveWorkflow(context, mode);
  assert.equal(value.publisher.pushes, 0); assert.equal(value.publisher.creates, 0); assert.equal(value.localCalls.length, 4);
  assert.notEqual(value.parent.automatic.status, 'succeeded');
  if (mode.correctiveVerdict === 'FAIL') assert.equal(value.child.reviewer.review_result.overall, 'FAIL');
  if (mode.publishCorrection === false) assert.equal(value.parent.automatic.reason, 'CORRECTIVE_REVIEW_RETAINED');
});

test('corrective publication opt-in preserves original PASS publication with no corrective task', async context => {
  const value = await correctiveWorkflow(context, { originalPass: true });
  assert.equal(value.parent.automatic.status, 'succeeded'); assert.equal(value.child, null);
  assert.deepEqual(value.localCalls, ['implementer', 'reviewer']); assert.equal(value.publisher.pushes, 1); assert.equal(value.publisher.creates, 1);
  assert.equal(repoGit(value.remote, 'rev-parse', `${value.parent.publication.commit_sha}^{tree}`).trim(), value.parent.reviewer.reviewed_git_state.tree_sha);
});

for (const mutation of ['authorization', 'contract', 'original contract', 'deadline', 'original deadline', 'original packet', 'corrected packet',
  'original tree object', 'corrected tree object', 'corrected worktree', 'normal checkout', 'registry', 'reviewer identity', 'validation'])
test(`corrective publication revalidates ${mutation} before any publisher operation`, async context => {
  let targets = 0, restore;
  const value = await correctiveWorkflow(context, { publisher(p) { const target = p.target.bind(p); p.target = (...args) => { targets++; return target(...args); }; },
    async beforePublication(c, parentId, childId) {
      const parent = c.task(parentId), child = c.task(childId), root = path.join(c.workspaceRoot, childId);
      if (mutation === 'contract') await fs.writeFile(path.join(root, 'contract.json'), '{}');
      else if (mutation === 'original contract') await fs.writeFile(path.join(c.workspaceRoot, parent.id, 'contract.json'), '{}');
      else if (mutation.endsWith('packet')) {
        const task = mutation === 'original packet' ? parent : child, file = path.join(c.workspaceRoot, task.id, task.reviewer.packet_directory, 'evidence.json');
        await fs.chmod(file, 0o600); await fs.appendFile(file, '\n');
      } else if (mutation.endsWith('tree object')) {
        const task = mutation === 'original tree object' ? parent : child, tree = task.reviewer.reviewed_git_state.tree_sha;
        await fs.rm(path.join(c.workspaceRoot, task.id, 'git-store/objects', tree.slice(0, 2), tree.slice(2)));
      } else if (mutation === 'corrected worktree') await fs.writeFile(path.join(root, 'repo/one.txt'), 'changed\n');
      else if (mutation === 'normal checkout') await fs.writeFile(path.join(child.repository.canonical_path, 'one.txt'), 'owner change\n');
      else if (mutation === 'registry') await fs.writeFile(path.join(c.stateRoot, 'repositories.json'), JSON.stringify({ version: 1, repositories: {} }));
      else {
        const task = ['authorization', 'original deadline'].includes(mutation) ? parent : child;
        const original = JSON.stringify(task); restore = () => c.db.prepare('UPDATE tasks SET value=? WHERE id=?').run(original, task.id);
        if (mutation === 'authorization') task.automatic.authorization.publish_after_correction = false;
        if (mutation.endsWith('deadline')) task.deadline += 1;
        if (mutation === 'reviewer identity') task.reviewer.local.thread_id = parent.reviewer.local.thread_id;
        if (mutation === 'validation') task.local_validation.results[0].completion_observed = false;
        c.db.prepare('UPDATE tasks SET value=? WHERE id=?').run(JSON.stringify(task), task.id);
      }
    } });
  try {
    assert.equal(targets, 0); assert.equal(value.publisher.pushes, 0); assert.equal(value.publisher.creates, 0);
    assert.equal(value.localCalls.length, 4); assert.notEqual(value.parent.automatic.status, 'succeeded');
  } finally { restore?.(); }
});

for (const lost of ['push', 'PR']) test(`corrective publication lost ${lost} acknowledgment remains uncertain without repeated GitHub writes across restart`, async context => {
  const value = await correctiveWorkflow(context, { publisher(p) {
    if (lost === 'push') { const push = p.push.bind(p); p.push = async (...args) => { await push(...args); throw Error('Lost push acknowledgment'); }; }
    else p.losePRResponse = true;
  } });
  assert.equal(value.publisher.pushes, 1); assert.equal(value.publisher.creates, lost === 'PR' ? 1 : 0);
  assert.equal(value.parent.automatic.status, 'uncertain');
  const status = await value.c.get(value.id);
  assert.equal(status.correction.publication.confirmed, false); assert.equal(status.correction.publication.uncertain, true);
  assert.equal(status.correction.publication.push_attempted, true); assert.equal(status.correction.review.overall, 'PASS');
  assert.equal(repoGit(value.remote, 'rev-parse', `${value.child.publication.commit_sha}^{tree}`).trim(), value.child.reviewer.reviewed_git_state.tree_sha);
  await value.c.close();
  const restarted = await new Controller({ stateRoot: path.join(value.root, 'state'), workspaceRoot: path.join(value.root, 'tasks'),
    api: value.api, executor: value.executor, publisher: value.publisher, secrets: [], localBackendFactory: () => assert.fail('Model replay forbidden') }).init();
  context.after(() => restarted.close());
  await restarted.start(value.startInput); restarted.scheduleAutomatic(value.id); await Promise.all([...restarted.automaticJobs.values()]);
  assert.equal((await restarted.get(value.id)).correction.publication.confirmed, false);
  await assert.rejects(restarted.runCorrectivePublication(value.id, value.child.id));
  await assert.rejects(restarted.publish({ task_id: value.child.id, title: 'Public retry' }), /CORRECTIVE_PUBLICATION_NOT_AUTHORIZED/);
  assert.equal(value.publisher.pushes, 1); assert.equal(value.publisher.creates, lost === 'PR' ? 1 : 0); assert.equal(value.localCalls.length, 4);
});

for (const point of ['before reservation', 'after push']) test(`corrective publication expiry ${point} preserves the deadline and stops continuation`, async context => {
  const now = Date.now; let c, deadline;
  try {
    const value = await correctiveWorkflow(context, { configure(controller) { c = controller; },
      beforePublication(controller, parentId) { deadline = controller.task(parentId).deadline; if (point === 'before reservation') Date.now = () => deadline + 1; },
      publisher(p) { const push = p.push.bind(p); p.push = async (...args) => { await push(...args); if (point === 'after push') Date.now = () => deadline + 1; }; } });
    assert.equal(value.publisher.pushes, point === 'after push' ? 1 : 0); assert.equal(value.publisher.creates, 0);
    assert.equal(c.task(value.id).deadline, deadline); assert.equal(value.localCalls.length, 4);
    assert.notEqual(value.parent.automatic.status, 'succeeded');
    if (point === 'after push') assert.equal((await c.get(value.id)).correction.publication.uncertain, true);
  } finally { Date.now = now; }
});

for (const effect of ['ABORT', 'IGNORE']) for (const boundary of ['operation', 'parent reservation', 'child reservation', 'history', 'prepared', 'push intent', 'PR intent', 'completion', 'acceptance', 'parent result'])
test(`corrective publication SQLite ${effect} at ${boundary} cannot fabricate authority or completion`, async context => {
  let hits = 0, evidence;
  const value = await correctiveWorkflow(context, { async beforePublication(c, parentId, childId) {
    await historicalStatus(c, parentId, childId, 'PASS');
    evidence = await retainedReviewEvidence(c, parentId, childId);
  }, configure(c) {
    c.db.function('publication_fault', () => ++hits === 1 ? 1 : 0);
    let table = 'tasks', event = 'INSERT', condition = "json_extract(NEW.value,'$.automatic.corrective_publication.operation_id') IS NOT NULL";
    if (boundary === 'operation' || boundary === 'acceptance') {
      table = 'operations'; event = boundary === 'operation' ? 'INSERT' : 'UPDATE';
      condition = "NEW.id GLOB 'automatic_publish_*'" + (boundary === 'acceptance' ? " AND NEW.status='accepted'" : '');
    } else if (boundary === 'history') {
      table = 'automatic_attempts'; condition = "json_extract(NEW.value,'$.publication.authorization.operation_id') IS NOT NULL AND json_extract(NEW.value,'$.kind')='corrective_execution'";
    } else {
      const predicates = { 'parent reservation': "json_extract(NEW.value,'$.correction') IS NULL AND json_extract(NEW.value,'$.automatic.status')='progressing'",
        'child reservation': "json_extract(NEW.value,'$.correction') IS NOT NULL AND json_extract(NEW.value,'$.publication') IS NULL",
        prepared: "json_extract(NEW.value,'$.publication.phase')='prepared' AND json_extract(NEW.value,'$.publication.push_attempted')=0",
        'push intent': "json_extract(NEW.value,'$.publication.push_attempted')=1", 'PR intent': "json_extract(NEW.value,'$.publication.pr_attempted')=1",
        completion: "json_extract(NEW.value,'$.publication.phase')='complete'",
        'parent result': "json_extract(NEW.value,'$.automatic.corrective_publication_result.pr_number') IS NOT NULL" };
      condition += ` AND (${predicates[boundary]})`;
    }
    c.db.exec(`CREATE TEMP TRIGGER publication_fault_trigger BEFORE ${event} ON ${table} WHEN (${condition}) AND publication_fault() BEGIN SELECT RAISE(${effect}${effect === 'ABORT' ? ", 'Injected publication failure'" : ''}); END;`);
  } });
  assert(hits > 0); value.c.db.exec('DROP TRIGGER publication_fault_trigger');
  context.diagnostic(`SQLite ${effect} trigger fired at ${boundary}: ${hits} matching write(s).`);
  assert.notEqual(value.parent.automatic.status, 'succeeded'); assert.equal(value.localCalls.length, 4);
  assert(value.publisher.pushes <= 1); assert(value.publisher.creates <= 1);
  if (['operation', 'parent reservation', 'child reservation', 'history', 'prepared', 'push intent'].includes(boundary)) assert.equal(value.publisher.pushes, 0);
  assert.notEqual((await value.c.get(value.id)).correction.publication?.confirmed, true);
  assert.equal(value.parent.reviewer.review_result.overall, 'FAIL'); assert(value.child.reviewer.review_result);
  await historicalStatus(value.c, value.id, value.child.id, 'PASS', true);
  assert.deepEqual(await retainedReviewEvidence(value.c, value.id, value.child.id, evidence.rows), evidence);
  const counts = [value.publisher.pushes, value.publisher.creates];
  await value.c.close();
  const restarted = await new Controller({ stateRoot: path.join(value.root, 'state'), workspaceRoot: path.join(value.root, 'tasks'), api: value.api,
    executor: value.executor, publisher: value.publisher, secrets: [], localBackendFactory: () => assert.fail('Publication failure must not replay models') }).init();
  context.after(() => restarted.close());
  await restarted.start(value.startInput); restarted.scheduleAutomatic(value.id); await Promise.all([...restarted.automaticJobs.values()]);
  assert.notEqual((await restarted.get(value.id)).correction.publication?.confirmed, true);
  assert.deepEqual([value.publisher.pushes, value.publisher.creates], counts);
  await historicalStatus(restarted, value.id, value.child.id, 'PASS', true);
  assert.deepEqual(await retainedReviewEvidence(restarted, value.id, value.child.id, evidence.rows), evidence);
  assert.equal(value.localCalls.length, 4); assert.equal(restarted.task(value.id).deadline, evidence.deadline);
});

test('corrective publication duplicate dispatch cannot reserve or publish another draft', async context => {
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
  const value = await setup(context, ['one.txt'], true, ['cat one.txt'], { versioned: true, corrective: true, publishCorrection: true,
    publisher(p) { const target = p.target.bind(p); p.target = async (...args) => { entered(); await held; return target(...args); }; } });
  await ready;
  const parent = value.c.task(value.id), child = value.c.task(parent.automatic.correction.task_id);
  try { await assert.rejects(value.c.runCorrectivePublication(parent.id, child.id), /AUTOMATIC_PUBLICATION_REPLAY_FORBIDDEN/); }
  finally { release(); }
  await automaticSettled(value);
  await assert.rejects(value.c.runCorrectivePublication(parent.id, child.id));
  assert.equal(value.publisher.pushes, 1); assert.equal(value.publisher.creates, 1); assert.equal(value.localCalls.length, 4);
});

test('corrective publication restart after a committed reservation requires attention without writes or replay', async context => {
  let snapshot;
  const value = await correctiveWorkflow(context, { configure(c) {
    const save = c.save.bind(c);
    c.save = (task, options) => {
      save(task, options);
      if (!snapshot && task.correction && task.automatic?.corrective_publication && !task.publication) {
        snapshot = { child: structuredClone(task), parent: c.task(task.correction.parent_task_id) };
        throw Error('Simulated process interruption after committed reservation');
      }
    };
  } });
  assert(snapshot); assert.equal(value.publisher.pushes, 0); assert.equal(value.publisher.creates, 0);
  await value.c.close();
  const db = new DatabaseSync(path.join(value.root, 'state/controller.sqlite'));
  for (const task of [snapshot.parent, snapshot.child]) db.prepare('UPDATE tasks SET value=? WHERE id=?').run(JSON.stringify(task), task.id);
  db.prepare('UPDATE operations SET status=? WHERE id=?').run('reserved', snapshot.child.automatic.publish_request_id); db.close();
  const restarted = await new Controller({ stateRoot: path.join(value.root, 'state'), workspaceRoot: path.join(value.root, 'tasks'),
    api: value.api, executor: value.executor, publisher: value.publisher, secrets: [], localBackendFactory: () => assert.fail('Reserved publication cannot replay models') }).init();
  context.after(() => restarted.close());
  await restarted.start(value.startInput); restarted.scheduleAutomatic(value.id); await Promise.all([...restarted.automaticJobs.values()]);
  const status = await restarted.get(value.id);
  assert.equal(status.correction.publication.confirmed, false); assert.equal(status.correction.publication.uncertain, true);
  assert.equal(value.publisher.pushes, 0); assert.equal(value.publisher.creates, 0); assert.equal(value.localCalls.length, 4);
});

async function publicationFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const name of (await fs.readdir(directory)).sort()) {
      const file = path.join(directory, name), stat = await fs.lstat(file);
      files.push([path.relative(root, file), stat.mode, stat.mtimeMs, stat.ctimeMs,
        stat.isFile() ? digest((await fs.readFile(file)).toString('base64')) : stat.isSymbolicLink() ? await fs.readlink(file) : null]);
      if (stat.isDirectory()) await visit(file);
    }
  }
  await visit(root); return digest(files);
}

async function retainedReviewEvidence(c, parentId, childId, originalRows) {
  const parent = c.task(parentId), child = c.task(childId);
  const rows = c.db.prepare('SELECT task_id,attempt_id,observation_sha256,value FROM automatic_attempts WHERE task_id=? OR task_id=?').all(parentId, childId);
  const selected = originalRows ? originalRows.map(prior => {
    assert(rows.some(row => JSON.stringify(row) === JSON.stringify(prior)), 'A prior evidence observation disappeared'); return prior;
  }) : rows;
  return { deadline: parent.deadline, lineage: child.correction, tree: child.reviewer.reviewed_git_state.tree_sha,
    original_packet: await fs.readFile(path.join(c.workspaceRoot, parentId, parent.reviewer.packet_directory, 'evidence.json'), 'utf8'),
    packet: await fs.readFile(path.join(c.workspaceRoot, childId, child.reviewer.packet_directory, 'evidence.json'), 'utf8'),
    findings: JSON.stringify(child.reviewer.review_result), validation: JSON.stringify(child.local_validation), rows: selected };
}

async function historicalStatus(c, parentId, childId, overall, publicationUncertain = false, readUnavailable = false) {
  clearInterval(c.sweeper);
  let authorizations = 0, writes = 0, readFailures = 0;
  const server = createServer(c, async () => { authorizations++; }), client = new Client({ name: 'retained-review-status', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  const ledger = () => JSON.stringify(['tasks', 'audit', 'operations', 'automatic_attempts', 'failures'].map(table => c.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  const before = ledger(), files = await publicationFiles(c.workspaceRoot), source = await publicationFiles(c.task(childId).repository.canonical_path);
  const calls = [...c.publisher.calls], mutations = new Set([sqlite.SQLITE_INSERT, sqlite.SQLITE_UPDATE, sqlite.SQLITE_DELETE]);
  c.db.setAuthorizer((action, table) => {
    if (mutations.has(action)) { writes++; return sqlite.SQLITE_DENY; }
    if (readUnavailable && action === sqlite.SQLITE_READ && table === 'automatic_attempts') { readFailures++; return sqlite.SQLITE_DENY; }
    return sqlite.SQLITE_OK;
  });
  try {
    for (const id of [parentId, childId]) {
      const result = await client.callTool({ name: 'get_task', arguments: { task_id: id } });
      if (readUnavailable && result.isError) { assert.equal(result.structuredContent, undefined); continue; }
      assert.notEqual(result.isError, true);
      const view = result.structuredContent, review = view.correction.review;
      assert.equal(review.overall, overall, `Historical review for ${id}: ${JSON.stringify(review)}`);
      assert.equal(review.qualified, overall !== null); assert.equal(review.evidence, overall === null ? 'unavailable' : 'retained');
      assert.equal(review.current_authority_verified, false);
      assert.equal(review.execution_authorized, false); assert.equal(review.publication_authorized, false);
      assert.equal(view.correction.execution_authorized, false);
      if (!readUnavailable) assert.equal(view.correction.codex_turns_attempted, 4);
      if (publicationUncertain) {
        assert.notEqual(view.correction.publication?.confirmed, true);
        if (view.correction.publication) { assert.equal(view.correction.publication.uncertain, true); assert.equal(view.correction.publication.execution_authorized, false); }
        assert.equal(view.automatic.status, 'uncertain');
      }
    }
    assert.equal(authorizations, 2); assert.equal(writes, 0); c.db.setAuthorizer(null); assert.equal(ledger(), before);
    if (readUnavailable) assert(readFailures > 0);
    assert.equal(await publicationFiles(c.workspaceRoot), files); assert.equal(await publicationFiles(c.task(childId).repository.canonical_path), source);
    assert.deepEqual(c.publisher.calls, calls);
  } finally { c.db.setAuthorizer(null); await client.close(); await server.close(); }
}

test('historical corrective review remains fail closed on missing or conflicting proof after publication failure', async context => {
  let hits = 0;
  const value = await correctiveWorkflow(context, { configure(c) {
    c.db.function('publication_fault', () => ++hits === 1 ? 1 : 0);
    c.db.exec(`CREATE TEMP TRIGGER publication_fault_trigger BEFORE INSERT ON tasks
      WHEN json_extract(NEW.value,'$.publication.phase')='prepared' AND publication_fault()
      BEGIN SELECT RAISE(ABORT, 'Injected publication failure'); END;`);
  } });
  const { c, id, child } = value; c.db.exec('DROP TRIGGER publication_fault_trigger'); assert(hits > 0);
  await historicalStatus(c, id, child.id, 'PASS', true);
  assert.equal((await c.retainedCorrectiveReview(c.task(child.id))).overall, 'PASS');
  const evidence = await retainedReviewEvidence(c, id, child.id), calls = [...value.localCalls];
  for (const fault of ['missing review', 'result hash', 'reviewed tree', 'lineage', 'contract binding', 'reviewer identity', 'validation']) {
    await context.test(fault, async () => {
      const task = c.task(fault === 'contract binding' ? id : child.id), original = JSON.stringify(task);
      if (fault === 'missing review') task.reviewer.review_result = null;
      if (fault === 'result hash') task.reviewer.findings_sha256 = '0'.repeat(64);
      if (fault === 'reviewed tree') task.reviewer.reviewed_git_state.tree_sha = '0'.repeat(40);
      if (fault === 'lineage') task.correction.findings_sha256 = '0'.repeat(64);
      if (fault === 'contract binding') task.automatic.contract_binding.contract.goal = 'Changed original authority';
      if (fault === 'reviewer identity') task.reviewer.local.thread_id = task.implementer.local.thread_id;
      if (fault === 'validation') task.local_validation.results = [];
      c.db.prepare('UPDATE tasks SET value=? WHERE id=?').run(JSON.stringify(task), task.id);
      try { await historicalStatus(c, id, child.id, null, true); }
      finally { c.db.prepare('UPDATE tasks SET value=? WHERE id=?').run(original, task.id); }
    });
  }
  for (const taskId of [id, child.id]) await context.test(taskId === id ? 'original packet' : 'fourth packet', async () => {
    const task = c.task(taskId), file = path.join(c.workspaceRoot, taskId, task.reviewer.packet_directory, 'evidence.json');
    const bytes = await fs.readFile(file), mode = (await fs.stat(file)).mode & 0o777;
    await fs.chmod(file, 0o600); await fs.writeFile(file, '{}'); await fs.chmod(file, mode);
    try {
      // Public reporting qualifies retained history; the existing current
      // verifier must independently continue rejecting the altered live packet.
      await assert.rejects(c.retainedCorrectiveReview(c.task(child.id)));
      await historicalStatus(c, id, child.id, 'PASS', true);
    }
    finally { await fs.chmod(file, 0o600); await fs.writeFile(file, bytes); await fs.chmod(file, mode); }
  });
  for (const kind of ['review_result', 'review_packet', 'corrective_execution']) await context.test(`missing retained ${kind}`, async () => {
    const rows = c.db.prepare('SELECT * FROM automatic_attempts WHERE task_id=? AND json_extract(value,\'$.kind\')=?').all(child.id, kind);
    assert(rows.length > 0);
    c.db.prepare('DELETE FROM automatic_attempts WHERE task_id=? AND json_extract(value,\'$.kind\')=?').run(child.id, kind);
    try { await historicalStatus(c, id, child.id, null, true); }
    finally { for (const row of rows) c.db.prepare('INSERT INTO automatic_attempts VALUES (?,?,?,?)').run(row.task_id, row.attempt_id, row.observation_sha256, row.value); }
  });
  await context.test('storage reads unavailable', () => historicalStatus(c, id, child.id, null, true, true));
  await context.test('missing corrected Git tree', async () => {
    const tree = child.reviewer.reviewed_git_state.tree_sha, file = path.join(c.workspaceRoot, child.id, 'git-store/objects', tree.slice(0, 2), tree.slice(2));
    const bytes = await fs.readFile(file), mode = (await fs.stat(file)).mode & 0o777; await fs.rm(file);
    try {
      await assert.rejects(c.retainedCorrectiveReview(c.task(child.id)));
      await historicalStatus(c, id, child.id, 'PASS', true);
      await assert.rejects(fs.stat(file), { code: 'ENOENT' });
    }
    finally { await fs.writeFile(file, bytes, { mode }); }
  });
  await context.test('later expiry does not erase historical qualification or renew authority', async () => {
    const now = Date.now; Date.now = () => evidence.deadline + 1;
    try { await historicalStatus(c, id, child.id, 'PASS', true); }
    finally { Date.now = now; }
    assert.equal(c.task(id).deadline, evidence.deadline);
  });
  await historicalStatus(c, id, child.id, 'PASS', true);
  assert.deepEqual(await retainedReviewEvidence(c, id, child.id, evidence.rows), evidence);
  assert.deepEqual(value.localCalls, calls); assert.equal(value.publisher.pushes, 0); assert.equal(value.publisher.creates, 0);
  await c.close();
  const restarted = await new Controller({ stateRoot: path.join(value.root, 'state'), workspaceRoot: c.workspaceRoot, api: value.api,
    executor: value.executor, publisher: value.publisher, secrets: [], localBackendFactory: () => assert.fail('Historical verification cannot replay models') }).init();
  context.after(() => restarted.close());
  await historicalStatus(restarted, id, child.id, 'PASS', true);
  assert.equal((await restarted.retainedCorrectiveReview(restarted.task(child.id))).overall, 'PASS');
  await context.test('packet integrity after restart', async () => {
    const packet = path.join(c.workspaceRoot, child.id, child.reviewer.packet_directory, 'evidence.json'), bytes = await fs.readFile(packet);
    await fs.chmod(packet, 0o600); await fs.writeFile(packet, '{}'); await fs.chmod(packet, 0o400);
    try {
      await assert.rejects(restarted.retainedCorrectiveReview(restarted.task(child.id)));
      await historicalStatus(restarted, id, child.id, 'PASS', true);
    }
    finally { await fs.chmod(packet, 0o600); await fs.writeFile(packet, bytes); await fs.chmod(packet, 0o400); }
  });
  await historicalStatus(restarted, id, child.id, 'PASS', true);
  await context.test('changed corrected worktree after restart', async () => {
    await fs.writeFile(path.join(c.workspaceRoot, child.id, 'repo/one.txt'), 'Changed after qualified review\n');
    await assert.rejects(restarted.retainedCorrectiveReview(restarted.task(child.id)));
    await historicalStatus(restarted, id, child.id, 'PASS', true);
  });
  await restarted.start(value.startInput); restarted.scheduleAutomatic(id); await Promise.all([...restarted.automaticJobs.values()]);
  assert.deepEqual(value.localCalls, calls); assert.equal(value.publisher.pushes, 0); assert.equal(value.publisher.creates, 0);
});

test('retained corrective FAIL remains qualified after later attention and Controller restart', async context => {
  const value = await correctiveWorkflow(context, { correctiveVerdict: 'FAIL' }), { c, id, child } = value;
  await historicalStatus(c, id, child.id, 'FAIL');
  c.persistenceFailures.add(id); c.persistenceFailures.add(child.id); c.persistenceAttention(id); c.persistenceAttention(child.id);
  await historicalStatus(c, id, child.id, 'FAIL', true);
  await c.close();
  const restarted = await new Controller({ stateRoot: path.join(value.root, 'state'), workspaceRoot: c.workspaceRoot, api: value.api,
    executor: value.executor, publisher: value.publisher, secrets: [], localBackendFactory: () => assert.fail('Historical FAIL cannot replay models') }).init();
  context.after(() => restarted.close());
  await historicalStatus(restarted, id, child.id, 'FAIL', true);
  assert.equal(value.localCalls.length, 4); assert.equal(value.publisher.pushes, 0); assert.equal(value.publisher.creates, 0);
});

for (const uncertain of [false, true]) test(`corrective publication parent and child MCP status are observational; uncertain=${uncertain}`, async context => {
  const value = await correctiveWorkflow(context, uncertain ? { publisher(p) { p.losePRResponse = true; } } : {}), { c, parent, child } = value;
  assert.equal(parent.automatic.status, uncertain ? 'uncertain' : 'succeeded');
  // Periodic pruning is separate from the request under observation.
  clearInterval(c.sweeper);
  const server = createServer(c, async () => { authorizations++; }), client = new Client({ name: 'corrective-publication-status', version: '1' });
  let authorizations = 0;
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  context.after(async () => { await client.close(); await server.close(); });
  const ledger = () => JSON.stringify(['tasks', 'audit', 'operations', 'automatic_attempts', 'failures'].map(table => c.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  const rows = ledger(), source = await publicationFiles(value.normal), workspaces = await publicationFiles(c.workspaceRoot);
  const publisherCalls = [...value.publisher.calls];
  let writes = 0;
  const mutations = new Set([sqlite.SQLITE_INSERT, sqlite.SQLITE_UPDATE, sqlite.SQLITE_DELETE]);
  c.db.setAuthorizer(action => { if (mutations.has(action)) { writes++; return sqlite.SQLITE_DENY; } return sqlite.SQLITE_OK; });
  try {
    await assert.rejects(c.expire()); assert.equal(writes, 1); writes = 0;
    for (const id of [parent.id, child.id, parent.id, child.id]) {
      const response = await client.callTool({ name: 'get_task', arguments: { task_id: id } }); assert.notEqual(response.isError, true);
      assert.equal(response.structuredContent.correction.publication.confirmed, !uncertain);
      assert.equal(response.structuredContent.correction.review.overall, 'PASS'); assert.equal(response.structuredContent.correction.review.qualified, true);
      assert.equal(response.structuredContent.correction.codex_turns_attempted, 4);
    }
    assert.equal(writes, 0); assert.equal(authorizations, 4); assert.equal(ledger(), rows);
    assert.equal(await publicationFiles(value.normal), source); assert.equal(await publicationFiles(c.workspaceRoot), workspaces);
    assert.deepEqual(value.publisher.calls, publisherCalls);
    if (!uncertain) {
      const tree = child.reviewer.reviewed_git_state.tree_sha, object = path.join(c.workspaceRoot, child.id, 'git-store/objects', tree.slice(0, 2), tree.slice(2));
      await fs.rm(object);
      const missing = await publicationFiles(c.workspaceRoot);
      for (const id of [parent.id, child.id]) {
        const response = await client.callTool({ name: 'get_task', arguments: { task_id: id } }); assert.notEqual(response.isError, true);
        assert.equal(response.structuredContent.correction.review.qualified, true);
        assert.equal(response.structuredContent.correction.review.current_authority_verified, false);
        assert.equal(response.structuredContent.correction.review.overall, 'PASS');
        assert.equal(response.structuredContent.correction.publication.confirmed, true);
        assert.equal((await c.correctiveReviewSummary(child)).qualified, false);
        assert.equal(response.structuredContent.correction.publication.execution_authorized, false);
      }
      await assert.rejects(fs.stat(object), { code: 'ENOENT' });
      assert.equal(writes, 0); assert.equal(ledger(), rows); assert.equal(await publicationFiles(c.workspaceRoot), missing);
      assert.equal(await publicationFiles(value.normal), source); assert.deepEqual(value.publisher.calls, publisherCalls);
    }
  } finally { c.db.setAuthorizer(null); }
  assert.equal(value.publisher.pushes, 1); assert.equal(value.publisher.creates, 1); assert.equal(value.localCalls.length, 4);
});

for (const corrupt of ['child publication', 'parent linkage']) test(`corrective publication status rejects conflicting ${corrupt} without repairing evidence`, async context => {
  const value = await correctiveWorkflow(context), { c, parent, child } = value;
  const task = structuredClone(corrupt === 'child publication' ? child : parent), original = JSON.stringify(task);
  if (corrupt === 'child publication') task.publication.commit_sha = '0'.repeat(40);
  else task.automatic.corrective_publication_result.commit_sha = '0'.repeat(40);
  c.db.prepare('UPDATE tasks SET value=? WHERE id=?').run(JSON.stringify(task), task.id);
  try {
    for (const id of [parent.id, child.id]) {
      const status = await c.get(id); assert.equal(status.correction.publication.confirmed, false);
      assert.equal(status.correction.publication.uncertain, true); assert.equal(status.automatic.status, 'uncertain');
    }
    assert.equal(c.db.prepare('SELECT value FROM tasks WHERE id=?').get(task.id).value, JSON.stringify(task));
    assert.equal(value.publisher.pushes, 1); assert.equal(value.publisher.creates, 1);
  } finally { c.db.prepare('UPDATE tasks SET value=? WHERE id=?').run(original, task.id); }
});

test('snapshot and publication state await the selected Git runner without changing the captured state', async context => {
  const { normal } = await setup(context), safeGit = asynchronousRepoGit(AbortSignal.timeout(10000));
  assert.deepEqual(await gitState(normal, x => x, safeGit), await gitState(normal, x => x));
  const snapshot = await checkoutSnapshot(normal, x => x), safeSnapshot = await checkoutSnapshot(normal, x => x, safeGit);
  assert.equal(snapshot.status, 'captured');
  delete snapshot.captured_at; delete safeSnapshot.captured_at;
  assert.deepEqual(safeSnapshot, snapshot);
  assert.deepEqual(await publicationState(normal, safeGit), await publicationState(normal));
});

for (const failure of ['interrupted', 'status_error']) test(`snapshot and publication state never fall back after ${failure}`, async context => {
  const { normal } = await setup(context), safeGit = asynchronousRepoGit(AbortSignal.abort());
  const selected = failure === 'interrupted' ? safeGit : async (cwd, ...args) => {
    if (args[0] === 'status') throw Error('Unavailable status evidence');
    return asynchronousRepoGit()(cwd, ...args);
  };
  const before = await publicationState(normal);
  const snapshot = await checkoutSnapshot(normal, x => x, selected);
  assert.equal(snapshot.status, 'unavailable');
  await assert.rejects(publicationState(normal, selected), /PUBLICATION_SNAPSHOT_UNAVAILABLE/);
  assert.deepEqual(await publicationState(normal), before);
});

test('explicit versioned automatic PASS uses authenticated findings and exact-tree draft publication', async context => {
  const value = await setup(context, ['one.txt'], true, ['test "$(cat one.txt)" = exact'], { versioned: true });
  const task = await automaticSettled(value), { c, id, publisher, remote } = value;
  assert.equal(task.automatic.status, 'succeeded', JSON.stringify(task.automatic));
  assert.equal(task.reviewer.review_result.validation_contract, LOCAL_ACTIONABILITY_REVIEW_VERSION);
  assert.equal(task.reviewer.review_result.actionability_qualification.execution_authorized, false);
  assert.deepEqual(task.reviewer.review_result.controller_context, { reviewerIndependent: true, executionQualified: true, authorityValid: true, uncertaintyFree: true });
  assert.deepEqual(value.localPrompts, [localActionabilityReviewerInstructions]); assert.deepEqual(value.localCalls, ['implementer', 'reviewer']);
  assert.equal(publisher.pushes, 1); assert.equal(publisher.creates, 1); assert.equal(publisher.pr.draft, true);
  assert.equal(repoGit(remote, 'rev-parse', `${task.publication.commit_sha}^{tree}`).trim(), task.reviewer.reviewed_git_state.tree_sha);
  assert.equal(repoGit(remote, 'rev-parse', 'main').trim(), value.baseline); assert.equal(value.api.created.length, 0);
  assert.equal(task.deadline, task.automatic.review_authorization.deadline);
  assert.equal((await reportingPublication(c, id)).confirmed, true);
  for (const view of [await c.get(id), await c.start(value.startInput)]) {
    assert.equal(view.automatic.review.state, 'pass'); assert.equal(view.automatic.usage.correction_turns, 0); assert.equal(view.automatic.review.execution_authorized, false);
  }
  assert.equal(publisher.pushes, 1); assert.equal(publisher.creates, 1);
});

test('versioned automatic FAIL never invokes the publisher despite potential actionability', async context => {
  const value = await setup(context, ['one.txt'], true, [], { versioned: true, verdict: 'FAIL' }), task = await automaticSettled(value);
  assert.equal(task.automatic.status, 'stopped'); assert.equal(task.reviewer.review_result.actionability_qualification.potentially_correctable, true);
  assert.deepEqual(value.localCalls, ['implementer', 'reviewer']); assert.equal(value.publisher.pushes, 0); assert.equal(value.publisher.creates, 0);
  assert.equal((await value.c.get(value.id)).automatic.usage.correction_turns, 0);
});

test('explicit 3/1 authority preserves exact-tree initial PASS draft publication without correction', async context => {
  const value = await setup(context, ['one.txt'], true, [], { versioned: true, configure(c, input) {
    Object.assign(input.automatic, { max_codex_turns: 3, max_corrections: 1 });
  } });
  const task = await automaticSettled(value);
  assert.equal(task.automatic.status, 'succeeded'); assert.equal(task.automatic.correction, undefined);
  assert.deepEqual(value.localCalls, ['implementer', 'reviewer']);
  assert.equal(value.publisher.pushes, 1); assert.equal(value.publisher.creates, 1); assert.equal(value.publisher.pr.draft, true);
  assert.equal(repoGit(value.remote, 'rev-parse', `${task.publication.commit_sha}^{tree}`).trim(), task.reviewer.reviewed_git_state.tree_sha);
  assert.equal(task.deadline, task.automatic.review_authorization.deadline);
});

for (const field of ['thread', 'turn', 'packet', 'tree', 'version', 'context']) test(`versioned publication rejects stale ${field} binding before push`, async context => {
  let controlled, original, injected = false;
  const value = await setup(context, ['one.txt'], true, [], { versioned: true, configure(c) { controlled = c; }, publisher(publisher) {
    const target = publisher.target.bind(publisher);
    publisher.target = async (...args) => {
      const result = await target(...args), task = JSON.parse(controlled.db.prepare('SELECT value FROM tasks').get().value);
      original = JSON.stringify(task);
      if (field === 'thread') task.reviewer.local.thread_id = 'different-thread';
      if (field === 'turn') task.reviewer.local.turn_id = 'different-turn';
      if (field === 'packet') task.reviewer.packet_hash = '0'.repeat(64);
      if (field === 'tree') task.reviewer.reviewed_git_state.tree_sha = '0'.repeat(40);
      if (field === 'version') task.reviewer.review_result.validation_contract = 'pab.local-review.v2';
      if (field === 'context') task.reviewer.review_result.controller_context.authorityValid = false;
      // Fault injection changes only this fixture's ledger. Even an updated task
      // hash cannot replace the independently retained original review record.
      task.reviewer.findings_sha256 = digest(task.reviewer.review_result);
      controlled.db.prepare('UPDATE tasks SET value=? WHERE id=?').run(JSON.stringify(task), task.id); injected = true;
      return result;
    };
  } });
  const task = await automaticSettled(value);
  assert(injected);
  const view = await value.c.get(value.id);
  assert(['stopped', 'uncertain'].includes(view.automatic.status)); assert.equal(value.publisher.pushes, 0); assert.equal(value.publisher.creates, 0);
  assert.deepEqual(value.localCalls, ['implementer', 'reviewer']); assert.equal(view.automatic.usage.correction_turns, 0);
  // Explicitly restore this test's injected corruption for resource teardown;
  // the Controller does not repair or replay an uncertain operation itself.
  controlled.db.prepare('UPDATE tasks SET value=? WHERE id=?').run(original, value.id);
});

async function automaticSettled(value) {
  await Promise.all([...value.c.automaticJobs.values()]);
  return value.c.task(value.id);
}

test('authorized automatic task validates, independently reviews and publishes the exact tree without observation driving work', async context => {
  const value = await setup(context, ['one.txt'], true, ['test "$(cat one.txt)" = exact'], {});
  const task = await automaticSettled(value), { c, publisher, remote, baseline, id } = value;
  assert.equal(task.automatic.status, 'succeeded', JSON.stringify(task.automatic));
  assert.equal(task.deadline, task.automatic.deadline);
  assert.deepEqual(value.localCalls, ['implementer', 'reviewer']);
  assert.equal(task.local_validation.results[0].status, 'passed');
  assert.equal(task.local_validation.termination_confirmed, true);
  assert.equal(task.reviewer.review_result.overall, 'PASS');
  assert.notEqual(task.implementer.local.thread_id, task.reviewer.local.thread_id);
  assert.equal(task.implementer.local.server_closed, true); assert.equal(task.reviewer.local.server_closed, true);
  assert.equal(repoGit(remote, 'rev-parse', `${task.publication.commit_sha}^{tree}`).trim(), task.reviewer.reviewed_git_state.tree_sha);
  assert.equal(repoGit(remote, 'rev-parse', 'main').trim(), baseline);
  assert.equal(task.publication.draft, undefined);
  assert.equal(publisher.pr.draft, true); assert.equal(publisher.pushes, 1); assert.equal(publisher.creates, 1);
  assert.equal(value.api.created.length, 0); assert.equal(value.executor.started.length, 0);
  const before = JSON.stringify(c.db.prepare('SELECT * FROM tasks').all());
  const views = await Promise.all([c.get(id), c.get(id), c.start(value.startInput)]);
  assert(views.every(view => view.state === 'succeeded' && view.publication.draft));
  assert.equal(JSON.stringify(c.db.prepare('SELECT * FROM tasks').all()), before);
  assert.deepEqual(views[0].automatic.usage, { implementer_turn_submissions_attempted: 1, reviewer_turn_submissions_attempted: 1,
    correction_turns: 0, token_usage: null, subscription_billing_attribution: 'unverified' });
  assert.equal(c.db.prepare('SELECT status FROM operations WHERE id=?').get(task.automatic.publish_request_id).status, 'accepted');
  const audit = c.db.prepare('SELECT value FROM audit').all().map(row => JSON.parse(row.value));
  assert(audit.some(row => row.tool === 'review_task' && row.codex_thread_id === task.reviewer.local.thread_id));
  assert(audit.some(row => row.tool === 'publish_task' && row.publication.commit_sha === task.publication.commit_sha));
  await assert.rejects(c.review({ task_id: id, request_id: 'manual_duplicate' }), /AUTOMATIC_TASK_OWNS_TRANSITIONS/);
  await assert.rejects(c.publish(value.input), /AUTOMATIC_TASK_OWNS_TRANSITIONS/);
  await assert.rejects(c.continue({ task_id: id, request_id: 'manual_continue' }), /AUTOMATIC_TASK_OWNS_TRANSITIONS/);
  await assert.rejects(c.start({ ...value.startInput, automatic: { ...value.startInput.automatic, publish: { title: 'Changed authority', draft: true } } }), /REQUEST_ID_REUSED/);
  assert.equal(publisher.pushes, 1); assert.equal(publisher.creates, 1);
  await c.cleanup({ task_id: id });
  assert.equal((await c.get(id)).automatic.status, 'succeeded');
});

for (const [label, commands, mode, expectedCalls] of [
  ['failed independent test', ['exit 1'], {}, ['implementer']],
  ['review FAIL', [], { verdict: 'FAIL' }, ['implementer', 'reviewer']],
  ['invalid findings', [], { reviewOutput: '{"overall":"PASS","findings":[]}' }, ['implementer', 'reviewer']],
  ['failed implementation', [], { result: { status: 'failed' } }, ['implementer']],
  ['uncertain implementation', [], { result: { status: 'uncertain', terminalObserved: false } }, ['implementer']],
  ['unconfirmed implementer closure', [], { closeFailure: 'implementer' }, ['implementer']],
  ['unconfirmed reviewer closure', [], { closeFailure: 'reviewer' }, ['implementer', 'reviewer']],
  ['execution uncertainty', [], { result: { uncertainties: ['Unknown command execution'] } }, ['implementer']],
  ['protected path mutation', [], { implementation: async options => fs.appendFile(path.join(options.cwd, 'TASK.md'), '\nmutated') }, ['implementer']],
  ['candidate mutation during review', [], { review: async options => fs.appendFile(path.join(options.cwd, '..', 'repo', 'one.txt'), 'changed') }, ['implementer', 'reviewer']],
]) test(`automatic ${label} stops without publication or correction`, async context => {
  const value = await setup(context, ['one.txt'], true, commands, mode), task = await automaticSettled(value);
  assert(['stopped', 'uncertain'].includes(task.automatic.status), JSON.stringify(task.automatic));
  assert(task.automatic.reason); assert.equal(task.automatic.human_attention_required, true);
  assert.deepEqual(value.localCalls, expectedCalls);
  assert.equal(value.publisher.pushes, 0); assert.equal(value.publisher.creates, 0);
  await value.c.get(value.id); await value.c.start(value.startInput);
  assert.deepEqual(value.localCalls, expectedCalls);
  assert.equal(task.deadline, task.automatic.deadline);
});

for (const method of ['item/commandExecution/requestApproval', 'item/tool/requestUserInput']) test(`automatic native ${method} stops and never supplies a human response`, async context => {
  const value = await setup(context, ['one.txt'], true, [], { implementation: async (options, identity, input) => {
    options.onLifecycle({ ...identity, phase: 'human_request', request: { id: 7, method,
      params: { threadId: identity.threadId, turnId: identity.turnId, command: 'printf harmless',
        ...(method.endsWith('requestUserInput') ? { questions: [{ id: 'choice', question: 'Which value?' }] } : {}) } } });
    assert.equal(input.signal.aborted, true);
  } });
  const task = await automaticSettled(value);
  assert.equal(task.automatic.status, 'stopped'); assert.equal(task.automatic.reason, 'AUTOMATIC_HUMAN_ATTENTION_REQUIRED');
  assert.equal(task.implementer.local.human_requests.length, 1); assert.equal(task.implementer.local.human_requests[0].delivery, 'not_attempted');
  assert.deepEqual(value.localCalls, ['implementer']); assert.equal(value.publisher.pushes, 0);
});

test('concurrent manual requests cannot race automatic review and publication', async context => {
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const value = await setup(context, ['one.txt'], true, [], { review: async () => { entered(); await new Promise(resolve => { release = resolve; }); } });
  await ready;
  const results = await Promise.allSettled([value.c.review({ task_id: value.id, request_id: 'competing_review' }), value.c.publish(value.input),
    value.c.start(value.startInput), value.c.start(value.startInput)]);
  assert(results.slice(0, 2).every(result => result.status === 'rejected' && result.reason.code === 'AUTOMATIC_TASK_OWNS_TRANSITIONS'));
  assert(results.slice(2).every(result => result.status === 'fulfilled' && result.value.task_id === value.id));
  release(); assert.equal((await automaticSettled(value)).automatic.status, 'succeeded');
  assert.deepEqual(value.localCalls, ['implementer', 'reviewer']); assert.equal(value.publisher.creates, 1);
});

test('uncertain GitHub publication is not replayed by observations, retries or restart', async context => {
  const value = await setup(context, ['one.txt'], true, [], { publisher: publisher => { publisher.losePRResponse = true; } });
  const task = await automaticSettled(value);
  assert.equal(task.automatic.status, 'uncertain'); assert.equal(task.publication.pr_attempted, true);
  assert.equal(value.publisher.creates, 1); assert.equal(value.publisher.pushes, 1);
  await value.c.start(value.startInput); await value.c.get(value.id);
  await assert.rejects(value.c.publish(value.input), /AUTOMATIC_TASK_OWNS_TRANSITIONS/);
  await value.c.close();
  const restarted = await new Controller({ stateRoot: value.c.stateRoot, workspaceRoot: value.c.workspaceRoot, api: value.api,
    publisher: value.publisher, secrets: [], localBackendFactory: () => { throw Error('REPLAY FORBIDDEN'); } }).init();
  try {
    assert.equal((await restarted.get(value.id)).automatic.status, 'uncertain');
    assert.equal(restarted.automaticJobs.size, 0); assert.equal(value.publisher.creates, 1); assert.equal(value.publisher.pushes, 1);
  } finally { await restarted.close(); }
});

test('overall deadline expires during review without renewal or publication', async context => {
  const value = await setup(context, ['one.txt'], true, [], { configure: (controller, input) => { input.automatic.max_duration_seconds = 1; },
    review: async (options, identity, input) => { await new Promise(resolve => {
      if (input.signal.aborted) resolve(); else input.signal.addEventListener('abort', resolve, { once: true });
    }); } });
  const task = await automaticSettled(value);
  assert.equal(task.deadline, task.automatic.deadline); assert(task.deadline <= task.created + 1000);
  assert.notEqual(task.automatic.status, 'succeeded'); assert.equal(task.automatic.reason, 'TASK_EXPIRED');
  assert.equal(value.publisher.pushes, 0);
});

test('expiry after an acknowledged push cannot authorize a later draft PR', async context => {
  const value = await setup(context, ['one.txt'], true, [], { publisher: publisher => {
    const push = publisher.push.bind(publisher);
    publisher.push = async (...args) => { await push(...args); const task = value.c.task(value.id); task.deadline = Date.now() - 1; value.c.save(task); };
  } });
  const task = await automaticSettled(value);
  assert.equal(task.automatic.status, 'uncertain'); assert.equal(value.publisher.pushes, 1); assert.equal(value.publisher.creates, 0);
});

for (const action of ['cleanup', 'close']) test(`automatic ${action} cancels an active reviewer without self-wait or publication`, { timeout: 15000 }, async context => {
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const value = await setup(context, ['one.txt'], true, [], { review: async (options, identity, input) => {
    entered(); await new Promise(resolve => input.signal.addEventListener('abort', resolve, { once: true }));
  } });
  await ready;
  if (action === 'cleanup') {
    await value.c.cleanup({ task_id: value.id }); await automaticSettled(value);
    assert.notEqual(value.c.task(value.id).automatic.status, 'progressing');
    assert.equal((await fs.lstat(value.work)).isDirectory(), true);
  } else await value.c.close();
  assert.equal(value.c.automaticJobs.size, 0); assert.equal(value.c.localRuns.size, 0);
  assert.equal(value.publisher.pushes, 0); assert.equal(value.publisher.creates, 0);
  assert.deepEqual(value.localCalls, ['implementer', 'reviewer']);
});

test('uncertain validation termination blocks reviewer creation and publication', async context => {
  const value = await setup(context, ['one.txt'], true, ['true'], { configure: controller => {
    controller.localValidationFactory = () => ({ terminationConfirmed: false, async run() {}, cancel() {} });
  } });
  const task = await automaticSettled(value);
  assert.equal(task.automatic.status, 'uncertain'); assert.equal(task.local_validation.termination_confirmed, false);
  assert.deepEqual(value.localCalls, ['implementer']); assert.equal(value.publisher.pushes, 0);
});

test('lost push response retains intent and cannot trigger a second push or PR', async context => {
  const value = await setup(context, ['one.txt'], true, [], { publisher: publisher => {
    const push = publisher.push.bind(publisher);
    publisher.push = async (...args) => { await push(...args); throw Error('lost push acknowledgment'); };
  } });
  const task = await automaticSettled(value);
  assert.equal(task.automatic.status, 'uncertain'); assert.equal(task.publication.push_attempted, true);
  assert.equal(task.publication.pr_attempted, false); assert.equal(value.publisher.pushes, 1); assert.equal(value.publisher.creates, 0);
  await value.c.start(value.startInput); await value.c.get(value.id);
  assert.equal(value.publisher.pushes, 1);
});

test('cleanup records cancellation before waiting for an automatic publication lock', async context => {
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const value = await setup(context, ['one.txt'], true, [], { publisher: publisher => {
    const target = publisher.target.bind(publisher);
    publisher.target = async (...args) => { entered(); await new Promise(resolve => { release = resolve; }); return target(...args); };
  } });
  await ready;
  const cleanup = value.c.cleanup({ task_id: value.id });
  assert.equal(value.c.task(value.id).automatic.status, 'stopped');
  release(); await cleanup; await automaticSettled(value);
  assert.equal(value.publisher.pushes, 0); assert.equal(value.publisher.creates, 0);
  assert.equal(value.c.task(value.id).automatic.reason, 'AUTOMATIC_CANCELLED');
});

test('qualified local PASS publishes the exact tree through the existing publisher, once, without Agents API identities', async context => {
  const value = await setup(context, ['one.txt'], true, ['test "$(cat one.txt)" = exact']);
  const { c, id, work, input, remote, baseline, publisher, api, executor } = value;
  await fs.writeFile(path.join(work, 'one.txt'), 'exact\n');
  const task = c.task(id), item = { id: 'write-without-output', type: 'commandExecution', command: "printf 'exact\\n' > one.txt", cwd: work };
  for (const method of ['item/started', 'item/completed']) observeLocalEvidence(task.local_execution_evidence, { method,
    params: { threadId: task.implementer.local.thread_id, turnId: task.implementer.local.turn_id,
      item: { ...item, status: method === 'item/started' ? 'inProgress' : 'completed', ...(method === 'item/completed' ? { exitCode: 0 } : {}) } } }, task.implementer.local, text => text);
  c.save(task); await value.review();
  const reviewed = c.task(id).reviewer, qualification = reviewed.review_result.scope_qualification;
  assert.equal(qualification.status, 'qualified'); assert(qualification.limitations.length > 0);
  assert.equal(qualification.command_output_limitations[0].availability, 'absent');
  assert.equal(qualification.command_output_limitations[0].missing, true);
  assert.equal(c.task(id).local_validation.results[0].status, 'passed');
  const [result, duplicate] = await Promise.all([c.publish(input), c.publish(input)]);
  assert.deepEqual(result, duplicate); assert.equal(result.draft, true);
  assert.equal(repoGit(remote, 'rev-parse', `${result.commit_sha}^{tree}`).trim(), reviewed.reviewed_git_state.tree_sha);
  assert.equal(repoGit(remote, 'rev-parse', 'refs/heads/main').trim(), baseline);
  assert.equal(repoGit(work, 'rev-parse', 'HEAD').trim(), baseline);
  assert.equal(publisher.pushes, 1); assert.equal(publisher.creates, 1);
  assert.equal(api.created.length, 0); assert.equal(api.sent.length, 0); assert.equal(executor.started.length, 0);
  const publication = c.task(id).publication;
  assert.equal(publication.reviewer_session_id, null); assert.equal(publication.reviewer_backend, 'local_codex');
  assert.equal(publication.reviewer_thread_id, reviewed.local.thread_id); assert.equal(publication.reviewer_turn_id, reviewed.local.turn_id);
  await assert.rejects(c.review({ task_id: id, request_id: 'new_review' }), /TASK_FROZEN_FOR_PUBLICATION/);
  await assert.rejects(c.continue({ task_id: id, request_id: 'new_turn', instruction: 'change' }), /TASK_FROZEN_FOR_PUBLICATION/);
  await assert.rejects(c.publish({ ...input, title: 'different' }), /PUBLICATION_INPUT_CHANGED/);
});

test('bounded scope gates reject missing, forged and contradictory observations without overriding reviewer FAIL', async context => {
  const value = await setup(context, ['one.txt'], true); await fs.writeFile(path.join(value.work, 'one.txt'), 'exact'); await value.review();
  const task = value.c.task(value.id), packet = JSON.parse(await fs.readFile(path.join(value.c.workspaceRoot, value.id, task.reviewer.packet_directory, 'evidence.json')));
  for (const mutate of [
    data => delete data.local_scope, data => data.local_scope.provenance = 'model', data => data.local_scope.contract_sha256 = 'forged',
    data => data.local_scope.protected_at_review.sha256 = 'changed', data => data.controller_evidence.provenance = 'model',
    data => data.controller_evidence.task_worktree.task_id = 'other-task', data => data.controller_evidence.registration.at_review.git_identity = {},
    data => data.controller_evidence.normal_checkout.at_review.contents.sha256 = 'changed', data => data.current_commit = 'other',
    data => data.controller_evidence.git_operations.at_review.refs.text += 'extra ref', data => data.staged_files = 'one.txt',
    data => data.current_config_hash = 'changed', data => data.changed_files.push('unauthorized'),
    data => data.execution.authentication = 'unverified', data => data.execution.turn_submission_acknowledged = false,
    data => data.execution.diagnostics.push('Codex reported a runtime error.'), data => data.native_activity.rejected_events++,
    data => data.native_activity.exhaustive = true, data => data.native_activity.omitted_events++,
    data => { delete data.controller_evidence.git_operations.before.operation_markers; delete data.controller_evidence.git_operations.at_review.operation_markers; },
    data => { delete data.controller_evidence.normal_checkout.before.contents; delete data.controller_evidence.normal_checkout.at_review.contents; },
  ]) {
    const changed = structuredClone(packet); mutate(changed);
    assert.equal(localScopeQualification(value.contract, changed).status, 'failed');
  }
  const raw = { overall: 'FAIL', findings: task.reviewer.review_result.findings.map(finding => ({ ...finding, status: finding.id === 'R1' ? 'FAIL' : 'PASS' })) };
  const result = validateLocalReview(JSON.stringify(raw), value.contract, packet, text => text);
  assert.equal(result.overall, 'FAIL'); assert.equal(result.scope_qualification.status, 'qualified');
  assert.equal(result.findings.find(finding => finding.id === 'R1').status, 'FAIL');
  const acceptedLimits = structuredClone(packet);
  acceptedLimits.execution.diagnostics = ['Upstream command/output coverage is unverified.', 'Model messages are not independent test evidence.', 'Descendant-process termination is not independently attested.'];
  assert.equal(localScopeQualification(value.contract, acceptedLimits).status, 'qualified');
  const item = { id: 'native-command', type: 'commandExecution', command: 'cat one.txt', cwd: value.work, status: 'completed', exitCode: 0, aggregatedOutput: 'exact' };
  const file = { id: 'native-file', type: 'fileChange', status: 'completed', changes: [{ path: path.join(value.work, 'one.txt'), kind: { type: 'add' }, diff: '+exact' }] };
  for (const native of [item, file]) for (const method of ['item/started', 'item/completed']) observeLocalEvidence(packet.native_activity, { method,
    params: { threadId: task.implementer.local.thread_id, turnId: task.implementer.local.turn_id,
      item: { ...native, status: method === 'item/started' ? 'inProgress' : 'completed' } } }, task.implementer.local, text => text);
  assert.equal(localScopeQualification(value.contract, packet).status, 'qualified');
  for (const mutate of [
    data => data.native_activity.commands[0].start_observed = false,
    data => data.native_activity.commands[0].completion_observed = false,
    data => data.native_activity.commands[0].command.truncated = true,
    data => data.native_activity.commands[0].thread_id = 'other',
    data => data.native_activity.commands[0].cwd.value = '/outside',
    data => data.native_activity.commands[0].status.value = null,
    data => data.native_activity.commands[0].start_completion_conflict = true,
    data => data.native_activity.file_changes[0].start_completion_conflict = true,
    data => data.native_activity.file_changes[0].changes[0].path.value = path.join(value.work, 'TASK.md'),
    data => data.native_activity.file_changes[0].changes[0].path.value = path.join(value.work, 'outside'),
    data => data.native_activity.file_changes[0].changes = null,
    data => data.native_activity.file_changes.push(null),
  ]) {
    const changed = structuredClone(packet); mutate(changed);
    assert.equal(localScopeQualification(value.contract, changed).status, 'failed');
  }
});

test('bounded SCOPE separates optional output limitations from execution and requirement qualification', async context => {
  const value = await setup(context, ['one.txt'], true);
  await fs.writeFile(path.join(value.work, 'one.txt'), 'exact'); await value.review();
  const task = value.c.task(value.id);
  const packet = JSON.parse(await fs.readFile(path.join(value.c.workspaceRoot, value.id, task.reviewer.packet_directory, 'evidence.json')));
  const raw = { overall: 'PASS', findings: task.reviewer.review_result.findings };
  const observedPacket = (output, change = {}, start = true, complete = true, startChange = {}) => {
    const candidate = structuredClone(packet); candidate.native_activity = createLocalEvidence(task.id);
    const item = { id: 'native-output', type: 'commandExecution', command: 'printf exact', cwd: value.work, status: 'inProgress' };
    for (const [enabled, method, eventItem] of [[start, 'item/started', { ...item, ...startChange }],
      [complete, 'item/completed', { ...item, status: 'completed', exitCode: 0, aggregatedOutput: output, ...change }]]) {
      if (enabled) observeLocalEvidence(candidate.native_activity, { method, params: { threadId: task.implementer.local.thread_id,
        turnId: task.implementer.local.turn_id, item: eventItem } }, task.implementer.local, text => text);
    }
    return candidate;
  };
  for (const [availability, output] of [['absent', undefined], ['null', null], ['empty', ''], ['present', 'exact']]) {
    const candidate = observedPacket(output), result = validateLocalReview(JSON.stringify(raw), value.contract, candidate, text => text);
    assert.equal(result.scope_qualification.status, 'qualified'); assert.equal(result.overall, 'PASS');
    assert.equal(result.scope_qualification.command_output_limitations[0].availability, availability);
    assert.equal(candidate.native_activity.commands[0].output.value, typeof output === 'string' ? output : null);
    const failed = structuredClone(raw); failed.overall = 'FAIL'; failed.findings[0].status = 'FAIL';
    failed.findings[0].evidence = 'Required output contents are not independently established.';
    if (availability !== 'empty' && availability !== 'present') {
      for (const alteration of [() => {}, data => { const output = data.native_activity.commands[0].output;
        Object.assign(output, { availability: 'present', value: '[REDACTED]', missing: false, redacted: true }); data.native_activity.commands[0].missing = [];
        // This is intentional valid retained output, so update its byte meter.
        data.native_activity.record_bytes = Buffer.byteLength(JSON.stringify([...data.native_activity.commands, ...data.native_activity.file_changes])); },
      data => { const output = data.native_activity.commands[0].output;
        Object.assign(output, { availability: 'present', value: 'partial', missing: false, truncated: true, source_truncated: true }); data.native_activity.commands[0].missing = [];
        data.native_activity.record_bytes = Buffer.byteLength(JSON.stringify([...data.native_activity.commands, ...data.native_activity.file_changes])); }]) {
        const limited = structuredClone(candidate); alteration(limited);
        const outputContract = { ...value.contract, requirements: [{ id: 'R1', text: 'The command must emit the exact complete stdout token expected-output.' }] };
        limited.contract = contractMarkdown(outputContract, 'local_codex');
        limited.contract_binding = localContractBinding(outputContract, limited.contract);
        limited.local_scope.contract_sha256 = digest(outputContract);
        const rejected = validateLocalReview(JSON.stringify(failed), outputContract, limited, text => text);
        assert.equal(rejected.overall, 'FAIL'); assert.equal(rejected.findings[0].status, 'FAIL');
        assert.equal(rejected.scope_qualification.status, 'qualified');
        assert.deepEqual(rejected.scope_qualification.command_output_limitations[0].redacted, limited.native_activity.commands[0].output.redacted);
      }
    }
  }
  // Keep meter attacks separate from the two intentional valid-output edits
  // above. Never repair a negative case through a shared fixture normalizer.
  for (const tamper of [data => data.native_activity.record_bytes++,
    data => data.native_activity.record_bytes = -1,
    data => data.native_activity.record_bytes = '2',
    data => data.native_activity.record_bytes = 2.5,
    data => data.native_activity.commands[0].output.value += 'stale retained output']) {
    const candidate = observedPacket('exact'); tamper(candidate);
    const rejected = validateLocalReview(JSON.stringify(raw), value.contract, candidate, text => text);
    assert.equal(rejected.overall, 'FAIL'); assert.equal(rejected.scope_qualification.status, 'failed');
    assert(rejected.scope_qualification.blockers.includes('SCOPE_NATIVE_COVERAGE_UNCERTAIN'));
  }
  for (const candidate of [observedPacket(null, { exitCode: null }), observedPacket(null, {}, false), observedPacket(null, {}, true, false),
    observedPacket({}), observedPacket(null, { command: 'changed' }), observedPacket(null, { cwd: '/other' }),
    observedPacket(null, { status: 'unknown' }), observedPacket(null, { exitCode: 1 }), observedPacket(null, { status: 'failed' }),
    observedPacket(null, {}, true, true, { status: 'completed' }), observedPacket(null, {}, true, true, { aggregatedOutput: 'lost prefix' })]) {
    assert.equal(localScopeQualification(value.contract, candidate).status, 'failed');
  }
  for (const mutate of [data => data.execution.diagnostics.push('RUNTIME_UNCERTAINTY'),
    data => data.native_activity.commands[0].thread_id = 'foreign', data => data.native_activity.commands[0].turn_id = 'foreign',
    data => data.native_activity.commands[0].output.availability = 'empty', data => delete data.native_activity.commands[0].output.availability]) {
    const candidate = observedPacket(null); mutate(candidate);
    assert.equal(localScopeQualification(value.contract, candidate).status, 'failed');
  }
});

test('optional output never rescues missing exit evidence or authorizes exact-tree publication', async context => {
  const value = await setup(context, ['one.txt'], true); await fs.writeFile(path.join(value.work, 'one.txt'), 'exact');
  const task = value.c.task(value.id), item = { id: 'missing-exit', type: 'commandExecution', command: 'printf exact', cwd: value.work };
  for (const method of ['item/started', 'item/completed']) observeLocalEvidence(task.local_execution_evidence, { method,
    params: { threadId: task.implementer.local.thread_id, turnId: task.implementer.local.turn_id,
      item: { ...item, status: method === 'item/started' ? 'inProgress' : 'completed', aggregatedOutput: null } } }, task.implementer.local, text => text);
  value.c.save(task); await value.review('FAIL');
  assert(value.c.task(value.id).reviewer.review_result.scope_qualification.blockers.includes('SCOPE_COMMAND_EXIT_UNCERTAIN'));
  await assert.rejects(value.c.publish(value.input), /PUBLICATION_REQUIRES_PASS_REVIEW/);
  assert.equal(value.publisher.pushes, 0); assert.equal(value.publisher.creates, 0);
});

for (const operation of ['git push origin HEAD', 'git -C . commit -m prohibited', 'git config user.name prohibited']) test(`observed prohibited indication blocks SCOPE even with clean final Git state: ${operation}`, async context => {
  const value = await setup(context, ['one.txt'], true); await fs.writeFile(path.join(value.work, 'one.txt'), 'exact');
  const task = value.c.task(value.id), item = { type: 'commandExecution', id: 'observed-command', command: operation, cwd: value.work, status: 'inProgress' };
  for (const method of ['item/started', 'item/completed']) observeLocalEvidence(task.local_execution_evidence, { method,
    params: { threadId: task.implementer.local.thread_id, turnId: task.implementer.local.turn_id,
      item: method === 'item/started' ? item : { ...item, status: 'completed', exitCode: 0, aggregatedOutput: '' } } }, task.implementer.local, text => text);
  value.c.save(task); await value.review('FAIL');
  assert(value.c.task(value.id).reviewer.review_result.scope_qualification.blockers.includes('SCOPE_PROHIBITED_GIT_INDICATION'));
  await assert.rejects(value.c.publish(value.input), /PUBLICATION_REQUIRES_PASS_REVIEW/);
});

for (const mutation of ['unauthorized', 'config', 'protected_codex', 'protected_mode']) test(`actual structural mutation blocks local SCOPE: ${mutation}`, async context => {
  const value = await setup(context, ['one.txt'], true); await fs.writeFile(path.join(value.work, 'one.txt'), 'exact');
  if (mutation === 'unauthorized') await fs.writeFile(path.join(value.work, 'outside.txt'), 'bad');
  if (mutation === 'config') repoGit(value.work, 'config', '--local', 'user.name', 'Prohibited mutation');
  if (mutation === 'protected_codex') { await fs.mkdir(path.join(value.work, '.codex')); await fs.writeFile(path.join(value.work, '.codex/config.toml'), ''); }
  if (mutation === 'protected_mode') await fs.chmod(path.join(value.work, 'TASK.md'), 0o400);
  await value.review('FAIL'); await assert.rejects(value.c.publish(value.input), /PUBLICATION_REQUIRES_PASS_REVIEW/);
  assert.equal(value.publisher.pushes, 0);
});

for (const field of ['validation_missing', 'validation_failed', 'validation_tree', 'thread', 'implementer_identity', 'session_identity', 'terminal', 'closed', 'authentication', 'runtime', 'findings', 'stale', 'packet', 'worktree', 'normal', 'protected', 'publication_binding']) test(`local publication rejects ${field} without remote calls`, async context => {
  const value = await setup(context, ['one.txt'], true, ['test -f one.txt']);
  await fs.writeFile(path.join(value.work, 'one.txt'), 'exact'); await value.review();
  const task = value.c.task(value.id);
  if (field === 'validation_missing') delete task.local_validation;
  if (field === 'validation_failed') task.local_validation.results[0].exit_code = 1;
  if (field === 'validation_tree') task.local_validation.reviewed_git_state.tree_sha = task.baseline;
  if (field === 'thread') task.reviewer.local.thread_id = task.implementer.local.thread_id;
  if (field === 'implementer_identity') task.implementer.local.thread_id = 'different-implementer';
  if (field === 'session_identity') task.reviewer.session_id = 'fabricated-session';
  if (field === 'publication_binding') task.publication = { phase: 'prepared', reviewer_thread_id: 'other' };
  if (field === 'terminal') task.reviewer.local.terminal_observed = false;
  if (field === 'closed') task.implementer.local.server_closed = false;
  if (field === 'authentication') task.implementer.local.authentication = 'unverified';
  if (field === 'runtime') task.reviewer.local.diagnostics.push('Codex reported a runtime error.');
  if (field === 'findings') task.reviewer.review_result.findings[0].evidence = 'forged';
  if (field === 'stale') task.reviewer.stale = true;
  if (field === 'packet') { const file = path.join(value.c.workspaceRoot, value.id, task.reviewer.packet_directory, 'evidence.json'); await fs.chmod(file, 0o600); await fs.writeFile(file, '{}'); }
  if (field === 'worktree') await fs.writeFile(path.join(value.work, 'one.txt'), 'mutated');
  if (field === 'normal') await fs.writeFile(path.join(value.normal, 'keep.txt'), 'mutated');
  if (field === 'protected') await fs.chmod(path.join(value.work, 'TASK.md'), 0o400);
  value.c.save(task);
  await assert.rejects(value.c.publish(value.input)); assert.equal(value.publisher.pushes, 0); assert.equal(value.publisher.creates, 0);
});

test('failed independent required test cannot be repaired by local reviewer PASS prose', async context => {
  const value = await setup(context, ['one.txt'], true, ['exit 7']); await fs.writeFile(path.join(value.work, 'one.txt'), 'exact');
  await value.review('FAIL');
  const result = value.c.task(value.id).reviewer.review_result;
  assert.equal(result.scope_qualification.status, 'qualified'); assert(result.controller_overrides.includes('TEST_EVIDENCE'));
  await assert.rejects(value.c.publish(value.input), /PUBLICATION_REQUIRES_PASS_REVIEW/);
});

test('local publication reconciles lost PR response after restart without duplicate push or creation', async context => {
  const value = await setup(context, ['one.txt'], true); await fs.writeFile(path.join(value.work, 'one.txt'), 'exact'); await value.review();
  value.publisher.losePRResponse = true; await assert.rejects(value.c.publish(value.input), /PUBLICATION_FAILED/);
  await value.c.close();
  const recovered = await new Controller({ stateRoot: value.c.stateRoot, workspaceRoot: value.c.workspaceRoot, publisher: value.publisher,
    api: value.api, executor: value.executor, localBackendFactory: () => { throw Error('Replay forbidden'); } }).init();
  try {
    const result = await recovered.publish(value.input); assert.equal(result.draft, true);
    assert.equal(value.publisher.pushes, 1); assert.equal(value.publisher.creates, 1);
  } finally { await recovered.close(); }
});

test('local restart uncertainty and unconfirmed validation termination cannot authorize publication', async context => {
  const value = await setup(context, ['one.txt'], true); await fs.writeFile(path.join(value.work, 'one.txt'), 'exact'); await value.review();
  const pending = value.c.task(value.id); await value.c.close();
  const recovered = await new Controller({ stateRoot: value.c.stateRoot, workspaceRoot: value.c.workspaceRoot, publisher: value.publisher,
    api: value.api, executor: value.executor, localBackendFactory: () => { throw Error('Replay forbidden'); } }).init();
  pending.reviewer.state = 'running'; pending.reviewer.local.result_received = false; pending.local_validation.status = 'running';
  recovered.save(pending); await recovered.close();
  const restarted = await new Controller({ stateRoot: value.c.stateRoot, workspaceRoot: value.c.workspaceRoot, publisher: value.publisher, api: value.api, executor: value.executor }).init();
  try { await assert.rejects(restarted.publish(value.input)); assert.equal(value.publisher.pushes, 0); }
  finally { await restarted.close(); }
});
const cases = [
  ['one-file', ['one.txt'], async w => fs.writeFile(path.join(w, 'one.txt'), 'exact\n')],
  ['multi-file', ['one.txt', 'dir/two.txt', 'keep.txt'], async w => { await fs.mkdir(path.join(w, 'dir')); await fs.writeFile(path.join(w, 'one.txt'), 'one\n'); await fs.writeFile(path.join(w, 'dir/two.txt'), 'two\n'); await fs.writeFile(path.join(w, 'keep.txt'), 'changed\n'); }],
  ['deletion', ['delete.txt'], async w => fs.unlink(path.join(w, 'delete.txt'))],
  ['rename', ['rename.txt', 'renamed.txt'], async w => fs.rename(path.join(w, 'rename.txt'), path.join(w, 'renamed.txt'))],
  ['executable bit', ['run.sh'], async w => fs.chmod(path.join(w, 'run.sh'), 0o755)],
  ['symlink', ['link'], async w => fs.symlink('keep.txt', path.join(w, 'link'))],
  ['binary', ['image.bin'], async w => fs.writeFile(path.join(w, 'image.bin'), Buffer.from([0, 255, 128, 13, 10, 1, 2]))],
];
for (const local of [false, true]) for (const [name, allowed, modify] of cases) test(`${local ? 'local' : 'Agents API'} publish preserves exact reviewed Git semantics: ${name}`, async t => {
  const { c, normal, remote, baseline, publisher, id, work, input, review } = await setup(t, allowed, local);
  const normalStatus = repoGit(normal, 'status', '--porcelain=v1'), normalRefs = repoGit(normal, 'show-ref');
  await modify(work); await review();
  const record = c.task(id), packet = JSON.parse(await fs.readFile(path.join(c.workspaceRoot, id, record.reviewer.packet_directory, 'evidence.json')));
  const reviewedTree = packet.reviewed_git_state.tree_sha;
  const result = await c.invoke('publish_task', input, { requestId: 'publication_rpc' }, x => c.publish(x));
  assert.equal(result.reviewed_tree_sha, reviewedTree); assert.equal(result.commit_tree_matches_reviewed_tree, true);
  assert.equal(result.pr_number, 7); assert.equal(result.draft, true);
  assert.equal(result.pushed_branch, `bridge/${id}`);
  assert.equal(repoGit(remote, 'rev-parse', `${result.commit_sha}^{tree}`).trim(), reviewedTree);
  assert.equal(repoGit(remote, 'rev-parse', 'refs/heads/main').trim(), baseline);
  assert.equal(repoGit(remote, 'rev-list', '--parents', '-1', result.commit_sha).trim(), `${result.commit_sha} ${baseline}`);
  assert.equal(repoGit(normal, 'status', '--porcelain=v1'), normalStatus); assert.equal(repoGit(normal, 'show-ref'), normalRefs);
  assert.equal(repoGit(work, 'rev-parse', 'HEAD').trim(), baseline);
  assert(!repoGit(remote, 'ls-tree', '--name-only', result.commit_sha).split('\n').includes('TASK.md'));
  if (name === 'symlink') assert.match(repoGit(remote, 'ls-tree', result.commit_sha, 'link'), /^120000 blob/);
  if (name === 'executable bit') assert.match(repoGit(remote, 'ls-tree', result.commit_sha, 'run.sh'), /^100755 blob/);
  if (name === 'deletion') assert.equal(repoGit(remote, 'ls-tree', result.commit_sha, 'delete.txt'), '');
  if (name === 'rename') assert.match(repoGit(remote, 'diff', '--summary', baseline, result.commit_sha), /rename rename.txt => renamed.txt/);
  if (name === 'binary') assert.deepEqual(execFileSync('/usr/bin/git', ['show', `${result.commit_sha}:image.bin`], { cwd: remote }), await fs.readFile(path.join(work, 'image.bin')));
  assert.equal(c.task(id).publication.review_packet_sha256, record.reviewer.packet_hash);
  assert.equal(c.task(id).publication.review_overall, 'PASS');
  const audits = c.db.prepare('SELECT value FROM audit').all().map(r => JSON.parse(r.value));
  assert(audits.some(a => a.tool === 'publish_task' && a.task_id === id));
  assert.deepEqual(await c.publish(input), result); assert.equal(publisher.pushes, 1); assert.equal(publisher.creates, 1);
  await assert.rejects(c.continue({ task_id: id, request_id: 'cannot_continue', instruction: 'Modify more' }), /TASK_FROZEN_FOR_PUBLICATION/);
  await assert.rejects(c.review({ task_id: id, request_id: 'cannot_review' }), /TASK_FROZEN_FOR_PUBLICATION/);
});

test('publish rejects missing and failed reviews and incomplete implementation', async t => {
  const { c, api, publisher, id, work, input, review } = await setup(t);
  await fs.writeFile(path.join(work, 'one.txt'), 'one');
  await assert.rejects(c.publish(input), /PUBLICATION_REQUIRES_COMPLETED_IMPLEMENTATION/);
  api.completed(c.task(id).implementer.session_id);
  await assert.rejects(c.publish(input), /PUBLICATION_REQUIRES_PASS_REVIEW/);
  await review('FAIL');
  await assert.rejects(c.publish(input), /PUBLICATION_REQUIRES_PASS_REVIEW/);
  assert.equal(publisher.pushes, 0);
});

test('publish rejects changed worktree even when status/changed filenames remain identical', async t => {
  const { c, publisher, work, input, review } = await setup(t);
  await fs.writeFile(path.join(work, 'one.txt'), 'before'); await review();
  const status = repoGit(work, 'status', '--porcelain');
  await fs.writeFile(path.join(work, 'one.txt'), 'after!');
  assert.equal(repoGit(work, 'status', '--porcelain'), status);
  await assert.rejects(c.publish(input), /WORKTREE_CHANGED_SINCE_REVIEW/); assert.equal(publisher.pushes, 0);
});

test('publish rejects missing worktree and legacy review without frozen tree', async t => {
  const { c, publisher, id, work, input, review } = await setup(t);
  await fs.writeFile(path.join(work, 'one.txt'), 'x'); await review();
  const row = c.task(id), file = path.join(c.workspaceRoot, id, row.reviewer.packet_directory, 'evidence.json');
  const packet = JSON.parse(await fs.readFile(file)); delete packet.reviewed_git_state;
  const text = JSON.stringify(packet); await fs.chmod(file, 0o600); await fs.writeFile(file, text); row.reviewer.packet_hash = digest(text); c.save(row);
  await assert.rejects(c.publish(input), /REVIEW_TREE_UNAVAILABLE/);
  await fs.rename(work, work + '-moved');
  await assert.rejects(c.publish(input)); assert.equal(publisher.pushes, 0);
});

for (const local of [false, true]) test(`${local ? 'local' : 'Agents API'} publish rejects commit tree mismatch before push`, async t => {
  const { c, baseline, publisher, id, work, input, review } = await setup(t, ['one.txt'], local);
  await fs.writeFile(path.join(work, 'one.txt'), 'x'); await review();
  const row = c.task(id), packet = JSON.parse(await fs.readFile(path.join(c.workspaceRoot, id, row.reviewer.packet_directory, 'evidence.json')));
  row.publication = { phase: 'prepared', input_sha256: digest(JSON.stringify({ title: input.title, body: '', draft: true })), target: await publisher.target(),
    commit_sha: baseline, reviewed_tree_sha: packet.reviewed_git_state.tree_sha, push_attempted: false };
  if (local) Object.assign(row.publication, { task_id: id, pushed_branch: row.repository.branch, review_packet_sha256: row.reviewer.packet_hash,
    reviewer_backend: 'local_codex', reviewer_session_id: null, reviewer_thread_id: row.reviewer.local.thread_id,
    reviewer_turn_id: row.reviewer.local.turn_id, review_overall: 'PASS' });
  c.save(row);
  await assert.rejects(c.publish(input), /PUBLICATION_TREE_MISMATCH/); assert.equal(publisher.pushes, 0);
});

for (const local of [false, true]) test(`${local ? 'local' : 'Agents API'} publish rejects existing remote branch even if it could be fast-forwarded`, async t => {
  const { c, remote, baseline, publisher, id, work, input, review } = await setup(t, ['one.txt'], local);
  await fs.writeFile(path.join(work, 'one.txt'), 'x'); await review();
  repoGit(remote, 'update-ref', `refs/heads/bridge/${id}`, baseline);
  await assert.rejects(c.publish(input), /PUBLICATION_REMOTE_BRANCH_EXISTS/); assert.equal(publisher.pushes, 0);
  assert.equal(repoGit(remote, 'rev-parse', `refs/heads/bridge/${id}`).trim(), baseline);
});

for (const local of [false, true]) test(`${local ? 'local' : 'Agents API'} create-only pre-push hook rejects a ref created after the remote precheck`, async t => {
  const { c, remote, baseline, publisher, id, work, input, review } = await setup(t, ['one.txt'], local);
  await fs.writeFile(path.join(work, 'one.txt'), 'x'); await review();
  publisher.beforePush = async () => repoGit(remote, 'update-ref', `refs/heads/bridge/${id}`, baseline);
  await assert.rejects(c.publish(input), /PUBLICATION_GIT_FAILED/);
  assert.equal(repoGit(remote, 'rev-parse', `refs/heads/bridge/${id}`).trim(), baseline); assert.equal(publisher.creates, 0);
});

for (const local of [false, true]) test(`${local ? 'local' : 'Agents API'} default branch, arbitrary branch/path, ready PR and generic Git commands are rejected`, async t => {
  const { c, publisher, id, work, input, review } = await setup(t, ['one.txt'], local);
  await fs.writeFile(path.join(work, 'one.txt'), 'x'); await review();
  for (const extra of [{ branch: 'main' }, { repository_path: work }, { command: 'git push' }, { draft: false }]) await assert.rejects(c.publish({ ...input, ...extra }), /INVALID_PUBLISH_INPUT/);
  publisher.base = `bridge/${id}`;
  await assert.rejects(c.publish(input), /PUBLICATION_DEFAULT_BRANCH_FORBIDDEN/); assert.equal(publisher.pushes, 0);
  const source = await fs.readFile(new URL('../publication.mjs', import.meta.url), 'utf8');
  assert(!/['"]--force(?:-with-lease)?['"]/.test(source)); assert(!/\['merge'/.test(source)); assert(!source.includes('/contents/'));
});

test('publication survives cleanup and reconciles a lost PR-create response without duplicate push/PR', async t => {
  const { c, publisher, id, work, input, review } = await setup(t);
  await fs.writeFile(path.join(work, 'one.txt'), 'x'); await review(); publisher.losePRResponse = true;
  await assert.rejects(c.publish(input), /PUBLICATION_FAILED/);
  assert.equal(c.task(id).publication.phase, 'pushed');
  const result = await c.publish(input);
  assert.equal(publisher.pushes, 1); assert.equal(publisher.creates, 1);
  await c.cleanup({ task_id: id, delete_workspace: true });
  assert.equal(c.task(id).publication.pr_url, result.pr_url);
  assert.equal((await c.get(id, false)).publication.commit_sha, result.commit_sha);
});

for (const local of [false, true]) test(`${local ? 'local' : 'Agents API'} uncertain PR outcome without a matching PR is not blindly retried`, async t => {
  const { c, publisher, work, input, review } = await setup(t, ['one.txt'], local);
  await fs.writeFile(path.join(work, 'one.txt'), 'x'); await review(); publisher.createPR = async () => { publisher.creates++; throw Error('uncertain'); };
  await assert.rejects(c.publish(input), /PUBLICATION_FAILED/);
  await assert.rejects(c.publish(input), /PUBLICATION_PR_OUTCOME_UNKNOWN/);
  assert.equal(publisher.creates, 1); assert.equal(publisher.pushes, 1);
});

test('completed PASS remains publishable after remote session cleanup with workspace retained', async t => {
  const { c, id, work, input, review } = await setup(t);
  await fs.writeFile(path.join(work, 'one.txt'), 'x'); await review();
  await c.cleanup({ task_id: id, delete_workspace: false });
  assert.equal((await c.publish(input)).draft, true);
});

test('publish MCP is strict, draft-only, and returns publication-specific structured output', async t => {
  const { c, work, input, review } = await setup(t); await fs.writeFile(path.join(work, 'one.txt'), 'x'); await review();
  const server = createServer(c, async () => {}), client = new Client({ name: 'publication-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  const tool = (await client.listTools()).tools.find(x => x.name === 'publish_task');
  assert.equal(tool.annotations.openWorldHint, true); assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal((await client.callTool({ name: 'publish_task', arguments: { ...input, branch: 'main' } })).isError, true);
  const r = await client.callTool({ name: 'publish_task', arguments: input });
  assert.equal(r.isError, undefined); assert.equal(r.structuredContent.commit_tree_matches_reviewed_tree, true);
});

test('production publication target accepts only unambiguous GitHub origins', () => {
  assert.equal(githubRepository('git@github.com:owner/repo.git'), 'owner/repo');
  assert.equal(githubRepository('https://github.com/owner/repo.git'), 'owner/repo');
  for (const url of ['/tmp/repo', 'https://github.com.evil/owner/repo', 'https://user:secret@github.com/owner/repo', 'https://github.com/owner/repo?x=1', 'ext::command']) assert.throws(() => githubRepository(url));
});

test('concurrent publication requests serialize and changed retries are rejected', async t => {
  const { c, publisher, work, input, review } = await setup(t); await fs.writeFile(path.join(work, 'one.txt'), 'x'); await review();
  const [a, b] = await Promise.all([c.publish(input), c.publish(input)]);
  assert.deepEqual(a, b); assert.equal(publisher.pushes, 1); assert.equal(publisher.creates, 1);
  await assert.rejects(c.publish({ ...input, title: 'different' }), /PUBLICATION_INPUT_CHANGED/);
});

for (const local of [false, true]) test(`${local ? 'local' : 'Agents API'} a lost push response reconciles the exact recorded commit, never a conflicting ref`, async t => {
  const { c, remote, baseline, publisher, id, work, input, review } = await setup(t, ['one.txt'], local); await fs.writeFile(path.join(work, 'one.txt'), 'x'); await review();
  const push = publisher.push.bind(publisher); publisher.push = async (...args) => { await push(...args); throw Error('lost push response'); };
  await assert.rejects(c.publish(input), /PUBLICATION_FAILED/);
  assert.equal(c.task(id).publication.push_attempted, true);
  const result = await c.publish(input); assert.equal(result.commit_tree_matches_reviewed_tree, true); assert.equal(publisher.pushes, 1);
  repoGit(remote, 'update-ref', `refs/heads/bridge/${id}`, baseline);
  await assert.rejects(c.publish(input), /PUBLICATION_REMOTE_BRANCH_CONFLICT/); assert.equal(publisher.pushes, 1);
});

test('PASS cannot bypass scope or an unconfirmed executor stop', async t => {
  const { c, executor, publisher, id, work, input, review } = await setup(t); await fs.writeFile(path.join(work, 'unauthorized.txt'), 'x'); await review();
  await assert.rejects(c.publish(input), /PUBLICATION_SCOPE_VIOLATION/);
  executor.stop = async () => false;
  await assert.rejects(c.publish(input), /EXECUTOR_NOT_STOPPED/); assert.equal(publisher.pushes, 0);
  assert.notEqual(c.task(id).publication?.phase, 'complete');
});

test('registry removal and origin changes fail closed before publishing', async t => {
  const { c, normal, publisher, work, input, review } = await setup(t); await fs.writeFile(path.join(work, 'one.txt'), 'x'); await review();
  repoGit(normal, 'remote', 'set-url', 'origin', '/tmp/not-the-approved-origin');
  await assert.rejects(c.publish(input), /PUBLICATION_ORIGIN_CHANGED/);
  await fs.writeFile(path.join(c.stateRoot, 'repositories.json'), JSON.stringify({ version: 1, repositories: {} }), { mode: 0o600 });
  await assert.rejects(c.publish(input), /UNKNOWN_REPOSITORY_ID/); assert.equal(publisher.pushes, 0);
});

test('ordinary disposable tasks cannot be published', async t => {
  const { c } = await setup(t);
  const started = await c.start({ request_id: 'disposable_fixture', contract: { goal: 'fixture', allowed_files: ['one.txt'], requirements: [{ id: 'R1', text: 'fixture' }], invariants: [], test_commands: [], initial_files: {} } });
  await Promise.all([...c.jobs.values()]);
  await assert.rejects(c.publish({ task_id: started.task_id, title: 'not a repo' }), /PUBLICATION_REQUIRES_REPOSITORY/);
});

// Revision fixtures use real isolated Git stores and the production pre-push
// check, with only GitHub transport/model responses replaced by offline fixtures.
async function revisionFixture(context, mode = {}) {
  const agents = mode.sourceBackend === 'agents_api';
  const value = await setup(context, ['one.txt'], !agents, agents ? [] : ['cat one.txt'], agents ? undefined : {});
  if (agents) { await fs.writeFile(path.join(value.work, 'one.txt'), 'exact\n'); await value.review(); await value.c.publish(value.input); }
  const original = agents ? value.c.task(value.id) : await automaticSettled(value), { c, publisher, normal, remote } = value;
  if (!agents) assert.equal(original.automatic.status, 'succeeded', JSON.stringify(original.automatic));
  assert.equal((await c.qualifyPublicationEvidence(original)).confirmed, true);
  const originalText = c.db.prepare('SELECT value FROM tasks WHERE id=?').get(original.id).value;
  const before = await publicationState(normal), refs = repoGit(normal, 'show-ref');
  const calls = [], fetches = [], identities = [], target = publisher.target.bind(publisher);
  publisher.target = async repository => { if (repository.github_identity) identities.push(repository.github_identity); return target(repository); };
  const metadata = { id: 1234, full_name: 'fixture/isolated-publication', owner: { id: 12, login: 'fixture', type: 'User' },
    private: false, permissions: { pull: true }, archived: false, disabled: false, default_branch: 'main', size: 1 };
  c.registration.transport.api = async endpoint => {
    if (endpoint === 'user') return { id: 12, login: 'fixture', type: 'User' };
    assert.equal(endpoint, 'repos/fixture/isolated-publication'); return structuredClone(metadata);
  };
  c.registration.transport.fetch = async (directory, target, signal, commit) => {
    fetches.push(commit);
    repoGit(directory, '-c', 'protocol.file.allow=always', 'fetch', '--no-tags', '--no-write-fetch-head', remote, commit);
    await mode.afterFetch?.();
  };
  publisher.getPR = async (target, number) => {
    publisher.calls.push('getPR'); assert.equal(number, 7);
    const pr = structuredClone(publisher.pr);
    pr.head.sha = repoGit(remote, 'rev-parse', `refs/heads/${pr.head.ref}`).trim();
    mode.pr?.(pr); return pr;
  };
  let instance = 0;
  c.localBackendFactory = options => ({
    async run() {
      const role = options.reviewOnly ? 'reviewer' : 'implementer'; calls.push(role);
      const identity = { model: 'fixture-model', threadId: mode.reuseIdentity && options.reviewOnly ? original.reviewer.local.thread_id : `revision-${role}-${++instance}`,
        turnId: `revision-turn-${instance}`, turnSubmissionAttempted: true, turnSubmissionAcknowledged: true, terminalObserved: true };
      options.onLifecycle({ ...identity, phase: 'turn_acknowledged' });
      let review;
      if (!options.reviewOnly) {
        assert.equal(options.requireFreshThread, true);
        const content = mode.content ?? 'revised\n';
        const item = { id: 'revision-write', type: 'commandExecution', command: mode.noWrite ? 'cat one.txt' : `printf ${JSON.stringify(content)} > one.txt`, cwd: options.cwd };
        options.onProgress({ method: 'item/started', params: { threadId: identity.threadId, turnId: identity.turnId, item: { ...item, status: 'inProgress' } } });
        if (!mode.noWrite) await fs.writeFile(path.join(options.cwd, 'one.txt'), content);
        if (mode.outside) await fs.writeFile(path.join(options.cwd, 'keep.txt'), 'out of scope\n');
        options.onProgress({ method: 'item/completed', params: { threadId: identity.threadId, turnId: identity.turnId, item: { ...item, status: 'completed', exitCode: 0 } } });
      } else review = await mode.review?.(options);
      options.onLifecycle({ ...identity, phase: 'terminal_observed', status: 'completed' });
      const verdict = mode.verdict || 'PASS';
      return { ...identity, status: 'completed', authentication: 'chatgpt', uncertainties: [], commands: [],
        messages: options.reviewOnly ? [{ provenance: 'model', text: JSON.stringify(review || { overall: verdict,
          findings: ['R1', 'SCOPE', 'TEST_EVIDENCE'].map(id => ({ id, status: verdict, evidence: 'Independent revision fixture.' })) }) }] : [] };
    }, async cancel() {}, async close() { return mode.closeFailure !== (options.reviewOnly ? 'reviewer' : 'implementer'); }
  });
  const input = { request_id: 'authorized_revision', execution_backend: 'local_codex', repository_id: 'fixture',
    contract: structuredClone(value.contract), automatic: { publish: { title: 'Owner-authorized fixture revision', draft: true },
      max_duration_seconds: 120, max_codex_turns: 2, max_corrections: 0 },
    revise_pr: { pr_number: 7, expected_head_sha: original.publication.commit_sha } };
  const run = async () => {
    const started = await c.start(input);
    await Promise.all([...c.jobs.values()]); await Promise.all([...c.automaticJobs.values()]);
    return c.task(started.task_id);
  };
  const unchanged = async () => {
    assert.equal(c.db.prepare('SELECT value FROM tasks WHERE id=?').get(original.id).value, originalText);
    assert.deepEqual(await publicationState(normal), before); assert.equal(repoGit(normal, 'show-ref'), refs);
    assert.equal(publisher.creates, 1); assert.equal(repoGit(remote, 'rev-parse', 'main').trim(), value.baseline);
  };
  return { ...value, original, originalText, input, run, unchanged, calls, fetches, identities, mode, metadata };
}

test('revision owner authorization publishes a fresh reviewed child on the same draft PR exactly once', async context => {
  const v = await revisionFixture(context), { c, publisher, remote } = v;
  const task = await v.run();
  assert.equal(task.automatic.status, 'succeeded', JSON.stringify(task.automatic));
  assert.notEqual(task.id, v.original.id); assert.equal(task.baseline, v.input.revise_pr.expected_head_sha);
  assert.notEqual(task.reviewer.local.thread_id, v.original.reviewer.local.thread_id);
  assert.notEqual(task.local_validation.attempt_id, v.original.local_validation.attempt_id);
  const p = task.publication;
  assert.equal(p.pr_number, 7); assert.equal(p.pr_url, v.original.publication.pr_url); assert.equal(p.pr_attempted, false);
  assert.equal(p.pushed_branch, v.original.publication.pushed_branch); assert.equal(p.previous_head_sha, task.baseline);
  assert.equal(repoGit(remote, 'rev-parse', `${p.commit_sha}^`).trim(), task.baseline);
  assert.equal(repoGit(remote, 'rev-parse', `${p.commit_sha}^{tree}`).trim(), task.reviewer.reviewed_git_state.tree_sha);
  assert.equal(repoGit(remote, 'rev-parse', `refs/heads/${p.pushed_branch}`).trim(), p.commit_sha);
  assert.equal(repoGit(path.join(c.workspaceRoot, task.id, 'repo'), 'rev-parse', 'HEAD').trim(), task.baseline);
  assert.equal(task.local_validation.results[0].status, 'passed'); assert.equal(publisher.pushes, 2);
  assert.deepEqual(v.calls, ['implementer', 'reviewer']); assert.deepEqual(v.fetches, [task.baseline]);
  assert.equal(task.revision.github_identity.repository_id, 1234); assert.equal(v.identities.at(-1).repository_id, 1234);
  const calls = [...publisher.calls];
  assert.equal((await c.qualifyPublicationEvidence(task)).confirmed, true);
  const report = await reportingPublication(c, task.id);
  assert.equal(report.confirmed, true); assert.equal(report.revision.previous_head_sha, task.baseline);
  assert.deepEqual(publisher.calls, calls); // Reporting never reconciles GitHub.
  const [a, b] = await Promise.all([c.start(v.input), c.start(v.input)]);
  assert.equal(a.task_id, task.id); assert.equal(b.task_id, task.id); assert.equal(publisher.pushes, 2);
  assert.deepEqual(v.calls, ['implementer', 'reviewer']); await v.unchanged();
  await assert.rejects(c.continue({ task_id: v.original.id, request_id: 'historical_continue', instruction: 'more' }), /AUTOMATIC_TASK_OWNS_TRANSITIONS/);
  await assert.rejects(c.start({ ...v.input, revise_pr: { ...v.input.revise_pr, pr_number: 8 } }), /REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT/);
});

for (const kind of ['missing publication', 'missing receipt', 'contradictory receipt', 'missing packet', 'changed publication identity',
  'different repository', 'changed head', 'closed', 'merged', 'ready', 'head owner', 'base owner', 'branch', 'base', 'wrong number', 'scope', 'owner'])
test(`revision admission rejects ${kind} without execution or push`, async context => {
  const v = await revisionFixture(context), { c, mode, publisher } = v;
  const source = c.task(v.original.id);
  if (kind === 'missing publication') delete source.publication;
  if (kind === 'missing receipt') delete source.reviewer.received_review_output;
  if (kind === 'contradictory receipt') {
    source.reviewer.received_review_output.output = '{"overall":"FAIL","findings":[]}';
    source.reviewer.received_review_output.output_sha256 = digest(source.reviewer.received_review_output.output);
    source.reviewer.received_output_sha256 = digest(source.reviewer.received_review_output);
  }
  if (kind === 'missing packet') c.db.prepare('DELETE FROM automatic_attempts WHERE task_id=?').run(source.id);
  if (kind === 'changed publication identity') source.publication.pushed_branch = 'bridge/other';
  if (kind === 'different repository') source.repository.repository_id = 'different';
  if (kind === 'scope') v.input.contract.allowed_files.push('keep.txt');
  if (kind === 'owner') v.metadata.owner.id = 999;
  const mutations = { 'changed head': pr => { pr.head.sha = 'a'.repeat(40); }, closed: pr => { pr.state = 'closed'; },
    merged: pr => { pr.merged_at = '2026-01-01T00:00:00Z'; }, ready: pr => { pr.draft = false; },
    'head owner': pr => { pr.head.repo.full_name = 'other/repository'; }, 'base owner': pr => { pr.base.repo.full_name = 'other/repository'; },
    branch: pr => { pr.head.ref = 'other'; }, base: pr => { pr.base.ref = 'other'; }, 'wrong number': pr => { pr.number = 8; } };
  mode.pr = mutations[kind];
  c.db.prepare('UPDATE tasks SET value=? WHERE id=?').run(JSON.stringify(source), source.id);
  await assert.rejects(v.run(), /REVISION_|PUBLICATION_|GITHUB_REGISTRATION_/);
  assert.deepEqual(v.calls, []); assert.equal(publisher.pushes, 1); assert.equal(publisher.creates, 1);
  assert.equal(c.db.prepare('SELECT count(*) AS n FROM tasks').get().n, 1);
});

for (const kind of ['wrong backend', 'manual', 'extra turn', 'base selection', 'short sha', 'extra field', 'invalid number'])
test(`revision input rejects ${kind}`, async context => {
  const v = await revisionFixture(context);
  if (kind === 'wrong backend') v.input.execution_backend = 'agents_api';
  if (kind === 'manual') delete v.input.automatic;
  if (kind === 'extra turn') Object.assign(v.input.automatic, { max_codex_turns: 4, max_corrections: 1, review_protocol: LOCAL_ACTIONABILITY_REVIEW_VERSION });
  if (kind === 'base selection') v.input.base_ref = 'main';
  if (kind === 'short sha') v.input.revise_pr.expected_head_sha = '1234';
  if (kind === 'extra field') v.input.revise_pr.branch = 'main';
  if (kind === 'invalid number') v.input.revise_pr.pr_number = -1;
  await assert.rejects(v.run(), /INVALID_REVISION_AUTHORITY|INVALID_AUTOMATIC/);
  assert.equal(v.publisher.pushes, 1); assert.deepEqual(v.calls, []);
});

for (const kind of ['FAIL', 'failed validation', 'outside scope', 'reviewer termination', 'implementer termination', 'changed tree', 'missing evidence', 'reused reviewer'])
test(`revision ${kind} stops before branch update`, async context => {
  const mode = {};
  if (kind === 'FAIL') mode.verdict = 'FAIL';
  if (kind === 'outside scope') mode.outside = true;
  if (kind === 'reviewer termination') mode.closeFailure = 'reviewer';
  if (kind === 'implementer termination') mode.closeFailure = 'implementer';
  if (kind === 'reused reviewer') mode.reuseIdentity = true;
  if (kind === 'changed tree') mode.review = async options => fs.writeFile(path.join(path.dirname(options.cwd), 'repo/one.txt'), 'modified after validation\n');
  const v = await revisionFixture(context, mode);
  if (kind === 'failed validation') v.input.contract.test_commands = ['false'];
  if (kind === 'missing evidence') mode.review = async () => {
    const task = v.c.db.prepare('SELECT value FROM tasks WHERE id<>?').all(v.original.id).map(row => JSON.parse(row.value))[0];
    task.local_validation.termination_confirmed = false; v.c.save(task);
  };
  const task = await v.run();
  assert.notEqual(task.automatic.status, 'succeeded', JSON.stringify(task.automatic));
  assert.equal(v.publisher.pushes, 1); assert.equal(v.publisher.creates, 1);
  assert.equal(repoGit(v.remote, 'rev-parse', v.original.publication.pushed_branch).trim(), v.input.revise_pr.expected_head_sha);
  await v.unchanged();
});

for (const stage of ['after fetch', 'before publication', 'push advertisement', 'receive race'])
test(`revision changed head at ${stage} fails closed preserving the other actor`, async context => {
  const mode = {}, v = await revisionFixture(context, mode), branch = v.original.publication.pushed_branch;
  // Build an independent actor commit on the expected head. The staged
  // hooks also exercise branch changes after the push advertisement.
  const advance = () => {
    const commit = publicationGit(v.remote, ['commit-tree', repoGit(v.remote, 'rev-parse', `${v.input.revise_pr.expected_head_sha}^{tree}`).trim(), '-p', v.input.revise_pr.expected_head_sha],
      { input: 'Competing actor\n', env: { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }).trim();
    repoGit(v.remote, 'update-ref', `refs/heads/${branch}`, commit); return commit;
  };
  let other;
  if (stage === 'after fetch') mode.afterFetch = () => { other = advance(); };
  if (stage === 'before publication') mode.review = () => { other = advance(); };
  if (stage === 'push advertisement') v.publisher.beforePush = () => { other = advance(); };
  if (stage === 'receive race') {
    const hook = path.join(v.remote, 'hooks/pre-receive');
    // receive-pack has advertised the expected head, then a competing actor
    // changes it. Its old-OID transaction must reject our normal push.
    await fs.writeFile(hook, `#!/bin/sh\nread old new ref\nenv -u GIT_QUARANTINE_PATH git update-ref "$ref" "${v.baseline}"\n`, { mode: 0o700 });
    other = v.baseline;
  }
  if (stage === 'after fetch') await assert.rejects(v.run(), /PUBLICATION_PR_CONFLICT|REVISION_HEAD_CHANGED/);
  else assert.notEqual((await v.run()).automatic.status, 'succeeded');
  assert.equal(repoGit(v.remote, 'rev-parse', branch).trim(), other);
  assert.equal(v.publisher.creates, 1); await v.unchanged();
});

test('revision competing starts reserve one task and duplicate requests cannot duplicate turns', async context => {
  const v = await revisionFixture(context);
  const results = await Promise.allSettled([v.c.start(v.input), v.c.start({ ...v.input, request_id: 'competing_revision' })]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.match(results.find(row => row.status === 'rejected').reason.code, /REVISION_COMPETING_PUBLICATION/);
  await Promise.all([...v.c.jobs.values()]); await Promise.all([...v.c.automaticJobs.values()]);
  assert.equal(v.publisher.pushes, 2); assert.deepEqual(v.calls, ['implementer', 'reviewer']); await v.unchanged();
});

for (const lost of ['push acknowledgment', 'push before effect'])
test(`revision lost ${lost} and restart never resubmit or replay`, async context => {
  const v = await revisionFixture(context), push = v.publisher.push.bind(v.publisher);
  v.publisher.push = async (...args) => {
    if (lost === 'push acknowledgment') await push(...args);
    else v.publisher.pushes++;
    throw Error('Synthetic uncertain push');
  };
  const task = await v.run(); assert.equal(task.automatic.status, 'uncertain');
  assert.equal(task.publication.push_attempted, true); assert.equal(v.publisher.creates, 1); assert.equal(v.publisher.pushes, 2);
  const commit = task.publication.commit_sha;
  await v.c.close();
  const restarted = await new Controller({ stateRoot: v.c.stateRoot, workspaceRoot: v.c.workspaceRoot, publisher: v.publisher, secrets: [],
    localBackendFactory: () => { throw Error('EXECUTION REPLAY'); } }).init();
  try {
    const repeated = await restarted.start(v.input); assert.equal(repeated.task_id, task.id);
    assert.equal(restarted.task(task.id).publication.commit_sha, commit);
    assert.equal(restarted.task(task.id).automatic.status, 'uncertain');
    assert.equal(v.publisher.pushes, 2); assert.equal(v.publisher.creates, 1);
    await assert.rejects(restarted.start({ ...v.input, request_id: 'new_request_after_uncertainty' }), /REVISION_COMPETING_PUBLICATION/);
    assert.equal(v.publisher.pushes, 2);
    await assert.rejects(restarted.publish({ task_id: task.id, title: v.input.automatic.publish.title }), /AUTOMATIC_TASK_OWNS_TRANSITIONS/);
  } finally { await restarted.close(); }
});

test('revision expected-old-head guard rejects a remotely rewound ancestor that would permit fast-forward', async context => {
  const v = await revisionFixture(context), p = v.original.publication;
  const repo = path.join(v.c.workspaceRoot, v.original.id, 'repo');
  const commit = publicationGit(repo, ['commit-tree', p.reviewed_tree_sha, '-p', p.commit_sha], { input: 'Revision fixture\n',
    env: { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }).trim();
  repoGit(v.remote, 'update-ref', `refs/heads/${p.pushed_branch}`, v.baseline);
  // The ancestor relation alone would allow this push. The expected old OID is
  // checked against the advertisement at the actual production push boundary.
  repoGit(repo, 'merge-base', '--is-ancestor', v.baseline, commit);
  await assert.rejects(v.publisher.push(repo, p.target, p.pushed_branch, commit, v.c.stateRoot, p.commit_sha), /PUBLICATION_GIT_FAILED/);
  assert.equal(repoGit(v.remote, 'rev-parse', p.pushed_branch).trim(), v.baseline);
  assert.equal(v.publisher.creates, 1);
});

test('revision MCP schema is strict and the existing start_task tool executes the same-PR path', async context => {
  const v = await revisionFixture(context), server = createServer(v.c, async () => {});
  const client = new Client({ name: 'revision-fixture', version: '1' }), [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  context.after(async () => { await client.close(); await server.close(); });
  const tools = (await client.listTools()).tools, start = tools.find(tool => tool.name === 'start_task');
  assert.equal(start.inputSchema.properties.revise_pr.additionalProperties, false);
  assert(!tools.some(tool => tool.name === 'revise_pr'));
  for (const revise_pr of [{ ...v.input.revise_pr, branch: 'main' }, { ...v.input.revise_pr, expected_head_sha: 'short' },
    { ...v.input.revise_pr, pr_number: 1.5 }]) {
    const result = await client.callTool({ name: 'start_task', arguments: { ...v.input, revise_pr } });
    assert.equal(result.isError, true); assert.equal(v.publisher.pushes, 1); assert.deepEqual(v.calls, []);
  }
  const result = await client.callTool({ name: 'start_task', arguments: v.input });
  assert.notEqual(result.isError, true);
  await Promise.all([...v.c.jobs.values()]); await Promise.all([...v.c.automaticJobs.values()]);
  assert.equal(v.c.task(result.structuredContent.task_id).automatic.status, 'succeeded');
  await v.unchanged();
});

test('revision can revise the next confirmed head while retaining every prior task and review', async context => {
  const v = await revisionFixture(context), first = await v.run();
  assert.equal(first.automatic.status, 'succeeded');
  const retained = v.c.db.prepare('SELECT value FROM tasks WHERE id=?').get(first.id).value;
  v.mode.content = 'revised again\n';
  v.input.request_id = 'second_owner_revision'; v.input.revise_pr.expected_head_sha = first.publication.commit_sha;
  const second = await v.run();
  assert.equal(second.automatic.status, 'succeeded', JSON.stringify(second.automatic));
  assert.equal(second.revision.source_task_id, first.id); assert.equal(second.revision.original_task_id, v.original.id);
  assert.notEqual(first.reviewer.local.thread_id, second.reviewer.local.thread_id);
  assert.notEqual(first.local_validation.attempt_id, second.local_validation.attempt_id);
  assert.notEqual(first.reviewer.packet_hash, second.reviewer.packet_hash);
  assert.notEqual(first.reviewer.reviewed_git_state.tree_sha, second.reviewer.reviewed_git_state.tree_sha);
  for (const [task, parent, content] of [[first, v.original.publication.commit_sha, 'revised\n'],
    [second, first.publication.commit_sha, 'revised again\n']]) {
    const p = task.publication, reviewer = task.reviewer;
    assert.equal(repoGit(v.remote, 'show', '-s', '--format=%P', p.commit_sha).trim(), parent);
    assert.equal(repoGit(v.remote, 'show', `${p.commit_sha}:one.txt`), content);
    assert.equal(repoGit(v.remote, 'diff-tree', '--no-commit-id', '--name-only', '-r', parent, p.commit_sha).trim(), 'one.txt');
    assert.equal(repoGit(v.remote, 'rev-parse', `${p.commit_sha}^{tree}`).trim(), reviewer.reviewed_git_state.tree_sha);
    assert.equal(task.local_validation.status, 'completed');
    assert.equal(task.local_validation.results[0].status, 'passed');
    assert.equal(task.local_validation.results[0].stdout.text, content);
    assert.equal(task.local_validation.reviewed_git_state.tree_sha, reviewer.reviewed_git_state.tree_sha);
    assert.equal(reviewer.review_result.overall, 'PASS');
    assert.equal(reviewer.review_result.scope_qualification.status, 'qualified');
    assert.deepEqual(reviewer.review_result.controller_overrides, []);
    assert.equal(reviewer.review_result.packet_hash, reviewer.packet_hash);
    assert.equal(p.review_packet_sha256, reviewer.packet_hash);
    assert.equal(p.reviewed_tree_sha, reviewer.reviewed_git_state.tree_sha);
    assert.equal(p.reviewer_thread_id, reviewer.local.thread_id);
  }
  assert.equal(v.c.db.prepare('SELECT value FROM tasks WHERE id=?').get(first.id).value, retained);
  assert.equal((await reportingPublication(v.c, first.id)).confirmed, true);
  assert.equal((await reportingPublication(v.c, second.id)).confirmed, true);
  assert.equal(v.publisher.pushes, 3); assert.equal(v.publisher.creates, 1); await v.unchanged();
});

test('revision no-op fails its requested change in independent review without updating the PR', async context => {
  const v = await revisionFixture(context, { noWrite: true, review: async options => {
    const packet = JSON.parse(await fs.readFile(path.join(options.cwd, 'evidence.json'), 'utf8'));
    assert.deepEqual(packet.changed_files, []); assert.equal(packet.diff, '');
    assert.equal(packet.baseline['one.txt'], packet.current['one.txt']);
    return { overall: 'FAIL', findings: [
      { id: 'R1', status: 'FAIL', evidence: 'The requested revision made no change: one.txt is identical to its baseline and the diff is empty.' },
      { id: 'SCOPE', status: 'PASS', evidence: 'No file changes or prohibited operations observed in the bounded packet.' },
      { id: 'TEST_EVIDENCE', status: 'PASS', evidence: 'Independent cat one.txt validation passed for the unchanged candidate; this does not prove the requested change.' }
    ] };
  } });
  const task = await v.run(), reviewer = task.reviewer;
  assert.equal(task.automatic.status, 'stopped'); assert.equal(task.automatic.reason, 'PUBLICATION_REQUIRES_PASS_REVIEW');
  assert.equal(task.local_validation.status, 'completed'); assert.equal(task.local_validation.results[0].status, 'passed');
  assert.equal(reviewer.state, 'completed'); assert.equal(reviewer.review_result.model_overall, 'FAIL');
  assert.equal(reviewer.review_result.overall, 'FAIL'); assert.deepEqual(reviewer.review_result.controller_overrides, []);
  assert.equal(reviewer.review_result.scope_qualification.status, 'qualified');
  assert.equal(reviewer.review_result.findings.find(finding => finding.id === 'R1').status, 'FAIL');
  assert.equal(reviewer.reviewed_git_state.tree_sha, v.original.publication.reviewed_tree_sha);
  assert.equal(task.publication, undefined); assert.equal(v.publisher.pushes, 1); assert.equal(v.publisher.creates, 1);
  assert.equal(repoGit(v.remote, 'rev-parse', `refs/heads/${v.original.publication.pushed_branch}`).trim(), v.original.publication.commit_sha);
  assert.deepEqual(v.calls, ['implementer', 'reviewer']); await v.unchanged();
});

test('revision accepts a retained published task after workspace cleanup without thawing history', async context => {
  const v = await revisionFixture(context);
  await v.c.cleanup({ task_id: v.original.id, delete_workspace: true });
  const retained = v.c.db.prepare('SELECT value FROM tasks WHERE id=?').get(v.original.id).value;
  assert.equal((await v.c.qualifyPublicationEvidence(v.c.task(v.original.id))).confirmed, true);
  const task = await v.run();
  assert.equal(task.automatic.status, 'succeeded', JSON.stringify(task.automatic));
  assert.equal(v.c.db.prepare('SELECT value FROM tasks WHERE id=?').get(v.original.id).value, retained);
  assert.equal(v.publisher.pushes, 2); assert.equal(v.publisher.creates, 1);
});

test('revision accepts authenticated retained original Agents API publication without changing that workflow', async context => {
  const v = await revisionFixture(context, { sourceBackend: 'agents_api' });
  const task = await v.run();
  assert.equal(task.automatic.status, 'succeeded', JSON.stringify(task.automatic));
  assert.equal(repoGit(v.remote, 'rev-parse', `${task.publication.commit_sha}^`).trim(), v.original.publication.commit_sha);
  assert.notEqual(task.reviewer.local.thread_id, v.original.reviewer.session_id);
  assert.equal((await reportingPublication(v.c, task.id)).confirmed, true);
  assert.equal(v.publisher.pushes, 2); await v.unchanged();
});
