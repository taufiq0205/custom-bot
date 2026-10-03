# Issue #16 — Verified Customer website integration

Environment: 2026-10-03, macOS 27.0.1 arm64 / OrbStack, Node 22.22.3, npm 10.9.8, Docker Compose v5.1.2, PostgreSQL 17 (repository-pinned pgvector image), Python 3.14.6 with psycopg 3.3.3, Better Auth 1.7.7, jose 6.2.12 (now a direct, exact-pinned dependency; it was already locked as a Better Auth dependency), TypeScript 7.0.2, Playwright 1.63.0 / Chromium.

## Reproduce

Requires this project's `.env`, free loopback ports 3116/8036, locked npm dependencies and Chromium. Tests restart db/app/worker and kill the worker in the isolated Compose project, so use disposable fixture data. No cloud credentials, providers or external identity services are used. The fixture Business websites are local Node servers (browser) or in-test signers (API). They generate their own ES256 key pairs, keep the private keys in the test process, and register only the public JWK through the Owner API.

```sh
npm ci --ignore-scripts
npx playwright install chromium
npm run typecheck
export COMPOSE_PROJECT_NAME=custom-bot-identity-validation APP_URL=http://localhost:3116 MAIL_URL=http://localhost:8036
COMPOSE_FILE=compose.yaml:compose.test.yaml:ports-16.yaml docker compose up --build -d --wait
node --test tests/identity.test.mjs
node --test tests/browser.test.mjs
sleep 61   # let Better Auth's per-IP auth limits reset; test helpers retry a 429 only once
npm test
```

`ports-16.yaml` (Compose `!override` support required):

```yaml
services:
  app:
    ports: !override [127.0.0.1:3116:3000]
  mail:
    ports: !override [127.0.0.1:8036:8025]
```

Run test files serially, as `npm test` does (`--test-concurrency=1`). The chat runtime group restarts db/app/worker, which breaks any file running at the same time. Time-dependent cases need no clock hook: the fixture issuer mints assertions with chosen `iat`/`exp`, for example a 2–3 s lifetime. Delayed-result cases use the existing test-only `[hold Ns]` message prefix with a 3 s hold, shorter than the 5 s test lease. A discarded result can therefore only come from the identity check, not the lease. A positive control with the same hold and no identity change must deliver its reply.

## Acceptance evidence

| Criterion | Runnable evidence |
| --- | --- |
| Signing format, library, explicit algorithm, issuer, audience/Business, subject, issued-at/expiry and signing-key reference are documented | [docs/customer-identity.md](customer-identity.md): JWT/JWS compact, `ES256` only via jose `jwtVerify` with `algorithms:['ES256']`. Requirements: `kid` header resolved per path Business; `iss` equal to the issuer registered with that key; `aud` equal to the platform origin; `business_id` equal to the path Business; `sub` as the only Customer key; required `iat`/`exp` (lifetime ≤ 1 h, 5 s tolerance); single-use `jti`. Private keys stay on the website; registration accepts only a P-256 public JWK. |
| Valid assertions succeed; forged, expired, wrong-audience, wrong-Business and disallowed-algorithm assertions fail | `identity.test.mjs` verification group. A valid assertion returns 200 with a rotated token and links the conversation. 19 rejected variants each return the identical `401 {"error":"Identity assertion rejected"}` and leave the anonymous session unchanged: forged (another key, same kid), expired, `nbf` in future, `iat` in future, lifetime > 1 h, wrong `aud`, wrong `business_id` (same key registered in both Businesses), wrong `iss`, unknown kid, missing kid, missing `exp`/`jti`/`sub`, empty and numeric `sub`, `alg: none`, HS256 signed with the public key as secret, ES384, garbage. A replayed assertion is rejected (401) and opens no history. Key registration rejects private, P-384, RSA, off-curve, `alg`-bearing and extra-field JWKs and bad kids (400) and duplicate kids (409). Support and other roles get 404 for list, add and remove. Removing a key ends sessions it verified (401) and refuses new assertions. Twelve concurrent identify requests all succeed. |
| Only the current anonymous conversation links, never one already linked to another Customer; email/phone never authenticate or merge | Linking group: an anonymous session with two conversations signs in, and only the latest links; the older one is 404 for the verified session. A second device signing in as the same Customer sees both devices' linked conversations. Switching to another Customer starts an empty conversation and never moves the first Customer's conversations; the previous token is 401. A SQL `UPDATE` of a linked conversation's Customer fails (trigger). Two independent-client barrier races on one anonymous session (two identities; identity vs logout) each yield exactly one 200 and one 401, with exactly one Customer owning the conversation, or none after logout. Two subjects with identical `email`/`phone_number` claims, and a subject equal to that email, are separate Customers. The same subject in another Business is a separate Customer, and its token is 401 on the first Business. |
| Logout, expiry and account switching invalidate previous history access and start fresh anonymous context | Shared-browser group: logout returns a new anonymous token and an empty conversation. The old token is 401 for list, read, send and logout, and the new session gets 404 for the previous conversation. An assertion with a 3 s lifetime gives 200 then 401 after expiry, server-side. Browser journey (one shared Chromium context, fixture site signing per page): an anonymous message is linked after website sign-in as A. Website sign-out empties the chat, also after reload. B sees none of A's messages. Switching back to A hides B's chat and offers only A's earlier conversation, which reopens A's history. A second tab signing in as A rotates the shared session; the first tab adopts it and keeps its open conversation, and its next send succeeds. Signing out in the second tab clears the idle first tab with no interaction; signing in as B there shows none of A's text in the first tab. Expiry: a page with a 5 s assertion signs in. After expiry, the next send reports that the session changed, does not send the text, and shows an empty anonymous chat with no signed-in notice and no earlier conversations. |
| Independent-client and delayed-result tests expose no previous Customer or other Business data; acceptance revalidates current identity | Delayed-result group: the positive control (`[hold 3s]`, no change) delivers a simulated reply. Logout and account switch each happen during a running 3 s turn. Assertion expiry (2 s session) happens during the turn or, on a slow claim, before it, which the claim-time check covers. The browser's new context shows nothing of it, and when the original Customer signs in again the turn is `failed` with only a system "chat session ended" notice and no assistant reply. The worker rechecks the submitting session (not ended, not expired, same Customer as the conversation) at claim and inside the result transaction. It takes the session share lock before the conversation lock, in the same order as the API. Cross-Business tokens are 401 (above). Logs from app and worker contain no assertion, subject, message text or token. |

