import { spawn, execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { homedir, constants } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const VALIDATION_VERSION = 'pab.controller-local-validation.v1';
// Bounded complete output is required for independent validation qualification.
// A busy test suite can exceed 2 KiB on stderr even when all tests pass.
const OUTPUT_LIMIT = 4 * 1024 * 1024;
const fail = code => { throw Object.assign(new Error(code), { code }); };
export const validationEnvironment = home => ({ PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: home,
  CODEX_HOME: home, TMPDIR: path.join(home, 'tmp'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', PYTHONDONTWRITEBYTECODE: '1', RUST_LOG: 'off' });

function treeGit(repo, args) {
  return execFileSync('/usr/bin/git', ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
    { cwd: repo, env: { ...validationEnvironment('/nonexistent'), GIT_ALLOW_PROTOCOL: '' }, timeout: 10000, maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
}

export async function materializeValidationTree(repo, tree, destination, signal) {
  if (!/^[a-f0-9]{40,64}$/.test(tree)) fail('VALIDATION_TREE_INVALID');
  const entries = new TextDecoder('utf-8', { fatal: true }).decode(treeGit(repo, ['ls-tree', '-rz', tree])).split('\0').filter(Boolean);
  if (entries.length > 2000) fail('VALIDATION_TREE_SIZE_LIMIT');
  let bytes = 0; const deadline = Date.now() + 10000;
  for (const entry of entries) {
    if (signal?.aborted || Date.now() > deadline) fail('VALIDATION_CAPTURE_INTERRUPTED');
    const match = /^(100644|100755) blob ([a-f0-9]{40,64})\t(.+)$/s.exec(entry);
    if (!match) fail('VALIDATION_TREE_ENTRY_UNSUPPORTED');
    const [, mode, object, name] = match;
    if (path.isAbsolute(name) || name.includes('\\') || name.split('/').some(part => !part || ['.', '..', '.git'].includes(part))) fail('VALIDATION_TREE_PATH_UNSAFE');
    const contents = treeGit(repo, ['cat-file', 'blob', object]);
    bytes += contents.length;
    if (bytes > 16 * 1024 * 1024) fail('VALIDATION_TREE_SIZE_LIMIT');
    const target = path.join(destination, name);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, contents, { flag: 'wx', mode: mode === '100755' ? 0o755 : 0o644 });
    await fs.chmod(target, mode === '100755' ? 0o755 : 0o644);
  }
  return { files: entries.length, bytes, source: 'git_tree_blobs', filters_applied: false };
}

// Keep supervision outside the namespace and outside the command's sandbox.
// The private pipes are closed before command exec. No task output can attest
// ownership or completion. PID 1 exit is the kernel's descendant-reaping barrier;
// a wrapper exit or a successful signal alone is deliberately insufficient.
const namespaceObserver = String.raw`
import ctypes,json,os,select,signal,subprocess,sys,time
request=json.loads(sys.argv[1])
libc=ctypes.CDLL(None,use_errno=True)
def prctl(option,value):
 if libc.prctl(option,value,0,0,0)!=0: raise OSError(ctypes.get_errno(),'process ownership unavailable')
def emit(event,**fields):
 os.write(3,(json.dumps(dict(event=event,nonce=request['nonce'],**fields))+'\n').encode())
def exited(fd): return bool(select.select([fd],[],[],0)[0])
def stop(fd):
 if fd is not None and not exited(fd): signal.pidfd_send_signal(fd,signal.SIGKILL)
stopping=False
def cancel(*_):
 global stopping
 stopping=True
signal.signal(signal.SIGTERM,cancel)
signal.signal(signal.SIGINT,cancel)
inner=r'''
import json,os,signal,subprocess,sys
info,gate,command=int(sys.argv[1]),int(sys.argv[2]),json.loads(sys.argv[3])
def report(**fields): os.write(info,(json.dumps(fields)+'\n').encode())
try:
 assert os.getpid()==1
 status=dict(line.split(':',1) for line in open('/proc/self/status') if ':' in line)
 # A matching procfs is required by native sandbox namespace lookups. Never
 # send a local PID as an outer PID or expose an inherited host-proc handle.
 assert int(status['Pid'])==1 and list(map(int,status['NSpid'].split()))==[1]
 assert os.readlink('/proc/self')=='1'
 namespace=os.readlink('/proc/self/ns/pid')
 assert os.readlink('/proc/1/ns/pid')==namespace
 report(event='ready',pid=1,namespace=namespace,mount_namespace=os.readlink('/proc/self/ns/mnt'))
 assert os.read(gate,1)==b'1'
 os.close(gate)
 # unshare may leave SIGTERM ignored; commands retain normal signal behavior.
 signal.signal(signal.SIGTERM,signal.SIG_DFL)
 child=subprocess.Popen(command,close_fds=True)
 code=child.wait()
 background=False
 while True:
  try:
   pid,_=os.waitpid(-1,os.WNOHANG)
   if pid==0:
    background=True
    break
  except ChildProcessError: break
 report(event='command',code=code,background=background)
except BaseException:
 report(event='incomplete')
finally:
 os._exit(0)
'''
wrapper=None
wrapper_fd=init_fd=None
init_pid=None
initialized=False
command=None
buffer=b''
eof=False
try:
 prctl(36,1) # PR_SET_CHILD_SUBREAPER, scoped to this observer.
 parent=request['owner_pid']
 prctl(1,signal.SIGTERM) # Owner death initiates the same bounded shutdown.
 if os.getppid()!=parent: raise RuntimeError('owner exited')
 if stopping:
  emit('complete',termination_confirmed=True,command=None,not_started=True)
  os._exit(0)
 reader,writer=os.pipe()
 gate_reader,gate_writer=os.pipe()
 owner=os.getpid()
 def owned_child():
  prctl(1,signal.SIGKILL)
  if os.getppid()!=owner: os._exit(125)
 wrapper=subprocess.Popen(['/usr/bin/unshare','--user','--map-current-user','--pid','--fork','--kill-child=KILL',
  '--mount-proc','--propagation=private',
  '/usr/bin/python3','-B','-c',inner,str(writer),str(gate_reader),json.dumps([request['binary'],*request['args']])],
  pass_fds=(writer,gate_reader),preexec_fn=owned_child)
 wrapper_fd=os.pidfd_open(wrapper.pid)
 os.close(writer)
 os.close(gate_reader)
 while True:
  # On early cancellation, finish trusted namespace setup without opening the
  # dispatch gate. This lets ownership be proved within the existing grace.
  if stopping and initialized:
   stop(wrapper_fd)
   stop(init_fd)
  if select.select([reader],[],[],0.01)[0]:
   data=os.read(reader,4096)
   if not data: eof=True
   buffer+=data
   if len(buffer)>4096: raise RuntimeError('oversized observation')
   while b'\n' in buffer:
    line,buffer=buffer.split(b'\n',1)
    message=json.loads(line)
    if message['event']=='ready':
     if initialized: raise RuntimeError('duplicate ownership')
     if type(message['pid']) is not int or message['pid']!=1: raise RuntimeError('invalid local owner')
     # The gated init cannot exit normally or spawn a command yet. Identify it
     # through our owned wrapper's children in the unchanged outer procfs.
     children=open('/proc/%d/task/%d/children'%(wrapper.pid,wrapper.pid)).read().split()
     if len(children)!=1: raise RuntimeError('ambiguous namespace owner')
     candidate=int(children[0])
     if candidate<=1: raise RuntimeError('invalid outer owner')
     candidate_fd=os.pidfd_open(candidate)
     status=dict(line.split(':',1) for line in open('/proc/%d/status'%candidate) if ':' in line)
     ids=list(map(int,status['NSpid'].split()))
     own_ids=list(map(int,dict(line.split(':',1) for line in open('/proc/self/status') if ':' in line)['NSpid'].split()))
     namespace=os.readlink('/proc/%d/ns/pid'%candidate)
     assert own_ids[0]==os.getpid() and ids[0]==candidate and ids[-1]==1 and len(ids)==len(own_ids)+1
     assert int(status['PPid'])==wrapper.pid and int(status['Uid'].split()[0])==os.getuid()
     assert namespace!=os.readlink('/proc/self/ns/pid') and not exited(candidate_fd)
     assert namespace==message['namespace']
     mount_namespace=os.readlink('/proc/%d/ns/mnt'%candidate)
     assert mount_namespace==message['mount_namespace'] and mount_namespace!=os.readlink('/proc/self/ns/mnt')
     init_pid,init_fd=candidate,candidate_fd
     initialized=True
     emit('ready',init_pid=init_pid,namespace=namespace)
     if not stopping: os.write(gate_writer,b'1')
     os.close(gate_writer)
    elif message['event']=='command':
     if not initialized or command is not None: raise RuntimeError('unowned completion')
     if type(message['code']) is not int or type(message['background']) is not bool: raise RuntimeError('invalid completion')
     command=message
    elif message['event']!='incomplete': raise RuntimeError('unknown observation')
  if eof and wrapper.poll() is not None and (init_fd is None or exited(init_fd)): break
 # A pidfd refers to the original task even after PID reuse. In particular,
 # do not substitute /proc group absence for this namespace-init exit proof.
 if buffer: raise RuntimeError('truncated observation')
 wrapper.wait()
 confirmed=initialized and exited(init_fd) and exited(wrapper_fd)
 if init_pid is not None:
  try: os.waitpid(init_pid,os.WNOHANG)
  except ChildProcessError: pass
 emit('complete',termination_confirmed=confirmed,command=command,
  diagnostic=None if command is not None else 'VALIDATION_NAMESPACE_EXECUTION_UNAVAILABLE')
except BaseException:
 try:
  stop(wrapper_fd)
  stop(init_fd)
  if wrapper is not None and wrapper_fd is None: wrapper.kill()
  if wrapper is not None: wrapper.wait(timeout=0.5)
 except BaseException: pass
 # Interrupted ownership/observation must never manufacture an exit proof.
 try: emit('incomplete')
 except BaseException: pass
finally:
 for fd in [wrapper_fd,init_fd]:
  if fd is not None: os.close(fd)
`;

export function observeValidationProcess(binary, args, { cwd, env, signal, timeoutMs, bound, spawnProcess = spawn }) {
  return new Promise(resolve => {
    const output = { stdout: { data: null, captured_bytes: 0, bytes: 0 }, stderr: { data: null, captured_bytes: 0, bytes: 0 } };
    let child, timer, grace, settled = false, closed = false, spawned = false, spawnFailed = false;
    const nonce = randomUUID();
    let timedOut = false, cancelled = signal?.aborted === true, background = false, exitCode = null, exitSignal = null;
    let ownership = null, completion = null, observationFailed = false, control = '', supervisorCode = null;
    const finish = () => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(grace); signal?.removeEventListener('abort', abort);
      const streams = Object.fromEntries(Object.entries(output).map(([name, value]) => {
        let text, encodingError = false;
        const captured = value.data === null ? Buffer.alloc(0) : value.data.subarray(0, value.captured_bytes);
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(captured); }
        catch { text = captured.toString('utf8'); encodingError = true; }
        let sanitized;
        try { sanitized = bound(text, OUTPUT_LIMIT); if (typeof sanitized !== 'string') throw Error('invalid output'); }
        catch { sanitized = ''; observationFailed = true; }
        return [name, { text: sanitized, bytes_observed: value.bytes, truncated: value.bytes > OUTPUT_LIMIT,
          redacted: sanitized !== text, encoding_error: encodingError, available: spawned && closed }];
      }));
      const terminationConfirmed = spawnFailed || (spawned && closed && supervisorCode === 0 && !observationFailed &&
        (ownership !== null || (completion?.not_started === true && (cancelled || timedOut))) && completion?.termination_confirmed === true);
      const status = !terminationConfirmed ? 'uncertain' : cancelled || background ? 'interrupted' : timedOut ? 'timed_out' :
        !closed || !Number.isInteger(exitCode) ? 'unavailable' : exitCode !== 0 || exitSignal ? 'failed' :
          Object.values(streams).some(value => value.truncated || value.redacted || value.encoding_error || !value.available) ? 'incomplete' : 'passed';
      resolve({ status, start_observed: spawned, completion_observed: closed, exit_code: exitCode, signal: exitSignal,
        timeout: timedOut, cancelled, background_processes_observed: background, termination_confirmed: terminationConfirmed,
        termination_scope: 'linux_pid_namespace', namespace_initialized: ownership !== null,
        namespace_identity: ownership, escaped_descendants_verified: ownership !== null && terminationConfirmed,
        ...(completion?.diagnostic ? { diagnostic: completion.diagnostic } : {}),
        independently_observed: true, ...streams });
    };
    const terminate = () => {
      if (spawned && !closed) { try { child.kill('SIGTERM'); } catch { observationFailed = true; } }
      if (!grace) grace = setTimeout(() => {
        if (!closed) { try { child.kill('SIGKILL'); } catch {} }
        observationFailed = true; finish();
      }, 1000);
    };
    const abort = () => { cancelled = true; terminate(); };
    if (cancelled) { spawnFailed = true; finish(); return; }
    try { child = spawnProcess('/usr/bin/python3', ['-B', '-c', namespaceObserver, JSON.stringify({ binary, args, nonce, owner_pid: process.pid })],
      { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] }); }
    catch { spawnFailed = true; finish(); return; }
    for (const name of ['stdout', 'stderr']) child[name]?.on('data', buffer => {
      const value = output[name], remaining = Math.max(0, OUTPUT_LIMIT - value.captured_bytes);
      value.bytes += buffer.length;
      if (remaining > 0) {
        // One lazily allocated fixed-size buffer per stream bounds allocation
        // overhead even when a process emits millions of one-byte fragments.
        if (value.data === null) value.data = Buffer.alloc(OUTPUT_LIMIT);
        value.captured_bytes += buffer.copy(value.data, value.captured_bytes, 0, remaining);
      }
    });
    child.once('spawn', () => { spawned = true; if (cancelled) terminate(); });
    child.once('error', () => { spawnFailed = !spawned; if (spawned) terminate(); else finish(); });
    const invalid = () => { observationFailed = true; terminate(); };
    child.stdio?.[3]?.on('data', buffer => {
      if (settled) return;
      try {
        control += buffer.toString('utf8');
        if (control.length > 4096) throw Error('oversized observation');
        while (control.includes('\n')) {
          const newline = control.indexOf('\n'), message = JSON.parse(control.slice(0, newline)); control = control.slice(newline + 1);
          if (message.nonce !== nonce || completion || observationFailed) throw Error('invalid observation');
          if (message.event === 'ready' && !ownership && Number.isSafeInteger(message.init_pid) && message.init_pid > 1 && /^pid:\[\d+\]$/.test(message.namespace)) {
            ownership = { init_pid: message.init_pid, namespace: message.namespace };
          } else if (message.event === 'complete' && typeof message.termination_confirmed === 'boolean') {
            completion = message;
            const command = message.command;
            if (command !== null) {
              if (!ownership || !Number.isSafeInteger(command.code) || typeof command.background !== 'boolean') throw Error('invalid completion');
              exitCode = command.code >= 0 ? command.code : null;
              exitSignal = command.code < 0 ? Object.keys(constants.signals).find(name => constants.signals[name] === -command.code) || null : null;
              background = command.background;
            }
          } else throw Error('incomplete observation');
        }
      } catch { invalid(); }
    });
    child.stdio?.[3]?.on('error', invalid);
    child.stdout?.on('error', invalid); child.stderr?.on('error', invalid);
    child.once('exit', () => { if (!grace) grace = setTimeout(() => { observationFailed = true; finish(); }, 1000); });
    child.once('close', (code, observedSignal) => {
      closed = true; supervisorCode = code;
      if (observedSignal || control.length) observationFailed = true;
      finish();
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
  });
}

export class LocalValidation {
  constructor({ root, binary = process.env.CODEX_BINARY || `${homedir()}/.local/bin/codex`, timeoutMs = 60000, bound = value => value }) {
    this.root = root; this.binary = binary; this.timeoutMs = Math.min(timeoutMs, 60000); this.bound = bound;
    this.abort = new AbortController(); this.terminationConfirmed = true;
  }
  cancel() { this.abort.abort(); }
  async run({ repo, tree, commands, attemptId, onRecord }) {
    if (!Array.isArray(commands) || commands.length > 10 || commands.some(command => typeof command !== 'string' || !command || command.length > 1000 || command.includes('\0'))) fail('VALIDATION_COMMANDS_INVALID');
    const results = [];
    let persistenceFailed = false;
    const persist = record => {
      try { onRecord(structuredClone(record)); }
      catch (error) { persistenceFailed = true; this.cancel(); throw error; }
    };
    for (const [index, command] of commands.entries()) {
      if (this.abort.signal.aborted) break;
      const record = { attempt_id: randomUUID(), validation_attempt_id: attemptId, command_index: index, command,
        candidate_tree: tree, cwd: null, status: 'preparing', start_attempted: false, start_observed: false,
        completion_observed: false, independently_observed: true, termination_confirmed: true,
        termination_scope: 'linux_pid_namespace', namespace_initialized: false, namespace_identity: null, escaped_descendants_verified: false,
        exit_code: null, signal: null, timeout: false, cancelled: false, started_at: null, completed_at: null,
        stdout: { text: '', available: false, bytes_observed: 0, truncated: false, redacted: false },
        stderr: { text: '', available: false, bytes_observed: 0, truncated: false, redacted: false } };
      results.push(record); persist(record);
      try {
        const directory = await fs.mkdtemp(path.join(this.root, 'validation-'));
        const cwd = path.join(directory, 'candidate'), control = path.join(directory, 'control'), scratch = path.join(directory, 'scratch');
        for (const folder of [cwd, control, scratch, path.join(control, 'tmp'), path.join(scratch, 'tmp')]) await fs.mkdir(folder, { mode: 0o700 });
        record.cwd = cwd;
        const identity = await fs.stat(cwd);
        record.cwd_identity = { realpath: await fs.realpath(cwd), device: identity.dev, inode: identity.ino };
        record.materialization = await materializeValidationTree(repo, tree, cwd, this.abort.signal);
        if (this.abort.signal.aborted) { record.status = 'interrupted'; persist(record); break; }
        const filesystem = { '/': 'read', [cwd]: 'write', [scratch]: 'write', [path.join(cwd, '.git')]: 'read', [path.join(cwd, '.codex')]: 'read' };
        const table = `{ bridge_task = { filesystem = { ${Object.entries(filesystem).map(([name, access]) => `${JSON.stringify(name)} = ${JSON.stringify(access)}`).join(', ')} }, network = { enabled = false } } }`;
        const env = validationEnvironment(control), commandEnv = validationEnvironment(scratch);
        const args = ['sandbox', '-c', `permissions=${table}`, '-P', 'bridge_task', '-C', control, '--', '/usr/bin/env', '-i',
          ...Object.entries(commandEnv).map(([name, value]) => `${name}=${value}`), '/bin/sh', '-c', 'cd -- "$1" && exec /bin/sh -c "$2"', 'pab-validation', cwd, command];
        record.status = 'running'; record.start_attempted = true; record.started_at = new Date().toISOString();
        persist(record);
        this.terminationConfirmed = false;
        const observed = await observeValidationProcess(this.binary, args, { cwd: control, env, signal: this.abort.signal,
          timeoutMs: this.timeoutMs, bound: this.bound });
        this.terminationConfirmed = observed.termination_confirmed;
        Object.assign(record, observed, { completed_at: new Date().toISOString() });
      } catch (error) {
        if (persistenceFailed) throw error;
        record.status = this.terminationConfirmed ? 'unavailable' : 'uncertain';
        record.diagnostic = /^VALIDATION_[A-Z_]+$/.test(error.code || '') ? error.code : 'VALIDATION_EXECUTION_UNAVAILABLE';
        record.termination_confirmed = this.terminationConfirmed;
      }
      persist(record);
      if (!this.terminationConfirmed || this.abort.signal.aborted) break;
    }
    return results;
  }
}

export function independentValidationPassed(validation, commands, reviewedState, taskId) {
  return !!reviewedState?.tree_sha && validation?.version === VALIDATION_VERSION && validation.provenance === 'controller_process_observation' &&
    typeof taskId === 'string' && validation.task_id === taskId &&
    validation.status === 'completed' && validation.original_unchanged === true && validation.termination_confirmed === true &&
    JSON.stringify(validation.reviewed_git_state) === JSON.stringify(reviewedState) && typeof validation.attempt_id === 'string' &&
    Array.isArray(validation.results) && validation.results.length === commands.length &&
    new Set(validation.results.map(record => record?.attempt_id)).size === commands.length &&
    validation.results.every((record, index) => record && record.command === commands[index] && record.command_index === index &&
      record.validation_attempt_id === validation.attempt_id && typeof record.attempt_id === 'string' && typeof record.cwd === 'string' &&
      record.cwd_identity?.realpath === record.cwd && Number.isInteger(record.cwd_identity.device) && Number.isInteger(record.cwd_identity.inode) &&
      record.materialization?.source === 'git_tree_blobs' && record.materialization.filters_applied === false &&
      record.candidate_tree === reviewedState.tree_sha && record.status === 'passed' && record.independently_observed === true &&
      record.start_attempted === true && record.start_observed === true && record.completion_observed === true && record.termination_confirmed === true &&
      record.exit_code === 0 && record.signal === null && record.timeout === false && record.cancelled === false && record.background_processes_observed === false &&
      ['stdout', 'stderr'].every(name => record[name]?.available === true && record[name].truncated === false && record[name].redacted === false && record[name].encoding_error === false && typeof record[name].text === 'string'));
}
