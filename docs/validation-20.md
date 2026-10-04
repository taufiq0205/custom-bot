# Issue #20: Authorized live order lookup

Environment (2026-10-04):
- macOS 27.0.1 arm64 with OrbStack.
- Node 22.22.3 and Docker Compose v5.1.2.
- PostgreSQL 17 (repository-pinned pgvector image).
- Python 3.14.6 with psycopg 3.3.3 and, new in this slice, `cryptography` 50.0.2 (plus `cffi` 2.1.1 and `pycparser` 3.0), all hash-locked in `worker/requirements.lock`.
- TypeScript 7.0.2. Playwright 1.63.0 Chromium.

The hash-locked worker image also builds and runs AES-GCM on `linux/amd64` (`docker build --platform linux/amd64 worker`, which printed `x86_64 50.0.2`).

`cryptography` was added because Python's standard library has no AES. The app encrypts with Node's built-in `crypto`.

## Reproduce

Requires this project's `.env`, free loopback ports 3100/8025/3199, and locked npm dependencies. No cloud credentials or external network are used. The test overlay supplies a fixed, test-only `ACTION_CREDENTIAL_KEY`.

```sh
npm ci --ignore-scripts
npm run typecheck
docker compose -f compose.yaml -f compose.test.yaml up --build -d --wait
node --test tests/actions.test.mjs          # 7 tests
node --test tests/workflow.test.mjs         # 9 tests, about 2.5 minutes
sleep 61                                    # let Better Auth's per-IP limits reset
npm test
```

## Controlled fixtures

The #19 HTTPS fixture serves these new test-only names. All of them pass the production destination checks except where noted:
- `orders.fixture.test` and `other.fixture.test`. `TEST_PUBLIC_HOSTS` lets these two exact names resolve to the private Docker network. The worker refuses this variable outside test mode, like the other `TEST_*` variables.
- `internal.fixture.test` resolves to the same live fixture server but is not exempt. If the private-address check were missing, its requests would reach the fixture and show up in its log.
- Worker `extra_hosts` point `loopback.fixture.test` at 127.0.0.1, `metadata.fixture.test` at 169.254.169.254 and `private.fixture.test` at 10.255.255.1.
- The test-only CA certificate was reissued with the same test key to cover these names.

A script entry `owned(json)` returns the record as belonging to whichever Customer the request names: the fixture copies the request's `customer` parameter into `customer_id`. Denial cases use explicit foreign or unowned records instead.

The workflow tests from #19 now run as verified Customers against registered controls, so they exercise the real checks. The old `*.fixture.test` bypass is removed.

## Acceptance evidence (`tests/actions.test.mjs`)

| Criterion | Runnable evidence |
| --- | --- |
| Owned orders succeed; an order ID alone, another Customer's order, missing authority or cross-business credentials never disclose order facts | **Owned** test, both paths: the reply is delivered. The fixture saw `customer=<verified subject>` and the Business's own `x-api-key`. The final agent saw only declared fields.<br>**Denials** test (22 cases × 2 paths), each with a unique `FOREIGN-FACT` sentinel in the fixture response:<br>• another Customer's order (order ID alone); a result with no owner field; an owner field of the wrong type → `result not authorized for this Customer`.<br>• an anonymous Customer → a sign-in clarification and zero requests.<br>• another Business's credential reference → zero requests.<br>In every case the sentinel is absent from the Customer conversation, no lookup is stored, and no final reply is generated.<br>**Isolation** test: two Businesses with the same Customer and order IDs and the same credential ref. The fixture header log shows each Business sending only its own secret. A non-member gets `404` from the controls API. |
| Explicit HTTP nodes and agent-requested actions share destination, schema, read-only method, credential and authorization validation | The **Denials** table runs every case through an explicit `http` step and through an agent `{"outcome":"action"}` request. Both paths must give the same fixture request count and the same recorded attempt error. **Inputs** test: a missing input gives the same clarification on both paths. An action outside the agent's permitted list fails the turn with no request. The method is GET in both paths, and publication rejects anything else (`configuration.test.mjs`). |
| Unapproved/private/loopback/link-local destinations denied with DNS and redirect revalidation, even for approved hostnames | **Denials**:<br>• the credential's origin approves another host → `destination not approved`.<br>• approved hostnames resolving to a live private server, 127.0.0.1, 169.254.169.254 or 10.255.255.1 → `destination address not permitted`, with zero fixture requests.<br>• a 302 to the private host is not followed, and the target received nothing.<br>Resolution happens on every attempt, retries included, and the connection uses the vetted address. Publication already rejects IP-literal and localhost URLs. |
| Missing inputs clarify; malformed/authentication/authorization failures do not retry; transient reads retry at most once within budgets | **Inputs** test (clarification, no request). **Denials**: schema-mismatched and non-JSON results, 401 and 403 → exactly 1 request. 503 then 502 → exactly 2 requests, then failure. Budget accounting is unchanged from #19 and re-proven by `workflow.test.mjs` running through the new path. |
| Encrypted server-side credentials with keys outside the database; no secrets in browser/configuration/prompt/trace/log payloads | **Secrets** test, with a `SENTINEL-SECRET` credential used on a successful and a 401 lookup:<br>• the fixture received the secret, so the credential is real;<br>• the sentinel is absent from the controls list, the store response, the configuration draft and version, the inbox list and detail, the Customer conversation, and the provider request bodies (prompts);<br>• a `pg_dump --data-only` contains neither the secret nor the key, and the stored ciphertext does not contain the plaintext;<br>• `docker compose logs app worker` contain neither;<br>• a malformed key stops the worker at startup.<br>• `TEST_PUBLIC_HOSTS`, the only private-network exemption, stops a `local`-mode worker at startup.<br>The controls list exposes only `ref, origin, header, active, revision, updated_at`. |
| Revoked actions/credentials defeat pinned versions and delayed results; the inbox presents completed authorized results as timestamped historical observations | **Revocation** test:<br>• a conversation pinned to v2, with the action revoked after v3 is published → zero requests (`action revoked`). Restoring it works again.<br>• while a lookup is in flight (4 s delay): revoking the credential, rotating it, revoking the policy or revoking the action each discards the late result (`action controls changed`) → no lookup stored, no final agent call, handoff.<br>• revoking the credential after the lookup but while the final agent is replying → the reply is not delivered (`automation-failure`), and the completed lookup remains for support.<br>• revoking the action while a later intermediate agent runs → the final agent is never called, so no further provider call receives the looked-up facts.<br>**Owned** test: `lookups` holds only declared fields plus `observed_at`.<br>**Browser** journey (390 px wide): Support opens the conversation and sees "Historical observations: …" and `lookup, observed <time>: status: <b>shipped</b>` rendered as text, with undeclared fields hidden, no horizontal scroll and no page errors. Support gets `404` from the controls API. |

