# Public-site runbook

Production: https://sidelook.practicalsystems.io/
Repository: https://github.com/ucsandman/sidelook

The public site is a static walkthrough and Windows download page. It doesn't run inference, take a subscription login, capture a camera or screen, or host the local API. Real builds happen in the downloaded app.

## Release procedure

1. Verify tests, browser behavior and the final Windows executable. Publish the versioned GitHub release and checksum.
2. Update the pinned download and release links in the README and site. Keep the desktop-runtime, model, streaming, credit and signing disclosures accurate.
3. Run `node scripts/build-site.mjs`, `node scripts/verify-site.mjs` and `node scripts/verify-states.mjs` (every control under the mouse, every text node, every token, across the app and the built site). If any interface on the page or in the README changed, refresh the captures first. `npm run build:captures` drives the real studio with the recorded fixture and writes the three walkthrough panes (`docs/images/share.png`, `direct.png`, `versions.png`); the browser verifiers write the other three at the published sizes, so `.artifacts/stream-desktop.png`, `.artifacts/companion-desktop.png` and `.artifacts/computer-desktop.png` (from `verify-stream`, `verify-companion` and `verify-computer`) copy over `docs/images/streaming.png`, `companion.png` and `computer.png`. Then `node scripts/build-social.mjs` rebuilds `docs/images/social.png` from the new panel and the current version. A capture that changes size takes its `width` and `height` attributes with it in `site/index.html`; verify-site compares the two and fails when they disagree. `docs/images/screen-on.png` is a real desktop composite and has to be retaken by hand.
4. Inspect `vercel deploy --dry --json --cwd .artifacts/site --scope ucsandmans-projects`. It must contain only allowlisted public files, including the verified `companion.png` capture, and no environment or configuration data.
5. Add the domain to the Vercel project and the CNAME at the parent's DNS (hard stop: confirm with the maintainer). Only then deploy, because `vercel.json` redirects the old host to the new one.
6. Deploy the approved release with `vercel deploy --prod --yes --cwd .artifacts/site --scope ucsandmans-projects`.
7. Run `node scripts/verify-site.mjs https://sidelook.practicalsystems.io`. Confirm the anonymous executable download hash, metadata, website link and GitHub About text.

Never deploy the repository root. The build output is `.artifacts/site`. Generated environment files are excluded and must never be read, staged or uploaded. Roll back with Vercel's deployment promotion controls. A public-site rollback doesn't touch local apps.

## Public surface

- One indexable page with title, description, canonical URL, Open Graph image, robots.txt, sitemap.xml and llms.txt.
- Keep the Google and Bing ownership tags. Ownership and sitemap submission were done at launch. Indexing is up to the search providers. Manual Google indexing was quota-limited last time.
- Standard Vercel Web Analytics on the existing hosting plan. No Plus add-on or new billing for ordinary releases.
- No hosted task-board sample. Its old route returns 404. The site explains the real reference, prompt, result and revision workflow instead.
- No DNS changes, social posts or outreach as part of a code release.

## Current product copy

The native desktop companion is the entry point. It uses its own persistent WebView2 profile, keeps a bounded in-session conversation, and opens the builder or Computer mode only through explicit user controls. Revisions from a source-development browser profile or an older browser-based install aren't imported automatically. Settings, then Import a saved HTML prototype, brings in exported HTML up to 120,000 bytes and adds a version only when the 12-slot history has room. Screen and window sharing, camera and upload stay available in the workbench. A requested companion screenshot shows the exact frame used. It doesn't monitor the screen or listen continuously. Live build sends consented snapshots after a pause, with minimum intervals and a ten-request cap. Fable can show incremental HTML drafts and can spend paid Claude usage credits. Astra's isolated Codex exec path releases finished messages. Draft scripts stay off until final validation. Source is MIT licensed. Upstream runtimes keep their own terms. The outer Windows executable is unsigned.

The page has no per-section eyebrow labels, no numbered section scaffolding outside real step sequences, no side-stripe accents and no arrow glyphs in copy. The mark is the lens from `public/mark.svg`. Keep it that way; see DESIGN.md.

## Verification

