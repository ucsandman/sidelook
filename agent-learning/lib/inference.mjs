// The model seam for the learning loop. createLearningInference wraps lib/vision.mjs's Vision.generate for a real model
// call; createFixtureInference answers from a canned fixtures object for the --fixtures / verify:learn path, so the loop
// never needs a CLI installed to run end to end. Contract: docs/AGENT_LEARNING_LOOP.md §2, §13.
import {MODELS} from '../../public/models.js';

// Real inference. `vision` is an injectable Vision-like instance ({generate(system,parts,schema,signal,options)}); when
// omitted, lib/vision.mjs is imported lazily, inside the returned function, so the module itself loads with no CLI present.
// The `model`/`effort` given here are only the default: a caller (independentReview, honouring --review-model) passes its
// own `model`/`effort` per call, and that override always wins — a closure default that silently ignores the override is
// what would make review.mjs's independence check compare the wrong model id (docs/AGENT_LEARNING_LOOP.md §10).
export function createLearningInference({model,effort='medium',vision}={}){
  if(!model) throw Object.assign(new Error('createLearningInference requires a model id.'),{code:'INVALID_INPUT'});
  return async function inference({system,prompt,schema,signal,model:callModel,effort:callEffort}={}){
    const instance=vision || new (await import('../../lib/vision.mjs')).Vision();
    const usedCatalogId=callModel || model;
    const {result,model:usedModel}=await instance.generate(system,[{text:prompt}],schema,signal,{model:usedCatalogId,effort:callEffort || effort});
    return {result,model:usedModel,catalogId:usedCatalogId};
  };
}

// Vision.generate (via lib/subscription.mjs) returns the provider model string (e.g. 'claude-opus-5'), not the catalog id
// ('opus') compared against generatorModel elsewhere in the loop. This maps it back.
export function modelIdForProviderModel(providerModel){
  return MODELS.find(m=>m.model===providerModel)?.id || providerModel;
}

// Fixture inference for tests and --fixtures: the caller names a pipeline stage (retro, hypotheses, edits, review, …) and
// an optional key; the answer comes from fixtures[stage][key] or fixtures[stage].default. An unknown stage throws so a
// fixture gap fails loudly instead of the loop silently inventing a candidate from nothing.
export function createFixtureInference(fixtures={}){
  return async function inference({stage,key}={}){
    const forStage=fixtures[stage];
    if(!forStage) throw Object.assign(new Error(`No fixture inference for stage "${stage}".`),{code:'FIXTURE_MISSING'});
    const answer=key!==undefined && forStage[key]!==undefined ? forStage[key] : forStage.default;
    if(answer===undefined) throw Object.assign(new Error(`No fixture inference for stage "${stage}" key "${key}".`),{code:'FIXTURE_MISSING'});
    return {result:answer,model:'fixture'};
  };
}

export function modelIdsDiffer(a,b){
  return String(a || '')!==String(b || '');
}

// opus unless the generator is itself opus, in which case fable reviews instead. Catalog ids from public/models.js, so
// the loop never names a model the page and the server would disagree on.
export function defaultReviewModel(generatorModel){
  const preferred=generatorModel==='opus' ? 'fable' : 'opus';
  if(!MODELS.some(m=>m.id===preferred)) throw Object.assign(new Error(`Review model "${preferred}" is not in the model catalog.`),{code:'INVALID_MODEL'});
  return preferred;
}
