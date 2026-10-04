# Issue #21: Document-grounded answers

Environment (2026-10-04):
- macOS 27.0.1 arm64 with OrbStack.
- Node 22.22.3 and Docker Compose 5.1.2.
- PostgreSQL 17 with pgvector 0.8.2 (repository-pinned image).
- Python 3.14.6 worker. New in this slice, all hash-locked in `worker/requirements.lock` (generated from `worker/requirements.in` with `uv pip compile --generate-hashes --universal`):
  - onnxruntime 1.30.0;
  - tokenizers 0.23.2;
  - pypdf 6.19.0;
  - numpy 2.5.3;
  - their transitive dependencies.
- TypeScript 7.0.2. Playwright 1.63.0 Chromium.
- Embedding model `BAAI/bge-small-en-v1.5` at commit `5c38ec7c405ec4b44b94cc5a9bb96e735b38267a`. Four files, each pinned by SHA-256 in `worker/knowledge.py`: `onnx/model.onnx`, `tokenizer.json`, `1_Pooling/config.json` and `modules.json`.

## Reproduce

Requires this project's `.env`, free loopback ports 3100/8025/3199, and locked npm dependencies. The first launch needs network access once, so the `models` service can download about 135 MB into the `models` volume. After that, nothing reaches the network: the worker runs on the internal network. No cloud credentials are used.

```sh
npm ci --ignore-scripts
npm run typecheck
docker compose -f compose.yaml -f compose.test.yaml up --build -d --wait
node --test tests/knowledge.test.mjs        # 8 tests, about 2 minutes
npm test
docker compose up -d --wait                 # leave test mode
```

## Runtime choice: the publisher's ONNX export instead of PyTorch

The research note recommended Sentence Transformers on PyTorch. The acceptance criteria fix the model, revision, tokenizer, CPU FP32 and normalization, but not the runtime. The worker instead runs the publisher's own FP32 ONNX export (`onnx/model.onnx` at the pinned commit) on onnxruntime's `CPUExecutionProvider`:
- **No conversion of our own.** The graph comes from the publisher's repository. Its inputs are `input_ids`, `attention_mask` and `token_type_ids` (int64), and its output is `last_hidden_state` (float32, 384 wide).
- **Pooling and normalization come from the pinned files.** `1_Pooling/config.json` sets `pooling_mode_cls_token: true`, and `modules.json` ends with `Normalize`. The worker takes the CLS vector and L2-normalizes it.
- **The query instruction is the publisher's.** It is `Represent this sentence for searching relevant passages: `, from the model card at that commit. Passages are encoded plain.
- **The dependencies are much smaller.** onnxruntime, tokenizers and numpy replace PyTorch, Transformers and Sentence Transformers. The worker image is 121 MB.

**Parity check (one-off, not a test dependency).** On the host, the same two queries and two passages were encoded with:
- sentence-transformers 6.1.0 (torch 2.14.1, transformers 5.18.0, CPU) at the pinned revision, with the instruction prepended and `normalize_embeddings=True`;
- the worker's `knowledge.Embedder` code.

Results: maximum absolute difference 2.98e-7, cosine similarity 1.0000 for every pair.

## Acceptance evidence (`tests/knowledge.test.mjs`)