The site suite checks the companion and all four walkthrough steps on desktop and mobile, arrow, Home and End navigation, the draft replay disclosure, public assets, removed and private routes, the download link, overflow and page errors. It also has to verify the companion's capture, subscription, profile-migration and Computer-mode boundary disclosures. Public release evidence is appended below. Detailed historical investigations live in [PLAYBOOK.md](../PLAYBOOK.md).

## 0.8 Desktop companion surface audit

The public page leads with the native companion, Ctrl+Shift+Space summon shortcut, explicit current-window screenshot, optional local voice features, bounded conversation, WebView2 requirement, and the separate WebView profile. It keeps the established builder walkthrough lower on the page. The companion does not claim ambient listening, screen monitoring, automatic revision import, model fallback, or action permission changes. The Computer guide remains explicit that the user opens its workflow and approves each action.

The verified `docs/images/companion.png` capture appears in the hero and is a required allowlisted public asset. Its caption identifies it as a captured idle local interface, not a live conversation or desktop-control surface, and states that screen and microphone are off until the user chooses a feature and consents.

### 0.6.0 publication

Published source 45e139d and GitHub release v0.6.0. CI run 33980839433 passed on Windows and Linux. Vercel deployment dpl_9DBCD1x4HN27ZX2TbyNRu8Sv47Tk is ready on the production alias; all 24 public browser checks passed. The anonymous Windows download matched its published SHA-256 and 171,309,056-byte size. GitHub reports MIT and the correct homepage. The local desktop launcher was restarted and serves the new draft UI.

### Marketing refresh after 0.6.0

The hero now shows the current Fable draft interface and leads with screen sharing and the Windows download. Model/effort choice, bounded Live build, incremental drafts, and version controls are visible before the earlier prepared walkthrough. Metadata and the social preview use the current product. The walkthrough keeps its historical captures and is labeled accordingly. The deployment allowlist now includes streaming.png, for 13 public files.

### Complete capability and walkthrough alignment

The walkthrough now covers window sharing, model and effort selection, single or automatic builds, Fable drafts, and refinement/export. Removed Daylight images are no longer deployed. The FAQ covers voice and all image inputs, preview sizes, source/download, saved versions and runtime reset, sample/setup recovery, allowance versus subscription limits, and frontend-only boundaries. The public site remains an instructional guide, not a hosted generator.

Capability audit against public/index.html, public/app.js and the shipped model/launch implementation: | Product surface | Marketing location |
| --- | --- |
| Screen/window capture, explicit selected frame, exact sent-frame evidence | Hero, feature rows, walkthrough Share, privacy FAQ |
| Camera selection, JPEG/PNG/WebP upload, text-only input | Share panel and input FAQ |
| Local Windows dictation, local spoken replies | Choose panel and input FAQ |
| Astra/Fable, five effort levels, low-effort shortcut | Feature rows, Choose panel, download steps, speed FAQ |
| CLI install, sign-in, recheck/cancel, no-login local sample | Download steps and setup/sample FAQ |
| Live build quiet time, interval choices, ten-build cap | Share/Refine panels and download steps |
| Pause/cancel, stop capture, no restart on reload | Refine panel and privacy FAQ |
| Animated status, elapsed time, Fable draft/code, last working version | Watch panel |
| Astra completed-message limitation and draft script restriction | Features, Watch panel, speed FAQ |
| Desktop/mobile/expanded preview, source, HTML export | Refine panel and output FAQ |
| Twelve local versions, restore, reference images, confirmed reset | Refine panel and output FAQ |
| Runtime-data reset, same-origin browser storage, retry preview | Output FAQ |
| Local counter versus provider allowance, credits, no fallback | Setup/sample FAQ, download and privacy |
| Frontend-only output, no desktop control/backend/deployment | Scope FAQ |
| Windows launcher, shortcuts, tray quit, unsigned download, MIT | Download section and footer |

Verification: rendered all four current panels at desktop and mobile widths, exercised keyboard navigation, and confirmed all seven obsolete/private routes return 404. The marketing deployment contains ten allowlisted files. Existing application tests and CI remain the product behavior checks.

