import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { deflateSync } from 'node:zlib';
import { Controller } from '../controller.mjs';
import { repoGit } from '../repositories.mjs';

const execute = promisify(execFile);
async function fixture(context) {
  const root = await fs.mkdtemp('/tmp/pab-reference-race-'), repo = path.join(root, 'repo');
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(repo, 'nested'), { recursive: true });
  await fs.mkdir(path.join(root, 'outside'));
  await fs.writeFile(path.join(repo, 'nested/source.py'), 'baseline\n');
  await fs.writeFile(path.join(root, 'outside/source.py'), 'baseline\n');
  repoGit(repo, 'init', '--initial-branch=main'); repoGit(repo, 'add', '.');
  repoGit(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'baseline');
  const baseline = repoGit(repo, 'rev-parse', 'HEAD').trim();
  const contract = { allowed_files: ['guide.md'], reference_files: ['nested/source.py'] };
  return { root, repo, baseline, contract };
}

for (const race of ['fifo', 'ancestor_symlink', 'ancestor_after_open', 'file_after_pin']) test(`descriptor-relative reference reader rejects ${race} without an outside or special-file read`, async context => {
  const value = await fixture(context);
  const script = `
    import { promises as fs } from 'node:fs';
    import { execFileSync } from 'node:child_process';
    import { Controller } from ${JSON.stringify(new URL('../controller.mjs', import.meta.url).href)};
    const {root, repo, baseline, contract} = ${JSON.stringify(value)};
    const race = ${JSON.stringify(race)}, original = fs.open;
    let changed = false, outsideReads = 0, rejected = false, specialReads = 0;
    async function replaceAncestor() {
      await fs.rename(repo + '/nested', root + '/saved');
      await fs.symlink(root + '/outside', repo + '/nested');
    }
    fs.open = async function(target, ...args) {
      const name = String(target);
      if (!changed && race === 'fifo' && name.endsWith('/source.py')) {
        changed = true;
        await fs.rename(repo + '/nested/source.py', root + '/original.py');
        execFileSync('/usr/bin/mkfifo', [repo + '/nested/source.py']);
      }
      if (!changed && race === 'ancestor_symlink' && (name.endsWith('/nested') || name === repo + '/nested/source.py')) {
        changed = true; await replaceAncestor();
      }
      const handle = await original.call(fs, target, ...args);
      if (!changed && race === 'ancestor_after_open' && name.endsWith('/nested')) {
        changed = true; await replaceAncestor();
      }
      if (!changed && race === 'file_after_pin' && name.endsWith('/source.py')) {
        changed = true;
        await fs.rename(repo + '/nested/source.py', root + '/original.py');
        await fs.symlink(root + '/outside/source.py', repo + '/nested/source.py');
      }
      const read = handle.read.bind(handle);
      handle.read = async (...values) => {
        if ((await fs.readlink('/proc/self/fd/' + handle.fd)).startsWith(root + '/outside/')) outsideReads++;
        if (!(await handle.stat()).isFile()) specialReads++;
        return read(...values);
      };
      return handle;
    };
    try { await Controller.prototype.localReferenceEvidence.call({safe: text => text}, repo, baseline, contract); }
    catch (error) { rejected = /^LOCAL_REFERENCE_/.test(error.code); }
    console.log(JSON.stringify({changed, outsideReads, specialReads, rejected}));
  `;
  const result = await execute(process.execPath, ['--input-type=module', '-e', script], {
    timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 4096,
    env: { PATH: '/usr/bin:/bin', LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH || '' },
  });
  assert.deepEqual(JSON.parse(result.stdout), { changed: true, outsideReads: 0, specialReads: 0, rejected: true });
});

for (const verifyWorktree of [false, true]) test(`valid replacement blob under corrupted intermediate tree is rejected (worktree=${verifyWorktree})`, async context => {
  const value = await fixture(context), tree = repoGit(value.repo, 'rev-parse', `${value.baseline}:nested`).trim();
  await fs.writeFile(path.join(value.repo, 'replacement'), 'attacker\n');
  const blob = repoGit(value.repo, 'hash-object', '-w', 'replacement').trim();
  const bytes = Buffer.concat([Buffer.from('100644 source.py\0'), Buffer.from(blob, 'hex')]);
  const object = path.join(value.repo, '.git/objects', tree.slice(0, 2), tree.slice(2));
  await fs.chmod(object, 0o600);
  await fs.writeFile(object, deflateSync(Buffer.concat([Buffer.from(`tree ${bytes.length}\0`), bytes])));
  await fs.writeFile(path.join(value.repo, 'nested/source.py'), 'attacker\n');
  assert.equal(repoGit(value.repo, 'show', `${value.baseline}:nested/source.py`), 'attacker\n');
  await assert.rejects(Controller.prototype.localReferenceEvidence.call({ safe: text => text }, value.repo, value.baseline, value.contract, verifyWorktree),
    { code: 'LOCAL_REFERENCE_OBJECT_INTEGRITY' });
});

for (const type of ['commit', 'root_tree', 'blob', 'missing_tree']) test(`reference capture and revalidation reject ${type} object corruption`, async context => {
  const value = await fixture(context);
  const oid = type === 'commit' ? value.baseline : repoGit(value.repo, 'rev-parse', type === 'root_tree' ? `${value.baseline}^{tree}` :
    type === 'blob' ? `${value.baseline}:nested/source.py` : `${value.baseline}:nested`).trim();
  const file = path.join(value.repo, '.git/objects', oid.slice(0, 2), oid.slice(2));
  if (type === 'missing_tree') await fs.unlink(file);
  else {
    const objectType = type === 'root_tree' ? 'tree' : type;
    await fs.chmod(file, 0o600);
    await fs.writeFile(file, deflateSync(Buffer.from(`${objectType} 1\0x`)));
  }
  for (const verifyWorktree of [false, true]) await assert.rejects(Controller.prototype.localReferenceEvidence.call({ safe: text => text },
    value.repo, value.baseline, value.contract, verifyWorktree), error => /^LOCAL_REFERENCE_/.test(error.code));
});

test('authenticated reference chains work with packed objects', async context => {
  const value = await fixture(context);
  repoGit(value.repo, 'repack', '-ad'); repoGit(value.repo, 'prune-packed');
  const evidence = await Controller.prototype.localReferenceEvidence.call({ safe: text => text }, value.repo, value.baseline, value.contract);
  assert.equal(evidence.files[0].content, 'baseline\n');
});
