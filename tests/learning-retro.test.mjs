import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRetroStats, RETRO_SCHEMA, buildRetroPrompt, parseRetro, runRetro} from '../agent-learning/lib/retro.mjs';

function run(overrides = {}) {
  return {runId: 'run_1', createdAt: '2026-09-01T00:00:00.000Z', status: 'completed', turn: 3, summary: {toolCalls: 5}, events: {tool: {ok: 4}}, ...overrides};
}

function incident(overrides = {}) {
  return {
    incidentId: 'inc_a', runId: 'run_1', at: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:05:00.000Z',
    integration: 'hubspot', tool: 'hubspot.update_customer', operation: 'update:1', phase: 'execute', failureClass: 'transient_provider',
    family: 'hubspot:transient_provider:hubspot.update_customer', severity: 'warn', providerStatus: 500, attemptNumber: 1,
    providerOperationId: null, dashclawActionId: null, effectId: 'fx_1', knownState: 'not_sent', uncertainState: false,
    recoveryAttempted: true, recoveryStrategy: 'retry', recoveryResult: 'recovered', verificationResult: 'verified',
    sanitizedEvidence: {code: 'SERVER', message: 'x', ids: {}}, finalDisposition: 'recovered',
    ...overrides
  };
}

test('buildRetroStats counts runs by status and incidents by class/integration/phase', () => {
  const evidence = {runs: [run({status: 'completed'}), run({runId: 'run_2', status: 'partial'})], incidents: [incident(), incident({incidentId: 'inc_b', runId: 'run_2', failureClass: 'rate_limit', integration: 'stripe', phase: 'reconcile'})]};
  const stats = buildRetroStats(evidence, null);
  assert.deepEqual(stats.runs, {total: 2, byStatus: {completed: 1, partial: 1}});
  assert.equal(stats.incidents.total, 2);
  assert.equal(stats.incidents.byClass.transient_provider, 1);
  assert.equal(stats.incidents.byClass.rate_limit, 1);
  assert.equal(stats.incidents.byIntegration.stripe, 1);
  assert.equal(stats.incidents.byPhase.reconcile, 1);
});

test('buildRetroStats includes only families that repeated (count>=2 across >=2 runs)', () => {
  const evidence = {
    runs: [run(), run({runId: 'run_2'})],
    incidents: [incident({incidentId: 'inc_a', runId: 'run_1'}), incident({incidentId: 'inc_b', runId: 'run_2'}), incident({incidentId: 'inc_c', runId: 'run_1', failureClass: 'rate_limit', family: 'stripe:rate_limit:stripe.refund_payment', integration: 'stripe'})]
  };
  const stats = buildRetroStats(evidence, null);
  assert.equal(stats.repeatedFamilies.length, 1);
  assert.equal(stats.repeatedFamilies[0].key, 'hubspot:transient_provider:hubspot.update_customer');
  assert.equal(stats.repeatedFamilies[0].count, 2);
});

test('buildRetroStats attributes incidents to model/external/governance/person/integration per the fixed table', () => {
  const evidence = {
    runs: [run()],
    incidents: [
      incident({incidentId: 'i1', failureClass: 'malformed_model_output'}),
      incident({incidentId: 'i2', failureClass: 'transient_provider'}),
      incident({incidentId: 'i3', failureClass: 'dashclaw_block'}),
      incident({incidentId: 'i4', failureClass: 'approval_denied'}),
      incident({incidentId: 'i5', failureClass: 'response_lost'})
    ]
  };
  const stats = buildRetroStats(evidence, null);
  assert.deepEqual(stats.attribution, {model: 1, integration: 1, external: 1, governance: 1, person: 1});
});

test('buildRetroStats tracks recoveries by class using recoveryResult, and computes planner signals', () => {
  const evidence = {
    runs: [run({turn: 1}), run({runId: 'run_2', turn: 9})],
    incidents: [
      incident({incidentId: 'i1', recoveryResult: 'recovered'}),
      incident({incidentId: 'i2', recoveryResult: 'retried_failed', failureClass: 'precondition_refused', runId: 'run_2'})
    ]
  };
  const stats = buildRetroStats(evidence, null);
  assert.equal(stats.recoveries.transient_provider.recovered, 1);
  assert.equal(stats.recoveries.precondition_refused.failed, 1);
  assert.equal(stats.planner.turnsAboveMedianRunIds.includes('run_2'), true);
});

