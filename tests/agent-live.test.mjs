// Live round trips against real Slack/Stripe/HubSpot/Gmail/DashClaw. Off by default: every test below is a no-op skip
// unless RUN_LIVE_AGENT_TESTS is exactly '1', so `node --test tests/agent-live.test.mjs` (what CI runs) exits 0 fast
// without touching a network. With the flag, each test names the record ids it creates in its own output.
// Contract: docs/AGENT_MODE_IMPLEMENTATION.md sections 6-10, 17; docs/HACKATHON_SETUP.md section 6.
// RUN_LIVE_AGENT_TESTS=1 node --test tests/agent-live.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {loadConfig} from '../lib/agent/config.mjs';
import {createProviders} from '../lib/agent/providers/index.mjs';
import {createGoverned} from '../lib/agent/governed.mjs';
import {createHealth} from '../lib/agent/health.mjs';
import {request} from '../lib/agent/http.mjs';
import {createRun,addFact,transition} from '../lib/agent/run.mjs';
import {sourceOfTruth,emailReference} from '../lib/agent/facts.mjs';
import {executeWrite} from '../lib/agent/effects.mjs';

const ENABLED=process.env.RUN_LIVE_AGENT_TESTS==='1';
const SKIP_REASON="Set RUN_LIVE_AGENT_TESTS=1 to run the live Agent mode tests against real Slack/Stripe/HubSpot/Gmail/DashClaw.";

const config=loadConfig();
const providers=createProviders({config});
const governed=createGoverned({config});
const STRIPE_BASE='https://api.stripe.com';
const stripeAuth={Authorization:`Bearer ${config.stripe.secretKey}`};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('health: all five integrations are ready',async t=>{
  if(!ENABLED) return t.skip(SKIP_REASON);
  const health=createHealth({config,providers,governed});
  const result=await health();
  console.log(`health live test: ${JSON.stringify(result.apps)}`);
  assert.equal(result.ready,true,`Agent mode is not ready: ${result.detail} (run npm run agent:health for detail).`);
});

test('Stripe: a refund round trip through the real governed engine',async t=>{
  if(!ENABLED) return t.skip(SKIP_REASON);
  if(!config.stripe.configured || config.stripe.mode!=='test') return t.skip('Stripe test mode is not configured (STRIPE_TEST_SECRET_KEY or a sk_test_ STRIPE_SECRET_KEY).');
  if(!config.dashclaw.configured) return t.skip('DashClaw is not configured (DASHCLAW_BASE_URL, DASHCLAW_API_KEY, DASHCLAW_APPROVER_API_KEY).');
  const email='sidelook-live-test@sidelook.local';
  let customer=(await providers.stripe.findCustomer({email}))[0];
  if(!customer){
    const form=new URLSearchParams({email,name:'Sidelook Live Test',description:'Sidelook live test customer'});
    const res=await request({url:`${STRIPE_BASE}/v1/customers`,method:'POST',headers:stripeAuth,form,label:'Stripe live test customer create'});
    customer={id:res.json.id,email,name:'Sidelook Live Test'};
  }
  const form=new URLSearchParams({amount:'100',currency:'usd',customer:customer.id,payment_method:'pm_card_visa',confirm:'true',description:'Sidelook live test'});
  form.append('payment_method_types[]','card');
  const created=await request({url:`${STRIPE_BASE}/v1/payment_intents`,method:'POST',headers:stripeAuth,form,label:'Stripe live test payment intent create'});
  assert.equal(created.json.status,'succeeded',`Payment intent ${created.json.id} did not settle.`);
  const paymentId=created.json.id;
  console.log(`stripe live test: customer ${customer.id}, payment ${paymentId} ($1.00)`);

  const run=createRun({goal:'Live test: refund the $1.00 test payment.',model:'live-test',effort:'low'});
  addFact(run,{key:'request',value:'Please refund the test payment.',label:'request',source:'slack',ref:'live-test'});
  run.entities.stripeCustomer=customer;
  run.entities.payment=await providers.stripe.getPayment({id:paymentId});
  // executeWrite assumes the loop already moved the run out of 'created' (planning -> executing) before any write is attempted.
  transition(run,'planning','Live test setup.');
  transition(run,'executing','Live test setup.');

  let resolveDecision=null;
  const handle={
    run,deps:{providers,governed,config},signal:new AbortController().signal,
    emit(){},waitForDecision:()=>new Promise(resolve=>{resolveDecision=resolve;}),clearDecision(){resolveDecision=null;}
  };
  const background=executeWrite(handle,'stripe.refund_payment',{paymentId});
  let pending=null;
  for(let i=0;i<100 && !pending;i++){await sleep(100);pending=run.approvals.find(a=>a.status==='pending');}
  assert.ok(pending,'DashClaw never returned a pending approval for the refund. Is the "refunds need a human" policy installed (npm run agent:setup-dashclaw)?');
  console.log(`stripe live test: approval ${pending.actionId} pending; approving with the approver key`);
  const approved=await governed.approve(pending.actionId,'Approved by the live test suite.');
  assert.equal(approved.ok,true,`governed.approve failed: ${approved.code} ${approved.message || ''}`);
  resolveDecision?.({decision:'allow',reason:'Approved by the live test suite.'});

  const result=await background;
  assert.equal(result.status,'verified',`The refund did not verify: ${result.detail}`);
  const refunds=await providers.stripe.findRefunds({paymentIntentId:paymentId});
  const refund=refunds.find(r=>r.status==='succeeded' && r.amountCents===100);
  assert.ok(refund,'Stripe holds no succeeded $1.00 refund for this payment intent.');
  console.log(`stripe live test: refund ${refund.id} verified in Stripe.`);
});

