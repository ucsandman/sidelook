// Unit tests for the recovery policy table and its two decision functions. Contract: docs/AGENT_SELF_HEALING.md section 4.
import test from 'node:test';
import assert from 'node:assert/strict';
import {RECOVERY_POLICY,RECOVERY_ACTIONS,decideWrite,decideRead,policyFor} from '../lib/agent/recovery.mjs';
import {FAILURE_CLASSES} from '../lib/agent/incidents.mjs';

// --- the table itself: a frozen literal transcribed from docs/AGENT_SELF_HEALING.md section 4, so an edit to any cell in
// lib/agent/recovery.mjs's RECOVERY_POLICY that is not also an edit to the contract fails here, not just in a derived assertion.
const EXPECTED_POLICY={
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
  precondition_refused:{writes:{beforeRetry:'none',retryWhen:'never',onExhausted:'fail_closed'},none:true}
};

test('RECOVERY_POLICY matches the contract literal cell for cell; a table edit not also made in docs/AGENT_SELF_HEALING.md fails here',()=>{
  assert.deepEqual(RECOVERY_POLICY,EXPECTED_POLICY);
});

test('every FAILURE_CLASSES entry has exactly one RECOVERY_POLICY row and vice versa (section 3: a class change touches both in one commit)',()=>{
  assert.deepEqual([...FAILURE_CLASSES].sort(),Object.keys(RECOVERY_POLICY).sort());
});

test('decideWrite is hardcoded per class at a representative attempt/finding, independent of the row under test (no self-derived expectations)',()=>{
  const cases=[
    ['transient_provider',{attempt:3,finding:null},'stop_partial'],
    ['rate_limit',{attempt:3,finding:'absent'},'stop_partial'],
    ['authentication_expired',{attempt:1,finding:null},'fail_closed'],
    ['timeout_before_request',{attempt:3,finding:null},'stop_partial'],
    ['timeout_during_request',{attempt:3,finding:'absent'},'stop_partial'],
    ['response_lost',{attempt:3,finding:'absent'},'stop_partial'],
    ['provider_state_conflict',{attempt:2,finding:'absent'},'stop_partial'],
    ['stale_entity_state',{attempt:1,finding:'absent'},'stop_partial'],
    ['ambiguous_identity',{attempt:1,finding:null},'ask_user'],
    ['dashclaw_unavailable',{attempt:1,finding:null},'fail_closed'],
    ['dashclaw_block',{attempt:1,finding:null},'stop_partial'],
    ['approval_denied',{attempt:1,finding:null},'stop_partial'],
    ['approval_expired',{attempt:1,finding:null},'stop_partial'],
    ['verification_mismatch',{attempt:1,finding:null},'refresh_read'],
    ['duplicate_effect_detected',{attempt:1,finding:null},'stop_uncertain'],
    ['user_cancellation',{attempt:1,finding:null},'stop_uncertain'],
    ['unknown_external_state',{attempt:1,finding:null},'stop_uncertain'],
    ['precondition_refused',{attempt:1,finding:null},'fail_closed']
  ];
  for(const [failureClass,args,expected] of cases) assert.equal(decideWrite({failureClass,...args}).action,expected,`${failureClass} ${JSON.stringify(args)}`);
});

// --- every class × every finding through decideWrite with no `if(writes)` guard: the model/render/resume classes have no
// `writes` row at all, so they must answer decideWrite's own "not a write fault" branch, never throw. -----------------------
test('decideWrite answers every FAILURE_CLASSES member for every finding, including classes with no writes row',()=>{
  for(const failureClass of FAILURE_CLASSES){
    for(const finding of [null,'present','absent','unknown']){
      const decision=decideWrite({failureClass,attempt:1,finding});
      assert.ok(RECOVERY_ACTIONS.includes(decision.action),`${failureClass} finding=${finding} answered "${decision.action}", not one of RECOVERY_ACTIONS`);
      if(!policyFor(failureClass).writes) assert.equal(decision.action,'stop_partial',`${failureClass} has no writes row; decideWrite must answer stop_partial, not silently allow a retry`);
    }
  }
});

test('RECOVERY_STRATEGIES (incidents.mjs) is the same array object as RECOVERY_ACTIONS, so the two lists can never drift apart',async()=>{
  const {RECOVERY_STRATEGIES}=await import('../lib/agent/incidents.mjs');
  assert.equal(RECOVERY_STRATEGIES,RECOVERY_ACTIONS);
});

// --- decideWrite: classes whose writes.beforeRetry is 'reconcile' -----------------------------------------------------
// Rule 1 of section 4 in words: these classes never retry solely because a request errored; a null finding always
// answers 'reconcile', never 'retry'. present ends the branch with 'none'; absent retries (bounded); unknown stops uncertain.
const RECONCILE_FIRST=['rate_limit','timeout_during_request','response_lost','provider_state_conflict'];

test('classes with beforeRetry:"reconcile" never answer retry on a null finding; they answer reconcile',()=>{
  for(const failureClass of RECONCILE_FIRST){
    const decision=decideWrite({failureClass,attempt:1,finding:null});
    assert.equal(decision.action,'reconcile',`${failureClass} with a null finding must reconcile, not guess`);
    assert.notEqual(decision.action,'retry');
  }
});

