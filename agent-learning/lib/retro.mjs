// Owns: the retrospective stage. Deterministic stats first (no model needed, runs in every mode), then the model
// half: a prompt built only from sanitized, bounded inputs, a fixed output schema, and a parser that validates and
// applies the do-not-repeat rule. Contract: docs/AGENT_LEARNING_LOOP.md section 6.
import { incidentsToFamilies } from './reduce.mjs';
import { TEMPLATE_RULES } from './hypotheses.mjs';
import { sanitizeText, sanitizeForPrompt } from './sanitize.mjs';
import { FAILURE_CLASSES } from './taxonomy.mjs';

const KNOWN_FAILURE_CLASSES = new Set(FAILURE_CLASSES);

// docs/AGENT_SELF_HEALING.md section 3's 23 classes, bucketed to the five attribution categories the contract
// names explicitly (model, external, governance, person) with everything else falling to `integration`, the
// bucket the contract describes as "adapter-classified faults" — the classes effects.mjs/tools.mjs derive from
// provider-specific detail (sentRequest, NOT_FOUND, a mismatch) rather than a raw HTTP status or a person's
// decision. This mapping is this module's own interpretation of an underspecified table; a worker who disagrees
// reports it, per the contract's own preamble.
const ATTRIBUTION_BY_CLASS = {
  malformed_model_output: 'model', unsupported_tool_request: 'model', precondition_refused: 'model', model_transport_failure: 'model',
  transient_provider: 'external', rate_limit: 'external', authentication_expired: 'external',
  dashclaw_unavailable: 'governance', dashclaw_block: 'governance',
  approval_denied: 'person', approval_expired: 'person', user_cancellation: 'person',
  timeout_before_request: 'integration', timeout_during_request: 'integration', response_lost: 'integration',
  provider_state_conflict: 'integration', stale_entity_state: 'integration', ambiguous_identity: 'integration',
  verification_mismatch: 'integration', duplicate_effect_detected: 'integration', unknown_external_state: 'integration',
  renderer_interruption: 'integration', local_process_interruption: 'integration'
};

// A terminal incident's recoveryResult tells the retro whether that fault's story ended well. 'reconciled_absent',
// 'asked_user', 'breaker_opened', 'none' and 'pending' are left uncounted here: none of them is unambiguously a
// success or a failure on their own (an absent reconciliation is a step toward a retry, not an outcome).
const RECOVERED_RESULTS = new Set(['recovered', 'reconciled_present']);
const FAILED_RESULTS = new Set(['retried_failed', 'stopped_partial', 'stopped_uncertain', 'failed_closed']);

// "Repeated" matches reduce.mjs / hypotheses.mjs's own definition: count >= 2 across >= 2 distinct runs.
function repeated(family) { return (family.count || 0) >= 2 && new Set(family.runIds || []).size >= 2; }

