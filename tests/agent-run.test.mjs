import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRun,transition,IllegalTransition,appendEvent,addError,addFact,planEffect,updateEffect,findEffect,priorEffect,
  addApproval,pendingApproval,resolveApproval,summary,finalStatus,finish,isTerminal,snapshot,STATES,ALLOWED,newId,idempotencyKey
} from '../lib/agent/run.mjs';

test('createRun starts in created with an empty run_ id and every ledger present',()=>{
  const run=createRun({goal:'  Refund Acme  ',model:'astra',effort:'low',windowTitle:'Slack'});
  assert.equal(run.status,'created');assert.equal(run.goal,'Refund Acme');
  assert.match(run.runId,/^run_[a-f0-9]{20}$/);
  assert.deepEqual(run.events,[]);assert.deepEqual(run.effects,[]);assert.deepEqual(run.approvals,[]);assert.deepEqual(run.sourceFacts,[]);
  assert.throws(()=>createRun({}),/goal/);
});

test('every allowed transition succeeds and moves status',()=>{
  for(const [from,tos] of Object.entries(ALLOWED)){
    for(const to of tos){
      const run=createRun({goal:'g'});run.status=from;
      transition(run,to,'test');
      assert.equal(run.status,to);
      assert.equal(run.events.at(-1).kind,'phase');
    }
  }
});

test('illegal transitions throw IllegalTransition and never change status',()=>{
  const cases=[['created','executing'],['waiting_for_user','executing'],['verifying','recovering'],['completed','planning'],['cancelled','executing']];
  for(const [from,to] of cases){
    const run=createRun({goal:'g'});run.status=from;
    assert.throws(()=>transition(run,to),IllegalTransition);
    assert.equal(run.status,from,`${from} -> ${to} must not move status`);
  }
  const run=createRun({goal:'g'});
  assert.throws(()=>transition(run,'not_a_state'),err=>err.code==='ILLEGAL_TRANSITION' && err.from==='created' && err.to==='not_a_state');
});

test('appendEvent bounds label, detail and evidence, and caps the timeline keeping the first event',()=>{
  const run=createRun({goal:'g'});
  const entry=appendEvent(run,{kind:'model',status:'info',label:'x'.repeat(500),detail:'y'.repeat(3000),evidence:{big:'z'.repeat(10000)}});
  assert.equal(entry.label.length,200);assert.equal(entry.detail.length,2000);
  assert.equal(entry.evidence.truncated,true);
  assert.equal(appendEvent(run,{kind:'bogus',status:'bogus',label:'fallback'}).kind,'error');
  assert.equal(appendEvent(run,{kind:'bogus',status:'bogus',label:'fallback'}).status,'info');
  for(let i=0;i<405;i++) appendEvent(run,{kind:'model',status:'info',label:`e${i}`});
  assert.equal(run.events.length,400);
  assert.equal(run.events[0].label,'x'.repeat(200),'the very first event ever appended is kept');
  assert.equal(run.events.at(-1).label,'e404');
});

test('addFact dedupes by key, keeping the latest value',()=>{
  const run=createRun({goal:'g'});
  addFact(run,{key:'customer_email',value:'a@acme.com',label:'Email',source:'stripe',ref:'cus_1'});
  addFact(run,{key:'customer_email',value:'b@acme.com',label:'Email',source:'stripe',ref:'cus_1'});
  addFact(run,{key:'payment_id',value:'pi_1',label:'Payment',source:'stripe',ref:'pi_1'});
  assert.equal(run.sourceFacts.length,2);
  assert.equal(run.sourceFacts.find(f=>f.key==='customer_email').value,'b@acme.com');
  assert.throws(()=>addFact(run,{value:'x'}),/key/);
});

test('effect lifecycle: plan, update, finishedAt only on a settled status, findEffect and priorEffect',()=>{
  const run=createRun({goal:'g'});
  const effect=planEffect(run,{tool:'stripe.refund_payment',app:'stripe',opKey:'refund:pi_1'});
  assert.equal(effect.status,'planned');assert.equal(effect.finishedAt,null);
  assert.equal(findEffect(run,effect.effectId).effectId,effect.effectId);
  assert.equal(findEffect(run,'missing'),null);
  assert.equal(priorEffect(run,'stripe.refund_payment','refund:pi_1'),null,'planned alone is not a prior in-flight effect');
  updateEffect(run,effect.effectId,{status:'claimed',attemptId:'att_1'});
  assert.equal(updateEffect(run,effect.effectId,{}).finishedAt,null,'claimed is not a settled status');
  assert.equal(priorEffect(run,'stripe.refund_payment','refund:pi_1').effectId,effect.effectId);
  updateEffect(run,effect.effectId,{status:'verified',receipt:{id:'re_1',at:new Date().toISOString(),raw:{}}});
  assert.ok(updateEffect(run,effect.effectId,{}).finishedAt,'verified sets finishedAt');
  assert.throws(()=>updateEffect(run,'missing',{status:'verified'}),/Unknown effect/);
  assert.throws(()=>updateEffect(run,effect.effectId,{status:'not_a_status'}),/Unknown effect status/);
  assert.throws(()=>planEffect(run,{tool:'x',app:'',opKey:'y'}),/effect needs/);
});

