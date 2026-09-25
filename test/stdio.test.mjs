import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { contract } from './helpers.mjs';
test('actual stdio MCP process initializes and returns stable task IDs', async t => {
  const root = await fs.mkdtemp('/var/tmp/personal-agents-bridge/stdio-');
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./stdio-server.mjs', import.meta.url)), root], env: { PATH: '/usr/bin:/bin', LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH || '' }, stderr: 'pipe' });
  const client = new Client({ name: 'stdio-verifier', version: '1' });
  t.after(async () => { await client.close(); await fs.rm(root, { recursive: true, force: true }); });
  await client.connect(transport); assert.equal((await client.listTools()).tools.length, 6);
  const started = await client.callTool({ name: 'start_task', arguments: { contract: contract(), request_id: 'stdio_start' } });
  assert(started.structuredContent.task_id);
  const got = await client.callTool({ name: 'get_task', arguments: { task_id: started.structuredContent.task_id } });
  assert.equal(got.structuredContent.task_id, started.structuredContent.task_id);
});
