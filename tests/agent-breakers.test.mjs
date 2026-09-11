// Unit tests for the circuit breakers. Contract: docs/AGENT_SELF_HEALING.md section 5.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CircuitBreakers,BREAKER_POLICY} from '../lib/agent/breakers.mjs';

// A controllable clock: `clock.now` is the function CircuitBreakers calls, `clock.set` moves it.
function fakeClock(startMs=1_700_000_000_000){
  let t=startMs;
  const now=()=>t;
  now.set=ms=>{t=ms;};
  now.advance=ms=>{t+=ms;};
  return now;
}

test('threshold opens the circuit only inside the window; failures older than windowMs do not count',()=>{
  const now=fakeClock();
  const breakers=new CircuitBreakers({now});
  const rule=BREAKER_POLICY['stripe:rate_limit']; // threshold 3, windowMs 300000
  breakers.recordFailure('stripe','rate_limit',now());
  now.advance(rule.windowMs+1000); // this failure has aged out of the window
  const second=breakers.recordFailure('stripe','rate_limit',now());
  assert.equal(second.opened,false,'only one failure is inside the window; threshold 3 is not met');
  const third=breakers.recordFailure('stripe','rate_limit',now());
  assert.equal(third.opened,false,'two failures inside the window, still under the threshold of 3');
  const fourth=breakers.recordFailure('stripe','rate_limit',now());
  assert.equal(fourth.opened,true,'the third failure inside the window opens the circuit');
  assert.equal(breakers.check('stripe',{kind:'write'}).open,true);
});

test('check answers open with reason and until while the circuit is open',()=>{
  const now=fakeClock();
  const breakers=new CircuitBreakers({now});
  const rule=BREAKER_POLICY['stripe:authentication_expired']; // threshold 2
  breakers.recordFailure('stripe','authentication_expired',now());
  const opened=breakers.recordFailure('stripe','authentication_expired',now());
  assert.equal(opened.opened,true);
  const gate=breakers.check('stripe',{kind:'write'});
  assert.equal(gate.open,true);
  assert.equal(gate.failureClass,'authentication_expired');
  assert.ok(gate.reason.length>0,'the reason is a human sentence');
  assert.equal(gate.until,new Date(now()+rule.cooldownMs).toISOString());
  assert.equal(gate.halfOpen,false);
});

test('half-open after cooldown lets exactly one trial through, then refuses a second check',()=>{
  const now=fakeClock();
  const breakers=new CircuitBreakers({now});
  const rule=BREAKER_POLICY['hubspot:rate_limit']; // threshold 3, cooldownMs 120000
  for(let i=0;i<3;i++) breakers.recordFailure('hubspot','rate_limit',now());
  assert.equal(breakers.check('hubspot',{kind:'write'}).open,true);
  now.advance(rule.cooldownMs+1);
  const trial=breakers.check('hubspot',{kind:'write'});
  assert.equal(trial.open,false,'the cooldown has passed; one trial call is let through');
  assert.equal(trial.trial,true);
  const secondCheck=breakers.check('hubspot',{kind:'write'});
  assert.equal(secondCheck.open,true,'a second check before the trial settles is refused');
  assert.equal(secondCheck.halfOpen,true);
});

