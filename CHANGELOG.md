# Changelog

## Unreleased

- The studio is one instrument, not a page. Three welded regions: a 48px toolbar, the panes (Direction above Reference on the left, the running prototype and Sidelook's reply on the right) and a 64px versions deck across the bottom, with 1px seams that run edge to edge and never scroll as a document above 900px. Radius means "this floats": the panel, its bubbles, its box, the dialogs and the expanded stage keep their corners; panes, seams, the deck, the starters and the viewfinder are square, and the only rounded thing inside the studio is the prototype. **Share window** and **Live build** sit beside the viewfinder they affect (Live build on the status line that reports the shared screen), so every screen has one teal fill. The build strip lays over the reply while a build runs, so the prototype never moves; the understanding block appears with the first frame sent; **F6** cycles the panes (Direction, Reference, Stage, panel) and Shift+F6 walks back. Below 900px the studio is one column again, the rail scrolling inside itself. Chosen by a tournament of eight concepts and five judges; the record and the build contract are in `docs/superpowers/specs/2026-09-11-ui-layout-champion-design.md`.
- Computer mode and Agent mode: the decision never scrolls. The steps are rule-separated instead of cards; the one accent frame on the screen is the decision, and its head (the step label, the action, the target, or the sentence "stripe · Refund $485.00") and its Approve row pin to the top and bottom of the body while the reason and the evidence scroll between them. Focus never moves onto Approve. Two new verifier assertions prove Approve sits inside the body without scrolling, and both were observed failing on the previous layout first. Agent mode shows no Stop at rest (only the hotkey note), lowercases its status ("Waiting for approval"), puts the goal box under the timeline and labels it "Start another run" after a run, and a hairline appears under the mode head only once the body has scrolled under it. The two mode rows in Settings read as doors (name, sentence, chevron); the send preview lists what already went before the request body.
- Panel: the chat controls and the context meter appear with the first message, so the empty panel is the tile, three starters and the box (about 380px). Beside the studio the panel header is as tall as the toolbar and carries its seam.
- The three published captures are the current interface again: `docs/images/streaming.png` (the studio during the streaming check), `docs/images/companion.png` (the panel at rest) and `docs/images/computer.png` (a decision waiting for approval) come straight from `verify-stream`, `verify-companion` and `verify-computer`, and `docs/images/social.png` was rebuilt from the new panel and now reads 0.18.0. They had been the 0.15.0 graphite panel, two releases and one rename behind the product, on the README and on the walkthrough's third step. `docs/images/screen-on.png` is a real desktop composite and still waits for a free machine.
- `.env.example` names every variable the code reads (`AGENT_ALLOW_UNVERIFIED_EMAIL`, `AGENT_LEARN_ROOT` were missing); `package.json` carries the description, repository, homepage and bugs fields the README already stated.
- Tokens `--chrome` (the preview bars) and `--warn` (errors, breakers, an unverified outcome); `--green` now means ready and nothing else (source and snapshot text is muted, the current version tile is a rule, the aperture is neutral). Control heights: primary 40, select 36. Every `pre` in the panel shares one evidence rule.
- Agent mode heals its own operational faults instead of just reporting them: a typed incident record for every fault (`lib/agent/incidents.mjs`), a recovery policy table that decides whether and how a failed read or write is retried (`lib/agent/recovery.mjs`), and circuit breakers that pause an integration, DashClaw, or the model itself after a repeated failure and refuse the next call before it is even made (`lib/agent/breakers.mjs`). A restart reads every provider back before it stamps an interrupted run, never resumes a model loop blind (`lib/agent/resume.mjs`). Contract: `docs/AGENT_SELF_HEALING.md`.
- Agent mode panel: the timeline narrates recovery as it happens ("Checking previous effects," "Retrying HubSpot safely," "Recovered"); an open breaker turns an app's dot amber with the reason as its title; the summary line counts incidents and how many recovered. A finished run's summary block gains **Diagnostics** (the incident list and the breaker table) and, on a run whose goal is unmet, **Continue** (a new run that inherits every proven write from its lineage and never repeats one).
- Agent mode: a new `npm run agent:learn` offline loop reads a run's own evidence, turns a repeated failure into a regression test, and proposes a fix as an isolated git worktree that must clear every existing safety invariant, a held-out regression corpus, and an independent model review before a person can merge it. It never edits product source outside a candidate's own worktree, never touches a running run, and never touches DashClaw policy; it does write its own corpus, memory and reports under `agent-learning/` in the main tree. `--promote` prepares a branch and prints the merge command, never merges. `npm run agent:learn -- --dry-run` shows what it would do; `npm run verify:learn` runs it end to end against a fixed fixture corpus; `npm run agent:regress` runs the accumulated regression corpus alone. Contract: `docs/AGENT_LEARNING_LOOP.md`.
- Agent mode eval: six new fixed scenarios (27-32) cover Retry-After handling, an authentication breaker that then refuses a whole run's Stripe reads, a DashClaw-unavailable breaker, Continue after a partial run and after an uncertain one, and a model breaker that refuses a further `create`. Every scenario's report now carries a safety-invariant block (`unclaimedWrites, duplicateEffects, incorrectSuccessClaims, unheldFinancialWrites, secretLeaks, injectionAuthorized`) and a sanitized incident list; the learning loop rejects a candidate that raises any of them.
- Agent mode: a customer lookup that matches nothing answers with the addresses the run has already read, so the agent searches by the address the request names instead of guessing a domain from the company name.
- Agent mode: a run whose model gives up ends by its ledger. A DashClaw block reads Blocked, not Failed, and verified writes with the goal unmet read Partial, never Completed.
- Agent mode never moves money without a person: a refund DashClaw allowed or only warned about (its interruption budget demotes a hold after 10 approvals of one kind in a day) is refused before the claim and closed on DashClaw as failed, and the installer marks both hold policies `ungrantable` so DashClaw keeps holding.
- Agent mode, all three demos run live: the seed adds Globex, one $5,000.00 payment over the refund ceiling, so Demo C is a real DashClaw block; a blocked write carries the DashClaw action id for its `/decisions` page; the Gmail send takes the prepared message id in the shapes models actually send (with or without brackets, HTML-escaped, or the preparedId); the planner is told which plan fields carry a tool's arguments.
- Agent mode, after the first full live run: the email act carries its content and source of truth so DashClaw's execution claim can re-check the non-fabrication policy (it strips them from the stored context); the planner is told the tool catalog is data and StructuredOutput the only function; a runtime refusal reads as refused, not blocked, so the model corrects its arguments; `AGENT_DEMO_EMAIL` names the inbox Demo A emails.
- Agent mode, Gmail: the confirmation email carries a `Reference: SL...` line, and a send is verified by the id Gmail returns rather than a search by Message-ID, which Gmail rewrites for gmail.com senders. Slack health now proves the read scopes and channel membership, not just the token.
- Agent mode. Settings, **Agent mode**: say a business outcome ("Resolve Acme's cancellation request. Refund the most recent eligible payment, update the CRM, and email them confirmation.") and Sidelook works across Slack, Stripe, HubSpot and Gmail through their APIs, one typed tool per model turn on the subscription you already use. Every write goes through DashClaw: a held action becomes a policy approval card in the panel with Approve and Reject, a blocked one says so, and nothing runs without DashClaw's execution claim. Every write is read back before it counts as verified; a lost answer is reconciled against the provider before anything is retried, so a refund is never made twice. The summary block counts apps, tool calls, writes, verified writes, approvals, duplicate side effects and unresolved effects from the run's own ledger. Stop and Ctrl+Shift+F12 end the run. `npm run eval:agent` runs 20 fixture-backed reliability scenarios against a fake DashClaw with the real SDK; `npm run verify:agent` drives the screen. Stripe is test mode by default. One runtime dependency arrives with it: the official DashClaw SDK. Guides: docs/HACKATHON_DEMO.md, docs/HACKATHON_SETUP.md, docs/HACKATHON_RELIABILITY.md, docs/HACKATHON_ARCHITECTURE.md.
- Computer mode plans the next step after every approved action. Approve runs one action, reads the window back locally, then sends the task and a fresh reading to the model so the next proposal is waiting for you. One Approve per action instead of Plan then Approve. Reject or Stop ends the loop; every action still waits for its own Approve and the 20-step cap holds.
- Plan next action works with no window chosen. Nothing is read; only the task goes, and the model can propose only opening Notepad, Calculator or Paint, or a report. The broker refuses any other action without a window.
- An approved launch finds its window: the window list is read again (titles only) until a new one appears, and it becomes the chosen window. Before, the screen asked you to refresh the list and pick it yourself.
- The chat no longer says it will "set up" a desktop action. It cannot; its prompt now says so and points at the Let Sidelook do this button, which opens Computer mode with the task filled in.

## 0.17.0: Local models, the Bench button, and three words under the conversation

- Three words under the conversation: New chat, Clear context, Compact. New chat is the old Clear conversation from Settings, moved where you need it. Clear context leaves the messages on screen and sends none of them with the next message. Compact is one send that trades the earlier messages for a summary under 150 words, and a line saying what it saved.
- A meter line under them: how full the 24,000 characters the next send can carry is, what the last send cost in tokens, and what this chat has cost. Cached input is counted beside each number, never inside it. The percent turns warm past 80.
- The model's token counts reach the page: Codex reports its cached input, Claude reports both its cache read and its cache write. They also go in the What goes panel.
- Local models. Whatever LM Studio or Ollama holds on this computer appears in the model list under the runtime's name, while the runtime is running. Sidelook talks to it through Codex's open-source provider, in the same read-only sandbox as a subscription model; nothing leaves the machine and nothing is metered. Setup checks that the runtime answers and the model is still there, and offers Start LM Studio server when it is not. Proven with Qwen3 8B in LM Studio on 2026-09-06; Ollama is wired the same way but has not been run yet.
- An LM Studio model is loaded with a 32,768-token context before the first request, because Codex's own prompt is about 12,700 tokens and LM Studio's default load of 4,096 refuses it. The studio shows "Loading <model> into memory" while that happens, about ten seconds for an 8B model.
- Local models get the schema inside their instructions and the JSON object read out of the reply, because LM Studio does not enforce Codex's output schema; low effort turns a local model's reasoning off (8 s a turn on Qwen3 8B instead of 30 to 50); the GPU share at load is computed from the card and the model so the 32k cache fits (every layer on an 8 GB card swapped at 5 tokens/s); a local chat has 300 s, the same as a build. A local model that answers in words instead of JSON is run once more; the conversation then takes words as the reply, a build fails closed. A suggestion the model invents reads as none.
- **Bench ↗** sits in the panel header and opens the studio. It was a line inside Settings, two presses away; that line is gone.
- The studio opens to fit the monitor Sidelook lives on: 85% of the working area, capped at 1480x900 and floored at 760x520. Drag it to another size and it opens at that size next time, saved in `studio-size.json` beside the dock position. The panel and the dock still remember nothing.
- The studio reflows instead of clipping. Above 1180 it is unchanged. From 900 to 1180 the chat column steps aside and a **Chat** button in the toolbar slides it over the right edge of the stage; Escape, ← Panel, or a window wide enough for the column closes it. Under 900 the rail stacks above the stage with its own scroll, the toolbar wraps and Share window and Live build shorten to Share and Live. Nothing scrolls sideways down to 760.
- The browser check loads the studio at 1480, 1180, 1100, 900, 800 and 760, opens and closes the chat overlay at two of them, and fails on any horizontal overflow.

## 0.16.0: Sidelook

- Jarvis is now Sidelook, a Practical Systems product. Same app, same shortcuts, same port, same twelve versions. The exe is `Sidelook-0.16.0-Windows-x64.exe`; the site is https://sidelook.practicalsystems.io and the old address redirects.
- The mark is one node of the Practical Systems mark: a white hexagon with two navy eyes. In the dock and in the panel header the eyes follow your mouse anywhere on the screen. Under Windows' animation switch they hold the sidelong look and nothing moves.
- Graphite and mint became the family navy and teal. Every control was re-measured at rest and under the mouse.
- Saved prototypes survive: the first start moves the old Jarvis profile folder to Sidelook once, or copies the profile and the dock position if a file is locked.
- Summon fades the panel in, dismiss fades it out.
- `npm run lint` refuses the old name outside history and marked legacy lines; `npm run verify:mark` compiles the mark and the profile move and checks the SVG, the C# and the icon build agree.

## 0.15.1: Buttons that stay under the mouse

- Every filled button (Send, Follow my clicks, Start 10 minutes, Build, Sign in) lost its fill under the mouse in 0.15.0 and read as faint text on the dark surface. The retint had rewritten the hover token to refer to itself, `--accent-hover: var(--accent-hover)`, which is invalid at computed-value time and makes the hover background fall to transparent. Fixed to `#8eeccf`. The error banner's leftover brown background is a dark mint tint now.
- New verifier, `npm run verify:states`, so this class of error fails a check instead of a glance: every control in the panel, its four dialogs, Computer mode, the studio, its four dialogs and the built site is measured at rest and under the mouse with transitions off, every text node at rest, contrast under 4.5:1 or a fill that goes transparent fails, and every `var(--token)` in the three stylesheets must be defined and must not define itself. 281 controls and every text node pass; with the 0.15.0 token put back on purpose it reports seven vanishing buttons.
- The site verifier now fails on any version string that is not the current one; the install steps still said "Open Jarvis-0.14.0-Windows-x64.exe". The FAQ line that still described a tick reads "The button says what goes" now.

## 0.15.0: The panel, quiet

- New palette: graphite and mint. Cool neutrals tinted toward one hue at the same depths as before, and a mint accent (`#6fe3c1`) on exactly three things: the mark, the primary button, and the thing under the cursor. Chosen from five rendered options on the same panel (`.artifacts/palette-mock.html`); contrast measured at 6.9:1 for muted text on the body and 9.8:1 for text on the accent. The mark, the dock button, the tray icon, the exe icon, the WebView backdrop, the Screen on border, the studio and the site all changed together. The prototype preview background is a neutral off-white now instead of cream.
- The dock is movable. Press and release still opens the panel; press and drag moves the dock, and the corner it lands on is where the panel and the studio pin from then on, saved in `dock.json` beside the WebView2 profile so it survives a restart. The default corner is unchanged.
- The panel is as tall as what is in it. The native title bar is gone; the header with the mark is the drag handle and the window's own edges resize it. After every change the page tells the shell how tall the content is, and the shell eases the top edge there over 200 ms with the bottom edge pinned, so a reply grows the panel upward while the box stays under your hands. It stops at the working area, and only then does the conversation scroll. An open dialog grows the panel to fit it. Drag an edge and that height sticks until the next summon. Windows' own "animate controls" switch turns the easing off. Empty over a browser window: about 380px, where 0.14.0 opened 700.
- The window Jarvis will look at is a tile: its app icon (from the process, never a pixel of the window), its title, the app's name, and under a Screen on lease the control under the cursor. Press the tile to pick another window or the whole desktop. Mid-conversation it is one muted line above the box, and it comes back full, with fresh starters, when Jarvis is summoned from a different window.
- Fewer words. Gone: the JARVIS wordmark (the mark is enough), "What are we looking at?", "Looking at:", "change", the "takes a screenshot of Brave" line under every starter, the › arrows, the "You" and "Jarvis" labels on messages, "on your Claude subscription" under the box. Starters are three short lines on 1px rules. Your messages sit on the right with the sent screenshot or text as a thumbnail in the bubble; press it for the exact frame or every character. Jarvis's replies are plain text with Copy. The line under the box reads "Opus 5 · may use paid credits" and What goes.
- The box is one line at rest and grows a line at a time as you type, up to eight, then scrolls inside; delete and it shrinks back. A grip in the corner drags it taller, and that height sticks until the box is emptied. Enter sends, Shift+Enter is a new line. Screenshot and Mic are icons with names for screen readers.
- The Send button is ↑ alone when only words go, and "Send with screenshot ↑" or "Send with window text ↑" when a chip is in the box. It still says what goes; it only stops saying "Send" for the case where nothing but words go. The server contract is unchanged.
- Shell: the `resize` message takes a `height`; `drag` takes an `edge`; `host-ready` and `target` carry `icon`. Panel mode is `FormBorderStyle.None` with a 12px rounded region, minimum 380×240.
- The companion verifier now asserts the shape: the tile with the app name and initial, starters with no card chrome, a one-line box that grows to 63px at three lines and caps at 168, the grip, the height the page asked for, no name labels, the thumbnail evidence. The desktop-host check asserts the borderless style and a content-sized first panel and waits for the panel to grow before pressing the lease dialog.

## 0.14.0: Read it back

- The studio composer follows the panel's contract. The "Include this frame" checkbox and the sharing tick are gone. A frame sits in the box as a chip with ×; the button reads **Build**, **Build with frame**, **Revise Version 02** or **Revise Version 02 with frame**, and the line under the box names what goes, including the selected prototype source. Share window and Camera show a live local preview and attach nothing; **Use this frame** takes one still into the box, and a saved frame can be attached again the same way. Upload, Sample sketch and the panel's "Build this in the studio" attach the chosen image, since choosing it is the act. A frame that went leaves the box and stays on the version as evidence; a refused or stopped build keeps it to retry. `/api/build` still refuses without `consent: true`; only the button press sends it.
- Ready no longer waits for the preview. The studio takes its token, starts the provider check at once and restores a saved preview beside it; a slow or failed iframe leaves "Ready" where it was. Measured with the preview held 1.5 s against synthetic transports: Ready at 33 ms instead of 1548 ms. Readiness lives in `public/session.js`, with unit tests for a slow preview, a failed preview, a stale answer and a failed handshake.
- Changing effort in Settings is local: it is saved and shown at once and rides on the next request as before. Only a model change checks the provider again.
- Screen on idles quietly. The 250 ms polling timer is gone; one timer waits for the next deadline the reducer names (a capture due after the three quiet seconds, or the lease end) and a separate once-a-second clock rewrites only the countdown. Measured over 2 s of following: 2 DOM mutations instead of 72. A capture that falls due while a send, a read or a manual screenshot is in flight now stays due and is taken by the next free tick; before, it was dropped and the follow stayed marked in flight.
- Computer mode reads the window back after every approved action. Approve runs one action, then one bounded local reading of the same window: never a model call, never a second action. The screen shows two lines, "Windows accepted click · Seven." and what the reading showed ("Observed: 1 new · Display = 7.", or "Observed: no change in the accessible controls. Check the app yourself."). When the window closed, changed or could not be read, it says verification was unavailable. A launch is never inspected on its own; choosing the new window stays with you. The next model step stays manual, and that reading rides in the recent actions the next plan sends.
- The action review reads in plain words before Approve: the consequence, the window, the target control, and the whole replacement text for a type. Automation IDs, control references, parent, state and the full accessibility tree sit behind a Details button.
- The read-back has its own bound, 8 seconds against 20 for an action: a window that will not answer in that time is reported as "took too long to read", the action is not repeated, and the broker is free for the next manual step.
- Stop in the panel while a Screen on screenshot is on its way no longer leaves the lease waiting for an answer that never comes; the next click schedules a fresh one.

## 0.13.0: Screen on

- "Screen & mic off" in the panel header is now a button. It opens a ten-minute lease with two ways in: **Follow my clicks** and **Follow and keep a fresh screenshot**. No checkbox; the button is the consent. The header then reads "Screen on · following clicks · 9:42" (or "fresh screenshots"), the dot lights, and pressing the line stops it. Ctrl+Shift+F12 stops it too.
- While on, the shell pins whatever top-level window you click as the thing Jarvis looks at. "Looking at" shows the window and the control you clicked ("Inbox – Gmail · Send button"); the starters refit once per window change. A 2px amber border on the desktop outlines the followed window.
- With fresh screenshots on, three quiet seconds after a click a screenshot of that window replaces the chip in the box, only if the window looks different from the last one. Send reads "Send with screenshot". Nothing is sent without Send. × on the chip mutes that window until you click a different one.
- The lease ends on its own after ten minutes; the header returns to "Screen & mic off" and a line under the box says "Screen off · followed for 10 minutes". A chip already in the box stays.
- Shell: a `WH_MOUSE_LL` hook and the border exist only during a lease. Messages `screen-on`, `screen-off`, `screen`, and `target` with `via:'click'` and `element`. The Computer helper's shortcut refusal now names Screen on as a possible holder.
- Not built, on purpose: automatic sends, any keyboard hook, following inside Computer mode (next release).

## 0.12.0: Any model, minimized windows too

- Settings' model selector now lists the full catalog from `public/models.js` in two groups, "OpenAI · ChatGPT through Codex" and "Anthropic · Claude through Claude Code": Astra, GPT-5.6 Sol, GPT-5.6 Terra, GPT-5.6 Luna, GPT-5.5, GPT-5.4 Mini and GPT-5.3 Codex Spark on OpenAI; Fable 5.1, Opus 5, Sonnet 5 and Haiku 4.5 on Anthropic. Every Anthropic model can spend paid Claude usage credits.
- Picking a model whose effort levels don't include the saved effort moves it to that model's deepest level and says so under the effort control. GPT-5.5, GPT-5.4 Mini and GPT-5.3 Codex Spark stop at xhigh; the rest go to max.
- The "Looking at" line's **change** picker now lists minimized windows too, marked "minimized" under the title. Picking one and taking a screenshot shows the window without activating it, captures it, then minimizes it again, restoring its exact placement.
- Computer mode: an approved action on a minimized window restores it first, since focus is required for input.
- Shell: `windows` message rows carry a `minimized` boolean. `/api/local-session` returns the whole catalog instead of a fixed two-model list.

## 0.11.0: Choose what Jarvis looks at

- The "In front" line is now "Looking at" with **change**. It lists **Whole desktop** and every open window (title and app, Jarvis excluded) as rows in place of the starters; a pick tells the shell, re-fits the starters to that app, and Screenshot and the starters capture that target until the next summon. A closed window is refused and the list refreshes. "not this one" is gone.
- **Whole desktop** captures every monitor at once, bounded like a window capture, with the panel made transparent for the capture so Jarvis is not in the picture.
- Window capture renders the window's own surface at full size, so a window half off the screen or on another monitor captures whole. "Move the entire selected window onto the visible desktop" is gone; only a minimized window refuses, and says so.
- Shell messages: `windows` (titles and process names only), `select-target`, and `id` on `host-ready`'s `front`. The browser build hides **change** and keeps the OS picker.

## 0.10.0: One box, one button

- The panel redesigned from first principles: one message box, one Send button, nothing to tick. The button says what goes ("Send with screenshot", "Send with window text"); a screenshot or the window's text sits inside the box as a chip with its name, time and size, × removes it, and after a send it leaves the box and stays on the message as evidence. Refused and stopped sends keep it.
- The panel has no checkbox, no details arrow and nothing that scrolls at rest; the companion verifier asserts all three. The consent sentence, the Include boxes, the hover hint, the horizontal chip strip, the footer status line, the sent counter, the Read text button and the studio arrow are gone from the panel.
- Starters are three full-width rows, each saying what it takes ("takes a screenshot of Chrome", "reads the text of Notepad", "just asks"). They show while the conversation is empty and come back when Jarvis is summoned from a different window.
- The header carries one sensor line, "Screen & mic off" with a dot, that no activity overwrites. The line under the box names the model and the account ("To Fable 5.1 on your Claude subscription · may use paid credits") with "What goes"; while a request is out it becomes "Thinking · 4s" with the only Stop on the screen.
- Computer mode is a screen, not a card: entered from Settings, it replaces the conversation once the lease is on and shows the window, the task and the one action waiting for approval, with the lease countdown at the top and Stop control in the footer. Back keeps the lease; Open on the line under the box returns to it. "Plan next action" is the consent; the line under it names the window whose fresh reading goes.
- Settings gains a "Do more" section: Open the studio, Computer mode.
- Harness: `activityLine()`, `sensorLine()` and `sendLabel()` in `public/harness.js`; `gate()` requires a tick only in the studio. Old Computer card and text strip rules removed from `style.css`; the panel's rules live in `companion.css`.

## 0.9.0: One column, one tick

- The companion column is the product. It keeps the same 440 pixels when the studio opens beside it; the native window widens to the left with its right edge pinned. Below 1180px the column steps aside and ← Panel brings it back.
- The deck: at summon the panel reads the title and process of the window that was in front and offers three prewritten questions for it, from `public/chips.js` (errors, terminals, code, browsers, mail and chat, spreadsheets, documents, design tools, settings and installers). No pixels and no model call until a chip is pressed. "not this one" falls back to the three generic questions.
- Ctrl+Shift+E summons, captures the window that was in front, fills the first chip and stops at the sharing tick. Settings says when another app owns the shortcut.
- One consent pattern everywhere: a generated sentence next to one tick ("Send this message, the 4 earlier messages and the attached frame to Fable 5.1 (your Claude subscription)"), "See exactly what goes" with the request body, a per-session ledger in the footer. The tick and the frame's Include box clear after every send. The studio's session-sticky permission dialog is gone.
- Read text: the panel reads the accessible text of the window you came from through a new read-only `read` operation on the Computer broker (never arms, grants no owner, cannot act). Every character is shown with a control and character count and a truncation flag; it goes only while its Include box is ticked, and the sharing sentence, the preview, the ledger and the provenance line under the reply all name it. Error, terminal, spreadsheet and settings chips read text first and fall back to a frame.
- Copy on every reply, write-only: the shell handles a `copy` message with `Clipboard.SetText`, the browser falls back to `writeText`, and lint fails on any clipboard read in `public/` or `desktop/`. "Say it plainly" takes its tone (plainer, shorter, warmer, firmer) from Settings, Advanced.
- Follow-up chips under each reply from the model's structured response; numbered and bulleted replies render as lists.
- One Settings dialog from either surface: model and connection, Advanced (effort, dictation, spoken replies, import, allowance, clear), what leaves this device. The workbench top bar, hero, quick-start row, "Try saying" row, section numbers, eyebrows, the privacy, consent, voice and budget dialogs are removed.
- The studio replaces the workbench page: a toolbar (← Panel, Share window, Live build, model, Settings), an input rail and an output stage that scroll themselves. Copy in sentence case; nothing in the app under 12px, checked by lint.
- Computer mode moved into the column as one resting line, a lease dialog and a card; model and effort come from Settings; the sharing tick clears after every plan; Approve and Reject.
- Harness: `public/harness.js` holds the status line, consent sentence, gate, spend and ledger, unit-tested in `tests/harness.test.mjs`; `scripts/check.mjs` verifies the asset map against disk and references and the 12px floor. Companion, computer and app markup live in `index.html`.
- Shell: `host-ready` carries the foreground title and process plus hotkey registration state; the studio window is 1480x900, minimum 1180x680, pinned to the panel's right edge.


## 0.8.1: The Jarvis mark

- Replaced the letter-in-a-circle dock and stock tray icon with the Jarvis mark: an amber lens on a rounded charcoal square, drawn natively on a shaped dock window (no white square behind it), embedded in the exe as `desktop/jarvis.ico`, and used for the tray, taskbar and title bar. `scripts/build-icon.ps1` regenerates the icon from the shared geometry.
- Rewrote the README, public site, docs and llms.txt in plain first-person voice. Removed per-section eyebrow labels, decorative section numbering, arrow glyphs and side-stripe accents from the site and the workbench. Added PRODUCT.md and DESIGN.md as the design context.
- Companion welcome copy now opens with a question instead of a tagline. Workbench text sizes have a 9px floor.

## 0.8.0: Desktop companion

- Added a compact native Windows companion that can be summoned with Ctrl+Shift+Space and expands into the existing workbench when the user chooses a build or Computer mode workflow.
- Added optional local dictation and spoken replies, a bounded in-session conversation, and an explicit current-window screenshot that shows the exact frame used.
- Added a persistent WebView2 profile for the companion. Existing browser-stored revisions are not imported automatically; export HTML and use Settings, then Import a saved HTML prototype. Imports are limited to 120,000 bytes and append a revision when the 12-version history has room.
- Kept camera sharing, consented Live build, source versions, downloads, Astra/Fable subscription transports, and reviewed Computer mode actions unchanged.

## 0.7.0: Reviewed computer actions

- Added Windows Computer mode with explicit local and subscription sharing consent.
- Added accessible-control inspection, click, text replacement, scroll, supported shortcuts, window focus, and fixed app launches.
- Added one-action approvals, rejection, expiry, target revalidation, session history and a global Ctrl+Shift+F12 stop shortcut.
- Preserved the isolated Astra/Fable subscription transports and the prototype builder.
- Documented native limitations and updated the public Computer mode guide and Windows download.

## 0.6.0 · 2026-09-05

- Fable streams real partial HTML into a script-disabled live draft and code view. Switch to the last working version during generation.
- Completion still validates and saves a full interactive version. Canceled or failed drafts are discarded and their temporary URLs revoked.
- Direct structured output avoids duplicate JSON narration. Shorter generation prompts and a low-effort shortcut help reduce waiting.
- Astra remains on the isolated Codex exec path and displays completed messages; it does not simulate incremental tokens.
- MIT license, refreshed README and contributor guidance, current screenshot, GitHub description, website link, and release documentation.

## 0.5.0 · 2026-09-05

- Share a screen or window and opt into Live build while drawing or editing. Camera and upload remain available.
- Local change detection, three quiet seconds, configurable minimum intervals, one request at a time, and ten builds per start. Pause cancels unfinished inference; Stop sharing releases capture.
- Exact sent-frame evidence, explicit automatic-sharing and usage-credit consent, and no automatic resume after reload.
- Animated Astra/Fable waiting messages, elapsed time, reduced-motion support, and a status panel that keeps the current prototype usable.
- Windows package, privacy documentation, public download guidance, and deterministic live-loop verification updated.

## 0.4.0 · 2026-09-05

- Choose Astra or Fable 5.1 and low, medium, high, xhigh, or max effort in the workbench. Preferences persist; each build records its selection.
- Fable generation and image input through official Claude Code with a paid Claude subscription. Usage credits may be charged; the UI shows this before consent.
- Provider-specific Setup, sign-in, and a Windows button to install the checksum- and publisher-verified Claude Code runtime directly from Anthropic.
- Server-side model/effort validation, isolated CLI settings, disabled executable tools and model fallback, safe errors and cancellation.
- Updated Windows executable and public download guidance.

## Website update · 2026-09-05

- Removed the optional task-board section and its hosted sample file. The public page now focuses on the reference-to-result walkthrough and Windows download.

## 0.3.0 · 2026-09-05

- Windows executable bundles Node and official Codex: download, open, and use ChatGPT sign-in from Setup without terminal commands.
- Per-user extraction, desktop and Start menu shortcuts, tray Open/Quit, single-session reuse, occupied-port refusal, and owned-process cleanup.
- Pinned upstream package integrity and publisher verification; Jarvis's outer executable is unsigned and disclosed as such.
- Desktop bootstrap protects local APIs with a per-launch key scoped to the browser origin, separate from restricted preview capabilities.
- Public walkthrough explains reference, prompt, result, and revision; the task board is an optional sample rather than the main product demonstration.
- Windows extraction, clean-profile authentication, rendered preview, and lifecycle verification scripts.

## Public demo · 2026-09-05

- Launched the free browser example at https://jarvis-workbench.vercel.app on the maintainer's existing Vercel plan.
- Added a Windows download, explicit prerequisites, subscription setup guidance, and privacy details.
- Static deployment uses an allowlist; no local server or ChatGPT credentials are hosted.
- Added public metadata, sitemap, robots, llms, search ownership tags, and standard Vercel Web Analytics.
- The initial public launch used the 0.2.0 source archive; 0.3.0 replaces it with the bundled Windows executable.

## 0.2.0 · 2026-09-05

- Working example before login, setup checklist, explicit CLI installation and ChatGPT sign-in, and reconnect controls.
- One subscription turn per visual build, returning observations and HTML together; typed revisions do not resend an old frame by default.
- Completed source persists before preview loading; retry previews without inference and access local source during connection failures.
- Reliable Windows readiness checks independent of subscription status, serialized launches, and graphical prerequisite errors.
- Visible frame-inclusion control, build controls near the top, and mobile progress/countdown.
- Safe error categories, visible local allowance, validation before budget consumption, and explicit allowance renewal.
- 21 unit tests and nine additional browser recovery checks. No application dependencies added.

## 0.1.0 · 2026-09-05

Initial public release of the local Jarvis workbench.

- Selected camera frames, image upload, and a labeled sample sketch.
- Visual observations followed by interactive HTML generation.
- Astra through the official Codex CLI using a ChatGPT subscription, with no model API or fallback.
- Revisions, version history, source inspection, and standalone HTML download.
- Restricted previews with desktop, mobile, and expanded views.
- Local Windows English dictation and optional local spoken replies.
- Explicit sharing consent, cancellation, and bounded inference requests.
- Windows/Linux CI for unit tests, syntax, and required assets.

See the [README](README.md#privacy-and-boundaries) for current limits and the [playbook](PLAYBOOK.md) for verification evidence.
