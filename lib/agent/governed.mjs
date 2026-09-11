// The DashClaw seam: every consequential write in Agent mode passes through here on its way to a provider.
// Wraps the official `dashclaw` npm SDK; nothing else in the codebase talks to DashClaw directly.
// Contract: docs/AGENT_MODE_IMPLEMENTATION.md section 8.
//
// ctx shape expected by record()/check(): { actionType, declaredGoal, riskScore, confidence, systemsTouched, target,
//   act, sessionId, runId, content, sourceOfTruth } — effects.mjs (Track D) builds this from the run and the effect.
import {DashClaw, ExecutionClaimError, GuardBlockedError, scrubAct} from 'dashclaw';

export class GovernanceUnavailable extends Error {
  constructor(message,detail){super(message);this.code='GOVERNANCE_UNAVAILABLE';this.detail=detail;}
}
export class ClaimRefused extends Error {
  constructor(message,detail){super(message);this.code='CLAIM_REFUSED';this.detail=detail;}
}
export class ClaimUncertain extends Error {
  constructor(message,detail){super(message);this.code='CLAIM_UNCERTAIN';this.detail=detail;}
}

// A policy block arrives two ways: the SDK turns a 403 whose verdict reads block into GuardBlockedError (its .decision is the
// GuardResult), and any other 403 with the block body keeps the whole body on .decision. Anything else is a real transport failure.
const isBlocked=error=>error instanceof GuardBlockedError || (error?.status===403 && error?.decision?.error==='Action blocked by policy');
const actionOf=body=>body?.action || null;
// The GuardResult the server returns: `decision` is the verdict string; a non_fabrication array rides inside it when a policy ran.
const guardOf=data=>(data && typeof data.decision==='object' && data.decision)?data.decision:(data && typeof data.decision==='string')?data:{};

