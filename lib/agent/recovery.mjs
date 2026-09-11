// The recovery policy: one table, per failure class, of what the runtime may do about a fault. Pure. effects.mjs asks
// decideWrite before it touches a provider again; http.mjs asks decideRead for a read. Nothing in the engine decides a retry
// on its own. Contract: docs/AGENT_SELF_HEALING.md section 4.

export const RECOVERY_ACTIONS=Object.freeze(['retry','wait_then_retry','reconcile','refresh_read','resume','ask_user','wait','open_breaker','stop_partial','stop_uncertain','fail_closed','none']);
const MAX_WAIT_MS=30000;

// reads: whether a failed read may be tried again and how often. writes: what must happen before a write is tried again
// (nothing, a reconciliation read, a fresh precondition read), when it may be (only when the request never left, only when the
// provider proved it absent, never), how many attempts in all, the pauses between them, and how the effect ends when the
// attempts run out or the provider state stays unknown. breaker: which circuit a repeat of this class trips. user: what the
// person is told. The literal rows below are also the regression corpus's edit targets; keep each on one line.
export const RECOVERY_POLICY=Object.freeze({
  transient_provider:{reads:{retry:true,maxAttempts:3},writes:{beforeRetry:'none',retryWhen:'presend_only',maxAttempts:3,backoffMs:[0,1000,3000]},breaker:'integration',user:'none'},
  rate_limit:{reads:{retry:true,maxAttempts:3,honourRetryAfter:true},writes:{beforeRetry:'reconcile',retryWhen:'absent',maxAttempts:3,backoffMs:[0,1000,3000],honourRetryAfter:true,onUnknown:'stop_uncertain'},breaker:'integration',user:'none'},
  authentication_expired:{reads:{retry:false},writes:{beforeRetry:'none',retryWhen:'never',onExhausted:'fail_closed'},breaker:'integration',user:'notify'},
  timeout_before_request:{reads:{retry:true,maxAttempts:3},writes:{beforeRetry:'none',retryWhen:'presend_only',maxAttempts:3,backoffMs:[0,1000,3000]},breaker:'integration',user:'none'},
  timeout_during_request:{reads:{retry:true,maxAttempts:3},writes:{beforeRetry:'reconcile',retryWhen:'absent',maxAttempts:3,backoffMs:[0,1000,3000],onUnknown:'stop_uncertain'},breaker:'integration',user:'none'},
  response_lost:{reads:{retry:true,maxAttempts:3},writes:{beforeRetry:'reconcile',retryWhen:'absent',maxAttempts:3,backoffMs:[0,1000,3000],onUnknown:'stop_uncertain'},breaker:'integration',user:'none'},
  provider_state_conflict:{reads:{retry:true,maxAttempts:2},writes:{beforeRetry:'reconcile',retryWhen:'absent',maxAttempts:2,backoffMs:[0,2000],onUnknown:'stop_uncertain'},breaker:null,user:'none'},
  stale_entity_state:{reads:{retry:false},writes:{beforeRetry:'refresh_read',retryWhen:'never',onExhausted:'stop_partial'},breaker:null,user:'none'},
  ambiguous_identity:{reads:{retry:false},writes:{beforeRetry:'none',retryWhen:'never',onExhausted:'ask_user'},breaker:null,user:'ask'},
  malformed_model_output:{model:{reprompt:true,maxConsecutive:2},breaker:'model',user:'none'},
  unsupported_tool_request:{model:{reprompt:true,maxConsecutive:2},breaker:'model',user:'none'},
  dashclaw_unavailable:{writes:{beforeRetry:'none',retryWhen:'never',onExhausted:'fail_closed'},breaker:'dashclaw',user:'notify'},
  dashclaw_block:{writes:{beforeRetry:'none',retryWhen:'never',onExhausted:'stop_partial'},breaker:null,user:'none'},
  approval_denied:{writes:{beforeRetry:'none',retryWhen:'never',onExhausted:'stop_partial'},breaker:null,user:'none'},
  approval_expired:{writes:{beforeRetry:'none',retryWhen:'never',onExhausted:'stop_partial'},breaker:null,user:'none'},
  verification_mismatch:{writes:{beforeRetry:'refresh_read',retryWhen:'never',refreshReads:2,refreshGapMs:2000,onExhausted:'stop_partial'},breaker:null,user:'none'},
  duplicate_effect_detected:{writes:{beforeRetry:'none',retryWhen:'never',onExhausted:'stop_uncertain'},breaker:null,user:'notify'},
  renderer_interruption:{none:true},
  local_process_interruption:{resume:true},
  user_cancellation:{writes:{beforeRetry:'none',retryWhen:'never',onExhausted:'stop_uncertain'},none:true},
  unknown_external_state:{writes:{beforeRetry:'none',retryWhen:'never',onExhausted:'stop_uncertain'},breaker:null,user:'notify'},
  model_transport_failure:{model:{reprompt:true,maxConsecutive:2},breaker:'model',user:'none'},
  // A runtime precondition or a CONFIG refusal never sends anything; on a write it ends the effect closed, no retry.
  precondition_refused:{writes:{beforeRetry:'none',retryWhen:'never',onExhausted:'fail_closed'},none:true}
});

