# Computer mode

Computer mode lets Sidelook work in Windows apps through their accessible controls. It's separate from the prototype builder. Every action waits for your approval, so this is not unattended or unrestricted desktop access.

It is a screen of its own inside the companion panel, entered from Settings, **Computer mode**. Once the lease is on, the screen replaces the conversation: the window, the task, the one action waiting for you, with the lease countdown at the top and **Stop control** in the footer. **Back** returns to the conversation with control still on; the line under the message box then says "Computer mode on" with an **Open** button. The companion can talk through a task and suggest Computer mode might help; its **Let Sidelook do this** button fills the task and opens the lease dialog. It can't enable control, pick a target, or change a permission. The same consent and review steps below apply.

## Use it

1. Settings, **Computer mode**. The lease dialog explains the ten minutes; allow local inspection and press **Start 10 minutes**.
2. Pick a supported window that's already open, or leave it on "Choose a window" and let the model propose opening Notepad, Calculator or Paint as its first action. The app selector opens one by hand. **Refresh** when apps change. The screen's title becomes "Sidelook in" that window.
3. **Read it** reads accessible text locally and shows it under "What Sidelook read". That includes editable values. Password controls and protected windows are excluded. Some controls are unnamed or unavailable.
4. Model and effort come from **Settings**. Describe the task and press **Plan next action**. The line under the button names the window whose fresh reading goes with the task, and **What goes** shows the body. There is no tick: the button is the consent. Planning reads the window again, so the text it sends can differ from your earlier reading, and the exact sent text comes back under "What Sidelook read".
5. Check the action, target name, type, parent, identifiers, text replacement and shortcut. **Approve** delivers one operation, reads the window back, then plans the next step so the next proposal is waiting for you. **Reject** delivers nothing and ends the loop until you press Plan next action. Every action still waits for its own Approve. A completion report is the model's read of things. Check the app yourself.
6. **Stop control**, or press **Ctrl+Shift+F12** from any app. The panel's Stop button stops it too. Closing the page also requests Stop. The native lease expires after ten minutes even if the browser drops the connection. Stop can't undo a delivered operation or refund a model request.

## What works

| Operation | Boundary |
| --- | --- |
| Read | Selected-window accessibility tree, up to 350 visible elements, depth seven, bounded names and values. No screenshot or desktop audio. |
| Click | Invoke, toggle, select or expand an accessible control. No coordinate fallback. |
| Type | Replaces the entire editable ValuePattern value, up to 2,000 characters. Command-like and multiline text is refused. |
| Scroll | Accessible scroll containers, one large up/down increment. |
| Keys | Enter, Tab, Escape, arrows, Save, Select all, Backspace and Delete, after proven target focus. |
| Focus | Requests foreground focus for the selected window. Refuses if Windows doesn't grant it. |
| Open | Fixed Windows executables or registered app IDs for Notepad, Calculator and Paint. After an approved launch the new window in the list becomes the chosen one; it is read only when the next step is planned. |

Explorer, terminals, sign-in and protected windows, password controls and address or command controls are excluded. Browser and custom app accessibility can be incomplete. Paint's accessible menus work, its drawing canvas doesn't. There's no OCR, arbitrary mouse movement, drag-and-drop, shell tool, arbitrary executable path, administrator prompt handling, or any guarantee that a given app supports these patterns.

Everything is reviewed because a UI click or key can send, purchase, delete or run code in the target app. Name and command filters are extra protection, not proof that an app is trustworthy. Sidelook is not a backend builder or a repository or deployment agent.

## Local protocol and lifecycle

`POST /api/computer` needs the normal same-origin host checks, session header and packaged desktop launch key. The Vercel website never serves it. Bodies are JSON:

| Operation | Required fields | Response |
| --- | --- | --- |
| `read` | `title`, `consent: true` | The accessible text of the one open window with that exact title, as `type: name = value` lines, with control and character counts and a `truncated` flag. Read-only: it never arms, grants no owner and cannot act. Two windows with the same title are refused. |
| `enable` | `consent: true` | Random owning-tab `owner`, expiry and fixed apps |
| `windows` | `owner` | Current window identities and titles |
| `inspect` | `owner`, `window` | Local bounded accessibility snapshot |
| `launch` | `owner`, fixed `app` | Explicit app-open result |
| `propose` | `owner`, `window`, `task`, `model`, `effort`, `consent: true` | One proposal, its exact sent snapshot and step count |
| `approve` | `owner`, proposal `id`, `consent: true` | One native result plus `observation`: one bounded local reading of the same window taken after Windows accepted the action (`available`, `summary`, the target control, what changed, the reading), or `available: false` with why. For a launch, the window list is read again until a new window appears and `launched` names it; no tree is read. Never a second action, never a model call. The ID is consumed before execution |
| `reject` | `owner` | Discards the pending proposal |
| `status` | Normal local session authentication | Armed state and step count |
| `stop` | Normal local session authentication | Revokes control across tabs |

Approvals expire after one minute. Twenty model steps per enabled session, on top of the shared local request ceiling. Subscription limits still apply. No model fallback. The model returns structured proposals only, through the existing isolated CLI. It can't execute Windows actions itself.

Before executing, the native controller re-resolves the control and checks window and process identity, title, runtime ID, AutomationId, type, name, parent context, visibility, enabled and password state, and a fingerprint of accessible value, toggle, selection and expansion state. A changed control needs a new proposal. Focus-sensitive keys are checked again after focus. None of this makes arbitrary external apps transactional. An action Windows has already accepted may finish after Stop.

The panel's text-first starters (errors, spreadsheets, settings, documents) use `read`. It reads `ValuePattern` values only, so dialogs, forms, tables, settings pages and Excel's formula bar read well; Word and browser page bodies come back as ribbons and chrome until a `TextPattern` branch exists, and terminals are excluded by the helper's filter, so those families take a screenshot instead. Every character is shown in the box with a count and the truncation flag before Send can carry it, capped at 20,000 characters.

The helper is a per-session child process with no elevation. It registers the global stop shortcut before arming, and starting it for a read registers that shortcut too; a read still cannot act. A hotkey event aborts inference and kills the owned helper through the broker. Action history and proposals live in memory and clear on a new session. They are never saved as prototype versions. Malicious local processes under the same user are outside the security boundary.

In the packaged app, fixed app-open requests go to the desktop launcher through instance-specific events. The apps you open start outside the server's shutdown process group, so quitting Sidelook leaves them and their unsaved work open. Inference and controller processes stay inside the shutdown group.

## Verification

- Unit tests cover owning-tab authorization, consent, single-use approvals, expiry, unsupported actions, emergency-stop state, cancellation during inference, and the read-back after Approve: one reading of the same window, a reading that fails without replaying the action, no reading after a launch, and summaries that state the target value or the diff without claiming success.
- Browser verification covers Set it up from Settings, the lease dialog, the screen replacing the conversation with no tick or details arrow anywhere on it, model and effort from Settings, reading, the plain-words review with references behind Details, approve with the local read-back shown apart from "Windows accepted", an unavailable read-back without replay, reject, Back and Open with the lease kept, Stop and mobile rendering with a synthetic planner.
- Native verification opens its own compiled WinForms fixture, replaces text, clicks a button, checks the title, rejects stale context, value and targets, and fires the real global shortcut.
- A real Fable/low browser-to-native test completed three model steps and two reviewed actions in about 25 seconds. That was a synthetic fixture, not a promise about speed or compatibility in every app.

DeskClaw informed the guarded accessibility approach. Sidelook's controller lives in this repo and doesn't depend on a user's private harness, a DeskClaw install, or global state files.
