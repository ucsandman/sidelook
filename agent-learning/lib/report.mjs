// Owns: turning one learning run's records into the reports a person and the next run read: the terse JSON
// summary, the human markdown page, the durable copies, and next_loop.json. Every number in the markdown comes
// from the records passed in, never from a model's own words. Contract: docs/AGENT_LEARNING_LOOP.md sections 11
// and 12.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Mirrors eval/run.mjs's EMPTY_INVARIANTS() key set, as a local literal rather than an import: pulling in
// eval/run.mjs here would drag its AgentRuntime/DashClaw dependency chain into report.mjs just to read six
// string names. Same tradeoff reduce.mjs made for GOAL_REFUND, and for the same reason.
const SAFETY_INVARIANT_NAMES = ['unclaimedWrites', 'unheldFinancialWrites', 'duplicateEffects', 'incorrectSuccessClaims', 'secretLeaks', 'injectionAuthorized'];

function buildLimitations({ evidence, retro, candidates }) {
  const out = [];
  if (retro?.skipped) out.push(`The retrospective ran without a model (${retro.skipped}); lessons and next experiments came from deterministic templates only.`);
  if (!evidence?.runs?.length) out.push('No runtime evidence was available this loop; families and regressions, if any, come only from prior memory.');
  const unreviewed = candidates.filter(c => c.status === 'promote_eligible' && c.reason === 'unreviewed');
  if (unreviewed.length) out.push(`${unreviewed.length} candidate(s) passed comparison but could not be reviewed and are not eligible for promotion.`);
  if (!candidates.length) out.push('No candidates were generated this loop.');
  return out;
}

// The contract's learning_summary.json (section 11) names a minimum shape (evidence as counts, a candidate row of
// exactly candidateId/hypothesisKey/decision/reason, retro as {lessons, next}); this builds that shape plus the
// extra detail renderReport needs to satisfy "every candidate row links its candidate and evaluation ids" and the
// governance/limitations sections — additions, never a narrowing of what the contract requires. `retro.lessons`
// and `retro.next` are read literally as those two fields of the retro object (the full lesson and next-entry
// arrays), not derived counts: that is what lets "What we learned" and "What to try next" render without a second
// data source.
function buildSummary({ learnRunId, at, mode, incumbent, evidence, reduced = {}, retro, candidates = [], evaluations = [], decisions = [], nextLoop = null }) {
  const decisionByCandidateId = new Map(decisions.map(d => [d.candidateId, d]));
  const evaluationByCandidateId = new Map(evaluations.map(e => [e.candidateId, e]));

  // The candidate's own status is the terminal verdict: review runs after compare (section 10), so a decision record
  // saying promote_eligible is stale the moment review blocks it. A terminal candidate status (rejected_by_review,
  // needs_human_review, invalid, promoted) always wins; only when the candidate is still mid-pipeline does the
  // compare decision stand in. The compare verdict itself is never lost — it rides along as compareDecision.
  const TERMINAL_STATUSES = new Set(['rejected_by_review', 'needs_human_review', 'invalid', 'promoted']);
  const candidateRows = candidates.map(c => {
    const decision = decisionByCandidateId.get(c.candidateId) || null;
    const evaluation = evaluationByCandidateId.get(c.candidateId) || null;
    const finalDecision = TERMINAL_STATUSES.has(c.status) ? c.status : (decision?.decision || c.status);
    return {
      candidateId: c.candidateId, hypothesisKey: c.hypothesisKey, decision: finalDecision,
      compareDecision: decision?.decision || null,
      reason: (decision?.reasons?.length ? decision.reasons.join('; ') : c.reason) || '',
      evaluationId: evaluation?.evaluationId || null,
      governanceTouch: c.governanceTouch || { touched: false, why: '' },
      target: decision?.target || null, holdout: decision?.holdout || null
    };
  });

  const violations = [];
  for (const d of decisions) for (const v of d.invariantViolations || []) violations.push({ candidateId: d.candidateId, ...v });

  const retroBody = retro?.retro || retro || { lessons: [], next: [] };

  return {
    learnRunId, at: at || new Date().toISOString(), mode: mode || 'unknown',
    incumbent: { revision: incumbent?.revision || null, dirty: !!incumbent?.dirty },
    evidence: {
      runs: evidence?.runs?.length || 0, incidents: evidence?.incidents?.length || 0, families: reduced?.families?.length || 0,
      newRegressions: { dev: reduced?.newRegressions?.dev?.length || 0, holdout: reduced?.newRegressions?.holdout?.length || 0 }
    },
    retro: { lessons: retroBody.lessons || [], next: retroBody.next || [], skipped: retro?.skipped ?? false },
    candidates: candidateRows,
    promoted: candidates.filter(c => c.status === 'promoted').map(c => c.candidateId),
    safetyChecks: { ran: SAFETY_INVARIANT_NAMES, violations },
    nextExperiment: nextLoop?.recommendedNextExperiment || null,
    governanceChanges: candidateRows.filter(c => c.governanceTouch?.touched),
    missingRegressionCoverage: reduced?.missingRegressionCoverage || [],
    limitations: buildLimitations({ evidence, retro, candidates })
  };
}

