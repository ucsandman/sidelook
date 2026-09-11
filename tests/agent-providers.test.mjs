import test from 'node:test';
import assert from 'node:assert/strict';
import {ProviderError,request,retryRead,backoffDelay} from '../lib/agent/http.mjs';
import {loadConfig} from '../lib/agent/config.mjs';
import {createSlack} from '../lib/agent/providers/slack.mjs';
import {createStripe} from '../lib/agent/providers/stripe.mjs';
import {createHubspot} from '../lib/agent/providers/hubspot.mjs';
import {createGmail} from '../lib/agent/providers/gmail.mjs';
import {createProviders} from '../lib/agent/providers/index.mjs';

const jsonResponse=(status,body,headers={})=>({ok:status>=200 && status<300,status,headers:{get:name=>headers[String(name).toLowerCase()] ?? null},text:async()=>JSON.stringify(body)});

// ---------- http.mjs: the failure taxonomy and the retry primitives every provider relies on ----------

test('request() classifies HTTP status codes into the taxonomy from section 14',async()=>{
  const cases=[[401,'AUTH',false],[403,'AUTH',false],[404,'NOT_FOUND',false],[429,'RATE_LIMIT',true],[500,'SERVER',true],[502,'SERVER',true],[400,'INVALID',false],[409,'CONFLICT',true],[422,'INVALID',false]];
  for(const [status,code,sentRequest] of cases){
    const fetchImpl=async()=>jsonResponse(status,{error:'boom'});
    await assert.rejects(request({url:'https://x.example',fetchImpl,label:'probe'}),error=>{
      assert.ok(error instanceof ProviderError,`status ${status} throws a ProviderError`);
      assert.equal(error.code,code,`status ${status} code`);
      assert.equal(error.sentRequest,sentRequest,`status ${status} sentRequest`);
      return true;
    });
  }
});

test('a 429 carries retryAfterMs parsed from the Retry-After header',async()=>{
  const fetchImpl=async()=>jsonResponse(429,{error:'rate'},{'retry-after':'2'});
  await assert.rejects(request({url:'https://x.example',fetchImpl,label:'probe'}),error=>{assert.equal(error.retryAfterMs,2000);return true;});
});

test('request() times out via AbortSignal.timeout and reports TIMEOUT with sentRequest true',async()=>{
  const fetchImpl=(url,init)=>new Promise((resolve,reject)=>{init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});});
  await assert.rejects(request({url:'https://x.example',fetchImpl,timeoutMs:20,label:'probe'}),error=>{
    assert.equal(error.code,'TIMEOUT');assert.equal(error.retryable,true);assert.equal(error.sentRequest,true);return true;
  });
});

test('request() classifies a network TypeError, sentRequest reflecting whether the socket ever connected',async()=>{
  const refused=async()=>{const e=new TypeError('fetch failed');e.cause={code:'ECONNREFUSED'};throw e;};
  await assert.rejects(request({url:'https://x.example',fetchImpl:refused,label:'a'}),error=>{
    assert.equal(error.code,'NETWORK');assert.equal(error.sentRequest,false);assert.equal(error.retryable,true);return true;
  });
  const reset=async()=>{const e=new TypeError('fetch failed');e.cause={code:'ECONNRESET'};throw e;};
  await assert.rejects(request({url:'https://x.example',fetchImpl:reset,label:'a'}),error=>{
    assert.equal(error.code,'NETWORK');assert.equal(error.sentRequest,true);return true;
  });
});

test('a caller-driven abort propagates as its own AbortError, never wrapped as a ProviderError',async()=>{
  const controller=new AbortController();
  const fetchImpl=(url,init)=>new Promise((resolve,reject)=>{init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});});
  const pending=request({url:'https://x.example',fetchImpl,signal:controller.signal,label:'p'});
  controller.abort();
  await assert.rejects(pending,error=>{assert.equal(error.name,'AbortError');assert.ok(!(error instanceof ProviderError));return true;});
});

test('ProviderError.detail is bounded and redacted even from a raw error body carrying a token',()=>{
  const error=new ProviderError('AUTH','failed',{detail:`leaked sk_live_ABCDEF123456 ${'x'.repeat(2000)}`});
  assert.ok(!error.detail.includes('sk_live_'));
  assert.ok(error.detail.length<=1000);
});

test('backoffDelay grows exponentially from baseMs',()=>{
  assert.equal(backoffDelay(1,400,4),400);
  assert.equal(backoffDelay(2,400,4),1600);
  assert.equal(backoffDelay(3,400,4),6400);
});

