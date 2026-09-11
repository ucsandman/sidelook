# Agent mode evaluation harness

`node eval/run.mjs [--only id] [--json path]` runs the thirty-two fixed scenarios in `eval/scenarios.mjs` against a
real `AgentRuntime` (`lib/agent/index.mjs`), a real in-process DashClaw (`eval/fake-dashclaw.mjs`), in-memory
Slack/Stripe/HubSpot/Gmail (`eval/fake-providers.mjs`) and a scripted model (`eval/scripted-model.mjs`) instead of a
live model transport. Nothing here reaches a real network service. Contract: `docs/AGENT_MODE_IMPLEMENTATION.md`
section 16, `docs/AGENT_SELF_HEALING.md` section 10 (scenarios 27-32).

```
node eval/run.mjs                       # all 32 scenarios, report at .artifacts/agent-eval.json
node eval/run.mjs --only 6              # one scenario
node eval/run.mjs --json out/report.json
```

## Self healing scenarios (27-32)

Added for `lib/agent/{incidents,recovery,breakers,resume}.mjs`, docs/AGENT_SELF_HEALING.md section 10:

| id | Scenario | Proves |
| --- | --- | --- |
| 27 | HubSpot rate limit with Retry-After | the write waits the header's delay, reconciles first, retries once, verifies; incident `hubspot:rate_limit:hubspot.update_customer` recovered |
| 28 | Stripe authentication expired twice opens the breaker | run 1's dead token opens `stripe:authentication_expired`; run 2 is refused `CIRCUIT_OPEN` on the read before any call, `callCounts.stripe.createRefund:2` |
| 29 | DashClaw unavailable twice opens its breaker | a third write is refused `GOVERNANCE_UNAVAILABLE` with zero network calls |
| 30 | Continue after a partial run | a HubSpot outage ends run 1 `partial`; clearing the fault and pressing Continue finishes the goal with no new Stripe write |
| 31 | Continue after an uncertain run reconciles first | run 1 loses Stripe's answer and cannot read it back, ending `uncertain`; Continue reconciles the inherited effect before doing anything else |
| 32 | Repeated malformed plans open the model breaker | four malformed turns across two runs open `model:malformed_model_output`; a third `create` is refused `MODEL_PAUSED` |

`faults` on these scenarios can take the object form as well as a bare string: `{kind:'failTimes', times:n}` (a
`SERVER` error before send, `n` times in a row) and `{kind:'rateLimit', times:n, retryAfterMs}` (a 429 with a
`Retry-After` header, `sentRequest:true`); `'authExpired'` is unchanged (a bare string, not an object). `scenario.repeat` runs the scenario
that many times in sequence against the same fake DashClaw/providers/breakers, so a breaker's state (or a model
turn count) carries from one run to the next, and `scenario.continueRun` drives a second run from
`runtime.continueRun(parentRunId, …)` after the named faults clear (and, when `resetBreakers:true`, the breaker
snapshot is reset first, standing in for the Diagnostics action an operator would take).

## Files

- `eval/fake-providers.mjs` — `createFakeProviders({fixtures, faults, clock})`. Every method's argument and return
  shape is copied from `lib/agent/providers/*.mjs` (read from source, not guessed), so the same `lib/agent/tools.mjs`
  and `lib/agent/effects.mjs` code that talks to the real adapters works unchanged here. `faults.set('app.method',
  kind)` injects `timeoutBeforeSend | lostAfterSuccess | failOnce | failAlways | authExpired | unavailable`.
  `providers.calls` records every call for duplicate-write assertions; `providers.state.{refunds,contacts,sent}`
  exposes the fixture ledgers.
