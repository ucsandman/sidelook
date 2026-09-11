// agent-learning/lib/candidates.mjs: worktree isolation, edit application, protected-surface detection, cleanup.
// Contract: docs/AGENT_LEARNING_LOOP.md §7. Uses a real git worktree off the current HEAD; never touches the main tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createCandidate,removeCandidate,applyEdits,resolveNodeModules} from '../agent-learning/lib/candidates.mjs';

const ROOT=fileURLToPath(new URL('..',import.meta.url));
const git=(args,opts={})=>execFileSync('git',args,{encoding:'utf8',cwd:ROOT,...opts}).trim();

// Worktrees must live inside the repository (candidates.mjs refuses anything else): the parent's node_modules is what a
// worktree's evaluation imports through Node's upward resolution. `.worktrees/` is ignored by git.
async function tempWorktreesDir(){return mkdtemp(join(ROOT,'.worktrees','test-'));}
import {mkdir} from 'node:fs/promises';
await mkdir(join(ROOT,'.worktrees'),{recursive:true});

// createCandidate's worktree is checked out from a git revision, so "exists" means tracked at HEAD, not merely present
// in the working directory (a parallel lane's untracked lib/agent/recovery.mjs would not be there).
const recoveryTrackedAtHead=(()=>{try{return git(['ls-tree','-r','HEAD','--name-only']).split('\n').includes('lib/agent/recovery.mjs');}catch{return false;}})();
const EDIT_FILE=recoveryTrackedAtHead ? 'lib/agent/recovery.mjs' : 'eval/README.md';
const EDIT_FIND=EDIT_FILE==='lib/agent/recovery.mjs' ? 'const MAX_WAIT_MS=30000;' : '# Agent mode evaluation harness';
const EDIT_REPLACE=EDIT_FILE==='lib/agent/recovery.mjs' ? 'const MAX_WAIT_MS=45000;' : '# Agent mode evaluation harness (edited)';

async function cleanupCandidate(candidate){
  if(!candidate?.worktree?.path) return;
  try{removeCandidate({root:ROOT,candidate,keepBranch:false});}catch{ /* already removed by the test, or never committed */ }
}

test('createCandidate isolates a worktree: main tree unchanged, worktree committed, branch named, node_modules resolves',async t=>{
  const worktreesDir=await tempWorktreesDir();
  // Registration order matters: node:test runs t.after hooks in the order they were added, and removeCandidate's
  // `git worktree remove` must run (and succeed) before the worktree's parent directory is rm -rf'd out from under it,
  // or the removal fails, is swallowed, and the branch is never deleted either (the leaked-branch finding).
  const candidateHolder={candidate:null};
  t.after(()=>cleanupCandidate(candidateHolder.candidate));
  t.after(async()=>{await rm(worktreesDir,{recursive:true,force:true}).catch(() => {});});
  const revision=git(['rev-parse','HEAD']);
  const beforeStatus=git(['status','--porcelain']);
  const beforeText=await readFile(join(ROOT,EDIT_FILE),'utf8');

  const candidate=await createCandidate({
    root:ROOT, learnRunId:'run_test', incumbent:{revision,hash:'incumbenthash',regionHashes:{}},
    hypothesis:{hypothesisKey:'test_edit_recovery_wait'}, edits:[{file:EDIT_FILE,find:EDIT_FIND,replace:EDIT_REPLACE}],
    generator:{fixture:true}, worktreesDir
  });
  candidateHolder.candidate=candidate;

  assert.equal(candidate.status,'created',JSON.stringify(candidate));
  assert.equal(candidate.candidateId.startsWith('cand_'),true);
  assert.equal(candidate.worktree.branch,`agent-learning/${candidate.candidateId}`);
  assert.match(candidate.worktree.commit,/^[0-9a-f]{40}$/);
  assert.deepEqual(candidate.filesChanged,[EDIT_FILE]);
  assert.equal(candidate.governanceTouch.touched,false);

  // The main tree: unchanged status, and the edited file still reads its original text.
  assert.equal(git(['status','--porcelain']),beforeStatus);
  assert.equal(await readFile(join(ROOT,EDIT_FILE),'utf8'),beforeText);

  // The worktree: the branch exists, the commit is reachable, and the file was actually edited there.
  const branches=git(['branch','--list',candidate.worktree.branch]);
  assert.match(branches,new RegExp(candidate.worktree.branch.replace('/','\\/')));
  const editedText=await readFile(join(candidate.worktree.path,EDIT_FILE),'utf8');
  assert.equal(editedText.includes(EDIT_REPLACE),true);
  // No link and no copy of node_modules in the worktree; a child process started there still resolves dashclaw through the parent tree.
  assert.equal(existsSync(join(candidate.worktree.path,'node_modules')),false,'the worktree carries no node_modules of its own');
  const resolved=execFileSync(process.execPath,['--input-type=module','-e','import("dashclaw").then(m=>console.log(typeof m.DashClaw))'],{cwd:candidate.worktree.path,encoding:'utf8'}).trim();
  assert.equal(resolved,'function','a process in the worktree imports dashclaw from the repository node_modules');
  // The packages a process here imports are the nearest ancestor's (this file may itself run inside a candidate worktree,
  // where ROOT has no node_modules of its own); whichever directory that is, it still holds dashclaw afterwards.
  const packages=resolveNodeModules(ROOT);
  assert.ok(packages,'a node_modules with dashclaw is reachable above ROOT');
  assert.equal(existsSync(join(packages,'dashclaw','package.json')),true,'the resolved node_modules is untouched');

  const commitLog=git(['log','-1','--format=%s',candidate.worktree.commit]);
  assert.equal(commitLog,`candidate ${candidate.candidateId}: test_edit_recovery_wait`);
});

