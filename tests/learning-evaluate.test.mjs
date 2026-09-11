// agent-learning/lib/evaluate.mjs: parsing (tests/eval/regression output -> EvaluationRecord) and metric derivation, using
// a fake injected runner; plus one real spawn of `node --test` to prove the child environment is allowlisted (no leaked
// operator env var reaches the child). Contract: docs/AGENT_LEARNING_LOOP.md §8.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {evaluateTree,defaultRunner,EMPTY_INVARIANTS} from '../agent-learning/lib/evaluate.mjs';

const EMPTY=()=>EMPTY_INVARIANTS();

// A fake runner matching defaultRunner's interface ({root,set,out,timeoutMs,env}) -> {status,stdout,stderr,jsonPath}.
// It writes the same *.json report shape eval/run.mjs and regress.mjs write, so evaluateTree's own readJson path is
// exercised exactly as it would be against the real CLIs.
function fakeRunner({sets}){
  return async({set,out})=>{
    const jsonPath=join(out,`${set}.json`);
    if(set==='tests'){
      return {status:0,stdout:'TAP version 13\n1..3\nok 1 - a\nok 2 - b\nnot ok 3 - broken thing\n# pass 2\n# fail 1\n# skipped 0\n',stderr:'',jsonPath};
    }
    const report=sets[set];
    await writeFile(jsonPath,JSON.stringify(report),'utf8');
    return {status:0,stdout:'',stderr:'',jsonPath};
  };
}

const EVAL_REPORT={
  generatedAt:'2026-01-01T00:00:00.000Z',
  scenarios:[
    {id:'e1',pass:true,status:'ok',invariants:EMPTY(),incidents:[]},
    {id:'e2',pass:false,status:'fail',invariants:{...EMPTY(),unclaimedWrites:1},incidents:[{failureClass:'unsupported_tool_request',recoveryResult:'retried_failed'}]}
  ],
  metrics:{
    scenariosPassed:1,scenariosTotal:2,requestedWrites:3,verifiedWrites:2,uncertainWrites:1,
    incorrectSuccessClaims:0,duplicateWrites:0,successfulRecoveries:1,invariants:{...EMPTY(),unclaimedWrites:1}
  }
};
const DEV_REPORT={generatedAt:'2026-01-01T00:00:00.000Z',scenarios:[{id:'d1',pass:true,status:'ok',invariants:EMPTY(),incidents:[]}],metrics:{scenariosPassed:1,scenariosTotal:1,invariants:EMPTY()}};
const HOLDOUT_REPORT={generatedAt:'2026-01-01T00:00:00.000Z',scenarios:[{id:'h1',pass:false,status:'fail',invariants:EMPTY(),incidents:[{recoveryResult:'asked_user'}]}],metrics:{scenariosPassed:0,scenariosTotal:1,invariants:EMPTY()}};

