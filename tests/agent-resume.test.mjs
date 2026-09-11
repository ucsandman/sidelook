// Unit tests for run resume: planResume, applyResume and lineageFor. Contract: docs/AGENT_SELF_HEALING.md section 6.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRun,planEffect,updateEffect,addApproval,transition,nextSeries,idempotencyKey} from '../lib/agent/run.mjs';
import {planResume,applyResume,lineageFor} from '../lib/agent/resume.mjs';
import {createFakeProviders} from '../eval/fake-providers.mjs';
import {AgentRuntime} from '../lib/agent/index.mjs';
import {RunStore} from '../lib/agent/store.mjs';
import {IncidentStore} from '../lib/agent/incidents.mjs';

// --- planResume ------------------------------------------------------------------------------------------------------
test('planResume maps every effect status to keep, verify, reconcile or expire per the contract table, and finds earliestUnverified',()=>{
  const run=createRun({goal:'Test planResume mapping.',model:'astra',effort:'low'});
  const make=(status,extra={})=>{
    const effect=planEffect(run,{tool:'stripe.refund_payment',app:'stripe',opKey:`refund:${run.effects.length}`});
    updateEffect(run,effect.effectId,{status,...extra});
    return effect;
  };
  const verified=make('verified');
  const blocked=make('blocked');
  const rejected=make('rejected');
  const expiredEffect=make('expired');
  const failed=make('failed');
  const executed=make('executed');
  const uncertain=make('uncertain');
  const claimed=make('claimed');
  const executing=make('executing');
  const plannedWithAction=(()=>{const e=planEffect(run,{tool:'hubspot.update_customer',app:'hubspot',opKey:'update:1'});updateEffect(run,e.effectId,{actionId:'act_planned'});return e;})();
  const pendingApproval=make('pending_approval');
  const plannedBare=planEffect(run,{tool:'gmail.send_message',app:'gmail',opKey:'send:1'});

  const plan=planResume(run);
  const byId=Object.fromEntries(plan.actions.map(a=>[a.effectId,a.action]));
  assert.equal(byId[verified.effectId],'keep');
  assert.equal(byId[blocked.effectId],'keep');
  assert.equal(byId[rejected.effectId],'keep');
  assert.equal(byId[expiredEffect.effectId],'keep');
  assert.equal(byId[failed.effectId],'keep');
  assert.equal(byId[executed.effectId],'verify');
  assert.equal(byId[uncertain.effectId],'reconcile');
  assert.equal(byId[claimed.effectId],'reconcile');
  assert.equal(byId[executing.effectId],'reconcile');
  assert.equal(byId[plannedWithAction.effectId],'reconcile','planned with an actionId may have reached the provider');
  assert.equal(byId[pendingApproval.effectId],'expire');
  assert.equal(byId[plannedBare.effectId],'keep','nothing left the process for a bare planned effect');

  assert.equal(plan.earliestUnverified,executed.effectId,'the first non-keep effect in ledger order');
});

test('planResume names every pending approval to expire, and leaves a decided one alone',()=>{
  const run=createRun({goal:'g',model:'astra',effort:'low'});
  addApproval(run,{actionId:'act_1',status:'pending'});
  addApproval(run,{actionId:'act_2',status:'approved'});
  const plan=planResume(run);
  assert.deepEqual(plan.approvals,[{actionId:'act_1',action:'expire'}]);
});