test('summary counts reads, writes and finds a duplicate when the same opKey executed more than once',()=>{
  const run=createRun({goal:'g'});
  appendEvent(run,{kind:'tool',status:'ok',label:'stripe.find_customer',app:'stripe'});
  appendEvent(run,{kind:'tool',status:'ok',label:'stripe.get_recent_payments',app:'stripe'});
  const dup=planEffect(run,{tool:'stripe.refund_payment',app:'stripe',opKey:'refund:pi_1'});
  // Duplicates count executions the provider performed (receipts or present reconciliations), never attempts that were refused before they left.
  updateEffect(run,dup.effectId,{status:'verified',attempts:2,executions:2,reconciliations:[]});
  const clean=planEffect(run,{tool:'hubspot.update_customer',app:'hubspot',opKey:'update:c1:status'});
  updateEffect(run,clean.effectId,{status:'verified',attempts:1,executions:1,reconciliations:[]});
  const s=summary(run);
  assert.equal(s.reads,2);assert.equal(s.apps,2,'stripe (events+effect) and hubspot');
  assert.equal(s.writes.planned,2);assert.equal(s.writes.verified,2);
  assert.equal(s.duplicates,1,'the refund executed twice under one opKey is one duplicate');
  const reconciled=planEffect(run,{tool:'gmail.send_message',app:'gmail',opKey:'send:m1'});
  updateEffect(run,reconciled.effectId,{status:'verified',attempts:2,executions:1,reconciliations:[{at:new Date().toISOString(),finding:'absent',detail:'first attempt never sent',presend:true}]});
  assert.equal(summary(run).duplicates,1,'a retry after a refused first attempt executed once, so it is not counted again');
});

test('finalStatus precedence covers all six terminals',()=>{
  const base=()=>createRun({goal:'g'});
  assert.equal(finalStatus(base(),{cancelled:true}),'cancelled');
  const uncertainRun=base();
  const u=planEffect(uncertainRun,{tool:'stripe.refund_payment',app:'stripe',opKey:'refund:pi_1'});
  updateEffect(uncertainRun,u.effectId,{status:'uncertain'});
  assert.equal(finalStatus(uncertainRun,{}),'uncertain');
  assert.equal(finalStatus(uncertainRun,{runtimeFailure:true}),'uncertain','uncertain outranks a runtime failure');
  assert.equal(finalStatus(base(),{runtimeFailure:true}),'failed');
  const blockedRun=base();
  const b=planEffect(blockedRun,{tool:'stripe.refund_payment',app:'stripe',opKey:'refund:pi_1'});
  updateEffect(blockedRun,b.effectId,{status:'blocked'});
  assert.equal(finalStatus(blockedRun,{}),'blocked');
  const partialRun=base();
  const p1=planEffect(partialRun,{tool:'stripe.refund_payment',app:'stripe',opKey:'refund:pi_1'});
  updateEffect(partialRun,p1.effectId,{status:'verified'});
  const p2=planEffect(partialRun,{tool:'hubspot.update_customer',app:'hubspot',opKey:'update:c1:status'});
  updateEffect(partialRun,p2.effectId,{status:'failed'});
  assert.equal(finalStatus(partialRun,{}),'partial');
  const completedRun=base();
  const c=planEffect(completedRun,{tool:'stripe.refund_payment',app:'stripe',opKey:'refund:pi_1'});
  updateEffect(completedRun,c.effectId,{status:'verified'});
  assert.equal(finalStatus(completedRun,{}),'completed');
  assert.equal(finalStatus(base(),{}),'completed','no writes at all is a clean completion');
});

test('finish transitions to a terminal, freezes the summary and rejects a non-terminal status',()=>{
  const run=createRun({goal:'g'});run.status='verifying';
  finish(run,'completed','All done.');
  assert.equal(run.status,'completed');assert.equal(run.closing,'All done.','finish carries the runtime closing line; the model words stay in finalMessage');assert.equal(run.finalMessage,'');
  assert.ok(run.summary);assert.equal(run.summary.status,'completed');
  assert.equal(run.currentStep,null);assert.equal(run.clarification,null);
  assert.equal(run.events.at(-1).kind,'summary');
  const other=createRun({goal:'g'});
  assert.throws(()=>finish(other,'planning'),/not a terminal status/);
});

test('approvals: added pending, resolved once, snapshot is a detached copy',()=>{
  const run=createRun({goal:'g'});
  addApproval(run,{actionId:'act_1',effectId:'fx_1',app:'stripe',operation:'refund',entity:'pi_1',amount:'$1.00',currency:'usd',reason:'',sourceEvidence:[],policyReason:'',riskScore:60,expiresAt:''});
  assert.equal(pendingApproval(run).actionId,'act_1');
  resolveApproval(run,'act_1','approved','sidelook');
  assert.equal(pendingApproval(run),null);
  assert.equal(resolveApproval(run,'act_1','rejected','sidelook').status,'approved','already resolved, second call is a no-op');
  assert.equal(resolveApproval(run,'missing','approved'),null);
  const copy=snapshot(run);copy.goal='mutated';assert.notEqual(run.goal,copy.goal);
  assert.equal(isTerminal(run),false);
});

test('idempotencyKey is deterministic per run/tool/opKey and newId matches the run_ shape',()=>{
  assert.equal(idempotencyKey('run_a','stripe.refund_payment','refund:pi_1'),idempotencyKey('run_a','stripe.refund_payment','refund:pi_1'));
  assert.notEqual(idempotencyKey('run_a','stripe.refund_payment','refund:pi_1'),idempotencyKey('run_a','stripe.refund_payment','refund:pi_2'));
  assert.match(newId('run'),/^run_[a-f0-9]{20}$/);
  assert.ok(STATES.includes('completed') && STATES.includes('created'));
});