function median(numbers) {
  const sorted = numbers.filter(n => Number.isFinite(n)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// buildRetroStats(evidence, corpusResults) is pure and deterministic; it runs in every mode, model or not. Nothing
// it returns carries a scenario id: corpusResults contributes only counts and a latency median, never an id or a
// name, which is what lets buildRetroPrompt below carry no holdout scenario however it assembles its text.
export function buildRetroStats(evidence = { runs: [], incidents: [] }, corpusResults = null) {
  const runs = evidence.runs || [];
  const incidents = evidence.incidents || [];

  const byStatus = {};
  for (const run of runs) byStatus[run.status] = (byStatus[run.status] || 0) + 1;

  const byClass = {}, byIntegration = {}, byPhase = {};
  for (const incident of incidents) {
    byClass[incident.failureClass] = (byClass[incident.failureClass] || 0) + 1;
    byIntegration[incident.integration] = (byIntegration[incident.integration] || 0) + 1;
    byPhase[incident.phase] = (byPhase[incident.phase] || 0) + 1;
  }

  // Full family shape (not just key/count): hypotheses.mjs's TEMPLATE_RULES need failureClass/integration/
  // attemptsExhausted/runIds to decide, and runRetro's no-model fallback runs those same rules over this list.
  const repeatedFamilies = incidentsToFamilies(incidents, runs).filter(repeated);

  const recoveries = {};
  for (const incident of incidents) {
    const cls = incident.failureClass;
    recoveries[cls] = recoveries[cls] || { recovered: 0, failed: 0 };
    if (RECOVERED_RESULTS.has(incident.recoveryResult)) recoveries[cls].recovered++;
    else if (FAILED_RESULTS.has(incident.recoveryResult)) recoveries[cls].failed++;
  }

  const attribution = { model: 0, integration: 0, external: 0, governance: 0, person: 0 };
  let unknownFailureClassCount = 0;
  for (const incident of incidents) {
    if (!KNOWN_FAILURE_CLASSES.has(incident.failureClass)) unknownFailureClassCount++;
    attribution[ATTRIBUTION_BY_CLASS[incident.failureClass] || 'integration']++;
  }

  const turns = runs.map(r => r.turn || 0);
  const turnsMedian = median(turns);
  const turnsAboveMedianRunIds = turnsMedian === null ? [] : runs.filter(r => (r.turn || 0) > turnsMedian).map(r => r.runId);

  const preconditionByRun = new Map();
  for (const incident of incidents) {
    if (incident.failureClass !== 'precondition_refused') continue;
    preconditionByRun.set(incident.runId, (preconditionByRun.get(incident.runId) || 0) + 1);
  }
  const avgPreconditionRefusalsPerRun = runs.length ? [...preconditionByRun.values()].reduce((sum, n) => sum + n, 0) / runs.length : 0;

  // A proxy for "repeated identical tool calls": intake keeps only per-run event counts by kind and status, never
  // per-tool detail, so a run whose tool-kind event count outruns its turns by more than one is flagged as a
  // candidate for having called the same tool more than once within a turn's worth of planning.
  const repeatedToolCallRunIds = runs.filter(run => {
    const toolEvents = Object.values(run.events?.tool || {}).reduce((sum, n) => sum + n, 0);
    return toolEvents > (run.turn || 0) + 1;
  }).map(r => r.runId);

  const toolCallsMedian = median(runs.map(r => r.summary?.toolCalls).filter(n => n !== undefined));

  const elapsedValues = [];
  for (const set of [corpusResults?.dev, corpusResults?.holdout]) {
    for (const scenario of set?.scenarios || []) if (Number.isFinite(scenario.elapsedMs)) elapsedValues.push(scenario.elapsedMs);
  }
  const latencyMsMedian = median(elapsedValues);

  return {
    runs: { total: runs.length, byStatus },
    incidents: { total: incidents.length, byClass, byIntegration, byPhase, unknownFailureClassCount },
    repeatedFamilies: repeatedFamilies.map(f => ({ key: f.key, integration: f.integration, failureClass: f.failureClass, tool: f.tool, count: f.count, runIds: f.runIds, attemptsExhausted: f.attemptsExhausted })),
    recoveries, attribution,
    planner: { turnsMedian, turnsAboveMedianRunIds, avgPreconditionRefusalsPerRun, repeatedToolCallRunIds },
    medians: { toolCallsMedian, latencyMsMedian },
    corpus: {
      devPassRate: corpusResults?.dev?.metrics?.scenarioPassRate ?? null, holdoutPassRate: corpusResults?.holdout?.metrics?.scenarioPassRate ?? null,
      devCount: corpusResults?.dev?.scenarios?.length ?? 0, holdoutCount: corpusResults?.holdout?.scenarios?.length ?? 0
    }
  };
}

const NEXT_KINDS = new Set(['prompt', 'tool_description', 'recovery_policy', 'reconciliation', 'verification', 'classification', 'breaker', 'adapter', 'resume', 'evaluation', 'observability', 'routing', 'governance']);

export const RETRO_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    whatWorked: { type: 'array', items: { type: 'object', properties: { pattern: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } } }, required: ['pattern', 'evidence'] } },
    whatFailed: { type: 'array', items: { type: 'object', properties: { familyKey: { type: 'string' }, count: { type: 'integer' }, attribution: { type: 'string' }, note: { type: 'string' } }, required: ['familyKey', 'count', 'attribution', 'note'] } },
    lessons: { type: 'array', minItems: 3, maxItems: 6, items: { type: 'object', properties: { text: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } } }, required: ['text', 'evidence'] } },
    next: {
      type: 'array', minItems: 2, maxItems: 5,
      items: {
        type: 'object',
        properties: {
          hypothesisKey: { type: 'string' }, problem: { type: 'string' }, proposedChange: { type: 'string' }, whyItMayHelp: { type: 'string' },
          metric: { type: 'string' }, couldRegress: { type: 'array', items: { type: 'string' } }, falsifiedIf: { type: 'string' },
          affectedModules: { type: 'array', items: { type: 'string' } }, risk: { type: 'string', enum: ['low', 'medium', 'high'] },
          kind: { type: 'string', enum: [...NEXT_KINDS] }
        },
        required: ['hypothesisKey', 'problem', 'proposedChange', 'whyItMayHelp', 'metric', 'couldRegress', 'falsifiedIf', 'affectedModules', 'risk', 'kind']
      }
    }
  },
  required: ['whatWorked', 'whatFailed', 'lessons', 'next']
};

