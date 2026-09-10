# Architecture decisions

## 2026-09-06: Sidelook, a Practical Systems product

Jarvis is a Marvel mark shared by dozens of projects and implies an always-on butler, which the product principle rejects. The maintainer chose Sidelook (a sidelong look at the window beside you), launched it under Practical Systems with the family navy and teal, and took one node of the family's seven-hexagon mark as the product mark: a white hexagon with two navy eyes that follow the cursor in the dock and the page header, and hold the sidelong look in every static render. The lens marks (ring and pupil, pupil to the edge, open ring, window and pupil) were dropped. Karpathy's "we're summoning ghosts, not building animals" is the story: the model sees nothing until shown something; the word ghost appears in the About screen and never as a label or a costume. The site self-hosts Plus Jakarta Sans 700 for the lowercase wordmark so the CSP stays at `font-src 'self'`. Private contracts with data already on disk keep their old names on `legacy`-marked lines: the four kernel object names, the profile folder the migration reads, the IndexedDB name and the two preference keys.

## 2026-09-06: The panel is as tall as its content, and says less

The maintainer rejected the 0.14.0 panel on sight: a native title bar over a page header, a fixed 700px window with 300px of nothing between three identical cards and the box, the window Jarvis was looking at as a truncated 12px line, and a chat composer any AI product ships. The redesign was mocked as six states plus four states of the box (`.artifacts/panel-mock.html`) and approved twice, the second time after "cleaner, fewer words and options, a box that grows with the text".

Panel mode is now `FormBorderStyle.None` with a 12px rounded region; the page's header is the drag handle and the page's own edges post `drag` with an `edge` name, which the shell turns into the native resize. After every render the page posts `resize` with its content height; the shell clamps it to the working area and eases the top edge there over 200 ms with the bottom edge pinned, so a reply grows the panel upward and the box stays under the cursor. An open dialog counts toward the height. A height the user drags sticks until the next summon (`panelSized`). Windows' "animate controls and elements" switch (`SPI_GETCLIENTAREAANIMATION`) is the reduced-motion signal on the native side.

The window in front is a tile, not a sentence: process icon (from the executable, cached per process, never a pixel of the window), title, app name, and under a lease the control under the cursor. The tile is the picker. The take-fact ("takes a screenshot of Brave") left the starters, because it was repeated three times and the Send button already says it once a chip is in the box. Removed on purpose: the wordmark, "What are we looking at?", "Looking at:", "change", the › arrows, the You / Jarvis labels, "on your Claude subscription" under the box (Settings and What goes carry the account), and the word "Send" when only words go. This last one amends "one box, one button" below: the button still says what goes, and the arrow alone is the case where nothing but words go. `sendLabel()` is unchanged; the page renders its "Send" as ↑ and keeps the full label as the button's accessible name.

Not built, on purpose: a live thumbnail of the window at summon. It would take a capture nobody asked for, against "keep companion capture explicit" below.

The palette changed in the same release. The maintainer said he did not like the warm charcoal and amber; five palettes were rendered on the same two panel states (current, graphite and mint, ink and vermilion, midnight and lime, paper and cobalt) with measured contrast, the assistant recommended graphite and mint as the one that reads as an instrument rather than a lamp and is neither the indigo nor the cream every AI tool ships, and the maintainer took the recommendation. The retint was done by rule over the ninety-odd shades in `style.css` (warm and olive neutrals moved to hue 200 at their own lightness, the amber family became the accent, reds and the error tint untouched) with the eight core tokens pinned by hand, so every studio surface kept its relative depth. The first rule pass turned the ink and the paper mint because it keyed on saturation alone; the fix was a lightness gate above 0.86 for off-whites. `--amber` became `--accent` with `--accent-hover` and `--on-accent`; the `.button.amber` class name stays as a name only.

The dock became draggable at the maintainer's request in the same session: press and release summons, press and move drags, and the corner it lands on becomes the anchor every mode pins to, saved in `dock.json` in the data root and clamped to the monitor's working area on load.

## 2026-09-05: Desktop companion stays a local entry point

The Windows companion is a native WinForms window hosting a persistent WebView2 profile. It gives the user a compact, summonable conversation surface, then opens the existing workbench when the user explicitly chooses a build or Computer mode workflow. Its conversational history is bounded to the active session.

Keep companion capture explicit: a requested current-window screenshot shows the exact frame used. Do not add ambient screen monitoring, always-on microphone capture, audio upload, automatic browser-history migration, model fallback, or action-permission changes. Camera sharing, Live build consent, source versions and downloads remain existing workbench behavior. WebView2 is a runtime dependency and missing availability fails closed with installation guidance.

## 2026-09-05: Reviewed Computer mode

