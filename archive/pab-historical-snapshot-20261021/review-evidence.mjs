// Controller observations only: no model prose, reasoning, or raw Git config/log contents.
import { promises as fs, createReadStream, constants } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { repoGit, resolveRepository, verifyTaskWorktree } from './repositories.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const unavailable = reason => ({ status: 'unavailable', reason });
const fingerprint = stat => [String(stat.dev), String(stat.ino), String(stat.mode), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs)];
// Hash all entries, including ignored/untracked files. Never follow links or publish file contents.
// Limits are explicit; exceeding them produces unavailable evidence, never an unchanged assertion.
async function treeState(root, skip = []) {
  const hash = createHash('sha256'); let files = 0, bytes = 0;
  const deadline = Date.now() + 10000;
  async function walk(relative = '') {
    const directory = path.join(root, relative);
    const before = await fs.lstat(directory, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink() || await fs.realpath(directory) !== directory) throw Error();
    for (const name of (await fs.readdir(directory)).sort()) {
      if (!relative && skip.includes(name)) continue;
      if (++files > 20000 || Date.now() > deadline) throw Error();
      const rel = path.join(relative, name), file = path.join(root, rel), stat = await fs.lstat(file, { bigint: true });
      if (stat.isDirectory()) { hash.update(JSON.stringify([rel, 'directory', String(stat.mode)])); await walk(rel); }
      else if (stat.isSymbolicLink()) hash.update(JSON.stringify([rel, 'symlink', await fs.readlink(file), fingerprint(stat)]));
      else if (stat.isFile()) {
        bytes += Number(stat.size); if (bytes > 256 * 1024 * 1024) throw Error();
        const content = createHash('sha256');
        for await (const chunk of createReadStream(file, { flags: constants.O_RDONLY | constants.O_NOFOLLOW })) {
          if (Date.now() > deadline) throw Error(); content.update(chunk);
        }
        if (JSON.stringify(fingerprint(stat)) !== JSON.stringify(fingerprint(await fs.lstat(file, { bigint: true })))) throw Error();
        hash.update(JSON.stringify([rel, fingerprint(stat), content.digest('hex')]));
      } else throw Error();
    }
    const after = await fs.lstat(directory, { bigint: true });
    if (JSON.stringify(fingerprint(before)) !== JSON.stringify(fingerprint(after))) throw Error();
  }
  await walk();
  return { sha256: hash.digest('hex'), entries: files, bytes, coverage: 'all entries, including ignored and untracked; symlinks hashed without following' };
}
function observedText(text, bound, limit = 8192) {
  return { text: bound(text, limit), sha256: sha(text), truncated: text.length > limit };
}
export async function gitState(repo, bound) {
  try {
    const common = await fs.realpath(repoGit(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim());
    const gitDir = await fs.realpath(repoGit(repo, 'rev-parse', '--absolute-git-dir').trim());
    const refs = repoGit(repo, 'for-each-ref', '--format=%(refname) %(objectname)');
    const config = await fs.readFile(path.join(common, 'config'));
    const indexFile = path.join(gitDir, 'index');
    const index = await fs.readFile(indexFile).then(sha, e => { if (e.code === 'ENOENT') return null; throw e; });
    const markers = {};
    for (const name of ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-apply', 'rebase-merge']) {
      markers[name] = await fs.lstat(path.join(gitDir, name)).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; });
    }
    return { status: 'captured', remotes: observedText(repoGit(repo, 'remote'), bound), operation_markers: markers, head: repoGit(repo, 'rev-parse', 'HEAD').trim(),
      refs: observedText(refs, bound), config_sha256: sha(config), index_sha256: index,
      metadata: await treeState(common, ['objects']),
      metadata_coverage: 'Git common directory except objects, including refs, reflogs, config, index and worktree administration' };
  } catch { return unavailable('Git state unreadable, changed during capture, or exceeded snapshot limits'); }
}
export async function checkoutSnapshot(repo, bound) {
  const capturedAt = new Date().toISOString();
  try {
    const canonical = await fs.realpath(repo);
    if (canonical !== repo) throw Error();
    const before = await gitState(repo, bound);
    const status = repoGit(repo, 'status', '--porcelain=v1', '--untracked-files=all');
    const contents = await treeState(repo, ['.git']);
    const after = await gitState(repo, bound);
    if (before.status !== 'captured' || JSON.stringify(before) !== JSON.stringify(after) ||
        status !== repoGit(repo, 'status', '--porcelain=v1', '--untracked-files=all')) throw Error();
    return { status: 'captured', captured_at: capturedAt, git: before,
      index_worktree_status: observedText(status, bound), contents };
  } catch { return { ...unavailable('Checkout unreadable, changed during capture, or exceeded snapshot limits'), captured_at: capturedAt }; }
}
export function compareSnapshots(before, after) {
  if (before?.status !== 'captured' || after?.status !== 'captured') return { status: 'unavailable', reason: 'Both controller snapshots are required; missing history cannot be reconstructed' };
  const fields = before.git ? ['git', 'index_worktree_status', 'contents'] : ['head', 'refs', 'config_sha256', 'index_sha256', 'metadata', 'remotes', 'operation_markers'];
  const changed = fields.filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
  return { status: changed.length ? 'conflicting' : 'unchanged', changed_fields: changed };
}
export async function registrationEvidence(t, stateRoot, workspaceRoot, bound) {
  const r = t.repository;
  try {
    const validated = await resolveRepository(path.join(stateRoot, 'repositories.json'), r.repository_id, r.base_ref, workspaceRoot, stateRoot);
    let origin;
    try { origin = repoGit(r.canonical_path, 'config', '--local', '--get-regexp', '^remote[.]origin[.](url|pushurl)$'); }
    catch (e) { if (e.status !== 1) throw e; origin = ''; }
    const matches = JSON.stringify(validated.registered_identity) === JSON.stringify(r.registered_identity);
    return { status: matches ? 'validated' : 'conflicting', captured_at: new Date().toISOString(), repository_id: r.repository_id,
      canonical_registered_path: bound(validated.canonical_path, 4096), git_identity: validated.registered_identity,
      origin: { ...observedText(origin.replace(/https?:\/\/[^\s]+/g, value => { try { const url = new URL(value); return `${url.host}:${url.pathname.replace(/^\//, '')}`; } catch { return '[INVALID URL]'; } }), bound, 2048), configuration_sha256: sha(origin) }, origin_validation: origin ? 'observed from the identity-validated local Git configuration; no remote authentication performed' : 'no origin configured',
      requested_base_ref: r.base_ref, resolved_base_ref_at_capture: validated.baseline_commit, pinned_baseline: t.baseline };
  } catch { return { ...unavailable('Registry or repository identity validation failed'), repository_id: r.repository_id }; }
}
export async function captureBefore(t, stateRoot, workspaceRoot, bound) {
  return { provenance: 'controller', captured_at: new Date().toISOString(),
    registration: await registrationEvidence(t, stateRoot, workspaceRoot, bound),
    normal_checkout: await checkoutSnapshot(t.repository.canonical_path, bound),
    task_git: await gitState(path.join(workspaceRoot, t.id, 'repo'), bound) };
}
export async function repositoryReviewEvidence(t, stateRoot, workspaceRoot, bound) {
  const root = path.join(workspaceRoot, t.id), repo = path.join(root, 'repo');
  const before = t.review_evidence_before || null;
  const registration = await registrationEvidence(t, stateRoot, workspaceRoot, bound);
  let mapping;
  try {
    await verifyTaskWorktree(root, t.repository);
    mapping = { status: 'validated', task_id: t.id, repository_id: t.repository.repository_id,
      canonical_worktree_path: await fs.realpath(repo), task_branch: t.repository.branch,
      baseline_commit: t.baseline, head: repoGit(repo, 'rev-parse', 'HEAD').trim(),
      private_git_directory: await fs.realpath(path.join(root, 'git-store')),
      worktree_list_porcelain: observedText(repoGit(repo, 'worktree', 'list', '--porcelain'), bound),
      mapping_method: 'controller created a private Git store by fetching the registered repository pinned commit, then added this worktree; source Git administration is not shared',
      creation_record: { repository_id: t.repository.repository_id, source_identity: t.repository.registered_identity,
        baseline_commit: t.repository.baseline_commit, worktree_id: t.repository.worktree_id } };
  } catch { mapping = unavailable('Task worktree identity validation failed'); }
  if (mapping.status === 'validated' && mapping.head !== mapping.baseline_commit) mapping.status = 'conflicting';
  const after = registration.status === 'validated' ? await checkoutSnapshot(t.repository.canonical_path, bound) : unavailable('Registration validation failed');
  const taskGit = ['validated', 'conflicting'].includes(mapping.status) ? await gitState(repo, bound) : unavailable('Task mapping validation failed');
  const isolation = t.implementer?.executor?.isolation_evidence;
  const enforced = isolation?.initialized === true && isolation.coverage_from_first_executor === true && isolation.command_network_access === false && isolation.filesystem_rpc_sandboxed === true;
  return { provenance: 'controller', captured_at: new Date().toISOString(),
    registration: { before: before?.registration || unavailable('No pre-execution registration observation retained'), at_review: registration,
      comparison: !before?.registration || before.registration.status !== 'validated' || registration.status !== 'validated' ? 'unavailable' :
        ['repository_id', 'canonical_registered_path', 'git_identity', 'origin'].every(key => JSON.stringify(before.registration[key]) === JSON.stringify(registration[key])) ? 'unchanged' : 'conflicting' },
    task_worktree: mapping,
    normal_checkout: { before: before?.normal_checkout || unavailable('No pre-execution checkout snapshot retained'), at_review: after,
      comparison: compareSnapshots(before?.normal_checkout, after) },
    git_operations: { before: before?.task_git || unavailable('No pre-execution Git metadata snapshot retained'), at_review: taskGit,
      comparison: compareSnapshots(before?.task_git, taskGit), executor_isolation: t.implementer?.executor?.isolation_evidence || unavailable('No executor isolation attestation retained'),
      limitations: ['State equality is not proof that every command was observed.', enforced ? 'Network denied for commands and file RPC worker by the recorded sandbox, including explicit-URL pushes; this is enforcement evidence, not a remote-side audit.' : 'No complete sandbox coverage: a push to an explicit URL cannot be ruled out solely by local refs/config.', 'Command records are execution evidence, not implementer prose; inspect failed attempts, truncation and retrieval gaps.'],
      remote_operations_verification: enforced ? 'network_denied_by_controller_sandbox' : 'not_independently_observed',
      filesystem_enforcement: enforced ? 'worktree_and_task_scratch_only; file RPCs also sandboxed' : 'complete_enforcement_evidence_unavailable' } };
}
