#!/usr/bin/env node
// Owns: the loop itself. Runs the 13 steps of docs/AGENT_LEARNING_LOOP.md section 2 in order, writing each step's
// record before the next starts so an interrupted loop leaves evidence on disk. Every stage's real implementation
// lives in agent-learning/lib/*; this file wires them together, resolves the model seam (real, fixture or none),
// and owns the parts the contract leaves to "the caller": learnRunId, the CLI, target resolution for compare(),
// the candidateId -> hypothesisKey translation the fixture review needs, and cleanup.
import { readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync as gitExec } from 'node:child_process';
import { randomBytes as randomBytesFn, createHash } from 'node:crypto';

import { freezeIncumbent } from './lib/incumbent.mjs';
import { readEvidence } from './lib/intake.mjs';
import { incidentsToFamilies, familyToRegression, assignSet, REDUCTION_TABLE } from './lib/reduce.mjs';
import { buildRetroStats, runRetro } from './lib/retro.mjs';
import { proposeHypotheses, TEMPLATE_RULES } from './lib/hypotheses.mjs';
import { createCandidate as realCreateCandidate, removeCandidate as realRemoveCandidate, checkoutIncumbent as realCheckoutIncumbent, removeWorktree as realRemoveWorktree } from './lib/candidates.mjs';
import { evaluateTree as realEvaluateTree } from './lib/evaluate.mjs';
import { compare } from './lib/compare.mjs';
import { independentReview, applyReviewDecision } from './lib/review.mjs';
import { loadMemory, saveMemory, mergeMemory, projectForPrompt } from './lib/memory.mjs';
import { buildNextLoop, writeReports } from './lib/report.mjs';
import { createLearningInference, createFixtureInference, defaultReviewModel } from './lib/inference.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

export const DEFAULTS = Object.freeze({
  maxCandidates: 2,
  model: null,
  reviewModel: null
});

// Mirrors lib/agent/config.mjs's own defaultDataDir (not exported there): SIDELOOK_AGENT_DATA, else the platform
// default under LOCALAPPDATA/AppData, else ~/.sidelook. Duplicated rather than imported for the same reason
// agent-learning/lib/reduce.mjs duplicates GOAL_REFUND: this is a small, stable literal, not worth a cross-lane
// export just for one caller.
function defaultDataDir(env = process.env) {
  if (env.SIDELOOK_AGENT_DATA) return env.SIDELOOK_AGENT_DATA;
  if (process.platform === 'win32') return join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Sidelook', 'agent', 'runs');
  return join(homedir(), '.sidelook', 'agent', 'runs');
}

function makeLearnRunId(now = new Date()) {
  const compact = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `learn_${compact}_${randomBytesFn(2).toString('hex')}`;
}

export function parseArgs(argv = []) {
  const args = {
    dryRun: false, fixtures: null, data: null, maxCandidates: DEFAULTS.maxCandidates,
    model: DEFAULTS.model, reviewModel: DEFAULTS.reviewModel, out: null, promote: null, verify: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--fixtures') args.fixtures = argv[++i];
    else if (a === '--data') args.data = argv[++i];
    else if (a === '--max-candidates') args.maxCandidates = Number(argv[++i]);
    else if (a === '--model') args.model = argv[++i];
    else if (a === '--review-model') args.reviewModel = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--promote') args.promote = argv[++i];
    else if (a === '--verify') args.verify = true;
  }
  return args;
}

async function readJsonSafe(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return null; }
}

// { items, unreadable } — a scenario file that fails to parse is counted, never silently dropped (a corrupt file
// must not defeat the fingerprint dedupe or assignSet without leaving a trace anyone can see).
async function loadRegressionSet(dir) {
  let files;
  try { files = (await readdir(dir)).filter(f => f.endsWith('.json')); }
  catch { return { items: [], unreadable: 0 }; }
  const items = [];
  let unreadable = 0;
  for (const f of files) {
    const scenario = await readJsonSafe(join(dir, f));
    if (scenario) items.push(scenario);
    else unreadable++;
  }
  return { items, unreadable };
}

async function loadExistingCorpus(regressionsDir) {
  const dev = await loadRegressionSet(join(regressionsDir, 'dev'));
  const holdout = await loadRegressionSet(join(regressionsDir, 'holdout'));
  return { dev: dev.items, holdout: holdout.items, unreadable: dev.unreadable + holdout.unreadable };
}

// This module's own 8000-char bound, matching lib/report.mjs's NEXT_LOOP_MAX_CHARS: a prior next_loop.json is
// compared against the loop's own stated bound, never the file's own (possibly tampered or drifted) `bounds.maxChars`
// (docs/AGENT_LEARNING_LOOP.md section 12). Returns {nextLoop, ignoredReason}: an ignored file is never silent.
const NEXT_LOOP_OWN_MAX_CHARS = 8000;
async function loadPriorNextLoop(durableDir) {
  if (!durableDir) return { nextLoop: null, ignoredReason: null };
  const raw = await readJsonSafe(join(durableDir, 'next_loop.json'));
  if (!raw) return { nextLoop: null, ignoredReason: null };
  if (raw.schemaVersion !== 1) return { nextLoop: null, ignoredReason: `prior next_loop.json ignored: unknown schemaVersion ${raw.schemaVersion}.` };
  if (JSON.stringify(raw).length > NEXT_LOOP_OWN_MAX_CHARS) return { nextLoop: null, ignoredReason: `prior next_loop.json ignored: exceeds the ${NEXT_LOOP_OWN_MAX_CHARS}-char bound.` };
  return { nextLoop: raw, ignoredReason: null };
}

function hasBuilderFor(family) {
  return !!(REDUCTION_TABLE[family.key] || REDUCTION_TABLE[`${family.integration}:${family.failureClass}:*`]);
}

