# Issue #28: DeepSeek generation and Qwen fallback

Environment (2026-10-04):
- macOS 27.0.1 arm64 with OrbStack (Docker Engine 29.4.0, linux/arm64).
- Node 22.22.3 and Docker Compose 5.1.2.
- PostgreSQL 17 with pgvector 0.8.2 (repository-pinned image).
- Python 3.14.6 worker.
- TypeScript 7.0.2. Playwright 1.63.0 Chromium.

No new dependencies. Provider calls use the worker's existing standard-library HTTPS client.

## Decisions (agreed with the user before building)

- **Memory extraction is deferred to #23.** Customer memory does not exist yet, so extraction has no consent, store or trigger to run on. This slice records an `extraction` permission operation (API and table) but sends nothing for extraction. The extraction parts of acceptance criteria 1 and 2 are **unmet here** and belong to #23.
- **Egress is opt-in.** The default launch and the test stack keep the worker on the internal network without outbound access (the knowledge test still proves this). Connected generation needs `compose.connected.yaml`, which adds the worker to the `web` network.
- **Retry rule.** Each agent call gets at most two attempts. A transient failure (timeout, connection error, 429, 5xx) gets exactly one more attempt: the configured Qwen `fallback` when there is one (and only if Qwen generation is permitted and its key is set), otherwise the same model. Both attempts count toward the 3 agent calls and the 60-second deadline.
- **Cost** is estimated only from operator-configured `PROVIDER_RATES` (USD per million input/output tokens, keyed by the served model). Without a rate it is null. Prices were not hard-coded.
- **Qwen as a primary model stays allowed** (the configuration schema already allowed it, and published versions use it). It is disclosed in readiness and in the Owner view, and needs Qwen's own generation permission.
- **No partial delivery is possible.** Responses are read whole (non-streaming), and replies are committed only when the whole turn finishes, so a fallback can never follow partly delivered text.

## Reproduce

Requires this project's `.env`, free loopback ports 3100/8025/3199, and locked npm dependencies. The test overlay gives the worker synthetic keys (`test-deepseek-key-0000-synthetic`, `test-dashscope-key-0000-synthetic`) and test rates. The fixture answers as `api.deepseek.com` and `dashscope-intl.aliyuncs.com` on the internal test network only, with a test-only CA (`tests/fixture/cert.pem`, regenerated with those two names). The worker therefore uses the production endpoints, headers and checks. No real provider is reached.

```sh
npm ci --ignore-scripts
npm run typecheck
docker compose -f compose.yaml -f compose.test.yaml up --build -d --wait
node --test tests/providers.test.mjs        # 7 tests, about 2 minutes
caffeinate -i npm test                      # keep the Mac awake; sleep skews the Docker VM clock
docker compose up -d --wait --remove-orphans # leave test mode; also stops the fixture's provider aliases
```

## Acceptance evidence (`tests/providers.test.mjs`)

