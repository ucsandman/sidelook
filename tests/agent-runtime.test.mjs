// Integration test of the Agent mode runtime through the real server route: a real AgentRuntime (the real dashclaw SDK
// against a fresh fake DashClaw server, fixture providers, a scripted model, RunStore on a temp dir) behind createApp's
// own /api/agent route, talked to exactly as the page does. Contract: docs/AGENT_MODE_IMPLEMENTATION.md sections 3, 8, 9, 11.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startFakeDashClaw} from '../eval/fake-dashclaw.mjs';
import {createFakeProviders} from '../eval/fake-providers.mjs';
import {createScriptedModel} from '../eval/scripted-model.mjs';
import {createGoverned} from '../lib/agent/governed.mjs';
import {RunStore} from '../lib/agent/store.mjs';
import {createHealth} from '../lib/agent/health.mjs';
import {AgentRuntime} from '../lib/agent/index.mjs';
import {createRun,transition,planEffect,updateEffect,addApproval,TERMINAL} from '../lib/agent/run.mjs';
import {finalStatus,summary} from '../lib/agent/run.mjs';
import {executeWrite} from '../lib/agent/effects.mjs';
import {runLoop} from '../lib/agent/loop.mjs';
import {EMPTY_PLAN} from '../lib/agent/planner.mjs';
import {createApp} from '../server.mjs';

// The same hackathon policy pack eval/run.mjs starts the fake DashClaw server with (contract section 15): refunds are
// held for a human, so every scenario below hits the approval gate the same way the live setup would.
const HACKATHON_POLICY={holdUrlPatterns:['/v1/refunds'],approvalRiskThreshold:90,blockRiskThreshold:100,nonFabrication:true,allowedActionTypes:['api','email'],requireEvidence:true};
const GOAL_REFUND='Acme cancellation: refund the last payment, mark the CRM lead unqualified, and email confirmation.';

// The AgentRuntime calls inference(request,signal) with request={system,prompt,schema,model,effort}; the scripted model
// speaks vision.generate's positional shape. The same adapter eval/run.mjs uses.
function wrapScriptedModel(scriptedModel){
  return (request,signal)=>scriptedModel(request.system,[{text:request.prompt}],request.schema,signal,{model:request.model,effort:request.effort});
}
// Shape matches lib/agent/config.mjs's loadConfig() output exactly (governed.mjs reads config.dashclaw, not env). The
// fake tokens are fixed literals here so test 9 can grep for them by name.
function buildConfig(baseUrl,{flags={}}={}){
  return {
    dashclaw:{baseUrl,apiKey:'sk_test_fake_agent',approverApiKey:'sk_test_fake_approver',agentId:'sidelook-agent',agentName:'Sidelook Agent Mode',configured:true},
    stripe:{secretKey:'sk_test_fake',mode:'test',allowLive:false,refundMaxCents:100000,configured:true},
    hubspot:{token:'fake-hubspot-token',property:'hs_lead_status',value:'UNQUALIFIED',allowedValues:['UNQUALIFIED'],configured:true},
    gmail:{clientId:'fake',clientSecret:'fake',refreshToken:'fake',from:'demo@sidelook.local',configured:true},
    demo:{customer:'Acme',domain:'acme.com'},
    flags:{failHubspotOnce:false,allowUnverifiedEmail:false,...flags},
    dataDir:''
  };
}

