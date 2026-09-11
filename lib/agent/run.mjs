// The run: what Agent mode knows about one attempt at a business outcome. Pure data and pure transitions, no I/O.
// Everything the panel shows and every reliability number derives from these ledgers, never from the model's words.
// Contract: docs/AGENT_MODE_IMPLEMENTATION.md section 3.
import {createHash, randomBytes} from 'node:crypto';

export const MAX_TURNS=14;
export const STATES=['created','planning','executing','waiting_for_approval','waiting_for_user','recovering','verifying','completed','partial','blocked','cancelled','failed','uncertain'];
export const TERMINAL=new Set(['completed','partial','blocked','cancelled','failed','uncertain']);
export const ALLOWED={
  created:['planning','cancelled','failed'],
  planning:['executing','verifying','waiting_for_user','failed','cancelled','blocked'],
  executing:['planning','waiting_for_approval','recovering','verifying','failed','cancelled','blocked','uncertain'],
  waiting_for_approval:['executing','planning','blocked','cancelled','failed'],
  waiting_for_user:['planning','cancelled'],
  // The post-Stop reconciliation runs on its own signal after a Stop leaves the run in 'recovering' (docs/AGENT_SELF_HEALING.md
  // §6): a write it finds present goes on to the normal verification, which starts by transitioning to 'verifying'.
  recovering:['executing','planning','verifying','uncertain','partial','cancelled','failed'],
  // A write is verified while the run goes on (back to executing), and the run's own final verification ends in a terminal.
  verifying:['executing','planning','completed','partial','uncertain','failed','cancelled','blocked']
};
export const EVENT_KINDS=['phase','model','tool','write','approval','policy','verify','recovery','user','error','summary'];
export const EVENT_STATUSES=['started','ok','blocked','rejected','failed','verified','unverified','uncertain','pending','info'];
export const EFFECT_STATUSES=['planned','blocked','rejected','pending_approval','claimed','executing','executed','verified','failed','uncertain','expired'];
const MAX_EVENTS=400,MAX_EVIDENCE=4096;

export class IllegalTransition extends Error {
  constructor(from,to){super(`Illegal run transition ${from} -> ${to}.`);this.code='ILLEGAL_TRANSITION';this.from=from;this.to=to;}
}

const iso=at=>at || new Date().toISOString();
export const newId=prefix=>`${prefix}_${randomBytes(10).toString('hex')}`;
// The idempotency key is the logical identity of one write inside one lineage: the same root run, tool and operation always hash
// the same, so a continued run cannot repeat a proven write even through Stripe's or DashClaw's own deduplication. `series`
// names a genuinely new attempt after the provider proved an earlier one absent; series 0 keeps the original key.
export const idempotencyKey=(runId,tool,opKey,series=0)=>createHash('sha256').update(`run:${runId}|tool:${tool}|op:${opKey}${series>0?`|series:${series}`:''}`).digest('hex');

export function createRun({goal,model,effort,windowTitle='',at,runId,lineage=null}={}){
  if(typeof goal!=='string' || !goal.trim()) throw new Error('A run needs a goal.');
  const now=iso(at);
  return {
    runId:runId || newId('run'),goal:goal.trim().slice(0,2000),createdAt:now,updatedAt:now,status:'created',model,effort,
    turn:0,currentStep:null,context:{windowTitle:String(windowTitle || '').slice(0,200)},
    entities:lineage?JSON.parse(JSON.stringify(lineage.entities || {})):{},sourceFacts:lineage?JSON.parse(JSON.stringify(lineage.facts || [])):[],
    events:[],effects:[],approvals:[],clarification:null,errors:[],summary:null,
    dashclaw:{sessionId:null,actionIds:[]},injection:[],finalMessage:'',closing:'',
    // Self healing (docs/AGENT_SELF_HEALING.md): the incident ledger, what a restart found, and what a continued run inherits.
    incidents:[],resume:null,lineage:lineage?{rootRunId:lineage.rootRunId,parentRunId:lineage.parentRunId,chain:[...(lineage.chain || [])],effects:JSON.parse(JSON.stringify(lineage.effects || [])),attempts:{...(lineage.attempts || {})}}:null
  };
}

export function transition(run,next,why='',at){
  if(!STATES.includes(next)) throw new IllegalTransition(run.status,next);
  if(!(ALLOWED[run.status] || []).includes(next)) throw new IllegalTransition(run.status,next);
  run.status=next;run.updatedAt=iso(at);
  appendEvent(run,{kind:'phase',label:next,detail:why,status:TERMINAL.has(next)?(next==='completed'?'ok':next==='blocked'?'blocked':next==='cancelled'?'info':next==='uncertain'?'uncertain':'failed'):'started'},at);
  return run;
}