// --- applyResume -------------------------------------------------------------------------------------------------------
test('applyResume expires pending approvals first, verifies an executed effect, reconciles uncertain effects to present and absent, and stops reading at the first unknown finding',async()=>{
  const providers=createFakeProviders({faults:{'stripe.findRefunds':'failAlways'}});
  const governed={outcome:async()=>({ok:true})};
  const run=createRun({goal:'Resume test.',model:'astra',effort:'low'});
  transition(run,'planning','t');transition(run,'executing','t');

  const pendingEffect=planEffect(run,{tool:'stripe.refund_payment',app:'stripe',opKey:'refund:pi_pending'});
  updateEffect(run,pendingEffect.effectId,{status:'pending_approval'});
  addApproval(run,{actionId:'act_pending',effectId:pendingEffect.effectId,app:'stripe',operation:'Refund',entity:'Acme',reason:'',sourceEvidence:[],policyReason:'',matchedPolicies:[],riskScore:60,expiresAt:new Date(Date.now()+900000).toISOString()});

  const executedEffect=planEffect(run,{tool:'hubspot.update_customer',app:'hubspot',opKey:'update:123:verify'});
  updateEffect(run,executedEffect.effectId,{status:'executed',actionId:'act_verify',plan:{contactId:'123',property:'hs_lead_status',value:'OPEN'},receipt:{id:'123',at:new Date().toISOString(),raw:{}}});

  const presentEffect=planEffect(run,{tool:'hubspot.update_customer',app:'hubspot',opKey:'update:123:present'});
  updateEffect(run,presentEffect.effectId,{status:'uncertain',plan:{contactId:'123',property:'hs_lead_status',value:'OPEN'}});

  const absentEffect=planEffect(run,{tool:'hubspot.update_customer',app:'hubspot',opKey:'update:123:absent'});
  updateEffect(run,absentEffect.effectId,{status:'uncertain',plan:{contactId:'123',property:'hs_lead_status',value:'UNQUALIFIED'}});

  const unknownEffect=planEffect(run,{tool:'stripe.refund_payment',app:'stripe',opKey:'refund:pi_acme1'});
  updateEffect(run,unknownEffect.effectId,{status:'uncertain',plan:{opKey:'refund:pi_acme1',paymentId:'pi_acme1',amountCents:1000,amount:'$10.00',currency:'usd'}});

  const notReachedEffect=planEffect(run,{tool:'hubspot.update_customer',app:'hubspot',opKey:'update:123:notreached'});
  updateEffect(run,notReachedEffect.effectId,{status:'uncertain',plan:{contactId:'123',property:'hs_lead_status',value:'OPEN'}});

  const handle={run,deps:{providers,governed},signal:new AbortController().signal,emit(){},isCancelled:()=>false,recordIncident:()=>{}};
  const plan=planResume(run);
  const outcome=await applyResume(handle,plan);

  assert.equal(run.approvals.find(a=>a.actionId==='act_pending').status,'expired','pending approvals are expired');
  assert.equal(pendingEffect.status,'expired');

  const verifyResult=outcome.results.find(r=>r.effectId===executedEffect.effectId);
  assert.equal(verifyResult.action,'verify');
  assert.equal(verifyResult.finding,'verified','the real verifyExecuted() ran against the fake provider');
  assert.equal(executedEffect.status,'verified');

  const presentResult=outcome.results.find(r=>r.effectId===presentEffect.effectId);
  assert.equal(presentResult.finding,'present');
  assert.equal(presentEffect.status,'verified','a present reconciliation runs through to a normal verification');

  const absentResult=outcome.results.find(r=>r.effectId===absentEffect.effectId);
  assert.equal(absentResult.finding,'absent');
  assert.equal(absentEffect.status,'failed');

  const unknownResult=outcome.results.find(r=>r.effectId===unknownEffect.effectId);
  assert.equal(unknownResult.finding,'unknown');
  assert.equal(unknownEffect.status,'uncertain','an unknown reconciliation leaves the effect uncertain');

  const notReachedResult=outcome.results.find(r=>r.effectId===notReachedEffect.effectId);
  assert.equal(notReachedResult.finding,'not_reached','reading stops at the first unknown finding');
  assert.equal(notReachedEffect.status,'uncertain','an effect never reached keeps its prior ledger status');

  assert.equal(outcome.uncertain,2,'unknownEffect and notReachedEffect are both still uncertain at the end');
  assert.equal(outcome.verified,2,'verified counts a "verified" finding and a "present" finding, nothing else');
});