| Criterion | Runnable evidence |
| --- | --- |
| Controlled provider servers prove Business/provider/operation permission before generation, extraction and fallback transfers, and revocation before late-result acceptance | **Gate** test:<br>• Without DeepSeek generation permission the fixture receives nothing. The attempt records `deepseek generation not permitted`, and the turn hands off.<br>• An `extraction` permission alone does not permit generation.<br>• After the Owner allows generation, the reply is delivered.<br>• Another Business of the same Owner, with the same workflow, still sends nothing.<br>**Fallback** test: a not-permitted Qwen fallback is never called (`qwen generation not permitted`, `fallback: true`).<br>**Races** test, with in-flight fixture calls:<br>• DeepSeek revoked while it generates: the output is discarded (`provider permission changed`), nothing is delivered, and there is no Qwen call.<br>• Revoked and re-allowed during the call: still discarded, because the revision changed.<br>• Qwen revoked while DeepSeek fails slowly: no Qwen call.<br>• DeepSeek revoked during a later HTTP step: an earlier agent's DeepSeek output never reaches a permitted Qwen final agent.<br>**Extraction transfers: not established (deferred to #23).** |
| DeepSeek final replies and permitted extraction use server-side credentials and independently validated output, with no key values in exposed payloads | **Gate** test: the fixture saw host `api.deepseek.com`, path `/chat/completions`, `Authorization: Bearer <worker key>`, model `deepseek-flash` and JSON mode. The reply is `simulated: false`.<br>**Fallback** test: each key goes only to its own provider. Output is validated independently of the model: non-JSON output, `finish_reason` other than `stop`, a body without a completion, and output outside the agent contract each hand off without fallback.<br>**Controls** test: a 401 whose body echoes the DeepSeek key. Neither key appears in attempt rows, the Customer conversation, the inbox detail, the permissions listing, readiness, or `docker compose logs app worker`.<br>Chat test: the app container's environment has no provider key.<br>**Extraction: deferred to #23.** |
| Transient DeepSeek failure allows at most one authorized Qwen attempt within budget/deadline before any generated text is delivered; never a third provider or restart after partial delivery | **Fallback** test:<br>• 503 then Qwen: exactly one Qwen call, to host `dashscope-intl.aliyuncs.com`, path `/compatible-mode/v1/chat/completions`, with the Qwen key, model `qwen3.7-plus-2026-05-26`, `enable_thinking: false`, the same messages and the agent's temperature.<br>• 429 is transient too.<br>• A Qwen 502 after a DeepSeek 503 hands off with exactly one call each, and no third attempt.<br>• Without a configured fallback, DeepSeek is retried once and Qwen is never called.<br>**Budget** test:<br>• the fallback spends an agent call, so the third agent of a three-agent chain is never called.<br>• A DeepSeek attempt that hangs to the deadline leaves no Qwen attempt.<br>Partial delivery cannot happen structurally (see Decisions). |
| Authentication/authorization/invalid-output failures hand off without blind retry; missing keys produce labelled simulation or unavailable service | **Fallback** test: 401, 403 and invalid outputs make exactly one DeepSeek call and no Qwen call, and hand off as `automation-failure`.<br>**Keyless** test, with a second worker started without keys (the normal one stopped):<br>• readiness reports `missing: set DEEPSEEK_API_KEY for the worker`.<br>• A connected turn says "connected generation is unavailable", hands off and sends nothing.<br>• A simulation Business still gets the labelled simulated reply.<br>• With only the Qwen key missing, a transient DeepSeek failure hands off (`qwen fallback unavailable: DASHSCOPE_API_KEY not set`) without a Qwen call. |
| Qwen base is exactly the approved URL; candidate models stay configuration choices, with account access unclaimed until measured | The worker hard-codes `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`. The **Fallback** test checks the fixture saw exactly that host and path. Model names are free configuration values. Readiness reports a configured key as "account and model access not verified until a measured run". **Controls** test: a fallback is valid only on a DeepSeek model and only for Qwen (located errors otherwise). |
| Readiness and redacted attempts/latency/usage/cost identify selected model and fallback, and disclose potentially worldwide inference excluding Chinese mainland | **Controls** test:<br>• readiness `generation` lists both endpoints, roles and key states, and Qwen's `processing: "Singapore access and static storage; inference potentially worldwide excluding Chinese mainland (not Singapore-only processing)"`.<br>• The Owner listing names the latest published version's models and fallback (`answer uses deepseek/deepseek-flash, fallback qwen/…`).<br>• Attempt rows record target, operation, `fallback`, status, error, timing, served model, tokens and cost (`0.0007` and `0.0014` at the test rates; null for a model without a rate).<br>• Each worker log line has the same data and no Customer text.<br>**Browser** journey, at 1280 and 390 px:<br>• the Owner sees the disclosure, key readiness and selected models.<br>• Allowing DeepSeek makes the next turn reply; withdrawing it stops the next turn before any transfer.<br>• No horizontal scroll, no page errors. |

## Mutation checks

Each mutant was applied to `worker.py`, built into the worker image (its presence was confirmed inside the running container), run against its provider test, then restored.

| Mutation | Result |
| --- | --- |
| No permission check before a provider attempt | Gate test failed |
| No permission recheck before accepting output | Races test failed |
| Fallback also after non-transient (`Rejected`) failures | Fallback test failed |
| No recheck of earlier outputs' permissions before a later transfer | Races test failed |
| `finish_reason` not checked | Fallback test failed |
| A third attempt (three tries, a third route) | Fallback test failed |

A first "third attempt" mutant (`for tries in (1, 2, 3)` alone) survived because it was equivalent: the `tries == 2` guard still ended the loop. It was replaced by the real three-attempt mutant above.

