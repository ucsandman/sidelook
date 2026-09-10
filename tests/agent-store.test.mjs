import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RunStore} from '../lib/agent/store.mjs';
import {createRun} from '../lib/agent/run.mjs';

async function tempDir(){return mkdtemp(join(tmpdir(),'sidelook-agent-store-'));}

test('save then load round-trips a run exactly, and no .tmp file is left behind',async()=>{
  const dir=await tempDir();
  const store=new RunStore({dir,redactor:v=>v});
  const run=createRun({goal:'Refund Acme',model:'astra',effort:'low'});
  await store.save(run);
  const files=await readdir(dir);
  assert.deepEqual(files,[`${run.runId}.json`]);
  const loaded=await store.load(run.runId);
  assert.deepEqual(loaded,run);
  await rm(dir,{recursive:true,force:true});
});

test('load returns null for a missing id, an invalid id, and a malformed or unparsable file',async()=>{
  const dir=await tempDir();
  const store=new RunStore({dir,redactor:v=>v});
  assert.equal(await store.load('run_'+'a'.repeat(20)),null,'missing file');
  assert.equal(await store.load('not-a-run-id'),null,'fails the runId shape before touching disk');
  const {writeFile}=await import('node:fs/promises');
  const badId='run_'+'b'.repeat(20);
  await writeFile(join(dir,`${badId}.json`),'{not json',  'utf8');
  assert.equal(await store.load(badId),null,'unparsable JSON');
  const malformedId='run_'+'c'.repeat(20);
  await writeFile(join(dir,`${malformedId}.json`),JSON.stringify({runId:malformedId,status:'not_a_real_status',events:[],effects:[],approvals:[]}),'utf8');
  assert.equal(await store.load(malformedId),null,'status outside STATES');
  const notArraysId='run_'+'d'.repeat(20);
  await writeFile(join(dir,`${notArraysId}.json`),JSON.stringify({runId:notArraysId,status:'created',events:'nope',effects:[],approvals:[]}),'utf8');
  assert.equal(await store.load(notArraysId),null,'events must be an array');
  await rm(dir,{recursive:true,force:true});
});

test('save rejects a run without a valid runId and never leaves a partial file',async()=>{
  const dir=await tempDir();
  const store=new RunStore({dir,redactor:v=>v});
  await assert.rejects(store.save({runId:'nope',goal:'x'}));
  await assert.rejects(store.save({}));
  const files=await readdir(dir).catch(()=>[]);
  assert.deepEqual(files.filter(f=>f.endsWith('.tmp')),[]);
});

test('two concurrent saves of the same run never interleave: the file always parses as one whole write',async()=>{
  const dir=await tempDir();
  const store=new RunStore({dir,redactor:v=>v});
  const run=createRun({goal:'g'});
  const writes=[];
  for(let i=0;i<20;i++){
    const copy={...run,goal:`goal ${i}`.repeat(2000)};
    writes.push(store.save(copy));
  }
  await Promise.all(writes);
  const loaded=await store.load(run.runId);
  assert.ok(loaded.goal.startsWith('goal '));
  await rm(dir,{recursive:true,force:true});
});

test('list returns newest first by createdAt, honours the limit, and skips files that do not belong to it',async()=>{
  const dir=await tempDir();
  const store=new RunStore({dir,redactor:v=>v});
  const {writeFile}=await import('node:fs/promises');
  await writeFile(join(dir,'not-a-run.json'),'{}','utf8');
  await writeFile(join(dir,'run_'+'e'.repeat(20)+'.json.tmp'),'{}','utf8');
  const runs=[];
  for(let i=0;i<5;i++){
    const run=createRun({goal:`Run ${i}`,at:new Date(2026,0,i+1).toISOString()});
    runs.push(run);
    await store.save(run);
  }
  const all=await store.list({limit:50});
  assert.equal(all.length,5);
  assert.deepEqual(all.map(r=>r.goal),['Run 4','Run 3','Run 2','Run 1','Run 0'],'newest createdAt first');
  const top=await store.list({limit:2});
  assert.equal(top.length,2);
  assert.deepEqual(top.map(r=>r.goal),['Run 4','Run 3']);
  assert.deepEqual(Object.keys(all[0]).sort(),['createdAt','goal','runId','status','updatedAt'].sort());
  await rm(dir,{recursive:true,force:true});
});

test('a custom redactor runs on every save; the module default tolerates a missing redact.mjs',async()=>{
  const dir=await tempDir();
  const redactor=run=>({...run,goal:run.goal.replace(/secret-\w+/g,'[redacted]')});
  const store=new RunStore({dir,redactor});
  const run=createRun({goal:'Refund for secret-token123'});
  await store.save(run);
  const loaded=await store.load(run.runId);
  assert.equal(loaded.goal,'Refund for [redacted]');
  const noRedactorStore=new RunStore({dir});
  const plain=createRun({goal:'Plain goal, no redactor injected'});
  await noRedactorStore.save(plain);
  const loadedPlain=await noRedactorStore.load(plain.runId);
  assert.equal(loadedPlain.goal,plain.goal,'without ./redact.mjs on disk the default redactor is the identity');
  await rm(dir,{recursive:true,force:true});
});

test('mkdir happens lazily on first use, so RunStore can be constructed before the directory exists',async()=>{
  const dir=join(await tempDir(),'nested','runs');
  const store=new RunStore({dir,redactor:v=>v});
  const run=createRun({goal:'g'});
  await store.save(run);
  assert.deepEqual((await store.list({limit:5})).map(r=>r.runId),[run.runId]);
});
