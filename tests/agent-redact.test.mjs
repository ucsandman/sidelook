import test from 'node:test';
import assert from 'node:assert/strict';
import {redactText,redact} from '../lib/agent/redact.mjs';

test('redactText masks every known secret pattern and leaves the rest alone',()=>{
  assert.equal(redactText('key is sk_live_ABCDEF123456 here'),'key is [redacted:stripe] here');
  assert.equal(redactText('key is sk_test_ABCDEF123456 here'),'key is [redacted:stripe] here');
  assert.equal(redactText('key is rk_live_ABCDEF123456 here'),'key is [redacted:stripe] here');
  assert.equal(redactText('token xoxb-1234567-abcdef'),'token [redacted:slack]');
  assert.equal(redactText('token xoxp-1234567-abcdef'),'token [redacted:slack]');
  assert.equal(redactText('hubspot pat-na1-abcdef123456'),'hubspot [redacted:hubspot]');
  assert.equal(redactText('google ya29.a0Abcdefghijklmno'),'google [redacted:google]');
  assert.equal(redactText('dashclaw oc_live_abcdef123456'),'dashclaw [redacted:dashclaw]');
  assert.equal(redactText('Authorization: Bearer abcdef123456'),'Authorization: [redacted:bearer]');
  assert.equal(redactText('body has refresh_token=abc.def-123&other=1'),'body has [redacted:refresh_token]&other=1');
  assert.equal(redactText('body has client_secret=abc.def-123&other=1'),'body has [redacted:client_secret]&other=1');
  assert.equal(redactText('body has access_token=abc.def-123&other=1'),'body has [redacted:access_token]&other=1');
  assert.equal(redactText('plain evidence: refund re_123 for pi_456'),'plain evidence: refund re_123 for pi_456');
  assert.equal(redactText(undefined),'');
});

test('redact() deep-clones and masks any value under a secret-named key',()=>{
  const input={
    headers:{Authorization:'Bearer sk_live_ABCDEF123456',Cookie:'session=abc', 'X-Api-Key':'k1','apiKey':'k2',token:'t1',secret:'s1',Accept:'application/json'},
    nested:{list:[{token:'inner-secret'},{safe:'value with sk_test_XYZ123456 inside'}]},
    plain:'no secret here'
  };
  const out=redact(input);
  assert.equal(out.headers.Authorization,'[redacted:key]');
  assert.equal(out.headers.Cookie,'[redacted:key]');
  assert.equal(out.headers['X-Api-Key'],'[redacted:key]');
  assert.equal(out.headers.apiKey,'[redacted:key]');
  assert.equal(out.headers.token,'[redacted:key]');
  assert.equal(out.headers.secret,'[redacted:key]');
  assert.equal(out.headers.Accept,'application/json');
  assert.equal(out.nested.list[0].token,'[redacted:key]');
  assert.equal(out.nested.list[1].safe,'value with [redacted:stripe] inside');
  assert.equal(out.plain,'no secret here');
  // original is untouched: redact() is a deep clone, never a mutation
  assert.equal(input.headers.Authorization,'Bearer sk_live_ABCDEF123456');
});

test('redact() passes through non-object, non-string values',()=>{
  assert.equal(redact(42),42);
  assert.equal(redact(null),null);
  assert.equal(redact(true),true);
  assert.deepEqual(redact([1,'sk_test_ABCDEF123456',null]),[1,'[redacted:stripe]',null]);
});
