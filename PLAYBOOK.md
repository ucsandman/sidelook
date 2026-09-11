# Jarvis build notes

## Scope and decisions

Jarvis turns a selected camera frame or uploaded reference plus typed or locally dictated direction into an interactive frontend prototype. Further directions revise the selected source version.

- Astra runs through the official Codex CLI with ChatGPT subscription authentication. No model API, API credentials, or fallback transport is permitted.
- Camera preview stays local until a user chooses to build. The selected frame and observations remain visible in the workbench.
- Generated HTML runs inside a restricted browser frame. Host code execution, backends, deployment, and continuous camera inference are outside this release.
- Use Node built-ins and browser APIs. The application has no package dependencies.

## Implementation lessons

- Preview readiness waits for frame load and rendered layout before announcing a version. Otherwise the label can appear before controls accept clicks.
- JavaScript-handled forms need `allow-forms` in both iframe and response sandbox policies. `form-action 'none'` continues to block form destinations.
- Host-header rejection is tested with raw HTTP because Node fetch does not reliably preserve a custom Host header.
- Browser checks target visible task cards because generated applications may also render hidden views.
- Treat incomplete generation and provider failure as failed revisions. Preserve the previous version and never switch transport or billing route.
- Check child-process exit status and the explicit completion event before accepting output.

## Verified demo · 2026-09-05

| Check | Result and scope |
| --- | --- |
| Subscription inference | Astra read the synthetic sketch and generated the DAYLIGHT task board. |
| Full build | 23,539 HTML characters in 237.5 seconds at high reasoning effort. The current application runner requests medium effort. |
| Live revision | A second version added a 25-minute Focus timer through the actual workbench. |
| Generated revision controls | Five checks passed: Start, Pause, Reset, task creation/filtering, and three preserved columns. Zero page errors. |
| Workbench browser checks | Eight checks passed, covering consent, synthetic camera input, rendering, source/download, persistence, mobile layout, and project reset. Zero page errors. |
| Unit tests | All 13 passed. Covers input boundaries, host/origin checks, consent, sandbox headers, concurrency, budgets, redaction, subscription enforcement, and cancellation. |
| Fresh source copy | Installation, tests, syntax, and required-asset checks passed. |

The screenshots in `docs/images/` show real generated outputs using synthetic references. Live webcam sharing and microphone dictation remain unverified end to end. Runtime state inside generated apps resets when reopened.

## Public release retro

What worked: reviewed synthetic demo screenshots supplied evidence without sharing private camera images or repeating inference.

What needed correction: session notes contained machine-specific and conversational context that does not belong in public documentation. They were preserved locally and excluded from publication.

Change: review an explicit publish manifest, scan staged content, and verify the remote commit and CI before reporting a release complete. The public repository is the release surface; there is no separate hosted website or package publication.


## Onboarding release · 0.2.0 · 2026-09-05

### Decisions and behavior

- A combined visual build returns observations and HTML in one Astra subscription turn. Typed revisions send selected source and direction; an old reference remains as evidence but is unchecked for the next request.
- Completed generation is accepted and persisted before preview work. Preview failure does not require regeneration. Local source restoration and local preview sessions do not wait for subscription readiness.
- The built-in DAYLIGHT example is explicitly labeled sample content and is usable before login. It uses the same restricted preview and version history as generated work.
- Setup actions are human-operated buttons: install the official npm CLI, sign in with ChatGPT, recheck, reconnect, and renew the local request allowance. They do not introduce a model transport or alternate billing route.
- CLI discovery supports official npm package layouts in standard and custom prefixes. Native executable-name fallback is intentionally excluded. Metadata validation does not protect against modification by the local account owner.
- The README and public Vercel site are product surfaces. The later 0.3.0 release adds a bundled Windows executable; see docs/SITE.md and docs/WINDOWS.md for their separate allowlisted release paths.

### Verification

- 21 unit tests passed. Five new recovery tests were observed failing against the original code before implementation, then passed unchanged.
- Nine isolated recovery browser checks and eight workbench browser checks passed, each with zero page errors. The isolated suite uses a dedicated server and synthetic inference; it never installs software or signs in.
- A real combined visual build completed through Astra/ChatGPT in 209.7 seconds at medium reasoning effort, producing 22,342 HTML characters and observations. This is not a controlled comparison to the earlier high-effort two-turn build.
- The generated app passed task creation and filtering inside the restricted preview. A real typed revision through the UI added a Focus timer; five follow-up checks passed: initial time, Start, Pause, Reset, and preserved task creation/search.
- A fresh source copy of 38 files passed npm installation, all 21 tests, lint, and build.
- The Windows launcher started the server and opened the workbench in 2.87 seconds in one local run. A second launch reused the same server process. PowerShell parsing passed. Missing Node and occupied-port paths have source-level handling, not fresh-machine end-to-end proof.
- The separate security review cleared the final npm-only discovery, explicit setup operations, server-side consent and session controls, safe errors, and preview isolation.
- Actual CLI installation and interactive account sign-in were not invoked against the operator's existing installation/account. Their request/consent paths were checked with injected operations. Real webcam and microphone input remain unverified; camera browser checks use a synthetic device.

### Local routes

All state-changing routes require the local Host/Origin boundary, `Content-Type: application/json`, and an `X-Jarvis-Session` header from the local session response. Tokens are per-process and should never appear in logs or documentation examples.