test('retryRead retries only retryable errors and backs off, staying well under a real second',async()=>{
  let attempts=0;
  const start=Date.now();
  const result=await retryRead(async()=>{
    attempts++;
    if(attempts<3) throw new ProviderError('SERVER','boom',{retryable:true,sentRequest:true});
    return 'ok';
  },{attempts:3,baseMs:5,factor:2});
  assert.equal(result,'ok');assert.equal(attempts,3);
  assert.ok(Date.now()-start<50,'stayed under the no-real-wait-above-50ms budget');
});

test('retryRead gives up immediately on a non-retryable error',async()=>{
  let attempts=0;
  await assert.rejects(retryRead(async()=>{attempts++;throw new ProviderError('AUTH','no',{retryable:false});},{attempts:3,baseMs:5}),/no/);
  assert.equal(attempts,1);
});

test('retryRead exhausts its attempts and throws the last error',async()=>{
  let attempts=0;
  await assert.rejects(retryRead(async()=>{attempts++;throw new ProviderError('SERVER','still failing',{retryable:true});},{attempts:3,baseMs:5}),/still failing/);
  assert.equal(attempts,3);
});

test('retryRead honours retryAfterMs even when it exceeds the exponential backoff',async()=>{
  let attempts=0;const start=Date.now();
  await retryRead(async()=>{
    attempts++;
    if(attempts===1){const e=new ProviderError('RATE_LIMIT','slow down',{retryable:true});e.retryAfterMs=30;throw e;}
    return 'ok';
  },{attempts:2,baseMs:1,factor:1});
  assert.ok(Date.now()-start>=25,'waited close to the provider-specified retryAfterMs, not just the tiny backoff');
});

// ---------- providers/index.mjs: an unconfigured app fails closed, naming its env var, and never branches on undefined ----------

test('createProviders returns a CONFIG-failing object for every unconfigured app',async()=>{
  const config=loadConfig({env:{},loadFile:false});
  const providers=createProviders({config});
  for(const [app,method,args] of [['slack','health',[]],['stripe','findCustomer',[{}]],['hubspot','getContact',[{}]],['gmail','send',[{}]]]){
    await assert.rejects(providers[app][method](...args),error=>{assert.equal(error.code,'CONFIG');assert.ok(error.message.length>0);return true;});
  }
});

// ---------- Slack ----------

function fakeSlackFetch(handlers){
  const calls=[];
  const fetchImpl=async(url,init)=>{
    const method=url.split('/api/')[1];
    const params=Object.fromEntries(new URLSearchParams(init.body));
    calls.push({method,params,headers:{...init.headers}});
    const handler=handlers[method];
    const json=handler?await handler(params):{ok:true};
    return {ok:true,status:200,headers:{get:()=>null},text:async()=>JSON.stringify(json)};
  };
  return {fetchImpl,calls};
}

test('slack.health calls auth.test with only a Bearer header',async()=>{
  const config=loadConfig({env:{SLACK_BOT_TOKEN:'xoxb-fake'},loadFile:false});
  const {fetchImpl,calls}=fakeSlackFetch({});
  await createSlack({config,fetchImpl}).health();
  assert.equal(calls[0].method,'auth.test');
  assert.deepEqual(Object.keys(calls[0].headers).sort(),['Authorization','Content-Type']);
  assert.equal(calls[0].headers.Authorization,'Bearer xoxb-fake');
});

test('slack.health throws AUTH when Slack answers ok:false with an auth error, even on HTTP 200',async()=>{
  const config=loadConfig({env:{SLACK_BOT_TOKEN:'xoxb-bad'},loadFile:false});
  const {fetchImpl}=fakeSlackFetch({'auth.test':()=>({ok:false,error:'invalid_auth'})});
  await assert.rejects(createSlack({config,fetchImpl}).health(),error=>{assert.equal(error.code,'AUTH');return true;});
});