test('an edit whose find does not match exactly once yields status invalid, reason edit_failed, without throwing',async t=>{
  const worktreesDir=await tempWorktreesDir();
  const candidateHolder={candidate:null};
  t.after(()=>cleanupCandidate(candidateHolder.candidate));
  t.after(async()=>{await rm(worktreesDir,{recursive:true,force:true}).catch(() => {});});
  const revision=git(['rev-parse','HEAD']);

  const candidate=await createCandidate({
    root:ROOT, learnRunId:'run_test', incumbent:{revision,hash:'incumbenthash',regionHashes:{}},
    hypothesis:{hypothesisKey:'test_bad_edit'}, edits:[{file:EDIT_FILE,find:'this text does not appear anywhere in the file',replace:'x'}],
    generator:{fixture:true}, worktreesDir
  });
  candidateHolder.candidate=candidate;

  assert.equal(candidate.status,'invalid');
  assert.equal(candidate.reason,'edit_failed');
});

test('an edit whose file escapes the worktree root is invalid and never touches the main tree',async t=>{
  const worktreesDir=await tempWorktreesDir();
  const candidateHolder={candidate:null};
  t.after(()=>cleanupCandidate(candidateHolder.candidate));
  t.after(async()=>{await rm(worktreesDir,{recursive:true,force:true}).catch(() => {});});
  const revision=git(['rev-parse','HEAD']);
  const beforeText=await readFile(join(ROOT,'lib','agent','governed.mjs'),'utf8').catch(()=>null);

  const candidate=await createCandidate({
    root:ROOT, learnRunId:'run_test', incumbent:{revision,hash:'incumbenthash',regionHashes:{}},
    hypothesis:{hypothesisKey:'test_escape_root'},
    edits:[{file:'../../lib/agent/governed.mjs',find:'x',replace:'y'}],
    generator:{fixture:true}, worktreesDir
  });
  candidateHolder.candidate=candidate;

  assert.equal(candidate.status,'invalid');
  assert.equal(candidate.reason,'edit_failed');
  if(beforeText!==null){
    assert.equal(await readFile(join(ROOT,'lib','agent','governed.mjs'),'utf8'),beforeText,'the main tree file is byte-identical afterwards');
  }
});

test('a create edit under the protected holdout corpus yields needs_human_review, naming the file',async t=>{
  const worktreesDir=await tempWorktreesDir();
  const candidateHolder={candidate:null};
  t.after(()=>cleanupCandidate(candidateHolder.candidate));
  t.after(async()=>{await rm(worktreesDir,{recursive:true,force:true}).catch(() => {});});
  const revision=git(['rev-parse','HEAD']);

  const candidate=await createCandidate({
    root:ROOT, learnRunId:'run_test', incumbent:{revision,hash:'incumbenthash',regionHashes:{}},
    hypothesis:{hypothesisKey:'test_touch_holdout'},
    edits:[{file:'agent-learning/regressions/holdout/x.json',create:true,content:'{}'}],
    generator:{fixture:true}, worktreesDir
  });
  candidateHolder.candidate=candidate;

  assert.equal(candidate.status,'needs_human_review');
  assert.equal(candidate.governanceTouch.touched,true);
  assert.deepEqual(candidate.governanceTouch.files,['agent-learning/regressions/holdout/x.json']);
});

