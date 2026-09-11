// The incident model: one typed record per operational fault the runtime sees, on the run and on disk the moment it happens.
// Classification is deterministic from the error the provider or DashClaw returned; the learning loop groups on `family`.
// Contract: docs/AGENT_SELF_HEALING.md sections 2 and 3.
import {randomBytes} from 'node:crypto';
import {mkdir,writeFile,rename,readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {redactText,redact} from './redact.mjs';
import {appendEvent} from './run.mjs';
import {RECOVERY_ACTIONS} from './recovery.mjs';

export const FAILURE_CLASSES=Object.freeze(['transient_provider','rate_limit','authentication_expired','timeout_before_request','timeout_during_request',
  'response_lost','provider_state_conflict','stale_entity_state','ambiguous_identity','malformed_model_output','unsupported_tool_request',
  'dashclaw_unavailable','dashclaw_block','approval_denied','approval_expired','verification_mismatch','duplicate_effect_detected',
  'renderer_interruption','local_process_interruption','user_cancellation','unknown_external_state','model_transport_failure','precondition_refused']);
export const PHASES=Object.freeze(['plan','read','precondition','govern','approval','claim','execute','verify','reconcile','outcome','resume','transport','render','cancel']);
export const INTEGRATIONS=Object.freeze(['stripe','hubspot','gmail','slack','dashclaw','model','sidelook']);
export const SEVERITY=Object.freeze(['info','warn','high']);
export const KNOWN_STATES=Object.freeze(['not_sent','sent_unknown','present','absent','verified','n/a']);
export const RECOVERY_RESULTS=Object.freeze(['pending','recovered','reconciled_present','reconciled_absent','retried_failed','stopped_uncertain','stopped_partial','failed_closed','asked_user','breaker_opened','none']);
export const VERIFICATION_RESULTS=Object.freeze(['pending','verified','unverified','mismatch','n/a']);
export const DISPOSITIONS=Object.freeze(['pending','recovered','partial','uncertain','blocked','failed','cancelled','info']);
// The strategy an incident records is one of the recovery policy's own actions; the two lists can never drift apart.
export const RECOVERY_STRATEGIES=RECOVERY_ACTIONS;

const MAX_INCIDENTS=200,MESSAGE_MAX=300,IDS_MAX=500;
const IDENTITY_CODES=new Set(['AMBIGUOUS_IDENTITY','IDENTITY_UNRESOLVED','IDENTITY_MISMATCH','CONTACT_NOT_OBSERVED']);
const MALFORMED_CODES=new Set(['PARSE_ERROR','INVALID_PLAN','UNKNOWN_KIND','MISSING_MESSAGE','INVALID_ARGS','MALFORMED_PLAN']);
const TRANSPORT_CODES=new Set(['MODEL','BUSY','SESSION_LIMIT','TRANSPORT']);
const BLOCK_CODES=new Set(['POLICY_BLOCK','CLAIM_REFUSED','REFUND_NOT_HELD','REFUND_HOLD_POLICY_MISSING','CLAIM_CONSUMED']);
// Severity by class: what a person should look at first when the run ends.
const HIGH=new Set(['duplicate_effect_detected','unknown_external_state','authentication_expired','dashclaw_unavailable','verification_mismatch']);
const INFO=new Set(['precondition_refused','renderer_interruption','user_cancellation','approval_denied','approval_expired','dashclaw_block','ambiguous_identity']);

export const newIncidentId=()=>`inc_${randomBytes(10).toString('hex')}`;
const iso=at=>at || new Date().toISOString();

// Deterministic: the same error in the same phase always lands in the same class. `sentRequest` decides whether a transport
// fault could have reached the provider (the classification lib/agent/http.mjs already makes per status code).
export function classifyFailure({error,phase='',sentRequest,source=''}={}){
  const code=String(error?.code || '').toUpperCase();
  const sent=typeof sentRequest==='boolean'?sentRequest:error?.sentRequest===true;
  if(source==='cancel' || code==='CANCELLED' || error?.name==='AbortError') return 'user_cancellation';
  if(code==='INTERRUPTED') return 'local_process_interruption';
  if(code==='RENDERER_DROPPED') return 'renderer_interruption';
  if(code==='DUPLICATE_EFFECT') return 'duplicate_effect_detected';
  if(code==='UNKNOWN_TOOL') return 'unsupported_tool_request';
  if(MALFORMED_CODES.has(code)) return 'malformed_model_output';
  if(TRANSPORT_CODES.has(code) || source==='model') return 'model_transport_failure';
  if(code==='GOVERNANCE_UNAVAILABLE' || code==='CLAIM_UNCERTAIN') return 'dashclaw_unavailable';
  if(BLOCK_CODES.has(code)) return 'dashclaw_block';
  if(code==='REJECTED') return 'approval_denied';
  if(code==='APPROVAL_EXPIRED' || code==='APPROVAL_UNCONFIRMED') return 'approval_expired';
  if(IDENTITY_CODES.has(code)) return 'ambiguous_identity';
  if(code==='VERIFICATION_MISMATCH') return 'verification_mismatch';
  if(code==='UNKNOWN_STATE') return 'unknown_external_state';
  if(code==='AUTH') return 'authentication_expired';
  if(code==='RATE_LIMIT') return 'rate_limit';
  if(code==='CONFLICT') return 'provider_state_conflict';
  if(code==='NOT_FOUND' || code==='INVALID') return (phase==='verify' || phase==='reconcile' || phase==='execute')?'stale_entity_state':'precondition_refused';
  if(code==='TIMEOUT') return sent?'timeout_during_request':'timeout_before_request';
  if(code==='NETWORK') return sent?'response_lost':'timeout_before_request';
  if(code==='SERVER') return sent?'response_lost':'transient_provider';
  if(code==='CONFIG' || phase==='precondition' || source==='precondition') return 'precondition_refused';
  return sent?'response_lost':'transient_provider';
}

const severityOf=failureClass=>HIGH.has(failureClass)?'high':INFO.has(failureClass)?'info':'warn';
const oneOf=(list,value,name)=>{if(!list.includes(value)) throw new Error(`Incident ${name} "${value}" is not one of ${list.join(', ')}.`);return value;};

function evidenceOf(fields){
  const source=fields.sanitizedEvidence || {};
  const code=String(source.code || fields.error?.code || '').slice(0,64);
  const message=redactText(String(source.message ?? fields.error?.message ?? '')).slice(0,MESSAGE_MAX);
  let ids=redact(source.ids || {});
  if(JSON.stringify(ids).length>IDS_MAX) ids={truncated:true};
  return {code,message,ids};
}

// Creates the record, bounds it, redacts it, and puts it on the run. `announce` appends a timeline row (breakers, resume);
// the engine's own rows carry the incidentId instead, so a fault never shows twice.
export function recordIncident(run,fields,at){
  if(!run || !Array.isArray(run.incidents)) throw new Error('recordIncident needs a run with an incidents ledger.');
  const failureClass=oneOf(FAILURE_CLASSES,fields.failureClass,'failureClass');
  const integration=oneOf(INTEGRATIONS,fields.integration,'integration');
  const phase=oneOf(PHASES,fields.phase,'phase');
  const tool=String(fields.tool || '').slice(0,80);
  const now=iso(at);
  const incident={
    incidentId:fields.incidentId || newIncidentId(),runId:run.runId,at:now,updatedAt:now,
    integration,tool,operation:String(fields.operation || tool || phase).slice(0,200),phase,failureClass,
    family:`${integration}:${failureClass}:${tool}`,severity:fields.severity?oneOf(SEVERITY,fields.severity,'severity'):severityOf(failureClass),
    providerStatus:Number.isInteger(fields.providerStatus)?fields.providerStatus:(Number.isInteger(fields.error?.status)?fields.error.status:null),
    attemptNumber:Number.isInteger(fields.attemptNumber)?fields.attemptNumber:0,
    providerOperationId:fields.providerOperationId?String(fields.providerOperationId).slice(0,120):null,
    dashclawActionId:fields.dashclawActionId?String(fields.dashclawActionId).slice(0,120):null,
    effectId:fields.effectId || null,
    knownState:oneOf(KNOWN_STATES,fields.knownState || 'n/a','knownState'),
    uncertainState:fields.uncertainState===true,
    recoveryAttempted:fields.recoveryAttempted===true,
    recoveryStrategy:oneOf(RECOVERY_STRATEGIES,fields.recoveryStrategy || 'none','recoveryStrategy'),
    recoveryResult:oneOf(RECOVERY_RESULTS,fields.recoveryResult || 'pending','recoveryResult'),
    verificationResult:oneOf(VERIFICATION_RESULTS,fields.verificationResult || 'pending','verificationResult'),
    sanitizedEvidence:evidenceOf(fields),
    finalDisposition:oneOf(DISPOSITIONS,fields.finalDisposition || 'pending','finalDisposition')
  };
  run.incidents.push(incident);
  while(run.incidents.length>MAX_INCIDENTS) run.incidents.shift();
  run.updatedAt=now;
  if(fields.announce) appendEvent(run,{kind:'recovery',status:fields.announceStatus || 'info',app:integration==='sidelook' || integration==='model'?null:integration,label:String(fields.announce).slice(0,200),detail:incident.sanitizedEvidence.message,effectId:incident.effectId,actionId:incident.dashclawActionId,incidentId:incident.incidentId},at);
  return incident;
}

const RESOLVABLE={knownState:KNOWN_STATES,recoveryResult:RECOVERY_RESULTS,verificationResult:VERIFICATION_RESULTS,finalDisposition:DISPOSITIONS,recoveryStrategy:RECOVERY_STRATEGIES};
// A recovery's outcome lands on the incident that started it; the class it was born with never changes.
export function resolveIncident(run,incidentId,patch={},at){
  const incident=(run?.incidents || []).find(i=>i.incidentId===incidentId);
  if(!incident) return null;
  for(const [key,list] of Object.entries(RESOLVABLE)) if(patch[key]!==undefined) incident[key]=oneOf(list,patch[key],key);
  if(patch.uncertainState!==undefined) incident.uncertainState=patch.uncertainState===true;
  if(patch.recoveryAttempted!==undefined) incident.recoveryAttempted=patch.recoveryAttempted===true;
  if(patch.attemptNumber!==undefined && Number.isInteger(patch.attemptNumber)) incident.attemptNumber=patch.attemptNumber;
  if(patch.providerOperationId!==undefined) incident.providerOperationId=patch.providerOperationId?String(patch.providerOperationId).slice(0,120):null;
  if(patch.dashclawActionId!==undefined) incident.dashclawActionId=patch.dashclawActionId?String(patch.dashclawActionId).slice(0,120):null;
  if(patch.sanitizedEvidence) incident.sanitizedEvidence={...incident.sanitizedEvidence,...evidenceOf({sanitizedEvidence:{...incident.sanitizedEvidence,...patch.sanitizedEvidence}})};
  incident.updatedAt=iso(at);run.updatedAt=incident.updatedAt;
  return incident;
}

// At a terminal status nothing stays "pending": the effect ledger says how each incident ended.
export function finalizeIncidents(run,at){
  let changed=0;
  for(const incident of run?.incidents || []){
    const effect=incident.effectId?(run.effects || []).find(e=>e.effectId===incident.effectId):null;
    const status=effect?.status || null;
    if(incident.finalDisposition==='pending'){
      incident.finalDisposition=status==='verified'?(incident.recoveryAttempted?'recovered':'info')
        :status==='executed'?'partial':status==='uncertain'?'uncertain'
        :['blocked','rejected','expired'].includes(status)?'blocked':status==='failed'?'failed'
        :run.status==='cancelled'?'cancelled':run.status==='failed'?'failed':run.status==='uncertain'?'uncertain':'info';
      changed++;
    }
    if(incident.recoveryResult==='pending'){
      incident.recoveryResult=status==='verified'?(incident.recoveryAttempted?'recovered':'none'):status==='uncertain'?'stopped_uncertain'
        :status==='failed'?(incident.recoveryAttempted?'retried_failed':'none'):status==='executed'?'stopped_partial':'none';
      changed++;
    }
    if(incident.verificationResult==='pending'){
      incident.verificationResult=status==='verified'?'verified':status==='executed'?(effect?.verification?'unverified':'n/a'):'n/a';
      changed++;
    }
    if(changed) incident.updatedAt=iso(at);
  }
  return changed;
}

export function incidentSummary(run){
  const list=run?.incidents || [];
  const count=(key,value)=>list.filter(i=>i[key]===value).length;
  const bySeverity={},byClass={};
  for(const i of list){bySeverity[i.severity]=(bySeverity[i.severity] || 0)+1;byClass[i.failureClass]=(byClass[i.failureClass] || 0)+1;}
  return {total:list.length,recovered:count('finalDisposition','recovered'),open:count('finalDisposition','pending'),bySeverity,byClass};
}

const EMAIL=/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,URL=/\bhttps?:\/\/[^\s"'<>)]+/gi,MESSAGE_ID=/<[^\s<>@]+@[^\s<>@]+>/g;
const scrub=text=>redactText(String(text ?? '')).replace(MESSAGE_ID,'<message-id>').replace(EMAIL,'<email>').replace(URL,'<url>');
const FIELDS=['incidentId','runId','at','updatedAt','integration','tool','operation','phase','failureClass','family','severity','providerStatus','attemptNumber',
  'providerOperationId','dashclawActionId','effectId','knownState','uncertainState','recoveryAttempted','recoveryStrategy','recoveryResult','verificationResult','finalDisposition'];
// What leaves the run: the typed fields, a scrubbed message, provider ids. Never retrieved text; the incident never held any.
export function sanitizeIncident(incident){
  const out={};
  for(const key of FIELDS) out[key]=incident?.[key] ?? null;
  out.operation=scrub(out.operation).slice(0,200);
  const evidence=incident?.sanitizedEvidence || {};
  out.sanitizedEvidence={code:String(evidence.code || '').slice(0,64),message:scrub(evidence.message).slice(0,MESSAGE_MAX),ids:redact(evidence.ids || {})};
  return out;
}

const INCIDENT_ID=/^inc_[a-f0-9]{20}$/;
// One file per incident, written whole and renamed into place, redacted; a crash between two saves leaves the earlier file intact.
export class IncidentStore {
  constructor({dir}={}){
    if(!dir) throw new Error('IncidentStore needs a directory.');
    this.dir=dir;this.dirReady=null;this.chains=new Map();
  }
  async ensureDir(){if(!this.dirReady) this.dirReady=mkdir(this.dir,{recursive:true});await this.dirReady;}
  path(id){return join(this.dir,`${id}.json`);}
  save(incident){
    const id=incident?.incidentId;
    if(typeof id!=='string' || !INCIDENT_ID.test(id)) return Promise.reject(new Error(`IncidentStore.save needs a valid incidentId, got ${JSON.stringify(id)}.`));
    const previous=this.chains.get(id) || Promise.resolve();
    const next=previous.then(()=>this.writeOnce(id,incident),()=>this.writeOnce(id,incident));
    this.chains.set(id,next.catch(()=>{}));
    return next;
  }
  async writeOnce(id,incident){
    await this.ensureDir();
    const file=this.path(id),tmp=`${file}.tmp`;
    await writeFile(tmp,JSON.stringify(redact(incident)),'utf8');
    await rename(tmp,file);
  }
  async load(id){
    if(typeof id!=='string' || !INCIDENT_ID.test(id)) return null;
    try{const parsed=JSON.parse(await readFile(this.path(id),'utf8'));return parsed && typeof parsed==='object' && FAILURE_CLASSES.includes(parsed.failureClass)?parsed:null;}
    catch{return null;}
  }
  async list({since=null,limit=200}={}){
    await this.ensureDir();
    let entries;
    try{entries=await readdir(this.dir,{withFileTypes:true});}catch{return [];}
    const ids=entries.filter(e=>e.isFile() && e.name.endsWith('.json')).map(e=>e.name.slice(0,-5)).filter(id=>INCIDENT_ID.test(id));
    const loaded=(await Promise.all(ids.map(id=>this.load(id)))).filter(Boolean).filter(i=>!since || i.at>since);
    loaded.sort((a,b)=>String(b.at).localeCompare(String(a.at)));
    return loaded.slice(0,Math.max(0,limit));
  }
}
