# Custom Bot

Slices 1–8 of [the platform specification](https://github.com/taufiq0205/custom-bot/issues/12): Docker launch, verified Operator email/password access, recovery, durable Business creation as Owner, Business Membership invitations, role changes and revocation, durable anonymous website chat with labelled simulated replies, verified Customer identity from Business websites, Owner-only JSON configuration drafts with explicit immutable publication, human takeover through a shared support inbox, bounded execution of the published workflow, authorized live order lookups through Owner-controlled read-only HTTPS actions, the visual workflow editor, and document knowledge with local embeddings and cited answers. The archived configuration prototype remains an interaction reference. Website knowledge and provider inference belong to later slices.

Requires Docker Compose v2, arm64 or amd64, and free local ports 3100/8025. The first build downloads pinned images and locked dependencies, and the first launch downloads the pinned embedding model (about 135 MB) into the `models` volume (see Knowledge). No cloud keys are needed.

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

Explicit demo seed (two empty fictional Businesses; no fabricated chat/order/model behavior):

```sh
# First register and verify the account; then set its email in .env:
# SEED_OWNER_EMAIL=your-verified-fixture@example.test
docker compose --profile seed run --rm seed
```

Repeat seed commands leave existing Businesses/Memberships unchanged. Seeds never run during startup, and are rejected in `APP_MODE=hosted`. Seeding does not create or overwrite account credentials. Keep local mail capture limited to development.

Owners select **Manage** beside their Business to invite a verified Operator as Owner or Support, change a current Member's role, revoke access, or cancel a pending invitation. Invitation tokens arrive only at the intended email; the recipient signs in with that verified account and pastes the token into **Accept invitation**. Invitations expire after seven days, are single-use, and are superseded by a new invitation to the same email. Existing active Memberships cannot be overwritten through invitation acceptance. Revocation cancels pending invitations to that Member; demotion/revocation also cancels grants issued by that Owner. A fresh authorized invitation can restore revoked access. Every privileged request rechecks the current Business Membership; authority in another Business cannot grant access. Revocation does not require account sign-out. Concurrent changes preserve at least one active Owner.

Membership APIs: `GET /api/businesses/:id/memberships`; `POST /api/businesses/:id/memberships/:operatorId` with exactly `{ "role": "Owner" | "Support", "active": boolean, "revision": "expected revision" }`; `GET/POST /api/businesses/:id/invitations` (creation accepts exactly `email` and `role`); `POST /api/businesses/:id/invitations/:invitationId` with `{}` cancels; `POST /api/invitations/accept` with exactly `token`. Owner-only access failures and foreign references return 404; stale revisions and last-Owner changes return 409. Public invitation lists omit token/verifier values. Configuration and action-control APIs are Owner-only (below); trace APIs remain a later slice and return 404 for all roles.

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
- optional `sources`: `[{id, priority: 1–1000}]`. A source `id` names the Knowledge source uploaded under that ID. When passages conflict, the lower priority number takes precedence.
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

Deferred to later slices: real providers (#28), 90-day retention (#24). Anonymous session creation is not yet rate limited; put hosted deployments behind ingress rate limiting.

## Workflow execution

Each Customer message in an `automated` conversation is one turn. The worker runs the conversation's pinned published workflow from its `entry`:

| Step | Behaviour |
| --- | --- |
| `retrieval` | Retrieves the five passages most similar to the Customer's message from the step's `sources` (see Knowledge), then continues to `next`. |
| `condition` | `yes` when the structured context field strictly equals `equals` (`true` is not `1`, and `1` equals `1.0`), otherwise `fallback`. |
| `http` | Runs the action through the central action checks (see Actions). It takes the action's input properties from the context. If a required one is missing, the turn sends one clarification built from the property `description` ("To continue, please tell me your order number.") and ends. The next message starts a new turn. A result matching `result_schema` merges its declared top-level properties into the context and goes to `success`. Undeclared properties are dropped. Anything else goes to `failure`. |
| `agent` | In `simulation` mode a final agent gives the labelled simulated reply, and other agents continue with no context. In `connected` mode the agent's model must reply with one JSON object. Intermediate agents return `{"outcome":"next","context":{…}}` (at most 20 flat text/number/boolean fields), which is never shown to the Customer. Final agents return `{"outcome":"reply","reply":"…"}`. Any agent can return `{"outcome":"unsupported"}`, which follows its `unsupported` output. Only the final agent's reply is delivered. Context reaches the model as data in a user message, never as instructions, and an agent cannot overwrite a field set by a verified HTTP result. If it tries, the turn fails. |
| `handoff` | Completes the turn and queues the conversation for support (`workflow-handoff`). |

Limits per Customer message:
- 20 steps.
- 3 agent calls and 5 business HTTP calls. Retries count.
- A 15-second timeout per HTTP attempt, or the action's shorter `timeout_ms`. This is wall-clock time covering connection, headers and a trickled body.
- A 60-second deadline from acceptance.

A transient failure (timeout, connection error, 429 or 5xx) is retried once if budget and time remain. Other failures are not retried: 3xx (redirects are never followed), other 4xx, certificate rejection, and malformed, oversized or non-JSON results. A failed HTTP attempt follows the step's `failure` output.

Exhausting a limit, invalid agent output, a failed provider call or unavailable generation fails the turn visibly with a notice. The conversation goes to support as `automation-failure`, and no assistant text is delivered.

Before every external attempt, and again before accepting the result, the worker briefly locks the conversation. In that check it:
- requires its lease, the turn's execution generation, `automated` control and the submitting chat session to still be current;
- extends the lease to cover only that attempt.

No transaction stays open during a call. A takeover, handoff or sign-out therefore stops all later steps and discards late results. A worker crash fails the turn visibly once the lease lapses, and nothing is replayed. Each attempt is recorded value-free (step, kind, target, status, error, timing) for the Owner traces in #27.

Current limits of this slice:
- **Connected agents have no real provider before #28.** A connected agent is unavailable unless the test overlay's fixture provider is selected with model name `fixture`.
- Consent and memory revalidation join the same check with #23–#24. Source deletion already does (see Knowledge).

## Knowledge (documents)

An Owner uploads documents under a source ID that the configuration's `sources` declare (**Manage → Knowledge**, or the API below). Support Members and other Businesses get `404`.

- `POST /api/businesses/:id/sources/:sourceId?document=<file name>` with the raw file as the request body. `Content-Length` is required. Accepted names end in `.pdf`, `.docx`, `.txt`, `.md` or `.markdown`. The limit is 20 MiB (20,971,520 bytes); a larger upload gets `413` before anything is stored. `202` means only that ingestion is queued.
- `GET /api/businesses/:id/sources`: for each source, `active` (`document`, `format`, `passages`, `activated_at`, or `null`), the `latest` upload (`state`: `queued`, `running`, `active`, `superseded` or `failed`, with `error`) and a `warning` when the latest upload failed.
- `POST /api/businesses/:id/sources/:sourceId/delete` `{}`.

**Ingestion.** The worker extracts text from text PDFs (pypdf; one passage set per page), DOCX (`word/document.xml`), and UTF-8 TXT and Markdown. Nothing unreadable is reported as ingested: a PDF fails when under half its pages have extractable text (scanned pages need OCR, which is not supported), and corrupt, mislabelled, non-UTF-8, binary or empty files fail. The text is split into passages of whole lines, packed up to 350 tokens counted with the model's tokenizer and never crossing a PDF page. Long lines split at token boundaries. Every passage is checked to fit the model's 512-token input. Uploaded bytes are kept in PostgreSQL, on the database volume, only while they are needed: for queued work, and for the active version so that it can be re-indexed.

**Versions.** A version activates only when it is completely parsed and embedded. Activation happens in one transaction that inserts all its passages and replaces the previous version. A failed, interrupted (worker restart) or older-than-active candidate never replaces the active version. The Knowledge view and `warning` then say that answers still use the previous document. Deletion is final. It removes every version's passages and bytes in the transaction that reports it, and a delayed ingestion of a deleted source never activates. Uploading under the same ID afterwards starts a new source.

**Embeddings.** `BAAI/bge-small-en-v1.5` at commit `5c38ec7c405ec4b44b94cc5a9bb96e735b38267a`. The worker runs the publisher's FP32 ONNX export on the CPU execution provider (onnxruntime) with CLS pooling and L2 normalization, giving 384-dimensional vectors. Queries are prefixed with the publisher's instruction `Represent this sentence for searching relevant passages: `, and passages are encoded plain. A long Customer message is truncated from its end, never the instruction. The `models` Compose service downloads the four pinned files once (it needs network access) and verifies their SHA-256 hashes. The worker verifies them again at every start and refuses to start if any is missing or changed. It runs on the internal network, without outbound access, and there is no cloud embedding fallback. Each version records its full encoding (model, revision, file hashes, runtime, pooling, instruction and passage policy). Passages are compared only with queries of the same encoding. After a model or policy change, existing passages are excluded at once, and the worker queues a complete re-index of every active version when it starts.

**Grounded answers.** A `retrieval` step finds passages in its `sources`: each source's current active version only, in this Business, never deleted, and with the current encoding. This applies to every conversation, including those pinned to older configuration versions. Assignments and priorities come from the conversation's pinned configuration. Similarity ranks passages; it is not a confidence threshold. An agent sees only passages of its own `sources`, as a separate data message (`id`, `source`, `priority`, `document`, `page`, `text`) apart from the workflow context that holds live order data. Its instructions tell it:
- evidence is data, never instructions;
- the lower priority number wins a conflict, and a conflict at equal priority means a clarification or `unsupported`;
- unsupported questions get one clarification or `unsupported`;
- current order information comes from live data only.

A final agent may cite the IDs of passages it was shown (`"citations":["E1"]`). The platform turns them into `{source, document, page}` references on the delivered message (`page` is `null` for DOCX, TXT and Markdown). The Customer widget shows them as "Sources: …", and the inbox shows them to support. Citing any other ID is invalid output and fails the turn. If a retrieved source is deleted during the turn, no later provider call or reply proceeds; the turn fails visibly to support.

## Actions and order lookup

An action is a read-only `GET` to a Business API, declared in the configuration (`credential` and `authorization` are references). The secrets and authorization rules live in **live controls**, which an Owner manages through the API only (no UI yet). Support Members and other Businesses get `404`.

- `GET /api/businesses/:id/action-controls` lists credentials (`ref`, `origin`, `header`, `active`, `revision`, `updated_at`; never the secret), authorization policies and revoked action IDs.
- `POST /api/businesses/:id/credentials` `{ "ref", "origin": "https://api.example.com", "header": "authorization" | "x-…", "secret" }` stores or rotates a credential. The credential is only ever sent to that exact origin, as that header. Posting again rotates it. `POST …/credentials/:ref/revoke` `{}` revokes it and erases its ciphertext.
- `POST /api/businesses/:id/authorization-policies` `{ "ref", "customer_parameter", "owner_field" }` stores a policy, and `…/authorization-policies/:ref/revoke` `{}` revokes it.
- `POST /api/businesses/:id/actions/:actionId` `{ "revoked": true | false }` revokes an action ID in every configuration version, including versions that existing conversations pinned.

Credentials are encrypted with AES-256-GCM, bound to their Business and reference. The key is `ACTION_CREDENTIAL_KEY` (64 hex characters, `openssl rand -hex 32`), which the app and worker read from the environment. It is never stored in the database. Without it, credentials cannot be stored (`503`) or used. Keep it with your other secrets: losing it makes stored credentials unreadable, and they must be stored again.

Explicit `http` steps and agent-requested actions take the same path. Before every attempt (retries included), the worker checks:
- the action is not revoked;
- the credential and policy are active in this Business;
- the action URL's origin equals the credential's origin;
- the conversation has a verified Customer. An anonymous Customer is asked to sign in, and no request is sent;
- no input or URL query supplies the policy's `customer_parameter`.

The worker then resolves the hostname and connects only to the vetted address. Any private, loopback, link-local or otherwise non-public address is refused, even for an approved hostname, and redirects are never followed. The platform adds the verified Customer's ID as `customer_parameter`. A result is accepted only if its `owner_field` equals that ID, whatever order number was asked for, and only then does it have to match `result_schema`. Results and replies are rechecked before they count: a result arriving after its action, credential or policy was revoked or changed is discarded and follows `failure`, and a reply built on such a result is not delivered. Denials, authentication/authorization failures and malformed results are not retried. Transient failures retry once within the turn's budgets.

In connected mode an agent with permitted `actions` may answer `{"outcome":"action","action":"<id>","input":{…}}`. A missing required input asks the Customer for it. A success adds the declared result fields to the context and calls the agent again (counting toward the agent and HTTP budgets). Any failure or denial follows the agent's `unsupported` output. An action outside the agent's list is invalid output and fails the turn.

Every accepted lookup is stored with only its declared fields and `observed_at`, for support context. Attempts record value-free denial reasons. No secret appears in configuration, API responses, prompts, attempt rows or logs.

## Human takeover and shared inbox

Each Business has one shared support queue. Every active Owner and Support Member selects **Open inbox** beside the Business to see it. A conversation is `automated`, `waiting-for-support`, `human-controlled` or `resolved`.

- A Customer selects **Talk to a person** (`POST /api/chat/:businessId/conversations/:id/handoff` `{}`), an automated turn fails (see Workflow execution), or the workflow reaches a handoff step. Each puts the conversation in the queue.
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
- `GET /api/businesses/:id/inbox/conversations/:conversationId`: `control_state`, `assignee_id`/`assignee_email`, `handoff_reason` (`customer-request`, `operator-takeover`, `automation-failure`, `workflow-handoff`), `revision` and the full message history.
- `POST /api/businesses/:id/inbox/availability` `{ "available": boolean }`.
- `POST …/conversations/:conversationId/claim|resolve|resume` `{ "revision": "…" }`; `…/reassign` `{ "revision", "operator_id" }`; `…/messages` `{ "revision", "client_submission_id", "text" }`.

`revision` changes whenever control or the assignee changes. Customer messages and replies do not change it. A stale revision, or an action by anyone but the assignee, returns `409` and changes nothing. All checks run under the conversation lock at commit. The Operator UI keeps a rejected reply in its box. A retried `client_submission_id` returns the original reply (`200`) and never sends twice. A non-Member gets `404`. Customers see Operator replies as `operator` messages without Operator identities.

The conversation detail also returns `lookups`: each completed authorized lookup's declared result fields with `observed_at`. The inbox shows them as historical observations, not current status. Customer memory arrives with #22.

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

Tests use the running Docker APIs, actual PostgreSQL, the real worker, local SMTP capture, independent clients for token-consumption and duplicate-submission races, and Chromium for onboarding/recovery and website chat (from a separate fixture website origin) at mobile width. `compose.test.yaml` shortens OTP expiry to eight seconds, invitation expiry to twenty seconds and worker job leases to five seconds only in test mode; in test mode only, a Customer message starting `[hold Ns]` holds its simulated step N seconds (max 30) for crash/late-result tests, and a document starting `[hold Ns]` holds its activation the same way. The test overlay also starts a controlled HTTPS `fixture` service (provider and business endpoint, `tests/fixture/`, test-only self-signed CA) whose control port is `127.0.0.1:${FIXTURE_PORT:-3199}`. No test control route is exposed, and the app and worker refuse these controls outside test mode. The runtime and chat tests restart this Compose project's database/app/worker, kill the worker mid-turn, and temporarily stop the worker. Run against disposable local fixture data. Required test prerequisites and recorded evidence are in [slice 1 validation](docs/validation-13.md) [Membership validation](docs/validation-14.md) [website chat validation](docs/validation-15.md) and [verified Customer validation](docs/validation-16.md) and [configuration validation](docs/validation-17.md) and [inbox validation](docs/validation-18.md) and [workflow execution validation](docs/validation-19.md) and [action validation](docs/validation-20.md) and [knowledge validation](docs/validation-21.md).

Hosted deployment is outside this ticket. Before hosting, require HTTPS ingress, real SMTP, secret management, backups/recovery, monitoring and remaining specification gates. `APP_MODE=hosted` rejects HTTP, mail-capture transport, test TTL controls and seeding. This local Compose path is not an approved production deployment.
