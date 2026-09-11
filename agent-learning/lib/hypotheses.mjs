// Owns: turning a retro's NEXT entries, deterministic template rules over failure families, and prior-guidance
// ideas from next_loop.json into one deduped list of candidate hypotheses, each classified for whether it touches
// governed code. Nothing here writes a worktree or an edit; that is candidates.mjs (a different lane). Contract:
// docs/AGENT_LEARNING_LOOP.md section 7 (first half: proposeHypotheses, governanceTouch, dedupeAgainstRejected).
import { PROTECTED_FILES } from './incumbent.mjs';
import { PROTECTED_FILES as GOVERNANCE_BAN_FILES } from './candidates.mjs';
import { assertNoInstruction } from './sanitize.mjs';

// Mirrors candidates.mjs's own isProtectedFile matching (not exported there): a glob-ending pattern ('…/**') bans a
// whole directory, '.env.*' bans any dotenv variant, everything else is an exact path match.
function isBannedFile(file, patterns) {
  const norm = String(file).replaceAll('\\', '/');
  return patterns.some(pattern => {
    if (pattern.endsWith('/**')) return norm === pattern.slice(0, -3) || norm.startsWith(`${pattern.slice(0, -3)}/`);
    if (pattern === '.env.*') return norm.startsWith('.env.');
    return norm === pattern;
  });
}

// "Repeated" is buildRetroStats's own definition (docs/AGENT_LEARNING_LOOP.md section 6): count >= 2 across >= 2
// distinct runs. Template rules reuse it so a family the retro would call "repeated" is exactly the set that also
// earns a template hypothesis when there is no model to propose one.
function repeated(family) {
  return (family.count || 0) >= 2 && new Set(family.runIds || []).size >= 2;
}

// One rule per deterministic pattern; `condition` decides whether a family qualifies, `build` shapes the hypothesis
// fields (everything a retro NEXT entry carries except hypothesisKey/kind/affectedModules, which are fixed here).
export const TEMPLATE_RULES = [
  {
    id: 'transient_provider_max_attempts',
    condition: family => family.failureClass === 'transient_provider' && family.attemptsExhausted === true,
    build: family => ({
      hypothesisKey: 'recovery_policy:transient_provider:max_attempts_4',
      kind: 'recovery_policy', affectedModules: ['lib/agent/recovery.mjs'],
      problem: `${family.key} exhausted its retry budget in ${family.count} incident(s) before recovering.`,
      proposedChange: 'Raise transient_provider writes.maxAttempts from 3 to 4 in RECOVERY_POLICY.',
      whyItMayHelp: 'A fourth attempt costs one more round trip and the failures observed cleared within a few tries.',
      metric: 'successfulRecoveries', couldRegress: [], falsifiedIf: 'The dev regression for this family still fails at 4 attempts.',
      risk: 'low'
    })
  },
  {
    id: 'rate_limit_retry_after',
    condition: family => family.failureClass === 'rate_limit' && repeated(family),
    build: family => ({
      hypothesisKey: 'recovery_policy:rate_limit:honour_retry_after',
      kind: 'recovery_policy', affectedModules: ['lib/agent/recovery.mjs'],
      problem: `${family.key} repeated across ${new Set(family.runIds || []).size} runs.`,
      proposedChange: 'Honour the provider Retry-After header before the next attempt instead of the fixed backoff table.',
      whyItMayHelp: 'A rate limit clears on its own schedule; waiting the provider-stated delay avoids a wasted retry.',
      metric: 'successfulRecoveries', couldRegress: [], falsifiedIf: 'The dev regression for this family still fails after honouring Retry-After.',
      risk: 'low'
    })
  },
  {
    id: 'malformed_model_output_clarify_schema',
    condition: family => family.failureClass === 'malformed_model_output' && repeated(family),
    build: family => ({
      hypothesisKey: 'prompt:planner:clarify_schema_fields',
      kind: 'prompt', affectedModules: ['lib/agent/planner.mjs'],
      problem: `${family.key} repeated across ${new Set(family.runIds || []).size} runs.`,
      proposedChange: 'Clarify the plan schema field descriptions in the planner system prompt.',
      whyItMayHelp: 'A malformed plan usually names the wrong field or shape; a clearer schema description reduces that.',
      metric: 'malformedModelResponses', couldRegress: [], falsifiedIf: 'The malformed-output rate is unchanged on the dev corpus.',
      risk: 'low'
    })
  },
  {
    id: 'unknown_external_state_extra_reads',
    condition: family => family.failureClass === 'unknown_external_state' && repeated(family),
    build: family => ({
      hypothesisKey: `reconciliation:${family.integration}:extra_reads`,
      kind: 'reconciliation', affectedModules: ['lib/agent/effects.mjs'],
      problem: `${family.key} reconciled to "unknown" repeatedly, in ${new Set(family.runIds || []).size} runs.`,
      proposedChange: `Add one more reconciliation read for ${family.integration} before giving up and reporting uncertain.`,
      whyItMayHelp: 'An extra read narrows the window where provider state is genuinely unknowable.',
      metric: 'uncertainFinalStates', couldRegress: [], falsifiedIf: 'The uncertain rate for this family is unchanged on the dev corpus.',
      risk: 'medium'
    })
  }
];