// --- lineageFor ----------------------------------------------------------------------------------------------------
test('lineageFor carries verified/executed/uncertain effects root-first, the attempts map (highest series per tool|opKey with an action id), and facts/entities',()=>{
  const parent=createRun({goal:'Refund and update.',model:'astra',effort:'low'});
  parent.sourceFacts.push({key:'refund_id',value:'re_1',label:'refund_id',source:'stripe',ref:'re_1',at:new Date().toISOString()});
  parent.entities.stripeCustomer={id:'cus_1',email:'dana@acme.com'};

  const effectA=planEffect(parent,{tool:'stripe.refund_payment',app:'stripe',opKey:'refund:pi_1',series:0});
  updateEffect(parent,effectA.effectId,{status:'verified',actionId:'act_a',plan:{},receipt:{id:'re_1'}});

  const effectB=planEffect(parent,{tool:'hubspot.update_customer',app:'hubspot',opKey:'update:1'});
  updateEffect(parent,effectB.effectId,{status:'uncertain'});

  // A later, failed attempt at the same logical operation: not in effects[] (failed is not one of verified/executed/uncertain),
  // but its action id still has to count toward the attempts map, or a child could reuse a consumed series.
  const effectC=planEffect(parent,{tool:'stripe.refund_payment',app:'stripe',opKey:'refund:pi_1',series:1});
  updateEffect(parent,effectC.effectId,{status:'failed',actionId:'act_c',error:{code:'X',message:'x'}});

  const effectD=planEffect(parent,{tool:'gmail.send_message',app:'gmail',opKey:'send:1'});
  updateEffect(parent,effectD.effectId,{status:'blocked',error:{code:'X',message:'x'}});

  const effectE=planEffect(parent,{tool:'hubspot.update_customer',app:'hubspot',opKey:'update:2',series:0});
  updateEffect(parent,effectE.effectId,{status:'verified',actionId:'act_e',superseded:true});

  const lineage=lineageFor(parent);
  assert.equal(lineage.rootRunId,parent.runId);
  assert.equal(lineage.parentRunId,parent.runId);
  assert.deepEqual(lineage.chain,[parent.runId]);
  assert.deepEqual(lineage.effects.map(e=>e.effectId),[effectA.effectId,effectB.effectId],'root first, ledger order, excluding a failed attempt, a blocked write and a superseded one');
  assert.equal(lineage.attempts['stripe.refund_payment|refund:pi_1'],1,'the highest series among effects that carried an action id, including the failed one');
  assert.equal(lineage.attempts['hubspot.update_customer|update:2'],0,'a superseded effect with an action id still counts toward attempts');
  assert.equal(lineage.attempts['gmail.send_message|send:1'],undefined,'an effect with no action id is never tracked');
  assert.deepEqual(lineage.facts,parent.sourceFacts);
  assert.deepEqual(lineage.entities,parent.entities);
});

test('a child run keys its effect idempotency on the root run id, and nextSeries answers one past the inherited attempt',()=>{
  const parent=createRun({goal:'Refund again.',model:'astra',effort:'low'});
  const effectA=planEffect(parent,{tool:'stripe.refund_payment',app:'stripe',opKey:'refund:pi_1',series:0});
  updateEffect(parent,effectA.effectId,{status:'failed',actionId:'act_a'});
  const lineage=lineageFor(parent);

  const child=createRun({goal:parent.goal,model:'astra',effort:'low',lineage});
  assert.equal(child.lineage.rootRunId,parent.runId);
  assert.equal(nextSeries(child,'stripe.refund_payment','refund:pi_1'),1,'one past the series 0 attempt inherited from the parent');

  const directEffect=planEffect(child,{tool:'stripe.refund_payment',app:'stripe',opKey:'refund:pi_1',series:1});
  assert.equal(directEffect.idempotencyKey,idempotencyKey(parent.runId,'stripe.refund_payment','refund:pi_1',1),'the child keys its effect on the root run id, not its own runId');
});