## Mutation checks

Each mutation was built into the running images, run against its group, then restored. Rows marked *final code* ran on the committed code; the others ran before the review fixes, against the same checks:

| Mutation | Result |
| --- | --- |
| Worker accepts results without the identity check (*final code*) | Delayed-result group failed (`failed` expected, `completed` actual) |
| Business claim check removed | Verification group failed (`wrongBusiness` → 200) |
| Single-use `jti` check removed | Verification group failed (replay → 200) |
| Sign-in links every anonymous conversation of the session | Linking group failed |
| Widget no longer signs out when the page carries no assertion (*final code*) | Browser journey failed (previous Customer's text still shown) |
| Widget ignores other tabs' session changes, no `storage` listener (*final code*) | Browser journey failed |
| Pooled client taken before assertion verification | **Not detected**: the twelve-request burst passed. Starvation is timing-dependent, and the fix rests on review rather than a reliable test. |

## Recorded result

Focused, serial, on rebuilt images of the committed code: identity **3 passed, 0 failed**; browser **4 passed, 0 failed** (including the shared-browser journey with tabs and expiry).

Final isolated full suite on rebuilt images of the committed code: **18 groups passed, 0 failed/cancelled/skipped; 648.529 seconds** (it includes rate-limit waits). Typecheck passed.

```text
# tests 18
# pass 18
# fail 0
# cancelled 0
# skipped 0
# duration_ms 648529.416958
```

Earlier full runs failed only on Better Auth's per-IP auth rate limits (429), which the new fixtures pushed over. Better Auth sends `X-Retry-After`, not `Retry-After`. With database storage, 1.7.7 can also send a nonsensical value: Node reported a `TimeoutOverflowWarning` for 179099522956370080 ms. The shared `limited()` test helper now reads `X-Retry-After`, clamps the wait to 1–60 s (the longest configured window), and also wraps operator email verification and the runtime group's auth assertions. The identity groups share one Owner to make fewer auth calls. No application rate limit was changed.

## Review

`/code-review high` returned 10 findings. Fixed:
- Assertion verification queried the pool while the request held a pooled client, so a burst could starve the pool. Verification now runs before the client is taken.
- Key removal locked the Business `FOR UPDATE` while chat transactions take `FOR KEY SHARE` on it through foreign keys, which could deadlock. Business administration now uses `FOR NO KEY UPDATE`, which still serializes administration with itself.
- The identity transaction rechecked only the `kid`. It now rechecks the exact public key, so a removed key re-registered under the same kid cannot be used.
- Tabs: a stale tab's draft save overwrote the session another tab had rotated, so the stale tab fell back to anonymous. Only identity changes may now replace a newer stored session. Tabs also follow each other's session through `storage` events, which closes the advisor-found gap of an idle tab showing a previous Customer after sign-out or switching in another tab (browser-tested).
- A same-Customer refresh jumped back to the latest conversation. The widget now keeps the conversation that was open.
- Polling fetched the conversation list every second; it now fetches only the open conversation.
- The hand-written `iat` future check duplicated jose's `maxTokenAge` enforcement (confirmed in jose source) and was removed.
- A turn failed at claim because its session ended no longer causes a 250 ms idle sleep.

Kept by design and documented in the contract:
- A rejected assertion (including a reused one from a cached page) signs out a verified widget session: identity that cannot be confirmed must not keep showing the previous Customer. Websites must serve assertion-bearing pages `no-store`.
- Expiry mid-page continues anonymously until a page brings a fresh assertion.

Not in this slice: an Operator UI for key registration (API only), an in-page JavaScript identity API for single-page sites, pruning expired `jti` rows (#24), Customer memory and consent.