| Route | Request | Response / purpose |
| --- | --- | --- |
| `GET /api/health` | none | `{ "app": "jarvis-workbench", "ready": true }`; lightweight launcher readiness, no CLI call. |
| `GET /api/local-session` | none | Local session token, remaining request count, and Windows dictation availability; no subscription check. |
| `GET /api/session` | none | Local token plus CLI availability, ChatGPT login status, model name, and remaining local count. Login is not proof of model entitlement. |
| `POST /api/build` | `{ "instruction": "Build a task board", "previous": "", "image": null, "consent": true }` | Validated result with title, reply, changes, HTML, and observations for image builds. One subscription turn. |
| `POST /api/observe` | Image data URL, optional instruction, `consent: true` | Standalone visual analysis; retained for explicit diagnostics. |
| `POST /api/preview` | `{ "html": "<html>...</html>" }` | Restricted preview URL; no inference. |
| `POST /api/login` | `{ "consent": true }` | Starts official ChatGPT browser sign-in and returns safe status when complete. |
| `POST /api/install-codex` | `{ "consent": true }` | Installs fixed `@openai/codex` from the official npm registry globally with scripts disabled; returns safe status. |
| `POST /api/reset-budget` | `{ "consent": true }` | Renews only Jarvis's local allowance. Saved versions and provider allowance are unchanged. |

The UI sends setup requests only after explicit button actions; installation and allowance renewal have confirmation dialogs. Setup/inference share a single busy guard and reject overlap. Failures expose allowlisted codes and messages, never raw CLI output. Invalid model input is rejected before the local allowance is charged.

### Release retro

What worked: failure-first regression checks and isolated browser profiles caught lost completed results and unnecessary reference sharing without spending subscription allowance. Real subscription checks then proved the combined build and revision paths.

What needed correction: broad executable discovery weakened the official-CLI boundary, and the camera button was hidden once a reference had been selected. The lint wrapper also attempted to parse a non-ESLint check as ESLint output.

Change: retain npm-layout validation and negative discovery tests; keep input controls outside replaceable preview content; run the repository's actual lint/build scripts through its npm CLI when the harness wrapper misclassifies them. Keep these gates in the release checks.

## 0.3.0 Windows and public launch

Website follow-up: retaining the rejected task board behind an optional disclosure did not address the maintainer's feedback. Removed the public section and hosted sample entirely. When a demo does not explain the product, remove it rather than merely demoting it.

The Windows download bundles the official runtime and CLI, opens a graphical browser workbench, and provides desktop/Start menu shortcuts and tray Open/Quit. Its build uses an explicit source allowlist, a fresh staging directory, pinned package integrity and verified upstream publishers. The Jarvis launcher itself is unsigned and this is disclosed beside the public download. Local subscription architecture and camera consent are unchanged.

Verification: 22 unit tests and syntax/build checks pass. Nine recovery browser checks pass. The rebuilt executable passes 18 assertions covering extraction with system-only PATH, bundled discovery, explicitly isolated signed-out CLI status, API bootstrap denial, removed URL fragments, port-isolated browser storage, rendered preview and reload. Six actual Windows lifecycle checks pass, including occupied-port refusal, second-click reuse, Quit and forced launcher termination. No new inference or interactive sign-in was required for this package release; the earlier real subscription build/revision evidence remains above.

Retro: the bundled runtime and process ownership checks worked. The first public task board confused an app input with a Jarvis prompt, so the site now shows the actual sketch, captured build and captured revision before offering the optional sample. The next demo must show the product's transformation, not just an output app's controls.

Security review caught unauthenticated cross-account loopback access, then a cookie-based fix that leaked across ports. The final executable uses a random launch key in origin-isolated session storage and API headers; preview URLs are separate random capabilities. Preserve negative raw-client checks and never use host cookies for loopback port isolation. The external review service became unavailable before its final re-review; final source and executable checks were completed locally.

Packaging failures: Windows PowerShell could not deserialize npm's empty root-package property, and native argument quoting stripped JavaScript string quotes. Parsing package integrity through Node stdin fixed both. HOME overrides also failed to create an unsigned-in Windows identity; the verifier now uses an explicit isolated CLI storage directory only for the signed-out status probe and does not claim a fresh OS account. Preserve these real failure cases when changing the packager or verifier.

Public hosting remains a static allowlisted deployment on the approved existing Vercel Pro team. Google and Bing ownership are verified and sitemaps submitted. Initial Google indexing request hit the account's daily quota; indexing is not guaranteed. Standard Vercel analytics is enabled, without the Plus add-on.

## 0.4.0 provider and effort verification

- 28 unit tests, 13 model/effort browser assertions, nine recovery browser checks, and 24 local public-site checks passed. Static verification checked 25 JavaScript files.
- Installed the pinned official Claude Code runtime through the production installer: archive checksum and Anthropic publisher verified; existing paid first-party login reused without exposing credential output.
- A real Fable image build at low effort completed in 34 seconds with five observations and 4,133 HTML characters. Its restricted preview passed five checks: load, task creation, search, movement, and zero page errors.
- Independent security review found no critical/high issue. Its stale billing-documentation finding was fixed before packaging.

Retro: the provider mechanism and rendered output worked. Initial preview QA used an incorrect session header and correctly received HTTP 403; using the server's actual header fixed the probe. Derive future verification clients from the canonical endpoint contract. Subscription OAuth does not prove included-only billing; preserve explicit credit notices and fresh consent on provider changes.

DEVIATIONS: Claude Code installs directly from Anthropic through Setup instead of redistribution inside the executable. The no-terminal flow is preserved. The user explicitly allowed Claude subscription usage credits; no direct model API was introduced.

