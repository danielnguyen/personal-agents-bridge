import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const source = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
test('real Linux sandbox denies controller/source reads and reviewer writes', async t => {
  const root = await fs.mkdtemp('/var/tmp/personal-agents-bridge/isolation-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace'), runtime = path.join(root, 'runtime');
  await fs.mkdir(workspace); await fs.mkdir(runtime); await fs.writeFile(path.join(workspace, 'input.txt'), 'original');
  const code = `import pathlib,sys\np=pathlib.Path('input.txt')\nassert p.read_text()=='original'\ntry:\n pathlib.Path(sys.argv[1]).read_text()\n raise AssertionError('controller source readable')\nexcept PermissionError: pass\ntry:\n p.write_text('changed')\n raise AssertionError('reviewer wrote file')\nexcept PermissionError: pass\nprint('sandbox checks passed')\n`;
  const out = execFileSync('/usr/bin/python3', ['-B', path.join(source, 'isolate.py'), workspace, runtime, 'reviewer', '/usr/bin/python3', '-B', '-c', code, path.join(source, 'controller.mjs')], { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, encoding: 'utf8' });
  assert.equal(out.trim(), 'sandbox checks passed'); assert.equal(await fs.readFile(path.join(workspace, 'input.txt'), 'utf8'), 'original');
});
