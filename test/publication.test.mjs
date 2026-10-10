import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Controller, digest } from '../controller.mjs';
import { GitHubPublisher, publicationGit, githubRepository } from '../publication.mjs';
import { repoGit, repositoryIdentity } from '../repositories.mjs';
import { FakeAPI, FakeExecutor } from './helpers.mjs';
import { createServer } from '../server.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { validateLocalReview, localScopeQualification } from '../local-reviewer-instructions.mjs';
import { observeLocalEvidence } from '../local-evidence.mjs';

class LocalPublisher extends GitHubPublisher {
  constructor(remote) { super(); this.remote = remote; this.pushes = 0; this.creates = 0; this.base = 'main'; }
  api() { throw Error('REAL GITHUB CALL FORBIDDEN IN TESTS'); }
  async target() { return { repository: 'fixture/isolated-publication', base: this.base, remote: this.remote }; }
  async push(...args) { this.pushes++; await this.beforePush?.(...args); return super.push(...args); }
  async findPR() { return this.pr || null; }
  async createPR(target, branch, input) {
    this.creates++; assert.equal(input.draft, true);
    this.pr = { number: 7, html_url: `https://github.com/${target.repository}/pull/7`, state: 'open', draft: true, merged_at: null,
      head: { ref: branch, sha: repoGit(this.remote, 'rev-parse', `refs/heads/${branch}`).trim(), repo: { full_name: target.repository } },
      base: { ref: target.base, repo: { full_name: target.repository } } };
    if (this.losePRResponse) throw Error('response lost');
    return this.pr;
  }
}
async function setup(t, allowed = ['one.txt'], local = false, commands = []) {
  const root = await fs.mkdtemp('/var/tmp/personal-agents-bridge/publication-test-');
  const normal = path.join(root, 'normal'), remote = path.join(root, 'remote.git');
  await fs.mkdir(normal); await fs.mkdir(remote);
  repoGit(normal, 'init', '--initial-branch=main'); repoGit(remote, 'init', '--bare', '--initial-branch=main');
  for (const name of ['keep.txt', 'delete.txt', 'rename.txt', 'run.sh']) await fs.writeFile(path.join(normal, name), `${name}\n`);
  repoGit(normal, 'add', '.'); repoGit(normal, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'baseline');
  repoGit(normal, 'remote', 'add', 'origin', remote); repoGit(normal, 'push', 'origin', 'HEAD:refs/heads/main');
  const baseline = repoGit(normal, 'rev-parse', 'HEAD').trim();
  const api = new FakeAPI(), executor = new FakeExecutor(), publisher = new LocalPublisher(remote);
  const c = await new Controller({ stateRoot: path.join(root, 'state'), workspaceRoot: path.join(root, 'tasks'), api, executor, publisher, secrets: [],
    ...(local ? { localBackendFactory: options => ({
      async run() {
        const identity = { model: 'fixture-model', threadId: options.reviewOnly ? 'independent-reviewer' : 'implementer-thread', turnId: 'fixture-turn',
          turnSubmissionAttempted: true, turnSubmissionAcknowledged: true, terminalObserved: true };
        options.onLifecycle({ ...identity, phase: 'turn_acknowledged' });
        options.onLifecycle({ ...identity, phase: 'terminal_observed', status: 'completed' });
        const findings = ['R1', 'SCOPE', 'TEST_EVIDENCE'].map(id => ({ id, status: 'PASS', evidence: 'Synthetic independent reviewer assessment.' }));
        return { ...identity, status: 'completed', authentication: 'chatgpt', uncertainties: [], commands: [],
          messages: options.reviewOnly ? [{ provenance: 'model', text: JSON.stringify({ overall: 'PASS', findings }) }] : [] };
      }, async cancel() {}, async close() { return true; },
    }) } : {}) }).init();
  t.after(async () => { await c.close(); await fs.rm(root, { recursive: true, force: true }); });
  await fs.writeFile(path.join(root, 'state/repositories.json'), JSON.stringify({ version: 1, repositories: { fixture: await repositoryIdentity(normal) } }), { mode: 0o600 });
  const contract = { goal: 'Local publication fixture', allowed_files: allowed, requirements: [{ id: 'R1', text: 'Make the exact fixture change.' }], invariants: [], test_commands: commands, initial_files: {} };
  const started = await c.start({ request_id: 'start_publication', repository_id: 'fixture', contract, ...(local ? { execution_backend: 'local_codex' } : {}) }); await Promise.all([...c.jobs.values()]);
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
  return { c, root, normal, remote, baseline, api, executor, publisher, id, work, input, review, contract };
}

test('qualified local PASS publishes the exact tree through the existing publisher, once, without Agents API identities', async context => {
  const value = await setup(context, ['one.txt'], true, ['test "$(cat one.txt)" = exact']);
  const { c, id, work, input, remote, baseline, publisher, api, executor } = value;
  await fs.writeFile(path.join(work, 'one.txt'), 'exact\n'); await value.review();
  const reviewed = c.task(id).reviewer, qualification = reviewed.review_result.scope_qualification;
  assert.equal(qualification.status, 'qualified'); assert(qualification.limitations.length > 0);
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