Packaging evidence: the final 0.4.0 executable is 171,300,352 bytes. All 18 packaged-app assertions and six actual Windows lifecycle checks passed. Payload inventory checked 37 files, including 27 text files, with seven current-source matches and zero credential filenames or secret/private-path matches. A clean staged-source checkout passed npm ci, 28 tests, lint and build. The production dry-run contains 12 public files and excludes generated environment data.

## 0.5.0 screen sharing and Live build

Added a browser screen/window picker alongside camera and upload. Live build requires separate consent, compares 160 by 90 thumbnails locally, waits for three quiet seconds, and sends only changed snapshots. Minimum intervals are 30 seconds, 60 seconds, or two minutes. It serializes generation, keeps only the newest settled candidate, pauses after ten requests, and cancels unfinished inference on Pause or capture loss. Stop sharing releases the track. Reload does not resume. The exact last sent frame is inspectable.

A compact animated status panel keeps the existing prototype usable. Astra and Fable get distinct waiting copy and motion; elapsed time is visible without fabricated completion percentages. Reduced motion disables animations. The screen capture API is initiated directly by the user's click and excludes audio. Provider and effort remain fixed during Live build.

Verification: 31 unit tests, 22 synthetic live-loop browser checks, 13 model-selection checks, nine recovery checks, and 24 local site checks passed. A real Chrome getDisplayMedia session captured a dedicated public drawing tab, and one real Fable/low automatic build completed in 60 seconds with 4,769 HTML characters and zero page errors. This is a single measurement, not an instant-update guarantee. No private desktop or webcam content was used for verification.

Retro: real capture and the automatic build worked. The first synthetic fixture produced no video frames until it repainted the canvas, and the first request assertion inspected the inference prompt instead of the HTTP body. Correcting the QA fixtures exposed the intended behavior without weakening assertions. Existing camera-status copy was preserved after its regression check failed. Keep native capture proof separate from deterministic scheduling tests, and inspect request bodies at the actual API boundary.

DEVIATIONS: Live build uses consented snapshots and bounded automatic requests; it does not stream video or guarantee instant output. No new dependencies or provider transport were introduced.

Final UI review caught a stale-reference edge case after pausing Live build. Clearing the selected-image pointer when returning to the shared video ensures the next manual capture is fresh; the exact previous frame remains in sent-frame evidence and saved revisions. All 22 live browser checks passed again after that fix. The real generated output also passed task creation, search and movement checks. Its submit button uses HTML's default submit type; the QA locator was corrected to its visible accessible name.

The final 0.5.0 executable passed 18 packaged-app assertions and six Windows lifecycle checks. Its payload scan covered 38 files, including 28 text files, with six current-source matches and no credential filenames or secret/private-path hits. Clean staged-source installation, all 31 tests, lint and build passed. Public deployment dry-run contains 12 files and excludes generated environment data.

## 0.6.0 incremental draft release

The CLI process runner now forwards bounded stdout events while retaining final validation. Fable emits HTML only from an active StructuredOutput block. Partial JSON decoding handles split escapes and ignores nested or quoted fake html fields. The local build endpoint offers opt-in NDJSON while retaining its JSON response for existing clients. Drafts use a script-disabled sandbox, stay out of history, and are revoked on build completion, cancellation, or failure. The prior working version remains accessible.

Astra stays on its config-isolated Codex exec path, which currently releases completed messages. Codex app-server has a different configuration surface and no equivalent verified ignore-user-config path in this work. It was not silently substituted. The interface and public docs state this limitation. Fable now calls StructuredOutput directly to avoid duplicate JSON narration; a low-effort shortcut and concise output instruction reduce unnecessary work.

A real Fable/low request produced first HTML at 18,892 ms and finished at 20,519 ms, with two draft updates and 2,949 HTML characters. This is a small independent request, not a controlled comparison with earlier runs. Browser checks verify real progressive rendering, scripts blocked in drafts, working-version interaction, cancellation and final persistence.

Security review caught two issues: inactive null block indices accepted deltas, and draft capability URLs survived cancellation. Active integer-block checks and build-owned capability revocation fixed both. Regression coverage now rejects null-index deltas, checks active draft CSP, verifies post-failure 404 and ended-session 409. Final independent review found no remaining findings. All 35 unit tests and 14 streaming browser checks pass.

Repository cleanup adds the MIT license, refreshes README/contributor/model/site documentation and a screenshot using captured real HTML, and updates GitHub's description, homepage and topics. Historical evidence is retained here rather than presented as current instructions.

Retro: proving the provider stream before changing the UI kept the preview honest. Stream lifetimes need to own both parsing state and temporary URLs; future streamed-output features must test revocation and malformed event order, not only successful rendering. A combined documentation/metadata shell call was rejected by automatic review without a detailed reason; separating local documentation writes from the explicitly authorized GitHub metadata operation succeeded.

DEVIATIONS: Fable provides incremental drafts; Astra remains completed-message-only until an equally isolated streaming transport is verified. Drafts intentionally disable scripts until completion. No provider, account, or billing route changed.

Final local verification: 35 unit tests, 14 streaming, 22 live-build, 13 model-selection, nine recovery, 18 packaged-app and six Windows lifecycle checks passed. Static checks covered 31 JavaScript files. The packaged payload scan covered 40 files, 30 text files and nine current-source matches with zero findings; 16 relative documentation links resolved. The unsigned 0.6.0 executable is 171,309,056 bytes; SHA-256: 42fa597ab52cf6b1bbb79a299f501b047170a0ad6f6d8bebb10c133a41105ce5.

