import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Controller, contractMarkdown, digest } from '../controller.mjs';
import { localContractBinding, LOCAL_ACTIONABILITY_REVIEW_VERSION } from '../local-reviewer-instructions.mjs';
import { repositoryIdentity, repoGit } from '../repositories.mjs';
import { createServer } from '../server.mjs';
import { FakeAPI, FakeExecutor, contract } from './helpers.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import { LocalCodexBackend } from '../local-codex-backend.mjs';
import { compareSnapshots } from '../review-evidence.mjs';
import { GitHubPublisher, publicationState } from '../publication.mjs';
import { LocalValidation } from '../local-validation.mjs';

class FakeLocal {
  constructor(options, mode = {}) { this.options = options; this.mode = mode; this.calls = []; }
  emit(phase, extra = {}) { this.options.onLifecycle({ ...this.identity, phase, ...extra }); }
  async run(input) {
    this.calls.push('run'); this.input = input;
    this.identity = { model: 'gpt-6-astra', threadId: null, turnId: null, turnSubmissionAttempted: false, turnSubmissionAcknowledged: false, terminalObserved: false };
    const pending = new Promise(resolve => { this.resolve = resolve; });
    this.emit('model_selected');
    this.identity.threadId = this.options.reviewOnly ? this.mode.reviewThread || 'review-thread-fixture' : 'thread-fixture'; this.emit('thread_acknowledged');
    this.identity.turnSubmissionAttempted = true; this.emit('turn_submitting');
    if (!this.mode.unacknowledged) { this.identity.turnId = this.options.reviewOnly ? this.mode.reviewTurn || 'turn-fixture' : 'turn-fixture'; this.identity.turnSubmissionAcknowledged = true; this.emit('turn_acknowledged'); }
    this.options.onProgress({ method: 'item/agentMessage/delta', params: { delta: 'Model says test-sensitive-value token=private https://private.invalid' } });
    if (this.mode.status) this.finish(this.mode.status, this.mode.terminal !== false);
    return pending;
  }
  finish(status = 'completed', terminal = true, output) {
    this.identity.terminalObserved = terminal;
    if (terminal) this.emit('terminal_observed', { status });
    this.resolve({ ...this.identity, status, authentication: 'chatgpt', commands: [{ command: 'untrusted test', exitCode: 0 }], messages: output ? [{ provenance: 'model', text: output }] : [], uncertainties: this.options.reviewOnly ? this.mode.reviewDiagnostics || [] : this.mode.implementationDiagnostics || ['Evidence is incomplete: test-sensitive-value token=private https://private.invalid'] });
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
    ...(options.localValidationFactory ? { localValidationFactory: options.localValidationFactory } : {}),
    ...(options.noApi ? {} : { api }), localBackendFactory: options.localBackendFactory || (backendOptions => { const instance = new FakeLocal(backendOptions, mode); instances.push(instance); return instance; }) };
  const controller = await new Controller(config).init();
  await fs.writeFile(path.join(controller.stateRoot, 'repositories.json'), JSON.stringify({ version: 1, repositories: { fixture: await repositoryIdentity(normal) } }), { mode: 0o600 });
  context.after(async () => { await controller.close(); await fs.rm(root, { recursive: true, force: true }); });
  const input = { contract: contract(), request_id: 'local_start_request', repository_id: 'fixture', execution_backend: 'local_codex' };
  const start = () => controller.start(input);
  const running = async (index = 0) => {
    for (let attempt = 0; attempt < 1000; attempt++) {
      if (instances[index]?.resolve) return instances[index];
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('Local execution did not start');
  };
  const drain = () => Promise.all([...controller.jobs.values()]);
  return { controller, config, api, executor, root, normal, baseline, input, instances, start, running, drain };
}

const automaticAuthority = () => ({ publish: { title: 'Explicit fixture draft', draft: true }, max_duration_seconds: 120, max_codex_turns: 2, max_corrections: 0 });

for (const mode of [false, true, 'completed history', 'missing history', 'non-array history', 'null history', 'ignored submission', 'ignored acceptance',
  'four-turn PASS', 'four-turn FAIL', 'four-turn implementation thread', 'four-turn original reviewer thread', 'four-turn corrective thread',
  'four-turn reused turn', 'four-turn completed history', 'four-turn missing output', 'four-turn malformed', 'four-turn unknown acknowledgment',
  'four-turn publish PASS', 'four-turn publish FAIL'])
test(`corrective native adapter starts a fresh subscription thread and never resumes; reused=${mode}`, async context => {
  const reused = mode === true, qualified = mode === false, four = typeof mode === 'string' && mode.startsWith('four-turn');
  const publishMode = typeof mode === 'string' && mode.startsWith('four-turn publish');
  const calls = []; let index = 0, fixtureFailure, original, ignored = 0;
  const value = await setup(context, {}, { noApi: true, localBackendFactory: options => {
    const execution = index++, prior = { 'four-turn implementation thread': 'native-0', 'four-turn original reviewer thread': 'native-1', 'four-turn corrective thread': 'native-2' }[mode];
    const thread = reused && execution === 2 ? 'native-0' : execution === 3 && prior ? prior : `native-${execution}`;
    const turn = execution === 3 && mode === 'four-turn reused turn' ? 'turn-0' : `turn-${execution}`;
    return new LocalCodexBackend({ ...options, spawnProcess(binary, args, config) {
      const child = new EventEmitter(); child.stdout = new PassThrough();
      const send = message => child.stdout.write(JSON.stringify(message) + '\n');
      child.kill = () => { if (!child.dead) { child.dead = true; queueMicrotask(() => child.emit('close', 0)); } };
      child.stdin = new Writable({ write(chunk, encoding, callback) {
        const message = JSON.parse(String(chunk));
        if (message.id !== undefined && message.method) {
          calls.push({ execution, method: message.method, params: message.params });
          queueMicrotask(() => { void (async () => {
            let result;
            if (message.method === 'initialize') result = { codexHome: config.env.CODEX_HOME };
            else if (message.method === 'config/read') result = { config: { model_provider: 'openai', chatgpt_base_url: 'https://chatgpt.com/backend-api/',
              sandbox_mode: options.reviewOnly ? 'read-only' : 'workspace-write', sandbox_workspace_write: { network_access: false },
              approval_policy: 'on-request', approvals_reviewer: 'user', web_search: 'disabled',
              shell_environment_policy: { inherit: 'none', set: { PATH: '/usr/local/bin:/usr/bin:/bin' } },
              features: { apps: false, plugins: false, hooks: false, multi_agent: false, remote_control: false, api_key_model_discovery: false } } };
            else if (message.method === 'account/read') result = { account: { type: 'chatgpt', email: 'fixture@example.invalid', planType: 'pro' }, requiresOpenaiAuth: true };
            else if (message.method === 'model/list') result = { data: [{ id: 'model', model: 'gpt-6-astra', isDefault: true, hidden: false }], nextCursor: null };
            else if (message.method === 'thread/start') result = { thread: { id: thread, turns: [] }, model: 'gpt-6-astra', cwd: options.cwd,
              modelProvider: 'openai', approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: options.reviewOnly ? 'readOnly' : 'workspaceWrite', networkAccess: false } };
            else if (message.method === 'turn/start') {
              if (execution === 3 && mode === 'four-turn unknown acknowledgment') { send({ id: message.id, error: { code: -32000, message: 'Unknown acknowledgment' } }); return; }
              if (!options.reviewOnly) await fs.writeFile(path.join(options.cwd, 'greeting.txt'), execution === 0 ? 'candidate\n' : 'corrected\n');
              result = { turn: { id: turn, status: 'inProgress' } };
              setImmediate(() => {
                if (child.dead) return;
                const output = { format: LOCAL_ACTIONABILITY_REVIEW_VERSION, overall: 'FAIL', findings: ['R1', 'R2', 'I1', 'SCOPE', 'TEST_EVIDENCE'].map(id => ({
                  id, status: id === 'R1' ? 'FAIL' : 'PASS', evidence: 'greeting.txt has the wrong greeting; the original required greeting must be restored.',
                  classification: id === 'R1' ? { kind: 'implementation_defect', target_files: ['greeting.txt'], remedy: { kind: 'edit_files', description: 'Use the originally required greeting.', requires_human_approval: false } } : null })) };
                if (execution === 3 && !['four-turn FAIL', 'four-turn publish FAIL'].includes(mode)) { output.overall = 'PASS'; for (const finding of output.findings) { finding.status = 'PASS'; finding.classification = null; } }
                if (options.reviewOnly && !(execution === 3 && mode === 'four-turn missing output')) send({ method: 'item/completed', params: { threadId: thread, turnId: turn,
                  item: { id: 'review-output', type: 'agentMessage', text: execution === 3 && mode === 'four-turn malformed' ? '{}' : JSON.stringify(output) } } });
                send({ method: 'turn/completed', params: { threadId: thread, turn: { id: turn, status: 'completed' } } });
              });
            } else throw Error(`Unexpected native method ${message.method}`);
            if (execution === 2 && message.method === 'thread/start') {
              assert.equal(options.requireFreshThread, true);
              const parent = value.controller.db.prepare('SELECT value FROM tasks').all().map(row => JSON.parse(row.value)).find(task => task.automatic);
              original = { reviewer: JSON.stringify(parent.reviewer), packet: await fs.readFile(path.join(value.controller.workspaceRoot, parent.id, parent.reviewer.packet_directory, 'evidence.json'), 'utf8'),
                rows: value.controller.db.prepare('SELECT * FROM automatic_attempts WHERE task_id=?').all(parent.id) };
              if (mode === 'completed history') result.thread.turns = [{ id: 'unseen-prior-turn', status: 'completed' }];
              if (mode === 'missing history') delete result.thread.turns;
              if (mode === 'non-array history') result.thread.turns = {};
              if (mode === 'null history') result.thread.turns = null;
            }
            if (execution === 3 && message.method === 'thread/start' && mode === 'four-turn completed history') result.thread.turns = [{ id: 'prior-fourth-turn', status: 'completed' }];
            send({ id: message.id, result });
          })().catch(error => { fixtureFailure = error; send({ id: message.id, error: { code: -32000, message: 'Fixture failure' } }); }); });
        }
        callback();
      } });
      return child;
    } });
  } });
  value.input.automatic = { ...automaticAuthority(), max_codex_turns: four ? 4 : 3, max_corrections: 1, review_protocol: LOCAL_ACTIONABILITY_REVIEW_VERSION };
  if (four) value.input.contract.test_commands = ['cat greeting.txt'];
  if (publishMode) value.input.automatic.publish_after_correction = true;
  if (typeof mode === 'string' && mode.startsWith('ignored')) {
    value.controller.db.function('count_native_ignored_write', () => { ignored++; return 1; });
    value.controller.db.exec(`CREATE TEMP TRIGGER native_ignored_write BEFORE INSERT ON tasks
      WHEN json_extract(NEW.value,'$.correction.parent_task_id') IS NOT NULL AND ${mode === 'ignored submission' ?
        "json_extract(NEW.value,'$.implementer.local.turn_submission_attempted')=1" : "json_extract(NEW.value,'$.correction_state')='awaiting_review'"}
      AND count_native_ignored_write() BEGIN SELECT RAISE(IGNORE); END;`);
  }
  let publishes = 0; value.controller.publisher = { target() { publishes++; throw Error('Publication forbidden'); } };
  let correctedPublisher, remote;
  if (publishMode) {
    remote = path.join(value.root, 'publication.git'); await fs.mkdir(remote); repoGit(remote, 'init', '--bare', '--initial-branch=main');
    repoGit(value.normal, 'remote', 'add', 'origin', remote); repoGit(value.normal, 'push', 'origin', 'HEAD:refs/heads/main');
    correctedPublisher = new class extends GitHubPublisher {
      constructor() { super(); this.pushes = 0; this.creates = 0; }
      api() { assert.fail('External GitHub calls forbidden'); }
      async target() { publishes++; return { repository: 'fixture/native-publication', base: 'main', remote }; }
      async push(...args) { this.pushes++; return super.push(...args); }
      async findPR() { return this.pr || null; }
      async createPR(target, branch, input) {
        this.creates++; assert.equal(input.draft, true); assert.equal(input.title, value.input.automatic.publish.title);
        return this.pr = { number: 1, html_url: 'https://github.com/fixture/native-publication/pull/1', state: 'open', draft: true, merged_at: null,
          head: { ref: branch, sha: repoGit(remote, 'rev-parse', `refs/heads/${branch}`).trim(), repo: { full_name: target.repository } },
          base: { ref: target.base, repo: { full_name: target.repository } } };
      }
    }(); value.controller.publisher = correctedPublisher;
  }
  let result, fourClient;
  if (four) {
    const server = createServer(value.controller, async () => {}), client = new Client({ name: 'four-turn-native', version: '1' });
    fourClient = client;
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
    context.after(async () => { await client.close(); await server.close(); });
    const response = await client.callTool({ name: 'start_task', arguments: value.input }); assert.notEqual(response.isError, true);
    result = response.structuredContent;
  } else result = await value.start();
  await value.drain(); await Promise.all([...value.controller.automaticJobs.values()]);
  assert.equal(fixtureFailure, undefined);
  const parent = value.controller.task(result.task_id);
  assert(parent.automatic.correction, JSON.stringify(parent.automatic));
  const child = value.controller.task(parent.automatic.correction.task_id);
  assert.equal(child.correction_state, qualified || four ? 'awaiting_review' : 'needs_attention', JSON.stringify(child.implementer));
  assert.equal(calls.filter(call => call.method === 'thread/start').length, four ? 4 : 3);
  const refusedFourth = four && (priorThreadMode(mode) || mode === 'four-turn completed history');
  assert.equal(calls.filter(call => call.method === 'turn/start').length, four ? refusedFourth ? 3 : 4 : qualified || mode === 'ignored acceptance' ? 3 : 2);
  assert.equal(calls.filter(call => call.method === 'thread/resume').length, 0);
  assert.equal(publishes, mode === 'four-turn publish PASS' ? 1 : 0); assert.equal(value.controller._api, undefined); assert.equal(value.executor.started.length, 0);
  const originalReview = JSON.parse(original.reviewer), currentReview = structuredClone(parent.reviewer);
  delete currentReview.stopping; delete originalReview.stopping;
  delete currentReview.local.human_attention_required; delete originalReview.local.human_attention_required;
  assert.deepEqual(currentReview, originalReview);
  assert.equal(await fs.readFile(path.join(value.controller.workspaceRoot, parent.id, parent.reviewer.packet_directory, 'evidence.json'), 'utf8'), original.packet);
  const retained = value.controller.db.prepare('SELECT * FROM automatic_attempts WHERE task_id=?').all(parent.id);
  for (const row of original.rows) assert(retained.some(current => current.value === row.value && current.observation_sha256 === row.observation_sha256));
  if (typeof mode === 'string' && mode.startsWith('ignored')) {
    assert(ignored > 0); value.controller.db.exec('DROP TRIGGER native_ignored_write');
    assert.notEqual(value.controller.db.prepare('SELECT status FROM operations WHERE id=?').get(child.request_id).status, 'accepted');
    const server = createServer(value.controller, async () => {}), client = new Client({ name: 'native-receipt-status', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
    context.after(async () => { await client.close(); await server.close(); });
    const tables = ['tasks', 'audit', 'operations', 'automatic_attempts', 'failures'];
    const snapshot = () => JSON.stringify(tables.map(table => value.controller.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
    const before = snapshot();
    for (let count = 0; count < 2; count++) {
      const result = await client.callTool({ name: 'get_task', arguments: { task_id: parent.id } });
      assert.notEqual(result.isError, true);
      assert.equal(result.structuredContent.correction.attempted_corrections, mode === 'ignored submission' ? null : 1);
      assert.equal(result.structuredContent.correction.retention_uncertain, true);
      assert.equal(result.structuredContent.correction.terminal_confirmed, false);
    }
    assert.equal(snapshot(), before);
  }
  if (qualified) {
    assert.equal(child.implementer.local.authentication, 'chatgpt'); assert.equal(child.implementer.local.thread_id, 'native-2');
    assert.equal(child.implementer.local.turn_id, 'turn-2'); assert.equal(child.deadline, parent.deadline);
    const submitted = calls.find(call => call.execution === 2 && call.method === 'turn/start').params;
    assert.equal(submitted.sandboxPolicy.networkAccess, false); assert.deepEqual(submitted.sandboxPolicy.writableRoots, [path.join(value.controller.workspaceRoot, child.id, 'repo')]);
    assert.equal(await fs.readFile(path.join(value.controller.workspaceRoot, parent.id, 'repo/greeting.txt'), 'utf8'), 'candidate\n');
  }
  if (four) {
    const accepted = ['four-turn PASS', 'four-turn FAIL', 'four-turn publish PASS', 'four-turn publish FAIL'].includes(mode), status = await value.controller.get(parent.id);
    assert.equal(await fs.readFile(path.join(value.normal, 'greeting.txt'), 'utf8'), 'uncommitted owner work\n');
    assert.equal(repoGit(value.normal, 'rev-parse', 'HEAD').trim(), value.baseline);
    const originalPacket = JSON.parse(original.packet), correctedPacket = JSON.parse(await fs.readFile(path.join(value.controller.workspaceRoot, child.id, child.reviewer.packet_directory, 'evidence.json'), 'utf8'));
    assert.equal(compareSnapshots(originalPacket.controller_evidence.normal_checkout.at_review, correctedPacket.controller_evidence.normal_checkout.at_review).status, 'unchanged');
    assert.equal(status.correction.review.qualified, accepted, JSON.stringify({ mode, child: child.automatic, reviewer: child.reviewer }));
    assert.equal(status.correction.review.overall, accepted ? mode.endsWith('PASS') ? 'PASS' : 'FAIL' : null);
    assert.equal(child.reviewer.review_protocol, LOCAL_ACTIONABILITY_REVIEW_VERSION);
    if (accepted) {
      assert.equal(new Set([parent.implementer, parent.reviewer, child.implementer, child.reviewer].map(role => role.local.thread_id)).size, 4);
      assert.equal(new Set([parent.implementer, parent.reviewer, child.implementer, child.reviewer].map(role => role.local.turn_id)).size, 4);
      assert.equal(child.local_validation.results[0].stdout.text, 'corrected\n');
      assert.notEqual(child.reviewer.reviewed_git_state.tree_sha, parent.reviewer.reviewed_git_state.tree_sha);
    }
    const request = calls.find(call => call.execution === 3 && call.method === 'turn/start');
    if (request) { assert.equal(request.params.sandboxPolicy.type, 'readOnly'); assert.equal(request.params.sandboxPolicy.networkAccess, false); assert.equal(request.params.sandboxPolicy.writableRoots, undefined); }
    assert.notEqual((await fourClient.callTool({ name: 'start_task', arguments: value.input })).isError, true);
    value.controller.scheduleAutomatic(parent.id); await Promise.all([...value.controller.automaticJobs.values()]);
    assert.equal(index, 4);
    if (publishMode) {
      assert.equal(correctedPublisher.pushes, mode.endsWith('PASS') ? 1 : 0); assert.equal(correctedPublisher.creates, mode.endsWith('PASS') ? 1 : 0);
      if (mode.endsWith('PASS')) {
        assert.equal(status.correction.publication.confirmed, true); assert.equal(parent.automatic.status, 'succeeded');
        assert.equal(repoGit(remote, 'rev-parse', `${child.publication.commit_sha}^{tree}`).trim(), child.reviewer.reviewed_git_state.tree_sha);
        assert.equal(repoGit(remote, 'rev-parse', `${child.publication.commit_sha}^`).trim(), value.baseline);
        assert.equal(repoGit(remote, 'show', `${child.publication.commit_sha}:greeting.txt`), 'corrected\n');
        const denied = await fourClient.callTool({ name: 'publish_task', arguments: { task_id: child.id, title: 'Public child publication' } });
        assert.equal(denied.isError, true); assert.match(denied.content[0].text, /CORRECTIVE_PUBLICATION_NOT_AUTHORIZED/);
      }
    }
  }
});

function priorThreadMode(mode) { return ['four-turn implementation thread', 'four-turn original reviewer thread', 'four-turn corrective thread'].includes(mode); }

test('MCP corrective publication opt-in is literal, versioned, local and restricted to the original request', async context => {
  const value = await setup(context, { status: 'completed' }), server = createServer(value.controller, async () => {});
  const client = new Client({ name: 'corrective-publication-authority', version: '1' }), [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b); context.after(async () => { await client.close(); await server.close(); });
  const automatic = { ...automaticAuthority(), max_codex_turns: 4, max_corrections: 1, review_protocol: LOCAL_ACTIONABILITY_REVIEW_VERSION, publish_after_correction: true };
  const start = (await client.listTools()).tools.find(tool => tool.name === 'start_task');
  assert(!start.inputSchema.properties.automatic.required.includes('publish_after_correction'));
  for (const change of [{ publish_after_correction: false }, { publish_after_correction: null }, { publish_after_correction: 'true' },
    { max_codex_turns: 2, max_corrections: 0 }, { max_codex_turns: 3 }, { review_protocol: undefined }]) {
    const result = await client.callTool({ name: 'start_task', arguments: { ...value.input, automatic: { ...automatic, ...change } } });
    assert.equal(result.isError, true);
  }
  for (const change of [{ execution_backend: 'agents_api' }, { execution_backend: undefined }, { repository_id: undefined }]) {
    const result = await client.callTool({ name: 'start_task', arguments: { ...value.input, ...change, automatic } }); assert.equal(result.isError, true);
  }
  assert.equal(value.instances.length, 0); assert.equal(value.api.created.length, 0);
  assert.equal(value.controller.db.prepare('SELECT count(*) AS n FROM tasks').get().n, 0);
  const response = await client.callTool({ name: 'start_task', arguments: { ...value.input, automatic } }); assert.notEqual(response.isError, true);
  const id = response.structuredContent.task_id;
  for (const name of ['continue_task', 'review_task', 'publish_task']) {
    const base = name === 'publish_task' ? { task_id: id, title: 'Not a new authority' } : { task_id: id, request_id: 'later_authority' };
    for (const fields of [{ publish_after_correction: true }, { automatic: { publish_after_correction: true } }]) {
      const denied = await client.callTool({ name, arguments: { ...base, ...fields } }); assert.equal(denied.isError, true);
    }
  }
  await value.drain(); await Promise.all([...value.controller.automaticJobs.values()]);
  const task = value.controller.task(id); assert.equal(task.automatic.authorization.publish_after_correction, true);
  const repeated = await client.callTool({ name: 'start_task', arguments: { ...value.input, automatic } }); assert.notEqual(repeated.isError, true);
  const changed = structuredClone(automatic); delete changed.publish_after_correction;
  const denied = await client.callTool({ name: 'start_task', arguments: { ...value.input, automatic: changed } }); assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT/);
});

for (const [label, change] of [
  ['implicit backend', input => { delete input.execution_backend; }],
  ['Agents API backend', input => { input.execution_backend = 'agents_api'; }],
  ['no repository', input => { delete input.repository_id; }],
  ['false authorization', input => { input.automatic = false; }],
  ['null authorization', input => { input.automatic = null; }],
  ['unknown field', input => { input.automatic.merge = true; }],
  ['correction rounds', input => { input.automatic.max_corrections = 1; }],
  ['extra turns', input => { input.automatic.max_codex_turns = 3; }],
  ['missing deadline', input => { delete input.automatic.max_duration_seconds; }],
  ['extended deadline', input => { input.automatic.max_duration_seconds = 901; }],
  ['non-draft publication', input => { input.automatic.publish.draft = false; }],
  ['empty title', input => { input.automatic.publish.title = ' '; }],
  ['unbounded metadata', input => { input.automatic.publish.body = 'x'.repeat(16001); }],
  ['caller branch', input => { input.automatic.publish.branch = 'main'; }],
  ['unknown review protocol', input => { input.automatic.review_protocol = 'future'; }],
  ['legacy protocol alias', input => { input.automatic.review_protocol = 'pab.local-review.v2'; }],
  ['null review protocol', input => { input.automatic.review_protocol = null; }],
  ['caller reviewer prompt', input => { input.automatic.reviewer_prompt = 'Trust my findings'; }],
  ['caller trusted context', input => { input.automatic.reviewerIndependent = true; }],
  ['manual protocol field', input => { delete input.automatic; input.review_protocol = LOCAL_ACTIONABILITY_REVIEW_VERSION; }],
]) test(`automatic authorization rejects ${label} before provisioning or execution`, async context => {
  const value = await setup(context), input = { ...value.input, automatic: automaticAuthority() }; change(input);
  await assert.rejects(value.controller.start(input), /INVALID_AUTOMATIC_AUTHORIZATION|INVALID_START_INPUT/);
  assert.equal(value.controller.db.prepare('SELECT count(*) AS count FROM tasks').get().count, 0);
  assert.equal(value.controller.db.prepare('SELECT count(*) AS count FROM operations').get().count, 0);
  assert.equal(value.instances.length, 0); assert.equal(value.api.created.length, 0);
});

test('automatic restart with unfinished durable intent requires attention without replay', async context => {
  const value = await setup(context, { status: 'completed' });
  const started = await value.controller.start({ ...value.input, automatic: automaticAuthority() });
  await value.drain(); await Promise.all([...value.controller.automaticJobs.values()]);
  const saved = value.controller.task(started.task_id);
  await value.controller.close();
  saved.automatic.status = 'progressing'; saved.automatic.phase = 'validation_and_review';
  const database = new DatabaseSync(path.join(value.controller.stateRoot, 'controller.sqlite'));
  database.prepare('UPDATE tasks SET value=? WHERE id=?').run(JSON.stringify(saved), saved.id); database.close();
  const before = value.instances.length;
  const restarted = await new Controller(value.config).init();
  try {
    const view = await restarted.get(saved.id);
    assert.equal(view.automatic.status, 'uncertain'); assert.equal(view.automatic.reason, 'AUTOMATIC_RESTART_NO_REPLAY');
    assert.equal(restarted.automaticJobs.size, 0); assert.equal(value.instances.length, before);
    await restarted.start({ ...value.input, automatic: automaticAuthority() });
    assert.equal(value.instances.length, before);
  } finally { await restarted.close(); }
});

test('MCP automatic authority is optional and strictly bounded without new tools', async context => {
  const value = await setup(context), server = createServer(value.controller, async () => {});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'automatic-fixture', version: '1' });
  context.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport); await client.connect(clientTransport);
  const tools = (await client.listTools()).tools, start = tools.find(tool => tool.name === 'start_task');
  assert.equal(tools.length, 8); assert(!start.inputSchema.required.includes('automatic'));
  assert.equal(start.inputSchema.properties.automatic.additionalProperties, false);
  assert(!start.inputSchema.properties.automatic.required.includes('review_protocol'));
  assert(JSON.stringify(start.inputSchema.properties.automatic.properties.review_protocol).includes(LOCAL_ACTIONABILITY_REVIEW_VERSION));
  const result = await client.callTool({ name: 'start_task', arguments: { ...value.input, automatic: { ...automaticAuthority(), merge: true } } });
  assert.equal(result.isError, true); assert.equal(value.instances.length, 0);
});