// Maps a hypothesisKey back to the failure family it targets, for every hypothesisKey TEMPLATE_RULES can produce.
// A hypothesis proposed by the model (fixture or real) that happens to reuse one of these exact keys gets the same
// family-scoped target as the deterministic rule would; a model hypothesis with a novel key gets no target (compare
// then falls back to "every dev case is the target", which only matters if the candidate gets past rule 1).
function buildHypothesisFamilyMap(families) {
  const map = new Map();
  for (const family of families) {
    for (const rule of TEMPLATE_RULES) {
      if (!rule.condition(family)) continue;
      const built = rule.build(family);
      if (!map.has(built.hypothesisKey)) map.set(built.hypothesisKey, family);
    }
  }
  return map;
}

function resolveTarget(hypothesis, familyMap, corpus) {
  const family = familyMap.get(hypothesis?.hypothesisKey);
  if (!family) return { metric: hypothesis?.metric || 'scenarioSuccessRate' };
  const belongsToFamily = [...corpus.dev, ...corpus.holdout].filter(r => r.family === family.key);
  return {
    devIds: belongsToFamily.filter(r => r.set === 'dev').map(r => r.id),
    holdoutIds: belongsToFamily.filter(r => r.set === 'holdout').map(r => r.id),
    metric: hypothesis?.metric || 'scenarioSuccessRate'
  };
}

// docs/AGENT_LEARNING_LOOP.md section 5 fixes the trend row's metric names, which differ from section 8's
// EvaluationRecord.metrics names (compare.mjs/evaluate.mjs); merged straight through, memory.trends used the wrong
// key names (finding). This is the one place that reconciles them.
function projectTrendMetrics(metrics = {}) {
  return {
    scenarioPassRate: metrics.scenarioSuccessRate, verifiedCompletionRate: metrics.verifiedCompletionRate,
    incorrectSuccessClaims: metrics.incorrectSuccessClaims, duplicateEffects: metrics.duplicateSideEffects,
    uncertainFinalStates: metrics.uncertainFinalStates, recoveries: metrics.successfulRecoveries, avgToolCalls: metrics.avgToolCalls
  };
}

// The model seam: fixtures always win (docs/AGENT_LEARNING_LOOP.md section 2), then a real model id, else none.
function buildInference({ fixtures, model, vision }) {
  if (fixtures) {
    const fixtureData = JSON.parse(readFileSync(join(fixtures, 'inference.json'), 'utf8'));
    return { inference: createFixtureInference(fixtureData), generatorModel: 'fixture', usingFixtures: true };
  }
  if (model && model !== 'none') return { inference: createLearningInference({ model, vision }), generatorModel: model, usingFixtures: false };
  return { inference: null, generatorModel: null, usingFixtures: false };
}

// review.mjs always calls the seam with key:candidate.candidateId (a random id it does not know ahead of time), but
// the fixture review answers are keyed by hypothesisKey (the only thing the fixtures author can name in advance).
// This wrapper is the one place that reconciles the two: it never changes review.mjs's call, only translates the key
// before handing the call to the underlying inference function.
function wireReviewKey(inference, candidatesById) {
  if (!inference) return inference;
  return async function wrapped(args = {}) {
    if (args.stage !== 'review') return inference(args);
    const candidate = candidatesById.get(args.key);
    const hypothesisKey = candidate?.hypothesis?.hypothesisKey || candidate?.hypothesisKey || args.key;
    const res = await inference({ ...args, key: hypothesisKey });
    // The fixture seam always answers {model:'fixture'} regardless of the requested review model (createFixtureInference,
    // lib/inference.mjs), which made independentReview's modelIdsDiffer(usedModel, generatorModel) check false even when
    // the fixture review approved a candidate — every fixture candidate came back unreviewed (finding: Scenario C never
    // promotable). Echo the requested model through when the seam's own answer doesn't already carry a useful one, so
    // review.mjs's independence check compares the model actually requested for review, not the seam's placeholder.
    return { ...res, model: args.model || res.model };
  };
}

const EDITS_SCHEMA = { type: 'object', additionalProperties: false, properties: { edits: { type: 'array', items: { type: 'object' } } }, required: ['edits'] };

// Current text of every file the hypothesis's own affectedModules names: the generator cannot produce a `find`
// string that matches without seeing the text it must match against (docs/AGENT_LEARNING_LOOP.md section 7). A file
// that cannot be read (not yet created, or the hypothesis names something odd) comes back null rather than throwing.
export async function readAllowlistedFiles(root, files) {
  const out = {};
  for (const file of files || []) {
    try { out[file] = await readFile(join(root, file), 'utf8'); }
    catch { out[file] = null; }
  }
  return out;
}

// Only the dev regression scenarios belonging to the hypothesis's own target family, and only the fields the
// contract names (ids, names, faults, expectations) — never a holdout scenario, never the holdout set at all.
export function devScenariosForFamily(corpus, family) {
  if (!family) return [];
  return (corpus?.dev || []).filter(r => r.family === family.key).map(r => ({ id: r.id, name: r.name, faults: r.faults, expect: r.expect }));
}

export function buildEditsPrompt(hypothesis, memoryProjection, fileTexts = {}, devScenarios = []) {
  return {
    system: 'You are the candidate generator for the Sidelook Agent Learning Loop. Given one hypothesis, the current text of the files it may edit, and the dev regression scenarios for its family, answer with structured edits only: {edits:[{file,find,replace}|{file,create:true,content}]}. find must occur exactly once. Never touch a protected file or region.',
    prompt: JSON.stringify({ hypothesis, memoryProjection: memoryProjection || {}, files: fileTexts || {}, devScenarios: devScenarios || [] })
  };
}

function normalizeEdits(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.edits)) return result.edits;
  if (result && typeof result === 'object') return [result];
  return [];
}