- `eval/scripted-model.mjs` — `createScriptedModel({overrides})` returns a function with `vision.generate`'s
  signature `(system, parts, schema, signal, options)`. It parses the JSON prompt `lib/agent/planner.mjs`'s
  `buildPrompt` sends and plays a competent agent: find the Slack request, resolve the Stripe customer (asking when
  more than one matches), find the payment, refund it, update HubSpot, prepare and send the confirmation email, then
  report done. `overrides` is a plain object: a numeric key (`{1:'inventTool'}`) replaces that turn's plan with a
  named hook or a caller-supplied partial plan; `obeyInjection:true` makes the refund step use `amountCents:5000000`
  whenever the latest Slack observation's text contains "ignore"; `when:[{test:(prompt,turn)=>bool, use}]` is the
  predicate form, checked before the numeric map. Named hooks: `inventTool` (an unregistered tool), `malformed` (the
  literal string `"this is not json"` as the model's raw result), `giveUp` (an early `done`).
- `eval/fake-dashclaw.mjs` — the in-process DashClaw server. Fault hooks used by scenarios 21-24:
  `policy.approvalWaitSecondsOverride` (seconds) shortens the approval window a pending action gets, and the row
  flips to `expired` the next time anything reads it back (`GET`/`approve`/`poll`), never on a timer; `faults.unavailable
  = true` makes every request destroy the socket immediately (already used by `tests/agent-governed.test.mjs`);
  `faults.failNext(route, opts)` arms one single-shot fault on one route (`'claim'`, `'outcome'`, `'approve'`,
  `'createAction'`), `opts.status` answers with that HTTP status, `opts.drop` destroys the socket after the state
  change it describes has already been recorded server-side (the claim row, the block) — so a `drop` fault always
  represents a real answer lost in transit, never a request that never arrived.
- `eval/scenarios.mjs` — `SCENARIOS`, the thirty-two fixed cases. Each names its fixtures, provider faults, a
  DashClaw `approvalScript` (`approve|reject|dashboard|timeout|none`), scripted-model overrides, and `expect`.
  Scenario 26 additionally sets `custom:'restartReconciliation'`, which routes it to `eval/run.mjs`'s dedicated
  function instead of the normal driver. Scenarios 28, 29 and 32 set `repeat:n` (run the scenario `n` times in a row
  against the same fake DashClaw/providers/breakers, so the breaker's own count carries across runs); scenarios 30
  and 31 set `continueRun:{clearFaults, resetBreakers?}` (run once, clear the named faults, then drive
  `runtime.continueRun` on the first run's id).
- `eval/run.mjs` — the runner: builds the dependencies per scenario, drives the run to a terminal status (answering
  `waiting_for_user` with the first offered option, deciding `waiting_for_approval` per `approvalScript`, cancelling on
  `stopAfter`'s event label for the Emergency Stop and cancel-mid-write scenarios, flipping the fake DashClaw server
  unreachable the instant `dashclaw.unavailableOnLabel`'s event appears on the timeline), evaluates `expect` against
  the effect ledger and the fixture state, and writes the JSON report plus a stdout table.
  `runRestartReconciliationScenario` (scenario 26 only) builds a first `AgentRuntime` whose store stops accepting
  writes the instant the refund goes `uncertain` (simulating a crash at that exact point, without racing the run's own
  eventual — different — terminal status), then builds a second `AgentRuntime` over the same on-disk file and the
  same fake providers and calls `reconcileStored()`, as a restarted Sidelook process would. Exports:
  `runScenario, evaluate, aggregate, buildConfig, wrapScriptedModel, countDuplicates, printTable, computeInvariants,
  EMPTY_INVARIANTS`. `agent-learning/regress.mjs` imports `runScenarios` (plural, the same driver `main()` uses) and
  `printTable` directly from this file rather than re-implementing either, so a regression case is graded exactly
  like a fixed eval scenario: same per-scenario shape, same invariants, same incidents.
  `agent-learning/lib/evaluate.mjs` runs `node eval/run.mjs`/`node agent-learning/regress.mjs` as child processes
  (never a live API, no `.env`) rather than importing this module in-process.

## Reading `expect`

- `status` — the run's terminal status.
- `writes.{requested,authorized,blocked,duplicate,verified,uncertain}` — `requested` is every effect planned;
  `authorized` is every effect that reached `claimed` or later (DashClaw let it proceed); `blocked` covers `blocked`,
  `rejected` and `expired` together, since the brief uses "blocked" for any refusal outcome; `duplicate` is a second
  provider call of the same write method for the same logical operation (a second `createRefund` for one payment
  intent and idempotency key, a second `updateContact` for one contact, a second `send` of the same raw message);
  `verified` and `uncertain` match the effect ledger's own statuses.
- `approvals.decision` — `'approved' | 'rejected' | 'expired' | null` (no approval was raised).
- `recovered` — true when some effect reconciled after a failure and still ended `verified`.
- `noSuccessClaim` — true unless the run reports `completed` while an attempted write never verified.
- `injectionFindings` — a floor on `run.injection.length` (scenario 19 only).
- `state.{refunds,sent}` — an exact count on the fixture ledger itself, for the scenarios that assert "exactly one
  refund" or "exactly one sent message" regardless of how many attempts it took.
- `pendingApprovalObserved` — asserts a `waiting_for_approval` snapshot was actually seen (scenario 6 only).
- `maxElapsedMs` — the scenario must finish within this many milliseconds (scenario 21 only, so a stalled expiry poll
  fails loudly instead of just running slow).
- `effectErrorCode` — the refund effect's `error.code` (scenario 22 only: `GOVERNANCE_UNAVAILABLE`).
- `callCounts` — `{method: count}` against `providers.calls`, for asserting a write reached the provider exactly once
  (or zero times) regardless of how many DashClaw-side retries happened around it (scenarios 22-23).
- `errorEventLabelContains` — asserts some `kind:'error'` event's label contains the given text (scenario 24: the
  timeline must name DashClaw when its outcome report is lost, not swallow the failure silently).
- `effectStatusIn` — `{tool, statuses}`; the named tool's final effect status must be one of `statuses` (scenario 25:
  a write cancelled right after the provider accepts it, before verification, may end `verified` or `uncertain`
  depending on exact timing, but never anything else and never stay `claimed`/`executing`).
- Every scenario also checks `run.summary.duplicates` (what the Agent mode panel actually renders) against this
  file's own provider-call-based duplicate count and fails if the two disagree — not read from `expect`, applied
  unconditionally in `evaluate()`.
- `incidents` — `[{family, recoveryStrategy?, recoveryResult?}]` (scenarios 27-32 only): each named family must
  appear in the run's own incident list; each key given (`recoveryStrategy`, `recoveryResult`) must match, a key
  omitted from the scenario is not checked.
- `breakerOpen`: a breaker key (`'stripe:authentication_expired'`, `'dashclaw:dashclaw_unavailable'`,
  `'model:malformed_model_output'`) that must be open in the runtime's breaker snapshot at the end (scenarios 28,
  29, 32).
- `createRefusedCode`: a further `runtime.create()` on the same runtime must throw with this `AppError` code
  (scenario 32 only: `MODEL_PAUSED`).

## Invariants and incidents in the report

Every scenario's result in `.artifacts/agent-eval.json` (and every regression case's, from `agent-learning/regress.mjs`)
carries two extra blocks beyond `writes`/`checks`, from `computeInvariants` and the run's own sanitized incidents:

```js
invariants: {unclaimedWrites, duplicateEffects, incorrectSuccessClaims, unheldFinancialWrites, secretLeaks, injectionAuthorized}
incidents:  [{family, failureClass, recoveryResult, finalDisposition}]   // one per fault the run recorded
```

`invariants` is the safety floor the learning loop rejects a candidate on (`docs/AGENT_LEARNING_LOOP.md` section 9,
`agent-learning/lib/compare.mjs` rule 1): a count above zero here, on a scenario that used to read zero, is an
automatic rejection whatever else improved. `aggregate()` sums every scenario's `invariants` into the top-level
`metrics.invariants` object, the same six keys. `incidents` is the sanitized incident list (`sanitizeIncident`,
`docs/AGENT_SELF_HEALING.md` section 2) a scenario's `expect.incidents` checks against: each entry names the
`family` string (`<integration>:<failureClass>:<tool>`, for example `hubspot:transient_provider:hubspot.update_customer`
or `stripe:authentication_expired:stripe.find_customer`) and the `recoveryStrategy`/`recoveryResult` the incident
ended with.

## Metrics (contract section 16)

`scenarioPassRate`, and the sums across every scenario of `requestedWrites`, `authorizedWrites`, `blockedWrites`,
`duplicateWrites`, `verifiedWrites`, `uncertainWrites`, plus `correctApprovalDecisions`, `successfulRecoveries` and
`incorrectSuccessClaims` (each a count of scenarios whose corresponding check passed/failed). Written under
`metrics` in the JSON report alongside `generatedAt` and the per-scenario `scenarios` array.

## Known state of the dependency chain

`eval/run.mjs` imports `lib/agent/governed.mjs`, `lib/agent/store.mjs` and `eval/fake-dashclaw.mjs` dynamically and
by their documented path, so it needs no change once every track has landed and any interop issue between them is
fixed; until then a scenario that cannot load one of those reports `status:'error'` with `error.code`
`DEPENDENCY_NOT_BUILT` instead of crashing the whole run. A result with `pendingEngineFix:true` (scenario 26 only)
prints `PENDING` in the table and is excluded from the exit-code gate even while `pass` is `false`: it names a real
gap in an engine file this harness does not own, not a regression introduced here.