test('buildRetroStats folds corpusResults into counts and a latency median only, never a scenario id or name', () => {
  const corpusResults = {
    dev: {scenarios: [{id: 'reg_dev_case', name: 'dev case', pass: true, elapsedMs: 100}], metrics: {scenarioPassRate: 1}},
    holdout: {scenarios: [{id: 'reg_holdout_secret_case', name: 'holdout case', pass: true, elapsedMs: 300}], metrics: {scenarioPassRate: 1}}
  };
  const stats = buildRetroStats({runs: [], incidents: []}, corpusResults);
  assert.equal(stats.corpus.devPassRate, 1);
  assert.equal(stats.corpus.holdoutPassRate, 1);
  assert.equal(stats.corpus.devCount, 1);
  assert.equal(stats.corpus.holdoutCount, 1);
  assert.equal(stats.medians.latencyMsMedian, 200);
  const statsText = JSON.stringify(stats);
  assert.ok(!statsText.includes('reg_holdout_secret_case'));
  assert.ok(!statsText.includes('reg_dev_case'));
});

test('buildRetroPrompt never carries a holdout scenario id: a holdout id passed only through corpusResults never reaches the assembled prompt', () => {
  const corpusResults = {
    dev: {scenarios: [{id: 'reg_dev_x', name: 'x', pass: true, elapsedMs: 10}], metrics: {scenarioPassRate: 1}},
    holdout: {scenarios: [{id: 'reg_holdout_NEVER_LEAK', name: 'y', pass: true, elapsedMs: 20}], metrics: {scenarioPassRate: 1}}
  };
  const stats = buildRetroStats({runs: [], incidents: []}, corpusResults);
  const {system, prompt} = buildRetroPrompt({stats, memoryProjection: {lessons: [], failureFamilies: [], rejectedStrategies: [], nextExperiments: []}, rejectedStrategies: []});
  assert.ok(!prompt.includes('reg_holdout_NEVER_LEAK'));
  assert.ok(!prompt.includes('reg_dev_x'));
  assert.ok(!system.includes('reg_holdout_NEVER_LEAK'));
});

test('buildRetroPrompt carries the rejected-strategy list and the brainstorming rules, sanitized', () => {
  const {prompt} = buildRetroPrompt({stats: {}, memoryProjection: {}, rejectedStrategies: [{hypothesisKey: 'hyp_1', reason: 'no_measurable_improvement, see C:\\Users\\dana\\log.txt'}]});
  assert.match(prompt, /hyp_1/);
  assert.match(prompt, /no_measurable_improvement/);
  assert.ok(!prompt.includes('C:\\Users\\dana'));
  assert.match(prompt, /Differ in kind/);
  assert.match(prompt, /YAGNI/);
});

function validRaw(overrides = {}) {
  return {
    whatWorked: [{pattern: 'Recovery after a transient failure verifies.', evidence: ['hubspot:transient_provider:hubspot.update_customer']}],
    whatFailed: [{familyKey: 'stripe:rate_limit:stripe.refund_payment', count: 3, attribution: 'external', note: 'Rate limit was not honoured.'}],
    lessons: [
      {text: 'HubSpot recovers after retries.', evidence: ['hubspot:transient_provider:hubspot.update_customer']},
      {text: 'A rate limit needs Retry-After.', evidence: ['stripe:rate_limit:stripe.refund_payment']},
      {text: 'Turn counts above the median correlate with precondition refusals.', evidence: ['run_2']}
    ],
    next: [
      {hypothesisKey: 'recovery_policy:rate_limit:honour_retry_after', problem: 'p', proposedChange: 'honour Retry-After', whyItMayHelp: 'w', metric: 'successfulRecoveries', couldRegress: [], falsifiedIf: 'f', affectedModules: ['lib/agent/recovery.mjs'], risk: 'low', kind: 'recovery_policy'},
      {hypothesisKey: 'prompt:planner:clarify_schema_fields', problem: 'p2', proposedChange: 'clarify schema', whyItMayHelp: 'w2', metric: 'malformedModelResponses', couldRegress: [], falsifiedIf: 'f2', affectedModules: ['lib/agent/planner.mjs'], risk: 'low', kind: 'prompt'}
    ],
    ...overrides
  };
}

