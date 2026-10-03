# Issue #15 — Durable anonymous website chat

Environment: 2026-10-03, macOS 27.0.1 arm64 / OrbStack, Node 22.22.3, npm 10.9.8, Docker Compose v5.1.2, PostgreSQL 17 (repository-pinned pgvector image), Python 3.14.6 with psycopg 3.3.3, Better Auth 1.7.7, TypeScript 7.0.2, Playwright 1.63.0 / Chromium. No dependency or image pins changed.

## Reproduce

Requires this project's `.env`, free loopback ports 3115/8035, locked npm dependencies and Chromium. Tests kill/restart the worker and restart db/app/worker in the isolated Compose project; use disposable fixture data. No cloud credentials or provider calls are used: this slice's generation is simulation only.

```sh
npm ci --ignore-scripts
npx playwright install chromium
npm run typecheck
export COMPOSE_PROJECT_NAME=custom-bot-chat-validation APP_URL=http://localhost:3115 MAIL_URL=http://localhost:8035
COMPOSE_FILE=compose.yaml:compose.test.yaml:ports-15.yaml docker compose up --build -d --wait
node --test tests/chat.test.mjs
node --test tests/browser.test.mjs
npm test
```

`ports-15.yaml` (Compose `!override` support required):

```yaml
services:
  app:
    ports: !override [127.0.0.1:3115:3000]
  mail:
    ports: !override [127.0.0.1:8035:8025]
```

`compose.test.yaml` adds a five-second worker job lease, and in `APP_MODE=test` only a message starting `[hold Ns]` (max 30) holds the simulated step. The worker refuses `TEST_JOB_LEASE_SECONDS` outside test mode (asserted). No test route or alternate authorization exists.

## Acceptance evidence

| Criterion | Runnable evidence |
| --- | --- |
| Anonymous sessions access only their own conversations on Business-approved origins | `chat.test.mjs` origins group: Owner-only origin approval (Support 404), malformed/path/credentialed/overlong origins 400; unapproved, missing Origin and unknown Business all 403 without CORS headers; preflight allowed only for approved origin; a second session cannot list, read or post to the first session's conversations (404); forged token 401; Business A token rejected on Business B even from B's approved origin (401); withdrawing an origin cuts off an existing session and re-approval restores it. Browser journey: a separate fixture website origin shows chat, a second browser context sees none of the first Customer's history, an unapproved origin shows chat unavailable. Composite `(business_id, …)` foreign keys bind sessions, conversations, messages, jobs and configuration versions to one Business. |
| Duplicate submission IDs produce exactly one delivered message and turn, including concurrent retries | Duplicates group: sequential retry returns the original (200), different text with the same ID 409, and eight independent sockets released by one barrier yield exactly one 202 and seven 200 with one message ID. After settling: one customer message and exactly one simulated reply per submission; a later retry adds nothing. |
| Worker claims durable jobs with bounded leases and short transitions, no transaction during external work | Runtime group: during a held turn a second send in the same conversation returns 202 in under 1 s, `pg_stat_activity` shows zero `idle in transaction` backends, and readiness stays 200. Claims, completion and recovery each lock the conversation row in short transactions. The lease never exceeds the 60 s deadline. Completion is accepted only with a current lease and execution generation. A partial unique index allows one running job per conversation, and claims follow message order. |
| Seeded immutable starting configuration and simulation mode are visible; no false real-inference claim | Every conversation reports `configuration_version: 1` and `mode: "simulation"`. Replies are `simulated: true` and begin "Simulated reply: no AI model generated this text". Readiness reports `generation: "simulation"`. The widget shows the simulation notice and version. SQL `UPDATE`/`DELETE` of the published configuration fail (trigger). The worker receives no provider keys. A pinned configuration in any other mode fails the turn visibly as unavailable. |
| Restart preserves messages/state; interrupted turns fail visibly without blind replay | Runtime group: `docker compose kill worker` mid-turn, then start. The turn becomes `failed` with only a system notice ("interrupted … not retried automatically"), and the queued next turn then completes. A worker still busy after its lease expires has its late result discarded and the turn fails visibly. Resubmitting the failed ID returns the failed original and enqueues nothing. After a 27 s wait, nothing new appears. The full conversation payload and session listing are identical after restarting db/app/worker. App/worker logs contain neither the session token nor the message text. |

## Recorded result

Focused chat groups: **3 passed, 0 failed**. Chromium chat journey: **1 passed, 0 failed**. Mutation check: removing the completion lease check failed the late-result assertion; removing Business scoping from the session lookup failed the cross-Business token assertion. Both were restored.

The first full-suite run passed 13/14. The Docker runtime group's unasserted sign-in hit Better Auth's per-IP 30/minute sign-in limit, which the added chat fixtures now exceed. Test sign-ins/sign-ups now retry once after the public `Retry-After`, and that sign-in is now asserted.

Final isolated full suite after review fixes: **14 groups passed, 0 failed/cancelled/skipped; 585.483 seconds** (it includes rate-limit waits). Typecheck passed.

```text
# tests 14
# pass 14
# fail 0
# cancelled 0
# skipped 0
# duration_ms 585482.942208
```

## Review

`/code-review high` returned 10 unverified findings. Fixed:
- An overlong origin was reported as the last-Owner 409. It is now a 400 with a regression assertion.
- Readiness now follows the job loop rather than an independent heartbeat.
- Plain-HTTP websites lacked `crypto.randomUUID`. The widget now uses `getRandomValues`.
- The widget now resumes polling after a transient error.
- The widget starts a fresh anonymous conversation after a 401/404 on send.
- Turns are claimed in message order instead of transaction-start time.
- The duplicated uuid/verifier and race-barrier helpers are deduplicated.

Not changed:
- Anonymous session/message rate limiting is documented as deferred. Hosted deployments need ingress rate limiting.
- The Job `kind`, idempotency key and attempt count, and the Conversation revision, are kept because the parent specification's records require them.

Out of scope: verified Customers and session expiry (#16), configuration publication (#17), takeover (#18), workflow execution/providers (#19, #28), retention (#24).
