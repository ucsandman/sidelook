// agent-learning/nightly.mjs: the nightly runner is locked, deadline-limited, records every outcome, prunes old runs and
// never reaches git. Contract: docs/AGENT_LEARNING_LOOP.md section 14 (scheduled execution).
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runNightly,parseArgs,learnSettingsFromEnvFile} from '../agent-learning/nightly.mjs';

test('only the two model keys are read from a .env text; a secret on the next line never comes out',()=>{
  const got=learnSettingsFromEnvFile('STRIPE_SECRET_KEY=sk_test_abcdefghijk\nAGENT_LEARN_MODEL=sonnet\nAGENT_LEARN_REVIEW_MODEL="opus"\nDASHCLAW_API_KEY=oc_live_zzz\n');
  assert.deepEqual(got,{AGENT_LEARN_MODEL:'sonnet',AGENT_LEARN_REVIEW_MODEL:'opus'});
  assert.equal(JSON.stringify(got).includes('sk_test'),false);
});

async function scratch(t){
  const dir=await mkdtemp(join(tmpdir(),'sidelook-nightly-'));
  t.after(()=>rm(dir,{recursive:true,force:true}).catch(()=>{}));
  return dir;
}
// A stand-in for learn.mjs: writes a summary into --out, or sleeps for a while, as the test asks.
async function fakeLearn(dir,{sleepMs=0,exit=0,summary=true}={}){
  const path=join(dir,'fake-learn.mjs');
  await writeFile(path,`
import {writeFile} from 'node:fs/promises';import {join} from 'node:path';
const out=process.argv[process.argv.indexOf('--out')+1];
if(${sleepMs}) await new Promise(r=>setTimeout(r,${sleepMs}));
if(${summary}) await writeFile(join(out,'learning_summary.json'),JSON.stringify({learnRunId:'learn_fake',candidates:[{decision:'promote_eligible'},{decision:'rejected'},{decision:'needs_human_review'}]}));
process.exit(${exit});`);
  return path;
}

test('parseArgs takes the model from the environment and bounds the deadline and keep',()=>{
  const a=parseArgs(['--deadline-minutes','0','--keep','0'],{AGENT_LEARN_MODEL:'sonnet'},{});
  assert.equal(a.model,'sonnet');assert.equal(a.deadlineMinutes,90);assert.equal(a.keep,14);
  assert.equal(parseArgs([],{},{}).model,null,'no model anywhere means the template-only loop, never an invented one');
  assert.equal(parseArgs([],{},{AGENT_LEARN_MODEL:'haiku'}).model,'haiku','the .env lines stand in when the shell has nothing');
  assert.equal(parseArgs([],{AGENT_LEARN_MODEL:'opus'},{AGENT_LEARN_MODEL:'haiku'}).model,'opus','the shell environment wins over the file');
});

test('a completed run records its summary counts, the log and the out dir, and leaves no lock',async t=>{
  const dir=await scratch(t);
  const result=await runNightly({root:dir,learnScript:await fakeLearn(dir),deadlineMinutes:1,keep:14});
  assert.equal(result.status,'completed');
  assert.deepEqual({c:result.summary.candidates,e:result.summary.promoteEligible,r:result.summary.rejected,h:result.summary.needsHumanReview},{c:3,e:1,r:1,h:1});
  assert.match(result.promotion,/never automatic/);
  const status=JSON.parse(await readFile(join(dir,'nightly-status.json'),'utf8'));
  assert.equal(status.status,'completed');
  const files=await readdir(dir);
  assert.ok(!files.includes('nightly.lock'),'the lock is released after the run');
  assert.ok(files.some(f=>f.startsWith('nightly-')),'the run has its own out dir');
});

test('a run past its deadline is killed and recorded as timed_out',async t=>{
  const dir=await scratch(t);
  const started=Date.now();
  const result=await runNightly({root:dir,learnScript:await fakeLearn(dir,{sleepMs:20000,summary:false}),deadlineMinutes:0.03,keep:14});
  assert.equal(result.status,'timed_out');
  assert.ok(Date.now()-started<15000,'the child did not run to its own end');
  assert.equal(result.summary,null);
});

test('a live holder keeps the lock; a dead holder is taken over',async t=>{
  const dir=await scratch(t);
  // The parent test runner is a live process that is not this one: the shape of a night still running from another shell.
  await writeFile(join(dir,'nightly.lock'),JSON.stringify({pid:process.ppid,startedAt:new Date().toISOString(),heartbeat:new Date().toISOString()}));
  const skipped=await runNightly({root:dir,learnScript:await fakeLearn(dir),deadlineMinutes:1,keep:14});
  assert.equal(skipped.status,'skipped_locked');
  assert.equal(skipped.holder.pid,process.ppid);
  await writeFile(join(dir,'nightly.lock'),JSON.stringify({pid:999999,startedAt:new Date().toISOString(),heartbeat:new Date().toISOString()}));
  const taken=await runNightly({root:dir,learnScript:await fakeLearn(dir),deadlineMinutes:1,keep:14});
  assert.equal(taken.status,'completed','a lock whose holder is gone does not stop the night');
});

test('a failed loop is recorded as failed with its exit code, and old nightly dirs are pruned to keep',async t=>{
  const dir=await scratch(t);
  for(const n of ['nightly-20260901T000000Z','nightly-20260902T000000Z','nightly-20260903T000000Z']) await mkdir(join(dir,n),{recursive:true});
  const result=await runNightly({root:dir,learnScript:await fakeLearn(dir,{exit:3,summary:false}),deadlineMinutes:1,keep:2});
  assert.equal(result.status,'failed');assert.equal(result.exitCode,3);
  const dirs=(await readdir(dir,{withFileTypes:true})).filter(d=>d.isDirectory() && /^nightly-\d{8}T/.test(d.name)).map(d=>d.name).sort();
  assert.equal(dirs.length,2,'the two newest nightly dirs remain');
  assert.equal(dirs[0],'nightly-20260903T000000Z');
});

test('the runner never spawns a git command',async()=>{
  const source=await readFile(new URL('../agent-learning/nightly.mjs',import.meta.url),'utf8');
  assert.ok(!/['"]git['"]/.test(source),'nightly.mjs holds no git invocation; merging is a person\'s act');
});