// One real AgentRuntime behind a real server.mjs app on 127.0.0.1, torn down in t.after. `local` is stubbed the way
// tests/local.test.mjs does, so the local-session handshake never depends on LM Studio or Ollama actually running.
async function setupEnv(t,{policy={},flags={},fixtures={},faults={},model={}}={}){
  const fakeDashClaw=await startFakeDashClaw({policy:{...HACKATHON_POLICY,...policy},keys:{agent:'sk_test_fake_agent',approver:'sk_test_fake_approver'}});
  const providers=createFakeProviders({fixtures,faults,clock:()=>Date.now()});
  const inference=wrapScriptedModel(createScriptedModel(model));
  const config=buildConfig(fakeDashClaw.baseUrl,{flags});
  const governed=createGoverned({config});
  const tmpRoot=await mkdtemp(join(tmpdir(),'sidelook-agent-runtime-'));
  const store=new RunStore({dir:tmpRoot});
  const health=createHealth({config,providers,governed});
  const runtime=new AgentRuntime({inference,store,governed,providers,config,health});
  const app=createApp({agent:runtime,vision:{status:async()=>({configured:true})},local:async()=>({runtimes:{},models:[]})});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.address().port}`;
  const {token}=await (await fetch(`${base}/api/local-session`)).json();
  const headers=(extra={})=>({'Content-Type':'application/json','X-Sidelook-Session':token,Origin:base,...extra});
  const post=(op,data={},extraHeaders={})=>fetch(`${base}/api/agent`,{method:'POST',headers:headers(extraHeaders),body:JSON.stringify({op,...data})});
  t.after(async()=>{
    await new Promise(resolve=>app.close(resolve));
    await fakeDashClaw.close().catch(()=>{});
    await rm(tmpRoot,{recursive:true,force:true}).catch(()=>{});
  });
  return {
    base,post,headers,providers,fakeDashClaw,config,store,runtime,tmpRoot,
    create:(data={})=>post('create',{consent:true,model:'astra',effort:'low',goal:GOAL_REFUND,...data}),
    get:runId=>post('get',{run:runId}),
    list:()=>post('list',{}),
    health:()=>post('health',{}),
    approve:(runId,actionId,reason='Approved in the test.')=>post('approve',{run:runId,actionId,consent:true,reason}),
    reject:(runId,actionId,reason='Rejected in the test.')=>post('reject',{run:runId,actionId,consent:true,reason}),
    cancel:runId=>post('cancel',{run:runId})
  };
}

function openWatch(env,runId,signal){
  return fetch(`${env.base}/api/agent`,{method:'POST',signal,headers:env.headers({Accept:'application/x-ndjson'}),body:JSON.stringify({op:'watch',run:runId})});
}

// Reads one continuous watch connection exactly as public/agent.js does: ndjson lines, one snapshot per `run` event.
// `onSnapshot` may perform an HTTP side effect (approve/reject/cancel) on the same run over a separate connection;
// `until` ends the drive, and this connection, the first time it returns true. A short bounded timeout stands in for
// the 10 s heartbeat wait the brief says never to take literally.
async function drive(env,runId,{onSnapshot=()=>{},until=()=>false,timeoutMs=8000}={}){
  const controller=new AbortController();
  let timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeoutMs);
  const snapshots=[];
  const response=await openWatch(env,runId,controller.signal);
  assert.ok(response.headers.get('content-type')?.includes('application/x-ndjson'),`expected an ndjson stream, got ${response.headers.get('content-type')}`);
  const reader=response.body.getReader(),decoder=new TextDecoder();
  let buffer='';
  try{
    while(true){
      const {value,done}=await reader.read();
      if(done) break;
      buffer+=decoder.decode(value,{stream:true});
      let idx;
      while((idx=buffer.indexOf('\n'))>=0){
        const line=buffer.slice(0,idx);buffer=buffer.slice(idx+1);
        if(!line.trim()) continue;
        const event=JSON.parse(line);
        if(event.type!=='run') continue;
        snapshots.push(event.run);
        await onSnapshot(event.run);
        if(until(event.run)) return snapshots;
      }
    }
  } catch(error){
    if(timedOut) throw Object.assign(new Error(`drive() timed out after ${timeoutMs}ms waiting for the expected run state.`),{cause:error});
    throw error;
  } finally {
    clearTimeout(timer);controller.abort();
    await reader.cancel().catch(()=>{});reader.releaseLock();
  }
  return snapshots;
}
// Waits for the run store's own file to settle into a state (save() is fire-and-forget from emit(), so the terminal
// snapshot on the watch stream can arrive slightly before its write to disk finishes).
async function waitForPersisted(env,runId,predicate,{tries=40,delayMs=25}={}){
  for(let i=0;i<tries;i++){
    const onDisk=await env.store.load(runId);
    if(onDisk && predicate(onDisk)) return onDisk;
    await new Promise(resolve=>setTimeout(resolve,delayMs));
  }
  throw new Error(`Timed out waiting for ${runId}'s persisted file to reach the expected state.`);
}

