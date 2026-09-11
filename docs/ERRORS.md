# Implementation lessons

## 2026-09-11: Shipping 0.18.0

- The site's one button has been dead for two releases and no check could see it. `ucsandman/sidelook` is a private
  repository, so `releases/download/v0.17.0/...` answers 404 to everyone except the maintainer, whose `gh` token makes
  it work from this machine every time. verify-site asserted the href string and the local asset routes, never that a
  stranger can follow the link. It now fetches the pinned download and the release page with an anonymous HEAD and
  fails under 400 (observed red first: 404 on both; a public repository answers 200 to the same call, confirmed
  against cli/cli). A link is a claim about someone else's access, so verify it the way they would, signed out.
- The release asset's own bytes were fine: `gh release download` returned 172,491,776 bytes hashing to
  ea7e7d73...c7949, exactly the build. Authenticated success and anonymous success are different facts, and the one
  the product depends on is the second.

## 2026-09-11: Bench, the champion UI

- A Workflow agent's return value is its last assistant message. The tournament synthesizer wrote a 76K-character spec that
  the model split across two messages, so the skeptic stage received the final 1.4K characters and refuted a fragment. The
  full text was recovered from the agent transcript. Fix for next time: a stage that can answer long writes the artifact to
  a file and returns the path; the script forwards the file.
- `button:not([hidden])` still matches a button whose wrapper is hidden, and `focus()` on it does nothing. The studio's F6
  handler passed review and never left the direction pane; a visible-control pick (`offsetParent !== null`) fixed it and
  verify-browser now walks the panes. A keyboard path gets a browser check, not a code read.
- A brief that says "keep every other rule byte-identical" and "implement this block" gets the block appended after the
  rules it replaces, so eight selectors were declared twice and only source order kept the result right. Say "edit these
  rules in place" when the new block supersedes old ones.
- The five browser verifiers write their PNGs into `.artifacts/`; reading those images after each run caught four polish
  defects the assertions cannot see (a wrapped control row, a 4px seam mismatch, a squeezed timeline label, an upright
  serif in a UI label). The screenshots are part of the check, not a by-product.
- The overhaul shipped three times before anyone looked at the published captures. `docs/images/streaming.png`,
  `companion.png` and `computer.png` sit on the README and on the site's walkthrough, and all three were still the
  0.15.0 graphite panel: one of them said "Ask Jarvis", a name the product dropped at 0.16.0. Nothing catches this,
  because the verifiers assert the image's `src` and its HTTP status, never its age. The fix was free: the same
  verifiers already write the right frames at the right sizes into `.artifacts/` on every run, so a UI change ends
  by copying stream-desktop, companion-desktop and computer-desktop over the published files and rebuilding the
  social card. A capture on a public page is a surface, and a surface drifts unless the change that moved it also
  moves the picture.

## 2026-09-11: Self healing and the Agent Learning Loop

- The first push of 0.18.0 went red on the Ubuntu CI job only: a candidate edit path written with backslashes named a
  file literally called `lib\agent\effects.mjs` on Linux, where a backslash is an ordinary filename character, so the
  edit missed and the protected-region test saw no touch. Fix: the path is normalized to forward slashes before it is
  resolved, on every platform. Two clean local runs on Windows are not a Linux run; the Ubuntu job is the check.
- A candidate worktree's `node_modules` was a junction back into the main tree's `node_modules`, and a recursive
  delete of the worktree followed the junction and emptied the repository's own `node_modules`. Fix: a candidate
  worktree lives at `.worktrees/<candidateId>` inside the repository, never a symlink, a junction, a copy or an
  `npm install` of its own; Node's own upward module resolution from `.worktrees/<id>/eval/run.mjs` finds the
  repository's `node_modules` on its own, and `removeCandidate`/`removeWorktree` unlink any `node_modules` link
  inside a worktree before any recursive removal runs, as defence in depth (`agent-learning/lib/candidates.mjs`).
- A successful read on one Stripe call cleared the count backing an *authentication* breaker for the same
  integration, so a dead write token's breaker never opened. A working call disproves an outage, not a dead
  credential. Fix: `CircuitBreakers.recordSuccess` clears only outage-shaped classes (`transient_provider`,
  `timeout_before_request`, `rate_limit`, `dashclaw_unavailable`); an authentication or model-fault count is not
  disproved by an unrelated call succeeding and ages out by its own window alone (`lib/agent/breakers.mjs`).
