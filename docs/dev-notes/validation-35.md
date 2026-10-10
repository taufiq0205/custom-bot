# Issue #35: Portfolio demo seed (Northwind Kettles)

Environment (2026-10-06): macOS 27.0.1 arm64, Docker Engine 29.4.0, Docker Compose 5.1.2, Node 22.22.3, PostgreSQL 17 with pgvector 0.8.2, Python 3.14.6 worker, TypeScript 7.0.2, Playwright 1.63.0 Chromium. No new dependencies: the demo service uses Node's standard library (`node:https`, `node:crypto`).

## Decisions

- **The seed is an API client.** `app/seed.ts` signs in as `SEED_OWNER_EMAIL`/`SEED_OWNER_PASSWORD` and creates everything through the app's public APIs. The Support Operator is signed up, verified through Mailpit, invited and accepted. The only direct database writes are the seed's own `demo_seeds` marker and a session advisory lock that serializes concurrent seeds. An unmarked Business of the Owner named "Northwind Kettles", left by a seed stopped between the two writes, is adopted instead of duplicated. The old two empty Businesses (Northstar, Harbor) are no longer seeded; rows already in a database stay.
- **Simulation routes decisions by keyword (user decision).** In `generation.mode: "simulation"` a decision step calls no engine. It picks the choice whose description shares the most words with the message (`uncertain` when none do, or on a tie) and records `{simulated: true, choice}` with no attempt. Before this, simulation called Jev for real, and without a key every message took the failure route to handoff, so a keyless walkthrough could not reach retrieval or lookups. Connected mode always uses the selected engine.
- **The demo settings are allowed in `local` and `test` (user decision).** The whole suite runs in `APP_MODE=test`, so tests drive the real demo service the same way a local demo does. Hosted mode refuses `DEMO_PUBLIC_HOSTS` and `DEMO_CA_FILE` at startup. `DEMO_PUBLIC_HOSTS` must be exactly `northwind.demo.test`, with the CA file. The demo CA has its own TLS context, used only for that host, so it verifies nothing else, and the demo host is verified by nothing else.
- **The lookup is an explicit `http` step with no required input.** That way it also runs in simulation. The `orders` agent may additionally request one order by number.
- **Synthetic secrets are committed in `demo/`:** the CA certificate and key, the Customer signing key and the order API key. They are documented in the README as protecting nothing real.

## Reproduce

```sh
npm ci --ignore-scripts
npm run typecheck
docker compose -f compose.yaml -f compose.test.yaml up --build -d --wait
docker compose -f compose.yaml -f compose.test.yaml build seed     # compose run does not rebuild the seed image
node --test --test-concurrency=1 tests/demo.test.mjs               # 5 tests, about 2 minutes (incl. a 61 s cool-down)
caffeinate -i npm test
docker compose up -d --wait --remove-orphans                       # leave test mode
```

## Acceptance evidence (`tests/demo.test.mjs`)