const BRAINSTORM_RULES = [
  'Differ in kind: propose changes to different modules or mechanisms, not several phrasings of the same idea.',
  'Trade-off first: name what could regress before what could improve.',
  'Lead with the recommendation: state the change, then the reasoning behind it.',
  'YAGNI: no configurability or generality the evidence given does not call for.'
];

// {system, prompt} built only from already-sanitized inputs (stats, the memory projection, rejected-strategy
// summaries): re-sanitized here anyway, defense in depth, since this text is about to leave the process as a model
// prompt. No raw run text, no code, and (see buildRetroStats above) no holdout scenario id ever enters `stats`, so
// none can leak into this prompt either.
export function buildRetroPrompt({ stats = {}, memoryProjection = {}, rejectedStrategies = [] } = {}) {
  const statsText = sanitizeForPrompt(stats, { maxChars: 4000 });
  const memoryText = sanitizeForPrompt(memoryProjection, { maxChars: 3000 });
  const rejectedText = rejectedStrategies.length
    ? rejectedStrategies.map(r => `- ${sanitizeText(r.hypothesisKey || '', { maxChars: 120 })}: ${sanitizeText(r.reason || '', { maxChars: 200 })}`).join('\n')
    : '(none yet)';

  const system = 'You are the retrospective analyst for Sidelook Agent mode\'s offline learning loop. You see only sanitized, aggregate evidence: counts, failure families and medians, never raw traces, retrieved text or code. Ground what worked, what failed, the lessons and the next experiments in the evidence given, nothing else.';

  const prompt = `Deterministic stats from this loop's evidence:
${statsText}

Learning memory projection (confirmed and provisional lessons, open failure families, rejected strategies, planned experiments):
${memoryText}

Do not propose these again unless proposedChange names the mechanism that differs (a "mechanism: ..." phrase):
${rejectedText}

Brainstorming rules:
${BRAINSTORM_RULES.map((rule, i) => `${i + 1}. ${rule}`).join('\n')}

Reply with whatWorked, whatFailed, 3 to 6 lessons and 2 to 5 next experiments of materially different kinds, each grounded in a familyKey, runId or stat from above.`;

  return { system, prompt };
}

function schemaError(field, detail) {
  return Object.assign(new Error(`Retro output ${field} ${detail}.`), { code: 'RETRO_SCHEMA', field });
}

function validateShape(raw) {
  if (!raw || typeof raw !== 'object') throw schemaError('(root)', 'must be an object');
  for (const key of ['whatWorked', 'whatFailed', 'lessons', 'next']) if (!Array.isArray(raw[key])) throw schemaError(key, 'must be an array');
  if (raw.lessons.length < 3 || raw.lessons.length > 6) throw schemaError('lessons', 'must have 3 to 6 items');
  if (raw.next.length < 2 || raw.next.length > 5) throw schemaError('next', 'must have 2 to 5 items');
  for (const item of raw.whatWorked) if (typeof item?.pattern !== 'string' || !Array.isArray(item.evidence)) throw schemaError('whatWorked[]', 'needs pattern (string) and evidence (array)');
  for (const item of raw.whatFailed) if (typeof item?.familyKey !== 'string' || typeof item.count !== 'number' || typeof item.attribution !== 'string' || typeof item.note !== 'string') throw schemaError('whatFailed[]', 'needs familyKey, count, attribution and note');
  for (const item of raw.lessons) if (typeof item?.text !== 'string' || !Array.isArray(item.evidence)) throw schemaError('lessons[]', 'needs text (string) and evidence (array)');
  for (const item of raw.next) {
    for (const field of ['hypothesisKey', 'problem', 'proposedChange', 'whyItMayHelp', 'metric', 'falsifiedIf', 'kind'])
      if (typeof item?.[field] !== 'string') throw schemaError(`next[].${field}`, 'must be a string');
    if (!Array.isArray(item.couldRegress) || !Array.isArray(item.affectedModules)) throw schemaError('next[]', 'needs couldRegress and affectedModules arrays');
    if (!['low', 'medium', 'high'].includes(item.risk)) throw schemaError('next[].risk', 'must be low, medium or high');
    if (!NEXT_KINDS.has(item.kind)) throw schemaError('next[].kind', `must be one of ${[...NEXT_KINDS].join(', ')}`);
  }
}