## Code review fixes

`/code-review` found 8 issues, all fixed and retested:
- **Facts reaching a provider after revocation.** After an action, credential or policy was revoked, later provider calls in the same turn could still send the looked-up facts in the context. Every attempt now rechecks the controls of earlier accepted results and fails the turn if they changed. A new regression case covers this: revoke while an intermediate agent runs, and the final agent is never called.
- **Plaintext secrets held for the turn.** Rechecks now compare control revisions, and only the attempt itself decrypts the credential, so the turn no longer keeps plaintext secrets.
- **Business lock on every revalidation.** The share lock is now taken only when action controls are checked.
- **Wasted round trip for anonymous Customers.** They are asked to sign in before being asked for an order number.
- **Only the first resolved address was tried.** The connection now tries every vetted address in resolver order.
- **Unfinished attempt rows.** An attempt is now recorded as finished even if building its request fails.
- **Duplicated grammar.** The REF/FIELD grammar is shared with the configuration validator.
- **Concurrent queries on one client.** The controls are now listed with sequential queries.

## Mutation checks

Each mutant was built into the worker image (the script confirmed the mutant text inside the running container), run against its test, then restored.

| Mutation | Result |
| --- | --- |
| Owner-field check removed | Denials test failed |
| Non-public addresses allowed | Denials test failed |
| No control recheck before accepting a result | Revocation test failed |
| No control recheck before delivering a reply | Revocation test failed |
| Provider attempts skip the recheck of accepted results' controls (after review) | Revocation test failed |
| `TEST_PUBLIC_HOSTS` dropped from the worker's test-only guard | Secrets test failed. The worker started in `local` mode instead of refusing. |

## Not established by this slice (deferred; not claimed)

- **A real business order API over the public internet.** The fixture is synthetic, and production DNS answers are not exercised. This needs an integration run against an approved HTTPS endpoint before the pilot.
- **DNS rebinding between check and connect.** This is prevented by construction (connecting to the vetted address), not by a rebinding DNS server in the tests.
- **Credential and policy management UI.** It is API-only, like Customer signing keys.
- **Real providers (#28) and Owner traces (#27).** Attempt rows are recorded value-free for those slices.

## Results

| Run | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `node --test tests/workflow.test.mjs` (the #19 suite, now on verified Customers and live controls) | 9/9 pass |
| `node --test tests/actions.test.mjs`, after the review fixes | 7/7 pass, 0 failed assertions. The Denials test ran 22 cases on 2 paths (44 turns). |
| Mutation checks (6 mutants) | 6/6 caught |
| `npm test`, first full run (2026-10-03 16:57Z) | 44/45. The browser registration journey got `429` from sign-up. |
| `npm test`, full run after the fix (2026-10-03 17:28–17:48Z, 19.6 min) | **45/45 pass, 0 failed assertions**, and no worker tracebacks |

**Cause of the first-run failure, reproduced and confirmed:** Better Auth's default sign-up limit is 3 per 10 s, and only sign-in has a custom rule. The actions browser test signed up a Support operator as the file's last step, and `api.test.mjs` then signed up two more. The browser registration journey that follows was therefore the 4th sign-up within 10 s, and a browser cannot wait out the `429` the way the API helper `limited()` does. A probe captured `429` and "Too many requests". The fix runs that journey first in `actions.test.mjs`. `actions → api → browser` then passed 14/14, and the full suite passed. The unexplained #19 stall had a different symptom (a request that hung for 300 s) and was not investigated here.
