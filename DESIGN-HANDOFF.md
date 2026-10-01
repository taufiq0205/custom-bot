# Design handoff: visual and developer configuration

## Assignment

Redesign and improve `prototype-configuration.html` to feel like Dify's workflow editor. Deliver a usable, visually verified throwaway prototype for the user to review. The user will return to the original Wayfinder discussion and close the decision only after validating the design.

Work in `/Users/mtaufiq456/Documents/personal/projects/custom-bot`. Keep communication extremely concise. Prefer plain HTML/CSS/JavaScript and the existing single file; introduce dependencies only if they solve a concrete limitation.

## Read first

- [Current prototype](./prototype-configuration.html): self-contained HTML with in-memory state. Double-click to run; reload resets everything. `?check=1` runs a small embedded validation check when opened through a URL.
- [Domain glossary](./CONTEXT.md): use Operator, Business, Owner, Support, Customer memory, Configuration draft, and Execution trace consistently.
- [Prototype the visual and developer configuration views](https://github.com/taufiq0205/custom-bot/issues/7): open decision, claimed by `taufiq0205` during this discussion.
- [Plan the customizable customer-service agent platform](https://github.com/taufiq0205/custom-bot/issues/1): canonical planning map. Refresh live issue state if needed; this handoff is dated 2026-10-01.
- [Define agent and workflow execution behavior](https://github.com/taufiq0205/custom-bot/issues/3#issuecomment-5924018922): accepted execution/publication rules if a redesign affects behavior.
- [Dify workflow reference](https://docs.dify.ai/en/guides/application-orchestrate/creating-an-application): canvas, node settings, test run, and publication. Inspect current official screenshots or the real interface before claiming visual similarity.

## Decisions already accepted by the user

1. JSON represents all supported agent, action, and workflow settings. The visual builder and developer view edit the same configuration. Supported JSON graph changes update the visual graph; neither view silently drops fields. Arbitrary code execution remains outside scope.
2. Preserve invalid edits. Block visual switching and publication until corrected or explicitly discarded. Formatting may normalize after visual edits; preserve meaning and values.
3. Configuration and developer traces are Owner-only. Traces are read-only and redact sensitive values. Respect reduced-motion preferences.
4. Workflow editing uses a draggable canvas, node settings, and explicit connections.
5. Reject stale saves/publications, preserve local edits, and offer reload or comparison when another Owner changes the version.
6. Selecting a trace step locates its workflow node or JSON section without changing configuration.
7. The user requested a Dify-style design overhaul after accepting these choices. The resulting design has **not** been validated by the user.

Keep explicit draft publication and conversation version pinning: existing conversations retain their starting published version; new conversations use the latest. Current permissions and revocations always override pinning.

## What exists, and its limits

The file has an app sidebar, toolbar, dotted canvas, SVG connections, draggable nodes, settings inspector, JSON editor, simulated test drawer, guided scenarios, and simulated publication conflicts. Main functions are `validate`, `render`, `drawGraph`, `renderInspector`, `editText`, `publish`, `simulate`, and `locateStep`.

Everything is simulated. There is no backend, persistence, real authorization, API call, model invocation, credential store, or actual multi-operator concurrency. The role selector previews visibility; it is not a security implementation.

The example contains one agent, one knowledge source, one GET action, and five step types: retrieval, condition, HTTP, agent, and handoff. Agent/model/action structure remains partly fixed in validation; this is a prototype limitation, not a product decision limiting future configuration. The test runner follows edited graph connections with fixtures and a 20-step ceiling; it is not the full runtime specified by the execution decision.

## Improve these areas

- Make the composition, typography, spacing, node hierarchy, controls, and panel transitions convincingly Dify-like while retaining this product's labels and behavior.
- Replace the browser `prompt` for adding nodes with an accessible picker. Improve connection editing; branches currently have unlabeled SVG curves and settings dropdowns.
- Make dragging and keyboard movement reliable. Connections currently redraw after a drag finishes; node rerenders can lose keyboard focus. Check pointer cancellation and narrow screens.
- Review deletion behavior: it currently redirects incoming links to the first remaining node automatically. Make consequences explicit and prevent surprising graph changes.
- Improve JSON navigation and errors. Trace selection currently searches text for a matching ID; editor focus/scrolling and invalid-text cases need real browser checks.
- Improve conflict comparison. The current “Keep local edits” action advances the base version; it does not merge changes. Clearly explain any replacement of newer remote values and preserve the user's draft until they choose.
- Verify that version-specific trace inspection cannot suggest an old run executed the current draft. Missing nodes from older versions should remain understandable.
- Review responsive access controls: the role selector currently lives in a sidebar hidden on small screens. Distinguish decorative navigation from working prototype controls.

These are improvement targets from code inspection, not claims that every issue was reproduced in a browser.

## Validation and delivery

1. Preserve agreed behavior while redesigning. Keep all execution and publications local fixtures.
2. Run the page in a real browser. Check desktop and narrow layouts, keyboard focus, reduced motion, scrolling, node selection/dragging, and inspector/test drawer overlap. Capture screenshots of both views and relevant error states.
3. Exercise visual → JSON → visual edits; graph changes in both directions; invalid JSON retention/discard; dangling connections; publication pinning; stale publication rejection and comparison; trace navigation without mutation; and Support visibility. Verify checks against the final file.
4. Report exactly what passed and what remains unverified. Previous checks ran under Node with a mocked DOM: round-trip preservation, invalid text, graph references, serialized positions, conflicts, version pinning, trace immutability, edited routing, and failure handoff passed. The browser screenshot tool returned blank captures, so the redesign's appearance and native interactions remain unverified. No screenshot artifact was saved.
5. Deliver the improved file, screenshots, and a concise review guide. Stop for the user's design validation.

Keep the Wayfinder decision open. Do not post a resolution, close the ticket/map, advance to specifications or implementation, deploy, or push a prototype branch during this design handoff. No prototype branch has been captured yet; the original Wayfinder session will handle resolution and artifact capture after validation.
