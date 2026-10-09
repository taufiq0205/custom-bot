# Issue #36 validation

The evaluation harness uses the seeded Northwind Kettles Business through public Owner and Customer APIs. The cases, expected passage fingerprints, fixture replies, pricing snapshot, judge prompt and schema are versioned and checksum-verified. Review them in [`evaluation/portfolio-v1/corpus-review.md`](../../evaluation/portfolio-v1/corpus-review.md).

The latest isolated fixture run, from commit `91c4213`, is [Markdown](../../evaluation/portfolio-v1/results/issue36-fixture-2026-10-08T18-28-27-623Z-87ee5b6a.md), [JSON](../../evaluation/portfolio-v1/results/issue36-fixture-2026-10-08T18-28-27-623Z-87ee5b6a.json) and its [SHA-256 sidecar](../../evaluation/portfolio-v1/results/issue36-fixture-2026-10-08T18-28-27-623Z-87ee5b6a.json.sha256). Its `workingTree.dirty` is true only because of an untracked `node_modules` symlink. Results:
- All 30 cases recorded, with 30/30 deterministic passes.
- Every case's provider attempts carried the worker's payload attestation, including 7 memory extractions; the 4 memory cases each had an attested extraction.
- 30 judge previews ran through the worker with scripted replies, which were parsed and left `pending`.
- Baseline configuration, the Owner's draft text, demo memory and all three temporary sources were restored.

The report stays `pending-review`: human verdicts, real LLM judge verdicts and connected provider evidence are absent. Fixture mode verifies the harness and the seeded API path. It makes no live model, latency or cost claim; its USD figure prices scripted fixture usage.

## Review repairs (after b5e234a)

- **Judge key custody.** The runner no longer reads `DEEPSEEK_API_KEY` or honours `EVAL_JUDGE_ENDPOINT`. It drops provider keys from its environment at startup. The frozen judge is a published configuration asked in Owner previews: the worker sends its requests and records their usage, and that usage counts toward the run cost.
- **SAFE-04 payload evidence.** Each generation, decision and extraction attempt records a value-free `payload_check` (migration 021, shown in the trace API). The worker refuses a payload that contains an active credential or a provider key; it checks each string raw and once more JSON-escaped. It also fails closed when a credential is unreadable or the payload is missing. Scoring requires that attestation on every attempt that could transfer data, against the case's named credential. A secret that was found and blocked still fails the case.
- **Outcome scoring.** Only RET-08, RET-09, ROUTE-05 and SAFE-04 accept their rubric's alternative to a handoff: a clarifying question for ROUTE-05, an abstention or refusal for the others. The alternative counts only as an uncited reply whose every sentence asks a question or declines. A sentence that both claims and declines still passes this check and is left to the reviews.
- **Found while repairing.**
  - Extraction attempts were counted twice, because a turn's trace attempts already include them.
  - Cleanup overwrote an unpublished Owner draft.
  - `--connected` against a test-mode stack would have recorded fixture replies as provider evidence; readiness now reports `mode`, and connected mode requires `local` or `hosted`.
  - The demo test counted workers by container name; it now counts the current Compose project's `worker` service.

Three review passes followed the repairs: a standards and a spec review of `d483e67`, then a two-axis review of `613ad76`. Their findings were fixed in `613ad76` and `91c4213`, except a `--rejudge` option, which is deferred (a full rerun costs under the USD 1 bound).

## Test runs

- Full `npm test` on `d483e67`: 115/115 passed (29.5 min).
- Full `npm test` on `613ad76`: 115/116 passed (30.2 min). The failure was the fixture evaluation run (`tests/evaluation.test.mjs`): `fetch failed` on the Owner sign-in right after the seed's long `docker compose run`, from a stale keep-alive socket. `91c4213` retries that sign-in once, as `tests/demo.test.mjs` already does.
- On `91c4213`, which changes only the evaluator and README (app and worker are as in `613ad76`):
  - `node --test evaluation/portfolio-v1/core.test.mjs` passed 15/15.
  - `tests/evaluation.test.mjs` passed 5/5 twice in a row. This includes the 30-case fixture run, refusal without corpus approval, refusal against a test-mode stack, and checksum tampering.
  - A full suite was not rerun.
- Focused runs on the `613ad76` build:
  - `tests/actions.test.mjs` 8/8, including JSON-special credentials and provider keys blocked before transfer, and unreadable credentials failing closed.
  - `tests/traces.test.mjs` 6/6.
  - `tests/memory.test.mjs` 22/22, including the extraction-refusal race.
  - `tests/demo.test.mjs` 5/5. One earlier run of this file after the traces and memory files failed its browser journey; the cause was not captured, and both full suites passed that test.
- `npm run typecheck` passed.

## Not yet established

- No connected evaluation has run. It needs these, in order:
  1. The user's corpus approval bound to the SHA-256 of `cases.v1.json`.
  2. Real `DEEPSEEK_API_KEY` and `TYPESAFE_API_KEY` in the worker, run with `compose.connected.yaml` (and `DASHSCOPE_API_KEY` for the Qwen fallback leg).
  3. Valid per-case LLM judge outputs.
  4. Human reviews bound to that run's output digest.
- No real quality, routing, retrieval, warm p95 latency (≤ 20 s) or run cost (≤ USD 1) evidence exists.
- The finalizer verifies the report's SHA-256 sidecar, the sanitized observations and the recorded public-trace provider evidence before it applies reviews.
