# Design

Navy and teal, the Practical Systems family palette (family values from `C:\Projects\Practical Systems\brand\brand.json`, adopted 2026-09-06). Cool neutrals tinted toward hue 224, one teal accent used for exactly three things: the primary button, the thing under the cursor, and the follow border; the mark is no longer one of them, since the node is white. Dark is not a style choice here; the companion floats over other people's windows and a dark surface recedes. It should read as an instrument, not a lamp.

## Colors

| Token | Value | Use |
| --- | --- | --- |
| `--bg` | `#171D2D` Navy (app) / `#171D2D` (site) | Body |
| `--panel` | `#1F2638` / `#12172A` | Raised surfaces, inputs |
| `--line` | `#2C3549` / `#303A50` | 1px rules and borders |
| `--ink` | `#F8FAFC` Snow | Body text |
| `--muted` | `#A3ADBD` / `#B3BCCA` | Secondary text. 7:1+ on the app body, 4.5:1+ on the site body |
| `--accent` | `#2DD4A8` Teal | The accent. Hover `--accent-hover` `#4EE0B8`. Text on it is `--on-accent` `#0B1F1A` |
| `--paper` | `#F8FAFC` | Prototype preview background |
| `--chrome` | `#D7DAE3` | The one grey for both preview bars. Text on it: `#3A4256` primary, `#4A5470` secondary, `#252A36` the active viewport |
| `--green` | `#10B981` Emerald | Ready state only |
| `--warn` | `#F2B49E` | Errors, paused breakers, warn dots, an unverified outcome |
| `--hub` | `#FFFFFF` | The mark's hexagon |

The long tail of studio shades in `style.css` was retinted by rule (hue 200 shades moved to hue 224 at the same lightness), so every surface keeps its relative depth. No gradients on text. No side-stripe borders (`border-left` accents). Grey text never sits on the accent; use `--on-accent`. The dock button (`desktop/SidelookMark.cs`), the exe icon (`scripts/build-icon.ps1`) and the WebView backdrop carry the same two values: Navy `23,29,45` and Teal `45,212,168`.

## Mark

One node of the Practical Systems mark. On a 64 grid: a rounded square of Navy (radius 14) when the mark needs a background (exe icon, favicon, OG card); a pointy-top white hexagon, circumradius 22, centred at (32,32), vertices (32,10) (51,21) (51,43) (32,54) (13,43) (13,21); two Navy eyes, radius 3.6, home centres (26,32) and (38,32), maximum travel 5 units in any direction. Static renders freeze the eyes 5 units right, at (31,32) and (43,32): the sidelong look is the name. The eyes follow the cursor in the dock and the page header (`public/eyes.js`, `SidelookMark.EyeOffset`); static renders look right. Sources of truth: `public/mark.svg`, `desktop/SidelookMark.cs`, `scripts/build-icon.ps1`; `npm run verify:mark` and `verify:states` check they agree.

## Typography

- App: Segoe UI 14/1.55 for body, Georgia for the occasional italic display line.
- Plus Jakarta Sans 700 for the lowercase wordmark on the site (self-hosted), Segoe UI Semibold for it in the app.
- Site: Georgia 17/1.65 body, Segoe UI for controls, captions and labels. Headings weight 400, letter-spacing no tighter than -0.03em, `text-wrap: balance`.
- Scale steps at least 1.25 apart. Uppercase is for short labels under four words, never for sentences, never as a per-section eyebrow.

## Spacing and layout

Site max width 1360px with 48px gutters (24px under 900px). Section padding 56-80px, one dominant idea per section. Two-column grids collapse to one at 900px; the walkthrough tabs go 4-up to 2-up at 620px. The studio is three welded regions (a 48px toolbar, the panes, a 64px versions deck) whose 1px seams run edge to edge with no shell padding; 16px page gutters appear only at 900px and below.

Radius means a thing floats. 0 is welded: the studio panes, their seams, the deck, the viewfinder, the starters and the rule-separated steps in Computer mode. 3 is a tag or a tile, 5 a field or a button, 6 an artifact or a block of evidence, 8 a dialog or the expanded stage, 9 to 12 the things that hover: decision cards, message bubbles, the panel itself. 999 is a pill. The only rounded thing inside the studio is the artifact.

## Motion

Ease-out only (`cubic-bezier(.22,1,.36,1)`), 150-300ms. Motion signals state (building, listening, scanning), never decoration. Every animation has a `prefers-reduced-motion` alternative. Summon fades in over 150 ms, dismiss out over 120 ms.

## The panel

Borderless, 440 wide, as tall as its content: the page posts its height and the shell moves the top edge with the bottom pinned. Empty over a window it is about 380px. Header 44px: the mark (the drag handle), the sensor line, Settings, dock; no wordmark. The window Sidelook will look at is a tile (28px app icon or the app's initial on `#2B3448`, title in ink 14px/500, app name muted 12px); mid-conversation the tile is one 12px muted line above the box with the app name in ink. Starters are three lines of 14px on 1px rules, no arrows, no cards. Your messages are bubbles on the right (`--panel`, 1px `--line`, radius 10/10/2/10) with the sent frame as a 40×28 thumbnail inside; Sidelook's replies are plain text. No name labels. The box is a 12px-radius field, one 21px line at rest, eight at most before it scrolls inside, with a grip in the corner. Screenshot and Mic are 16px icons; Send is the teal ↑ alone with only words, and "Send with screenshot ↑" with a chip. The line under the box is the model in ink and "may use paid credits" when it applies, and What goes.

## Components

- Buttons: `.button.amber` primary (the class name is historical; it paints `--accent` with `--on-accent` text), `.button.secondary` (raised navy), `.quiet` text buttons. Labels are verb plus object.
- Cards are avoided. Lists with 1px rules, definition lists and figures with captions carry the content.
- Screenshots are evidence: captured from the real app, captioned with what they are and what they are not.
