# Issue #13 validation

Recorded 2026-10-03 MYT. Scope: Docker launch, verified Operator accounts, recovery and durable Business creation. Parent: [#12](https://github.com/taufiq0205/custom-bot/issues/12); slice: [#13](https://github.com/taufiq0205/custom-bot/issues/13).

## Environment and reproduction

Actual host: Darwin arm64; Docker Engine 29.4.0 through OrbStack, Linux containers aarch64. Node 22.22.3; Python 3.14.6; PostgreSQL 17.10; pgvector image 0.8.2; Mailpit 1.29.3; Better Auth 1.7.7; psycopg 3.3.3; Playwright 1.63.0 / Chromium 153.0.8010.12. Container images use immutable multi-architecture digests; npm dependencies use package-lock.json; Python dependencies use a hash-checked requirements.lock.

Clean verification directory: `/tmp/custom-bot-clean-13-final`, created from `git archive 220f1f200a6d1ef271dbd0531665b2ff706b179a` plus the reviewed staged binary diff, then the reviewed Retry-After fixture adjustment. No existing node_modules or application database was copied. Fresh random local secrets and a new Docker project/volume were used; no cloud credentials were configured. The final source files match this workspace's implementation.

Prerequisites: running Docker Compose v2, Node 22.22.3, installed Playwright Chromium, free loopback ports 3100/8025, initial network access for image/dependency downloads. The mail fixture is real local SMTP capture; no internet email-delivery claim is made. The tests operate on disposable fixture accounts and restart services.

Commands from the clean directory:

```sh
npm ci --ignore-scripts
npm run typecheck
npx playwright install chromium
COMPOSE_PROJECT_NAME=custom-bot-clean13 docker compose -f compose.yaml -f compose.test.yaml up --build -d --wait
COMPOSE_PROJECT_NAME=custom-bot-clean13 npm test
```

Clean dependency installation, typecheck and Docker readiness passed. `npm audit --omit=dev --audit-level=high` also passed with zero reported vulnerabilities. Actual full-suite result: **4 scenario groups passed; 0 failed, cancelled or skipped; 139.276 seconds**. These are scenario-group counts, not a count of individual assertions.

## Acceptance coverage

| Criterion | Running verification and result |
| --- | --- |
| Clean launch, pins, private services and readiness | Fresh directory/volume built and launched healthy. Hash-locked packages and digest-pinned images were used. Runtime test confirms no published database/worker ports; stopping worker or SMTP changes public readiness to 503 and restarting restores 200. |
| Guarded ordered migrations | Initial migrations applied before app startup. Two concurrent migrators succeeded without reapplying migrations. A changed applied SQL fixture was rejected by its checksum, with the running app still healthy. |
| Verification and recovery | Actual SMTP codes verify email and reset password. Invalid, expired and reused codes fail. Two independent HTTP requests hold incomplete bodies at a shared connection barrier; release gives exactly one successful verification/reset and one rejected consumer. Reset invalidates the prior session and old password. |
| Business ownership, authorization and origin | Authenticated verified creator receives Owner. Anonymous/unverified creation is denied; forged owner fields and malformed names/types are rejected. Another account cannot read or list the Business. Missing/foreign Origin mutations, including auth sign-out, are rejected. Split UTF-8 names survive creation and persisted public retrieval. |
| UI interactions | Chromium at 390×844 registers, reads captured mail, verifies, signs in, creates a Business, recovers access, signs in again, and signs out. No page errors or horizontal overflow; signed-out workspace disappears. |
| Restart persistence | Docker database/worker/app restart preserves Business identity/name, existing session access, and subsequent password sign-in. Reads use the public API, not table inspection. |
| Explicit idempotent seed | Two concurrent explicit seed runs create exactly two fictional Businesses for a verified fixture Operator. A repeat preserves IDs, names and roles, while an existing independent Business remains unchanged. Hosted seed and hosted test-TTL configuration are rejected. No startup service invokes seeding. |
| Secret redaction | App/worker/migrator/mail logs omit the fixture password and both configured environment secrets. No real credentials or customer data were used. |

## Review

Baseline: `220f1f200a6d1ef271dbd0531665b2ff706b179a`; read-only reviewers used `git diff --cached <baseline>` because this review preceded the requested commit.

### Standards

No remaining findings. Fixed split-buffer UTF-8 decoding with Node's native streaming decoder. The public regression test first failed with `Caf��` and then passed with `Café`. Expanded manually minified HTML/CSS into lines.

### Spec

No remaining findings. Added an explicit two-request token-consumption barrier and disabled HTTP connection reuse for its independent clients. Review confirmed the barrier and public Retry-After handling.

Review totals: Standards 0 remaining; Spec 0 remaining.

## Earlier failures and correction

Focused work initially exposed mail UI access through an internal-only network, auth endpoint throttling, split UTF-8 corruption and a reused-socket barrier timeout. These were corrected and their focused scenarios passed. The first clean full-suite run passed 2/4 groups and failed 2 because the default signup limit was reached after three fixture accounts. The fixture client now honors public Retry-After and retries once; the signup limit is unchanged. The final complete run below passed all groups. There are no skipped required slice checks. Only arm64 was exercised; hosted deployment, external email delivery and later platform slices are outside this evidence.

## Local stack restoration

Cleanup initially selected the default Compose project and removed its containers without deleting volumes. Both test and original database volumes were preserved. The original stack was recreated with normal five-minute expiry; public readiness returned 200 and a fresh fixture sign-in listed both existing demo Businesses with Owner roles. For isolated teardown, explicitly select `docker compose -p custom-bot-clean13 -f compose.yaml -f compose.test.yaml down`.

## Final raw suite output

```text

> custom-bot@0.1.0 test
> node --test --test-concurrency=1 tests/*.test.mjs

TAP version 13
# Subtest: running Docker: verified Owner creation, isolation and recovery
ok 1 - running Docker: verified Owner creation, isolation and recovery
  ---
  duration_ms: 757.1285
  type: 'test'
  ...
# Subtest: browser: register, verify, sign in, create Owner Business, recover, sign out
ok 2 - browser: register, verify, sign in, create Owner Business, recover, sign out
  ---
  duration_ms: 1439.095417
  type: 'test'
  ...
# Subtest: tokens: independent concurrent consumers and expiry
ok 3 - tokens: independent concurrent consumers and expiry
  ---
  duration_ms: 19699.309459
  type: 'test'
  ...
# Subtest: Docker: restart persistence, private services, guarded migrations, seed idempotency and readiness failure
ok 4 - Docker: restart persistence, private services, guarded migrations, seed idempotency and readiness failure
  ---
  duration_ms: 117104.760209
  type: 'test'
  ...
1..4
# tests 4
# suites 0
# pass 4
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 139275.852292
```
