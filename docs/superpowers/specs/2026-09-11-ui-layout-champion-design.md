# UI and layout champion design (2026-09-11)

Status: approved for build on 2026-09-11 (Wes asked for a tournament, then the champion built, then impeccable, polish and de-vibe passes, in one request). Ultracode workflow wf_197c7a8f-68a: 8 designers, 5 judges, 2 semifinals, 1 final, 1 synthesizer, 3 skeptics; 28 agents.

## Tournament record

| Seed | Concept | Lens | Judges avg /50 | Fatal votes | Build cost |
|---|---|---|---|---|---|
| 1 | D4 Sill | Evidence and trust designer | 42.8 | 0 | S |
| 2 | D1 Hairline | Apple Human Interface craftsman | 40.2 | 0 | M |
| 3 | D8 Bench | Pro-tool workbench designer | 39.4 | 0 | M |
| 4 | D7 Earned Ink | Progressive-disclosure minimalist | 38.4 | 0 | M |
| 5 | D2 The Shelf — one shelf, four places | Information architect | 38.2 | 0 | M |
| 6 | D3 One Thread | Conversation-first unifier | 36.2 | 0 | M |
| 7 | D5 Only One Box | Editorial instrument designer | 36.2 | 0 | S |
| 8 | D6 The Spine | Keyboard and accessibility lead | 34.4 | 0 | M |

Bracket: D4 beat D7 (3-0); D8 beat D1 (0-3); final D8 beat D4 (2-3).

Champion: **D8 Bench** (the studio as welded panes; radius means float). Runner-up **D4 Sill** (the decision never scrolls) is grafted in as the pinned decision card in Computer and Agent mode. The judges asked for 66 grafts; Appendix A says which were absorbed and which refused, with the reason.

Concept theses, for the record:

- **D1 Hairline** (Apple Human Interface craftsman): Every Sidelook surface is the same instrument: a 44px header of constant chrome, one scrolling canvas, and a fixed shelf that holds the primary action and the one line of consent that belongs to it. Inside the canvas, sections are separated by 1px rules and nothing is boxed except the single thing a person must decide right now, so the approval card is the only card on screen and reads as one. Everything else is discipline: a 12/15/19/24 type ladder with the 13px tier deleted, an 8pt grid, three control heights, four radii, and three state colors.
- **D2 The Shelf — one shelf, four places** (Information architect): Sidelook has four places (Chat, Computer, Agent, Studio) and today three of them are invisible until you open a modal gear dialog and read a sentence under "Do more". This concept puts a 28px shelf directly under the panel header that lists all four places on every screen, marks where you are, and carries each absent place's live state ("Computer · 9:42", "Agent · running"), so entering and leaving a mode is one press from anywhere and no armed lease or live run can ever be out of sight. Back navigation is abolished as a concept: you do not go back, you go somewhere, and the shelf is the only navigation control in the product.
- **D3 One Thread** (Conversation-first unifier): Sidelook already has one good idea for showing work — the Agent timeline: a glyph, an app tag, a plain sentence, and evidence behind a Details button. It is used on exactly one screen out of four. One Thread promotes that row to the app's only way of reporting anything, makes the conversation the index that every run is entered into, and gives Computer mode and Agent mode the same shape as the panel: a scroll of rows, a decision at the bottom edge where the send button lives, and one Stop. What changes: the two pinned setup forms that today push live proposals below the fold disappear into a composer-shaped bar, the panel stops offering a "New chat" button when there is no chat, and Computer mode and Agent mode stop hiding inside Settings.
- **D4 Sill** (Evidence and trust designer): The decision never scrolls; the evidence always does. Today Sidelook's two riskiest moments — approving a Windows action and approving a DashClaw write — put Approve and Reject at the bottom of a scrolling column, below the fold (see .artifacts/agent-approval.png: Risk 60 is cut off and the buttons are not on screen at all). Sill gives every consent surface one pinned strip at the bottom of its own screen that carries the sentence you are agreeing to, the live countdown and the buttons, while the evidence scrolls underneath it — and it makes the accent border mean exactly one thing everywhere: a person must decide here, now.
- **D5 Only One Box** (Editorial instrument designer): Sidelook already speaks in rules, but it keeps drawing boxes: Computer mode is four stacked cards, Agent mode boxes its summary the same way it boxes an approval, and twelve different greys pretend to be twelve different kinds of edge. This concept makes enclosure mean exactly one thing — a person must decide, now — and gives everything else the 1px rule. After the change there is never more than one box on any screen, and it is always the thing you must answer; the rest of the app is a ruled ledger with aligned figures and monospaced readings, which is what an instrument looks like.
- **D6 The Spine** (Keyboard and accessibility lead): Sidelook is summoned by keyboard, so the keyboard is the layout. Every surface is rebuilt on one three-band spine — a 44px head that never scrolls and carries state, one scroll region for work, and a pinned act band that carries every judgment call and Stop — so the Tab order is identical in chat, Computer mode and Agent mode and a decision can never scroll out of reach. A keyboard layer (F6 between bands, Alt accelerators, a keys line) appears only once a key is pressed, so mouse users see today's panel unchanged and keyboard users get a complete instrument.
- **D7 Earned Ink** (Progressive-disclosure minimalist): Sidelook already knows the rule in two places: the running line replaces the goes line while something runs, and the slim tile replaces the tile once a conversation exists. Earned Ink makes that the law of the whole app — a control appears when its object exists, collapses to one line when its decision is made, and is never on screen announcing a future. Nothing new is invented; what is added is the discipline that the empty panel is 12 controls instead of 16, the studio rail is three zones instead of five, and the only accent-bordered thing on any screen is the thing waiting for a person.
- **D8 Bench** (Pro-tool workbench designer): The studio is currently a page with two scrolling columns; every other surface in Sidelook is a fixed frame (head, body, foot). Bench makes the studio obey the same law as the panel: three welded regions that never scroll as a document — Direction, Stage, Versions — with the reference and the reading stacked as a second pane under Direction. One consequence carries the whole concept: radius means "this floats". The panel, its bubbles and its box keep their radii because they hover over someone else's window; the studio's panes get 0px radius and 1px seams because they are welded to each other, and the only rounded thing in the studio is the artifact itself.

The skeptic pass ran against a truncated copy of the spec (the synthesizer answer was split across two messages); its citation corrections are folded into Appendix B below, and every other finding was answered by text already present in sections 3 and 4.

---
# Sidelook UI build spec: Bench, with the decision pinned

Champion D8 (Bench) with the consent surfaces from runner-up D4 (Sill) grafted in. Every change below was checked against `public/index.html`, the three stylesheets, `public/app.js`, `public/companion.js`, `public/computer.js`, `public/agent.js`, `public/harness.js` and every `scripts/verify-*.mjs` at HEAD `d239990`. Grafts absorbed and refused are in Appendix A; champion items corrected against the code are in Appendix B.

## 1. Thesis

The studio becomes a fixed instrument, like every other Sidelook surface: three welded regions (toolbar 48px, panes, versions deck 64px) with 1px seams that run edge to edge and never scroll as a document, and one law a stranger can restate: radius means "this floats" (the panel, its bubbles, its box, every dialog, the expanded stage), 0px means "this is welded" (panes, seams, deck, starters, rule-separated steps), and the only rounded thing inside the studio is the artifact. Every control that feeds a reference moves beside the viewfinder it affects, which leaves exactly one teal fill per screen. Where money or a click in someone else's app is at stake (Computer mode, Agent mode), the decision never scrolls: the sentence being agreed to and the Approve row pin to the edges of the scrolling body while the evidence moves between them, focus never moves onto Approve, and a new bounding-box assertion in each verifier proves it (observed failing at HEAD first).

## 2. Navigation model

Decision: unchanged in structure. Two surfaces switched by `body[data-surface]`: the panel alone, or the studio with the panel as its right column; below 1180px the column steps aside and `#chat-toggle` slides it over the stage (Escape, `← Panel` or widening closes it). Computer mode and Agent mode stay screens inside `#companion`, entered from Settings (`#computer-open`, `#agent-open`) or the contextual `Open` buttons on the goes line (`#companion-computer`, `#companion-agent`), left by `‹ Back` (lease kept) or Stop (lease ended). Settings, the send preview and the three lease dialogs stay dialogs.

What changes is where controls live:

| Control | Today | Bench |
|---|---|---|
| `#share-screen` | toolbar, teal fill | Reference pane, `.quiet` with `#i-screen`, text "Share window" |
| `#live-start`, `#live-pause` (+`#live-count`) | toolbar, secondary fill | Reference pane, right end of the sources row, `.quiet` |
| `#revision-count`, `#revisions`, `#new-session` | bottom of the scrolling stage | the fixed 64px `.deck` row under rail and stage |
| `#build-overlay` | a block that pushes the prototype down | absolute strip over the reply, the prototype never moves |
| `#sent-evidence` | bottom of the rail, ~420px below the composer | top of the Reference pane, directly under the composer |
| `#agent-start` | above the timeline | below the timeline; after a terminal run it reads "Start another run" |
| `#computer-review` | before outcome/read/done | last in the body: window, task, read, done, outcome, then the decision |

Status lives where the thing it describes lives: sensor line in the panel header, `#activity` beside Build, `#reply-status` on the byline, `#computer-left` and `#agent-status` in their screen heads. Stop is never in a scroll: `#computer-stop` and `#agent-stop` in fixed 44px feet, `#companion-stop` on the running line, `#cancel` on the build strip. One teal fill per screen: `#companion-send` in the panel; `#build` in the studio; `#computer-next` until a proposal is live, then `#computer-approve`; `#agent-start-button`, then `#agent-approve` or `#agent-answer`, then `#agent-continue` when offered (Start demotes to secondary while Continue is on screen).

Toolbar keeps: mark, `#companion-back` "← Panel", "Studio", `#chat-toggle` (≤1180 only), `#model-menu`, `#settings-open`. Panel header keeps: mark (drag), `#companion-sense`, `#companion-bench`, `#companion-settings`, `#companion-hide`.

## 3. Design system

### Tokens (style.css `:root`, the only place verify-states.mjs:13 scans besides companion.css and site.css)

Add two, change none:

