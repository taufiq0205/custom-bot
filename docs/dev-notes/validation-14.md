# Issue #14 — Business Membership management

Environment: 2026-10-03, macOS arm64 / OrbStack, Node 22.22.3, npm 10.9.8, Docker Compose 5.1.2, PostgreSQL 17.10 with the repository-pinned pgvector image, Python 3.14.6, Better Auth 1.7.7, TypeScript 7.0.2, Playwright 1.63.0 / Chromium. Dependency/image pins remain unchanged.

## Reproduce

Requires this project's `.env`, existing Docker fixtures, free loopback ports 3100/8025, installed locked npm dependencies and Chromium. Tests restart the database/app/worker and temporarily stop worker/mail; use disposable local fixture data. No cloud credentials, Customer APIs, provider calls or worker jobs are required for this slice.

```sh
npm ci --ignore-scripts
npx playwright install chromium
npm run typecheck
# Use the isolated ports override below:
APP_URL=http://localhost:3114 docker compose -p custom-bot-memberships-validation -f compose.yaml -f compose.test.yaml -f /tmp/custom-bot-14-ports.yaml up --build -d --wait
APP_URL=http://localhost:3114 MAIL_URL=http://localhost:8034 node --test tests/memberships.test.mjs
APP_URL=http://localhost:3114 MAIL_URL=http://localhost:8034 node --test tests/browser.test.mjs
APP_URL=http://localhost:3114 MAIL_URL=http://localhost:8034 COMPOSE_PROJECT_NAME=custom-bot-memberships-validation npm test
# Restore normal OTP/invitation expiry after testing:
docker compose up -d --wait
```

Save this as `/tmp/custom-bot-14-ports.yaml` (Compose `!override` support required):

```yaml
services:
  app:
    ports: !override [127.0.0.1:3114:3000]
  mail:
    ports: !override [127.0.0.1:8034:8025]
```

`compose.test.yaml` sets eight-second OTP and twenty-second invitation expiry. These controls are refused outside test mode; no time-control API or alternate authorization route exists. Local invitation expiry is seven days. Tests use SMTP capture, actual PostgreSQL, actual session cookies, and independent HTTP sockets synchronized before completing their bodies.

## Acceptance evidence

| Criterion | Runnable evidence |
| --- | --- |
| Authorized Owner, intended verified account, expiring single-use invitation | `memberships.test.mjs`: intended-email mismatch, unauthenticated/unverified access, bad token/input/origin, superseded/cancelled/expired grants, concurrent consumption yielding exactly one success. |
| Owner in A / Support in B cannot manage B | Public Business/Membership/invitation requests assert Business-specific roles, deny Support reads/creates, and allow its independent Owner access in A. Browser journey hides management for Support. |
| Cross-business references denied without foreign data | Foreign Business, foreign invitation ID, foreign Member and forged body selector tests return denial; lists omit tokens/verifiers. `003-memberships.sql` uses a composite `(business_id, inviter_id)` foreign key to the corresponding Membership and immutable Membership identity. |
| Existing sessions lose access on revocation | Same authenticated client is denied Business/Membership reads after revocation; B disappears from its Business list while A remains. Pending grants to revoked Members and grants issued by demoted Owners cannot restore access. Browser reload independently confirms removal. |
| Concurrent removal/demotion preserve last Owner | Independent socket barrier: two self-demotions, two self-revocations, and mixed revoke/demote each yield one 200 and one 409, and exactly one active Owner remains observable. Both sequential last-Owner revoke and demote fail. Stale revisions fail. Protection is enforced by a PostgreSQL trigger, not only request code. |
| UI and durable state | Chromium at 390×844: invitation creation/acceptance, promotion/demotion, cancellation/revocation, visible last-Owner error, no browser errors/horizontal overflow. Runtime test compares public Membership/invitation records across database/app/worker restart. |

Configuration, credentials, developer traces, inbox, Customer memory, Customer APIs and execution jobs belong to later slices. Their absent routes deny all roles; this ticket establishes the current-Membership authorization pattern, without claiming live behavior for those future features. Better Auth supplies account verification and maintained signed-session authentication; Business invitation grants store only a SHA-256 verifier of a 256-bit random token and atomically consume/recheck it with current authority in PostgreSQL. No password/session cryptography is implemented here.

## Recorded result

Focused Membership API groups: **3 passed, 0 failed**; Chromium groups: **2 passed, 0 failed**. Typecheck and diff whitespace checks passed.

Initial full-suite attempts passed 8/9 groups. The existing repeated-signup regression encountered HTTP 429 after the added browser fixtures consumed Better Auth's built-in three-signups/ten-second quota. It now retries using the public `Retry-After` header and asserts the successful response before checking unchanged signup/recovery behavior. A targeted attempt overlapping the runtime suite's intentional mail stop failed on unavailable SMTP capture; the final suite runs without competing tests.

Final isolated full suite: **9 groups passed, 0 failed/cancelled/skipped; 194.394 seconds**. Typecheck passed. Standard local Compose settings were restored after validation. The isolated project's fixture database is separate from the normal app.

```text
1..9
# tests 9
# suites 0
# pass 9
# fail 0
# cancelled 0
# skipped 0
# duration_ms 194393.928125
```

## Standards

One availability defect was found and fixed: incomplete POST bodies reserved shared PostgreSQL connections before parsing. Parsing now finishes before acquiring a connection. The public regression held ten independent bodies incomplete; readiness timed out before the fix and returned 200 after it (one focused group passed). Static follow-up confirmed the fix. No hard standards violations remain. Parser duplication is a nonblocking smell; extraction was deferred until the parsing contracts need another shared change.

## Spec

No findings against issue #14 and its parent. Future unavailable APIs remain explicitly bounded.

Review totals: Standards 0 unresolved defects, 1 nonblocking duplication smell; Spec 0 findings.

Post-review full suite: **10 groups passed, 0 failed/cancelled/skipped; 205.623 seconds**, including the availability regression and complete Docker restart/recovery checks. Typecheck and whitespace checks passed.

```text
1..10
# tests 10
# suites 0
# pass 10
# fail 0
# cancelled 0
# skipped 0
# duration_ms 205623.374042
```