The maintainer approved a separate local Windows action broker alongside prototype building. Keep subscription inference isolated and tool-free; interpret its structured output as a proposal, not permission. Every action requires a short-lived, single-use user approval bound to a fresh accessible target. Use a native global stop shortcut and a bounded session lease.

Use Windows accessibility patterns rather than arbitrary coordinates. Fixed app launches are Notepad, Calculator and Paint. Explorer and launch-capable address controls are excluded. The interface explicitly describes unsupported canvas, shell, elevated and unattended work. No direct model API, new billing route or automatic model fallback is introduced.

Keep all prototype building, streaming, capture and storage paths unchanged. Deploy only the allowlisted static marketing files to Vercel; native control remains in the downloaded app.

## 2026-09-05: One column, one tick, one Settings

The companion column is the product. It keeps the same 440 pixels whether or not the studio is open: the studio widens the native window to the left with the right edge pinned, so "open the studio" never reads as a page change. Below 1180px the column steps aside and ← Panel brings it back. The native mode names (`dock`, `panel`, `workbench`) did not change.

Consent is one rule, stated in the settings dialog: a tick is one send, a dialog is a lease with a countdown and a Stop, Approve is one desktop action. The tick's sentence is generated from the payload and clears after every request that goes out, in every surface. That is stricter than 0.8.1, where the studio's permission was session-sticky. "See exactly what goes" shows the request body with only the frame's bytes elided, and a session ledger counts every send.

The deck is local. The shell already tracked the foreground window every 250 ms for capture; it now also reports the title and process name on `host-ready`, and `public/chips.js` maps those to families and chips with no pixels and no model call. Nothing is captured at summon. Ctrl+Shift+E summons, captures the window that was in front and fills the first chip, then stops at the tick. Follow-up chips come from the model's structured reply and only fill the box.

Computer mode moved into the column as one resting line and a lease dialog. Model and effort come from the one Settings choice. Live build, camera sharing and the import path stay where AGENTS.md records them.

Not built, on purpose: auto-capture on summon, model-generated chip suggestions, and anything that watches a window and reports when it changed.

## 2026-09-05: Choose what Jarvis looks at

The maintainer's second correction after 0.10.0: the panel only ever looked at the window that was foreground at summon, which is not how people use a computer, and its capture refused any window not entirely on the visible desktop. Approved from a fifth mock state before code changed.

The target is a pick. The "Looking at" line carries **change**, which asks the shell for every visible, titled, top-level window except Jarvis, tool windows, cloaked and minimized ones (titles and process names only, capped at 60), and lists them as rows under **Whole desktop**. A pick is a `select-target` message; the shell validates the window still exists, pins it, and answers with the new `front`, so the page never shows a target the shell would not capture. The foreground tracker keeps running but only fills the default; a pick lasts until the next summon, because a new summon is a new context. Ctrl+Shift+E therefore still captures the window that was in front.

Whole desktop is `CopyFromScreen` over the virtual screen with the panel at opacity zero for the capture, bounded and encoded like a window. Window capture is `PrintWindow` at the window's own size instead of its intersection with the screen, which is what made off-screen and other-monitor windows fail. The stricter "move it onto the desktop" check was protecting nothing: PrintWindow renders the window's surface, not the screen.

Not built, on purpose: a live thumbnail per window in the list (pixels before a pick), capturing minimized windows (nothing to render), and a per-monitor choice (Whole desktop covers it).

## 2026-09-05: One box, one button, no tick in the panel

The maintainer rejected the 0.9.0 panel on sight: a scrolling box inside a small window, a checkbox sentence, two Include boxes, a horizontal chip strip with arrows, a Computer card under the chat. The redesign was mocked as four states of the same 440px panel and approved before any code changed.

Consent in the panel is now the button, not a tick. The Send button reads "Send", "Send with screenshot", "Send with window text" or "Send with screenshot and text", computed by `sendLabel()` from what is in the box. Attached means it goes: a screenshot or the window's text sits inside the box as a chip with its name, time and size (every character of the text shown in full), × removes it, and a send that reached the model clears it and pins it to the message as evidence. A refused or stopped send keeps it. This reverses "one tick, one send" for the panel and for Computer mode, whose "Plan next action" button names the window whose fresh reading goes in the line under it. The studio keeps its tick and its sharing sentence; `gate()` requires a tick only for `surface:'build'`.

