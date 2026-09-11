// agent-learning/lib/review.mjs: block → rejected_by_review, unreviewed never eligible, same-model review not independent.
// Contract: docs/AGENT_LEARNING_LOOP.md §10. The inference seam is a hand-built fake; no model, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {independentReview,applyReviewDecision,REVIEW_SCHEMA} from '../agent-learning/lib/review.mjs';
import {REASONS} from '../agent-learning/lib/compare.mjs';
import {createLearningInference} from '../agent-learning/lib/inference.mjs';

// A fake inference matching agent-learning/lib/inference.mjs's signature: ({system,prompt,schema,stage,key,model}) -> {result,model}.
function fakeInference(result,model='opus'){
  return async({stage})=>{
    if(stage!=='review') throw Object.assign(new Error(`unexpected stage ${stage}`),{code:'FIXTURE_MISSING'});
    return {result,model};
  };
}

const CANDIDATE={candidateId:'cand_abc123',hypothesis:{hypothesisKey:'recovery_policy:transient_provider:max_attempts_4'}};

test('REVIEW_SCHEMA fixes the verdict enum and the required fields',()=>{
  assert.deepEqual(REVIEW_SCHEMA.properties.verdict.enum,['approve','block']);
  assert.deepEqual(REVIEW_SCHEMA.required,['verdict','blocking','concerns']);
});

test('no inference seam => skipped, no verdict, and never independent',async()=>{
  const review=await independentReview({candidate:CANDIDATE,diff:'',before:{},after:{},inference:null,reviewModel:'opus',generatorModel:'sonnet'});
  assert.deepEqual(review,{skipped:'no model',verdict:null,blocking:[],concerns:[],independent:false,model:null});
});

test('an approving, independent review yields promote_eligible with promoteEligible true',async()=>{
  const inference=fakeInference({verdict:'approve',blocking:[],concerns:['minor style note']},'opus');
  const review=await independentReview({candidate:CANDIDATE,diff:'diff text',before:{},after:{},inference,reviewModel:'opus',generatorModel:'sonnet'});
  assert.equal(review.verdict,'approve');
  assert.equal(review.independent,true);
  assert.equal(review.model,'opus');
  assert.deepEqual(review.blocking,[]);

  const decision={decision:'promote_eligible',reasons:[]};
  const applied=applyReviewDecision(CANDIDATE,decision,review);
  assert.equal(applied.status,'promote_eligible');
  assert.equal(applied.promoteEligible,true);
  assert.equal(applied.reason,null);
});

test('a blocking review rejects with the blocking list, whatever compare decided',async()=>{
  const blocking=[{title:'governance bypass',file:'lib/agent/effects.mjs',why:'skips the governed claim before the write'}];
  const inference=fakeInference({verdict:'block',blocking,concerns:[]},'opus');
  const review=await independentReview({candidate:CANDIDATE,diff:'diff text',before:{},after:{},inference,reviewModel:'opus',generatorModel:'sonnet'});
  assert.equal(review.verdict,'block');

  const decision={decision:'promote_eligible',reasons:[]};
  const applied=applyReviewDecision(CANDIDATE,decision,review);
  assert.equal(applied.status,'rejected_by_review');
  assert.deepEqual(applied.blocking,blocking);
});

test('a missing review (skipped) leaves a promote_eligible candidate unpromoted, reason unreviewed',()=>{
  const decision={decision:'promote_eligible',reasons:[]};
  const applied=applyReviewDecision(CANDIDATE,decision,undefined);
  assert.equal(applied.status,'promote_eligible');
  assert.equal(applied.promoteEligible,false);
  assert.equal(applied.reason,REASONS.UNREVIEWED);
});

test('a review whose model equals the generator\'s is recorded independent:false and does not count, even on approve',async()=>{
  const inference=fakeInference({verdict:'approve',blocking:[],concerns:[]},'sonnet');
  const review=await independentReview({candidate:CANDIDATE,diff:'diff text',before:{},after:{},inference,reviewModel:'sonnet',generatorModel:'sonnet'});
  assert.equal(review.independent,false);
  assert.equal(review.verdict,'approve');

  const decision={decision:'promote_eligible',reasons:[]};
  const applied=applyReviewDecision(CANDIDATE,decision,review);
  assert.equal(applied.status,'promote_eligible');
  assert.equal(applied.promoteEligible,false);
  assert.equal(applied.reason,REASONS.UNREVIEWED);
});

test('a candidate compare already rejected keeps that status regardless of any review',()=>{
  const decision={decision:'rejected',reasons:[REASONS.HOLDOUT_REGRESSION]};
  const applied=applyReviewDecision(CANDIDATE,decision,{verdict:'approve',independent:true});
  assert.equal(applied.status,'rejected');
  assert.equal(applied.reason,REASONS.HOLDOUT_REGRESSION);
});

test('a candidate compare sent to needs_human_review keeps that status regardless of any review',()=>{
  const decision={decision:'needs_human_review',reasons:[REASONS.GOVERNANCE_SURFACE]};
  const applied=applyReviewDecision(CANDIDATE,decision,undefined);
  assert.equal(applied.status,'needs_human_review');
  assert.equal(applied.reason,REASONS.GOVERNANCE_SURFACE);
});

// The bug this closes: independentReview passes {model:reviewModel} into the inference seam per call (review.mjs:38-41),
// but createLearningInference previously always used its closure's own `model`, so review independence was asserted
// from a parameter with no real effect. This proves the seam itself now honours the per-call override.
test('createLearningInference honours a per-call model/effort override, not just its closure default',async()=>{
  const calls=[];
  const fakeVision={
    async generate(system,parts,schema,signal,options){
      calls.push(options);
      return {result:{ok:true},model:`provider-model-for-${options.model}`};
    }
  };
  const inference=createLearningInference({model:'sonnet',effort:'medium',vision:fakeVision});
  const outcome=await inference({system:'s',prompt:'p',schema:{},model:'opus',effort:'high'});
  assert.equal(calls[0].model,'opus','the per-call override, not the closure default sonnet, reached Vision.generate');
  assert.equal(calls[0].effort,'high');
  assert.equal(outcome.model,'provider-model-for-opus');

  // No override given: falls back to the closure default.
  await inference({system:'s',prompt:'p',schema:{}});
  assert.equal(calls[1].model,'sonnet');
  assert.equal(calls[1].effort,'medium');
});

test('an unparseable verdict from the model is treated as block, not silently approved',async()=>{
  const inference=fakeInference({verdict:'yes please',blocking:[],concerns:[]},'opus');
  const review=await independentReview({candidate:CANDIDATE,diff:'',before:{},after:{},inference,reviewModel:'opus',generatorModel:'sonnet'});
  assert.equal(review.verdict,'block');
});
