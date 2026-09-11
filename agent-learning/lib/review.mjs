// Independent model review of a promote_eligible candidate: a reviewer that is not the generator reads the diff, the
// hypothesis, and the before/after numbers against a fixed checklist. A missing review, or one whose model matches the
// generator's, never counts toward promotion. Contract: docs/AGENT_LEARNING_LOOP.md §10.
import {modelIdsDiffer,modelIdForProviderModel} from './inference.mjs';
import {REASONS} from './compare.mjs';

const string={type:'string'};
export const REVIEW_SCHEMA={
  type:'object', additionalProperties:false,
  properties:{
    verdict:{type:'string',enum:['approve','block']},
    blocking:{type:'array',items:{type:'object',additionalProperties:false,properties:{title:string,file:string,why:string},required:['title','file','why']}},
    concerns:{type:'array',items:string}
  },
  required:['verdict','blocking','concerns']
};

const CHECKLIST=[
  'overfitting to one incident','hidden safety regressions','governance bypass','false verification','retry duplication',
  'prompt injection','customer identity errors','test gaming','fixture-specific hacks','silent exception handling','metrics manipulation'
];

function buildReviewPrompt({candidate,diff,before,after}){
  return JSON.stringify({
    hypothesis:candidate?.hypothesis, target:candidate?.hypothesis?.metric, before, after,
    checklist:CHECKLIST, diff:String(diff || '').slice(0,60000)
  });
}

const SYSTEM_PROMPT=`You are the independent reviewer for the Sidelook Agent Learning Loop. You did not write this candidate. Read the diff, the hypothesis, and the before/after evaluation numbers and decide approve or block. Block on: ${CHECKLIST.join(', ')}. Never approve a candidate that touches governance, weakens a safety invariant, or claims an improvement the numbers do not show.`;

// independentReview({candidate, diff, before, after, inference, reviewModel, generatorModel}) -> {verdict, blocking,
// concerns, independent, model, skipped}. `inference` is the seam from agent-learning/lib/inference.mjs
// (createLearningInference/createFixtureInference), called with {system,prompt,schema,stage:'review',key:candidateId}.
export async function independentReview({candidate,diff,before,after,inference,reviewModel,generatorModel}={}){
  if(!inference) return {skipped:'no model',verdict:null,blocking:[],concerns:[],independent:false,model:null};
  const {result,model}=await inference({
    system:SYSTEM_PROMPT, prompt:buildReviewPrompt({candidate,diff,before,after}), schema:REVIEW_SCHEMA,
    stage:'review', key:candidate?.candidateId, model:reviewModel
  });
  // Independence is judged from the model the inference seam actually used, not the model requested: a seam that ignores
  // its per-call override (the bug this closes) must not be able to make this check pass on the strength of `reviewModel`
  // alone. `model` comes back as the provider model string (e.g. 'claude-opus-5'); map it to the catalog id before
  // comparing against generatorModel, which is always a catalog id.
  const usedModel=modelIdForProviderModel(model!=null ? model : reviewModel);
  const independent=modelIdsDiffer(usedModel,generatorModel);
  const verdict=result?.verdict==='approve' ? 'approve' : 'block';
  const blocking=(Array.isArray(result?.blocking) ? result.blocking : []).slice(0,20)
    .map(item=>({title:String(item?.title || '').slice(0,200),file:String(item?.file || '').slice(0,300),why:String(item?.why || '').slice(0,500)}));
  const concerns=(Array.isArray(result?.concerns) ? result.concerns : []).slice(0,20).map(item=>String(item).slice(0,500));
  return {verdict,blocking,concerns,independent,model:usedModel,requestedModel:reviewModel,skipped:false};
}

// applyReviewDecision(candidate, decision, review) -> the candidate with its final status. `decision` is compare()'s
// output for this candidate; `review` is independentReview()'s output, or undefined when review never ran.
//
// §10 requires "the reviewer's model id is recorded on the candidate" and, specifically for the unreviewed case,
// `promote_eligible: false, reason:'unreviewed'` (status stays 'promote_eligible' — the contract names this exact shape,
// so a distinct status for "unreviewed" is not introduced here even though it would remove the second boolean a caller
// must check). What this does fix: every branch, not just the promote/approve one, now carries the review record
// (verdict, model, independent, skipped) so an audit can see who reviewed what regardless of outcome, and a block no
// longer discards its reason as null.
export function applyReviewDecision(candidate,decision,review){
  const reviewRecord=review
    ? {verdict:review.verdict ?? null,model:review.model ?? null,independent:!!review.independent,skipped:review.skipped || false}
    : {verdict:null,model:null,independent:false,skipped:'not run'};
  if(decision?.decision!=='promote_eligible') return {...candidate,status:decision?.decision,reason:decision?.reasons?.[0] || null,review:reviewRecord};
  if(!review || review.skipped) return {...candidate,status:'promote_eligible',promoteEligible:false,reason:REASONS.UNREVIEWED,review:reviewRecord};
  if(review.verdict==='block'){
    const reason=review.blocking?.[0]?.title || 'rejected_by_review';
    return {...candidate,status:'rejected_by_review',reason,blocking:review.blocking,review:reviewRecord};
  }
  if(review.verdict==='approve' && review.independent) return {...candidate,status:'promote_eligible',promoteEligible:true,reason:null,review:reviewRecord};
  // Approved, but by the same model that generated it: does not count (§10, "independent:false … does not count").
  return {...candidate,status:'promote_eligible',promoteEligible:false,reason:REASONS.UNREVIEWED,review:reviewRecord};
}