function mdList(items, empty) {
  return items.length ? items.map(i => `- ${i}`).join('\n') : empty;
}

// Pure and exported so a test can check section presence and that every number traces to `summary`, without
// needing a filesystem or the rest of the loop.
export function renderReport(summary) {
  const s = summary;
  const lines = [];
  lines.push(`# Learning run ${s.learnRunId}`, '', `Mode: ${s.mode} · Incumbent: \`${s.incumbent.revision || 'unknown'}\`${s.incumbent.dirty ? ' (dirty)' : ''} · Generated ${s.at}`, '');

  lines.push('## What happened');
  lines.push(`${s.evidence.runs} run(s) and ${s.evidence.incidents} incident(s) read, reduced to ${s.evidence.families} failure famil${s.evidence.families === 1 ? 'y' : 'ies'}; ${s.evidence.newRegressions.dev} new dev regression(s) and ${s.evidence.newRegressions.holdout} new holdout regression(s) proposed. ${s.candidates.length} candidate(s) tried this run.`, '');

  lines.push('## What failed');
  lines.push(mdList(s.candidates.filter(c => c.decision === 'rejected' || c.decision === 'rejected_by_review').map(c => `\`${c.candidateId}\` (${c.hypothesisKey}): ${c.reason}`), 'No candidate was rejected this run.'), '');

  lines.push('## What we learned');
  lines.push(mdList(s.retro.lessons.map(l => l.text), 'No lessons recorded this run.'), '');

  lines.push('## Candidates tried');
  lines.push(s.candidates.length
    ? s.candidates.map(c => `- \`${c.candidateId}\` (${c.hypothesisKey}): **${c.decision}** — ${c.reason || 'no reason recorded'}${c.evaluationId ? ` (\`${c.evaluationId}\`)` : ''}`).join('\n')
    : 'No candidates were generated this run.', '');

  lines.push('## Which candidate won and why');
  const winners = s.candidates.filter(c => c.decision === 'promote_eligible');
  lines.push(winners.length
    ? winners.map(c => `- \`${c.candidateId}\` (${c.hypothesisKey}): target ${JSON.stringify(c.target)}, holdout ${JSON.stringify(c.holdout)} (\`${c.evaluationId || 'no evaluation id'}\`)`).join('\n')
    : 'No candidate was promote-eligible this run.', '');

  lines.push('## Safety checks that ran');
  lines.push(`Checked: ${s.safetyChecks.ran.join(', ')}.`);
  lines.push(s.safetyChecks.violations.length
    ? s.safetyChecks.violations.map(v => `- \`${v.candidateId}\`: ${v.invariant} at ${v.where} (count ${v.count})`).join('\n')
    : 'No new safety invariant violations.', '');

  lines.push('## Was anything promoted');
  lines.push(s.promoted.length ? s.promoted.map(id => `- \`${id}\``).join('\n') : 'Nothing was promoted this run.', '');

  lines.push('## What to try next');
  lines.push(s.retro.next.length
    ? s.retro.next.map(n => `- **${n.hypothesisKey}** (${n.kind}, risk ${n.risk}): ${n.proposedChange}`).join('\n')
    : 'No next experiments were proposed.', '');
  if (s.nextExperiment) lines.push('', `Recommended: **${s.nextExperiment.hypothesisKey}** — ${s.nextExperiment.summary}`);
  lines.push('');

  lines.push('## Governance changes recommended for human review');
  lines.push(s.governanceChanges.length
    ? s.governanceChanges.map(c => `- \`${c.candidateId}\` (${c.hypothesisKey}): ${c.governanceTouch.why}`).join('\n')
    : 'No candidate touched governed code this run.', '');

  lines.push('## Limitations');
  lines.push(mdList(s.limitations, 'None recorded.'));

  return lines.join('\n');
}

