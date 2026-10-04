# Issue #25: Visual workflow editing

Environment (2026-10-04):
- macOS 27.0.1 arm64 with OrbStack.
- Node 22.22.3 and Docker Compose 5.1.2.
- PostgreSQL 17 (repository-pinned image).
- TypeScript 7.0.2, and Playwright 1.63.0 with Chromium.

The branch includes `main` at #20 (merge `9be9487`). The suite therefore covers the action, credential and lookup tests too.

## Reproduce

Requires this project's `.env`, free loopback ports 3100/8025/3199, and locked npm dependencies. Use disposable local test data. No cloud credentials are used.

```sh
npm ci --ignore-scripts
npm run typecheck
docker compose -f compose.yaml -f compose.test.yaml up --build -d --wait
node --test tests/browser.test.mjs          # 7 journeys
npm test
```

Use the test overlay and the default fixture port. A stack started without `compose.test.yaml`, or with the fixture on another port, sends the tests' fixture scripting to a different fixture than the worker calls. That explains the earlier run's 8 workflow failures (see Results).

## Design: the validated prototype shell

The whole Operator app follows `prototype-configuration.html`, reusing its tokens, typography and components:
- **Shell:** a dark icon rail and a dark top bar (breadcrumb Business / view), with a status bar at the bottom.
- **Views:** Businesses, Configuration, Team and website, Inbox and Account are separate views reached from the rail.
  - Signed out, only Account is shown, and the rail is hidden.
  - Configuration and Team and website are enabled only after an Owner selects **Manage**. Support Members never get either.
  - Views change only on sign-in or sign-out, **Manage**, **Open inbox**, rail navigation, or loss of access. Saves, publishes and inbox polling never move the Operator.
- **Configuration:**
  - Full-viewport warm grey dotted canvas.
  - Workflow/JSON switch, draft state, Reload/Save/Publish in the top bar.
  - Floating zoom, Fit, Add step and Tidy bar, with the minimap above it.
  - Step settings at the top right, as a bottom sheet at ≤720 px.
  - Step colours follow the prototype.
  - Draft controls are hidden whenever no draft is loaded.
- **Not copied:** prototype-only controls (the PROTOTYPE menu, review-scenario bar, Preview chat, conflict diff dialog). They belong to other slices or would do nothing.

Screenshots were compared side by side with the prototype at 1440×900 and 390×844 (`shots/proto-*` and `shots/new-*` in the session scratchpad). Neither width overflows horizontally, and there are no page errors.

## Acceptance evidence

| Criterion | Evidence |
| --- | --- |
| Every supported field and finite position survives visual → JSON → visual edits and restart | `browser.test.mjs`, "workflow and JSON edit…". The fixture covers decision, source, agent/model, action schemas, every step type, fractional and negative positions, and branch connections. It edits each view, saves, restarts the app and deep-compares the restored document. |
| Invalid JSON/schema text stays intact and blocks visual switching and publication until repaired or discarded | Same journey, plus "Owner keeps invalid JSON…". Malformed text survives reload, Publish is disabled, and explicit discard works. An action edited to HTTP is rejected by the server, and its exact text stays in JSON until repaired. A stale save keeps local text, and Reload asks before discarding. |
| Left-to-right design: draggable live connections, labelled branches, searchable picker, pan/zoom, minimap, Tidy, settings panels | Same journey: labelled branches; pointer connection with a live pending edge; edges following a dragged node; searchable picker; pan; zoom; left-to-right Tidy; minimap panning; settings panel. **New:** in Workflow view the JSON text is not visible, and every wire ends within 3 px of its target's input port, measured on screen through the camera transform. |
| Deletion lists affected links and clears them without rerouting | Same journey: the delete dialog lists incoming links and the start step, and confirming clears them without rerouting. |
| Keyboard connections/movement, visible focus, reachable controls on narrow layouts, bottom settings panel, reduced motion | Same journey: keyboard node movement, keyboard branch connection, bottom-docked settings at 390×844, no horizontal overflow, the explicit Reduce motion toggle, and system reduced motion. |
| Support cannot obtain Owner editing access through UI or API | `configuration.test.mjs` (Owner-only API, `404` for Support). The journeys show Support has no **Manage**, no editor, and disabled Configuration and Team and website rail items. |

### Bugs fixed during the restyle (the earlier journeys missed both)

- **The JSON editor was always visible.** `.json-view{display:grid}` overrode the `hidden` attribute, so JSON showed under the canvas in Workflow view. A global `[hidden]{display:none!important}` fixes it. Two journey steps that typed into the JSON box while Workflow was selected now select JSON first.
- **Wires ended away from input ports.** Ports were measured with `getBoundingClientRect` while the camera transform was changing. They are now measured from layout offsets relative to their node, and the canvas re-measures each time the Configuration view is shown. Fit no longer zooms past 100%. The earlier fit rendered the two-step starter graph at 150%.

## Mutation checks

Each mutant was built into the app image, run against the visual-editing journey, then restored.

| Mutation | Result |
| --- | --- |
| Global `[hidden]` rule removed | Journey failed: "JSON text is hidden in the Workflow view" |
| Port metrics measured from transformed rects again | Journey failed: wire ends 220–1,139 px from their input ports |

## Results

| Run | Result |
| --- | --- |
| `npm run typecheck`; `node --check` on the changed browser scripts | pass |
| `node --test tests/browser.test.mjs` (the 7 journeys) plus the #20 inbox-lookup journey | 8/8 pass |
| Mutation checks (2 mutants) | 2/2 caught |
| `npm test`, full suite on the merged branch (2026-10-04 06:10–06:34Z, 24.3 min) | **46/46 pass, 0 failed assertions**, and no worker tracebacks |
| The "Owner keeps invalid JSON" journey re-run after adding the Support rail assertion | pass |

**The earlier run's 8 `workflow.test.mjs` failures were fixture cross-talk, not a regression.** That run used a separate Compose project whose fixture was on port 3299. The tests default to `localhost:3199`, which was another stack's fixture. The tests therefore scripted one fixture while the worker called the other, unscripted one, which answers `400 unscripted fixture request`. On the standard test stack all 9 workflow tests pass.

## Review

The earlier spec review findings (schema-invalid visual saves, keyboard connections, pan, zoom and Tidy evidence) are resolved. The standards review found no violation of repository standards. One low-priority maintainability note remains: step-type handling is repeated across validation, settings and node summaries.