// True when a hypothesis touches governed code: its own kind is 'governance', or any module it names is on either
// the incumbent's protected-region file list or candidates.mjs's full governance ban list (imported, never
// duplicated, so this lane and the candidate lane cannot drift apart on what counts as governed).
function classifyGovernanceTouch(hypothesis) {
  if (hypothesis.kind === 'governance') return { touched: true, files: [], regions: [], why: 'kind is governance' };
  const modules = hypothesis.affectedModules || [];
  const bannedHit = modules.filter(file => isBannedFile(file, GOVERNANCE_BAN_FILES));
  const regionHit = modules.filter(file => PROTECTED_FILES.includes(file));
  const files = [...new Set([...bannedHit, ...regionHit])];
  if (files.length) return { touched: true, files, regions: regionHit, why: `touches protected file(s): ${files.join(', ')}` };
  return { touched: false, files: [], regions: [], why: '' };
}

// A hypothesis whose hypothesisKey matches a rejected strategy is dropped unless its proposedChange names a
// different mechanism ("mechanism:" substring), mirroring retro.mjs's parseRetro rule (section 6) so a hypothesis
// arriving from a template or next_loop.json gets the same protection a retro NEXT entry gets.
function survivesRejection(hypothesis, rejectedStrategies) {
  const rejection = (rejectedStrategies || []).find(r => r.hypothesisKey === hypothesis.hypothesisKey);
  if (!rejection) return true;
  return typeof hypothesis.proposedChange === 'string' && hypothesis.proposedChange.includes('mechanism:');
}

function safe(text) {
  try { assertNoInstruction(text); return true; } catch { return false; }
}

// retro.next entries: already shaped like a hypothesis minus hypothesisKey's source tag. Every free-text field is
// re-checked with assertNoInstruction before it can reach a candidate prompt; a failing entry is dropped, not thrown.
function fromRetro(retro) {
  if (!retro || retro.skipped || !Array.isArray(retro.next)) return [];
  return retro.next
    .filter(entry => entry && typeof entry.hypothesisKey === 'string')
    .filter(entry => [entry.problem, entry.proposedChange, entry.whyItMayHelp, entry.falsifiedIf].every(text => text === undefined || safe(text)))
    .map(entry => ({ ...entry, source: 'retro' }));
}

function fromTemplates(families) {
  const out = [];
  for (const family of families || []) {
    for (const rule of TEMPLATE_RULES) {
      if (rule.condition(family)) out.push({ ...rule.build(family), source: 'template' });
    }
  }
  return out;
}

// next_loop.json's candidateIdeas ({hypothesisKey, summary, kind}) and recommendedNextExperiment
// ({hypothesisKey, summary, falsifiedIf}) are prior guidance, not a full retro entry; missing fields default to the
// least committal value so downstream code that expects the full shape never sees `undefined`.
function fromNextLoop(nextLoop) {
  if (!nextLoop) return [];
  const out = [];
  for (const idea of nextLoop.candidateIdeas || []) {
    if (!idea || typeof idea.hypothesisKey !== 'string' || !safe(idea.summary)) continue;
    out.push({
      hypothesisKey: idea.hypothesisKey, kind: idea.kind || 'observability', affectedModules: [],
      problem: idea.summary || '', proposedChange: idea.summary || '', whyItMayHelp: '', metric: '',
      couldRegress: [], falsifiedIf: '', risk: 'medium', source: 'next_loop'
    });
  }
  const rec = nextLoop.recommendedNextExperiment;
  if (rec && typeof rec.hypothesisKey === 'string' && safe(rec.summary) && safe(rec.falsifiedIf)) {
    out.push({
      hypothesisKey: rec.hypothesisKey, kind: 'observability', affectedModules: [],
      problem: rec.summary || '', proposedChange: rec.summary || '', whyItMayHelp: '', metric: '',
      couldRegress: [], falsifiedIf: rec.falsifiedIf || '', risk: 'medium', source: 'next_loop'
    });
  }
  return out;
}

// proposeHypotheses({retro, families, memory, nextLoop, max}) -> [{hypothesisKey, ...retro-next-entry fields,
// source, governanceTouch}]. Priority order when two sources propose the same hypothesisKey: retro (a model that
// saw this run's own evidence), then template (deterministic, always available), then next_loop (prior guidance,
// untested this run) — the first occurrence wins, later duplicates are dropped silently (same idea, redundant source).
export function proposeHypotheses({ retro = null, families = [], memory = {}, nextLoop = null, max = Infinity } = {}) {
  const candidates = [...fromRetro(retro), ...fromTemplates(families), ...fromNextLoop(nextLoop)];
  const rejectedStrategies = memory.rejectedStrategies || [];

  const seen = new Set();
  const out = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.hypothesisKey)) continue;
    if (!survivesRejection(candidate, rejectedStrategies)) continue;
    seen.add(candidate.hypothesisKey);
    out.push({ ...candidate, governanceTouch: classifyGovernanceTouch(candidate) });
    if (out.length >= max) break;
  }
  return out;
}