test('recordSuccess closes a half-open circuit and clears outage-class counts, but never authentication or model counts',()=>{
  const now=fakeClock();
  const breakers=new CircuitBreakers({now});
  const outageRule=BREAKER_POLICY['stripe:rate_limit'];
  for(let i=0;i<outageRule.threshold;i++) breakers.recordFailure('stripe','rate_limit',now());
  now.advance(outageRule.cooldownMs+1);
  breakers.check('stripe',{kind:'write'}); // consume the trial, half-open
  breakers.recordSuccess('stripe');
  assert.equal(breakers.check('stripe',{kind:'write'}).open,false,'a success on the trial closes the half-open circuit');
  const snapshotAfterClose=breakers.snapshot().find(e=>e.key==='stripe:rate_limit');
  assert.equal(snapshotAfterClose,undefined,'a closed breaker with no failures left is omitted from the snapshot');

  // Two failures short of opening the authentication breaker; a success on the same integration must not erase them.
  const authRule=BREAKER_POLICY['stripe:authentication_expired'];
  breakers.recordFailure('stripe','authentication_expired',now());
  breakers.recordSuccess('stripe');
  const afterSuccess=breakers.snapshot().find(e=>e.key==='stripe:authentication_expired');
  assert.equal(afterSuccess?.failures,1,'recordSuccess never clears an authentication_expired count, even for a closed breaker');
  breakers.recordFailure('stripe','authentication_expired',now());
  assert.equal(breakers.check('stripe',{kind:'write'}).open,true,`the authentication breaker still opens at its threshold ${authRule.threshold}`);
});

// The distinct branch this file's own title promises: a *closed* breaker carrying an outage-shaped count (never opened,
// never half-open) has that count cleared by a success on the same integration, while a model count on the same
// integration is left alone. breakers.mjs:78's `state==='closed' && OUTAGE_CLASSES.has(...)` branch, never reached above.
test('recordSuccess on a closed breaker clears every outage-shaped class\'s count, and only those',()=>{
  const now=fakeClock();
  const breakers=new CircuitBreakers({now});
  for(const failureClass of ['rate_limit','transient_provider','timeout_before_request']){
    breakers.recordFailure('stripe',failureClass,now()); // one failure each, still closed (thresholds are all >1)
    assert.equal(breakers.snapshot().find(e=>e.key===`stripe:${failureClass}`)?.failures,1,`${failureClass} recorded one closed failure`);
  }
  breakers.recordFailure('dashclaw','dashclaw_unavailable',now());
  assert.equal(breakers.snapshot().find(e=>e.key==='dashclaw:dashclaw_unavailable')?.failures,1);
  // A model fault on the same 'stripe' key space (integration 'model') must never be touched by a Stripe success.
  breakers.recordFailure('model','malformed_model_output',now());

  breakers.recordSuccess('stripe');
  for(const failureClass of ['rate_limit','transient_provider','timeout_before_request'])
    assert.equal(breakers.snapshot().find(e=>e.key===`stripe:${failureClass}`),undefined,`${failureClass} count cleared by the Stripe success`);
  assert.equal(breakers.snapshot().find(e=>e.key==='dashclaw:dashclaw_unavailable')?.failures,1,'a different integration is untouched by a Stripe success');
  assert.equal(breakers.snapshot().find(e=>e.key==='model:malformed_model_output')?.failures,1,'a model count is never cleared by an unrelated provider success');

  breakers.recordSuccess('dashclaw');
  assert.equal(breakers.snapshot().find(e=>e.key==='dashclaw:dashclaw_unavailable'),undefined,'dashclaw_unavailable is outage-shaped and clears on its own integration\'s success');
});

test('recordFailure in half-open reopens the circuit for a full cooldown',()=>{
  const now=fakeClock();
  const breakers=new CircuitBreakers({now});
  const rule=BREAKER_POLICY['gmail:rate_limit'];
  for(let i=0;i<rule.threshold;i++) breakers.recordFailure('gmail','rate_limit',now());
  now.advance(rule.cooldownMs+1);
  breakers.check('gmail',{kind:'write'}); // the one trial call, half-open
  const reopened=breakers.recordFailure('gmail','rate_limit',now());
  assert.equal(reopened.opened,true,'a failure on the trial call reopens the circuit');
  const gate=breakers.check('gmail',{kind:'write'});
  assert.equal(gate.open,true);
  assert.equal(gate.until,new Date(now()+rule.cooldownMs).toISOString(),'reopening grants a full new cooldown, not the remainder of the old one');
});