0.6.0 shipped: source 45e139d, release v0.6.0, Windows/Linux CI 33980839433 passed. Production Vercel deployment dpl_9DBCD1x4HN27ZX2TbyNRu8Sv47Tk passed 24 live site checks. Anonymous release download hash matched; GitHub MIT recognition and About/homepage were verified. The local app was restarted on the packaged streaming implementation. Clean staged-source installation, tests, lint and build passed before publication. Retro: release verification covered the executable users actually download and the running desktop process, preventing a source-only success claim. No social posts were sent.

Marketing correction: updating only the FAQ and version links left the hero showing the old camera-first interface. The landing page now leads with the current screen-sharing workflow and Fable draft screenshot, and the earlier walkthrough is labeled historical. Future user-visible releases must compare the hero image and primary action against the running app, not only check text and links. No application behavior changed.

Walkthrough correction: retaining historical screenshots after refreshing the hero left the primary example out of date. Replaced the whole walkthrough and audited visible app controls against marketing copy, FAQ and llms.txt. The verifier now follows the current controls and explicitly rejects obsolete deployed assets. Future marketing checks must exercise every linked walkthrough step, not just the landing view. No app behavior or provider transport changed.

## 2026-09-05 Computer mode release

User-approved desktop architecture extends the existing app with reviewed Windows accessibility actions and unchanged isolated subscription transport. Native fixture and real Fable/browser tests proved planning, text replacement, clicking and result inspection. The independent review caught stale-pattern validation and user-app shutdown containment before release. Keep a real native action test and user-app survival check alongside protocol/browser tests. Audit README, GitHub About, screenshots, marketing features, both tutorials, privacy, installation and model docs together whenever either mode changes.

0.7.0 shipped and the anonymous release hash and production site were verified. Clean-PATH packaging caught a helper discovery bug that normal development missed; keep native startup in the system-only-PATH package test. Separate public release verification from optional local reopening, and report an automatic approval rejection explicitly when it prevents that final convenience step.

## 2026-09-05 Desktop companion release

The approved companion extends the existing launcher and document with WebView2, a dock, compact conversation, and workbench expansion. Conversation uses the existing isolated subscription inference. Native capture is explicit and target-bound; random request IDs and cancellation generations discard stale results. Import appends saved HTML to the desktop profile, with the existing preview sandbox.

Local verification for 0.8.0: 40 tests; 43 JavaScript syntax checks; 7 API requests across two isolated conversation services; 12 companion, 9 recovery, 14 streaming, 22 Live build and 11 Computer browser checks; 8 real WebView2 content checks; 20 packaged-app assertions; 6 launcher lifecycle checks. The native host also proved panel/dock transitions, shortcut registration and reopen. A 93-file clean-source snapshot passed installation, tests, lint, build and conversation verification. Two real Fable requests checked the builder handoff and rejection of unsupported automatic terminal installation. The source security review reported no release-blocking findings.

The unsigned executable is 172,186,624 bytes, SHA-256 `91c8667bdfe2c08ae191a06b41a8d321f68d210adafbe8f8bb05788b5e00d108`. Website checks passed on desktop and mobile; the deployment preview contained 12 public files and excluded local environment and configuration files.

Retro: preserving the workbench made the existing browser suites useful, but only native rendering exposed the retained minimum-width bug. Keep the native round trip and dedicated capture fixture in the release checks. Publishing and live verification are recorded separately after completion.

0.8.0 shipped: implementation commit b348347 and README screenshot follow-up f4a28d2; Windows/Linux CI runs 33987813828 and 33987872053 passed. Release v0.8.0 is public. The anonymous executable download matched the 172,186,624-byte size and SHA-256 above. Production deployment dpl_EPmdoe1LvMPevhjixhCihQpsVKwj is READY at the canonical website; live desktop/mobile walkthrough, keyboard, assets, private-route, download and browser-error checks passed. GitHub About and homepage reflect the desktop companion. The shipped desktop app was reopened locally after verification. No social posts were sent.

Release retro: source checks, native checks and anonymous download verification each cover a different failure boundary. Keep the public checksum comparison and production browser check as required steps after publication, before declaring a release complete.

## 2026-09-05 One-column redesign · 0.9.0

Two idea tournaments (plans/feature-roadmap-tournament.md and plans/ui-harness-redesign-tournament.md) picked the deck of context chips and the one-column layout. Both were implemented against the 0.8.1 source in the order the redesign spec gives: follow-ups, harness modules, the column, Settings, the studio, Computer mode in the column, the shell, docs.

After the redesign shipped locally, the maintainer approved two more roadmap items and they landed in the same release: a read-only `read` operation on the Computer broker (never arms, no owner, exact window text shown with counts and a truncation flag before its Include box can send it) and a write-only clipboard Copy on every reply, with a lint scan that fails on any clipboard read.

Local verification for 0.9.0, counts read from the output: 47 tests (7 new for the harness, the chip table and the read op); lint checked 46 JavaScript files, 13 asset routes on disk, 15 references resolved, 0 declarations under 12px, 35 shipped files scanned for clipboard reads with 0 found; 7 assistant requests across two isolated services with bounded follow-ups and a 20,000-character window-text bound; 20 companion checks with 8 synthetic requests and 5 synthetic native reads (deck chips, send preview against the request, tick and Include clearing, follow-ups, Copy as one write-only message, list rendering, ledger, Read text with its volume line and provenance, the error window reading text instead of a frame, handoffs, dictation, stop, clear, import, reload; zero arm calls across the run); 11 Computer checks (lease dialog, per-plan clearing, model from Settings); 9 recovery, 14 streaming, 13 model, 24 Live build and 9 browser checks (column visible at 1440, hidden at 1100); 20 packaged-app assertions; 15 native Computer checks including a read of the fixture before anything is armed; 8 real WebView2 content checks including the pinned right edge; the native host check registered Ctrl+Shift+Space and Ctrl+Shift+E. A real Fable/low Computer run completed 3 model steps and 2 reviewed actions in 24.8 seconds.

