# Custom Bot

Slices of [the platform specification](https://github.com/taufiq0205/custom-bot/issues/12): Docker launch, verified Operator email/password access, recovery, durable Business creation as Owner, Business Membership invitations, role changes and revocation, durable anonymous website chat with labelled simulated replies, verified Customer identity from Business websites, Owner-only JSON configuration drafts with explicit immutable publication, human takeover through a shared support inbox, bounded execution of the published workflow, authorized live order lookups through Owner-controlled read-only HTTPS actions, the visual workflow editor, document and scoped website knowledge with local embeddings and cited answers, consented Customer memory, DeepSeek generation with one permitted Qwen fallback, and Jev typed workflow decisions. The archived configuration prototype remains an interaction reference.

Requires Docker Compose v2, arm64 or amd64, and free local ports 3100/8025. The first build downloads pinned images and locked dependencies. No cloud keys or model downloads are needed: document knowledge is optional and needs a one-time `docker compose run --rm models` (see Knowledge and [docs/models.md](docs/models.md)).

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

The explicit demo seed is described in [Portfolio demo](#portfolio-demo-northwind-kettles). Seeds never run during startup, and are rejected in `APP_MODE=hosted`. Keep local mail capture limited to development.

Owners select **Manage** beside their Business to invite a verified Operator as Owner or Support, change a current Member's role, revoke access, or cancel a pending invitation. Invitation tokens arrive only at the intended email; the recipient signs in with that verified account and pastes the token into **Accept invitation**. Invitations expire after seven days, are single-use, and are superseded by a new invitation to the same email. Existing active Memberships cannot be overwritten through invitation acceptance. Revocation cancels pending invitations to that Member; demotion/revocation also cancels grants issued by that Owner. A fresh authorized invitation can restore revoked access. Every privileged request rechecks the current Business Membership; authority in another Business cannot grant access. Revocation does not require account sign-out. Concurrent changes preserve at least one active Owner.

Membership APIs: `GET /api/businesses/:id/memberships`; `POST /api/businesses/:id/memberships/:operatorId` with exactly `{ "role": "Owner" | "Support", "active": boolean, "revision": "expected revision" }`; `GET/POST /api/businesses/:id/invitations` (creation accepts exactly `email` and `role`); `POST /api/businesses/:id/invitations/:invitationId` with `{}` cancels; `POST /api/invitations/accept` with exactly `token`. Owner-only access failures and foreign references return 404; stale revisions and last-Owner changes return 409. Public invitation lists omit token/verifier values. Configuration, action-control, preview and trace APIs are Owner-only (below).

## Portfolio demo (Northwind Kettles)

One command prepares a complete, labelled demo of one fictional Business, **Northwind Kettles** (a small kettle and appliance shop). It covers website chat, cited knowledge answers, Customer memory, an authorized order lookup, Jev routing, handoff to the shared inbox and the Owner's trace view. It runs in simulation without any key, or connected with real providers.

**Everything about Northwind Kettles is synthetic.** It is not a real business. Its documents, help site, products, orders and Customers are invented. Its keys protect nothing real. The files live in [`demo/`](demo):

- `cert.pem`/`key.pem`: a local-only demo CA certificate for `northwind.demo.test`, and its key.
- `customer-key.json`: the shop's Customer signing key. It is committed, so anyone with this repository can sign in as any demo Customer of the demo Business. Never register it for any other Business.
- `demo.json`: the order API key.
- `orders.json`, `documents/` and `site/`: the order data, policy documents and help site.

That is why hosted mode refuses the demo settings and the seed.

### What runs

A `demo` Compose profile adds one bundled service, `demo` ([`demo/server.mjs`](demo/server.mjs)):

- **HTTPS on the private Docker network as `northwind.demo.test`.** It serves Northwind Kettles' order API (`GET /orders?customer=…[&order_id=…]` with the `x-demo-key` header) and a static help site (`/help/`, with `robots.txt`). The order API returns only the requesting Customer's orders.
- **HTTP on `127.0.0.1:3300`.** The demo shop page embeds the chat widget. Its backend holds the Customer signing key and signs a 10-minute ES256 assertion for the demo Customer `demo-customer-ada` when you click **Sign in as demo customer**. **Sign out** reloads the page without one, and the widget then ends the verified chat session.

The worker reaches the demo service only when `DEMO_PUBLIC_HOSTS=northwind.demo.test` is set (exactly that one name) in `APP_MODE=local`, or in `test` for the test suite. Then that name may resolve to the private network, and its certificate is verified only through the demo CA, which verifies nothing else. Hosted mode refuses `DEMO_PUBLIC_HOSTS` and `DEMO_CA_FILE` at startup. Every other check stays: HTTPS, the approved origin, credentials, the ownership policy, schemas, robots.txt and the crawl scope. Readiness then reports `"demo": "northwind.demo.test: demo service, not a real business"`.

### Prerequisites

- Ports 3100, 8025 and 3300 must be free.
- In `.env`:
  - `COMPOSE_PROFILES=local,demo` and `DEMO_PUBLIC_HOSTS=northwind.demo.test`.
  - `ACTION_CREDENTIAL_KEY` (`openssl rand -hex 32`), so the orders credential can be stored.
  - `SEED_OWNER_EMAIL` and `SEED_OWNER_PASSWORD` for the Owner, and `SEED_SUPPORT_PASSWORD` for the demo Support Operator.
- The embedding model, installed once: `docker compose run --rm models` (needs network).
- Connected mode only: `DEEPSEEK_API_KEY` and `TYPESAFE_API_KEY` (and optionally `DASHSCOPE_API_KEY` for the Qwen fallback), plus `compose.connected.yaml` for outbound HTTPS (see Providers).

### The command

```sh
docker compose up --build -d --wait
docker compose run --rm models            # once
# Open http://localhost:3100, create the SEED_OWNER_EMAIL account and verify it (code at http://localhost:8025).
docker compose --profile seed run --rm seed                    # simulation, no keys

# Connected, with real providers:
docker compose -f compose.yaml -f compose.connected.yaml up -d --wait
docker compose -f compose.yaml -f compose.connected.yaml --profile seed run --rm seed node dist/seed.js --connected
```

The seed signs in as the Owner and creates everything through the app's own APIs, so every authorization and validation check applies:

- the Business, with a `demo_seeds` marker;
- the Support Operator `support@northwind-kettles.test`, signed up, verified through Mailpit, invited and accepted;
- the approved website origin `http://localhost:3300`, and the Customer signing key `northwind-demo-1`;
- the orders credential `northwind-orders` (sent only to `https://northwind.demo.test`), and the ownership policy `own-orders` (`customer` → `customer_id`);
- the sources: the policy PDF (`policies`, priority 1, page-level facts on returns, warranty and delivery), the care guide in Markdown (`care-guide`, priority 2), and the help site (`help-centre`, priority 3, crawled from `https://northwind.demo.test/help/`, never a third-party site);
- the published workflow. A Jev `decision` (`policy`, `order` or `other`, threshold 0.6) leads to one of three routes:
  - `policy`: retrieval, then the `policy` agent answers with citations;
  - `order`: an `http` lookup of `my_orders`, then the `orders` agent answers;
  - `other`, `uncertain`, `failure`, and an unsupported answer: handoff.

  Both agents use `deepseek/deepseek-flash` with the `qwen3.7-plus-2026-05-26` fallback. The `orders` agent may also look up one order by number.
- with `--connected` only: the Business's provider permissions (DeepSeek and Qwen generation and extraction, Jev decisions), and `generation.mode: "connected"`. Without it, the published workflow runs in simulation. The seed never revokes permissions it granted earlier; revoke them under **Cloud providers**.

It then waits for ingestion and the crawl, and prints the shop link, `http://localhost:3300/?business=<id>`.

A rerun creates only what is missing and prints `Already exists:` for the rest. Two concurrent runs serialize on a database lock. Changing modes publishes a new version.

### Walkthrough

1. **Chat with a cited answer.** Open the shop link and ask *"What is your returns policy?"*.
   - Connected: the answer cites `northwind-policies.pdf, page 1`.
   - Simulation: the reply is labelled simulated and contains no business facts. The trace still shows the passages retrieval found.
2. **Memory** (connected). Click **Sign in as demo customer**, opt in under **Customer memory**, and say *"Please call me Ada and keep answers brief."* The next reply uses the preference, and the panel lists it. Product interests accept only a fixed list, and kettles are not on it. In simulation, opt-in and corrections work, but nothing is extracted.
3. **Order lookup.** Signed in, ask *"Where is my order?"*. The worker calls the demo order API as `demo-customer-ada` and checks that the result is hers. It gets NK-1001 and NK-1002, never another Customer's NK-2001. Signed out, the assistant asks you to sign in.
4. **Jev route.** Each message is first routed by Jev. Simulation sends no Jev request; it picks the choice whose description shares the most words with the message, and the trace labels that a keyword match.
5. **Handoff.** Say *"hello"* (or anything outside policies and orders). The conversation waits for support. Sign in at http://localhost:3100 as `support@northwind-kettles.test`, open the Northwind Kettles inbox, claim it and reply.
6. **Traces.** As the Owner, open **Traces** for that conversation. It shows:
   - the Jev choice and probability (or the simulated keyword match);
   - the retrieved and cited passages;
   - the lookup's returned fields;
   - each model call with tokens and cost;
   - the published version it ran on.

### Reset

- **Restore the setup.** Rerun the seed. It republishes the demo configuration if it changed, and uploads a deleted source again. It also re-stores a revoked credential, re-approves a withdrawn origin and re-invites a removed Support Member.
- **A new key.** The orders credential is encrypted with `ACTION_CREDENTIAL_KEY`. After changing that key, revoke `northwind-orders` (**Actions**) and rerun the seed.
- **Start with no chat history in the shop.** Sign out, then clear the site data of `localhost:3300`.
- **Wipe everything.** `docker compose down -v` deletes all local data: every Business, account and conversation, not only the demo's.

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
- optional `decision`: `{engine: "jev" | "laya" | "von", model?}`, the one engine every `decision` step uses (required once a workflow has one). Jev's model defaults to `jev-latest`; Laya and Von arrive with #30 (see Decisions).
- optional `sources`: `[{id, priority: 1–1000}]`. A source `id` names the Knowledge source uploaded under that ID. When passages conflict, the lower priority number takes precedence.
- `agents`: `[{id, name, instructions, sources?, actions?, model?: {provider: "deepseek" | "qwen", name, temperature?: 0–2, max_tokens?: 1–8192, fallback?: {provider: "qwen", name}}}]`. Only a DeepSeek model may name a fallback (see Providers). Model names are free choices; the evaluated candidates are `deepseek-flash` (which DeepSeek serves with DeepSeek-V4.1-Flash) and `qwen3.7-plus-2026-05-26`.
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
| `decision` | `question` (1–2000 characters), `choices` (2–20 `{name: description}`; names like field names, not `uncertain` or `failure`), `min_probability` (0–1) | each choice name, `uncertain`, `failure` |

Connections are `{from, output, to}`, and `to` may be `null` in a draft.

New Businesses start with a publishable simulation draft: one agent with its `unsupported` output connected to a handoff. Businesses created before this slice keep their original version 1, whose single agent lacks that connection. Their draft therefore shows one blocker until a handoff is connected.

## Website chat (simulated)

Every Business starts with an immutable, system-published configuration version 1 whose generation mode is `simulation`; it is created with the Business (and backfilled for existing ones) and cannot be updated or deleted. Every simulated reply is labelled `simulated: true` and says that no AI model generated it. Simulation needs no keys and stays available. Connected mode uses real providers only (see Providers); without a key, permission or model it fails the turn visibly instead of pretending to generate.

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

Deferred to later slices: 90-day retention (#24). Anonymous session creation is not yet rate limited; put hosted deployments behind ingress rate limiting.

## Workflow execution

Each Customer message in an `automated` conversation is one turn. The worker runs the conversation's pinned published workflow from its `entry`:

| Step | Behaviour |
| --- | --- |
| `retrieval` | Retrieves the three passages most similar to the Customer's message from each of the step's `sources` (see Knowledge), then continues to `next`. |
| `condition` | `yes` when the structured context field strictly equals `equals` (`true` is not `1`, and `1` equals `1.0`), otherwise `fallback`. |
| `http` | Runs the action through the central action checks (see Actions). It takes the action's input properties from the context. If a required one is missing, the turn sends one clarification built from the property `description` ("To continue, please tell me your order number.") and ends. The next message starts a new turn. A result matching `result_schema` merges its declared top-level properties into the context and goes to `success`. Undeclared properties are dropped. Anything else goes to `failure`. |
| `agent` | In `simulation` mode a final agent gives the labelled simulated reply, and other agents continue with no context. In `connected` mode the agent's model must reply with one JSON object. Intermediate agents return `{"outcome":"next","context":{…}}` (at most 20 flat text/number/boolean fields), which is never shown to the Customer. Final agents return `{"outcome":"reply","reply":"…"}`. Any agent can return `{"outcome":"unsupported"}`, which follows its `unsupported` output. Only the final agent's reply is delivered. Context reaches the model as data in a user message, never as instructions, and an agent cannot overwrite a field set by a verified HTTP result. If it tries, the turn fails. |
| `handoff` | Completes the turn and queues the conversation for support (`workflow-handoff`). |
| `decision` | Asks the selected decision engine which declared choice fits the Customer's message (see Decisions), and follows that choice's output, `uncertain` or `failure`. Adds nothing to the context. |

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
- Consent and memory revalidation join the same check with #23–#24. Source deletion already does (see Knowledge).

## Providers (connected generation)

Connected agents generate with DeepSeek at `https://api.deepseek.com` (an agent may also select a Qwen model directly, under Qwen's permission), and may name one Qwen fallback at exactly `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`. Both use `POST …/chat/completions` in JSON mode. Qwen is sent `enable_thinking: false`, because its JSON mode does not support thinking.

**Keys.** Set `DEEPSEEK_API_KEY` and `DASHSCOPE_API_KEY` (a Singapore/International Model Studio key) in `.env`. Only the worker receives them, and each is sent only to its own endpoint. No key value appears in the app container, API responses, configuration, prompts, attempt rows or logs. Without a key, a connected agent is unavailable: the turn fails visibly to support and nothing is sent. Simulation is unaffected.

**Egress.** The default launch keeps the worker on the internal network with no outbound access, so real calls need the connected overlay:

```sh
docker compose -f compose.yaml -f compose.connected.yaml up -d --wait
```

Never combine it with `compose.test.yaml`; the tests prove the worker runs without egress.

**Permissions.** Nothing is sent to a provider unless an Owner currently allows it for that Business and operation (**Team and website → Cloud providers**, or the API). Support Members and other Businesses get `404`.
- `GET /api/businesses/:id/provider-permissions`: every `{provider, operation, allowed, revision, updated_at}` pair (off until allowed), `providers`, the worker's endpoint/key readiness, and `selected`: the latest published version's mode and each agent's `model` and `fallback` (what new conversations use).
- `POST /api/businesses/:id/provider-permissions/:provider/:operation` `{ "allowed": true | false }`, for `deepseek` or `qwen` with `generation` or `extraction`, or `jev` with `decision` (see Decisions). Other pairs are `404`.

Like action controls, permissions are live and override pinned configuration versions. The worker checks the provider's permission before each attempt, and checks that it is unchanged before accepting the output and before delivering the reply. Every change bumps the revision, so revoking (even if allowed again at once) discards output already in flight. The same recheck runs again just before delivery, as defense in depth. An agent's output also cannot travel to a later provider call once its own provider's permission changed.

**Fallback.** A transient failure (timeout, connection error, 429 or 5xx) gets exactly one more attempt. With a `fallback`, that attempt goes to Qwen, if Qwen generation is allowed and its key is set; otherwise the turn hands off and nothing is sent to Qwen. Without a `fallback`, the same model is retried once. There is never a third attempt or provider. Both attempts count toward the 3 agent calls and the 60-second deadline. These are not retried and hand off at once: authentication or authorization failures (401/403), other 4xx errors, non-JSON or truncated output (`finish_reason` other than `stop`), and output outside the agent contract. A blank reply counts as transient, since DeepSeek documents that JSON mode occasionally returns empty content; this also applies to memory extraction. Every agent request ends with a short closing instruction after all data ("Answer now with the one JSON object described in your instructions."), because without it DeepSeek's JSON mode often returned blank replies. Replies are delivered only when the whole turn finishes, so a fallback never follows partly delivered text.

**Processing scope.** Qwen's endpoint is Singapore for access and static storage. Inference may run anywhere in the world except Chinese mainland, so this is not Singapore-only processing. Readiness and the Cloud providers view say so.

**Readiness and measurements.** `GET /health/ready` reports `generation`: simulation, and for each provider its endpoint, role and whether its key is configured. A configured key is reported as needing `compose.connected.yaml` for outbound calls, and as "account and model access not verified until a measured run", never as available. Each provider attempt records, value-free:
- provider/model and operation;
- whether it was the fallback;
- status and error;
- timing;
- the model the provider reports serving;
- prompt and completion tokens;
- an estimated cost.

The worker logs one redacted line per attempt with the same data. Cost uses optional `PROVIDER_RATES`, JSON such as `{"deepseek/deepseek-flash":[0.5,2]}` (USD per million input and output tokens, keyed by the served model). Without a rate, no cost is estimated. The Owner trace view arrives with #27.

## Decisions (Jev)

A `decision` step asks Jev (TypeSafe) one typed question about the current Customer message and routes on the answer. Jev supplies only a choice name. Its answer never becomes reply text, context or prompt data, and never authorizes anything: an action reached through a decision still passes every central action check, so an anonymous Customer is still asked to sign in.

- **Request.** `POST https://api.typesafe.ai/v1/systemone` with the worker-only `TYPESAFE_API_KEY`, the configured `model` (default `jev-latest`), `state: {"customer_message": …}` (only the message, never history, context, evidence or preferences), and two questions in one request: a `choice` with the step's `question` as instructions and its `choices` as criteria, and a `noul` asking whether the message is written in English.
- **Validation, each check on its own.** The answers must be exactly those two, with the right types. The choice must be a declared name, and its probabilities must cover exactly the declared names, each 0–1, summing to 1 (within rounding), with the choice the most probable. The message must be English (probability at least 0.5); other languages take the failure route until they are evaluated. Only then is `min_probability` compared with the validated probability of the chosen option, not the reported confidence. Below it, the step follows `uncertain`.
- **Failure route.** Anything else follows `failure` with a recorded reason: malformed or non-JSON output, an undeclared choice, inconsistent probabilities, an unsupported language, a refusal such as context overflow (`status 400 max_tokens_exceeded`) or authentication (`status 401 authentication_error`), no permission, no key (`decision unavailable: TYPESAFE_API_KEY not set`, nothing sent) and a Laya or Von engine (not available in this version; nothing is sent to Jev instead). Jev refuses an oversized input rather than truncating it. Configured questions and choices are bounded, and messages are at most 2,000 characters.
- **Bounds.** Each attempt has a 15-second wall-clock timeout within the 60-second deadline. A transient failure (timeout, connection error, 429, 529 or 5xx) gets one more attempt; 4xx refusals are not retried. Decision attempts do not use the 3 agent calls; the 20-step limit and the deadline bound them.
- **Permission.** An Owner allows `jev`/`decision` per Business (**Team and website → Cloud providers → Allow Jev decisions**, or `POST /api/businesses/:id/provider-permissions/jev/decision`). The worker checks it before each attempt (without it nothing is sent and the step follows `failure`) and again before accepting the answer: revoking it while Jev answers discards the answer and stops the turn visibly to support, whatever the failure route leads to. As with generated text, what a decision routed to is delivered only while that permission stands.
- **Records.** Each attempt is recorded and logged value-free, like generation: target `jev/<model>`, operation `decision`, status and reason, the served model (`jev-1.13.0`), input/output tokens, and a cost estimate from `PROVIDER_RATES` (Jev charges input tokens only, for example `{"jev/jev-1.13.0":[0.042,0]}`). Readiness reports Jev's endpoint and key state, never the key.
- **Simulation mode.** Simulation calls no engine. A decision step picks the choice whose description shares the most words with the message (`uncertain` when none do, or on a tie), and the trace labels it `simulated` (a keyword match, not inference). No attempt is recorded, and nothing is sent. Connected mode always routes with the selected engine.

## Preview chat and execution traces

In **Configuration**, **▷ Preview chat** lets an Owner chat as an anonymous preview Customer:
- **Pinned version.** Each New chat pins the latest *published* version, exactly like a website conversation; the draft never runs. Every reply shows its version and whether it ran in simulation or connected mode.
- **Real execution.** Connected mode calls the real providers (with their cost) under the same permissions and checks.
- **Never in the inbox.** Preview conversations are invisible to Support. One that reaches a handoff stays paused, so start a New chat.

Under each reply is its **execution trace**:
- **What it shows:** the steps the turn ran, in order, with type, status, route taken and timing. Each provider or HTTP attempt shows its target, status, reason, served model, tokens, cost estimate and whether it was the Qwen fallback.
- **Safe references only:** evidence by source, document and page; decision choice and probability; lookup result and context field *names*; citations.
- **Never shown:** prompts, messages, passage text, field values, inputs, Customer identities or secrets.
- **Turn outcome:** it comes from the job, not from the last step. A step left unfinished by a worker stop shows as `interrupted`.

**Recent conversations** in the same panel opens the trace of any recent Customer or preview conversation.

Selecting a trace step only navigates; nothing in the draft changes:
- **Canvas:** it selects the step's node.
- **JSON view:** it selects the step's ID in the text. If the draft JSON is invalid, it finds the ID by text search and says so.
- **Not in the draft:** a step that ran in an older version but is missing from the draft, or has another type there, is labelled that way and is not located.
- **Version:** every status line names the version that actually ran.

APIs (Owner of the Business only; Support, other Businesses and demoted Owners get `404`):
- `POST /api/businesses/:id/preview` `{}`: `201 {conversation}`, pinned to the latest published version (`configuration_version`, `mode`).
- `GET /api/businesses/:id/preview/:conversationId`: the preview conversation and its messages.
- `POST /api/businesses/:id/preview/:conversationId/messages` `{ "client_submission_id", "text" }`: `202`. A retried submission returns the original (`200`); the same ID with other text gets `409`.
- `GET /api/businesses/:id/traces`: the 50 most recent conversations with messages, each with `preview`, `configuration_version` and `mode`.
- `GET /api/businesses/:id/traces/:conversationId`:
  - the pinned `configuration_version`, `mode` and `published_at`;
  - per turn, the job's `status` and `error`;
  - its `steps`: `ordinal`, `step_id`, `type`, `status`, `output`, `error`, `detail`, and the start and finish times;
  - its `attempts`, each linked to its step by `step_ordinal`.

## Knowledge (documents and websites)

An Owner uploads documents under a source ID that the configuration's `sources` declare (**Manage → Knowledge**, or the API below). Support Members and other Businesses get `404`.

- `POST /api/businesses/:id/sources/:sourceId?document=<file name>` with the raw file as the request body. `Content-Length` is required. Accepted names end in `.pdf`, `.docx`, `.txt`, `.md` or `.markdown`. The limit is 20 MB (20,000,000 bytes); a larger upload gets `413` before anything is stored. `202` means only that ingestion is queued.
- `GET /api/businesses/:id/sources`: for each source, `active` (`document`, `format`, `passages`, `activated_at`, or `null`), the `latest` upload (`state`: `queued`, `running`, `active`, `superseded` or `failed`, with `error`) and a `warning` when the latest upload failed.
- `POST /api/businesses/:id/sources/:sourceId/expire` `{}`: the active version stops answering at once, its passages and bytes are removed, and no upload made before the expiry can activate later. The source stays listed as expired until a new upload replaces it. `404` when nothing is active.
- `POST /api/businesses/:id/sources/:sourceId/delete` `{}`: removes the source and every version.

**Website sources.** A source is a document or a website for life; using the other kind under an existing ID gets `409`.
- `POST /api/businesses/:id/sources/:sourceId/website` `{ "url": "https://shop.example.com/help/", "required": ["https://shop.example.com/help/returns"] }` creates the source, or replaces its scope, and queues a refresh (`202`). The URL is an HTTPS scope ending in `/`, without credentials, query, fragment, dot segments or encoded separators, at most 200 characters. `required` is optional: up to 20 page URLs inside the scope.
- `POST /api/businesses/:id/sources/:sourceId/refresh` `{}` queues a refresh (`202`). While one is pending, it returns that one. Documents get `409`.
- The list adds `kind`, `website` (`url`, `required`, `next_refresh_at`), `active.pages`, `active.fresh_until` and `fresh`. Websites cannot be expired explicitly (`404`); they expire on their own.

**Crawling.** A refresh starts from the scope URL and every required page, and follows links to pages on the same host under the scope path that the host's `robots.txt` permits for `CustomBotKnowledge`. Rules use longest match with wildcards (Python 3.14 `urllib.robotparser`). Redirects of `robots.txt` are followed, to other hosts too, as RFC 9309 asks. A missing `robots.txt` (4xx) permits everything; 401/403 forbid everything; an unreachable one (5xx, timeout) fails the refresh. Every request, robots included, resolves the host again and goes only to public addresses (as for actions), with the certificate verified. Every redirect hop of a page (at most five) must stay in scope and be permitted by robots. Links are percent-encoded as a browser would. Malformed links are skipped, and so are links with a query string, which would otherwise fill the page limit with duplicates. Pages are HTML, at most 2 MB each, decoded with the header's charset, else one declared in the page, else UTF-8. Their visible text becomes passages that cite the page URL (`page` is `null`). Each fetch is bounded by 15 seconds.

**Complete snapshots.** A snapshot is at most 100 permitted pages, counting redirect targets and excluding pages robots forbids. Discovering a 101st fails the refresh before it is fetched. These also fail the whole refresh: a required page (the scope URL included) that is forbidden, redirected out of scope, gone, not HTML or without text; any permitted page failing transiently (timeout, 429, 5xx); and robots being unreachable. A discovered page that is gone (4xx), not HTML or redirected out of bounds is skipped. A failed refresh never replaces the active snapshot, and its `warning` says which snapshot answers until when. As with documents, activation is one transaction, and deletion defeats any held or racing refresh.

**Schedule and freshness.** The next daily refresh is due a day after the last refresh finished, whether it succeeded or failed, or was requested while one is still pending. The worker queues a due refresh unless one is pending. Website evidence is used for seven days after its last successful refresh (the active snapshot's activation). After that, it is excluded from retrieval at once, and a turn still holding its passages is not delivered (the same check as deletion). The source then shows "Website evidence expired …" until a refresh succeeds. Documents have no such limit.

**Outbound access.** Refreshes need outbound HTTPS. The default stack has none, so a refresh there fails with `robots.txt of … could not be fetched (connection failed); website refresh needs outbound HTTPS (compose.connected.yaml)`. Use `docker compose -f compose.yaml -f compose.connected.yaml up -d --wait`.

**Ingestion.** The worker extracts text from text PDFs (pypdf; one passage set per page), DOCX (`word/document.xml`), and UTF-8 TXT and Markdown. Nothing unreadable is reported as ingested: a PDF fails if any page has no extractable text (scanned pages need OCR, which is not supported), so no partly scanned file is reported as ingested, and corrupt, mislabelled, non-UTF-8, binary or empty files fail. The text is split into passages of whole lines, packed up to 350 tokens counted with the model's tokenizer and never crossing a PDF page. Long lines split at token boundaries. Every passage is checked to fit the model's 512-token input. Uploaded bytes are kept in PostgreSQL, on the database volume, only while they are needed: for queued work, and for the active version so that it can be re-indexed.

**Versions.** A version activates only when it is completely parsed and embedded. Activation happens in one transaction that inserts all its passages and replaces the previous version. A failed, interrupted (worker restart) or older-than-active candidate never replaces the active version. The Knowledge view and `warning` then say that answers still use the previous document. Deletion is final. It removes every version's passages and bytes in the transaction that reports it, and a delayed ingestion of a deleted source never activates. Uploading under the same ID afterwards starts a new source.

**Embeddings (optional).** `BAAI/bge-small-en-v1.5` at commit `5c38ec7c405ec4b44b94cc5a9bb96e735b38267a`. The worker runs the publisher's FP32 ONNX export on the CPU execution provider (onnxruntime) with CLS pooling and L2 normalization, giving 384-dimensional vectors. Queries are prefixed with the publisher's instruction `Represent this sentence for searching relevant passages: `, and passages are encoded plain. A long Customer message is truncated from its end, never the instruction. The model is not downloaded by default. `docker compose run --rm models` downloads the four pinned files once (it needs network access) and verifies their SHA-256 hashes; then `docker compose restart worker`. The worker verifies the files at every start. If any is missing or changed, knowledge is unavailable while chat and lookups keep working. Readiness reports `knowledge` (available, or why not and what to run), uploads fail visibly, and a turn reaching a `retrieval` step goes to support. The worker runs on the internal network, without outbound access, and there is no cloud embedding fallback. Each version records its full encoding (model, revision, file hashes, runtime, pooling, instruction and passage policy). Passages are compared only with queries of the same encoding. After a model or policy change, existing passages are excluded at once, and the worker queues a complete re-index of every active version when it starts.

**Grounded answers.** A `retrieval` step finds the three passages most similar to the Customer's message in each of its `sources`, so a lower-priority source cannot crowd out a higher-priority one. It searches each source's current active version only, in this Business, never deleted, and with the current encoding. This applies to every conversation, including those pinned to older configuration versions. Assignments and priorities come from the conversation's pinned configuration. Similarity ranks passages; it is not a confidence threshold. An agent sees only passages of its own `sources`, as a separate data message (`id`, `source`, `priority`, `document`, `page`, `text`) apart from the workflow context that holds live order data. Its instructions tell it:
- evidence is data, never instructions;
- the lower priority number wins a conflict, and a conflict at equal priority means a clarification or `unsupported`;
- unsupported questions get one clarification or `unsupported`;
- current order information comes from live data only.

A final agent may cite the IDs of passages it was shown (`"citations":["E1"]`). The platform turns them into `{source, document, page}` references on the delivered message (`page` is `null` for DOCX, TXT and Markdown). The Customer widget shows them as "Sources: …", and the inbox shows them to support. Citing any other ID is invalid output and fails the turn. If a retrieved source is deleted or expired during the turn, no later provider call or reply proceeds; the turn fails visibly to support.

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
# Restore normal five-minute expiry after tests. --remove-orphans also stops the test fixture, which otherwise keeps
# answering as api.deepseek.com, dashscope-intl.aliyuncs.com and api.typesafe.ai on the internal network:
docker compose up -d --wait --remove-orphans
```

Tests use the running Docker APIs, actual PostgreSQL, the real worker, local SMTP capture, independent clients for token-consumption and duplicate-submission races, and Chromium for onboarding/recovery and website chat (from a separate fixture website origin) at mobile width. `compose.test.yaml` shortens OTP expiry to eight seconds, invitation expiry to twenty seconds and worker job leases to five seconds only in test mode; in test mode only, a Customer message starting `[hold Ns]` holds its simulated step N seconds (max 30) for crash/late-result tests, and a document (or a website's first page) starting `[hold Ns]` holds its activation the same way. The test overlay also starts a controlled HTTPS `fixture` service (answering as `api.deepseek.com`, `dashscope-intl.aliyuncs.com` and `api.typesafe.ai` on the test network only, plus a business endpoint; `tests/fixture/`, test-only self-signed CA and synthetic worker keys) whose control port is `127.0.0.1:${FIXTURE_PORT:-3199}`. It also always starts the bundled `demo` service and enables `DEMO_PUBLIC_HOSTS` for it, exactly as a local demo does. No test control route is exposed, and the app and worker refuse these controls outside test mode. The runtime and chat tests restart this Compose project's database/app/worker, kill the worker mid-turn, and temporarily stop the worker. Run against disposable local fixture data. Required test prerequisites and recorded evidence are in [slice 1 validation](docs/validation-13.md) [Membership validation](docs/validation-14.md) [website chat validation](docs/validation-15.md) and [verified Customer validation](docs/validation-16.md) and [configuration validation](docs/validation-17.md) and [inbox validation](docs/validation-18.md) and [workflow execution validation](docs/validation-19.md) and [action validation](docs/validation-20.md) and [knowledge validation](docs/validation-21.md) and [provider validation](docs/validation-28.md) and [website knowledge validation](docs/validation-22.md) and [decision validation](docs/validation-29.md) and [preview and trace validation](docs/validation-27.md) and [portfolio demo validation](docs/validation-35.md).

Hosted deployment is outside this ticket. Before hosting, require HTTPS ingress, real SMTP, secret management, backups/recovery, monitoring and remaining specification gates. `APP_MODE=hosted` rejects HTTP, mail-capture transport, test TTL controls and seeding. This local Compose path is not an approved production deployment.
