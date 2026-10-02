# Custom Bot

Slice 1 of [the platform specification](https://github.com/taufiq0205/custom-bot/issues/12): Docker launch, verified Operator email/password access, recovery, and durable Business creation as Owner. The archived configuration prototype remains an interaction reference. Chat, knowledge, provider inference and workflow execution belong to later slices.

Requires Docker Compose v2, arm64 or amd64, and free local ports 3100/8025. The first build downloads pinned images and locked dependencies; no cloud keys or model download is needed for this slice.

```sh
cp .env.example .env
# Replace BOTH secrets using separate outputs from: openssl rand -hex 32
# Keep .env private; never commit it.
docker compose up --build -d --wait
```

Open http://localhost:3100. Create an account, retrieve the verification code from http://localhost:8025, verify, sign in, and create a Business. The authenticated creator becomes Owner. Recovery sends a single-use code to the same mail transport; enter it and your new password, then sign in again. Reset revokes existing sessions. Repeating Create account for the same email does not replace its original password; use Recover access to change it. Codes expire in five minutes and allow five incorrect attempts. Authentication requests are rate limited in PostgreSQL (30/minute for sign-in and OTP endpoints; 60/minute otherwise). Local HTTP cookies are HttpOnly/SameSite; HTTPS enables Secure cookies. Mutations require the exact configured Origin, including API clients.

The `local` Compose profile enables mail capture (set in `.env.example`). Only the app and mail UI bind to loopback; PostgreSQL, SMTP and the Python worker have no published ports. Database and worker use an internal Docker network. The worker only records readiness in slice 1; no fictitious job processing or simulation is claimed. Database state persists in the `database` volume across `docker compose down`/restart. **Do not use `down -v` to preserve data.**

Readiness checks migrations/database, worker heartbeat and SMTP. Inspect `docker compose ps` and `docker compose logs migrate app worker` when startup fails. An unapplied/failed migration prevents traffic. Migrations execute in order under a database advisory lock and record checksums; changed applied files fail rather than being silently rerun. Authentication SQL was generated from Better Auth 1.7.7. New migrations must use new numbered files.

Explicit demo seed (two empty fictional Businesses; no fabricated chat/order/model behavior):

```sh
# First register and verify the account; then set its email in .env:
# SEED_OWNER_EMAIL=your-verified-fixture@example.test
docker compose --profile seed run --rm seed
```

Repeat seed commands leave existing Businesses/Memberships unchanged. Seeds never run during startup, and are rejected in `APP_MODE=hosted`. Seeding does not create or overwrite account credentials. Keep local mail capture limited to development.

Public Operator APIs: Better Auth endpoints under `/api/auth` (sign-up/email, sign-in/email, sign-out, get-session, email-otp/send-verification-otp, email-otp/verify-email, email-otp/request-password-reset, email-otp/reset-password); `GET/POST /api/businesses`; `GET /api/businesses/:id`; `GET /health/ready`. Business creation accepts only `{ "name": "Example" }`; arbitrary ownership fields are rejected. No Customer APIs are needed in this slice. Unauthorized Business selectors return 404.

Reproducible checks (Node 22.22.3 on the host):

```sh
npm ci --ignore-scripts
npm run typecheck
npx playwright install chromium
docker compose -f compose.yaml -f compose.test.yaml up --build -d --wait
npm test
# Restore normal five-minute expiry after tests:
docker compose up -d --wait
```

Tests use the running Docker APIs, actual PostgreSQL, local SMTP capture, independent clients for token-consumption races, and Chromium for onboarding/recovery at mobile width. `compose.test.yaml` shortens OTP expiry to eight seconds only in test mode; no test control route is exposed. The runtime test restarts this Compose project's database/app/worker and temporarily stops the worker. Run against disposable local fixture data. Required test prerequisites and recorded evidence are in [validation](docs/validation-13.md).

Hosted deployment is outside this ticket. Before hosting, require HTTPS ingress, real SMTP, secret management, backups/recovery, monitoring and remaining specification gates. `APP_MODE=hosted` rejects HTTP, mail-capture transport, test TTL controls and seeding. This local Compose path is not an approved production deployment.