| Token | Value | Use |
|---|---|---|
| `--chrome` | `#D7DAE3` | the one grey for both preview bars (replaces `#d4d7e1` and `#dcdfe7`) |
| `--warn` | `#F2B49E` | promotes the literal already used at companion.css:61-62 and agent.css:14,16,22,29; errors, paused breakers, warn dots, "verification unavailable" |

Preview chrome text on `--chrome`: primary `#3A4256` (7.0:1), secondary `#4A5470` (5.3:1), active viewport `#252A36`, hover on the footer's quiet buttons `#171D2D` (today's `.quiet:hover` goes to `--ink` on a light bar, 1.3:1).

### Colour law

Teal fills and frames mean four things: the primary button, the thing under the cursor, the follow border, and the single accent frame that means "a person must decide now" (`#agent-approval`, `#agent-clarify`, `.computer-live`), at most one on screen at a time. `--green` is the ready dot and the billing line only; three violations are fixed: `pre{color}` (style.css:222) becomes `var(--muted)`, `.revision[aria-current=true]` (style.css:159) becomes `border-color:var(--muted);background:var(--panel)`, `.aperture div` (style.css:95) becomes `border-color:#545d78`, and `#computer-outcome-text.unverified` (companion.css:93) becomes `var(--warn)`. Teal *text* uses that ship today (`.reply-byline`, `.frame-label`, `.agent-glyph-verified`, `.build-overlay h2`, `.setup-line`, `.observation-list .index`, `.annotation`) are left in place and listed as known; they are not fills.

### Type: three text roles, three display steps

| Role | Size | Where |
|---|---|---|
| meta | 12px/1.45 | labels, captions, chips, quiet buttons, tags, meters, footers, countdowns. Nothing below 12 (scripts/check.mjs enforces) |
| secondary prose | 13px/1.5 | reply text, dialog body, timeline rows, computer reasons, settings lists |
| body | 14px/1.55 Segoe UI | inputs, starters, messages, tile titles, `#agent-summary-line` (500) |
| decision headline | 16px/1.3, 500 | `#computer-action-title`, `#agent-approval-line`, `.camera-empty h2` (17) |
| display | 22px Georgia italic | `#build-message` only |
| display | 24px/1.2 Georgia | dialog `h2`, `.preview-empty h2` (unchanged) |

Weights: 400 body, 500 names and headlines inside dense rows, 600 buttons and the wordmark. Numbers that change in place get `font-variant-numeric:tabular-nums`: `#build-elapsed` (already), `#computer-left` (already), `#version-label`, `#agent-decide-by`, `#agent-approval-fields dd`, `#agent-effects`, `#send-preview dd`.

### Spacing

