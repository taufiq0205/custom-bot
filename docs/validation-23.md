# Issue #23: Consented Customer memory

Synthetic external provider fixtures establish platform behavior, not real provider access or measured AI quality.

## Scope and controls

Customer and Operator memory APIs, website-widget and inbox controls, PostgreSQL persistence and durable post-turn extraction. Consent is granted only by the currently verified Customer after disclosure, from the current linked conversation. Operator corrections preserve the Customer confirmation and expiry; Customer corrections explicitly reconfirm. Consent epochs, control revisions, source boundaries, conversation control generation, live session validity and per-operation provider permission defeat late results. Disable/delete remove active values and prevent older-source regeneration. Expired values are excluded immediately and pruned by the worker.

The extractor transfers only eligible completed automated Customer statements from the current conversation (latest 20), with no assistant, Operator, knowledge or API output. First opt-in permits the current linked conversation's completed automated statements; renewed consent, correction, deletion and takeover establish a new source boundary. Other past history and human turns are never mined. Durable extraction jobs reference the completed turn, retain its 60-second deadline, and count provider attempts against its 3-call limit. Failure is visible while completed ordinary service remains available.

Conservative validation requires a literal explicit statement and matching source/value. Supported forms include `Please call me Ada`, `I prefer Malay`, `I prefer brief replies`, `I am interested in photobooks`. Language and style use finite permitted values; product interests use common non-sensitive product categories. Unsupported or ambiguous output is rejected or clarified, never guessed. This deliberately limits paraphrase recall; it does not claim measured model quality. Current matching explicit statements override saved preferences before generation; alternative or ambiguous current statements omit that preference and require clarification; unrelated product interests are omitted. Memory never changes action authorization.

## Reproduce

Requires `.env`, locked npm dependencies, Docker and Playwright Chromium. Uses synthetic external HTTPS fixtures with the production provider endpoints and real local PostgreSQL/job transitions; no real provider account is reached.

```sh
npm run typecheck
docker compose -f compose.yaml -f compose.test.yaml up --build -d --wait
node --test tests/memory.test.mjs
npm test
git diff --check
```

This run uses an isolated worktree `/tmp/custom-bot-issue23`, Compose project `custom-bot-issue23`, app 3113, Mailpit 8133, fixture 3193. Local-only port overrides in `compose.test.yaml` are excluded from the commit. Commands set `COMPOSE_PROJECT_NAME=custom-bot-issue23 APP_URL=http://localhost:3113 MAIL_URL=http://localhost:8133 FIXTURE_URL=http://localhost:3193 FIXTURE_PORT=3193`.

The original checkout concurrently contains paused, uncommitted issue #22 website code, including `013-websites.sql`; the shared database had both website and memory migrations applied. Those changes are excluded from this issue's commit and from the isolated validation images/database. Memory migration filenames remain `013-memory.sql`, `014-memory-clock.sql`, `015-memory-control.sql`, `016-memory-revisions.sql`; migration discovery orders complete filenames, so distinct filenames with the same numeric prefix do not collide. Do not rename an already-applied migration without handling its recorded checksum.

## Environment

2026-10-04: macOS arm64/OrbStack; Docker Engine 29.4.0 arm64, Compose 5.1.2, Node 22.22.3, TypeScript 7.0.2, Playwright 1.63.0 Chromium. Pinned Python 3.14.6 and PostgreSQL 17/pgvector 0.8.2 images. No new dependencies.

## Evidence

Focused regression: 18 groups passed, zero failed/skipped, 56.28 seconds, before the final ambiguity/action-retry refinements. Final full suite: 81 groups passed, zero failed/cancelled/skipped, 1,617.00 seconds (26m57s), including all 19 memory groups and Docker restart/readiness checks. `npm run typecheck` and `git diff --check` passed. Root staging was checked: all 16 staged files exactly match the isolated issue #23 sources; website changes remain unstaged.

| Acceptance criterion | Runnable evidence in `tests/memory.test.mjs` |
| --- | --- |
| Disclosure; only currently verified Customer opts in | Consent group and old-conversation/malformed-controls group; desktop/mobile Customer journeys |
| No memory without consent; only current linked conversation eligible | Boundary group: old anonymous conversation excluded, current pre-opt-in completed automated statements eligible; same-Customer/new-conversation and Business/Customer isolation |
| Explicit validated extraction only after completed automated turns | Explicit/preferences groups cover name, accented name, language, style and product interest; four invalid/sensitive/fabricated-output cases rejected with visible failure; provider transfers contain Customer statements only |
| Current statements, ambiguity, relevant isolated data, no action authority | Current-name override; unrelated interest filtering; false clarification flag and alternative-name tests; system contract and unchanged central action authorization |
| Customer/Operator corrections preserve provenance and confirmation clock | Support inspection/correction and attribution, outsider/revoked membership denial, two independent racing correction requests, 89/90-day clock checks |
| Races/human control/outage | Six held-extraction races (correction, disable, delete, takeover, provider revocation, logout); renewal and delete source boundaries; human messages excluded after resume; newer-statement/ordinary-background-save regressions; storage and mid-generation outages, intermediate-context removal, restart with interrupted extraction visibly failed and never replayed |

## Independent code review

Standards and Spec reviews ran separately against base `8865f88`. Findings were corrected: separate control/display revisions; discard delayed older extraction after newer statements; independently identify ambiguous alternatives; recover memory outages without cached/intermediate personalization; prohibit action replay during ordinary retry. Final independent Standards and Spec reviews: zero actionable findings. Preference validators remain independent at the API and worker boundaries; accented-name acceptance is consistent and exercised.

## Integration limits

No real DeepSeek/Qwen account, hosted deployment, production-data quality, off-host recovery or device/cache claims are established by these fixture runs. Extraction intentionally favors validated literal forms over broad paraphrase recall. History deletion/backup-ledger enforcement is the separate #24 slice; memory source references are Business-constrained and deletion-cascading.
