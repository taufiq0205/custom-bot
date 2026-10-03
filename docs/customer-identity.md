# Verified Customer identity: website integration contract

A Business website that already signs in its own customers tells chat who is signed in by sending a signed identity assertion. The platform never sees the website's passwords or private key. It recognizes a Customer only inside that Business.

## Format and library

| Item | Contract |
| --- | --- |
| Format | JWT ([RFC 7519](https://www.rfc-editor.org/rfc/rfc7519)) in JWS compact serialization |
| Accepted algorithm | `ES256` only (ECDSA P-256 with SHA-256). The platform passes an explicit `algorithms: ['ES256']` allowlist. It rejects `none`, HMAC (`HS*`) including a public key reused as an HMAC secret, `RS*`, and `ES384`/`ES512`. |
| Verifying library | [`jose`](https://github.com/panva/jose) 6.2.12 (`jwtVerify`, `importJWK`), pinned in `package.json`/`package-lock.json` |
| Signing key | An EC P-256 key pair generated and kept on the website's **server**. Only the public JWK (`kty`, `crv`, `x`, `y`) is registered with the platform, under a key ID (`kid`). The registration API rejects JWKs that carry a private component (`d`) or any other field. |
| Signing-key reference | The JWS protected header must contain `"kid"`. The platform looks it up among the keys registered for **the Business in the request path** only. |

## Claims (all required)

| Claim | Requirement |
| --- | --- |
| `iss` | Exactly the issuer registered with that `kid` (for example the website origin `https://shop.example.com`) |
| `aud` | Exactly this platform's origin (`APP_URL` origin, e.g. `https://chat.example.com`) |
| `business_id` | The Business UUID in the request path. A token for another Business fails even if both Businesses registered the same key. |
| `sub` | The website's stable, never-reused customer ID: a string of 1–200 characters. It is the **only** thing that identifies a Customer. Email, phone or any other claim is ignored and never used to authenticate or merge Customers. The same `sub` in two Businesses is two unrelated Customers. |
| `iat` | Issue time. It must not be in the future, and the token must not be older than 1 hour. |
| `exp` | Expiry, at most 1 hour after `iat`. The verified chat session ends at `exp`, and it is checked server-side on every request and before any reply is accepted. |
| `jti` | A unique ID (1–200 characters). Each assertion is accepted once per Business, so a replayed or cached assertion cannot reopen the Customer's history. |

`nbf` is honoured if present. Clock tolerance is 5 seconds. Every verification failure returns the same `401 {"error":"Identity assertion rejected"}`. Assertions and subjects are never logged.

Signing example (Node, `jose`):

```js
const assertion = await new SignJWT({ business_id: BUSINESS_ID, jti: crypto.randomUUID() })
  .setProtectedHeader({ alg: 'ES256', kid: 'shop-2026-10' })
  .setIssuer('https://shop.example.com').setAudience('https://chat.example.com')
  .setSubject(customer.id).setIssuedAt().setExpirationTime('15m')
  .sign(privateKey);
```

## Registering keys (Owner only, API)

- `GET /api/businesses/:id/customer-keys` lists `kid`, `issuer`, `public_key` and `created_at`.
- `POST /api/businesses/:id/customer-keys` takes exactly `{ "kid": "A-Z a-z 0-9 . _ - (1–100)", "issuer": "…", "public_key": { "kty": "EC", "crv": "P-256", "x": "…", "y": "…" } }` and returns `201`. A duplicate `kid` returns `409`; keys are immutable, so rotate by registering a new `kid`.
- `POST /api/businesses/:id/customer-keys/:kid` with `{}` removes the key. It also ends every Customer session verified with it, on their next request.

Support Members and other Businesses get `404`. Key registration has no Operator UI in this slice.

## Propagating sign-in, sign-out and switching

Render a fresh assertion into the widget tag on every page for a signed-in Customer, and omit it when nobody is signed in:

```html
<script src="https://chat.example.com/widget.js" data-business="BUSINESS_ID" data-assertion="SIGNED_JWT" defer></script>
```

On each page load the widget does one of three things:
- With an assertion, it calls `POST /api/chat/:businessId/identity` with `{ "assertion": "…" }`.
- Without one, after a verified session, it calls `POST /api/chat/:businessId/logout` with `{}`.
- Otherwise it stays anonymous.

Serve pages that carry an assertion with `Cache-Control: no-store`. A cached page re-presents an already-used assertion. The widget then cannot confirm who is signed in, so it signs the chat out rather than keep showing the previous identity. Set `exp` no later than the website's own session. After it passes, the widget continues anonymously until the next page brings a fresh assertion. Tabs share one chat session. When another tab signs in, signs out, switches account or rotates the token, an idle tab follows at once, without any interaction, so it never keeps showing a previous Customer's history.

Both calls need an approved website `Origin`, like all Customer APIs. The responses return a new session `token` (the old token stops working immediately), `verified`, `expires_at` (identity only), and the `conversation` to show.

| Situation | Result |
| --- | --- |
| Anonymous session signs in | The session becomes verified, and **only its latest (current) conversation** links to the Customer. Its other anonymous conversations stay unlinked and become unreachable. Turns in flight continue. |
| Same Customer again (page load, refresh) | `exp` is renewed and the token rotates. Nothing else changes. |
| A different Customer (account switch) | The previous session ends. A new verified session starts with a fresh conversation. Nothing links, and a conversation already linked to a Customer never changes owner (a database trigger enforces this). |
| No token | A new verified session with a fresh conversation. |
| Logout | The session ends, and a fresh anonymous session and conversation start. |
| Expiry (`exp` passed) | Every request with that token returns `401`. The widget starts fresh anonymous context. |

A verified session can list and read all of its Customer's conversations in that Business, including those from other devices. An anonymous session can reach only its own anonymous conversations.

Each Customer message records the session that submitted it. The worker rechecks that session before starting the turn and again before accepting the result: it must not be ended or expired, and it must still match the conversation's Customer. A reply that becomes ready after logout, switching or expiry is not delivered. The turn fails with a visible notice that the chat session ended, and the Customer sees that notice after signing in again.

Not in this slice: an in-page JavaScript API for single-page sites (they can reload or re-render the widget tag), pruning of expired `jti` records (retention, #24), and Customer memory (later slice).