test('classes with beforeRetry:"reconcile": present ends it, absent retries within maxAttempts then hits onExhausted, unknown stops uncertain',()=>{
  for(const failureClass of RECONCILE_FIRST){
    const {writes}=policyFor(failureClass);
    const present=decideWrite({failureClass,attempt:1,finding:'present'});
    assert.equal(present.action,'none','the provider already holds the write; nothing more runs');

    const firstAttempt=decideWrite({failureClass,attempt:1,finding:'absent'});
    assert.ok(['retry','wait_then_retry'].includes(firstAttempt.action),`${failureClass} attempt 1 of ${writes.maxAttempts} should still be allowed to retry`);

    const lastAttempt=decideWrite({failureClass,attempt:writes.maxAttempts,finding:'absent'});
    assert.equal(lastAttempt.action,writes.onExhausted || 'stop_partial',`${failureClass} at its last allowed attempt hits onExhausted`);

    const unknown=decideWrite({failureClass,attempt:1,finding:'unknown'});
    assert.equal(unknown.action,writes.onUnknown || 'stop_uncertain',`${failureClass} unknown finding stops uncertain`);
  }
});

// --- decideWrite: presend_only classes ----------------------------------------------------------------------------
const PRESEND_ONLY=['transient_provider','timeout_before_request'];

test('presend_only classes answer retry or wait_then_retry on a null finding below maxAttempts, and the exhausted action at maxAttempts',()=>{
  for(const failureClass of PRESEND_ONLY){
    const {writes}=policyFor(failureClass);
    assert.equal(writes.retryWhen,'presend_only');
    const below=decideWrite({failureClass,attempt:1,finding:null});
    assert.ok(['retry','wait_then_retry'].includes(below.action),`${failureClass} attempt 1 is below maxAttempts ${writes.maxAttempts}`);
    const atMax=decideWrite({failureClass,attempt:writes.maxAttempts,finding:null});
    assert.equal(atMax.action,writes.onExhausted || 'stop_partial',`${failureClass} at maxAttempts hits the exhausted action`);
  }
});

test('presend_only classes: present ends it, unknown stops uncertain',()=>{
  for(const failureClass of PRESEND_ONLY){
    assert.equal(decideWrite({failureClass,attempt:1,finding:'present'}).action,'none');
    assert.equal(decideWrite({failureClass,attempt:1,finding:'unknown'}).action,'stop_uncertain');
  }
});

// --- decideWrite: classes that never retry a write (retryWhen:'never') -------------------------------------------
const NEVER_RETRY=[
  ['authentication_expired','fail_closed'],
  ['ambiguous_identity','ask_user'],
  ['dashclaw_unavailable','fail_closed'],
  ['dashclaw_block','stop_partial'],
  ['approval_denied','stop_partial'],
  ['approval_expired','stop_partial'],
  ['duplicate_effect_detected','stop_uncertain'],
  ['user_cancellation','stop_uncertain'],
  ['unknown_external_state','stop_uncertain'],
  ['precondition_refused','fail_closed']
];

test('classes with retryWhen:"never" answer their onExhausted action on a null or an absent finding, "none" on present, and stop_uncertain on unknown',()=>{
  for(const [failureClass,exhausted] of NEVER_RETRY){
    assert.equal(decideWrite({failureClass,attempt:1,finding:null}).action,exhausted,`${failureClass} null finding`);
    assert.equal(decideWrite({failureClass,attempt:1,finding:'absent'}).action,exhausted,`${failureClass} absent finding`);
    assert.equal(decideWrite({failureClass,attempt:1,finding:'present'}).action,'none',`${failureClass} present finding`);
    assert.equal(decideWrite({failureClass,attempt:1,finding:'unknown'}).action,'stop_uncertain',`${failureClass} unknown finding`);
  }
});

// --- decideWrite: classes with beforeRetry:'refresh_read' (a re-read, never a re-execute) ---------------------------
const REFRESH_READ_FIRST=['stale_entity_state','verification_mismatch'];

test('classes with beforeRetry:"refresh_read" answer refresh_read on a null finding and never retry a write',()=>{
  for(const failureClass of REFRESH_READ_FIRST){
    const {writes}=policyFor(failureClass);
    assert.equal(writes.retryWhen,'never');
    assert.equal(decideWrite({failureClass,attempt:1,finding:null}).action,'refresh_read');
    assert.equal(decideWrite({failureClass,attempt:1,finding:'present'}).action,'none');
    assert.equal(decideWrite({failureClass,attempt:1,finding:'absent'}).action,writes.onExhausted || 'stop_partial');
  }
});

// --- spec.noBlindRetry: an absent finding is never trusted enough to retry (Gmail) ----------------------------------
test('absent with spec.noBlindRetry answers stop_uncertain, whatever the failure class',()=>{
  assert.equal(decideWrite({failureClass:'response_lost',attempt:1,finding:'absent',spec:{noBlindRetry:true}}).action,'stop_uncertain');
  assert.equal(decideWrite({failureClass:'transient_provider',attempt:1,finding:'absent',spec:{noBlindRetry:true}}).action,'stop_uncertain');
  // A class with its own onUnknown is honoured even here.
  assert.equal(decideWrite({failureClass:'rate_limit',attempt:1,finding:'absent',spec:{noBlindRetry:true}}).action,policyFor('rate_limit').writes.onUnknown);
});