## 0.7 Computer mode surface audit

The hero now shows an actual Fable proposal from the native Windows verification app. The Computer mode guide covers local permission, selected-window inspection, fresh-text sharing, model/effort, review, single-use approvals, expiry and global Stop. The four-step prototype walkthrough remains distinct and functional. Both modes appear in features, FAQ, README, privacy/security docs and GitHub About. Download links point to 0.7.0.

The static deployment contains 11 allowlisted files, including computer.png. Native code, local routes, logs, controller state and account data are excluded. The guide explicitly limits accessible-control automation and does not claim unrestricted desktop, canvas or shell access. The updated verifier covers both guides at desktop/mobile widths, 7 public assets and 7 forbidden/removed routes.

### Published 0.7.0 verification

Released v0.7.0 from code commit 25e1105. Windows and Linux CI run 33984559654 passed. Vercel production deployment dpl_2kkFMN7pPsEwwUHXGbL5Dfoi2kns is READY at the canonical website. The production browser check passed both guides, mobile layout, public assets, blocked routes and the pinned download. GitHub About, homepage and desktop topics were verified after updating. Existing search-verification tags, sitemap and Vercel analytics were preserved.

The anonymous executable download was 171,325,440 bytes and matched SHA-256 bef0b66ee2b0f7d272191fc40dbe9995620ebb2fb48ac1451e8872ad5e3d0404. The final archive has 46 entries; all 23 first-party payload files match the shipped source, and 33 text files were scanned. Verification passed: 40 unit tests, 19 compiled filter cases, 14 native cases, 11 Computer UI checks, 20 packaged checks, 6 launcher lifecycle cases, plus user-app survival after Quit. Real Fable/browser/native execution completed three model steps and two reviewed actions; the final repeat took about 33 seconds.

The installed app was not reopened after release: automatic approval review rejected that separate local launch with only a blocked-by-policy reason. Public download and production site verification completed successfully.

## 0.15.1 Buttons that stay under the mouse release

Release v0.15.1 from commit d718240 is public with `Jarvis-0.15.1-Windows-x64.exe` (172,353,536 bytes) and `SHA256SUMS.txt`. The anonymous download matched SHA-256 6f53e385eda83c14d44cb02470dec0c30f55bdc31b5ee872db739e8f6141e4f6. CI run 34027145525 passed on Windows and Linux. Production deployment dpl_5FSgapsoXZHYyWDUeq82G3pUB3YQ is Ready at the canonical URL with 12 allowlisted files; the production browser check passed and the live page carries the 0.15.1 download with no other version string on it. Local verification before the push, all synthetic: 63 unit tests; check.mjs over 52 files; the new states verifier (73 controls at rest and under the mouse, 201 text nodes, 12 tokens, across the panel, its dialogs, Computer mode, the studio, its dialogs and the built site; proven by putting the 0.15.0 token back, seven vanishing buttons reported); companion 23 checks; the packaged executable's 20 assertions. The desktop hand checks owed since 0.15.0 are still owed.

## 0.15.0 The panel, quiet release

Release v0.15.0 from commit 406b972 is public with `Jarvis-0.15.0-Windows-x64.exe` (172,353,536 bytes) and `SHA256SUMS.txt`. The anonymous download matched SHA-256 934fc203eac45b3199785308e16462931b99ee275c2c80e84e9e6668e2dcce60. CI run 34026458718 passed on Windows and Linux. Production deployment dpl_J6Q86ikKM4CpgiynVz791h9BwSxP is Ready at the canonical URL with 12 allowlisted files; the production browser check passed and the live page carries the 0.15.0 download, the new panel copy ("tile at the top", the arrow-only Send) and the graphite-and-mint tokens. The hero screenshot is the browser check's 440×380 content-sized panel (captioned as such, not as a packaged-app capture); the studio and Computer mode screenshots and the social image were regenerated in the new palette. Local verification before the push, all synthetic: 63 unit tests; check.mjs over 51 files; assistant 7 requests; companion 23 checks; computer 14; recovery 10; browser 9; live 24; models 13; stream 14; the packaged executable's 20 assertions. Not run, since the desktop was in use: the desktop-host check (now asserting a borderless content-sized panel), the desktop-content check, and a dock drag on a real desktop.