test('MCP admits only the explicit versioned automatic protocol and binds its original fingerprint', async context => {
  const value = await setup(context, { status: 'completed' }), server = createServer(value.controller, async () => {});
  const client = new Client({ name: 'versioned-fixture', version: '1' }), [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  context.after(async () => { await client.close(); await server.close(); });
  for (const extra of [{ review_protocol: 'v1' }, { review_protocol: null }, { review_protocol: LOCAL_ACTIONABILITY_REVIEW_VERSION, authorityValid: true }]) {
    const result = await client.callTool({ name: 'start_task', arguments: { ...value.input, automatic: { ...automaticAuthority(), ...extra } } });
    assert.equal(result.isError, true);
  }
  assert.equal(value.instances.length, 0);
  const input = { ...value.input, automatic: { ...automaticAuthority(), review_protocol: LOCAL_ACTIONABILITY_REVIEW_VERSION } };
  const result = await client.callTool({ name: 'start_task', arguments: input }); assert.equal(result.isError, undefined);
  await value.drain(); await Promise.all([...value.controller.automaticJobs.values()]);
  const task = value.controller.task(result.structuredContent.task_id), operation = value.controller.db.prepare('SELECT * FROM operations WHERE id=?').get(input.request_id);
  assert.equal(task.automatic.review_authorization.request_fingerprint, operation.fingerprint);
  assert.equal(task.automatic.review_authorization.authorization_sha256, digest(task.automatic.authorization));
  assert.equal(task.automatic.authorization.review_protocol, LOCAL_ACTIONABILITY_REVIEW_VERSION);
  assert.equal(task.automatic.authorization.max_corrections, 0); assert.equal(value.api.created.length, 0);
});

test('MCP four-turn authority is explicit, fingerprinted, immutable and admits no additional authority fields', async context => {
  const value = await setup(context, { status: 'completed' }, { noApi: true }), server = createServer(value.controller, async () => {});
  const client = new Client({ name: 'four-turn-admission', version: '1' }), [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b); context.after(async () => { await client.close(); await server.close(); });
  const input = { ...value.input, automatic: { ...automaticAuthority(), max_codex_turns: 4, max_corrections: 1, review_protocol: LOCAL_ACTIONABILITY_REVIEW_VERSION } };
  for (const automatic of [{ ...input.automatic, max_corrections: 0 }, { ...input.automatic, max_corrections: 2 },
    { ...input.automatic, max_codex_turns: 5 }, { ...input.automatic, review_protocol: undefined },
    { ...input.automatic, review_protocol: 'v1' }, { ...input.automatic, reviewerIndependent: true }, { ...input.automatic, fourth_turn_authorized: true }]) {
    const response = await client.callTool({ name: 'start_task', arguments: { ...input, automatic } }); assert.equal(response.isError, true);
  }
  for (const change of [{ execution_backend: 'agents_api' }, { execution_backend: undefined }, { repository_id: undefined }]) {
    const response = await client.callTool({ name: 'start_task', arguments: { ...input, ...change } }); assert.equal(response.isError, true);
  }
  assert.equal(value.instances.length, 0); assert.equal(value.controller.db.prepare('SELECT count(*) AS n FROM tasks').get().n, 0);
  const response = await client.callTool({ name: 'start_task', arguments: input }); assert.notEqual(response.isError, true);
  await value.drain(); await Promise.all([...value.controller.automaticJobs.values()]);
  const task = value.controller.task(response.structuredContent.task_id);
  assert.equal(task.automatic.authorization.max_codex_turns, 4);
  assert.equal(task.automatic.review_authorization.request_fingerprint, value.controller.db.prepare('SELECT fingerprint FROM operations WHERE id=?').get(input.request_id).fingerprint);
  const count = value.instances.length;
  assert.notEqual((await client.callTool({ name: 'start_task', arguments: input })).isError, true);
  assert.equal((await client.callTool({ name: 'start_task', arguments: { ...input, automatic: { ...input.automatic, max_codex_turns: 3 } } })).isError, true);
  assert.equal(value.instances.length, count); assert.equal(value.controller._api, undefined);
});

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

test('Git-dependent validation is rejected before operations, provisioning or implementation admission', async context => {
  const value = await setup(context, {}, { noApi: true });
  value.input.contract.test_commands = ['git diff --check'];
  const before = await fs.readdir(value.controller.workspaceRoot);
  await assert.rejects(value.start(), { code: 'LOCAL_VALIDATION_GIT_COMMAND_UNSUPPORTED' });
  assert.equal(value.controller.db.prepare('SELECT count(*) AS count FROM tasks').get().count, 0);
  assert.equal(value.controller.db.prepare('SELECT count(*) AS count FROM operations').get().count, 0);
  assert.deepEqual(await fs.readdir(value.controller.workspaceRoot), before);
  assert.equal(value.instances.length, 0); assert.equal(value.controller.jobs.size, 0);
  assert.equal(value.executor.started.length, 0); assert.equal(value.controller._api, undefined);
  value.input.contract.test_commands = ['python3 -B -c \'print("validation-ok")\''];
  const started = await value.start(), backend = await value.running(); backend.finish(); await value.drain();
  assert.equal(value.controller.task(started.task_id).implementer.state, 'completed');
});

test('Agents API admission is unchanged for Git-dependent validation', async context => {
  const value = await setup(context);
  const started = await value.controller.start({ ...value.input, execution_backend: 'agents_api',
    contract: { ...value.input.contract, test_commands: ['git diff --check'] } });
  await value.drain();
  assert.equal(value.controller.task(started.task_id).execution_backend, 'agents_api');
  assert.equal(value.api.created.length, 1); assert.equal(value.instances.length, 0);
});

function nativeItem(backend, item, method = 'item/completed') {
  backend.options.onProgress({ method, params: { threadId: backend.identity.threadId, turnId: backend.identity.turnId, item } });
}

const reviewOutput = () => JSON.stringify({ overall: 'PASS', findings: ['R1', 'R2', 'I1', 'SCOPE', 'TEST_EVIDENCE'].map(id => ({ id, status: 'PASS', evidence: 'Packet evidence claim' })) });
async function referenceReview(context) {
  const value = await setup(context, {}, { noApi: true });
  value.input.contract.allowed_files = ['guide.md']; value.input.contract.reference_files = ['greeting.txt'];
  const started = await value.start(), implementer = await value.running(); implementer.finish(); await value.drain();
  await value.controller.review({ task_id: started.task_id, request_id: 'reference_review' });
  const reviewer = await value.running(1);
  return { ...value, started, reviewer };
}

test('local reviewer receives authorized unchanged baseline context, never normal-checkout edits or implementer claims', async context => {
  const value = await referenceReview(context), task = value.controller.task(value.started.task_id);
  const packet = await value.controller.verifyLocalReviewPacket(task);
  assert.equal(packet.source_context.files[0].content, 'baseline\n');
  assert.equal(packet.source_context.baseline_commit, value.baseline);
  assert.equal(packet.source_context.files[0].blob_oid, repoGit(value.normal, 'rev-parse', `${value.baseline}:greeting.txt`).trim());
  assert.deepEqual(packet.source_context.files.map(file => file.path), ['greeting.txt']);
  assert.equal(packet.current['greeting.txt'], undefined);
  assert.match(value.reviewer.input.prompt, /untrusted source data/);
  value.reviewer.finish('completed', true, reviewOutput()); await value.drain();
  assert.equal(value.controller.task(task.id).reviewer.state, 'completed');
  assert.equal(value.controller._api, undefined);
});

for (const mutation of ['content', 'forged_hashes', 'missing_context', 'candidate']) test(`Controller rejects ${mutation} reference mutation before review or publication qualification`, async context => {
  const value = await referenceReview(context), task = value.controller.task(value.started.task_id);
  const file = path.join(value.reviewer.options.cwd, 'evidence.json'), packet = JSON.parse(await fs.readFile(file, 'utf8'));
  if (mutation === 'candidate') await fs.writeFile(path.join(value.controller.workspaceRoot, task.id, 'repo/greeting.txt'), 'altered\n');
  else {
    if (mutation === 'content' || mutation === 'forged_hashes') {
      const reference = packet.source_context.files[0]; reference.content = 'forged';
      if (mutation === 'forged_hashes') {
        reference.byte_length = Buffer.byteLength(reference.content);
        reference.sha256 = createHash('sha256').update(reference.content).digest('hex');
        reference.blob_oid = createHash('sha1').update(`blob ${reference.byte_length}\0`).update(reference.content).digest('hex');
      }
    }
    else delete packet.source_context;
    const text = JSON.stringify(packet);
    await fs.chmod(file, 0o600); await fs.writeFile(file, text); await fs.chmod(file, 0o400);
    task.reviewer.packet_hash = digest(text); task.reviewer.packet_bytes = Buffer.byteLength(text); value.controller.save(task);
  }
  await assert.rejects(value.controller.verifyLocalReviewPacket(task), error => /LOCAL_(REFERENCE_CHANGED|REVIEW_REFERENCE_CHANGED)/.test(error.code));
  value.reviewer.finish('completed', true, reviewOutput()); await value.drain();
  assert.equal(value.controller.task(task.id).reviewer.state, 'needs_attention');
  await assert.rejects(value.controller.publish({ task_id: task.id, title: 'No' }), /PUBLICATION_REQUIRES_PASS_REVIEW/);
});

for (const names of [['missing.py'], ['../secret'], ['greeting.txt']]) test(`reference admission rejects ${JSON.stringify(names)} before implementation`, async context => {
  const value = await setup(context, {}, { noApi: true }); value.input.contract.reference_files = names;
  await assert.rejects(value.start(), error => /^(LOCAL_REFERENCE_|INVALID_LOCAL_REFERENCE)/.test(error.code));
  assert.equal(value.instances.length, 0); assert.equal(value.api.created.length, 0);
  assert.equal(value.controller.db.prepare('SELECT count(*) AS count FROM tasks').get().count, 0);
});

test('reference files do not extend the Agents API execution path', async context => {
  const value = await setup(context); value.input.contract.reference_files = ['README.md'];
  await assert.rejects(value.controller.start({ ...value.input, execution_backend: 'agents_api' }), { code: 'LOCAL_REFERENCES_REQUIRE_LOCAL_REPOSITORY' });
  assert.equal(value.api.created.length, 0); assert.equal(value.instances.length, 0);
});

async function reviewing(context) {
  const value = await setup(context, {}, { noApi: true }); value.input.contract.test_commands = ['python3 -B check.py'];
  const started = await value.start(), implementer = await value.running(); implementer.finish(); await value.drain();
  await value.controller.review({ task_id: started.task_id, request_id: 'review_operation' });
  const reviewer = await value.running(1);
  return { ...value, started, implementer, reviewer };
}

test('independent local reviewer binds durable distinct identity, read-only workspace, packet and tree; findings cannot manufacture PASS', async context => {
  const value = await reviewing(context), { controller, started, reviewer } = value;
  const task = controller.task(started.task_id), ref = task.reviewer;
  assert.equal(ref.execution_backend, 'local_codex'); assert.equal(ref.local.thread_id, 'review-thread-fixture');
  assert.notEqual(ref.local.thread_id, task.implementer.local.thread_id); assert.equal(ref.local.turn_id, 'turn-fixture');
  assert.equal(ref.local.turn_submission_acknowledged, true); assert.equal(ref.local.terminal_observed, false);
  const durable = JSON.parse(controller.db.prepare('SELECT value FROM tasks WHERE id=?').get(task.id).value);
  assert.deepEqual(durable.reviewer, ref); assert.equal(reviewer.options.reviewOnly, true);
  assert.notEqual(reviewer.options.cwd, value.implementer.options.cwd); assert.deepEqual(reviewer.input.allowedFiles, []);
  assert.equal(reviewer.input.threadId, undefined); assert.match(reviewer.input.prompt, /independent evidence-only reviewer/);
  assert.deepEqual(await fs.readdir(reviewer.options.cwd), ['evidence.json']);
  const packet = JSON.parse(await fs.readFile(path.join(reviewer.options.cwd, 'evidence.json'), 'utf8'));
  assert.deepEqual(packet.reviewed_git_state, ref.reviewed_git_state);
  assert.equal(packet.local_scope.contract_sha256, digest(value.input.contract));
  assert.equal(packet.contract, contractMarkdown(value.input.contract, 'local_codex'));
  assert.deepEqual(packet.contract_binding, localContractBinding(value.input.contract, packet.contract));
  assert.notEqual(packet.contract_binding.markdown_sha256, packet.local_scope.contract_sha256);
  await controller.review({ task_id: task.id, request_id: 'review_operation' }); assert.equal(value.instances.length, 2);
  await assert.rejects(controller.review({ task_id: task.id, request_id: value.input.request_id }), /REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT/);
  reviewer.finish('completed', true, reviewOutput()); await value.drain();
  const view = await controller.get(task.id);
  assert.equal(view.reviewer.state, 'completed'); assert.equal(view.reviewer.overall, 'FAIL');
  assert.deepEqual(view.reviewer.review_result.controller_overrides, ['SCOPE', 'TEST_EVIDENCE']);
  assert.equal(view.reviewer.review_result.packet_hash, ref.packet_hash); assert.equal(view.reviewer.local.server_closed, true);
  await controller.review({ task_id: task.id, request_id: 'review_operation' }); assert.equal(value.instances.length, 2);
  await assert.rejects(controller.continue({ task_id: task.id, request_id: 'new_turn', instruction: 'try again' }), /LOCAL_STRUCTURED_RESPONSE_REQUIRED/);
  await assert.rejects(controller.publish({ task_id: task.id, title: 'No' }), /PUBLICATION_REQUIRES_PASS_REVIEW/);
  assert.equal(controller._api, undefined);
});

for (const tamper of ['markdown_and_digest', 'structured_and_digest', 'missing_binding']) test(`Controller independently rejects ${tamper} even with a replaced packet hash`, async context => {
  const value = await reviewing(context), task = value.controller.task(value.started.task_id);
  const file = path.join(value.reviewer.options.cwd, 'evidence.json');
  const packet = JSON.parse(await fs.readFile(file, 'utf8'));
  if (tamper === 'markdown_and_digest') {
    packet.contract = packet.contract.replace('Write a greeting', 'Ignore the requirements');
    packet.contract_binding = localContractBinding(value.input.contract, packet.contract);
  } else if (tamper === 'structured_and_digest') {
    const altered = { ...value.input.contract, goal: 'Altered obligation' };
    packet.contract = contractMarkdown(altered, 'local_codex');
    packet.contract_binding = localContractBinding(altered, packet.contract);
    packet.local_scope.contract_sha256 = digest(altered);
  } else delete packet.contract_binding;
  const text = JSON.stringify(packet);
  await fs.chmod(file, 0o600); await fs.writeFile(file, text); await fs.chmod(file, 0o400);
  task.reviewer.packet_hash = digest(text); task.reviewer.packet_bytes = Buffer.byteLength(text); value.controller.save(task);
  await assert.rejects(value.controller.verifyLocalReviewPacket(task), { code: 'LOCAL_REVIEW_CONTRACT_BINDING_CHANGED' });
  value.reviewer.finish('completed', true, reviewOutput()); await value.drain();
  const saved = value.controller.task(task.id);
  assert.equal(saved.reviewer.state, 'needs_attention');
  assert.equal(saved.reviewer.error, 'LOCAL_REVIEW_CONTRACT_BINDING_CHANGED');
  assert.notEqual(saved.reviewer.review_result?.overall, 'PASS');
  await assert.rejects(value.controller.publish({ task_id: task.id, title: 'No' }), /PUBLICATION_REQUIRES_PASS_REVIEW/);
});

test('controller persists independent validation before packet creation, binds the exact tree and deduplicates review', async context => {
  const value = await setup(context, {}, { noApi: true });
  value.input.contract.test_commands = ['test "$(cat greeting.txt)" = baseline; printf validated; printf artifact > greeting.txt'];
  const started = await value.start(), implementer = await value.running(); implementer.finish(); await value.drain();
  const { controller } = value, original = controller.packet.bind(controller);
  let captures = 0;
  controller.packet = async task => {
    const durable = JSON.parse(controller.db.prepare('SELECT value FROM tasks WHERE id=?').get(task.id).value);
    assert.equal(durable.local_validation.status, 'completed');
    assert.equal(durable.local_validation.original_unchanged, true);
    assert.equal(durable.local_validation.results[0].status, 'passed');
    captures++; return original(task);
  };
  await controller.review({ task_id: started.task_id, request_id: 'independent_review' });
  const reviewer = await value.running(1), task = controller.task(started.task_id);
  const record = task.local_validation.results[0];
  assert.equal(record.command, value.input.contract.test_commands[0]); assert.equal(record.exit_code, 0);
  assert.equal(record.candidate_tree, task.reviewer.reviewed_git_state.tree_sha);
  assert.equal(record.stdout.text, 'validated'); assert.equal(record.independently_observed, true);
  assert.notEqual(record.cwd, implementer.options.cwd);
  assert.equal(await fs.readFile(path.join(implementer.options.cwd, 'greeting.txt'), 'utf8'), 'baseline\n');
  assert.equal(await fs.readFile(path.join(value.normal, 'greeting.txt'), 'utf8'), 'uncommitted owner work\n');
  const packet = JSON.parse(await fs.readFile(path.join(reviewer.options.cwd, 'evidence.json'), 'utf8'));
  assert.deepEqual(packet.independent_validation, task.local_validation);
  assert.deepEqual(packet.independent_validation.reviewed_git_state, packet.reviewed_git_state);
  await controller.review({ task_id: started.task_id, request_id: 'independent_review' });
  await controller.review({ task_id: started.task_id, request_id: 'different_review_request' });
  assert.equal(captures, 1); assert.equal(value.instances.length, 2);
  reviewer.finish('completed', true, reviewOutput()); await value.drain();
  const result = controller.task(started.task_id).reviewer.review_result;
  assert.deepEqual(result.controller_overrides, ['SCOPE']); assert.equal(result.overall, 'FAIL');
  assert.equal(controller._api, undefined);
  await assert.rejects(controller.publish({ task_id: started.task_id, title: 'No' }), /PUBLICATION_REQUIRES_PASS_REVIEW/);
});

function heldValidation() {
  let entered, release;
  const waiting = new Promise(resolve => { entered = resolve; });
  const runner = { terminationConfirmed: false, calls: 0, cancelled: false,
    async run() { this.calls++; entered(); await new Promise(resolve => { release = resolve; }); },
    cancel() { this.cancelled = true; this.terminationConfirmed = true; release?.(); } };
  return { runner, waiting };
}

for (const action of ['cleanup', 'shutdown']) test(`${action} stops validation before waiting and never starts a reviewer`, async context => {
  const held = heldValidation(), value = await setup(context, {}, { localValidationFactory: () => held.runner });
  value.input.contract.test_commands = ['sleep 60'];
  const started = await value.start(), implementer = await value.running(); implementer.finish(); await value.drain();
  await value.controller.review({ task_id: started.task_id, request_id: 'held_review' }); await held.waiting;
  assert.equal(value.controller.task(started.task_id).reviewer.local.thread_id, null);
  if (action === 'cleanup') await value.controller.cleanup({ task_id: started.task_id }); else await value.controller.close();
  assert.equal(held.runner.cancelled, true); assert.equal(value.instances.length, 1);
  if (action === 'cleanup') {
    assert.equal(value.controller.task(started.task_id).local_validation.status, 'interrupted');
    assert.equal(value.controller.task(started.task_id).cleanup.executor_stopped, true);
  }
});

test('restart preserves uncertain validation identity, blocks deletion, and never replays tests', async context => {
  const held = heldValidation(), value = await setup(context, {}, { localValidationFactory: () => held.runner });
  value.input.contract.test_commands = ['sleep 60'];
  const started = await value.start(), implementer = await value.running(); implementer.finish(); await value.drain();
  await value.controller.review({ task_id: started.task_id, request_id: 'held_review' }); await held.waiting;
  const pending = value.controller.task(started.task_id); await value.controller.close();
  const seed = await new Controller(value.config).init(); seed.save(pending); clearInterval(seed.sweeper); seed.dbClosed = true; seed.db.close();
  const recovered = await new Controller(value.config).init();
  try {
    const task = recovered.task(started.task_id);
    assert.equal(task.local_validation.status, 'uncertain'); assert.equal(task.local_validation.termination_confirmed, false);
    assert.equal(task.local_validation.attempt_id, pending.local_validation.attempt_id);
    assert.equal(task.local_validation.diagnostic, 'VALIDATION_RESTART_NO_REPLAY');
    await recovered.review({ task_id: task.id, request_id: 'held_review' });
    await recovered.review({ task_id: task.id, request_id: 'no_replay' });
    assert.equal(held.runner.calls, 1); assert.equal(value.instances.length, 1);
    const cleanup = await recovered.cleanup({ task_id: task.id, delete_workspace: true });
    assert.equal(cleanup.cleanup.workspace_deleted, false);
    assert.match(cleanup.cleanup.cleanup_diagnostic, /VALIDATION_TERMINATION_UNCONFIRMED/);
  } finally { await recovered.close(); }
});

test('unconfirmed validation termination prevents reviewer startup and unsafe workspace deletion', async context => {
  const runner = { terminationConfirmed: false, run: async () => {}, cancel() {} };
  const value = await setup(context, {}, { localValidationFactory: () => runner });
  const started = await value.start(), implementer = await value.running(); implementer.finish(); await value.drain();
  await value.controller.review({ task_id: started.task_id, request_id: 'uncertain_validation' }); await value.drain();
  assert.equal(value.controller.task(started.task_id).local_validation.status, 'uncertain');
  assert.equal(value.instances.length, 1); assert.equal(value.controller.task(started.task_id).reviewer.review_result, null);
  const result = await value.controller.cleanup({ task_id: started.task_id, delete_workspace: true });
  assert.equal(result.cleanup.workspace_deleted, false); assert.equal(result.cleanup.executor_stopped, false);
  assert.equal(result.cleanup.validation_termination_confirmed, false); assert.match(result.cleanup.cleanup_diagnostic, /VALIDATION_TERMINATION_UNCONFIRMED/);
});

test('candidate mutation during independent validation prevents reviewer analysis and stale packet qualification', async context => {
  let repo;
  const runner = { terminationConfirmed: true, async run() { await fs.writeFile(path.join(repo, 'greeting.txt'), 'changed during validation'); }, cancel() {} };
  const value = await setup(context, {}, { localValidationFactory: () => runner });
  const started = await value.start(), implementer = await value.running(); repo = implementer.options.cwd;
  implementer.finish(); await value.drain();
  await value.controller.review({ task_id: started.task_id, request_id: 'changed_validation' }); await value.drain();
  const task = value.controller.task(started.task_id);
  assert.equal(task.local_validation.original_unchanged, false); assert.equal(value.instances.length, 1);
  assert.equal(task.reviewer.review_result, null);
  const packet = JSON.parse((await value.controller.buildPacket(task)).text);
  assert.equal(packet.independent_validation.status, 'unavailable');
  assert.match(packet.independent_validation.reason, /does not match/);
});

test('controller persistence failure at command start prevents independent execution and reviewer PASS', async context => {
  const value = await setup(context);
  value.input.contract.test_commands = ['printf must-not-run'];
  const started = await value.start(), implementer = await value.running(); implementer.finish(); await value.drain();
  const save = value.controller.save.bind(value.controller);
  let rejected = false;
  value.controller.save = task => {
    if (!rejected && task.local_validation?.results.some(record => record.status === 'running')) { rejected = true; throw Error('synthetic disk failure'); }
    return save(task);
  };
  await value.controller.review({ task_id: started.task_id, request_id: 'persistence_validation' });
  const reviewer = await value.running(1), task = value.controller.task(started.task_id);
  assert.equal(rejected, true); assert.equal(task.local_validation.status, 'unavailable');
  assert.equal(task.local_validation.results[0].start_attempted, false);
  reviewer.finish('completed', true, reviewOutput()); await value.drain();
  assert(value.controller.task(started.task_id).reviewer.review_result.controller_overrides.includes('TEST_EVIDENCE'));
});

for (const mutation of ['packet', 'worktree', 'normal_checkout', 'packet_link']) test(`local review rejects ${mutation} mutation during analysis`, async context => {
  const value = await reviewing(context), file = path.join(value.reviewer.options.cwd, 'evidence.json');
  if (mutation === 'packet') { await fs.chmod(file, 0o600); await fs.writeFile(file, '{}'); await fs.chmod(file, 0o400); }
  else if (mutation === 'packet_link') { const text = await fs.readFile(file); await fs.unlink(file); await fs.writeFile(file + '.other', text); await fs.symlink(file + '.other', file); }
  else if (mutation === 'normal_checkout') await fs.writeFile(path.join(value.normal, 'greeting.txt'), 'normal checkout changed during review');
  else await fs.writeFile(path.join(value.implementer.options.cwd, 'greeting.txt'), 'changed during review');
  value.reviewer.finish('completed', true, reviewOutput()); await value.drain();
  const ref = value.controller.task(value.started.task_id).reviewer;
  assert.equal(ref.state, 'needs_attention'); assert.equal(ref.review_result, null); assert.match(ref.error, /LOCAL_REVIEW_(PACKET|TREE|NORMAL_CHECKOUT)_CHANGED/);
});

for (const outcome of ['invalid_json', 'failed', 'interrupted', 'uncertain', 'missing_terminal', 'missing_ack']) test(`local reviewer ${outcome} cannot produce a trusted result`, async context => {
  const value = await reviewing(context);
  if (outcome === 'missing_ack') {
    const task = value.controller.task(value.started.task_id); task.reviewer.local.turn_submission_acknowledged = false; value.controller.save(task);
    value.reviewer.identity.turnSubmissionAcknowledged = false;
  }
  value.reviewer.finish(['failed', 'interrupted', 'uncertain'].includes(outcome) ? outcome : 'completed', !['missing_terminal', 'uncertain'].includes(outcome), outcome === 'invalid_json' ? 'I declare PASS' : reviewOutput());
  await value.drain(); const ref = value.controller.task(value.started.task_id).reviewer;
  assert.equal(ref.state, 'needs_attention'); assert.equal(ref.review_result, null); assert(ref.error);
});

test('review integrity is rechecked on get_task after a completed analysis', async context => {
  const value = await reviewing(context); value.reviewer.finish('completed', true, reviewOutput()); await value.drain();
  await fs.writeFile(path.join(value.implementer.options.cwd, 'greeting.txt'), 'late mutation');
  const view = await value.controller.get(value.started.task_id);
  assert.equal(view.reviewer.state, 'needs_attention'); assert.equal(view.reviewer.review_result, null);
  assert.equal(view.reviewer.error, 'LOCAL_REVIEW_INTEGRITY_CHANGED');
});

for (const action of ['cleanup', 'shutdown']) test(`${action} cancels and closes an owned local reviewer`, async context => {
  const value = await reviewing(context);
  if (action === 'cleanup') await value.controller.cleanup({ task_id: value.started.task_id }); else await value.controller.close();
  assert(value.reviewer.calls.includes('cancel')); assert(value.reviewer.calls.includes('close'));
  const recovered = await new Controller(value.config).init();
  try { assert.equal(recovered.task(value.started.task_id).reviewer.review_result, null); }
  finally { await recovered.close(); }
});

test('reviewer human requests never auto-approve, and pending reviewer restart never replays', async context => {
  const value = await reviewing(context);
  assert.throws(() => value.reviewer.emit('human_request', { request: { id: 123, method: 'item/commandExecution/requestApproval' } }), /LOCAL_REVIEW_HUMAN_REQUEST_UNSUPPORTED/);
  assert.equal(value.reviewer.input.signal.aborted, true);
  const pending = value.controller.task(value.started.task_id);
  await value.controller.close();
  const first = await new Controller(value.config).init(); first.save(pending); clearInterval(first.sweeper); first.dbClosed = true; first.db.close();
  const recovered = await new Controller(value.config).init();
  try {
    const ref = recovered.task(pending.id).reviewer;
    assert.equal(ref.state, 'needs_attention'); assert.equal(ref.local.execution_state, 'uncertain'); assert.equal(ref.review_result, null);
    assert.equal(ref.local.thread_id, pending.reviewer.local.thread_id); assert.match(ref.local.diagnostics.join(), /NO_REPLAY/);
    await recovered.review({ task_id: pending.id, request_id: 'review_operation' }); assert.equal(value.instances.length, 2);
  } finally { await recovered.close(); }
});

test('a reused implementer thread is rejected before reviewer turn submission', async context => {
  const value = await setup(context, { reviewThread: 'thread-fixture' });
  const started = await value.start(), implementer = await value.running(); implementer.finish(); await value.drain();
  await value.controller.review({ task_id: started.task_id, request_id: 'review_reused_thread' }); await value.drain();
  const ref = value.controller.task(started.task_id).reviewer;
  assert.equal(ref.state, 'needs_attention'); assert.equal(ref.local.turn_submission_attempted, false);
  assert.equal(ref.review_result, null); assert(value.instances[1].calls.includes('close'));
});

test('unresolved reviewer runtime diagnostics cannot yield a qualified result', async context => {
  const value = await reviewing(context);
  value.reviewer.mode.reviewDiagnostics = ['Codex reported a runtime error.'];
  value.reviewer.finish('completed', true, reviewOutput()); await value.drain();
  const ref = value.controller.task(value.started.task_id).reviewer;
  assert.equal(ref.state, 'needs_attention'); assert.equal(ref.review_result, null);
  assert.equal(ref.error, 'LOCAL_REVIEW_EXECUTION_UNVERIFIED');
});

test('restart preserves completed review and marks a crash during result validation uncertain without replay', async context => {
  const value = await reviewing(context); value.reviewer.finish('completed', true, reviewOutput()); await value.drain();
  const completed = value.controller.task(value.started.task_id).reviewer.review_result;
  await value.controller.close();
  const recovered = await new Controller(value.config).init();
  assert.deepEqual(recovered.task(value.started.task_id).reviewer.review_result, completed);
  await recovered.review({ task_id: value.started.task_id, request_id: 'review_operation' });
  const pending = recovered.task(value.started.task_id); pending.reviewer.state = 'finishing'; pending.reviewer.review_result = null;
  recovered.save(pending); await recovered.close();
  const restarted = await new Controller(value.config).init();
  try {
    const ref = restarted.task(pending.id).reviewer;
    assert.equal(ref.state, 'needs_attention'); assert.equal(ref.local.execution_state, 'uncertain');
    assert.equal(ref.review_result, null); assert.equal(value.instances.length, 2);
    await restarted.review({ task_id: pending.id, request_id: 'review_operation' }); assert.equal(value.instances.length, 2);
  } finally { await restarted.close(); }
});

test('reviewer cancellation cannot race validation into a completed result', async context => {
  const value = await reviewing(context), original = value.controller.verifyLocalReviewPacket.bind(value.controller);
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  value.controller.verifyLocalReviewPacket = async task => {
    const packet = await original(task); entered(); await new Promise(resolve => { release = resolve; }); return packet;
  };
  value.reviewer.finish('completed', true, reviewOutput()); await waiting;
  const stopping = value.controller.cleanup({ task_id: value.started.task_id });
  for (let attempt = 0; attempt < 100 && !value.controller.task(value.started.task_id).reviewer.stopping; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  release(); await stopping; await value.drain();
  assert.equal(value.controller.task(value.started.task_id).reviewer.review_result, null);
});

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
  assert.equal(data.gates.local_review, 'bounded_evidence_qualification'); assert.equal(data.gates.local_publication, 'controller_gated_exact_tree');
  await assert.rejects(controller.publish({ task_id: started.task_id, title: 'No' }), /PUBLICATION_REQUIRES_PASS_REVIEW/);
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
  await fs.writeFile(path.join(value.controller.workspaceRoot, started.task_id, 'repo/greeting.txt'), 'x'.repeat(125000));
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
  await assert.rejects(value.controller.review({ task_id: saved.id, request_id: 'review_unclosed' }), /LOCAL_EVIDENCE_EXECUTION_NOT_CLOSED/);
});

