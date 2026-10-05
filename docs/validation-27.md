# Issue #27: Owner preview and version-aware traces

Environment (2026-10-05): macOS 27.0.1 arm64 with OrbStack (Docker Engine 29.4.0), Node 22.22.3, Docker Compose 5.1.2, PostgreSQL 17 with pgvector 0.8.2, Python 3.14.6 worker, TypeScript 7.0.2, Playwright 1.63.0 Chromium. No new dependencies.

## Decisions

- **Steps are recorded, not inferred.** Migration `019-traces.sql` adds `execution_steps`. The worker records each visited step when it starts and again when it ends, with its route (`output`), status, the reason a turn stopped in it, and timing. Attempts gain `step_ordinal`, so every provider or HTTP attempt belongs to one step visit; loops are distinguished. Extraction attempts and turns run before the migration have no ordinal and are listed separately.
- **Value-free detail.** It holds only these:
  - evidence and citations by source, document and page;
  - a decision's top choice and its probability (also when it fell below the threshold and took `uncertain`), or its failure reason;
  - lookup result field names;
  - an intermediate agent's context field names;
  - whether a reply was simulated.

  Never prompts, messages, passage text, field values, inputs, Customer identities or secrets.
- **Delivery comes from the job.** `finish()` can still turn a reply into a stop (a permission, action control, memory or source changed). The trace therefore reports each turn's `status`/`error` from its job. A step still `started` after its job ended is reported `interrupted`.
- **Preview runs the published version, never the draft.** A preview conversation is an ordinary conversation, pinned at creation, on an anonymous chat session whose token is never issued. Only the Owner API reaches it.
  - It is flagged `preview`. The inbox excludes it from the list and returns 404 for its detail and actions; memory already returns 404, because a preview has no Customer.
  - Submissions reuse the Customer path (`submit()` in `chat.ts`): the same locking, deduplication and job creation.
- **Traces live in the configuration view.** They are not in the inbox, so locating a step can never point into another Business's draft. **Recent conversations** opens any recent Customer or preview trace.
- **Locating is read-only.** On the canvas it calls `select()`/`centerOn()`; in JSON view it selects the step ID in the text, searching after `"steps"` so an agent with the same ID is not matched. It never switches view (switching reformats or saves), and never edits or saves.
  - A step is compared by ID **and** type: a reused ID of another type is "changed in draft" and is not located.
  - With invalid draft JSON, it is a text search, and the status line says so.
  - Every status line names the version that ran.

## Reproduce

```sh
npm ci --ignore-scripts
npm run typecheck
docker compose -f compose.yaml -f compose.test.yaml up --build -d --wait
node --test --test-concurrency=1 tests/traces.test.mjs   # 5 tests, about 15 seconds
caffeinate -i npm test
docker compose up -d --wait --remove-orphans                # leave test mode
```

## Acceptance evidence (`tests/traces.test.mjs`)