test('slack.findCustomerRequest resolves a channel name, scans the lookback window, matches by customer or domain, sorts newest first, and bounds to 5',async()=>{
  const config=loadConfig({env:{SLACK_BOT_TOKEN:'xoxb-fake',SLACK_CHANNELS:'general',SLACK_LOOKBACK_DAYS:'30'},loadFile:false});
  const now=()=>1_700_000_000_000;
  const messages=[
    {ts:'1699000000.0001',text:'Acme wants a refund',user:'U1'},
    {ts:'1699100000.0002',text:'unrelated chatter',user:'U2'},
    {ts:'1699200000.0003',text:'please refund acme.com order',user:'U1'},
    {ts:'1699300000.0004',text:'Acme again',user:'U3'},
    {ts:'1699400000.0005',text:'Acme once more',user:'U1'},
    {ts:'1699500000.0006',text:'Acme yet again',user:'U2'},
    {ts:'1699600000.0007',text:'newest Acme mention',user:'U1'}
  ];
  const {fetchImpl,calls}=fakeSlackFetch({
    'conversations.list':()=>({ok:true,channels:[{id:'C1',name:'general'}]}),
    'conversations.history':params=>{assert.equal(params.channel,'C1');return {ok:true,messages};},
    'users.info':params=>params.user==='U1'?{ok:true,user:{real_name:'Alex'}}:{ok:false,error:'user_not_found'},
    'chat.getPermalink':params=>({ok:true,permalink:`https://slack.example/p/${params.message_ts}`})
  });
  const {messages:results}=await createSlack({config,fetchImpl,now}).findCustomerRequest({customer:'Acme',domain:'acme.com'});
  assert.equal(results.length,5,'bounded to 5');
  assert.equal(results[0].ts,'1699600000.0007','newest first');
  assert.equal(results[0].author,'Alex','users.info name resolved');
  assert.ok(results.some(r=>r.author==='U2'),'falls back to the user id when users.info fails');
  assert.equal(results[0].channelName,'general');assert.equal(results[0].channel,'C1');
  assert.equal(results[0].permalink,'https://slack.example/p/1699600000.0007');
  const historyCall=calls.find(c=>c.method==='conversations.history');
  assert.equal(historyCall.params.oldest,String(Math.floor(now()/1000-30*86400)));
  assert.equal(historyCall.params.limit,'200');
  const listCall=calls.find(c=>c.method==='conversations.list');
  assert.equal(listCall.params.limit,'200');assert.equal(listCall.params.types,'public_channel');
});

test('slack.findCustomerRequest skips channel-name resolution when every channel is already an id',async()=>{
  const config=loadConfig({env:{SLACK_BOT_TOKEN:'xoxb-fake'},loadFile:false});
  const {fetchImpl,calls}=fakeSlackFetch({'conversations.history':()=>({ok:true,messages:[]})});
  await createSlack({config,fetchImpl}).findCustomerRequest({customer:'Acme',channels:['C0123456']});
  assert.ok(!calls.some(c=>c.method==='conversations.list'));
});

test('slack.getMessageContext bounds thread replies to 20 and sends the exact channel and ts',async()=>{
  const config=loadConfig({env:{SLACK_BOT_TOKEN:'xoxb-fake'},loadFile:false});
  const many=Array.from({length:30},(_,i)=>({ts:`${i}`,text:`reply ${i}`,user:`U${i}`}));
  const {fetchImpl}=fakeSlackFetch({'conversations.replies':params=>{
    assert.equal(params.channel,'C1');assert.equal(params.ts,'123.456');assert.equal(params.limit,'20');return {ok:true,messages:many};
  }});
  const {replies}=await createSlack({config,fetchImpl}).getMessageContext({channel:'C1',ts:'123.456'});
  assert.equal(replies.length,20);assert.equal(replies[0].text,'reply 0');
});

// ---------- Stripe ----------

function fakeStripeFetch(handler){
  const calls=[];
  const fetchImpl=async(url,init)=>{
    const u=new URL(url);
    const record={path:u.pathname,query:Object.fromEntries(u.searchParams),method:init.method,headers:{...init.headers},body:init.body?Object.fromEntries(new URLSearchParams(init.body)):null};
    calls.push(record);
    const result=await handler(record);
    return {ok:result.status<300,status:result.status,headers:{get:()=>null},text:async()=>JSON.stringify(result.body)};
  };
  return {fetchImpl,calls};
}

test('stripe.findCustomer searches by email with the exact query string, headers never beyond Authorization',async()=>{
  const config=loadConfig({env:{STRIPE_SECRET_KEY:'sk_test_fake'},loadFile:false});
  const {fetchImpl,calls}=fakeStripeFetch(({path,query})=>{
    // An exact email goes through the read-your-writes list endpoint, not the lagging search index.
    assert.equal(path,'/v1/customers');assert.equal(query.email,'a@acme.com');assert.equal(query.limit,'10');
    return {status:200,body:{data:[{id:'cus_1',email:'a@acme.com',name:'Acme Inc'}]}};
  });
  const results=await createStripe({config,fetchImpl}).findCustomer({email:'a@acme.com'});
  assert.deepEqual(results,[{id:'cus_1',email:'a@acme.com',name:'Acme Inc'}]);
  assert.deepEqual(Object.keys(calls[0].headers),['Authorization']);
});