## Production network path (no keys needed)

- `docker compose -f compose.yaml -f compose.connected.yaml config` puts the worker on `internal` and `web`.
- A worker run under the overlay completed verified TLS 1.3 to `api.deepseek.com` (issuer Amazon RSA 2048 M01) and `dashscope-intl.aliyuncs.com` (issuer GlobalSign GCC R46 OV TLS CA 2025) with the image's own CA bundle.
- **Finding:** the first attempt failed with "self-signed certificate". After a test run, `docker compose up -d --wait` had left the test fixture running as an orphan on the internal network, still answering for both provider hostnames. TLS verification refused it, so no key was sent. Leaving test mode now uses `--remove-orphans` (README and above).

## Code review fixes

`/code-review` (Standards and Spec axes) found these; all fixed and retested:
- **Readiness did not name the selected model and fallback.** The Owner provider listing and view now show the latest published version's mode and each agent's model and fallback.
- **Qwen-as-primary was undisclosed.** Qwen's role now says it can be an agent's selected model as well as the fallback.
- **Duplication and naming:** provider/operation lists built the route from one place; the UI takes roles from the worker report; the permission revision and the empty measurement are named; `PROVIDER_RATES` is validated without `assert`.
- **Missing validation record:** this file.

## Real integration run

Plan change (2026-10-04, from the user): no Qwen key is available, so only DeepSeek can be run for real. The DeepSeek model stays `deepseek-flash`. DeepSeek's documentation says that ID is served by DeepSeek-V4.1-Flash, and `deepseek-v4.1-flash` is not a documented ID. The real run records the served model, which shows the actual version.

DeepSeek leg, **run 2026-10-04** with the user's real `DEEPSEEK_API_KEY` (worker only), `docker compose -f compose.yaml -f compose.connected.yaml up --build -d --wait --remove-orphans`, and no `PROVIDER_RATES`. It went through the public Operator and Customer APIs: a fresh Business, DeepSeek generation allowed, and published version 2 with one final agent `deepseek/deepseek-flash` (temperature 0.2, max_tokens 400, no fallback) answering from bookshop opening hours in its instructions.

| Customer message | Outcome | Attempt (served model, prompt/completion tokens, attempt time) |
| --- | --- | --- |
| Are you open on Saturday? | Delivered, `simulated: false`: "No — we're closed on weekends. We're open Monday to Friday, 09:00-17:00." | succeeded, `deepseek-flash`, 152/62, 1.01 s |
| What time do you close on Wednesdays? | Delivered: "We close at 17:00 on Wednesdays." | succeeded, `deepseek-flash`, 156/81, 1.03 s |
| Can you tell me the price of a first-edition Dune? | The model answered `unsupported`; the conversation went to support (`workflow-handoff`), and no text was delivered | succeeded, `deepseek-flash`, 160/27, 0.55 s |
| Hello? (agent model `deepseek-v4.1-flash`, in another Business) | DeepSeek rejected the model name. One attempt, no retry; handed to support as `automation-failure` | failed, `status 400`, 0.26 s |

What this establishes:
- Real account and model access for `deepseek-flash`.
- Valid real JSON-mode output through the agent contract, and real usage reporting.
- The Owner listing names the selected model.
- The model's real abstention path goes to support.
- `deepseek-v4.1-flash` is not an accepted ID: the API returns `400`. DeepSeek reports the served model only as `deepseek-flash`, so the V4.1-Flash version comes from DeepSeek's documentation, not from this run.

Redaction with the real key, counted without printing it (all `0`): `docker compose logs app worker`, a `pg_dump --data-only`, the app container's environment, and readiness. Cost is null because no rates were configured.

Qwen leg: **blocked until a Singapore/International `DASHSCOPE_API_KEY` exists.** Until then, real Qwen endpoint, key and model access, and acceptance of `enable_thinking: false`, are unestablished. Without that key, a configured fallback cannot run: a transient DeepSeek failure hands off with `qwen fallback unavailable: DASHSCOPE_API_KEY not set` (Keyless test). So configure no `fallback` until the key exists.

## Blank JSON-mode replies (fixed after #23, 2026-10-04)

