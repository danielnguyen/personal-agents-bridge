// Controller-only bounded metadata. Never store RPC payloads, responses or file bytes.
import { promises as fs, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const MAX_RECORDS = 100, MAX_BYTES = 24576;
const within = (root, p) => p === root || p.startsWith(root + path.sep);
const methods = new Set(['fs/readFile', 'fs/open', 'fs/readBlock', 'fs/close', 'fs/writeFile', 'fs/createDirectory', 'fs/getMetadata', 'fs/canonicalize', 'fs/walk', 'fs/remove', 'fs/copy', 'fs/rename', 'fs/writeBlock']);
function safePath(value) {
  let text = value;
  for (const [key, secret] of Object.entries(process.env)) if (/KEY|TOKEN|SECRET|PASSWORD/i.test(key) && secret.length > 8) text = text.split(secret).join('[REDACTED]');
  return text.replace(/(?:sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/(?:password|secret|token|api[_-]?key)[=:][^/\s]+/gi, '[REDACTED]')
    .replace(/[\x00-\x1f\x7f]/g, '?').slice(0, 200);
}
async function target(value, workspace, scratch, kind) {
  if (typeof value !== 'string') return { kind, classification: 'unknown', path: null };
  try {
    let p = value.startsWith('file:') ? fileURLToPath(value) : value;
    if (!path.isAbsolute(p)) return { kind, classification: 'unknown', path: null };
    p = path.normalize(p);
    // Resolve existing ancestors too, so a not-yet-created target behind a link is outside.
    let ancestor = p, suffix = [];
    while (true) {
      try { p = path.join(await fs.realpath(ancestor), ...suffix); break; }
      catch (e) { if (e.code !== 'ENOENT' || ancestor === path.dirname(ancestor)) throw e; suffix.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor); }
    }
    const classification = within(workspace, p) ? 'worktree' : within(scratch, p) ? 'task_scratch' : 'outside';
    const rel = classification === 'outside' ? null : path.relative(classification === 'worktree' ? workspace : scratch, p) || '.';
    return { kind, classification, path: rel === null ? null : safePath(rel), path_redacted_or_truncated: rel !== null && safePath(rel) !== rel };
  } catch { return { kind, classification: 'unknown', path: null }; }
}
export function createFileRpcJournal(control, workspace, scratch) {
  const file = path.join(control, 'file-rpc.json');
  const state = { version: 1, provenance: 'controller_file_rpc_dispatch', instance_id: randomUUID(), initialized: true, closed: false, started_at: new Date().toISOString(), observed: 0, omitted: 0, records: [] };
  function persist() {
    const tmp = file + '.tmp'; const fd = openSync(tmp, 'w', 0o600);
    try { writeFileSync(fd, JSON.stringify(state)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, file);
  }
  persist();
  let queue = Promise.resolve();
  return {
    file,
    // Serialize RPC dispatch as well as metadata capture; order is unambiguous.
    run(method, params, execute) {
      const next = queue.then(async () => {
        if (state.closed) throw Error('FILE_RPC_JOURNAL_CLOSED');
        const sequence = ++state.observed;
        const targets = await Promise.all((['fs/copy', 'fs/rename'].includes(method) ? [['source', params?.sourcePath], ['destination', params?.destinationPath]] : [['target', params?.path]]).map(([kind, value]) => target(value, workspace, scratch, kind)));
        const record = { operation_id: `${state.instance_id}:${sequence}`, sequence, method: methods.has(method) ? method : 'fs/unsupported', targets,
          started_at: new Date().toISOString(), finished_at: null, outcome: 'pending', success: null };
        if (!state.omitted && state.records.length < MAX_RECORDS && Buffer.byteLength(JSON.stringify([...state.records, record])) < MAX_BYTES - 256) state.records.push(record);
        else state.omitted++;
        persist(); // Failure here prevents dispatch; a crash leaves pending evidence.
        try {
          const response = await execute();
          record.success = !response?.error;
          record.outcome = response?.error ? (/permission|denied|read.only|not permitted|disabled/i.test(response.error.message || '') ? 'denied' : 'failed') : 'succeeded';
          return response;
        } catch { record.success = false; record.outcome = 'unknown'; throw Error('FILE_RPC_OUTCOME_UNKNOWN'); }
        finally { record.finished_at = new Date().toISOString(); persist(); }
      });
      queue = next.catch(() => {}); return next;
    },
    async close() { await queue; state.closed = true; persist(); }
  };
}

export async function captureFileRpcEvidence(task, workspaceRoot) {
  if (task.cleaned && task.file_rpc_evidence) return task.file_rpc_evidence;
  const isolation = task.implementer?.executor?.isolation_evidence;
  const result = { provenance: 'controller_file_rpc_dispatch', records: [], capture_complete: false,
    coverage_from_first_executor: isolation?.file_rpc_coverage_from_first_executor === true,
    observed_operations: 0, omitted_records: 0, generations: 0, expected_generations: isolation?.file_rpc_generation || 0,
    error: null, coverage: 'File RPC dispatch metadata only; not command syscalls or an exhaustive read audit. Kernel policy enforces write/network confinement. Paths are pre-operation observations; outside paths are omitted.' };
  try {
    if (!result.coverage_from_first_executor || !result.expected_generations) throw Error('FILE_RPC_CAPTURE_UNAVAILABLE');
    const runtime = path.join(workspaceRoot, task.id, 'implementer-runtime');
    const dirs = (await fs.readdir(runtime)).filter(n => n.startsWith('sandbox-')).sort();
    if (dirs.length !== result.expected_generations || dirs.length > 32) throw Error('FILE_RPC_GENERATIONS_INCOMPLETE');
    let bytes = 0, complete = true; const journals = [];
    for (const dir of dirs) {
      const file = path.join(runtime, dir, 'control/file-rpc.json'), st = await fs.lstat(file);
      if (!st.isFile() || st.isSymbolicLink() || st.size > 32768 || await fs.realpath(file) !== file) throw Error('FILE_RPC_JOURNAL_INVALID');
      const j = JSON.parse(await fs.readFile(file, 'utf8'));
      if (j.version !== 1 || !j.initialized || !Array.isArray(j.records) || j.records.length > MAX_RECORDS || !Number.isSafeInteger(j.observed) || !Number.isSafeInteger(j.omitted) || j.omitted < 0 || j.observed !== j.records.length + j.omitted || j.records.some((r, i) => r.sequence !== i + 1 || r.operation_id !== `${j.instance_id}:${r.sequence}` || !Array.isArray(r.targets) || !['pending','succeeded','failed','denied','unknown'].includes(r.outcome) || r.success !== (r.outcome === 'succeeded' ? true : r.outcome === 'pending' ? null : false))) throw Error('FILE_RPC_JOURNAL_CONFLICT');
      journals.push(j);
    }
    // Generations are sequential; timestamps order starts, sequences order each generation.
    journals.sort((a,b) => a.started_at.localeCompare(b.started_at));
    for (const j of journals) {
      result.generations++; result.observed_operations += j.observed; result.omitted_records += j.omitted;
      if (!j.closed || j.omitted || j.records.some(r => ['pending','unknown'].includes(r.outcome))) complete = false;
      for (const record of j.records) {
        const size = Buffer.byteLength(JSON.stringify(record));
        if (result.records.length >= MAX_RECORDS || bytes + size > MAX_BYTES) { result.omitted_records++; complete = false; continue; }
        result.records.push(record); bytes += size;
      }
    }
    result.capture_complete = complete;
    if (!complete) result.error = 'FILE_RPC_CAPTURE_INCOMPLETE';
  } catch (e) { result.error = /^FILE_RPC_[A-Z_]+$/.test(e.message) ? e.message : 'FILE_RPC_CAPTURE_UNAVAILABLE'; }
  return result;
}