test('stripe.findCustomer falls back to name~ and always filters client-side by domain',async()=>{
  const config=loadConfig({env:{STRIPE_SECRET_KEY:'sk_test_fake'},loadFile:false});
  const {fetchImpl}=fakeStripeFetch(({query})=>{
    assert.equal(query.query,"name~'Acme'");
    return {status:200,body:{data:[{id:'cus_1',email:'a@acme.com',name:'Acme Inc'},{id:'cus_2',email:'b@other.com',name:'Acme Other'}]}};
  });
  const results=await createStripe({config,fetchImpl}).findCustomer({query:'Acme',domain:'acme.com'});
  assert.deepEqual(results.map(r=>r.id),['cus_1']);
});

test('stripe.findCustomer with only a domain searches name~ on the domain text, then filters by email domain',async()=>{
  const config=loadConfig({env:{STRIPE_SECRET_KEY:'sk_test_fake'},loadFile:false});
  const {fetchImpl}=fakeStripeFetch(({query})=>{
    assert.equal(query.query,"name~'acme.com'");
    return {status:200,body:{data:[{id:'cus_1',email:'a@acme.com',name:'Acme'},{id:'cus_2',email:'b@other.com',name:'Acmeco'}]}};
  });
  const results=await createStripe({config,fetchImpl}).findCustomer({domain:'acme.com'});
  assert.deepEqual(results.map(r=>r.id),['cus_1']);
});

test('stripe.listRecentPayments expands the latest charge, keeps only succeeded, computes refundable newest first',async()=>{
  const config=loadConfig({env:{STRIPE_SECRET_KEY:'sk_test_fake'},loadFile:false});
  const {fetchImpl}=fakeStripeFetch(({path,query})=>{
    assert.equal(path,'/v1/payment_intents');assert.equal(query.customer,'cus_1');assert.equal(query.limit,'10');assert.equal(query['expand[]'],'data.latest_charge');
    return {status:200,body:{data:[
      {id:'pi_1',status:'succeeded',amount_received:485,currency:'usd',created:1699000000,description:'Order 1',latest_charge:{id:'ch_1',amount_refunded:0}},
      {id:'pi_2',status:'succeeded',amount_received:200,currency:'usd',created:1699100000,description:'Order 2',latest_charge:{id:'ch_2',amount_refunded:200}},
      {id:'pi_3',status:'requires_payment_method',amount_received:0,currency:'usd',created:1699200000,latest_charge:null}
    ]}};
  });
  const payments=await createStripe({config,fetchImpl}).listRecentPayments({customerId:'cus_1'});
  assert.equal(payments.length,2,'only succeeded intents');
  assert.equal(payments[0].id,'pi_2','newest first');
  assert.equal(payments[0].refundable,false,'fully refunded already');
  assert.equal(payments[1].refundable,true);assert.equal(payments[1].amountRefundedCents,0);assert.equal(payments[1].chargeId,'ch_1');
});

test('stripe.getPayment expands latest_charge for one intent',async()=>{
  const config=loadConfig({env:{STRIPE_SECRET_KEY:'sk_test_fake'},loadFile:false});
  const {fetchImpl}=fakeStripeFetch(({path,query})=>{
    assert.equal(path,'/v1/payment_intents/pi_1');assert.equal(query['expand[]'],'latest_charge');
    return {status:200,body:{id:'pi_1',status:'succeeded',amount_received:485,currency:'usd',created:1699000000,latest_charge:{id:'ch_1',amount_refunded:0}}};
  });
  const payment=await createStripe({config,fetchImpl}).getPayment({id:'pi_1'});
  assert.equal(payment.id,'pi_1');assert.equal(payment.refundable,true);
});

test('stripe.createRefund throws CONFIG before any request when unconfigured or live without STRIPE_ALLOW_LIVE',async()=>{
  const unwired=async()=>{throw new Error('must not be called');};
  const none=createStripe({config:loadConfig({env:{},loadFile:false}),fetchImpl:unwired});
  await assert.rejects(none.createRefund({paymentIntentId:'pi_1'}),error=>{assert.equal(error.code,'CONFIG');return true;});
  const live=createStripe({config:loadConfig({env:{STRIPE_SECRET_KEY:'sk_live_fake'},loadFile:false}),fetchImpl:unwired});
  await assert.rejects(live.createRefund({paymentIntentId:'pi_1'}),error=>{assert.equal(error.code,'CONFIG');assert.match(error.message,/STRIPE_ALLOW_LIVE/);return true;});
});