| Criterion | Runnable evidence |
| --- | --- |
| One documented command seeds idempotently; a rerun changes nothing and reports what exists; hosted refuses; extends `app/seed.ts` and `demo_seeds` | **Seed** test. A snapshot of the business list, memberships, origins, keys, action controls, permissions, configuration revision/version and source versions is identical after:<br>• two concurrent runs started with the marker deleted (a seed stopped after creating the Business): both succeed with no `Created` line, and exactly one marker points at the same Business. Mutation check: without the seed's advisory lock, one run failed on `demo_seeds_pkey`;<br>• a sequential rerun with 11 `Already exists` lines and no `Created` line;<br>• three refused runs: hosted mode ("Demo seeding is disabled in hosted mode"), a wrong Owner password, and another Operator naming themselves Owner ("not its Owner");<br>• a run with the demo service stopped ("Enable the demo service first").<br>Exactly one `demo_seeds` row. |
| Created through the app's own authorization and persistence paths | Credential rows have `updated_by` = the Owner, and published versions have `published_by` = the Owner (version 1 is the system starting configuration). Policies, sources and memberships are listed through the Owner's APIs. |
| PDF and Markdown policies with page facts, website source, approved origin, signing key, orders credential and ownership policy, Owner and Support | **Seed** test, exact values: sources `care-guide` (kettle-care.md), `help-centre` (https://northwind.demo.test/help/), `policies` (northwind-policies.pdf), all `active`; origin `http://localhost:3300`; key `northwind-demo-1`; credential `northwind-orders` → `https://northwind.demo.test` (`x-demo-key`); policy `own-orders` (`customer` → `customer_id`); Owner and Support active. |
| Jev decision workflow: policy → retrieval and cited answer, order → authorized lookup and answer, else/unsupported → handoff; sources, priorities, actions, DeepSeek with Qwen fallback | **Connected** test with fixture providers:<br>• `policy` (0.9) → a cited reply whose citation is the cited passage, with the returns page (PDF page 1) among the evidence;<br>• `order` (0.9) → the agent received the context orders NK-1001 and NK-1002, and the trace shows `{choice:'order', probability:0.9}`;<br>• below the threshold (0.4) → waiting for support;<br>• `other` → waiting for support. |
| Demo shop on loopback, backend-signed assertion, anonymous and signed-in chat, logout | **Simulation** test: the shop backend's own assertion signs in `demo-customer-ada`; after logout the old token gets `401` and the new session is unverified. **Browser**: sign in and sign out on the shop page. |
| Simulation completes the walkthrough, every reply labelled, no inference claimed; connected opt-in grants permissions; readiness shows keys | **Simulation** test:<br>• the policy reply is `simulated` ("Simulated reply: no AI model…"); the trace shows triage `{simulated:true, choice:'policy'}`, retrieval evidence including the PDF, the agent `{simulated:true}`, and no attempts;<br>• an anonymous order question asks the Customer to sign in, with no lookup;<br>• Ada's order lookup is recorded;<br>• memory opt-in and a `preferred_name` correction;<br>• "hello" goes to the inbox (`workflow-handoff`, verified), seen by Support;<br>• zero provider attempts in all three conversations.<br>**Connected** test: `--connected` grants all five pairs, publishes `connected`, and readiness reports the keys `configured`. |
| `demo` profile, one fixed hostname, `DEMO_PUBLIC_HOSTS` only in local/test, demo CA only, hosted refuses, readiness label | **Demo service** test:<br>• readiness `demo` label;<br>• the hosted worker exits "local-only" for either setting;<br>• another host, or a list with an extra host, exits "must be exactly";<br>• a worker without the setting refuses to crawl the demo host ("not permitted"), and readiness drops the label;<br>• a worker trusting the fixture CA instead of the demo CA rejects the demo certificate;<br>• the normal worker crawls the same scope. |
| The website source crawls the bundled site; lookups return only the requesting Customer's orders | The `help-centre` crawl is active (3 pages). Ada's lookup returns NK-1001 and NK-1002; a second demo Customer (`demo-customer-ben`) gets only NK-2001. Mutation check: removing the order API's customer filter made the simulation test fail. |
| README "Portfolio demo" section | Covers prerequisites, the command, the walkthrough (cited answer, memory, order lookup, Jev route, handoff in the inbox, traces) and reset. |
| Browser journeys at 1280 and 390 px | **Browser** test, at each width:<br>• the shop page with its synthetic-business banner;<br>• sign-in, then a cited answer ("Sources: …");<br>• a handoff, then Support signs in to the Operator app and opens that conversation in the Northwind Kettles inbox ("Reason: workflow-handoff");<br>• sign-out.<br>Then a connected rerun prints no `Created` line, the Owner sees one Northwind Kettles Business at the same version, there is no horizontal scroll, and no page errors. |

## Real integration run (local mode, real DeepSeek and Jev)

`APP_MODE=local`, `COMPOSE_PROFILES=local,demo`, `DEMO_PUBLIC_HOSTS=northwind.demo.test`, `compose.connected.yaml`. `ACTION_CREDENTIAL_KEY` was the synthetic test key, because the credential was already stored under it in the shared database. `DASHSCOPE_API_KEY` was absent, so the Qwen fallback was not exercised, and readiness said `missing`. `PROVIDER_RATES` was unset, so no costs were estimated. The seed (`--connected`) reported every item `Already exists` and published version 19 (connected). Signed in as Ada through the shop backend:

| Message | Jev route | Result |
| --- | --- | --- |
| What is your returns policy? | `policy` (1.0) | "You can return an unused kettle within 30 days of delivery…", citing northwind-policies.pdf page 1. DeepSeek 1212/74 tokens. |
| How much does express delivery cost? | `policy` (1.0) | "Express delivery arrives the next business day and costs GBP 12.", citing page 3. DeepSeek 1264/49 tokens. |
| Where is my order? | `order` (1.0) | The lookup returned only Ada's NK-1001 and NK-1002, and the reply listed both correctly. DeepSeek 449/309 tokens. |
| hello | `other` (1.0) | Handoff; waiting for support. |

Jev (`jev-1.13.0`) used 386–392/55 tokens per decision. All seven provider attempts succeeded.

**Memory, found and fixed here.** The first real memory run failed: extraction got DeepSeek `status 400`. DeepSeek's JSON mode rejects a prompt that never contains the word "json". The extraction prompt never said it, and only worked in #23 because those agents' instructions did. `worker/memory.py` now asks for "one JSON object". Rerun result: extraction reached validation and refused the combined message "Please call me Ada and keep answers brief. What is your returns policy?" as `ungrounded preference`. That is correct: a preference must be the whole message, and Jev routes a message like "Please call me Ada." to support (also observed). The walkthrough therefore saves preferences in the memory panel.

Personalization was then verified with real DeepSeek. Ada opted in and saved `preferred_name` Ada and `communication_style` brief (Customer corrections). The demo agents now say to use given preferences (version 20). The next reply began "Ada, every Northwind kettle has a 2-year warranty…".

Not covered by a real run: the Qwen fallback (no key).

## Full suite

`npm run typecheck` is clean. On `a0e9adc`, after the code review fixes, `caffeinate -i npm test` ran 109 tests: 109 passed. **On the final commit `a40656f`** (the extraction prompt fix, the lock race test and the demo instructions): **109 tests, 109 passed, 0 failed** (29.5 minutes).

An earlier run had 1 failure: the duplicate-signup browser test, which runs next, got a sign-in `429`. Better Auth keys every client under one rate-limit key (`no-trusted-ip`), and each seed run signs in twice. The demo file now ends with a 61-second cool-down.

## Code review

`/code-review` (standards and spec). Fixed:

- An interrupted seed (Business created, marker not yet written) would duplicate the Business on rerun. It is now adopted.
- With `DEMO_PUBLIC_HOSTS` set but the demo container not running, the seed carried on with dead sources. It now probes the service over HTTPS with the demo CA and stops with a clear message.
- Memory was not exercised in the walkthrough test. A simulation leg now covers it.
- The README now says never to register the demo key for another Business.

Not changed (judgement calls):

- A shared "find or create" helper in the seed.
- A boolean instead of `DEMO_PUBLIC_HOSTS`: the issue asks for that exact setting.
- Printing the Operator emails in the local CLI output.
