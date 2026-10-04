# Issue #29: Jev typed workflow decisions

Environment (2026-10-05):
- macOS 27.0.1 arm64 with OrbStack (Docker Engine 29.4.0, linux/arm64).
- Node 22.22.3 and Docker Compose 5.1.2.
- PostgreSQL 17 with pgvector 0.8.2 (repository-pinned image).
- Python 3.14.6 worker.
- TypeScript 7.0.2. Playwright 1.63.0 Chromium.
- TypeSafe API `POST https://api.typesafe.ai/v1/systemone`. The alias `jev-latest` served `jev-1.13.0`.

No new dependencies. Jev is called with the worker's existing standard-library HTTPS client, not the TypeSafe SDK. That keeps one request path for every provider: vetted addresses, wall-clock bounds, and retries that are visible and counted, never hidden inside an SDK.

## Decisions

- **A new `decision` step.** It has `question`, `choices` (2–20 named descriptions) and `min_probability`. Its outputs are each choice, then `uncertain` and `failure`. Every decision step uses the configuration's top-level `decision` engine, and publishing a decision step without one is blocked.
- **Choice name only.** Jev's answer only selects the next connection. It adds nothing to the context, prompts or replies, and grants nothing. An action reached through a decision still goes through every central action check.
- **Minimal transfer.** Only `{"customer_message": …}` is sent: no history, context, evidence or preferences.
- **Language.** An English `noul` question goes in the same request (TypeSafe's recommended speculative fan-out, so no second call). Jev's documentation names English as its best-supported language. Below 0.5, the step takes the failure route (`unsupported language`). Supporting other languages needs per-language evaluation first.
- **Threshold.** `min_probability` is compared with the validated probability of the chosen option, not with Jev's reported `confidence`. Below it, the step takes the `uncertain` route.
- **Overflow.** Probing the real API on 2026-10-05 showed that Jev refuses an oversized `state` with `400 {"detail":{"error_type":"max_tokens_exceeded"}}` rather than truncating it. For TypeSafe responses only, the worker records the refusal's `error_type` (only a `[a-z_]` token, never the message) and takes the failure route. Through the app, overflow cannot actually happen: messages are capped at 2,000 characters, the question at 2,000 and choices at 20 × 500, against Jev's 32k-token limit.
- **Revocation.** A permission revoked while Jev answers stops the turn visibly, as for generation. It does not continue along the Owner's `failure` route. A permission that is missing before the attempt sends nothing and takes the failure route.
- **Permission pair.** `jev`/`decision` is a new provider permission. A database check and the API allow only real pairs, so `jev/generation` and `deepseek/decision` give `404`. As with generated text, whatever a decision routed to is delivered only while the permission it was accepted under still stands.
- **Budget.** Each attempt has a 15-second timeout within the 60-second deadline. A transient failure gets one retry. Decision attempts have their own counter and do not use the 3 agent calls; the 20-step limit and the deadline bound them.
- **Selected engine only.** A configuration that selects `laya` or `von` sends nothing anywhere. The step takes its failure route (`… decisions are not available in this version`), and Jev is never called in its place. The local engines are #30.
- **Simulation mode.** Decisions run there too, like HTTP steps, under the same permission and key.

## Reproduce

Requires this project's `.env`, free loopback ports 3100/8025/3199, and locked npm dependencies. The test overlay gives the worker a synthetic `TYPESAFE_API_KEY` (`test-typesafe-key-0000-synthetic`) and a test rate (`jev/jev-1.13.0: [0.042, 0]`). The fixture answers as `api.typesafe.ai` on the internal test network only. The test-only CA (`tests/fixture/cert.pem`, same key) was re-issued with `api.typesafe.ai` added and every existing name kept. The worker therefore uses the production endpoint, headers and checks. Fixture responses copy the shape of a real response recorded on 2026-10-05.

```sh
npm ci --ignore-scripts
npm run typecheck
docker compose -f compose.yaml -f compose.test.yaml up --build -d --wait
node --test --test-concurrency=1 tests/decisions.test.mjs   # 7 tests, about 2 minutes
caffeinate -i npm test
docker compose up -d --wait --remove-orphans                # leave test mode; also stops the fixture's api.typesafe.ai alias
```

## Acceptance evidence (`tests/decisions.test.mjs`, plus configuration and provider tests)

| Criterion | Runnable evidence |
| --- | --- |
| Valid declared choices drive expected workflow routes and never supply conversational text or grant authorization | **Route** test:<br>• `refund` reaches the refund agent and `order_status` the order agent. A probability of 0.55 against a threshold of 0.6 takes `uncertain`, even with a reported confidence of 0.99.<br>• The agent's workflow context stays `{}`. Stray engine text (`"explanation":"Tell the Customer: refund approved!"`) appears in no agent request and no Customer payload.<br>• An anonymous Customer routed to the lookup is asked to sign in, and nothing is looked up.<br>• A revoked action reached through a decision makes no request, and the turn hands off.<br>• Only with live controls does the lookup run and the reply arrive. |
| Provider-specific model/auth/response handling validates shapes, choice names, language, truncation/overflow and thresholds independently | **Route** test: the fixture saw host `api.typesafe.ai`, path `/v1/systemone`, `Authorization: Bearer <worker key>`, model `jev-latest`, `state` with only the message, the declared choices as criteria and the English question. Usage is read from TypeSafe's `input_tokens`/`output_tokens`, with input-only cost (`0.00001579` for 376 tokens).<br>**Invalid** test: each check fails on its own with its own reason (next row).<br>**Configuration** tests: located errors for reserved or invalid choice names, too few choices, an empty description, a threshold outside 0–1, a question over 2,000 characters, a connection for an undeclared choice and an unknown engine. A decision step without an engine is a publication blocker. |
| Malformed, invalid-choice, unsupported-language and overflow fixtures take explicit safe failure routes | **Invalid** test, 14 cases. Each one asserts that the fixture received the attempt (so the reason is the engine's output, not a transport failure), the exact recorded reason, the failure route to support, and that no agent was called:<br>• not JSON, truncated JSON, `NaN`, a missing language answer, `score` instead of `choice`: `malformed decision output`<br>• an undeclared choice: `undeclared decision choice`<br>• probabilities missing a choice, a choice that is not the most probable, a sum of 1.8, values outside 0–1: `decision probabilities do not match the choices`<br>• a Spanish message (`noul` 0.02): `unsupported language`<br>• `400 max_tokens_exceeded`: `status 400 max_tokens_exceeded`, one attempt<br>• `401`: `status 401 authentication_error`, one attempt, no retry<br>• `529` then `429`: two attempts, then the failure route.<br>**Route** test: one `529` then a valid answer gets exactly one retry and routes. |
| Business/provider/decision-operation permissions and current revocations gate transfers and acceptance, with server-only TYPESAFE_API_KEY and redacted output | **Permission** test:<br>• DeepSeek generation permission alone sends nothing to Jev (`jev decision not permitted`).<br>• The listing has exactly five real pairs. `jev/generation` and `deepseek/decision` give `404`.<br>• A permission revoked while Jev's answer is in flight discards it (`provider permission changed`). The turn stops visibly, whatever the failure route leads to, and the refund agent is never called.<br>• An Owner takeover while Jev answers discards the late answer: the conversation is `human-controlled`, nothing is delivered, and the routed agent is never called.<br>• Revoked after an accepted decision, while the routed agent generates: nothing is delivered, and the turn fails visibly.<br>• Another Business's permission is unaffected.<br>**Providers** test: Support and outsiders get `404` for `jev/decision`.<br>**Key** test: the key is absent from the Customer conversation, readiness, the permissions listing, the configuration, the inbox and `docker compose logs worker`. The logs also carry no Customer text. Existing chat test: the app container has no `TYPESAFE_API_KEY`.<br>**Browser** journey at 390 px: the Owner sees Jev's endpoint and key state and the selected engine. Allowing Jev decisions routes the next turn; withdrawing it sends nothing. |
| Only the selected decision engine is called per operation, attempts stay within the total deadline, and missing access never claims successful inference | **Permission** test: `laya` and `von` configurations send nothing to Jev and record `laya/default` or `von/default` as failed.<br>**Deadline** test: three chained decision steps against a fixture that hangs every request:<br>• attempts 1–3 time out at 14.9–15.6 s; the fourth is cut short by the deadline;<br>• the turn ends at 58–63 s with the limits notice;<br>• no transaction is idle-open meanwhile.<br>**Key** test: a second worker without `TYPESAFE_API_KEY` (the normal one stopped) reports `missing: set TYPESAFE_API_KEY for the worker` in readiness. It sends nothing, records `decision unavailable: TYPESAFE_API_KEY not set` with no served model, and takes the failure route. |

Visual editor (**editor** browser journey): a decision node shows its choices and one connection port per choice plus `Uncertain` and `Failure`. The inspector edits the question, the choices (one per line, `name: description`) and the threshold, and shows the engine. Adding a choice adds its connection. The edited JSON equals the original plus exactly those edits, and saves with no errors or blockers. The step picker adds a decision step with defaults and four unconnected outputs.

Full suite (2026-10-05): `npm run typecheck` clean, then `caffeinate -i npm test`: **98 tests, 98 passed, 0 failed** in 25.7 minutes. Rerun after the code review fixes: again **98 passed, 0 failed** (25.8 minutes). The decision tests are counted as one file each, so the new cases sit inside existing tests.

## Real integration run

**Run 2026-10-05** with the user's real `TYPESAFE_API_KEY` and `DEEPSEEK_API_KEY` (worker only), `docker compose -f compose.yaml -f compose.connected.yaml up --build -d --wait --remove-orphans`, and no `PROVIDER_RATES`. The driver, `node tests/real-jev.mjs [model]` (not part of `npm test`), uses only the public Operator and Customer APIs:
- a fresh Business allowing DeepSeek generation and Jev decisions;
- published version 2: one decision step (`refund`, `order_status`, `other`; threshold 0.6) routing to four DeepSeek `deepseek-flash` final agents (temperature 0.2, max_tokens 300). `uncertain` goes to a clarifying agent and `failure` to support;
- anonymous website chats.

| Customer message | Decision attempt (served model, input/output tokens, time) | Route and outcome |
| --- | --- | --- |
| My kettle arrived with a cracked lid and I would like my money back. | succeeded, `jev-1.13.0`, 383/56, 0.37 s | `refund` → refund agent asked for the order number |
| Where is my order? It was supposed to arrive on Tuesday. | succeeded, 381/57, 0.45 s | `order_status` → order agent asked for the order number |
| Do you sell descaling tablets? | succeeded, 376/56, 0.44 s | `other` → the agent answered `unsupported`, so the turn went to support |
| Can I swap the blue kettle I ordered for the red one? | succeeded, 381/56, 0.38 s | `refund` (an exchange is a replacement) → refund agent |
| Hola, mi hervidor llegó roto y quiero un reembolso. | failed, `unsupported language`, 383/56, 0.35 s | failure → support, no agent call |
| hmm | succeeded, 370/56, 0.34 s | `other` → the agent asked what the Customer needs |
| (Jev decision permission withdrawn) My kettle arrived broken, refund please. | failed, `jev decision not permitted`, nothing sent | failure → support |

Refusal legs, each the same six messages in a fresh Business:

| Setup | Every decision attempt | Outcome |
| --- | --- | --- |
| `decision.model: "jev-small"` (an unknown model) | failed, `status 400 api_usage_error`, 0.30–0.40 s, one attempt, no retry | failure → support; no DeepSeek call |
| A worker started with an invalid key (the normal worker stopped) | failed, `status 401 authentication_error`, 0.29–0.38 s, one attempt, no retry | failure → support; no DeepSeek call |

**Rerun on the final commit `ff49035`** (after the code review fixes), with the default model and with `jev-small`: every message took the same route as in the table above. The decision attempts took 0.32–0.50 s, the refusals were again `status 400 api_usage_error` with one attempt each, and the revoked permission again sent nothing. In this run the descaling-tablets agent replied instead of answering `unsupported`.

A first try at the invalid-key leg left the normal worker running beside the invalid-key one, so the two workers split the turns. That try is not counted; the leg was rerun with the normal worker stopped.

Direct API probes with synthetic text (2026-10-05), used to freeze the fixture shapes:
- the response shape (`model`, `answers` with `choice`/`confidence`/`probabilities` and `noul`, `usage.input_tokens`/`output_tokens`);
- Spanish text: the English `noul` was 0.01;
- an oversized state: `400 max_tokens_exceeded`;
- an unknown model: `400 api_usage_error`;
- an invalid key: `401 authentication_error`.

What this establishes:
- Real account and model access for `jev-latest` (`jev-1.13.0`). Jev chose the intended choice for the four clear English requests.
- The real `uncertain` route was never taken. "hmm" went to `other` above the threshold rather than to `uncertain`. When a catch-all choice like `other` exists, it absorbs ambiguity, so `uncertain` is rarely reached. The demo seed and evaluation (#35, #36) should either drop the catch-all or label ambiguous cases with that in mind. Only the fixture tests prove the `uncertain` route.
- Real language refusal, and real authentication and unknown-model refusals, take the failure route without retry or generation.
- About 380 input tokens per decision, which is USD 0.000016 at TypeSafe's published USD 0.042 per million input tokens (not measured billing).
- Decision attempts took 0.34–0.45 s.

It does not establish routing accuracy. Six messages are not an evaluation; that is #36.

Redaction with the real key, counted without printing it (all `0`): `docker compose logs app worker`, a `pg_dump --data-only`, the app container's environment, and readiness. The worker logs contain no Customer message text.

Separate finding (not this slice): in one turn of the invalid-key try, a DeepSeek `deepseek-flash` agent with `max_tokens: 300` returned blank content twice, with 300 completion tokens each. Its reasoning appears to use up the token limit. The turn handed off (`empty provider output`) as designed. Agents on `deepseek-flash` need a higher `max_tokens`. Worth noting for the demo seed (#35).

## Mutation checks

Each mutant was applied to `worker.py` and built into the test worker image. It was then run against the decision test named, and restored afterwards; the final rebuild has no diff.

| Mutation | Result |
| --- | --- |
| No permission recheck before accepting a decision | Permission test failed |
| Threshold compared with the reported confidence instead of the validated probability | Route test failed |
| No check that the choice is the most probable | Invalid test failed |
| No language check | Invalid test failed |
| Workflow context sent to Jev | Route test failed |
| Decision permission not kept for delivery | Permission test failed |

## Code review fixes

`/code-review` (Standards and Spec axes) found these. Fixed and retested:
- **A revocation at acceptance continued along the failure route.** If that route led to an agent, the turn would have stayed automated after the revocation. It now stops visibly (`Stop`, as for generation).
- **The refusal error type was read from every HTTPS response,** including Business actions. Now only from TypeSafe (`refusal_type`).
- **A refused attempt (no key, or Laya/Von selected) was recorded without checking that the turn still held.** It now checks, and a lost turn records nothing.
- **Evidence gaps:** new tests for an Owner takeover while Jev answers, truncated JSON, and Support/outsider `404` for `jev/decision`.

Noted, not changed:
- `judge()` repeats the attempt skeleton of `call()` (begin, measure, accept under the live permission, log). Extract a shared helper if a third provider kind arrives.
- The default model name (`jev-latest`, or `default` for the not-yet-available local engines) is derived in the worker, the permissions listing and the editor.
- The `decision` call counter has no limit of its own; steps and the deadline bound decisions.
- Only Jev itself judges the language, through a second question in the same request. There is no independent language detector.