test('stripe.createRefund proceeds once STRIPE_ALLOW_LIVE=1 is set for a live key',async()=>{
  const config=loadConfig({env:{STRIPE_SECRET_KEY:'sk_live_fake',STRIPE_ALLOW_LIVE:'1'},loadFile:false});
  const {fetchImpl}=fakeStripeFetch(()=>({status:200,body:{id:'re_1',status:'succeeded',amount:485,currency:'usd',created:1699000000,payment_intent:'pi_1',charge:'ch_1'}}));
  const refund=await createStripe({config,fetchImpl}).createRefund({paymentIntentId:'pi_1',amountCents:485,idempotencyKey:'idem-1'});
  assert.equal(refund.id,'re_1');
});

test('stripe.createRefund posts amount and metadata as form fields and carries Idempotency-Key, never leaking the secret beyond Authorization',async()=>{
  const config=loadConfig({env:{STRIPE_SECRET_KEY:'sk_test_fake'},loadFile:false});
  const {fetchImpl}=fakeStripeFetch(({path,method,body,headers})=>{
    assert.equal(path,'/v1/refunds');assert.equal(method,'POST');
    assert.equal(body.payment_intent,'pi_1');assert.equal(body.amount,'485');
    assert.equal(body['metadata[sidelook_run]'],'run_1');assert.equal(body['metadata[sidelook_effect]'],'fx_1');
    assert.equal(headers['Idempotency-Key'],'idem-1');
    assert.deepEqual(Object.keys(headers).sort(),['Authorization','Content-Type','Idempotency-Key']);
    assert.ok(!JSON.stringify(body).includes('sk_test_fake'));
    return {status:200,body:{id:'re_1',status:'succeeded',amount:485,currency:'usd',created:1699000000,payment_intent:'pi_1',charge:'ch_1'}};
  });
  await createStripe({config,fetchImpl}).createRefund({paymentIntentId:'pi_1',amountCents:485,idempotencyKey:'idem-1',metadata:{sidelook_run:'run_1',sidelook_effect:'fx_1'}});
});

test('stripe.getRefund reads one refund by id',async()=>{
  const config=loadConfig({env:{STRIPE_SECRET_KEY:'sk_test_fake'},loadFile:false});
  const {fetchImpl}=fakeStripeFetch(({path})=>{
    assert.equal(path,'/v1/refunds/re_1');
    return {status:200,body:{id:'re_1',status:'succeeded',amount:485,currency:'usd',created:1699000000,payment_intent:'pi_1',charge:'ch_1'}};
  });
  const refund=await createStripe({config,fetchImpl}).getRefund({id:'re_1'});
  assert.equal(refund.status,'succeeded');
});

test('stripe.findRefunds lists by payment_intent and filters client-side by metadata (used for reconciliation)',async()=>{
  const config=loadConfig({env:{STRIPE_SECRET_KEY:'sk_test_fake'},loadFile:false});
  const {fetchImpl}=fakeStripeFetch(({path,query})=>{
    assert.equal(path,'/v1/refunds');assert.equal(query.payment_intent,'pi_1');assert.equal(query.limit,'20');
    return {status:200,body:{data:[
      {id:'re_1',status:'succeeded',amount:485,currency:'usd',created:1699000000,payment_intent:'pi_1',charge:'ch_1',metadata:{sidelook_effect:'fx_1'}},
      {id:'re_2',status:'succeeded',amount:100,currency:'usd',created:1699000001,payment_intent:'pi_1',charge:'ch_1',metadata:{sidelook_effect:'fx_2'}}
    ]}};
  });
  const stripe=createStripe({config,fetchImpl});
  assert.equal((await stripe.findRefunds({paymentIntentId:'pi_1'})).length,2);
  assert.deepEqual((await stripe.findRefunds({paymentIntentId:'pi_1',metadata:{sidelook_effect:'fx_1'}})).map(r=>r.id),['re_1']);
});

test('stripe.health reports the configured mode and the live cross-check Stripe itself reports',async()=>{
  const config=loadConfig({env:{STRIPE_SECRET_KEY:'sk_test_fake'},loadFile:false});
  const {fetchImpl}=fakeStripeFetch(({path})=>{assert.equal(path,'/v1/balance');return {status:200,body:{livemode:false}};});
  assert.deepEqual(await createStripe({config,fetchImpl}).health(),{mode:'test',livemode:false});
});

// ---------- HubSpot ----------

function fakeHubspotFetch(handler){
  const calls=[];
  const fetchImpl=async(url,init)=>{
    const u=new URL(url);
    const record={path:u.pathname,query:Object.fromEntries(u.searchParams),method:init.method,headers:{...init.headers},body:init.body?JSON.parse(init.body):null};
    calls.push(record);
    const result=await handler(record);
    return {ok:result.status<300,status:result.status,headers:{get:()=>null},text:async()=>JSON.stringify(result.body)};
  };
  return {fetchImpl,calls};
}

