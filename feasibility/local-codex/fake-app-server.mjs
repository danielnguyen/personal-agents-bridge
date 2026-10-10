#!/usr/bin/env node
import { createInterface } from 'node:readline';

const mode = process.argv.at(-1);
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (mode === 'disconnect') return process.exit(0);
  if (mode === 'timeout') return;
  if (mode === 'oversize') return process.stdout.write('x'.repeat(1024 * 1024 + 1));
  if (mode === 'malformed') return process.stdout.write('{broken}\n');
  if (mode === 'server-request') return process.stdout.write(JSON.stringify({ id: message.id, method: 'item/permissions/requestApproval', params: {} }) + '\n');
  if (mode === 'error') return process.stdout.write(JSON.stringify({ id: message.id, error: { code: -1, message: 'raw detail must not escape' } }) + '\n');
  process.stdout.write(JSON.stringify({ id: message.id, result: { method: message.method } }) + '\n');
});
