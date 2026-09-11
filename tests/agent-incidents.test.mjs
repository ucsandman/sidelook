// Unit tests for the incident model. Contract: docs/AGENT_SELF_HEALING.md sections 2 and 3.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProviderError} from '../lib/agent/http.mjs';
import {
  classifyFailure,recordIncident,resolveIncident,finalizeIncidents,incidentSummary,sanitizeIncident,IncidentStore,SEVERITY
} from '../lib/agent/incidents.mjs';

const baseRun=(overrides={})=>({runId:'run_0000000000000000dead',status:'executing',events:[],turn:0,effects:[],incidents:[],updatedAt:'',...overrides});

// --- classifyFailure: every row of docs/AGENT_SELF_HEALING.md section 2's table, error objects built the way http.mjs's
// ProviderError builds them (code, status, sentRequest) for anything that comes off a provider request. --------------------
test('classifyFailure covers every row of the contract table, including the sentRequest split for TIMEOUT, NETWORK and SERVER',()=>{
  const pe=(code,opts={})=>new ProviderError(code,'boom',opts);
  const plain=code=>({code,message:'boom'});
  const cases=[
    ['SERVER, sentRequest:false -> transient_provider',{error:pe('SERVER',{status:500,sentRequest:false}),phase:'execute'},'transient_provider'],
    ['SERVER, sentRequest:true -> response_lost',{error:pe('SERVER',{status:500,sentRequest:true}),phase:'execute'},'response_lost'],
    ['NETWORK, sentRequest:true -> response_lost',{error:pe('NETWORK',{sentRequest:true}),phase:'execute'},'response_lost'],
    ['TIMEOUT, sentRequest:false -> timeout_before_request',{error:pe('TIMEOUT',{sentRequest:false}),phase:'execute'},'timeout_before_request'],
    ['NETWORK pre-connect (sentRequest:false) -> timeout_before_request',{error:pe('NETWORK',{sentRequest:false}),phase:'execute'},'timeout_before_request'],
    ['TIMEOUT, sentRequest:true -> timeout_during_request',{error:pe('TIMEOUT',{sentRequest:true}),phase:'execute'},'timeout_during_request'],
    ['RATE_LIMIT (429) -> rate_limit',{error:pe('RATE_LIMIT',{status:429,sentRequest:true}),phase:'execute'},'rate_limit'],
    ['AUTH (401/403) -> authentication_expired',{error:pe('AUTH',{status:401}),phase:'execute'},'authentication_expired'],
    ['CONFLICT (409) -> provider_state_conflict',{error:pe('CONFLICT',{status:409,sentRequest:true}),phase:'execute'},'provider_state_conflict'],
    ['NOT_FOUND on a verify read -> stale_entity_state',{error:pe('NOT_FOUND',{status:404}),phase:'verify'},'stale_entity_state'],
    ['NOT_FOUND on a reconcile read -> stale_entity_state',{error:pe('NOT_FOUND',{status:404}),phase:'reconcile'},'stale_entity_state'],
    ['NOT_FOUND outside verify/reconcile/execute -> precondition_refused',{error:pe('NOT_FOUND',{status:404}),phase:'read'},'precondition_refused'],
    ['precondition AMBIGUOUS_IDENTITY -> ambiguous_identity',{error:plain('AMBIGUOUS_IDENTITY'),phase:'precondition'},'ambiguous_identity'],
    ['precondition IDENTITY_UNRESOLVED -> ambiguous_identity',{error:plain('IDENTITY_UNRESOLVED'),phase:'precondition'},'ambiguous_identity'],
    ['precondition IDENTITY_MISMATCH -> ambiguous_identity',{error:plain('IDENTITY_MISMATCH'),phase:'precondition'},'ambiguous_identity'],
    ['precondition CONTACT_NOT_OBSERVED -> ambiguous_identity',{error:plain('CONTACT_NOT_OBSERVED'),phase:'precondition'},'ambiguous_identity'],
    ['PARSE_ERROR -> malformed_model_output',{error:plain('PARSE_ERROR'),phase:'plan'},'malformed_model_output'],
    ['INVALID_PLAN -> malformed_model_output',{error:plain('INVALID_PLAN'),phase:'plan'},'malformed_model_output'],
    ['UNKNOWN_KIND -> malformed_model_output',{error:plain('UNKNOWN_KIND'),phase:'plan'},'malformed_model_output'],
    ['MISSING_MESSAGE -> malformed_model_output',{error:plain('MISSING_MESSAGE'),phase:'plan'},'malformed_model_output'],
    ['INVALID_ARGS -> malformed_model_output',{error:plain('INVALID_ARGS'),phase:'plan'},'malformed_model_output'],
    ['UNKNOWN_TOOL -> unsupported_tool_request',{error:plain('UNKNOWN_TOOL'),phase:'plan'},'unsupported_tool_request'],
    ['GOVERNANCE_UNAVAILABLE -> dashclaw_unavailable',{error:plain('GOVERNANCE_UNAVAILABLE'),phase:'govern'},'dashclaw_unavailable'],
    ['CLAIM_UNCERTAIN -> dashclaw_unavailable',{error:plain('CLAIM_UNCERTAIN'),phase:'claim'},'dashclaw_unavailable'],
    ['POLICY_BLOCK -> dashclaw_block',{error:plain('POLICY_BLOCK'),phase:'govern'},'dashclaw_block'],
    ['CLAIM_REFUSED -> dashclaw_block',{error:plain('CLAIM_REFUSED'),phase:'claim'},'dashclaw_block'],
    ['REFUND_NOT_HELD -> dashclaw_block',{error:plain('REFUND_NOT_HELD'),phase:'govern'},'dashclaw_block'],
    ['REFUND_HOLD_POLICY_MISSING -> dashclaw_block',{error:plain('REFUND_HOLD_POLICY_MISSING'),phase:'govern'},'dashclaw_block'],
    ['REJECTED -> approval_denied',{error:plain('REJECTED'),phase:'approval'},'approval_denied'],
    ['APPROVAL_EXPIRED -> approval_expired',{error:plain('APPROVAL_EXPIRED'),phase:'approval'},'approval_expired'],
    ['APPROVAL_UNCONFIRMED -> approval_expired',{error:plain('APPROVAL_UNCONFIRMED'),phase:'approval'},'approval_expired'],
    ['a verify read that disagrees with the receipt -> verification_mismatch',{error:plain('VERIFICATION_MISMATCH'),phase:'verify'},'verification_mismatch'],
    ['effect.executions > 1 -> duplicate_effect_detected',{error:plain('DUPLICATE_EFFECT'),phase:'verify'},'duplicate_effect_detected'],
    ['the watch stream closed before terminal -> renderer_interruption',{error:plain('RENDERER_DROPPED'),phase:'render'},'renderer_interruption'],
    ['INTERRUPTED -> local_process_interruption',{error:plain('INTERRUPTED'),phase:'resume'},'local_process_interruption'],
    ['an AbortError -> user_cancellation',{error:{name:'AbortError',message:'Canceled'},phase:'cancel'},'user_cancellation'],
    ['source:"cancel" -> user_cancellation',{error:plain('ANYTHING'),phase:'cancel',source:'cancel'},'user_cancellation'],
    ['reconcile finding unknown -> unknown_external_state',{error:plain('UNKNOWN_STATE'),phase:'reconcile'},'unknown_external_state'],
    ['MODEL transport error -> model_transport_failure',{error:plain('MODEL'),phase:'transport'},'model_transport_failure'],
    ['BUSY -> model_transport_failure',{error:plain('BUSY'),phase:'transport'},'model_transport_failure'],
    ['SESSION_LIMIT -> model_transport_failure',{error:plain('SESSION_LIMIT'),phase:'transport'},'model_transport_failure'],
    ['a transport error from inference(), source:"model" -> model_transport_failure',{error:new Error('network blip'),phase:'plan',source:'model'},'model_transport_failure'],
    ['AMOUNT_EXCEEDS_REFUNDABLE precondition refusal -> precondition_refused',{error:plain('AMOUNT_EXCEEDS_REFUNDABLE'),phase:'precondition'},'precondition_refused'],
    ['PAYMENT_NOT_OBSERVED precondition refusal -> precondition_refused',{error:plain('PAYMENT_NOT_OBSERVED'),phase:'precondition'},'precondition_refused'],
    ['VALUE_NOT_ALLOWED precondition refusal -> precondition_refused',{error:plain('VALUE_NOT_ALLOWED'),phase:'precondition'},'precondition_refused']
  ];
  for(const [name,input,expected] of cases) assert.equal(classifyFailure(input),expected,name);
});

