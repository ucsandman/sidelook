// agent-learning/lib/compare.mjs: every rejection rule (docs/AGENT_LEARNING_LOOP.md §9), promotion eligibility, holdout
// regression, incumbent mismatch. All records are hand-built; no worktree, no model, no filesystem.
import test from 'node:test';
import assert from 'node:assert/strict';
import {compare,REASONS} from '../agent-learning/lib/compare.mjs';

const EMPTY_INVARIANTS=()=>({unclaimedWrites:0,duplicateEffects:0,incorrectSuccessClaims:0,unheldFinancialWrites:0,secretLeaks:0,injectionAuthorized:0});
const scenario=(pass,invariants={})=>({pass,status:pass ? 'ok' : 'fail',invariants:{...EMPTY_INVARIANTS(),...invariants}});

// A minimal EvaluationRecord: only the fields compare.mjs reads (byScenario/byId, total/passed or scenariosTotal/scenariosPassed,
// tests.ok, metrics, governanceTouch). `revision`/`parentRevision` link the pair the way candidates.mjs and evaluate.mjs would.
function record({revision='rev1',parentRevision,testsOk=true,eval:evalScenarios={},dev={},devTotal,devPassed,holdout={},holdoutTotal,holdoutPassed,metrics={},governanceTouch}={}){
  const devIds=Object.keys(dev),holdoutIds=Object.keys(holdout);
  return {
    revision, parentRevision, tests:{ok:testsOk,pass:1,fail:testsOk ? 0 : 1,skipped:0,failing:testsOk ? [] : ['a failing test']},
    eval:{byScenario:evalScenarios,scenariosPassed:Object.values(evalScenarios).filter(s=>s.pass).length,scenariosTotal:Object.keys(evalScenarios).length},
    dev:{byId:dev,total:devTotal ?? devIds.length,passed:devPassed ?? Object.values(dev).filter(s=>s.pass).length},
    holdout:{byId:holdout,total:holdoutTotal ?? holdoutIds.length,passed:holdoutPassed ?? Object.values(holdout).filter(s=>s.pass).length},
    metrics:{scenarioSuccessRate:0.5,...metrics},
    governanceTouch:governanceTouch || {touched:false,files:[],regions:[]}
  };
}

test('rule 1: a new zero-tolerance invariant rejects, naming the invariant and the scenario',()=>{
  const incumbent=record({eval:{e1:scenario(true,{unclaimedWrites:0})}});
  const candidate=record({parentRevision:'rev1',eval:{e1:scenario(true,{unclaimedWrites:1})}});
  const decision=compare(incumbent,candidate,{});
  assert.equal(decision.decision,'rejected');
  assert.deepEqual(decision.reasons,[REASONS.DASHCLAW_BYPASS]);
  assert.equal(decision.invariantViolations.length,1);
  assert.deepEqual(decision.invariantViolations[0],{invariant:'unclaimedWrites',scenario:'e1',set:'eval',before:0,after:1,reason:REASONS.DASHCLAW_BYPASS});
});

test('rule 1: the incumbent\'s own baseline violation never excuses a candidate that adds more',()=>{
  const incumbent=record({eval:{e1:scenario(true,{duplicateEffects:1})}});
  const candidate=record({parentRevision:'rev1',eval:{e1:scenario(true,{duplicateEffects:2})}});
  const decision=compare(incumbent,candidate,{});
  assert.equal(decision.decision,'rejected');
  assert.deepEqual(decision.reasons,[REASONS.DUPLICATE_EFFECT]);
});

test('rule 1: an unchanged (or improved) invariant count is not a new violation',()=>{
  const incumbent=record({eval:{e1:scenario(true,{secretLeaks:1})},dev:{d1:scenario(true)},holdout:{h1:scenario(true)}});
  const candidate=record({parentRevision:'rev1',eval:{e1:scenario(true,{secretLeaks:1})},dev:{d1:scenario(true)},holdout:{h1:scenario(true)},governanceTouch:{touched:false,files:[],regions:[]}});
  const decision=compare(incumbent,candidate,{});
  assert.equal(decision.invariantViolations.length,0);
});

test('rule 2: candidate tests failing rejects regardless of everything else',()=>{
  const incumbent=record({});
  const candidate=record({parentRevision:'rev1',testsOk:false});
  const decision=compare(incumbent,candidate,{});
  assert.equal(decision.decision,'rejected');
  assert.deepEqual(decision.reasons,[REASONS.REQUIRED_TESTS_FAILED]);
});

test('rule 3: an unexplained newly-failing eval/dev scenario rejects',()=>{
  const incumbent=record({eval:{e1:scenario(true)}});
  const candidate=record({parentRevision:'rev1',eval:{e1:scenario(false)}});
  const decision=compare(incumbent,candidate,{});
  assert.equal(decision.decision,'rejected');
  assert.deepEqual(decision.reasons,[REASONS.NEW_SCENARIO_FAILURE]);
  assert.deepEqual(decision.newFailures,[{set:'eval',scenario:'e1'}]);
});