test('hubspot.findContact searches by email EQ with the requested properties',async()=>{
  const config=loadConfig({env:{HUBSPOT_ACCESS_TOKEN:'pat-fake'},loadFile:false});
  const {fetchImpl,calls}=fakeHubspotFetch(({path,method,body})=>{
    assert.equal(path,'/crm/v3/objects/contacts/search');assert.equal(method,'POST');
    assert.deepEqual(body.filterGroups,[{filters:[{propertyName:'email',operator:'EQ',value:'a@acme.com'}]}]);
    assert.deepEqual(body.properties,['email','firstname','lastname','hs_lead_status']);
    return {status:200,body:{results:[{id:'1',properties:{email:'a@acme.com',firstname:'Ann',lastname:'Acme',hs_lead_status:'UNQUALIFIED'}}]}};
  });
  const results=await createHubspot({config,fetchImpl}).findContact({email:'a@acme.com'});
  assert.deepEqual(results,[{id:'1',email:'a@acme.com',firstName:'Ann',lastName:'Acme',properties:{email:'a@acme.com',firstname:'Ann',lastname:'Acme',hs_lead_status:'UNQUALIFIED'}}]);
  assert.deepEqual(Object.keys(calls[0].headers).sort(),['Authorization','Content-Type']);
});

test('hubspot.findContact searches by CONTAINS_TOKEN *@domain when only a domain is given',async()=>{
  const config=loadConfig({env:{HUBSPOT_ACCESS_TOKEN:'pat-fake'},loadFile:false});
  const {fetchImpl}=fakeHubspotFetch(({body})=>{
    assert.deepEqual(body.filterGroups,[{filters:[{propertyName:'email',operator:'CONTAINS_TOKEN',value:'*@acme.com'}]}]);
    return {status:200,body:{results:[]}};
  });
  await createHubspot({config,fetchImpl}).findContact({domain:'acme.com'});
});

test('hubspot.findContact falls back to a free-text query for a name',async()=>{
  const config=loadConfig({env:{HUBSPOT_ACCESS_TOKEN:'pat-fake'},loadFile:false});
  const {fetchImpl}=fakeHubspotFetch(({body})=>{assert.equal(body.query,'Acme');assert.equal(body.filterGroups,undefined);return {status:200,body:{results:[]}};});
  await createHubspot({config,fetchImpl}).findContact({query:'Acme'});
});

test('hubspot.getContact reads with the requested, or default, properties',async()=>{
  const config=loadConfig({env:{HUBSPOT_ACCESS_TOKEN:'pat-fake'},loadFile:false});
  const {fetchImpl}=fakeHubspotFetch(({path,query})=>{
    assert.equal(path,'/crm/v3/objects/contacts/123');assert.equal(query.properties,'email,firstname,lastname,hs_lead_status');
    return {status:200,body:{id:'123',properties:{email:'a@acme.com',firstname:'Ann',lastname:'Acme',hs_lead_status:'UNQUALIFIED'}}};
  });
  const contact=await createHubspot({config,fetchImpl}).getContact({id:'123'});
  assert.equal(contact.email,'a@acme.com');
});

test('hubspot.updateContact PATCHes only the given properties',async()=>{
  const config=loadConfig({env:{HUBSPOT_ACCESS_TOKEN:'pat-fake'},loadFile:false});
  const {fetchImpl}=fakeHubspotFetch(({path,method,body})=>{
    assert.equal(path,'/crm/v3/objects/contacts/123');assert.equal(method,'PATCH');
    assert.deepEqual(body,{properties:{hs_lead_status:'CHURNED'}});
    return {status:200,body:{id:'123',properties:{hs_lead_status:'CHURNED',email:'a@acme.com'}}};
  });
  const updated=await createHubspot({config,fetchImpl}).updateContact({id:'123',properties:{hs_lead_status:'CHURNED'}});
  assert.equal(updated.properties.hs_lead_status,'CHURNED');
});

test('hubspot.health lists one contact to prove the token works',async()=>{
  const config=loadConfig({env:{HUBSPOT_ACCESS_TOKEN:'pat-fake'},loadFile:false});
  const {fetchImpl,calls}=fakeHubspotFetch(({path,query})=>{assert.equal(path,'/crm/v3/objects/contacts');assert.equal(query.limit,'1');return {status:200,body:{results:[]}};});
  await createHubspot({config,fetchImpl}).health();
  assert.equal(calls.length,1);
});