export function createGoverned({config,DashClawClass=DashClaw,fetchImpl=fetch,now=Date.now,log}={}){
  const dc=config?.dashclaw || {};
  const missingVar=()=>{
    if(!dc.baseUrl) return 'DASHCLAW_BASE_URL is not set.';
    if(!dc.apiKey) return 'DASHCLAW_API_KEY is not set.';
    if(!dc.agentId) return 'DASHCLAW_AGENT_ID is not set.';
    return 'DashClaw is not configured.';
  };
  const configured=Boolean(dc.baseUrl && dc.apiKey && dc.agentId);
  const clientOptions=key=>({baseUrl:dc.baseUrl,apiKey:key,agentId:dc.agentId,...(dc.agentName?{agentName:dc.agentName}:{})});
  const agentClient=configured?new DashClawClass(clientOptions(dc.apiKey)):null;
  const approverClient=configured?new DashClawClass(clientOptions(dc.approverApiKey || dc.apiKey)):null;

  function ensureConfigured(){if(!configured) throw new GovernanceUnavailable('DashClaw is not configured.',missingVar());}
  // Any failure that is not a policy block (network down, timeout, 5xx) is governance unavailable — never a silent allow.
  function unavailable(operation,error){
    if(error instanceof GovernanceUnavailable) return error;
    const detail=error?.code==='ETIMEDOUT'?`DashClaw timed out during ${operation}.`
      :typeof error?.status==='number' && error.status>=500?`DashClaw returned ${error.status} during ${operation}.`
      :`DashClaw is unreachable during ${operation} (${error?.message || error}).`;
    return new GovernanceUnavailable(`Governance is unavailable during ${operation}.`,detail);
  }

  function mapBlocked(error){
    const body=error instanceof GuardBlockedError?{decision:error.decision}:(error.decision || {});
    const guard=guardOf(body);
    const action=actionOf(body);
    return {state:'blocked',actionId:action?.action_id ?? action?.id ?? null,decisionId:guard.decision_id ?? null,decision:guard.decision || 'block',
      reasons:guard.reasons?.length?guard.reasons:(guard.reason?[guard.reason]:[]),matchedPolicies:guard.matched_policies || [],
      riskScore:guard.risk_score ?? null,nonFabrication:guard.non_fabrication || body.non_fabrication || null,replay:false,actionStatus:action?.status || 'blocked'};
  }
  function mapReplay(data){
    const action=actionOf(data) || {};
    const state=action.status==='pending_approval'?'pending'
      :action.status==='running' && action.execution_claimed_at?'replayed_claimed'
      :action.status==='running'?'allowed'
      :['blocked','failed','cancelled','expired'].includes(action.status)?'blocked'
      :'allowed';
    return {state,actionId:data.action_id ?? action.id ?? null,decisionId:null,decision:null,reasons:[],matchedPolicies:[],
      riskScore:action.risk_score ?? null,nonFabrication:null,replay:true,actionStatus:action.status ?? null};
  }
  function mapAllowed(data){
    const guard=guardOf(data);
    const action=actionOf(data) || {};
    // The persisted row is the authority on approval (the server re-evaluates at write time), the guard result carries the why.
    const pending=action.status==='pending_approval' || guard.decision==='require_approval';
    return {state:pending?'pending':'allowed',actionId:data.action_id ?? action.action_id ?? action.id ?? null,
      decisionId:guard.decision_id ?? null,decision:guard.decision ?? null,reasons:guard.reasons?.length?guard.reasons:(guard.reason?[guard.reason]:[]),matchedPolicies:guard.matched_policies || [],
      riskScore:guard.risk_score ?? action.risk_score ?? null,nonFabrication:guard.non_fabrication || data.non_fabrication || null,replay:false,actionStatus:action.status ?? null};
  }

  function buildAction(effect,ctx){
    return {
      action_type:ctx.actionType,declared_goal:ctx.declaredGoal,risk_score:ctx.riskScore,confidence:ctx.confidence,
      reversible:false,systems_touched:ctx.systemsTouched || [],target:ctx.target,act:ctx.act,
      idempotency_key:effect.idempotencyKey,approval_wait_seconds:900,client_capabilities:['execution_claims'],
      session_id:ctx.sessionId,metadata:{run_id:ctx.runId,effect_id:effect.effectId,tool:effect.tool,op_key:effect.opKey},
      ...(ctx.content!==undefined?{content:ctx.content}:{}),...(ctx.sourceOfTruth!==undefined?{source_of_truth:ctx.sourceOfTruth}:{})
    };
  }

  let policyCache=null;
  return {
    // The org's active policy names, cached briefly: the engine refuses a refund when the row that holds refunds for a person is missing.
    async policyNames(){
      ensureConfigured();
      if(policyCache && now()-policyCache.at<60000) return policyCache.names;
      const res=await fetchImpl(`${dc.baseUrl.replace(/\/$/,'')}/api/policies`,{headers:{'x-api-key':dc.apiKey}});
      if(!res.ok) throw new GovernanceUnavailable('DashClaw could not list its policies.',`GET /api/policies returned ${res.status}.`);
      const body=await res.json().catch(()=>({}));
      const names=(body.policies || []).filter(r=>r.active===1 || r.active===true).map(r=>String(r.name));
      policyCache={at:now(),names};
      return names;
    },
    async health(){
      if(!configured) return {configured:false,baseUrl:dc.baseUrl || null,agent:dc.agentId || null,approverRole:'unknown',policies:[],nonFabrication:false,version:null};
      const result={configured:true,baseUrl:dc.baseUrl,agent:dc.agentId,approverRole:'unknown',policies:[],nonFabrication:false,version:null};
      const base=dc.baseUrl.replace(/\/$/,'');
      try{
        const res=await fetchImpl(`${base}/api/health`,{headers:{'x-api-key':dc.apiKey}});
        if(res.ok){const body=await res.json().catch(()=>({}));result.version=body.version || null;}
      }catch(error){log?.('governed.health: liveness probe failed',error);} // reported via configured/ready upstream, not thrown here
      try{
        const res=await fetchImpl(`${base}/api/policies`,{method:'POST',headers:{'x-api-key':dc.approverApiKey || dc.apiKey,'Content-Type':'application/json'},body:'{}'});
        result.approverRole=res.status===400?'admin':res.status===403?'member':'unknown';
      }catch(error){log?.('governed.health: approver-role probe failed',error);}
      try{
        const res=await fetchImpl(`${base}/api/policies`,{headers:{'x-api-key':dc.apiKey}});
        if(res.ok){
          const body=await res.json().catch(()=>({}));
          const rows=body.policies || [];
          result.policies=rows.map(r=>r.name);
          // The server stores active as 0/1; only a row that is on counts (an inactive Non-Fabrication row exists on real orgs).
          result.nonFabrication=rows.some(r=>r.policy_type==='non_fabrication' && (r.active===1 || r.active===true));
        }
      }catch(error){log?.('governed.health: policy list failed',error);}
      return result;
    },

    async session(runId,goal){
      if(!configured) return null;
      try{
        const data=await agentClient.createSession(dc.agentId,`run:${runId}`);
        return data?.session?.session_id ?? null;
      }catch(error){log?.('governed.session: non-fatal, continuing without a session id',error);return null;} // failure is non-fatal per contract
    },

    async record(effect,ctx){
      ensureConfigured();
      let data;
      try{data=await agentClient.createAction(buildAction(effect,ctx));}
      catch(error){if(isBlocked(error)) return mapBlocked(error);throw unavailable('record',error);}
      return data.idempotent_replay?mapReplay(data):mapAllowed(data);
    },

    async check(ctx){
      ensureConfigured();
      const context={action_type:ctx.actionType,declared_goal:ctx.declaredGoal,risk_score:ctx.riskScore,act:ctx.act,
        ...(ctx.content!==undefined?{content:ctx.content}:{}),...(ctx.sourceOfTruth!==undefined?{source_of_truth:ctx.sourceOfTruth}:{})};
      let data;
      try{data=await agentClient.guard(context,{record:false});}
      catch(error){if(isBlocked(error)){const mapped=mapBlocked(error);return {decision:'block',reasons:mapped.reasons,matchedPolicies:mapped.matchedPolicies,nonFabrication:mapped.nonFabrication};}throw unavailable('check',error);}
      const guard=guardOf(data);
      return {decision:guard.decision ?? null,reasons:guard.reasons?.length?guard.reasons:(guard.reason?[guard.reason]:[]),matchedPolicies:guard.matched_policies || [],nonFabrication:guard.non_fabrication || null};
    },

    async approve(actionId,reason){return decide(approverClient,'allow',actionId,reason);},
    async reject(actionId,reason){return decide(approverClient,'deny',actionId,reason);},

    async poll(actionId){
      ensureConfigured();
      let data;
      try{data=await agentClient.getAction(actionId);}
      catch(error){throw unavailable('poll',error);}
      const action=actionOf(data) || {};
      return {status:action.status ?? null,approvedBy:action.approved_by ?? null,approvedAt:action.approved_at ?? null,
        expired:action.status==='expired',claimed:Boolean(action.execution_attempt_id),attemptId:action.execution_attempt_id ?? null,
        outcomeStatus:action.outcome?.status ?? null};
    },

    async claim(actionId,act){
      ensureConfigured();
      let response;
      try{response=await agentClient.claimExecution(actionId,act);}
      catch(error){
        if(!(error instanceof ExecutionClaimError)) throw unavailable('claim',error);
        let read;
        try{read=await agentClient.getAction(actionId);}
        catch(readError){throw new ClaimUncertain('Could not confirm the execution claim after the server did not answer.',{actionId,cause:readError});}
        const action=actionOf(read) || {};
        if(action.execution_attempt_id && action.execution_attempt_id===error.attemptId) return {attemptId:error.attemptId,claimedAt:action.execution_claimed_at ?? new Date(now()).toISOString()};
        throw new ClaimRefused(error.message || 'The execution claim was refused.',{actionId,action});
      }
      return {attemptId:response.attempt_id,claimedAt:new Date(now()).toISOString()};
    },

    async outcome(actionId,{status,summary,progress,error}={}){
      ensureConfigured();
      const payload={status,...(summary!==undefined?{summary}:{}),...(progress!==undefined?{progress}:{}),...(error!==undefined?{error_message:error}:{})};
      try{await agentClient.reportActionOutcome(actionId,payload);return {ok:true};}
      catch(err){
        if(err?.status===409) return {ok:false,code:err.decision?.code==='NOT_ALLOWED'?'NOT_ALLOWED':'ALREADY_SET',currentStatus:err.decision?.current_status ?? null};
        throw unavailable('outcome',err);
      }
    },

    async scan(text,source){
      if(!configured) return {clean:null,unavailable:true,detail:missingVar()};
      try{
        const data=await agentClient.scanPromptInjection(text,{source});
        return {clean:data.clean,riskLevel:data.risk_level,recommendation:data.recommendation,categories:data.categories || [],findingsCount:data.findings_count ?? (data.findings || []).length};
      }catch(error){return {clean:null,unavailable:true,detail:error?.message || String(error)};}
    },

    // `evidence` rides inside the act on purpose: DashClaw strips a non-fabrication policy's content and source paths from
    // the decision context it stores, and the execution claim re-evaluates the policies from that stored context plus the act
    // sent with the claim. With the paths pointing into the act (scripts/agent-setup-dashclaw.mjs), record and claim read the
    // same text, and the act hash binds the claim to that exact email. Seen live 2026-09-11: without this, every email send
    // was recorded `allow` and then refused at the claim with "source-of-truth missing or malformed (fail-closed)".
    actForHttp({method,url,body,evidence}){
      const act={kind:'http',request:{method:String(method || 'GET').toUpperCase(),url:String(url || '').slice(0,2048)}};
      if(body!==undefined && body!==null){
        const excerpt=typeof body==='string'?body:(()=>{try{return JSON.stringify(body);}catch{return String(body);}})();
        act.request.body_excerpt=excerpt.slice(0,2048);
      }
      if(evidence && typeof evidence==='object') act.evidence=evidence;
      return scrubAct(act);
    }
  };

  async function decide(client,decision,actionId,reason){
    ensureConfigured();
    try{await client.approveAction(actionId,decision,reason);return {ok:true};}
    catch(error){
      const code=error?.decision?.code;
      if(error?.status===403 && code==='SELF_APPROVAL_FORBIDDEN') return {ok:false,code:'SELF_APPROVAL',message:error.message};
      if(error?.status===403) return {ok:false,code:'FORBIDDEN',message:error.message};
      if(error?.status===410) return {ok:false,code:'EXPIRED',message:error.message};
      if(error?.status===409) return {ok:false,code:code==='NOT_PENDING'?'NOT_PENDING':'ALREADY_RESOLVED',message:error.message};
      throw unavailable('approve',error);
    }
  }
}
