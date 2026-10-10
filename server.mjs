import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Controller, BridgeError } from './controller.mjs';

const requestId = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/);
const taskId = z.string().regex(/^task_[a-f0-9-]{36}$/);
const humanResponse = z.object({ request_ref: z.string().uuid(), thread_id: z.string().min(1).max(200), turn_id: z.string().min(1).max(200),
  decision: z.enum(['accept', 'decline', 'cancel']).optional(),
  answers: z.record(z.object({ answers: z.array(z.string().min(1).max(4000)).min(1).max(10) }).strict()).optional(),
}).strict().refine(value => (value.decision !== undefined) !== (value.answers !== undefined), 'Provide one explicit decision or exact question-ID answers');
const requirement = z.object({ id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/), text: z.string().min(1).max(4000) }).strict();
export const contractSchema = z.object({
  goal: z.string().min(1).max(8000),
  allowed_files: z.array(z.string().min(1).max(200)).min(1).max(30),
  requirements: z.array(requirement).min(1).max(30),
  invariants: z.array(requirement).max(20).default([]),
  test_commands: z.array(z.string().min(1).max(1000)).max(10).default([]),
  initial_files: z.record(z.string().max(32000)).default({}),
}).strict().refine(c => Buffer.byteLength(JSON.stringify(c)) <= 64000 && Object.keys(c.initial_files).length <= 30, 'Contract/seed files exceed limits');

