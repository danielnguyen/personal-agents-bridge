import { randomUUID, createHash } from 'node:crypto';
export const contract = () => ({ goal: 'Write a greeting after asking the user which name to use.', allowed_files: ['greeting.txt'], requirements: [{ id: 'R1', text: 'Use request_clarification to ask for a name before writing the greeting.' }, { id: 'R2', text: 'Write exactly Hello, <name>! followed by a newline to greeting.txt.' }], invariants: [{ id: 'I1', text: 'Leave TASK.md and Git state unchanged.' }], initial_files: {}, test_commands: [] });
export class FakeAPI {
  constructor() {
    this.rows = new Map(); this.created = []; this.sent = []; this.deleted = []; this.streamCount = 0;
    this.events = { stream: async () => { this.streamCount++; let end; const wait = new Promise(r => end = r); return { controller: { abort: () => end() }, async *[Symbol.asyncIterator]() { await wait; } }; }, create: async (id, payload) => { this.sent.push({ id, payload }); const r = this.rows.get(id); if (!r) throw { status: 404 }; if (payload.events[0].type.endsWith('.cancel')) { r.status = 'idle'; r.required_actions = []; r.turns = [{ id: 'turn_cancelled', status: 'cancelled' }]; } else { r.status = 'in_progress'; r.required_actions = []; r.turns = [{ id: `turn_${randomUUID()}`, status: 'in_progress' }]; } } };
    this.turns = { list: async id => ({ data: this.rows.get(id).turns }) };
    this.items = { list: (id, query) => { const items = this.rows.get(id).items; return Object.assign(Promise.resolve({ data: query.order === 'desc' ? [...items].reverse() : items }), { async *[Symbol.asyncIterator]() { yield* items; } }); } };
  }
  async create(body) { const id = `sess_${randomUUID()}`; const r = { id, metadata: body.metadata, status: 'idle', environment: { id: `env_${id}`, status: 'connected', remote_url: 'https://api.openai.com/fake' }, required_actions: [], turns: [], items: [] }; this.rows.set(id, r); this.created.push(body); return r; }
  async retrieve(id) { if (!this.rows.has(id)) throw { status: 404 }; return this.rows.get(id); }
  async delete(id) { this.deleted.push(id); this.rows.delete(id); return { deleted: true }; }
  async *list() { yield* this.rows.values(); }
  pending(id) { const r = this.rows.get(id); r.status = 'requires_action'; r.required_actions = [{ type: 'function_call', name: 'request_clarification', turn_id: r.turns[0].id, call_id: 'call_question', arguments: { question: 'Which name?' } }]; }
  completed(id, text = 'Done') { const r = this.rows.get(id); r.status = 'idle'; r.required_actions = []; r.turns[0].status = 'completed'; r.items.push({ type: 'message', role: 'assistant', turn_id: r.turns[0].id, content: [{ type: 'output_text', text }] }); }
}
// Synthetic startup evidence for controller tests; real enforcement is tested separately.
export function fakeSandboxEvidence(workspace, runtime) {
  return { provenance: 'controller', wrapper: 'codex sandbox RPC boundary', profile: 'bridge_task',
    policy_sha256: createHash('sha256').update('synthetic-test-policy').digest('hex'), initialized: true,
    command_network_access: false, filesystem_rpc_sandboxed: true,
    policy: { filesystem: { '/': 'read', [workspace]: 'write', [runtime + '/sandbox-fixture/scratch']: 'write',
      [workspace + '/.git']: 'read', [workspace + '/TASK.md']: 'read', [workspace + '/.codex']: 'read' }, network: { enabled: false } },
    preflight: { scratch_write: true, outside_create_denied: true, outside_truncate_denied: true, inet_inet6_unix_connect_denied: true } };
}
export class FakeExecutor { constructor() { this.started = []; this.stopped = []; } async start(...args) { this.started.push(args); return { pid: 2147483647, identity: 'fake', ...(args[0].repository_task ? { isolation_evidence: fakeSandboxEvidence(args[1], args[2]) } : {}) }; } async stop(owner) { this.stopped.push(owner); return true; } }
