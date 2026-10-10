# Issue #19: Bounded configurable workflow execution

Environment (2026-10-03):
- macOS 27.0.1 arm64 with OrbStack.
- Node 22.22.3 and Docker Compose v5.1.2.
- PostgreSQL 17 (repository-pinned pgvector image).
- Python 3.14.6 with psycopg 3.3.3, for both the worker and the fixture.
- TypeScript 7.0.2.

No new dependencies. The fixture uses only the Python standard library, and the worker uses `http.client`/`ssl` from the standard library.

## Reproduce

Requires this project's `.env`, free loopback ports 3100/8025/3199, and locked npm dependencies. No cloud credentials or external network are used.

```sh
npm ci --ignore-scripts
npm run typecheck
docker compose -f compose.yaml -f compose.test.yaml up --build -d --wait
node --test tests/workflow.test.mjs        # 9 tests, about 3 minutes (one runs a full 60 s deadline)
sleep 61                                     # let Better Auth's per-IP limits reset
npm test
```

## Controlled external fixture

`compose.test.yaml` adds the `fixture` service (`tests/fixture/server.py`).
- It is reachable on the internal Docker network as `provider.fixture.test` and `orders.fixture.test`, over HTTPS with a committed test-only self-signed CA. The worker trusts that CA only through the test overlay's `TEST_CA_FILE`.
- Tests script responses per key on the loopback control port: status, JSON or raw body, delay, a byte-per-second trickle, and headers. Tests then read back every request the worker sent, including when the worker hung up.
- Agent keys travel in the agent instructions, and HTTP keys in the action URL path.
- The worker refuses every `TEST_*` variable outside `APP_MODE=test` (existing `z-runtime` check).
- Connected agents reach the fixture provider only when their model name is `fixture`, so the existing proof that connected generation is unavailable is unchanged.

## Acceptance evidence (`tests/workflow.test.mjs`)

| Criterion | Runnable evidence |
| --- | --- |
| Fixtures match branches, structured context, final-only replies, multi-agent transitions | **Flow** test. Retrieval → intermediate agent → condition → HTTP → final agent.<br>• The intermediate context `{intent, order_id}` becomes the HTTP query `order_id=A-100`.<br>• The final agent receives `{intent, order_id, status}`; the undeclared result field is dropped.<br>• Exactly one assistant reply arrives, `simulated: false`.<br>• A second message takes the condition `fallback` branch to another final agent with no HTTP call.<br>• Attempt rows list exactly the provider/HTTP attempts made, in order. |
| Missing required input: one clarification and end of turn; unsupported/failure paths hand off | **Clarify** test. One reply ("To continue, please tell me your order number."), turn `completed`, conversation still `automated`, no HTTP or final-agent call. The next message runs a new turn whose agent sees the clarification in history.<br>**Paths** test (16 cases):<br>• An unsupported agent, HTTP 404, 401 and 302 (not followed), a malformed, nested-mistyped or non-JSON result, a 100,000-deep nested JSON result (the worker survives), a wrongly typed input, and transient-twice all go to the workflow handoff (`workflow-handoff`).<br>• Contract-violating agent output, non-JSON or `NaN`-bearing provider output and provider 401 go to the visible automation-failure handoff (`automation-failure`).<br>• No failure path delivers assistant text.<br>• Exact fixture call counts per case show no retry except for transient failures. |
| Existing conversations keep their starting configuration; new ones use the latest; current controls override snapshots | **Versions** test. A conversation started on v1 still answers from v1's agent after v2 is published, and a new conversation uses v2. Current control (takeover) and session (sign-out) overriding the pinned version: **Races** test. |
| 20 steps, 3 agent calls (fallback included), 5 HTTP calls (retries included), 15 s HTTP timeouts, 60 s deadline | **Budgets** test.<br>• Steps: 19 conditions + final agent replies; 20 + final fails with no provider call.<br>• Agent calls: 3 agents reply; 4 → exactly 3 calls then fail; 503-then-retry on the first agent → `[2,1,0]` calls then fail.<br>• HTTP calls: 5 calls reply; 6 → exactly 5 calls; 503/ok/ok/503/ok → exactly 5 calls then fail.<br>**Time limits** test:<br>• A 2 s action against a trickled body: two attempts of 1.9–2.6 s each (wall clock).<br>• Hanging 15 s actions chained on failure: the turn ends 58–63 s after sending with the limits notice. The fixture sees 4 attempts; the first three are closed at 14.5–16.5 s (worker-measured 14.9–15.6 s) and the fourth is cut short by the deadline.<br>• No session is `idle in transaction` during the held call. |
| Provider/HTTP attempts observable and bounded without hidden adapter retries; no transaction spans external calls | Every attempt is an `execution_attempts` row written before the call. The tests compare those rows and the fixture's own request log with the expected counts, so an adapter retry would add a fixture request. `pg_stat_activity` shows zero idle-in-transaction sessions during held provider (Races) and HTTP (Time limits) calls. |
| Permission/identity/…/generation changes reject new work and delayed results; visible crash failure; no blind replay | **Races** test.<br>• Takeover during an in-flight provider call: the conversation becomes `human-controlled`, the message is `human`, and no later HTTP or final-agent call happens (`[1,0,0]`).<br>• Sign-out during an in-flight HTTP call: the turn is `failed` with the session-ended notice, and the final agent is never called.<br>• Worker killed mid-call: the turn is `failed` ("interrupted … not retried automatically"), with `[1,1,0]` calls after restart. The next message answers normally. |

