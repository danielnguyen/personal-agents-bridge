import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const interrupted = signal => { if (signal?.aborted) fail('REGISTRATION_INTERRUPTED'); };

export async function validateManagedTree(directory, commit, git) {
  const entries = (await git(directory, 'ls-tree', '-r', '-l', '-z', commit)).split('\0').filter(Boolean);
  if (entries.length > 20000) fail('REGISTRATION_CONTENT_LIMIT');
  const files = new Map(); let bytes = 0;
  for (const entry of entries) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\s+(\d+)\t([^\0]+)$/s.exec(entry);
    if (!match || match[4].includes('\ufffd') || match[4].includes('\\') ||
        match[4].split('/').some(part => !part || ['.', '..', '.git'].includes(part.toLowerCase()))) fail('REGISTRATION_UNSUPPORTED_ENTRY');
    const [, mode, object, size, name] = match;
    bytes += Number(size);
    if (!Number.isSafeInteger(bytes) || bytes > 128 * 1024 * 1024) fail('REGISTRATION_CONTENT_LIMIT');
    if (files.has(name)) fail('REGISTRATION_UNSUPPORTED_ENTRY');
    files.set(name, { mode, object, size: Number(size) });
  }
  return files;
}

async function inventory(root, signal) {
  const entries = new Map(); let bytes = 0;
  async function visit(relative) {
    interrupted(signal);
    const target = path.join(root, relative), stat = await fs.lstat(target);
    if (stat.uid !== process.getuid() || stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) ||
        (stat.isFile() && stat.nlink !== 1) || (!relative && (stat.mode & 0o077))) fail('REGISTRATION_STORAGE_INVALID');
    entries.set(relative, stat);
    bytes += stat.isFile() ? stat.size : 0;
    if (entries.size > 100000 || bytes > 512 * 1024 * 1024) fail('REGISTRATION_CONTENT_LIMIT');
    if (stat.isDirectory()) for (const name of await fs.readdir(target)) await visit(relative ? `${relative}/${name}` : name);
  }
  await visit('');
  return entries;
}

function storageShape(entries) {
  for (const name of ['.git', '.git/objects', '.git/objects/info', '.git/objects/pack', '.git/refs', '.git/refs/heads', '.git/refs/tags']) {
    if (!entries.get(name)?.isDirectory()) fail('REGISTRATION_STORAGE_INVALID');
  }
  for (const name of ['.git/HEAD', '.git/config', '.git/index']) if (!entries.get(name)?.isFile()) fail('REGISTRATION_STORAGE_INVALID');
  for (const [name, stat] of entries) {
    if (!name.startsWith('.git/')) continue;
    const suffix = name.slice(5);
    const allowed = stat.isDirectory()
      ? /^(objects(?:\/(?:info|pack|[a-f0-9]{2}))?|refs(?:\/(?:heads|tags|remotes)(?:\/[A-Za-z0-9._/-]+)?)?|logs(?:\/refs(?:\/(?:heads|remotes)(?:\/[A-Za-z0-9._/-]+)?)?)?|info|hooks)$/
      : /^(HEAD|config|index|packed-refs|ORIG_HEAD|description|info\/exclude|objects\/[a-f0-9]{2}\/[a-f0-9]{38}|objects\/pack\/pack-[a-f0-9]{40}\.(pack|idx|rev)|refs\/(?:heads|tags|remotes)\/[A-Za-z0-9._/-]+|logs\/(?:HEAD|refs\/(?:heads|remotes)\/[A-Za-z0-9._/-]+))$/;
    if (!allowed.test(suffix)) fail('REGISTRATION_STORAGE_INVALID');
  }
}

export async function verifyManagedCheckout(directory, commit, git, signal) {
  const entries = await inventory(directory, signal);
  storageShape(entries);
  const configuration = (await git(directory, 'config', '--local', '--list')).trim().split('\n');
  const allowed = /^(core\.(?:repositoryformatversion=0|filemode=true|bare=false|logallrefupdates=true)|remote\.origin\.(?:url=https:\/\/github\.com\/[A-Za-z0-9_.\/-]+\.git|fetch=\+refs\/heads\/\*:refs\/remotes\/origin\/\*))$/;
  if (configuration.some(line => !allowed.test(line)) || new Set(configuration.map(line => line.split('=')[0])).size !== configuration.length) fail('REGISTRATION_STORAGE_INVALID');
  if ((await git(directory, 'fsck', '--full', '--strict', '--no-reflogs')).trim()) fail('REGISTRATION_STORAGE_INVALID');
  const files = await validateManagedTree(directory, commit, git);
  const index = (await git(directory, 'ls-files', '--stage', '-z')).split('\0').filter(Boolean);
  if (index.length !== files.size || index.some(entry => {
    const match = /^(100644|100755) ([a-f0-9]{40}) 0\t(.+)$/s.exec(entry);
    const file = match && files.get(match[3]);
    return !file || file.mode !== match[1] || file.object !== match[2];
  })) fail('REGISTRATION_CHECKOUT_INVALID');
  const directories = new Set(['']);
  for (const name of files.keys()) {
    for (let parent = path.posix.dirname(name); parent !== '.'; parent = path.posix.dirname(parent)) directories.add(parent);
  }
  for (const [name, stat] of entries) {
    if (name === '.git' || name.startsWith('.git/')) continue;
    if (stat.isDirectory()) {
      if (!directories.has(name)) fail('REGISTRATION_CHECKOUT_INVALID');
      continue;
    }
    const file = files.get(name);
    if (!file || stat.size !== file.size || (stat.mode & 0o777) !== (file.mode === '100755' ? 0o755 : 0o644)) fail('REGISTRATION_CHECKOUT_INVALID');
    const handle = await fs.open(path.join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (before.dev !== stat.dev || before.ino !== stat.ino || before.size !== stat.size) fail('REGISTRATION_CHECKOUT_INVALID');
      const hash = createHash('sha1').update(`blob ${stat.size}\0`);
      for await (const chunk of handle.createReadStream({ autoClose: false })) { interrupted(signal); hash.update(chunk); }
      const after = await handle.stat();
      if (hash.digest('hex') !== file.object || after.ctimeMs !== before.ctimeMs || after.mtimeMs !== before.mtimeMs) fail('REGISTRATION_CHECKOUT_INVALID');
    } finally { await handle.close(); }
    files.delete(name);
  }
  if (files.size) fail('REGISTRATION_CHECKOUT_INVALID');
}

export async function synchronizeCheckout(directory, signal, syncHandle = handle => handle.sync()) {
  const entries = await inventory(directory, signal);
  for (const [name, stat] of [...entries].reverse()) {
    interrupted(signal);
    const handle = await fs.open(path.join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | (stat.isDirectory() ? constants.O_DIRECTORY : 0));
    try {
      const current = await handle.stat();
      if (stat.dev !== current.dev || stat.ino !== current.ino || stat.size !== current.size || stat.mtimeMs !== current.mtimeMs) fail('REGISTRATION_SYNC_CHANGED');
      await syncHandle(handle);
    } finally { await handle.close(); }
  }
}
