import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {writeReports, buildNextLoop, renderReport} from '../agent-learning/lib/report.mjs';

async function tempDir(prefix) { return mkdtemp(join(tmpdir(), prefix)); }

const SECTION_ORDER = [
  '## What happened', '## What failed', '## What we learned', '## Candidates tried', '## Which candidate won and why',
  '## Safety checks that ran', '## Was anything promoted', '## What to try next', '## Governance changes recommended for human review', '## Limitations'
];

function baseArgs(overrides = {}) {
  return {
    learnRunId: 'learn_1', mode: 'live', at: '2026-09-11T00:00:00.000Z',
    incumbent: {revision: 'a'.repeat(40), dirty: false},
    evidence: {runs: [{runId: 'run_1'}, {runId: 'run_2'}], incidents: [{incidentId: 'inc_1'}]},
    reduced: {families: [{key: 'hubspot:transient_provider:hubspot.update_customer', count: 3, status: 'open', regressionIds: ['reg_a']}], newRegressions: {dev: [{id: 'reg_a'}], holdout: []}, missingRegressionCoverage: [{family: 'slack:unknown_external_state:slack.post_message', why: 'no table entry'}]},
    retro: {retro: {whatWorked: [{pattern: 'x', evidence: []}], whatFailed: [], lessons: [{text: 'HubSpot recovers after retries.', evidence: ['run_1']}], next: [{hypothesisKey: 'recovery_policy:transient_provider:max_attempts_4', problem: 'p', proposedChange: 'raise maxAttempts to 4', whyItMayHelp: 'w', metric: 'successfulRecoveries', couldRegress: [], falsifiedIf: 'f', affectedModules: ['lib/agent/recovery.mjs'], risk: 'low', kind: 'recovery_policy'}]}, skipped: false},
    candidates: [
      {candidateId: 'cand_promoted111111', hypothesisKey: 'recovery_policy:transient_provider:max_attempts_4', status: 'promote_eligible', reason: '', governanceTouch: {touched: false, why: ''}},
      {candidateId: 'cand_rejected2222222', hypothesisKey: 'prompt:planner:clarify_schema_fields', status: 'rejected', reason: 'no_measurable_improvement', governanceTouch: {touched: true, why: 'touches protected file(s): lib/agent/planner.mjs'}}
    ],
    evaluations: [
      {evaluationId: 'eval_a111111111111', candidateId: 'cand_promoted111111', tests: {pass: 5, fail: 0, ok: true}},
      {evaluationId: 'eval_b222222222222', candidateId: 'cand_rejected2222222', tests: {pass: 5, fail: 0, ok: true}}
    ],
    decisions: [
      {candidateId: 'cand_promoted111111', decision: 'promote_eligible', reasons: [], target: {before: 0, after: 1, improved: true}, holdout: {before: 1, after: 1, regressed: false}, invariantViolations: []},
      {candidateId: 'cand_rejected2222222', decision: 'rejected', reasons: ['no_measurable_improvement'], target: null, holdout: null, invariantViolations: [{invariant: 'duplicateEffects', where: 'eval:11', count: 1}]}
    ],
    memory: {lessons: [{status: 'confirmed', text: 'A confirmed lesson from a prior run.'}]},
    nextLoop: {schemaVersion: 1, generatedAt: '2026-09-11T00:00:00.000Z', learnRunId: 'learn_1', incumbentRevision: 'a'.repeat(40), priorityFailureFamilies: [], confirmedLessons: [], candidateIdeas: [], rejectedIdeas: [], evaluationWeaknesses: [], missingRegressionCoverage: [], recommendedNextExperiment: null, bounds: {maxChars: 8000}},
    ...overrides
  };
}

