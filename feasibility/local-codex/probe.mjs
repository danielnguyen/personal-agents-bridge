import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { AppServerRpc, isolatedEnvironment, requireSubscription } from './rpc.mjs';
import { migrationDecision } from './state.mjs';

const binary = process.argv[2];
if (!binary || !path.isAbsolute(binary) || process.argv.length !== 3) {
  process.stderr.write('Usage: node feasibility/local-codex/probe.mjs /absolute/path/to/codex\n');
  process.exit(2);
}
const root = await fs.mkdtemp('/tmp/pab-codex-probe-');
await fs.chmod(root, 0o700);
const workspace = path.join(root, 'work'), scratch = path.join(root, 'scratch'), control = path.join(root, 'control');
const codexHome = path.join(control, 'codex'), home = path.join(control, 'home');
for (const directory of [workspace, scratch, control, codexHome, home, path.join(workspace, '.codex')]) await fs.mkdir(directory, { mode: 0o700 });
const protectedPaths = [path.join(workspace, '.git'), path.join(workspace, 'TASK.md'), path.join(workspace, '.codex', 'config.toml'), path.join(control, 'sentinel'), path.join(root, 'normal-checkout')];
for (const filename of protectedPaths) await fs.writeFile(filename, 'sentinel', { mode: 0o600 });
await fs.symlink(path.join(control, 'sentinel'), path.join(workspace, 'escape'));
const report = { modelTurnsSubmitted: 0, productionAuthenticationRead: false, checks: {}, migration: migrationDecision() };
let rpc;
try {
  report.version = execFileSync(binary, ['--version'], { env: isolatedEnvironment(home, codexHome, scratch), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  report.binarySha256 = createHash('sha256').update(await fs.readFile(binary)).digest('hex');
  for (const role of ['implementer', 'reviewer']) {
    const filesystem = { '/': 'read', [scratch]: 'write', ...(role === 'implementer' ? { [workspace]: 'write' } : {}),
      ...Object.fromEntries(['.git', 'TASK.md', '.codex'].map(name => [path.join(workspace, name), 'read'])) };
    const table = `{ probe = { filesystem = { ${Object.entries(filesystem).map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`).join(', ')} }, network = { enabled = false } } }`;
    const args = ['-c', `permissions=${table}`, '-c', 'default_permissions="probe"', '-c', 'approval_policy="never"',
      '-c', 'web_search="disabled"', '-c', 'shell_environment_policy.inherit="none"', '-c', 'mcp_servers={}', '-c', 'features.multi_agent=false'];
    rpc = new AppServerRpc(binary, args, { cwd: control, env: isolatedEnvironment(home, codexHome, scratch), timeoutMs: 15000 });
    await rpc.initialize();
    const account = await rpc.request('account/read', { refreshToken: false });
    let rejected = false;
    try { requireSubscription(account); } catch { rejected = true; }
    if (!rejected) throw Error('UNEXPECTED_AUTHENTICATION');
    report.checks[`${role}_unauthenticated_rejected`] = true;
    const code = `import pathlib, socket, errno, json
work=pathlib.Path(${JSON.stringify(workspace)})
scratch=pathlib.Path(${JSON.stringify(scratch)})
checks={}
(scratch/'allowed').write_text('ok')
checks['scratch_write']=True
try:
 (work/'role-write').write_text('ok')
 checks['role_write_policy']=${role === 'implementer' ? 'True' : 'False'}
except OSError as error:
 checks['role_write_policy']=${role === 'reviewer' ? 'True' : 'False'} and error.errno in [errno.EPERM,errno.EACCES,errno.EROFS]
for index, filename in enumerate(${JSON.stringify([...protectedPaths, path.join(root, 'outside-create'), path.join(workspace, 'escape')])}):
 for operation in ['write','truncate']:
  try:
   if operation=='write': pathlib.Path(filename).write_text('BAD')
   else:
    with open(filename,'r+') as target: target.truncate(0)
  except OSError as error: checks['protected_'+str(index)+'_'+operation]=error.errno in [errno.EPERM,errno.EACCES,errno.EROFS] or (index==5 and operation=='truncate' and error.errno==errno.ENOENT)
  else: checks['protected_'+str(index)+'_'+operation]=False
for label, family, kind, address in [('inet',socket.AF_INET,socket.SOCK_STREAM,('127.0.0.1',9)),('inet6',socket.AF_INET6,socket.SOCK_STREAM,('::1',9)),('unix',socket.AF_UNIX,socket.SOCK_STREAM,${JSON.stringify(path.join(root, 'no-socket'))}),('udp',socket.AF_INET,socket.SOCK_DGRAM,('192.0.2.1',53))]:
 try:
  connection=socket.socket(family,kind)
  connection.settimeout(.2)
  connection.connect(address)
 except OSError as error: checks[label+'_denied']=error.errno in [errno.EPERM,errno.EACCES]
 else: checks[label+'_denied']=False
print(json.dumps(checks))
raise SystemExit(0 if all(checks.values()) else 1)
`;
    const result = await rpc.request('command/exec', { command: ['/usr/bin/python3', '-B', '-c', code], cwd: workspace,
      permissionProfile: 'probe', timeoutMs: 10000, outputBytesCap: 8192 });
    if (result.exitCode !== 0) throw Error('COMMAND_BOUNDARY_PROBE_FAILED');
    const checks = JSON.parse(result.stdout);
    if (Object.keys(checks).length !== 20 || !Object.values(checks).every(value => value === true)) throw Error('PROBE_RESULTS_INCOMPLETE');
    for (const filename of protectedPaths) if (await fs.readFile(filename, 'utf8') !== 'sentinel') throw Error('PROTECTED_FILE_CHANGED');
    report.checks[`${role}_standalone_command`] = checks;
    await rpc.close(); rpc = null;
  }
} catch (error) {
  report.blocker = /^[A-Z_]+$/.test(error.message) ? error.message : 'PROBE_FAILED';
  process.exitCode = 1;
} finally {
  await rpc?.close();
  await fs.rm(root, { recursive: true, force: true });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}
