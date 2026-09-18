# SignPath Foundation application (draft)

Status: **draft, not submitted.** Written to close the open question in
`docs/DECISIONS.md` (2026-09-14: "Sign the Windows build, and which
certificate") and to give Wes something he can submit in five minutes rather
than something he has to compose from scratch. Nothing in this file has been
sent anywhere.

A note on how this was researched: this session's network access blocks
direct fetches of `signpath.org` and most third-party sites (only GitHub and
search-engine results were reachable). Everything below about the live
application page is corroborated through SignPath's own terms text (quoted
by search results) and several independent projects' public write-ups of
going through the same process (BrowserPicker, amd/gaia, DB Browser for
SQLite, SysManage), not a direct read of today's page. **Before submitting,
open the URL below yourself once** to confirm the form and address are still
what's described here — cheap insurance, since the process itself hasn't
been observed to change in years.

## 1. Where to apply

- Start here: **https://signpath.org/apply.html** ("Apply for a free
  SignPath.io subscription").
- The page links an Excel request form (referenced elsewhere as
  `OSSRequestForm-v4.xlsx`, served from `signpath.org/assets/`). You fill it
  in and email it back per the instructions on that page — the destination
  address should be read off the live page rather than guessed here.
- Reported turnaround from other projects that went through this: **about a
  week** to a decision.
- Read `https://signpath.org/terms.html` once before sending; it's short and
  it's the actual contract, not just the summary below.

## 2. Eligibility conditions, and how Sidelook meets each one

SignPath Foundation's stated conditions (per its terms page):

| Condition | Sidelook |
| --- | --- |
| No malware or potentially unwanted behavior | Nothing in Sidelook does anything covertly; every capture, send and write is user-initiated and documented (`README.md`, `docs/COMPUTER.md`, `SECURITY.md`). |
| OSI-approved open-source license, no commercial dual-licensing | MIT (`LICENSE`), single license, no dual-licensing anywhere. |
| Public repository | `https://github.com/ucsandman/sidelook` — confirmed public via the GitHub API today (`"private": false, "visibility": "public"`). It was briefly private around 2026-09-05/06 during early development (see `docs/ERRORS.md`, 2026-09-11 entry, where that caused the site's download link to 404 for anonymous visitors); that was fixed before the 0.18.0 release and has stayed public since. |
| Actively maintained | Releases roughly every few days through September 2026 (0.14.0 → 0.18.1 in the CHANGELOG, most recent push 2026-09-14); `docs/DECISIONS.md` and `docs/ERRORS.md` are updated the same day issues are found. |
| Already released in the form to be signed | Yes. `Sidelook-0.18.0-Windows-x64.exe` is live on the GitHub Releases page and is the same self-extracting launcher shape `scripts/build-windows.ps1` would hand to SignPath for signing. |
| Documented functionality on the download page | The GitHub Releases page and `README.md` both describe what the app does before the download link. |
| No proprietary, non-open-source component (the maintainer's own or an affiliate's, especially) | See section 3 — the one candidate (the bundled WebView2 loader) is a Microsoft system-interop stub, not proprietary product code, and every other bundled dependency is itself OSI-licensed (below). |

## 3. The open question: does the bundled WebView2 redistributable disqualify Sidelook?

**Short answer: no.** The condition, and the "System Libraries" exception
SignPath's terms explicitly point to (GPLv3 §1's definition), both cut in
Sidelook's favor here.

**What's actually bundled.** `scripts/build-windows.ps1` does not embed the
WebView2 browser engine. It embeds one native DLL —
`WebView2Loader.dll` — pulled from Microsoft's official
`Microsoft.Web.WebView2` NuGet package (hash-pinned in the build script).
That DLL's only job is to locate and bind to the WebView2 Runtime already
installed on the machine; it contains no rendering or browser code itself.
The Runtime — the actual Chromium/Edge-derived engine — is never bundled:
the README says plainly that "Sidelook checks on launch and tells you where
to get it if it's missing," i.e. the user's Windows install (or a separate
Microsoft installer) supplies it, not the exe SignPath would sign.

**Why that fits the exception, not the condition.** SignPath's terms allow
"System Libraries" in a signed package and point to GPLv3 §1 for the
definition: something that (a) is included in the normal way of packaging a
"Major Component" — a major essential part of the operating system, like the
window system — without being part of that component itself, and (b) serves
only to enable use of the work with that component. `WebView2Loader.dll` is
exactly this on both counts:

- (a) It's the standard, Microsoft-sanctioned redistributable for locating
  the WebView2 Runtime, which Microsoft ships pre-installed as part of
  Windows 11 and as a serviced, OS-level component on other supported
  Windows versions — a "window system"-class Major Component if there ever
  was one.
- (b) The loader does nothing except find and hand off to that runtime. It
  has no independent function.

The condition's own parenthetical — "especially code published by a
maintainer or an affiliated person/organization" — is aimed at a maintainer
smuggling in their own closed product, which this plainly is not: it's a
one-file Microsoft interop shim, not Sidelook's or Practical Systems' code.

**The other bundled pieces, for completeness** (none are proprietary):
Node.js (OpenJS Foundation, MIT), the Codex CLI (`openai/codex`, open
source), and the DashClaw SDK (`node_modules/dashclaw`, published to npm
under MIT per `package-lock.json`). All three ship as officially published,
Authenticode-signed binaries or npm packages under OSI-approved licenses —
`build-windows.ps1` even verifies the Authenticode signature and publisher
of `node.exe` and `codex.exe` before packaging them.

