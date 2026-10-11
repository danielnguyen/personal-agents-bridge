import { promises as fs } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { repoGit, repositoryIdentity, repositoryIdPattern, readRegistry, resolveRepository, withRegistryLock, writeRegistry } from './repositories.mjs';
import { githubRepository } from './publication.mjs';

const SOURCE = path.dirname(fileURLToPath(import.meta.url));
const SELF = 'danielnguyen/personal-agents-bridge';
export const bridgeGitHubRepositoryId = 1388046916;
export const githubNamePattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/;
export class RegistrationError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = code => { throw new RegistrationError(code); };
const overlaps = (first, second) => first === second || first.startsWith(second + path.sep) || second.startsWith(first + path.sep);
const numericId = value => Number.isSafeInteger(value) && value > 0;
function validName(value) {
  return typeof value === 'string' && githubNamePattern.test(value) && !/\s/.test(value) && !['.', '..'].includes(value.split('/')[1]) && !value.endsWith('.git');
}
function environment(network = false) {
  return { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
    ...(network ? { HOME: homedir(), GH_TOKEN: process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '', GH_PROMPT_DISABLED: '1' } : {}) };
}
export class GitHubRegistrationTransport {
  constructor(run = execFileSync) { this.run = run; }
  api(endpoint) {
    try { return JSON.parse(this.run('/usr/bin/gh', ['api', '--hostname', 'github.com', '--method', 'GET', endpoint], {
      env: environment(true), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000, killSignal: 'SIGKILL', maxBuffer: 128 * 1024,
    })); } catch { fail('GITHUB_REGISTRATION_ACCESS_UNAVAILABLE'); }
  }
  fetch(directory, target) {
    try {
      this.run('/usr/bin/timeout', ['--signal=KILL', '120s', '/usr/bin/git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
        '-c', 'credential.helper=', '-c', 'credential.helper=!/usr/bin/gh auth git-credential', '-c', 'credential.interactive=false',
        '-c', 'http.followRedirects=false', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'fetch.fsckObjects=true',
        'fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--', `https://github.com/${target.full_name}.git`,
        `refs/heads/${target.default_branch}:refs/remotes/origin/${target.default_branch}`], {
        cwd: directory, env: environment(true), stdio: 'ignore', timeout: 125000, killSignal: 'SIGKILL',
      });
    } catch { fail('GITHUB_REGISTRATION_FETCH_FAILED'); }
  }
}
async function provisionRoot(root, excluded) {
  if (excluded.some(entry => overlaps(root, path.resolve(entry)))) fail('REGISTRATION_ROOT_OVERLAP');
  const ancestors = [];
  for (let ancestor = root; ; ancestor = path.dirname(ancestor)) {
    ancestors.unshift(ancestor);
    if (ancestor === path.dirname(ancestor)) break;
  }
  for (const ancestor of ancestors) {
    let stat;
    try { stat = await fs.lstat(ancestor); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await fs.mkdir(ancestor, { mode: 0o700 }); stat = await fs.lstat(ancestor);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || ![0, process.getuid()].includes(stat.uid) ||
        ((stat.mode & 0o022) && !(stat.uid === 0 && (stat.mode & 0o1000)))) fail('UNSAFE_REGISTRATION_ROOT');
    if (await fs.lstat(path.join(ancestor, '.git')).then(() => true, error => { if (error.code !== 'ENOENT') throw error; return false; })) fail('REGISTRATION_ROOT_INSIDE_REPOSITORY');
  }
  const stat = await fs.lstat(root);
  if (stat.uid !== process.getuid() || (stat.mode & 0o077) || await fs.realpath(root) !== root) fail('UNSAFE_REGISTRATION_ROOT');
}
function result(id, binding, status) {
  return { status, repository_id: id, github_repository: { id: binding.repository_id, owner_id: binding.owner_id, full_name: binding.full_name, private: binding.private },
    baseline_commit: binding.baseline_commit, diagnostics: [] };
}
export class GitHubRegistration {
  constructor({ stateRoot, workspaceRoot, root = path.join(homedir(), '.local/share/personal-agents-bridge/repositories'), transport = new GitHubRegistrationTransport(), commitRegistry = writeRegistry }) {
    this.stateRoot = stateRoot; this.workspaceRoot = workspaceRoot; this.root = path.resolve(root);
    this.file = path.join(stateRoot, 'repositories.json'); this.transport = transport; this.commitRegistry = commitRegistry;
  }
  async authorize(name) {
    const user = await this.transport.api('user'), repository = await this.transport.api(`repos/${name}`);
    if (!numericId(user?.id) || user.type !== 'User' || typeof user.login !== 'string' || !numericId(repository?.id) ||
        !validName(repository.full_name) || repository.full_name.toLowerCase() !== name.toLowerCase() ||
        repository.owner?.type !== 'User' || repository.owner.id !== user.id || repository.owner.login?.toLowerCase() !== user.login.toLowerCase() ||
        repository.full_name.split('/')[0].toLowerCase() !== user.login.toLowerCase() || repository.permissions?.pull !== true) fail('GITHUB_REGISTRATION_NOT_OWNER');
    if (repository.id === bridgeGitHubRepositoryId || repository.full_name.toLowerCase() === SELF) fail('BRIDGE_SELF_TARGET');
    if (repository.archived !== false || repository.disabled !== false || typeof repository.private !== 'boolean' ||
        !Number.isSafeInteger(repository.size) || repository.size < 0 || repository.size > 131072 ||
        typeof repository.default_branch !== 'string' || repository.default_branch.length > 200) fail('GITHUB_REGISTRATION_UNSUPPORTED');
    try { repoGit(this.stateRoot, 'check-ref-format', `refs/heads/${repository.default_branch}`); }
    catch { fail('GITHUB_REGISTRATION_INVALID_BRANCH'); }
    return { repository_id: repository.id, owner_id: user.id, full_name: repository.full_name, private: repository.private, default_branch: repository.default_branch };
  }
  async register(input) {
    if (!input || Object.keys(input).length !== 1 || !validName(input.repository)) fail('INVALID_GITHUB_REPOSITORY');
    const target = await this.authorize(input.repository), id = `github_${target.repository_id}`;
    return withRegistryLock(this.file, async () => {
      const registry = await readRegistry(this.file);
      if (Object.hasOwn(registry.repositories, id)) {
        const saved = registry.github_repositories?.[id];
        if (!saved || Object.entries(target).some(([key, value]) => saved[key] !== value)) fail('GITHUB_REGISTRATION_CONFLICT');
        await resolveRepository(this.file, id, 'HEAD', this.workspaceRoot, this.stateRoot);
        return result(id, saved, 'already_registered');
      }
      if (registry.github_repositories && (typeof registry.github_repositories !== 'object' || Array.isArray(registry.github_repositories))) fail('GITHUB_REGISTRATION_CONFLICT');
      if (Object.hasOwn(registry.github_repositories || {}, id)) fail('GITHUB_REGISTRATION_CONFLICT');
      if (Object.keys(registry.repositories).length >= 100) fail('REPOSITORY_REGISTRY_LIMIT');
      for (const saved of Object.values(registry.repositories)) {
        const identity = await repositoryIdentity(saved.path);
        if (JSON.stringify(identity) !== JSON.stringify(saved)) fail('REPOSITORY_PATH_CHANGED');
        const origins = repoGit(saved.path, 'remote', '-v');
        if (origins.toLowerCase().includes(`github.com/${target.full_name.toLowerCase()}`) || origins.toLowerCase().includes(`github.com:${target.full_name.toLowerCase()}`)) fail('GITHUB_REPOSITORY_ALREADY_LOCAL');
      }
      await provisionRoot(this.root, [SOURCE, this.stateRoot, this.workspaceRoot, path.join(homedir(), '.local/state'), path.join(homedir(), '.codex'), path.join(homedir(), '.ssh'), path.join(homedir(), '.config'), path.join(homedir(), '.local/share/personal-agents-bridge/releases')]);
      const destination = path.join(this.root, id);
      if (await fs.lstat(destination).then(() => true, error => { if (error.code !== 'ENOENT') throw error; return false; })) fail('REGISTRATION_DESTINATION_EXISTS');
      const commit = await this.transport.api(`repos/${target.full_name}/commits/${encodeURIComponent(target.default_branch)}`);
      if (!/^[a-f0-9]{40}$/.test(commit?.sha || '')) fail('GITHUB_REGISTRATION_BASELINE_UNAVAILABLE');
      const binding = { ...target, baseline_commit: commit.sha };
      const stage = path.join(this.root, `.stage-${id}`);
      try { await fs.mkdir(stage, { mode: 0o700 }); }
      catch (error) { if (error.code === 'EEXIST') fail('REGISTRATION_INCOMPLETE_REQUIRES_INSPECTION'); throw error; }
      let published = false, fetchCompleted = false;
      try {
        repoGit(stage, 'init', '--template=', `--initial-branch=${target.default_branch}`);
        repoGit(stage, 'remote', 'add', 'origin', `https://github.com/${target.full_name}.git`);
        await this.transport.fetch(stage, target);
        fetchCompleted = true;
        if (repoGit(stage, 'rev-parse', '--verify', `refs/remotes/origin/${target.default_branch}^{commit}`).trim() !== binding.baseline_commit) fail('GITHUB_REGISTRATION_BASELINE_CHANGED');
        const entries = repoGit(stage, 'ls-tree', '-r', '-l', '-z', binding.baseline_commit).split('\0').filter(Boolean);
        let bytes = 0;
        if (entries.length > 20000) fail('REGISTRATION_CONTENT_LIMIT');
        for (const entry of entries) {
          const match = /^(100644|100755) blob [a-f0-9]{40}\s+(\d+)\t([^\0]+)$/.exec(entry);
          if (!match || match[3].split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git') || match[3].includes('\\')) fail('REGISTRATION_UNSUPPORTED_ENTRY');
          bytes += Number(match[2]);
        }
        if (bytes > 128 * 1024 * 1024) fail('REGISTRATION_CONTENT_LIMIT');
        repoGit(stage, '-c', 'core.attributesFile=/dev/null', 'reset', '--hard', binding.baseline_commit);
        if (repoGit(stage, 'status', '--porcelain')) fail('REGISTRATION_CHECKOUT_INVALID');
        const confirmed = await this.authorize(target.full_name);
        if (JSON.stringify(confirmed) !== JSON.stringify(target)) fail('GITHUB_REGISTRATION_IDENTITY_CHANGED');
        if (await fs.lstat(destination).then(() => true, error => { if (error.code !== 'ENOENT') throw error; return false; })) fail('REGISTRATION_DESTINATION_EXISTS');
        await fs.rename(stage, destination); published = true;
        const directory = await fs.open(this.root, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
        const identity = await repositoryIdentity(destination);
        registry.repositories[id] = identity;
        registry.github_repositories ||= {};
        registry.github_repositories[id] = binding;
        await this.commitRegistry(this.file, registry);
        await resolveRepository(this.file, id, 'HEAD', this.workspaceRoot, this.stateRoot);
        return result(id, binding, 'registered');
      } finally {
        if (!published && fetchCompleted) await fs.rm(stage, { recursive: true, force: true });
      }
    });
  }
  async list() {
    const registry = await readRegistry(this.file), repositories = [];
    if (Object.keys(registry.repositories).length > 100) fail('REPOSITORY_REGISTRY_LIMIT');
    for (const id of Object.keys(registry.repositories).sort()) {
      if (!repositoryIdPattern.test(id)) fail('INVALID_REPOSITORY_ID');
      try {
        const resolved = await resolveRepository(this.file, id, 'HEAD', this.workspaceRoot, this.stateRoot);
        if (resolved.github_identity) repositories.push(result(id, resolved.github_identity, 'registered'));
        else {
          let name = null;
          try {
            const candidate = githubRepository(repoGit(resolved.canonical_path, 'remote', 'get-url', 'origin').trim());
            if (validName(candidate)) name = candidate;
          } catch {}
          repositories.push({ status: 'registered', repository_id: id, github_repository: name ? { full_name: name } : null, baseline_commit: resolved.baseline_commit, diagnostics: ['LOCAL_OPERATOR_REGISTRATION'] });
        }
      } catch { repositories.push({ status: 'unavailable', repository_id: id, github_repository: null, baseline_commit: null, diagnostics: ['REGISTRATION_REQUIRES_OPERATOR_INSPECTION'] }); }
    }
    return { repositories };
  }
}