const NEXT_LOOP_CAPS = { priorityFailureFamilies: 8, confirmedLessons: 10, candidateIdeas: 6, rejectedIdeas: 10, evaluationWeaknesses: 6, missingRegressionCoverage: 8 };
const NEXT_LOOP_MAX_CHARS = 8000;

// buildNextLoop per docs/AGENT_LEARNING_LOOP.md section 12. `retro` accepts either runRetro's {retro, skipped}
// wrapper or a bare retro object, matching how writeReports and the tests both hand it around.
export function buildNextLoop({ learnRunId, incumbentRevision, memory = {}, families = [], retro = null, candidates = [], decisions = [], missingRegressionCoverage = [], evaluationWeaknesses = [], now = () => new Date().toISOString() } = {}) {
  const retroBody = retro?.retro || retro || { next: [] };
  const madeThisRun = new Set(candidates.map(c => c.hypothesisKey));
  // Ideas the retro proposed but that did not become a candidate this run: still worth trying next time.
  const carriedNextEntries = (retroBody.next || []).filter(n => !madeThisRun.has(n.hypothesisKey));

  const decisionByCandidateId = new Map(decisions.map(d => [d.candidateId, d]));
  const rejectedIdeas = [];
  for (const candidate of candidates) {
    const decision = decisionByCandidateId.get(candidate.candidateId);
    const isRejected = decision?.decision === 'rejected' || candidate.status === 'rejected' || candidate.status === 'rejected_by_review';
    if (!isRejected) continue;
    const reason = decision?.reasons?.length ? decision.reasons.join('; ') : (candidate.reason || 'rejected');
    rejectedIdeas.push({ hypothesisKey: candidate.hypothesisKey, reason });
  }

  const priorityFailureFamilies = [...families].sort((a, b) => (b.count || 0) - (a.count || 0)).slice(0, NEXT_LOOP_CAPS.priorityFailureFamilies)
    .map(f => ({ key: f.key, count: f.count || 0, status: f.status || 'open', regressionIds: f.regressionIds || [] }));

  const confirmedLessons = (memory.lessons || []).filter(l => l.status === 'confirmed').map(l => l.text).slice(0, NEXT_LOOP_CAPS.confirmedLessons);
  const candidateIdeas = carriedNextEntries.slice(0, NEXT_LOOP_CAPS.candidateIdeas).map(n => ({ hypothesisKey: n.hypothesisKey, summary: n.proposedChange || n.problem || '', kind: n.kind }));
  const recommendedNextExperiment = carriedNextEntries.length
    ? { hypothesisKey: carriedNextEntries[0].hypothesisKey, summary: carriedNextEntries[0].proposedChange || carriedNextEntries[0].problem || '', falsifiedIf: carriedNextEntries[0].falsifiedIf || '' }
    : null;

  const nextLoop = {
    schemaVersion: 1, generatedAt: now(), learnRunId, incumbentRevision,
    priorityFailureFamilies, confirmedLessons, candidateIdeas,
    rejectedIdeas: rejectedIdeas.slice(0, NEXT_LOOP_CAPS.rejectedIdeas),
    evaluationWeaknesses: evaluationWeaknesses.slice(0, NEXT_LOOP_CAPS.evaluationWeaknesses),
    missingRegressionCoverage: missingRegressionCoverage.slice(0, NEXT_LOOP_CAPS.missingRegressionCoverage),
    recommendedNextExperiment, bounds: { maxChars: NEXT_LOOP_MAX_CHARS }
  };

  // Trim from the back of the least-critical arrays until the file fits its own stated bound, same pattern as
  // memory.mjs's projectForPrompt.
  while (JSON.stringify(nextLoop).length > NEXT_LOOP_MAX_CHARS) {
    if (nextLoop.rejectedIdeas.length) nextLoop.rejectedIdeas.pop();
    else if (nextLoop.missingRegressionCoverage.length) nextLoop.missingRegressionCoverage.pop();
    else if (nextLoop.evaluationWeaknesses.length) nextLoop.evaluationWeaknesses.pop();
    else if (nextLoop.candidateIdeas.length) nextLoop.candidateIdeas.pop();
    else if (nextLoop.priorityFailureFamilies.length) nextLoop.priorityFailureFamilies.pop();
    else if (nextLoop.confirmedLessons.length) nextLoop.confirmedLessons.pop();
    else break;
  }
  return nextLoop;
}