const boundedText = (text, maxChars) => sanitizeText(typeof text === 'string' ? text : '', { maxChars });

// parseRetro(raw, rejectedStrategies=[]) validates the model's raw structured output against RETRO_SCHEMA (throws
// code RETRO_SCHEMA on a shape violation), re-sanitizes every free-text field, and drops any `next` entry whose
// hypothesisKey matches a rejected strategy unless its proposedChange names a different mechanism. The second
// argument is optional so the function still matches the documented `parseRetro(raw)` call.
export function parseRetro(raw, rejectedStrategies = []) {
  validateShape(raw);
  const whatWorked = raw.whatWorked.map(w => ({ pattern: boundedText(w.pattern, 200), evidence: w.evidence.map(e => boundedText(e, 120)) }));
  const whatFailed = raw.whatFailed.map(w => ({ familyKey: boundedText(w.familyKey, 160), count: w.count, attribution: boundedText(w.attribution, 40), note: boundedText(w.note, 240) }));
  const lessons = raw.lessons.map(l => ({ text: boundedText(l.text, 240), evidence: l.evidence.map(e => boundedText(e, 120)) }));
  const next = raw.next
    .map(n => ({
      hypothesisKey: boundedText(n.hypothesisKey, 120), problem: boundedText(n.problem, 300), proposedChange: boundedText(n.proposedChange, 300),
      whyItMayHelp: boundedText(n.whyItMayHelp, 300), metric: boundedText(n.metric, 80), couldRegress: n.couldRegress.map(c => boundedText(c, 120)),
      falsifiedIf: boundedText(n.falsifiedIf, 240), affectedModules: n.affectedModules.map(m => boundedText(m, 120)), risk: n.risk, kind: n.kind
    }))
    .filter(entry => {
      const rejection = rejectedStrategies.find(r => r.hypothesisKey === entry.hypothesisKey);
      return !rejection || entry.proposedChange.includes('mechanism:');
    });
  return { whatWorked, whatFailed, lessons, next };
}

// Template next-entries for the no-model path: the same TEMPLATE_RULES hypotheses.mjs's proposeHypotheses uses,
// run over buildRetroStats's repeatedFamilies, with the same rejected-strategy protection parseRetro applies.
function templateNextEntries(repeatedFamilies = [], rejectedStrategies = []) {
  const seen = new Set();
  const out = [];
  for (const family of repeatedFamilies) {
    for (const rule of TEMPLATE_RULES) {
      if (!rule.condition(family)) continue;
      const entry = rule.build(family);
      if (seen.has(entry.hypothesisKey)) continue;
      const rejection = rejectedStrategies.find(r => r.hypothesisKey === entry.hypothesisKey);
      if (rejection && !entry.proposedChange.includes('mechanism:')) continue;
      seen.add(entry.hypothesisKey);
      out.push(entry);
    }
  }
  return out;
}

// runRetro({inference, stats, memoryProjection, rejectedStrategies}). `inference` speaks agent-learning/lib/
// inference.mjs's seam: `inference({system, prompt, schema, stage})` -> `{result, model}`, where `result` is
// already the schema-shaped object (real inference parses it; fixture inference returns the canned one). A null
// inference (no model configured) never invents a candidate: the deterministic stats stand, lessons stay empty,
// and `next` comes only from the same template rules the runtime falls back to everywhere else in the loop.
export async function runRetro({ inference, stats, memoryProjection = {}, rejectedStrategies = [] } = {}) {
  if (!inference) {
    return { retro: { whatWorked: [], whatFailed: [], lessons: [], next: templateNextEntries(stats?.repeatedFamilies, rejectedStrategies) }, skipped: 'no model' };
  }
  const { system, prompt } = buildRetroPrompt({ stats, memoryProjection, rejectedStrategies });
  const { result } = await inference({ system, prompt, schema: RETRO_SCHEMA, stage: 'retro' });
  return { retro: parseRetro(result, rejectedStrategies), skipped: false };
}