test('writeReports writes all five per-run files into out, with numbers matching the inputs', async () => {
  const out = await tempDir('sidelook-report-out-');
  const summary = await writeReports({out, ...baseArgs()});
  const files = (await readdir(out)).sort();
  assert.deepEqual(files, ['candidate_results.json', 'learning_report.md', 'learning_summary.json', 'next_loop.json', 'retro.json']);

  assert.equal(summary.learnRunId, 'learn_1');
  assert.equal(summary.at, '2026-09-11T00:00:00.000Z', 'the caller-supplied at must not be discarded for wall-clock time');
  assert.equal(summary.evidence.runs, 2);
  assert.equal(summary.evidence.incidents, 1);
  assert.equal(summary.evidence.families, 1);
  assert.equal(summary.evidence.newRegressions.dev, 1);
  assert.equal(summary.candidates.length, 2);
  assert.equal(summary.candidates[0].evaluationId, 'eval_a111111111111');
  assert.equal(summary.candidates[1].evaluationId, 'eval_b222222222222');
  assert.deepEqual(summary.safetyChecks.ran, ['unclaimedWrites', 'unheldFinancialWrites', 'duplicateEffects', 'incorrectSuccessClaims', 'secretLeaks', 'injectionAuthorized']);
  assert.equal(summary.safetyChecks.violations.length, 1);
  assert.equal(summary.governanceChanges.length, 1);
  assert.equal(summary.governanceChanges[0].candidateId, 'cand_rejected2222222');

  const onDisk = JSON.parse(await readFile(join(out, 'learning_summary.json'), 'utf8'));
  assert.deepEqual(onDisk, summary);
  await rm(out, {recursive: true, force: true});
});

test('writeReports copies durable records into durableDir subfolders when given', async () => {
  const out = await tempDir('sidelook-report-out-');
  const durableDir = await tempDir('sidelook-report-durable-');
  await writeReports({out, durableDir, ...baseArgs()});
  assert.deepEqual(await readdir(join(durableDir, 'retros')), ['retro-learn_1.json']);
  assert.deepEqual((await readdir(join(durableDir, 'candidates'))).sort(), ['cand_promoted111111.json', 'cand_rejected2222222.json']);
  assert.deepEqual((await readdir(join(durableDir, 'evaluations'))).sort(), ['eval_a111111111111.json', 'eval_b222222222222.json']);
  assert.ok((await readdir(durableDir)).includes('next_loop.json'));
  const nextLoopOnDisk = JSON.parse(await readFile(join(durableDir, 'next_loop.json'), 'utf8'));
  assert.equal(nextLoopOnDisk.learnRunId, 'learn_1');
  await rm(out, {recursive: true, force: true});
  await rm(durableDir, {recursive: true, force: true});
});

test('writeReports never touches durableDir when it is not given', async () => {
  const out = await tempDir('sidelook-report-out-');
  await writeReports({out, ...baseArgs()});
  assert.deepEqual((await readdir(out)).sort(), ['candidate_results.json', 'learning_report.md', 'learning_summary.json', 'next_loop.json', 'retro.json']);
  await rm(out, {recursive: true, force: true});
});

test('writeReports throws without out or learnRunId', async () => {
  await assert.rejects(writeReports({...baseArgs(), out: undefined}));
  await assert.rejects(writeReports({...baseArgs(), learnRunId: undefined}));
});

