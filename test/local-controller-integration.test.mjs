import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Controller, contractMarkdown } from '../controller.mjs';
import { repositoryIdentity, repoGit } from '../repositories.mjs';
import { createServer } from '../server.mjs';
import { FakeAPI, FakeExecutor, contract } from './helpers.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { LocalCodexBackend } from '../local-codex-backend.mjs';

class FakeLocal {
  constructor(options, mode = {}) { this.options = options; this.mode = mode; this.calls = []; }
  emit(phase, extra = {}) { this.options.onLifecycle({ ...this.identity, phase, ...extra }); }
  async run(input) {
    this.calls.push('run'); this.input = input;
    this.identity = { model: 'gpt-6-astra', threadId: null, turnId: null, turnSubmissionAttempted: false, turnSubmissionAcknowledged: false, terminalObserved: false };
    const pending = new Promise(resolve => { this.resolve = resolve; });
    this.emit('model_selected');
    this.identity.threadId = 'thread-fixture'; this.emit('thread_acknowledged');
    this.identity.turnSubmissionAttempted = true; this.emit('turn_submitting');
    if (!this.mode.unacknowledged) { this.identity.turnId = 'turn-fixture'; this.identity.turnSubmissionAcknowledged = true; this.emit('turn_acknowledged'); }
    this.options.onProgress({ method: 'item/agentMessage/delta', params: { delta: 'Model says test-sensitive-value token=private https://private.invalid' } });
    if (this.mode.status) this.finish(this.mode.status, this.mode.terminal !== false);
    return pending;
  }
  finish(status = 'completed', terminal = true) {
    this.identity.terminalObserved = terminal;
    if (terminal) this.emit('terminal_observed', { status });
    this.resolve({ ...this.identity, status, commands: [{ command: 'untrusted test', exitCode: 0 }], messages: [], uncertainties: ['Evidence is incomplete: test-sensitive-value token=private https://private.invalid'] });
  }
  respondToRequest(input) {
    this.mode.onDeliver?.(input);
    this.calls.push('respond'); this.responses ||= []; this.responses.push(input);
    this.emit('human_response_submitting', { request: { id: input.requestId } });
    if (this.mode.deliveryFails) throw Error('Synthetic transport loss');
    this.emit('human_response_sent', { request: { id: input.requestId } });
  }
  async cancel() { this.calls.push('cancel'); if (!this.mode.ignoreCancel && this.resolve) this.finish('interrupted'); }
  async close() { this.calls.push('close'); if (this.mode.closeFails) return false; if (this.resolve && !this.identity.terminalObserved) this.finish('interrupted', false); return true; }
}