async function failedReviewPacket(context) {
  const value = await setup(context, { status: 'completed' }, { noApi: true });
  const started = await value.start(); await value.drain();
  const original = value.controller.packet.bind(value.controller);
  const build = value.controller.buildPacket.bind(value.controller);
  value.controller.packet = async task => {
    const buildData = value.controller.buildPacketData;
    value.controller.buildPacketData = async () => { throw Object.assign(new Error('EVIDENCE_SIZE_LIMIT'), { code: 'EVIDENCE_SIZE_LIMIT', diagnostic: { code: 'EVIDENCE_SIZE_LIMIT', measured_bytes: 157677, limit_bytes: 131072 } }); };
    try { await build(task); } finally { value.controller.buildPacketData = buildData; }
  };
  await value.controller.review({ task_id: started.task_id, request_id: 'failed_packet_request' }); await value.drain();
  value.controller.packet = original;
  const failed = value.controller.task(started.task_id);
  assert.equal(failed.reviewer.error, 'EVIDENCE_SIZE_LIMIT'); assert.equal(failed.reviewer.local.instance_started, false);
  assert.equal(failed.local_validation.status, 'completed'); assert.equal(value.instances.length, 1);
  return { ...value, started, failed };
}

test('explicit distinct request retries pre-execution packaging failure once with fresh validation and preserved history', async context => {
  const value = await failedReviewPacket(context), { controller, started, failed } = value;
  await controller.review({ task_id: started.task_id, request_id: 'failed_packet_request' });
  assert.equal(controller.task(started.task_id).local_validation.attempt_id, failed.local_validation.attempt_id);
  await Promise.all([1, 2].map(() => controller.review({ task_id: started.task_id, request_id: 'fresh_packet_request' })));
  await value.drain();
  const task = controller.task(started.task_id);
  assert.notEqual(task.local_validation.attempt_id, failed.local_validation.attempt_id);
  assert.deepEqual(task.reviewer.reviewed_git_state, failed.reviewer.reviewed_git_state);
  assert.deepEqual(task.previous_reviewers[0].independent_validation, failed.local_validation);
  assert.equal(task.previous_reviewers[0].review_packet_diagnostic.measured_bytes, 157677);
  assert.equal(controller.db.prepare('SELECT status FROM operations WHERE id=?').get('failed_packet_request').status, 'failed');
  assert.equal(value.instances.length, 2); assert.equal(controller._api, undefined);
});