Hand check against the packaged app with real foreground windows: an error-titled window produced "Unstick me", "Is this safe to click?" and "What do I do next here?"; Windows Terminal produced "Unstick me", "What's this error?" and "What does this output mean?"; Notepad falls to the three generic questions (not in the family table). Ctrl+Shift+E sent through SendKeys captured the error window, filled the Unstick prompt, ticked Include and left the sharing tick unticked. Opening the studio kept the window's right edge at the same pixel, sized 1480x900, and ← Panel returned to 440x700 at the same edge. Pressing "Unstick me" on the error window read it instead of capturing: 8 controls, 206 characters, truncated no, the exact title and buttons in the strip, "window text attached" in the status, and the Computer card still resting.

Two checks were observed failing before the code that fixes them: the new 12px floor in check.mjs failed on the 0.8.1 stylesheets (8 declarations in companion.css), and the companion verifier's Include-clears assertion cannot pass on 0.8.1 companion.js, which never unticked it.

DEVIATIONS from the redesign spec: the tick clears after every send in the studio too (decision 1, per send); the column stays visible inside the studio (decision 2); `/api/observe` stays for now (decision 4); Computer mode count pluralizes "1 action". Subagents were blocked by the DashClaw claim endpoint for the whole session, so every file was written from the main loop through the recorded scratchpad path.

An adversarial review (four read-only finders, three skeptics per finding) ran against the whole diff before the commit and confirmed twelve distinct defects, all fixed in the same release: post-send bookkeeping in `finally` that logged refused sends and unticked attachments on failure (now only a real send records, marks and unticks; the ledger names refusals and the footer counts only sends); the read op sharing the Computer session's abort teardown and busy state (reads are exempt from the socket-close stop, and a rejected Approve keeps its proposal); terminal, browser, editor, chat and design windows taking a text badge they cannot honour (those families take a frame); title matching that failed on the shell's trim and 200-character cap; the truncation flag shown to the user but never sent to the model; Copy saying "Copied" before anything was written (the shell now answers every copy); an unguarded Ctrl+Shift+E that overwrote a draft mid-request; a failed capture routing the previous frame into the studio; an old reply re-attaching a removed frame; the two-step allowance reset staying armed after Escape; a clipboard scan narrower than the boundary it claimed; and a tick that survived a new attachment (new evidence now clears it). The review cost 4.5M tokens across 82 agents and found nothing the verifiers had caught.

Retro: the cascade-layer and modal-dialog failures were found by the verifiers, not by reading; the status-box regression was found only by looking at the rendered capture. Keep the rendered hand check with real foreground windows in the release checks, and rebuild the exe before reading it as evidence for a source edit.

0.9.0 shipped: implementation commit 8fe0324; CI run 33999948390 passed on Windows and Linux. Release v0.9.0 is public with `Jarvis-0.9.0-Windows-x64.exe` and `SHA256SUMS.txt`. The anonymous download matched the 172,317,696-byte size and SHA-256 `5c171a6401f517656fd5e87bb2e8d8b423ab146f6b3b4ac58a8baa5aa304110b`. Production deployment jarvis-workbench-asc5gw7go is Ready at the canonical website; the live site says Jarvis 0.9.0 twice and the walkthrough check passed against it (4 steps on desktop and mobile, 7 public assets, 7 removed routes, pinned download, no overflow or browser errors). The installed desktop app was relaunched on the shipped payload after verification. The DashClaw hook fix that unblocked subagents shipped separately as DashClaw a0c24eb6. No social posts were sent.

## 2026-09-05 One box, one button · 0.10.0

Wes rejected the 0.9.0 panel on sight ("I still hate the layout"): a scrolling box inside a small window, a checkbox sentence, two Include boxes, a chip strip with arrows, a Computer card under the chat. The redesign was mocked as four states of the same 440px panel in one HTML page and approved with "go" before any code changed, including the removal of the tick from the panel and Computer mode (docs/DECISIONS.md, "One box, one button, no tick in the panel").

Local verification for 0.10.0, counts read from the output: 48 tests (the gate test now proves the panel and Computer mode need no tick; a new test covers the Send label and the separate activity and sensor lines); lint checked 46 JavaScript files, 13 asset routes on disk, 15 references resolved, 0 declarations under 12px, 35 shipped files with 0 clipboard reads; 19 companion checks with 8 synthetic requests and 3 synthetic native reads (no checkbox, no details arrow and nothing scrolling at rest; starters fill the box and only the screenshot starter captures; the button says what goes; the attachment clears after a send and stays on the message as evidence; a refused send keeps it; an error window brings Unstick me back mid-conversation, reads text instead of a frame and never arms; Back and Open around Computer mode; stop, clear, import, reload; the studio opens from Settings); 12 Computer checks (Set it up from Settings, the screen replacing the conversation, no tick anywhere on it, Back keeps the lease); 9 browser checks; the site walkthrough; 20 packaged-app assertions; the native host check registered both shortcuts; 8 real WebView2 content checks including the pinned right edge and a native capture whose button read "Send with screenshot ↑". The README and site screenshot is that native capture: the packaged app with Brave in front, three browser starters, the fixture's screenshot in the box.

Verify-computer failed once before the code that fixes it: a `text-transform:uppercase` on the step label turned "Step 1 of 20 · waiting for you" into caps, which DESIGN.md forbids and which the regex caught. The transform went. Subagents were not used; every file was written from the main loop through the scratchpad staging path.

