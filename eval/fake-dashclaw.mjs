// A fake DashClaw server: just enough of the real HTTP surface for the official `dashclaw` SDK to drive it end to end,
// so lib/agent/governed.mjs can be tested without a live DashClaw instance. Contract: docs/AGENT_MODE_IMPLEMENTATION.md
// sections 8, 15, 16. The wire shapes here are this fake's own choice where the contract left room (e.g. the exact
// object under `decision`); governed.mjs is written against exactly what this file sends.
import {createServer} from 'node:http';
import {createHash, randomUUID} from 'node:crypto';

const DEFAULT_POLICY={holdUrlPatterns:[],approvalRiskThreshold:90,blockRiskThreshold:100,nonFabrication:true,allowedActionTypes:['api','email'],requireEvidence:true};
const ROLE_OVERRIDE=[/ignore previous instructions/i,/you are now/i,/system prompt/i,/disregard/i];
const WARN_PHRASES=[/reveal/i,/exfiltrate/i];
const MONTHS=['january','february','march','april','may','june','july','august','september','october','november','december'];

const now=()=>new Date().toISOString();
const hashAct=act=>createHash('sha256').update(JSON.stringify(act ?? null)).digest('hex');
const newId=prefix=>`${prefix}_${randomUUID().replace(/-/g,'').slice(0,20)}`;

function readBody(req){
  return new Promise((resolve,reject)=>{
    let data='';
    req.on('data',chunk=>{data+=chunk;if(data.length>1000000)req.destroy();});
    // A malformed or empty body reads as {}, same as an absent one: every route below validates the fields it needs.
    req.on('end',()=>{if(!data){resolve({});return;}try{resolve(JSON.parse(data));}catch{resolve({});}});
    req.on('error',reject);
  });
}
function send(res,status,body){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));}

// ---- non-fabrication verification: money needs a literal $ prefix, dates normalise to ISO, ids only via extract.patterns ----
function moneyValue(token){const m=/^\$([0-9][0-9,]*)(\.[0-9]{2})?$/.exec(String(token));if(!m)return null;return Number(m[1].replace(/,/g,'')+(m[2]||''));}
const extractMoney=text=>[...text.matchAll(/\$[0-9][0-9,]*(?:\.[0-9]{2})?/g)].map(m=>m[0]);
function normalizeDate(token){
  let m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(token));
  if(m) return `${m[1]}-${m[2]}-${m[3]}`;
  m=/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(token));
  if(m) return `${m[3]}-${String(m[1]).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`;
  m=/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/.exec(String(token));
  if(m){const mi=MONTHS.indexOf(m[1].toLowerCase());if(mi>=0)return `${m[3]}-${String(mi+1).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`;}
  return null;
}
function extractDates(text){
  const out=[];
  for(const re of [/\b\d{4}-\d{2}-\d{2}\b/g,/\b\d{1,2}\/\d{1,2}\/\d{4}\b/g,/\b[A-Za-z]+\s+\d{1,2},\s*\d{4}\b/g]) out.push(...[...text.matchAll(re)].map(m=>m[0]));
  return out;
}
// A missing or malformed source of truth blocks outright; otherwise every operational token in `content` must trace
// back to an allowed fact, verbatim for required facts and ids, numerically for money, normalised for dates.
function verifyNonFabrication(content,sourceOfTruth){
  if(!sourceOfTruth || typeof sourceOfTruth!=='object' || !Array.isArray(sourceOfTruth.allowedFacts)){
    return {policy_id:'non_fabrication',verdict:'block',violations:[{code:'MISSING_SOURCE',label:'source of truth',detail:'No source of truth was supplied for this content.'}],receipt:{at:now()}};
  }
  const violations=[];
  const allowed=sourceOfTruth.allowedFacts.map(f=>String(f.value));
  for(const fact of sourceOfTruth.requiredFacts || []) if(!content.includes(String(fact.value))) violations.push({code:'MISSING_REQUIRED_FACT',label:fact.label,detail:`"${fact.value}" was required but not found.`});
  for(const pattern of sourceOfTruth.forbiddenPatterns || []) if(new RegExp(pattern,'i').test(content)) violations.push({code:'FORBIDDEN_PATTERN',label:pattern,detail:'A forbidden phrase was found.'});
  const extract=sourceOfTruth.extract || {};
  if(extract.money) for(const token of extractMoney(content)) if(!allowed.some(a=>moneyValue(a)===moneyValue(token))) violations.push({code:'UNVERIFIED_MONEY',label:'money',detail:`${token} does not match a verified amount.`});
  if(extract.dates) for(const token of extractDates(content)){const iso=normalizeDate(token);if(!iso || !allowed.some(a=>normalizeDate(a)===iso)) violations.push({code:'UNVERIFIED_DATE',label:'date',detail:`${token} does not match a verified date.`});}
  for(const {pattern,label} of extract.patterns || []) for(const match of [...content.matchAll(new RegExp(pattern,'g'))].map(m=>m[0])) if(!allowed.includes(match)) violations.push({code:'UNVERIFIED_ID',label,detail:`${match} does not match a verified ${label}.`});
  return {policy_id:'non_fabrication',verdict:violations.length?'block':'pass',violations,receipt:{at:now()}};
}

