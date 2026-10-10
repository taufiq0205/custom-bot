# Running locally

Requires Docker Compose v2, arm64 or amd64, and free local ports 3100/8025. The first build downloads pinned images and locked dependencies. No cloud keys or model downloads are needed: document knowledge is optional and needs a one-time `docker compose run --rm models` (see Knowledge and [docs/models.md](models.md)).

```sh
cp .env.example .env
# Replace BOTH secrets using separate outputs from: openssl rand -hex 32
# Optionally set ACTION_CREDENTIAL_KEY the same way to store Business API credentials (see Actions).
# Keep .env private; never commit it.
docker compose up --build -d --wait
```

Open http://localhost:3100. Create an account, retrieve the verification code from http://localhost:8025, verify, sign in, and create a Business. The authenticated creator becomes Owner. Recovery sends a single-use code to the same mail transport; enter it and your new password, then sign in again. Reset revokes existing sessions. Repeating Create account for the same email does not replace its original password; use Recover access to change it. Codes expire in five minutes and allow five incorrect attempts. Authentication requests are rate limited in PostgreSQL (30/minute for sign-in and OTP endpoints; 60/minute otherwise). Local HTTP cookies are HttpOnly/SameSite; HTTPS enables Secure cookies. Mutations require the exact configured Origin, including API clients.

The `local` Compose profile enables mail capture (set in `.env.example`). Only the app and mail UI bind to loopback; PostgreSQL, SMTP and the Python worker have no published ports. Database and worker use an internal Docker network. The Python worker processes durable chat turn jobs (see Website chat) and records its heartbeat for readiness. Database state persists in the `database` volume across `docker compose down`/restart. **Do not use `down -v` to preserve data.**

Readiness checks migrations/database, worker heartbeat and SMTP. Inspect `docker compose ps` and `docker compose logs migrate app worker` when startup fails. An unapplied/failed migration prevents traffic. Migrations execute in order under a database advisory lock and record checksums; changed applied files fail rather than being silently rerun. Authentication SQL was generated from Better Auth 1.7.7. New migrations must use new numbered files.

The explicit demo seed is described in [Portfolio demo](demo.md). Seeds never run during startup, and are rejected in `APP_MODE=hosted`. Keep local mail capture limited to development.

## Tests

Reproducible checks (Node 22.22.3 on the host):

```sh
npm ci --ignore-scripts
npm run typecheck
npx playwright install chromium
docker compose -f compose.yaml -f compose.test.yaml up --build -d --wait
npm test
# Restore normal five-minute expiry after tests. --remove-orphans also stops the test fixture, which otherwise keeps
# answering as api.deepseek.com, dashscope-intl.aliyuncs.com and api.typesafe.ai on the internal network:
docker compose up -d --wait --remove-orphans
```

Tests use the running Docker APIs, actual PostgreSQL, the real worker, local SMTP capture, independent clients for token-consumption and duplicate-submission races, and Chromium for onboarding/recovery and website chat (from a separate fixture website origin) at mobile width. `compose.test.yaml` shortens OTP expiry to eight seconds, invitation expiry to twenty seconds and worker job leases to five seconds only in test mode; in test mode only, a Customer message starting `[hold Ns]` holds its simulated step N seconds (max 30) for crash/late-result tests, and a document (or a website's first page) starting `[hold Ns]` holds its activation the same way. The test overlay also starts a controlled HTTPS `fixture` service (answering as `api.deepseek.com`, `dashscope-intl.aliyuncs.com` and `api.typesafe.ai` on the test network only, plus a business endpoint; `tests/fixture/`, test-only self-signed CA and synthetic worker keys) whose control port is `127.0.0.1:${FIXTURE_PORT:-3199}`. It also always starts the bundled `demo` service and enables `DEMO_PUBLIC_HOSTS` for it, exactly as a local demo does. No test control route is exposed, and the app and worker refuse these controls outside test mode. The runtime and chat tests restart this Compose project's database/app/worker, kill the worker mid-turn, and temporarily stop the worker. Run against disposable local fixture data. Required test prerequisites and recorded evidence are in [slice 1 validation](dev-notes/validation-13.md) [Membership validation](dev-notes/validation-14.md) [website chat validation](dev-notes/validation-15.md) and [verified Customer validation](dev-notes/validation-16.md) and [configuration validation](dev-notes/validation-17.md) and [inbox validation](dev-notes/validation-18.md) and [workflow execution validation](dev-notes/validation-19.md) and [action validation](dev-notes/validation-20.md) and [knowledge validation](dev-notes/validation-21.md) and [provider validation](dev-notes/validation-28.md) and [website knowledge validation](dev-notes/validation-22.md) and [decision validation](dev-notes/validation-29.md) and [preview and trace validation](dev-notes/validation-27.md) and [portfolio demo validation](dev-notes/validation-35.md).

## Hosting

Hosted deployment is outside this ticket. Before hosting, require HTTPS ingress, real SMTP, secret management, backups/recovery, monitoring and remaining specification gates. `APP_MODE=hosted` rejects HTTP, mail-capture transport, test TTL controls and seeding. This local Compose path is not an approved production deployment.
