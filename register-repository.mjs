// Local operator command only. Never exposed as an MCP tool.
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { repositoryIdPattern, repositoryIdentity, readRegistry } from './repositories.mjs';

const [id, approvedPath, ...extra] = process.argv.slice(2);
try {
  if (!id || !repositoryIdPattern.test(id) || !approvedPath || extra.length) throw Error('Usage: node register-repository.mjs <logical-id> <approved-absolute-path>');
  const file = path.join(homedir(), '.local/state/personal-agents-bridge/repositories.json');
  const registry = await readRegistry(file);
  if (Object.hasOwn(registry.repositories, id)) throw Error('Repository ID already registered; inspect the registry locally before changing it');
  registry.repositories[id] = await repositoryIdentity(approvedPath);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  // Exclusive temporary file and atomic replacement; this command is operator-run, not concurrent automation.
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(registry, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await fs.rename(temporary, file);
  process.stdout.write(`Registered ${id}.\n`);
} catch (error) {
  process.stderr.write(`${error.code || (error.message.startsWith('Usage:') || error.message.startsWith('Repository ID') ? error.message : 'REPOSITORY_REGISTRATION_FAILED')}\n`);
  process.exitCode = 1;
}
