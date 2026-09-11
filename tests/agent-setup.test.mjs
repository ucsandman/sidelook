import test from 'node:test';
import assert from 'node:assert/strict';
import {installDashclawPolicies,SIDELOOK_POLICIES,verdictDrift} from '../scripts/agent-setup-dashclaw.mjs';
import {consentUrl,exchangeCode} from '../scripts/gmail-auth.mjs';

// A minimal Response-like object plus call recording, standing in for the DashClaw HTTP surface.
function fakeFetch({existing=[],postHandler,deleteHandler}={}){
  const calls={get:[],post:[],delete:[]};
  const fetchImpl=async(url,opts={})=>{
    const method=opts.method || 'GET';
    if(method==='GET'){calls.get.push(url);return {ok:true,status:200,json:async()=>({policies:existing}),text:async()=>JSON.stringify({policies:existing})};}
    if(method==='POST'){
      const body=JSON.parse(opts.body);calls.post.push(body);
      if(postHandler) return postHandler(body);
      return {ok:true,status:201,json:async()=>({policy:{...body,id:'gp_new'}}),text:async()=>''};
    }
    if(method==='DELETE'){
      calls.delete.push(url);
      if(deleteHandler) return deleteHandler(url);
      return {ok:true,status:200,json:async()=>({deleted:true}),text:async()=>''};
    }
    throw new Error(`fakeFetch: unexpected method ${method}`);
  };
  return {fetchImpl,calls};
}

async function withCapturedConsole(run){
  const logs=[];
  const originalLog=console.log,originalError=console.error;
  console.log=(...args)=>logs.push(args.map(String).join(' '));
  console.error=(...args)=>logs.push(args.map(String).join(' '));
  try{await run();}finally{console.log=originalLog;console.error=originalError;}
  return logs;
}

test('installs only the policies missing by name; bodies carry rules and agent_ids as JSON strings',async()=>{
  const existingNames=[SIDELOOK_POLICIES[0].name,SIDELOOK_POLICIES[2].name];
  // A present row carries the rules the server stored; the installer compares its verdict fields against what it would send.
  const existing=existingNames.map((name,i)=>{const policy=SIDELOOK_POLICIES.find(p=>p.name===name);return {id:`gp_existing_${i}`,name,policy_type:policy.policy_type,rules:JSON.stringify(policy.rules)};});
  const {fetchImpl,calls}=fakeFetch({existing});
  let result;
  await withCapturedConsole(async()=>{result=await installDashclawPolicies({baseUrl:'http://dashclaw.test',approverKey:'oc_live_faketestkey0000000000000',agentId:'sidelook-agent',fetchImpl});});
  assert.equal(result.ok,true);
  assert.equal(calls.get.length,1);
  assert.equal(calls.post.length,SIDELOOK_POLICIES.length-existingNames.length);
  for(const body of calls.post){
    assert.equal(typeof body.rules,'string');assert.doesNotThrow(()=>JSON.parse(body.rules));
    assert.equal(typeof body.agent_ids,'string');assert.deepEqual(JSON.parse(body.agent_ids),['sidelook-agent']);
    assert.equal(body.active,1);assert.equal(body.created_by,'sidelook-setup');
  }
  assert.equal(result.rows.filter(r=>r.status==='present').length,existingNames.length);
  assert.equal(result.rows.filter(r=>r.status==='created').length,SIDELOOK_POLICIES.length-existingNames.length);
});

test('a bare 409 counts as already present; a Short List 409 is a real failure',async()=>{
  const {fetchImpl:dupFetch}=fakeFetch({existing:[],postHandler:()=>({ok:false,status:409,json:async()=>({error:'A policy with that name already exists'}),text:async()=>'dup'})});
  let dupResult;
  await withCapturedConsole(async()=>{dupResult=await installDashclawPolicies({baseUrl:'http://x',approverKey:'k',fetchImpl:dupFetch});});
  assert.equal(dupResult.ok,true);
  assert.ok(dupResult.rows.every(r=>r.status==='present'));

  const {fetchImpl:fullFetch}=fakeFetch({existing:[],postHandler:()=>({ok:false,status:409,json:async()=>({error:'The Short List is full (10 of 10).',code:'SHORT_LIST_FULL'}),text:async()=>'full'})});
  let fullResult;
  await withCapturedConsole(async()=>{fullResult=await installDashclawPolicies({baseUrl:'http://x',approverKey:'k',fetchImpl:fullFetch});});
  assert.equal(fullResult.ok,false);
  assert.ok(fullResult.rows.every(r=>r.status.startsWith('failed') && r.status.includes('Short List')));
});

test('a 500 response fails the run through the return value',async()=>{
  const {fetchImpl}=fakeFetch({existing:[],postHandler:()=>({ok:false,status:500,json:async()=>({}),text:async()=>'internal error'})});
  let result;
  await withCapturedConsole(async()=>{result=await installDashclawPolicies({baseUrl:'http://x',approverKey:'k',fetchImpl});});
  assert.equal(result.ok,false);
  assert.ok(result.rows.every(r=>r.status.includes('500')));
});

test('--dry-run posts nothing',async()=>{
  const {fetchImpl,calls}=fakeFetch({existing:[]});
  let result;
  await withCapturedConsole(async()=>{result=await installDashclawPolicies({baseUrl:'http://x',approverKey:'k',fetchImpl,dryRun:true});});
  assert.equal(calls.post.length,0);
  assert.ok(result.rows.every(r=>r.status==='would-create'));
});