| Criterion | Runnable evidence |
| --- | --- |
| Preview identifies simulation versus connected mode and the pinned configuration per reply | **Preview** test: a new preview is `configuration_version: 1`, `mode: simulation`, `preview: true`; its reply is simulated and its trace records `{agent, simulated:true}` and no attempts. After version 2 (connected) is published, a new preview pins 2/connected and replies through the fixture provider, while the first still reports version 1. The trace list shows both with their own version and mode. **Browser** journey: New chat reports "pinned to published version 2 (simulation)", and each reply carries a "Simulation · version 2" tag. |
| Trace steps present ordered types/statuses/timing and safe metadata without secret values | **Routed** test, a decision → agent → lookup → agent turn: exact ordered steps (`triage` decision → `order_status`, `{choice, probability:0.9}`; `status` agent → `reply`, `{lookups:[{action:'lookup',fields:['status']}]}`). Attempts are attached to their steps: Jev `jev-1.13.0` 376/56 USD 0.00001579; DeepSeek generation 1000/100 USD 0.0007 (twice); HTTP lookup. Every step and attempt has a finish time no earlier than its start. The trace contains none of: the credential secret, provider keys, the Customer's external ID, the order ID, the result value, the reply text or the instructions' fixture key. Further cases:<br>• below threshold: `uncertain` with `{choice:'refund', probability:0.55}`;<br>• malformed Jev output: `failure` with `{reason:'malformed decision output'}`, then the `handoff` step;<br>• a DeepSeek 401: the step `failed` with `agent failed: status 401`, and so did the turn.<br>**Evidence** test: retrieval and citations reference `{source:'faq', document:'faq.txt', page:null}`; the passage text is absent. |
| Support and other Businesses are denied through both API and UI | **Access** test: Support and another Business's Owner get `404` on all five routes. Cross-Business conversation IDs get `404` both ways, and nothing is queued. A Customer conversation's trace is `404` for Support and `200` for the Owner. Signed out: `401`; foreign or missing Origin on POST: `403`. An Owner demoted to Support gets `404` on the next request of the same session. **Browser**: Support sees the Business without Manage and no Preview chat. |
| Selecting a trace step locates its node or JSON section without changing any draft value or revision | **Browser** journey with a pretty-printed saved draft:<br>• canvas: "locate" selects the `reply` node;<br>• JSON view: the selection is exactly `"id": "reply"`, after `"steps"` (an agent has the same ID);<br>• after each click the server revision and text are unchanged, the editor text is byte-identical, and no unsaved-edits dialog appears. |
| Older-version missing nodes and invalid current JSON are handled explicitly | **Browser**:<br>• `route` (dropped from the draft) is tagged "not in draft" and its status names version 2;<br>• `greet` (an agent in version 2, a handoff in the draft) is "changed in draft" and is not located; the selection stays on `reply`;<br>• with invalid draft JSON saved and reloaded, locate says "by text search, because the draft JSON is invalid" and the text and revision are unchanged;<br>• after version 3 is published, the version 2 conversation says "Version 3 is published now; New chat uses it". |
| Browser journeys verify navigation, version distinction and draft immutability | The **browser** journey above, at 1440 px and then 390 px (no horizontal overflow), with no page errors. |

Also in the **preview** test:
- inbox list, detail, claim and memory exclude the preview;
- a retried submission returns the original message (`202`, then `200` with the same ID), and the same ID with other text gets `409`;
- a preview that reaches a handoff waits for support, stays out of the inbox, and the UI offers New chat.

Full suite (2026-10-05): `npm run typecheck` clean. `caffeinate -i npm test` ran **103 tests: 102 passed, 1 failed** (26.3 minutes). The failure was the browser journey, which I had edited during the run; it ran against images built before its UI wording change. After rebuilding, `tests/traces.test.mjs` passed **5 of 5**.

## Mutation checks

Each mutant was applied, built into the test images, run against the named test and restored; the final rebuild has no diff.

| Mutation | Result |
| --- | --- |
| Trace/preview routes accept any active Member (no `role='Owner'`) | Access test failed |
| Inbox list includes preview conversations | Preview test failed |
| Evidence references include passage text | Evidence test failed |
| Locate compares step IDs only, ignoring type | Browser journey failed |

## Real integration run

**Run 2026-10-05**:
- The user's real `DEEPSEEK_API_KEY` and `TYPESAFE_API_KEY` (worker only), and no `PROVIDER_RATES`, so cost is not estimated.
- Stack: `docker compose -f compose.yaml -f compose.connected.yaml up --build -d --wait --remove-orphans`.
- Driver: `node tests/real-trace.mjs` (not part of `npm test`), public APIs only.
- Business: a fresh one with published version 2: a Jev decision (`refund`, `order_status`; threshold 0.6) routing to `deepseek-flash` agents with `max_tokens: 1000`.

| Conversation · message | Steps (route, time) | Attempts (served model, tokens) |
| --- | --- | --- |
| Preview · cracked lid, money back | `triage` → `refund` (p 1.0, 457 ms); `refund` → reply (1140 ms) | `jev-1.13.0` 370/49; `deepseek-flash` 206/95 |
| Preview · where is my order | `triage` → `order_status` (p 1.0, 550 ms); `status` → reply (1252 ms) | `jev-1.13.0` 368/50; `deepseek-flash` 263/132 |
| Customer website chat · "hmm" | `triage` → `order_status` (p 0.92, 325 ms); `status` → reply (728 ms) | `jev-1.13.0` 357/50; `deepseek-flash` 189/76 |

Both conversations reported version 2 and `connected`; the preview reported `preview: true`. Redaction, counted without printing values (all `0`): either key in either trace, in `docker compose logs app worker`, and in a `pg_dump --data-only`.

What this establishes:
- Real step, route and probability recording.
- Real served models and usage per attempt, attached to their steps.
- Owner preview over real providers, and a Customer conversation's trace.

It does not establish routing quality. "hmm" routed to `order_status` with probability 0.92, so the threshold did not catch that ambiguity. That is for the demo evaluation (#36).
