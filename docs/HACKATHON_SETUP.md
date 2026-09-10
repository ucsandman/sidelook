# Agent mode setup

Agent mode has its own screen, its own credentials, and its own server: DashClaw for governance, Slack for the request, Stripe and HubSpot for the writes, Gmail for the reply. Nothing here touches Computer mode or the prototype builder. Every credential lives in `.env`, which is never committed; copy `.env.example` to `.env` and fill it in as you go through this page. Contract: `docs/AGENT_MODE_IMPLEMENTATION.md`.

Steps marked **one-time** are per person, per DashClaw org, or per Google/Slack/Stripe/HubSpot account — do them once and they hold across demos. Steps marked **per demo** reset the world so the next run has something to find.

## 1. DashClaw

DashClaw is what decides whether a Stripe refund or a Gmail send may actually happen. Agent mode never writes anywhere without it.

1. **One-time.** Get an instance: either self-host with `npx dashclaw up` (prints the local URL, typically `http://localhost:3000`, once setup finishes) or use a hosted DashClaw org you already have.
2. **One-time.** Sign in, open **/api-keys**, and create two keys:
   - An **agent** key with the **member** role. This is `DASHCLAW_API_KEY`.
   - An **approver** key with the **admin** role. This is `DASHCLAW_APPROVER_API_KEY`.

   Two keys, not one: DashClaw refuses to let a key approve the actions it recorded itself. If the agent key could also approve, "a human held the refund" would be a fiction — the agent would be nodding at its own request. The admin-role key belongs to whoever clicks Approve or Reject; keep it out of anything the model touches.
3. **One-time.** Set `DASHCLAW_BASE_URL`, `DASHCLAW_API_KEY`, `DASHCLAW_APPROVER_API_KEY` in `.env`. `DASHCLAW_AGENT_ID` defaults to `sidelook-agent`; only change it if you created the keys under a different agent id.
4. **One-time per DashClaw org.** Run:
   ```
   npm run agent:setup-dashclaw
   ```
   This installs six policies, scoped to `DASHCLAW_AGENT_ID` only, so they never affect another agent on the same org: refunds always need a human, a low-confidence write is held, anything over the risk ceiling is blocked outright, an email that doesn't trace to a verified fact is blocked, Stripe/HubSpot/Gmail are the only action types the agent may declare, and a write with no evidence attached is blocked. It prints a table (name, type, status) — `created` for a new row, `present` if it's already there, `failed` with the server's own error if something went wrong — and exits non-zero on any failure. Safe to run again; it never duplicates a row. Add `--dry-run` to see the bodies it would send without sending them, or `--remove` to delete the six rows by name (also dry-runnable).
5. Approvals show up at **/approvals** on the DashClaw instance while they're pending, and every decision — approved, rejected, expired — lands in the audit trail at **/decisions**, one row per action id, with the detail page at **/decisions/`<action id>`**.

## 2. Slack

Where the agent reads the customer's request.

1. **One-time.** At api.slack.com, create an app "from scratch" in your workspace.
2. **One-time.** Under **OAuth & Permissions**, add bot token scopes `channels:history`, `channels:read`, `chat:write`, `users:read`. `chat:write` is only used by the seed script (`SLACK_SEED_CHANNEL`), not by the agent itself.
3. **One-time.** Install the app to the workspace and copy the **Bot User OAuth Token** into `SLACK_BOT_TOKEN`.
4. **Per demo (or one-time if you keep a fixed channel).** Invite the bot to the channel(s) it should search (`/invite @your-app-name` in each channel), and set `SLACK_CHANNELS` to the comma-separated channel names or ids.

## 3. Stripe

Test mode only. Agent mode never writes to a live Stripe account unless `STRIPE_ALLOW_LIVE=1` is set on purpose — leave it unset.

