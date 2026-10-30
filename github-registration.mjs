import { promises as fs } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { asynchronousRepoGit, registrationProcess, repositoryIdentity, repositoryIdPattern, readRegistry, resolveRepository, withRegistryLock, writeRegistry } from './repositories.mjs';
import { validateManagedTree, verifyManagedCheckout, synchronizeCheckout } from './github-repository-integrity.mjs';
import { githubRepository } from './publication.mjs';

const SOURCE = path.dirname(fileURLToPath(import.meta.url));
const SELF = 'danielnguyen/personal-agents-bridge';
export const bridgeGitHubRepositoryId = 1388046916;
export const githubNamePattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/;
export class RegistrationError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = code => { throw new RegistrationError(code); };
const overlaps = (first, second) => first === second || first.startsWith(second + path.sep) || second.startsWith(first + path.sep);
const numericId = value => Number.isSafeInteger(value) && value > 0;
export function validName(value) {
  return typeof value === 'string' && githubNamePattern.test(value) && !/\s/.test(value) && !['.', '..'].includes(value.split('/')[1]) && !value.endsWith('.git');
}
function environment(network = false) {
  return { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1',
    ...(network ? { HOME: homedir(), GH_TOKEN: process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '', GH_PROMPT_DISABLED: '1' } : {}) };
}
export class GitHubRegistrationTransport {
  constructor(run = registrationProcess) { this.run = run; }
  async api(endpoint, signal) {
    try { return JSON.parse(await this.run('/usr/bin/gh', ['api', '--hostname', 'github.com', '--method', 'GET', endpoint], {
      env: environment(true), signal, timeout: 15000, maxBuffer: 128 * 1024,
    })); } catch (error) { this.failure(error, 'GITHUB_REGISTRATION_ACCESS_UNAVAILABLE'); }
  }
  failure(error, code) {
    fail(['REGISTRATION_INTERRUPTED', 'REGISTRATION_TERMINATION_UNCERTAIN'].includes(error.code) ? error.code : code);
  }
  async fetch(directory, target, signal, commit) {
    if (commit !== undefined && !/^[a-f0-9]{40}$/.test(commit)) fail('GITHUB_REGISTRATION_BASELINE_UNAVAILABLE');
    try {
      await this.run('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
        '-c', 'credential.helper=', '-c', 'credential.helper=!/usr/bin/gh auth git-credential', '-c', 'credential.interactive=false',
        '-c', 'http.followRedirects=false', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'fetch.fsckObjects=true',
        'fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--', `https://github.com/${target.full_name}.git`,
        commit ?? `refs/heads/${target.default_branch}:refs/remotes/origin/${target.default_branch}`], {
        cwd: directory, env: environment(true), signal, timeout: 120000,
      });
    } catch (error) { this.failure(error, 'GITHUB_REGISTRATION_FETCH_FAILED'); }
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
      const parent = await fs.open(path.dirname(ancestor), 'r');
      try { await parent.sync(); } finally { await parent.close(); }
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
async function publishCheckout(stage, destination) {
  await fs.rename(stage, destination);
  const directory = await fs.open(path.dirname(destination), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
export class GitHubRegistration {
  constructor({ stateRoot, workspaceRoot, root = path.join(homedir(), '.local/share/personal-agents-bridge/repositories'), transport = new GitHubRegistrationTransport(), commitRegistry = writeRegistry, synchronize = synchronizeCheckout, publish = publishCheckout }) {
    this.stateRoot = stateRoot; this.workspaceRoot = workspaceRoot; this.root = path.resolve(root);
    this.file = path.join(stateRoot, 'repositories.json'); this.transport = transport; this.commitRegistry = commitRegistry;
    this.abort = new AbortController(); this.git = asynchronousRepoGit(this.abort.signal); this.synchronize = synchronize;
    this.publish = publish;
    this.terminationUncertain = false;
  }
  cancel() { this.abort.abort(); }
  checkActive() { if (this.abort.signal.aborted) fail('REGISTRATION_INTERRUPTED'); }
  async authorize(name) {
    this.checkActive();
    const user = await this.transport.api('user', this.abort.signal), repository = await this.transport.api(`repos/${name}`, this.abort.signal);
    if (!numericId(user?.id) || user.type !== 'User' || typeof user.login !== 'string' || !numericId(repository?.id) ||
        !validName(repository.full_name) || repository.full_name.toLowerCase() !== name.toLowerCase() ||
        repository.owner?.type !== 'User' || repository.owner.id !== user.id || repository.owner.login?.toLowerCase() !== user.login.toLowerCase() ||
        repository.full_name.split('/')[0].toLowerCase() !== user.login.toLowerCase() || repository.permissions?.pull !== true) fail('GITHUB_REGISTRATION_NOT_OWNER');
    if (repository.id === bridgeGitHubRepositoryId || repository.full_name.toLowerCase() === SELF) fail('BRIDGE_SELF_TARGET');
    if (repository.archived !== false || repository.disabled !== false || typeof repository.private !== 'boolean' ||
        !Number.isSafeInteger(repository.size) || repository.size < 0 || repository.size > 131072 ||
        typeof repository.default_branch !== 'string' || repository.default_branch.length > 200) fail('GITHUB_REGISTRATION_UNSUPPORTED');
    try { await this.git(this.stateRoot, 'check-ref-format', `refs/heads/${repository.default_branch}`); }
    catch (error) { this.checkActive(); this.transportFailure(error); fail('GITHUB_REGISTRATION_INVALID_BRANCH'); }
    return { repository_id: repository.id, owner_id: user.id, full_name: repository.full_name, private: repository.private, default_branch: repository.default_branch };
  }
  async register(input) {
    try { return await this.registerVerified(input); }
    catch (error) { this.transportFailure(error); throw error; }
  }
  transportFailure(error) {
    if (error.code === 'REGISTRATION_TERMINATION_UNCERTAIN') { this.terminationUncertain = true; this.cancel(); throw error; }
  }
  async registerVerified(input) {
    if (!input || Object.keys(input).length !== 1 || !validName(input.repository)) fail('INVALID_GITHUB_REPOSITORY');
    const target = await this.authorize(input.repository), id = `github_${target.repository_id}`;
    return withRegistryLock(this.file, async () => {
      const registry = await readRegistry(this.file);
      if (Object.hasOwn(registry.repositories, id)) {
        const saved = registry.github_repositories?.[id];
        if (!saved || Object.entries(target).some(([key, value]) => saved[key] !== value)) fail('GITHUB_REGISTRATION_CONFLICT');
        await resolveRepository(this.file, id, 'HEAD', this.workspaceRoot, this.stateRoot, this.git);
        await this.synchronize(registry.repositories[id].path, this.abort.signal);
        for (const name of [this.file, this.stateRoot]) {
          const handle = await fs.open(name, 'r');
          try { await handle.sync(); } finally { await handle.close(); }
        }
        await resolveRepository(this.file, id, 'HEAD', this.workspaceRoot, this.stateRoot, this.git);
        return result(id, saved, 'already_registered');
      }
      if (registry.github_repositories && (typeof registry.github_repositories !== 'object' || Array.isArray(registry.github_repositories))) fail('GITHUB_REGISTRATION_CONFLICT');
      if (Object.hasOwn(registry.github_repositories || {}, id)) fail('GITHUB_REGISTRATION_CONFLICT');
      if (Object.keys(registry.repositories).length >= 100) fail('REPOSITORY_REGISTRY_LIMIT');
      for (const saved of Object.values(registry.repositories)) {
        const identity = await repositoryIdentity(saved.path, this.git);
        if (JSON.stringify(identity) !== JSON.stringify(saved)) fail('REPOSITORY_PATH_CHANGED');
        const origins = await this.git(saved.path, 'remote', '-v');
        for (const entry of origins.trim().split('\n')) {
          let name;
          try { name = githubRepository(entry.split(/\s+/)[1]?.replace(/^(https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)/i, prefix => prefix.toLowerCase())); } catch { continue; }
          if (name.toLowerCase() === target.full_name.toLowerCase()) fail('GITHUB_REPOSITORY_ALREADY_LOCAL');
        }
      }
      await provisionRoot(this.root, [SOURCE, this.stateRoot, this.workspaceRoot, path.join(homedir(), '.local/state'), path.join(homedir(), '.codex'), path.join(homedir(), '.ssh'), path.join(homedir(), '.config'), path.join(homedir(), '.local/share/personal-agents-bridge/releases')]);
      const destination = path.join(this.root, id);
      if (await fs.lstat(destination).then(() => true, error => { if (error.code !== 'ENOENT') throw error; return false; })) fail('REGISTRATION_DESTINATION_EXISTS');
      const commit = await this.transport.api(`repos/${target.full_name}/commits/${encodeURIComponent(target.default_branch)}`, this.abort.signal);
      if (!/^[a-f0-9]{40}$/.test(commit?.sha || '')) fail('GITHUB_REGISTRATION_BASELINE_UNAVAILABLE');
      const binding = { ...target, baseline_commit: commit.sha };
      const stage = path.join(this.root, `.stage-${id}`);
      try { await fs.mkdir(stage, { mode: 0o700 }); }
      catch (error) { if (error.code === 'EEXIST') fail('REGISTRATION_INCOMPLETE_REQUIRES_INSPECTION'); throw error; }
      let registryAttempted = false;
      try {
        await this.git(stage, 'init', '--template=', `--initial-branch=${target.default_branch}`);
        await this.git(stage, 'remote', 'add', 'origin', `https://github.com/${target.full_name}.git`);
        await this.transport.fetch(stage, target, this.abort.signal);
        if ((await this.git(stage, 'rev-parse', '--verify', `refs/remotes/origin/${target.default_branch}^{commit}`)).trim() !== binding.baseline_commit) fail('GITHUB_REGISTRATION_BASELINE_CHANGED');
        await this.git(stage, 'fsck', '--full', '--strict');
        await validateManagedTree(stage, binding.baseline_commit, this.git);
        await this.git(stage, '-c', 'core.attributesFile=/dev/null', 'reset', '--hard', binding.baseline_commit);
        await verifyManagedCheckout(stage, binding.baseline_commit, this.git, this.abort.signal);
        const confirmed = await this.authorize(target.full_name);
        if (JSON.stringify(confirmed) !== JSON.stringify(target)) fail('GITHUB_REGISTRATION_IDENTITY_CHANGED');
        await this.synchronize(stage, this.abort.signal);
        await verifyManagedCheckout(stage, binding.baseline_commit, this.git, this.abort.signal);
        this.checkActive();
        if (await fs.lstat(destination).then(() => true, error => { if (error.code !== 'ENOENT') throw error; return false; })) fail('REGISTRATION_DESTINATION_EXISTS');
        await this.publish(stage, destination);
        const identity = await repositoryIdentity(destination, this.git);
        await verifyManagedCheckout(destination, binding.baseline_commit, this.git, this.abort.signal);
        registry.repositories[id] = identity;
        registry.github_repositories ||= {};
        registry.github_repositories[id] = binding;
        this.checkActive(); registryAttempted = true;
        await this.commitRegistry(this.file, registry);
        await resolveRepository(this.file, id, 'HEAD', this.workspaceRoot, this.stateRoot, this.git);
        return result(id, binding, 'registered');
      } catch (error) {
        this.transportFailure(error);
        if (registryAttempted) fail('REGISTRATION_PUBLICATION_UNCERTAIN');
        throw error;
      }
    });
  }
  // Only new task admission may synchronize. Discovery, retries and historical
  // resolution never acquire network authority or move the registration baseline.
  async resolveForTask(id, baseRef) {
    try {
      const registry = await readRegistry(this.file);
      if (!registry.github_repositories?.[id]) return resolveRepository(this.file, id, baseRef, this.workspaceRoot, this.stateRoot);
      return await withRegistryLock(this.file, async () => {
        this.checkActive();
        const registered = await resolveRepository(this.file, id, baseRef, this.workspaceRoot, this.stateRoot, this.git);
        const saved = registered.github_identity;
        if (baseRef === 'HEAD' || /^[a-f0-9]{40}$/.test(baseRef) ||
            ![saved.default_branch, `refs/heads/${saved.default_branch}`].includes(baseRef)) return registered;
        const target = await this.authorize(saved.full_name);
        if (Object.entries(target).some(([key, value]) => saved[key] !== value)) fail('GITHUB_REGISTRATION_IDENTITY_CHANGED');
        const endpoint = `repos/${target.full_name}/commits/${encodeURIComponent(target.default_branch)}`;
        const selected = await this.transport.api(endpoint, this.abort.signal);
        if (!/^[a-f0-9]{40}$/.test(selected?.sha || '')) fail('GITHUB_REGISTRATION_BASELINE_UNAVAILABLE');
        // Fetch only the API-selected object closure. No destination ref,
        // FETCH_HEAD, checkout, index, configuration or registry write is allowed.
        await this.transport.fetch(registered.canonical_path, target, this.abort.signal, selected.sha);
        const resolved = await resolveRepository(this.file, id, selected.sha, this.workspaceRoot, this.stateRoot, this.git);
        const confirmed = await this.authorize(saved.full_name);
        if (JSON.stringify(confirmed) !== JSON.stringify(target)) fail('GITHUB_REGISTRATION_IDENTITY_CHANGED');
        if ((await this.transport.api(endpoint, this.abort.signal))?.sha !== selected.sha) fail('GITHUB_REGISTRATION_BASELINE_CHANGED');
        await this.synchronize(registered.canonical_path, this.abort.signal);
        await verifyManagedCheckout(registered.canonical_path, saved.baseline_commit, this.git, this.abort.signal);
        this.checkActive();
        return { ...resolved, requested_base_ref: baseRef };
      });
    } catch (error) { this.transportFailure(error); throw error; }
  }
  // Revision callers supply only Controller-verified publication authority.
  // Reuse the selected-object fetch; never install a branch/ref in the checkout.
  async resolveForRevision(id, revision, verify) {
    try {
      return await withRegistryLock(this.file, async () => {
        this.checkActive();
        const registered = await resolveRepository(this.file, id, 'HEAD', this.workspaceRoot, this.stateRoot, this.git);
        const target = await this.authorize(revision.target.repository);
        if (target.default_branch !== revision.target.base || (registered.github_identity &&
            Object.entries(target).some(([key, value]) => registered.github_identity[key] !== value))) fail('REVISION_TARGET_CHANGED');
        await verify(registered);
        await this.transport.fetch(registered.canonical_path, target, this.abort.signal, revision.request.expected_head_sha);
        const resolved = await resolveRepository(this.file, id, revision.request.expected_head_sha, this.workspaceRoot, this.stateRoot, this.git);
        await validateManagedTree(registered.canonical_path, resolved.baseline_commit, this.git);
        if (JSON.stringify(await this.authorize(target.full_name)) !== JSON.stringify(target)) fail('GITHUB_REGISTRATION_IDENTITY_CHANGED');
        await verify(resolved);
        if (registered.github_identity) {
          await this.synchronize(registered.canonical_path, this.abort.signal);
          await verifyManagedCheckout(registered.canonical_path, registered.github_identity.baseline_commit, this.git, this.abort.signal);
        }
        this.checkActive();
        return { ...resolved, revision_identity: target };
      });
    } catch (error) { this.transportFailure(error); throw error; }
  }
  async list() {
    this.checkActive();
    const registry = await readRegistry(this.file), repositories = [];
    if (Object.keys(registry.repositories).length > 100) fail('REPOSITORY_REGISTRY_LIMIT');
    for (const id of Object.keys(registry.repositories).sort()) {
      if (!repositoryIdPattern.test(id)) fail('INVALID_REPOSITORY_ID');
      try {
        const resolved = await resolveRepository(this.file, id, 'HEAD', this.workspaceRoot, this.stateRoot, this.git);
        if (resolved.github_identity) repositories.push(result(id, resolved.github_identity, 'registered'));
        else {
          let name = null;
          try {
            const candidate = githubRepository((await this.git(resolved.canonical_path, 'remote', 'get-url', 'origin')).trim());
            if (validName(candidate)) name = candidate;
          } catch (error) { this.transportFailure(error); this.checkActive(); }
          repositories.push({ status: 'registered', repository_id: id, github_repository: name ? { full_name: name } : null, baseline_commit: resolved.baseline_commit, diagnostics: ['LOCAL_OPERATOR_REGISTRATION'] });
        }
      } catch (error) { this.transportFailure(error); repositories.push({ status: 'unavailable', repository_id: id, github_repository: null, baseline_commit: null, diagnostics: ['REGISTRATION_REQUIRES_OPERATOR_INSPECTION'] }); }
    }
    return { repositories };
  }
}
