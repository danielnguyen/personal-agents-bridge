import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { verifyManagedCheckout, validateManagedTree } from './github-repository-integrity.mjs';

const SOURCE = path.dirname(fileURLToPath(import.meta.url));
export const repositoryIdPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const within = (a, b) => a === b || a.startsWith(b + path.sep);
function preserveInterruption(error) {
  if (['REGISTRATION_INTERRUPTED', 'REGISTRATION_TERMINATION_UNCERTAIN'].includes(error.code)) throw error;
}
async function processGroupAlive(pid, stopped) {
  try { process.kill(-pid, 0); }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  for (const name of await fs.readdir('/proc')) {
    if (stopped()) return true;
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = await fs.readFile(`/proc/${name}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(fields[2]) === pid && !['Z', 'X'].includes(fields[0])) return true;
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
  }
  return false;
}
export async function registrationProcess(binary, args, { cwd, env, signal, timeout = 120000, maxBuffer = 256 * 1024 } = {}) {
  if (signal?.aborted) fail('REGISTRATION_INTERRUPTED');
  return new Promise((resolve, reject) => {
    let child, closed = false, exited = false, code, reason, bytes = 0;
    let settled = false, checking = false, deadline, grace, retry;
    const output = [], started = Date.now();
    const killOwned = () => {
      if (!child?.pid) return;
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') reason = 'REGISTRATION_TERMINATION_UNCERTAIN'; }
      if (!exited) {
        try { child.kill('SIGKILL'); }
        catch { reason = 'REGISTRATION_TERMINATION_UNCERTAIN'; }
      }
    };
    const finish = uncertain => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline); clearTimeout(grace); clearTimeout(retry);
      signal?.removeEventListener('abort', abort);
      if (uncertain) {
        reason = 'REGISTRATION_TERMINATION_UNCERTAIN'; killOwned();
        child?.stdout?.destroy(); child?.stderr?.destroy();
      }
      if (reason || code !== 0) {
        const errorCode = reason || 'REGISTRATION_PROCESS_FAILED';
        reject(Object.assign(new Error(errorCode), { code: errorCode, status: code }));
      } else resolve(Buffer.concat(output).toString('utf8'));
    };
    const verify = async () => {
      if (settled || checking) return;
      checking = true;
      clearTimeout(retry);
      try {
        const alive = child.pid ? await processGroupAlive(child.pid, () => settled) : false;
        if (settled) return;
        if (alive) {
          reason ||= 'REGISTRATION_DESCENDANTS_REMAINED';
          killOwned();
        }
        if (closed && !alive) { finish(false); return; }
        retry = setTimeout(verify, 25);
      } catch { finish(true); }
      finally { checking = false; }
    };
    const settle = () => {
      if (settled) return;
      if (!grace) grace = setTimeout(() => finish(true), 2000);
      void verify();
    };
    const stop = value => {
      if (settled) return;
      reason ||= value;
      killOwned();
      settle();
    };
    const abort = () => stop('REGISTRATION_INTERRUPTED');
    try {
      child = spawn('/usr/bin/timeout', ['--signal=KILL', `${timeout / 1000}s`, '/bin/sh', '-c', 'umask 022; exec "$@"', 'pab-registration', binary, ...args],
        { cwd, env, detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { reject(Object.assign(new Error('REGISTRATION_PROCESS_FAILED'), { code: 'REGISTRATION_PROCESS_FAILED' })); return; }
    child.once('error', () => stop('REGISTRATION_PROCESS_FAILED'));
    child.once('exit', (exitCode, exitSignal) => {
      exited = true; code = exitCode;
      if (settled) return;
      if (exitSignal === 'SIGKILL' && Date.now() - started >= timeout) reason ||= 'REGISTRATION_PROCESS_TIMEOUT';
      if (reason) killOwned();
      settle();
    });
    child.once('close', exitCode => { closed = true; code = exitCode; settle(); });
    for (const stream of ['stdout', 'stderr']) child[stream].on('data', data => {
      if (settled) return;
      bytes += data.length;
      if (bytes > maxBuffer) stop('REGISTRATION_OUTPUT_LIMIT');
      else if (stream === 'stdout') output.push(data);
    });
    deadline = setTimeout(() => stop('REGISTRATION_PROCESS_TIMEOUT'), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
export const asynchronousRepoGit = signal => (cwd, ...args) => registrationProcess('/usr/bin/git',
  ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
    cwd, signal, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' },
  });
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
export async function repositoryIdentity(configuredPath, git = repoGit) {
  if (!path.isAbsolute(configuredPath)) fail('REPOSITORY_PATH_MUST_BE_ABSOLUTE');
  const canonical = await fs.realpath(configuredPath);
  if (canonical !== path.resolve(configuredPath)) fail('REPOSITORY_PATH_CHANGED');
  if (within(SOURCE, canonical) || within(canonical, SOURCE)) fail('BRIDGE_SELF_TARGET');
  const directory_identity = await identity(canonical);
  if ((await git(canonical, 'rev-parse', '--show-toplevel')).trim() !== canonical) fail('NOT_REPOSITORY_ROOT');
  const git_directory = await fs.realpath((await git(canonical, 'rev-parse', '--path-format=absolute', '--git-common-dir')).trim());
  const sourceGit = await fs.realpath((await git(SOURCE, 'rev-parse', '--path-format=absolute', '--git-common-dir')).trim());
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
export async function withRegistryLock(file, operation) {
  const parent = path.dirname(file), lock = `${file}.lock`;
  const stat = await fs.lstat(parent);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077) || await fs.realpath(parent) !== parent) fail('UNSAFE_REPOSITORY_REGISTRY');
  try { await fs.mkdir(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') fail('REPOSITORY_REGISTRY_BUSY'); throw error; }
  let uncertain = false;
  try { return await operation(); }
  catch (error) { uncertain = error.code === 'REGISTRATION_TERMINATION_UNCERTAIN'; throw error; }
  finally { if (!uncertain) await fs.rmdir(lock); }
}
export async function writeRegistry(file, registry) {
  const text = JSON.stringify(registry, null, 2) + '\n';
  if (Buffer.byteLength(text) > 65536) fail('REPOSITORY_REGISTRY_LIMIT');
  const temporary = `${file}.${randomUUID()}.tmp`;
  let created = false;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    created = true;
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, file);
    const directory = await fs.open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { if (created) await fs.rm(temporary, { force: true }); }
}
export async function verifyGitHubBinding(identity, id, binding, git = asynchronousRepoGit()) {
  if (!binding || !Number.isSafeInteger(binding.repository_id) || binding.repository_id <= 0 || id !== `github_${binding.repository_id}` ||
      !Number.isSafeInteger(binding.owner_id) || binding.owner_id <= 0 || !/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(binding.full_name || '') ||
      !/^[a-f0-9]{40}$/.test(binding.baseline_commit || '') || typeof binding.private !== 'boolean' ||
      typeof binding.default_branch !== 'string' || !binding.default_branch || identity.git_directory !== path.join(identity.path, '.git')) fail('GITHUB_REGISTRATION_INVALID');
  const origin = `https://github.com/${binding.full_name}.git`;
  let config;
  try { config = (await git(identity.path, 'config', '--local', '--get-regexp', '^remote[.]origin[.](url|pushurl)$')).trim().split('\n'); }
  catch (error) { preserveInterruption(error); fail('GITHUB_REGISTRATION_ORIGIN_CHANGED'); }
  if (config.length !== 1 || config[0] !== `remote.origin.url ${origin}`) fail('GITHUB_REGISTRATION_ORIGIN_CHANGED');
  if ((await git(identity.path, 'rev-parse', '--verify', 'HEAD^{commit}')).trim() !== binding.baseline_commit) fail('GITHUB_REGISTRATION_BASELINE_CHANGED');
  await verifyManagedCheckout(identity.path, binding.baseline_commit, git);
}
export async function resolveRepository(file, id, baseRef, workspaceRoot, stateRoot, git = repoGit) {
  if (!repositoryIdPattern.test(id)) fail('INVALID_REPOSITORY_ID');
  if (typeof baseRef !== 'string' || baseRef.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(baseRef) || baseRef.includes('..')) fail('INVALID_BASE_REF');
  const registry = await readRegistry(file);
  if (!Object.hasOwn(registry.repositories, id)) fail('UNKNOWN_REPOSITORY_ID');
  const saved = registry.repositories[id];
  const github = registry.github_repositories?.[id];
  if (github && git === repoGit) git = asynchronousRepoGit();
  const current = await repositoryIdentity(saved.path, git);
  if (JSON.stringify(current) !== JSON.stringify(saved)) fail('REPOSITORY_PATH_CHANGED');
  if (github) await verifyGitHubBinding(current, id, github, git);
  for (const root of [workspaceRoot, stateRoot]) if (within(current.path, root) || within(root, current.path)) fail('REPOSITORY_OVERLAPS_BRIDGE_STORAGE');
  let baseline;
  try { baseline = (await git(current.path, 'rev-parse', '--verify', `${baseRef}^{commit}`)).trim(); }
  catch (error) { preserveInterruption(error); fail('BASE_REF_NOT_FOUND'); }
  if (!/^[a-f0-9]{40,64}$/.test(baseline)) fail('INVALID_BASELINE');
  if (github) await validateManagedTree(current.path, baseline, git);
  return { repository_id: id, canonical_path: current.path, registered_identity: current, base_ref: baseRef, baseline_commit: baseline, ...(github ? { github_identity: github } : {}) };
}
export async function createTaskWorktree(root, id, repository) {
  // Never share writable objects, refs, config, hooks or worktree metadata with the source.
  const current = await repositoryIdentity(repository.canonical_path);
  if (JSON.stringify(current) !== JSON.stringify(repository.registered_identity)) fail('REPOSITORY_PATH_CHANGED');
  if (repository.github_identity) {
    await verifyGitHubBinding(current, repository.repository_id, repository.github_identity);
    await validateManagedTree(current.path, repository.baseline_commit, asynchronousRepoGit());
  }
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
export async function createCorrectiveWorktree(root, id, sourceRoot, repository, tree) {
  if (!/^[a-f0-9]{40,64}$/.test(tree)) fail('INVALID_REVIEW_TREE');
  await verifyTaskWorktree(sourceRoot, repository);
  const git = asynchronousRepoGit(AbortSignal.timeout(10000)), source = path.join(sourceRoot, 'repo');
  await git(source, 'cat-file', '-e', `${repository.baseline_commit}^{commit}`);
  await validateManagedTree(source, tree, git);
  const store = path.join(root, 'git-store'), worktree = path.join(root, 'repo');
  await fs.mkdir(store, { mode: 0o700 });
  await git(store, 'init', '--bare', '--initial-branch=main');
  let files = 0, bytes = 0;
  const deadline = Date.now() + 10000;
  // Copy object bytes, never alternates, configuration, refs or mutable Git
  // administration. No fetch, shared object directory or hardlinks are used.
  async function copyObjects(relative = '') {
    const from = path.join(sourceRoot, 'git-store/objects', relative), to = path.join(store, 'objects', relative);
    const before = await fs.lstat(from, { bigint: true });
    if (Date.now() >= deadline || before.uid !== BigInt(process.getuid()) || before.isSymbolicLink()) fail('CORRECTION_OBJECTS_UNAVAILABLE');
    if (before.isDirectory()) {
      if (relative && !/^(?:info|pack|[a-f0-9]{2})$/.test(relative)) fail('CORRECTION_OBJECTS_UNAVAILABLE');
      if (relative) await fs.mkdir(to, { recursive: true, mode: 0o700 });
      for (const name of (await fs.readdir(from)).sort()) await copyObjects(relative ? `${relative}/${name}` : name);
    } else {
      if (!before.isFile() || before.nlink !== 1n || !/^(?:[a-f0-9]{2}\/(?:[a-f0-9]{38}|[a-f0-9]{62})|pack\/pack-[a-f0-9]{40,64}\.(?:pack|idx|rev))$/.test(relative) ||
          ++files > 100000 || (bytes += Number(before.size)) > 512 * 1024 * 1024) fail('CORRECTION_OBJECTS_UNAVAILABLE');
      await fs.copyFile(from, to, constants.COPYFILE_EXCL);
    }
    const after = await fs.lstat(from, { bigint: true });
    if (['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key] !== after[key])) fail('CORRECTION_OBJECTS_CHANGED');
  }
  await copyObjects();
  await git(store, 'fsck', '--full', '--strict', '--no-reflogs');
  await git(store, 'cat-file', '-e', `${repository.baseline_commit}^{commit}`);
  await validateManagedTree(store, tree, git);
  const branch = `bridge/${id}`;
  await git(store, 'worktree', 'add', '-b', branch, worktree, repository.baseline_commit);
  await git(worktree, 'read-tree', '--reset', '-u', tree);
  if ((await git(worktree, 'write-tree')).trim() !== tree) fail('CORRECTION_TREE_CHANGED');
  await git(worktree, 'diff-files', '--quiet');
  await fs.appendFile(path.join(store, 'info/exclude'), '\n/TASK.md\n');
  return { ...repository, branch, worktree_id: id };
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
