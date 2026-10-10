# Models and providers guide

The platform uses three kinds of model, each for a different job. Each can be set up separately.

| Job | What it does | Model and how it runs | Status |
| --- | --- | --- | --- |
| **Generation** | Writes the Customer reply, and later extracts permitted memory | DeepSeek through its API, with one authorized fallback attempt on Qwen | Planned in [#28](https://github.com/taufiq0205/custom-bot/issues/28). Today a configuration with `generation.mode: "simulation"` gives labelled simulated replies. Connected agents answer only through the test fixture. |
| **Typed decisions** | Gives structured answers such as a choice, a score or a yes/no, for workflow routing. Never Customer text or authorization. | Jev through the TypeSafe API. Laya or Von locally as alternatives. | Jev built ([#29](https://github.com/taufiq0205/custom-bot/issues/29)); Laya/Von planned in [#30](https://github.com/taufiq0205/custom-bot/issues/30) |
| **Retrieval embeddings** | Finds the document passages relevant to a Customer's message | `BAAI/bge-small-en-v1.5`, run locally in the worker on CPU | Built (#21). **Optional:** it is installed with one command. |

**Retrieval needs embeddings, and neither DeepSeek nor TypeSafe provides them.** The provider research (`docs/research/PROVIDER-INTEGRATIONS.md`) found no supported embedding endpoint in the DeepSeek or TypeSafe APIs, or in Laya and Von. The specification also forbids silently falling back to a cloud embedding. Document knowledge therefore needs the local model. Generation and decisions can use API keys alone.

## Running without the embedding model (the default)

`docker compose up --build -d --wait` no longer downloads the embedding model. Without it:
- chat, order lookups, handoff and every workflow without a `retrieval` step work as usual;
- `GET /health/ready` stays `ready` and reports `"knowledge": "knowledge unavailable: … Run docker compose run --rm models …"`;
- a document upload is accepted, then fails visibly in **Knowledge** with that reason. Any version that is already active stays in use;
- a turn that reaches a `retrieval` step fails visibly and goes to support (`knowledge unavailable: embedding model not installed`). It never answers as if no evidence existed.

## Installing the embedding model

This needs network access once, and about 135 MB in the `models` Docker volume.

```sh
docker compose run --rm models        # downloads 4 files at the pinned commit and verifies their SHA-256 hashes
docker compose restart worker         # the worker loads the model only at start
curl -s localhost:3100/health/ready   # "knowledge": "available: BAAI/bge-small-en-v1.5@5c38ec7 on CPU"
```

Then upload the documents again; uploads made while the model was missing have failed. The worker itself never needs network access: it runs on the internal Docker network and reads only the verified cache. Running `models` again re-verifies the files and downloads only missing or changed ones. Files with any changed byte count as missing.

To remove the model, delete the volume (`docker volume rm custom-bot_models` with the stack stopped). Knowledge then becomes unavailable again.

## Replacing the embedding model

Everything the worker needs is pinned at the top of `worker/knowledge.py`:
- `MODEL` and `REVISION` (a full commit hash);
- `FILES` (the path and SHA-256 of each file the worker loads);
- `INSTRUCTION` (the query prefix the model's publisher documents; passages stay plain);
- the passage size `PASSAGE_TOKENS` (counted with that model's tokenizer).

To change the model:

1. Choose a model that publishes an ONNX export, with `input_ids`/`attention_mask` (and `token_type_ids` if it uses them) inputs and a `last_hidden_state` output. Read its pooling (`1_Pooling/config.json`) and normalization (`modules.json`) and its query/passage prompts from its model card at the pinned commit.
2. Update the pins above. Update `Embedder.vectors` if the model pools differently (for example mean pooling instead of CLS) or takes different inputs.
3. If the vector size is not 384, add a migration changing `source_chunks.embedding` to `vector(N)` (and `dimensions` in the recorded encoding).
4. Check parity once against the publisher's reference implementation (Sentence Transformers), as recorded in `docs/dev-notes/validation-21.md`.
5. Install it (`docker compose run --rm models`) and restart the worker.

The recorded encoding then differs from the one stored with each version. Existing passages are excluded from answers immediately, because vectors from different models are never compared, even when their sizes match. The worker queues a complete re-index of every active document when it starts. Each document answers again once its new version is complete.

## Generation with a DeepSeek API key (#28)

Planned in [#28](https://github.com/taufiq0205/custom-bot/issues/28); nothing below is built yet. The specification fixes these points:
- **The key is read only on the server,** from `DEEPSEEK_API_KEY`. It never appears in the configuration, browser payloads, prompts, traces or logs.
- **Calls go to** `https://api.deepseek.com/chat/completions`, with an explicitly chosen model (the research found `deepseek-flash` and `deepseek-v4-pro` documented).
- **An agent selects it** with `model: {provider: "deepseek", name: …}` in the configuration, which the editor already supports.
- **Each Business must permit the transfer** before generation sends any data to the provider.
- **Fallback:** a transient DeepSeek failure allows at most one authorized Qwen attempt, at `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` with `DASHSCOPE_API_KEY`, before any text is delivered.
- **With no key**, the service gives labelled simulation or reports itself unavailable. It never claims real inference.

## Typed decisions with a Jev API key (#29)

Built in [#29](https://github.com/taufiq0205/custom-bot/issues/29); the README's Decisions section has the details.
- **Key:** `TYPESAFE_API_KEY` in `.env`, passed to the worker only. Real calls also need `compose.connected.yaml`.
- **Endpoint:** `POST https://api.typesafe.ai/v1/systemone`, with `model` (default `jev-latest`, which served `jev-1.13.0` on 2026-10-05), `state` and two questions: the step's `choice` and an English-language `noul`.
- **Configuration:** `decision: {engine: "jev", model?}` plus `decision` steps (`question`, `choices`, `min_probability`).
- **Permission:** each Business allows `jev`/`decision` separately from generation.
- **Validation:** decisions only route the workflow. Shape, choice name, probabilities, language and threshold are checked independently; anything else takes the step's `failure` route.
- **Cost:** input tokens only, USD 0.042 per million for `jev-1.13.0` (TypeSafe's published price, not measured here).

Laya and Von (#30) serve the same `/v1/systemone` shape locally, as optional containers with their own model downloads. Their confidences are not interchangeable with Jev's.

## Checklist for adding any other model

- Pin it: a full revision for local weights, an explicit model ID for an API.
- Keep keys server-side, in environment variables only.
- Check the Business's permission before sending any data to a cloud provider.
- Bound every call with a timeout. Count retries in the turn's budgets, and retry only transient failures, once.
- Validate every output before use; model output is never authorization.
- Make readiness report whether it is configured and reachable, without secrets.
- Record its attempts value-free, without prompts or results.
- Test it through the running Docker app with the controlled fixture, as the existing workflow tests do.
