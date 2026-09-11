// Owns: turning sanitized incidents into failure families, and failure families into regression scenarios via a
// fixed, hand-written table (never model-generated: a regression file is the loop's own ground truth). Contract:
// docs/AGENT_LEARNING_LOOP.md section 8, docs/AGENT_SELF_HEALING.md section 2 (family = `integration:failureClass:tool`).
import { createHash } from 'node:crypto';
import { FAILURE_CLASSES } from './taxonomy.mjs';

// Not exported by eval/scenarios.mjs (it is a local const there), so this is a literal copy; the contract names
// this exact string ("the GOAL_REFUND goal string from eval/scenarios.mjs"). If eval/scenarios.mjs's copy ever
// changes, this one has to change with it by hand — flagged in this lane's report as a cross-lane fragility, since
// agent-learning/lib is not allowed to edit eval/scenarios.mjs to export it.
const GOAL_REFUND = 'Acme cancellation: refund the last payment, mark the CRM lead unqualified, and email confirmation.';

function sha256(text) { return createHash('sha256').update(text).digest('hex'); }

// Recursively sorts object keys before stringifying, so two objects with the same data in a different key order
// fingerprint identically.
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

// sha256 over the sorted {goal, fixtures, faults, dashclaw, model} of a scenario: the identity of a regression
// case, independent of its id, name, status or evidence trail.
export function fingerprintOf(scenario) {
  const subset = { goal: scenario.goal ?? '', fixtures: scenario.fixtures ?? {}, faults: scenario.faults ?? {}, dashclaw: scenario.dashclaw ?? {}, model: scenario.model ?? {} };
  return sha256(stableStringify(subset));
}

// A recovery attempt that ran out of road: the runtime gave up, not just failed once. Used to decide
// attemptsExhausted and (with the policy's own attempt ceiling) how many times a regression fault should fire.
const EXHAUSTED_RESULTS = new Set(['retried_failed', 'stopped_partial', 'stopped_uncertain', 'failed_closed', 'breaker_opened']);
// docs/AGENT_SELF_HEALING.md section 4: transient_provider writes retry up to 3 times before giving up.
const TRANSIENT_PROVIDER_MAX_ATTEMPTS = 3;

export function incidentsToFamilies(incidents = [], runs = []) {
  const runById = new Map((runs || []).map(r => [r.runId, r]));
  const groups = new Map();
  const knownClasses = new Set(FAILURE_CLASSES);
  for (const incident of incidents) {
    if (!incident) continue;
    if (!knownClasses.has(incident.failureClass)) continue; // unknown failureClass: not in the frozen taxonomy, never grouped into a family
    const key = incident.family || `${incident.integration}:${incident.failureClass}:${incident.tool}`;
    if (!groups.has(key)) groups.set(key, { key, integration: incident.integration, failureClass: incident.failureClass, tool: incident.tool, incidents: [] });
    groups.get(key).incidents.push(incident);
  }
  const families = [];
  for (const group of groups.values()) {
    const runIds = [...new Set(group.incidents.map(i => i.runId).filter(Boolean))];
    const incidentIds = [...new Set(group.incidents.map(i => i.incidentId).filter(Boolean))];
    const firstTimes = group.incidents.map(i => i.at || runById.get(i.runId)?.createdAt).filter(Boolean).sort();
    const lastTimes = group.incidents.map(i => i.updatedAt || i.at || runById.get(i.runId)?.createdAt).filter(Boolean).sort();
    const dispositions = {};
    for (const i of group.incidents) { const d = i.finalDisposition || 'pending'; dispositions[d] = (dispositions[d] || 0) + 1; }
    const maxAttemptNumber = group.incidents.reduce((max, i) => Math.max(max, i.attemptNumber || 0), 0);
    const attemptsExhausted = group.incidents.some(i => EXHAUSTED_RESULTS.has(i.recoveryResult)) || maxAttemptNumber >= TRANSIENT_PROVIDER_MAX_ATTEMPTS;
    families.push({
      key: group.key, integration: group.integration, failureClass: group.failureClass, tool: group.tool,
      count: group.incidents.length, runIds, incidentIds,
      firstSeen: firstTimes[0] || null, lastSeen: lastTimes.at(-1) || null,
      attemptsExhausted, dispositions,
      // Not in the contract's field list verbatim, but familyToRegression needs it (section 8: "times:<max observed
      // attemptNumber, minimum 3>") and familyToRegression only receives the family, not the raw incidents.
      maxAttemptNumber
    });
  }
  return families.sort((a, b) => (b.count - a.count) || a.key.localeCompare(b.key));
}