async function setup(context, mode = {}, options = {}) {
  const root = await fs.mkdtemp('/tmp/pab-local-controller-'), normal = path.join(root, 'normal');
  await fs.mkdir(normal);
  repoGit(normal, 'init', '--initial-branch=main');
  await fs.writeFile(path.join(normal, 'greeting.txt'), 'baseline\n');
  repoGit(normal, 'add', '.');
  repoGit(normal, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'baseline');
  const baseline = repoGit(normal, 'rev-parse', 'HEAD').trim();
  await fs.writeFile(path.join(normal, 'greeting.txt'), 'uncommitted owner work\n');
  const api = new FakeAPI(), executor = new FakeExecutor(), instances = [];
  const config = { stateRoot: path.join(root, 'state'), workspaceRoot: path.join(root, 'work'), executor, secrets: ['test-sensitive-value'],
    ...(options.noApi ? {} : { api }), localBackendFactory: options.localBackendFactory || (backendOptions => { const instance = new FakeLocal(backendOptions, mode); instances.push(instance); return instance; }) };
  const controller = await new Controller(config).init();
  await fs.writeFile(path.join(controller.stateRoot, 'repositories.json'), JSON.stringify({ version: 1, repositories: { fixture: await repositoryIdentity(normal) } }), { mode: 0o600 });
  context.after(async () => { await controller.close(); await fs.rm(root, { recursive: true, force: true }); });
  const input = { contract: contract(), request_id: 'local_start_request', repository_id: 'fixture', execution_backend: 'local_codex' };
  const start = () => controller.start(input);
  const running = async (index = 0) => {
    for (let attempt = 0; attempt < 300; attempt++) {
      if (instances[index]?.resolve) return instances[index];
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('Local execution did not start');
  };
  const drain = () => Promise.all([...controller.jobs.values()]);
  return { controller, config, api, executor, root, normal, baseline, input, instances, start, running, drain };
}

test('local opt-in reuses owned worktree, baseline, contract and audit without Agents API sessions', async context => {
  const value = await setup(context);
  const { controller, input, normal, baseline } = value;
  const result = await controller.invoke('start_task', input, { requestId: 'mcp_start' }, params => controller.start(params));
  const backend = await value.running(), repo = path.join(controller.workspaceRoot, result.task_id, 'repo');
  const saved = controller.task(result.task_id), local = saved.implementer.local;
  assert.equal(saved.execution_backend, 'local_codex'); assert.equal(saved.baseline, baseline);
  assert.equal(saved.repository.worktree_id, result.task_id); assert.equal(saved.repository.branch, `bridge/${result.task_id}`);
  assert.equal(backend.options.cwd, repo); assert.deepEqual(backend.input.allowedFiles, input.contract.allowed_files);
  assert.equal(await fs.readFile(path.join(repo, 'TASK.md'), 'utf8'), contractMarkdown(input.contract, 'local_codex'));
  assert.match(backend.input.prompt, /This contract is authoritative/); assert(!backend.input.prompt.includes('controller_repository_sandbox'));
  assert.equal(saved.implementer.executor, undefined); assert.equal(saved.file_rpc_evidence, undefined);
  assert.equal(await fs.readFile(path.join(normal, 'greeting.txt'), 'utf8'), 'uncommitted owner work\n');
  assert.equal(local.thread_id, 'thread-fixture'); assert.equal(local.turn_id, 'turn-fixture'); assert.equal(local.model, 'gpt-6-astra');
  assert.equal(local.turn_submission_attempted, true); assert.equal(local.turn_submission_acknowledged, true); assert.equal(local.terminal_observed, false);
  const durable = JSON.parse(controller.db.prepare('SELECT value FROM tasks WHERE id=?').get(result.task_id).value);
  assert.deepEqual(durable.implementer.local, local);
  const audit = JSON.parse(controller.db.prepare('SELECT value FROM audit').get().value);
  assert.equal(audit.codex_thread_id, local.thread_id); assert.equal(audit.codex_turn_id, local.turn_id); assert.equal(audit.session_id, null); assert.equal(audit.turn_id, null);
  assert.equal(value.api.created.length, 0); assert.equal(value.api.sent.length, 0); assert.equal(value.api.streamCount, 0); assert.equal(value.executor.started.length, 0);
  backend.finish(); await value.drain();
});

test('local-only initialization and execution do not construct an inference API client or require a key', async context => {
  const previous = process.env.OPENAI_API_KEY; delete process.env.OPENAI_API_KEY;
  try {
    const value = await setup(context, { status: 'completed' }, { noApi: true });
    const result = await value.start(); await value.drain();
    assert.equal((await value.controller.get(result.task_id)).state, 'completed');
    assert.equal(value.controller._api, undefined);
    await value.controller.cleanup({ task_id: result.task_id }); await value.controller.close();
    assert.equal(value.controller._api, undefined);
  } finally { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; }
});

function nativeItem(backend, item, method = 'item/completed') {
  backend.options.onProgress({ method, params: { threadId: backend.identity.threadId, turnId: backend.identity.turnId, item } });
}

test('local notification evidence is durable before completion and packets reuse controller Git snapshots without API evidence', async context => {
  const value = await setup(context, {}, { noApi: true });
  value.input.contract.test_commands = ['python3 check.py', 'python3 missing.py'];
  const started = await value.start(), backend = await value.running(), { controller } = value;
  const repo = path.join(controller.workspaceRoot, started.task_id, 'repo');
  const item = { type: 'commandExecution', id: 'native-test', command: 'python3 check.py', cwd: repo, status: 'inProgress' };
  nativeItem(backend, item, 'item/started');
  let durable = JSON.parse(controller.db.prepare('SELECT value FROM tasks WHERE id=?').get(started.task_id).value);
  assert.equal(durable.local_execution_evidence.commands[0].start_observed, true);
  assert.equal(durable.implementer.local.terminal_observed, false);
  await assert.rejects(controller.buildPacket(durable), /LOCAL_EVIDENCE_EXECUTION_NOT_CLOSED/);
  nativeItem(backend, { ...item, status: 'completed', exitCode: 0, aggregatedOutput: 'ok token=private\n' });
  nativeItem(backend, { type: 'fileChange', id: 'native-file', status: 'completed', changes: [
    { path: path.join(repo, 'greeting.txt'), kind: { type: 'update', move_path: null }, diff: '+model claim\n' },
  ] });
  durable = JSON.parse(controller.db.prepare('SELECT value FROM tasks WHERE id=?').get(started.task_id).value);
  assert.equal(durable.local_execution_evidence.commands[0].exit_code, 0);
  assert.equal(durable.local_execution_evidence.file_changes[0].start_observed, false);
  assert.equal(durable.implementer.local.terminal_observed, false);
  await fs.writeFile(path.join(repo, 'greeting.txt'), 'actual controller-observed contents\n');
  await fs.writeFile(path.join(repo, 'unauthorized.txt'), 'unauthorized\n');
  backend.finish(); await value.drain();
  const packet = await controller.buildPacket(controller.task(started.task_id)), data = JSON.parse(packet.text);
  assert.equal(data.evidence_version, 'pab.local-codex-review.v1');
  assert.equal(data.current['greeting.txt'], 'actual controller-observed contents\n');
  assert.equal(data.baseline['greeting.txt'], 'baseline\n');
  assert.equal(data.file_byte_evidence['greeting.txt'].provenance, 'controller');
  assert.equal(data.baseline_commit, value.baseline); assert.equal(data.current_commit, value.baseline);
  assert.equal(data.baseline_state.head, value.baseline);
  assert.equal(data.current_config_hash, data.baseline_state.config_hash);
  assert.deepEqual(data.unauthorized_files, ['unauthorized.txt']);
  assert.equal(data.controller_evidence.normal_checkout.comparison.status, 'unchanged');
  assert.equal(data.controller_evidence.task_worktree.status, 'validated');
  assert.equal(data.controller_evidence.git_operations.executor_isolation.status, 'unavailable');
  assert.equal(data.native_activity.commands[0].provenance, 'codex_app_server_notification');
  assert.equal(data.required_test_correlation.tests[0].status, 'native_observations_only');
  assert.equal(data.required_test_correlation.tests[1].status, 'unmatched');
  assert.equal(data.independent_validation.status, 'unavailable');
  assert.equal(data.command_execution_evidence, undefined); assert.equal(data.file_rpc_operation_evidence, undefined);
  assert.equal(controller.task(started.task_id).file_rpc_evidence, undefined); assert.equal(controller._api, undefined);
  assert(!packet.text.includes('Model says')); assert(!packet.text.includes('untrusted test')); assert(!packet.text.includes('token=private'));
  assert.equal(data.gates.local_review, 'disabled'); assert.equal(data.gates.local_publication, 'disabled');
  await assert.rejects(controller.review({ task_id: started.task_id, request_id: 'local_packet_review' }), /LOCAL_REVIEW_UNSUPPORTED/);
  await assert.rejects(controller.publish({ task_id: started.task_id, title: 'No' }), /LOCAL_PUBLISH_UNSUPPORTED/);
});

test('packet detects changed original checkout rather than trusting local command claims', async context => {
  const value = await setup(context, { status: 'completed' });
  const started = await value.start(); await value.drain();
  await fs.writeFile(path.join(value.normal, 'greeting.txt'), 'changed after baseline capture\n');
  const data = JSON.parse((await value.controller.buildPacket(value.controller.task(started.task_id))).text);
  assert.equal(data.controller_evidence.normal_checkout.comparison.status, 'conflicting');
  assert.deepEqual(data.native_activity.commands, []);
  assert.equal(data.independent_validation.status, 'unavailable');
});

test('local packet refuses altered worktree mapping and TASK.md using existing checks', async context => {
  const value = await setup(context, { status: 'completed' });
  const started = await value.start(); await value.drain();
  const task = value.controller.task(started.task_id), repo = path.join(value.controller.workspaceRoot, task.id, 'repo');
  const taskText = await fs.readFile(path.join(repo, 'TASK.md'), 'utf8');
  await fs.writeFile(path.join(repo, 'TASK.md'), 'tampered');
  await assert.rejects(value.controller.buildPacket(task), /TASK_CONTRACT_CHANGED/);
  await fs.writeFile(path.join(repo, 'TASK.md'), taskText);
  repoGit(repo, 'checkout', '-b', 'unexpected');
  await assert.rejects(value.controller.buildPacket(task), /TASK_BRANCH_CHANGED/);
});

test('local notification persistence failure propagates without retaining fabricated evidence', async context => {
  const value = await setup(context), started = await value.start(), backend = await value.running();
  const save = value.controller.save;
  value.controller.save = () => { throw Error('synthetic write failure'); };
  try {
    assert.throws(() => nativeItem(backend, { type: 'commandExecution', id: 'lost', command: 'true', cwd: backend.options.cwd, status: 'completed', exitCode: 0, aggregatedOutput: '' }), /synthetic write failure/);
  } finally { value.controller.save = save; }
  assert.deepEqual(value.controller.task(started.task_id).local_execution_evidence.commands, []);
  backend.finish('uncertain', false); await value.drain();
  const data = JSON.parse((await value.controller.buildPacket(value.controller.task(started.task_id))).text);
  assert.equal(data.execution.state, 'uncertain'); assert.equal(data.execution.terminal_observed, false);
});

for (const status of ['failed', 'interrupted', 'uncertain']) test(`local packet preserves incomplete command and ${status} lifecycle`, async context => {
  const value = await setup(context), started = await value.start(), backend = await value.running();
  nativeItem(backend, { type: 'commandExecution', id: 'incomplete', command: 'true', cwd: backend.options.cwd, status: 'inProgress' }, 'item/started');
  backend.finish(status, status !== 'uncertain'); await value.drain();
  const data = JSON.parse((await value.controller.buildPacket(value.controller.task(started.task_id))).text);
  assert.equal(data.execution.state, status); assert(data.native_activity.commands[0].missing.includes('completion'));
  assert.equal(data.native_activity.commands[0].exit_code, null); assert.equal(data.native_activity.exhaustive, false);
});

test('pre-ledger local tasks expose unavailable history, not a reconstructed success', async context => {
  const value = await setup(context, { status: 'completed' }), started = await value.start(); await value.drain();
  const task = value.controller.task(started.task_id); delete task.local_execution_evidence; value.controller.save(task);
  const data = JSON.parse((await value.controller.buildPacket(task)).text);
  assert.equal(data.native_activity.status, 'unavailable'); assert.equal(data.independent_validation.status, 'unavailable');
});

test('local packet overflow persists shared size diagnostics without API retrieval or section loss', async context => {
  const value = await setup(context, { status: 'completed' }, { noApi: true }), started = await value.start(); await value.drain();
  await fs.writeFile(path.join(value.controller.workspaceRoot, started.task_id, 'repo/greeting.txt'), 'x'.repeat(70000));
  await assert.rejects(value.controller.buildPacket(value.controller.task(started.task_id)), error =>
    error.code === 'EVIDENCE_SIZE_LIMIT' && error.diagnostic.required_section === 'local_packet');
  const saved = value.controller.task(started.task_id);
  assert.equal(saved.review_packet_diagnostic.limit_bytes, 128 * 1024);
  assert(saved.review_packet_diagnostic.measured_bytes > 128 * 1024);
  assert.equal(saved.reviewer, undefined); assert.equal(value.controller._api, undefined);
});

test('unconfirmed app-server closure blocks local packet preparation even after job settlement', async context => {
  const value = await setup(context, { status: 'completed', closeFails: true }), started = await value.start(); await value.drain();
  const saved = value.controller.task(started.task_id);
  assert.equal(saved.implementer.local.server_closed, false);
  await assert.rejects(value.controller.buildPacket(saved), /LOCAL_EVIDENCE_EXECUTION_NOT_CLOSED/);
});

test('invalid backend, unsupported non-repository local tasks and protected scope fail before provisioning', async context => {
  const value = await setup(context);
  for (const execution_backend of ['other', null, 1]) await assert.rejects(value.controller.start({ ...value.input, execution_backend }), /INVALID_EXECUTION_BACKEND/);
  await assert.rejects(value.controller.start({ ...value.input, repository_id: undefined }), /LOCAL_CODEX_REQUIRES_REPOSITORY/);
  await assert.rejects(value.controller.start({ ...value.input, repository_id: 'unknown' }), /UNKNOWN_REPOSITORY_ID/);
  for (const file of ['TASK.md', '.codex/config.toml', '.git/config', '../escape']) await assert.rejects(value.controller.start({ ...value.input, contract: { ...contract(), allowed_files: [file] } }), /INVALID_WORKSPACE_PATH/);
  assert.equal(value.controller.db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 0);
  assert.deepEqual(await fs.readdir(value.controller.workspaceRoot), []); assert.equal(value.instances.length, 0); assert.equal(value.api.created.length, 0);
});

for (const status of ['completed', 'failed', 'interrupted', 'uncertain']) test(`persisted local ${status} is distinct and model prose is not test evidence`, async context => {
  const value = await setup(context, { status, terminal: status !== 'uncertain' });
  const started = await value.start(); await value.drain();
  const result = await value.controller.get(started.task_id);
  assert.equal(result.state, status); assert.equal(result.implementer.local.execution_state, status);
  assert.equal(result.implementer.latest_output_source, 'model'); assert.match(result.implementer.evidence_notice, /no exhaustive command history/);
  assert.equal(result.implementer.session_id, null); assert.equal(result.implementer.turn_id, null);
  assert(!JSON.stringify(result).includes('test-sensitive-value')); assert(!JSON.stringify(result).includes('https://private.invalid')); assert(!JSON.stringify(result).includes('token=private'));
  assert.equal(result.implementer.local.command_count, 1); assert.equal(result.implementer.local.subscription_usage_attribution, 'unverified');
  assert.equal(value.controller.task(started.task_id).command_execution_evidence, undefined);
});

test('a completed result without a terminal event is uncertain, and missing turn acknowledgements stay missing', async context => {
  const value = await setup(context, { status: 'completed', terminal: false, unacknowledged: true });
  const started = await value.start(); await value.drain();
  const result = await value.controller.get(started.task_id);
  assert.equal(result.state, 'uncertain'); assert.equal(result.implementer.local.turn_id, null);
  assert.equal(result.implementer.local.turn_submission_attempted, true); assert.equal(result.implementer.local.turn_submission_acknowledged, false);
});

test('request retries do not execute twice or permit changing a task backend', async context => {
  const value = await setup(context), started = await value.start(); await value.running();
  const repeated = await value.start(); assert.equal(repeated.task_id, started.task_id); assert.equal(value.instances.length, 1);
  for (const execution_backend of ['agents_api', undefined]) await assert.rejects(value.controller.start({ ...value.input, execution_backend }), /REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT/);
  assert.equal(value.api.created.length, 0); assert.equal(value.controller.task(started.task_id).execution_backend, 'local_codex');
});

for (const method of ['item/permissions/requestApproval']) test(`human request ${method} cannot approve itself or become task success`, async context => {
  const value = await setup(context), started = await value.start(), backend = await value.running();
  const params = { command: 'test-sensitive-value token=private https://private.invalid ' + 'x'.repeat(5000), questions: [{ id: 'question', question: 'Which name?' }] };
  backend.emit('human_request', { request: { id: 42, method, params: { ...params, threadId: 'thread-fixture', turnId: 'turn-fixture' } } });
  assert.equal(backend.input.signal.aborted, true);
  backend.finish('completed'); await value.drain();
  const result = await value.controller.get(started.task_id);
  assert.equal(result.state, 'needs_attention'); assert.equal(result.implementer.human_attention_required, true);
  assert.equal(result.implementer.local.human_requests[0].diagnostic, 'UNSUPPORTED_HUMAN_REQUEST');
  assert(result.implementer.local.human_requests[0].summary.length <= 4096);
  assert(!JSON.stringify(result).includes('test-sensitive-value')); assert(!JSON.stringify(result).includes('token=private'));
});

test('cleanup cancels before joining execution, retains files by default and preserves audit/ownership', async context => {
  const value = await setup(context), started = await value.start(), backend = await value.running();
  const result = await value.controller.invoke('cleanup_task', { task_id: started.task_id }, { requestId: 'cleanup' }, input => value.controller.cleanup(input));
  assert.equal(backend.calls[1], 'cancel'); assert(backend.calls.includes('close')); assert.equal(result.state, 'cleaned');
  assert.equal(result.cleanup.workspace_deleted, false); assert.equal(result.cleanup.remote_session_deleted, null);
  assert.equal(result.cleanup.cancellation_confirmed, true); assert.equal(result.cleanup.descendant_termination_verified, false);
  assert((await fs.stat(path.join(value.controller.workspaceRoot, started.task_id, 'repo'))).isDirectory());
  assert(value.controller.db.prepare('SELECT value FROM audit').get()); assert.equal(value.api.deleted.length, 0);
  const deleted = await value.controller.cleanup({ task_id: started.task_id, delete_workspace: true });
  assert.equal(deleted.cleanup.workspace_deleted, true); assert.equal(deleted.cleanup.worktree_deleted, true);
  assert.equal(await fs.readFile(path.join(value.normal, 'greeting.txt'), 'utf8'), 'uncommitted owner work\n');
  assert(value.controller.task(started.task_id));
});

test('cleanup during provisioning prevents execution instead of waiting for a local turn', async context => {
  const value = await setup(context), started = await value.start();
  const result = await value.controller.cleanup({ task_id: started.task_id });
  assert.equal(result.state, 'cleaned'); assert.equal(value.instances.length, 0);
  assert.equal(result.implementer.local.turn_submission_attempted, false);
});

test('unconfirmed local server closure prevents workspace deletion and remains visible', async context => {
  const value = await setup(context, { closeFails: true }), started = await value.start(); await value.running();
  const result = await value.controller.cleanup({ task_id: started.task_id, delete_workspace: true });
  assert.notEqual(result.state, 'cleaned'); assert.equal(result.cleanup.server_closed, false); assert.equal(result.cleanup.workspace_deleted, false);
  assert.match(result.cleanup.cleanup_diagnostic, /LOCAL_CLOSE_UNCONFIRMED/);
});

test('shutdown interrupts owned local work without joining it first', async context => {
  const value = await setup(context), started = await value.start(), backend = await value.running();
  await value.controller.close();
  assert.equal(backend.calls[1], 'cancel'); assert(backend.calls.includes('close')); assert.equal(value.controller.dbClosed, true);
  const recovered = await new Controller(value.config).init();
  try { const result = await recovered.get(started.task_id); assert.equal(result.implementer.local.execution_state, 'interrupted'); assert.equal(value.instances.length, 1); }
  finally { await recovered.close(); }
});

test('restart retains acknowledged identity and completed results but never replays unfinished work', async context => {
  const value = await setup(context, { status: 'completed' }), completed = await value.start(); await value.drain();
  const retry = { ...value.input, request_id: 'crashed_request' };
  const second = await value.controller.start(retry); await value.drain();
  const unresolved = value.controller.task(second.task_id);
  unresolved.implementer.state = 'running'; Object.assign(unresolved.implementer.local, { result_received: false, server_closed: false, terminal_observed: false });
  await value.controller.close();
  const first = await new Controller(value.config).init();
  first.save(unresolved); first.opDone(unresolved.request_id, 'pending'); clearInterval(first.sweeper); first.closed = true; first.dbClosed = true; first.db.close();
  const recovered = await new Controller(value.config).init();
  try {
    assert.equal((await recovered.get(completed.task_id)).state, 'completed');
    const result = await recovered.get(unresolved.id);
    assert.equal(result.state, 'needs_attention'); assert.equal(result.implementer.local.thread_id, 'thread-fixture');
    assert.equal(result.implementer.local.turn_id, 'turn-fixture'); assert.equal(result.implementer.local.execution_state, 'uncertain');
    assert.match(result.implementer.local.diagnostics.join(), /NO_REPLAY/); assert.equal(value.instances.length, 2);
    assert.deepEqual(recovered.task(unresolved.id).local_execution_evidence, unresolved.local_execution_evidence);
    await assert.rejects(recovered.buildPacket(recovered.task(unresolved.id)), /LOCAL_EVIDENCE_EXECUTION_NOT_CLOSED/);
    assert.equal((await recovered.start(retry)).task_id, unresolved.id); assert.equal(value.instances.length, 2);
    const cleanup = await recovered.cleanup({ task_id: unresolved.id, delete_workspace: true });
    assert.match(cleanup.cleanup.cleanup_diagnostic, /LOCAL_OWNER_UNAVAILABLE/);
    assert.equal(value.api.created.length, 0);
  } finally { await recovered.close(); }
});

test('cleanup cancels only the selected task and expiration uses the same local lifecycle', async context => {
  const value = await setup(context), first = await value.start(), firstBackend = await value.running();
  const second = await value.controller.start({ ...value.input, request_id: 'second_task_request' });
  const secondBackend = await value.running(1);
  await value.controller.cleanup({ task_id: first.task_id });
  assert(firstBackend.calls.includes('cancel')); assert(!secondBackend.calls.includes('cancel'));
  const expiring = value.controller.task(second.task_id); expiring.deadline = Date.now() - 1; value.controller.save(expiring);
  await value.controller.expire();
  assert(secondBackend.calls.includes('cancel')); assert.equal((await value.controller.get(second.task_id)).state, 'cleaned');
});

test('shutdown bounds an unresponsive cancel request, closes execution, and preserves cancellation uncertainty', { timeout: 15000 }, async context => {
  const value = await setup(context), started = await value.start(), backend = await value.running();
  backend.cancel = () => { backend.calls.push('cancel'); return new Promise(() => {}); };
  await value.controller.close();
  assert(backend.calls.includes('close')); assert.equal(value.controller.dbClosed, true);
  const recovered = await new Controller(value.config).init();
  try {
    const result = await recovered.get(started.task_id);
    assert.equal(result.implementer.local.terminal_observed, false);
    assert(result.implementer.local.diagnostics.includes('LOCAL_CANCELLATION_UNCONFIRMED'));
    assert.equal(result.implementer.human_attention_required, true);
  } finally { await recovered.close(); }
});

test('local continue, review and publish reject explicitly without downstream API or publication work', async context => {
  const value = await setup(context), started = await value.start(); await value.running();
  await assert.rejects(value.controller.continue({ task_id: started.task_id, instruction: 'answer', request_id: 'next_request' }), /LOCAL_STRUCTURED_RESPONSE_REQUIRED/);
  await assert.rejects(value.controller.review({ task_id: started.task_id, request_id: 'review_request' }), /LOCAL_REVIEW_UNSUPPORTED/);
  await assert.rejects(value.controller.publish({ task_id: started.task_id, title: 'not allowed' }), /LOCAL_PUBLISH_UNSUPPORTED/);
  assert.equal(value.api.created.length, 0); assert.equal(value.controller.task(started.task_id).reviewer, undefined);
  assert.equal(value.controller.task(started.task_id).publication, undefined);
});

test('MCP exposes explicit local opt-in and persisted state without adding operations', async context => {
  const value = await setup(context, { status: 'completed' }), server = createServer(value.controller, async () => {});
  const client = new Client({ name: 'local-integration-test', version: '1' }), [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  context.after(async () => { await client.close(); await server.close(); });
  const list = await client.listTools(); assert.equal(list.tools.length, 6);
  assert.deepEqual(list.tools.find(tool => tool.name === 'start_task').inputSchema.properties.execution_backend.enum, ['agents_api', 'local_codex']);
  const invalid = await client.callTool({ name: 'start_task', arguments: { ...value.input, execution_backend: 'invalid' } }); assert.equal(invalid.isError, true);
  const started = await client.callTool({ name: 'start_task', arguments: value.input }); assert.equal(started.isError, undefined);
  await value.drain();
  const result = await client.callTool({ name: 'get_task', arguments: { task_id: started.structuredContent.task_id } });
  assert.equal(result.structuredContent.execution_backend, 'local_codex'); assert.equal(result.structuredContent.implementer.local.model, 'gpt-6-astra');
  assert.equal(value.api.created.length, 0);
});

async function waiting(context, method = 'item/commandExecution/requestApproval', mode = {}) {
  const value = await setup(context, mode, { noApi: true });
  const started = await value.start(), backend = await value.running();
  const params = { threadId: 'thread-fixture', turnId: 'turn-fixture', command: 'node --version', itemId: 'item-fixture',
    questions: [{ id: 'scope', header: 'Scope', question: 'Which file?', isOther: false, options: [{ label: 'fixture.txt', description: 'Only the fixture' }] }] };
  backend.emit('human_request', { request: { id: 0, method, params } });
  const request = (await value.controller.get(started.task_id)).implementer.pending_human_requests[0];
  const response = (answer = { decision: 'accept' }, operation = 'human_response_1', changes = {}) => ({ task_id: started.task_id, request_id: operation,
    human_response: { request_ref: request.request_ref, thread_id: request.thread_id, turn_id: request.turn_id, ...answer, ...changes } });
  return { ...value, started, backend, request, response };
}

for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput']) test(`durably pending ${method} exposes exact sanitized correlation, not native IDs`, async context => {
  const value = await waiting(context, method), { controller, started, request, backend } = value;
  const stored = JSON.parse(controller.db.prepare('SELECT value FROM tasks WHERE id=?').get(started.task_id).value).implementer.local.human_requests[0];
  assert.equal(stored.native_request_id, 0); assert.equal(stored.task_id, started.task_id);
  assert.equal(stored.start_operation_id, value.input.request_id); assert.equal(stored.status, 'pending');
  const view = await controller.get(started.task_id);
  assert.equal(view.state, method.endsWith('requestUserInput') ? 'waiting_for_clarification' : 'waiting_for_approval');
  assert.equal(view.implementer.human_attention_required, true); assert.equal(view.implementer.local.terminal_observed, false);
  assert.equal(request.request_ref, stored.request_ref); assert.equal(request.thread_id, 'thread-fixture'); assert.equal(request.turn_id, 'turn-fixture');
  assert(!JSON.stringify(view).includes('native_request_id')); assert.equal(backend.responses, undefined);
  assert.equal(backend.options.deferHumanRequests, true); assert.equal(backend.input.signal.aborted, false);
  assert.equal(controller._api, undefined);
});