test('rule 3: a newly-failing scenario named under couldRegress with a real justification routes to needs_human_review, not rejected',()=>{
  const incumbent=record({dev:{d1:scenario(true)}});
  const candidate=record({parentRevision:'rev1',dev:{d1:scenario(false)}});
  const hypothesis={couldRegress:{d1:'this case exercises the old retry path we intentionally removed here'}};
  const decision=compare(incumbent,candidate,{hypothesis});
  assert.equal(decision.decision,'needs_human_review');
  assert.deepEqual(decision.reasons,[REASONS.NEW_SCENARIO_FAILURE]);
});

test('rule 3: a couldRegress justification under 20 characters does not excuse the failure',()=>{
  const incumbent=record({dev:{d1:scenario(true)}});
  const candidate=record({parentRevision:'rev1',dev:{d1:scenario(false)}});
  const hypothesis={couldRegress:{d1:'too short'}};
  const decision=compare(incumbent,candidate,{hypothesis});
  assert.equal(decision.decision,'rejected');
  assert.deepEqual(decision.reasons,[REASONS.NEW_SCENARIO_FAILURE]);
});

test('rule 4: a holdout case that passed on the incumbent and fails on the candidate rejects',()=>{
  const incumbent=record({dev:{d1:scenario(true)},holdout:{h1:scenario(true)}});
  const candidate=record({parentRevision:'rev1',dev:{d1:scenario(true)},holdout:{h1:scenario(false)}});
  const decision=compare(incumbent,candidate,{});
  assert.equal(decision.decision,'rejected');
  assert.deepEqual(decision.reasons,[REASONS.HOLDOUT_REGRESSION]);
  assert.equal(decision.holdout.regressed,true);
});

test('rule 4: the target family must also pass every one of its own holdout cases, even ones that never passed before',()=>{
  const incumbent=record({dev:{d1:scenario(false)},holdout:{h1:scenario(false)}});
  const candidate=record({parentRevision:'rev1',dev:{d1:scenario(true)},holdout:{h1:scenario(false)}});
  const decision=compare(incumbent,candidate,{target:{regressionIds:['h1']}});
  assert.equal(decision.decision,'rejected');
  assert.deepEqual(decision.reasons,[REASONS.HOLDOUT_REGRESSION]);
});

test('rule 5: no previously-failing dev case in the target family flips to passing => no_measurable_improvement',()=>{
  const incumbent=record({dev:{d1:scenario(true)},holdout:{h1:scenario(true)}});
  const candidate=record({parentRevision:'rev1',dev:{d1:scenario(true)},holdout:{h1:scenario(true)}});
  const decision=compare(incumbent,candidate,{});
  assert.equal(decision.decision,'rejected');
  assert.deepEqual(decision.reasons,[REASONS.NO_MEASURABLE_IMPROVEMENT]);
});

test('rule 5: the named metric worsening rejects even when a dev case improved',()=>{
  const incumbent=record({dev:{d1:scenario(false)},holdout:{h1:scenario(true)},metrics:{scenarioSuccessRate:0.8}});
  const candidate=record({parentRevision:'rev1',dev:{d1:scenario(true)},holdout:{h1:scenario(true)},metrics:{scenarioSuccessRate:0.5}});
  const decision=compare(incumbent,candidate,{});
  assert.equal(decision.decision,'rejected');
  assert.deepEqual(decision.reasons,[REASONS.NO_MEASURABLE_IMPROVEMENT]);
});

test('rule 6: governance surface touched routes to needs_human_review even when the target improved cleanly',()=>{
  const incumbent=record({dev:{d1:scenario(false)},holdout:{h1:scenario(true)},metrics:{scenarioSuccessRate:0.5}});
  const candidate=record({parentRevision:'rev1',dev:{d1:scenario(true)},holdout:{h1:scenario(true)},metrics:{scenarioSuccessRate:0.8},governanceTouch:{touched:true,files:['lib/agent/effects.mjs'],regions:[]}});
  const decision=compare(incumbent,candidate,{});
  assert.equal(decision.decision,'needs_human_review');
  assert.deepEqual(decision.reasons,[REASONS.GOVERNANCE_SURFACE]);
});

test('rule 7: every rule passes => promote_eligible',()=>{
  const incumbent=record({dev:{d1:scenario(false)},holdout:{h1:scenario(true)},metrics:{scenarioSuccessRate:0.5}});
  const candidate=record({parentRevision:'rev1',dev:{d1:scenario(true)},holdout:{h1:scenario(true)},metrics:{scenarioSuccessRate:0.8}});
  const decision=compare(incumbent,candidate,{});
  assert.equal(decision.decision,'promote_eligible');
  assert.deepEqual(decision.reasons,[]);
  assert.equal(decision.target.improved,true);
});

test('a candidate whose parentRevision does not match the incumbent revision throws INCUMBENT_MISMATCH',()=>{
  const incumbent=record({revision:'rev1'});
  const candidate=record({parentRevision:'rev2'});
  assert.throws(()=>compare(incumbent,candidate,{}),error=>error.code==='INCUMBENT_MISMATCH');
});