DEVIATIONS from the mock: starters return when Jarvis is summoned from a different window mid-conversation (the mock hid them for good, which would have stranded text reading); step labels are sentence case, not small caps.

0.10.0 shipped: implementation commit 90fcd21; CI run 34002223024 passed on Windows and Linux. Release v0.10.0 is public with `Jarvis-0.10.0-Windows-x64.exe` and `SHA256SUMS.txt`; the anonymous download's SHA-256 matched `c9e36c2f2d60fce5e9ee3bd118dca6cbf54a6578d246b89acc3d24f147a539a3`. Production deployment jarvis-workbench-6buf5vtu7 is Ready at the canonical website; the live page says Jarvis 0.10.0 three times and "Send with screenshot" twice, and the walkthrough check passed against it (4 steps on desktop and mobile, 7 public assets, 7 removed routes, pinned download, no overflow or browser errors). No social posts were sent.

## 2026-09-05 Choose what Jarvis looks at · 0.11.0

Wes's second correction the same evening: the panel only looked at the window under the last click, and the shell refused a window not wholly on the visible desktop ("Move the entire selected window onto the visible desktop before capturing it"). A fifth mock state (the picker) was approved with "go" before code changed.

Verification for 0.11.0, counts read from the output: 48 tests; lint 46 files, 0 under 12px, 0 clipboard reads; 20 companion checks with 8 synthetic requests (change lists the desktop and every window from a synthetic shell, a pick re-fits the starters and captures that target, a closed window is refused and relisted, starters stay live after a capture); 12 Computer checks; 9 browser checks; the site walkthrough; packaged 0.11.0 with 20 assertions; the native host check; 9 real WebView2 content checks, the new one picking the verifier's own fixture from the live window list, capturing it, then capturing Whole desktop at 800px or wider with the panel back afterwards. The installed app was quit through its named signal for the packaged checks and relaunched on the new build twice this evening.

0.11.0 shipped: implementation commit 4803f64; CI run 34003437590 passed on Windows and Linux. Release v0.11.0 is public with `Jarvis-0.11.0-Windows-x64.exe` and `SHA256SUMS.txt`; the anonymous download's SHA-256 matched `c892e42cd67a30ec4eaaa086a0b789a43faf666c7ece0dea511fb3ae5a47bf1b`. Production deployment jarvis-workbench-e4gtm4j13 is Ready; the live page says 0.11.0 three times and names the whole desktop, and the walkthrough check passed against it. The site's Computer mode caption had still said "a real Fable request" over the synthetic browser capture that replaced it in 0.10.0; corrected in this release. No social posts were sent.

## 2026-09-05 Any model, minimized windows too · 0.12.0

Wes asked why the model choice was capped at Astra and Fable and why his minimized VS Code was missing from change. The two-model list became a catalog in `public/models.js`, read by the page and the server: seven OpenAI models from the Codex CLI's own model cache on this machine (with each model's effort levels) and four Anthropic models by Claude Code's full names. Every `==='fable'` check in the transports and the page became a provider or catalog lookup. Live probes through Jarvis's isolated env and settings showed Claude Code reporting exactly the passed ID for Opus 5, Sonnet 5 and Haiku 4.5, Sonnet accepting max effort, and Codex answering on gpt-5.6-sol, so the pin check holds for every entry. The picker lists minimized windows; capture shows one with `SW_SHOWNOACTIVATE`, waits for it to unminimize plus 250 ms and a `DwmFlush`, prints it, then `SetWindowPlacement` puts it back minimized with its restore state intact.

Verification for 0.12.0, counts read from the output: 49 tests; lint 47 files, 0 under 12px, 0 clipboard reads; 13 model/effort browser assertions; 20 companion checks with 8 synthetic requests; 12 Computer checks; 9 browser checks; 7 assistant requests; the site walkthrough; packaged 0.12.0 with 20 assertions; the native host check; 9 real WebView2 content checks; 6 lifecycle checks. The real capture service, compiled with a scratchpad harness, listed 18 windows of which 11 were minimized, captured the minimized VS Code at 1216x808 with its editor visible, left it minimized and left the foreground window unchanged. The installed 0.11.0 was quit through its named signal for the packaged checks and 0.12.0 relaunched afterwards.

0.12.0 shipped: implementation commit 9d7444b; CI run 34004997758 passed on Windows and Linux. Release v0.12.0 is public with `Jarvis-0.12.0-Windows-x64.exe` and `SHA256SUMS.txt`; the anonymous download's SHA-256 matched `dc9b30ee222c1f2259c3788fc2d4eae5d92d676a5511de756341bcf93c012c91`. Production deployment jarvis-workbench-4lkpgh2kc is Ready; the live page says 0.12.0 seven times and "Anthropic model" seven times, the walkthrough check passed against it, and the Vercel dry manifest kept `.env.local` in its ignored list. The social image was regenerated because its caption still said "Astra or Fable". No social posts were sent.

## 2026-09-06 Buttons that stay under the mouse · 0.15.1

The maintainer hovered "Follow my clicks" in 0.15.0 and it vanished. Cause: the retint's rename had turned the `:root` line into `--accent-hover: var(--accent-hover)`, so every filled button's hover fell to transparent. Eight verifiers and 63 tests had passed because nothing put a mouse on a button. Asked for a thorough review of errors like it: built `scripts/verify-states.mjs` (every control at rest and under the mouse with transitions off, every text node, every token defined and not self-referential, panel, dialogs, Computer mode, studio and the built site), proved it by putting the broken token back (seven vanishing buttons reported) before trusting its clean run, and found two more stale sentences on the site by the same sweep ("Open Jarvis-0.14.0", "next to a tick"); the site verifier now rejects any version string but the current one. Shipped as 0.15.1 because the exe embeds the stylesheet.

