# Issue #25: Visual workflow editing

Environment (2026-10-04): Node 22.22.3, npm 10.9.8, TypeScript 7.0.2, Playwright 1.63.0 / Chromium, Docker Compose 5.1.2, PostgreSQL 17. The test stack used an isolated Compose project, app port 3110, and Mailpit port 8125 so it did not contend with the other issue branch's app and Mailpit ports.

## Reproduce

Requires locked npm dependencies, Chromium, and this project's test Compose services. Use a disposable local test database. The focused browser journeys use public application APIs and real PostgreSQL state; provider calls are not part of the visual editor gate.

```sh
npm run typecheck
COMPOSE_PROJECT_NAME=custom-bot-issue25 APP_URL=http://localhost:3110 docker compose -f compose.yaml -f /private/tmp/compose.issue25.override.yaml --profile local up --build -d --wait
COMPOSE_PROJECT_NAME=custom-bot-issue25 APP_URL=http://localhost:3110 MAIL_URL=http://localhost:8125 node --test --test-name-pattern='Owner keeps invalid JSON|workflow and JSON edit' tests/browser.test.mjs
```

The temporary ports override was:

```yaml
services:
  app:
    ports: !override [127.0.0.1:3110:3000]
  mail:
    ports: !override [127.0.0.1:8125:8025]
```

## Acceptance evidence

| Criterion | Evidence |
| --- | --- |
| Workflow and JSON edit one persisted configuration; every supported field and finite step position survive restart | `browser.test.mjs`, “workflow and JSON edit…”: fixture covers decision, source, agent/model, action schemas, every step type, fractional/negative positions and branch connections; edits each view, saves, restarts the app, and deep-compares the restored document. |
| Invalid JSON and schema errors remain repairable and cannot publish | Browser journey saves malformed JSON across reload, verifies Publish disabled and explicitly discards it. A visual HTTPS action edited to HTTP is server-rejected; the exact text remains visible in JSON, then repairs and returns to Workflow. Syntactically valid malformed shapes do not crash the editor. |
| Canvas, links, settings and keyboard access | Browser journey verifies labelled branches, pointer connection with a live pending edge, connected edge movement during node drag, keyboard node movement and settings, keyboard branch connection, searchable picker, pan, zoom scale change, left-to-right Tidy positions, minimap movement, and safe deletion that clears incoming links without rerouting. |
| Narrow layout and reduced motion | Same browser journey checks bottom-docked settings at 390×844, no horizontal overflow, explicit reduced-motion toggle, and system reduced-motion styling. |
| Owner/Support boundary | Owner-only configuration APIs are covered by `configuration.test.mjs`; browser journey confirms Support sees no management button or editor. |

## Results

| Run | Result |
| --- | --- |
| `npm run typecheck` | Pass |
| `node --check` for changed browser scripts/tests; `git diff --check` | Pass |
| Focused browser journeys (2) against isolated Docker stack | 2 passed, 0 failed; includes app restart and public API-backed persistence. |
| `npm test` full suite (39 tests; 901.7 s) | 31 passed, 8 failed. All 8 failures were in `workflow.test.mjs` provider-backed execution cases. The recorded assertions show provider HTTP 400 responses and resulting automatic handoffs; this change does not modify the worker or provider adapter. These failures remain unverified against base `main` and are not counted as passes. API, configuration, browser, chat, identity, inbox, membership, and runtime tests passed in this run. |

## Review

Spec review findings for schema-invalid visual saves, keyboard connections, pan, zoom, and Tidy evidence are resolved; the focused browser gate passed afterward. Standards review found no repository-standard violation; it noted a low-priority maintainability smell because step-type handling appears in validation, settings, and node summaries. This remains a non-blocking organization concern.