for (const decision of ['accept', 'decline', 'cancel']) test(`explicit ${decision} persists before callback release without creating another execution`, async context => {
  const mode = {}, value = await waiting(context, 'item/commandExecution/requestApproval', mode);
  mode.onDeliver = input => {
    const stored = value.controller.task(value.started.task_id).implementer.local.human_requests[0];
    assert.equal(stored.status, 'responding'); assert.equal(stored.delivery, 'prepared'); assert.deepEqual(stored.response, { decision });
    assert.equal(stored.operation_id, 'human_response_1');
    assert.equal(value.controller.db.prepare('SELECT status FROM operations WHERE id=?').get(stored.operation_id).status, 'submitting');
    assert.equal(input.requestId, 0); assert.equal(input.threadId, 'thread-fixture'); assert.equal(input.turnId, 'turn-fixture');
  };
  await value.controller.continue(value.response({ decision }));
  assert.equal(value.backend.responses.length, 1); assert.equal(value.instances.length, 1);
  assert.equal(value.backend.calls.filter(call => call === 'run').length, 1);
  value.backend.emit('human_request_resolved', { request: { id: 0 } });
  value.backend.finish(decision === 'cancel' ? 'interrupted' : 'completed'); await value.drain();
  const view = await value.controller.get(value.started.task_id);
  assert.equal(view.state, decision === 'cancel' ? 'interrupted' : 'completed');
  assert.equal(view.implementer.local.human_requests[0].status, 'resolved');
  assert.equal(view.implementer.local.human_requests[0].delivery, 'server_cleared');
  assert(!Object.hasOwn(view.implementer.local.human_requests[0], 'response'));
  assert.equal(value.controller._api, undefined);
});