test('parseRetro accepts a well-formed raw object matching RETRO_SCHEMA and bounds/sanitizes every free-text field', () => {
  const raw = validRaw();
  const retro = parseRetro(raw);
  assert.equal(retro.next.length, 2);
  assert.equal(retro.lessons.length, 3);
  assert.equal(retro.whatWorked[0].pattern, raw.whatWorked[0].pattern);
});

test('parseRetro throws code RETRO_SCHEMA for a shape violation (too few lessons, too few next entries, bad enum)', () => {
  assert.throws(() => parseRetro(validRaw({lessons: [{text: 'only one', evidence: []}]})), err => err.code === 'RETRO_SCHEMA');
  assert.throws(() => parseRetro(validRaw({next: [validRaw().next[0]]})), err => err.code === 'RETRO_SCHEMA');
  assert.throws(() => parseRetro(validRaw({next: [{...validRaw().next[0], risk: 'extreme'}, validRaw().next[1]]})), err => err.code === 'RETRO_SCHEMA');
  assert.throws(() => parseRetro(validRaw({next: [{...validRaw().next[0], kind: 'not_a_real_kind'}, validRaw().next[1]]})), err => err.code === 'RETRO_SCHEMA');
  assert.throws(() => parseRetro(null), err => err.code === 'RETRO_SCHEMA');
});

test('parseRetro drops a next entry whose hypothesisKey matches a rejected strategy, unless proposedChange names a mechanism', () => {
  const raw = validRaw();
  const rejectedStrategies = [{hypothesisKey: 'recovery_policy:rate_limit:honour_retry_after', reason: 'tried already'}];
  const withoutMechanism = parseRetro(raw, rejectedStrategies);
  assert.equal(withoutMechanism.next.length, 1);
  assert.equal(withoutMechanism.next[0].hypothesisKey, 'prompt:planner:clarify_schema_fields');

  const withMechanism = parseRetro(validRaw({next: [{...validRaw().next[0], proposedChange: 'mechanism: read the header, not the fixed table'}, validRaw().next[1]]}), rejectedStrategies);
  assert.equal(withMechanism.next.length, 2);
});

test('RETRO_SCHEMA names the exact 13 next.kind values from the contract', () => {
  assert.deepEqual([...RETRO_SCHEMA.properties.next.items.properties.kind.enum].sort(), ['adapter', 'breaker', 'classification', 'evaluation', 'governance', 'observability', 'prompt', 'reconciliation', 'recovery_policy', 'resume', 'routing', 'tool_description', 'verification'].sort());
});

test('runRetro with inference:null never calls a model, and returns deterministic-only shape with empty lessons and template next entries', async () => {
  const stats = buildRetroStats({
    runs: [run(), run({runId: 'run_2'})],
    incidents: [incident({incidentId: 'inc_a', runId: 'run_1', attemptNumber: 3}), incident({incidentId: 'inc_b', runId: 'run_2', attemptNumber: 3})]
  }, null);
  // Make the family exhausted so the transient_provider template rule fires.
  stats.repeatedFamilies[0].attemptsExhausted = true;
  const {retro, skipped} = await runRetro({inference: null, stats, memoryProjection: {}, rejectedStrategies: []});
  assert.equal(skipped, 'no model');
  assert.deepEqual(retro.whatWorked, []);
  assert.deepEqual(retro.whatFailed, []);
  assert.deepEqual(retro.lessons, []);
  assert.ok(retro.next.length >= 1);
  assert.equal(retro.next[0].hypothesisKey, 'recovery_policy:transient_provider:max_attempts_4');
});

test('runRetro with an inference function calls it with {system, prompt, schema, stage} and parses the result', async () => {
  let captured = null;
  const inference = async request => { captured = request; return {result: validRaw(), model: 'fixture'}; };
  const {retro, skipped} = await runRetro({inference, stats: {}, memoryProjection: {}, rejectedStrategies: []});
  assert.equal(skipped, false);
  assert.equal(retro.next.length, 2);
  assert.equal(captured.stage, 'retro');
  assert.equal(captured.schema, RETRO_SCHEMA);
  assert.equal(typeof captured.system, 'string');
  assert.equal(typeof captured.prompt, 'string');
});
