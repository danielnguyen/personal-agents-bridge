// Test fixture: fake API only, no credentials, no live executor. Never configure a tunnel to this file.
import { Controller } from '../controller.mjs';
import { createServer } from '../server.mjs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { FakeAPI, FakeExecutor } from './helpers.mjs';
import path from 'node:path';
const root = process.argv[2];
if (!root?.startsWith('/var/tmp/personal-agents-bridge/stdio-')) process.exit(2);
const c = await new Controller({ stateRoot: path.join(root, 'state'), workspaceRoot: path.join(root, 'work'), api: new FakeAPI(), executor: new FakeExecutor(), secrets: [] }).init();
const s = createServer(c, async () => {});
process.stdin.on('end', async () => { await c.close(); process.exit(0); });
await s.connect(new StdioServerTransport());
