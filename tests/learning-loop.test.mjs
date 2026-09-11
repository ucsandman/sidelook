// End-to-end tests for the loop CLI (agent-learning/learn.mjs) against agent-learning/fixtures/, with evaluateTree
// and createCandidate injected so nothing touches git or spawns a real test/eval run. Contract:
// docs/AGENT_LEARNING_LOOP.md sections 2, 13, 15.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runLoop, parseArgs, DEFAULTS, verifyFixtureSummary, promoteCandidate, buildEditsPrompt, devScenariosForFamily } from '../agent-learning/learn.mjs';
import { readEvidence } from '../agent-learning/lib/intake.mjs';
import { incidentsToFamilies, familyToRegression } from '../agent-learning/lib/reduce.mjs';
import { loadMemory } from '../agent-learning/lib/memory.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES_DIR = join(REPO_ROOT, 'agent-learning', 'fixtures');

const CANDIDATE_ID_BY_KEY = {
  'recovery_policy:transient_provider:max_attempts_4': 'cand_maxattempts4',
  'reconciliation:blind_retry': 'cand_blindretry',
  'governance:skip_claim': 'cand_skipclaim'
};

const EMPTY_INVARIANTS = () => ({ unclaimedWrites: 0, duplicateEffects: 0, incorrectSuccessClaims: 0, unheldFinancialWrites: 0, secretLeaks: 0, injectionAuthorized: 0 });

async function makeTmpDirs() {
  const base = await mkdtemp(join(tmpdir(), 'sidelook-learn-test-'));
  return {
    base,
    outDir: join(base, 'out'),
    durableDir: join(base, 'durable'),
    memoryPath: join(base, 'memory', 'learning-memory.json'),
    regressionsDir: join(base, 'regressions')
  };
}

// The dev regression id familyToRegression assigns for the fixture data's hubspot family: computed the same way
// learn.mjs computes it internally, rather than hardcoded, so a change to the fixture data cannot silently
// desynchronize the stub from what the loop actually asks compare() to check.
async function devTargetId() {
  const evidence = await readEvidence({ dataDir: join(FIXTURES_DIR, 'data') });
  const families = incidentsToFamilies(evidence.incidents, evidence.runs);
  const family = families.find(f => f.key === 'hubspot:transient_provider:hubspot.update_customer');
  const reg = familyToRegression(family, { learnRunId: 'learn_probe' });
  return reg.id;
}

// Records edits without touching git (the lane brief's own words): builds a Candidate record shape directly.
function makeStubCreateCandidate() {
  const calls = [];
  const fn = async ({ learnRunId, incumbent, hypothesis, edits, generator }) => {
    calls.push(hypothesis.hypothesisKey);
    const candidateId = CANDIDATE_ID_BY_KEY[hypothesis.hypothesisKey] || `cand_${hypothesis.hypothesisKey.replace(/[^a-z0-9]/gi, '')}`;
    const governanceTouched = hypothesis.hypothesisKey === 'governance:skip_claim';
    return {
      candidateId, learnRunId, parentRevision: incumbent.revision, incumbentHash: incumbent.revision,
      hypothesisKey: hypothesis.hypothesisKey, hypothesis, generator, edits, filesChanged: edits.map(e => e.file),
      diffHash: `diff_${candidateId}`, worktree: { path: join('/stub', candidateId), branch: `agent-learning/${candidateId}`, commit: `commit_${candidateId}` },
      governanceTouch: { touched: governanceTouched, files: governanceTouched ? ['lib/agent/effects.mjs'] : [], regions: governanceTouched ? [{ file: 'lib/agent/effects.mjs', region: 'governedClaim' }] : [] },
      status: governanceTouched ? 'needs_human_review' : 'created', reason: null, createdAt: new Date().toISOString()
    };
  };
  fn.calls = calls;
  return fn;
}