test('hubspot maps a 401 to AUTH without retrying',async()=>{
  const config=loadConfig({env:{HUBSPOT_ACCESS_TOKEN:'pat-bad'},loadFile:false});
  let calls=0;
  const fetchImpl=async()=>{calls++;return {ok:false,status:401,headers:{get:()=>null},text:async()=>JSON.stringify({message:'unauthorized'})};};
  await assert.rejects(createHubspot({config,fetchImpl}).getContact({id:'1'}),error=>{assert.equal(error.code,'AUTH');return true;});
  assert.equal(calls,1);
});

// ---------- Gmail ----------

function fakeGmailFetch(handler){
  const calls=[];
  const fetchImpl=async(url,init)=>{
    const record={url,method:init.method,headers:{...init.headers},body:init.body};
    calls.push(record);
    const result=await handler(record);
    return {ok:result.status<300,status:result.status,headers:{get:()=>null},text:async()=>JSON.stringify(result.body)};
  };
  return {fetchImpl,calls};
}
const gmailEnv={GMAIL_CLIENT_ID:'id',GMAIL_CLIENT_SECRET:'secret',GMAIL_REFRESH_TOKEN:'refresh',GMAIL_FROM:'agent@example.com'};

test('gmail.accessToken exchanges the refresh token, caches it, and re-exchanges inside the 60s expiry margin',async()=>{
  const config=loadConfig({env:gmailEnv,loadFile:false});
  let time=1_700_000_000_000;const now=()=>time;let exchanges=0;
  const {fetchImpl}=fakeGmailFetch(({url,body})=>{
    if(!url.endsWith('/token')) return {status:200,body:{}};
    exchanges++;
    const params=Object.fromEntries(new URLSearchParams(body));
    assert.equal(params.client_id,'id');assert.equal(params.client_secret,'secret');assert.equal(params.refresh_token,'refresh');assert.equal(params.grant_type,'refresh_token');
    return {status:200,body:{access_token:`token-${exchanges}`,expires_in:3600}};
  });
  const gmail=createGmail({config,fetchImpl,now});
  assert.equal(await gmail.accessToken(),'token-1');assert.equal(exchanges,1);
  assert.equal(await gmail.accessToken(),'token-1','cached, no second exchange yet');assert.equal(exchanges,1);
  time+=3600*1000-59000; // inside the 60s-before-expiry margin
  assert.equal(await gmail.accessToken(),'token-2','re-exchanged once inside the expiry margin');assert.equal(exchanges,2);
});

test('gmail.accessToken reports AUTH, not INVALID, when Google refuses a bad refresh token',async()=>{
  const config=loadConfig({env:gmailEnv,loadFile:false});
  const {fetchImpl}=fakeGmailFetch(()=>({status:400,body:{error:'invalid_grant'}}));
  await assert.rejects(createGmail({config,fetchImpl}).accessToken(),error=>{assert.equal(error.code,'AUTH');return true;});
});

test("gmail.composeRaw builds RFC 822 headers in order, keeps the caller's exact Message-ID, and returns base64url",()=>{
  const config=loadConfig({env:gmailEnv,loadFile:false});
  const gmail=createGmail({config,fetchImpl:async()=>{throw new Error('no network expected');},now:()=>1_700_000_000_000});
  const raw=gmail.composeRaw({to:'customer@acme.com',subject:'Your refund',body:'It is done.',messageId:'<sidelook-run_1-1@sidelook.local>'});
  assert.match(raw,/^[A-Za-z0-9_-]+$/,'base64url has no +, / or = padding');
  const decoded=Buffer.from(raw.replace(/-/g,'+').replace(/_/g,'/'),'base64').toString('utf8');
  const lines=decoded.split('\r\n');
  assert.equal(lines[0],'From: agent@example.com');
  assert.equal(lines[1],'To: customer@acme.com');
  assert.equal(lines[2],'Subject: Your refund');
  assert.match(lines[3],/^Date: /);
  assert.equal(lines[4],'Message-ID: <sidelook-run_1-1@sidelook.local>');
  assert.equal(lines[5],'MIME-Version: 1.0');
  assert.equal(lines[6],'Content-Type: text/plain; charset=utf-8');
  assert.equal(lines[7],'');
  assert.equal(lines[8],'It is done.');
});

test('gmail.send posts the raw message and returns the provider ids',async()=>{
  const config=loadConfig({env:gmailEnv,loadFile:false});
  const {fetchImpl}=fakeGmailFetch(({url,body,headers})=>{
    if(url.endsWith('/token')) return {status:200,body:{access_token:'tok',expires_in:3600}};
    assert.ok(url.endsWith('/messages/send'));
    assert.equal(headers.Authorization,'Bearer tok');
    assert.deepEqual(JSON.parse(body),{raw:'rawpayload'});
    return {status:200,body:{id:'msg_1',threadId:'thread_1',labelIds:['SENT']}};
  });
  const result=await createGmail({config,fetchImpl}).send({raw:'rawpayload'});
  assert.deepEqual(result,{id:'msg_1',threadId:'thread_1',labelIds:['SENT']});
});