test('clarifications preserve exact question IDs/options and reject malformed or additional answers', async context => {
  const value = await waiting(context, 'item/tool/requestUserInput');
  assert.equal(value.request.questions[0].id, 'scope'); assert.equal(value.request.questions[0].options[0].label, 'fixture.txt');
  for (const answer of [{ decision: 'accept' }, { answers: {} }, { answers: { wrong: { answers: ['fixture.txt'] } } },
    { answers: { scope: { answers: ['not an option'] } } }, { answers: { scope: { answers: [] } } },
    { answers: { scope: { answers: ['fixture.txt'], extra: true } } }, { answers: { scope: { answers: ['fixture.txt'] }, extra: { answers: ['x'] } } }]) {
    await assert.rejects(value.controller.continue(value.response(answer)), /LOCAL_HUMAN_RESPONSE_INVALID/);
  }
  const answers = { scope: { answers: ['fixture.txt'] } };
  await value.controller.continue(value.response({ answers }));
  assert.deepEqual(value.backend.responses[0].response, { answers });
  value.backend.finish(); await value.drain();
  assert.equal((await value.controller.get(value.started.task_id)).state, 'completed');
});

test('duplicate operation retries deliver once; conflicting and new-operation duplicate replies fail closed', async context => {
  const value = await waiting(context), input = value.response();
  await Promise.all([value.controller.continue(input), value.controller.continue(input)]);
  assert.equal(value.backend.responses.length, 1);
  await assert.rejects(value.controller.continue(value.response({ decision: 'decline' })), /REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT/);
  await assert.rejects(value.controller.continue(value.response({ decision: 'accept' }, 'different_operation')), /LOCAL_PENDING_REQUEST_NOT_FOUND/);
  value.backend.finish(); await value.drain();
  await value.controller.continue(input); assert.equal(value.backend.responses.length, 1);
});

