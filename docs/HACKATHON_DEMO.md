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
they appear: "HubSpot update failed. Checking previous effects. Stripe refund already verified. Retrying HubSpot.
HubSpot update verified."

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