test('gmail.getMessage reads the message by the id the send returned, and a 404 reads as not found',async()=>{
  const config=loadConfig({env:gmailEnv,loadFile:false});
  const {fetchImpl}=fakeGmailFetch(({url})=>{
    if(url.endsWith('/token')) return {status:200,body:{access_token:'tok',expires_in:3600}};
    if(url.includes('/messages/msg_1?format=metadata')) return {status:200,body:{id:'msg_1',threadId:'thread_1',labelIds:['SENT']}};
    return {status:404,body:{error:{message:'Requested entity was not found.'}}};
  });
  const gmail=createGmail({config,fetchImpl});
  assert.deepEqual(await gmail.getMessage({id:'msg_1'}),{found:true,id:'msg_1',threadId:'thread_1',labelIds:['SENT']});
  assert.deepEqual(await gmail.getMessage({id:'msg_gone'}),{found:false,id:'',threadId:'',labelIds:[]});
});

test('gmail.findByMessageId searches rfc822msgid OR the quoted reference, then reads the first match',async()=>{
  const config=loadConfig({env:gmailEnv,loadFile:false});
  const {fetchImpl}=fakeGmailFetch(({url})=>{
    if(url.endsWith('/token')) return {status:200,body:{access_token:'tok',expires_in:3600}};
    if(url.includes('/messages?q=')){
      assert.ok(url.includes(encodeURIComponent('rfc822msgid:sidelook-run_1-1@sidelook.local OR "SL0123456789AB"')),url);
      return {status:200,body:{messages:[{id:'msg_1'}]}};
    }
    return {status:200,body:{id:'msg_1',threadId:'thread_1',labelIds:['SENT']}};
  });
  const result=await createGmail({config,fetchImpl}).findByMessageId({messageId:'<sidelook-run_1-1@sidelook.local>',reference:'SL0123456789AB'});
  assert.deepEqual(result,{found:true,id:'msg_1',threadId:'thread_1',labelIds:['SENT']});
});

test('gmail.findByMessageId searches rfc822msgid without angle brackets, then reads the first match',async()=>{
  const config=loadConfig({env:gmailEnv,loadFile:false});
  const {fetchImpl}=fakeGmailFetch(({url})=>{
    if(url.endsWith('/token')) return {status:200,body:{access_token:'tok',expires_in:3600}};
    if(url.includes('/messages?q=')){
      assert.ok(url.includes(encodeURIComponent('rfc822msgid:sidelook-run_1-1@sidelook.local')));
      return {status:200,body:{messages:[{id:'msg_1'}]}};
    }
    assert.ok(url.includes('/messages/msg_1'));
    return {status:200,body:{id:'msg_1',threadId:'thread_1',labelIds:['SENT']}};
  });
  const result=await createGmail({config,fetchImpl}).findByMessageId({messageId:'<sidelook-run_1-1@sidelook.local>'});
  assert.deepEqual(result,{found:true,id:'msg_1',threadId:'thread_1',labelIds:['SENT']});
});

test('gmail.findByMessageId reports not found without a second metadata call',async()=>{
  const config=loadConfig({env:gmailEnv,loadFile:false});
  const {fetchImpl,calls}=fakeGmailFetch(({url})=>{
    if(url.endsWith('/token')) return {status:200,body:{access_token:'tok',expires_in:3600}};
    return {status:200,body:{messages:[]}};
  });
  const result=await createGmail({config,fetchImpl}).findByMessageId({messageId:'nope@sidelook.local'});
  assert.deepEqual(result,{found:false,id:'',threadId:'',labelIds:[]});
  assert.equal(calls.filter(c=>c.url.includes('/messages/msg')).length,0);
});

test('gmail.health reads the authenticated address',async()=>{
  const config=loadConfig({env:gmailEnv,loadFile:false});
  const {fetchImpl}=fakeGmailFetch(({url})=>{
    if(url.endsWith('/token')) return {status:200,body:{access_token:'tok',expires_in:3600}};
    assert.ok(url.endsWith('/profile'));
    return {status:200,body:{emailAddress:'agent@example.com'}};
  });
  assert.deepEqual(await createGmail({config,fetchImpl}).health(),{address:'agent@example.com'});
});