The panel has no checkbox, no details arrow and nothing that scrolls at rest, and the companion verifier asserts all three. Starters are three full-width rows, each saying what it takes ("takes a screenshot of Chrome", "reads the text of Notepad", "just asks"); they show while the conversation is empty and come back when Jarvis is summoned from a different window mid-conversation. The header carries one sensor line ("Screen & mic off") from `sensorLine()` that no activity overwrites; the line under the box carries the destination ("To Fable 5.1 on your Claude subscription · may use paid credits") and "What goes", and becomes "Thinking · 4s" with the only Stop while a request is out. The Read text button is gone; text comes through the text-first starters. The studio arrow left the header for Settings and for the reply that suggests it.

Computer mode is a screen, not a card. Set it up lives in Settings; once the lease is on, the screen replaces the conversation and the box, keeps the header, shows the window, the task, and the one action waiting for approval, with the lease countdown at the top and Stop control in the footer. Back returns to the conversation with the lease intact and an Open button on the line under the box. The lease dialog, the broker, the per-action approval and the global stop shortcut did not change.

## 2026-09-05: Read-only window text and a write-only clipboard

The maintainer approved both after the redesign shipped. `op:'read'` on the Computer broker reads one window's accessible text through the existing helper without arming it: Snapshot has no Check(), so a read cannot click, and the operation never sets an owner or a proposal. It is a strictly weaker permission than Computer mode and needs no lease; pressing Read text or a text-first chip is the consent, and the text goes to a model only while its Include box is ticked. The clipboard is write-only. `Clipboard.SetText` in the shell, `writeText` in the browser, and a lint rule that fails on any read, because a clipboard read would make "screen & mic off" untrue. "Replace it in the app" through Computer mode was rejected: multi-paragraph text cannot pass the type broker and Jarvis should not be near a Send button.

## 2026-09-05: Any catalog model, and minimized windows

The two-model cap was never a technical limit, only an unreviewed default; the maintainer requested the change and it is now a catalog in `public/models.js` with 11 entries across OpenAI and Anthropic. What still holds: each transport pins exactly one model ID read from the catalog, never a free-text value from the page; missing subscription auth, model access or allowance still fails closed; and adding a model stays a one-line catalog change, not a new transport.

The earlier "not built, on purpose: capturing minimized windows (nothing to render)" call is reversed. `PrintWindow` can render a minimized window off-screen without activating it, so the picker now lists minimized windows too, marked "minimized" under the title. A pick shows the window, captures it, and minimizes it again, restoring its exact placement; the window is visible for well under a second. The trade-off is that sub-second flash. Computer mode still needs real focus for input, so an approved action on a minimized window restores it first.

## 2026-09-05: Screen on is a lease, not a status

The maintainer asked why "Screen & mic off" was a label rather than a switch, and approved a mode in which Jarvis follows the window the user clicks. This reverses "no ambient screen monitoring" and "nothing that watches a window" from the same day. It holds because the mode is explicit (a button and a dialog with no tick), bounded (ten minutes, counted down in the header), visible on the desktop itself (the border), stoppable in one press or with Ctrl+Shift+F12, and still sends nothing on its own: a fresh screenshot waits in the box for Send. The line stays truthful in both states.

Built page-side and shell-side only. No server, broker or model change; the existing `capture` message and chip carry the screenshot, and `public/follow.js` is a pure reducer under test. Only mouse button-up events are observed, only during the lease; element names are bounded and values are never read.

Not built, on purpose: automatic sends with a budget (the button still says what goes), a keyboard hook, coordinate clicks, and the Act tier. Release B makes Computer mode follow the click with a highlight-and-Enter approval and the user's own input as the interrupt, one approval per action.

## The studio has no tick either (2026-09-06)

The maintainer approved a six-state mock (`.artifacts/studio-mock.html`) and the studio composer took the panel's contract: a frame is a chip in the box, × removes it, the button says what goes ("Build with frame", "Revise Version 02"), and the line under the box names the destination and the selected source. Sharing a window or camera attaches nothing; "Use this frame" takes one still, because a live preview is context and a still in the box is a decision. Upload, the sample sketch and the panel's handoff attach the image they carry, since choosing it is the act. The server contract is unchanged: `/api/build` still needs `consent: true`, which only the button press sends. The harness `gate` lost its tick branch and `spend` went away; the studio clears its own chip after a send that carried it.

## Read the window back after Approve (2026-09-06)

Approve runs one action, then the broker takes one bounded local reading of the same window and returns it with the result. The page shows "Windows accepted" and "Observed" as two lines, because acceptance and outcome are different facts; a reading that fails says verification was unavailable, never "done", and never causes a second action. A launch is not inspected on its own, so choosing the new window stays with the person. The reading rides in the recent actions the next manual plan sends; no model step runs from it. Diagnostic IDs and the full tree sit behind a Details button rather than a `<details>` element, because the panel's verifier asserts it has no details arrows.

## Local models are the one non-subscription path (2026-09-06)