// The evidence on an event is what the person can open under Details: ids and values, bounded, never a token.
function boundedEvidence(value){
  if(value===undefined || value===null) return null;
  let text;try{text=JSON.stringify(value);}catch{return {truncated:true};}
  if(text.length<=MAX_EVIDENCE) return JSON.parse(text);
  return {truncated:true,preview:text.slice(0,MAX_EVIDENCE)};
}
export function appendEvent(run,event,at){
  const kind=EVENT_KINDS.includes(event.kind)?event.kind:'error';
  const status=EVENT_STATUSES.includes(event.status)?event.status:'info';
  const entry={id:newId('ev'),at:iso(at),turn:run.turn,kind,status,label:String(event.label || '').slice(0,200),detail:String(event.detail || '').slice(0,2000),
    step:event.step || null,app:event.app || null,evidence:boundedEvidence(event.evidence),actionId:event.actionId || null,effectId:event.effectId || null,incidentId:event.incidentId || null};
  run.events.push(entry);
  while(run.events.length>MAX_EVENTS) run.events.splice(1,1); // keep the first event (the goal) and the newest ones
  run.updatedAt=entry.at;
  return entry;
}

export function setStep(run,label,at){run.currentStep=label?{label:String(label).slice(0,200),since:iso(at)}:null;run.updatedAt=iso(at);}

export function addError(run,{code,message,step},at){
  const entry={at:iso(at),code:String(code || 'ERROR').slice(0,64),message:String(message || '').slice(0,1000),step:step || null};
  run.errors.push(entry);if(run.errors.length>100) run.errors.shift();
  appendEvent(run,{kind:'error',status:'failed',label:entry.code,detail:entry.message,step},at);
  return entry;
}

// Facts are what a provider read proved; keyed so a fact is stated once. Only tools add facts, never the model.
export function addFact(run,{key,value,label,source,ref},at){
  if(typeof key!=='string' || !key) throw new Error('A fact needs a key.');
  const fact={key,value:String(value ?? '').slice(0,500),label:String(label || key).slice(0,100),source:String(source || '').slice(0,40),ref:String(ref || '').slice(0,200),at:iso(at)};
  const index=run.sourceFacts.findIndex(f=>f.key===key);
  if(index>=0) run.sourceFacts[index]=fact;else run.sourceFacts.push(fact);
  return fact;
}

export function planEffect(run,{tool,app,opKey,series=0},at){
  if(!tool || !app || !opKey) throw new Error('An effect needs a tool, an app and an opKey.');
  const effect={effectId:newId('fx'),tool,app,opKey:String(opKey).slice(0,200),idempotencyKey:idempotencyKey(run.lineage?.rootRunId || run.runId,tool,opKey,series),series,status:'planned',attempts:0,
    actionId:null,decisionId:null,attemptId:null,policy:null,receipt:null,verification:null,reconciliations:[],error:null,startedAt:iso(at),finishedAt:null};
  run.effects.push(effect);run.updatedAt=effect.startedAt;
  return effect;
}
export function updateEffect(run,effectId,patch,at){
  const effect=run.effects.find(e=>e.effectId===effectId);
  if(!effect) throw new Error(`Unknown effect ${effectId}.`);
  if(patch.status!==undefined && !EFFECT_STATUSES.includes(patch.status)) throw new Error(`Unknown effect status ${patch.status}.`);
  Object.assign(effect,patch);
  if(['blocked','rejected','verified','failed','uncertain','expired','executed'].includes(effect.status)) effect.finishedAt=iso(at);
  run.updatedAt=iso(at);
  return effect;
}
export const findEffect=(run,effectId)=>run.effects.find(e=>e.effectId===effectId) || null;
// The series a new attempt at this logical operation gets: one past the highest series of any earlier attempt, in this run or
// its lineage, that consumed a DashClaw action and ended failed with the provider proving nothing was written. A blocked,
// rejected or expired attempt keeps its key on purpose (DashClaw's refusal is final and a replay reads the same verdict).
export function nextSeries(run,tool,opKey){
  const key=`${tool}|${opKey}`;
  let highest=-1;
  for(const e of run.effects) if(e.tool===tool && e.opKey===opKey && e.status==='failed' && e.actionId) highest=Math.max(highest,e.series || 0);
  const inherited=run.lineage?.attempts?.[key];
  if(Number.isInteger(inherited)) highest=Math.max(highest,inherited);
  return highest+1;
}
// An earlier effect for the same logical operation that already executed: the one thing a later step must never repeat.
// Several effects can share one tool|opKey (an inherited entry alongside a fresher series); the most advanced status wins
// so a settled verified/executed attempt is never shadowed by a stale uncertain one earlier in ledger order.
const PRIOR_RANK={uncertain:0,executing:1,claimed:2,pending_approval:3,executed:4,verified:5};
export const priorEffect=(run,tool,opKey)=>{
  let best=null;
  for(const e of run.effects){
    if(e.tool!==tool || e.opKey!==opKey || !(e.status in PRIOR_RANK)) continue;
    if(!best || PRIOR_RANK[e.status]>PRIOR_RANK[best.status]) best=e;
  }
  return best;
};

export function addApproval(run,approval,at){
  const entry={status:'pending',decidedAt:null,decidedVia:null,...approval,createdAt:iso(at)};
  run.approvals.push(entry);run.updatedAt=entry.createdAt;
  return entry;
}
export const pendingApproval=run=>run.approvals.find(a=>a.status==='pending') || null;
export function resolveApproval(run,actionId,status,via,at){
  const approval=run.approvals.find(a=>a.actionId===actionId);
  if(!approval) return null;
  if(approval.status!=='pending') return approval;
  approval.status=status;approval.decidedAt=iso(at);approval.decidedVia=via || null;run.updatedAt=approval.decidedAt;
  return approval;
}