// ---- risk and policy evaluation ----
function actRisk(act){
  if(!act || act.kind!=='http' || !act.request) return 0;
  const method=String(act.request.method || 'GET').toUpperCase();
  let host='';try{host=new URL(act.request.url).hostname;}catch{host='';} // an unparsable URL is treated as a non-local host, never as risk-free
  const local=host==='localhost' || host==='127.0.0.1';
  if(['POST','PATCH','PUT'].includes(method) && !local) return 45+(/stripe\.com|googleapis\.com/.test(host)?20:0);
  if(method==='GET') return 10;
  return 0;
}
function evaluate(context,policy){
  const reasons=[],matched=[];
  const actionType=context.action_type;
  const riskScore=Math.max(Number(context.risk_score) || 0,actRisk(context.act));
  const respond=(status,nonFabrication=null)=>({status,reasons,matched_policies:matched,risk_score:riskScore,nonFabrication});
  if(!policy.allowedActionTypes.includes(actionType)){reasons.push(`${actionType || 'unset'} is not an allowed action type.`);matched.push('role_constraint');return respond('block');}
  if(policy.requireEvidence && !context.act){reasons.push('No act evidence was attached to this action.');matched.push('require_evidence');return respond('block');}
  if(riskScore>=policy.blockRiskThreshold){reasons.push(`Risk score ${riskScore} is at or above the block threshold.`);matched.push('risk_threshold_block');return respond('block');}
  let nonFabrication=null;
  if(policy.nonFabrication && context.content){
    nonFabrication=verifyNonFabrication(context.content,context.source_of_truth);
    if(actionType==='email' && nonFabrication.verdict==='block'){reasons.push(...nonFabrication.violations.map(v=>v.detail));matched.push('non_fabrication');return respond('block',nonFabrication);}
  }
  const held=policy.holdUrlPatterns.some(p=>context.act?.request?.url && new RegExp(p).test(context.act.request.url));
  if(held || riskScore>=policy.approvalRiskThreshold){
    matched.push(held?'protected_path':'risk_threshold_hold');
    reasons.push(held?'This URL is protected and requires a human.':`Risk score ${riskScore} requires a human.`);
    return respond('require_approval',nonFabrication);
  }
  return respond('allow',nonFabrication);
}
// The real GuardResult: `decision` is the verdict string, `decision_id` names the guard_decisions row, and a non_fabrication array rides inside it.
let decisionSeq=0;
const decisionBody=d=>({decision:d.status,decision_id:d.decision_id || (d.decision_id=`act_gd_${String(++decisionSeq).padStart(6,'0')}`),reason:(d.reasons || [])[0] || null,reasons:d.reasons || [],matched_policies:d.matched_policies || [],risk_score:d.risk_score,...(d.nonFabrication?{non_fabrication:[d.nonFabrication]}:{})});

function normalizeKeys(input={}){
  const agent=input.agent || {},approver=input.approver || {};
  const entries=[
    {key:agent.key || 'sk_test_fake_agent',role:agent.role || 'member',principal:agent.principal || 'agent-principal'},
    {key:approver.key || 'sk_test_fake_approver',role:approver.role || 'admin',principal:approver.principal || 'approver-principal'}
  ];
  return {byKey:new Map(entries.map(e=>[e.key,e])),operatorKey:input.operatorKey || null};
}