test('--remove deletes existing rows by name and leaves missing ones absent',async()=>{
  const existing=[{id:'gp_1',name:SIDELOOK_POLICIES[0].name},{id:'gp_2',name:SIDELOOK_POLICIES[1].name}];
  const {fetchImpl,calls}=fakeFetch({existing});
  let result;
  await withCapturedConsole(async()=>{result=await installDashclawPolicies({baseUrl:'http://x',approverKey:'k',fetchImpl,remove:true});});
  assert.equal(calls.delete.length,2);
  assert.ok(calls.delete.every(url=>/id=gp_(1|2)/.test(url)));
  assert.equal(result.rows.filter(r=>r.status==='removed').length,2);
  assert.equal(result.rows.filter(r=>r.status==='absent').length,SIDELOOK_POLICIES.length-2);
  assert.equal(result.ok,true);
});

test('missing base url or key fails without ever calling fetch',async()=>{
  let called=false;
  const fetchImpl=async()=>{called=true;return {ok:true,status:200,json:async()=>({policies:[]}),text:async()=>''};};
  let result;
  await withCapturedConsole(async()=>{result=await installDashclawPolicies({baseUrl:'',approverKey:'',fetchImpl});});
  assert.equal(result.ok,false);
  assert.equal(called,false);
});

test('never prints the approver key',async()=>{
  const fakeKey='oc_live_shouldneverappearinoutput00';
  const {fetchImpl}=fakeFetch({existing:[]});
  const logs=await withCapturedConsole(async()=>{
    await installDashclawPolicies({baseUrl:'http://x',approverKey:fakeKey,fetchImpl,dryRun:true});
    await installDashclawPolicies({baseUrl:'http://x',approverKey:fakeKey,fetchImpl});
  });
  assert.ok(logs.length>0);
  assert.ok(logs.every(line=>!line.includes(fakeKey)));
});

test('consentUrl carries the exact scopes, loopback redirect and offline consent params',()=>{
  const url=consentUrl({clientId:'client-123',port:54321});
  const parsed=new URL(url);
  assert.equal(parsed.origin+parsed.pathname,'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(parsed.searchParams.get('client_id'),'client-123');
  assert.equal(parsed.searchParams.get('redirect_uri'),'http://127.0.0.1:54321/callback');
  assert.equal(parsed.searchParams.get('response_type'),'code');
  assert.equal(parsed.searchParams.get('scope'),'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly');
  assert.equal(parsed.searchParams.get('access_type'),'offline');
  assert.equal(parsed.searchParams.get('prompt'),'consent');
});

test('exchangeCode trades the code for a refresh token, with an injectable fetch',async()=>{
  let capturedBody,capturedUrl;
  const fetchImpl=async(url,opts)=>{capturedUrl=url;capturedBody=opts.body;return {ok:true,json:async()=>({refresh_token:'rt_fake_000',access_token:'at_fake',expires_in:3600})};};
  const result=await exchangeCode({code:'auth-code-1',clientId:'client-123',clientSecret:'secret-123',port:54321,fetchImpl});
  assert.equal(capturedUrl,'https://oauth2.googleapis.com/token');
  assert.equal(result.refreshToken,'rt_fake_000');
  const params=new URLSearchParams(capturedBody);
  assert.equal(params.get('code'),'auth-code-1');
  assert.equal(params.get('client_id'),'client-123');
  assert.equal(params.get('client_secret'),'secret-123');
  assert.equal(params.get('redirect_uri'),'http://127.0.0.1:54321/callback');
  assert.equal(params.get('grant_type'),'authorization_code');
});

test('exchangeCode names the Google error and never invents a refresh token',async()=>{
  const fetchImpl=async()=>({ok:false,status:400,json:async()=>({error:'invalid_grant',error_description:'Malformed auth code.'})});
  await assert.rejects(exchangeCode({code:'bad',clientId:'c',clientSecret:'s',port:1,fetchImpl}),error=>{
    assert.equal(error.code,'GOOGLE_invalid_grant');
    assert.match(error.message,/Malformed auth code/);
    return true;
  });
});

test('the non-fabrication row reads its content and source from the act, which the execution claim re-supplies',()=>{
  // Live, 2026-09-11: with top-level content paths DashClaw stripped them from the stored context and refused every email claim.
  const row=SIDELOOK_POLICIES.find(p=>p.policy_type==='non_fabrication');
  assert.equal(row.rules.content_path,'act.evidence.content');
  assert.equal(row.rules.source_path,'act.evidence.source_of_truth');
  assert.equal(row.rules.short_list,true);
});

test('both holds are ungrantable, and a present hold stored without it is reported as drift',()=>{
  // Live, 2026-09-11: DashClaw's interruption budget demoted the refunds hold to warn and a refund ran with no card.
  for(const name of ['sidelook-agent: refunds need a human','sidelook-agent: hold when the agent is unsure']){
    const policy=SIDELOOK_POLICIES.find(p=>p.name===name);
    assert.equal(policy.rules.action,'require_approval');assert.equal(policy.rules.ungrantable,true,name);
    const {ungrantable,...stored}=policy.rules;
    assert.match(verdictDrift(policy,{policy_type:policy.policy_type,rules:JSON.stringify(stored)}),/ungrantable stored as \(none\), sent true/);
    assert.equal(verdictDrift(policy,{policy_type:policy.policy_type,rules:JSON.stringify(policy.rules)}),null);
  }
});

