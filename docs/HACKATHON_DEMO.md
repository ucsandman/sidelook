# Agent mode: the two-minute demo

Setup: `docs/HACKATHON_SETUP.md`. Architecture: `docs/HACKATHON_ARCHITECTURE.md`. Reliability: `docs/HACKATHON_RELIABILITY.md`.

## Pre-demo checklist

- [ ] **Health green.** `npm run agent:health` prints `ok` for every configured integration and `ready: yes`
      (an app you have not set up yet does not count against `ready`; get every app you plan to demo configured
      first). The panel's five app dots in Agent mode read the same check.
- [ ] **Policies installed.** `npm run agent:setup-dashclaw` prints all six rows `created` or `present`, none
      `failed`.
- [ ] **Seed present.** `npm run agent:seed` has run since the world was last reset (see "Between runs" below).
- [ ] **Model chosen.** Settings, pick the model for this run.
- [ ] **Effort low.** Settings, Advanced, effort set to low.
- [ ] **DashClaw dashboard open.** A browser tab on the DashClaw instance's `/approvals` page, signed in with the
      approver account, ready to switch to.

## The script (2:00)

Measured live on 2026-09-11 (Claude Code, Haiku 4.5, low effort, real Slack, Stripe test mode, HubSpot, Gmail and
DashClaw): Demo A took 137 to 174 s from Start to the summary, Demo B 180 s, Demo C 68 s. A model turn takes 10 to
20 s and a run needs 5 to 12 of them, so the minute marks below are the talk track, not the run time. Start Demo A
before 0:00 and narrate the rows as they arrive, and run Demo B ahead of time and open it from the run list; Back and
Open keep a run on screen.

### 0:00 to 0:20: what this is

Say: "Sidelook usually looks at one window and answers a question about it. Agent mode is different. I give it a
business outcome, and it works across four separate apps to reach it, while a person holds every consequential
decision."

Click: Settings, then **Agent mode · give Sidelook a business outcome across Slack, Stripe, HubSpot and Gmail**.

### 0:20 to 1:20: Demo A, the approval card and verified writes

Type into the goal box, exactly:

```
Acme cancellation: refund the last payment, mark the CRM lead unqualified, and email confirmation.
```

Click **Start**.

Narrate the timeline rows as they fill in: the Slack request found, the Stripe customer and payment matched, the
refund proposed. When the **DashClaw policy approval** card renders, read its fields aloud: app, operation,
customer, amount, the agent's own reason, the source evidence, the policy reason, the risk score, the action id.

Say: "This refund does not run until I say so, or someone does on the DashClaw dashboard."

Click **Approve**.

Wait for the timeline to show the refund verified, the HubSpot update verified, and the Gmail send verified. Point
at the summary line at the bottom (apps touched, tool calls, writes planned and verified, approvals, duplicate side
effects, anything unresolved) and say: "Every one of those numbers comes from a second read of the provider, not
from the model's own words."

### 1:20 to 1:45: Demo B, recovery

Set up ahead of time (not on stage): `HACKATHON_FAIL_HUBSPOT_ONCE=1` in `.env`, restart Sidelook, and reseed
(`npm run agent:seed -- --reset`) so there is a fresh payment to refund.

Run the same goal string as Demo A and approve the refund again. When the HubSpot row fails, narrate the rows as
they appear: "HubSpot update failed. Checking previous effects. Previous Stripe refund verified. Retrying HubSpot
safely. HubSpot update verified." Then: "Recovered."

Say: "That's the same run recovering: no duplicate refund, no second email, one write retried after Sidelook proved
the earlier one was untouched."

### 1:45 to 2:00: Demo C, the block and the paper trail

Type into the goal box, exactly:

```
Globex cancellation: refund $5,000 for the last payment.
```

Click **Start**. Globex is the seed's second customer: one $5,000.00 payment, above the $1,000.00 refund ceiling
(`AGENT_REFUND_MAX_CENTS`). The timeline shows the refund blocked by DashClaw policy, the risk ceiling, never even
offered for approval. (Asking for $50,000 on Acme's $485.00 payment is a different thing: the runtime refuses it
before DashClaw is asked, "only $485.00 is refundable", and the model may correct the amount.)