// The numbers on the summary block, from the ledgers alone. A duplicate is a second execution of the same logical operation.
export function summary(run){
  const reads=run.events.filter(e=>e.kind==='tool' && e.status!=='started').length;
  const writes=run.effects;
  const count=predicate=>writes.filter(predicate).length;
  const executedLike=e=>['executed','verified','uncertain'].includes(e.status);
  const apps=new Set([...run.events.filter(e=>e.app).map(e=>e.app),...writes.map(e=>e.app)]);
  // A duplicate is a second execution the provider actually performed for one logical operation: executions count receipts and
  // reconciliations that found the write present, never attempts that were refused before they left or that no provider ever saw.
  const byOp=new Map();
  for(const e of writes){const n=e.executions || 0;if(!n) continue;const key=`${e.tool}|${e.opKey}`;byOp.set(key,(byOp.get(key) || 0)+n);}
  const duplicates=[...byOp.values()].reduce((sum,n)=>sum+Math.max(0,n-1),0);
  // A recovery is a write that failed or went uncertain and still verified: a later attempt, or a reconciliation of its own
  // (the sweep's re-read of an earlier write is not one). Incidents come from the incident ledger, by their final disposition.
  const incidents=run.incidents || [];
  const recoveries=count(e=>e.status==='verified' && (e.attempts>1 || (e.reconciliations || []).some(r=>!r.sweep && r.finding==='present')));
  return {
    status:run.status,apps:apps.size,toolCalls:reads+writes.length,reads,turns:run.turn,
    writes:{planned:writes.length,attempted:count(e=>e.attempts>0),executed:count(executedLike),verified:count(e=>e.status==='verified'),
      blocked:count(e=>e.status==='blocked' && !e.superseded),corrected:count(e=>e.superseded===true),rejected:count(e=>e.status==='rejected'),expired:count(e=>e.status==='expired'),failed:count(e=>e.status==='failed' && !e.superseded),
      uncertain:count(e=>e.status==='uncertain'),verificationUnavailable:count(e=>e.status==='executed' && e.verification && e.verification.verified===false),inherited:count(e=>!!e.inheritedFrom)},
    approvals:{required:run.approvals.length,approved:run.approvals.filter(a=>a.status==='approved').length,rejected:run.approvals.filter(a=>a.status==='rejected').length,expired:run.approvals.filter(a=>a.status==='expired').length},
    duplicates,unresolved:count(e=>['uncertain','executing','claimed','pending_approval'].includes(e.status)),injectionFindings:run.injection.length,
    recoveries,incidents:{total:incidents.length,recovered:incidents.filter(i=>i.finalDisposition==='recovered').length,open:incidents.filter(i=>i.finalDisposition==='pending').length}
  };
}

// Where a run ends, in precedence order: Stop, anything unresolved, a runtime failure, a block with nothing done, a mix, or everything
// verified. `gaveUp` is the model saying the goal was not met; it never outranks the ledger, it only stops a run from reading completed.
export function finalStatus(run,{cancelled=false,runtimeFailure=false,gaveUp=false}={}){
  // A precondition refusal the model corrected (superseded by a verified write of the same tool) does not decide the ending.
  const effects=run.effects.filter(e=>!e.superseded);
  // Anything whose provider state is not settled outranks even a Stop: a claimed or executing write may have reached the provider.
  if(effects.some(e=>['uncertain','claimed','executing'].includes(e.status))) return 'uncertain';
  if(cancelled) return 'cancelled';
  if(runtimeFailure) return 'failed';
  const verified=effects.filter(e=>e.status==='verified').length;
  const refused=effects.filter(e=>['blocked','rejected','expired','pending_approval'].includes(e.status)).length;
  // Every status the machine knows is named here; a status it does not know can never read as success.
  const notVerified=effects.filter(e=>!['verified','blocked','rejected','expired','pending_approval'].includes(e.status)).length;
  if(refused && !verified && !notVerified) return 'blocked';
  if(refused || notVerified) return verified?'partial':refused?'blocked':'failed';
  if(gaveUp) return verified?'partial':'failed';
  return 'completed';
}

// `closing` is Sidelook's own last line (Stopped., The run could not finish.); the model's words stay in finalMessage, set by the loop.
export function finish(run,status,closing='',at){
  if(!TERMINAL.has(status)) throw new Error(`${status} is not a terminal status.`);
  run.closing=String(closing || '').slice(0,400);
  run.currentStep=null;run.clarification=null;
  transition(run,status,closing,at);
  run.summary=summary(run);
  appendEvent(run,{kind:'summary',status:status==='completed'?'ok':'info',label:'Run summary',evidence:run.summary},at);
  return run;
}

export const isTerminal=run=>TERMINAL.has(run.status);
export const snapshot=run=>JSON.parse(JSON.stringify(run));
