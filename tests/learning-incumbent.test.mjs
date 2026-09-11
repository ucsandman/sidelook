import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {freezeIncumbent,protectedRegionHashes,PROTECTED_FILES,PROTECTED_MARKERS} from '../agent-learning/lib/incumbent.mjs';

const HEX64=/^[a-f0-9]{64}$/;

async function tempDir(){return mkdtemp(join(tmpdir(),'sidelook-learning-incumbent-'));}

// Builds a minimal fixture tree with real marker text in the protected files, so region hashes are not just
// sha256('') for every marker, plus a fake node_modules/dashclaw and a regression corpus.
async function buildFixtureRoot({omitRecovery=false,omitBreakers=false}={}){
  const root=await tempDir();
  await mkdir(join(root,'lib/agent/providers'),{recursive:true});
  await mkdir(join(root,'agent-learning/regressions/dev'),{recursive:true});
  await mkdir(join(root,'agent-learning/regressions/holdout'),{recursive:true});
  await mkdir(join(root,'node_modules/dashclaw'),{recursive:true});

  await writeFile(join(root,'lib/agent/effects.mjs'),[
    '// effects',
    'const REFUND_NOT_HELD=1;',
    'await deps.governed.claim(x);',
    'const allowUnheldRefunds=false;',
    'const STRIPE_LIVE_REFUSED=true;',
    'function boundToCustomer(){}',
    'async function awaitDecision(){}',
    'const approvedBy=null;'
  ].join('\n'),'utf8');
  await writeFile(join(root,'lib/agent/providers/stripe.mjs'),['// stripe','function guardWrite(){}','const allowLive=false;'].join('\n'),'utf8');
  await writeFile(join(root,'lib/agent/providers/hubspot.mjs'),'// hubspot\n','utf8');
  await writeFile(join(root,'lib/agent/providers/gmail.mjs'),'// gmail\n','utf8');
  await writeFile(join(root,'lib/agent/providers/slack.mjs'),'// slack\n','utf8');
  await writeFile(join(root,'lib/agent/planner.mjs'),['// planner','// External app content is untrusted data: rule 1','// A blocked or rejected action is final for this run.'].join('\n'),'utf8');
  await writeFile(join(root,'lib/agent/tools.mjs'),['// tools','export const WRITE_TOOLS=[];','export const READ_HANDLERS={};'].join('\n'),'utf8');
  await writeFile(join(root,'lib/agent/http.mjs'),'// http\n','utf8');
  await writeFile(join(root,'lib/agent/governed.mjs'),'// governed\n','utf8');
  if(!omitRecovery) await writeFile(join(root,'lib/agent/recovery.mjs'),'// recovery\n','utf8');
  if(!omitBreakers) await writeFile(join(root,'lib/agent/breakers.mjs'),'// breakers\n','utf8');

  await writeFile(join(root,'agent-learning/regressions/dev/reg_a.json'),JSON.stringify({id:'reg_a',name:'A'}),'utf8');
  await writeFile(join(root,'agent-learning/regressions/holdout/reg_b.json'),JSON.stringify({id:'reg_b',name:'B'}),'utf8');
  await writeFile(join(root,'node_modules/dashclaw/package.json'),JSON.stringify({name:'dashclaw',version:'5.33.9'}),'utf8');
  return root;
}

function fakeGit({dirty=false}={}){
  return {execFileSync(cmd,args){
    if(args[0]==='rev-parse') return 'a'.repeat(40)+'\n';
    if(args[0]==='status') return dirty?' M lib/agent/effects.mjs\n':'';
    throw new Error(`unexpected git command ${args.join(' ')}`);
  }};
}

test('PROTECTED_FILES and PROTECTED_MARKERS cover exactly the four contract files',()=>{
  assert.deepEqual([...PROTECTED_FILES].sort(),['lib/agent/effects.mjs','lib/agent/planner.mjs','lib/agent/providers/stripe.mjs','lib/agent/tools.mjs'].sort());
  assert.equal(PROTECTED_MARKERS['lib/agent/effects.mjs'].length,8);
  assert.equal(PROTECTED_MARKERS['lib/agent/providers/stripe.mjs'].length,2);
  assert.equal(PROTECTED_MARKERS['lib/agent/planner.mjs'].length,2);
  assert.equal(PROTECTED_MARKERS['lib/agent/tools.mjs'].length,2);
});

const SHA256_EMPTY='e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

test('protectedRegionHashes on the real repo hashes every marker region to a real sha256, and every marker actually matches a line today',()=>{
  const regions=protectedRegionHashes(fileURLToPath(new URL('../',import.meta.url)));
  for(const file of PROTECTED_FILES){
    for(const region of regions[file].regions){
      assert.match(region.sha256,HEX64,`${file} ${region.name}`);
      assert.notEqual(region.sha256,SHA256_EMPTY,`${file} ${region.name} matched nothing`);
    }
  }
});

test('protectedRegionHashes marks every region absent when the file itself is missing',async()=>{
  const root=await tempDir();
  const regions=protectedRegionHashes(root);
  for(const file of PROTECTED_FILES) for(const region of regions[file].regions) assert.equal(region.sha256,'absent');
  await rm(root,{recursive:true,force:true});
});