export function policyFor(failureClass){
  const row=RECOVERY_POLICY[failureClass];
  if(!row) throw new Error(`No recovery policy for failure class "${failureClass}".`);
  return row;
}

const decision=(action,waitMs,reason)=>({action,waitMs:Math.max(0,waitMs || 0),reason});
// The pause before the next attempt: the table's backoff for this attempt, or the provider's own Retry-After when the class
// honours it and it is longer. A Retry-After past the cap is not waited out inside a run; the effect ends by policy instead.
function pause(writes,attempt,retryAfterMs){
  const backoff=(writes.backoffMs || [])[attempt] ?? (writes.backoffMs || []).at(-1) ?? 0;
  const after=writes.honourRetryAfter && Number.isFinite(retryAfterMs)?retryAfterMs:0;
  return {waitMs:Math.max(backoff,after),tooLong:after>MAX_WAIT_MS};
}
function next(writes,attempt,retryAfterMs,why){
  const exhausted=writes.onExhausted || 'stop_partial';
  const max=writes.maxAttempts ?? 1;
  if(attempt>=max) return decision(exhausted,0,`${why}; attempt ${attempt} of ${max} was the last allowed`);
  const {waitMs,tooLong}=pause(writes,attempt,retryAfterMs);
  if(tooLong) return decision(exhausted,0,`${why}; the provider asked for a ${Math.round(retryAfterMs/1000)} s wait, longer than a run waits`);
  return decision(waitMs>0?'wait_then_retry':'retry',waitMs,why);
}

// What a failed write does next. Called twice at most: once with no finding (right after the error) and once after the
// reconciliation or refresh read it asked for. `present` never reaches here: the engine continues from the provider's record.
export function decideWrite({failureClass,attempt=1,spec={},finding=null,retryAfterMs=null,cancelled=false}={}){
  if(cancelled) return decision('stop_uncertain',0,'stopped by the person; nothing is retried');
  const row=policyFor(failureClass);
  const writes=row.writes;
  if(!writes) return decision('stop_partial',0,`${failureClass} is not a write fault`);
  const exhausted=writes.onExhausted || 'stop_partial';
  if(finding===null){
    if(writes.beforeRetry==='reconcile') return decision('reconcile',0,'the request may have reached the provider; read it back before anything else');
    if(writes.beforeRetry==='refresh_read') return decision('refresh_read',0,'the entity may have changed; read the current state before deciding');
    if(writes.retryWhen==='presend_only') return next(writes,attempt,retryAfterMs,'the request never left this process');
    return decision(exhausted,0,`${failureClass} is never retried`);
  }
  if(finding==='present') return decision('none',0,'the provider already holds the write');
  if(finding==='unknown') return decision(writes.onUnknown || 'stop_uncertain',0,'the provider state could not be read');
  // absent
  if(spec.noBlindRetry) return decision(writes.onUnknown || 'stop_uncertain',0,'this provider cannot be asked reliably enough for an absent read to justify a second send');
  if(writes.retryWhen==='absent' || writes.retryWhen==='presend_only') return next(writes,attempt,retryAfterMs,'the provider holds no trace of the write');
  return decision(exhausted,0,`${failureClass} is never retried`);
}

// What a failed read does next; http.mjs's retryRead follows this. Backoff 400 ms × 4^(attempt-1), Retry-After honoured.
export function decideRead({failureClass,attempt=1,retryAfterMs=null,baseMs=400,factor=4}={}){
  const row=policyFor(failureClass);
  const reads=row.reads;
  if(!reads || !reads.retry) return decision('stop',0,`${failureClass} reads are not retried`);
  if(attempt>=(reads.maxAttempts ?? 3)) return decision('stop',0,`attempt ${attempt} was the last allowed`);
  const backoff=baseMs*Math.pow(factor,Math.max(0,attempt-1));
  const after=reads.honourRetryAfter && Number.isFinite(retryAfterMs)?retryAfterMs:0;
  if(after>MAX_WAIT_MS) return decision('stop',0,'the provider asked for a longer wait than a read waits');
  const waitMs=Math.max(backoff,after);
  return decision(waitMs>0?'wait_then_retry':'retry',waitMs,'a read may be tried again');
}