const toTerminal=run=>TERMINAL.has(run.status);
const pendingActionId=run=>run.approvals.find(a=>a.status==='pending')?.actionId || null;

// --- 1: create + watch + an HTTP approve to a verified completion --------------------------------------------------
test('create returns the run; the watch stream carries a waiting_for_approval snapshot, an HTTP approve resolves it, and the final snapshot is a verified completion',async t=>{
  const env=await setupEnv(t);
  const created=await (await env.create()).json();
  const runId=created.run.runId;
  assert.equal(created.run.goal,GOAL_REFUND);
  let approved=false,sawWaiting=false;
  const snapshots=await drive(env,runId,{
    onSnapshot:async run=>{
      if(!approved && run.status==='waiting_for_approval'){
        const pending=run.approvals.filter(a=>a.status==='pending');
        assert.equal(pending.length,1,'exactly one pending approval');
        sawWaiting=true;approved=true;
        const res=await env.approve(runId,pending[0].actionId);
        assert.equal(res.status,200);
      }
    },
    until:toTerminal
  });
  assert.ok(sawWaiting,'the stream carried a waiting_for_approval snapshot');
  const final=snapshots.at(-1);
  assert.equal(final.status,'completed');
  assert.equal(final.summary.writes.verified,3);
  assert.equal(final.summary.approvals.approved,1);
});

// --- 2: a wrong actionId, a missing consent, and a second approve after resolution ----------------------------------
test('approve rejects a mismatched actionId and a missing consent without changing state; a second approve after resolution is a no-op recorded once',async t=>{
  const env=await setupEnv(t);
  const created=await (await env.create()).json();
  const runId=created.run.runId;
  const toWaiting=await drive(env,runId,{until:run=>run.status==='waiting_for_approval'});
  const actionId=pendingActionId(toWaiting.at(-1));
  assert.ok(actionId);

  const wrong=await env.approve(runId,'act_not_the_real_one');
  assert.equal(wrong.status,409);
  const noConsent=await env.post('approve',{run:runId,actionId,reason:''});
  assert.equal(noConsent.status,403);
  const stillPending=(await (await env.get(runId)).json()).run;
  assert.equal(stillPending.approvals.find(a=>a.actionId===actionId).status,'pending','neither bad call moved the approval');

  let approved=false;
  const snapshots=await drive(env,runId,{
    onSnapshot:async run=>{
      if(!approved && run.status==='waiting_for_approval'){approved=true;await env.approve(runId,actionId);}
    },
    until:toTerminal
  });
  assert.equal(snapshots.at(-1).status,'completed');

  const second=await (await env.approve(runId,actionId)).json();
  assert.equal(second.already,true);
  assert.equal(env.fakeDashClaw.state.approvals.size,1,'the fake DashClaw server recorded exactly one approval');
  assert.equal(env.providers.state.refunds.length,1,'the fake Stripe holds exactly one refund');
});