## 0.14.0 Read it back release

Release v0.14.0 from commit 2e32990 is public with `Jarvis-0.14.0-Windows-x64.exe` (172,345,344 bytes) and `SHA256SUMS.txt`. The anonymous download matched SHA-256 9e3be9a03b07f33c858533ffd48a44e90cd0ca15d835bd7e23c8d1d647a4ff7c. CI run 34023303339 passed on Windows and Linux. Production deployment dpl_J6ahAc3yoL92yvCmncfSEfARwm3V is Ready at the canonical URL with 12 allowlisted files (the dry inspection ignored `.env.local`, `.gitignore` and `.vercel`); the production browser check passed and the live page carries the 0.14.0 download and the new studio copy ("Use this frame", the chip, "Build with frame"). The walkthrough's studio screenshot and the Computer mode screenshot were regenerated from this release's synthetic checks. Local verification before the push, all synthetic: 63 unit tests; check.mjs over 51 files; assistant 7 requests; companion 22 checks; computer 14; recovery 10; browser 9; live 24; models 13; stream 14; the packaged executable's 20 assertions. The desktop-host hand check was not run this release, since the desktop was in use.

## 0.13.0 Screen on release

Release v0.13.0 from commit 52dd1d9 is public with `Jarvis-0.13.0-Windows-x64.exe` (172,340,736 bytes) and `SHA256SUMS.txt`. The anonymous download matched SHA-256 cb9796e22df58cd0df9f7d5e55227386aa25e852133a62f1e012fb3b9238cd6a. CI run 34019747343 passed. Production deployment dpl_DvkhWHrCeRuEX1BRYiGq9uBKx1sK is Ready at the canonical URL with 12 allowlisted files; the production browser check passed and the live page carries the 0.13.0 download. Local verification before the push: 53 unit tests, lint, companion, desktop-host (including the Screen on lease, hotkey, border and expiry), computer-lifecycle and windows-lifecycle. Defender's cloud heuristic had flagged the 0.12.0 download as `Trojan:Win32/Sabsik.TE.A!ml`; the 0.13.0 executable scans clean locally. A false-positive submission to Microsoft is the maintainer's next step, and code signing is the fix.

## 0.8.1 Identity and copy release

Release v0.8.1 from commit 0395477 is public with `Jarvis-0.8.1-Windows-x64.exe` (172,306,432 bytes) and `SHA256SUMS.txt`. The anonymous download matched SHA-256 35f62bf93f3a83f088511678744b989030b85fb27e2819fb6a50896ff72231e8. CI run 33990408097 passed on Windows and Linux. Production deployment dpl_PxwVirH4Ja6baaCGQGfEczp1uaom is Ready at the canonical URL with 12 allowlisted files; the production browser check passed, the live page carries the 0.8.1 download and no eyebrow labels, and llms.txt serves the rewritten summary. Local verification before the push: 40 unit tests, lint, verify:site, companion, stream, recovery, computer, assistant, desktop-host, desktop-content and verify:windows (20 assertions). The rebuilt app was relaunched locally on the released executable.

## 0.8 Desktop companion release

The live hero, companion screenshot, social image, download, FAQ and metadata now describe the desktop companion. The prototype walkthrough and Computer guide remain available. The deployment contains 12 public files; existing search-verification tags, sitemap and analytics are preserved.

Release v0.8.0 and production deployment dpl_EPmdoe1LvMPevhjixhCihQpsVKwj are public. Windows/Linux CI run 33987872053 passed. Production browser verification passed desktop/mobile walkthroughs, keyboard controls, assets, blocked routes and the pinned download with no overflow or browser errors. The anonymous Windows download matched its published SHA-256 and 172,186,624-byte size. The new desktop app was reopened locally.

## 0.18.0 Bench, the welded studio, and an agent that heals itself

