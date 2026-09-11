// Turns a hypothesis into an isolated candidate: a detached git worktree off the frozen incumbent revision, structured edits
// applied and parsed, one commit on its own branch. The main tree is never written. Contract: docs/AGENT_LEARNING_LOOP.md §7.
//
// Dependencies: the worktree lives under <root>/.worktrees/, so Node's upward module resolution from
// <root>/.worktrees/<id>/eval/run.mjs finds <root>/node_modules on its own. There is no junction, no symlink and no install:
// a junction into node_modules was followed by a recursive delete on 2026-09-11 and emptied the main tree's node_modules.
import {execFileSync} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {existsSync,lstatSync,rmSync} from 'node:fs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,isAbsolute,join,resolve,sep} from 'node:path';
import {protectedRegionHashes as incumbentRegionHashes,PROTECTED_MARKERS as INCUMBENT_MARKERS} from './incumbent.mjs';

// The full-file governance ban (docs/AGENT_LEARNING_LOOP.md §7): a candidate may not touch these at all. The harness that
// measures a candidate's own safety (eval/, the regression runner, the loop's own modules, CI) is on the list because a
// candidate that could edit the instrument could hide a violation from it. Regions inside allowed files are hashed by
// agent-learning/lib/incumbent.mjs, the one implementation both sides of a comparison use.
export const PROTECTED_FILES=[
  'lib/agent/governed.mjs','lib/agent/config.mjs','scripts/agent-setup-dashclaw.mjs','.env','.env.*',
  'package.json','package-lock.json','eval/fake-dashclaw.mjs','eval/fake-providers.mjs','eval/run.mjs','eval/scripted-model.mjs',
  'agent-learning/regressions/holdout/**','agent-learning/regress.mjs','agent-learning/learn.mjs','agent-learning/lib/**','.github/**'
];

async function loadProtectedDefaults(){
  return {protectedFiles:PROTECTED_FILES,protectedMarkers:INCUMBENT_MARKERS,regionHashes:root=>incumbentRegionHashes(root)};
}

function isProtectedFile(file,protectedFiles){
  const norm=file.replaceAll('\\','/');
  return protectedFiles.some(pattern=>{
    if(pattern.endsWith('/**')) return norm===pattern.slice(0,-3) || norm.startsWith(`${pattern.slice(0,-3)}/`);
    if(pattern==='.env.*') return norm.startsWith('.env.');
    return norm===pattern;
  });
}

function err(code,message,extra={}){return Object.assign(new Error(message),{code,...extra});}

// The node_modules a process in `root` would import from: `root/node_modules` or the nearest ancestor's, exactly the walk
// Node's own resolver makes. A candidate worktree under <repo>/.worktrees/<id> resolves to <repo>/node_modules; a
// nested worktree made by the test suite running inside a candidate resolves the same way. Null when nothing is found.
export function resolveNodeModules(root){
  let dir=resolve(root);
  for(let i=0;i<12;i++){
    if(existsSync(join(dir,'node_modules','dashclaw','package.json'))) return join(dir,'node_modules');
    const parent=dirname(dir);
    if(parent===dir) break;
    dir=parent;
  }
  return null;
}

const runGit=(args,opts={})=>execFileSync('git',args,{encoding:'utf8',...opts}).trim();