// --- AgentRuntime.reconcileStored() with providers: the §6/§7 restart path, never exercised by the pure-function tests
// above or by tests/agent-runtime.test.mjs's own reconcileStored test (which builds the runtime with no `providers`, so it
// takes the else-branch of index.mjs and never touches this file's own resume.mjs code at all). --------------------------
test('AgentRuntime.reconcileStored() with providers reads back an interrupted run: terminal status, expired approvals, one local_process_interruption incident on disk',async t=>{
  const tmpRoot=await mkdtemp(join(tmpdir(),'sidelook-agent-resume-restart-'));
  t.after(()=>rm(tmpRoot,{recursive:true,force:true}).catch(()=>{}));
  const store=new RunStore({dir:join(tmpRoot,'runs')});
  const incidents=new IncidentStore({dir:join(tmpRoot,'incidents')});
  const providers=createFakeProviders({}); // default fixture: contact 123's hs_lead_status is 'OPEN'

  const run=createRun({goal:'Restart reconciliation.',model:'astra',effort:'low'});
  transition(run,'planning','begin');transition(run,'executing','run');

  // An executed effect: the provider accepted it, nothing proved it yet (planResume: 'verify').
  const executedEffect=planEffect(run,{tool:'hubspot.update_customer',app:'hubspot',opKey:'update:123:hs_lead_status'});
  updateEffect(run,executedEffect.effectId,{status:'executed',plan:{contactId:'123',property:'hs_lead_status',value:'OPEN'},receipt:{id:'123',at:new Date().toISOString(),raw:{}}});

  // An uncertain effect the provider actually holds (planResume: 'reconcile' -> present -> verified).
  const uncertainEffect=planEffect(run,{tool:'hubspot.update_customer',app:'hubspot',opKey:'update:123:hs_lead_status:2'});
  updateEffect(run,uncertainEffect.effectId,{status:'uncertain',plan:{contactId:'123',property:'hs_lead_status',value:'OPEN'}});

  // A pending approval nobody is waiting on any more (planResume: 'expire').
  const pendingEffect=planEffect(run,{tool:'gmail.send_message',app:'gmail',opKey:'send:dana@acme.com:confirmation'});
  updateEffect(run,pendingEffect.effectId,{status:'pending_approval'});
  addApproval(run,{actionId:'act_stored_pending',effectId:pendingEffect.effectId,app:'gmail',operation:'Send',entity:'dana@acme.com',reason:'',sourceEvidence:[],policyReason:'',matchedPolicies:[],riskScore:80,expiresAt:new Date(Date.now()+900000).toISOString()});
  transition(run,'waiting_for_approval','Waiting for a decision.');
  run.status='executing'; // the process died mid-execution, not while cleanly waiting; a non-terminal status reconcileStored will pick up
  await store.save(run);

  const runtime=new AgentRuntime({inference:async()=>{throw new Error('not used in this test');},store,incidents,providers,governed:{outcome:async()=>{throw new Error('outcomeResult should never be called: no effect here carries a dashclawActionId.');}},config:{},health:async()=>({apps:{},ready:false})});
  await runtime.reconcileStored();

  const reloaded=await store.load(run.runId);
  assert.ok(['completed','partial','blocked','failed','uncertain','cancelled'].includes(reloaded.status),'a terminal status is stamped');
  assert.equal(reloaded.approvals.find(a=>a.actionId==='act_stored_pending').status,'expired','pending approvals expire on restart');
  assert.equal(reloaded.effects.find(e=>e.effectId===pendingEffect.effectId).status,'expired');
  assert.ok(reloaded.resume,'run.resume is populated');
  assert.equal(reloaded.resume.results.length,3,'the executed effect, the uncertain effect and the expired approval effect all appear in results');
  const verifyResult=reloaded.resume.results.find(r=>r.effectId===executedEffect.effectId);
  assert.equal(verifyResult.finding,'verified');
  const reconcileResult=reloaded.resume.results.find(r=>r.effectId===uncertainEffect.effectId);
  assert.equal(reconcileResult.finding,'present');
  assert.equal(reloaded.effects.find(e=>e.effectId===executedEffect.effectId).status,'verified');
  assert.equal(reloaded.effects.find(e=>e.effectId===uncertainEffect.effectId).status,'verified');

  const interruptionIncidents=(reloaded.incidents || []).filter(i=>i.failureClass==='local_process_interruption');
  assert.equal(interruptionIncidents.length,1,'exactly one local_process_interruption incident for this restart');
  assert.equal(interruptionIncidents[0].recoveryStrategy,'resume');

  const onDisk=await incidents.load(interruptionIncidents[0].incidentId);
  assert.ok(onDisk,'the IncidentStore holds a file for this incident');
  assert.equal(onDisk.incidentId,interruptionIncidents[0].incidentId);
});