test('a candidate blocked by independent review is reported as rejected, never as the winner', async () => {
  const out = await tempDir('sidelook-report-out-');
  const args = baseArgs({
    candidates: [
      {candidateId: 'cand_blocked11111111', hypothesisKey: 'reconciliation:blind_retry', status: 'rejected_by_review', reason: 'review blocked: governance bypass', governanceTouch: {touched: false, why: ''}}
    ],
    evaluations: [
      {evaluationId: 'eval_c333333333333', candidateId: 'cand_blocked11111111', tests: {pass: 5, fail: 0, ok: true}}
    ],
    decisions: [
      // compare itself said promote_eligible; the independent reviewer (which runs after compare) is what blocked it.
      {candidateId: 'cand_blocked11111111', decision: 'promote_eligible', reasons: [], target: {before: 0, after: 1, improved: true}, holdout: {before: 1, after: 1, regressed: false}, invariantViolations: []}
    ]
  });
  const summary = await writeReports({out, ...args});
  const row = summary.candidates.find(c => c.candidateId === 'cand_blocked11111111');
  assert.equal(row.decision, 'rejected_by_review');
  assert.equal(row.compareDecision, 'promote_eligible');
  const md = renderReport(summary);
  assert.match(md, /## What failed[\s\S]*cand_blocked11111111[\s\S]*## What we learned/);
  const winnersSection = md.slice(md.indexOf('## Which candidate won and why'), md.indexOf('## Safety checks that ran'));
  assert.ok(!winnersSection.includes('cand_blocked11111111'), 'a review-blocked candidate must never appear under the winner section');
  assert.match(winnersSection, /No candidate was promote-eligible this run\./);
  await rm(out, {recursive: true, force: true});
});

test('renderReport produces every section in the contract order, with numbers traceable to the summary object', async () => {
  const out = await tempDir('sidelook-report-out-');
  const summary = await writeReports({out, ...baseArgs()});
  const md = renderReport(summary);
  let lastIndex = -1;
  for (const heading of SECTION_ORDER) {
    const index = md.indexOf(heading);
    assert.ok(index > lastIndex, `${heading} must appear, in order`);
    lastIndex = index;
  }
  assert.match(md, /2 run\(s\) and 1 incident\(s\)/);
  assert.match(md, /cand_promoted111111/);
  assert.match(md, /cand_rejected2222222/);
  assert.match(md, /HubSpot recovers after retries\./);
  assert.match(md, /recovery_policy:transient_provider:max_attempts_4/);
  assert.match(md, /touches protected file\(s\): lib\/agent\/planner\.mjs/);
  await rm(out, {recursive: true, force: true});
});

test('renderReport reports "no candidates" and "nothing promoted" honestly on an empty run', () => {
  const md = renderReport({
    learnRunId: 'learn_2', at: 't', mode: 'dry-run', incumbent: {revision: null, dirty: false},
    evidence: {runs: 0, incidents: 0, families: 0, newRegressions: {dev: 0, holdout: 0}},
    retro: {lessons: [], next: [], skipped: 'no model'}, candidates: [], promoted: [],
    safetyChecks: {ran: [], violations: []}, nextExperiment: null, governanceChanges: [], missingRegressionCoverage: [],
    limitations: ['No candidates were generated this loop.']
  });
  assert.match(md, /No candidates were generated this run\./);
  assert.match(md, /Nothing was promoted this run\./);
  assert.match(md, /No lessons recorded this run\./);
  assert.match(md, /No candidate touched governed code this run\./);
  assert.match(md, /No candidates were generated this loop\./);
});

test('buildNextLoop carries a retro next entry only when it was not made into a candidate this run', () => {
  const args = baseArgs();
  const nextLoop = buildNextLoop({
    learnRunId: 'learn_1', incumbentRevision: 'a'.repeat(40), memory: args.memory, families: args.reduced.families,
    retro: args.retro, candidates: args.candidates, decisions: args.decisions, now: () => '2026-09-11T00:00:00.000Z'
  });
  assert.equal(nextLoop.schemaVersion, 1);
  assert.equal(nextLoop.learnRunId, 'learn_1');
  assert.equal(nextLoop.generatedAt, '2026-09-11T00:00:00.000Z');
  // The one retro.next entry's hypothesisKey matches the promoted candidate, so it was made this run and is not carried forward.
  assert.equal(nextLoop.candidateIdeas.length, 0);
  assert.equal(nextLoop.recommendedNextExperiment, null);
  assert.equal(nextLoop.bounds.maxChars, 8000);
});

test('buildNextLoop carries forward a retro next entry that was not made into a candidate this run, as the recommendation', () => {
  const retro = {retro: {next: [{hypothesisKey: 'reconciliation:hubspot:extra_reads', problem: 'p', proposedChange: 'read once more', whyItMayHelp: 'w', metric: 'm', couldRegress: [], falsifiedIf: 'the family still reconciles unknown', affectedModules: ['lib/agent/effects.mjs'], risk: 'medium', kind: 'reconciliation'}]}, skipped: false};
  const nextLoop = buildNextLoop({learnRunId: 'learn_1', incumbentRevision: 'a'.repeat(40), memory: {}, families: [], retro, candidates: [], decisions: []});
  assert.equal(nextLoop.candidateIdeas.length, 1);
  assert.equal(nextLoop.candidateIdeas[0].hypothesisKey, 'reconciliation:hubspot:extra_reads');
  assert.equal(nextLoop.recommendedNextExperiment.hypothesisKey, 'reconciliation:hubspot:extra_reads');
  assert.equal(nextLoop.recommendedNextExperiment.falsifiedIf, 'the family still reconciles unknown');
});

test('buildNextLoop pulls confirmedLessons only from confirmed memory lessons, and rejectedIdeas only from this run\'s rejected candidates', () => {
  const args = baseArgs();
  const nextLoop = buildNextLoop({learnRunId: 'learn_1', incumbentRevision: 'a'.repeat(40), memory: args.memory, families: args.reduced.families, retro: args.retro, candidates: args.candidates, decisions: args.decisions});
  assert.deepEqual(nextLoop.confirmedLessons, ['A confirmed lesson from a prior run.']);
  assert.equal(nextLoop.rejectedIdeas.length, 1);
  assert.equal(nextLoop.rejectedIdeas[0].hypothesisKey, 'prompt:planner:clarify_schema_fields');
  assert.match(nextLoop.rejectedIdeas[0].reason, /no_measurable_improvement/);
});

test('buildNextLoop caps every array at its contract limit', () => {
  const manyFamilies = Array.from({length: 20}, (_, i) => ({key: `k_${i}`, count: 20 - i, status: 'open', regressionIds: []}));
  const manyRejected = Array.from({length: 20}, (_, i) => ({candidateId: `cand_r${i}`, hypothesisKey: `hyp_${i}`, status: 'rejected', reason: `reason ${i}`}));
  const manyDecisions = manyRejected.map(c => ({candidateId: c.candidateId, decision: 'rejected', reasons: [c.reason]}));
  const memory = {lessons: Array.from({length: 20}, (_, i) => ({status: 'confirmed', text: `Lesson ${i}`}))};
  const nextLoop = buildNextLoop({
    learnRunId: 'learn_1', incumbentRevision: 'a'.repeat(40), memory, families: manyFamilies,
    retro: {retro: {next: []}}, candidates: manyRejected, decisions: manyDecisions,
    missingRegressionCoverage: Array.from({length: 20}, (_, i) => ({family: `f_${i}`, why: 'no mapping'})),
    evaluationWeaknesses: Array.from({length: 20}, (_, i) => `weakness ${i}`)
  });
  assert.equal(nextLoop.priorityFailureFamilies.length, 8);
  assert.equal(nextLoop.confirmedLessons.length, 10);
  assert.equal(nextLoop.rejectedIdeas.length, 10);
  assert.equal(nextLoop.missingRegressionCoverage.length, 8);
  assert.equal(nextLoop.evaluationWeaknesses.length, 6);
  // Highest-count families survive the cap (sorted before slicing).
  assert.equal(nextLoop.priorityFailureFamilies[0].key, 'k_0');
});

test('buildNextLoop stays within its own 8000-char bound even when nothing else would have capped it', () => {
  const manyFamilies = Array.from({length: 8}, (_, i) => ({key: `hubspot:transient_provider:tool_${i}`.repeat(3), count: 8 - i, status: 'open', regressionIds: Array.from({length: 5}, (_, j) => `reg_${i}_${j}`)}));
  const nextLoop = buildNextLoop({
    learnRunId: 'learn_1', incumbentRevision: 'a'.repeat(40), memory: {lessons: Array.from({length: 10}, (_, i) => ({status: 'confirmed', text: `A fairly long confirmed lesson number ${i} about a recovery family that repeated.`}))},
    families: manyFamilies, retro: {retro: {next: []}}, candidates: [], decisions: [],
    missingRegressionCoverage: Array.from({length: 8}, (_, i) => ({family: `family_${i}`, why: `A fairly long explanation of why family ${i} has no regression mapping yet.`})),
    evaluationWeaknesses: Array.from({length: 6}, (_, i) => `A fairly long evaluation weakness number ${i} about the dev corpus not covering something.`)
  });
  assert.ok(JSON.stringify(nextLoop).length <= 8000);
  assert.equal(nextLoop.schemaVersion, 1);
  assert.equal(nextLoop.learnRunId, 'learn_1');
});