- A continued run replayed the parent's already-consumed DashClaw action: the child kept the same idempotency key
  for an effect the parent had already failed on, so the fresh attempt read as a duplicate of one DashClaw
  considered settled. Fix: `nextSeries(run, tool, opKey)` gives a fresh logical attempt its own `series`, a new
  idempotency key and a new DashClaw action. Inside one run this only advances past a `failed` attempt with an
  `actionId`, so an attempt DashClaw actually refused (`blocked`/`rejected`/`expired`) keeps its original key on
  purpose, since a replay should read the same verdict; across a Continue, `lineageFor` (`lib/agent/resume.mjs`)
  populates `attempts` from every prior effect carrying an `actionId` whatever its end, so `nextSeries` advances
  past those too and a Continue never reuses a settled key (`lib/agent/run.mjs`, `docs/AGENT_SELF_HEALING.md`
  section 4).
- An open Stripe authentication breaker also refuses Stripe *reads*, not just writes, so eval scenario 28's second
  run cannot even look the customer up: every Stripe call is refused `CIRCUIT_OPEN` before it is made, nothing
  reaches DashClaw, and the run ends `failed` with zero writes and zero new calls, not `blocked`, because nothing
  was ever proposed to DashClaw for it to block. Counted, not a defect: the scenario asserts exactly this
  (`callCounts.stripe.createRefund:2`, no third attempt).
- The learning loop's incumbent baseline was first measured against the live working tree, which a person or another
  agent could be editing while the loop ran, making the baseline numbers describe bytes nobody could reproduce. Fix:
  `learn.mjs` checks out the frozen revision into its own detached worktree (`checkoutIncumbent`) before hashing it
  or evaluating it, and removes that worktree once the baseline evaluation finishes; a dirty working tree is
  reported (`incumbent.workingTreeDirty`) but never measured.

## 2026-09-06: Local models, the Bench button, chat controls (0.17.0)

