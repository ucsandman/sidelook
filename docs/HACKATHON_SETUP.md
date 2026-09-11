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
   This installs six policies, scoped to `DASHCLAW_AGENT_ID` only, so they never affect another agent on the same org: refunds always need a human, a low-confidence write is held, anything over the risk ceiling is blocked outright, an email that doesn't trace to a verified fact is blocked, Stripe/HubSpot/Gmail are the only action types the agent may declare, and a write with no evidence attached is blocked. It prints a table (name, type, status): `created` for a new row, `present` if it's already there, `failed` with the server's own error if something went wrong, and exits non-zero on any failure. Safe to run again; it never duplicates a row. Add `--dry-run` to see the bodies it would send without sending them, or `--remove` to delete the six rows by name (also dry-runnable).

   Every row opts into DashClaw's Short List (`short_list: true`), which is what keeps it interrupting; an org has ten interrupting slots. The two holds (refunds, and a low-confidence write) are also `ungrantable: true`. Without it, DashClaw's interruption budget turns a hold into a warning, with no human review, once the same kind of action has asked more than 10 times in 24 hours, which a morning of demo runs reaches. Ungrantable stops that automatic relief; your own Approve still releases the refund. A row installed before this change reports `present but ungrantable stored as (none)`: run `npm run agent:setup-dashclaw -- --remove`, then install again. The installer reads each row back and reports `created but action stored as warn` rather than `created` when the server softened it. The first four rows are the ones the demos need. The last two (`only api and email`, `writes carry evidence`) are defence in depth for rules the runtime already enforces; if the table says `The Short List is full (10 of 10)` for them, free two slots at **/policies** or leave them out. `npm run agent:health` reports how many of the six are installed.

   Checked live on 2026-09-10 against a hosted org: with `DASHCLAW_AGENT_ID` set to a different id than the one the rows were installed under, every refund came back `allowed` and no card appeared, because the rows are scoped by agent id. Keep the id in `.env` and the installer's id the same (`sidelook-agent` unless you have a reason). And a single admin key used for both roles answers `SELF_APPROVAL` on Approve: the agent key must be a second, member-role key.
5. Approvals show up at **/approvals** on the DashClaw instance while they're pending, and every decision — approved, rejected, expired — lands in the audit trail at **/decisions**, one row per action id, with the detail page at **/decisions/`<action id>`**.

## 2. Slack

Where the agent reads the customer's request.

1. **One-time.** At api.slack.com, create an app "from scratch" in your workspace.
2. **One-time.** Under **OAuth & Permissions**, add bot token scopes `channels:history`, `channels:read`, `chat:write`, `users:read`. `chat:write` is used only by `npm run agent:seed` to post the demo customer's request into `SLACK_SEED_CHANNEL`; the agent itself only reads (`channels:history`, `channels:read`).
3. **One-time.** Install the app to the workspace and copy the **Bot User OAuth Token** into `SLACK_BOT_TOKEN`.
4. **Per demo (or one-time if you keep a fixed channel).** Invite the bot to the channel(s) it should search (`/invite @your-app-name` in each channel), and set `SLACK_CHANNELS` to the comma-separated channel names or ids.
5. **Per demo (or one-time if you keep a fixed channel).** Invite the bot to the channel `npm run agent:seed` should post the demo request into, and set `SLACK_SEED_CHANNEL` to its name or id (not in `.env.example`; add it to `.env` by hand). It can be the same channel as `SLACK_CHANNELS` or a separate one.

## 3. Stripe

Test mode only. Agent mode never writes to a live Stripe account unless `STRIPE_ALLOW_LIVE=1` is set on purpose — leave it unset.