// Applies structured edits inside `root` (a worktree, or any directory in tests). `find` must occur exactly once in the
// target file; a miss or a duplicate returns {ok:false} rather than throwing, so createCandidate can record the hypothesis
// as a failure instead of crashing. Exported and pure-ish (no git calls) so it is directly testable.
export async function applyEdits(root,edits){
  const filesChanged=[];
  const rootAbs=resolve(root);
  for(const edit of edits || []){
    // Edits are model-authored, so the path is untrusted input: reject anything not a plain in-tree relative path before
    // touching the filesystem. Refusing here, rather than after join(), is what stops a `..` segment (or an absolute path)
    // from ever reaching readFile/writeFile outside `root`, which for a candidate worktree means the live main tree.
    if(typeof edit.file!=='string' || !edit.file || isAbsolute(edit.file)){
      return {ok:false,filesChanged,failed:{file:edit.file,reason:'edit_failed'}};
    }
    const path=resolve(root,edit.file);
    if(!(path+sep).startsWith(rootAbs+sep)) return {ok:false,filesChanged,failed:{file:edit.file,reason:'edit_failed'}};
    const normalizedFile=edit.file.replaceAll('\\','/');
    if(edit.create){
      if(typeof edit.content!=='string') return {ok:false,filesChanged,failed:{file:edit.file,reason:'edit_failed'}};
      await mkdir(dirname(path),{recursive:true});
      await writeFile(path,edit.content,'utf8');
      filesChanged.push(normalizedFile);
      continue;
    }
    if(typeof edit.find!=='string' || typeof edit.replace!=='string'){
      return {ok:false,filesChanged,failed:{file:edit.file,reason:'edit_failed'}};
    }
    let text;
    try{text=await readFile(path,'utf8');}
    catch{return {ok:false,filesChanged,failed:{file:edit.file,reason:'edit_failed'}};}
    const occurrences=text.split(edit.find).length-1;
    if(occurrences!==1) return {ok:false,filesChanged,failed:{file:edit.file,reason:'edit_failed'}};
    await writeFile(path,text.replace(edit.find,edit.replace),'utf8');
    filesChanged.push(normalizedFile);
  }
  return {ok:true,filesChanged,failed:null};
}

// createCandidate(params, options?) -> Candidate record (docs/AGENT_LEARNING_LOOP.md §7). `options` is {protectedFiles,
// protectedMarkers, regionHashes}, defaulted from loadProtectedDefaults() when omitted, so a caller never has to know
// whether agent-learning/lib/incumbent.mjs exists yet.
export async function createCandidate(params={},options={}){
  const {root,learnRunId,incumbent,hypothesis,edits,generator,worktreesDir=join(root || '.','.worktrees'),git=runGit}=params;
  if(!root || !incumbent?.revision || !Array.isArray(edits) || !edits.length) throw err('INVALID_INPUT','createCandidate requires root, incumbent.revision and a nonempty edits array.');

  const defaults=await loadProtectedDefaults();
  const protectedFiles=options.protectedFiles || defaults.protectedFiles;
  const protectedMarkers=options.protectedMarkers || defaults.protectedMarkers;
  const regionHashesFn=options.regionHashes || defaults.regionHashes;

  const candidateId=`cand_${randomBytes(6).toString('hex')}`;
  const branch=`agent-learning/${candidateId}`;
  // The worktree must sit inside the repository so the parent's node_modules resolves; anywhere else the evaluation could not import dashclaw.
  const rootAbs=resolve(root),treesAbs=resolve(worktreesDir);
  if(!(treesAbs+sep).startsWith(rootAbs+sep)) throw err('WORKTREE_OUTSIDE_ROOT',`worktreesDir must be inside the repository (${rootAbs}); got ${treesAbs}.`);
  if(!resolveNodeModules(rootAbs)) throw err('NODE_MODULES_MISSING','No node_modules/dashclaw is reachable above the repository root; run npm ci before creating candidates.');
  const worktreePath=join(treesAbs,candidateId);

  await mkdir(treesAbs,{recursive:true});
  git(['worktree','add','--detach',worktreePath,incumbent.revision],{cwd:root});

  const record={
    candidateId,learnRunId,parentRevision:incumbent.revision,incumbentHash:incumbent.hash,
    hypothesisKey:hypothesis?.hypothesisKey,hypothesis,generator,edits,filesChanged:[],diffHash:null,
    worktree:{path:worktreePath,branch,commit:null},governanceTouch:{touched:false,files:[],regions:[]},
    status:'created',reason:null,createdAt:new Date().toISOString()
  };

  // From here on, any unexpected throw (a malformed edit that slips past applyEdits' own checks, a filesystem error, …)
  // must not leave an orphan worktree/branch behind, so the rest of the function is wrapped and cleans up before rethrowing.
  try{
    const applied=await applyEdits(worktreePath,edits);
    record.filesChanged=applied.filesChanged;
    if(!applied.ok){
      record.status='invalid';
      record.reason=applied.failed.reason;
      return record;
    }

    for(const file of applied.filesChanged){
      if(!/\.(mjs|js)$/.test(file)) continue;
      try{execFileSync(process.execPath,['--check',join(worktreePath,file)],{stdio:'pipe'});}
      catch(error){
        record.status='invalid';
        record.reason='parse_failed';
        record.error=`${file}: ${String(error.message || error).slice(0,500)}`;
        return record;
      }
    }

    try{
      git(['checkout','-b',branch],{cwd:worktreePath});
      git(['add','-A'],{cwd:worktreePath});
      const commitEnv={...process.env,GIT_AUTHOR_NAME:'Sidelook Agent Learning Loop',GIT_COMMITTER_NAME:'Sidelook Agent Learning Loop',GIT_AUTHOR_EMAIL:'agent-learning@sidelook.local',GIT_COMMITTER_EMAIL:'agent-learning@sidelook.local'};
      git(['commit','-m',`candidate ${candidateId}: ${record.hypothesisKey || 'unknown'}`],{cwd:worktreePath,env:commitEnv});
    }catch(error){
      record.status='invalid';
      record.reason='commit_failed';
      record.error=String(error.message || error).slice(0,500);
      return record;
    }

    const commit=git(['rev-parse','HEAD'],{cwd:worktreePath});
    const diff=git(['diff',`${incumbent.revision}..${commit}`],{cwd:worktreePath});
    record.worktree.commit=commit;
    record.diffHash=createHash('sha256').update(diff).digest('hex');

    const candidateRegions=await regionHashesFn(worktreePath);
    const touchedFiles=applied.filesChanged.filter(file=>isProtectedFile(file,protectedFiles));
    const touchedRegions=[];
    // Only files this candidate actually edited: candidateRegions covers every marked file in the whole worktree, and an
    // untouched file's regions cannot legitimately differ from the incumbent's, whatever incumbent.regionHashes holds for it.
    for(const [file,{regions}] of Object.entries(candidateRegions)){
      if(!Object.hasOwn(protectedMarkers,file) || !applied.filesChanged.includes(file)) continue;
      const before=(incumbent.regionHashes || {})[file]?.regions || [];
      for(const region of regions){
        const prior=before.find(r=>r.name===region.name);
        if(!prior || prior.sha256!==region.sha256) touchedRegions.push({file,region:region.name});
      }
    }
    record.governanceTouch={touched:touchedFiles.length>0 || touchedRegions.length>0,files:touchedFiles,regions:touchedRegions};
    record.status=record.governanceTouch.touched ? 'needs_human_review' : 'created';
    return record;
  }catch(error){
    try{git(['worktree','remove','--force',worktreePath],{cwd:root});}catch{ /* best effort */ }
    throw error;
  }
}