// --- Retry-After ------------------------------------------------------------------------------------------------------
test('Retry-After is honoured for rate_limit: a short wait wins over the table backoff, a wait past the cap ends the write instead',()=>{
  const {writes}=policyFor('rate_limit');
  assert.equal(writes.honourRetryAfter,true);
  const short=decideWrite({failureClass:'rate_limit',attempt:1,finding:'absent',retryAfterMs:1500});
  assert.equal(short.action,'wait_then_retry');
  assert.equal(short.waitMs,1500,'1500ms beats the table backoff of 1000ms at attempt 1');
  const long=decideWrite({failureClass:'rate_limit',attempt:1,finding:'absent',retryAfterMs:60000});
  assert.equal(long.action,writes.onExhausted || 'stop_partial','a 60s wait is longer than a run waits; the effect ends by policy instead');
  assert.notEqual(long.action,'wait_then_retry');
});

test('Retry-After is ignored for a class that does not honour it',()=>{
  const withoutHeader=decideWrite({failureClass:'response_lost',attempt:1,finding:'absent'});
  const withHeader=decideWrite({failureClass:'response_lost',attempt:1,finding:'absent',retryAfterMs:9999});
  assert.equal(withHeader.waitMs,withoutHeader.waitMs,'response_lost does not honour Retry-After');
});

// --- cancelled -----------------------------------------------------------------------------------------------------
test('cancelled answers stop_uncertain regardless of failure class or finding',()=>{
  for(const finding of [null,'present','absent','unknown']){
    const decision=decideWrite({failureClass:'transient_provider',attempt:1,finding,cancelled:true});
    assert.equal(decision.action,'stop_uncertain');
  }
});

// --- decideRead ----------------------------------------------------------------------------------------------------
test('decideRead retries a retryable class with backoff and stops once maxAttempts is reached',()=>{
  const {reads}=policyFor('transient_provider');
  assert.equal(reads.retry,true);
  const first=decideRead({failureClass:'transient_provider',attempt:1});
  assert.ok(['retry','wait_then_retry'].includes(first.action));
  const atMax=decideRead({failureClass:'transient_provider',attempt:reads.maxAttempts});
  assert.equal(atMax.action,'stop',`attempt ${reads.maxAttempts} of ${reads.maxAttempts} is the last allowed`);
});

test('decideRead never retries a class whose reads.retry is false',()=>{
  assert.equal(policyFor('authentication_expired').reads.retry,false);
  assert.equal(decideRead({failureClass:'authentication_expired',attempt:1}).action,'stop');
  assert.equal(decideRead({failureClass:'stale_entity_state',attempt:1}).action,'stop');
});

test('decideRead honours Retry-After only where the row says so',()=>{
  const withRetryAfter=decideRead({failureClass:'rate_limit',attempt:1,retryAfterMs:5000});
  assert.equal(policyFor('rate_limit').reads.honourRetryAfter,true);
  assert.equal(withRetryAfter.waitMs,5000,'rate_limit reads honour a longer Retry-After than the backoff');

  const ignoresRetryAfter=decideRead({failureClass:'transient_provider',attempt:1,retryAfterMs:5000});
  assert.notEqual(policyFor('transient_provider').reads.honourRetryAfter,true);
  assert.notEqual(ignoresRetryAfter.waitMs,5000,'transient_provider reads do not honour Retry-After');

  const pastCap=decideRead({failureClass:'rate_limit',attempt:1,retryAfterMs:40000});
  assert.equal(pastCap.action,'stop','a Retry-After longer than a read waits ends the read instead');
});

// --- policyFor -------------------------------------------------------------------------------------------------------
test('policyFor throws on an unknown failure class',()=>{
  assert.throws(()=>policyFor('not_a_real_class'),/No recovery policy/);
});

// --- RECOVERY_ACTIONS ----------------------------------------------------------------------------------------------
test('RECOVERY_ACTIONS contains every action decideWrite or decideRead can answer for any policy row',()=>{
  const observed=new Set();
  for(const failureClass of Object.keys(RECOVERY_POLICY)){
    if(policyFor(failureClass).writes){
      for(const finding of [null,'present','absent','unknown']){
        for(const attempt of [1,2,3]) observed.add(decideWrite({failureClass,attempt,finding}).action);
      }
      observed.add(decideWrite({failureClass,attempt:1,finding:null,cancelled:true}).action);
    }
    if(policyFor(failureClass).reads) for(const attempt of [1,2,3]) observed.add(decideRead({failureClass,attempt}).action);
  }
  observed.delete('stop'); // decideRead's own terminal word is not one of the write actions RECOVERY_ACTIONS enumerates
  for(const action of observed) assert.ok(RECOVERY_ACTIONS.includes(action),`RECOVERY_ACTIONS is missing "${action}"`);
});
