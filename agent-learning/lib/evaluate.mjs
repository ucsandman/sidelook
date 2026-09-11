// Runs one tree (the incumbent worktree, or a candidate's) through the test suite, the eval harness and the regression
// corpus, and reduces the output to an EvaluationRecord. Never a live API: the child process gets an allowlisted
// environment with RUN_LIVE_AGENT_TESTS unset. Contract: docs/AGENT_LEARNING_LOOP.md §8.
//
// Deviation from the literal §8 code block, needed by agent-learning/lib/compare.mjs's per-scenario rule (§9 rule 1): here
// `eval.byScenario[id]` and `dev.byId[id]` / `holdout.byId[id]` are `{pass, status, invariants}`, not a bare boolean or
// `{pass,status}`. compare.mjs needs the per-scenario invariant counts to find *which* case a new violation belongs to;
// nothing else in this record can carry that. Reported to the parent.
import {randomBytes} from 'node:crypto';
import {mkdtemp,readFile,readdir,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';

const ENV_ALLOWLIST=['PATH','SystemRoot','TEMP','TMP','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','ComSpec'];
const EMPTY_INVARIANTS=()=>({unclaimedWrites:0,duplicateEffects:0,incorrectSuccessClaims:0,unheldFinancialWrites:0,secretLeaks:0,injectionAuthorized:0});
const MODULE_MISSING=/Cannot find module|MODULE_NOT_FOUND|cannot find package/i;

function buildChildEnv(agentDataDir){
  const env={};
  for(const key of ENV_ALLOWLIST) if(process.env[key]!==undefined) env[key]=process.env[key];
  env.NODE_OPTIONS='';
  env.SIDELOOK_AGENT_DATA=agentDataDir;
  delete env.RUN_LIVE_AGENT_TESTS;
  return env;
}

// The runner is injectable so tests can supply canned {status, stdout, stderr} without spawning anything. The default
// spawns real `node` processes with cwd=root and the allowlisted environment above.
async function defaultRunner({root,set,out,timeoutMs,env,regressionsDir}){
  // The child runs with cwd=root (a worktree); every path handed to it is absolute so its report lands where this process reads it.
  const jsonPath=resolve(out,`${set}.json`);
  let args;
  if(set==='tests'){
    const files=(await readdir(join(root,'tests')).catch(() => [])).filter(f=>f.endsWith('.test.mjs')).sort();
    args=['--test','--test-reporter=tap',...files.map(f=>join('tests',f))];
  }else if(set==='eval'){
    args=['eval/run.mjs','--json',jsonPath];
  }else if(set==='dev' || set==='holdout'){
    // The corpus is the loop's own, never the tree's: a worktree checked out before this run's new regression files still runs them.
    args=['agent-learning/regress.mjs','--set',set,'--json',jsonPath,...(regressionsDir?['--regressions',resolve(regressionsDir)]:[])];
  }else{
    throw Object.assign(new Error(`Unknown evaluation set "${set}".`),{code:'INVALID_SET'});
  }
  const result=spawnSync(process.execPath,args,{cwd:root,env,timeout:timeoutMs,encoding:'utf8',maxBuffer:64*1024*1024});
  return {status:result.status ?? (result.error ? 1 : 0),stdout:result.stdout || '',stderr:result.stderr || '',error:result.error,jsonPath};
}

function parseTestSummary(stdout){
  const pass=Number(/^# pass (\d+)/m.exec(stdout)?.[1] ?? 0);
  const fail=Number(/^# fail (\d+)/m.exec(stdout)?.[1] ?? 0);
  const skipped=Number(/^# skipped (\d+)/m.exec(stdout)?.[1] ?? 0);
  const failing=[...stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map(m=>m[1].trim()).slice(0,20);
  return {pass,fail,skipped,failing};
}

async function readJson(path){
  try{return JSON.parse(await readFile(path,'utf8'));}
  catch{return null;}
}

// Removes a set's report file (out/<set>.json, the path defaultRunner writes) before the runner is invoked, so a run that
// crashes or exits without writing a fresh report can never be scored on a report a previous invocation left behind in the
// same `out` directory (the caller-supplied out dir is reused across the incumbent and every candidate in a real loop run).
async function clearStaleReport(out,set){
  try{await unlink(join(out,`${set}.json`));}catch{ /* nothing to clear: the common case */ }
}

// eval/run.mjs's own report shape: {generatedAt, scenarios:[{id,name,pass,status,invariants,...}], metrics:{...}}.
// regress.mjs writes the same shape for a set (see agent-learning/regress.mjs).
function byScenarioFromReport(report){
  const byId={};
  for(const scenario of report?.scenarios || []) byId[scenario.id]={pass:!!scenario.pass,status:scenario.status ?? null,invariants:scenario.invariants || EMPTY_INVARIANTS(),incidents:scenario.incidents || []};
  return byId;
}

function sumInvariants(byId){
  const total=EMPTY_INVARIANTS();
  for(const entry of Object.values(byId)) for(const key of Object.keys(total)) total[key]+=entry.invariants?.[key] || 0;
  return total;
}

async function runTestsSet({root,out,timeoutMs,runner,env}){
  const raw=await runner({root,set:'tests',out,timeoutMs,env});
  const summary=parseTestSummary(raw.stdout);
  return {pass:summary.pass,fail:summary.fail,skipped:summary.skipped,ok:raw.status===0 && summary.fail===0,ran:true,failing:summary.failing};
}

async function runEvalSet({root,out,timeoutMs,runner,env}){
  await clearStaleReport(out,'eval');
  const raw=await runner({root,set:'eval',out,timeoutMs,env});
  const missing=raw.status!==0 && MODULE_MISSING.test(raw.stderr || '');
  if(missing) return {scenariosPassed:0,scenariosTotal:0,byScenario:{},metrics:{},invariants:EMPTY_INVARIANTS(),ok:false,missing:true};
  const report=await readJson(raw.jsonPath);
  if(!report){
    return {scenariosPassed:0,scenariosTotal:0,byScenario:{},metrics:{},invariants:EMPTY_INVARIANTS(),ok:false,stderrTail:(raw.stderr || '').slice(-2000)};
  }
  const byScenario=byScenarioFromReport(report);
  return {
    scenariosPassed:report.metrics?.scenariosPassed ?? Object.values(byScenario).filter(s=>s.pass).length,
    scenariosTotal:report.metrics?.scenariosTotal ?? Object.keys(byScenario).length,
    byScenario, metrics:report.metrics || {}, invariants:report.metrics?.invariants || sumInvariants(byScenario), ok:raw.status===0
  };
}

async function runRegressionSet({root,set,out,timeoutMs,runner,env,regressionsDir}){
  await clearStaleReport(out,set);
  const raw=await runner({root,set,out,timeoutMs,env,regressionsDir});
  if(raw.status!==0){
    if(MODULE_MISSING.test(raw.stderr || '') && /regress\.mjs/.test(raw.stderr || '')) return {passed:0,total:0,missing:true,byId:{},invariants:EMPTY_INVARIANTS(),ok:false};
    const report=await readJson(raw.jsonPath);
    if(!report) return {passed:0,total:0,byId:{},invariants:EMPTY_INVARIANTS(),ok:false,stderrTail:(raw.stderr || '').slice(-2000)};
    const byId=byScenarioFromReport(report);
    return {passed:report.metrics?.scenariosPassed ?? Object.values(byId).filter(s=>s.pass).length,total:report.metrics?.scenariosTotal ?? Object.keys(byId).length,byId,invariants:report.metrics?.invariants || sumInvariants(byId),ok:false,stderrTail:(raw.stderr || '').slice(-2000)};
  }
  const report=await readJson(raw.jsonPath);
  if(!report) return {passed:0,total:0,byId:{},invariants:EMPTY_INVARIANTS(),ok:false};
  const byId=byScenarioFromReport(report);
  return {passed:report.metrics?.scenariosPassed ?? Object.values(byId).filter(s=>s.pass).length,total:report.metrics?.scenariosTotal ?? Object.keys(byId).length,byId,invariants:report.metrics?.invariants || sumInvariants(byId),ok:true};
}

const RECOVERY_FAILURE_RESULTS=new Set(['retried_failed','stopped_uncertain','stopped_partial','failed_closed']);

// Best-effort metric derivation. The contract (§8) names these fourteen fields without formulas; avgToolCalls and
// avgRecoveryAttempts are not derivable from eval/run.mjs's current per-scenario result (no tool-call or attempt count is
// in that JSON), so they are reported 0 with a note here rather than invented. Reported to the parent as an open question.
function deriveMetrics({eval:evalSet,dev,holdout}){
  const sets=[evalSet,dev,holdout];
  const totalScenarios=sets.reduce((n,s)=>n+(s.scenariosTotal ?? s.total ?? 0),0);
  const passedScenarios=sets.reduce((n,s)=>n+(s.scenariosPassed ?? s.passed ?? 0),0);
  const requested=n=>n.metrics?.requestedWrites ?? 0, verified=n=>n.metrics?.verifiedWrites ?? 0, uncertain=n=>n.metrics?.uncertainWrites ?? 0;
  const totalRequested=requested(evalSet)+(dev.metrics?.requestedWrites || 0)+(holdout.metrics?.requestedWrites || 0);
  const totalVerified=verified(evalSet)+(dev.metrics?.verifiedWrites || 0)+(holdout.metrics?.verifiedWrites || 0);
  const totalUncertain=uncertain(evalSet)+(dev.metrics?.uncertainWrites || 0)+(holdout.metrics?.uncertainWrites || 0);
  const incorrectSuccessClaims=sets.reduce((n,s)=>n+(s.metrics?.incorrectSuccessClaims || 0),0);
  const duplicateSideEffects=sets.reduce((n,s)=>n+(s.metrics?.duplicateWrites || 0),0);
  const unauthorizedWriteAttempts=sets.reduce((n,s)=>n+((s.invariants?.unclaimedWrites || 0)+(s.invariants?.unheldFinancialWrites || 0)+(s.invariants?.injectionAuthorized || 0)),0);
  const successfulRecoveries=sets.reduce((n,s)=>n+(s.metrics?.successfulRecoveries || 0),0);
  const allIncidents=sets.flatMap(s=>Object.values(s.byScenario || s.byId || {}).flatMap(entry=>entry.incidents || []));
  const failedRecoveries=allIncidents.filter(i=>RECOVERY_FAILURE_RESULTS.has(i.recoveryResult)).length;
  const toolHallucinations=allIncidents.filter(i=>i.failureClass==='unsupported_tool_request').length;
  const malformedModelResponses=allIncidents.filter(i=>i.failureClass==='malformed_model_output').length;
  const unnecessaryUserEscalations=allIncidents.filter(i=>i.recoveryResult==='asked_user').length;
  const regressionCount=((dev.total || 0)-(dev.passed || 0))+((holdout.total || 0)-(holdout.passed || 0));
  return {
    scenarioSuccessRate:totalScenarios ? passedScenarios/totalScenarios : 0,
    verifiedCompletionRate:totalRequested ? totalVerified/totalRequested : 0,
    incorrectSuccessClaims, duplicateSideEffects, unauthorizedWriteAttempts, uncertainFinalStates:totalUncertain,
    successfulRecoveries, failedRecoveries, unnecessaryUserEscalations, toolHallucinations, malformedModelResponses,
    avgToolCalls:0, avgRecoveryAttempts:0, regressionCount
  };
}

function computeSafety({eval:evalSet,dev,holdout}){
  const violations=[];
  for(const [name,set] of [['eval',evalSet],['dev',dev],['holdout',holdout]]){
    for(const [invariant,count] of Object.entries(set.invariants || {})) if(count>0) violations.push({invariant,where:name,count});
  }
  return {ok:violations.length===0,violations};
}

// evaluateTree({root, sets, learnRunId, candidateId, revision, timeoutMs, runner, out}) -> EvaluationRecord (§8).
export async function evaluateTree({root,sets=['tests','eval','dev','holdout'],learnRunId,candidateId,revision,timeoutMs=600000,runner=defaultRunner,out,regressionsDir=null}={}){
  if(!root) throw Object.assign(new Error('evaluateTree requires root.'),{code:'INVALID_INPUT'});
  const startedAt=Date.now();
  const outDir=resolve(out || await mkdtemp(join(tmpdir(),'sidelook-agent-learning-eval-')));
  const agentDataDir=await mkdtemp(join(tmpdir(),'sidelook-agent-learning-data-'));
  const env=buildChildEnv(agentDataDir);

  // A set that never ran is recorded as such (ok:false, or ok:null/ran:false for tests), never fabricated as a clean pass:
  // compare's evaluation-incomplete guard and its required-tests rule both key on this. See §9 rule 1/2 and the
  // evaluation-incomplete finding.
  const results={};
  if(sets.includes('tests')) results.tests=await runTestsSet({root,out:outDir,timeoutMs,runner,env});
  else results.tests={pass:0,fail:0,skipped:0,ok:null,ran:false,failing:[]};
  results.eval=sets.includes('eval') ? await runEvalSet({root,out:outDir,timeoutMs,runner,env}) : {scenariosPassed:0,scenariosTotal:0,byScenario:{},metrics:{},invariants:EMPTY_INVARIANTS(),ok:false};
  results.dev=sets.includes('dev') ? await runRegressionSet({root,set:'dev',out:outDir,timeoutMs,runner,env,regressionsDir}) : {passed:0,total:0,byId:{},invariants:EMPTY_INVARIANTS(),ok:false};
  results.holdout=sets.includes('holdout') ? await runRegressionSet({root,set:'holdout',out:outDir,timeoutMs,runner,env,regressionsDir}) : {passed:0,total:0,byId:{},invariants:EMPTY_INVARIANTS(),ok:false};

  const metrics=deriveMetrics(results);
  const safety=computeSafety(results);

  return {
    evaluationId:`eval_${randomBytes(6).toString('hex')}`,
    learnRunId, candidateId:candidateId || 'incumbent', revision, at:new Date().toISOString(), elapsedMs:Date.now()-startedAt,
    tests:results.tests,
    // ok (and missing, where applicable) carried through from the runner result: compare's evaluation-incomplete guard
    // (§9 rule 1 precondition) needs to see that a set crashed or never ran, not just a zeroed-out clean-looking record.
    eval:{scenariosPassed:results.eval.scenariosPassed,scenariosTotal:results.eval.scenariosTotal,byScenario:results.eval.byScenario,metrics:results.eval.metrics,invariants:results.eval.invariants,ok:results.eval.ok,...(results.eval.missing ? {missing:true} : {})},
    dev:{passed:results.dev.passed,total:results.dev.total,byId:results.dev.byId,invariants:results.dev.invariants,ok:results.dev.ok,...(results.dev.missing ? {missing:true} : {})},
    holdout:{passed:results.holdout.passed,total:results.holdout.total,byId:results.holdout.byId,invariants:results.holdout.invariants,ok:results.holdout.ok,...(results.holdout.missing ? {missing:true} : {})},
    metrics, safety
  };
}

export {defaultRunner,EMPTY_INVARIANTS};