// --- recordIncident -----------------------------------------------------------------------------------------------
test('recordIncident validates enums, derives family and severity, and bounds/redacts sanitizedEvidence',()=>{
  const run=baseRun();
  assert.throws(()=>recordIncident(run,{integration:'stripe',tool:'x',operation:'x',phase:'execute',failureClass:'not_a_class',error:{code:'X',message:'x'}}),/failureClass/);
  assert.throws(()=>recordIncident(run,{integration:'not_an_integration',tool:'x',operation:'x',phase:'execute',failureClass:'transient_provider',error:{code:'X',message:'x'}}),/integration/);
  assert.throws(()=>recordIncident(run,{integration:'stripe',tool:'x',operation:'x',phase:'not_a_phase',failureClass:'transient_provider',error:{code:'X',message:'x'}}),/phase/);

  const secretMessage='Token sk_test_abcdefghijkl was rejected by Stripe.';
  const incident=recordIncident(run,{integration:'stripe',tool:'stripe.refund_payment',operation:'refund:pi_1',phase:'execute',failureClass:'transient_provider',error:{code:'SERVER',message:secretMessage},knownState:'not_sent'});
  assert.equal(incident.family,'stripe:transient_provider:stripe.refund_payment');
  assert.ok(SEVERITY.includes(incident.severity));
  assert.equal(incident.severity,'warn','transient_provider is neither the high nor the info set');
  assert.ok(incident.sanitizedEvidence.message.includes('[redacted:stripe]'),'a Stripe test key is redacted');
  assert.ok(!incident.sanitizedEvidence.message.includes('sk_test_abcdefghijkl'),'the raw key never appears');
  assert.equal(run.incidents.length,1);

  const longMessage='x'.repeat(400);
  const bounded=recordIncident(run,{integration:'stripe',tool:'stripe.refund_payment',operation:'refund:pi_1',phase:'execute',failureClass:'transient_provider',error:{code:'SERVER',message:longMessage},knownState:'not_sent'});
  assert.ok(bounded.sanitizedEvidence.message.length<=300,'the evidence message is bounded to 300 chars');
});