1. **One-time.** In the Stripe dashboard, switch to **test mode**, then **Developers → API keys → Create restricted key**. Grant exactly: Customers (read), Payment Intents (read), Charges (read), Refunds (write), Balance (read). Nothing else.
2. **One-time.** Put the restricted key in `STRIPE_SECRET_KEY` (it starts `rk_test_`; a plain secret key `sk_test_...` also works if you'd rather not scope permissions by hand). Leave `STRIPE_ALLOW_LIVE` unset.
3. **Per demo.** Create a test customer with a real name and email, and give it one **succeeded** payment (test card `4242 4242 4242 4242` in Checkout or a PaymentIntent confirmed directly) so there's something refundable. `npm run agent:seed` does this for `AGENT_DEMO_CUSTOMER` / `AGENT_DEMO_DOMAIN` (default Acme / acme.com) if you'd rather not click through the dashboard; see section 6.

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
| `npm run agent:health` | Prints one line per integration (Slack, Stripe, HubSpot, Gmail, DashClaw): `ok` or `FAIL` and a detail string (Slack `ok` means the token also lists channels and reads the first configured channel, so a token missing `channels:read` or `channels:history`, or a bot not invited to the channel, fails here rather than mid-run), the DashClaw line adding the approver role and whether the non-fabrication policy is present. `ready: yes` means every *configured* app answered; an app you haven't set up yet doesn't count against it. `--json` prints the raw health object and sets the exit code from `ready` instead. | Run any time; safe to run repeatedly, makes no writes. |
| `npm run agent:seed` | Creates the demo customer (`AGENT_DEMO_CUSTOMER` / `AGENT_DEMO_DOMAIN`, default Acme / acme.com; its address is `AGENT_DEMO_EMAIL`, which should be an inbox you control since Demo A really emails it) in Stripe (one succeeded, refundable $485.00 payment) and HubSpot (a contact with the status property set away from the target value), posts the cancellation request into `SLACK_SEED_CHANNEL` if that's set, and does the same for Demo C's Globex customer (a $5,000.00 payment over the refund ceiling; address `AGENT_DEMO_BLOCK_EMAIL`, default a +globex alias of the demo inbox). Idempotent: safe to run again before every demo, refuses to touch a live Stripe key. Gmail gets a profile read only, never a message. `npm run agent:seed -- --reset` re-seeds only Stripe and HubSpot, the two states a demo run actually changes; Slack and Gmail need nothing redone between demos. | **Per demo** (plain), **between demo runs** (`--reset`). |
| `npm run agent:setup-dashclaw` | Installs the six DashClaw policies (section 1 above). | **One-time per DashClaw org**, safe to repeat. |
| `npm run eval:agent` | Runs the fixture-backed scenario suite against a real `AgentRuntime` and a fake DashClaw/Slack/Stripe/HubSpot/Gmail; no real credentials or network calls. | Any time; this is the regression suite, not a live check. Numbers from a real run: `docs/HACKATHON_RELIABILITY.md`. |
| `npm run agent:gmail-auth` | The one-time Gmail OAuth loopback flow (section 5). | **One-time**, repeat only if the refresh token is revoked. |
| `RUN_LIVE_AGENT_TESTS=1 npm run test:agent-live` | Runs real round trips: health readiness; a Stripe refund on a fresh $1.00 test payment through the real governed engine, approved with the DashClaw approver key; a HubSpot property round trip on the seeded contact (set to the target value, then restored); a Gmail send to `GMAIL_FROM` itself found back by Message-ID; a DashClaw non-fabrication check that blocks a fabricated amount and passes the real facts. Skips itself (`t.skip`, exit 0) when the flag is unset — this is what CI runs. Each test names the record ids it creates. | **Per demo**, after seeding, to prove the real accounts are wired correctly. |

## Windows PowerShell: setting one env var for one command

Don't edit `.env` for a one-off override — set it inline for that single command and it won't leak into your next shell:

```powershell
$env:HACKATHON_FAIL_HUBSPOT_ONCE = "1"; npm run agent:seed; Remove-Item Env:\HACKATHON_FAIL_HUBSPOT_ONCE
```

For a single value that must not persist even on failure, `powershell -NoProfile -Command` with the variable set in that subshell only also works:

```powershell
powershell -NoProfile -Command "$env:RUN_LIVE_AGENT_TESTS='1'; npm run test:agent-live"
```