Retro: the sweep's first draft also missed the bug, reading a half-faded fill mid-transition. Change: a state check reads the settled state, so transitions are off in every verifier that measures a hover. And a rename over a file must exclude the definition it is renaming; `verify-states` now catches a self-referential token in under a second.

## 2026-09-06 The panel, quiet · 0.15.0

The maintainer looked at the 0.14.0 panel and asked for something drastically better: cleaner, fewer words and options, a box that is easy to move, grow and shrink. Brainstormed three directions (restyle in place, a panel shaped by its content, a viewfinder panel), recommended the second and rejected the third on the record because it would capture at summon. Mocked six panel states plus four box states in `.artifacts/panel-mock.html`, trimmed the words after the first review, approved. Built: borderless panel with a content-driven, bottom-anchored height and native edge resize; the window tile with its process icon; plain starters; bubbles without labels and thumbnail evidence; an auto-growing box with a grip; ↑ as the words-only Send. Companion verifier: 23 checks including the shape assertions and the box heights (21, 63, 168, 141 after the grip). All synthetic verifiers green; the shell compiled and packaged. Docs, README, site copy and the companion screenshot (from the browser check, 440×380) updated in the same change.

Mid-session the maintainer added two asks before the ship: he did not like the colour scheme, and the dock had to be movable. The dock got press-to-summon, drag-to-move, and a saved anchor corner (`dock.json`). Five palettes were rendered on the same panel with measured contrast; the assistant recommended graphite and mint and the maintainer took it. The retint ran by rule over `style.css`, misfired once on the ink (logged in ERRORS), and was redone with a lightness gate; the mark, dock button, tray and exe icons, WebView backdrop, Screen on border, studio and site changed together. Every synthetic verifier passed again on the retint and the exe repackaged with the new icon.

0.15.0 shipped from 406b972: CI 34026458718 green, release v0.15.0 with the exe and checksums (anonymous download hash matched), deployment dpl_J6Q86ikKM4CpgiynVz791h9BwSxP Ready and verified at the canonical URL.

Owed: the desktop-host check (borderless style, content-sized first panel, growth for the lease dialog), the desktop-content check, a dock drag on a real desktop, and a real look at the panel and the mint over a real window, all of which need the desktop free.

Retro: the mock pattern held for the third time; what worked was writing the verifier's shape assertions from the mock before wiring, so the first failing run pointed at a measurement, not a design. What did not work: measuring a flex child for its content. Change: any "how tall is the content" question is answered from the children, never from the scrolling container.

## 2026-09-06 Responsiveness pass · unreleased

Four behaviors and one boundary, each measured before and after with a scratchpad script against synthetic transports (no provider, no desktop). Readiness with the preview held 1.5 s: 1548 ms before, 33 ms after; with the preview failing: 1527 ms before, 31 ms after. Idle DOM mutations over 2 s of Screen on following: 72 before, 2 after (status writes 8 to 2). Effort-only changes stopped probing the provider; a model change still does, once. Readiness moved into `public/session.js` with its own tests. Computer mode reads the window back once after every approved action and shows "Windows accepted" apart from "Observed"; a failed reading says verification was unavailable and never replays the action. The review card names the consequence, window and target in plain words, with references and the tree behind a Details button.

The Studio consent redesign (one box, a removable frame chip, one button that says what goes, the source disclosed on the line under the box) was mocked as six states in `.artifacts/studio-mock.html` and stopped at the approval gate, since tests/harness.test.mjs asserted the tick in three places. Wes approved it and asked for the whole set to ship; the studio then took the panel's contract in the same release (0.14.0), with the three harness assertions rewritten, seven verifiers moved off `#build-consent`, and a stale "Fable is grinding" regex in verify-live (the label became "Fable 5.1" in 0.12.0) fixed on the way. The two concerns from the first pass closed too: the read-back has its own 8 s bound, and Stop no longer strands a follow capture.

0.14.0 shipped: implementation commit 2e32990 on main and screen-on; CI run 34023303339 passed on Windows and Linux. Release v0.14.0 is public with `Jarvis-0.14.0-Windows-x64.exe` (172,345,344 bytes) and `SHA256SUMS.txt`; the anonymous download's SHA-256 matched `9e3be9a03b07f33c858533ffd48a44e90cd0ca15d835bd7e23c8d1d647a4ff7c`. Production deployment dpl_J6ahAc3yoL92yvCmncfSEfARwm3V passed the site check with the 0.14.0 download and the new studio copy live. Not done: the desktop-host hand check (needs a free desktop) and a real-subscription build through the new composer; the studio path was proven with synthetic transports only.

Retro: the 20-edit budget ran out mid-phase five. Staging whole files in the scratchpad and copying them in, and an exact-string apply script for the small edits, carried the rest; both are logged overrides. The one change: count the planned edits before the first one, and stage from the start when the plan exceeds the budget.

0.16.0 shipped: Sidelook, a Practical Systems product. Merge commit 3b659ac on main and screen-on from the 29-commit `sidelook` branch; release v0.16.0 with `Sidelook-0.16.0-Windows-x64.exe` (172,362,240 bytes); site live at https://sidelook.practicalsystems.io with the old host redirecting; repository renamed. Built as a spec, a twelve-task plan, then subagent-driven execution: Tasks 1 to 3 one at a time, Tasks 4 to 11 as three parallel worktree lanes (native, page, site) each with its own review and one fix round, a reconciliation pass over the merged tree for the six private contracts whose halves had drifted between lanes, an independent verification run, and a whole-branch review that found the one thing no check could: the saved-prototype IndexedDB had been renamed by a scoped sed, which would have emptied every user's versions list after the profile move. Reverted to the legacy name. Every synthetic check passed at 4f18404; the desktop hand checks are owed (see the release memory).

