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
    ...(options.noApi ? {} : { api }), localBackendFactory: backendOptions => { const instance = new FakeLocal(backendOptions, mode); instances.push(instance); return instance; } };
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

for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput', 'item/permissions/requestApproval']) test(`human request ${method} cannot approve itself or become task success`, async context => {
  const value = await setup(context), started = await value.start(), backend = await value.running();
  const params = { command: 'test-sensitive-value token=private https://private.invalid ' + 'x'.repeat(5000), questions: [{ id: 'question', question: 'Which name?' }] };
  backend.emit('human_request', { request: { method, params } });
  assert.equal(backend.input.signal.aborted, true);
  assert.equal(backend.options.onApproval({ method, ...params }), 'decline');
  assert.throws(() => backend.options.onQuestion(params), /LOCAL_CLARIFICATION_UNSUPPORTED/);
  backend.finish('completed'); await value.drain();
  const result = await value.controller.get(started.task_id);
  assert.equal(result.state, 'needs_attention'); assert.equal(result.implementer.human_attention_required, true);
  assert.equal(result.implementer.local.human_requests[0].resolution, 'unsupported_no_human_answer');
  assert(result.implementer.local.human_requests[0].summary.length <= 1024);
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
  await assert.rejects(value.controller.continue({ task_id: started.task_id, instruction: 'answer', request_id: 'next_request' }), /LOCAL_CONTINUE_UNSUPPORTED/);
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