// git diff of the candidate's commit against its parent, for the reviewer. A stubbed candidate (no real git worktree
// -- tests/learning-loop.test.mjs's injected createCandidate) has no commit to diff; the edits themselves, serialized,
// are the next best evidence and are deterministic, which is what makes the fallback testable at all.
function computeDiff(root, candidate) {
  if (candidate?.worktree?.commit && candidate?.parentRevision) {
    try { return gitExec('git', ['diff', `${candidate.parentRevision}..${candidate.worktree.commit}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { /* fall through to the edits-based fallback below */ }
  }
  return JSON.stringify(candidate?.edits || [], null, 2);
}

function log(print, message) { if (print) print(message); }

// runLoop(options) -> summary (the object writeReports returns). Every dependency the real loop needs from disk or
// git is injectable so tests/learning-loop.test.mjs can run the whole pipeline against temp dirs and canned
// evaluators with nothing under agent-learning/ or the repo's own git state touched.
export async function runLoop(options = {}) {
  const root = options.root || REPO_ROOT;
  const dryRun = !!options.dryRun;
  const fixturesDir = options.fixturesDir || null;
  const dataDir = options.dataDir || (fixturesDir ? join(fixturesDir, 'data') : defaultDataDir());
  const maxCandidates = Number.isFinite(options.maxCandidates) && options.maxCandidates > 0 ? options.maxCandidates : DEFAULTS.maxCandidates;
  const model = options.model ?? DEFAULTS.model;
  const now = options.now || (() => new Date());
  const learnRunId = options.learnRunId || makeLearnRunId(now());
  const outDir = options.outDir || join(root, '.artifacts', 'agent-learning', dryRun ? `${learnRunId}-dry-run` : learnRunId);
  // --fixtures is the CI-safe, self-contained proof (docs/AGENT_LEARNING_LOOP.md section 2): when no explicit dir was
  // given, its durable/memory/regressions state lives under the run's own --out, never the committed agent-learning/
  // paths — otherwise a fixture run merges synthetic lessons/families/strategies into real learning memory and real
  // prompts (finding: --fixtures pollutes committed corpus and memory), and the moment a real run advances
  // lastIntakeAt, the fixture proof silently reads zero evidence forever (finding: fixture proof gated by real state).
  const durableDir = dryRun ? null : (options.durableDir ?? (fixturesDir ? outDir : join(root, 'agent-learning')));
  const memoryPath = options.memoryPath || (fixturesDir ? join(outDir, 'learning-memory.json') : join(root, 'agent-learning', 'memory', 'learning-memory.json'));
  const regressionsDir = options.regressionsDir || (fixturesDir ? join(outDir, 'regressions') : join(root, 'agent-learning', 'regressions'));
  // A fixtures run starts clean: whatever an earlier run left under its out dir (memory with rejected strategies, a corpus,
  // records) would change what this run proposes, so the out dir is emptied first, then seeded with a fresh copy of the
  // committed corpus so the starter holdout cases take part in the proof (Scenario C must pass its family's holdout case).
  // Nothing the run writes reaches the committed files.
  if (fixturesDir && !options.regressionsDir && !dryRun) {
    // Only a directory under the repository's own .artifacts/ is ever emptied; any other --out is left as found.
    const artifacts = resolve(root, '.artifacts');
    if (resolve(outDir).toLowerCase().startsWith((artifacts + sep).toLowerCase())) await rm(outDir, { recursive: true, force: true });
    const committed = join(root, 'agent-learning', 'regressions');
    for (const set of ['dev', 'holdout']) {
      await mkdir(join(regressionsDir, set), { recursive: true });
      for (const f of (await readdir(join(committed, set)).catch(() => [])).filter(f => f.endsWith('.json'))) await writeFile(join(regressionsDir, set, f), await readFile(join(committed, set, f), 'utf8'), 'utf8');
    }
  }
  const worktreesDir = options.worktreesDir || join(root, '.worktrees');
  const print = options.print === undefined ? (msg => console.log(msg)) : options.print;
  const evaluateTreeFn = options.evaluateTree || realEvaluateTree;
  const createCandidateFn = options.createCandidate || realCreateCandidate;
  const removeCandidateFn = options.removeCandidate || realRemoveCandidate;
  // The baseline runs in a detached checkout of the frozen revision, never in the live working tree (a test's stubbed
  // evaluator never needs the checkout, so a stubbed evaluateTree also stubs this away unless the caller says otherwise).
  const checkoutIncumbentFn = options.checkoutIncumbent || (options.evaluateTree ? (async ({ root: r }) => ({ path: r, revision: null, stub: true })) : realCheckoutIncumbent);
  const removeWorktreeFn = options.removeWorktree || realRemoveWorktree;
  const evalReportPath = options.evalReportPath || join(root, '.artifacts', 'agent-eval.json');

  const step = (n, name, detail) => log(print, `step ${n} of 13: ${name}${detail ? ` ... ${detail}` : ''}`);

  const memory = await loadMemory(memoryPath).catch(() => ({ schemaVersion: 1, updatedAt: null, lastIntakeAt: null, loops: [], lessons: [], failureFamilies: [], recoveryStrategies: [], rejectedStrategies: [], unresolved: [], nextExperiments: [], trends: [], lineage: [], rejectedMemoryItems: [] }));

  // Step 1: freeze. Written to <out>/incumbent.json (docs/AGENT_LEARNING_LOOP.md section 2 step 1); incumbentHash is
  // sha256 of those exact bytes (section 3), and candidates.mjs's createCandidate reads incumbent.hash/regionHashes
  // to stamp every candidate record and diff protected regions against — without this, both were always undefined.
  // The incumbent is HEAD, frozen from a detached checkout of exactly those bytes: hashes taken from the live working tree
  // would include whatever is being edited there. The checkout stays for the baseline evaluation (step 4) and is removed after.
  // A dry run freezes from the working tree (it creates nothing) and says so.
  const checkout = dryRun ? { path: root, stub: true } : await checkoutIncumbentFn({ root, revision: gitExec('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), worktreesDir, label: 'incumbent' });
  let incumbent;
  try {
    incumbent = await freezeIncumbent({ root: checkout.path, now: () => now().toISOString() });
  } catch (error) {
    if (!checkout.stub) { try { removeWorktreeFn({ root, path: checkout.path }); } catch { /* best effort */ } }
    throw error;
  }
  // `dirty` from a clean checkout is always false; what a person wants to know is whether the working tree they ran from differs from HEAD.
  incumbent.workingTreeDirty = gitExec('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0;
  incumbent.frozenFrom = checkout.stub ? 'working tree (dry run)' : 'detached checkout';
  const incumbentJson = JSON.stringify(incumbent, null, 2);
  const incumbentHash = createHash('sha256').update(incumbentJson).digest('hex');
  const incumbentForCandidates = { ...incumbent, hash: incumbentHash, regionHashes: incumbent.protected };
  if (!dryRun) {
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, 'incumbent.json'), incumbentJson, 'utf8');
  }
  step(1, 'freeze', `revision ${incumbent.revision.slice(0, 12)}${incumbent.workingTreeDirty ? ' (working tree dirty; the incumbent is HEAD)' : ''}`);

  // Step 2: intake. A --fixtures run never trusts the real committed memory's lastIntakeAt: the fixture data is
  // dated once and fixed, so gating it behind real state silently empties it the moment a real run advances that
  // timestamp (finding: the --fixtures proof is gated by the real memory's lastIntakeAt).
  const since = fixturesDir ? null : memory.lastIntakeAt;
  const evidence = await readEvidence({ dataDir, since, evalReportPath });
  step(2, 'intake', `${evidence.runs.length} runs, ${evidence.incidents.length} incidents`);

  // Step 3: reduce.
  const families = incidentsToFamilies(evidence.incidents, evidence.runs);
  const existingCorpus = await loadExistingCorpus(regressionsDir);
  const newRegressions = { dev: [], holdout: [] };
  const missingRegressionCoverage = [];
  for (const family of families) {
    const reg = familyToRegression(family, { learnRunId, now: () => now().toISOString() });
    if (!reg) {
      missingRegressionCoverage.push({ family: family.key, why: hasBuilderFor(family) ? 'condition not yet met (e.g. attempts not exhausted)' : 'no reduction mapping for this family' });
      continue;
    }
    const alreadyCovered = [...existingCorpus.dev, ...existingCorpus.holdout, ...newRegressions.dev, ...newRegressions.holdout].some(r => r.fingerprint === reg.fingerprint);
    if (alreadyCovered) continue;
    const set = assignSet(family, existingCorpus, reg.fingerprint);
    const full = { ...reg, set };
    newRegressions[set].push(full);
    existingCorpus[set].push(full);
  }
  if (!dryRun) {
    for (const set of ['dev', 'holdout']) {
      for (const reg of newRegressions[set]) {
        await mkdir(join(regressionsDir, set), { recursive: true });
        await writeFile(join(regressionsDir, set, `${reg.id}.json`), JSON.stringify(reg, null, 2), 'utf8');
      }
    }
  } else {
    for (const set of ['dev', 'holdout']) for (const reg of newRegressions[set]) log(print, `  planned: regressions/${set}/${reg.id}.json`);
  }
  const unreadableRegressionsNote = existingCorpus.unreadable > 0 ? [`${existingCorpus.unreadable} regression file(s) under agent-learning/regressions/ could not be parsed and were skipped.`] : [];
  step(3, 'reduce', `${families.length} families, ${newRegressions.dev.length} new dev regression(s), ${newRegressions.holdout.length} new holdout regression(s)${existingCorpus.unreadable ? `, ${existingCorpus.unreadable} unreadable` : ''}`);

  // Step 4: baseline. Dry-run stops after reduce (docs/AGENT_LEARNING_LOOP.md section 2's dry-run list).
  let incumbentEval = null;
  if (!dryRun) {
    // The incumbent is evaluated on its frozen bytes: the same detached checkout step 1 hashed, removed once measured.
    // A dirty working tree is reported, never measured; what it holds is not part of the incumbent.
    try {
      incumbentEval = await evaluateTreeFn({ root: checkout.path, sets: ['tests', 'eval', 'dev', 'holdout'], learnRunId, candidateId: 'incumbent', revision: incumbent.revision, out: join(outDir, 'incumbent'), regressionsDir });
    } finally {
      if (!checkout.stub) { try { removeWorktreeFn({ root, path: checkout.path }); } catch (error) { log(print, `step 4 of 13: baseline ... warning: could not remove the incumbent worktree: ${error.message || error}`); } }
    }
    step(4, 'baseline', `${incumbentEval.tests.pass}/${incumbentEval.tests.pass + incumbentEval.tests.fail} tests, ${incumbentEval.eval.scenariosPassed}/${incumbentEval.eval.scenariosTotal} eval, ${incumbentEval.dev.passed}/${incumbentEval.dev.total} dev, ${incumbentEval.holdout.passed}/${incumbentEval.holdout.total} holdout (measured in a detached checkout of ${incumbent.revision.slice(0, 12)})`);

    // A proposed regression that passes on the incumbent is coverage: mark it confirmed in its file (section 8); one
    // that fails on the incumbent stays proposed and is a target. Covers the whole corpus (existingCorpus already
    // holds old + this run's new regressions), not just what this run added.
    for (const set of ['dev', 'holdout']) {
      const byId = incumbentEval[set]?.byId || {};
      for (const reg of existingCorpus[set]) {
        if (reg.status !== 'proposed' || byId[reg.id]?.pass !== true) continue;
        reg.status = 'confirmed';
        await writeFile(join(regressionsDir, set, `${reg.id}.json`), JSON.stringify(reg, null, 2), 'utf8');
      }
    }
  }

  // Step 5: retro. Deterministic stats run in every mode; the model half only outside dry-run, and only when a model
  // (real or fixture) is actually available.
  const stats = buildRetroStats(evidence, { dev: incumbentEval?.dev, holdout: incumbentEval?.holdout });
  const memoryProjection = projectForPrompt(memory);
  const rejectedStrategies = memory.rejectedStrategies || [];
  const { inference: modelInference, generatorModel, usingFixtures } = dryRun ? { inference: null, generatorModel: null, usingFixtures: false } : buildInference({ fixtures: fixturesDir, model, vision: options.vision });
  const retroResult = await runRetro({ inference: dryRun ? null : modelInference, stats, memoryProjection, rejectedStrategies });
  step(5, 'retro', `${retroResult.retro.lessons.length} lessons, ${retroResult.retro.next.length} next experiment(s) (${retroResult.skipped || 'model'})`);

  if (dryRun) {
    const summary = await writeReports({
      out: outDir, durableDir: null, learnRunId, mode: 'dry-run', at: now().toISOString(), incumbent, evidence,
      reduced: { families, newRegressions, missingRegressionCoverage }, retro: retroResult, candidates: [], evaluations: [], decisions: [],
      nextLoop: buildNextLoop({ learnRunId, incumbentRevision: incumbent.revision, memory, families, retro: retroResult, candidates: [], decisions: [], missingRegressionCoverage, evaluationWeaknesses: unreadableRegressionsNote, now: () => now().toISOString() })
    });
    step(12, 'report', `written to ${outDir} (dry run: nothing else changed)`);
    return { ...summary, rejectedThisRun: [], candidateRecords: [] };
  }

  // Step 6: hypothesize. hypotheses.mjs's fromRetro needs `.next` and `.skipped` both at the top level of the object
  // it receives; runRetro's own return shape nests `.next` under `.retro` and keeps `.skipped` beside it, so this is
  // the flattened view that call needs.
  const { nextLoop: priorNextLoop, ignoredReason: priorNextLoopIgnoredReason } = await loadPriorNextLoop(durableDir);
  const evaluationWeaknesses = [...unreadableRegressionsNote, ...(priorNextLoopIgnoredReason ? [priorNextLoopIgnoredReason] : [])];
  const retroForHypotheses = { ...retroResult.retro, skipped: retroResult.skipped };
  const hypotheses = proposeHypotheses({ retro: retroForHypotheses, families, memory, nextLoop: priorNextLoop, max: maxCandidates });
  const hypothesisFamilyMap = buildHypothesisFamilyMap(families);
  step(6, 'hypothesize', `${hypotheses.length} hypothesis(es), ${hypotheses.filter(h => h.governanceTouch?.touched).length} governance-touching`);

  // Step 7: candidates. Never invents one without a model (real or fixture): with neither, hypotheses are reported
  // but no worktree is created.
  const candidates = [];
  const candidatesById = new Map();
  if (modelInference) {
    for (const hypothesis of hypotheses) {
      let rawEdits;
      try {
        if (usingFixtures) { const { result } = await modelInference({ stage: 'edits', key: hypothesis.hypothesisKey }); rawEdits = normalizeEdits(result); }
        else {
          const family = hypothesisFamilyMap.get(hypothesis.hypothesisKey);
          const fileTexts = await readAllowlistedFiles(root, hypothesis.affectedModules);
          const devScenarios = devScenariosForFamily(existingCorpus, family);
          const { system, prompt } = buildEditsPrompt(hypothesis, memoryProjection, fileTexts, devScenarios);
          const { result } = await modelInference({ system, prompt, schema: EDITS_SCHEMA, stage: 'edits', key: hypothesis.hypothesisKey });
          rawEdits = normalizeEdits(result);
        }
      } catch (error) {
        candidates.push({ candidateId: `cand_${randomBytesFn(6).toString('hex')}`, learnRunId, parentRevision: incumbent.revision, hypothesisKey: hypothesis.hypothesisKey, hypothesis, generator: usingFixtures ? { fixture: true } : { model: generatorModel }, edits: [], filesChanged: [], worktree: { path: null, branch: null, commit: null }, governanceTouch: { touched: false, files: [], regions: [] }, status: 'invalid', reason: 'edits_unavailable', error: String(error.message || error), createdAt: now().toISOString() });
        continue;
      }
      if (!rawEdits.length) {
        // A hypothesis that produced no edits still becomes a recorded, failed candidate (section 7: "recorded as a
        // failed hypothesis"), never silently dropped — otherwise it is absent from madeThisRun and gets re-proposed
        // next run as if it had never been tried.
        candidates.push({ candidateId: `cand_${randomBytesFn(6).toString('hex')}`, learnRunId, parentRevision: incumbent.revision, hypothesisKey: hypothesis.hypothesisKey, hypothesis, generator: usingFixtures ? { fixture: true } : { model: generatorModel }, edits: [], filesChanged: [], worktree: { path: null, branch: null, commit: null }, governanceTouch: { touched: false, files: [], regions: [] }, status: 'invalid', reason: 'no_edits', createdAt: now().toISOString() });
        continue;
      }
      let candidate;
      try {
        candidate = await createCandidateFn({ root, learnRunId, incumbent: incumbentForCandidates, hypothesis, edits: rawEdits, generator: usingFixtures ? { fixture: true } : { model: generatorModel, effort: 'medium' }, worktreesDir });
      } catch (error) {
        candidate = { candidateId: `cand_${randomBytesFn(6).toString('hex')}`, learnRunId, parentRevision: incumbent.revision, hypothesisKey: hypothesis.hypothesisKey, hypothesis, generator: usingFixtures ? { fixture: true } : { model: generatorModel }, edits: rawEdits, filesChanged: [], worktree: { path: null, branch: null, commit: null }, governanceTouch: { touched: false, files: [], regions: [] }, status: 'invalid', reason: 'create_failed', error: String(error.message || error), createdAt: now().toISOString() };
      }
      candidates.push(candidate);
      candidatesById.set(candidate.candidateId, candidate);
    }
  }
  step(7, 'candidates', `${candidates.filter(c => c.status !== 'invalid').length} created, ${candidates.filter(c => c.status === 'needs_human_review').length} needs_human_review, ${candidates.filter(c => c.status === 'invalid').length} invalid`);

  // Steps 8-12 run inside a try/finally: an unhandled throw here (a crashed `node --test` in a worktree, a transport
  // failure) used to abort the whole loop before step 13 ever ran, leaving every worktree and its branch behind
  // (finding: no exception boundary around evaluate/review). Cleanup in the finally block always runs, whatever
  // happens above it; a genuine failure still propagates to main()'s catch after cleanup has had its turn.
  let summary;
  try {
    // Step 8: evaluate. A candidate stays evaluated even when it is already needs_human_review (governance touch is
    // never a reason to skip the numbers). A candidate whose evaluation itself throws (contract §10's "a review that
    // could not run" applies equally here) gets a minimal evaluation_incomplete record instead of aborting the loop.
    const evaluations = [];
    for (const candidate of candidates) {
      if (candidate.status === 'invalid') continue;
      try {
        const evalRecord = await evaluateTreeFn({ root: candidate.worktree.path, sets: ['tests', 'eval', 'dev', 'holdout'], learnRunId, candidateId: candidate.candidateId, revision: candidate.worktree.commit, out: join(outDir, candidate.candidateId), regressionsDir });
        evalRecord.parentRevision = candidate.parentRevision;
        evalRecord.governanceTouch = candidate.governanceTouch;
        evaluations.push(evalRecord);
      } catch (error) {
        evaluations.push({ evaluationId: `eval_incomplete_${candidate.candidateId}`, learnRunId, candidateId: candidate.candidateId, revision: candidate.worktree.commit, at: now().toISOString(), elapsedMs: 0, status: 'evaluation_incomplete', error: String(error.message || error).slice(0, 500), parentRevision: candidate.parentRevision, governanceTouch: candidate.governanceTouch });
      }
    }
    step(8, 'evaluate', `${evaluations.length} candidate(s) evaluated`);

    // Step 9: compare. The generating model's opinion never enters (compare() itself never sees it).
    const decisions = [];
    for (const evalRecord of evaluations) {
      const candidate = candidatesById.get(evalRecord.candidateId);
      const target = resolveTarget(candidate.hypothesis, hypothesisFamilyMap, existingCorpus);
      let decision;
      try { decision = compare(incumbentEval, evalRecord, { target, hypothesis: candidate.hypothesis }); }
      catch (error) { decision = { decision: 'rejected', reasons: [error.code || 'COMPARE_ERROR'], invariantViolations: [], newFailures: [], target: { before: null, after: null, improved: false }, holdout: { before: null, after: null, regressed: false }, metrics: { before: {}, after: {}, delta: {} } }; }
      decision.candidateId = candidate.candidateId;
      decisions.push(decision);
      candidate.status = decision.decision;
      candidate.reason = decision.reasons?.[0] || candidate.reason || null;
      candidate.reasons = Array.isArray(decision.reasons) ? [...decision.reasons] : [];
    }
    step(9, 'compare', `${decisions.filter(d => d.decision === 'promote_eligible').length}/${decisions.length} promote_eligible`);

    // Step 10: review. Only a candidate compare() called promote_eligible is reviewed; everything else already has
    // its terminal status. A review call that throws (no model, transport failure) falls back to the same
    // undefined-review path applyReviewDecision already treats as unreviewed (contract §10), rather than aborting.
    const reviewInference = wireReviewKey(dryRun ? null : modelInference, candidatesById);
    let reviewedCount = 0;
    for (const candidate of candidates) {
      if (candidate.status !== 'promote_eligible') continue;
      const evalRecord = evaluations.find(e => e.candidateId === candidate.candidateId);
      const decision = decisions.find(d => d.candidateId === candidate.candidateId);
      const diff = computeDiff(root, candidate);
      let review;
      try {
        review = await independentReview({
          candidate, diff, before: { metrics: incumbentEval.metrics }, after: { metrics: evalRecord.metrics, target: decision.target },
          inference: reviewInference, reviewModel: options.reviewModel || defaultReviewModel(generatorModel === 'fixture' ? 'sonnet' : (generatorModel || 'sonnet')), generatorModel
        });
      } catch (error) {
        review = undefined;
        candidate.reviewError = String(error.message || error).slice(0, 500);
      }
      const updated = applyReviewDecision(candidate, decision, review);
      Object.assign(candidate, updated);
      reviewedCount++;
    }
    step(10, 'review', `${reviewedCount} reviewed, ${candidates.filter(c => c.status === 'promote_eligible' && c.promoteEligible === true).length} promote_eligible`);

    // Step 11: memory.
    const runIds = evidence.runs.slice(0, 10).map(r => r.runId);
    const incidentIds = evidence.incidents.slice(0, 10).map(i => i.incidentId);
    const provenance = { runIds, incidentIds, learnRunId, source: 'retro' };
    const madeThisRun = new Set(candidates.map(c => c.hypothesisKey));
    const referencedHypothesisKeys = [
      ...(retroResult.retro.next || []).filter(n => !madeThisRun.has(n.hypothesisKey)).map(n => n.hypothesisKey),
      ...candidates.filter(c => c.status === 'rejected' || c.status === 'rejected_by_review').map(c => c.hypothesisKey)
    ];
    const delta = {
      lastIntakeAt: now().toISOString(),
      loops: [{ learnRunId, at: now().toISOString(), incumbentRevision: incumbent.revision, candidates: candidates.length, promoted: candidates.filter(c => c.status === 'promoted').length, rejected: candidates.filter(c => c.status === 'rejected' || c.status === 'rejected_by_review').length }],
      lessons: (retroResult.retro.lessons || []).map((lesson, i) => ({ id: `${learnRunId}_lesson_${i}`, text: lesson.text, status: 'provisional', confidence: 'low', provenance })),
      failureFamilies: families.map(f => ({ key: f.key, integration: f.integration, failureClass: f.failureClass, tool: f.tool, count: f.count, firstSeen: f.firstSeen, lastSeen: f.lastSeen, status: 'open', regressionIds: [...newRegressions.dev, ...newRegressions.holdout].filter(r => r.family === f.key).map(r => r.id), runIds: f.runIds, incidentIds: f.incidentIds })),
      rejectedStrategies: candidates.filter(c => c.status === 'rejected' || c.status === 'rejected_by_review').map(c => ({ hypothesisKey: c.hypothesisKey, summary: c.hypothesis?.proposedChange || c.hypothesis?.problem || '', reason: c.reason || 'rejected', candidateId: c.candidateId, evaluationId: evaluations.find(e => e.candidateId === c.candidateId)?.evaluationId || null, learnRunId })),
      nextExperiments: (retroResult.retro.next || []).filter(n => !madeThisRun.has(n.hypothesisKey)).map((n, i) => ({ hypothesisKey: n.hypothesisKey, summary: n.proposedChange || n.problem || '', priority: 5 - i, provenance: { ...provenance, source: 'retro' } })),
      trends: [{ learnRunId, at: now().toISOString(), metrics: projectTrendMetrics(incumbentEval?.metrics || {}) }],
      lineage: candidates.map(c => ({ candidateId: c.candidateId, parentRevision: c.parentRevision, hypothesisKey: c.hypothesisKey, decision: c.status, reason: c.reason || '', at: c.createdAt })),
      referencedHypothesisKeys
    };
    const merged = mergeMemory(memory, delta, { now: () => now().toISOString() });
    await saveMemory(memoryPath, merged.memory);
    step(11, 'memory', `${merged.memory.lessons.length} lessons, ${merged.memory.rejectedStrategies.length} rejected strategies, ${merged.rejected.length} rejected-memory-item(s)`);

    // Step 12: report.
    const nextLoop = buildNextLoop({ learnRunId, incumbentRevision: incumbent.revision, memory: merged.memory, families, retro: retroResult, candidates, decisions, missingRegressionCoverage, evaluationWeaknesses, now: () => now().toISOString() });
    const written = await writeReports({
      out: outDir, durableDir, learnRunId, mode: usingFixtures ? 'fixtures' : (model ? 'model' : 'template-only'), at: now().toISOString(), incumbent, evidence,
      reduced: { families, newRegressions, missingRegressionCoverage }, retro: retroResult, candidates, evaluations, decisions, nextLoop
    });
    step(12, 'report', `written to ${outDir}`);
    summary = { ...written, rejectedThisRun: merged.rejected, candidateRecords: candidates };
  } finally {
    // Step 13: cleanup. A promote_eligible, reviewer-approved candidate keeps its branch; everything else loses both
    // its worktree and its branch. Best effort: a candidate whose worktree never came up (invalid before git ran)
    // must not abort cleanup for the rest, and this now always runs even when the try block above threw.
    let removed = 0, kept = 0;
    for (const candidate of candidates) {
      if (candidate.status === 'invalid' || !candidate.worktree?.path) continue;
      const keepBranch = candidate.status === 'promote_eligible' && candidate.promoteEligible === true;
      try { await removeCandidateFn({ root, candidate, keepBranch }); keepBranch ? kept++ : removed++; }
      catch (error) { log(print, `step 13 of 13: cleanup ... warning: could not remove ${candidate.candidateId}: ${error.message || error}`); }
    }
    step(13, 'cleanup', `${removed} worktree(s) removed, ${kept} branch(es) kept`);
  }

  return summary;
}

// Validated at the promotion CLI boundary: a candidateId, branch or commit that fails its shape is refused before it
// ever reaches a git argv (finding: promoteCandidate touches git on unvalidated input; candidateId also selects the
// durable record file it reads, so join(durableDir,'candidates',`${candidateId}.json`) must never see a path
// segment of its own).
const CANDIDATE_ID_RE = /^cand_[0-9a-f]{12}$/;
const BRANCH_RE = /^agent-learning\/cand_[0-9a-f]{12}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;

// --promote <candidateId>: reads the candidate and its evaluation from the durable records, refuses unless the
// candidate is promote_eligible with an approving independent review, re-checks the branch's commit against the
// record, creates or moves the branch to that commit, and prints the merge command. Never merges, never pushes.
export async function promoteCandidate({ root = REPO_ROOT, durableDir = join(root, 'agent-learning'), candidateId, print = msg => console.log(msg) } = {}) {
  if (!CANDIDATE_ID_RE.test(candidateId || '')) { print(`Invalid candidate id: ${candidateId}.`); return { ok: false, reason: 'invalid_candidate_id' }; }
  const candidate = await readJsonSafe(join(durableDir, 'candidates', `${candidateId}.json`));
  if (!candidate) { print(`No candidate record for ${candidateId}.`); return { ok: false, reason: 'not_found' }; }
  if (candidate.status !== 'promote_eligible' || candidate.promoteEligible !== true) {
    print(`${candidateId} is not eligible to promote (status: ${candidate.status}).`);
    return { ok: false, reason: 'not_eligible' };
  }
  if (candidate.review?.verdict !== 'approve') {
    print(`${candidateId} has no approving independent review.`);
    return { ok: false, reason: 'unreviewed' };
  }
  const branch = candidate.worktree?.branch || `agent-learning/${candidateId}`;
  if (!BRANCH_RE.test(branch)) { print(`Invalid branch name recorded for ${candidateId}: ${branch}.`); return { ok: false, reason: 'invalid_branch' }; }
  const commit = candidate.worktree?.commit;
  if (!commit || !COMMIT_RE.test(commit)) { print(`${candidateId} has no valid recorded commit.`); return { ok: false, reason: 'no_commit' }; }
  let currentCommit = null;
  try { currentCommit = gitExec('git', ['rev-parse', branch], { cwd: root, encoding: 'utf8' }).trim(); } catch { /* branch does not exist yet */ }
  if (currentCommit && currentCommit !== commit) {
    print(`${branch} points at ${currentCommit}, not the recorded commit ${commit}. Refusing to move it automatically.`);
    return { ok: false, reason: 'commit_mismatch' };
  }
  if (!currentCommit) gitExec('git', ['branch', branch, commit], { cwd: root });
  await writeFile(join(durableDir, 'candidates', `${candidateId}.json`), JSON.stringify({ ...candidate, status: 'promoted' }, null, 2), 'utf8');
  print(`Branch ${branch} is ready at ${commit}.`);
  print(`git merge ${branch}`);
  return { ok: true, branch, commit };
}

// --verify: after a --fixtures run, asserts the three fixture scenarios (docs/AGENT_LEARNING_LOOP.md section 13)
// from the records runLoop itself produced this run (summary.candidateRecords, summary.rejectedThisRun), never the
// cumulative committed memory file — a prior run's rejection would otherwise make Scenario E's check pass forever
// even when this run intook nothing (finding: verify passes on a run that read zero evidence). Exits with a clear
// line per failed assertion rather than throwing on the first one, so a broken run reports everything wrong with it
// in one pass.
export function verifyFixtureSummary(summary) {
  const failures = [];
  const evidence = summary.evidence || {};
  if (evidence.runs !== 5) failures.push(`Expected 5 evidence runs read, got ${evidence.runs}.`);
  if (evidence.incidents !== 3) failures.push(`Expected 3 evidence incidents read, got ${evidence.incidents}.`);
  if (evidence.families !== 1) failures.push(`Expected 1 failure family reduced, got ${evidence.families}.`);

  const records = summary.candidateRecords || [];
  const byKey = key => records.find(c => c.hypothesisKey === key);

  const c1 = byKey('recovery_policy:transient_provider:max_attempts_4');
  if (!c1 || c1.status !== 'promote_eligible' || c1.promoteEligible !== true) failures.push(`Scenario C: expected recovery_policy:transient_provider:max_attempts_4 to be promote_eligible with promoteEligible=true, got ${c1?.status ?? 'no candidate'} (promoteEligible=${c1?.promoteEligible}).`);
  else if (!c1.worktree?.branch) failures.push('Scenario C: expected the promote_eligible candidate to retain a branch.');

  const c2 = byKey('reconciliation:blind_retry');
  const reasonsOf = c => [...(c?.reasons || []), c?.reason || ''].filter(Boolean);
  if (!c2 || c2.status !== 'rejected' || !reasonsOf(c2).includes('duplicate_effect')) failures.push(`Scenario D: expected reconciliation:blind_retry rejected duplicate_effect, got ${c2?.status ?? 'no candidate'} (${reasonsOf(c2).join(', ')}).`);

  const c3 = byKey('governance:skip_claim');
  if (!c3 || c3.status !== 'rejected' || !reasonsOf(c3).includes('dashclaw_bypass') || !c3.governanceTouch?.touched) failures.push(`Scenario D2: expected governance:skip_claim rejected dashclaw_bypass with governanceTouch, got ${c3?.status ?? 'no candidate'} (${reasonsOf(c3).join(', ')}), governanceTouch=${!!c3?.governanceTouch?.touched}.`);

  const plantedRejected = (summary.rejectedThisRun || []).some(r => r.field === 'lessons' && /instruction/i.test(r.reason || ''));
  if (!plantedRejected) failures.push('Scenario E: expected this run to refuse the planted instruction-like lesson (rejectedThisRun, field "lessons", an instruction-like reason).');

  return failures;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.promote) {
    const result = await promoteCandidate({ candidateId: args.promote });
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  if (args.verify && !args.fixtures) {
    console.error('--verify requires --fixtures.');
    process.exitCode = 1;
    return;
  }
  const outDir = args.out || undefined;
  const summary = await runLoop({
    dryRun: args.dryRun, fixturesDir: args.fixtures, dataDir: args.data, maxCandidates: args.maxCandidates,
    model: args.model, reviewModel: args.reviewModel, outDir
  });
  if (args.verify) {
    const failures = verifyFixtureSummary(summary);
    if (failures.length) {
      console.error('verify:learn failed:');
      for (const f of failures) console.error(`- ${f}`);
      process.exitCode = 1;
      return;
    }
    console.log('verify:learn passed: Scenario C promote_eligible, D and D2 rejected as expected, Scenario E lesson refused.');
  }
  process.exitCode = 0;
}

// Only a direct `node agent-learning/learn.mjs` runs the CLI; tests import runLoop/parseArgs/promoteCandidate/
// verifyFixtureSummary directly. Same path-based, case-insensitive comparison as agent-learning/regress.mjs (a
// percent-encoded URL pathname breaks on a checkout path containing a space).
if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === resolve(fileURLToPath(import.meta.url)).toLowerCase()) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