Release v0.18.0 is public from commit fdf4315 with `Sidelook-0.18.0-Windows-x64.exe` (172,491,776 bytes) and `SHA256SUMS.txt`. The executable was rebuilt from the committed tree after the version strings moved, and `gh release download` returned bytes hashing to ea7e7d73496697bb50e650035178f667910c3e889ea79c348c9568f3185c7949, the build's own hash. `verify:windows` passed on it (20 assertions). The three published captures and the social card were regenerated from the verifiers for the new interface, and the site and README moved to v0.18.0 (13 references). `node scripts/verify-site.mjs` passes locally on everything except the new anonymous-reachability assertion.

The repository was made public again (it had been private since some point after 0.17.0, which is why the live 0.17.0 download had been answering 404 to every visitor while working from the maintainer's machine). Anonymous verification then passed end to end: the signed-out download returned 172,491,776 bytes hashing to ea7e7d73...c7949, and `SHA256SUMS.txt` and the release page both answer 200. Production deployment dpl_3PhuLUNGx1Me5yUEyGmaqNff5qM2 is live; the dry run listed exactly 14 allowlisted public files, no environment file and no `.vercel` directory. `node scripts/verify-site.mjs https://sidelook.practicalsystems.io` passes against the live host, including the new anonymous-reachability assertion on the pinned download, and the four served images (streaming, companion, computer, og) hash to the files in `docs/images`, so no stale capture survived in the CDN.

## After 0.18.0: the walkthrough shows the studio

The four walkthrough steps carry captures of the real panes (`share.png`, `direct.png`, `streaming.png`, `versions.png`), the first three written by `npm run build:captures` against the running studio with the recorded fixture, at `deviceScaleFactor` 2 because `.current-capture img` caps a capture at 660 CSS pixels tall and scales it to the 682-pixel column. A capture taller than about 1.03:1 is letterboxed by that cap, so the stage shot is taken in a 1440x760 window. The deployment allowlist is 17 public files (the dry run lists them and no environment file). verify-site now asserts each step's image, its decode and its declared size.

## 0.17.0 Local models, the Bench button, three words under the conversation

Release v0.17.0 from commit e75254b is public with `Sidelook-0.17.0-Windows-x64.exe` (172,372,480 bytes) and `SHA256SUMS.txt`; the anonymous download matched SHA-256 0d1b13c193462d161170736e4c547c06ebb6f8901bbbbc2b0d0ac0c965e2fe18. The verified exe was built from e75254b; b80ccba on main after it only makes the LM Studio loader's `lms` path injectable for the tests (CI run 34044924819 failed on both runners for that, 34045137424 passed) and changes no runtime behaviour, so the tag stays on e75254b. Production deployment dpl_2cLNtjMK6xHxGhYTHqPgCqxTkLYm passed the site check against https://sidelook.practicalsystems.io with the 0.17.0 download link, the local-model sentences (four on the page) and the Bench step. The parent products page at practicalsystems.io names local models too (ce33a8af in that repo). The four README screenshots are still the graphite palette; they wait for a free desktop. (Superseded 2026-09-11: streaming.png, companion.png, computer.png and the social card are the current interface; screen-on.png alone still waits.)

## 0.16.0 Sidelook release

Production moved to https://sidelook.practicalsystems.io: an A record `sidelook -> 76.76.21.21` was added at Namecheap with every one of the parent's 18 existing records and its MX email type re-sent unchanged (read back and diffed: nothing lost, one record added), the domain was attached to the Vercel project (kept as `jarvis-workbench` so the old `jarvis-workbench.vercel.app` host still exists and now 308-redirects to the new address), then deployment dpl (jarvis-workbench-eoa4hyrcj) went to production. `node scripts/verify-site.mjs https://sidelook.practicalsystems.io` passed on the live host: the walkthrough, the self-hosted wordmark face, 8 public assets, the pinned download, no overflow. The GitHub repository was renamed to `ucsandman/sidelook` (old URL redirects) and release v0.16.0 carries `Sidelook-0.16.0-Windows-x64.exe` (172,362,240 bytes) and `SHA256SUMS.txt`; the anonymous download's SHA-256 matched the build. The Vercel Web Analytics tag is on the page from this release; enabling Analytics on the project is a dashboard step. Search Console and Bing properties for the new host are owed (the verification meta tags are already on the page).