export async function startFakeDashClaw({policy={},keys={}}={}){
  const cfg={...DEFAULT_POLICY,...policy};
  const {byKey,operatorKey}=normalizeKeys(keys);
  const state={actions:new Map(),claims:new Map(),outcomes:new Map(),approvals:new Map(),scans:[]};
  const idempotency=new Map();
  const faults={unavailable:false,pending:new Map(),failNext(route,opts){this.pending.set(route,opts);}};
  const resetFaults=()=>{faults.unavailable=false;faults.pending.clear();};
  const takeFault=route=>{const f=faults.pending.get(route);if(f)faults.pending.delete(route);return f;};
  const authenticate=req=>byKey.get(req.headers['x-api-key']) || null;
  const publicAction=row=>{const {principal,act_hash,wasPending,...rest}=row;return rest;};
  function maybeExpire(row){
    if(row.status==='pending_approval' && row.approval_expires_at && new Date(row.approval_expires_at).getTime()<=Date.now()){
      row.status='expired';row.error_message='Approval expired before a decision was made.';row.updated_at=now();
    }
    return row;
  }

  // Shared by POST /api/actions and POST /api/guard?record=true: idempotency replay, evaluation, storage, response.
  async function recordAction(req,res,auth,body,faultRoute){
    if(!auth){send(res,401,{error:'Unauthorized'});return;}
    const key=body.idempotency_key;
    if(key && idempotency.has(key)){
      const existing=state.actions.get(idempotency.get(key));
      send(res,200,{action:publicAction(existing),action_id:existing.id,idempotent_replay:true});
      return;
    }
    const decision=evaluate(body,cfg);
    const id=newId('act'),nowIso=now();
    const waitSeconds=cfg.approvalWaitSecondsOverride ?? body.approval_wait_seconds ?? 900;
    const row={
      id,action_id:id,agent_id:body.agent_id || null,principal:auth.principal,
      action_type:body.action_type || null,declared_goal:body.declared_goal || '',risk_score:decision.risk_score,
      confidence:body.confidence ?? null,reversible:body.reversible===true,systems_touched:body.systems_touched || [],
      target:body.target || null,act:body.act || null,act_hash:hashAct(body.act),
      idempotency_key:key || null,approval_wait_seconds:waitSeconds,client_capabilities:body.client_capabilities || [],
      session_id:body.session_id || null,metadata:body.metadata || {},content:body.content,source_of_truth:body.source_of_truth,
      status:decision.status==='block'?'blocked':decision.status==='require_approval'?'pending_approval':'running',
      wasPending:decision.status==='require_approval',decision,non_fabrication:decision.nonFabrication?[decision.nonFabrication]:null,
      created_at:nowIso,updated_at:nowIso,
      approval_expires_at:decision.status==='require_approval'?new Date(Date.now()+waitSeconds*1000).toISOString():null,
      approved_by:null,approved_at:null,error_message:null,
      execution_attempt_id:null,execution_claimed_at:null,execution_agent_id:null,
      outcome:{status:'pending',summary:null,error_message:null,progress:null,outcome_at:null}
    };
    state.actions.set(id,row);
    if(key) idempotency.set(key,id);
    const fault=takeFault(faultRoute);
    if(fault?.status){send(res,fault.status,{error:'Injected fault'});return;}
    if(decision.status==='block'){
      if(fault?.drop){req.socket.destroy();return;}
      send(res,403,{error:'Action blocked by policy',action:publicAction(row),decision:decisionBody(decision)});
      return;
    }
    if(fault?.drop){req.socket.destroy();return;}
    send(res,decision.status==='require_approval'?202:201,{action:publicAction(row),action_id:id,decision:decisionBody(decision),...(row.non_fabrication?{non_fabrication:row.non_fabrication}:{}),security:{}});
  }

  async function guardRoute(req,res,auth,url){
    const body=await readBody(req);
    if(!auth){send(res,401,{error:'Unauthorized'});return;}
    if(url.searchParams.get('record')==='true'){await recordAction(req,res,auth,body,'createAction');return;}
    const decision=evaluate(body,cfg);
    send(res,200,decisionBody(decision));
  }

  async function approveAction(req,res,auth,id){
    const body=await readBody(req);
    if(!auth){send(res,401,{error:'Unauthorized'});return;}
    const row=state.actions.get(id);
    if(!row){send(res,404,{error:'Action not found'});return;}
    maybeExpire(row);
    if(auth.role!=='admin'){send(res,403,{error:'Admin access required',code:'FORBIDDEN'});return;}
    if(row.status==='expired'){send(res,410,{error:'Approval expired before a decision was made.',code:'APPROVAL_EXPIRED'});return;}
    if(row.status!=='pending_approval'){
      const code=row.wasPending?'ALREADY_RESOLVED':'NOT_PENDING';
      send(res,409,{error:code==='ALREADY_RESOLVED'?'Action was already resolved by another approver':'Action is not pending approval',code});
      return;
    }
    // Database keys never approve their own action; only the operator bootstrap key may.
    if(row.principal===auth.principal && auth.key!==operatorKey){send(res,403,{error:'Self-approval is not allowed for this key',code:'SELF_APPROVAL_FORBIDDEN'});return;}
    const fault=takeFault('approve');
    if(fault?.status){send(res,fault.status,{error:'Injected fault'});return;}
    if(body.decision==='deny'){row.status='failed';row.error_message=body.reasoning || 'Operator denied the action.';}
    else{row.status='running';row.approved_by=auth.principal;row.approved_at=now();}
    row.updated_at=now();
    state.approvals.set(id,{decision:body.decision,reasoning:body.reasoning || null,decidedBy:auth.principal,decidedAt:row.updated_at});
    if(fault?.drop){req.socket.destroy();return;}
    send(res,200,{action:publicAction(row)});
  }

  async function claimAction(req,res,auth,id){
    const body=await readBody(req);
    if(!auth){send(res,401,{error:'Unauthorized'});return;}
    const row=state.actions.get(id);
    if(!row){send(res,404,{error:'Action not found'});return;}
    if(body.claim_execution!==true){send(res,400,{error:'Unsupported PATCH payload'});return;}
    const fault=takeFault('claim');
    if(fault?.status){send(res,fault.status,{error:'Injected fault'});return;}
    const conflict=row.status!=='running' || row.execution_attempt_id || row.principal!==auth.principal
      || row.agent_id!==body.agent_id || row.act_hash!==hashAct(body.act) || !row.client_capabilities.includes('execution_claims');
    if(conflict){send(res,409,{error:'Execution already claimed or not eligible',code:'EXECUTION_CLAIM_CONFLICT'});return;}
    row.execution_attempt_id=body.attempt_id;row.execution_claimed_at=now();row.execution_agent_id=body.agent_id;row.updated_at=row.execution_claimed_at;
    state.claims.set(id,{attemptId:body.attempt_id,agentId:body.agent_id,claimedAt:row.execution_claimed_at});
    // A "drop" fault is applied only here, after the claim was recorded: the state change happened, the answer never arrived.
    if(fault?.drop){req.socket.destroy();return;}
    send(res,200,{claimed:true,action_id:id,attempt_id:body.attempt_id,claimed_at:row.execution_claimed_at});
  }

  async function outcomeAction(req,res,auth,id){
    const body=await readBody(req);
    if(!auth){send(res,401,{error:'Unauthorized'});return;}
    const row=state.actions.get(id);
    if(!row){send(res,404,{error:'Action not found'});return;}
    const fault=takeFault('outcome');
    if(fault?.status){send(res,fault.status,{error:'Injected fault'});return;}
    if(row.outcome.status!=='pending'){send(res,409,{error:'outcome already set',current_status:row.outcome.status});return;}
    if(['blocked','pending_approval','cancelled','failed'].includes(row.status)){send(res,409,{error:'Action is not in a reportable state',code:'NOT_ALLOWED',current_status:row.status});return;}
    if(!['completed','partial','failed'].includes(body.status)){send(res,400,{error:'status must be completed, partial or failed'});return;}
    if(body.status==='failed' && !body.error_message){send(res,400,{error:'error_message is required for a failed outcome'});return;}
    if(body.status==='partial' && !body.progress){send(res,400,{error:'progress is required for a partial outcome'});return;}
    row.outcome={status:body.status,summary:body.summary || null,error_message:body.error_message || null,progress:body.progress || null,outcome_at:now()};
    state.outcomes.set(id,row.outcome);
    if(fault?.drop){req.socket.destroy();return;}
    send(res,200,{outcome:row.outcome});
  }

  async function scanRoute(req,res,auth){
    const body=await readBody(req);
    if(!auth){send(res,401,{error:'Unauthorized'});return;}
    const text=String(body.text || '');
    let recommendation='allow',categories=[];
    if(ROLE_OVERRIDE.some(re=>re.test(text))){recommendation='block';categories=['role_override'];}
    else if(WARN_PHRASES.some(re=>re.test(text))){recommendation='warn';categories=['exfiltration'];}
    const findings=categories.length?[{category:categories[0],detail:'Matched a known injection phrase.'}]:[];
    const result={clean:recommendation==='allow',risk_level:recommendation==='block'?'high':recommendation==='warn'?'medium':'none',recommendation,findings_count:findings.length,critical_count:recommendation==='block'?1:0,categories,findings};
    state.scans.push({text,source:body.source,agentId:body.agent_id,result});
    send(res,200,result);
  }

  function policiesList(res){
    const rows=[];
    if(cfg.nonFabrication) rows.push({id:'pol_nf',name:'sidelook-agent: no fabricated email',policy_type:'non_fabrication',rules:JSON.stringify({action_types:['email'],on_violation:'block'}),active:true,agent_ids:[]});
    if(cfg.holdUrlPatterns.length) rows.push({id:'pol_hold',name:'sidelook-agent: refunds need a human',policy_type:'protected_path',rules:JSON.stringify({paths:cfg.holdUrlPatterns}),active:true,agent_ids:[]});
    rows.push({id:'pol_risk',name:'sidelook-agent: hold when the agent is unsure',policy_type:'risk_threshold',rules:JSON.stringify({threshold:cfg.approvalRiskThreshold,action:'require_approval'}),active:true,agent_ids:[]});
    send(res,200,{policies:rows});
  }
  async function policiesCreate(req,res,auth){
    const body=await readBody(req);
    if(!auth){send(res,401,{error:'Unauthorized'});return;}
    if(auth.role!=='admin'){send(res,403,{error:'Admin access required'});return;}
    if(!body || !body.name || !body.policy_type){send(res,400,{error:'name and policy_type are required'});return;}
    send(res,201,{policy:{id:newId('pol'),...body}});
  }

  async function sessionsCreate(req,res,auth){
    const body=await readBody(req);
    if(!auth){send(res,401,{error:'Unauthorized'});return;}
    const session={session_id:newId('sess'),agent_id:body.agent_id || auth.principal,workspace:body.workspace || null,branch:body.branch || null,status:'active',created_at:now()};
    send(res,201,{session});
  }

  async function handle(req,res){
    const url=new URL(req.url,'http://localhost');
    const {pathname}=url;
    const auth=authenticate(req);
    if(req.method==='GET' && pathname==='/api/health') return send(res,200,{ok:true,version:'fake-1.0.0'});
    if(req.method==='GET' && pathname==='/api/policies') return policiesList(res);
    if(req.method==='POST' && pathname==='/api/policies') return policiesCreate(req,res,auth);
    if(req.method==='POST' && pathname==='/api/guard') return guardRoute(req,res,auth,url);
    if(req.method==='POST' && pathname==='/api/actions') return recordAction(req,res,auth,await readBody(req),'createAction');
    if(req.method==='POST' && pathname==='/api/sessions') return sessionsCreate(req,res,auth);
    if(req.method==='POST' && pathname==='/api/security/prompt-injection') return scanRoute(req,res,auth);
    let m=/^\/api\/actions\/([^/]+)\/approve$/.exec(pathname);
    if(m && req.method==='POST') return approveAction(req,res,auth,m[1]);
    m=/^\/api\/actions\/([^/]+)\/outcome$/.exec(pathname);
    if(m){
      if(req.method==='POST') return outcomeAction(req,res,auth,m[1]);
      if(req.method==='GET'){
        const row=state.actions.get(m[1]);
        if(!row) return send(res,404,{error:'Action not found'});
        return send(res,200,{action_id:row.id,status:row.outcome.status,outcome_at:row.outcome.outcome_at,summary:row.outcome.summary,error_message:row.outcome.error_message,progress:row.outcome.progress,elapsed_ms:row.outcome.outcome_at?new Date(row.outcome.outcome_at).getTime()-new Date(row.created_at).getTime():null});
      }
    }
    m=/^\/api\/actions\/([^/]+)$/.exec(pathname);
    if(m){
      if(req.method==='GET'){
        const row=state.actions.get(m[1]);
        if(!row) return send(res,404,{error:'Action not found'});
        maybeExpire(row);
        return send(res,200,{action:publicAction(row),assumptions:[],guard_decision:row.decision?decisionBody(row.decision):null});
      }
      if(req.method==='PATCH') return claimAction(req,res,auth,m[1]);
    }
    send(res,404,{error:'Not found'});
  }

  const server=createServer((req,res)=>{
    if(faults.unavailable){req.socket.destroy();return;}
    handle(req,res).catch(error=>{
      // A bug in this fixture must not hang a test; answer 500 so the caller gets a definite, if unexpected, response.
      if(!res.headersSent) send(res,500,{error:'fake dashclaw internal error',detail:error.message});
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const {port}=server.address();
  return {baseUrl:`http://127.0.0.1:${port}`,close:()=>new Promise(resolve=>server.close(resolve)),state,faults,resetFaults};
}
