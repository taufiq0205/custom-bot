# Issue #36 validation

The evaluation harness uses the seeded Northwind Kettles Business through public Owner and Customer APIs. The cases, expected passage fingerprints, fixture replies, pricing snapshot, judge prompt and schema are versioned and checksum-verified. Review them in [`evaluation/portfolio-v1/corpus-review.md`](../evaluation/portfolio-v1/corpus-review.md).

The latest isolated fixture run is [Markdown](../evaluation/portfolio-v1/results/issue36-fixture-2026-10-08T16-35-36-193Z-64f7debe.md), [JSON](../evaluation/portfolio-v1/results/issue36-fixture-2026-10-08T16-35-36-193Z-64f7debe.json) and its [SHA-256 sidecar](../evaluation/portfolio-v1/results/issue36-fixture-2026-10-08T16-35-36-193Z-64f7debe.json.sha256). It recorded all 30 cases. All deterministic assertions passed; baseline configuration, demo memory and all three temporary sources were restored successfully. The report remains `pending-review`: human verdicts, real LLM judge verdicts and connected provider evidence are intentionally absent. Fixture mode verifies the harness and seeded API path; it makes no live model quality claim.

An earlier full fixture attempt (`issue36-fixture-2026-10-08T16-06-07-278Z-f6333f56`) exposed six harness expectation/setup failures in foreign-order isolation, route fixtures, tracking-source grounding and extraction sequencing. Those were corrected; the later complete run passed 30/30 deterministic checks. Intermediate development reports are omitted from the repository.

Validation recorded before the full application suite:

- `npm run typecheck` passed.
- `node --test evaluation/portfolio-v1/core.test.mjs` passed 12/12 evaluator tests, including review finalization plumbing that deliberately stays pending without LLM verdicts and refuses missing provider transport evidence.
- `node --test tests/evaluation.test.mjs` passed 4/4, including a public-API 30-case fixture run, cleanup assertions, CLI refusal to finalize fixture results, saved-report checksum tampering, connected-mode refusal without corpus approval, and credential/injection exposure failures.
- `node --test tests/traces.test.mjs` passed 6/6 in the isolated stack.
- Full `npm test` is the remaining code validation after the implementation commit.

No connected evaluation has run. It requires a human-approved corpus digest, real provider configuration, valid per-case LLM judge outputs and human reviews bound to that run's output digest. The finalizer verifies the report's SHA-256 sidecar, sanitized observations and recorded public-trace provider evidence before applying reviews. These fixture reports validate evaluator plumbing only; they do not establish portfolio answer quality.
