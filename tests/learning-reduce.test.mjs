import test from 'node:test';
import assert from 'node:assert/strict';
import {incidentsToFamilies, familyToRegression, fingerprintOf, assignSet, REDUCTION_TABLE} from '../agent-learning/lib/reduce.mjs';

const GOAL_REFUND = 'Acme cancellation: refund the last payment, mark the CRM lead unqualified, and email confirmation.';

function incident(overrides = {}) {
  return {
    incidentId: 'inc_' + Math.random().toString(16).slice(2), runId: 'run_1', at: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:05:00.000Z',
    integration: 'hubspot', tool: 'hubspot.update_customer', operation: 'update:123', phase: 'execute', failureClass: 'transient_provider',
    family: 'hubspot:transient_provider:hubspot.update_customer', severity: 'warn', providerStatus: 500, attemptNumber: 1,
    providerOperationId: null, dashclawActionId: null, effectId: 'fx_1', knownState: 'not_sent', uncertainState: false,
    recoveryAttempted: true, recoveryStrategy: 'retry', recoveryResult: 'recovered', verificationResult: 'verified',
    sanitizedEvidence: {code: 'SERVER', message: 'hubspot.updateContact failed (failTimes).', ids: {}}, finalDisposition: 'recovered',
    ...overrides
  };
}

test('incidentsToFamilies groups by family key, counts, dedupes run/incident ids, and tracks attemptsExhausted', () => {
  const incidents = [
    incident({incidentId: 'inc_a', runId: 'run_1', attemptNumber: 1, recoveryResult: 'recovered'}),
    incident({incidentId: 'inc_b', runId: 'run_1', attemptNumber: 2, recoveryResult: 'recovered'}),
    incident({incidentId: 'inc_c', runId: 'run_2', attemptNumber: 3, recoveryResult: 'retried_failed', finalDisposition: 'partial'})
  ];
  const families = incidentsToFamilies(incidents, []);
  assert.equal(families.length, 1);
  const family = families[0];
  assert.equal(family.key, 'hubspot:transient_provider:hubspot.update_customer');
  assert.equal(family.integration, 'hubspot');
  assert.equal(family.failureClass, 'transient_provider');
  assert.equal(family.tool, 'hubspot.update_customer');
  assert.equal(family.count, 3);
  assert.deepEqual(family.runIds.sort(), ['run_1', 'run_2']);
  assert.deepEqual(family.incidentIds.sort(), ['inc_a', 'inc_b', 'inc_c']);
  assert.equal(family.attemptsExhausted, true, 'a recoveryResult of retried_failed marks the family exhausted');
  assert.equal(family.dispositions.recovered, 2);
});

test('incidentsToFamilies marks attemptsExhausted true once the max attempt number reaches the transient-provider ceiling, even with no failed recoveryResult', () => {
  const incidents = [incident({incidentId: 'inc_a', attemptNumber: 3, recoveryResult: 'recovered'})];
  const [family] = incidentsToFamilies(incidents, []);
  assert.equal(family.attemptsExhausted, true);
});

test('incidentsToFamilies leaves attemptsExhausted false below the ceiling with no exhausted recoveryResult', () => {
  const incidents = [incident({incidentId: 'inc_a', attemptNumber: 1, recoveryResult: 'recovered'})];
  const [family] = incidentsToFamilies(incidents, []);
  assert.equal(family.attemptsExhausted, false);
});

test('incidentsToFamilies sorts families by count descending, then key', () => {
  const incidents = [
    incident({incidentId: 'inc_a', family: 'stripe:response_lost:stripe.refund_payment', integration: 'stripe', failureClass: 'response_lost', tool: 'stripe.refund_payment'}),
    incident({incidentId: 'inc_b'}), incident({incidentId: 'inc_c'})
  ];
  const families = incidentsToFamilies(incidents, []);
  assert.equal(families[0].key, 'hubspot:transient_provider:hubspot.update_customer');
  assert.equal(families[0].count, 2);
  assert.equal(families[1].key, 'stripe:response_lost:stripe.refund_payment');
});

