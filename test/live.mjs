// Local MCP verification, NOT ChatGPT/tunnel acceptance. No production gate bypass flag.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Controller } from '../controller.mjs';
import { createServer } from '../server.mjs';

process.umask(0o077);
const state = `${homedir()}/.local/state/personal-agents-bridge`;
const controller = await new Controller({ stateRoot: state }).init();
const server = createServer(controller, async () => {}); // In-process local client only.
const client = new Client({ name: 'bridge-local-live-verifier', version: '1' });
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a); await client.connect(b);
let taskId;
const report = { provenance: 'Local MCP client -> bridge -> real Agents API -> Ubuntu executor. Not ChatGPT or tunnel acceptance.', started_at: new Date().toISOString(), checks: [] };
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
  if (result.isError) throw Error(result.content.map(x => x.text).join('\n'));
  return result.structuredContent;
}
async function until(check, label, limit = 180000) {
  const start = Date.now();
  while (Date.now() - start < limit) {
    const state = await call('get_task', { task_id: taskId });
    if (check(state)) return state;
    if (['needs_attention', 'failed', 'unavailable'].includes(state.implementer?.state) || ['needs_attention', 'failed'].includes(state.reviewer?.state)) throw Error(`Task state: ${JSON.stringify(state)}`);
    await delay(2000);
  }
  throw Error(`Timeout: ${label}`);
}
try {
  const contract = {
    goal: 'Verify the real bridge with intentional human clarification. First run pwd and python3 -B --version in the workspace. Then call request_clarification asking which greeting name to use, and wait. After the answer, implement the file and run the specified test. Do not ask further questions.',
    allowed_files: ['greeting.txt'],
    requirements: [{ id: 'R1', text: 'Before writing greeting.txt, run pwd and python3 -B --version and ask for the missing name using request_clarification.' }, { id: 'R2', text: 'Write exactly Hello, <human-supplied name>! followed by a newline to greeting.txt.' }, { id: 'R3', text: 'Run python3 -B check_greeting.py successfully after writing the file.' }],
    invariants: [{ id: 'I1', text: 'Leave TASK.md, check_greeting.py, Git history and staged state unchanged. Do not commit.' }],
    initial_files: { 'check_greeting.py': 'from pathlib import Path\ns = Path("greeting.txt").read_text()\nassert s.startswith("Hello, ") and s.endswith("!\\n") and len(s.splitlines()) == 1\nprint("greeting check passed")\n' },
    test_commands: ['python3 -B check_greeting.py'],
  };
  const start = await call('start_task', { contract, request_id: `local_start_${Date.now()}` }); taskId = start.task_id;
  console.log(`Local live task ${taskId}`);
  const waiting = await until(x => x.implementer.clarification_required, 'clarification');
  report.task_id = taskId; report.waiting = waiting; report.checks.push('get_task exposes a structured pending clarification');
  console.log('Executor connected; clarification requested');
  const sid = waiting.implementer.session_id;
  const continued = await call('continue_task', { task_id: taskId, instruction: 'Use the name Example.', request_id: `local_continue_${Date.now()}` });
  assert.equal(continued.implementer.session_id, sid);
  const finished = await until(x => x.implementer.state === 'completed', 'completion');
  assert.equal(finished.implementer.session_id, sid);
  const repo = path.join(controller.workspaceRoot, taskId, 'repo');
  assert.equal(await fs.readFile(path.join(repo, 'greeting.txt'), 'utf8'), 'Hello, Example!\n');
  report.finished = finished; report.checks.push('same task and session across clarification', 'actual executor created the expected artifact');
  console.log('Same-session continuation completed; artifact independently checked');
  // Locally exercise review too; first ChatGPT acceptance remains start/get/continue only.
  await call('review_task', { task_id: taskId, request_id: `local_review_${Date.now()}` });
  const reviewed = await until(x => ['completed', 'needs_attention'].includes(x.reviewer?.state), 'review', 240000);
  assert.notEqual(reviewed.reviewer.session_id, sid);
  assert(Array.isArray(reviewed.reviewer.findings));
  report.reviewed = reviewed; report.checks.push('separate read-only reviewer returned requirement-level findings');
  console.log(`Independent reviewer ${reviewed.reviewer.overall}`);
  report.success = true;
} catch (e) {
  report.success = false; report.error = controller.safe(e.message); console.error(report.error);
} finally {
  if (taskId) {
    try { report.cleanup = await call('cleanup_task', { task_id: taskId }); }
    catch (e) { report.cleanup_error = controller.safe(e.message); }
  }
  await client.close(); await server.close(); await controller.close();
  await fs.writeFile(path.join(state, 'local-verification.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
}
if (!report.success || report.cleanup?.state !== 'cleaned') process.exitCode = 1;