test('HubSpot: a property round trip on the seeded contact',async t=>{
  if(!ENABLED) return t.skip(SKIP_REASON);
  if(!config.hubspot.configured) return t.skip('HubSpot is not configured (HUBSPOT_ACCESS_TOKEN); this live round trip needs it.');
  const contact=(await providers.hubspot.findContact({domain:config.demo.domain}))[0];
  assert.ok(contact,`No HubSpot contact found for @${config.demo.domain}. Run npm run agent:seed first.`);
  const property=config.hubspot.property;
  const before=(await providers.hubspot.getContact({id:contact.id,properties:[property]})).properties?.[property] ?? null;
  console.log(`hubspot live test: contact ${contact.id}, ${property} was ${before}`);
  const target=config.hubspot.value;
  await providers.hubspot.updateContact({id:contact.id,properties:{[property]:target}});
  const afterSet=(await providers.hubspot.getContact({id:contact.id,properties:[property]})).properties?.[property] ?? null;
  assert.equal(afterSet,target,`HubSpot did not accept ${property}=${target}.`);
  await providers.hubspot.updateContact({id:contact.id,properties:{[property]:before}});
  const afterRestore=(await providers.hubspot.getContact({id:contact.id,properties:[property]})).properties?.[property] ?? null;
  assert.equal(afterRestore,before,`HubSpot did not restore ${property} back to ${before}.`);
  console.log(`hubspot live test: contact ${contact.id}, ${property} set to ${target} then restored to ${before}.`);
});

test('Gmail: sends a one-line test message to itself, reads it back by id, and finds it by reference',async t=>{
  if(!ENABLED) return t.skip(SKIP_REASON);
  if(!config.gmail.configured) return t.skip('Gmail is not configured (GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_FROM); this live round trip needs it.');
  const messageId=`<sidelook-live-test-${Date.now()}@sidelook.local>`;
  const reference=emailReference(messageId);
  const raw=providers.gmail.composeRaw({to:config.gmail.from,subject:'Sidelook live test',body:`This is a one-line test message from the Sidelook live test suite.\n\nReference: ${reference}`,messageId});
  const sent=await providers.gmail.send({raw});
  console.log(`gmail live test: sent ${sent.id} (reference ${reference}) to ${config.gmail.from}`);
  // Verification path: the id Gmail returned answers at once.
  const byId=await providers.gmail.getMessage({id:sent.id});
  assert.ok(byId.found,`Gmail does not hold message ${sent.id}.`);
  assert.ok((byId.labelIds || []).includes('SENT'),`Gmail message ${sent.id} is not labeled SENT.`);
  // Reconciliation path: the search index lags a send (Gmail also rewrites the Message-ID for gmail.com senders), so the
  // reference in the body is what a lost send answer is found by; give the index up to 90 s.
  let found={found:false};
  const startedAt=Date.now();
  while(!found.found && Date.now()-startedAt<90000){await sleep(3000);found=await providers.gmail.findByMessageId({messageId,reference});}
  assert.ok(found.found,`Gmail search never indexed reference ${reference} within 90 s.`);
  assert.equal(found.id,sent.id,'the search found a different message than the one sent');
  console.log(`gmail live test: found ${found.id} by reference after ${Math.round((Date.now()-startedAt)/1000)} s.`);
});

test('DashClaw: non-fabrication blocks a fabricated amount and passes the real facts',async t=>{
  if(!ENABLED) return t.skip(SKIP_REASON);
  const run=createRun({goal:'Live test: non-fabrication check.',model:'live-test',effort:'low'});
  addFact(run,{key:'customer_name',value:'Sidelook Live Test',label:'customer_name',source:'stripe',ref:'live-test'});
  addFact(run,{key:'refund_amount',value:'$1.00',label:'refund_amount',source:'stripe',ref:'live-test'});
  addFact(run,{key:'refund_id',value:'re_livetest',label:'refund_id',source:'stripe',ref:'live-test'});
  const truth=sourceOfTruth(run);
  // The policy reads content and source from the act (see scripts/agent-setup-dashclaw.mjs), so the act carries them.
  const actFor=content=>governed.actForHttp({method:'POST',url:'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',body:content,evidence:{content,source_of_truth:truth}});

  const fabricated=await governed.check({actionType:'email',declaredGoal:'Live test: fabricated amount',riskScore:30,act:actFor('We refunded $9,999.00 to your account.'),content:'We refunded $9,999.00 to your account.',sourceOfTruth:truth});
  assert.equal(fabricated.decision,'block',`A fabricated amount was not blocked: ${JSON.stringify(fabricated)}`);
  console.log(`dashclaw live test: fabricated content blocked (${(fabricated.reasons || []).join('; ') || 'no reason given'})`);

  const honest=await governed.check({actionType:'email',declaredGoal:'Live test: honest content',riskScore:30,act:actFor('We refunded $1.00 to Sidelook Live Test (re_livetest).'),content:'We refunded $1.00 to Sidelook Live Test (re_livetest).',sourceOfTruth:truth});
  assert.notEqual(honest.decision,'block',`Honest content was blocked: ${JSON.stringify(honest)}`);
  console.log('dashclaw live test: honest content passed.');
});