Retro: the seds did their job and the reviewers earned their seats; what nearly shipped was a rename that a name gate required and no test observed, because the data it touched lives on the user's disk, not in the repo. Change: any rename of a storage key, database name, folder or header now needs a line in the plan saying what existing data it addresses and how it survives, and the whole-branch review checks that list first. Second change: Workflow lanes with worktree isolation start from main, not the feature branch; the lane prompt's first command is a reset to the named SHA, checked with `git worktree list` right after launch.

## 2026-09-11 Bench, the champion UI · unreleased

Wes asked for a tournament, the champion built, then impeccable, polish and de-vibe, in one request with ultracode on. Three workflows ran: the tournament (8 designers, 5 judges scoring all eight, two semifinals with 3 judges, a final with 5, a Fable synthesizer, 3 skeptics; 28 agents, 61 minutes), the build (6 slices with one owner per file, in parallel in one working tree, 8 minutes) and the de-vibe audit (3 lanes). The two new verifier assertions landed first and were run against the unchanged UI: Approve sat 90px below the agent body and 160px below the computer body, both red for the right reason. After the six slices the eleven checks were green on the first integration run; the one hand pass merged a duplicated Computer-mode block that a slice had appended instead of editing in place.

Polish, from the rendered screenshots rather than the spec: Live build moved from the sources row to the status line (at 380px the sources row wrapped and orphaned Sample sketch); beside the studio the panel header took the toolbar's 48px and seam; a timeline detail took its own line (a short label had been sharing the row with it); the Live build heading dropped its upright Georgia. F6 was found broken in the browser after a clean code review: the reference pane's first button sits inside a hidden wrapper, is not `[hidden]` itself, and cannot take focus; the pick now tests `offsetParent`, and verify-browser walks the four panes.

Retro. Worked: an L1 red run before any layout change, disjoint file ownership (zero conflicts across six parallel editors), and a spec that named every verifier assertion at risk. Did not work: the synthesizer's 76K-character answer was split across two assistant messages and the workflow forwarded only the tail, so the three skeptics judged a fragment and the round was wasted; a keyboard path passed review and failed in the browser. The one change: a workflow stage whose answer can exceed one message returns a file path and the script forwards the file, never the final text.

Three changes Wes asked for after 0.16.0, built as two Opus worktree lanes (chat controls; the Bench button and the studio reflow) with the local provider done by hand in the main loop, since it was the architecture piece. The lanes merged with one changelog conflict and nothing else. Chat controls: New chat, Clear context and Compact in one row under the messages, a meter line (percent of the 24,000-character history budget, last send and this chat in tokens, cached counted beside), cached tokens read from Codex's `cached_input_tokens` and Claude Code's cache read and write. Bench: the studio button moved out of Settings into the panel header; the studio opens at 85% of its monitor's working area (cap 1480x900, floor 760x520), remembers a dragged size in `studio-size.json`, and reflows at 1180 (chat column becomes a toolbar toggle and overlay) and 900 (one column, wrapping toolbar). Local models: LM Studio and Ollama through Codex's `--oss --local-provider`, listed from the runtime on every handshake, chosen from that list, failing closed when the runtime is down or the model gone; AGENTS.md carries the 2026-09-06 approval.

The local path took four measured corrections, none guessable from the docs. (1) LM Studio's just-in-time load uses a 4,096 context and Codex's prompt alone is 12,710 tokens, so the model is loaded ahead at 32,768 through `lms load`. (2) LM Studio does not enforce `--output-schema`: the small proof instruction produced JSON, the real companion prompt ("plain text") produced prose, so the schema rides in the instructions and the one JSON object is read out of the reply. (3) Every layer on an 8 GB card (LM Studio's default) swapped the 32k cache through the driver: 150 s prefill, 5 tokens/s; a 0.5 to 0.7 share fit, so the share is computed from nvidia-smi and the model's size, 0.6 on the 3070 Ti. (4) Qwen3's reasoning cost 150 to 300 tokens a turn at 5 tokens/s; Codex effort `none` maps to LM Studio's reasoning-off and took a warm turn from 30 to 50 s to 8 s, so local low effort means that. Local chats get the build's 300 s. Between the last two measurements the 5 GB model file vanished from `C:\LLMs` while LM Studio's index still listed it: a second Claude Code session was clearing disk space and deleted it as it downloaded (Wes, later). The file was fetched again from Hugging Face into the path the index expects.

0.17.0 shipped: release commit e75254b on main and screen-on, test fix b80ccba after it; CI run 34045137424 passed on Windows and Linux. Release v0.17.0 is public with `Sidelook-0.17.0-Windows-x64.exe` (172,372,480 bytes) and its checksum; the anonymous download hash matched the build. Production deployment dpl_2cLNtjMK6xHxGhYTHqPgCqxTkLYm passed the site check; the parent products page was updated. Owed: the desktop hand checks in the release memory, the README screenshots, and one real local-model build in the studio (chat and compaction ran, a build did not).

Retro: the proof was run against a toy instruction, and it passed for a reason the real prompt did not share. The one change: a transport proof uses the product's own captured system prompt, schema and stdin (the Assistant's `generate` monkeypatched to write them), never a stand-in, before the transport is called proven. Second: every timing claim about a local model names the card, the context, the offload share and whether the prefix cache was warm, because each one moved the answer by 3x or more.
