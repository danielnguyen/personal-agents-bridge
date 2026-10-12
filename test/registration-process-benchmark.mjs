import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { promises as fs } from 'node:fs';
import { registrationProcess } from '../repositories.mjs';
import { observeValidationProcess } from '../local-validation.mjs';

const env = { PATH: '/usr/bin:/bin' };
function control(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.resume(); child.stderr.resume();
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(Error('control failed')));
  });
}
const results = { node: process.version, processes: (await fs.readdir('/proc')).filter(name => /^\d+$/.test(name)).length, samples: [] };
for (let round = 0; round < 3; round++) {
  for (const workload of ['idle', 'git40', 'validation', 'idle3']) {
    for (const mode of round % 2 ? ['monitored', 'control'] : ['control', 'monitored']) {
      const run = mode === 'monitored' ? (binary, args) => registrationProcess(binary, args, { env, timeout: 10000 }) : control;
      const start = performance.now(), cpu = process.cpuUsage();
      let validationMs;
      if (workload === 'idle') await run('/bin/sleep', ['2']);
      if (workload === 'idle3') await Promise.all(Array.from({ length: 3 }, () => run('/bin/sleep', ['2'])));
      if (workload === 'git40') for (let count = 0; count < 40; count++) await run('/usr/bin/git', ['--version']);
      if (workload === 'validation') {
        const sleeper = run('/bin/sleep', ['4']);
        const validationStart = performance.now();
        const observed = await Promise.all(Array.from({ length: 2 }, () => observeValidationProcess('/usr/bin/python3', ['-B', '-c',
          'import hashlib\nfor index in range(500000): hashlib.sha256(b"x"*2048).digest()'],
        { env, timeoutMs: 10000, bound: value => value })));
        validationMs = performance.now() - validationStart;
        if (observed.some(result => result.status !== 'passed')) throw Error('validation failed');
        await sleeper;
      }
      const wallMs = performance.now() - start, used = process.cpuUsage(cpu), cpuMs = (used.user + used.system) / 1000;
      const sample = { round, workload, mode, wallMs, cpuMs, cpuPercent: 100 * cpuMs / wallMs, validationMs };
      results.samples.push(sample); console.log(JSON.stringify(sample));
    }
  }
}
await fs.writeFile(process.argv[2], JSON.stringify(results, null, 2), { flag: 'wx', mode: 0o600 });
