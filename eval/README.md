# Agent mode evaluation harness

`node eval/run.mjs [--only id] [--json path]` runs the twenty fixed scenarios in `eval/scenarios.mjs` against a real
`AgentRuntime` (`lib/agent/index.mjs`), a real in-process DashClaw (`eval/fake-dashclaw.mjs`), in-memory Slack/Stripe/
HubSpot/Gmail (`eval/fake-providers.mjs`) and a scripted model (`eval/scripted-model.mjs`) instead of a live model
transport. Nothing here reaches a real network service. Contract: `docs/AGENT_MODE_IMPLEMENTATION.md` section 16.

```
node eval/run.mjs                       # all 20 scenarios, report at .artifacts/agent-eval.json
node eval/run.mjs --only 6              # one scenario
node eval/run.mjs --json out/report.json
```

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
- `eval/scenarios.mjs` — `SCENARIOS`, the twenty fixed cases. Each names its fixtures, provider faults, a DashClaw
  `approvalScript` (`approve|reject|dashboard|timeout|none`), scripted-model overrides, and `expect`.
- `eval/run.mjs` — the runner: builds the dependencies per scenario, drives the run to a terminal status (answering
  `waiting_for_user` with the first offered option, deciding `waiting_for_approval` per `approvalScript`, cancelling on
  `stopAfter`'s event label for the Emergency Stop scenario), evaluates `expect` against the effect ledger and the
  fixture state, and writes the JSON report plus a stdout table.

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

## Metrics (contract section 16)

`scenarioPassRate`, and the sums across every scenario of `requestedWrites`, `authorizedWrites`, `blockedWrites`,
`duplicateWrites`, `verifiedWrites`, `uncertainWrites`, plus `correctApprovalDecisions`, `successfulRecoveries` and
`incorrectSuccessClaims` (each a count of scenarios whose corresponding check passed/failed). Written under
`metrics` in the JSON report alongside `generatedAt` and the per-scenario `scenarios` array.

## Known state of the dependency chain

`eval/run.mjs` imports `lib/agent/governed.mjs`, `lib/agent/store.mjs` and `eval/fake-dashclaw.mjs` dynamically and
by their documented path, so it needs no change once every track has landed and any interop issue between them is
fixed; until then a scenario that cannot load one of those reports `status:'error'` with `error.code`
`DEPENDENCY_NOT_BUILT` instead of crashing the whole run.