test('free prose, invalid decisions and wrong task/thread/turn/request identity never release approval', async context => {
  const value = await waiting(context);
  for (const decision of ['yes', 'sounds good', 'proceed', 'acceptForSession', true, null]) {
    await assert.rejects(value.controller.continue(value.response({ decision })), /LOCAL_HUMAN_RESPONSE_INVALID/);
  }
  await assert.rejects(value.controller.continue({ ...value.response(), instruction: 'yes' }), /LOCAL_STRUCTURED_RESPONSE_REQUIRED/);
  for (const changes of [{ request_ref: 'wrong' }, { thread_id: 'wrong' }, { turn_id: 'wrong' }, { native_request_id: 0 }]) {
    await assert.rejects(value.controller.continue(value.response({ decision: 'accept' }, 'identity_check', changes)), /LOCAL_(PENDING_REQUEST_NOT_FOUND|CALLBACK_IDENTITY_MISMATCH|STRUCTURED_RESPONSE_REQUIRED)/);
  }
  const other = await value.controller.start({ ...value.input, request_id: 'second_task_request' }); await value.running(1);
  await assert.rejects(value.controller.continue({ ...value.response(), task_id: other.task_id }), /LOCAL_PENDING_REQUEST_NOT_FOUND/);
  assert.equal(value.backend.responses, undefined);
});

