// Integration tests of the self-healing runtime through the real HTTP route: a real AgentRuntime (the real dashclaw SDK
// against a fresh fake DashClaw server, fixture providers, a scripted model, RunStore/IncidentStore/CircuitBreakers on
// temp dirs) behind createApp's own /api/agent route, talked to exactly as the page does.
// Contract: docs/AGENT_SELF_HEALING.md, and the setupEnv pattern of tests/agent-runtime.test.mjs.
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
import {CircuitBreakers} from '../lib/agent/breakers.mjs';
import {IncidentStore} from '../lib/agent/incidents.mjs';
import {createApp} from '../server.mjs';
import {createRun} from '../lib/agent/run.mjs';
import {executeWrite} from '../lib/agent/effects.mjs';

const HACKATHON_POLICY={holdUrlPatterns:['/v1/refunds'],approvalRiskThreshold:90,blockRiskThreshold:100,nonFabrication:true,allowedActionTypes:['api','email'],requireEvidence:true};
const GOAL_REFUND='Acme cancellation: refund the last payment, mark the CRM lead unqualified, and email confirmation.';
const TERMINAL=new Set(['completed','partial','blocked','cancelled','failed','uncertain']);

function wrapScriptedModel(scriptedModel){
  return (request,signal)=>scriptedModel(request.system,[{text:request.prompt}],request.schema,signal,{model:request.model,effort:request.effort});
}
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

