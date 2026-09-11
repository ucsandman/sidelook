# Regression corpus

`dev/` and `holdout/` each hold `reg_*.json` regression scenario files: fixed evaluation cases the learning loop
grows from runtime evidence. Contract: `docs/AGENT_LEARNING_LOOP.md` section 8.

## Where they come from

- **Starters** (this commit): five hand-verified cases seeded before any real evidence existed, so the loop and
  `agent-learning/regress.mjs` have something to run from day one. Each was checked against the current tree with
  `runScenarios` (`eval/run.mjs`) before being committed; every one passed, so `status` is `"confirmed"`.
- **Reduced from incidents** (every learning run after that): `agent-learning/lib/reduce.mjs`'s
  `incidentsToFamilies` groups sanitized incidents into failure families, then `familyToRegression` maps a
  qualifying family to a fault and an expectation through `REDUCTION_TABLE`, a fixed, hand-written table — never
  model-generated, because a regression file is the loop's own ground truth. A family with no entry in the table
  produces no file and is listed under `missingRegressionCoverage` in `next_loop.json` instead.

## Schema

```js
{
  id,                 // 'reg_' + a family slug + 4 hex chars of the fingerprint
  name, set,          // 'dev' | 'holdout'
  status,             // 'proposed' (not yet observed passing on the incumbent) | 'confirmed' (it does)
  family,             // '<integration>:<failureClass>:<tool>' (docs/AGENT_SELF_HEALING.md section 2)
  source: { incidentIds, runIds, learnRunId, createdAt },
  fingerprint,        // sha256 over the sorted {goal, fixtures, faults, dashclaw, model} — the case's identity,
                       // independent of id, name, status or evidence trail
  goal, fixtures, faults, dashclaw, model,
  expect: { status, writes, approvals, recovered, noSuccessClaim, state?, callCounts?, incidents? }
}
```

`faults` values are `eval/fake-providers.mjs` fault kinds: a bare string (`'lostAfterSuccess'`, `'timeoutBeforeSend'`,
...) or the counted object form `{kind:'failTimes'|'rateLimit', times, retryAfterMs?}`. `expect.writes` only needs
the keys a case actually asserts (`eval/run.mjs`'s evaluator checks exactly the keys present, nothing else).

## Set assignment

The first case ever recorded for a family goes to `dev` (the generator must be able to see at least one example of
every family it is asked to fix). Later, distinct-fingerprint cases for the same family alternate `dev`/`holdout`
by the hash of `(family key, case index)` — `agent-learning/lib/reduce.mjs`'s `assignSet`. A family with two or
more cases therefore always has a holdout case backing its dev case, so a candidate cannot pass by memorizing the
one example it was shown.

## Running the corpus

`node agent-learning/regress.mjs --set dev|holdout|all [--root <tree>] [--json <path>]` loads every `reg_*.json` in
the chosen set(s), validates it against this schema, and runs it through `eval/run.mjs`'s scenario driver — the
same pass/fail, invariants and incidents shape as the fixed eval suite (`eval/scenarios.mjs`). A `proposed` case
that passes on the incumbent is marked `confirmed` in its own file by the learning loop (coverage gained); one that
still fails stays `proposed` and is a target for a candidate.

## What must never happen

`holdout/` is never shown to a candidate generator (`docs/AGENT_LEARNING_LOOP.md` section 7: a test asserts the
assembled generation prompt contains no holdout scenario id and no holdout file content) and a candidate may never
edit anything under `agent-learning/regressions/holdout/` (`lib/candidates.mjs`'s `PROTECTED` list).