Switch to the DashClaw dashboard tab, open **/decisions**, and open the blocked action's own page at
**/decisions/`<action id>`** (the action id is also visible under the blocked row's Details in Sidelook). Show the
matched policy and the reasons on that page.

Close on the summary block: 0 writes verified, 1 blocked, 0 unresolved. Say: "Sidelook decided nothing here.
DashClaw did, and it's on the record."

## Demo D: a failure becomes a regression, and a candidate gets evaluated (2:00)

Run ahead of time (not on stage):

```
npm run verify:learn
```

This runs `node agent-learning/learn.mjs --fixtures agent-learning/fixtures --out .artifacts/agent-learning/verify --max-candidates 3 --verify`
end to end: five synthetic runs and their incidents, a retrospective from the canned fixture model, three candidates
each tried in its own git worktree, each evaluated against the fixture suite and compared against the incumbent;
the one candidate that clears comparison is then independently reviewed.
Nothing here touches a live run or the main tree. The console prints one line per step, for example:

```
step 1 of 13: freeze ... revision <12 hex> (working tree dirty; the incumbent is HEAD)
step 2 of 13: intake ... 5 runs, 3 incidents
step 3 of 13: reduce ... 1 families, 1 new dev regression(s), 0 new holdout regression(s)
step 4 of 13: baseline ... <pass>/<total> tests, <pass>/<total> eval, <pass>/<total> dev, <pass>/<total> holdout
step 5 of 13: retro ... 3 lessons, 3 next experiment(s) (model)
step 6 of 13: hypothesize ... 3 hypothesis(es), 2 governance-touching
step 7 of 13: candidates ... 3 created, 2 needs_human_review, 0 invalid
step 8 of 13: evaluate ... 3 candidate(s) evaluated
step 9 of 13: compare ... <n>/3 promote_eligible
step 10 of 13: review ... <n> reviewed, <n> promote_eligible
step 11 of 13: memory ... 2 lessons, 2 rejected strategies, 1 rejected-memory-item(s)
step 12 of 13: report ... written to .artifacts/agent-learning/verify
step 13 of 13: cleanup ... 2 worktree(s) removed, 1 branch(es) kept
```

`--verify` then checks the run's own records against `agent-learning/learn.mjs`'s `verifyFixtureSummary()` and prints
one line: `verify:learn passed: Scenario C promote_eligible, D and D2 rejected as expected, Scenario E lesson
refused.` A failing check names the exact assertion that did not hold, never a bare exit code.

Open `.artifacts/agent-learning/verify/learning_report.md` on screen and narrate straight down it:

- **What happened.** "Five runs and three incidents read, reduced to one failure family: HubSpot transient failures
  that exhausted the retry budget. One new dev regression scenario was written from that family. Three candidates
  were tried this run."
- **What failed.** The two rejected candidates and their reasons, read straight from the file.
- **Candidates tried.** Three rows: `recovery_policy:transient_provider:max_attempts_4` (raises the HubSpot retry
  budget from 3 to 4 attempts), `reconciliation:blind_retry` (skips the reconciliation read on a lost response and
  retries directly), `governance:skip_claim` (skips the DashClaw execution claim). Say: "One candidate raises a
  number. The other two are exactly the kind of shortcut that looks like a fix and is actually a safety hole, and
  the loop is built to catch both of them by name."
- **Safety checks that ran.** `compare.mjs`'s six zero-tolerance invariants (`unclaimedWrites, unheldFinancialWrites,
  duplicateEffects, incorrectSuccessClaims, secretLeaks, injectionAuthorized`), checked across every eval, dev
  and holdout case (the test suite contributes pass/fail only). `reconciliation:blind_retry` trips `duplicateEffects` the moment it skips the reconciliation
  read: a second refund shows up where only one should. `governance:skip_claim` trips `unclaimedWrites` the moment
  it skips the DashClaw claim, and it also touched a protected region of `lib/agent/effects.mjs`, so its record
  carries `governanceTouch:true` on top of the rejection. Say: "The loop doesn't have to know these are dangerous
  in advance. It runs the same eval suite everything else runs, and a write that shouldn't have happened twice,
  or that happened with no governance record, fails the same invariant a live run would fail."

Switch to the panel. Open a run that ended `partial` (Demo B with a HubSpot outage that never recovered works, or
scenario 30's setup by hand). Press **Diagnostics**: the incident list names the failure class, the recovery
strategy that was tried, and how it ended; the breaker table shows anything still paused. Press **Continue**: say
"This is the online half of the same idea. Nothing here rewrites Sidelook's code. It reads what already happened
and picks up from the earliest thing that isn't proven yet, never repeating a write that already went through."

## Between demo runs

`npm run agent:seed` creates the demo customer's Slack message, Stripe customer and payment, and HubSpot contact
(`AGENT_DEMO_CUSTOMER` / `AGENT_DEMO_DOMAIN`, default Acme / acme.com; set `AGENT_DEMO_EMAIL` to an inbox you control, because Demo A really sends the confirmation there). It also seeds Demo C's Globex customer (a $5,000.00 payment and its own Slack request). Run it once before the
first Demo A or Demo B of the session. Demo C's refund is blocked before any write is attempted, so it never needs a
reseed of its own.

Between Demo A and Demo B (both refund the same demo payment), run:

```
npm run agent:seed -- --reset
```

This re-seeds only Stripe (a fresh refundable payment) and HubSpot (the status property put back to its starting
value); Slack and Gmail need nothing redone between demos, so `--reset` leaves them alone.

## Failure playbook

- **The approval card never appears.** Check the DashClaw dashboard's `/approvals` tab directly; the action may
  already be sitting there even if Sidelook's own 3-second poll has not caught up. If the DashClaw dot in Agent mode
  is not green, check `DASHCLAW_BASE_URL` and `DASHCLAW_API_KEY` in `.env` and restart Sidelook.
- **A provider is down** (its dot reads muted or amber, or `npm run agent:health` prints `FAIL` for it). The
  detail string on the dot or the health line names the exact error. Demo C only needs Stripe and DashClaw, so it
  can still run if Slack, HubSpot or Gmail are the ones down; narrate what changed instead of pretending nothing
  did. As a fallback with no live call at all, show `node eval/run.mjs` on screen: the 20/20 fixture pass proves the
  same reliability claims without touching a real account.
- **The model stalls** (the same "Thinking" step for 15+ seconds). It is still inside the loop's own turn cap (14
  turns) and a local request queue that waits up to a minute for another call to finish; give it about 20 seconds
  per turn before acting. **Stop** in the footer, or **Ctrl+Shift+F12** from anywhere, ends the run without undoing
  anything already verified; reseed and start again.