// --- 3: reject -------------------------------------------------------------------------------------------------------
test('reject ends the run blocked, with zero executed writes and the fake DashClaw action recorded as denied',async t=>{
  const env=await setupEnv(t);
  const created=await (await env.create()).json();
  const runId=created.run.runId;
  let actionId=null;
  const snapshots=await drive(env,runId,{
    onSnapshot:async run=>{
      if(!actionId && run.status==='waiting_for_approval'){
        actionId=pendingActionId(run);
        const res=await env.reject(runId,actionId);
        assert.equal(res.status,200);
      }
    },
    until:toTerminal
  });
  const final=snapshots.at(-1);
  assert.equal(final.status,'blocked');
  assert.equal(final.summary.writes.executed,0);
  assert.equal(final.summary.writes.verified,0);
  assert.equal(env.fakeDashClaw.state.actions.get(actionId).status,'failed');
});

// --- 4: cancel during waiting_for_approval --------------------------------------------------------------------------
test('cancel during waiting_for_approval ends the run cancelled, expires the approval, and denies the DashClaw action with no provider write',async t=>{
  const env=await setupEnv(t);
  const created=await (await env.create()).json();
  const runId=created.run.runId;
  let actionId=null;
  const snapshots=await drive(env,runId,{
    onSnapshot:async run=>{
      if(!actionId && run.status==='waiting_for_approval'){
        actionId=pendingActionId(run);
        const res=await env.cancel(runId);
        assert.equal(res.status,200);
      }
    },
    until:toTerminal
  });
  const final=snapshots.at(-1);
  assert.equal(final.status,'cancelled');
  assert.equal(final.approvals.find(a=>a.actionId===actionId).status,'expired');
  const action=env.fakeDashClaw.state.actions.get(actionId);
  assert.equal(action.status,'failed');
  assert.match(action.error_message,/Stopped/);
  assert.equal(env.providers.state.refunds.length,0);
  assert.ok(!env.providers.calls.some(c=>c.method==='stripe.createRefund'),'no refund request ever reached the provider');
});

// --- 5: a second create while a run is active -----------------------------------------------------------------------
test('a second create while a run is active answers 409 RUN_ACTIVE',async t=>{
  const env=await setupEnv(t);
  const first=await env.create();
  assert.equal(first.status,200);
  const second=await env.create();
  assert.equal(second.status,409);
  const body=await second.json();
  assert.equal(body.code,'RUN_ACTIVE');
  // Leaves nothing running behind for teardown: the first run is still mid-flight (parked on approval), so it is
  // cancelled explicitly here rather than raced against app.close()/rm(tmpRoot) in t.after.
  await env.runtime.stopAll();
});

// --- 6: restart reconciliation, then get/list against the new runtime ------------------------------------------------
test('get and list read the stored run after restart; reconcileStored resolves a mid-flight approval and a mid-flight claim',async t=>{
  const tmpRoot=await mkdtemp(join(tmpdir(),'sidelook-agent-runtime-reconcile-'));
  t.after(()=>rm(tmpRoot,{recursive:true,force:true}).catch(()=>{}));
  const store=new RunStore({dir:tmpRoot});

  const runA=createRun({goal:'Refund Acme (mid-approval)',model:'astra',effort:'low'});
  transition(runA,'planning','begin');
  transition(runA,'executing','run');
  const effectA=planEffect(runA,{tool:'stripe.refund_payment',app:'stripe',opKey:'refund:pi_a'});
  updateEffect(runA,effectA.effectId,{status:'pending_approval'});
  addApproval(runA,{actionId:'act_stored_a',effectId:effectA.effectId,app:'stripe',operation:'Refund $10.00',entity:'Acme (cus_a)',amount:'$10.00',currency:'usd',reason:'',sourceEvidence:[],policyReason:'Held for approval.',matchedPolicies:[],riskScore:60,expiresAt:new Date(Date.now()+900000).toISOString()});
  transition(runA,'waiting_for_approval','Waiting for a decision.');
  await store.save(runA);

  const runB=createRun({goal:'Refund Acme (mid-claim)',model:'astra',effort:'low'});
  transition(runB,'planning','begin');
  transition(runB,'executing','run');
  const effectB=planEffect(runB,{tool:'stripe.refund_payment',app:'stripe',opKey:'refund:pi_b'});
  updateEffect(runB,effectB.effectId,{status:'claimed',attemptId:'attempt_stored_b'});
  await store.save(runB);

  const runtime2=new AgentRuntime({inference:async()=>{throw new Error('not used in this test');},store,health:async()=>({apps:{},ready:false})});
  await runtime2.reconcileStored();

  const reA=await store.load(runA.runId);
  assert.equal(reA.status,'blocked');
  assert.equal(reA.approvals[0].status,'expired');
  const reB=await store.load(runB.runId);
  assert.equal(reB.status,'uncertain');
  assert.equal(reB.effects[0].status,'uncertain');

  const app=createApp({agent:runtime2,vision:{status:async()=>({configured:true})},local:async()=>({runtimes:{},models:[]})});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>app.close(resolve)));
  const base=`http://127.0.0.1:${app.address().port}`;
  const {token}=await (await fetch(`${base}/api/local-session`)).json();
  const post=(op,data={})=>fetch(`${base}/api/agent`,{method:'POST',headers:{'Content-Type':'application/json','X-Sidelook-Session':token,Origin:base},body:JSON.stringify({op,...data})});

  const gotA=await (await post('get',{run:runA.runId})).json();
  assert.equal(gotA.run.status,'blocked');
  const gotB=await (await post('get',{run:runB.runId})).json();
  assert.equal(gotB.run.status,'uncertain');
  const list=await (await post('list',{})).json();
  const statuses=Object.fromEntries(list.runs.map(r=>[r.runId,r.status]));
  assert.equal(statuses[runA.runId],'blocked');
  assert.equal(statuses[runB.runId],'uncertain');
});