test('transaction failure rolls back operation and authorization before any callback delivery', async context => {
  const value = await waiting(context), save = value.controller.save.bind(value.controller);
  value.controller.save = task => {
    if (task.implementer.local.human_requests[0]?.response) throw Error('Storage unavailable');
    save(task);
  };
  await assert.rejects(value.controller.continue(value.response()), /LOCAL_RESPONSE_PERSISTENCE_FAILED/);
  value.controller.save = save;
  assert.equal(value.backend.responses, undefined);
  assert.equal(value.controller.task(value.started.task_id).implementer.local.human_requests[0].status, 'pending');
  assert.equal(value.controller.db.prepare('SELECT * FROM operations WHERE id=?').get('human_response_1'), undefined);
});

test('failed initial request persistence cannot expose or release an unrecorded callback', async context => {
  const value = await setup(context), started = await value.start(), backend = await value.running(), save = value.controller.save.bind(value.controller);
  value.controller.save = task => { if (task.implementer.local.human_requests.length) throw Error('storage unavailable'); save(task); };
  assert.throws(() => backend.emit('human_request', { request: { id: 0, method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thread-fixture', turnId: 'turn-fixture', command: 'node --version' } } }), /storage unavailable/);
  value.controller.save = save;
  assert.deepEqual((await value.controller.get(started.task_id)).implementer.pending_human_requests, []);
  assert.equal(backend.responses, undefined);
});

test('native decision limits and private question bounds fail closed', async context => {
  const value = await waiting(context);
  value.backend.emit('human_request', { request: { id: 1, method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thread-fixture', turnId: 'turn-fixture', command: 'node --version', availableDecisions: ['decline', 'cancel'] } } });
  const request = (await value.controller.get(value.started.task_id)).implementer.pending_human_requests[1];
  assert.deepEqual(request.decisions, ['decline', 'cancel']);
  await assert.rejects(value.controller.continue(value.response({ decision: 'accept' }, 'restricted_decision', { request_ref: request.request_ref })), /LOCAL_HUMAN_RESPONSE_INVALID/);
  for (const question of [{ id: 'scope', question: 'Password?', isSecret: true }, { id: 'token=private', question: 'Which file?' },
    { id: 'scope', question: 'test-sensitive-value' }, { id: 'scope', question: 'x'.repeat(2001) },
    { id: 'scope', question: 'Which file?', options: [{ label: 'token=private' }] }]) {
    assert.throws(() => value.backend.emit('human_request', { request: { id: 2, method: 'item/tool/requestUserInput',
      params: { threadId: 'thread-fixture', turnId: 'turn-fixture', questions: [question] } } }), /LOCAL_QUESTION/);
  }
  assert.equal(value.backend.responses, undefined);
});

test('uncertain delivery is durable and never automatically resent, including identical retries', async context => {
  const value = await waiting(context, 'item/commandExecution/requestApproval', { deliveryFails: true });
  await assert.rejects(value.controller.continue(value.response()), /LOCAL_RESPONSE_DELIVERY_UNCERTAIN/);
  const record = value.controller.task(value.started.task_id).implementer.local.human_requests[0];
  assert.equal(record.status, 'uncertain'); assert.equal(record.delivery, 'attempted');
  assert.equal(value.controller.db.prepare('SELECT status FROM operations WHERE id=?').get('human_response_1').status, 'uncertain');
  await value.controller.continue(value.response()); assert.equal(value.backend.responses.length, 1);
  value.backend.finish('interrupted'); await value.drain();
  assert.equal((await value.controller.get(value.started.task_id)).state, 'needs_attention');
});

for (const event of ['server_resolved', 'completed', 'interrupted']) test(`${event} invalidates pending callbacks without fabricated human replies`, async context => {
  const value = await waiting(context);
  if (event === 'server_resolved') value.backend.emit('human_request_resolved', { request: { id: 0 } });
  else { value.backend.finish(event); await value.drain(); }
  await assert.rejects(value.controller.continue(value.response()), /LOCAL_(PENDING_REQUEST_NOT_FOUND|CALLBACK_NOT_ACTIVE)/);
  assert.equal((await value.controller.get(value.started.task_id)).state, 'needs_attention');
  assert.equal(value.backend.responses, undefined);
});

for (const action of ['cleanup', 'close', 'expire']) test(`${action} cancels a pending human request without waiting for an answer`, async context => {
  const value = await waiting(context);
  if (action === 'cleanup') await value.controller.cleanup({ task_id: value.started.task_id });
  if (action === 'close') await value.controller.close();
  if (action === 'expire') {
    const task = value.controller.task(value.started.task_id); task.deadline = 0; value.controller.save(task);
    await assert.rejects(value.controller.continue(value.response()), /LOCAL_CALLBACK_NOT_ACTIVE/);
    await value.controller.expire();
  }
  assert(value.backend.calls.includes('cancel')); assert(value.backend.calls.includes('close')); assert.equal(value.backend.responses, undefined);
  if (action !== 'close') {
    assert.equal(value.controller.task(value.started.task_id).implementer.local.human_requests[0].status, 'interrupted');
    await assert.rejects(value.controller.continue(value.response()), /LOCAL_CALLBACK_NOT_ACTIVE/);
  }
});

for (const delivery of ['pending', 'prepared', 'sent_unconfirmed']) test(`restart preserves ${delivery} callback identity without replay or reattachment`, async context => {
  const value = await waiting(context), snapshot = value.controller.task(value.started.task_id), request = snapshot.implementer.local.human_requests[0];
  if (delivery !== 'pending') { request.status = 'responding'; request.delivery = delivery; request.response = { decision: 'accept' }; }
  await value.controller.close();
  const database = new DatabaseSync(path.join(value.controller.stateRoot, 'controller.sqlite'));
  database.prepare('UPDATE tasks SET value=? WHERE id=?').run(JSON.stringify(snapshot), snapshot.id); database.close();
  const recovered = await new Controller(value.config).init();
  try {
    const view = await recovered.get(snapshot.id), saved = recovered.task(snapshot.id).implementer.local.human_requests[0];
    assert.equal(view.state, 'needs_attention'); assert.equal(saved.native_request_id, 0); assert.equal(saved.request_ref, request.request_ref);
    assert.equal(saved.status, delivery === 'pending' ? 'interrupted' : 'uncertain');
    assert.equal(saved.diagnostic, 'LOCAL_RESTART_CALLBACK_UNAVAILABLE');
    await assert.rejects(recovered.continue(value.response()), /LOCAL_PENDING_REQUEST_NOT_FOUND/);
    assert.equal(value.instances.length, 1); assert.equal(value.backend.responses, undefined);
  } finally { await recovered.close(); }
});

test('redacted/truncated approval descriptions cannot authorize hidden operations', async context => {
  const value = await waiting(context);
  value.backend.emit('human_request', { request: { id: 'private-token=private', method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thread-fixture', turnId: 'turn-fixture', command: 'test-sensitive-value token=private https://private.invalid ' + 'x'.repeat(5000) } } });
  const view = await value.controller.get(value.started.task_id), request = view.implementer.pending_human_requests[1];
  assert.equal(request.description_incomplete, true); assert(!JSON.stringify(view).includes('token=private'));
  assert(!JSON.stringify(view).includes('private-token'));
  await assert.rejects(value.controller.continue(value.response({ decision: 'accept' }, 'second_response', { request_ref: request.request_ref })), /LOCAL_APPROVAL_DESCRIPTION_INCOMPLETE/);
  await value.controller.continue(value.response({ decision: 'decline' }, 'second_response', { request_ref: request.request_ref }));
  assert.equal(value.backend.responses[0].requestId, 'private-token=private');
});

test('MCP routes structured human replies and preserves unsupported review/publication gates', async context => {
  const value = await waiting(context), server = createServer(value.controller, async () => {});
  const client = new Client({ name: 'human-response-test', version: '1' }), [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  context.after(async () => { await client.close(); await server.close(); });
  const get = await client.callTool({ name: 'get_task', arguments: { task_id: value.started.task_id } });
  assert.equal(get.structuredContent.state, 'waiting_for_approval');
  assert(!JSON.stringify(get).includes('native_request_id'));
  for (const answer of [{ decision: 'proceed' }, { decision: 'accept', answers: {} }, { native_request_id: 0, decision: 'accept' }]) {
    const invalid = await client.callTool({ name: 'continue_task', arguments: value.response(answer) }); assert.equal(invalid.isError, true);
  }
  const continued = await client.callTool({ name: 'continue_task', arguments: value.response() });
  assert.equal(continued.isError, undefined); assert.equal(value.backend.responses.length, 1);
  const retry = await client.callTool({ name: 'continue_task', arguments: value.response() }); assert.equal(retry.isError, undefined);
  assert.equal(value.backend.responses.length, 1);
  await assert.rejects(value.controller.review({ task_id: value.started.task_id, request_id: 'still_no_review' }), /LOCAL_REVIEW_UNSUPPORTED/);
  await assert.rejects(value.controller.publish({ task_id: value.started.task_id, title: 'No publication' }), /LOCAL_PUBLISH_UNSUPPORTED/);
});

for (const kind of ['command', 'file', 'question', 'transport_loss']) test(`real Controller and adapter route ${kind} via mocked native RPC without another turn`, async context => {
  const calls = [], replies = [];
  let controller, taskId, child;
  const native = 'private-native-request';
  const method = kind === 'file' ? 'item/fileChange/requestApproval' : kind === 'question' ? 'item/tool/requestUserInput' : 'item/commandExecution/requestApproval';
  const value = await setup(context, {}, { noApi: true, localBackendFactory: options => new LocalCodexBackend({ ...options,
    spawnProcess: (binary, args, config) => {
      child = new EventEmitter(); child.stdout = new PassThrough();
      const send = message => child.stdout.write(JSON.stringify(message) + '\n');
      child.kill = () => { if (!child.dead) { child.dead = true; queueMicrotask(() => child.emit('close', 0)); } };
      child.stdin = new Writable({ write(chunk, encoding, callback) {
        const message = JSON.parse(String(chunk));
        if (!message.method) {
          const saved = controller.task(taskId).implementer.local.human_requests[0];
          assert.equal(saved.status, 'responding'); assert.equal(saved.delivery, 'attempted');
          assert.deepEqual(saved.response, message.result); assert.equal(saved.native_request_id, message.id);
          replies.push(message);
          if (kind === 'transport_loss') child.kill();
          else {
            send({ method: 'serverRequest/resolved', params: { threadId: 'native-thread', requestId: native } });
            send({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { id: 'native-turn', status: 'completed' } } });
          }
          callback(); return;
        }
        if (message.id !== undefined) {
          calls.push(message.method);
          queueMicrotask(() => {
            let result;
            if (message.method === 'initialize') result = { codexHome: config.env.CODEX_HOME };
            else if (message.method === 'config/read') result = { config: { model_provider: 'openai', chatgpt_base_url: 'https://chatgpt.com/backend-api/',
              sandbox_mode: 'workspace-write', sandbox_workspace_write: { network_access: false }, approval_policy: 'on-request', approvals_reviewer: 'user', web_search: 'disabled',
              shell_environment_policy: { inherit: 'none', set: { PATH: '/usr/local/bin:/usr/bin:/bin' } },
              features: { apps: false, plugins: false, hooks: false, multi_agent: false, remote_control: false, api_key_model_discovery: false } } };
            else if (message.method === 'account/read') result = { account: { type: 'chatgpt', email: 'fixture@example.invalid', planType: 'pro' }, requiresOpenaiAuth: true };
            else if (message.method === 'model/list') result = { data: [{ id: 'model', model: 'gpt-6-astra', isDefault: true, hidden: false }], nextCursor: null };
            else if (message.method === 'thread/start') result = { thread: { id: 'native-thread', turns: [] }, model: 'gpt-6-astra', cwd: options.cwd, modelProvider: 'openai', approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'workspaceWrite', networkAccess: false } };
            else if (message.method === 'turn/start') {
              result = { turn: { id: 'native-turn', status: 'inProgress' } };
              setImmediate(() => send({ id: native, method, params: { threadId: 'native-thread', turnId: 'native-turn', command: 'node --version', reason: 'Write fixture.txt',
                questions: [{ id: 'scope', question: 'Which file?', options: [{ label: 'fixture.txt' }], isOther: false }] } }));
            } else assert.fail(`Unexpected RPC ${message.method}`);
            send({ id: message.id, result });
          });
        }
        callback();
      } });
      return child;
    } }) });
  controller = value.controller;
  taskId = (await value.start()).task_id;
  let request;
  for (let attempt = 0; attempt < 200; attempt++) {
    request = (await controller.get(taskId)).implementer.pending_human_requests[0];
    if (request) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert(request); assert.equal(replies.length, 0);
  const input = { task_id: taskId, request_id: 'real_adapter_response', human_response: { request_ref: request.request_ref,
    thread_id: request.thread_id, turn_id: request.turn_id, ...(kind === 'question' ? { answers: { scope: { answers: ['fixture.txt'] } } } : { decision: 'accept' }) } };
  await controller.continue(input); await value.drain();
  const view = await controller.get(taskId);
  assert.equal(view.implementer.local.thread_id, 'native-thread'); assert.equal(view.implementer.local.turn_id, 'native-turn');
  assert.equal(view.state, kind === 'transport_loss' ? 'needs_attention' : 'completed');
  assert.equal(view.implementer.local.human_requests[0].status, kind === 'transport_loss' ? 'uncertain' : 'resolved');
  assert.equal(view.implementer.local.terminal_observed, kind !== 'transport_loss');
  assert.equal(replies.length, 1); assert.equal(replies[0].id, native);
  await controller.continue(input); assert.equal(replies.length, 1);
  assert.equal(calls.filter(method => method === 'thread/start').length, 1); assert.equal(calls.filter(method => method === 'turn/start').length, 1);
  assert.equal(controller._api, undefined); assert.equal(value.executor.started.length, 0);
  assert.equal(view.implementer.local.server_closed, true);
});
