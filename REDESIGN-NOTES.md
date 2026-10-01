# Redesign notes: visual and developer configuration prototype

Dated 2026-10-01. This follows [DESIGN-HANDOFF.md](./DESIGN-HANDOFF.md). The user formally validated the design in the original Wayfinder discussion: "Validated the design: REDESIGN-NOTES.md and screenshots". These notes and screenshots are the accepted design evidence for [Prototype the visual and developer configuration views](https://github.com/taufiq0205/custom-bot/issues/7). The earlier hold on resolution and artifact capture is superseded by that validation. Application implementation and deployment remain separate work.

## Files

| File | What it is |
|---|---|
| `prototype-configuration.html` | The redesigned prototype. One self-contained file with no dependencies and no web fonts; it opens by double-click. `?check=1` runs the built-in checks. |
| `screenshots/01–21-*.png` | Browser captures of the final file (list below). |
| `REDESIGN-NOTES.md` | This file. |

## User decisions made in this session

1. **Look:** a dark ("ink") top bar and icon rail, a warm light-grey canvas, a deep-teal accent (`#0c7166`), and system sans-serif and monospace fonts. It is deliberately not Dify's blue.
2. **Flow direction:** left to right (the user rejected top to bottom).
3. **Test run:** a chat simulator that shows a trace under each reply (it replaced the old trace-list drawer).
4. **Extras in scope:** drag-to-connect with edge labels, a step picker (`/` or ⌘K), a minimap with zoom controls, and safe delete.

**Deviation from my own proposal:** I proposed opening node settings in a card floating next to the selected node. I built a card pinned to the top-right of the canvas instead; on screens ≤720px it becomes a panel at the bottom. This was reported to the user.

## Bugs the user reported (fixed)

- **Wires didn't follow a dragged node.** Root cause: `drawGraph()` drew the wires once, and the drag handler only moved the node's `left`/`top`. Now `drawWires()` runs on every `pointermove`, using `live` (temporary positions during a drag) layered over `draft.workflow.positions`. The draft is updated on `pointerup`. `pointercancel` puts the node back and leaves the draft unchanged.
- **The canvas wasn't infinite.** Root cause: a fixed 1050×760 `#canvas`, plus `0–800 / 0–600` limits in `moveStep`, the drag handler, and `validate`. Now a camera `{x,y,k}` applies a CSS transform to `#world`, and the dot grid follows through `background-size` and `background-position`. All limits are removed: `validate` only requires finite numbers, and negative coordinates are valid.

## What was built (by area)

### Canvas (`/* ---------- canvas ---------- */`)
- **Pan:** drag empty space, or use the wheel or trackpad scroll.
- **Zoom:** ⌘/Ctrl + wheel, with a capped delta, centred on the cursor; range 25–200%. There are also −/+ buttons, a percentage label, and Fit.
- **Fit view:** fits the graph into the visible area, excluding the settings card when it is docked on the right. It never zooms below 50%; if the graph doesn't fit, it shows the start of the flow instead.
- **Minimap:** an SVG in the bottom-left. Click or drag it to move the view.
- **Snap:** nodes snap to a 20px grid while dragging; Alt places them freely.
- **Node cards:**
  - A coloured stripe for the step type, a mono type label, the title and a detail line.
  - A `START` badge on the entry step.
  - One labelled row per output, each with its own port.
  - Unconnected outputs show red with a dashed port.
- **Edges:** solid teal for Next/Yes, dashed grey for Else, dotted rose for failure/unsupported. Branch edges carry a mono label at the midpoint, and an invisible wide stroke makes them easy to hit.
- **Connections:**
  - Drag a port to a node to connect; the node under the pointer is highlighted as a drop target.
  - Drop on empty canvas to open the picker; the new step is placed at the drop point and connected.
  - Click a port without dragging to insert a step after it. The new step's first output carries over the old target.
- **Edge selection:** click a line, then press Delete/Backspace or the "✕ Disconnect" button. The output becomes `null`.
- **Keyboard on a focused node:**
  - Enter/Space opens its settings.
  - Arrows move it 20px (Shift: 100px).
  - Delete opens the delete dialog.
  - Esc clears the selection.
  - Focus survives re-renders (`data-focus-key` is restored in `render()`). Tabbing to an off-screen node moves the camera to it (`focusin` handler).
- **Tidy:** places each step one column after its furthest parent, so there are no backward edges. A condition's second branch drops one row. Loops are capped at one pass per step, and unreachable steps go in a final column.
- **New-step placement:** a step that would overlap an existing one is moved down 160px until clear. This doesn't apply when you dropped it on a chosen spot.

### Graph model changes (affect JSON)
- **`null` link means "deliberately unconnected".** This applies to `next`/`yes`/`fallback`/`failure`/`unsupported` and to `workflow.entry`. It is structurally valid (the visual view still works) but appears in `blockers()`, which disables Publish and shows the "⚠ N to fix" warning in the top bar. A link to a step ID that doesn't exist is still a validation error: it blocks switching to the workflow view, and the text is preserved.
- **New steps start with all outputs `null`.** The old behaviour pointed them at the first step.
- **Delete never reroutes.** The dialog lists each incoming connection (and the entry) that will become `null`, and the status line reports the count.

### Settings card (inspector)
- **Fields by step type:**
  - Every step: Step ID (read-only) and "Make this the start step" (or the START badge).
  - Condition: field/equals.
  - Knowledge and agent: knowledge source.
  - Agent: name and instructions.
  - HTTP: endpoint plus the credential note.
  - Handoff: a note.
- **Outputs:** one select per output, with a "— unconnected —" option. This is the keyboard-accessible way to edit connections.
- **Delete step…** opens the delete dialog.

### Step picker (`#picker` dialog)
- A native `<dialog>` with a search box and the five step types.
- Keys: ↑/↓ move, Enter adds the first match, Esc closes.
- Opened by `/`, ⌘K/Ctrl+K, "＋ Add step", or clicking or dropping a port.

### JSON view (`#developer`)
- A line-number gutter that scrolls with the editor.
- A section list (top-level keys plus each step), built by regex over the raw text so it still works while the JSON is invalid. It assumes 2-space indentation.
- An error box with "Go to error", which parses `position N` from the parse error, and "Discard invalid text".
- `render()` doesn't rewrite the textarea while it has focus, so the caret and scroll position stay put.

### Publication and conflicts
- **`basePublished`** is a new snapshot of the version the draft is based on. `dirty()` now compares against it, so another Owner publishing doesn't make an untouched draft look edited.
- **Stale publish** is rejected and opens `#conflictDialog`. It is a three-way table, built by `flat()`/`diff3()`, with columns: base vN | your draft | latest vM | changed by. Fields changed on both sides show a rose row, the remote value struck through, and a note naming the fields whose newer values yours will replace. Arrays such as `workflow.steps` are compared as whole values.
- **Actions:**
  - "Apply my changes onto vM": `merge()` starts from the remote and applies local changes, then the result goes through `editText` and the base is updated. It is disabled while the JSON is invalid.
  - "Discard my draft, load vM": needs two clicks.
  - "Decide later": closes the dialog. The draft is untouched and a "vM published elsewhere · Compare" button stays in the top bar.

### Preview chat (`#testPanel`)
- Customer and agent bubbles, plus system messages for handoff and pause.
- Preset customer messages: "Any update on PB-1042?", "Order API times out", "Can I talk to a person?". "↻ New chat" starts a conversation pinned to the latest published version.
- Each agent reply shows the agent name and version from the **pinned** config, and a collapsible trace. Trace steps are buttons with "locate" or "not in draft" tags, followed by the redacted rows.
- A note appears when the conversation is pinned to an older version or the draft differs from what ran.
- Locating a step selects it and centres it, or jumps to it in the JSON view. It never changes the configuration, and the status line says which version actually ran. On screens ≤720px the chat closes so the step is visible.
- Visited nodes pulse in sequence; this is disabled under reduced motion.
- The simulation logic and the 20-step limit are unchanged from the original.

### Shell and access
- The breadcrumb and the Workflow/JSON switch sit in the dark top bar.
- The **PROTOTYPE ▾** menu holds the role preview, reduced motion, "Simulate another Owner publishing" and Reset. It works on narrow screens.
- The icon rail is decorative (`aria-hidden`).
- The status bar at the bottom shows the live status (`role=status`) and the walkthrough buttons.
- Support role: configuration, JSON, chat and Publish are hidden, and a restricted message is shown.
- Reduced motion: honours `prefers-reduced-motion` and the menu checkbox (the `.reduce-motion` class).
- Responsive layout:
  - ≤1000px: the chat overlays the canvas and the settings card moves left of it.
  - ≤720px: the rail and minimap are hidden, settings become a bottom panel, the JSON section list becomes a horizontal row, and the chat is full width.

### Walkthroughs
- These four are unchanged: `roundtrip`, `invalid`, `publication`, `access`. The Access text now points to PROTOTYPE ▾ for switching back to Owner.
- **New `conflict`:** edit the name and instructions locally → another Owner publishes v2 → publish is rejected and the dialog shows one clashing row and one clean row → apply your changes and publish v3.

### `?check=1` assertions
- A supported edit is accepted.
- An authorization bypass is rejected.
- A `null` output is valid but appears in `blockers()`.
- Far-away positions are valid.
- `merge()` keeps both a remote and a local change.

## Verification

Run in headless Brave via puppeteer-core. The harness was in the session scratchpad and is **not** saved in the repo.

**Passed:**
- Wires move during a drag; the draft only changes on drop.
- Pan, wheel zoom, button zoom, minimap click.
- Drag cancel on emulated touch puts the node back.
- Keyboard moves keep focus. Tabbing to an off-screen node moves the camera.
- Drag-to-connect, including the drop-target highlight.
- Edge selection, with both Delete and the Disconnect button.
- Port-click insert, including the carried-over target.
- Drop on empty canvas, then the picker.
- `/` shortcut, picker arrow keys and Esc.
- Delete dialog contents and the count in the status line.
- Tidy.
- JSON → graph edits: a changed link, a `null` link, a link to a missing step.
- Typing invalid JSON, Go to error, switching to the workflow view blocked, discard.
- Section-list jumps.
- All five walkthroughs.
- Same-field conflict, Decide later, the two-click discard.
- Pinning: a v1 conversation keeps the v1 agent name after v2 is published.
- Locating a deleted step shows "not in draft" and changes nothing.
- API-timeout path to handoff, then the paused message.
- Support visibility.
- No sideways overflow at 390px; the role control is reachable.
- No settings/chat overlap at 900px.
- No page errors.

**Not verified:** trackpad pinch zoom; touch on a real device. The pulse animation was only confirmed through computed styles plus one screenshot.

## Known limits and next candidates
- Prototype limits carried over from the handoff: one agent and one GET action, fixed agent/action structure in `validate`, everything simulated, and the role selector is not security.
- **Settings card:** pinned to the top-right rather than anchored to the selected node. Revisit if the user wants the floating version.
- **Merge:** compares arrays as whole values, so concurrent edits to `workflow.steps` merge "yours wins" at array level.
- **Tidy:** a simple heuristic. Use a layout engine (dagre or elk) if graphs grow.
- **No undo/redo, multi-select, copy/paste, or auto-pan while dragging near the edge.**
- **Touch:** pinch-to-zoom isn't implemented; touch can pan and drag only.
- **Section list:** assumes 2-space indentation at the top level.

## Screenshots (`screenshots/`)
- `01-workflow-desktop.png`: default canvas.
- `02-json-invalid-blocked.png`: invalid JSON blocking the switch to the workflow view.
- `03-json-error-goto.png`: syntax error with "Go to error".
- `04-json-view.png`: JSON view with the section list.
- `05-chat-pinned-v1.png`: conversation pinned to v1 after v2 was published.
- `06-conflict-dialog.png`: conflict with one clashing and one clean field.
- `07-support-role.png`: Support role.
- `08-node-settings.png`: settings card for a condition step.
- `09-trace-old-version.png`: trace step marked "not in draft".
- `10-narrow-workflow.png`: 390px workflow view.
- `11-narrow-settings.png`: 390px settings panel.
- `12-narrow-prototype-menu.png`: 390px PROTOTYPE menu.
- `13-narrow-chat.png`: 390px chat.
- `14-narrow-json.png`: 390px JSON view.
- `15-mid-drag-wires-follow.png`: wires following a node mid-drag.
- `16-drag-to-connect.png`: drag-to-connect with the drop target highlighted.
- `17-safe-delete.png`: delete dialog.
- `18-step-picker.png`: step picker.
- `19-tidy.png`: layout after Tidy.
- `20-run-pulse.png`: visited nodes pulsing during a run.
- `21-900px-settings-and-chat.png`: settings card and chat at 900px.