// The incumbent's own checkout: a detached worktree at the frozen revision, so the baseline is measured on those exact bytes
// and never on a working tree someone may be editing while the loop runs (Discovery Loop's "freeze the baseline as bytes").
export async function checkoutIncumbent({root,revision,worktreesDir=join(root || '.','.worktrees'),label='incumbent',git=runGit}={}){
  if(!root || !revision) throw err('INVALID_INPUT','checkoutIncumbent requires root and revision.');
  const rootAbs=resolve(root),treesAbs=resolve(worktreesDir);
  if(!(treesAbs+sep).startsWith(rootAbs+sep)) throw err('WORKTREE_OUTSIDE_ROOT',`worktreesDir must be inside the repository (${rootAbs}); got ${treesAbs}.`);
  if(!resolveNodeModules(rootAbs)) throw err('NODE_MODULES_MISSING','No node_modules/dashclaw is reachable above the repository root; run npm ci first.');
  const path=join(treesAbs,`${label}-${randomBytes(4).toString('hex')}`);
  await mkdir(treesAbs,{recursive:true});
  git(['worktree','add','--detach',path,revision],{cwd:root});
  return {path,revision};
}
export function removeWorktree({root,path,git=runGit}){
  const link=join(path,'node_modules');
  try{if(lstatSync(link).isSymbolicLink()) rmSync(link);}catch{ /* no such link: the normal case */ }
  git(['worktree','remove','--force',path],{cwd:root});
}

export function removeCandidate({root,candidate,keepBranch=false,git=runGit}){
  const path=candidate.worktree.path;
  // Defence in depth: a link named node_modules inside the worktree is unlinked (the link only) before any recursive removal
  // runs, so nothing that follows links can reach the main tree's packages.
  const link=join(path,'node_modules');
  try{if(lstatSync(link).isSymbolicLink()) rmSync(link);}catch{ /* no such link: the normal case */ }
  git(['worktree','remove','--force',path],{cwd:root});
  if(!keepBranch) git(['branch','-D',candidate.worktree.branch],{cwd:root});
}
