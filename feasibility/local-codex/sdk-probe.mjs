import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sdkFile = process.argv[2];
if (!sdkFile || !path.isAbsolute(sdkFile) || process.argv.length !== 3) {
  process.stderr.write('Usage: node feasibility/local-codex/sdk-probe.mjs /absolute/path/to/codex-sdk/dist/index.js\n');
  process.exit(2);
}
const { Codex } = await import(pathToFileURL(sdkFile).href);
const root = await fs.mkdtemp('/tmp/pab-sdk-probe-');
await fs.chmod(root, 0o700);
try {
  const binary = path.join(root, 'fake-codex.mjs'), capture = path.join(root, 'calls.jsonl');
  await fs.copyFile(fileURLToPath(new URL('./fake-codex.mjs', import.meta.url)), binary); await fs.chmod(binary, 0o700);
  const codex = new Codex({ codexPathOverride: binary, env: {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, PAB_SDK_CAPTURE: capture,
    ...(process.env.LD_LIBRARY_PATH ? { LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH } : {}) } });
  const options = { workingDirectory: root, sandboxMode: 'workspace-write', approvalPolicy: 'never', networkAccessEnabled: false, webSearchMode: 'disabled' };
  const thread = codex.startThread(options);
  const first = await thread.run('first');
  assert.equal(first.finalResponse, 'synthetic response');
  assert.equal(first.items[0].command, 'synthetic-test'); assert.equal(first.items[0].exit_code, 0);
  assert.equal(thread.id, 'synthetic-thread');
  await thread.run('continue');
  await codex.resumeThread(thread.id, options).run('restart');
  const controller = new AbortController();
  const { events } = await codex.resumeThread(thread.id, options).runStreamed('wait', { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    await assert.rejects(async () => {
      for await (const event of events) if (event.type === 'turn.started') controller.abort();
    });
  } finally { clearTimeout(timer); }
  const calls = (await fs.readFile(capture, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(calls.length, 4);
  for (const call of calls) {
    assert.equal(call.apiKeyPresent, false);
    assert.deepEqual(call.argv.slice(0, 2), ['exec', '--experimental-json']);
    assert(call.argv.includes('approval_policy="never"')); assert(call.argv.includes('sandbox_workspace_write.network_access=false'));
    assert(call.argv.includes('web_search="disabled"')); assert(call.argv.includes('workspace-write'));
  }
  assert(!calls[0].argv.includes('resume'));
  for (const call of calls.slice(1)) assert.deepEqual(call.argv.slice(-2), ['resume', 'synthetic-thread']);
  process.stdout.write(JSON.stringify({ sdkWrapperChecks: 'passed', syntheticCliInvocations: calls.length,
    realCodexInvocations: 0, modelTurnsSubmitted: 0, authenticationAndSandboxVerified: false }) + '\n');
} finally { await fs.rm(root, { recursive: true, force: true }); }