**Net:** nothing in the signed artifact is proprietary product code. The
WebView2 loader is the one component worth calling out proactively in the
application (better to explain it than let a reviewer wonder), and the
honest, well-supported answer is that it's a system-interop stub covered by
the same exception SignPath already carves out for exactly this situation.

## 4. Draft answers for the application form

Fill these into the SignPath OSS request form (the exact field labels
weren't recoverable from outside the live page/spreadsheet, so this is
organized by topic rather than by field name — copy the relevant line into
whichever field asks for it):

- **Project name:** Sidelook
- **Homepage:** https://sidelook.practicalsystems.io
- **Source repository:** https://github.com/ucsandman/sidelook (public)
- **License:** MIT (`LICENSE`), OSI-approved, no dual-licensing
- **Maintainer:** Wes Sander, Practical Systems (wes@practicalsystems.io —
  confirm this is the address you want on file before sending)
- **What the project does:** A Windows desktop companion app. It sits in a
  small always-available panel: summon it over any window, ask about what's
  on screen, and it answers grounded in a screenshot or the window's
  accessible text. From the same app, a "studio" turns a sketch or a shared
  design window into a working HTML prototype; "Computer mode" drives one
  Windows app's accessible controls one user-approved click at a time; and
  "Agent mode" carries out a stated business outcome (e.g. "refund this
  payment and email confirmation") across Slack, Stripe, HubSpot and Gmail,
  with every write gated by a policy-approval layer (DashClaw) and verified
  by a second read afterward. It runs on the user's own ChatGPT or Claude
  subscription (via the official Codex or Claude Code CLIs) or on a fully
  local model through LM Studio or Ollama — no API key, nothing metered by
  Sidelook itself.
- **Actively maintained:** Yes — see the release cadence in section 2.
  `docs/DECISIONS.md` and `docs/ERRORS.md` are the running engineering
  record, updated same-day.
- **Already released in the form to be signed:** Yes,
  `Sidelook-0.18.0-Windows-x64.exe` (GitHub Releases,
  https://github.com/ucsandman/sidelook/releases/tag/v0.18.0).
- **What artifact needs signing:** One Windows executable per release,
  `Sidelook-<version>-Windows-x64.exe` — a self-extracting, C#-compiled
  (`csc.exe`) WinForms launcher, currently about 164 MiB. It's a native
  Authenticode target, not an MSI/MSIX.
- **How it's built:** `scripts/build-windows.ps1`, run today by the
  maintainer on a Windows machine (not yet wired into GitHub Actions CI,
  which currently runs tests/lint/build on push but not the release build).
  The script downloads and hash-verifies Node.js and the WebView2 SDK
  NuGet package, installs a pinned, integrity-checked build of the Codex
  CLI, checks the Authenticode signature and publisher of every bundled
  executable, zips the app payload, and compiles the launcher with the
  payload embedded as a resource, emitting a `SHA256SUMS.txt` alongside it.
  This is the point where a SignPath signing step would slot in, either as
  a manual submission from that same machine (SignPath's PowerShell module)
  or by moving the release build into GitHub Actions later.
- **Bundled third-party components and their licenses:** Node.js runtime
  (OpenJS Foundation, MIT), Codex CLI (`openai/codex`, open source),
  DashClaw SDK (npm `dashclaw`, MIT), and the WebView2 loader DLL from
  Microsoft's `Microsoft.Web.WebView2` NuGet package — addressed in section
  3 as a System Library, not a proprietary component.
- **Why signing matters for this project, if asked:** Two consecutive
  unsigned builds were flagged by Windows Defender's cloud ML as two
  different malware families and deleted on download (`docs/ERRORS.md`,
  2026-09-14); a consistent signed publisher identity is what lets
  reputation accumulate release over release instead of resetting on every
  new hash.

## 5. Anything that would disqualify Sidelook

Nothing found. To spell out what was checked and ruled out:

- **Repository visibility:** was briefly private in early development,
  which broke the public download link (`docs/ERRORS.md`, 2026-09-11); it's
  been public since before the 0.18.0 release and is public now (verified
  live, not from notes).
- **License:** single MIT license, OSI-approved, no dual-licensing terms
  anywhere in the repo.
- **Proprietary components:** the one candidate (WebView2's loader DLL) is
  a Microsoft system-interop stub covered by SignPath's own System Library
  exception (section 3); every other bundled dependency is independently
  OSI-licensed.
- **"Already released in the form to be signed":** met — 0.18.0 is the live
  download today.
- **Malware/PUP behavior:** nothing covert; every sensor, capture and write
  path is documented and user-gated (`SECURITY.md`, `docs/COMPUTER.md`).

The one thing not fully in Sidelook's control: SignPath Foundation reviews
applications by hand and can still decline for reasons outside these
published conditions. If it's refused, `docs/DECISIONS.md` already names
the fallback — Azure Artifact Signing, about $9.99/month, no application
required, and it signs from CI rather than needing a person at a USB token.

## 6. Turnaround

Other projects that applied report a decision in about a week. Given the
next real-code release has no Defender fallback (`docs/DECISIONS.md`,
2026-09-14), it's worth Wes sending this the same day he reviews it rather
than letting it sit.
