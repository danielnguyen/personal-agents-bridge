import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Controller, contractMarkdown } from '../controller.mjs';
import { repositoryIdentity, repoGit } from '../repositories.mjs';
import { reviewerInstructions } from '../reviewer-instructions.mjs';
import { FakeAPI, FakeExecutor } from './helpers.mjs';

// Offline reviewer-input regressions, not simulated model judgments. Exercise the
// real packet/session builder and assert both the decision rule delivered to the
// reviewer and the evidence that rule needs. No API access or preserved task reads.
async function fixture(t, { prohibition, observed, observedReadPath, missingController, conflictingController, unauthorized, missingTest, omitted = 1 } = {}) {
  const root = await fs.mkdtemp('/var/tmp/personal-agents-bridge/reviewer-semantics-');
  const normal = path.join(root, 'normal'); await fs.mkdir(normal);
  repoGit(normal, 'init', '--initial-branch=main');
  await fs.writeFile(path.join(normal, 'AGENTS.md'), 'Original instructions\n');
  repoGit(normal, 'add', '.');
  repoGit(normal, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture');
  const api = new FakeAPI(), executor = new FakeExecutor();
  const c = await new Controller({ stateRoot: path.join(root, 'state'), workspaceRoot: path.join(root, 'work'), api, executor, secrets: [] }).init();
  t.after(async () => { await c.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await fs.writeFile(path.join(c.stateRoot, 'repositories.json'), JSON.stringify({ version: 1, repositories: { fixture: await repositoryIdentity(normal) } }), { mode: 0o600 });
  const contract = { goal: 'Update AGENTS.md only.', allowed_files: ['AGENTS.md'],
    requirements: [{ id: 'R1', text: 'Replace the instructions with Revised instructions followed by a newline.' }],
    invariants: prohibition ? [{ id: 'I1', text: prohibition }] : [], test_commands: ['git diff --check'], initial_files: {} };
  const x = await c.start({ contract, repository_id: 'fixture', request_id: 'semantics_fixture' });
  await Promise.all([...c.jobs.values()]);
  const task = c.task(x.task_id), repo = path.join(c.workspaceRoot, task.id, 'repo');
  assert.equal(task.implementer.error, undefined);
  await fs.writeFile(path.join(repo, 'AGENTS.md'), 'Revised instructions\n');
  if (unauthorized) await fs.writeFile(path.join(repo, 'unexpected.txt'), 'Unauthorized change\n');
  const control = path.join(c.workspaceRoot, task.id, 'implementer-runtime/sandbox-fixture/control');
  await fs.mkdir(control, { recursive: true });
  // Synthetic history with 73 observed operations, 72 retained.
  // Deliberately short records keep this fixture independent of evidence limits.
  const records = Array.from({ length: 72 }, (_, i) => ({ operation_id: `fixture:${i + 1}`, sequence: i + 1,
    method: 'fs/readFile', targets: [{ kind: 'target', classification: 'worktree', path: 'AGENTS.md' }], outcome: 'succeeded', success: true }));
  if (observed) Object.assign(records[0], { method: observed === 'write' ? 'fs/writeFile' : 'fs/readFile',
    targets: [{ kind: 'target', classification: 'outside', path: null }],
    outcome: observed === 'write' ? 'denied' : 'succeeded', success: observed !== 'write' });
  await fs.writeFile(path.join(control, 'file-rpc.json'), JSON.stringify({ version: 1, initialized: true, closed: true,
    instance_id: 'fixture', started_at: '2026-01-01T00:00:00Z', observed: records.length + omitted, omitted, records }));
  Object.assign(task.implementer.executor.isolation_evidence, { file_rpc_coverage_from_first_executor: true, file_rpc_generation: 1 });
  if (missingController) delete task.implementer.executor.isolation_evidence;
  c.save(task);
  if (conflictingController) await fs.writeFile(path.join(normal, 'AGENTS.md'), 'Unexpected normal checkout mutation\n');
  const items = api.rows.get(task.implementer.session_id).items;
  items.push({ type: 'command_execution', id: 'long_command', command: 'printf ' + 'x'.repeat(2200), output: '', exit_code: 0 });
  if (observedReadPath) items.push({ type: 'command_execution', id: 'prohibited_read', command: `cat ${observedReadPath}`, output: '', exit_code: 0 });
  if (!missingTest) items.push({ type: 'command_execution', id: 'required_test', command: 'git diff --check', output: '', exit_code: 0 });
  api.completed(task.implementer.session_id);
  await c.review({ task_id: task.id, request_id: 'semantics_review' });
  await Promise.all([...c.jobs.values()]);
  const saved = c.task(task.id);
  assert.equal(saved.reviewer.error, undefined);
  const packet = JSON.parse(await fs.readFile(path.join(c.workspaceRoot, task.id, saved.reviewer.packet_directory, 'evidence.json')));
  const instructions = api.created.at(-1).agent.instructions;
  assert.equal(instructions, reviewerInstructions);
  assert.doesNotMatch(instructions, /Missing or conflicting evidence is FAIL\./);
  const taskMarkdown = await fs.readFile(path.join(repo, 'TASK.md'), 'utf8');
  const savedContract = JSON.parse(await fs.readFile(path.join(c.workspaceRoot, task.id, 'contract.json'), 'utf8'));
  assert.deepEqual(savedContract, contract); // Normalization/storage must not add prohibitions.
  assert.equal(taskMarkdown, contractMarkdown(contract));
  assert.equal(packet.contract, taskMarkdown);
  return { packet, instructions, taskMarkdown, contract, implementerInstructions: api.created[0].agent.instructions };
}

function provenScope(packet) {
  const e = packet.controller_evidence;
  assert.equal(e.provenance, 'controller');
  assert.equal(e.task_worktree.status, 'validated');
  assert.equal(e.normal_checkout.comparison.status, 'unchanged');
  assert.equal(e.git_operations.comparison.status, 'unchanged');
  assert.equal(e.git_operations.executor_isolation.coverage_from_first_executor, true);
  assert.equal(e.git_operations.filesystem_enforcement, 'worktree_and_task_scratch_only; file RPCs also sandboxed');
  assert.equal(e.git_operations.remote_operations_verification, 'network_denied_by_controller_sandbox');
  assert.deepEqual(packet.unauthorized_files, []);
}

test('optional history gaps direct SCOPE PASS when boundaries/final scope are proven', async t => {
  const { packet: p, instructions, taskMarkdown, implementerInstructions } = await fixture(t);
  provenScope(p);
  assert.deepEqual(p.changed_files, ['AGENTS.md']);
  assert.equal(p.file_rpc_operation_evidence.observed_operations, 73);
  assert.equal(p.file_rpc_operation_evidence.omitted_records, 1);
  assert.equal(p.file_rpc_operation_evidence.capture_complete, false);
  assert.equal(p.packet_budget.sections.file_rpc_operation_evidence.complete, false);
  assert.equal(p.test_execution_evidence[0].exit_code, 0);
  for (const generated of [taskMarkdown, p.contract, implementerInstructions]) {
    assert.doesNotMatch(generated, /No[^\n.]*(?:credentials|external paths|external repositories)/);
    assert.doesNotMatch(generated, /Never inspect credentials or process environments/);
    assert.match(generated, /These execution rules add no credential-read or external-path-read prohibition/);
    assert.match(generated, /Follow explicit task read prohibitions and any actual sandbox read denials/);
  }
  assert.match(instructions, /review scope applies to you, not to the implementation being reviewed; it adds no read prohibition to the task contract/);
  assert.match(instructions, /If relevant structural boundaries and final allowed-file scope are independently proven, no prohibited operation is observed, and missing history is not needed for any explicit task prohibition or required fact, SCOPE is PASS/);
  assert.match(instructions, /Before passing despite a gap, cite the controller proof/);
});

test('truncated command text without a relevant prohibition is not automatically FAIL', async t => {
  const { packet: p, instructions } = await fixture(t, { omitted: 0 });
  provenScope(p);
  assert.equal(p.file_rpc_operation_evidence.capture_complete, true);
  assert.equal(p.command_execution_evidence.records[0].truncated, true);
  assert.equal(p.command_execution_evidence.records[0].command.length, 2048);
  assert.equal(p.packet_budget.sections.command_execution_evidence.complete, false);
  assert.match(instructions, /Truncated command text without a relevant task-specific prohibition or other required fact depending on the missing text is not automatically SCOPE FAIL/);
});

const prohibitedPaths = ['/home/example/.config/provider/credentials.json', '/srv/private/reference.txt'];
for (const prohibition of ['Do not read /private/data.', 'Do not access credentials.', ...prohibitedPaths.map(p => `Do not read ${p}.`)]) test(`explicit prohibition with incomplete history directs FAIL: ${prohibition}`, async t => {
  const { packet: p, instructions, taskMarkdown, contract } = await fixture(t, { prohibition });
  provenScope(p);
  assert.equal(contract.invariants[0].text, prohibition);
  assert(taskMarkdown.includes(`- I1: ${prohibition}\n`));
  assert(p.contract.includes(`- I1: ${prohibition}\n`));
  assert.equal(p.file_rpc_operation_evidence.capture_complete, false);
  assert.match(instructions, /missing, truncated or conflicting required history is FAIL/);
  assert.match(instructions, /Broad-read sandbox policy does not prove compliance with a narrower read prohibition/);
  assert.match(instructions, /If an explicit prohibited read cannot be ruled out with sufficient required evidence, SCOPE is FAIL/);
});

for (const prohibitedPath of prohibitedPaths) test(`exact explicit path prohibition survives generation and observed violation directs FAIL: ${prohibitedPath}`, async t => {
  const prohibition = `Do not read ${prohibitedPath}.`;
  const { packet: p, instructions, taskMarkdown } = await fixture(t, { prohibition, observed: 'read', observedReadPath: prohibitedPath, omitted: 0 });
  provenScope(p);
  assert(taskMarkdown.includes(prohibition));
  assert(p.contract.includes(prohibition));
  const read = p.command_execution_evidence.records.find(r => r.item_id === 'prohibited_read');
  assert.equal(read.command, `cat ${prohibitedPath}`);
  assert.equal(read.exit_code, 0);
  assert.equal(read.truncated, false);
  // RPC paths outside the worktree are intentionally omitted; the command record
  // supplies the exact prohibited path, rather than inferring it from "outside".
  assert.equal(p.file_rpc_operation_evidence.records[0].targets[0].path, null);
  assert.match(instructions, /Observed prohibited credential or external reads still FAIL/);
});

test('contract generation preserves explicit read clauses verbatim in every user-authored section', () => {
  const prohibition = 'Do not read /home/example/.config/provider/credentials.json or /srv/private/reference.txt.';
  const contract = { goal: prohibition, allowed_files: ['AGENTS.md'], requirements: [{ id: 'R1', text: prohibition }],
    invariants: [{ id: 'I1', text: prohibition }], test_commands: [] };
  const before = structuredClone(contract), markdown = contractMarkdown(contract);
  assert.deepEqual(contract, before);
  assert(markdown.includes(`## Goal\n${prohibition}\n`));
  assert(markdown.includes(`- R1: ${prohibition}\n`));
  assert(markdown.includes(`- I1: ${prohibition}\n`));
});

test('observed prohibited outside read directs FAIL even with complete RPC capture', async t => {
  const { packet: p, instructions } = await fixture(t, { prohibition: 'Do not read outside the worktree.', observed: 'read', omitted: 0 });
  provenScope(p);
  assert.equal(p.file_rpc_operation_evidence.capture_complete, true);
  assert.equal(p.file_rpc_operation_evidence.records[0].targets[0].classification, 'outside');
  assert.equal(p.file_rpc_operation_evidence.records[0].success, true);
  assert.match(instructions, /Observed prohibited credential or external reads still FAIL/);
});

test('observed denied outside write directs FAIL despite proven confinement', async t => {
  const { packet: p, instructions, taskMarkdown, implementerInstructions } = await fixture(t, { observed: 'write' });
  provenScope(p);
  assert.equal(p.file_rpc_operation_evidence.records[0].method, 'fs/writeFile');
  assert.equal(p.file_rpc_operation_evidence.records[0].outcome, 'denied');
  assert.match(instructions, /observed write attempt outside the worktree\/task scratch is SCOPE FAIL even if denied/);
  assert.match(instructions, /Observed prohibited writes, network operations or Git operations also FAIL, including denied attempts/);
  for (const generated of [taskMarkdown, p.contract, implementerInstructions]) {
    assert.match(generated, /writes outside the task worktree\/task scratch are prohibited/);
    assert.match(generated, /command\/file-worker networking is denied/);
    assert.match(generated, /protected Git\/controller paths remain read-only/);
    assert.match(generated, /normal checkout must remain unmodified/);
    assert.match(generated, /Never modify TASK.md, .codex, Git history\/index\/configuration/);
    assert.match(generated, /No commits, pushes, merges, rebases, tags, remote branch changes, dependency installations, network calls, or subagents/);
  }
});

for (const mode of ['missingController', 'conflictingController']) test(`${mode} confinement evidence directs FAIL`, async t => {
  const { packet: p, instructions } = await fixture(t, { [mode]: true });
  if (mode === 'missingController') assert.equal(p.controller_evidence.git_operations.filesystem_enforcement, 'complete_enforcement_evidence_unavailable');
  else assert.equal(p.controller_evidence.normal_checkout.comparison.status, 'conflicting');
  assert.match(instructions, /Missing or conflicting controller confinement evidence is SCOPE FAIL/);
  assert.match(instructions, /an unchanged final diff, command history, or implementer assertion cannot repair it/);
});

test('final unauthorized file change directs FAIL within a confined worktree', async t => {
  const { packet: p, instructions } = await fixture(t, { unauthorized: true });
  assert.deepEqual(p.unauthorized_files, ['unexpected.txt']);
  assert.equal(p.current['unexpected.txt'], 'Unauthorized change\n');
  assert.match(instructions, /Any final unauthorized file change is SCOPE FAIL/);
});

test('missing required test evidence directs TEST_EVIDENCE FAIL independently of scope', async t => {
  const { packet: p, instructions } = await fixture(t, { missingTest: true });
  provenScope(p);
  assert.deepEqual(p.test_execution_evidence, []);
  assert.deepEqual(p.command_execution_evidence.required_test_commands_missing, ['git diff --check']);
  assert.equal(p.packet_budget.sections.test_execution_evidence.complete, false);
  assert.match(instructions, /Required test evidence missing, conflicting, or insufficient to establish the required command\/result is TEST_EVIDENCE FAIL/);
});