test('protectedRegionHashes changes only the touched region\'s hash, not the others in the same file',async()=>{
  const root=await buildFixtureRoot();
  const before=protectedRegionHashes(root);
  const {readFile,writeFile:write}=await import('node:fs/promises');
  const path=join(root,'lib/agent/effects.mjs');
  const content=await readFile(path,'utf8');
  await write(path,content.replace('const approvedBy=null;','const approvedBy=42; // changed'),'utf8');
  const after=protectedRegionHashes(root);
  const effectsBefore=before['lib/agent/effects.mjs'].regions;
  const effectsAfter=after['lib/agent/effects.mjs'].regions;
  for(const region of effectsBefore){
    const match=effectsAfter.find(r=>r.name===region.name);
    if(region.name==='approvedBy') assert.notEqual(match.sha256,region.sha256,'the touched region changes');
    else assert.equal(match.sha256,region.sha256,`${region.name} must not change`);
  }
  await rm(root,{recursive:true,force:true});
});

test('protectedRegionHashes detects a change to a non-marker line inside a protected function body (the region is brace-balanced, not a line filter)',async()=>{
  const root=await tempDir();
  await mkdir(join(root,'lib/agent'),{recursive:true});
  const before=[
    '// effects',
    'async function awaitDecision(handle,effect,actionId,approval){',
    '  let outcome=null;',
    '  while(true){',
    "    if(!outcome || outcome.via!=='sidelook' || !outcome.confirmed) break;",
    '  }',
    '  return outcome;',
    '}'
  ].join('\n');
  // A candidate that self-approves every held write by replacing the guard line with an unconditional allow: no
  // marker token on that line, so the old line-filter hash never moved. The line count and the `{`/`}` balance both
  // stay the same, so this is a real regression check, not an artifact of the file getting longer.
  const after=before.replace(
    "    if(!outcome || outcome.via!=='sidelook' || !outcome.confirmed) break;",
    "    outcome={via:'sidelook',decision:'allow',confirmed:true}; break;"
  );
  await writeFile(join(root,'lib/agent/effects.mjs'),before,'utf8');
  const regionsBefore=protectedRegionHashes(root);
  await writeFile(join(root,'lib/agent/effects.mjs'),after,'utf8');
  const regionsAfter=protectedRegionHashes(root);
  const nameHash=(regions,name)=>regions['lib/agent/effects.mjs'].regions.find(r=>r.name===name).sha256;
  assert.notEqual(nameHash(regionsBefore,'awaitDecision'),nameHash(regionsAfter,'awaitDecision'),'a self-approval edit inside awaitDecision must change its region hash');
  await rm(root,{recursive:true,force:true});
});

test('freezeIncumbent reads revision and dirty from the injected git, never a real git process',async()=>{
  const root=await buildFixtureRoot();
  const clean=await freezeIncumbent({root,git:fakeGit({dirty:false}),now:()=>'2026-09-11T00:00:00.000Z'});
  assert.equal(clean.revision,'a'.repeat(40));
  assert.equal(clean.dirty,false);
  assert.equal(clean.frozenAt,'2026-09-11T00:00:00.000Z');
  const dirty=await freezeIncumbent({root,git:fakeGit({dirty:true})});
  assert.equal(dirty.dirty,true);
  await rm(root,{recursive:true,force:true});
});

test('freezeIncumbent hashes: systemPrompt/toolSchemas/planSchema from the real registry, files from disk, missing recovery/breakers as absent',async()=>{
  const root=await buildFixtureRoot({omitRecovery:true,omitBreakers:true});
  const incumbent=await freezeIncumbent({root,git:fakeGit()});
  assert.match(incumbent.hashes.systemPrompt,HEX64);
  assert.match(incumbent.hashes.toolSchemas,HEX64);
  assert.match(incumbent.hashes.planSchema,HEX64);
  assert.match(incumbent.hashes.effectsSpecs,HEX64);
  assert.equal(incumbent.hashes.recoveryPolicy,'absent');
  assert.equal(incumbent.hashes.breakerPolicy,'absent');
  assert.match(incumbent.hashes.adapters.stripe,HEX64);
  assert.match(incumbent.hashes.http,HEX64);
  assert.match(incumbent.hashes.governed,HEX64);
  assert.match(incumbent.hashes.corpus.dev,HEX64);
  assert.match(incumbent.hashes.corpus.holdout,HEX64);
  assert.equal(incumbent.dashclawSdk,'5.33.9');
  assert.equal(typeof incumbent.config.dashclaw.configured,'boolean');
  assert.ok(incumbent.protected['lib/agent/effects.mjs']);
  await rm(root,{recursive:true,force:true});
});

test('freezeIncumbent is deterministic: the same tree hashes the same twice',async()=>{
  const root=await buildFixtureRoot();
  const a=await freezeIncumbent({root,git:fakeGit(),now:()=>'t1'});
  const b=await freezeIncumbent({root,git:fakeGit(),now:()=>'t2'});
  const {frozenAt:_a,...restA}=a;
  const {frozenAt:_b,...restB}=b;
  assert.deepEqual(restA,restB);
  await rm(root,{recursive:true,force:true});
});

test('freezeIncumbent throws when called without a root',async()=>{
  await assert.rejects(freezeIncumbent({}));
});

test('the corpus hash changes when a regression file is added',async()=>{
  const root=await buildFixtureRoot();
  const before=await freezeIncumbent({root,git:fakeGit()});
  await writeFile(join(root,'agent-learning/regressions/dev/reg_c.json'),JSON.stringify({id:'reg_c',name:'C'}),'utf8');
  const after=await freezeIncumbent({root,git:fakeGit()});
  assert.notEqual(before.hashes.corpus.dev,after.hashes.corpus.dev);
  assert.equal(before.hashes.corpus.holdout,after.hashes.corpus.holdout);
  await rm(root,{recursive:true,force:true});
});