1. **One-time.** In the Stripe dashboard, switch to **test mode**, then **Developers → API keys → Create restricted key**. Grant exactly: Customers (read), Payment Intents (read), Charges (read), Refunds (write), Balance (read). Nothing else.
2. **One-time.** Put the restricted key in `STRIPE_SECRET_KEY` (it starts `rk_test_`; a plain secret key `sk_test_...` also works if you'd rather not scope permissions by hand). Leave `STRIPE_ALLOW_LIVE` unset.
3. **Per demo.** Create a test customer with a real name and email, and give it one **succeeded** payment (test card `4242 4242 4242 4242` in Checkout or a PaymentIntent confirmed directly) so there's something refundable. `npm run agent:seed` does this for `AGENT_DEMO_CUSTOMER` / `AGENT_DEMO_DOMAIN` if you'd rather not click through the dashboard.

## 4. HubSpot

1. **One-time.** In your HubSpot account, go to **Settings → Integrations → Private Apps**, create one, and grant scopes `crm.objects.contacts.read` and `crm.objects.contacts.write`.
2. **One-time.** Copy the private app token into `HUBSPOT_ACCESS_TOKEN`.
3. **One-time.** Check the status property exists: **Settings → Properties → Contact properties**, search for the value in `HUBSPOT_STATUS_PROPERTY` (default `hs_lead_status`). It ships on every HubSpot portal by default; if you renamed or removed it, either restore it or point `HUBSPOT_STATUS_PROPERTY` at a property you do have.
4. **One-time.** Set `HUBSPOT_STATUS_VALUE` (default `UNQUALIFIED`) and `HUBSPOT_ALLOWED_VALUES` to the comma-separated values the agent is allowed to write. A value outside that list is refused before any write is attempted — check the property's allowed values on the same settings page (a dropdown/enumeration property lists them; a free-text property has none to check).

## 5. Gmail

1. **One-time.** In the Google Cloud console, create a project, then **APIs & Services → Enable APIs** and enable the **Gmail API**.
2. **One-time.** **APIs & Services → Credentials → Create credentials → OAuth client ID**, application type **Desktop app**. Copy the client id and secret into `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET`.
3. **One-time.** Under **OAuth consent screen**, add the Gmail account you'll send from as a **test user** (the app stays in testing mode; no Google review needed for this hackathon).
4. **One-time (repeat only if the refresh token is revoked).** Run:
   ```
   npm run agent:gmail-auth
   ```
   It prints a Google consent URL, opens it in your browser with `--open`, waits for the loopback callback, exchanges the code, and prints one line — `GMAIL_REFRESH_TOKEN=...` — exactly once. Paste that line into `.env`.
5. **One-time.** Set `GMAIL_FROM` to the same address that completed the consent screen.

## 6. Seed, health and evaluation

| Command | What it does | Cadence |
| --- | --- | --- |
| `npm run agent:health` | Checks all five integrations (Slack, Stripe, HubSpot, Gmail, DashClaw) and prints what's configured, what's reachable, and what's missing. | Run any time; safe to run repeatedly. |
| `npm run agent:seed` | Creates the demo customer's Slack message, Stripe customer and payment, and HubSpot contact so a run has something real to find. | **Per demo.** |
| `npm run agent:setup-dashclaw` | Installs the six DashClaw policies (section 1 above). | **One-time per DashClaw org**, safe to repeat. |
| `npm run eval:agent` | Runs the fixture-backed scenario suite against a real `AgentRuntime` and a fake DashClaw/Slack/Stripe/HubSpot/Gmail — no real credentials or network calls. | Any time; this is the regression suite, not a live check. |
| `RUN_LIVE_AGENT_TESTS=1 npm run test:agent-live` | Runs the tests that hit your real, configured integrations. Skips itself (not a failure) when the flag is unset. | **Per demo**, after seeding, to prove the real accounts are wired correctly. |

## Windows PowerShell: setting one env var for one command

Don't edit `.env` for a one-off override — set it inline for that single command and it won't leak into your next shell:

```powershell
$env:HACKATHON_FAIL_HUBSPOT_ONCE = "1"; npm run agent:seed; Remove-Item Env:\HACKATHON_FAIL_HUBSPOT_ONCE
```

For a single value that must not persist even on failure, `powershell -NoProfile -Command` with the variable set in that subshell only also works:

```powershell
powershell -NoProfile -Command "$env:RUN_LIVE_AGENT_TESTS='1'; npm run test:agent-live"
```