test('recordIncident caps run.incidents at 200, keeping the newest',()=>{
  const run=baseRun();
  for(let i=0;i<210;i++) recordIncident(run,{integration:'hubspot',tool:'hubspot.update_customer',operation:`op_${i}`,phase:'execute',failureClass:'transient_provider',error:{code:'SERVER',message:'x'},knownState:'not_sent'});
  assert.equal(run.incidents.length,200,'the ledger is capped at 200 incidents');
  assert.equal(run.incidents.at(-1).operation,'op_209','the newest incident survives the cap');
  assert.equal(run.incidents[0].operation,'op_10','the oldest ten were dropped to make room');
});

test('recordIncident attaches the announce timeline event only when asked',()=>{
  const run=baseRun();
  const before=run.events.length;
  recordIncident(run,{integration:'model',tool:'',operation:'plan',phase:'plan',failureClass:'model_transport_failure',error:{code:'MODEL',message:'x'},knownState:'n/a',announce:'Model turn failed',announceStatus:'failed'});
  assert.equal(run.events.length,before+1,'announce appends exactly one timeline row');
  assert.equal(run.events.at(-1).kind,'recovery');
  recordIncident(run,{integration:'model',tool:'',operation:'plan',phase:'plan',failureClass:'model_transport_failure',error:{code:'MODEL',message:'x'},knownState:'n/a'});
  assert.equal(run.events.length,before+1,'no announce field appends nothing');
});

// --- resolveIncident ------------------------------------------------------------------------------------------------
test('resolveIncident updates knownState/recoveryResult/verificationResult/finalDisposition but never rewrites failureClass, and validates enums',()=>{
  const run=baseRun();
  const incident=recordIncident(run,{integration:'stripe',tool:'stripe.refund_payment',operation:'refund:pi_1',phase:'execute',failureClass:'response_lost',error:{code:'SERVER',message:'x'},knownState:'sent_unknown'});
  const resolved=resolveIncident(run,incident.incidentId,{failureClass:'rate_limit',knownState:'present',recoveryResult:'reconciled_present',verificationResult:'verified',finalDisposition:'recovered'});
  assert.equal(resolved.failureClass,'response_lost','failureClass never changes on resolve, even when the patch names another one');
  assert.equal(resolved.knownState,'present');
  assert.equal(resolved.recoveryResult,'reconciled_present');
  assert.equal(resolved.verificationResult,'verified');
  assert.equal(resolved.finalDisposition,'recovered');
  assert.throws(()=>resolveIncident(run,incident.incidentId,{recoveryResult:'not_a_result'}),/recoveryResult/);
  assert.equal(resolveIncident(run,'inc_doesnotexist000000',{}),null,'an unknown incident id resolves to null');
});

