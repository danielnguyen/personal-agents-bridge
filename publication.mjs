// Trusted controller-only Git publication. No agent command, remote, ref or path is accepted.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { checkoutSnapshot } from './review-evidence.mjs';
import { repositoryIdentity, verifyTaskWorktree, repoGit } from './repositories.mjs';

const sha = x => createHash('sha256').update(x).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const oid = value => /^[a-f0-9]{40,64}$/.test(value);
function environment(extra = {}) {
  return { PATH: '/usr/bin:/bin', HOME: homedir(), LANG: 'C.UTF-8', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...extra };
}
export function publicationGit(repo, args, { env = {}, input, hooks = '/dev/null', network = false } = {}) {
  try {
    return execFileSync('/usr/bin/git', ['--no-optional-locks', '-c', `core.hooksPath=${hooks}`, '-c', 'core.fsmonitor=false', '-c', 'core.filemode=true', '-c', 'core.symlinks=true', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
      ...(network ? ['-c', 'credential.helper=!/usr/bin/gh auth git-credential', '-c', 'push.followTags=false', '-c', 'http.followRedirects=false'] : []), ...args], {
      cwd: repo, env: environment({ ...(network ? { GH_TOKEN: process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '' } : {}), ...env }), input, encoding: 'utf8', timeout: 60000, maxBuffer: 2 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch { fail('PUBLICATION_GIT_FAILED'); }
}
export async function publicationState(repo) {
  const s = await checkoutSnapshot(repo, x => x);
  if (s.status !== 'captured') fail('PUBLICATION_SNAPSHOT_UNAVAILABLE');
  return { head: s.git.head, contents_sha256: s.contents.sha256, index_sha256: s.git.index_sha256,
    git_metadata_sha256: s.git.metadata.sha256, status_sha256: s.index_worktree_status.sha256 };
}
export async function worktreeTree(root, baseline) {
  if (!oid(baseline)) fail('INVALID_PUBLICATION_BASELINE');
  const dir = await fs.mkdtemp(path.join(root, 'tree-index-'));
  try {
    const env = { GIT_INDEX_FILE: path.join(dir, 'index') }, repo = path.join(root, 'repo');
    publicationGit(repo, ['read-tree', baseline], { env });
    publicationGit(repo, ['add', '--all', '--', '.'], { env });
    publicationGit(repo, ['update-index', '--force-remove', '--', 'TASK.md'], { env });
    const tree = publicationGit(repo, ['write-tree'], { env }).trim();
    if (!oid(tree)) fail('INVALID_REVIEW_TREE');
    if (publicationGit(repo, ['ls-tree', '-r', tree]).split('\n').some(line => line.startsWith('160000 '))) fail('PUBLICATION_SUBMODULE_UNSUPPORTED');
    return tree;
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
export async function reviewedGitState(root, task) {
  await verifyTaskWorktree(root, task.repository);
  const repo = path.join(root, 'repo'), before = await publicationState(repo);
  const tree = await worktreeTree(root, task.baseline), after = await publicationState(repo);
  if (JSON.stringify(before) !== JSON.stringify(after)) fail('WORKTREE_CHANGED_DURING_REVIEW');
  return { provenance: 'controller', tree_sha: tree, state: before,
    method: 'Git read-tree/add/write-tree in the existing task worktree using a temporary index; real index and HEAD unchanged' };
}
export function githubRepository(url) {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(url);
  if (!match || match[2] === '.' || match[2] === '..') fail('PUBLICATION_REQUIRES_GITHUB_ORIGIN');
  return `${match[1]}/${match[2]}`;
}
export function originConfiguration(repo) {
  try { return repoGit(repo, 'config', '--local', '--get-regexp', '^remote[.]origin[.](url|pushurl)$'); }
  catch (e) { if (e.status === 1) return ''; throw e; }
}
export class GitHubPublisher {
  api(endpoint, method = 'GET', body) {
    try { return JSON.parse(execFileSync('/usr/bin/gh', ['api', '--hostname', 'github.com', '--method', method, endpoint, ...(body ? ['--input', '-'] : [])], {
      env: environment({ GH_TOKEN: process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '', GH_PROMPT_DISABLED: '1' }), input: body ? JSON.stringify(body) : undefined,
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000, maxBuffer: 1024 * 1024
    })); } catch { fail('GITHUB_PUBLICATION_API_FAILED'); }
  }
  async target(repository) {
    const fetch = githubRepository(repoGit(repository.canonical_path, 'remote', 'get-url', 'origin').trim());
    const push = githubRepository(repoGit(repository.canonical_path, 'remote', 'get-url', '--push', 'origin').trim());
    if (fetch.toLowerCase() !== push.toLowerCase()) fail('PUBLICATION_ORIGIN_MISMATCH');
    const r = this.api(`repos/${fetch}`);
    if (r.full_name?.toLowerCase() !== fetch.toLowerCase() || typeof r.default_branch !== 'string' || r.archived) fail('PUBLICATION_TARGET_INVALID');
    return { repository: r.full_name, base: r.default_branch, remote: `https://github.com/${r.full_name}.git` };
  }
  async remoteHead(repo, target, branch) {
    const ref = `refs/heads/${branch}`;
    const rows = publicationGit(repo, ['ls-remote', '--refs', '--', target.remote, ref], { network: true }).trim();
    if (!rows) return null;
    const fields = rows.split(/\s+/);
    if (fields.length !== 2 || !oid(fields[0]) || fields[1] !== ref) fail('PUBLICATION_REMOTE_REF_INVALID');
    return fields[0];
  }
  async push(repo, target, branch, commit, controlRoot) {
    const hooks = await fs.mkdtemp(path.join(controlRoot, 'publish-hooks-'));
    try {
      // Verify the remote's advertised old OID is zero: never fast-forward an
      // unexpected existing ref. receive-pack's old-OID CAS protects a later race.
      const ref = `refs/heads/${branch}`;
      const script = `#!/usr/bin/python3\nimport sys\nrows=[line.split() for line in sys.stdin]\nexpected=${JSON.stringify(ref)}\ncommit=${JSON.stringify(commit)}\nif len(rows)!=1: sys.exit(1)\nr=rows[0]\nif not (len(r)==4 and r[1]==commit and r[2]==expected and len(r[3]) in (40,64) and set(r[3])=={'0'}): sys.exit(1)\n`;
      await fs.writeFile(path.join(hooks, 'pre-push'), script, { mode: 0o700, flag: 'wx' });
      publicationGit(repo, ['push', '--porcelain', '--', target.remote, `${commit}:${ref}`], { hooks, network: true });
    } finally { await fs.rm(hooks, { recursive: true, force: true }); }
  }
  async findPR(target, branch) {
    const owner = target.repository.split('/')[0];
    const rows = this.api(`repos/${target.repository}/pulls?state=all&head=${encodeURIComponent(owner + ':' + branch)}&base=${encodeURIComponent(target.base)}&per_page=100`);
    if (!Array.isArray(rows) || rows.length > 1) fail('PUBLICATION_PR_AMBIGUOUS');
    return rows[0] || null;
  }
  async createPR(target, branch, input) {
    return this.api(`repos/${target.repository}/pulls`, 'POST', { title: input.title, body: input.body, head: branch, base: target.base, draft: true });
  }
}
function verifyPR(pr, target, branch, commit) {
  if (!Number.isInteger(pr?.number) || pr.number <= 0 || pr.state !== 'open' || pr.draft !== true || pr.merged_at ||
      pr.head?.ref !== branch || pr.head?.sha !== commit || pr.head?.repo?.full_name !== target.repository ||
      pr.base?.ref !== target.base || pr.base?.repo?.full_name !== target.repository ||
      pr.html_url !== `https://github.com/${target.repository}/pull/${pr.number}`) fail('PUBLICATION_PR_CONFLICT');
}
export async function publishReviewedTask(controller, task, input) {
  const id = task.id, root = path.join(controller.workspaceRoot, id), repo = path.join(root, 'repo');
  if (!/^task_[a-f0-9-]{36}$/.test(id) || task.repository.branch !== `bridge/${id}`) fail('PUBLICATION_BRANCH_INVALID');
  try { await fs.lstat(repo); } catch (e) { if (e.code === 'ENOENT') fail('PUBLICATION_WORKTREE_MISSING'); throw e; }
  await verifyTaskWorktree(root, task.repository);
  const currentIdentity = await repositoryIdentity(task.repository.canonical_path);
  if (JSON.stringify(currentIdentity) !== JSON.stringify(task.repository.registered_identity)) fail('REPOSITORY_PATH_CHANGED');
  const packetText = await fs.readFile(path.join(root, task.reviewer.packet_directory, 'evidence.json'), 'utf8');
  if (sha(packetText) !== task.reviewer.packet_hash) fail('REVIEW_PACKET_CHANGED');
  const packet = JSON.parse(packetText), reviewed = packet.reviewed_git_state;
  if (!reviewed || !oid(reviewed.tree_sha) || reviewed.state?.head !== task.baseline) fail('REVIEW_TREE_UNAVAILABLE');
  const contract = JSON.parse(await fs.readFile(path.join(root, 'contract.json'), 'utf8'));
  const treeChanges = publicationGit(repo, ['diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', task.baseline, reviewed.tree_sha]).split('\0').filter(Boolean);
  if (treeChanges.some(name => !contract.allowed_files.includes(name))) fail('PUBLICATION_SCOPE_VIOLATION');
  if (packet.unauthorized_files?.length || !Array.isArray(packet.unauthorized_files)) fail('PUBLICATION_SCOPE_VIOLATION');
  if (sha(originConfiguration(task.repository.canonical_path)) !== packet.controller_evidence?.registration?.at_review?.origin?.configuration_sha256) fail('PUBLICATION_ORIGIN_CHANGED');
  if (JSON.stringify(await publicationState(repo)) !== JSON.stringify(reviewed.state)) fail('WORKTREE_CHANGED_SINCE_REVIEW');
  if (await worktreeTree(root, task.baseline) !== reviewed.tree_sha) fail('PUBLICATION_TREE_MISMATCH');
  if (JSON.stringify(await publicationState(repo)) !== JSON.stringify(reviewed.state)) fail('WORKTREE_CHANGED_SINCE_REVIEW');
  const fingerprint = sha(JSON.stringify(input)), backend = controller.publisher;
  if (task.publication && task.publication.input_sha256 !== fingerprint) fail('PUBLICATION_INPUT_CHANGED');
  task.publication_frozen = true; controller.save(task); // durable: continue/review cannot restart implementation
  const target = await backend.target(task.repository), branch = task.repository.branch;
  publicationGit(repo, ['check-ref-format', `refs/heads/${target.base}`]);
  if (target.base === branch) fail('PUBLICATION_DEFAULT_BRANCH_FORBIDDEN');
  let p = task.publication;
  if (p && JSON.stringify(p.target) !== JSON.stringify(target)) fail('PUBLICATION_TARGET_CHANGED');
  if (!p) {
    if (await backend.remoteHead(repo, target, branch)) fail('PUBLICATION_REMOTE_BRANCH_EXISTS');
    const timestamp = new Date().toISOString();
    const commit = publicationGit(repo, ['commit-tree', reviewed.tree_sha, '-p', task.baseline], { input: input.title + '\n', env: {
      GIT_AUTHOR_NAME: 'Personal Agents Bridge', GIT_AUTHOR_EMAIL: 'personal-agents-bridge@users.noreply.github.com', GIT_COMMITTER_NAME: 'Personal Agents Bridge', GIT_COMMITTER_EMAIL: 'personal-agents-bridge@users.noreply.github.com', GIT_AUTHOR_DATE: timestamp, GIT_COMMITTER_DATE: timestamp
    } }).trim();
    if (!oid(commit)) fail('PUBLICATION_COMMIT_INVALID');
    p = task.publication = { phase: 'prepared', task_id: id, input_sha256: fingerprint, reviewed_tree_sha: reviewed.tree_sha, commit_sha: commit,
      pushed_branch: branch, target, review_packet_sha256: task.reviewer.packet_hash,
      ...(task.execution_backend === 'local_codex' ? { reviewer_backend: 'local_codex', reviewer_thread_id: task.reviewer.local.thread_id, reviewer_session_id: null } : { reviewer_session_id: task.reviewer.session_id }),
      reviewer_turn_id: task.reviewer.review_result.turn_id, review_overall: 'PASS', prepared_at: timestamp, push_attempted: false, pr_attempted: false };
    controller.save(task);
  }
  if (publicationGit(repo, ['rev-parse', `${p.commit_sha}^{tree}`]).trim() !== reviewed.tree_sha || p.reviewed_tree_sha !== reviewed.tree_sha) fail('PUBLICATION_TREE_MISMATCH');
  p.commit_tree_matches_reviewed_tree = true; controller.save(task);
  const remote = await backend.remoteHead(repo, target, branch);
  if (remote && (remote !== p.commit_sha || !p.push_attempted)) fail('PUBLICATION_REMOTE_BRANCH_CONFLICT');
  if (!remote) {
    if (p.phase !== 'prepared') fail('PUBLICATION_REMOTE_BRANCH_MISSING');
    if (JSON.stringify(await publicationState(repo)) !== JSON.stringify(reviewed.state)) fail('WORKTREE_CHANGED_SINCE_REVIEW');
    p.push_attempted = true; controller.save(task);
    await backend.push(repo, target, branch, p.commit_sha, controller.stateRoot);
    if (await backend.remoteHead(repo, target, branch) !== p.commit_sha) fail('PUBLICATION_PUSH_UNCONFIRMED');
  }
  if (p.phase === 'complete') return publicationResult(p);
  p.phase = 'pushed'; controller.save(task);
  let pr = await backend.findPR(target, branch);
  if (pr && !p.pr_attempted) fail('PUBLICATION_UNEXPECTED_PR');
  if (!pr) {
    // A prior uncertain create is never blindly repeated: allow read-only recovery.
    if (p.pr_attempted) fail('PUBLICATION_PR_OUTCOME_UNKNOWN');
    p.pr_attempted = true; controller.save(task);
    pr = await backend.createPR(target, branch, input);
  }
  verifyPR(pr, target, branch, p.commit_sha);
  p.phase = 'complete'; p.pr_number = pr.number; p.pr_url = pr.html_url; p.completed_at = new Date().toISOString(); controller.save(task);
  return publicationResult(p);
}
export function publicationResult(p) {
  return { task_id: p.task_id, reviewed_tree_sha: p.reviewed_tree_sha, commit_sha: p.commit_sha, pushed_branch: p.pushed_branch,
    pr_number: p.pr_number, pr_url: p.pr_url, commit_tree_matches_reviewed_tree: p.commit_tree_matches_reviewed_tree, draft: true };
}
