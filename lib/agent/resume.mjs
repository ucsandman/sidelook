// Resume re-establishes truth from persisted evidence: which writes are proven, which must be read back, which can only be
// expired. It never resumes model planning, never replays a write, never infers success from an attempt. `lineageFor` is what
// a continued run inherits so it can carry on from the earliest unverified postcondition without repeating a proven write.
// Contract: docs/AGENT_SELF_HEALING.md section 6.
import {updateEffect,resolveApproval} from './run.mjs';
import {verifyExecuted,reconcileUncertain} from './effects.mjs';

const KEEP=new Set(['verified','blocked','rejected','expired','failed']);
const RECONCILE=new Set(['uncertain','claimed','executing']);

export function planResume(run){
  const actions=[];
  let earliestUnverified=null;
  for(const effect of run?.effects || []){
    let action,why;
    if(KEEP.has(effect.status)){action='keep';why=`${effect.status}: the ledger already knows how this ended`;}
    else if(effect.status==='executed'){action='verify';why='the provider accepted it and no read proved the state yet';}
    else if(RECONCILE.has(effect.status) || (effect.status==='planned' && effect.actionId)){action='reconcile';why='the request may have reached the provider before the interruption';}
    else if(effect.status==='pending_approval'){action='expire';why='a decision nobody is waiting on cannot be honoured after a restart';}
    else {action='keep';why=`${effect.status}: nothing left the process`;}
    if(action!=='keep' && !earliestUnverified) earliestUnverified=effect.effectId;
    actions.push({effectId:effect.effectId,tool:effect.tool,app:effect.app,opKey:effect.opKey,status:effect.status,action,why});
  }
  const approvals=(run?.approvals || []).filter(a=>a.status==='pending').map(a=>({actionId:a.actionId,action:'expire'}));
  return {runId:run?.runId || null,actions,approvals,earliestUnverified};
}

// Reads only. Effects the plan says to expire are expired first (no provider is asked about a write nobody authorized); the
// rest are read in ledger order and the reading stops at the first state that cannot be established.
export async function applyResume(handle,plan){
  const {run}=handle;
  const results=[];
  for(const step of plan.actions){
    const effect=run.effects.find(e=>e.effectId===step.effectId);
    if(!effect) continue;
    if(step.action==='expire'){updateEffect(run,effect.effectId,{status:'expired',error:{code:'INTERRUPTED',message:'Sidelook stopped while this write waited for a decision.'}});results.push({effectId:effect.effectId,action:'expire',finding:null,status:'expired'});}
    else if(step.action==='reconcile' && effect.status!=='uncertain'){updateEffect(run,effect.effectId,{status:'uncertain'});}
  }
  for(const approval of plan.approvals) resolveApproval(run,approval.actionId,'expired','sidelook');
  let stopped=false;
  for(const step of plan.actions){
    if(step.action!=='verify' && step.action!=='reconcile') continue;
    const effect=run.effects.find(e=>e.effectId===step.effectId);
    if(!effect) continue;
    if(stopped){results.push({effectId:effect.effectId,action:step.action,finding:'not_reached',status:effect.status});continue;}
    if(step.action==='verify'){
      const verification=await verifyExecuted(handle,effect);
      results.push({effectId:effect.effectId,action:'verify',finding:verification.verified?'verified':'unverified',status:effect.status});
    } else {
      await reconcileUncertain({...handle,only:effect.effectId});
      const after=run.effects.find(e=>e.effectId===effect.effectId);
      const finding=after.status==='verified' || after.status==='executed'?'present':after.status==='failed'?'absent':'unknown';
      results.push({effectId:effect.effectId,action:'reconcile',finding,status:after.status});
      if(finding==='unknown') stopped=true;
    }
  }
  return {results,uncertain:run.effects.filter(e=>e.status==='uncertain').length,verified:results.filter(r=>r.finding==='verified' || r.finding==='present').length};
}

const INHERIT=new Set(['verified','executed','uncertain']);
const pick=(effect,runId)=>({effectId:effect.effectId,runId,tool:effect.tool,app:effect.app,opKey:effect.opKey,status:effect.status,receipt:effect.receipt || null,plan:effect.plan || null,actionId:effect.actionId || null,executions:effect.executions || 0,series:effect.series || 0,inheritedFrom:effect.inheritedFrom || null});
// Root first: the parent's own inheritance, then the parent's effects that a child must know about.
export function lineageFor(run){
  const parentLineage=run?.lineage || null;
  const rootRunId=parentLineage?.rootRunId || run.runId;
  const chain=[...(parentLineage?.chain || []),run.runId];
  // An inherited entry was frozen when this run was created; this run may since have settled it (reconciled absent and
  // failed, replaced by a fresh series, or verified it). Resolve each one against this run's own copy of the same effect
  // (created with the same effectId, `inheritedFrom` set, in index.mjs `create()`) rather than handing the stale snapshot
  // on to a grandchild, and never hand on one this run proved absent (docs/AGENT_SELF_HEALING.md §6).
  const inherited=(parentLineage?.effects || []).flatMap(e=>{
    const own=(run?.effects || []).find(x=>x.effectId===e.effectId);
    if(!own) return [{...e}];
    if(own.status==='failed') return [];
    return [{...e,status:own.status,receipt:own.receipt || null,executions:own.executions || 0,series:own.series ?? e.series}];
  });
  const own=(run?.effects || []).filter(e=>INHERIT.has(e.status) && !e.superseded && !e.inheritedFrom).map(e=>pick(e,run.runId));
  // Every attempt that consumed a DashClaw action, whatever its end, so a child's fresh attempt at the same operation gets its own key.
  const attempts={...(parentLineage?.attempts || {})};
  for(const e of run?.effects || []){
    if(!e.actionId) continue;
    const key=`${e.tool}|${e.opKey}`;
    attempts[key]=Math.max(attempts[key] ?? -1,e.series || 0);
  }
  return {rootRunId,parentRunId:run.runId,chain,effects:[...inherited,...own],attempts,facts:JSON.parse(JSON.stringify(run?.sourceFacts || [])),entities:JSON.parse(JSON.stringify(run?.entities || {}))};
}