// --- finalizeIncidents -----------------------------------------------------------------------------------------------
test('finalizeIncidents derives disposition, recoveryResult and verificationResult from the effect ledger, and from run.status when there is no effect',()=>{
  const makeRun=(effectStatus,{recoveryAttempted=false,verification=null,runStatus='executing'}={})=>{
    const run=baseRun({status:runStatus,effects:effectStatus?[{effectId:'fx_1',status:effectStatus,verification}]:[]});
    const incident=recordIncident(run,{integration:'stripe',tool:'stripe.refund_payment',operation:'refund:pi_1',phase:'execute',failureClass:'response_lost',error:{code:'SERVER',message:'x'},knownState:'sent_unknown',effectId:effectStatus?'fx_1':null,recoveryAttempted});
    return {run,incident};
  };

  let {run,incident}=makeRun('verified',{recoveryAttempted:true});
  let changed=finalizeIncidents(run);
  assert.deepEqual([incident.finalDisposition,incident.recoveryResult,incident.verificationResult],['recovered','recovered','verified']);
  assert.equal(changed,3,'all three pending fields count as changed');

  ({run,incident}=makeRun('verified',{recoveryAttempted:false}));
  finalizeIncidents(run);
  assert.deepEqual([incident.finalDisposition,incident.recoveryResult,incident.verificationResult],['info','none','verified']);

  ({run,incident}=makeRun('executed',{verification:{verified:false}}));
  finalizeIncidents(run);
  assert.deepEqual([incident.finalDisposition,incident.recoveryResult,incident.verificationResult],['partial','stopped_partial','unverified']);

  ({run,incident}=makeRun('executed',{verification:null}));
  finalizeIncidents(run);
  assert.equal(incident.verificationResult,'n/a','an executed effect with no verification attempt reads n/a, not unverified');

  ({run,incident}=makeRun('uncertain'));
  finalizeIncidents(run);
  assert.deepEqual([incident.finalDisposition,incident.recoveryResult,incident.verificationResult],['uncertain','stopped_uncertain','n/a']);

  for(const blockedLike of ['blocked','rejected','expired']){
    ({run,incident}=makeRun(blockedLike));
    finalizeIncidents(run);
    assert.equal(incident.finalDisposition,'blocked',`${blockedLike} reads blocked`);
    assert.equal(incident.recoveryResult,'none');
  }

  ({run,incident}=makeRun('failed',{recoveryAttempted:true}));
  finalizeIncidents(run);
  assert.deepEqual([incident.finalDisposition,incident.recoveryResult],['failed','retried_failed']);

  ({run,incident}=makeRun('failed',{recoveryAttempted:false}));
  finalizeIncidents(run);
  assert.deepEqual([incident.finalDisposition,incident.recoveryResult],['failed','none']);

  for(const [runStatus,expected] of [['cancelled','cancelled'],['failed','failed'],['uncertain','uncertain'],['blocked','info']]){
    ({run,incident}=makeRun(null,{runStatus}));
    finalizeIncidents(run);
    assert.equal(incident.finalDisposition,expected,`no effect, run.status ${runStatus} -> ${expected}`);
  }
});

// --- incidentSummary -------------------------------------------------------------------------------------------------
test('incidentSummary counts total, recovered, open, bySeverity and byClass',()=>{
  const run=baseRun();
  recordIncident(run,{integration:'stripe',tool:'a',operation:'a',phase:'execute',failureClass:'transient_provider',error:{code:'SERVER',message:'x'},knownState:'not_sent',finalDisposition:'recovered'});
  recordIncident(run,{integration:'hubspot',tool:'b',operation:'b',phase:'execute',failureClass:'authentication_expired',error:{code:'AUTH',message:'x'},knownState:'not_sent'}); // stays 'pending' -> open
  recordIncident(run,{integration:'gmail',tool:'c',operation:'c',phase:'precondition',failureClass:'ambiguous_identity',error:{code:'AMBIGUOUS_IDENTITY',message:'x'},knownState:'not_sent',finalDisposition:'blocked'});
  const summary=incidentSummary(run);
  assert.equal(summary.total,3);
  assert.equal(summary.recovered,1);
  assert.equal(summary.open,1);
  assert.equal(summary.bySeverity.high,1,'authentication_expired is a high-severity class');
  assert.equal(summary.bySeverity.info,1,'ambiguous_identity is an info-severity class');
  assert.equal(summary.byClass.transient_provider,1);
  assert.equal(summary.byClass.authentication_expired,1);
});