test('compare requires both records',()=>{
  assert.throws(()=>compare(null,record({}),{}));
  assert.throws(()=>compare(record({}),undefined,{}));
});

test('a candidate record with no parentRevision throws INVALID_INPUT rather than silently skipping the mismatch gate',()=>{
  const incumbent=record({revision:'rev1'});
  const candidate=record({});
  delete candidate.parentRevision;
  assert.throws(()=>compare(incumbent,candidate,{}),error=>error.code==='INVALID_INPUT');
});

test('a candidate record with no governanceTouch throws INVALID_INPUT rather than letting rule 6 silently no-op',()=>{
  const incumbent=record({revision:'rev1'});
  const candidate=record({parentRevision:'rev1'});
  delete candidate.governanceTouch;
  assert.throws(()=>compare(incumbent,candidate,{}),error=>error.code==='INVALID_INPUT');
});

test('an eval run with an empty byScenario against a populated incumbent rejects as evaluation_incomplete, not a clean zero',()=>{
  const incumbent=record({eval:{e1:scenario(true),e2:scenario(true)}});
  const candidate=record({parentRevision:'rev1',eval:{}});
  // Simulate a crashed/never-ran eval set: evaluateTree carries ok:false through for exactly this case.
  candidate.eval.ok=false;
  const decision=compare(incumbent,candidate,{});
  assert.equal(decision.decision,'rejected');
  assert.deepEqual(decision.reasons,[REASONS.EVALUATION_INCOMPLETE]);
});

test('a dev/holdout set marked missing on the candidate rejects as evaluation_incomplete',()=>{
  const incumbent=record({dev:{d1:scenario(true)}});
  const candidate=record({parentRevision:'rev1',dev:{}});
  candidate.dev.missing=true;
  const decision=compare(incumbent,candidate,{});
  assert.equal(decision.decision,'rejected');
  assert.deepEqual(decision.reasons,[REASONS.EVALUATION_INCOMPLETE]);
});

test('rule 2: a candidate with fewer passing tests than the incumbent rejects as tests_weakened even when tests.ok is true',()=>{
  const incumbent=record({});
  incumbent.tests.pass=10;
  const candidate=record({parentRevision:'rev1'});
  candidate.tests.pass=8;
  const decision=compare(incumbent,candidate,{});
  assert.equal(decision.decision,'rejected');
  assert.deepEqual(decision.reasons,[REASONS.TESTS_WEAKENED]);
});

test('rule 2: a candidate that skips more tests than the incumbent rejects as tests_weakened',()=>{
  const incumbent=record({});
  incumbent.tests.skipped=0;
  const candidate=record({parentRevision:'rev1'});
  candidate.tests.skipped=3;
  const decision=compare(incumbent,candidate,{});
  assert.equal(decision.decision,'rejected');
  assert.deepEqual(decision.reasons,[REASONS.TESTS_WEAKENED]);
});

test('rule 2: a tests set that never ran (ran:false) rejects rather than passing on a fabricated ok:true',()=>{
  const incumbent=record({});
  const candidate=record({parentRevision:'rev1'});
  candidate.tests.ran=false;
  const decision=compare(incumbent,candidate,{});
  assert.equal(decision.decision,'rejected');
  assert.deepEqual(decision.reasons,[REASONS.REQUIRED_TESTS_FAILED]);
});

test('rule 3: couldRegress as the free-text string §6 actually emits (scenario id mentioned in the text) excuses the failure',()=>{
  const incumbent=record({dev:{d1:scenario(true)}});
  const candidate=record({parentRevision:'rev1',dev:{d1:scenario(false)}});
  const hypothesis={couldRegress:'This removes the retry path exercised by d1, which is expected to flip.'};
  const decision=compare(incumbent,candidate,{hypothesis});
  assert.equal(decision.decision,'needs_human_review');
});

test('target.familyKey with no resolvable ids throws INVALID_INPUT instead of silently treating every dev case as the target',()=>{
  const incumbent=record({dev:{d1:scenario(true)}});
  const candidate=record({parentRevision:'rev1',dev:{d1:scenario(true)}});
  assert.throws(()=>compare(incumbent,candidate,{target:{familyKey:'hubspot:transient_provider:hubspot.update_customer',metric:'scenarioSuccessRate'}}),error=>error.code==='INVALID_INPUT');
});

test('target.holdoutIds and target.devIds resolve independently, unlike the overloaded regressionIds',()=>{
  const incumbent=record({dev:{d1:scenario(false)},holdout:{h1:scenario(false),h2:scenario(true)}});
  const candidate=record({parentRevision:'rev1',dev:{d1:scenario(true)},holdout:{h1:scenario(false),h2:scenario(true)}});
  // h1 is not part of this target's holdout family (only h2 is), so its continued failure must not block promotion; d1 is
  // the dev target and it improved.
  const decision=compare(incumbent,candidate,{target:{devIds:['d1'],holdoutIds:['h2']}});
  assert.equal(decision.decision,'promote_eligible',JSON.stringify(decision));
});