test('incidentsToFamilies ignores null/undefined entries and falls back to a computed key when family is missing', () => {
  const families = incidentsToFamilies([null, undefined, incident({family: undefined})], []);
  assert.equal(families.length, 1);
  assert.equal(families[0].key, 'hubspot:transient_provider:hubspot.update_customer');
});

test('familyToRegression: hubspot transient_provider only produces a scenario once attempts are exhausted', () => {
  const notExhausted = {key: 'hubspot:transient_provider:hubspot.update_customer', integration: 'hubspot', failureClass: 'transient_provider', tool: 'hubspot.update_customer', count: 1, attemptsExhausted: false, maxAttemptNumber: 1, runIds: [], incidentIds: []};
  assert.equal(familyToRegression(notExhausted, {learnRunId: 'learn_1'}), null);

  const exhausted = {...notExhausted, attemptsExhausted: true, maxAttemptNumber: 3, count: 3, runIds: ['run_1'], incidentIds: ['inc_a']};
  const scenario = familyToRegression(exhausted, {learnRunId: 'learn_1', now: () => '2026-09-11T00:00:00.000Z'});
  assert.equal(scenario.status, 'proposed');
  assert.equal(scenario.family, exhausted.key);
  assert.equal(scenario.goal, GOAL_REFUND);
  assert.deepEqual(scenario.faults, {'hubspot.updateContact': {kind: 'failTimes', times: 3}});
  assert.equal(scenario.dashclaw.approvalScript, 'approve');
  assert.equal(scenario.expect.status, 'completed');
  assert.equal(scenario.expect.writes.duplicate, 0);
  assert.equal(scenario.expect.writes.verified, 3);
  assert.equal(scenario.expect.approvals.decision, 'approved');
  assert.equal(scenario.expect.recovered, true);
  assert.equal(scenario.expect.noSuccessClaim, true);
  assert.equal(scenario.expect.state.refunds, 1);
  assert.match(scenario.id, /^reg_hubspot_transient_provider_hubspot_update_customer_[0-9a-f]{4}$/);
  assert.equal(scenario.source.learnRunId, 'learn_1');
  assert.equal(scenario.source.createdAt, '2026-09-11T00:00:00.000Z');
});

test('familyToRegression: stripe:response_lost, gmail:response_lost and hubspot:rate_limit map per the fixed table', () => {
  const stripe = familyToRegression({key: 'stripe:response_lost:stripe.refund_payment', integration: 'stripe', failureClass: 'response_lost', tool: 'stripe.refund_payment', count: 1, runIds: [], incidentIds: []}, {learnRunId: 'l'});
  assert.deepEqual(stripe.faults, {'stripe.createRefund': 'lostAfterSuccess'});
  assert.equal(stripe.expect.status, 'completed');
  assert.equal(stripe.expect.state.refunds, 1);
  assert.equal(stripe.expect.callCounts['stripe.createRefund'], 1);

  const gmail = familyToRegression({key: 'gmail:response_lost:gmail.send_message', integration: 'gmail', failureClass: 'response_lost', tool: 'gmail.send_message', count: 1, runIds: [], incidentIds: []}, {learnRunId: 'l'});
  assert.deepEqual(gmail.faults, {'gmail.send': 'lostAfterSuccess'});
  assert.equal(gmail.expect.state.sent, 1);

  const hubspotRate = familyToRegression({key: 'hubspot:rate_limit:hubspot.update_customer', integration: 'hubspot', failureClass: 'rate_limit', tool: 'hubspot.update_customer', count: 1, runIds: [], incidentIds: []}, {learnRunId: 'l'});
  assert.deepEqual(hubspotRate.faults, {'hubspot.updateContact': {kind: 'rateLimit', times: 1, retryAfterMs: 50}});
  assert.equal(hubspotRate.expect.recovered, true);
});