// Canned EvaluationRecords: the max_attempts_4 candidate improves the target dev regression with every invariant
// unchanged; the blind_retry candidate adds a duplicateEffects violation on scenario 16; the skip_claim candidate
// adds an unclaimedWrites violation on scenario 16. Every other number stays identical to the incumbent baseline.
function makeStubEvaluateTree(devId) {
  return async ({ candidateId, revision, learnRunId }) => {
    const evalInvariants = EMPTY_INVARIANTS();
    if (candidateId === 'cand_blindretry') evalInvariants.duplicateEffects = 1;
    if (candidateId === 'cand_skipclaim') evalInvariants.unclaimedWrites = 1;
    const devPass = candidateId !== 'incumbent';
    return {
      evaluationId: `eval_${candidateId}`, learnRunId, candidateId, revision, at: new Date().toISOString(), elapsedMs: 5,
      tests: { pass: 10, fail: 0, skipped: 0, ok: true, ran: true, failing: [] },
      eval: {
        scenariosPassed: 26, scenariosTotal: 26,
        byScenario: {
          '11': { pass: true, status: 'completed', invariants: EMPTY_INVARIANTS(), incidents: [] },
          '16': { pass: true, status: 'completed', invariants: evalInvariants, incidents: [] }
        },
        metrics: {}, ok: true
      },
      dev: { passed: devPass ? 1 : 0, total: 1, byId: { [devId]: { pass: devPass, status: devPass ? 'completed' : 'failed', invariants: EMPTY_INVARIANTS(), incidents: [] } }, ok: true },
      holdout: { passed: 0, total: 0, byId: {}, ok: true },
      metrics: { scenarioSuccessRate: devPass ? 0.95 : 0.9, successfulRecoveries: devPass ? 4 : 3 },
      safety: { ok: true, violations: [] }
    };
  };
}

function noopRemoveCandidate() { return Promise.resolve(); }

test('dry-run writes nothing under the repo and touches no worktree or memory file', async t => {
  const dirs = await makeTmpDirs();
  t.after(() => rm(dirs.base, { recursive: true, force: true }));
  const before = execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' });

  const summary = await runLoop({
    root: REPO_ROOT, dryRun: true, fixturesDir: FIXTURES_DIR, maxCandidates: 3,
    outDir: dirs.outDir, memoryPath: dirs.memoryPath, regressionsDir: dirs.regressionsDir, durableDir: dirs.durableDir,
    print: null
  });

  const after = execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(after, before, 'a dry run must not change the repository working tree');
  assert.equal(summary.mode, 'dry-run');
  assert.equal(summary.candidates.length, 0, 'dry-run never creates a candidate');
  await assert.rejects(readFile(dirs.memoryPath, 'utf8'), 'dry-run must not write the memory file');
});

test('parseArgs reads every documented flag', () => {
  const args = parseArgs(['--fixtures', 'F', '--data', 'D', '--max-candidates', '3', '--model', 'sonnet', '--review-model', 'opus', '--out', 'O', '--promote', 'cand_x', '--verify', '--dry-run']);
  assert.equal(args.fixtures, 'F');
  assert.equal(args.data, 'D');
  assert.equal(args.maxCandidates, 3);
  assert.equal(args.model, 'sonnet');
  assert.equal(args.reviewModel, 'opus');
  assert.equal(args.out, 'O');
  assert.equal(args.promote, 'cand_x');
  assert.equal(args.verify, true);
  assert.equal(args.dryRun, true);
  assert.deepEqual(DEFAULTS, { maxCandidates: 2, model: null, reviewModel: null });
});