for (const mutation of ['submitted', 'acknowledged', 'instance', 'thread', 'termination', 'active_validation', 'active_reviewer', 'active_job', 'old_operation', 'history']) test(`review retry rejects ${mutation} uncertainty`, async context => {
  const value = await failedReviewPacket(context), { controller, started } = value;
  const task = controller.task(started.task_id);
  if (mutation === 'submitted') task.reviewer.local.turn_submission_attempted = true;
  if (mutation === 'acknowledged') task.reviewer.local.turn_submission_acknowledged = true;
  if (mutation === 'instance') task.reviewer.local.instance_started = true;
  if (mutation === 'thread') task.reviewer.local.thread_id = 'unknown';
  if (mutation === 'termination') task.local_validation.termination_confirmed = false;
  if (mutation === 'history') task.previous_reviewers = [{ local: { instance_started: true } }];
  if (mutation === 'old_operation') controller.opDone('failed_packet_request', 'uncertain');
  controller.save(task);
  if (mutation === 'active_validation') controller.validationRuns.set(task.id, {});
  if (mutation === 'active_reviewer') controller.localRuns.set(`${task.id}:reviewer`, {});
  if (mutation === 'active_job') controller.jobs.set(`${task.id}:reviewer`, Promise.resolve());
  try { await assert.rejects(controller.review({ task_id: task.id, request_id: 'unsafe_retry' }), /LOCAL_REVIEW_RETRY_UNSAFE/); }
  finally { controller.validationRuns.clear(); controller.localRuns.clear(); controller.jobs.clear(); }
  assert.equal(value.instances.length, 1);
});