test('a backslash edit path against a region-bearing file is still caught by the protected-region check',async t=>{
  const worktreesDir=await tempWorktreesDir();
  const candidateHolder={candidate:null};
  t.after(()=>cleanupCandidate(candidateHolder.candidate));
  t.after(async()=>{await rm(worktreesDir,{recursive:true,force:true}).catch(() => {});});
  const revision=git(['rev-parse','HEAD']);
  const effectsTracked=(()=>{try{return git(['ls-tree','-r','HEAD','--name-only']).split('\n').includes('lib/agent/effects.mjs');}catch{return false;}})();
  if(!effectsTracked){t.skip('lib/agent/effects.mjs is not tracked at HEAD in this checkout');return;}
  const effectsText=await readFile(join(ROOT,'lib','agent','effects.mjs'),'utf8');
  const markerLine=effectsText.split('\n').find(line=>/approvedBy/.test(line));
  if(!markerLine){t.skip('no approvedBy marker line found in lib/agent/effects.mjs');return;}

  const candidate=await createCandidate({
    root:ROOT, learnRunId:'run_test', incumbent:{revision,hash:'incumbenthash',regionHashes:{}},
    hypothesis:{hypothesisKey:'test_backslash_region'},
    edits:[{file:'lib\\agent\\effects.mjs',find:markerLine,replace:`${markerLine} // learning-test-touch`}],
    generator:{fixture:true}, worktreesDir
  });
  candidateHolder.candidate=candidate;

  assert.equal(candidate.governanceTouch.touched,true,JSON.stringify(candidate.governanceTouch));
});

test('removeCandidate leaves no worktree and no branch behind',async()=>{
  const worktreesDir=await tempWorktreesDir();
  try{
    const revision=git(['rev-parse','HEAD']);
    const candidate=await createCandidate({
      root:ROOT, learnRunId:'run_test', incumbent:{revision,hash:'incumbenthash',regionHashes:{}},
      hypothesis:{hypothesisKey:'test_remove'}, edits:[{file:EDIT_FILE,find:EDIT_FIND,replace:EDIT_REPLACE}],
      generator:{fixture:true}, worktreesDir
    });
    assert.equal(candidate.status,'created');

    removeCandidate({root:ROOT,candidate});

    const worktreeList=git(['worktree','list']);
    assert.equal(worktreeList.includes(candidate.candidateId),false,'git worktree list still shows the removed candidate');
    const branchList=git(['branch','--list','agent-learning/*']);
    assert.equal(branchList.includes(candidate.candidateId),false,'git branch --list agent-learning/* still shows the removed candidate');
    assert.equal(existsSync(candidate.worktree.path),false);
  }finally{
    await rm(worktreesDir,{recursive:true,force:true}).catch(() => {});
  }
});

test('applyEdits: create writes a new file, and a find that matches more than once also fails without throwing',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'sidelook-learning-applyedits-'));
  try{
    const created=await applyEdits(dir,[{file:'new/file.txt',create:true,content:'hello'}]);
    assert.equal(created.ok,true);
    assert.equal(await readFile(join(dir,'new','file.txt'),'utf8'),'hello');

    const {writeFile}=await import('node:fs/promises');
    await writeFile(join(dir,'dup.txt'),'aa aa','utf8');
    const dup=await applyEdits(dir,[{file:'dup.txt',find:'aa',replace:'bb'}]);
    assert.equal(dup.ok,false);
    assert.equal(dup.failed.reason,'edit_failed');

    // Path containment: a `..` escape and an absolute path are both refused without touching the filesystem outside dir.
    const escape=await applyEdits(dir,[{file:'../outside.txt',create:true,content:'x'}]);
    assert.equal(escape.ok,false);
    assert.equal(escape.failed.reason,'edit_failed');
    assert.equal(existsSync(join(dir,'..','outside.txt')),false);

    const absolute=await applyEdits(dir,[{file:process.platform==='win32'?'C:\\Windows\\outside.txt':'/tmp/outside.txt',create:true,content:'x'}]);
    assert.equal(absolute.ok,false);
    assert.equal(absolute.failed.reason,'edit_failed');

    // Malformed edits (not a string file, no content on create) are rejected instead of throwing.
    const badFile=await applyEdits(dir,[{file:42,create:true,content:'x'}]);
    assert.equal(badFile.ok,false);
    const noContent=await applyEdits(dir,[{file:'missing-content.txt',create:true}]);
    assert.equal(noContent.ok,false);
  }finally{
    await rm(dir,{recursive:true,force:true}).catch(() => {});
  }
});