**Finding.** In #23's real run, DeepSeek answered "I have diabetes. Remember my medical diagnosis." with whitespace only (`finish_reason: stop`). The reply contract rejected it as invalid output, without a retry, and the conversation went to support. [DeepSeek's JSON Output guide](https://api-docs.deepseek.com/guides/json_mode) states that the API "may occasionally return empty content" and suggests adjusting the prompt.

**Diagnosis.** The failing request was replayed from the database against real DeepSeek (`deepseek-flash`), 5 times per variant:

| Variant | Valid replies | Completion tokens |
| --- | --- | --- |
| A: current request (it ends with the workflow-context data message) | 1 of 5; 4 blank | 108–180 |
| B: example JSON output added to the contract | 5 of 5 | 259–392 |
| C: a closing instruction after the data (system role) | 5 of 5 | 98–213 |
| C′: the same closing instruction as a user message | 5 of 5 | 113–131 |
| D: text mode instead of JSON mode | 5 of 5 | 207–384 |

The model reasons first (its `reasoning_content` is present), and when the request ends on data with no closing instruction, JSON mode often emits nothing.

**Fix (`worker/worker.py`, `worker/memory.py`).**
- **Closing instruction:** every agent request now ends with the user message "Answer now with the one JSON object described in your instructions." This is C′, chosen because it costs almost nothing in tokens and because a mid-conversation system message may be rejected by Qwen's compatible API.
- **Blank output is transient:** for replies and for memory extraction, so the documented residual case gets the one permitted retry or Qwen fallback within the existing budget. Two blank replies still hand off, with no third attempt.

**Tests, written first and failing before the fix.**
- **Providers:** a blank reply recovers on the same model and through the Qwen fallback, with attempts recorded as `empty provider output` and then `succeeded`. Blank twice hands off after exactly 2 calls. The request ends with the closing instruction, right after the workflow context.
- **Memory:** a blank extraction reply is retried once, and the preference is saved.
- Two existing assertions that read the workflow context as the last message now find it by its prefix.

**Real rerun.** Three complete #23 memory flows ran in connected mode against real DeepSeek: opt-in, name, language, style, correction, then the medical statement. Conversations: `83bdfcbf-eeef-43e4-b9c7-0b72bb95b610`, `7ceaa56a-0136-4803-8bb5-4e740c81bfdf`, `d8426529-f821-4a3b-9b8d-8546ac26ed67`.
- Every check passed in all 3 runs, and the medical-statement turn completed each time.
- All 24 provider attempts succeeded on the first try: 12 generation and 12 extraction, `deepseek-flash`, 6,119 input and 3,784 output tokens, about USD 0.0032 at USD 0.15 / 0.60 per million (estimated, cache discounts ignored).
- The diagnostic replays (30 calls) are not included; only their completion tokens were recorded.

## Not established by this slice

- **The permission recheck just before delivery** (`finish()`) is defense in depth. No test reaches the gap between accepting the final output and delivering it, so no test or mutant proves it. Late-result acceptance and later transfers are proven (Races test and mutants).

- **Memory extraction** (deferred to #23, see Decisions).
- **Model quality, latency and cost at scale** belong to #32 and #33.
- **Owner trace view of attempts** belongs to #27. Attempts are recorded and logged now.

## Results

| Run | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `node --test tests/providers.test.mjs` after the review fixes | 7/7 pass, 0 failed assertions |
| Mutation checks (6 genuine mutants) | 6/6 caught |
| Affected files `workflow`, `actions`, `chat`, `configuration` | 24/24 pass |
| `caffeinate -i npm test`, full run after the review fixes (2026-10-04, 22.0 min) | **62/62 pass, 0 failed assertions**, and no worker tracebacks |
| After the readiness wording and `--remove-orphans` fix: `node --test --test-concurrency=1 tests/providers.test.mjs tests/chat.test.mjs` | 10/10 pass (an earlier run without `--test-concurrency=1` ran the files in parallel and failed two concurrency-sensitive assertions; that was a command error) |
| Real DeepSeek integration run (2026-10-04) | **Pass:** 3 real turns: 2 replies delivered, 1 correct abstention handed off. A rejected model name hands off without retry. Real-key redaction count 0 in logs, database, app env and readiness. |
| Real Qwen integration run | **Blocked: no Qwen key available.** The fallback criterion is fixture-verified only, and this ticket stays incomplete on that point. |