test('evaluateTree parses tests/eval/dev/holdout output into an EvaluationRecord',async()=>{
  const out=await mkdtemp(join(tmpdir(),'sidelook-learning-evaluate-'));
  try{
    const runner=fakeRunner({sets:{eval:EVAL_REPORT,dev:DEV_REPORT,holdout:HOLDOUT_REPORT}});
    const record=await evaluateTree({root:'C:/does/not/matter',learnRunId:'run_test',candidateId:'cand_x',revision:'deadbeef',runner,out});

    assert.match(record.evaluationId,/^eval_[0-9a-f]{12}$/);
    assert.equal(record.candidateId,'cand_x');
    assert.equal(record.revision,'deadbeef');

    // tests: parsed from the TAP summary lines, not the exit code.
    assert.deepEqual(record.tests,{pass:2,fail:1,skipped:0,ok:false,ran:true,failing:['broken thing']});

    // eval: byScenario keyed by id, metrics passed through.
    assert.equal(record.eval.scenariosPassed,1);
    assert.equal(record.eval.scenariosTotal,2);
    assert.equal(record.eval.byScenario.e1.pass,true);
    assert.equal(record.eval.byScenario.e2.invariants.unclaimedWrites,1);

    // dev / holdout: byId, passed/total from the report.
    assert.deepEqual(record.dev,{passed:1,total:1,byId:record.dev.byId,invariants:EMPTY(),ok:true});
    assert.equal(record.dev.byId.d1.pass,true);
    assert.equal(record.holdout.passed,0);
    assert.equal(record.holdout.total,1);
    assert.equal(record.holdout.byId.h1.pass,false);

    // metric derivation, hand-computed from the fixtures above.
    assert.equal(record.metrics.scenarioSuccessRate,2/4);
    assert.equal(record.metrics.verifiedCompletionRate,2/3);
    assert.equal(record.metrics.uncertainFinalStates,1);
    assert.equal(record.metrics.unauthorizedWriteAttempts,1);
    assert.equal(record.metrics.successfulRecoveries,1);
    assert.equal(record.metrics.failedRecoveries,1);
    assert.equal(record.metrics.toolHallucinations,1);
    assert.equal(record.metrics.malformedModelResponses,0);
    assert.equal(record.metrics.unnecessaryUserEscalations,1);
    assert.equal(record.metrics.regressionCount,1);

    // safety: the one nonzero invariant, in eval, and nowhere else.
    assert.equal(record.safety.ok,false);
    assert.deepEqual(record.safety.violations,[{invariant:'unclaimedWrites',where:'eval',count:1}]);
  }finally{
    await rm(out,{recursive:true,force:true}).catch(() => {});
  }
});

test('a set whose runner exits non-zero still yields a record (ok:false) with a stderr tail, not a throw',async()=>{
  const out=await mkdtemp(join(tmpdir(),'sidelook-learning-evaluate-'));
  try{
    const runner=async({set,out:outDir})=>{
      if(set==='tests') return {status:1,stdout:'# pass 0\n# fail 1\n# skipped 0\n',stderr:'',jsonPath:join(outDir,'tests.json')};
      return {status:1,stdout:'',stderr:'boom: the harness crashed hard and this is the tail of that message',jsonPath:join(outDir,`${set}.json`)};
    };
    const record=await evaluateTree({root:'C:/does/not/matter',learnRunId:'run_test',revision:'deadbeef',runner,out});
    assert.equal(record.tests.ok,false);
    assert.equal(record.eval.byScenario && Object.keys(record.eval.byScenario).length,0);
    assert.equal(record.candidateId,'incumbent');
  }finally{
    await rm(out,{recursive:true,force:true}).catch(() => {});
  }
});

test('a missing regress.mjs in an old revision yields {passed:0,total:0,missing:true}, not a crash',async()=>{
  const out=await mkdtemp(join(tmpdir(),'sidelook-learning-evaluate-'));
  try{
    const runner=async({set,out:outDir})=>{
      if(set==='tests') return {status:0,stdout:'# pass 0\n# fail 0\n# skipped 0\n',stderr:'',jsonPath:join(outDir,'tests.json')};
      if(set==='eval') return {status:0,stdout:'',stderr:'',jsonPath:join(outDir,'eval.json')};
      return {status:1,stdout:'',stderr:"node:internal/modules/cjs/loader: Cannot find module 'C:\\\\old\\\\agent-learning\\\\regress.mjs'",jsonPath:join(outDir,`${set}.json`)};
    };
    // Pre-writes eval.json as if a previous invocation left it there; the eval runner below returns status 0 without
    // writing a fresh report. The staleness guard (clearStaleReport) must delete this before the runner is invoked, so
    // this stale report is never read as if it were this invocation's — proving record.eval.ok comes back false, not a
    // fabricated clean pass.
    await writeFile(join(out,'eval.json'),JSON.stringify({scenarios:[],metrics:{scenariosPassed:0,scenariosTotal:0}}),'utf8');
    const record=await evaluateTree({root:'C:/does/not/matter',learnRunId:'run_test',revision:'old',runner,out});
    assert.equal(record.eval.ok,false,'the pre-existing eval.json must not be read as this invocation\'s report');
    assert.deepEqual(record.dev,{passed:0,total:0,byId:{},invariants:EMPTY(),ok:false,missing:true});
    assert.deepEqual(record.holdout,{passed:0,total:0,byId:{},invariants:EMPTY(),ok:false,missing:true});
  }finally{
    await rm(out,{recursive:true,force:true}).catch(() => {});
  }
});