| Criterion | Runnable evidence |
| --- | --- |
| Readable PDF, DOCX, TXT and Markdown ingest; scanned/unreadable or over-20-MB files fail without reporting success | **Ingestion** test:<br>• a 3-page PDF (one blank page), a DOCX, a BOM-prefixed TXT and a `.markdown` file each become `active` with the expected format and passage count.<br>• Seven unreadable uploads end `failed`, with no active version and a "no usable version" warning: a mostly scanned PDF (2 of 3 pages without text), a truncated PDF, text named `.pdf`, a corrupt DOCX, Latin-1 bytes named `.txt`, binary with NUL, and whitespace-only Markdown. Each has its specific error.<br>• 20 MiB + 1 byte → `413` "nothing was uploaded", and no source or version row exists.<br>• Unsupported extensions → `400`.<br>• Support, an outsider and a cross-origin request cannot list, upload or delete (`404`/`403`), and the source stays intact. |
| Pinned revision/tokenizer, CPU FP32, normalized 384-dimensional vectors, query instruction, plain passages, tokenizer-counted chunks within 512 | **Ingestion** test, inside the running worker: a long document's stored passages are re-counted with the pinned tokenizer (max ≤ 352 including `[CLS]`/`[SEP]`, and > 300, so packing works). Every vector has `vector_dims` 384 and norm 1 ± 1e-5. The version's recorded encoding names the model, revision, `float32`, 384 dimensions, CLS pooling, normalization, the instruction and `onnxruntime … CPUExecutionProvider`.<br>**Runtime** test: model files are SHA-256-checked at start; see the last row. |
| Only complete versions activate atomically; failed replacements keep the previous active version with an Operator warning | **Versions** test:<br>• a scanned replacement fails; the warning says answers still use `gifts.txt`, and retrieval still returns its text.<br>• A complete replacement serves the same conversation at once.<br>• An older candidate held for 6 s finishes after a newer upload and ends `superseded`; the newer one stays active.<br>• A worker killed during ingestion fails that candidate visibly ("interrupted … not retried"), and the previous version stays active.<br>**Browser** journey, at 1280 and 390 px: upload, active status, a failed replacement's warning beside the still-active document, delete. No horizontal scroll and no page errors. |
| Assigned eligible current sources govern each turn, even for old conversations; priorities resolve precedence; contradictions and insufficient evidence clarify or hand off | **Versions** test: a conversation pinned to version 1 gets each replacement's content without changing its `configuration_version`. After a publication assigns another source, the old conversation keeps its pinned assignment and a new conversation uses the new one.<br>**Precedence** test: two conversations on two published versions each receive their own version's priorities for the same conflicting passages. The contract states the lower number wins and that equal-priority conflicts ask or return `unsupported`, which hands off (`workflow-handoff`).<br>**Answers** test: an agent sees only passages of its own assigned sources (an unassigned retrieved source is withheld). An agent without sources gets no evidence message.<br>**Deletion** test: after deletion the same conversation's agent receives an empty evidence list, so it can only clarify or hand off. |
| Factual answers cite Business-scoped document/page references; policy evidence stays distinct from live order data; injection cannot change instructions or authority | **Answers** test: the most similar passage (PDF page 2) ranks first as `E1`. The reply's `["E1"]` is delivered as `{source: "policies", document: "refunds.pdf", page: 2}` to the Customer and in the inbox. Citing a withheld or unknown ID fails the turn with no assistant text. A second Business with the same source ID and a conflicting sentinel fact retrieves only its own passage, and neither Business sees the other's.<br>**Injection** test: a document with "ignore all previous instructions", an admin-mode claim, a `fixture-key:` routing marker, a foreign order number and a non-permitted action name:<br>• the system prompt equals the configured instructions plus the platform contract, unchanged between calls, with none of that text;<br>• the text arrives only in the evidence message, and the fixture never routed on its marker;<br>• the lookup used the Customer's own order and verified identity, and its result (`status: shipped`) appears only in the workflow context, never in evidence;<br>• a model that "obeys" by requesting `refund_all` fails the turn, and no request is sent.<br>**Browser** journey: the Customer widget shows "Sources: refunds.pdf, page 2." |
| Deletion excludes all versions immediately and defeats delayed jobs; model/encoding changes need a complete compatible index; a missing cache fails without cloud fallback | **Deletion** test:<br>• after two versions, deletion returns `200` only when no passage or stored byte of any version remains. The next turn finds no evidence, and a second delete gets `404`.<br>• Deletion during a held ingestion: the late result never activates (no sentinel passage exists), and a re-upload under the same ID starts a fresh source.<br>• Deletion while a provider holds the passages: with a final agent, the reply is not delivered (`knowledge source deleted before delivery`); with an intermediate agent, the next agent is never called (`knowledge source deleted`). Both hand off visibly.<br>**Runtime** test:<br>• an outbound connection from the worker fails (no egress); the worker restarts and answers from its cache.<br>• An empty model directory, or a copy with one changed byte in `tokenizer.json`, stops the worker at start with "missing or changed … There is no cloud embedding fallback", run with `--network none`.<br>• Marking the active version as built under another encoding excludes its passages from the next turn at once. After a worker restart, a complete new version is built from the stored document and activates; the old one ends `superseded` with its bytes erased. |

## Not established by this slice (deferred; not claimed)

- **Answer quality and abstention.** The fixture provider is scripted, so these tests prove what the platform sends, accepts and delivers, not that a real model answers, prioritizes or abstains well. The labelled retrieval corpus and the frozen abstention policy belong to #32 and #33, and real providers to #28.
- **Website sources and freshness** belong to #22.
- **Performance.** Ingestion and query latency, memory and amd64 timings were not measured here (see Results for the amd64 build).
- **Untrusted-parser isolation.** Documents are parsed in the worker process; a pathological file could stall ingestion. This is marked with a `ponytail:` comment.
- **Excerpt view.** Customers see document/page references, not the cited passage text.

## Results

To be completed after the full run.