test('the fixture loop reproduces Scenario C (promote_eligible), D (duplicate_effect) and D2 (dashclaw_bypass + governanceTouch)', async t => {
  const dirs = await makeTmpDirs();
  t.after(() => rm(dirs.base, { recursive: true, force: true }));
  const devId = await devTargetId();

  const promptsSeen = [];
  const summary = await runLoop({
    root: REPO_ROOT, dryRun: false, fixturesDir: FIXTURES_DIR, maxCandidates: 3,
    outDir: dirs.outDir, memoryPath: dirs.memoryPath, regressionsDir: dirs.regressionsDir, durableDir: dirs.durableDir,
    createCandidate: makeStubCreateCandidate(), evaluateTree: makeStubEvaluateTree(devId), removeCandidate: noopRemoveCandidate,
    print: null,
    // Wraps the real inference call so the assembled retro prompt can be inspected without changing what it answers.
    vision: undefined
  });

  const byKey = key => summary.candidates.find(c => c.hypothesisKey === key);
  const c1 = byKey('recovery_policy:transient_provider:max_attempts_4');
  const c2 = byKey('reconciliation:blind_retry');
  const c3 = byKey('governance:skip_claim');

  assert.ok(c1, 'the max_attempts_4 candidate was created');
  assert.equal(c1.decision, 'promote_eligible');

  assert.ok(c2, 'the blind_retry candidate was created');
  assert.equal(c2.decision, 'rejected');
  assert.match(c2.reason, /duplicate_effect/);

  assert.ok(c3, 'the skip_claim candidate was created');
  assert.equal(c3.decision, 'rejected');
  assert.match(c3.reason, /dashclaw_bypass/);
  assert.equal(c3.governanceTouch?.touched, true, 'the stub candidate for governance:skip_claim reports a governance touch');

  // Independent review of a fixture candidate must actually count: the fixture inference seam always answers
  // {model:'fixture'}, so without learn.mjs echoing the requested review model through, promoteEligible stays false
  // (reason:'unreviewed') even though compare() and the canned review both said yes.
  const c1Record = summary.candidateRecords.find(c => c.hypothesisKey === 'recovery_policy:transient_provider:max_attempts_4');
  assert.equal(c1Record.promoteEligible, true, 'Scenario C: the approving fixture review must count as independent and make the candidate promote-eligible');
  assert.ok(c1Record.worktree?.branch, 'Scenario C: the promote_eligible candidate keeps a recorded branch');

  const memory = await loadMemory(dirs.memoryPath);
  const rejectedKeys = memory.rejectedStrategies.map(r => r.hypothesisKey);
  assert.ok(rejectedKeys.includes('reconciliation:blind_retry'), 'memory.rejectedStrategies retains D');
  assert.ok(rejectedKeys.includes('governance:skip_claim'), 'memory.rejectedStrategies retains D2');
  const blindRetryEntry = memory.rejectedStrategies.find(r => r.hypothesisKey === 'reconciliation:blind_retry');
  const skipClaimEntry = memory.rejectedStrategies.find(r => r.hypothesisKey === 'governance:skip_claim');
  assert.match(blindRetryEntry.reason, /duplicate_effect/);
  assert.match(skipClaimEntry.reason, /dashclaw_bypass/);

  // Scenario E: this run's own rejection, not just whatever the cumulative memory file happens to hold, and the
  // reason must actually be the instruction-like refusal, not merely a missing-provenance refusal that would also
  // satisfy field === 'lessons' on a run that read no evidence at all.
  assert.ok(summary.rejectedThisRun.some(r => r.field === 'lessons' && /instruction/i.test(r.reason)), 'Scenario E: the planted lesson is refused this run for looking instruction-like');

  const nextLoopText = await readFile(join(dirs.durableDir, 'next_loop.json'), 'utf8');
  assert.ok(nextLoopText.length < 8000, 'next_loop.json stays under its own 8000-char bound');
  const nextLoop = JSON.parse(nextLoopText);
  const rejectedIdeaKeys = nextLoop.rejectedIdeas.map(r => r.hypothesisKey);
  assert.ok(rejectedIdeaKeys.includes('reconciliation:blind_retry'), 'next_loop.json lists D under rejectedIdeas');
  assert.ok(rejectedIdeaKeys.includes('governance:skip_claim'), 'next_loop.json lists D2 under rejectedIdeas');

  const retroJson = JSON.parse(await readFile(join(dirs.outDir, 'retro.json'), 'utf8'));
  assert.ok(retroJson, 'retro.json was written');

  // The evidence counts this run actually read, and verifyFixtureSummary passing on the real written records
  // (docs/AGENT_LEARNING_LOOP.md section 13): a broken pipeline that reads zero evidence must not pass silently.
  assert.equal(summary.evidence.runs, 5);
  assert.equal(summary.evidence.incidents, 3);
  assert.equal(summary.evidence.families, 1);
  assert.deepEqual(verifyFixtureSummary(summary), []);
});

