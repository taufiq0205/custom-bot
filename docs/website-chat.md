# Website chat (simulated)

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

## Verified Customers

A Business website that signs in its own customers can verify them in chat. Its server signs a short-lived ES256 JWT with a key whose public half an Owner registered (`/api/businesses/:id/customer-keys`; API only). The widget tag carries it as `data-assertion`. `POST /api/chat/:businessId/identity` `{ "assertion": "…" }` links only the current anonymous conversation; `POST /api/chat/:businessId/logout` `{}` ends the session. Both rotate the session token. Logout, account switching and assertion expiry end access to earlier history at once, and replies that arrive afterwards are not delivered. Email and phone never identify or merge Customers. The full integration contract (claims, algorithm, keys, lifetimes) is in [docs/customer-identity.md](customer-identity.md).

Deferred to later slices: 90-day retention (#24). Anonymous session creation is not yet rate limited; put hosted deployments behind ingress rate limiting.
