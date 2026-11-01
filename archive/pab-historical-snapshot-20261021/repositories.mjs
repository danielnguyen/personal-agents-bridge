import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SOURCE = path.dirname(fileURLToPath(import.meta.url));
export const repositoryIdPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const within = (a, b) => a === b || a.startsWith(b + path.sep);
export function repoGit(cwd, ...args) {
  return execFileSync('/usr/bin/git', ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
    cwd, encoding: 'utf8', maxBuffer: 256 * 1024, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }
  });
}
async function identity(p) {
  const stat = await fs.lstat(p);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) fail('UNSAFE_REPOSITORY_PATH');
  return { dev: String(stat.dev), ino: String(stat.ino) };
}
export async function repositoryIdentity(configuredPath) {
  if (!path.isAbsolute(configuredPath)) fail('REPOSITORY_PATH_MUST_BE_ABSOLUTE');
  const canonical = await fs.realpath(configuredPath);
  if (canonical !== path.resolve(configuredPath)) fail('REPOSITORY_PATH_CHANGED');
  if (within(SOURCE, canonical) || within(canonical, SOURCE)) fail('BRIDGE_SELF_TARGET');
  const directory_identity = await identity(canonical);
  if (repoGit(canonical, 'rev-parse', '--show-toplevel').trim() !== canonical) fail('NOT_REPOSITORY_ROOT');
  const git_directory = await fs.realpath(repoGit(canonical, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim());
  const sourceGit = await fs.realpath(repoGit(SOURCE, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim());
  if (git_directory === sourceGit) fail('BRIDGE_SELF_TARGET');
  return { path: canonical, directory_identity, git_directory, git_identity: await identity(git_directory) };
}
export async function readRegistry(file) {
  try {
    const st = await fs.lstat(file);
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o077) || st.size > 65536) fail('UNSAFE_REPOSITORY_REGISTRY');
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    if (value.version !== 1 || !value.repositories || typeof value.repositories !== 'object' || Array.isArray(value.repositories)) fail('INVALID_REPOSITORY_REGISTRY');
    return value;
  } catch (e) { if (e.code === 'ENOENT') return { version: 1, repositories: {} }; throw e; }
}
export async function resolveRepository(file, id, baseRef, workspaceRoot, stateRoot) {
  if (!repositoryIdPattern.test(id)) fail('INVALID_REPOSITORY_ID');
  if (typeof baseRef !== 'string' || baseRef.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(baseRef) || baseRef.includes('..')) fail('INVALID_BASE_REF');
  const registry = await readRegistry(file);
  if (!Object.hasOwn(registry.repositories, id)) fail('UNKNOWN_REPOSITORY_ID');
  const saved = registry.repositories[id];
  const current = await repositoryIdentity(saved.path);
  if (JSON.stringify(current) !== JSON.stringify(saved)) fail('REPOSITORY_PATH_CHANGED');
  for (const root of [workspaceRoot, stateRoot]) if (within(current.path, root) || within(root, current.path)) fail('REPOSITORY_OVERLAPS_BRIDGE_STORAGE');
  let baseline;
  try { baseline = repoGit(current.path, 'rev-parse', '--verify', `${baseRef}^{commit}`).trim(); }
  catch { fail('BASE_REF_NOT_FOUND'); }
  if (!/^[a-f0-9]{40,64}$/.test(baseline)) fail('INVALID_BASELINE');
  return { repository_id: id, canonical_path: current.path, registered_identity: current, base_ref: baseRef, baseline_commit: baseline };
}
export async function createTaskWorktree(root, id, repository) {
  // Never share writable objects, refs, config, hooks or worktree metadata with the source.
  const current = await repositoryIdentity(repository.canonical_path);
  if (JSON.stringify(current) !== JSON.stringify(repository.registered_identity)) fail('REPOSITORY_PATH_CHANGED');
  const store = path.join(root, 'git-store'), worktree = path.join(root, 'repo');
  await fs.mkdir(store, { mode: 0o700 });
  repoGit(store, 'init', '--bare', '--initial-branch=main');
  repoGit(store, '-c', 'protocol.file.allow=always', 'fetch', '--no-tags', '--no-write-fetch-head', repository.canonical_path, repository.baseline_commit);
  const branch = `bridge/${id}`;
  repoGit(store, 'worktree', 'add', '-b', branch, worktree, repository.baseline_commit);
  await fs.appendFile(path.join(store, 'info/exclude'), '\n/TASK.md\n');
  return { ...repository, branch, worktree_id: id };
}
export async function verifyTaskWorktree(root, repository) {
  const worktree = path.join(root, 'repo'), store = path.join(root, 'git-store');
  if (await fs.realpath(worktree) !== worktree || await fs.realpath(store) !== store) fail('TASK_WORKTREE_CHANGED');
  const pointer = await fs.lstat(path.join(worktree, '.git'));
  if (!pointer.isFile() || pointer.isSymbolicLink()) fail('TASK_WORKTREE_CHANGED');
  if ((await fs.readFile(path.join(worktree, '.git'), 'utf8')).trim() !== `gitdir: ${store}/worktrees/repo`) fail('TASK_WORKTREE_CHANGED');
  if (repoGit(worktree, 'symbolic-ref', 'HEAD').trim() !== `refs/heads/${repository.branch}`) fail('TASK_BRANCH_CHANGED');
}
export async function removeTaskWorktree(root, repository) {
  const worktree = path.join(root, 'repo'), store = path.join(root, 'git-store');
  try { await fs.lstat(worktree); }
  catch (e) { if (e.code === 'ENOENT') return; throw e; }
  await verifyTaskWorktree(root, repository);
  repoGit(store, 'worktree', 'remove', '--force', worktree);
  try { await fs.lstat(worktree); fail('WORKTREE_DELETE_UNCONFIRMED'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
}