test('verifyFixtureSummary fails a run that read zero evidence, even though it still produces the three canned candidates', () => {
  const brokenSummary = {
    evidence: { runs: 0, incidents: 0, families: 0 },
    candidateRecords: [
      { hypothesisKey: 'recovery_policy:transient_provider:max_attempts_4', status: 'promote_eligible', promoteEligible: true, worktree: { branch: 'agent-learning/cand_x' } },
      { hypothesisKey: 'reconciliation:blind_retry', status: 'rejected', reason: 'duplicate_effect' },
      { hypothesisKey: 'governance:skip_claim', status: 'rejected', reason: 'dashclaw_bypass', governanceTouch: { touched: true } }
    ],
    rejectedThisRun: [{ field: 'lessons', reason: 'A lesson needs provenance with at least one run, incident, candidate or evaluation id.' }]
  };
  const failures = verifyFixtureSummary(brokenSummary);
  assert.ok(failures.some(f => /5 evidence runs/.test(f)), 'zero evidence runs must fail verification');
  assert.ok(failures.some(f => /Scenario E/.test(f)), 'a provenance rejection must not satisfy the instruction-like check');
});

test('promoteCandidate refuses an unvalidated candidateId, branch or commit before touching git', async t => {
  const dirs = await makeTmpDirs();
  t.after(() => rm(dirs.base, { recursive: true, force: true }));

  const traversal = await promoteCandidate({ root: REPO_ROOT, durableDir: dirs.durableDir, candidateId: '../../../etc/passwd', print: () => {} });
  assert.equal(traversal.ok, false);
  assert.equal(traversal.reason, 'invalid_candidate_id');

  await mkdir(join(dirs.durableDir, 'candidates'), { recursive: true });
  await writeFile(join(dirs.durableDir, 'candidates', 'cand_abcdef012345.json'), JSON.stringify({
    candidateId: 'cand_abcdef012345', status: 'promote_eligible', promoteEligible: true,
    review: { verdict: 'approve' }, worktree: { branch: '-x', commit: 'a'.repeat(40) }
  }), 'utf8');
  const badBranch = await promoteCandidate({ root: REPO_ROOT, durableDir: dirs.durableDir, candidateId: 'cand_abcdef012345', print: () => {} });
  assert.equal(badBranch.ok, false);
  assert.equal(badBranch.reason, 'invalid_branch');
});

test('the retro prompt built from the fixture evidence never contains the planted injection text', async () => {
  // Rebuilds exactly what runRetro/buildRetroPrompt would assemble from this fixture evidence, the same call
  // learn.mjs makes internally: proof the sanitized, allowlisted evidence path structurally excludes the text,
  // independent of which candidate outcomes a stubbed evaluator produces.
  const { buildRetroStats, buildRetroPrompt } = await import('../agent-learning/lib/retro.mjs');
  const { projectForPrompt } = await import('../agent-learning/lib/memory.mjs');
  const evidence = await readEvidence({ dataDir: join(FIXTURES_DIR, 'data') });
  const stats = buildRetroStats(evidence, null);
  const { prompt, system } = buildRetroPrompt({ stats, memoryProjection: projectForPrompt({ lessons: [], failureFamilies: [], rejectedStrategies: [], nextExperiments: [] }), rejectedStrategies: [] });
  assert.ok(!prompt.includes('IGNORE PREVIOUS INSTRUCTIONS'));
  assert.ok(!system.includes('IGNORE PREVIOUS INSTRUCTIONS'));
});