for (const state of ['cleaned', 'expired', 'changed_tree']) test(`review retry rejects ${state} without reviving the task`, async context => {
  const value = await failedReviewPacket(context), { controller, started } = value;
  const task = controller.task(started.task_id);
  if (state === 'cleaned') await controller.cleanup({ task_id: task.id });
  if (state === 'expired') { task.deadline = Date.now() - 1; controller.save(task); }
  if (state === 'changed_tree') await fs.writeFile(path.join(controller.workspaceRoot, task.id, 'repo/greeting.txt'), 'different\n');
  await assert.rejects(controller.review({ task_id: task.id, request_id: 'ineligible_retry' }), /TASK_CLEANED|TASK_EXPIRED|LOCAL_REVIEW_RETRY_TREE_CHANGED/);
  assert.equal(value.instances.length, 1);
});

test('abrupt restart retains proven no-reviewer-execution failure without replay; new request alone retries', async context => {
  const value = await failedReviewPacket(context);
  clearInterval(value.controller.sweeper);
  value.controller.closed = true; value.controller.dbClosed = true; value.controller.db.close();
  const controller = await new Controller(value.config).init();
  try {
    const saved = controller.task(value.started.task_id);
    assert.equal(saved.reviewer.error, 'EVIDENCE_SIZE_LIMIT');
    assert.equal(saved.reviewer.local.execution_state, 'failed');
    assert.equal(saved.reviewer.local.instance_started, false);
    assert.equal(controller.jobs.size, 0); assert.equal(value.instances.length, 1);
    await controller.review({ task_id: saved.id, request_id: 'failed_packet_request' });
    assert.equal(value.instances.length, 1);
    await controller.review({ task_id: saved.id, request_id: 'after_restart_review' });
    await Promise.all([...controller.jobs.values()]);
    assert.equal(value.instances.length, 2);
    assert.equal(controller.task(saved.id).previous_reviewers.length, 1);
  } finally { await controller.close(); }
});