test('the sets option limits which are run; the rest come back as empty zero records',async()=>{
  const out=await mkdtemp(join(tmpdir(),'sidelook-learning-evaluate-'));
  try{
    let calls=0;
    const runner=async({set,out:outDir})=>{
      calls++;
      if(set==='tests') return {status:0,stdout:'# pass 1\n# fail 0\n# skipped 0\n',stderr:'',jsonPath:join(outDir,'tests.json')};
      throw new Error(`runner should not be called for set "${set}"`);
    };
    const record=await evaluateTree({root:'C:/does/not/matter',learnRunId:'run_test',revision:'x',runner,out,sets:['tests']});
    assert.equal(calls,1);
    assert.equal(record.tests.ok,true);
    // A set left out of `sets` genuinely never ran: it comes back ok:false, not indistinguishable from a set that ran
    // and found nothing (compare's evaluation-incomplete guard depends on this distinction).
    assert.deepEqual(record.eval,{scenariosPassed:0,scenariosTotal:0,byScenario:{},metrics:{},invariants:EMPTY(),ok:false});
    assert.deepEqual(record.dev,{passed:0,total:0,byId:{},invariants:EMPTY(),ok:false});
  }finally{
    await rm(out,{recursive:true,force:true}).catch(() => {});
  }
});

test('omitting tests from `sets` is recorded ok:null, ran:false, never a fabricated clean pass',async()=>{
  const out=await mkdtemp(join(tmpdir(),'sidelook-learning-evaluate-'));
  try{
    const runner=async({set,out:outDir})=>{
      const report={generatedAt:'2026-01-01T00:00:00.000Z',scenarios:[],metrics:{scenariosPassed:0,scenariosTotal:0}};
      await writeFile(join(outDir,`${set}.json`),JSON.stringify(report),'utf8');
      return {status:0,stdout:'',stderr:'',jsonPath:join(outDir,`${set}.json`)};
    };
    const record=await evaluateTree({root:'C:/does/not/matter',learnRunId:'run_test',revision:'x',runner,out,sets:['eval','dev','holdout']});
    assert.deepEqual(record.tests,{pass:0,fail:0,skipped:0,ok:null,ran:false,failing:[]});
  }finally{
    await rm(out,{recursive:true,force:true}).catch(() => {});
  }
});

// Real spawn: proves the child process environment is the allowlist from §8, not a copy of the operator's environment.
// The temp tree has no node_modules and no repo files; the probe test uses only node:test and node:assert built-ins.
test('a real node --test spawn never leaks an operator environment variable into the child',{timeout:30000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'sidelook-learning-evaluate-real-'));
  const out=await mkdtemp(join(tmpdir(),'sidelook-learning-evaluate-real-out-'));
  process.env.SECRET_PROBE='leak-me-not';
  try{
    await mkdir(join(root,'tests'),{recursive:true});
    await writeFile(join(root,'tests','probe.test.mjs'),
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\n" +
      "test('the child sees no SECRET_PROBE',()=>{ assert.equal(process.env.SECRET_PROBE,undefined); });\n",
      'utf8');

    const record=await evaluateTree({root,learnRunId:'run_test',revision:'x',runner:defaultRunner,out,sets:['tests']});
    assert.deepEqual(record.tests,{pass:1,fail:0,skipped:0,ok:true,ran:true,failing:[]},JSON.stringify(record.tests));
  }finally{
    delete process.env.SECRET_PROBE;
    await rm(root,{recursive:true,force:true}).catch(() => {});
    await rm(out,{recursive:true,force:true}).catch(() => {});
  }
});