// writeReports({out, durableDir, learnRunId, mode, incumbent, evidence, reduced, retro, candidates, evaluations,
// decisions, memory, nextLoop}): writes the five per-run files into `out`, and, when `durableDir` is given, copies
// the durable ones into its committed subfolders (agent-learning/retros, /candidates, /evaluations, and
// next_loop.json at its root — the layout docs/AGENT_LEARNING_LOOP.md section 1 names). Returns the summary object
// it wrote, so a caller (or a test) never has to re-read the file to see what was reported.
export async function writeReports({ out, durableDir = null, learnRunId, mode, at, incumbent, evidence, reduced = {}, retro, candidates = [], evaluations = [], decisions = [], nextLoop } = {}) {
  if (!out) throw new Error('writeReports needs an out directory.');
  if (!learnRunId) throw new Error('writeReports needs a learnRunId.');

  const summary = buildSummary({ learnRunId, at, mode, incumbent, evidence, reduced, retro, candidates, evaluations, decisions, nextLoop });
  const reportMd = renderReport(summary);

  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'learning_summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  await writeFile(join(out, 'learning_report.md'), reportMd, 'utf8');
  await writeFile(join(out, 'retro.json'), JSON.stringify(retro, null, 2), 'utf8');
  await writeFile(join(out, 'candidate_results.json'), JSON.stringify({ candidates, evaluations, decisions }, null, 2), 'utf8');
  await writeFile(join(out, 'next_loop.json'), JSON.stringify(nextLoop, null, 2), 'utf8');

  if (durableDir) {
    await mkdir(join(durableDir, 'retros'), { recursive: true });
    await writeFile(join(durableDir, 'retros', `retro-${learnRunId}.json`), JSON.stringify(retro, null, 2), 'utf8');
    await mkdir(join(durableDir, 'candidates'), { recursive: true });
    for (const candidate of candidates) await writeFile(join(durableDir, 'candidates', `${candidate.candidateId}.json`), JSON.stringify(candidate, null, 2), 'utf8');
    await mkdir(join(durableDir, 'evaluations'), { recursive: true });
    for (const evaluation of evaluations) await writeFile(join(durableDir, 'evaluations', `${evaluation.evaluationId}.json`), JSON.stringify(evaluation, null, 2), 'utf8');
    await writeFile(join(durableDir, 'next_loop.json'), JSON.stringify(nextLoop, null, 2), 'utf8');
  }

  return summary;
}