test('graceful shutdown stop intent is not silently reversed by a review retry', async context => {
  const value = await failedReviewPacket(context);
  await value.controller.close();
  const controller = await new Controller(value.config).init();
  try {
    await assert.rejects(controller.review({ task_id: value.started.task_id, request_id: 'stopped_retry' }), /LOCAL_REVIEW_RETRY_UNSAFE/);
    assert.equal(value.instances.length, 1);
  } finally { await controller.close(); }
});

test('cleanup while retry checks await never releases a replacement review', async context => {
  const value = await failedReviewPacket(context), { controller, started } = value;
  const original = controller.repositoryEvidence.bind(controller);
  controller.repositoryEvidence = async id => {
    const result = await original(id), task = controller.task(id);
    task.cleaned = true; controller.save(task); return result;
  };
  await assert.rejects(controller.review({ task_id: started.task_id, request_id: 'cancelled_retry' }), /TASK_CLEANED/);
  assert.equal(value.instances.length, 1);
  assert.equal(controller.task(started.task_id).reviewer.request_id, 'failed_packet_request');
});

test('unconfirmed reviewer closure prevents workspace deletion and remains explicit', async context => {
  const value = await reviewing(context); value.reviewer.mode.closeFails = true;
  value.reviewer.finish('interrupted'); await value.drain();
  const result = await value.controller.cleanup({ task_id: value.started.task_id, delete_workspace: true });
  assert.equal(result.cleanup.server_closed, false); assert.equal(result.cleanup.workspace_deleted, false);
  assert.match(result.cleanup.cleanup_diagnostic, /REVIEWER_LOCAL_CLOSE_UNCONFIRMED/);
  assert.equal(result.reviewer.review_result, null);
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

test('cleanup during protected-path capture cannot launch local execution afterward', async context => {
  const value = await setup(context), original = value.controller.localProtectedState.bind(value.controller);
  let entered, release;
  const capturing = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
  value.controller.localProtectedState = async repo => { const snapshot = await original(repo); entered(); await held; return snapshot; };
  const started = await value.start(); await capturing;
  const pending = value.controller.cleanup({ task_id: started.task_id });
  for (let attempt = 0; attempt < 100 && !value.controller.task(started.task_id).implementer.stopping; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  const stopping = value.controller.task(started.task_id).implementer.stopping;
  release(); const result = await pending;
  assert.equal(stopping, true); assert.equal(result.state, 'cleaned'); assert.equal(value.instances.length, 0);
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
  await assert.rejects(value.controller.review({ task_id: started.task_id, request_id: 'review_request' }), /LOCAL_REVIEW_REQUIRES_COMPLETED_IMPLEMENTATION/);
  await assert.rejects(value.controller.publish({ task_id: started.task_id, title: 'not allowed' }), /TASK_EXECUTION_PENDING/);
  assert.equal(value.api.created.length, 0); assert.equal(value.controller.task(started.task_id).reviewer, undefined);
  assert.equal(value.controller.task(started.task_id).publication, undefined);
});

test('MCP exposes explicit local opt-in and persisted state without adding operations', async context => {
  const value = await setup(context, { status: 'completed' }), server = createServer(value.controller, async () => {});
  const client = new Client({ name: 'local-integration-test', version: '1' }), [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  context.after(async () => { await client.close(); await server.close(); });
  const list = await client.listTools(); assert.equal(list.tools.length, 8);
  assert.match(client.getInstructions(), /qualified local Codex repository tasks/);
  assert.match(client.getInstructions(), /No local post-completion continuation\./);
  assert(!client.getInstructions().includes('No local post-completion continuation, review or publication'));
  assert.match(list.tools.find(tool => tool.name === 'start_task').description, /qualified PASS review and controller safeguards/);
  assert.match(list.tools.find(tool => tool.name === 'review_task').description, /controller-owned independent validation and a separate Codex reviewer/);
  assert.match(list.tools.find(tool => tool.name === 'publish_task').description, /exact frozen Git tree/);
  assert(!list.tools.some(tool => /Local review and publication are unsupported/.test(tool.description)));
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
  await assert.rejects(value.controller.review({ task_id: value.started.task_id, request_id: 'still_no_review' }), /LOCAL_REVIEW_REQUIRES_COMPLETED_IMPLEMENTATION/);
  await assert.rejects(value.controller.publish({ task_id: value.started.task_id, title: 'No publication' }), /TASK_EXECUTION_PENDING/);
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


// Complete the real Controller's implementation/review/publication path using
// fake sessions and a memory-only GitHub remote; interrupt only final status.
async function completedPublication(context, { turns = 2, versioned = false, pendingOperation = false, beforeCompletion = false, afterPush = false } = {}) {
  let validations = 0;
  const value = await setup(context, { reviewTurn: 'independent-review-turn', implementationDiagnostics: [] }, {
    noApi: true, localValidationFactory: options => {
      const runner = new LocalValidation(options), run = runner.run.bind(runner);
      runner.run = input => { validations++; return run(input); }; return runner;
    },
  });
  const counts = { pushes: 0, creates: 0, reads: 0 };
  const publisher = {
    async target() { counts.reads++; return { repository: 'fixture/reconciliation', base: 'main', remote: 'https://github.com/fixture/reconciliation.git' }; },
    async remoteHead() { counts.reads++; return this.remote || null; },
    async push(repo, target, branch, commit) { counts.pushes++; this.remote = commit; if (afterPush) throw Error('Lost push acknowledgment'); },
    async findPR() { counts.reads++; return this.pr || null; },
    async createPR(target, branch) {
      counts.creates++;
      this.pr = { number: 7, html_url: 'https://github.com/fixture/reconciliation/pull/7', state: 'open', draft: true, merged_at: null,
        head: { ref: branch, sha: this.remote, repo: { full_name: target.repository } }, base: { ref: target.base, repo: { full_name: target.repository } } };
      if (beforeCompletion) throw Error('Lost PR creation acknowledgment');
      return this.pr;
    },
  };
  value.controller.publisher = publisher; value.config.publisher = publisher;
  repoGit(value.normal, 'remote', 'add', 'origin', 'https://github.com/fixture/reconciliation.git');
  value.input.contract.test_commands = ['test "$(cat greeting.txt)" = candidate'];
  value.input.automatic = { ...automaticAuthority(), max_codex_turns: turns, max_corrections: turns > 2 ? 1 : 0,
    ...(versioned || turns > 2 ? { review_protocol: LOCAL_ACTIONABILITY_REVIEW_VERSION } : {}),
    ...(turns === 4 ? { publish_after_correction: true } : {}) };
  const finish = value.controller.finishAutomatic.bind(value.controller);
  value.controller.finishAutomatic = (id, status, reason) => { if (status !== 'succeeded') finish(id, status, reason); };
  const opDone = value.controller.opDone.bind(value.controller);
  if (pendingOperation) value.controller.opDone = (id, status) => { if (!id.startsWith('automatic_publish_')) opDone(id, status); };
  const started = await value.start(), implementer = await value.running();
  await fs.writeFile(path.join(implementer.options.cwd, 'greeting.txt'), 'candidate\n');
  implementer.finish(); await value.drain();
  const reviewer = await value.running(1), raw = JSON.parse(reviewOutput());
  if (versioned || turns > 2) { raw.format = LOCAL_ACTIONABILITY_REVIEW_VERSION; raw.findings.forEach(finding => { finding.classification = null; }); }
  reviewer.finish('completed', true, JSON.stringify(raw)); await value.drain(); await Promise.all([...value.controller.automaticJobs.values()]);
  const task = value.controller.task(started.task_id);
  assert.equal(task.publication?.phase, afterPush ? 'prepared' : beforeCompletion ? 'pushed' : 'complete', JSON.stringify(task.automatic));
  assert.equal(task.automatic.status, beforeCompletion || afterPush ? 'uncertain' : 'progressing', JSON.stringify(task.automatic));
  assert.equal(task.reviewer.review_result.overall, 'PASS');
  assert.equal(counts.pushes, 1); assert.equal(counts.creates, afterPush ? 0 : 1); assert.equal(validations, 1); assert.equal(value.instances.length, 2);
  return { ...value, task, publisher, counts, validations: () => validations };
}
function interruptController(controller) {
  // Abrupt connection loss, without graceful shutdown mutating retained facts.
  clearInterval(controller.sweeper);
  for (const timer of controller.automaticTimers.values()) clearTimeout(timer);
  controller.closed = true; controller.dbClosed = true; controller.db.close();
}
const recoveryLedger = c => JSON.stringify(['tasks', 'operations', 'automatic_attempts', 'audit', 'failures']
  .map(table => c.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));

for (const mode of [{ turns: 2 }, { turns: 2, versioned: true }, { turns: 3 }, { turns: 4 }, { turns: 2, pendingOperation: true }])
test(`terminal publication recovery confirms one historical outcome without replay: ${JSON.stringify(mode)}`, async context => {
  const value = await completedPublication(context, mode), { task } = value;
  const retained = value.controller.db.prepare('SELECT * FROM automatic_attempts WHERE task_id=?').all(task.id);
  const repo = path.join(value.controller.workspaceRoot, task.id, 'repo'), before = await publicationState(repo);
  interruptController(value.controller);
  let previous;
  for (let restart = 0; restart < 2; restart++) {
    const c = await new Controller(value.config).init();
    try {
      const saved = c.task(task.id), ledger = recoveryLedger(c), reads = value.counts.reads;
      assert.equal(saved.automatic.status, 'succeeded', JSON.stringify(saved.automatic));
      assert.equal(saved.automatic.reconciliation.outcome, 'publication_confirmed');
      assert.equal(saved.automatic.reconciliation.confirmed, true);
      assert.equal(saved.automatic.owner_instance, task.automatic.owner_instance); assert.notEqual(c.instanceId, task.automatic.owner_instance);
      assert.equal(saved.deadline, task.deadline); assert.deepEqual(saved.publication, task.publication);
      assert.deepEqual(saved.reviewer, task.reviewer); assert.deepEqual(saved.implementer, task.implementer);
      assert.equal(c.db.prepare('SELECT status FROM operations WHERE id=?').get(task.automatic.publish_request_id).status, 'accepted');
      for (let attempt = 0; attempt < 2; attempt++) {
        await c.reconcileAutomaticPublication(task.id);
        const status = await c.invoke('get_task', { task_id: task.id }, {}, () => c.get(task.id));
        assert.equal(status.automatic.status, 'succeeded'); assert.equal(status.automatic.human_attention_required, false);
        assert.equal(status.automatic.reconciliation.attempt_id, task.automatic.review_request_id);
        assert.equal(status.automatic.reconciliation.publication_id, task.automatic.publish_request_id);
        assert.equal(status.automatic.review.state, 'pass');
        assert.equal(status.automatic.usage.implementer_turn_submissions_attempted, 1);
        assert.equal(status.automatic.usage.reviewer_turn_submissions_attempted, 1);
        assert(!JSON.stringify(status.automatic.reconciliation).includes(value.root));
      }
      assert.equal(recoveryLedger(c), ledger); assert.equal(value.counts.reads, reads);
      if (previous) assert.equal(ledger, previous); previous = ledger;
      assert.deepEqual(await publicationState(repo), before);
      const current = c.db.prepare('SELECT * FROM automatic_attempts WHERE task_id=?').all(task.id);
      for (const row of retained) assert(current.some(now => now.value === row.value && now.observation_sha256 === row.observation_sha256));
      assert.equal(current.filter(row => JSON.parse(row.value).outcome === 'succeeded').length, 1);
      c.scheduleAutomatic(task.id); await Promise.all([...c.automaticJobs.values()]);
      assert.equal(c.automaticJobs.size, 0); assert.equal(c.automaticTimers.size, 0);
      await assert.rejects(c.publish({ task_id: task.id, title: 'Another publication' }), /AUTOMATIC_TASK_OWNS_TRANSITIONS/);
    } finally { interruptController(c); }
  }
  assert.equal(value.instances.length, 2); assert.equal(value.validations(), 1);
  assert.equal(value.counts.pushes, 1); assert.equal(value.counts.creates, 1); assert.equal(value.controller._api, undefined);
});

test('terminal publication recovery preserves a concurrent second instance confirmation', async context => {
  const value = await completedPublication(context, { pendingOperation: true }), { task } = value;
  interruptController(value.controller);
  const first = new Controller(value.config), second = new Controller(value.config);
  const find = value.publisher.findPR.bind(value.publisher); let entered = false;
  value.publisher.findPR = async (...args) => {
    if (!entered) { entered = true; await second.init(); }
    return find(...args);
  };
  try {
    await first.init();
    assert(entered);
    for (const c of [first, second]) {
      const status = await c.get(task.id);
      assert.equal(status.automatic.status, 'succeeded'); assert.equal(status.automatic.reconciliation.confirmed, true);
      assert.equal(c.persistenceFailures.has(task.id), false);
      assert.equal(c.db.prepare("SELECT count(*) AS n FROM automatic_attempts WHERE task_id=? AND json_extract(value,'$.outcome')='succeeded'").get(task.id).n, 1);
      assert.equal(c.task(task.id).automatic.owner_instance, task.automatic.owner_instance);
    }
    assert.equal(value.instances.length, 2); assert.equal(value.validations(), 1);
    assert.equal(value.counts.pushes, 1); assert.equal(value.counts.creates, 1);
  } finally { for (const c of [first, second]) if (c.db && !c.dbClosed) interruptController(c); }
});

for (const fault of ['lookup failure', 'absent PR', 'branch', 'commit', 'repository', 'base', 'draft', 'PR number', 'merged', 'target', 'remote branch',
  'tree', 'workspace', 'review packet', 'review result', 'review receipt', 'review history', 'corrupt history', 'operation', 'missing operation',
  'uncertain operation', 'extra operation', 'authorization', 'missing authorization', 'input binding', 'deadline', 'owner', 'validation', 'correction', 'after deadline', 'unconfirmed publication', 'unconfirmed push'])
test(`terminal publication recovery requires attention and never replays: ${fault}`, async context => {
  const value = await completedPublication(context, { beforeCompletion: fault === 'unconfirmed publication', afterPush: fault === 'unconfirmed push' });
  const { task, controller: original, publisher } = value;
  const file = path.join(original.workspaceRoot, task.id, task.reviewer.packet_directory, 'evidence.json');
  if (fault === 'lookup failure') publisher.findPR = async () => { throw Error('private token=secret /private/path'); };
  if (fault === 'absent PR') publisher.pr = null;
  if (fault === 'branch') publisher.pr.head.ref = 'other';
  if (fault === 'commit') publisher.pr.head.sha = value.baseline;
  if (fault === 'repository') publisher.pr.head.repo.full_name = 'fixture/other';
  if (fault === 'base') publisher.pr.base.ref = 'other';
  if (fault === 'draft') publisher.pr.draft = false;
  if (fault === 'PR number') publisher.pr.number++;
  if (fault === 'merged') publisher.pr.merged_at = new Date().toISOString();
  if (fault === 'target') publisher.target = async () => ({ ...task.publication.target, base: 'other' });
  if (fault === 'remote branch') publisher.remote = value.baseline;
  if (fault === 'tree') task.publication.commit_sha = value.baseline;
  if (fault === 'workspace') await fs.writeFile(path.join(original.workspaceRoot, task.id, 'repo/greeting.txt'), 'changed\n');
  if (fault === 'review packet') { await fs.chmod(file, 0o600); await fs.writeFile(file, '{}'); }
  if (fault === 'review result') task.reviewer.review_result.findings[0].evidence = 'corrupted';
  if (fault === 'review receipt') delete task.reviewer.received_review_output;
  if (fault === 'review history') original.db.prepare("DELETE FROM automatic_attempts WHERE task_id=? AND json_extract(value,'$.kind')='review_result'").run(task.id);
  if (fault === 'corrupt history') original.db.prepare("UPDATE automatic_attempts SET value='{}' WHERE task_id=?").run(task.id);
  if (fault === 'operation') original.db.prepare("UPDATE operations SET fingerprint='corrupted' WHERE id=?").run(task.automatic.publish_request_id);
  if (fault === 'missing operation') original.db.prepare('DELETE FROM operations WHERE id=?').run(task.automatic.review_request_id);
  if (fault === 'uncertain operation') original.opDone(task.automatic.publish_request_id, 'uncertain');
  if (fault === 'extra operation') original.operation('unexpected_operation', 'continue', {}, task.id);
  if (fault === 'authorization') task.automatic.authorization.publish.draft = false;
  if (fault === 'missing authorization') delete task.automatic.authorization;
  if (fault === 'input binding') task.publication.input_sha256 = 'corrupted';
  if (fault === 'deadline') { task.deadline += 1000; task.automatic.deadline = task.deadline; }
  if (fault === 'owner') task.automatic.owner_instance = 'another-owner';
  if (fault === 'validation') { task.local_validation.status = 'running'; task.local_validation.termination_confirmed = false; }
  if (fault === 'correction') task.automatic.corrective_publication = {};
  if (fault === 'after deadline') {
    task.publication.completed_at = new Date(task.deadline + 1).toISOString();
    context.mock.method(Date, 'now', () => task.deadline + 1000);
  }
  original.db.prepare('UPDATE tasks SET value=? WHERE id=?').run(JSON.stringify(task), task.id);
  interruptController(original);
  for (let restart = 0; restart < 2; restart++) {
    const c = await new Controller(value.config).init();
    try {
      const view = await c.get(task.id), ledger = recoveryLedger(c);
      assert.equal(view.automatic.status, 'uncertain'); assert.equal(view.automatic.human_attention_required, true);
      assert.equal(view.automatic.reconciliation.confirmed, false);
      assert(!JSON.stringify(view.automatic.reconciliation).includes('/private/path'));
      assert.equal(c.task(task.id).deadline, task.deadline);
      await c.get(task.id); assert.equal(recoveryLedger(c), ledger);
      await assert.rejects(c.continue({ task_id: task.id, request_id: 'no_replay', instruction: 'Retry' }), /AUTOMATIC_TASK_OWNS_TRANSITIONS/);
      assert.equal(c.automaticJobs.size, 0); assert.equal(c.validationRuns.size, 0); assert.equal(c.localRuns.size, 0);
    } finally { interruptController(c); }
  }
  assert.equal(value.instances.length, 2); assert.equal(value.validations(), 1);
  assert.equal(value.counts.pushes, 1); assert.equal(value.counts.creates, fault === 'unconfirmed push' ? 0 : 1);
});

for (const effect of ['ABORT', 'IGNORE']) for (const boundary of ['task', 'operation', 'outcome'])
test(`terminal publication recovery detects SQLite ${effect} at final ${boundary} bookkeeping`, async context => {
  const value = await completedPublication(context, { pendingOperation: true }), { task } = value;
  interruptController(value.controller);
  const c = new Controller(value.config), db = new DatabaseSync(path.join(c.stateRoot, 'controller.sqlite'));
  const [table, event, condition] = boundary === 'task' ? ['tasks', 'INSERT', "json_extract(NEW.value,'$.automatic.status')='succeeded'"] :
    boundary === 'operation' ? ['operations', 'UPDATE', "NEW.id LIKE 'automatic_publish_%' AND NEW.status='accepted'"] :
    ['automatic_attempts', 'INSERT', "json_extract(NEW.value,'$.outcome')='succeeded'"];
  db.exec(`CREATE TRIGGER terminal_recovery_fault BEFORE ${event} ON ${table} WHEN ${condition} BEGIN SELECT RAISE(${effect}${effect === 'ABORT' ? ", 'synthetic storage failure'" : ''}); END;`);
  db.close();
  await c.init();
  try {
    const status = await c.get(task.id);
    assert.equal(status.automatic.status, 'uncertain'); assert.equal(status.automatic.human_attention_required, true);
    assert.equal(status.automatic.reconciliation.confirmed, false);
    assert.equal(c.task(task.id).automatic.status, 'uncertain');
    assert.equal(c.db.prepare('SELECT status FROM operations WHERE id=?').get(task.automatic.publish_request_id).status, 'pending');
    assert.equal(c.db.prepare("SELECT count(*) AS n FROM automatic_attempts WHERE task_id=? AND json_extract(value,'$.outcome')='succeeded'").get(task.id).n, 0);
    assert.equal(value.instances.length, 2); assert.equal(value.validations(), 1); assert.equal(value.counts.pushes, 1); assert.equal(value.counts.creates, 1);
    c.db.exec('DROP TRIGGER terminal_recovery_fault');
  } finally { interruptController(c); }
});

test('terminal publication recovery may record completion after expiry only with proof of timely publication', async context => {
  const value = await completedPublication(context), { task } = value;
  interruptController(value.controller);
  context.mock.method(Date, 'now', () => task.deadline + 1000);
  const c = await new Controller(value.config).init();
  try {
    assert.equal(c.task(task.id).automatic.status, 'succeeded'); assert.equal(c.task(task.id).deadline, task.deadline);
    await c.expire(); assert.equal(c.task(task.id).cleanup, undefined);
    assert.equal(value.instances.length, 2); assert.equal(value.validations(), 1); assert.equal(value.counts.pushes, 1); assert.equal(value.counts.creates, 1);
  } finally { interruptController(c); }
});

// Pure SQLite classification checks also run where filesystem integration is
// unavailable. They do not replace the real packet/Git/session tests above.
for (const state of ['pending', 'expired', 'stopped', 'missing proof', 'write loss', 'manual', 'agents api'])
test(`durable recovery classification persists without execution: ${state}`, async context => {
  const effects = [], c = new Controller({ executor: new FakeExecutor(), localBackendFactory() { effects.push('model'); },
    localValidationFactory() { effects.push('validation'); }, publisher: Object.fromEntries(['target', 'remoteHead', 'findPR', 'push', 'createPR']
      .map(name => [name, () => { effects.push(name); throw Error('External operation forbidden'); }])) });
  c.db = new DatabaseSync(':memory:');
  c.db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY,value TEXT); CREATE TABLE operations (id TEXT PRIMARY KEY,fingerprint TEXT,task_id TEXT,status TEXT); CREATE TABLE automatic_attempts (task_id TEXT,attempt_id TEXT,observation_sha256 TEXT,value TEXT,PRIMARY KEY(task_id,attempt_id,observation_sha256)); CREATE TABLE audit (id TEXT,created INTEGER,value TEXT);');
  context.after(() => { c.dbClosed = true; c.db.close(); });
  const created = Date.now(), id = 'task_00000000-0000-0000-0000-000000000001', authorization = automaticAuthority();
  const t = { id, execution_backend: 'local_codex', created, deadline: created + 120000, baseline: 'a'.repeat(40), request_id: 'original',
    implementer: { state: 'completed', local: { turn_submission_attempted: true, human_requests: [] } },
    automatic: { status: state === 'stopped' ? 'stopped' : 'progressing', reason: state === 'stopped' ? 'AUTOMATIC_CANCELLED' : null,
      phase: 'implementation', authorization, contract_binding: { sha256: digest(contract()), contract: contract() },
      owner_instance: 'previous-owner', deadline: created + 120000, review_request_id: 'review-original', publish_request_id: 'publish-original' } };
  if (state === 'expired') t.deadline = t.automatic.deadline = created - 1;
  if (state === 'missing proof') { t.automatic.phase = 'publication'; t.publication = { phase: 'complete' }; }
  if (['manual', 'agents api'].includes(state)) { delete t.automatic; if (state === 'agents api') t.execution_backend = 'agents_api'; }
  c.db.prepare('INSERT INTO tasks VALUES (?,?)').run(id, JSON.stringify(t));
  if (state === 'write loss') c.db.exec('CREATE TEMP TRIGGER lost_recovery BEFORE INSERT ON tasks BEGIN SELECT RAISE(IGNORE); END;');
  await c.reconcileAutomaticPublication(id);
  const saved = c.task(id);
  if (['manual', 'agents api'].includes(state)) { assert.deepEqual(saved, t); assert.deepEqual(effects, []); return; }
  if (state === 'write loss') { assert(c.persistenceFailures.has(id)); assert.equal(saved.automatic.status, 'progressing'); }
  else {
    assert.equal(saved.automatic.reconciliation.outcome, { pending: 'external_effects_uncertain', expired: 'expired', stopped: 'stopped', 'missing proof': 'evidence_unconfirmed' }[state]);
    assert.equal(saved.automatic.reconciliation.confirmed, false);
    assert.equal(saved.automatic.status, state === 'stopped' ? 'stopped' : 'uncertain');
    assert.equal(saved.deadline, t.deadline); assert.equal(saved.automatic.owner_instance, 'previous-owner');
  }
  const status = await c.get(id);
  assert.equal(status.automatic.status, state === 'stopped' ? 'stopped' : 'uncertain');
  assert.equal(status.automatic.reconciliation.confirmed, false);
  assert.equal(status.automatic.human_attention_required, state === 'stopped' ? saved.automatic.human_attention_required : true);
  assert.deepEqual(effects, []); assert.equal(c.localRuns.size, 0); assert.equal(c.validationRuns.size, 0); assert.equal(c.automaticJobs.size, 0);
});


// Exercise the persistence boundary without Controller.init or task execution.
// Qualification is stubbed here only to isolate the two-connection write race;
// the real qualified-workflow counterpart below retains every publication gate.
for (const conflict of ['confirmed', 'unresolved', 'operation mismatch', 'missing outcome'])
test(`recovery fallback snapshot race preserves durable ${conflict}`, async context => {
  const root = await fs.mkdtemp('/tmp/pab-recovery-sqlite-'), file = path.join(root, 'controller.sqlite'), effects = [];
  const config = { executor: new FakeExecutor(), localBackendFactory() { effects.push('model'); }, localValidationFactory() { effects.push('validation'); },
    publisher: Object.fromEntries(['target', 'remoteHead', 'findPR', 'push', 'createPR'].map(name => [name, () => { effects.push(name); throw Error('Unexpected external effect'); }])) };
  const first = new Controller(config), second = new Controller(config);
  first.db = new DatabaseSync(file);
  first.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE tasks (id TEXT PRIMARY KEY,value TEXT); CREATE TABLE operations (id TEXT PRIMARY KEY,fingerprint TEXT,task_id TEXT,status TEXT); CREATE TABLE automatic_attempts (task_id TEXT,attempt_id TEXT,observation_sha256 TEXT,value TEXT,PRIMARY KEY(task_id,attempt_id,observation_sha256)); CREATE TABLE audit (id TEXT,created INTEGER,value TEXT);');
  second.db = new DatabaseSync(file);
  context.after(async () => { for (const c of [first, second]) { c.dbClosed = true; c.db.close(); } await fs.rm(root, { recursive: true, force: true }); });
  const created = Date.now(), id = 'task_00000000-0000-0000-0000-000000000002';
  const task = { id, execution_backend: 'local_codex', created, deadline: created + 120000, baseline: 'a'.repeat(40), request_id: 'start-original',
    publication: { phase: 'complete' }, implementer: { state: 'completed', local: { human_requests: [], turn_submission_attempted: true } },
    automatic: { status: 'progressing', phase: 'publication', reason: null, human_attention_required: false,
      authorization: automaticAuthority(), contract_binding: { sha256: digest(contract()), contract: contract() },
      deadline: created + 120000, owner_instance: 'original-owner', review_request_id: 'review-original', publish_request_id: 'publish-original' } };
  first.db.prepare('INSERT INTO tasks VALUES (?,?)').run(id, JSON.stringify(task));
  for (const [operation, status] of [[task.request_id, 'accepted'], [task.automatic.review_request_id, 'accepted'], [task.automatic.publish_request_id, 'pending']]) {
    first.db.prepare('INSERT INTO operations VALUES (?,?,?,?)').run(operation, digest(operation), id, status);
  }
  const ledger = c => JSON.stringify(c.db.prepare('SELECT * FROM operations WHERE task_id=? ORDER BY id').all(id));
  for (const c of [first, second]) c.verifyCompletedAutomaticPublication = async current => {
    if (current.publication_error) throw Error('Unresolved proof');
    return ledger(c);
  };
  const qualifiedOperations = await second.verifyCompletedAutomaticPublication(second.task(id));
  const save = first.save.bind(first); let failed = false, interleaved = false, candidate, committed;
  first.save = (value, options) => {
    if (!failed && value.automatic.reconciliation?.confirmed) { failed = true; candidate = structuredClone(value); throw Error('Synthetic initial persistence failure'); }
    if (!interleaved && value.automatic.reason === 'AUTOMATIC_EVIDENCE_PERSISTENCE_UNCONFIRMED') {
      interleaved = true;
      assert.equal(second.task(id).automatic.status, 'progressing'); // A has already read its nonterminal fallback snapshot.
      const replacement = structuredClone(candidate);
      if (conflict === 'unresolved') {
        replacement.publication_error = 'CONCURRENT_PROOF_UNCONFIRMED';
        Object.assign(replacement.automatic, { status: 'uncertain', reason: 'CONCURRENT_PROOF_UNCONFIRMED', human_attention_required: true });
        Object.assign(replacement.automatic.reconciliation, { outcome: 'evidence_unconfirmed', confirmed: false, reason: 'CONCURRENT_PROOF_UNCONFIRMED' });
      }
      second.save(replacement, { expectedTask: JSON.stringify(task), expectedOperations: qualifiedOperations,
        ...(conflict === 'operation mismatch' ? {} : { operation: { id: task.automatic.publish_request_id, status: conflict === 'unresolved' ? 'uncertain' : 'accepted' } }) });
      if (conflict === 'missing outcome') second.db.prepare("DELETE FROM automatic_attempts WHERE task_id=? AND json_extract(value,'$.outcome')='succeeded'").run(id);
      committed = second.db.prepare('SELECT value FROM tasks WHERE id=?').get(id).value;
    }
    return save(value, options);
  };
  await first.reconcileAutomaticPublication(id);
  assert(failed); assert(interleaved);
  assert.equal(first.db.prepare('SELECT value FROM tasks WHERE id=?').get(id).value, committed);
  assert.equal(first.db.prepare('SELECT status FROM operations WHERE id=?').get(task.automatic.publish_request_id).status,
    conflict === 'unresolved' ? 'uncertain' : conflict === 'operation mismatch' ? 'pending' : 'accepted');
  assert.equal(first.db.prepare("SELECT count(*) AS n FROM automatic_attempts WHERE task_id=? AND json_extract(value,'$.outcome')='succeeded'").get(id).n,
    ['unresolved', 'missing outcome'].includes(conflict) ? 0 : 1);
  const status = await first.get(id);
  assert.equal(status.automatic.status, conflict === 'confirmed' ? 'succeeded' : 'uncertain');
  assert.equal(status.automatic.reconciliation.confirmed, conflict === 'confirmed');
  assert.equal(first.persistenceFailures.has(id), conflict !== 'confirmed');
  const snapshot = () => JSON.stringify(['tasks', 'operations', 'automatic_attempts', 'audit'].map(table => first.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  const before = snapshot();
  for (let repeat = 0; repeat < 2; repeat++) await first.reconcileAutomaticPublication(id);
  if (conflict === 'confirmed') assert.equal(snapshot(), before);
  assert.equal((await first.get(id)).automatic.status, conflict === 'confirmed' ? 'succeeded' : 'uncertain');
  assert.deepEqual(effects, []); assert.equal(first.automaticJobs.size, 0); assert.equal(second.automaticJobs.size, 0);
});

test('qualified recovery fallback snapshot race preserves second Controller terminal success', async context => {
  const value = await completedPublication(context, { pendingOperation: true }), { task } = value;
  interruptController(value.controller);
  const first = new Controller(value.config), second = new Controller(value.config);
  second.db = new DatabaseSync(path.join(second.stateRoot, 'controller.sqlite'));
  const qualifiedOperations = await second.verifyCompletedAutomaticPublication(second.task(task.id));
  const save = first.save.bind(first); let failed = false, interleaved = false, candidate;
  first.save = (current, options) => {
    if (!failed && current.automatic.reconciliation?.confirmed) { failed = true; candidate = structuredClone(current); throw Error('Synthetic initial persistence failure'); }
    if (!interleaved && current.automatic.reason === 'AUTOMATIC_EVIDENCE_PERSISTENCE_UNCONFIRMED') {
      interleaved = true;
      assert.equal(second.task(task.id).automatic.status, 'progressing');
      second.save(candidate, { expectedTask: JSON.stringify(task), expectedOperations: qualifiedOperations,
        operation: { id: task.automatic.publish_request_id, status: 'accepted' } });
    }
    return save(current, options);
  };
  try {
    await first.init(); assert(failed); assert(interleaved);
    const before = recoveryLedger(first);
    for (const c of [first, second]) {
      assert.equal(c.task(task.id).automatic.status, 'succeeded');
      assert.equal(c.db.prepare('SELECT status FROM operations WHERE id=?').get(task.automatic.publish_request_id).status, 'accepted');
      assert.equal(c.db.prepare("SELECT count(*) AS n FROM automatic_attempts WHERE task_id=? AND json_extract(value,'$.outcome')='succeeded'").get(task.id).n, 1);
      await c.reconcileAutomaticPublication(task.id); await c.reconcileAutomaticPublication(task.id);
      assert.equal((await c.get(task.id)).automatic.reconciliation.confirmed, true);
    }
    assert.equal(recoveryLedger(first), before);
    assert.equal(value.instances.length, 2); assert.equal(value.validations(), 1); assert.equal(value.counts.pushes, 1); assert.equal(value.counts.creates, 1);
  } finally { for (const c of [first, second]) if (c.db && !c.dbClosed) interruptController(c); }
});
