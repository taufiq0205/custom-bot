# Custom Bot

Slices 1–6 of [the platform specification](https://github.com/taufiq0205/custom-bot/issues/12): Docker launch, verified Operator email/password access, recovery, durable Business creation as Owner, Business Membership invitations, role changes and revocation, durable anonymous website chat with labelled simulated replies, verified Customer identity from Business websites, Owner-only JSON configuration drafts with explicit immutable publication, and human takeover through a shared support inbox. The archived configuration prototype remains an interaction reference. The visual workflow editor, knowledge, provider inference and workflow execution belong to later slices.

Requires Docker Compose v2, arm64 or amd64, and free local ports 3100/8025. The first build downloads pinned images and locked dependencies; no cloud keys or model download is needed for this slice.

```sh
cp .env.example .env
# Replace BOTH secrets using separate outputs from: openssl rand -hex 32
# Keep .env private; never commit it.
docker compose up --build -d --wait
```

Open http://localhost:3100. Create an account, retrieve the verification code from http://localhost:8025, verify, sign in, and create a Business. The authenticated creator becomes Owner. Recovery sends a single-use code to the same mail transport; enter it and your new password, then sign in again. Reset revokes existing sessions. Repeating Create account for the same email does not replace its original password; use Recover access to change it. Codes expire in five minutes and allow five incorrect attempts. Authentication requests are rate limited in PostgreSQL (30/minute for sign-in and OTP endpoints; 60/minute otherwise). Local HTTP cookies are HttpOnly/SameSite; HTTPS enables Secure cookies. Mutations require the exact configured Origin, including API clients.

The `local` Compose profile enables mail capture (set in `.env.example`). Only the app and mail UI bind to loopback; PostgreSQL, SMTP and the Python worker have no published ports. Database and worker use an internal Docker network. The Python worker processes durable chat turn jobs (see Website chat) and records its heartbeat for readiness. Database state persists in the `database` volume across `docker compose down`/restart. **Do not use `down -v` to preserve data.**

Readiness checks migrations/database, worker heartbeat and SMTP. Inspect `docker compose ps` and `docker compose logs migrate app worker` when startup fails. An unapplied/failed migration prevents traffic. Migrations execute in order under a database advisory lock and record checksums; changed applied files fail rather than being silently rerun. Authentication SQL was generated from Better Auth 1.7.7. New migrations must use new numbered files.

Explicit demo seed (two empty fictional Businesses; no fabricated chat/order/model behavior):

```sh
# First register and verify the account; then set its email in .env:
# SEED_OWNER_EMAIL=your-verified-fixture@example.test
docker compose --profile seed run --rm seed
```

Repeat seed commands leave existing Businesses/Memberships unchanged. Seeds never run during startup, and are rejected in `APP_MODE=hosted`. Seeding does not create or overwrite account credentials. Keep local mail capture limited to development.

Owners select **Manage** beside their Business to invite a verified Operator as Owner or Support, change a current Member's role, revoke access, or cancel a pending invitation. Invitation tokens arrive only at the intended email; the recipient signs in with that verified account and pastes the token into **Accept invitation**. Invitations expire after seven days, are single-use, and are superseded by a new invitation to the same email. Existing active Memberships cannot be overwritten through invitation acceptance. Revocation cancels pending invitations to that Member; demotion/revocation also cancels grants issued by that Owner. A fresh authorized invitation can restore revoked access. Every privileged request rechecks the current Business Membership; authority in another Business cannot grant access. Revocation does not require account sign-out. Concurrent changes preserve at least one active Owner.

Membership APIs: `GET /api/businesses/:id/memberships`; `POST /api/businesses/:id/memberships/:operatorId` with exactly `{ "role": "Owner" | "Support", "active": boolean, "revision": "expected revision" }`; `GET/POST /api/businesses/:id/invitations` (creation accepts exactly `email` and `role`); `POST /api/businesses/:id/invitations/:invitationId` with `{}` cancels; `POST /api/invitations/accept` with exactly `token`. Owner-only access failures and foreign references return 404; stale revisions and last-Owner changes return 409. Public invitation lists omit token/verifier values. Configuration APIs are Owner-only (below); credentials and trace APIs remain later slices and return 404 for all roles.

## Configuration (JSON)

Each Business has one shared configuration draft and a series of immutable published versions. Owners select **Manage**, edit **Configuration JSON**, then **Save draft** or **Publish**. Support Operators and other Businesses get no editor and `404` from the API.

- `GET /api/businesses/:id/configuration`: `{text, revision, base_version, published_version, updated_at, validation}`.
- `POST /api/businesses/:id/configuration` `{ "text": "raw JSON text", "revision": "expected revision" }` saves the text verbatim, even when it is invalid, and returns the new `revision` and `validation`. Text may be at most 262,144 characters, without NUL or unpaired surrogates.
- `POST /api/businesses/:id/configuration/publish` `{ "revision": "expected revision" }` publishes the *saved* draft at that revision. It returns `201 {version, revision}`, or `422 {validation}` when the draft has problems.
- `GET /api/businesses/:id/configuration/versions/:version` returns that immutable published `document`.

`validation` is `{json_valid, errors, blockers}`. Every entry is located: a parse error gives `line`/`column`, and other entries give a JSON Pointer `path` such as `/workflow/steps/2/position/x`.

- **Errors** cover unparseable JSON, duplicate object keys, out-of-range numbers, unknown fields, wrong types, duplicate IDs or connections, dangling references, non-finite positions (for example `1e999`) and malformed action schemas. They also cover write methods, non-HTTPS or IP/localhost destinations, URLs with credentials, and missing credential or authorization-policy references.
- **Blockers** cover a `null` entry and unconnected required outputs. The draft stays saved and editable, but it cannot be published.

Both kinds block publication. Only published versions ever execute.

A stale `revision` returns `409` with the `latest` draft and saves nothing. The editor keeps your local text, and reloading asks before discarding it. Publication also advances the draft revision, so two Owners publishing the same revision create exactly one version. A version is `max(version)+1`, created in the same transaction under the Business lock. The highest version is the current entry workflow for new conversations. Existing conversations keep the version they started with.

Schema version 1. Top-level fields:
- `schema_version`: `1`.
- `generation`: `{mode: "simulation" | "connected"}`.
- optional `decision`: `{engine: "jev" | "laya" | "von", model?}`.
- optional `sources`: `[{id, priority: 1–1000}]`.
- `agents`: `[{id, name, instructions, sources?, actions?, model?: {provider: "deepseek" | "qwen", name, temperature?: 0–2, max_tokens?: 1–8192}}]`.
- `actions`: `[{id, method: "GET", url, input_schema, result_schema, credential, authorization, timeout_ms: 1–15000}]`. `credential` and `authorization` are references, never secret values. Schemas use a JSON Schema subset: `type`, `properties`, `required`, `items` and `description`.
- `workflow`: `{entry, steps, connections}`.

Every step has `id`, `type` and a finite `position {x, y}`. The step types and the outputs each must connect:

| Type | Fields | Outputs |
| --- | --- | --- |
| `retrieval` | `sources` | `next` |
| `condition` | `field`, `equals` | `yes`, `fallback` |
| `http` | `action` | `success`, `failure` |
| `agent` | `agent`, `final` | final agents: `unsupported`; others: `next`, `unsupported` |
| `handoff` | none | none |

Connections are `{from, output, to}`, and `to` may be `null` in a draft.

New Businesses start with a publishable simulation draft: one agent with its `unsupported` output connected to a handoff. Businesses created before this slice keep their original version 1, whose single agent lacks that connection. Their draft therefore shows one blocker until a handoff is connected.

## Website chat (simulated)

Every Business starts with an immutable, system-published configuration version 1 whose generation mode is `simulation`; it is created with the Business (and backfilled for existing ones) and cannot be updated or deleted. No provider keys are read in this slice. Every automated reply is labelled `simulated: true` and says that no AI model generated it, and readiness reports `"generation": "simulation"`. A pinned configuration in any other mode fails the turn visibly instead of pretending to generate.

An Owner approves each website that may embed chat (**Manage → Website chat origins**, or `GET/POST /api/businesses/:id/website-origins` with exactly `{ "origin": "https://shop.example.com", "approved": true | false }`). Origins must be exact `scheme://host[:port]` values; hosted mode accepts HTTPS only. Withdrawing an origin cuts off existing sessions on their next request. Embed the widget on an approved page:

```html
<script src="http://localhost:3100/widget.js" data-business="BUSINESS_ID" defer></script>
```

Customer API (every request needs an approved `Origin`; no cookies; `Authorization: Bearer <token>` identifies the browser's chat session, anonymous or verified):

- `POST /api/chat/:businessId/conversations` `{}` — without a token, creates an anonymous session and returns its `token` once (only a SHA-256 verifier is stored); with a token, starts another conversation in that session. New conversations pin the current published configuration version.
- `GET /api/chat/:businessId/conversations` — an anonymous session's own conversations, or all of a verified Customer's conversations in this Business.
- `GET /api/chat/:businessId/conversations/:id` — `control_state`, `configuration_version`, `mode` and ordered messages (`author`, `text`, `simulated`, `reply_to`, `turn_state`).
- `POST /api/chat/:businessId/conversations/:id/messages` `{ "client_submission_id": "8–100 of A-Z a-z 0-9 _ -", "text": "1–2000 characters" }` — `202` when accepted (a reply is not yet delivered), `200` with the original message for a retried ID, `409` if the ID was used for different text.

Unapproved/missing origins and unknown Businesses return the same `403` without CORS access; invalid or foreign-Business tokens return `401`; another session's conversation returns `404`. Each message creates one durable turn job. The worker claims the oldest turn per conversation in a short transaction with a lease bounded by the 60-second execution deadline, holds no transaction during the external step, and accepts its result only while its lease and the conversation's execution generation are current. Expired leases (for example a worker crash) and missed deadlines mark the turn `failed` with a visible notice; nothing is replayed, and retrying the same submission ID returns the failed original. Restart preserves sessions, conversations and messages. The widget stores its token in the website's `localStorage`, renders text only, and reuses a submission ID only to retry the same unsent text.

### Verified Customers

A Business website that signs in its own customers can verify them in chat. Its server signs a short-lived ES256 JWT with a key whose public half an Owner registered (`/api/businesses/:id/customer-keys`; API only). The widget tag carries it as `data-assertion`. `POST /api/chat/:businessId/identity` `{ "assertion": "…" }` links only the current anonymous conversation; `POST /api/chat/:businessId/logout` `{}` ends the session. Both rotate the session token. Logout, account switching and assertion expiry end access to earlier history at once, and replies that arrive afterwards are not delivered. Email and phone never identify or merge Customers. The full integration contract (claims, algorithm, keys, lifetimes) is in [docs/customer-identity.md](docs/customer-identity.md).

Deferred to later slices: workflow execution and real providers (#19, #28), 90-day retention (#24). Anonymous session creation is not yet rate limited; put hosted deployments behind ingress rate limiting.

## Human takeover and shared inbox

Each Business has one shared support queue. Every active Owner and Support Member selects **Open inbox** beside the Business to see it. A conversation is `automated`, `waiting-for-support`, `human-controlled` or `resolved`.

- A Customer selects **Talk to a person** (`POST /api/chat/:businessId/conversations/:id/handoff` `{}`), or an automated turn fails because connected generation is unavailable. Either puts the conversation in the queue.
- An Operator can **Claim** a queued conversation. Claiming an automated conversation takes it over directly; an Operator must own a conversation before replying.
- Every control change happens in one transaction, enforced by a database trigger whichever service makes it. It increments the conversation's execution generation, stops its queued and running automated turns (their late results are discarded), and posts the Customer notice: *Waiting for support*, *Support joined*, *Automated assistant resumed* or *Conversation resolved*. No notice promises a response time.
- Customer messages sent while queued or under human control are stored with `turn_state: "human"` and never start an automated turn.
- Only the current assignee can reply, **Resolve** or **Return to automated assistant**. Any Member can reassign a queued, human-controlled or resolved conversation to an active Member.
- Resume replays nothing. The next Customer message starts the next automated turn.
- A Customer message after resolution reopens the conversation under human control with the same assignee. If that Membership has been revoked, it returns to the queue instead.
- Revoking a Membership returns that Member's human-controlled conversations to the queue.
- Available/Away is manual and shown to the team only. It never assigns, releases or resumes a conversation. Away, sign-out and restarts keep assignments, messages and the pause.

Operator inbox API (verified Operator session, same-origin):
- `GET /api/businesses/:id/inbox`: your `operator_id`, active `members` (`email`, `role`, `available`) and up to 200 conversations with messages. The queue is listed first.
- `GET /api/businesses/:id/inbox/conversations/:conversationId`: `control_state`, `assignee_id`/`assignee_email`, `handoff_reason` (`customer-request`, `operator-takeover`, `automation-failure`), `revision` and the full message history.
- `POST /api/businesses/:id/inbox/availability` `{ "available": boolean }`.
- `POST …/conversations/:conversationId/claim|resolve|resume` `{ "revision": "…" }`; `…/reassign` `{ "revision", "operator_id" }`; `…/messages` `{ "revision", "client_submission_id", "text" }`.

`revision` changes whenever control or the assignee changes. Customer messages and replies do not change it. A stale revision, or an action by anyone but the assignee, returns `409` and changes nothing. All checks run under the conversation lock at commit. The Operator UI keeps a rejected reply in its box. A retried `client_submission_id` returns the original reply (`200`) and never sends twice. A non-Member gets `404`. Customers see Operator replies as `operator` messages without Operator identities.

Lookup results and Customer memory are not shown yet; they arrive with actions (#20) and memory (#22).

Public Operator APIs: Better Auth endpoints under `/api/auth` (sign-up/email, sign-in/email, sign-out, get-session, email-otp/send-verification-otp, email-otp/verify-email, email-otp/request-password-reset, email-otp/reset-password); `GET/POST /api/businesses`; `GET /api/businesses/:id`; `GET /health/ready`. Business creation accepts only `{ "name": "Example" }`; arbitrary ownership fields are rejected. Unauthorized Business selectors return 404.

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

Tests use the running Docker APIs, actual PostgreSQL, the real worker, local SMTP capture, independent clients for token-consumption and duplicate-submission races, and Chromium for onboarding/recovery and website chat (from a separate fixture website origin) at mobile width. `compose.test.yaml` shortens OTP expiry to eight seconds, invitation expiry to twenty seconds and worker job leases to five seconds only in test mode; in test mode only, a Customer message starting `[hold Ns]` holds its simulated step N seconds (max 30) for crash/late-result tests. No test control route is exposed, and the app and worker refuse these controls outside test mode. The runtime and chat tests restart this Compose project's database/app/worker, kill the worker mid-turn, and temporarily stop the worker. Run against disposable local fixture data. Required test prerequisites and recorded evidence are in [slice 1 validation](docs/validation-13.md) [Membership validation](docs/validation-14.md) [website chat validation](docs/validation-15.md) and [verified Customer validation](docs/validation-16.md) and [configuration validation](docs/validation-17.md) and [inbox validation](docs/validation-18.md).

Hosted deployment is outside this ticket. Before hosting, require HTTPS ingress, real SMTP, secret management, backups/recovery, monitoring and remaining specification gates. `APP_MODE=hosted` rejects HTTP, mail-capture transport, test TTL controls and seeding. This local Compose path is not an approved production deployment.