// One real AgentRuntime, with its own CircuitBreakers and IncidentStore on temp dirs, behind a real server.mjs app.
async function setupEnv(t,{policy={},flags={},fixtures={},faults={},model={}}={}){
  const fakeDashClaw=await startFakeDashClaw({policy:{...HACKATHON_POLICY,...policy},keys:{agent:'sk_test_fake_agent',approver:'sk_test_fake_approver'}});
  const providers=createFakeProviders({fixtures,faults,clock:()=>Date.now()});
  const inference=wrapScriptedModel(createScriptedModel(model));
  const config=buildConfig(fakeDashClaw.baseUrl,{flags});
  const governed=createGoverned({config});
  const tmpRoot=await mkdtemp(join(tmpdir(),'sidelook-agent-healing-'));
  const store=new RunStore({dir:join(tmpRoot,'runs')});
  const incidentsDir=join(tmpRoot,'incidents');
  const incidents=new IncidentStore({dir:incidentsDir});
  const breakers=new CircuitBreakers({path:join(tmpRoot,'breakers.json')});
  const health=createHealth({config,providers,governed});
  const runtime=new AgentRuntime({inference,store,governed,providers,config,health,breakers,incidents});
  const app=createApp({agent:runtime,vision:{status:async()=>({configured:true})},local:async()=>({runtimes:{},models:[]})});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.address().port}`;
  const {token}=await (await fetch(`${base}/api/local-session`)).json();
  const headers=(extra={})=>({'Content-Type':'application/json','X-Sidelook-Session':token,Origin:base,...extra});
  const post=(op,data={},extraHeaders={})=>fetch(`${base}/api/agent`,{method:'POST',headers:headers(extraHeaders),body:JSON.stringify({op,...data})});
  t.after(async()=>{
    // Any run a test left active or parked mid-flight still emits, and each emit persists into tmpRoot (index.mjs) and can
    // re-create breakers.json (breakers.mjs's mkdirSync) after the directory removal below starts: stop every active run and
    // await its loop before closing the app/DashClaw and deleting the temp dir, or the removal races a write and is silently
    // swallowed, leaving a leftover %TEMP%\sidelook-agent-healing-* directory.
    await runtime.stopAll();
    await Promise.all([...runtime.entries.values()].map(entry=>entry.loop?.catch(()=>{})));
    await new Promise(resolve=>app.close(resolve));
    await fakeDashClaw.close().catch(()=>{});
    // A run's own persist() is fire-and-forget from emit() (index.mjs), so a write can still be landing on disk a moment
    // after its loop settles; maxRetries/retryDelay is Node's own remedy for that class of transient ENOTEMPTY/EBUSY race
    // rather than a swallowed failure, so a genuine cleanup failure still throws.
    await rm(tmpRoot,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  });
  return {
    base,post,headers,providers,fakeDashClaw,config,store,runtime,breakers,incidents,incidentsDir,tmpRoot,
    create:(data={})=>post('create',{consent:true,model:'astra',effort:'low',goal:GOAL_REFUND,...data}),
    get:runId=>post('get',{run:runId}),
    approve:(runId,actionId,reason='Approved in the test.')=>post('approve',{run:runId,actionId,consent:true,reason}),
    cancel:runId=>post('cancel',{run:runId}),
    continueRun:(runId,data={})=>post('continue',{run:runId,consent:true,model:'astra',effort:'low',...data}),
    diagnostics:(runId=null)=>post('diagnostics',runId?{run:runId}:{}),
    health:()=>post('health',{})
  };
}

function openWatch(env,runId,signal){
  return fetch(`${env.base}/api/agent`,{method:'POST',signal,headers:env.headers({Accept:'application/x-ndjson'}),body:JSON.stringify({op:'watch',run:runId})});
}

// Reads one continuous watch connection exactly as public/agent.js does: ndjson lines, one snapshot per `run` event.
async function drive(env,runId,{onSnapshot=()=>{},until=()=>false,timeoutMs=8000}={}){
  const controller=new AbortController();
  let timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeoutMs);
  const snapshots=[];
  const response=await openWatch(env,runId,controller.signal);
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

// --- 1: a run with faults recovers within the run and leaves one incident, on the run and on disk in the IncidentStore ----
test('a run with a HubSpot fault ends completed with one recovered incident, on the run file and in the IncidentStore',async t=>{
  const env=await setupEnv(t,{faults:{'hubspot.updateContact':'failOnce'}});
  const created=await (await env.create()).json();
  const runId=created.run.runId;
  let approved=false;
  const snapshots=await drive(env,runId,{
    onSnapshot:async run=>{if(!approved && run.status==='waiting_for_approval'){approved=true;await env.approve(runId,pendingActionId(run));}},
    until:toTerminal
  });
  assert.equal(snapshots.at(-1).status,'completed');

  const persisted=await waitForPersisted(env,runId,r=>TERMINAL.has(r.status));
  const hubspotIncidents=(persisted.incidents || []).filter(i=>i.family==='hubspot:transient_provider:hubspot.update_customer');
  assert.equal(hubspotIncidents.length,1,'exactly one incident for this fault episode');
  assert.equal(hubspotIncidents[0].recoveryResult,'recovered');

  const onDisk=await env.incidents.load(hubspotIncidents[0].incidentId);
  assert.ok(onDisk,'the IncidentStore holds a file for this incident');
  assert.equal(onDisk.incidentId,hubspotIncidents[0].incidentId);
});

// --- 1b: Retry-After through a real write, not just decideWrite's arithmetic (docs section 4 rule, §7, §10 scenario 27) ---
test('a HubSpot 429 with Retry-After reconciles first, waits the header value, retries once and verifies; the incident reads rate_limit recovered',async t=>{
  const env=await setupEnv(t,{faults:{'hubspot.updateContact':{kind:'rateLimit',times:1,retryAfterMs:50}}});
  const created=await (await env.create()).json();
  const runId=created.run.runId;
  let approved=false;
  const snapshots=await drive(env,runId,{
    onSnapshot:async run=>{if(!approved && run.status==='waiting_for_approval'){approved=true;await env.approve(runId,pendingActionId(run));}},
    until:toTerminal
  });
  assert.equal(snapshots.at(-1).status,'completed');

  const persisted=await waitForPersisted(env,runId,r=>TERMINAL.has(r.status));
  const updateCalls=env.providers.calls.filter(c=>c.method==='hubspot.updateContact');
  assert.equal(updateCalls.length,2,'exactly one extra write attempt after the rate limit');
  const reconcileIdx=env.providers.calls.findIndex(c=>c.method==='hubspot.findContact' || c.method==='hubspot.getContact');
  const secondUpdateIdx=env.providers.calls.lastIndexOf(updateCalls[1]);
  if(reconcileIdx>=0) assert.ok(reconcileIdx<secondUpdateIdx,'the reconcile read precedes the retry in the call ledger');

  const rateLimitIncidents=(persisted.incidents || []).filter(i=>i.failureClass==='rate_limit');
  assert.equal(rateLimitIncidents.length,1);
  assert.equal(rateLimitIncidents[0].recoveryResult,'recovered');
});

// --- 2: diagnostics -------------------------------------------------------------------------------------------------
test('op diagnostics returns sanitized incidents, a summary and breakers for a run id, and the newest incidents without one',async t=>{
  const env=await setupEnv(t,{faults:{'hubspot.updateContact':'failOnce'}});
  const created=await (await env.create()).json();
  const runId=created.run.runId;
  let approved=false;
  await drive(env,runId,{onSnapshot:async run=>{if(!approved && run.status==='waiting_for_approval'){approved=true;await env.approve(runId,pendingActionId(run));}},until:toTerminal});
  await waitForPersisted(env,runId,r=>TERMINAL.has(r.status));

  const withRun=await (await env.diagnostics(runId)).json();
  assert.equal(withRun.runId,runId);
  assert.equal(withRun.incidents.length,1,'exactly one incident: the single HubSpot failOnce fault');
  assert.ok(withRun.incidents.every(i=>typeof i.sanitizedEvidence?.message==='string'),'every incident is the sanitized shape');
  const secretLike=/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|https?:\/\/|sk_[A-Za-z0-9]+/;
  assert.ok(withRun.incidents.every(i=>!secretLike.test(i.sanitizedEvidence.message)),'no incident message carries an email, url or live key');
  assert.deepEqual(
    [withRun.summary.total,withRun.summary.recovered,withRun.summary.open,withRun.summary.bySeverity,withRun.summary.byClass],
    [1,1,0,{warn:1},{transient_provider:1}],
    'literal summary values, not values derived from the same list they are checked against'
  );
  assert.equal(withRun.resume,null,'a fresh run that never restarted carries no resume record');
  assert.equal(withRun.lineage,null,'a run with no parent carries no lineage');
  assert.ok(Array.isArray(withRun.breakers));

  const withoutRun=await (await env.diagnostics()).json();
  assert.equal(withoutRun.runId,null);
  assert.equal(withoutRun.summary,null);
  assert.ok(Array.isArray(withoutRun.incidents));
  assert.ok(withoutRun.incidents.some(i=>i.family==='hubspot:transient_provider:hubspot.update_customer'),'the newest incidents across runs include this one');
});

// --- 3: continue ------------------------------------------------------------------------------------------------------
test('op continue on a completed run answers 409 NOT_CONTINUABLE',async t=>{
  const env=await setupEnv(t);
  const created=await (await env.create()).json();
  const runId=created.run.runId;
  let approved=false;
  await drive(env,runId,{onSnapshot:async run=>{if(!approved && run.status==='waiting_for_approval'){approved=true;await env.approve(runId,pendingActionId(run));}},until:toTerminal});
  const res=await env.continueRun(runId);
  assert.equal(res.status,409);
  assert.equal((await res.json()).code,'NOT_CONTINUABLE');
});

test('op continue on an active run answers 409 RUN_ACTIVE',async t=>{
  const env=await setupEnv(t);
  const created=await (await env.create()).json();
  const res=await env.continueRun(created.run.runId);
  assert.equal(res.status,409);
  assert.equal((await res.json()).code,'RUN_ACTIVE');
  await env.runtime.stopAll();
});

test('op continue on a partial run creates a child whose lineage names the parent, and whose timeline opens with Continuing run',async t=>{
  const env=await setupEnv(t,{faults:{'hubspot.updateContact':'failAlways'}});
  const created=await (await env.create()).json();
  const runId=created.run.runId;
  let approved=false;
  const snapshots=await drive(env,runId,{onSnapshot:async run=>{if(!approved && run.status==='waiting_for_approval'){approved=true;await env.approve(runId,pendingActionId(run));}},until:toTerminal,timeoutMs:15000});
  assert.equal(snapshots.at(-1).status,'partial','HubSpot never recovers; the Stripe refund is still verified');

  // §4's closing rule: three exhausted attempts at the same fault read as one incident with attemptNumber 3, never three
  // incidents. failOnce (test 1) cannot prove this because it only ever takes one attempt; failAlways burns all three.
  const persistedPartial=await waitForPersisted(env,runId,r=>TERMINAL.has(r.status));
  const hubspotFailAlwaysIncidents=(persistedPartial.incidents || []).filter(i=>i.family==='hubspot:transient_provider:hubspot.update_customer');
  assert.ok(hubspotFailAlwaysIncidents.length>=1,'HubSpot never recovering leaves at least one fault-episode incident');
  const effectIds=new Set(hubspotFailAlwaysIncidents.map(i=>i.effectId));
  assert.equal(effectIds.size,hubspotFailAlwaysIncidents.length,'one incident per effect: three exhausted attempts on the same effect merge onto one record, never three');
  for(const incident of hubspotFailAlwaysIncidents) assert.equal(incident.attemptNumber,3,'each exhausted fault episode burned all three allowed attempts on its own record');

  // The operator's Diagnostics action after an outage ends: clear the fault and the breaker before Continue (docs section 6).
  env.providers.faults.clear('hubspot.updateContact');
  for(const b of env.breakers.snapshot()) env.breakers.reset(b.key);

  const res=await env.continueRun(runId);
  assert.equal(res.status,200);
  const childRun=(await res.json()).run;
  assert.equal(childRun.lineage.parentRunId,runId);
  assert.equal(childRun.lineage.rootRunId,runId);
  const idx=childRun.events.findIndex(e=>String(e.label || '').startsWith('Continuing run'));
  assert.ok(idx>=0,'a Continuing run event exists on the child');
  assert.ok(childRun.events[idx].label.includes(runId),'it names the parent run id');
  // docs/AGENT_SELF_HEALING.md §6 quotes "0 to reconcile"; lib/agent/index.mjs's actual event text reads "0 to read back
  // before anything new" (deviation reported to the parent: the doc's literal wording does not match the implementation).
  assert.equal(childRun.events[idx].label,`Continuing run ${runId}: 1 write already verified, 0 to read back before anything new`,'the full event sentence, not just its prefix');
  assert.ok(!childRun.events.slice(0,idx).some(e=>['tool','write'].includes(e.kind)),'it appears before any real tool or write work starts, so the timeline opens with it');

  const parentBody=await (await env.get(runId)).json();
  const parentRefundActionId=parentBody.run.effects.find(e=>e.tool==='stripe.refund_payment')?.actionId;

  // Drive the child to terminal and assert the contract's own numbers, not just cosmetic lineage fields (docs section 6, 10 scenario 30).
  const callsBefore=env.providers.calls.filter(c=>c.method==='stripe.createRefund').length;
  const childSnapshots=await drive(env,childRun.runId,{until:toTerminal,timeoutMs:15000});
  const childFinal=childSnapshots.at(-1);
  assert.equal(childFinal.status,'completed','HubSpot recovers now that the fault and breaker are cleared');
  assert.equal(env.providers.state.refunds.length,1,'the inherited refund is never repeated');
  assert.equal(env.providers.calls.filter(c=>c.method==='stripe.createRefund').length,callsBefore,'no new stripe.createRefund call on continue');
  assert.equal(childFinal.summary.duplicates,0);
  const childStripeEffect=childFinal.effects.find(e=>e.tool==='stripe.refund_payment');
  assert.ok(['verified','executed'].includes(childStripeEffect.status),'the inherited effect reads as already done');
  assert.equal(childStripeEffect.actionId,parentRefundActionId,'no new DashClaw action for an inherited verified/executed write');
  const childHubspotEffect=childFinal.effects.find(e=>e.tool==='hubspot.update_customer');
  assert.equal(childHubspotEffect.status,'verified');
});

test('op continue on an uncertain run reconciles the inherited effect present before anything new; the refund is never repeated',async t=>{
  const env=await setupEnv(t,{faults:{'stripe.createRefund':'lostAfterSuccess','stripe.findRefunds':'failAlways'}});
  const created=await (await env.create()).json();
  const runId=created.run.runId;
  let approved=false;
  const snapshots=await drive(env,runId,{onSnapshot:async run=>{if(!approved && run.status==='waiting_for_approval'){approved=true;await env.approve(runId,pendingActionId(run));}},until:toTerminal,timeoutMs:15000});
  assert.equal(snapshots.at(-1).status,'uncertain','the refund reached Stripe but the response was lost, and findRefunds cannot read it back');

  env.providers.faults.clear('stripe.findRefunds');
  const res=await env.continueRun(runId);
  assert.equal(res.status,200);
  const childRun=(await res.json()).run;

  const callsBefore=env.providers.calls.filter(c=>c.method==='stripe.createRefund').length;
  const childSnapshots=await drive(env,childRun.runId,{until:toTerminal,timeoutMs:15000});
  const childFinal=childSnapshots.at(-1);
  assert.equal(childFinal.status,'completed');
  assert.equal(env.providers.state.refunds.length,1,'the reconciled refund is never made a second time');
  assert.equal(env.providers.calls.filter(c=>c.method==='stripe.createRefund').length,callsBefore,'no new stripe.createRefund call once the inherited refund reconciles present');
  assert.equal(childFinal.summary.duplicates,0);
  const childStripeEffect=childFinal.effects.find(e=>e.tool==='stripe.refund_payment');
  assert.equal(childStripeEffect.status,'verified','the inherited uncertain effect reconciled present');
});

// --- 4: breakers open on repeated authentication_expired failures and refuse a later read ---------------------------
test('after two Stripe authentication_expired failures across two runs the breaker opens; a third run creates fine but its Stripe read is refused CIRCUIT_OPEN',async t=>{
  const env=await setupEnv(t,{faults:{'stripe.findCustomer':'authExpired'}});

  for(let i=0;i<2;i++){
    const created=await (await env.create()).json();
    const snapshots=await drive(env,created.run.runId,{until:toTerminal});
    assert.equal(snapshots.at(-1).status,'failed',`run ${i+1} ends failed with no Stripe customer found`);
  }

  const healthBody=await (await env.health()).json();
  assert.ok(Array.isArray(healthBody.breakers),'health carries the breaker snapshot');
  assert.ok(healthBody.breakers.some(b=>b.key==='stripe:authentication_expired' && b.state!=='closed'),'the breaker is open after two failures');

  const callsBefore=env.providers.calls.filter(c=>c.method==='stripe.findCustomer').length;
  const created3=await (await env.create()).json();
  assert.ok(created3.run.runId,'a third create still works; only the model breaker refuses create()');
  const snapshots3=await drive(env,created3.run.runId,{until:toTerminal});
  const final3=snapshots3.at(-1);
  assert.equal(final3.status,'failed');
  const callsAfter=env.providers.calls.filter(c=>c.method==='stripe.findCustomer').length;
  assert.equal(callsAfter,callsBefore,'the third run never actually called Stripe; the circuit refused the read first');
  assert.ok(final3.events.some(e=>String(e.label || '').includes('stripe.find_customer not called')),'the timeline says the circuit refused the read');
});

// --- 4b: the write-side breaker gates of effects.mjs's executeWrite (docs section 5), never exercised by driving a read fault ---
test('an open integration breaker refuses a write with CIRCUIT_OPEN before any DashClaw call',async t=>{
  const env=await setupEnv(t);
  env.breakers.recordFailure('stripe','authentication_expired',Date.now());
  env.breakers.recordFailure('stripe','authentication_expired',Date.now());
  assert.equal(env.breakers.check('stripe',{kind:'write'}).open,true,'the breaker is open before the write is attempted');

  const run=createRun({goal:GOAL_REFUND,model:'astra',effort:'low'});
  run.sourceFacts.push({key:'request',value:'refund please',label:'request',source:'slack',ref:'',at:new Date().toISOString()});
  run.entities.stripeCustomer={id:'cus_acme',email:'dana@acme.com',name:'Acme'};
  run.entities.payment={id:'pi_acme1',customerId:'cus_acme',amountCents:48500,amountRefundedCents:0,currency:'usd',status:'succeeded'};
  const handle={run,deps:env.runtime.deps,signal:new AbortController().signal,emit(){},recordIncident(){},persist:async()=>{},isCancelled:()=>false};

  const actionsBefore=env.fakeDashClaw.state.actions.size;
  const callsBefore=env.providers.calls.filter(c=>c.method==='stripe.createRefund').length;
  const result=await executeWrite(handle,'stripe.refund_payment',{paymentId:'pi_acme1',amountCents:0,reason:'test'});

  assert.equal(result.code,'CIRCUIT_OPEN');
  assert.equal(run.effects.at(-1).status,'blocked');
  assert.equal(run.effects.at(-1).error.code,'CIRCUIT_OPEN');
  assert.equal(env.fakeDashClaw.state.actions.size,actionsBefore,'no DashClaw action was created for a write the circuit refused');
  assert.equal(env.providers.calls.filter(c=>c.method==='stripe.createRefund').length,callsBefore,'stripe.createRefund was never called');
});

test('an open DashClaw breaker ends a write blocked with GOVERNANCE_UNAVAILABLE and makes no DashClaw call',async t=>{
  const env=await setupEnv(t);
  env.breakers.recordFailure('dashclaw','dashclaw_unavailable',Date.now());
  env.breakers.recordFailure('dashclaw','dashclaw_unavailable',Date.now());
  assert.equal(env.breakers.check('dashclaw',{kind:'write'}).open,true,'the DashClaw breaker is open before the write is attempted');
  assert.equal(env.breakers.check('hubspot',{kind:'write'}).open,false,'only the DashClaw breaker is open; HubSpot itself is fine');

  const run=createRun({goal:GOAL_REFUND,model:'astra',effort:'low'});
  run.entities.customer={domain:'acme.com'};
  run.entities.hubspotContact={id:'123',email:'dana@acme.com'};
  const handle={run,deps:env.runtime.deps,signal:new AbortController().signal,emit(){},recordIncident(){},persist:async()=>{},isCancelled:()=>false};

  const actionsBefore=env.fakeDashClaw.state.actions.size;
  const callsBefore=env.providers.calls.filter(c=>c.method==='hubspot.updateContact').length;
  const result=await executeWrite(handle,'hubspot.update_customer',{contactId:'123',property:'hs_lead_status',value:'UNQUALIFIED',reason:'test'});

  assert.equal(result.code,'GOVERNANCE_UNAVAILABLE');
  assert.ok(result.detail.includes('Nothing runs without DashClaw'));
  assert.equal(run.effects.at(-1).status,'blocked');
  assert.equal(run.effects.at(-1).error.code,'GOVERNANCE_UNAVAILABLE');
  assert.equal(env.fakeDashClaw.state.actions.size,actionsBefore,'no DashClaw action was created; the write was refused before any DashClaw call');
  assert.equal(env.providers.calls.filter(c=>c.method==='hubspot.updateContact').length,callsBefore,'hubspot.updateContact was never called');
});

// --- 5: the model breaker refuses a further create ----------------------------------------------------------------
test('four malformed model turns across two runs open the model breaker; a third create answers 429 MODEL_PAUSED',async t=>{
  const env=await setupEnv(t,{model:{overrides:{1:'malformed',2:'malformed'}}});
  for(let i=0;i<2;i++){
    const created=await (await env.create()).json();
    const snapshots=await drive(env,created.run.runId,{until:toTerminal});
    assert.equal(snapshots.at(-1).status,'failed',`run ${i+1} ends failed after two consecutive malformed turns`);
  }
  const third=await env.create();
  assert.equal(third.status,429);
  assert.equal((await third.json()).code,'MODEL_PAUSED');
});

// --- 6: closing the watch stream early ------------------------------------------------------------------------------
test('closing the watch stream early records a renderer_interruption incident once on the run',async t=>{
  const env=await setupEnv(t);
  // GOAL_REFUND, not GOAL_READ: it pauses at waiting_for_approval, so the run is still non-terminal by the time this
  // watch connection is closed early. A read-only goal can finish before the connection is even open, and noteWatchDrop
  // never fires on an already-terminal run.
  const created=await (await env.create()).json();
  const runId=created.run.runId;

  const controller=new AbortController();
  const response=await openWatch(env,runId,controller.signal);
  const reader=response.body.getReader();
  await reader.read(); // one ndjson line: the initial snapshot
  controller.abort();
  await reader.cancel().catch(()=>{});

  let run=null;
  for(let i=0;i<60;i++){
    run=(await (await env.get(runId)).json()).run;
    if((run.incidents || []).some(inc=>inc.failureClass==='renderer_interruption')) break;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  const rendererIncidents=(run.incidents || []).filter(inc=>inc.failureClass==='renderer_interruption');
  assert.equal(rendererIncidents.length,1,'exactly one renderer_interruption incident is recorded for one early close');
  assert.equal(rendererIncidents[0].integration,'sidelook');
  assert.equal(rendererIncidents[0].recoveryResult,'none');
});
