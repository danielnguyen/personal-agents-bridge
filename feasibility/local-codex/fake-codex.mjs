#!/usr/bin/env node
import { appendFileSync } from 'node:fs';

let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  appendFileSync(process.env.PAB_SDK_CAPTURE, JSON.stringify({ argv: process.argv.slice(2),
    apiKeyPresent: Boolean(process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY), input }) + '\n');
  const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
  emit({ type: 'thread.started', thread_id: 'synthetic-thread' });
  emit({ type: 'turn.started' });
  if (input === 'wait') { setInterval(() => {}, 1000); return; }
  emit({ type: 'item.completed', item: { id: 'synthetic-command', type: 'command_execution', command: 'synthetic-test',
    aggregated_output: 'synthetic output', exit_code: 0, status: 'completed' } });
  emit({ type: 'item.completed', item: { id: 'synthetic-message', type: 'agent_message', text: 'synthetic response' } });
  emit({ type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } });
});