// --- 7: health ---------------------------------------------------------------------------------------------------------
test('health reports the five app probes, and the DashClaw entry reports the admin approver role from the fake server',async t=>{
  const env=await setupEnv(t);
  const res=await env.health();
  assert.equal(res.status,200);
  const body=await res.json();
  for(const name of ['slack','stripe','hubspot','gmail','dashclaw']) assert.ok(body.apps[name],`apps.${name} is present`);
  assert.equal(body.apps.dashclaw.approverRole,'admin');
});

// --- 8: the watch stream stays open through the approval wait ------------------------------------------------------
test('the watch stream stays open through waiting_for_approval and resumes on a later approve, never waiting on the 10s heartbeat',async t=>{
  const env=await setupEnv(t);
  const created=await (await env.create()).json();
  const runId=created.run.runId;
  const startedAt=Date.now();
  let approved=false,waitingSeen=false;
  const snapshots=await drive(env,runId,{
    timeoutMs:4000,
    onSnapshot:async run=>{
      if(run.status==='waiting_for_approval'){
        waitingSeen=true;
        if(!approved){approved=true;await env.approve(runId,pendingActionId(run));}
      }
    },
    until:toTerminal
  });
  const elapsedMs=Date.now()-startedAt;
  assert.ok(waitingSeen,'the connection carried the waiting_for_approval snapshot');
  assert.ok(elapsedMs<5000,`resumed well inside the 10s heartbeat interval (took ${elapsedMs}ms)`);
  assert.ok(snapshots.length>=2,'more than one run snapshot arrived on the single connection');
  assert.equal(snapshots.at(-1).status,'completed');
});

// --- 9: no fake credential ever leaks -------------------------------------------------------------------------------
test('no fake credential ever appears in an event\'s evidence or the persisted run file',async t=>{
  const env=await setupEnv(t);
  const created=await (await env.create()).json();
  const runId=created.run.runId;
  let approved=false;
  await drive(env,runId,{
    onSnapshot:async run=>{
      if(!approved && run.status==='waiting_for_approval'){approved=true;await env.approve(runId,pendingActionId(run));}
    },
    until:toTerminal
  });
  const gotten=(await (await env.get(runId)).json()).run;
  const persisted=await waitForPersisted(env,runId,r=>TERMINAL.has(r.status));
  const secrets=['sk_test_fake','fake-hubspot-token','sk_test_fake_approver'];
  const eventsText=JSON.stringify(gotten.events);
  const fileText=JSON.stringify(persisted);
  for(const secret of secrets){
    assert.ok(!eventsText.includes(secret),`an event's evidence leaked ${secret}`);
    assert.ok(!fileText.includes(secret),`the persisted run file leaked ${secret}`);
  }
});