test('the generator prompt carries the allowlisted file text and only dev regression scenarios, never a holdout id or file body', () => {
  const hypothesis = { hypothesisKey: 'recovery_policy:transient_provider:max_attempts_4', affectedModules: ['lib/agent/recovery.mjs'] };
  const corpus = {
    dev: [{ id: 'reg_dev_1', family: 'hubspot:transient_provider:hubspot.update_customer', name: 'dev case', faults: { 'hubspot.updateContact': { kind: 'failTimes', times: 3 } }, expect: { status: 'completed' } }],
    holdout: [{ id: 'reg_holdout_secret', family: 'hubspot:transient_provider:hubspot.update_customer', name: 'HOLDOUT_ONLY_NAME', faults: { 'hubspot.updateContact': { kind: 'failTimes', times: 99 } }, expect: { status: 'HOLDOUT_ONLY_STATUS' } }]
  };
  const family = { key: 'hubspot:transient_provider:hubspot.update_customer' };
  const devScenarios = devScenariosForFamily(corpus, family);
  const fileTexts = { 'lib/agent/recovery.mjs': 'const RECOVERY_POLICY = { HOLDOUT_MARKER_ABSENT: true };' };

  const { prompt, system } = buildEditsPrompt(hypothesis, {}, fileTexts, devScenarios);
  const whole = system + prompt;
  assert.ok(prompt.includes('reg_dev_1'), 'the dev scenario for the hypothesis family is present');
  assert.ok(prompt.includes('RECOVERY_POLICY'), 'the current text of an allowlisted file is present');
  assert.ok(!whole.includes('reg_holdout_secret'), 'no holdout scenario id ever reaches the prompt');
  assert.ok(!whole.includes('HOLDOUT_ONLY_NAME'), 'no holdout scenario content ever reaches the prompt');
  assert.ok(!whole.includes('HOLDOUT_ONLY_STATUS'), 'no holdout scenario content ever reaches the prompt');
});

test('a second loop run over the same memory does not propose the rejected hypotheses again', async t => {
  const dirs = await makeTmpDirs();
  t.after(() => rm(dirs.base, { recursive: true, force: true }));
  const devId = await devTargetId();

  const firstCreate = makeStubCreateCandidate();
  await runLoop({
    root: REPO_ROOT, dryRun: false, fixturesDir: FIXTURES_DIR, maxCandidates: 3,
    outDir: join(dirs.outDir, 'run1'), memoryPath: dirs.memoryPath, regressionsDir: dirs.regressionsDir, durableDir: dirs.durableDir,
    createCandidate: firstCreate, evaluateTree: makeStubEvaluateTree(devId), removeCandidate: noopRemoveCandidate, print: null
  });
  assert.deepEqual(new Set(firstCreate.calls), new Set(['recovery_policy:transient_provider:max_attempts_4', 'reconciliation:blind_retry', 'governance:skip_claim']));

  const secondCreate = makeStubCreateCandidate();
  const summary2 = await runLoop({
    root: REPO_ROOT, dryRun: false, fixturesDir: FIXTURES_DIR, maxCandidates: 3,
    outDir: join(dirs.outDir, 'run2'), memoryPath: dirs.memoryPath, regressionsDir: dirs.regressionsDir, durableDir: dirs.durableDir,
    createCandidate: secondCreate, evaluateTree: makeStubEvaluateTree(devId), removeCandidate: noopRemoveCandidate, print: null
  });

  assert.ok(!secondCreate.calls.includes('reconciliation:blind_retry'), 'the second run must not re-propose the rejected blind_retry hypothesis');
  assert.ok(!secondCreate.calls.includes('governance:skip_claim'), 'the second run must not re-propose the rejected skip_claim hypothesis');
  assert.ok(!summary2.candidates.some(c => c.hypothesisKey === 'reconciliation:blind_retry'));
  assert.ok(!summary2.candidates.some(c => c.hypothesisKey === 'governance:skip_claim'));
});