4px base for blocks and panes: 8, 12, 16, 24, 64. Inside a control cluster the shipped 6px and 10px stay (chip gaps, row gaps, the header's 6px); no new off-grid value is introduced. Pane padding 16px horizontal, 12-14px vertical. Studio shell padding 0 at every width above 900px so seams reach the edges; 16px page gutters at 900px and below.

### Radii: the float rule

| Radius | Meaning | Elements |
|---|---|---|
| 0 | welded | `.app-shell` panes, `.deck`, `.viewfinder`, starters, rule-separated computer steps, `#agent-summary`, `.build-overlay` at desktop |
| 3 | tag / tile | `#changes li`, `.revision`, `.frame-label` |
| 5 | field / button | `.button`, `.composer`, `.error-banner`, `.viewfinder` border stays 1px |
| 6 | artifact / evidence | `.prototype`, every `pre` in the panel, thumbnails |
| 8 | floats | dialogs, `.stage.expanded`, `.build-overlay` at ≤900px, `.frame-chip`/`.companion-att` (one chip component on both surfaces) |
| 9-10 | floats | decision cards, message bubbles, mode primaries |
| 12 | floats | the native panel, `#companion-form` |
| 999 | pill | `.chip`, `.agent-tag` |

### Control heights (px)

28 quiet text button · 30 chip · 32 panel icon and `#companion-send` · 34 toolbar icon · 36 select (`select`, `.settings-field select` 38→36, `#computer-mode select`) · 38 starter row · 40 primary (`.button{min-height:40px;padding:0 18px}`, `#computer-mode .button.amber, #agent-mode .button.amber{min-height:40px;padding:0 14px}`) · 44 panel header, mode feet · 48 studio toolbar · 64 versions deck.

### Component rules

- Buttons: `.button.amber` is the only teal fill, one per screen. `.button.secondary` raised navy `#2f3443`, hover `#363c4e`. `.quiet` 12px muted, ink on hover, no fill ever; reveal buttons add a 3px-offset underline and go ink at `aria-expanded=true`. No `<details>` anywhere inside `#companion`, `#computer-mode`, `#agent-mode` (verify-companion.mjs:46, verify-computer.mjs:31, verify-agent.mjs:293).
- Rules: 1px `var(--line)`, never doubled, never a left stripe. Seams between welded regions are permanent. The two mode heads get a hairline only while their body has scrolled under them.
- Fields: 1px `#3c4357`/`var(--line)` at rest, `var(--accent)` on `:focus-within`, radius per the float rule.
- Evidence blocks: one rule, `#companion pre`: 12px/1.45 muted on `--bg`, 1px `--line`, radius 6, padding 8px 10px, `max-height:200px` with its own scroll, `white-space:pre-wrap; overflow-wrap:anywhere`. Replaces the five near-copies (`#companion-text-body`, `.companion-message>pre`, `#computer-review pre`, `#computer-diagnostics/#computer-outcome-tree`, `#computer-read pre`, `#agent-timeline pre`), which keep only their own `max-height` and margins.
- Decision card (Computer and Agent share it): accent 1px frame, radius 10, `--panel`, padding 12px 14px; a pinned head (12px muted label, 16px/500 ink headline, the target block), a scrolling middle (reason, evidence, reveals), a pinned foot (sentence or deadline, Approve, Reject). Head and foot are `position:sticky` against the mode body, which is the only scroller; the card never gets `overflow`, `max-height`, `dvh` or a nested scroller.
- Doors (Settings): a two-line row, name 14px/500 ink, sentence 12px muted, right chevron, 56px tall, rules between.

### State colours

`--accent` as above · `--green` ready dot, billing line · `--warn` errors, breakers, warn dots, unverified outcome · `--muted` everything secondary · disabled = opacity .38 (`.quiet`) / .4 (panel), never a colour change.

### Motion

Ease-out only, `cubic-bezier(.22,1,.36,1)`, 150-300ms. New: the build strip fades in over 150ms with `@starting-style{opacity:0}` (out is instant: the new reply is simply revealed); the mode-head hairline fades over 200ms. Layout never animates: panes do not slide, the prototype does not move, the chat overlay keeps its instant show (as today). `prefers-reduced-motion` already zeroes every animation and transition (style.css:294, companion.css:101, agent.css:65) and stays.

## 4. Per surface

Change items are tagged (P, S, C, A, T, V) so slices in section 6 can claim them.

### 4.1 The panel

Decision: three CSS changes and nothing else. The panel is the most finished surface and carries the tightest assertions.

**P1** Rest state hides what cannot act. `companion.css`:
```css
#companion:has(#companion-messages:empty) .companion-chat-controls{display:none}
#companion:has(#companion-messages:empty) #companion-meter{position:absolute;width:1px;height:1px;margin:0;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}
```
`#companion-messages` has no whitespace children at load (index.html:121) and `innerHTML===''` after New chat (verify-companion.mjs:174), so `:empty` matches in both rest states. The meter is clipped, not display:none, so `innerText()` at verify-companion.mjs:150 returns the rendered string `Context 0% · no sends yet`; the controls row is display:none, and `isDisabled()` on `#companion-clear-context`/`#companion-compact` (same line) does not need visibility. The empty panel posts about 380px (434 today minus the 54px of controls and meter), inside the 300-460 band at verify-companion.mjs:54 and equal to DESIGN.md's "about 380px".

**P2** In the studio column the deck stops being bottom-pinned: `body[data-surface=studio] #companion-deck{margin-top:0}`. Scoped to the studio; the native panel is content-height and never sees it.

**P3** Tokens: `.companion-meter .warn` and `#companion-error` use `var(--warn)`.

Already true and kept: the studio column has no outer radius (`body[data-surface=companion][data-native]` scopes the 12px), `#companion-goes`/`#companion-running` share `min-height:24px`, `#companion-send` never transitions width (only background, color, opacity, transform are transitioned at style.css:15), a refused send lands in the ledger as "refused, nothing reached the model" (verify-companion.mjs:102).

States, unchanged in mechanics: **rest** = header 44 · tile (28px icon or initial on `#2B3448`, title 14/500, app 12 muted) · three starters at 38px on 1px rules · box (12px radius, one 21px line, ▣ and 🎤 at 16px, teal ↑) · `Astra … What goes`. **Mid-conversation** = replies as plain text with 12px Copy, yours as right bubbles (10/10/2/10) with the 40×28 sent frame, dividers "Context cleared" / "Compacted: N to M characters", slim tile as one 12px line, chat controls and meter visible. **Attachment** = chip inside the box (44×30 thumbnail, label, time · size, ×), send reads "Send with screenshot ↑" / "Send with window text ↑". **Running** = `#companion-running` (pulsing dot, activity, Stop) replaces `#companion-goes` in the same slot.

```
Wireframe P-A — Panel at rest, native shell, 440 × ~380 (P1 removed the controls row and the meter)
+------------------------------------------+
| (⬡) ● Screen & mic off   Bench ↗   ⚙   − |  44
+------------------------------------------+
| [F]  Design reference window             |  tile
|      Fixture                             |
|------------------------------------------|
| What do you think about this?            |  38
|------------------------------------------|
| Help me with a task                      |  38
|------------------------------------------|
| Make something together                  |  38
|------------------------------------------|
| +--------------------------------------+ |
| | Ask about this window…               | |  r12, 21px line
| | (▣) (🎤)                       [ ↑ ] | |
| +--------------------------------------+ |
| Astra                          What goes |  24
+------------------------------------------+
```

```
Wireframe P-B — Panel mid-conversation with an attachment, 440 × 700 browser
+------------------------------------------+
| (⬡) ● Screen & mic off   Bench ↗   ⚙   − |
+------------------------------------------+
| Two things stand out:                    |
|  1. The heading is too small.            |
|  2. The button has no label.             |
| Copy                                     |
| - - - - Compacted: 231 to 110 - - - - -  |
|                     +------------------+ |
|                     |[▤] List two things| |  bubble r10/10/2/10
|                     +------------------+ |
|------------------------------------------|
| [F] Fixture · Design reference window    |  slim tile 12px
| New chat   Clear context   Compact       |  visible: messages exist
| Context 7% · last send 900 tokens        |
| +--------------------------------------+ |
| | [img] Design reference · 3 KB      × | |
| | What do you think?                   | |
| | (▣) (🎤)      [ Send with screenshot ↑]| |
| +--------------------------------------+ |
| Astra                          What goes |
+------------------------------------------+
```

### 4.2 The studio

Decision: four welded panes, one document scroll nowhere above 900px, one below it.

**DOM (S1, index.html)**

```html
<div class="app-shell">
  <header class="toolbar">
    <span class="toolbar-mark" aria-hidden="true">…unchanged svg (keeps "32,10 51,21 51,43 32,54 13,43 13,21")…</span>
    <button class="quiet" id="companion-back">← Panel</button>
    <span class="toolbar-title">Studio</span>
    <div class="toolbar-actions">
      <button class="quiet" id="chat-toggle" aria-expanded="false" aria-controls="companion">Chat</button>
      <button class="quiet model-menu" id="model-menu" …unchanged…></button>
      <button class="icon-button" id="settings-open" …unchanged…>⚙</button>
    </div>
  </header>
  <main class="studio">
    <section class="rail" aria-label="Direction and reference">
      <div class="pane pane-direction" aria-label="Direction">
        <div class="chip-row" id="rail-chips" aria-label="Prewritten directions"></div>
        <form id="composer" class="composer">…unchanged…</form>
        <div class="error-banner" id="error" role="alert" hidden>…unchanged…</div>
      </div>
      <div class="pane pane-reference" aria-label="Reference">
        <details id="sent-evidence" class="sent-evidence" hidden>…unchanged…</details>
        <div class="viewfinder" id="viewfinder">…unchanged, including .camera-empty and the corners…</div>
        <p class="source-status" id="source-status">Camera off</p>
        <div class="source-controls">
          <button class="quiet" id="share-screen"><svg><use href="#i-screen"/></svg> Share window</button>
          <button class="quiet" id="connect" aria-label="Connect camera"><svg><use href="#i-camera"/></svg> Camera</button>
          <button class="quiet" id="upload"><svg><use href="#i-upload"/></svg> Upload</button>
          <button class="quiet" id="example" aria-label="Try a sample sketch">Sample sketch</button>
          <input type="file" id="file" accept="image/jpeg,image/png,image/webp" hidden>
          <button class="quiet live-toggle" id="live-start">Live build</button>
          <button class="quiet live-toggle" id="live-pause" hidden>Live <span id="live-count">0 / 10 builds</span> · Pause</button>
        </div>
        <div class="camera-controls" id="camera-controls" hidden>…unchanged…</div>
        <section class="live-controls" id="live-controls" aria-label="Live build" hidden>…unchanged…</section>
        <div class="understanding" id="understanding" hidden>…unchanged children…</div>
      </div>
    </section>
    <section class="stage" aria-label="Running prototype">
      <div class="prototype" id="prototype">
        <div class="browser-bar"><span id="prototype-title">Your next idea, running.</span><span class="version-label" id="version-label">No version yet</span><div class="preview-actions">…unchanged…</div></div>
        <div id="draft-controls" …unchanged…></div>
        <div class="preview-stage" id="preview-stage">…unchanged…</div>
        <div class="prototype-footer">…unchanged…</div>
      </div>
      <section class="reply" aria-label="Sidelook reply">
        <div class="reply-scroll"><img class="reply-mark" src="/mark.svg" width="27" height="27" alt="" aria-hidden="true"><div><div class="reply-byline">Sidelook <span id="reply-status">Standing by</span></div><p id="reply-text" aria-live="polite">…</p><ul id="changes"></ul></div></div>
        <div class="build-overlay" id="build-overlay" hidden>…unchanged children…</div>
      </section>
    </section>
  </main>
  <footer class="deck" aria-label="Versions">
    <span id="revision-count">Every build keeps the previous version.</span>
    <nav class="revisions" id="revisions" aria-label="Revision history"><p class="revision-empty">Your first version starts with an idea.</p></nav>
    <button class="quiet" id="new-session">New project</button>
  </footer>
</div>
```

Removed from the markup: `.browser-dots` and its three `<i>` (no id, no text, no function), the two `.toolbar-wide` spans, the `.revision-heading` wrapper (its two children move into `.deck`). `#live-start` stays a sibling of `#live-controls`, never a child: verify-live.mjs:32 needs it disabled before any share and :81 needs it visible after the twelfth build, and `#live-controls` is hidden until sharing.

**CSS (S2, style.css)** — the rules to replace or add:

```css
/* layout layer */
.app-shell{display:grid;grid-template-rows:48px minmax(0,1fr) 64px;height:100dvh;min-width:0;padding:0}
.toolbar{display:flex;align-items:center;gap:14px;padding:0 16px;border-bottom:1px solid var(--line);min-width:0}
.studio{display:grid;grid-template-columns:minmax(340px,380px) minmax(0,1fr);overflow:hidden;min-height:0}
.rail{display:grid;grid-template-rows:auto minmax(0,1fr);overflow:hidden;min-width:0;min-height:0;border-right:1px solid var(--line)}
.pane{min-width:0}
.pane-direction{padding:12px 16px 14px}
.pane-reference{overflow:auto;min-height:0;padding:14px 16px 24px;border-top:1px solid var(--line);scrollbar-width:thin;scrollbar-color:var(--line) transparent}
.stage{position:relative;display:grid;grid-template-rows:minmax(300px,1fr) auto;overflow:hidden;min-width:0;min-height:0;padding:14px 16px 0}
.stage.expanded{position:fixed;inset:12px;background:var(--bg);z-index:5;padding:16px 20px 0;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.deck{display:flex;align-items:center;gap:16px;padding:0 16px;border-top:1px solid var(--line);min-width:0}
/* components layer */
.composer{border-radius:5px}                       /* was 7 */
.viewfinder{margin-top:0;border-radius:0}          /* was 18px / 5px */
.sent-evidence{margin:0 0 10px;font-size:12px}
.sent-evidence summary{padding:0 0 6px}
.source-controls{display:flex;align-items:center;gap:18px;padding:6px 0 12px;border-bottom:0;flex-wrap:wrap}
.live-toggle{margin-left:auto}
.live-controls{margin-top:6px;padding:14px 0 0;border-top:1px solid var(--line);border-bottom:0}
.understanding{padding:14px 0 0;border-top:1px solid var(--line)}
.prototype{min-height:0}
.preview-stage{min-height:0}
.browser-bar{display:flex;align-items:center;gap:14px;min-height:34px;padding:0 14px;background:var(--chrome);color:#3A4256;border-bottom:1px solid #C2C7D4;flex-wrap:wrap}
.version-label{font-size:12px;letter-spacing:.5px;white-space:nowrap;font-variant-numeric:tabular-nums}
.viewport-button{background:none;color:#4A5470;font-size:12px;padding:3px 0}
.viewport-button.active{color:#252A36;font-weight:600}
.browser-bar .icon-button{color:#4A5470}
.prototype-footer{display:flex;align-items:center;justify-content:space-between;min-height:34px;padding:0 14px;background:var(--chrome);color:#4A5470;gap:10px;flex-wrap:wrap}
.prototype-footer .quiet{color:#3A4256;font-size:12px;padding:0}
.prototype-footer .quiet:hover{color:#171D2D}
.reply{position:relative;min-height:132px}
.reply-scroll{display:flex;gap:13px;padding:14px 0 12px;overflow:auto;max-height:min(38vh,360px);scrollbar-width:thin;scrollbar-color:var(--line) transparent}
.build-overlay{position:absolute;inset:0;z-index:2;display:grid;grid-template-columns:30px 1fr auto;gap:6px 16px;align-items:center;align-content:center;padding:12px 0;margin:0;border:0;border-top:1px solid var(--line);background:var(--bg);color:#e0e2e9;text-align:left;transition:opacity .15s var(--ease)}
@starting-style{.build-overlay{opacity:0}}
#revision-count{color:var(--muted);font-size:12px;white-space:nowrap}
.revisions{display:flex;align-items:center;gap:8px;flex:1;min-width:0;height:64px;padding:0;margin:0;overflow-x:auto;scrollbar-width:thin;scrollbar-color:var(--line) transparent}
.revision-empty{font-size:12px;color:var(--muted);margin:0;white-space:nowrap}
.revision{flex:0 0 auto;min-width:125px;text-align:left;border:1px solid var(--line);background:none;border-radius:3px;padding:6px 10px}
.revision[aria-current=true]{border-color:var(--muted);background:var(--panel)}
.revision small{font-size:12px;color:var(--muted)}
#new-session{white-space:nowrap}
pre{…existing…;color:var(--muted)}
.aperture div{border-color:#545d78}
.button{min-height:40px;padding:0 18px}
select{min-height:36px}
.settings-field select{min-height:36px}
```
Delete: `.toolbar .button{…}`, `.browser-dots{…}`, `.browser-dots i{…}`, `.revision-heading{…}`, the 900px `.toolbar-wide{display:none}`, and the 1100px `.app-shell{padding:0 24px}`, `.rail{padding-right:16px}`, `.stage{padding-left:16px}`.

Responsive, replacing the 900px block:
```css
@media(max-width:900px){
  body[data-surface=studio]{display:block;height:auto;overflow:visible}
  body[data-surface=studio] .app-shell{display:block;height:auto;overflow:visible;padding:0 16px}
  .toolbar{height:auto;min-height:56px;padding:8px 0;flex-wrap:wrap}
  .studio{display:block;overflow:visible}
  .rail{display:block;max-height:60vh;overflow:auto;border-right:0;border-bottom:1px solid var(--line)}
  .pane{padding-left:0;padding-right:0}
  .pane-direction{padding:16px 0 12px}
  .pane-reference{overflow:visible;max-height:none;padding:14px 0 24px}
  .stage{display:block;overflow:visible;padding:16px 0 24px}
  .prototype{flex:none;min-height:0}
  .preview-stage{flex:none;height:435px}
  .stage.expanded .preview-stage{height:calc(100vh - 240px)}
  .reply{min-height:0}
  .reply-scroll{max-height:none;overflow:visible}
  .build-overlay{position:fixed;inset:auto 16px 12px 16px;z-index:6;padding:14px 16px;border:1px solid var(--line);border-radius:8px;background:var(--panel);box-shadow:0 16px 48px #0008;grid-template-columns:24px 1fr}
  .build-overlay #cancel{grid-column:2;grid-row:auto;justify-self:start}
  .deck{flex-wrap:wrap;height:auto;padding:12px 0 24px}
  .revisions{flex-basis:100%;order:3;height:auto;padding:4px 0}
}
```
The 1180px and 420px blocks are unchanged; the 1100px block keeps only `.studio{grid-template-columns:minmax(300px,340px) minmax(0,1fr)}`. This restores exactly what verify-browser.mjs:101 reads at 800px: `.rail` is `display:block` with `overflowY==='auto'` and its bottom sits above `.stage`'s top.

**JS (S3, app.js)**
- Stow the understanding block until an observation exists: in the reset path that writes `'No frame sent yet'` (app.js:176-178) add `$('understanding').hidden=true;`; in the fill path that writes `From the frame sent at …` (app.js:315-317) add `$('understanding').hidden=false;`. Index.html ships it `hidden`.
- F6 cycles panes, after the Escape handler at app.js:571:
```js
// F6 cycles the studio's panes (Direction, Reference, Stage, the panel column); Shift+F6 goes back. Focus lands on the pane's first control.
document.addEventListener('keydown',event => {
  if (event.key !== 'F6' || document.body.dataset.surface !== 'studio') return;
  const panes = ['.pane-direction','.pane-reference','.stage','#companion'].map(s => document.querySelector(s)).filter(el => el && el.offsetParent !== null);
  if (!panes.length) return; event.preventDefault();
  const at = panes.findIndex(p => p.contains(document.activeElement));
  const next = panes[(at + (event.shiftKey ? -1 : 1) + panes.length) % panes.length];
  (next.querySelector('textarea') || next.querySelector('button:not([disabled]):not([hidden]),select') || next).focus();
});
```
Nothing else in app.js changes: `#share-screen`, `#live-start`, `#live-pause`, `#sent-evidence`, `#build-overlay`, `#revision-count`, `#new-session` are all reached by id (app.js:152-171, 282-285, 462, 584-589), `.stage` keeps its class for the expand/Escape handlers (app.js:570-571), Enter already builds (app.js:557).

```
Wireframe S-A — Studio at 1480 × 900 with a built version and the panel column (P2 top-aligns the column's deck)
+-------------------------------------------------------------------+-----------------------+
| (⬡) ← Panel  Studio                        ● Astra · medium ▾  ⚙  | (⬡) ● Screen & mic off ⚙ |  toolbar 48 / header 44
+---------------------------+---------------------------------------+-----------------------+
| [Build this.][Change it…] | +-----------------------------------+ | What do you think?    |  DIRECTION pane (fixed)
| +-----------------------+ | | DAYLIGHT · Daily focus  VERSION 02 | |-----------------------|
| |(🎤) Tell me what to   | | |            Desktop  Mobile  ⤢     | | Help me with a task   |
| |     build…            | | +-----------------------------------+ |-----------------------|
| | Send this direction…  | | |                                   | | Make something…       |
| |    See exactly what goes| | |      running prototype           | |                       |
| | Version 02 ready       | | |      (iframe on --paper)          | |                       |
| |        [Revise Version 02 →]| |                               | |                       |
| +-----------------------+ | |                                   | |                       |
|---------------------------| +-----------------------------------+ |                       |
| ▸ Last frame sent · 9:32  | | Interactive prototype · resets    | |                       |  REFERENCE pane (scrolls)
| +-----------------------+ | |               ⟨⟩ Source ⤓ Download| |                       |
| |  saved reference 4:3  | | +-----------------------------------+ |                       |
| |  01 Brand and search  | |---------------------------------------|                       |
| +-----------------------+ | (⬡) Sidelook  Version ready           |                       |  REPLY strip, ≥132, ≤min(38vh,360)
| Selected frame            | Built your sketch into a warm ivory… |                       |
| ▣ Share window ⌾ Camera   | [Matched DAYLIGHT…] [Added tasks…]    | +-------------------+ |
| ⤒ Upload  Sample sketch   |            Live build                 | | Ask Sidelook…     | |
| From the frame sent 9:32  |                                       | | (▣)(🎤)      [ ↑ ]| |
| 01 Brand and search …     |                                       | +-------------------+ |
+---------------------------+---------------------------------------+ Astra      What goes  |
| 2 saved versions · on this device  [01 / DAYLIGHT…][02 / DAYLIGHT…]        New project     |  DECK 64
+-------------------------------------------------------------------+-----------------------+
```
(`Live build` sits at the right end of the sources row; it is drawn on its own line above only because the rail is 380px wide in this diagram.)

```
Wireframe S-B — Studio at 800 × 900, page mode
+------------------------------------------------------------+
| (⬡) ← Panel  Studio         [Chat]  ● Astra · medium ▾  ⚙   |  toolbar wraps, min 56
+------------------------------------------------------------+
| [Build this.] [Change it to this.] [Make it work on mobile.]|  RAIL: block, max-height 60vh, scrolls inside
| +--------------------------------------------------------+ |
| |(🎤) Tell me what to build, or what to change…           | |
| | Send this direction and the current prototype source    | |
| | to Astra (your ChatGPT subscription).  See exactly what goes |
| | Version 02 ready                      [Revise Version 02 →]|
| +--------------------------------------------------------+ |
|------------------------------------------------------------|
| ▸ Last frame sent · 9:32 AM · Astra                        |
| +--------------------------------------------------------+ |
| |               saved reference, 4:3                     | |
| ~ ~ ~ ~ ~ ~ ~ rail scrolls here ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ |
+------------------------------------------------------------+
| +--------------------------------------------------------+ |  STAGE: block
| | DAYLIGHT · Daily focus board  VERSION 02 Desktop Mobile ⤢| |
| |            running prototype, 435px tall               | |
| | Interactive prototype · resets   ⟨⟩ Source  ⤓ Download | |
| +--------------------------------------------------------+ |
| (⬡) Sidelook  Version ready                                |
| Built your sketch into a warm ivory task board…            |
| [Matched DAYLIGHT…] [Added tasks…]                          |
|------------------------------------------------------------|
| 2 saved versions · on this device               New project |  DECK: wraps
| [01 / DAYLIGHT · Daily focu…] [02 / DAYLIGHT · Daily focu…] |
+------------------------------------------------------------+
| ↻ Building · Reading your reference  "Connecting the dots."|  build strip while building: fixed, bottom 12, r8
|   0s elapsed                                      [Cancel] |
+------------------------------------------------------------+
```

### 4.3 Computer mode

Decision: rules instead of cards, the decision last and pinned, one teal at a time.

**DOM (C1, index.html)** — new order inside `#computer-body` and the review bands:
```html
<div class="computer-head" id="computer-head">…unchanged: #computer-back, #computer-title, #computer-left…</div>
<div class="computer-body" id="computer-body">
  <div class="computer-step"><div class="computer-lbl">1 · The window</div>
    <div class="computer-row">…#computer-window #computer-refresh #computer-inspect…</div>
    <div class="computer-row computer-launch"><span>or open</span>…#computer-app #computer-launch…</div></div>
  <div class="computer-step">…2 · The task, unchanged (#computer-task, #computer-next, #computer-preview, #computer-gate, #computer-status)…</div>
  <section id="computer-read" hidden aria-label="What Sidelook read">…unchanged…</section>
  <section id="computer-done" hidden aria-label="Actions done">…unchanged…</section>
  <section id="computer-outcome" class="computer-step" hidden aria-label="After the action">…unchanged…</section>
  <section id="computer-review" class="computer-step computer-live" hidden aria-label="Review the next action">
    <div class="decision-head"><div class="computer-lbl" id="computer-step-label">3 · Waiting for you</div><h3 id="computer-action-title"></h3><pre id="computer-action-detail"></pre></div>
    <p id="computer-reason"></p>
    <button type="button" class="quiet computer-reveal" id="computer-details" aria-expanded="false" aria-controls="computer-diagnostics">Details</button>
    <pre id="computer-diagnostics" hidden></pre>
    <div class="computer-row"><button type="button" class="button amber" id="computer-approve">Approve</button><button type="button" class="quiet" id="computer-reject">Reject</button><span id="computer-expiry"></span></div>
  </section>
</div>
<footer class="computer-foot">…unchanged…</footer>
```
Two new ids (`computer-head`, `computer-body`), two new classes (`computer-launch`, `decision-head`). `#computer-action-detail` moves above `#computer-reason`; no verifier reads the card as one string (verify-computer.mjs:33 reads the two ids separately).

**CSS (C2, companion.css)**
```css
.computer-head{display:flex;align-items:center;gap:6px;min-height:36px;padding:0 16px 8px 8px;flex-shrink:0;position:relative}
.computer-head::after{content:'';position:absolute;left:0;right:0;bottom:0;height:1px;background:var(--line);opacity:0;transition:opacity .2s var(--ease)}
.computer-head.scrolled::after{opacity:1}
.computer-body{overflow:auto;flex:1;min-height:0;padding:0 16px 12px;display:flex;flex-direction:column;gap:0;scrollbar-width:thin;scrollbar-color:var(--line) transparent}
.computer-body>*{padding:12px 0}
.computer-body>*+*{border-top:1px solid var(--line)}
.computer-step{border:0;border-radius:0;background:none}
.computer-body>.computer-live{border:1px solid var(--accent);border-radius:10px;background:var(--panel);padding:12px 14px;margin-top:12px}
.computer-step:has(#computer-window option:not([value=""]):checked) .computer-launch{display:none}
.computer-body:has(#computer-review:not([hidden])) #computer-next{background:#2f3443;color:var(--ink)}
.computer-body:has(#computer-review:not([hidden])) #computer-next:hover:not(:disabled){background:#363c4e}
#computer-review .decision-head{position:sticky;top:0;z-index:1;background:var(--panel);margin:-12px -14px 0;padding:12px 14px 8px;border-radius:9px 9px 0 0}
#computer-review .decision-head pre{margin:0}
#computer-review #computer-reason{margin:10px 0 8px}
#computer-review .computer-row{position:sticky;bottom:0;z-index:1;background:var(--panel);margin:0 -14px -12px;padding:10px 14px 12px;border-top:1px solid var(--line);border-radius:0 0 9px 9px}
#computer-expiry{order:-1;flex-basis:100%;margin:0;font-size:12px;color:var(--muted)}
#computer-outcome-text.unverified{color:var(--warn)}
#companion pre{max-height:200px;overflow:auto;margin:0;padding:8px 10px;font-size:12px;line-height:1.45;color:var(--muted);background:var(--bg);border:1px solid var(--line);border-radius:6px;white-space:pre-wrap;overflow-wrap:anywhere}
#companion #companion-text-body{max-height:120px;margin:0 0 8px}
#companion .companion-message>pre{max-height:160px;margin:6px 0 0;flex-basis:100%}
#companion #computer-diagnostics,#companion #computer-outcome-tree{margin:0 0 10px}
#companion #computer-read pre{max-height:160px}
#computer-mode select{min-height:36px}
#computer-mode .button.amber{min-height:40px;padding:0 14px}
.computer-foot{min-height:44px}
```
Delete the five per-element `pre` rules these replace (companion.css:69 body, 51 message pre, 91 review pre, 92 diagnostics/tree, 94 read pre) except their kept `max-height`/margins above. The `.computer-live` card keeps its accent frame; it is the one place on the screen that means "decide now". The expiry sentence (`Expires in one minute. Check the target before you approve.`, computer.js:131, unchanged) reads first in the pinned foot, then Approve and Reject.

**JS (C3, computer.js)** — one line before `controls();return …` at computer.js:152:
```js
  // A hairline under the head only while the body has scrolled under it; the class flips only when the boolean does.
  let scrolled=false;$('body').addEventListener('scroll',()=>{const s=$('body').scrollTop>0;if(s!==scrolled){scrolled=s;$('head').classList.toggle('scrolled',s);}},{passive:true});
```
`$('review').scrollIntoView({block:'nearest'})` at computer.js:133 stays and is what brings a new proposal into view. No focus call is added.

```
Wireframe C-A — Computer mode, 440 × 700, proposal live with Details open (foot pinned, head pinned, middle scrolls)
+------------------------------------------+
| (⬡) ● Screen & mic off   Bench ↗   ⚙   − |  44
| ‹ Back  Sidelook in Calculator fixture   |  head 36 (hairline appears once scrolled)
|                                9:58 left |
+------------------------------------------+
| 1 · The window                           |  rule-separated, no card
| [ Calculator fixture         ▾] Refresh Read it |  ("or open" row hidden while a window is chosen)
|------------------------------------------|
| 2 · The task                             |
| | Enter seven                          | |
| [ Plan next action ] What goes           |  secondary while a proposal is live
| Send this task and a fresh reading of…   |
| Nothing has executed. Approve runs this… |
|------------------------------------------|
| Done · 1 action                          |
|  1. click · Seven: Windows accepted…     |
|------------------------------------------|
| After the action                         |
| Windows accepted click · Seven.          |
| Observed: 1 new · Display = 7.   Details |
|,==========================================,|  accent frame, r10, --panel
|‖ Step 2 of 20 · waiting for you          ‖|  PINNED head: label 12 muted
|‖ CLICK · Seven                           ‖|  16/500 ink
|‖ | In: Calculator fixture              | ‖|  target pre, 12px
|‖ | Target: Button "Seven"              | ‖|
|‖ Press Seven in the test calculator.  ⇅  ‖|  scrolls: reason, Details, diagnostics
|‖ Details                                 ‖|
|‖ | Automation ID: (none) …             | ‖|
|‖------------------------------------------‖|
|‖ Expires in one minute. Check the target ‖|  PINNED foot
|‖ before you approve.                      ‖|
|‖ [ Approve ]  Reject                      ‖|
|'=========================================='|
+------------------------------------------+
| Ctrl+Shift+F12 stops from any app  [Stop control] |  foot 44
+------------------------------------------+
```

### 4.4 Agent mode

Decision: same decision card as Computer mode, the pinned sentence "stripe · Refund $485.00", status that reads "Waiting for approval", no Stop at rest, the goal box after the timeline.

**DOM (A1, index.html)**
```html
<div class="agent-head" id="agent-head">…unchanged: #agent-back, #agent-title, #agent-status…</div>
<p id="agent-lineage" class="agent-lineage" hidden></p>
<ul id="agent-breakers" class="agent-breakers" aria-label="Paused integrations" hidden></ul>
<div class="agent-body" id="agent-body">
  <section id="agent-run" hidden>
    <ol id="agent-timeline"></ol>
    <section id="agent-approval" hidden aria-label="DashClaw policy approval">
      <div class="agent-decision-head"><h3>DashClaw policy approval</h3><p id="agent-approval-line"></p></div>
      <dl id="agent-approval-fields"></dl>
      <div class="agent-row"><button type="button" class="button amber" id="agent-approve">Approve</button><button type="button" class="quiet" id="agent-reject">Reject</button><p id="agent-decide-by"></p></div>
    </section>
    <section id="agent-clarify" hidden aria-label="The agent needs an answer">…unchanged…</section>
    <section id="agent-summary" hidden aria-label="Run summary">…unchanged…</section>
  </section>
  <section id="agent-start">
    <p class="agent-again">Start another run</p>
    <textarea id="agent-goal" …unchanged…></textarea>
    …unchanged: #agent-apps, #agent-model-line, .agent-row with #agent-start-button, #agent-error…
  </section>
</div>
<footer class="agent-foot">…unchanged…</footer>
```
New ids: `agent-approval-line`, `agent-head`, `agent-body`. New classes: `agent-decision-head`, `agent-again`. `#agent-decide-by` moves into the approval's `.agent-row` (text unchanged, `^Decide by \d{2}:\d{2}$` at verify-agent.mjs:304). `#agent-start` moves after `#agent-run`; agent.js:285 hides it while a run is active and shows it on any terminal run, so on first entry the goal box is the only thing on screen and after a run it sits under the summary.

**CSS (A2, agent.css)**
```css
.agent-head{display:flex;align-items:center;gap:6px;min-height:36px;padding:0 16px 8px 8px;flex-shrink:0;position:relative}
.agent-head::after{content:'';position:absolute;left:0;right:0;bottom:0;height:1px;background:var(--line);opacity:0;transition:opacity .2s var(--ease)}
.agent-head.scrolled::after{opacity:1}
#agent-status{margin-left:auto;font-size:12px;color:var(--muted);white-space:nowrap;text-transform:lowercase}
#agent-status::first-letter{text-transform:uppercase}
.agent-app.warn .agent-dot{background:var(--warn)}
.agent-breakers{…;color:var(--warn)}
#agent-error{color:var(--warn);…}
.agent-glyph-blocked,.agent-glyph-rejected,.agent-glyph-failed{color:var(--warn)}
#agent-mode .button.amber{…;min-height:40px;padding:0 14px}
.agent-event-detail{color:var(--muted);font-size:12px;flex:1 1 0;min-width:70%}
#agent-timeline .agent-reveal{font-size:12px;color:var(--muted);text-decoration:underline;text-underline-offset:3px;padding:0;min-height:0;margin-left:auto}
#agent-timeline pre{margin:2px 0 0;flex-basis:100%}          /* the rest comes from #companion pre */
#agent-approval,#agent-clarify{border:1px solid var(--accent);border-radius:10px;padding:12px 14px;background:var(--panel)}
#agent-summary{border:0;border-top:1px solid var(--line);border-radius:0;padding:12px 0 0}
#agent-approval h3,#agent-clarify h3{font:400 12px/1.45 'Segoe UI',sans-serif;color:var(--muted);margin:0 0 4px}
#agent-approval-line{font:500 16px/1.3 'Segoe UI',sans-serif;color:var(--ink);margin:0;overflow-wrap:anywhere}
#agent-question{font:500 15px/1.35 'Segoe UI',sans-serif;margin:0 0 8px}
.agent-decision-head{position:sticky;top:0;z-index:1;background:var(--panel);margin:-12px -14px 0;padding:12px 14px 8px;border-radius:9px 9px 0 0}
#agent-approval-fields{display:grid;grid-template-columns:110px minmax(0,1fr);gap:6px 12px;margin:10px 0;font-size:13px}
#agent-approval-fields dt{color:var(--muted);font-size:12px;margin:0;padding-top:1px}
#agent-approval-fields dd{margin:0;color:var(--ink);font-variant-numeric:tabular-nums}
#agent-approval .agent-row,#agent-clarify .agent-row{position:sticky;bottom:0;z-index:1;background:var(--panel);margin:0 -14px -12px;padding:10px 14px 12px;border-top:1px solid var(--line);border-radius:0 0 9px 9px}
#agent-decide-by{font-size:12px;color:var(--muted);margin:0 0 0 auto;font-variant-numeric:tabular-nums}
#agent-effects{…;font-variant-numeric:tabular-nums}
.agent-again{display:none;font-size:12px;color:var(--muted);margin:0 0 8px}
#agent-run:not([hidden])+#agent-start{border-top:1px solid var(--line);padding-top:12px}
#agent-run:not([hidden])+#agent-start .agent-again{display:block}
#agent-run:has(#agent-continue:not([hidden]))+#agent-start #agent-start-button{background:#2f3443;color:var(--ink)}
#agent-run:has(#agent-continue:not([hidden]))+#agent-start #agent-start-button:hover:not(:disabled){background:#363c4e}
#agent-mode:has(#agent-run[hidden]) #agent-stop{display:none}
.agent-foot{…;min-height:44px}
```
`dt`/`dd` stay block-level grid items, so `#agent-approval-fields` innerText still yields `App\nstripe`, `Amount\n$485.00`, `Action id\nact_demo1` (verify-agent.mjs:295) and the evidence `ul` is untouched (:300-303). `#agent-status` keeps its `textContent` (`blocked`, `cancelled`, `partial`, `recovering` at :338, :353, :369, :371 are all read through `textContent`). `.agent-row-item` keeps `display:flex` and its child order, so `/^Continuing run /` at :414-415 and `/Refund \$485\.00 pending/` at :288 are unchanged; only the Details button now sits at the end of the detail line instead of on a row of its own (`.agent-reveal` remains the class-based locator at :307).

**JS (A3, agent.js)**
- Declare `let scrolledTo=null;` with the other lets at agent.js:16.
- In `renderApproval` (agent.js:140-152), after `if(!pending) return;` add `$('approval-line').textContent=[pending.app,pending.operation].filter(Boolean).join(' · ');` and, as the last statement, `if(scrolledTo!==pending.actionId){scrolledTo=pending.actionId;$('approval').scrollIntoView({block:'nearest'});}`. Focus stays where it is: a stray Enter or Space must never approve.
- Before `controls();return {open,stop};` at agent.js:391: the same one-line scroll listener as C3, on `$('body')` toggling `scrolled` on `$('head')`.

```
Wireframe A-A — Agent mode, 440 × 700, approval waiting, timeline scrolled up to read the permalink
+------------------------------------------+
| (⬡) ● Screen & mic off   Bench ↗   ⚙   − |
| ‹ Back  Agent mode    Waiting for approval|  head, hairline shown (scrolled)
+------------------------------------------+
| ✓ (slack)  Found cancellation request… ⇅ |  rows: label / detail … Details
|   Acme asked to cancel and be…   Details |
|   | channel: #support               |    |
|   | permalink: https://slack.exam…  |    |
| ✓ (stripe) Matched acme.com to cus_demo  |
|   One match on domain.           Details |
| ● (stripe) Refund $485.00 pending        |
|,==========================================,|  accent frame, r10, --panel
|‖ DashClaw policy approval                ‖|  PINNED head: 12 muted
|‖ stripe · Refund $485.00                 ‖|  16/500 ink (#agent-approval-line)
|‖ Customer      Acme (cus_demo)        ⇅  ‖|  dl 110px / 1fr, scrolls
|‖ Amount        $485.00                   ‖|
|‖ Agent reason  Acme asked for a refund…  ‖|
|‖ Source evidence · Slack request: from…  ‖|
|‖------------------------------------------‖|
|‖ [ Approve ]  Reject      Decide by 09:41 ‖|  PINNED foot
|'=========================================='|
+------------------------------------------+
| Ctrl+Shift+F12 stops from any app  [Stop]|  foot 44
+------------------------------------------+
```

```
Wireframe A-B — Agent mode at rest (no Stop) and after a completed run
+------------------------------------------+      +------------------------------------------+
| ‹ Back  Agent mode                       |      | ‹ Back  Agent mode              Completed |
+------------------------------------------+      +------------------------------------------+
| | Resolve Acme's cancellation request… | |      | ✓ (gmail) Gmail message verified         |
| |                                      | |      |------------------------------------------|
| ● Slack ● Stripe ● HubSpot ○ Gmail ● DashClaw |  | 4 apps · 8 tool calls · 3 of 3 writes…   |  14/500
| Fable 5.1 · Every write goes through DashClaw.|  | verified · stripe stripe.refund_payment  |
| [ Start ]                                |      | Diagnostics                              |
|                                          |      | All writes finished.                     |
|                                          |      | The agent said  Refunded Acme $485.00…   |
|                                          |      |------------------------------------------|
|                                          |      | Start another run                        |  .agent-again
|                                          |      | | Resolve Acme's cancellation request… | |
+------------------------------------------+      | [ Start ]                                |
| Ctrl+Shift+F12 stops from any app        |      +------------------------------------------+
+------------------------------------------+      | Ctrl+Shift+F12 stops from any app  [Stop]|
```

### 4.5 Settings

Decision: order unchanged (Do more → Model → Advanced → What leaves this device → About → foot); the two mode rows become doors. Everything else in the dialog is untouched, copy included.

**DOM (T1, index.html)**
```html
<section class="settings-section settings-more" aria-label="Do more">
  <button class="quiet" id="computer-open"><b>Computer mode</b><small>let Sidelook work in one Windows app, one approved action at a time</small></button>
  <button class="quiet" id="agent-open"><b>Agent mode</b><small>give Sidelook a business outcome across Slack, Stripe, HubSpot and Gmail</small></button>
</section>
```
The words are identical; the "·" becomes a line break. Nothing asserts these buttons' text (verify-computer.mjs:21 and verify-agent.mjs:253 click by id).

**CSS (T2, style.css)** — replaces the three `.settings-more` rules at style.css:251-253:
```css
.settings-more{display:flex;flex-direction:column;align-items:stretch;gap:0}
.settings-more .quiet{position:relative;display:flex;flex-direction:column;align-items:flex-start;justify-content:center;gap:2px;min-height:56px;padding:8px 28px 8px 0;text-align:left;color:var(--ink);font-size:14px;line-height:1.4}
.settings-more .quiet+.quiet{border-top:1px solid var(--line)}
.settings-more .quiet b{font-weight:500}
.settings-more .quiet small{font-size:12px;color:var(--muted)}
.settings-more .quiet::after{content:'›';position:absolute;right:8px;top:50%;transform:translateY(-50%);font-size:18px;color:var(--muted)}
.settings-more .quiet:hover{color:var(--accent)}
```
The `small` keeps its explicit muted colour under hover, so verify-states' hover pass on `dialog settings` stays above 4.5:1.

```
Wireframe T-A — Settings, 560px dialog (only "Do more" changes)
+----------------------------------------------------+
| Settings                                      Back |
|----------------------------------------------------|
| Computer mode                                    › |  14/500 ink
| let Sidelook work in one Windows app, one approved |  12 muted
| action at a time                                   |
|....................................................|
| Agent mode                                       › |
| give Sidelook a business outcome across Slack,     |
| Stripe, HubSpot and Gmail                          |
|----------------------------------------------------|
| Model                     [ Astra (ChatGPT)     ▾] |  unchanged from here down
| Astra uses your ChatGPT subscription.              |
| ● Ready  1. Local Sidelook is running. …           |
| [Check again]        Official setup help           |
|----------------------------------------------------|
| ▸ Advanced                                         |
|----------------------------------------------------|
| What leaves this device  … 8 items …               |
| See exactly what goes                              |
|----------------------------------------------------|
| (⬡) sidelook  a Practical Systems product, made by Wes. |
+----------------------------------------------------+
```

### 4.6 Send preview

Decision: the human reading first, the machine reading last; a packing-slip `dl`.

**DOM (T3, index.html)** — inside `#send-preview`, the order becomes: `.settings-head`, `#send-preview-list`, `<h3>Sent this session</h3>`, `#send-ledger-empty`, `#send-ledger`, then the `<details>` with `#send-preview-body`. `harness.js renderPreview` (harness.js:89-97) reaches every one of these by id, so nothing changes there; `ledgerRows()` at verify-companion.mjs:39 reads `#send-ledger li` and clicks `#send-preview [data-close]`, both order-independent.

**CSS (T4, style.css)**: `#send-preview dl{display:grid;grid-template-columns:120px minmax(0,1fr);gap:6px 16px;font-size:13px;margin:12px 0}` and `#send-preview dd{margin:0;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}`. The dialog stays a centred 530px dialog in the studio and a `calc(100% - 32px)` dialog in the panel; no bottom sheet (companion.js:126 sizes the native panel from the dialog's unclamped `scrollHeight`).

```
Wireframe T-B — Send preview
+-------------------------------------------------+
| What goes with the next send              Close |
|-------------------------------------------------|
| Message          What do you think?             |  dl 120px / 1fr
| Screenshot       Design reference · 3 KB        |
| Window text      none                           |
| Earlier messages 0                              |
| Model            Astra · medium                 |
|-------------------------------------------------|
| Sent this session                               |
|  1. 9:32 AM · message · Astra · medium · frame sent |
|  2. 9:34 AM · message · refused, nothing reached the model |
|-------------------------------------------------|
| ▸ The request body, as it will be posted        |  last
+-------------------------------------------------+
```

### 4.7 Lease and confirmation dialogs

Decision: unchanged. `#computer-lease`, `#screen-lease`, `#live-dialog`, `#reset-dialog`, `#install-dialog`, `#source-dialog` keep their copy, order, 8px radius (they float) and `#screen-lease`'s stacked actions. They inherit only two system changes: `.button` at 40px, and `pre` text in `var(--muted)` instead of green (`#source-code`, `#send-preview-body`).

## 5. Id and verifier contract

**Every id in `public/index.html` is kept.** None is renamed or removed; ids are only re-parented into class-only wrappers. New ids (six): `understanding`, `computer-head`, `computer-body`, `agent-head`, `agent-body`, `agent-approval-line`. New classes: `pane`, `pane-direction`, `pane-reference`, `deck`, `reply-scroll`, `live-toggle`, `computer-launch`, `decision-head`, `agent-decision-head`, `agent-again`. Removed elements: `.browser-dots` (+3 `<i>`), two `.toolbar-wide` spans, the `.revision-heading` wrapper. Class-based JS lookups that must survive: `.stage` (app.js:570-571, kept on the same element), `.revision` (app.js:167), `#rail-chips .chip` (app.js:160), `.companion-scroll`, `.companion-compose`, `.companion-header` (companion.js:123-125, all kept with the same children), `.consent-line`/`.billing` (harness.js:84), `.mark-live`/`.eye` (companion.js:10-12), `.starter`, `.companion-followups button` (companion.js:88), `.companion-edges i` (companion.js:439).

**Visible strings verifiers assert, all held constant:** `#companion-status` `Screen & mic off`; `#companion-send` `↑` / `Send with screenshot ↑` / `Send with window text ↑`, aria-label `Send`; `.companion-chat-controls button` exactly `['New chat','Clear context','Compact']`; `#companion-meter` `Context 0% · no sends yet` and `/^Context [1-9]\d?% · last send …$/`; starters `What do you think about this?`, `Help me finish setting this up.` (input value), `Unstick me`; targets `Whole desktop\nevery monitor, without Sidelook`; slim tile `Fixture · Design reference window`; dividers `Context cleared`, `/^Compacted: \d[\d,]* to \d[\d,]* characters$/`; `Copied`; `Screen off · stopped early`; workflow buttons `Build this in the studio`, `Let Sidelook do this`; `#build-label` `Build` / `Build with frame` / `Revise Version 01` / `Revise Version 03 with frame`; `#use-frame` `Attach this frame`; aria-labels `Connect camera`, `Try a sample sketch`, `Desktop preview`, `Mobile preview`, `Close source`, `Expand preview`; button names `Turn off`, `Source`, `Download`, `New project`, `Clear and start fresh`, `Keep it local`; texts `Camera on · local only`, `Your first version starts with an idea.`, `Say what Sidelook should do first.`, `Say what the agent should accomplish first.`, `Allow local window inspection before enabling Computer mode.`; `#provider-status` `/^Astra · (low|medium|high|xhigh|max)$/`, `Fable 5.1 · high`; `#version-label` `VERSION 01`/`02`; `#frame-label` `/Sample sketch/`; `#frame-chip-label` `/^Camera frame · /`; `#error-text` `/Tell Sidelook what should work first/`; `#build-consent-line` `/^Live build on/`; `#live-count` `N / 10 builds`; `#build-message` `/Fable 5\.1 is grinding/`; `#build-phase` `Waiting for model output`; `#computer-left` `/^(9|10):\d\d left$/`; `#computer-title` `Sidelook in Calculator fixture`; `#computer-consent-line` regexes; `#computer-step-label` `/^Step 1 of 20 · waiting for you$/`; `#computer-action-title` `/^LAUNCH · notepad$/`; `#computer-action-detail` `/^In: Calculator fixture\nTarget: Button "Seven"$/`; `#computer-reason` `Press Seven in the test calculator.`; `#computer-count` `1 action`; `#computer-outcome-accepted` `Windows accepted click · Seven.`; `#computer-outcome-text` `Observed: 1 new · Display = 7.`; `#computer-status` `/^Nothing has executed\. Approve runs this one action, then plans the next\.$/`, `/^Action rejected\. Nothing more is planned/`; `#companion-goes-text` `/^Computer mode on/`; `#agent-model-label` `Fable 5.1`; `#agent-approval-fields` `/App\nstripe/`, `/Amount\n\$485\.00/`, `/Action id\nact_demo1/`; `#agent-decide-by` `/^Decide by \d{2}:\d{2}$/`; `#agent-timeline pre` `/channel: #support/`; `#agent-closing` `All writes finished.`; `#agent-status` textContent `blocked`, `cancelled`, `partial`, `recovering`; `#agent-breakers` `/HubSpot paused: 2 authentication failures in 10 min · clears at \d{2}:\d{2}/`; `.agent-row-item` first innerText `/^Continuing run /`; `#agent-lineage` `/^Continues run …$/`; mark geometry `32,10 51,21 51,43 32,54 13,43 13,21` in index.html (verify-states.mjs:75).

**Assertions at risk, and how the design keeps them:**

1. verify-browser.mjs:101 (800px: `.rail` bottom ≤ `.stage` top + 1 and `overflowY==='auto'`) — the 900px block sets `.rail{display:block;max-height:60vh;overflow:auto}` and nulls both panes' scrollers (section 4.2). Read the `one column at 800` line of the PASS output, not the screenshot.
2. verify-live.mjs:32 and :81 (`#live-start` disabled before sharing, visible after twelve builds) — `#live-start` is a sibling of `#live-controls`, never inside it.
3. verify-companion.mjs:54 (empty panel 300-460px), :47/:210 (nothing scrolls at rest), :53/:68-73 (box 21/63/168/141) — P1 removes 54px above the box and touches nothing inside `#companion-form`; the posted height is read off the verifier's own `asks the shell for Npx` line.
4. verify-companion.mjs:147 and :150 — the controls row is display:none only while `#companion-messages` is empty; :147 runs mid-conversation, :150 reads `innerText` of a clip-rect meter (rendered) and `isDisabled()` (visibility-free).
5. verify-states (79 controls, 216 text nodes, every `var(--token)` defined) — `--chrome` and `--warn` are declared in style.css `:root`; the de-carded computer steps sit on `--bg` (muted 7.28:1); the sticky rows sit on `--panel` (6.66:1); the chrome bars use #3A4256 (7.0:1) and #4A5470 (5.3:1); `#computer-next` while the review is open (verify-states.mjs:64 unhides it) is ink on `#2f3443` (11.6:1) with a non-transparent hover, so no VANISH; the `.settings-more small` keeps muted under hover. The reported counts will change (dots and spans removed, controls hidden at rest); the assertion is on findings.
6. verify-agent.mjs:295, :303, :414-415 — grid `dl` keeps block-level dt/dd; the timeline row stays flex with the same child order.
7. verify-computer.mjs:28/:39/:42/:45 — `#computer-read`, `#computer-done`, `#computer-outcome`, `#computer-review` are reordered, never hidden by the reorder; every check is `isVisible`/text by id.
8. verify-recovery.mjs:79-81, verify-models.mjs:33, verify-desktop-content.mjs:42 (`#login`, `#recheck` visible and clickable) — the setup checklist is not collapsed (graft refused).
9. verify-stream.mjs:40, verify-recovery.mjs:101 (`#cancel` click) — the overlay is inside `.reply` at desktop and fixed at ≤900px; Playwright scrolls to it either way.
10. companion.js:124 posts `#agent-mode.scrollHeight` / `#computer-mode.scrollHeight` — no `dvh`, no `max-height`, no nested scroller is added inside either mode, so the posted height cannot feed back on itself.

## 6. Work breakdown: six slices, one owner per file

| Slice | Owns | Delivers | Model |
|---|---|---|---|
| **S-HTML** | `public/index.html` | S1 (studio panes, deck, reply wrapper, overlay move, share/live relocation, dots and spans removed), C1 (computer order, `computer-launch`, `decision-head`, head/body ids), A1 (approval head/line, decide-by move, `agent-start` after `agent-run`, `agent-again`, head/body ids), T1 (doors), T3 (send-preview order), `#understanding hidden` | sonnet |
| **S-STYLE** | `public/style.css`, `DESIGN.md` | tokens, colour-law fixes, S2 (layout, chrome, reply, overlay, deck, responsive), T2, T4, control heights; DESIGN.md: add `--chrome`/`--warn` rows, the radius law paragraph, replace "App shell max width 1800px, 40px gutters" with the three-region description, keep "about 380px" | sonnet |
| **S-PANEL** | `public/companion.css` | P1, P2, P3, C2 (de-carding, bands, or-open rule, `#companion pre`, head hairline, heights) | sonnet |
| **S-AGENT-CSS** | `public/agent.css` | A2 in full | sonnet |
| **S-STUDIO-JS** | `public/app.js` | S3 (understanding stow, F6) | sonnet |
| **S-MODES-JS** | `public/agent.js`, `public/computer.js`, `scripts/verify-agent.mjs`, `scripts/verify-computer.mjs` | A3, C3, V1, V2 (section 7), the L1 red run recorded in the commit message | sonnet |

No two slices touch one file. CSS slices code against the class names in section 4 exactly as written; the integrator (opus) runs section 7 after all six land and owns any cross-slice mismatch. Docs beyond DESIGN.md: none change (README run steps, PRODUCT.md, AGENTS.md untouched).

## 7. Acceptance

**V1 — verify-agent.mjs**, insert after the Details expansion at :309 (before the screenshot at :311):
```js
  // The decision never scrolls: with evidence expanded above it, the pinned sentence and the Approve row sit inside the body's
  // viewport with no scroll. A bounding box, not isVisible(), which is true for an element below the fold.
  assert.equal(await page.locator('#agent-approval-line').innerText(),'stripe · Refund $485.00');
  assert.equal(await page.locator('#agent-status').evaluate(el=>getComputedStyle(el).textTransform),'lowercase','the status reads Waiting for approval, not Waiting For Approval');
  const bodyBox=await page.locator('#agent-body').boundingBox();
  for(const id of ['agent-approve','agent-approval-line']){const box=await page.locator('#'+id).boundingBox();assert.ok(box&&box.y>=bodyBox.y-1&&box.y+box.height<=bodyBox.y+bodyBox.height+1,`#${id} spans ${Math.round(box?.y)}..${Math.round(box?.y+box?.height)} but the body shows ${Math.round(bodyBox.y)}..${Math.round(bodyBox.y+bodyBox.height)}; the decision stays on screen without scrolling`);}count++;
```
**V2 — verify-computer.mjs**, insert after :35 (Details expanded), before the screenshot at :36:
```js
  // The decision never scrolls: at a 440x760 panel with Details open, Approve and the target sit inside the body's viewport with no scroll.
  await page.setViewportSize({width:440,height:760});await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  const bodyBox=await page.locator('#computer-body').boundingBox();
  for(const id of ['computer-approve','computer-action-detail']){const box=await page.locator('#'+id).boundingBox();assert.ok(box&&box.y>=bodyBox.y-1&&box.y+box.height<=bodyBox.y+bodyBox.height+1,`#${id} spans ${Math.round(box?.y)}..${Math.round(box?.y+box?.height)} but the body shows ${Math.round(bodyBox.y)}..${Math.round(bodyBox.y+bodyBox.height)}; the decision and its target stay on screen without scrolling`);}
  await page.setViewportSize({width:1440,height:1000});count++;
```
**L1 first:** S-MODES-JS lands V1 and V2 in a worktree on HEAD with no CSS or markup change, runs `npm run verify:agent` and `npm run verify:computer`, and pastes the two red lines (Approve below the body at 1440×1000 for agent, at 440×760 for computer) into its commit message. A check never observed failing has been run, not verified.

**Commands, in this order, every one read to the PASS line and its count:**
```
npm run lint
npm test
npm run verify:companion   # expect 27 checks; read "asks the shell for Npx" (300-460, about 380)
npm run verify:browser     # expect 10 checks; read "one column at 800"
npm run verify:computer    # expect 16 (15 + V2)
npm run verify:agent       # expect 24 (23 + V1)
npm run verify:states      # expect 0 findings; the control/text counts will differ from 79/216
npm run verify:live
npm run verify:recovery
npm run verify:stream
npm run verify:models
```
(`verify:browser` reuses `.artifacts/generated.json` and `observation.json` from the last `verify:vision`; do not rerun `verify:vision`, it is a paid call.)

**Screenshots regenerated by those runs** (`.artifacts/`): companion-desktop, companion-attached, companion-controls, companion-small, companion-screen-on, panel-bench, workbench-desktop, workbench-built, studio-1480, studio-1180, studio-1100-chat, studio-900, studio-800, studio-800-chat, studio-760, workbench-mobile, computer-desktop, computer-outcome, computer-mobile, agent-desktop, agent-approval, agent-summary, agent-recovering, agent-diagnostics, agent-continue, agent-mobile, live-build-desktop, live-build-mobile, onboarding-desktop, onboarding-mobile, stream-desktop, stream-mobile, model-controls-desktop, model-controls-mobile. **Two new one-off captures** (not verifier changes), taken with `browserTools()` from `scripts/browser.mjs` against a `createApp({vision:{status:async()=>({configured:true,cli:true})}})` server at 1440×1000: `settings-desktop.png` (`document.getElementById('settings').showModal()`, then `page.locator('#settings').screenshot()`) and `send-preview-desktop.png` (click `#build-preview`, screenshot `#send-preview`).

**Stranger test, run by eye on the rendered app, each answer in ten seconds:**
1. `?companion` at 440×700 after `host-ready`: "what is it?" → ask about this window. Count the teal things: one (↑). Count controls above the box: zero.
2. Press Bench at 1480×900: name the four regions without reading a label (direction top-left, reference bottom-left, stage right, versions bottom). Count teal fills: one (Build). Press F6 four times: the caret moves direction → reference → stage → panel.
3. Type "Build a task board", press Enter: the prototype does not move; the build strip appears over the reply with the phase, the italic line, elapsed and Cancel.
4. Resize to 800: the rail scrolls inside itself, the prototype sits below it, Chat slides the column over the stage, Escape closes it, the deck is the last block.
5. Open Settings: the two doors read as places to go; the Model section reads as before.
6. Computer mode at 440×700 with a proposal and Details open: read the target and press Approve without scrolling; scroll the body: the target and Approve stay.
7. Agent mode at 440×700 while waiting: read "stripe · Refund $485.00", "Decide by …", Approve without scrolling; scroll up to the Slack permalink: the sentence and the buttons stay; the head reads "Waiting for approval".
8. Agent mode at rest: no Stop button, only the hotkey note; after a run: the summary, then "Start another run" above the goal box.

## 8. Deliberately unchanged

- `server.mjs`, `lib/`, `harness.js`, `models.js`, `eyes.js`, `chips.js`, `live.js`, `follow.js`, `session.js`, `storage.js`, the native shell: AGENTS.md forbids transport and architecture changes and this design needs none.
- The panel's conversation mechanics: box growth 21 → 168, the grip, starters that fill and never send, the tile picker, the meter string, the goes and running lines, Copy, follow-ups, New chat / Clear context / Compact, the header order, the mic icon (DESIGN.md:42 names both icons; the mic click is the door to the dictation setting, companion.js:327).
- The mark, the eyes, `mark.svg`, the polygon points in both header SVGs, the four files `verify:states` cross-checks.
- Every dialog's copy, including the eight-item "What leaves this device" list, the setup checklist (always visible), the ledger's zero state, and the three lease dialogs word for word.
- Settings order; the `.leaves` list and its "See exactly what goes" link (already present at index.html:262).
- The viewfinder's corner ticks, aperture and empty state, the scan line, frame label and frame tools, the chip content, the revision tile markup, the send-preview generation.
- Enter builds in the studio (app.js:557) exactly as Enter sends in the panel; no Ctrl+Enter.
- The 1180 / 1100 / 900 / 420 breakpoints and the chat overlay's three close paths; `.rail{max-height:60vh}` at ≤900.
- Type roles 12/13/14; control heights except the four normalised above; spacing values inside clusters.
- The twelve existing tokens' values; teal *text* uses listed under the colour law; `.attach-button`'s dead accent rule at style.css:81 (`.small-button` at :105 wins; pre-existing, left and noted).
- `site/`, README, PRODUCT.md.

---

## Appendix A — Grafts absorbed and refused

Numbers are the judges' list. Duplicates share a line.

**Absorbed**
- 20, 37, 44, 58 — no focus moves onto Approve; the card scrolls into view once (A3); Approve is reached by Tab.
- 43, 49, 57 — `#agent-approval-line` pinned above the dl (A1-A3).
- 51, 61, 48, 52, 63 — three bands with sticky head and foot, no cap, no dvh, no nested scroller (companion.js:124 makes any inner cap circular); V1/V2 bounding-box assertions observed failing first.
- 2, 8, 19, 27, 35 — chat controls and meter hidden at rest via `:has(#companion-messages:empty)`, meter clip-rect (P1).
- 4, 11 — `.understanding` stowed until the first observation (S3).
- 9 — the "or open" row hides while a window is chosen (C2, CSS only).
- 14 — timeline Details inline at the end of the detail line (A2).
- 16 — no Stop at rest in Agent mode, hotkey note kept (A2); 5's whole-foot removal refused because the note teaches the hotkey before the danger.
- 23, 41 — scroll-aware hairline under the two mode heads (C2, C3, A2, A3); 31 refused: the toolbar seam is structural, nothing scrolls under it.
- 24, 34, 39 — one `#companion pre` rule; green dropped from every `pre`.
- 25, 30, 17 — Settings order kept, mode rows as doors (T1, T2). 64's order half moot; its link already exists.
- 26, 33, 40 — "Start another run" label, CSS-only via the reordered `#agent-start` (A1, A2).
- 47, 53, 59 — ledger above the request body (T3).
- 50 — `#agent-clarify` keeps its box and takes the accent frame (A2).
- 54 — `#sent-evidence` at the top of the Reference pane (S1); 45 (inside the Direction pane) declined only because an open receipt would grow the fixed pane.
- 66 — 60vh kept.
- 15, 42, 56 — already true by construction (quiet Live build; no width transition; refusals ledgered).

**Refused**
- 1, 18 — hiding the mic contradicts DESIGN.md:42 and removes the only door to the dictation setting.
- 3 — collapsing the viewfinder at rest removes the instrument's face and the rail's stranger-test sentence (12 agrees), and adds a reveal-before-`getUserMedia` race against verify-browser.mjs:26 for no gain in a pane that has the room.
- 6, 13 — collapsing the setup checklist would break `#recheck` at verify-desktop-content.mjs:42 on a signed-in machine and `#login` at verify-recovery.mjs:79-81 / verify-models.mjs:33; the ledger's zero state is its honesty line and stays.
- 7, 10 — "What Sidelook read" and the action history are the evidence PRODUCT.md says to show at the moment it matters; they keep their own scroll instead.
- 21, 28, 36 — deleting the 13px role either grows every secondary line on a 440px panel (pushing Approve down, as 7 itself warns) or drops it to the 12px floor; 31 declarations across three files is a sweep with no verified defect behind it.
- 22, 29, 38 — collapsing heights and spacing to fewer steps is a sweep across every measured control for a difference no one perceives.
- 32 — the dialog title is the one upright Georgia use and shipped with the doc; no defect.
- 46 — the outcome block already has the claim/source/reveal shape; restyling `#agent-effects` rows the summary verifier reads buys nothing.
- 55, 62 — a third statement of the attachment on a footer that would wrap to two lines and shift the posted height mid-conversation; the chip and the button already say it.
- 60 — `#computer-status` already sits two lines under Plan next action; moving it above the consent sentence would separate the button from what it sends.
- 65 — a 64dvh sheet grows the native panel to the dialog's full `scrollHeight` (companion.js:126) and feeds `dvh` back into the posted height.

## Appendix C — Deviations during the build

- The two verifier assertions (V1, V2) select the scroller by class (`.agent-body`, `.computer-body`) so they were valid on the unchanged UI for the red run; the ids from 4.3 and 4.4 also exist.
- Live build lives on the status line (`.source-line`: `#source-status` then `#live-start`/`#live-pause`, right-aligned) rather than at the end of `.source-controls`: at the 380px pane the sources row wrapped and orphaned Sample sketch, and the state of the shared screen and the one action that depends on it belong on one row.
- Beside the studio the panel header is 48px with a bottom rule (`body[data-surface=studio] .companion-header`), so the toolbar seam runs edge to edge; the native panel keeps 44px.
- `.agent-event-detail` takes `flex:1 1 calc(100% - 64px)` so a detail always starts its own line with room for Details at the end; the spec's `flex:1 1 0;min-width:70%` let a short label share the row.
- `.live-heading strong` is Segoe UI 14/500, not upright Georgia (DESIGN.md reserves Georgia for the italic display line).
- The F6 handler picks the first control with `offsetParent !== null`; the spec's selector matched a button inside a hidden wrapper. verify-browser walks the four panes.

## Appendix B — Champion items corrected against the code

- Ctrl+Enter submit: dropped; app.js:557 already builds on Enter and inserts a newline on Shift+Enter, matching the panel.
- Model-first Settings order: dropped; three judges showed the two mode rows are the only discovery path, and no defect stood behind the reorder.
- Auto-focus on `#agent-approve`: dropped; no focus call exists today (agent.js, computer.js) and adding one makes a held Enter approve a $485 write.
- D8 proposed `.reply{max-height:132px}` (the shipped `.reply` at style.css:146 has no height rule). It became `min-height:132px` on the strip and `max-height:min(38vh,360px)` on the new `.reply-scroll` wrapper defined in 4.2; a five-line reply plus four chips is about 270px and must not scroll on every build.
- Visible "Direction" / "Reference" pane labels: dropped in favour of `aria-label`s; the caption row (`#source-status`) and the composer already name the panes, so a visible label would be a duplicate.
- D8 asked for two panel changes that are already true: the studio column has no outer radius (the 12px radius at companion.css:4 is scoped to `body[data-surface=companion][data-native]`, so it never applies inside the studio) and the goes/running lines already share `min-height:24px` (companion.css:75). Neither is a work item; only the deck rule (P2) remains.
- `.rail{max-height:56vh}`: 60vh kept (graft 66).
- `#live-start` on a "status row": lives at the right end of `.source-controls` instead (last child, `margin-left:auto`), so the Reference pane has one control row, not two.
- "Only two class-based lookups in public/*.js": app.js also uses `.revision` (:167) and `#rail-chips .chip` (:160, the lookup; :563 only creates the chips); both survive whole-element re-parenting and are listed in section 5.
- `--chrome` and `--warn` must be declared in `style.css :root`: confirmed against verify-states.mjs:13, which scans style.css, companion.css and site/site.css only.