// One builder per family key (exact) or `${integration}:${failureClass}:*` (wildcard on tool). Returns
// {faults, dashclaw, model?, expect} or null (the family does not qualify, e.g. attempts not yet exhausted); the
// goal and fingerprint are filled in by familyToRegression, not here.
export const REDUCTION_TABLE = {
  'hubspot:transient_provider:hubspot.update_customer': family => !family.attemptsExhausted ? null : ({
    faults: { 'hubspot.updateContact': { kind: 'failTimes', times: Math.max(TRANSIENT_PROVIDER_MAX_ATTEMPTS, family.maxAttemptNumber || 0) } },
    dashclaw: { approvalScript: 'approve' },
    expect: { status: 'completed', writes: { duplicate: 0, verified: 3 }, approvals: { decision: 'approved' }, recovered: true, noSuccessClaim: true, state: { refunds: 1 } }
  }),
  'stripe:response_lost:stripe.refund_payment': () => ({
    faults: { 'stripe.createRefund': 'lostAfterSuccess' },
    dashclaw: { approvalScript: 'approve' },
    expect: { status: 'completed', writes: { duplicate: 0, verified: 3 }, approvals: { decision: 'approved' }, recovered: true, noSuccessClaim: true, state: { refunds: 1 }, callCounts: { 'stripe.createRefund': 1 } }
  }),
  'gmail:response_lost:gmail.send_message': () => ({
    faults: { 'gmail.send': 'lostAfterSuccess' },
    dashclaw: { approvalScript: 'approve' },
    expect: { status: 'completed', writes: { duplicate: 0, verified: 3 }, approvals: { decision: 'approved' }, recovered: true, noSuccessClaim: true, state: { sent: 1 } }
  }),
  'hubspot:rate_limit:hubspot.update_customer': () => ({
    faults: { 'hubspot.updateContact': { kind: 'rateLimit', times: 1, retryAfterMs: 50 } },
    dashclaw: { approvalScript: 'approve' },
    expect: { status: 'completed', writes: { duplicate: 0, verified: 3 }, approvals: { decision: 'approved' }, recovered: true, noSuccessClaim: true }
  }),
  // Verified against the current tree (docs/AGENT_LEARNING_LOOP.md's own instruction): with no recovery.mjs-driven
  // fail-closed path wired into effects.mjs yet, an unrecovered AUTH failure on the refund write ends the run
  // `failed` (no verified effect, no refusal recorded either), not `partial` or `blocked` as the contract's prose
  // guessed. Recorded as observed, per the contract's own instruction to do exactly that.
  'stripe:authentication_expired:*': () => ({
    faults: { 'stripe.createRefund': 'authExpired' },
    dashclaw: { approvalScript: 'approve' },
    expect: { status: 'failed', writes: { duplicate: 0 }, approvals: { decision: 'approved' }, recovered: false, noSuccessClaim: true }
  }),
  'dashclaw:dashclaw_unavailable:*': () => ({
    faults: {},
    dashclaw: { approvalScript: 'none', unavailableOnLabel: 'Write: stripe.refund_payment' },
    expect: { status: 'blocked', writes: { duplicate: 0 }, approvals: { decision: null }, recovered: false, noSuccessClaim: true, callCounts: { 'stripe.createRefund': 0 } }
  })
};

function lookupBuilder(family) {
  return REDUCTION_TABLE[family.key] || REDUCTION_TABLE[`${family.integration}:${family.failureClass}:*`] || null;
}

const slug = value => String(value).replace(/[^a-z0-9]+/gi, '_').toLowerCase().replace(/^_+|_+$/g, '');

// Returns a regression scenario object per docs/AGENT_LEARNING_LOOP.md section 8, minus `set` (assignSet decides
// that separately, since it needs the existing corpus, which this function does not receive), or null when the
// family has no mapping in REDUCTION_TABLE or does not yet qualify (e.g. attempts not exhausted).
export function familyToRegression(family, { learnRunId = null, now = () => new Date().toISOString() } = {}) {
  const builder = lookupBuilder(family);
  const shaped = builder ? builder(family) : null;
  if (!shaped) return null;
  const base = { goal: GOAL_REFUND, fixtures: shaped.fixtures || {}, faults: shaped.faults || {}, dashclaw: shaped.dashclaw || {}, model: shaped.model || {} };
  const fingerprint = fingerprintOf(base);
  return {
    id: `reg_${slug(family.key)}_${fingerprint.slice(0, 4)}`,
    name: `${family.key} (${family.count} incident${family.count === 1 ? '' : 's'})`,
    status: 'proposed', family: family.key,
    source: { incidentIds: family.incidentIds || [], runIds: family.runIds || [], learnRunId, createdAt: now() },
    fingerprint, ...base,
    expect: { ...shaped.expect, writes: { ...(shaped.expect.writes || {}), duplicate: 0 }, noSuccessClaim: true }
  };
}

// dev|holdout: the first case ever recorded for a family goes to dev (the generator must see it); the second
// distinct case goes to holdout, so a family with two or more cases always has a holdout one (docs/AGENT_LEARNING_LOOP.md
// section 8). A third and later case alternates by the parity of the new case's own fingerprint (the caller passes
// it in; falls back to the existing-count parity when no fingerprint is given, still deterministic).
export function assignSet(family, existingCorpus = { dev: [], holdout: [] }, fingerprint = null) {
  const existing = [...(existingCorpus.dev || []), ...(existingCorpus.holdout || [])].filter(r => r.family === family.key);
  if (existing.length === 0) return 'dev';
  if (existing.length === 1) return 'holdout';
  const parity = fingerprint
    ? parseInt(sha256(fingerprint).slice(0, 8), 16) % 2
    : existing.length % 2;
  return parity === 0 ? 'dev' : 'holdout';
}