// Personal-only operator confirmation plus live association metadata on every call.
// This verifies tunnel scope, NOT individual ChatGPT user identity or OAuth.
export async function fetchTunnelMetadata(tunnelId, stateRoot) {
  const key = process.env.CONTROL_PLANE_API_KEY || process.env.OPENAI_API_KEY;
  if (!key) throw new BridgeError('TUNNEL_RUNTIME_CREDENTIAL_MISSING');
  try {
    const { stdout } = await promisify(execFile)(path.join(stateRoot, 'tunnel-client/tunnel-client'), ['admin', '--json', 'tunnels', 'get', tunnelId], {
      timeout: 15000, maxBuffer: 65536, env: { PATH: '/usr/bin:/bin', CONTROL_PLANE_API_KEY: key },
    });
    return JSON.parse(stdout);
  } catch { throw new BridgeError('LIVE_TUNNEL_ASSOCIATION_UNAVAILABLE'); }
}
export async function authorizePersonalTunnel({ stateRoot = `${homedir()}/.local/state/personal-agents-bridge`, expectedTunnel = process.env.BRIDGE_TUNNEL_ID, now = Date.now(), lookup = fetchTunnelMetadata } = {}) {
  if (!expectedTunnel || !/^tunnel_[A-Za-z0-9_-]+$/.test(expectedTunnel)) throw new BridgeError('PERSONAL_TUNNEL_NOT_CONFIGURED');
  const file = path.join(stateRoot, 'personal-tunnel.json');
  let stat, value;
  try { stat = await fs.lstat(file); value = JSON.parse(await fs.readFile(file, 'utf8')); } catch { throw new BridgeError('PERSONAL_ASSOCIATION_NOT_VERIFIED'); }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new BridgeError('UNSAFE_TUNNEL_CONFIRMATION');
  const verified = Date.parse(value.verified_at); const expires = Date.parse(value.expires_at);
  if (value.tunnel_id !== expectedTunnel || value.personal_only !== true || value.sole_authorized_user !== true || value.verification_method !== 'owner_checked_platform_settings' || typeof value.platform_organization_id !== 'string' || !value.platform_organization_id || typeof value.chatgpt_workspace_id !== 'string' || !value.chatgpt_workspace_id || !Array.isArray(value.associated_organizations) || !Array.isArray(value.associated_workspaces) || value.associated_organizations.length !== 1 || value.associated_workspaces.length !== 1 || value.associated_organizations[0] !== value.platform_organization_id || value.associated_workspaces[0] !== value.chatgpt_workspace_id || !Number.isFinite(verified) || !Number.isFinite(expires) || verified > now || expires <= now || expires - verified > 86400000) throw new BridgeError('PERSONAL_ASSOCIATION_UNVERIFIED_OR_EXPIRED');
  const live = await lookup(expectedTunnel, stateRoot);
  if (live.id !== expectedTunnel || !Array.isArray(live.organization_ids) || !Array.isArray(live.workspace_ids) || live.organization_ids.length !== 1 || live.workspace_ids.length !== 1 || live.organization_ids[0] !== value.platform_organization_id || live.workspace_ids[0] !== value.chatgpt_workspace_id) throw new BridgeError('LIVE_TUNNEL_ASSOCIATION_MISMATCH');
  return { tunnel_id: value.tunnel_id };
}
export function createServer(controller, authorize = authorizePersonalTunnel) {
  const server = new McpServer({ name: 'personal-agents-bridge', version: '0.1.0' }, { instructions: 'Personal single-owner task execution. Explain execution/API costs before start_task, continue_task or review_task; cleanup_task deletes remote sessions and may delete local work when explicitly requested. Reuse returned task IDs. Agents API is the default. Local Codex is explicit opt-in for allowlisted repositories and consumes subscription allowance. For pending local human requests, show the sanitized question/approval description and obtain an explicit human response; send human_response through continue_task with the exact request_ref, thread_id and turn_id. Never infer approval from prose or invent answers. No local post-completion continuation, review or publication. For Agents API tasks, when clarification_required is true, ask the user and send the answer as instruction with continue_task. publish_task publishes only a completed, independently PASS-reviewed Agents API repository tree as a draft PR through the trusted controller; it never gives agents push access. Never send credentials. Existing repositories require an allowlisted logical repository_id; implementation always uses an isolated task worktree.' });
  function register(name, description, inputSchema, handler, { readOnly = false, destructive = false, external = false, outputSchema } = {}) {
    server.registerTool(name, { title: name.replaceAll('_', ' '), description, inputSchema: ['start_task', 'publish_task'].includes(name) ? z.object(inputSchema).strict() : inputSchema, outputSchema: outputSchema || { task_id: z.string(), execution_backend: z.enum(['agents_api', 'local_codex']).optional(), state: z.string(), implementer: z.any().nullable(), reviewer: z.any().nullable(), cleanup: z.any().nullable(), expires_at: z.string(), repository: z.any().optional(), publication: z.any().optional(), review_packet_diagnostic: z.any().optional() }, annotations: { readOnlyHint: readOnly, destructiveHint: destructive, openWorldHint: external, idempotentHint: true } }, async (input, extra) => {
      try { await authorize(); const result = await controller.invoke(name, input, extra, handler); return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] }; }
      catch (error) { const code = error instanceof BridgeError ? error.code : 'OPERATION_FAILED_CHECK_TASK_STATE'; return { isError: true, content: [{ type: 'text', text: error instanceof BridgeError && error.diagnostic ? JSON.stringify({ error: code, diagnostic: error.diagnostic }) : code }] }; }
    });
  }
  register('start_task', 'Execute an authorized contract. execution_backend defaults to agents_api (paid Agents API session and local executor). Explicit local_codex uses existing ChatGPT Codex authentication and requires an allowlisted repository_id; continuation only delivers pending native human responses, not new turns. Local review and publication are unsupported. repository_id and optional base_ref create an isolated task worktree; no arbitrary paths or normal-checkout edits. Tasks expire after 15 minutes; files remain unless explicitly deleted. Reuse request_id only for identical input, including backend selection.', { contract: contractSchema, request_id: requestId, execution_backend: z.enum(['agents_api', 'local_codex']).optional(), repository_id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/).optional(), base_ref: z.string().min(1).max(200).optional() }, x => controller.start(x));
  register('get_task', 'Use this to read current task progress, latest assistant output, session/turn IDs, pending human clarification, and reviewer findings. Does not execute new work.', { task_id: taskId }, x => controller.get(x.task_id), { readOnly: true });
  register('continue_task', 'Agents API: send instruction to resume the SAME session. Local Codex: send human_response only for a live pending native request in the SAME turn; copy request_ref/thread_id/turn_id from get_task. Approvals require explicit accept/decline/cancel; clarification answers map exact question IDs to {answers:[strings]}. Never infer approval or invent answers. Request_id deduplicates delivery; uncertain replies are never resent. No local post-completion new turn.', { task_id: taskId, instruction: z.string().min(1).max(16000).optional(), human_response: humanResponse.optional(), request_id: requestId }, x => controller.continue(x));
  register('review_task', 'Use this when the user authorizes an independent paid review of a finished task. Freezes implementation, starts a separate reviewer with a read-only bounded evidence packet, and returns progress or requirement findings. Use get_task for completion.', { task_id: taskId, request_id: requestId }, x => controller.review(x));
  register('cleanup_task', 'Use this when the user authorizes stopping this task and deleting its remote sessions. Cancels work and stops owned executors. delete_workspace=true also permanently deletes this task workspace; default retains files. Never affects other tasks or the tunnel.', { task_id: taskId, delete_workspace: z.boolean().default(false) }, x => controller.cleanup(x), { destructive: true });
  register('publish_task', 'Publish the exact frozen Git tree of a completed repository task with an independent PASS review as a draft GitHub PR. Stops owned executors and permanently freezes implementation for this task. Creates a controller-authored commit in the existing task Git store and pushes only its fixed task branch, never force-pushing, updating the default branch, or merging. Rejects changed worktrees, missing review, unexpected remote refs and uncertain PR outcomes. Repeating identical input reconciles saved publication state. No arbitrary paths, branch names or Git commands are accepted.', { task_id: taskId, title: z.string().min(1).max(200).regex(/^[^\x00-\x1f]+$/), body: z.string().max(16000).optional(), draft: z.literal(true).default(true) }, x => controller.publish(x), { external: true, outputSchema: {
    task_id: z.string(), reviewed_tree_sha: z.string(), commit_sha: z.string(), pushed_branch: z.string(), pr_number: z.number().int().positive(), pr_url: z.string().url(), commit_tree_matches_reviewed_tree: z.literal(true), draft: z.literal(true)
  } });
  return server;
}
async function main() {
  process.umask(0o077);
  await authorizePersonalTunnel();
  const controller = await new Controller().init();
  const server = createServer(controller);
  let closing = false;
  async function close() { if (closing) return; closing = true; await server.close(); await controller.close(); process.exit(0); }
  process.on('SIGINT', close); process.on('SIGTERM', close); process.stdin.on('end', close);
  await server.connect(new StdioServerTransport());
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { process.stderr.write(`${error instanceof BridgeError ? error.code : 'BRIDGE_START_FAILED'}\n`); process.exitCode = 1; });