test('keys without a rule are tracked:false and never open',()=>{
  const breakers=new CircuitBreakers({now:fakeClock()});
  const result=breakers.recordFailure('slack','provider_state_conflict'); // no policy row for this pair
  assert.equal(result.tracked,false);
  assert.equal(result.opened,false);
  assert.equal(breakers.check('slack',{kind:'write'}).open,false);
});

test('wildcard rules (*:transient_provider) apply to any integration',()=>{
  const now=fakeClock();
  const breakers=new CircuitBreakers({now});
  const rule=BREAKER_POLICY['*:transient_provider']; // threshold 5
  for(let i=0;i<rule.threshold-1;i++) assert.equal(breakers.recordFailure('slack','transient_provider',now()).opened,false);
  const last=breakers.recordFailure('slack','transient_provider',now());
  assert.equal(last.opened,true,'the wildcard rule opens the circuit for an integration with no specific rule');
  assert.equal(breakers.check('slack',{kind:'write'}).open,true);
  // A second, unrelated integration is unaffected: each key is integration-scoped.
  assert.equal(breakers.check('gmail',{kind:'write'}).open,false);
});

test('snapshot omits closed idle keys but includes a closed key that still carries failures',()=>{
  const now=fakeClock();
  const breakers=new CircuitBreakers({now});
  assert.deepEqual(breakers.snapshot(),[],'nothing recorded yet');
  breakers.recordFailure('stripe','rate_limit',now()); // 1 of 3, still closed
  const snap=breakers.snapshot();
  assert.equal(snap.length,1);
  assert.equal(snap[0].state,'closed');
  assert.equal(snap[0].failures,1);
});

test('reset removes a key',()=>{
  const now=fakeClock();
  const breakers=new CircuitBreakers({now});
  const rule=BREAKER_POLICY['dashclaw:dashclaw_unavailable'];
  for(let i=0;i<rule.threshold;i++) breakers.recordFailure('dashclaw','dashclaw_unavailable',now());
  assert.equal(breakers.check('dashclaw',{kind:'write'}).open,true);
  assert.equal(breakers.reset('dashclaw:dashclaw_unavailable'),true);
  assert.equal(breakers.check('dashclaw',{kind:'write'}).open,false,'reset clears the key entirely');
  assert.equal(breakers.reset('dashclaw:dashclaw_unavailable'),false,'resetting a key that is not tracked answers false');
});

// --- persistence -----------------------------------------------------------------------------------------------------
test('a path given to the constructor persists state across two instances; an open breaker survives a reload',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'sidelook-breakers-'));
  t.after(()=>rm(dir,{recursive:true,force:true}).catch(()=>{}));
  const path=join(dir,'breakers.json');
  const now=fakeClock();
  const rule=BREAKER_POLICY['hubspot:authentication_expired'];
  const first=new CircuitBreakers({now,path});
  for(let i=0;i<rule.threshold;i++) first.recordFailure('hubspot','authentication_expired',now());
  assert.equal(first.check('hubspot',{kind:'write'}).open,true);

  const second=new CircuitBreakers({now,path});
  assert.equal(second.check('hubspot',{kind:'write'}).open,true,'the open breaker survives a reload from the same snapshot file');
  const snap=second.snapshot().find(e=>e.key==='hubspot:authentication_expired');
  assert.equal(snap.state,'open');
});

test('an unreadable snapshot file starts closed rather than throwing',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'sidelook-breakers-bad-'));
  t.after(()=>rm(dir,{recursive:true,force:true}).catch(()=>{}));
  const path=join(dir,'breakers.json');
  await mkdir(dir,{recursive:true});
  await writeFile(path,'not valid json','utf8');
  const breakers=new CircuitBreakers({now:fakeClock(),path});
  assert.equal(breakers.check('stripe',{kind:'write'}).open,false);
  assert.deepEqual(breakers.snapshot(),[]);
});
