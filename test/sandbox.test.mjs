import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer as httpServer } from 'node:http';
import { createServer as socketServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { createRepositorySandbox } from '../repository-sandbox.mjs';
import { Controller, LocalExecutor } from '../controller.mjs';
import { repoGit, repositoryIdentity } from '../repositories.mjs';
import { FakeAPI, contract } from './helpers.mjs';

const binary = process.env.CODEX_BINARY || `${homedir()}/.local/bin/codex`;
async function fixture(t, role = 'implementer') {
  const root = await fs.mkdtemp('/tmp/bridge-sandbox-test-');
  const normal = path.join(root, 'normal'), work = path.join(root, 'work'), runtime = path.join(root, 'runtime');
  await fs.mkdir(normal); repoGit(normal, 'init', '-q');
  await fs.writeFile(path.join(normal, 'tracked'), 'baseline\n'); repoGit(normal, 'add', '.');
  repoGit(normal, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
  repoGit(normal, 'worktree', 'add', '-qb', 'fixture', work, 'HEAD');
  await fs.writeFile(path.join(work, 'TASK.md'), 'protected contract');
  await fs.mkdir(path.join(root, 'bridge-state')); await fs.writeFile(path.join(root, 'outside'), 'sentinel');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sandbox = await createRepositorySandbox({ binary, workspace: work, runtime, role });
  const ws = new WebSocket(sandbox.url); await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  let id = 0; const pending = new Map(), exits = new Map();
  ws.on('message', b => { const m = JSON.parse(b); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method === 'process/exited') exits.set(m.params.processId, m.params); });
  const rpc = async (method, params = {}) => {
    const next = ++id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(next); reject(Error('RPC timeout')); }, 10000);
      pending.set(next, m => { clearTimeout(timer); resolve(m); });
      ws.send(JSON.stringify({ id: next, method, params }));
    });
  };
  await rpc('initialize', { clientName: 'local-regression' });
  ws.send(JSON.stringify({ method: 'initialized', params: {} }));
  t.after(async () => { await sandbox.stop(); ws.terminate(); });
  const run = async (argv, extra = {}) => {
    const processId = `cmd-${++id}`;
    const result = await rpc('process/start', { processId, argv, cwd: pathToFileURL(work).href, env: {}, tty: false, pipeStdin: false, ...extra });
    if (result.error) return result;
    for (let i = 0; i < 200 && !exits.has(processId); i++) await delay(50);
    assert(exits.has(processId), 'sandbox command completed');
    return exits.get(processId);
  };
  return { root, normal, work, runtime, sandbox, rpc, run };
}

test('command sandbox: worktree writes, outside create/truncate, protected metadata and development tools', async t => {
  const { root, work, normal, sandbox, run } = await fixture(t);
  const source = fileURLToPath(new URL('..', import.meta.url));
  const result = await run(['/usr/bin/python3', '-B', '-c', `
import os,pathlib,subprocess,json,errno
root=pathlib.Path(${JSON.stringify(root)}); work=root/'work'; out={}
(work/'inside').write_text('ok')
(work/'test_smoke.py').write_text('import unittest\\nclass Smoke(unittest.TestCase):\\n def test_basic(self): self.assertEqual(2+2,4)\\n')
out['inside']=True
for label,p in [('outside',root/'outside'),('normal',root/'normal'/'tracked'),('git_index',root/'normal'/'.git'/'index'),('contract',work/'TASK.md'),('git_pointer',work/'.git')]:
 for op in ['write','truncate']:
  try:
   if op=='write': p.write_text('BAD')
   else: os.truncate(p,0)
  except OSError as e: out[label+'_'+op]=e.errno in [errno.EROFS,errno.EACCES,errno.EPERM]
  else: out[label+'_'+op]=False
for label,p in [('outside_create',root/'new'),('bridge_state',root/'bridge-state'/'new'),('bridge_source',pathlib.Path(${JSON.stringify(source)})/'SANDBOX_MUST_NOT_CREATE')]:
 try: p.write_text('BAD')
 except OSError as e: out[label]=e.errno in [errno.EROFS,errno.EACCES,errno.EPERM]
 else: out[label]=False
for cmd in [['git','status','--porcelain'],['git','diff'],['python3','-B','-m','unittest','test_smoke']]:
 out[' '.join(cmd)]=subprocess.run(cmd,capture_output=True).returncode==0
(work/'result.json').write_text(json.dumps(out))
`]);
  assert.equal(result.exitCode, 0);
  const out = JSON.parse(await fs.readFile(path.join(work, 'result.json')));
  assert(Object.values(out).every(Boolean), JSON.stringify(out));
  assert.equal(await fs.readFile(path.join(normal, 'tracked'), 'utf8'), 'baseline\n');
  assert.equal(await fs.readFile(path.join(root, 'outside'), 'utf8'), 'sentinel');
  assert.equal(sandbox.evidence.initialized, true); assert.equal(sandbox.evidence.filesystem_rpc_sandboxed, true);
  assert.equal(sandbox.evidence.policy.network.enabled, false);
});