// --- 10: HACKATHON_FAIL_HUBSPOT_ONCE recovers within the run --------------------------------------------------------
test('HACKATHON_FAIL_HUBSPOT_ONCE recovers within one run: the recovery labels appear in order and the refund happens once',async t=>{
  const env=await setupEnv(t,{flags:{failHubspotOnce:true}});
  const created=await (await env.create()).json();
  const runId=created.run.runId;
  let approved=false;
  const snapshots=await drive(env,runId,{
    onSnapshot:async run=>{
      if(!approved && run.status==='waiting_for_approval'){approved=true;await env.approve(runId,pendingActionId(run));}
    },
    until:toTerminal
  });
  const final=snapshots.at(-1);
  assert.equal(final.status,'completed');
  const labels=final.events.map(e=>e.label);
  const expectedOrder=['HubSpot update failed','Checking previous effects','Stripe refund already verified','Retrying HubSpot','HubSpot update verified'];
  let cursor=-1;
  for(const label of expectedOrder){
    const idx=labels.indexOf(label,cursor+1);
    assert.ok(idx>cursor,`expected "${label}" after position ${cursor} in the timeline, found at ${idx}`);
    cursor=idx;
  }
  assert.equal(env.providers.state.refunds.length,1);
});

test('the effect engine marks a corrected runtime refusal superseded once the same tool verifies, and the run completes',async()=>{
  // Live Demo A, 2026-09-11: hubspot.update_customer with the model's own value was refused, then called with only the
  // contact id and verified. The refusal must stay on the ledger but not turn a finished run into partial.
  const fake=await startFakeDashClaw({policy:HACKATHON_POLICY});
  try{
    const config=buildConfig(fake.baseUrl);
    const providers=createFakeProviders({});
    const governed=createGoverned({config});
    const run=createRun({goal:GOAL_REFUND,model:'scripted',effort:'low'});
    run.entities.stripeCustomer={id:'cus_1',email:'dana@acme.com',name:'Acme'};
    run.entities.hubspotContact={id:'123',email:'dana@acme.com'};
    transition(run,'planning','Test setup.');transition(run,'executing','Test setup.');
    const handle={run,deps:{providers,governed,config},signal:new AbortController().signal,emit(){},waitForDecision:()=>new Promise(()=>{}),clearDecision(){}};

    const refused=await executeWrite(handle,'hubspot.update_customer',{contactId:'123',value:'CUSTOMER'});
    assert.equal(refused.status,'refused');assert.equal(refused.code,'VALUE_NOT_ALLOWED');assert.ok(refused.next,'the model is told it may correct the call');
    assert.equal(finalStatus(run,{}),'blocked','before the correction the refusal is all there is');

    const verified=await executeWrite(handle,'hubspot.update_customer',{contactId:'123'});
    assert.equal(verified.status,'verified');
    assert.equal(run.effects.length,2);
    assert.equal(run.effects[0].status,'blocked');assert.equal(run.effects[0].superseded,true);
    assert.equal(finalStatus(run,{}),'completed');
    assert.deepEqual([summary(run).writes.blocked,summary(run).writes.corrected],[0,1]);
  }finally{await fake.close();}
});

