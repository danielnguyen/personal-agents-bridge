import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createFileRpcJournal, captureFileRpcEvidence } from '../file-rpc-evidence.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp('/tmp/bridge-rpc-evidence-'), id = 'fixture';
  const runtime = root + '/' + id + '/implementer-runtime', control = runtime + '/sandbox-one/control';
  const work = root + '/' + id + '/repo', scratch = runtime + '/sandbox-one/scratch';
  for (const p of [control, work, scratch]) await fs.mkdir(p, { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const journal = createFileRpcJournal(control, work, scratch);
  const task = { id, implementer: { executor: { isolation_evidence: { file_rpc_coverage_from_first_executor: true, file_rpc_generation: 1 } } } };
  return { root, task, journal, work, scratch };
}
test('RPC journal is bounded, sanitized and explicit about omitted records', async t => {
  const { root, task, journal, work } = await fixture(t);
  for (let i = 0; i < 110; i++) await journal.run('fs/writeFile', { path: pathToFileURL(work + '/token=do-not-persist').href, dataBase64: Buffer.from('SECRET_CONTENT').toString('base64'), env: { key: 'SECRET_ENV' } }, async () => ({ result: { secret: 'SECRET_RESPONSE' } }));
  await journal.close();
  const raw = await fs.readFile(journal.file, 'utf8');
  for (const value of ['do-not-persist', 'SECRET_CONTENT', 'SECRET_ENV', 'SECRET_RESPONSE', Buffer.from('SECRET_CONTENT').toString('base64')]) assert(!raw.includes(value));
  assert(Buffer.byteLength(raw) < 32768);
  const e = await captureFileRpcEvidence(task, root);
  assert.equal(e.capture_complete, false); assert.equal(e.observed_operations, 110); assert(e.omitted_records > 0);
  assert.equal(e.records.length + e.omitted_records, 110);
  assert.equal(e.records[0].targets[0].path, '[REDACTED]');
});
test('RPC evidence distinguishes unsealed, missing, conflicting and legacy journals', async t => {
  const { root, task, journal, work } = await fixture(t);
  await journal.run('fs/writeFile', { path: pathToFileURL(work + '/ok').href }, async () => ({ result: {} }));
  assert.equal((await captureFileRpcEvidence(task, root)).capture_complete, false);
  await journal.close();
  assert.equal((await captureFileRpcEvidence(task, root)).capture_complete, true);
  const j = JSON.parse(await fs.readFile(journal.file)); j.records[0].success = false;
  await fs.writeFile(journal.file, JSON.stringify(j));
  assert.equal((await captureFileRpcEvidence(task, root)).error, 'FILE_RPC_JOURNAL_CONFLICT');
  await fs.unlink(journal.file);
  assert.equal((await captureFileRpcEvidence(task, root)).capture_complete, false);
  delete task.implementer.executor.isolation_evidence.file_rpc_coverage_from_first_executor;
  assert.equal((await captureFileRpcEvidence(task, root)).error, 'FILE_RPC_CAPTURE_UNAVAILABLE');
});
test('RPC interrupted dispatch remains unknown and paths classify symlink escapes and scratch', async t => {
  const { root, task, journal, work, scratch } = await fixture(t);
  await fs.symlink(root, work + '/escape');
  await journal.run('fs/copy', { sourcePath: pathToFileURL(scratch + '/source').href, destinationPath: pathToFileURL(work + '/escape/new').href }, async () => ({ error: { message: 'Permission denied SECRET' } }));
  await assert.rejects(journal.run('fs/writeFile', { path: pathToFileURL(work + '/maybe').href }, async () => { throw Error('private response'); }));
  await journal.close();
  const e = await captureFileRpcEvidence(task, root);
  assert.equal(e.capture_complete, false); assert.equal(e.records[1].outcome, 'unknown');
  assert.equal(e.records[0].outcome, 'denied');
  assert.deepEqual(e.records[0].targets.map(t => t.classification), ['task_scratch','outside']);
  assert.equal(e.records[0].targets[1].path, null);
  assert(!JSON.stringify(e).includes('SECRET'));
});

test('journal persistence failure prevents file-RPC dispatch', async t => {
  const { journal } = await fixture(t);
  await fs.rm(journal.file.slice(0, journal.file.lastIndexOf('/')), { recursive: true });
  let dispatched = false;
  await assert.rejects(journal.run('fs/writeFile', { path: 'file:///tmp/never-dispatched' }, async () => { dispatched = true; return { result: {} }; }));
  assert.equal(dispatched, false);
});