// --- sanitizeIncident ------------------------------------------------------------------------------------------------
test('sanitizeIncident keeps provider ids and replaces emails, urls and Message-IDs',()=>{
  const run=baseRun();
  const incident=recordIncident(run,{
    integration:'gmail',tool:'gmail.send_message',operation:'send:dana@acme.com:refund confirmation',phase:'execute',
    failureClass:'response_lost',error:{code:'NETWORK',message:'Gmail at https://gmail.googleapis.com/x lost message <abc123@mail.gmail.com>, contact dana@acme.com'},
    knownState:'sent_unknown',providerOperationId:'gmail_1',dashclawActionId:'act_1'
  });
  const sanitized=sanitizeIncident(incident);
  assert.equal(sanitized.providerOperationId,'gmail_1','provider ids are kept');
  assert.equal(sanitized.dashclawActionId,'act_1');
  assert.ok(sanitized.operation.includes('<email>'),'operation scrubs the email');
  assert.ok(!sanitized.operation.includes('dana@acme.com'));
  assert.ok(sanitized.sanitizedEvidence.message.includes('<url>'),'a url is replaced');
  assert.ok(sanitized.sanitizedEvidence.message.includes('<message-id>'),'a Message-ID is replaced');
  assert.ok(sanitized.sanitizedEvidence.message.includes('<email>'),'an email is replaced');
  assert.ok(!sanitized.sanitizedEvidence.message.includes('dana@acme.com'),'the raw email never survives');
});

// --- IncidentStore ---------------------------------------------------------------------------------------------------
test('IncidentStore.save is atomic, load rejects a malformed file, and list orders newest-first honouring since and limit',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'sidelook-incidents-'));
  t.after(()=>rm(dir,{recursive:true,force:true}).catch(()=>{}));
  const store=new IncidentStore({dir});
  const run=baseRun();

  const a=recordIncident(run,{integration:'stripe',tool:'a',operation:'a',phase:'execute',failureClass:'transient_provider',error:{code:'SERVER',message:'x'},knownState:'not_sent'},'2026-09-10T00:00:00.000Z');
  await store.save(a);
  const filesAfterA=await readdir(dir);
  assert.deepEqual(filesAfterA,[`${a.incidentId}.json`],'no .tmp file is left behind');
  const onDisk=JSON.parse(await readFile(join(dir,`${a.incidentId}.json`),'utf8'));
  assert.equal(onDisk.incidentId,a.incidentId,'the file parses and matches the saved incident');

  await writeFile(join(dir,'inc_deadbeefdeadbeefdead.json'),'not json','utf8');
  assert.equal(await store.load('inc_deadbeefdeadbeefdead'),null,'a malformed file loads as null');
  assert.equal(await store.load('not-a-valid-id'),null,'an id that does not match the incident id shape loads as null');

  const b=recordIncident(run,{integration:'hubspot',tool:'b',operation:'b',phase:'execute',failureClass:'transient_provider',error:{code:'SERVER',message:'x'},knownState:'not_sent'},'2026-09-11T00:00:00.000Z');
  await store.save(b);
  const c=recordIncident(run,{integration:'gmail',tool:'c',operation:'c',phase:'execute',failureClass:'transient_provider',error:{code:'SERVER',message:'x'},knownState:'not_sent'},'2026-09-12T00:00:00.000Z');
  await store.save(c);

  const listed=await store.list({});
  assert.deepEqual(listed.map(i=>i.incidentId),[c.incidentId,b.incidentId,a.incidentId],'newest first');

  const since=await store.list({since:'2026-09-10T00:00:00.000Z'});
  assert.deepEqual(since.map(i=>i.incidentId),[c.incidentId,b.incidentId],'since excludes anything at or before the cutoff');

  const limited=await store.list({limit:1});
  assert.deepEqual(limited.map(i=>i.incidentId),[c.incidentId],'limit trims to the newest N');
});