- The Codex-to-LM-Studio proof used a two-line instruction and returned JSON; the companion's real prompt ("plain text without Markdown") returned prose, because LM Studio does not enforce Codex's `--output-schema`. A transport proof runs on the product's captured system prompt, schema and stdin, never a stand-in. Fix: the schema rides in the instructions, the one JSON object is read out of the reply, a prose reply gets one retry, and the conversation reads words as its reply.
- LM Studio's just-in-time load uses a 4,096 context; Codex's own prompt is 12,710 tokens, so the first request failed at once. The model is now loaded ahead at 32,768 through `lms load`.
- Every layer on the 8 GB card (LM Studio's default) swapped the 32k cache through the driver: prefill 150 s, 5 tokens/s. A 0.5 to 0.7 share fit. The share is computed from nvidia-smi and the model size; without nvidia-smi LM Studio decides.
- Qwen3's reasoning cost 150 to 300 tokens a turn at that speed. Codex effort `none` maps to LM Studio's reasoning-off and took a warm turn from 30 to 50 s to 8 s; local low effort now means reasoning off.
- An end-to-end script sent three chats with no model named because the local list was empty, and `/api/chat` defaults to Astra, so three real turns (about 52,000 tokens) went to the ChatGPT subscription. Scripts that exercise the API stop when the model they meant is absent. The API default itself is unchanged and is the maintainer's call.
- The 5 GB model file vanished mid-session while LM Studio's index still listed it: a second Claude Code session was clearing disk space. Before blaming a runtime for a missing file, check for a concurrent cleanup session.
- `verify:site` had failed since the 0.16.0 analytics tag: the local server answered the Vercel insights script with two 404s and the console check caught them. The local server now serves an empty script at that path.
- A Python heredoc replacement wrote a JavaScript regex literal with real newlines in it and a second Python pass consumed the CR; a `node -e` string with a template literal lost its backticks to bash. Edits that carry escape sequences or backticks go through the Edit tool or a Node script file, never an inline shell string.
- The two LM Studio load tests passed here and failed on both CI runners: `ensureLoaded` looked for the real `lms` binary and this PC has one. A test that touches a binary path gets that path injected, and the release commit was pushed before CI had answered, so the fix is a second commit on the tag. Two clean local runs are not a substitute for a machine without the tool.
- `npm test` crashes one whole test file (server, recovery) about one full run in five, with no assertion text, on the release tree and on clean main alike; the same file passes alone. Counted, not fixed: the suite runs its files in parallel and the crash looks like a port or timer race. Two clean runs in a row is the bar before a ship.
- The first `verify:browser` run on the merged tree failed on the sample sketch's `img.decode()`; a rerun passed and clean main passed. Not reproduced; noted as a flake to count.

## 2026-09-06: Sidelook (0.16.0)

- A scoped sed (`jarvis-workbench` -> `sidelook`) renamed the IndexedDB database in `public/storage.js`; the name gate then required the new name and no test observes the database, so it passed every check and would have emptied every user's saved versions after the profile move. The whole-branch review caught it; reverted to the legacy name on a marked line. A rename of anything that names data already on disk is a migration, not a string.
- The retint script's `#[0-9a-fA-F]{6}` never matched an 8-digit alpha-suffixed hex, so ten old-palette shades survived in overlays and shadows; found by the Task 3 review's named check, fixed by hand. A colour sweep lists 8-digit, 3-digit and `rgb()` forms before it starts.
- Three parallel worktree lanes each renamed their own half of a private contract (launch header, health payload, environment variables, storage keys) and the merged tree had six disagreeing pairs; a reconciliation pass on the merged tree, not a per-lane fix, closed them. Rename both halves in one change or in one pass.
- Workflow `isolation: 'worktree'` branched from `main`, not the feature branch, so the lanes started without Tasks 1 and 2; caught by `git worktree list` a minute in. The lane prompt's first command is now `git reset --hard <feature SHA>`.
- The plan's `verify-mark` corner-pixel assertion sampled (2,2), which sits outside a radius-14 rounded corner and could never pass; the implementer diagnosed it instead of loosening it. A pixel assertion names the geometry it relies on.
- `npm run lint` is wrapped in this environment by a harness that mislabels the repo's own output as ESLint JSON; every agent ran `node scripts/check.mjs` directly. Not a repo defect.

## 2026-09-06: The panel, quiet (0.15.0)

- The first height the page posted was 700: `.companion-scroll` is `flex:1`, so its `scrollHeight` is whatever the window gave it, never what the content wants. The content's height is the sum of the scroll area's children plus its padding. A flex child that fills the viewport cannot measure its own content.
- The tile's icon stretched to fill the row in the mock because `.tile>span{flex:1}` matched the icon span too. A flex rule on a bare element selector inside a row hits every child; name the one that should grow.
- The 0.9.0 mock lesson held again: six states mocked and approved before code, and the implementation passed the companion verifier on the third run, the two failures being a measurement (above) and a missing re-render of the tile when the deck went slim.
- A bash `-c` string cannot carry CSS with `content:''` or `'Segoe UI'` inside a node `-e` argument: the quotes end the shell string. A file in the scratchpad run with `node file.mjs` is the only reliable way to apply a multi-line replacement that contains quotes.
- The first palette retint keyed the amber family on saturation and hue alone, so the ivory ink (`#eeeae0`, saturation .29, hue 43) and the cream paper became mint and every dialog background became the ready green. The fix was a lightness gate: anything above L .86 is an off-white whatever its hue. A rule-based recolor needs its output tokens printed and read before the verifier runs; the misfire was visible in the printed map, not in any test.
- The retint's token rename replaced every `#8eeccf` with `var(--accent-hover)`, including the one inside the `:root` definition, so the token defined itself and every primary button's hover background computed to transparent. Eight verifiers, 63 tests and a rendered screenshot review all passed, because none of them put a mouse on a button. Found by the maintainer on the first hover. Fix: `scripts/verify-states.mjs` measures every control under the mouse with transitions off and rejects self-referential or undefined tokens; the first draft of that sweep missed the bug too, because it read the style 0 ms into a 200 ms background transition and saw a half-faded fill. A hover check reads the settled state or it reads nothing.
- Reverting that misfire could not use `git checkout` on two of the files because they carried this session's uncommitted edits; they were rebuilt from `git show HEAD:` plus the session's own apply scripts. A generated file should be regenerated from a script kept in the scratchpad, not edited in place, so a bad pass can be undone.

## 2026-09-05: Identity and copy pass

- The site verifier passed against a stale `docs/images/companion.png` after the companion copy changed, because it checks the asset exists, not what it shows. Regenerate the companion capture from the packaged app whenever companion copy or the mark changes, then rebuild the social image and the site.
- The dock's white square came from the form background showing around an elliptical button region. Shaping the form itself (rounded-square Region in dock mode, cleared in the other modes) removes the backdrop; the button only paints the mark.
- `scripts/verify-browser.mjs` had two stale assumptions: it waited for "Astra · subscription" (the status has read "Astra · medium" since the effort selector landed) and it pointed at port 4317, which the desktop launcher now owns behind the launch key, so a plain browser saw "Setup needed". It is now self-hosted on a free port with a synthetic signed-in status like the other verifiers, and asserts the `#provider-status` label against the model plus effort pattern. It still needs the recorded `.artifacts/generated.json` and `observation.json` from a real verify:vision run.

## 2026-09-05: Desktop companion release

- Keeping the companion and workbench in one document preserved existing camera, build, version, and Computer mode behavior across expansion. Separate browser profiles would not preserve old saved work automatically; explicit HTML import now adds a desktop version without overwriting the existing history.
- Desktop capture review found that a screen-region copy could include an overlapping window. Capture now uses the selected window directly, snapshots its identity, validates it again, and refuses unsupported capture instead of falling back to a desktop crop.
- Stop and reload can race a native capture. Unique capture request IDs, host cancellation generations, and page-exit cancellation prevent late results from becoming the next message's reference. Future native operations must carry a request identity across the bridge.
- The marketing sweep initially retained browser-only storage and startup wording. The release check now includes the complete startup, storage, migration, and shutdown story, alongside rendered desktop and mobile pages.
- The local command-output wrapper treated `npm run lint` as ESLint JSON even though this project uses a syntax checker. Running npm's installed CLI entrypoint directly produced the actual passing output; no application lint rule was relaxed.
- Native automation must wait for connection completion and explicitly focus its owned fixture before capture. A background fixture can lose foreground ownership; verification refuses to save or share any other window's frame.
- Rendered native QA exposed a panel that stayed wide after workbench expansion. Lowering the native minimum size before setting the compact client size fixes the transition; the verifier now checks the restored width. Expanded windows are also clamped to the monitor's working area.

## 2026-09-05: Computer mode verification

- A PowerShell-hosted UI fixture was correctly excluded by the terminal process filter. A standalone compiled fixture let the test exercise real UI without weakening the guard.
- Hidden process startup suppressed the fixture's window. Native UI tests now open only their owned fixture visibly and close it by its captured process handle.
- Requiring foreground focus for every UIA action rejected otherwise valid operations. Target-bound UIA patterns now act directly; only focus and keyboard operations require proven foreground focus.
- A review found that validating a fresh element but invoking a pattern from the old element defeated the re-resolution. Execution now obtains the pattern from the fresh, verified element and also binds parent context and accessible state.
- A regex review mistakenly double-escaped JSON-rendered source. Tests now load the compiled native regexes and check both blocked and ordinary strings.
- The ship audit must update both the existing prototype walkthrough and the new Computer guide. Keep capabilities and limitations adjacent to each mode, and verify both public surfaces in the same release.
- A lifecycle review found that apps launched by the native helper would inherit the server's kill-on-close Job Object. Packaged fixed app launches now originate from the desktop launcher, outside that job; runtime helpers remain contained. Verify user-app survival after Quit before publishing.

- Windows 11 had Paint installed as a Store app with no System32 mspaint.exe. Fixed app launches now use a fixed registered Windows app ID when the system executable is absent; no arbitrary launch target is accepted.
- The Stop button must remain usable in a new tab even when that tab has no owning-session token. A failed page-close request can leave an old lease active; Stop now stays available to revoke it immediately instead of waiting for expiry.
- The packaged system-only-PATH probe could not find powershell.exe by name. Computer mode now resolves Windows PowerShell through the absolute Windows system path, removing that PATH dependency.

## 2026-09-05: One-column redesign

- The old companion status line overwrote "screen & mic off" with "selected snapshot only" the moment a frame was attached, so the promise disappeared exactly when it mattered. One `statusLine()` now computes the sensor clause from live state and appends the attachment instead of replacing it; the unit test asserts both halves are present.
- The companion's Include box never unticked after a send, so a second message silently carried the first frame again. `spend()` clears the tick and, when the frame went, the Include box; the companion verifier asserts both after the first send.
- Cascade layers bit twice: a 900px rule set `.app-shell{display:block}` and beat the companion-surface hide in the layout layer, and the unlayered `#companion{display:flex}` in companion.css beat the layered 1180px hide. Surface rules that must win live next to the rule they override, in the same file and layer.
- Playwright's modal dialogs block clicks behind them. The verifiers now open Settings, change, and close it explicitly; the app only opens Settings by itself when sign-in is needed, never on a transport error.
- Stop from the column reported "Computer control is stopped" even when nothing had been enabled, because the panel's Stop always clicks the Computer stop to revoke a stale lease. The message now shows only when a session was actually on; the revoke call still runs.
- The packaged exe embeds `public/`, so a hand check against the built exe does not see a source edit made after the build. Rebuild before reading the exe as evidence.
- A destructured `const {reading}` inside `submit()` shadowed the module-level `reading` flag that the same function reads in its first line, so every send threw a temporal-dead-zone ReferenceError and no error ever rendered. The companion verifier caught it as "unticked sharing line sends zero requests" failing for the wrong reason; the fix is a distinct local name. Do not reuse a state flag's name for a per-call value.
- Subagents were blocked for a whole session by a DashClaw hook bug, not by policy: the execution claim sent the bare parent agent id while the action was recorded under `<parent>:<agent_type>`, so the server answered 409. Root cause found by fetching the stored action and comparing `agent_id`; fixed in the DashClaw hook (a0c24eb6) with a regression test.
- Post-send bookkeeping (untick Include, relabel the strip "Sent", append to the ledger) sat in a `finally`, so a 409, a 429 or a Stop looked exactly like a send. The review caught it in three surfaces at once. Rule: only the response decides what happened; the tick is the one thing that clears on any attempt.
- The read-only window read shared the Computer route's socket-close handler, which calls `computer.stop()` for every op but `status`; a page reload during a slow read would have torn down an armed session and killed the helper. New ops on a shared route inherit its abort semantics until told otherwise.
- Text-first chips were assigned per chip, but the helper's safety filter excludes every terminal window from `windows`, so a terminal could never be read and the badge lied. What a chip takes is a property of the window family in front, not of the chip.

## 2026-09-05: One box, one button

- The 0.9.0 panel passed every verifier and the maintainer still rejected it on sight: a scrolling box inside a 440px window, a checkbox sentence, two Include boxes, a chip strip with arrows, a Computer card under the chat. The verifiers checked consent and evidence, never the shape. The redesign added three shape assertions to the companion verifier (no checkbox, no details arrow, nothing scrolls at rest) so the next regression fails a check instead of a review. Rule: a UX bar the maintainer states ("dead simple, like Loom") becomes a verifier assertion in the same change, not a note.
- The Computer step label used `text-transform:uppercase` on a sentence ("Step 1 of 20 · waiting for you"), which DESIGN.md forbids and which turned the verifier's innerText into caps so its regex failed. The transform went, not the regex. Playwright's innerText is post-CSS; assert on what the user reads.
- The design was mocked as four states in one HTML page and approved before the code changed; the implementation then passed both browser verifiers on the first run apart from the caps label. Mock before wire held.
- 0.10.0 replaced docs/images/computer.png with the browser check's synthetic capture and fixed the README caption, but the site's caption over the same file still said "a real Fable request". Two surfaces share one image; a caption lives beside every use of it, so a swapped image is a grep for its filename across README and site, not one edit.
- A screenshot taken right after a capture showed the starters dim and read as a disabled-state bug. It was the 200ms button opacity transition caught mid fade-in; the disabled property was false. Before chasing a visual in a verifier screenshot, assert the property, then check for a transition on the element.
- 0.12.0 (2026-09-05): the maintainer asked why the model choice was capped at Astra and Fable at all, and why the change picker hid his minimized VS Code. Neither limit was a decision anyone had recorded; the cap was a two-entry list with `==='fable'` checks spread across two transports and three page files, and the picker's `IsIconic` filter came from "nothing to render" without trying a restore. Both went in one release. Lesson: a product limit that is not in DECISIONS.md is an accident waiting for the maintainer to notice; when adding one, write the decision or do not add the limit.
- The `claude` on PATH fails with "Credit balance is too low" because the shell carries an API key; Jarvis's isolated subscription path is unaffected, but that message does not match the usage-limit filter in `parseClaudeResult`, so through Jarvis it would surface as a generic failure. Probe transports with Jarvis's own env allowlist and settings, never the shell's CLI.
- The shell's "move the entire window onto the visible desktop" check protected nothing: PrintWindow renders the window's surface, not the screen, so the intersection test only made off-screen and second-monitor windows fail. A validation inherited from a screen-copy design does not carry over to a surface-render one.
- Screen on's followTick dropped a capture that fell due while a send or a read was in flight: the reducer had already marked it in flight, the page skipped capture() because it was busy, nothing ever landed, and later clicks queued behind a capture that did not exist. The reducer now answers 'busy' and keeps the deadline; tests/follow.test.mjs drives it. A reducer must not commit state for an action its caller may decline.
- verify-live still matched "Fable is grinding" after 0.12.0 renamed the label to "Fable 5.1", so the live verifier had been red for two releases without anyone noticing, because it is not in CI or the release checklist. Fixed in 0.14.0. A verifier that no list runs is a verifier that rots; every script under scripts/verify-*.mjs is either in a checklist or deleted.
- refreshSession awaited the preview restore before the provider check, so Ready arrived when the iframe did: 1548 ms with the preview held 1.5 s, measured before the change. Decoupled in session.js: 33 ms. A wait on the path a user reads as "connecting" needs its number measured before anyone argues about it.
