import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Controller } from '../controller.mjs';
import { FakeAPI, FakeExecutor } from './helpers.mjs';

async function setup(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'pab-discovery-'));
  const api = new FakeAPI(), executor = new FakeExecutor();
  const controller = await new Controller({
    stateRoot: path.join(root, 'state'), workspaceRoot: path.join(root, 'work'),
    api, executor, secrets: ['PRIVATE_VALUE'], timeoutMs: 600000,
  }).init();
  t.after(async () => { await controller.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { controller, api };
}

const taskId = () => `task_${randomUUID()}`;
const record = (created, more = {}) => ({
  id: taskId(), created, deadline: created + 600000, cleaned: true,
  execution_backend: 'agents_api', implementer: { state: 'completed' }, ...more,
});

test('listTasks returns bounded stored summaries with active records first and no sensitive execution details', async t => {
  const { controller: c, api } = await setup(t);
  assert.deepEqual(await c.listTasks(), { tasks: [], truncated: false });
  const now = Date.now();
  for (let i = 0; i < 60; i++) c.save(record(now + i));
  const active = record(now - 1000, {
    cleaned: false, execution_backend: 'agents_api',
    implementer: { state: 'needs_attention', session_id: 'PRIVATE_VALUE', local: { human_attention_required: true } },
    repository: { repository_id: 'github_123', canonical_path: '/private/worktree' },
    reviewer: { state: 'waiting_for_clarification' },
    contract: { goal: 'PRIVATE_VALUE' },
  });
  c.save(active);
  const snapshot = await c.listTasks();
  assert.equal(snapshot.tasks.length, 50);
  assert.equal(snapshot.truncated, true);
  assert.deepEqual(snapshot.tasks[0], {
    task_id: active.id, execution_backend: 'agents_api', state: 'needs_attention',
    reviewer_state: 'waiting_for_clarification', repository_id: 'github_123',
    created_at: new Date(active.created).toISOString(),
    expires_at: new Date(active.deadline).toISOString(),
    human_attention_required: true,
  });
  assert.equal(snapshot.tasks[1].created_at, new Date(now + 59).toISOString());
  assert(!JSON.stringify(snapshot).includes('PRIVATE_VALUE'));
  assert(!JSON.stringify(snapshot).includes('/private/worktree'));
  assert.equal(api.created.length, 0);
  assert.equal(api.sent.length, 0);
  assert.equal(api.streamCount, 0);
  active.cleaned = true;
  c.save(active); // Avoid task shutdown operations for synthetic records.
});

test('listTasks reads persisted state across controller restart without claiming runtime reconciliation', async t => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'pab-discovery-restart-'));
  let after;
  t.after(async () => { if (after) await after.close(); await fs.rm(root, { recursive: true, force: true }); });
  const stateRoot = path.join(root, 'state'), workspaceRoot = path.join(root, 'work');
  const options = { stateRoot, workspaceRoot, api: new FakeAPI(), executor: new FakeExecutor(), timeoutMs: 600000 };
  const before = await new Controller(options).init();
  const original = record(Date.now(), { execution_backend: 'local_codex', reviewer: { state: 'completed' } });
  before.save(original);
  await before.close();
  after = await new Controller(options).init();
  const found = await after.listTasks();
  assert.equal(found.tasks.length, 1);
  assert.equal(found.tasks[0].task_id, original.id);
  assert.equal(found.tasks[0].execution_backend, 'local_codex');
  assert.equal(found.tasks[0].state, 'cleaned');
  assert.equal(found.tasks[0].reviewer_state, 'completed');
  assert.equal(found.tasks[0].human_attention_required, false);
});
