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

The fixture runs above establish no real provider access, hosted deployment, production-data quality, off-host recovery or device/cache claims. The separate real DeepSeek run below establishes only its recorded synthetic integration outcomes; Qwen remains unverified. Extraction intentionally favors validated literal forms over broad paraphrase recall. History deletion/backup-ledger enforcement is the separate #24 slice; memory source references are Business-constrained and deletion-cascading.


## Real integration run

**Overall: FAIL — communication-style extraction did not save. Push and merge remain pending explicit user confirmation.** No implementation change or fixture response was used to make this run pass.

2026-10-04, isolated worktree `/tmp/custom-bot-issue23`, implementation commit `06ebd64`, Compose project `custom-bot-issue23`. The successful connected startup used:

```sh
COMPOSE_PROJECT_NAME=custom-bot-issue23 APP_URL=http://localhost:3113   docker compose -f compose.yaml -f compose.connected.yaml up -d --wait
COMPOSE_PROJECT_NAME=custom-bot-issue23 APP_URL=http://localhost:3113   docker compose -f compose.yaml -f compose.connected.yaml run --rm models
```

Local-only base Compose port overrides use app 3113 and Mailpit 8133 and are excluded from commits. The test overlay was **not** loaded, its HTTPS fixture was stopped, and the recreated app/worker ran in local mode with the existing `.env` DeepSeek key. No key values were printed or recorded. The pinned `BAAI/bge-small-en-v1.5@5c38ec7c405ec4b44b94cc5a9bb96e735b38267a` model was already installed; the models command verified the cache, and readiness reported local CPU knowledge available. The isolated worker had outbound access; the shared checkout/stack was not used.

A fresh synthetic Business and verified signed-in Customer were created through public APIs. Its Owner authorized DeepSeek generation and extraction independently and published one final `deepseek-flash` agent, without Qwen fallback. Customer memory was inspected, its version-1 disclosure accepted, then each synthetic message was submitted through chat. Checks waited for the submitted message's actual extraction job, not an earlier job's status. Customer correction used the public memory API and its current revision. No database writes supplied preferences.

Primary run: 15:49:10–15:49:22 UTC (23:49 MYT). Business `a2b7aafc-8ca5-4b63-ba07-9f84bb4ef9cd`, conversation `e84de69f-3bba-4327-b885-5da252fdb9a3`. Every measured response reported **`deepseek-flash`** as its served model. The [official model/pricing page](https://api-docs.deepseek.com/quick_start/pricing/?tab=case-studies), checked on 2026-10-04, maps that alias to DeepSeek-V4.1-Flash; the response itself did not separately attest a version.

| Check | Observed result | Pass/fail |
| --- | --- | --- |
| Opt-in | Initially disabled; verified Customer accepted disclosure version 1, including 90-day retention; enabled returned HTTP 200 | PASS |
| Name: `Please call me Ada` | Completed automated turn and extraction; stored `preferred_name=Ada`, extraction provenance and submitting message UUID | PASS |
| Language: `I prefer Malay` | Completed automated turn and extraction; stored `language=Malay` with source UUID | PASS |
| Style: `I prefer brief replies` | Ordinary reply completed; provider extraction attempt succeeded, but extraction job failed with `preferences could not be saved`; no style stored | **FAIL** |
| Correction | Customer changed Ada to Grace; HTTP 200, `customer-correction` provenance, renewed explicit confirmation and 90-day expiry | PASS |
| Sensitive: `I have diabetes. Remember my medical diagnosis.` | Ordinary reply and extraction completed; final preferences exactly equal the pre-sensitive snapshot (`Grace`, `Malay`); no medical value or sensitive-message source saved | PASS |

The style failure's exact save/validation cause remains undiagnosed: provider transport success is not proof of accepted preferences. Synthetic coverage does not establish general model quality. The sensitive assertion was checked against the actual pre-sensitive snapshot; an initial harness assertion incorrectly expected three preferences despite the failed style save and was corrected without another provider call.

### Measured usage and estimated cost

Each row comes from the isolated database's `execution_attempts` for this Business. All eight provider attempts below succeeded at the transport/response stage; style extraction still failed afterward. Tokens are provider-reported prompt/completion usage. Rates supplied through `PROVIDER_RATES` were USD **0.15 / 0.60 per million input/output tokens**, the documented Sunday off-peak rates. Estimates treat all input as cache misses, ignore cache discounts, and are **not measured billed charges**.

| Turn | Operation | Served model | Input tokens | Output tokens | Estimated USD |
| --- | --- | --- | ---: | ---: | ---: |
| Name | generation | deepseek-flash | 188 | 56 | 0.00006180 |
| Name | extraction | deepseek-flash | 226 | 100 | 0.00009390 |
| Language | generation | deepseek-flash | 227 | 176 | 0.00013965 |
| Language | extraction | deepseek-flash | 265 | 184 | 0.00015015 |
| Style | generation | deepseek-flash | 261 | 93 | 0.00009495 |
| Style | extraction | deepseek-flash | 303 | 452 | 0.00031665 |
| Sensitive | generation | deepseek-flash | 275 | 235 | 0.00018225 |
| Sensitive | extraction | deepseek-flash | 230 | 145 | 0.00012150 |

Primary totals: **1,975 input + 1,441 output tokens; USD 0.00116085 estimated**. Extraction alone: **1,024 input + 881 output tokens; USD 0.00068220 estimated**.

Earlier exploratory run (15:39–15:43 UTC): opt-in/name/correction worked; language extraction had a transient network failure and was discarded, subsequent style service failed and the sensitive message stayed under human control. Four measured responses reported 891 input + 403 output tokens, estimated USD 0.00037545. One failed extraction returned no served-model/usage data, so its billed cost is unknown. The recorded attempt spanned approximately 227 seconds; its authority had expired and no language preference was accepted. That anomaly was not repaired or claimed as passing. An exploratory harness provenance assertion expected `customer` instead of the actual `customer-correction`; it was corrected before the primary run. Recorded measured estimates across both runs total **USD 0.00153630**, excluding unknown failed-call billing.

**Qwen: PENDING.** `DASHSCOPE_API_KEY` is absent; no Qwen account request, fallback, or verification was attempted. The broader 81-group fixture suite remains the prior synthetic result; this real integration failure is an additional unresolved gate.