test('familyToRegression: stripe:authentication_expired and dashclaw:dashclaw_unavailable resolve via the wildcard tool entries', () => {
  const auth = familyToRegression({key: 'stripe:authentication_expired:stripe.refund_payment', integration: 'stripe', failureClass: 'authentication_expired', tool: 'stripe.refund_payment', count: 1, runIds: [], incidentIds: []}, {learnRunId: 'l'});
  assert.ok(auth, 'stripe:authentication_expired:* must match a family whose exact key has no table row');
  assert.deepEqual(auth.faults, {'stripe.createRefund': 'authExpired'});
  assert.equal(auth.expect.recovered, false);

  const unavailable = familyToRegression({key: 'dashclaw:dashclaw_unavailable:stripe.refund_payment', integration: 'dashclaw', failureClass: 'dashclaw_unavailable', tool: 'stripe.refund_payment', count: 1, runIds: [], incidentIds: []}, {learnRunId: 'l'});
  assert.equal(unavailable.expect.status, 'blocked');
  assert.equal(unavailable.dashclaw.unavailableOnLabel, 'Write: stripe.refund_payment');
  assert.equal(unavailable.expect.callCounts['stripe.createRefund'], 0);
});

test('familyToRegression returns null for a family with no table entry, exact or wildcard', () => {
  const scenario = familyToRegression({key: 'slack:unknown_external_state:slack.post_message', integration: 'slack', failureClass: 'unknown_external_state', tool: 'slack.post_message', count: 1, runIds: [], incidentIds: []}, {learnRunId: 'l'});
  assert.equal(scenario, null);
});

test('every produced expect carries noSuccessClaim:true and writes.duplicate:0, even when the builder did not set it explicitly', () => {
  for (const key of Object.keys(REDUCTION_TABLE)) {
    const family = {key, integration: key.split(':')[0], failureClass: key.split(':')[1], tool: key.split(':')[2] === '*' ? 'some.tool' : key.split(':')[2], count: 1, attemptsExhausted: true, maxAttemptNumber: 3, runIds: [], incidentIds: []};
    const scenario = familyToRegression(family, {learnRunId: 'l'});
    assert.ok(scenario, key);
    assert.equal(scenario.expect.noSuccessClaim, true, key);
    assert.equal(scenario.expect.writes.duplicate, 0, key);
  }
});

test('fingerprintOf is deterministic and independent of key order, but sensitive to a changed fault', () => {
  const a = {goal: 'g', fixtures: {x: 1}, faults: {a: 1, b: 2}, dashclaw: {}, model: {}};
  const b = {goal: 'g', faults: {b: 2, a: 1}, fixtures: {x: 1}, model: {}, dashclaw: {}};
  assert.equal(fingerprintOf(a), fingerprintOf(b));
  const c = {...a, faults: {a: 1, b: 3}};
  assert.notEqual(fingerprintOf(a), fingerprintOf(c));
  assert.match(fingerprintOf(a), /^[a-f0-9]{64}$/);
});

test('assignSet: the first case of a family goes to dev; the second distinct case always lands in holdout', () => {
  const family = {key: 'hubspot:transient_provider:hubspot.update_customer'};
  assert.equal(assignSet(family, {dev: [], holdout: []}), 'dev');
  const existingCorpus = {dev: [{family: family.key, fingerprint: 'f1'}], holdout: []};
  const second = assignSet(family, existingCorpus, 'f2');
  assert.equal(second, 'holdout', 'a family with two cases must have a holdout one');
});

test('assignSet: a third and later case alternates deterministically by the new fingerprint\'s parity', () => {
  const family = {key: 'hubspot:transient_provider:hubspot.update_customer'};
  const existingCorpus = {dev: [{family: family.key}, {family: family.key}], holdout: [{family: family.key}]};
  const first = assignSet(family, existingCorpus, 'f3');
  const second = assignSet(family, existingCorpus, 'f3'); // same input: same answer out (pure, deterministic)
  assert.equal(first, second);
  assert.ok(['dev', 'holdout'].includes(first));
});

test('assignSet only counts existing cases of the same family, not the whole corpus', () => {
  const family = {key: 'gmail:response_lost:gmail.send_message'};
  const corpus = {dev: [{family: 'hubspot:transient_provider:hubspot.update_customer'}], holdout: [{family: 'stripe:response_lost:stripe.refund_payment'}]};
  assert.equal(assignSet(family, corpus), 'dev', 'no prior case of this family exists in either set');
});