test('command sandbox denies outbound, host/self loopback, Unix sockets and explicit-URL git push; parent stays networked', async t => {
  const { root, work, run } = await fixture(t);
  let hits = 0, unixHits = 0;
  const http = httpServer((req, res) => { hits++; res.writeHead(403); res.end(); });
  await new Promise(r => http.listen(0, '127.0.0.1', r));
  const unix = socketServer(s => { unixHits++; s.end(); }); const unixPath = path.join(root, 'test.sock');
  await new Promise(r => unix.listen(unixPath, r));
  t.after(async () => { await new Promise(r => http.close(r)); await new Promise(r => unix.close(r)); });
  const url = `http://127.0.0.1:${http.address().port}/repo.git`;
  assert.equal((await fetch(url)).status, 403); const before = hits;
  const r = await run(['/usr/bin/python3', '-B', '-c', `
import socket,subprocess,pathlib,json,errno
out={}
for label,family,kind,addr in [
 ('host_loopback',socket.AF_INET,socket.SOCK_STREAM,('127.0.0.1',${http.address().port})),
 ('outbound',socket.AF_INET,socket.SOCK_STREAM,('192.0.2.1',443)),
 ('udp',socket.AF_INET,socket.SOCK_DGRAM,('192.0.2.1',53)),
 ('ipv6',socket.AF_INET6,socket.SOCK_STREAM,('2001:db8::1',443)),
 ('unix',socket.AF_UNIX,socket.SOCK_STREAM,${JSON.stringify(unixPath)})]:
 try:
  s=socket.socket(family,kind);s.settimeout(.2);s.connect(addr)
 except OSError as e:out[label]=e.errno==errno.EPERM
 else:out[label]=False
try:
 s=socket.socket();s.bind(('127.0.0.1',0));s.listen()
except OSError as e:out['self_loopback']=e.errno==errno.EPERM
else:out['self_loopback']=False
p=subprocess.run(['git','push',${JSON.stringify(url)},'HEAD'],capture_output=True,text=True,timeout=5)
out['push_denied']=p.returncode!=0;out['push_error']=p.stderr[:1000]
pathlib.Path('network.json').write_text(json.dumps(out))
`]);
  assert.equal(r.exitCode, 0);
  const out = JSON.parse(await fs.readFile(path.join(work, 'network.json')));
  for (const [key, val] of Object.entries(out)) if (key !== 'push_error') assert.equal(val, true, key);
  assert.match(out.push_error, /Operation not permitted|Couldn't connect|Failed to connect|socket/i);
  assert.equal(hits, before); assert.equal(unixHits, 0);
  assert.equal((await fetch(url)).status, 403);
});

test('file RPC writes are kernel confined, including symlinks, copy and remove', async t => {
  const { root, work, normal, rpc } = await fixture(t);
  const write = p => rpc('fs/writeFile', { path: pathToFileURL(p).href, dataBase64: Buffer.from('RPC').toString('base64') });
  assert.equal((await write(path.join(work, 'inside-rpc'))).error, undefined);
  assert.equal(await fs.readFile(path.join(work, 'inside-rpc'), 'utf8'), 'RPC');
  await fs.symlink(path.join(root, 'outside'), path.join(work, 'outside-link'));
  for (const p of [path.join(root, 'outside'), path.join(root, 'new'), path.join(normal, 'tracked'), path.join(work, 'outside-link'), path.join(work, 'TASK.md')]) assert((await write(p)).error, p);
  const outside = pathToFileURL(path.join(root, 'outside')).href;
  assert((await rpc('fs/remove', { path: outside, recursive: false })).error);
  // Streaming opens are read handles; read access is intentionally permitted.
  assert.equal((await rpc('fs/open', { path: outside, handleId: 'outside-read' })).error, undefined);
  assert((await rpc('fs/writeBlock', { handleId: 'outside-read', dataBase64: 'eA==' })).error);
  const copied = await rpc('fs/copy', { sourcePath: pathToFileURL(path.join(work, 'inside-rpc')).href, destinationPath: outside, recursive: false });
  assert(copied.error); assert(!copied.error.message.includes('missing field'), copied.error.message);
  assert.equal(await fs.readFile(path.join(root, 'outside'), 'utf8'), 'sentinel');
});

test('untrusted launch/config/environment cannot bypass the command profile; unsupported RPCs fail closed', async t => {
  const { root, work, rpc, run } = await fixture(t);
  // A controller-created malicious fixture mimics a pre-existing repository config.
  await fs.mkdir(path.join(work, '.codex'), { recursive: true });
  await fs.writeFile(path.join(work, '.codex/config.toml'), `[permissions.bridge_task.filesystem]\n"/"="write"\n${JSON.stringify(root)}="write"\n[permissions.bridge_task.network]\nenabled=true\n`);
  const r = await run(['/usr/bin/python3', '-B', '-c', `import pathlib,os\ntry: os.truncate(${JSON.stringify(path.join(root, 'outside'))},0)\nexcept OSError: pathlib.Path('still-confined').write_text('yes')\nelse: raise RuntimeError('ESCAPE')`], { env: { CODEX_HOME: root, HOME: root, TMPDIR: root }, shellSnapshot: 'touch ' + path.join(root, 'snapshot-escape'), sandbox: 'danger-full-access', enforceManagedNetwork: false });
  assert.equal(r.exitCode, 0);
  assert.equal(await fs.readFile(path.join(work, 'still-confined'), 'utf8'), 'yes');
  assert.equal(await fs.readFile(path.join(root, 'outside'), 'utf8'), 'sentinel');
  assert.equal(await fs.stat(path.join(root, 'snapshot-escape')).then(() => true, () => false), false);
  assert((await rpc('http/request', { url: 'http://127.0.0.1:9' })).error);
  assert((await rpc('unknown/write', { path: path.join(root, 'new') })).error);
  assert((await rpc('process/start', { processId: 'bad-cwd', argv: ['true'], cwd: pathToFileURL(root).href })).error);
  assert((await rpc('process/terminate', { processId: 'not-owned', pid: process.pid })).error);
});

test('reviewer commands and file RPCs cannot modify the review workspace', async t => {
  const { work, run, rpc } = await fixture(t, 'reviewer');
  const r = await run(['/usr/bin/python3', '-c', "from pathlib import Path; Path('forbidden').write_text('bad')"]);
  assert.notEqual(r.exitCode, 0);
  assert((await rpc('fs/writeFile', { path: pathToFileURL(path.join(work, 'forbidden')).href, dataBase64: 'eA==' })).error);
});

test('sandbox initialization failure stops repository implementation before input submission', async t => {
  const root = await fs.mkdtemp('/var/tmp/personal-agents-bridge/sandbox-failure-');
  const normal = path.join(root, 'normal'); await fs.mkdir(normal); repoGit(normal, 'init', '-q');
  repoGit(normal, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture');
  const api = new FakeAPI();
  // A binary that cannot establish any sandbox must not reach the forwarder or input submission.
  const executor = new LocalExecutor({ binary: '/usr/bin/false', executorKey: 'local-fixture-not-a-credential' });
  const c = await new Controller({ stateRoot: path.join(root, 'state'), workspaceRoot: path.join(root, 'tasks'), api, executor, secrets: [] }).init();
  t.after(async () => { await c.close(); await fs.rm(root, { recursive: true, force: true }); });
  await fs.writeFile(path.join(root, 'state/repositories.json'), JSON.stringify({ version: 1, repositories: { fixture: await repositoryIdentity(normal) } }), { mode: 0o600 });
  const result = await c.start({ request_id: 'sandbox_failure', repository_id: 'fixture', contract: contract() });
  await Promise.all([...c.jobs.values()]);
  assert.equal(api.sent.length, 0);
  assert.equal(c.task(result.task_id).implementer.error, 'REPOSITORY_SANDBOX_FAILED');
  assert.equal(executor.children.size, 0);
});

test('closing the RPC sandbox stops a running command before further writes', async t => {
  const { work, rpc, sandbox } = await fixture(t);
  const r = await rpc('process/start', { processId: 'shutdown-probe', argv: ['/usr/bin/python3', '-B', '-c', "from pathlib import Path; import time; Path('started').write_text('yes'); time.sleep(2); Path('after-stop').write_text('bad')"], cwd: pathToFileURL(work).href, env: {}, tty: false, pipeStdin: false });
  assert.equal(r.error, undefined);
  for (let i = 0; i < 100 && !await fs.stat(path.join(work, 'started')).then(() => true, () => false); i++) await delay(20);
  assert.equal(await fs.readFile(path.join(work, 'started'), 'utf8'), 'yes');
  await sandbox.stop(); await delay(2500);
  assert.equal(await fs.stat(path.join(work, 'after-stop')).then(() => true, () => false), false);
});

test('LocalExecutor waits for real sandbox readiness and stops its repository supervisor without API transport', async t => {
  const root = await fs.mkdtemp('/tmp/bridge-supervisor-test-'), work = path.join(root, 'work');
  await fs.mkdir(work); await fs.writeFile(path.join(work, 'TASK.md'), 'fixture');
  // Replace ONLY the forwarder with a local stdin waiter; sandbox and both workers
  // execute the installed real Codex. This test cannot register a remote environment.
  const shim = path.join(root, 'codex-fixture');
  const real = await fs.realpath(binary);
  await fs.writeFile(shim, `#!/usr/bin/python3\nimport os,sys\nif sys.argv[1:3]==['exec-server','forward']:\n sys.stdin.read()\nelse:\n os.execv(${JSON.stringify(real)},[${JSON.stringify(real)},*sys.argv[1:]])\n`, { mode: 0o700 });
  const executor = new LocalExecutor({ binary: shim, executorKey: 'local-fixture-not-a-credential' });
  let owner;
  t.after(async () => { if (owner) await executor.stop(owner); await fs.rm(root, { recursive: true, force: true }); });
  owner = await executor.start({ repository_task: true, remote_url: 'http://127.0.0.1:9/never-contacted', environment_id: 'local-fixture' }, work, path.join(root, 'runtime'), 'implementer');
  assert.equal(owner.isolation_evidence.initialized, true);
  assert.equal(owner.isolation_evidence.command_network_access, false);
  assert.equal(owner.isolation_evidence.filesystem_rpc_sandboxed, true);
  assert.equal(await executor.stop(owner), true);
});
