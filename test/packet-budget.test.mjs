import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { budgetPacket, PACKET_LIMIT } from '../packet-budget.mjs';
import { Controller } from '../controller.mjs';
import { repositoryIdentity, repoGit } from '../repositories.mjs';
import { createFileRpcJournal } from '../file-rpc-evidence.mjs';
import { pathToFileURL } from 'node:url';
import { FakeAPI, FakeExecutor, contract } from './helpers.mjs';
import { createServer } from '../server.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

async function setup(t) {
  const root = await fs.mkdtemp('/var/tmp/personal-agents-bridge/packet-budget-');
  const normal = path.join(root,'normal'); await fs.mkdir(normal);
  repoGit(normal,'init','--initial-branch=main');
  const baseline=Array.from({length:410},(_,i)=>`Rule ${i}: preserve repository boundaries and explicit human decisions.\n`).join('');
  await fs.writeFile(path.join(normal,'AGENTS.md'),baseline);repoGit(normal,'add','.');repoGit(normal,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture');
  const api=new FakeAPI(),executor=new FakeExecutor();
  const c=await new Controller({stateRoot:path.join(root,'state'),workspaceRoot:path.join(root,'work'),api,executor,secrets:[]}).init();
  await fs.writeFile(path.join(c.stateRoot,'repositories.json'),JSON.stringify({version:1,repositories:{fixture:await repositoryIdentity(normal)}}),{mode:0o600});
  t.after(async()=>{await c.close();await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  const ct={...contract(),allowed_files:['AGENTS.md'],initial_files:{},test_commands:['git diff --check']};
  const x=await c.start({contract:ct,repository_id:'fixture',request_id:'budget_start'});await Promise.all([...c.jobs.values()]);
  const task=c.task(x.task_id),work=path.join(c.workspaceRoot,x.task_id,'repo');
  const control=path.join(c.workspaceRoot,x.task_id,'implementer-runtime/sandbox-fixture/control');await fs.mkdir(control,{recursive:true});
  const journal=createFileRpcJournal(control,work,path.join(control,'../scratch'));
  const current=baseline.replace('Rule 100:', 'Updated scoped rule 100:')+'\n## Bridge workflow\n'+'Only the trusted controller publishes reviewed changes.\n'.repeat(100);
  await journal.run('fs/writeFile',{path:pathToFileURL(path.join(work,'AGENTS.md')).href},async()=>{await fs.writeFile(path.join(work,'AGENTS.md'),current);return {result:{}};});
  for(let i=0;i<50;i++)await journal.run('fs/getMetadata',{path:pathToFileURL(path.join(work,'AGENTS.md')).href},async()=>({result:{}}));
  await journal.close();
  Object.assign(task.implementer.executor.isolation_evidence,{file_rpc_capture_initialized:true,file_rpc_coverage_from_first_executor:true,file_rpc_generation:1});c.save(task);
  const items=api.rows.get(task.implementer.session_id).items;
  for(let i=0;i<12;i++)items.push({type:'command_execution',id:`inspection_${i}`,command:'git diff -- AGENTS.md',output:'inspection only\n'.repeat(1000),stdout:'stdout\n'.repeat(2000),stderr:'stderr\n'.repeat(2000),exit_code:0});
  items.push({type:'command_execution',id:'required_test',command:'git diff --check',output:'',exit_code:0});
  return {c,api,task,work,baseline,current,items};
}

test('moderately large repository packet keeps semantic files, complete RPC evidence and bounded command streams',async t=>{
  const {c,task,baseline,current}=await setup(t);
  const p=await c.buildPacket(task),d=JSON.parse(p.text);
  assert(p.bytes<=PACKET_LIMIT);assert.equal(d.evidence_version,5);
  assert.equal(d.current['AGENTS.md'],current);assert.equal(d.baseline['AGENTS.md'],baseline);
  assert.equal(d.file_rpc_operation_evidence.capture_complete,true);assert.equal(d.file_rpc_operation_evidence.records.length,51);
  assert.equal(d.test_execution_evidence[0].exit_code,0);assert.equal(d.test_execution_evidence[0].truncated,false);
  const command=d.command_execution_evidence.records[0];assert(command.truncated);assert(command.stdout_truncated&&command.stderr_truncated);
  assert(command.output.length<=256&&command.stdout.length<=256&&command.stderr.length<=256);
  assert(command.output_bytes.observed>command.output_bytes.retained);
  assert.equal(d.packet_budget.sections.command_execution_evidence.complete,false);
  assert.equal(d.packet_budget.sections.file_rpc_operation_evidence.complete,true);
  assert(d.diff.includes('Bridge workflow')||d.packet_budget.sections.diff.semantic_text_complete);
});

test('redundant text diff deduplicates deterministically but complete semantic maps remain',async t=>{
  const {c,task}=await setup(t);const d=JSON.parse((await c.buildPacket(task)).text);delete d.packet_budget;
  d.diff='diff --git a/AGENTS.md b/AGENTS.md\n'+ '@@ -1 +1 @@\n-old\n+new\n'.repeat(2400);
  const a=budgetPacket(d),b=budgetPacket(d);assert.equal(a.text,b.text);const p=JSON.parse(a.text);
  assert.equal(p.diff,'');assert.equal(p.packet_budget.sections.diff.complete,false);
  assert.equal(p.packet_budget.sections.diff.semantic_text_complete,true);
  assert.deepEqual(p.baseline,d.baseline);assert.deepEqual(p.current,d.current);
  assert.deepEqual(p.file_rpc_operation_evidence,d.file_rpc_operation_evidence);
  d.diff='old mode 100644\nnew mode 100755\n'+d.diff;
  // An unreconstructable patch fits inside the new capacity and must stay literal.
  assert.equal(JSON.parse(budgetPacket(d).text).diff,d.diff);
});

test('required tests are retained even after generic command quota is exhausted',async t=>{
  const {c,task,items}=await setup(t);const required=items.pop();
  for(let i=0;i<110;i++)items.push({type:'command_execution',command:'git status',output:'x'.repeat(6000),exit_code:0});
  items.push(required);
  const p=JSON.parse((await c.buildPacket(task)).text);
  assert(p.command_execution_evidence.omitted_command_records>0);
  assert.equal(p.test_execution_evidence.length,1);assert.equal(p.test_execution_evidence[0].item_id,'required_test');
  assert.deepEqual(p.command_execution_evidence.required_test_commands_missing,[]);
});

test('configured 64 MiB hard capacity rejects oversized required semantic evidence', () => {
  const data={contract:'x'.repeat(PACKET_LIMIT),diff:'',changed_files:[],baseline:{},current:{}};
  assert.throws(()=>budgetPacket(data),e=>e.code==='EVIDENCE_SIZE_LIMIT'&&
    e.diagnostic.required_section==='contract'&&e.diagnostic.limit_bytes===PACKET_LIMIT&&
    e.diagnostic.section_bytes.contract>PACKET_LIMIT);
});

test('required result-section overflow fails closed rather than dropping required executions',async t=>{
  const {c,task,items}=await setup(t);
  for(let i=0;i<30;i++)items.push({type:'command_execution',command:'git diff --check',output:'required detail\n'.repeat(1000),exit_code:0});
  await assert.rejects(c.buildPacket(task),e=>e.code==='EVIDENCE_SIZE_LIMIT'&&e.diagnostic.required_section==='test_execution_evidence'&&e.diagnostic.section_bytes.test_execution_evidence>32768);
});

test('relevant Git operations survive inspection quotas and upstream truncation stays explicit',async t=>{
  const {c,task,items}=await setup(t);
  for(let i=0;i<110;i++)items.push({type:'command_execution',command:'echo inspect',output:'x'.repeat(2000),exit_code:0});
  items.push({type:'command_execution',id:'late_prohibited_push',command:'git push https://example.invalid/repo HEAD',output:'denied',exit_code:1,output_truncated:true});
  const p=JSON.parse((await c.buildPacket(task)).text);
  const push=p.command_execution_evidence.records.find(r=>r.item_id==='late_prohibited_push');
  assert(push);assert.equal(push.exit_code,1);assert.equal(push.truncated,true);assert.equal(push.source_truncated,true);
  assert(p.command_execution_evidence.omitted_command_records>0);
});

test('local review budget is configurable while historical hard retention cap remains fixed', async () => {
  const {execFileSync}=await import('node:child_process');
  const snippet=`import {budgetLocalPacket} from './local-evidence.mjs';
    try {budgetLocalPacket({diff:'x'.repeat(300000)});console.log('UNEXPECTED_PASS');}
    catch(e){console.log(e.code+':'+e.diagnostic.limit_bytes);}`;
  const output=execFileSync(process.execPath,['--input-type=module','-e',snippet],{
    cwd:process.cwd(),encoding:'utf8',env:{...process.env,PAB_REVIEW_PACKET_LIMIT_BYTES:'262144'}
  }).trim();
  assert.equal(output,'EVIDENCE_SIZE_LIMIT:262144');
});