test('a refund DashClaw allowed without holding it for a person is refused before the claim, and closed as failed on DashClaw',async()=>{
  // Live, 2026-09-11: DashClaw's interruption budget turned the refunds hold into `warn` (builtin:shape_budget) and a $485.00
  // refund ran with no card. The engine must never move money on an unheld verdict.
  const config=buildConfig('http://127.0.0.1:1');
  const providers=createFakeProviders({});
  const outcomes=[],claims=[];
  const stub=(approvedBy)=>({
    async policyNames(){return ['sidelook-agent: refunds need a human'];},
    async record(){return {state:'allowed',actionId:'act_warn',decisionId:'act_gd_warn',decision:'warn',reasons:[],matchedPolicies:['gp_hold','builtin:shape_budget'],riskScore:65,nonFabrication:null,replay:false,actionStatus:'running',approvedBy};},
    async claim(actionId){claims.push(actionId);throw Object.assign(new Error('stop here'),{code:'CLAIM_REFUSED'});},
    async outcome(actionId,payload){outcomes.push({actionId,payload});return {ok:true};},
    actForHttp:({method,url,body})=>({kind:'http',request:{method,url,body_excerpt:body}})
  });
  const setup=governed=>{
    const run=createRun({goal:GOAL_REFUND,model:'scripted',effort:'low'});
    run.sourceFacts.push({key:'request',value:'Please refund our most recent payment.',label:'request',source:'slack',ref:'C1/1.1'});
    run.entities.stripeCustomer={id:'cus_1',email:'dana@acme.com',name:'Acme'};
    run.entities.payment={id:'pi_1',customerId:'cus_1',amountCents:48500,amountRefundedCents:0,currency:'usd'};
    transition(run,'planning','Test setup.');transition(run,'executing','Test setup.');
    return {run,deps:{providers,governed,config},signal:new AbortController().signal,emit(){},waitForDecision:()=>new Promise(()=>{}),clearDecision(){}};
  };

  const unheld=setup(stub(null));
  const result=await executeWrite(unheld,'stripe.refund_payment',{paymentId:'pi_1'});
  assert.equal(result.status,'blocked');assert.equal(result.code,'REFUND_NOT_HELD');
  assert.equal(claims.length,0,'no execution claim for an unheld refund');
  assert.equal(providers.calls.filter(c=>c.method==='stripe.createRefund').length,0,'Stripe never saw a refund');
  assert.deepEqual(outcomes.map(o=>[o.actionId,o.payload.status]),[['act_warn','failed']]);
  assert.match(unheld.run.effects[0].error.message,/builtin:shape_budget/);
  assert.equal(finalStatus(unheld.run,{}),'blocked');

  // A replay of an action a person already approved carries approved_by and goes on to the claim.
  const approved=setup(stub('operator'));
  await executeWrite(approved,'stripe.refund_payment',{paymentId:'pi_1'});
  assert.equal(claims.length,1,'an approved action reaches the claim');
});

test('the loop ends a run by its ledger when the model replies fail: blocked stays blocked, verified work is partial',async()=>{
  const ending=async(seed)=>{
    const run=createRun({goal:GOAL_REFUND,model:'scripted',effort:'low'});
    for(const status of seed){const e=planEffect(run,{tool:'stripe.refund_payment',app:'stripe',opKey:`refund:pi_${status}`});updateEffect(run,e.effectId,{status});}
    const inference=async()=>({result:{...EMPTY_PLAN,kind:'fail',reason:'Cannot continue.',message:'The refund was blocked by policy; nothing more can be done.'}});
    const handle={run,deps:{inference,providers:createFakeProviders({}),config:buildConfig('http://127.0.0.1:1')},signal:new AbortController().signal,
      emit(){},persist:async()=>{},isCancelled:()=>false,waitForUser:async()=>null,waitForDecision:()=>new Promise(()=>{}),clearDecision(){}};
    await runLoop(handle);
    return run;
  };
  const blocked=await ending(['blocked']);
  assert.equal(blocked.status,'blocked');assert.equal(blocked.closing,'','a policy block is not "The run could not finish."');
  assert.equal((await ending(['verified'])).status,'partial');
  assert.equal((await ending([])).status,'failed');
});