The maintainer approved open-weight models served by LM Studio or Ollama on the user's own computer, reached only through the official Codex CLI's open-source provider (`--oss --local-provider`). Nothing is metered, no key exists, nothing leaves the machine. The server lists what the runtime holds and the page chooses from that list, so the rule that the page never names an arbitrary model or CLI argument still holds; a runtime that is down or a model that is gone fails closed, and there is no switching between a local model and a subscription model. Three product facts follow from measurements, not preference: an LM Studio model is loaded ahead at a 32,768 context with a GPU share computed from the card; low effort turns reasoning off; and because LM Studio does not enforce Codex's output schema, the schema rides in the instructions, a prose reply gets one retry, and the conversation accepts words as its reply while a build fails closed. Ollama is wired identically and ships untested until an install exists.

## Bench is a header button; the studio fits its monitor (2026-09-06)

Opening the studio was a line inside Settings, two presses away; it is now **Bench ↗** in the panel header. The studio opens at 85% of the working area of the monitor Sidelook lives on, capped at 1480x900 and floored at 760x520, and remembers a dragged size in `studio-size.json` beside the dock position. It reflows rather than clipping: at 1180 the chat column becomes a toolbar Chat toggle and an overlay, at 900 the rail stacks above the stage and the toolbar wraps. The browser check loads six widths and fails on any horizontal overflow.

## Three words under the conversation (2026-09-06)

New chat, Clear context and Compact sit in one row under the messages, with a meter line beneath: how full the 24,000-character history budget is, what the last send cost in tokens and what the chat has cost, cached input counted beside each number rather than inside it. Clear context keeps the messages on screen and sends none of them; Compact is one send that trades the earlier messages for a summary. The old Clear conversation in Settings is gone; the row is where the person is looking.

## Approve plans the next step; a task can start with no window (2026-09-06)

Wes opened Computer mode from the chat's "open a new notepad", found a window selector, a manual Open button, and Plan next action refusing to run until a window was chosen, and asked what the product was for. Two presses per step (Plan, then Approve) made a five-step task ten presses, and the one task the chat had suggested could not even be planned. Three changes. Plan next action runs with no window chosen: nothing is read, only the task goes, and the model can propose only a launch of Notepad, Calculator or Paint, or a report; a click without a window is refused by the broker. An approved launch reads the window list again (titles only, never a tree) until a new window appears and makes it the chosen one, so the next step reads it. After every approved action, the page plans the next step by itself, so the loop is one Approve per action; Reject ends it, Stop ends it, and every action still waits for its own Approve, still expires in a minute, and the 20-step cap holds. The chat prompt now says it cannot set up or run anything and points at the Let Sidelook do this button, because three replies of "I'll set that up" had promised an agent and handed over a form.


## Agent mode is a governed effect engine, not a chat with tools (2026-09-10)

The hackathon asked for a customer-operations agent across Slack, Stripe, HubSpot and Gmail with DashClaw as the enforcement boundary. The maintainer's brief set the thesis: agents using apps is no longer the interesting problem; performing consequential workflows across several systems without silently leaving the world in the wrong state is. So the design centre is not the model loop but the write path. One module, `lib/agent/effects.mjs`, is the only way a provider write can happen, and every write is precondition, DashClaw record, approval when held, execution claim, the request, a receipt, a fresh read that verifies, and an outcome reported back. "The API returned 200" is `executed`; only a second read that confirms the intended state is `verified`, and the summary block counts the two apart.

Three choices follow from reading DashClaw's current code rather than its README. Approvals are non-blocking: `runGoverned` would park the whole process inside the SDK, so the seam records with `createAction`, parks the effect when the row comes back `pending_approval`, and resumes through `claimExecution` after the person decides in the panel or the dashboard, whichever comes first. The approver is a second key: DashClaw refuses self-approval for database keys, so the agent records with a member key and the person's admin key approves. Policy rows opt into the Short List: rows created without `short_list: true` were admitted at `warn` on the live org, so the installer reads every row back and refuses to call a softened row installed.

Reconciliation replaces rollback. A request that may have left the process is never repeated blind: Stripe is read by the effect's metadata, HubSpot by the property value, Gmail by the deterministic Message-ID, and only an absent effect is retried, with Stripe's idempotency key as the second net. A HubSpot failure after a verified refund re-reads the refund on the timeline before anything is retried, which is Demo B. What cannot be established stays `uncertain` and the run ends `uncertain`; the panel never shows a guess.

Not built, on purpose: a generic workflow builder, more integrations, a rollback story, an OAuth product for Gmail (a one-time loopback consent and a refresh token are enough), model-generated tool names, and any policy engine inside Sidelook beyond the preconditions the model's evidence already justifies (missing Slack request, ambiguous identity, an unobserved payment).