Scenario counts: 9 workflow tests, with 16 path cases and 8 budget runs. Run results are below.

**Observed** test: an intermediate agent that tries to overwrite a field set by a verified HTTP result (`status: pending` → `shipped`) fails the turn as `automation-failure`, and the final agent is never called. Invented order facts cannot replace verified ones.

## Code review fixes

`/code-review` found 10 issues, all fixed and retested:
- A deeply nested JSON body crashed the worker. It now becomes a failure.
- NaN/Infinity rejection now covers the provider's message content.
- Agents cannot overwrite verified HTTP fields.
- The deadline is anchored at claim time.
- Lock waits come out of the call's time bound.
- An aborted attempt is recorded as `failed`.
- A lease extension never shortens the lease.
- Workflow context goes to the provider as a user-role data message, not a system message.
- `execution_attempts` has composite Business/job foreign keys.
- The test-only guard checks the explicit variable names.

## Mutation checks

Each mutation was built into the worker image (the test confirmed the mutant text was inside the running container), run against its test, then restored.

| Mutation | Result |
| --- | --- |
| Transient failures not retried | Paths test failed |
| HTTP budget 6 instead of 5 | Budgets test failed |
| No revalidation gate before external calls | Races test failed |
| An intermediate agent's turn delivers assistant text | Flow test failed |

The races test also caught a real defect during development. The worker recorded the visible session-ended failure and then rolled it back by raising inside the same transaction. It now raises after commit.

## Not established by this slice (deferred; not claimed)

- **Real outbound business HTTP.** Outside test mode an `http` step records a refused attempt and follows `failure`. No request leaves the platform until #20 adds encrypted credentials, deterministic Customer authorization, and DNS/redirect/private-network destination checks. The fixture results are synthetic, not order facts.
- **Real providers, provider fallback to Qwen, and permission checks before transfer:** #28. The retry-once rule and agent budget accounting here are where #28's single fallback attempt fits.
- **Extraction and decision attempts:** these do not exist yet (#23, #29). They must use the same `current()` gate and attempt records.
- **Revalidation of source, consent and deletion:** #21–#24 add these to the same `current()` gate. **Action/credential revocation** is #20. None of these is tested here.
- **Retrieval:** finds no evidence until ingestion exists (#21).
- **Owner trace presentation of attempt rows:** #27.

## Results

| Run | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `node --test tests/workflow.test.mjs tests/chat.test.mjs tests/identity.test.mjs tests/inbox.test.mjs` | 18/18 pass, 0 failed assertions (390 s) |
| After the review fixes: `node --test tests/workflow.test.mjs`, then `chat`/`identity`/`inbox` | 9/9 and 10/10 pass; worker restart count 0 and no tracebacks |
| `npm test` (full suite, 37 tests, 41 min) | 31 pass, 6 fail. The 6 failures (`api.test.mjs`, then five `browser.test.mjs` journeys) were not assertion errors. During the first ~8 minutes the app stopped responding (first sign-up request hung 300 s with `fetch failed`, page loads timed out at 30 s). The container did not restart, and its logs show only client-aborted requests. This slice changes no app code. All later tests passed. |
| Rerun of the stalled files: `node --test --test-concurrency=1 tests/api.test.mjs tests/browser.test.mjs` | 7/7 pass, 0 failed assertions (245 s) |

The cause of the stall was not identified; it did not recur. Together the two runs pass every test at least once, but the full suite has not yet completed one run with zero failures.
