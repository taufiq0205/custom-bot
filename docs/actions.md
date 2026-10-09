# Actions and order lookup

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
