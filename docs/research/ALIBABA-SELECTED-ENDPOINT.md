# Selected Qwen Cloud API endpoint

Final operator selection, 2026-10-01: **`https://dashscope-intl.aliyuncs.com/compatible-mode/v1`**. This exact endpoint supersedes the earlier Global preference and regional/workspace discussion. [ALIBABA-GLOBAL.md](ALIBABA-GLOBAL.md) is informational exploration; [ALIBABA-SINGAPORE.md](ALIBABA-SINGAPORE.md) supplies detailed API comparison. No account, region, workspace or provider infrastructure provisioning is requested.

## Selected configuration

| Setting | Value |
|---|---|
| Qwen Cloud API base | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` |
| Reply/memory extraction fallback candidate | `qwen3.7-plus-2026-05-26` |
| Text vector candidate | `text-embedding-v4`, `dimensions: 1024` |
| Authentication | Bearer API key supplied later through server-side environment variable `DASHSCOPE_API_KEY` |

Alibaba documents this base as **Singapore** with **International** inference scope, not Global. Singapore is the access/static-storage region; International inference can occur worldwide excluding Chinese mainland. The exact endpoint does not guarantee Singapore-only processing. Existing DashScope domains remain functional. A key must match the Singapore region and applicable API billing plan; no key/account access was inspected. [Base URL documentation](https://www.alibabacloud.com/help/en/model-studio/base-url), [Regions and scopes](https://www.alibabacloud.com/help/en/model-studio/regions/), [International scope definition](https://www.alibabacloud.com/help/en/model-studio/video-generate-edit-model/)

## Documented contracts

Generation uses `POST {base}/chat/completions` with `model/messages`, returning `choices[].message.content` or streaming SSE. The Singapore inventory lists the pinned `qwen3.7-plus-2026-05-26` snapshot. The Plus family supports function calls and documented JSON Schema output; validate the chosen account/model, completed output, tool arguments and authorization before use. [Chat API](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions), [Singapore inventory](https://www.alibabacloud.com/help/en/model-studio/model-pricing), [Structured output](https://www.alibabacloud.com/help/en/model-studio/qwen-structured-output)

Embedding uses `POST {base}/embeddings`, independently of reply fallback. `text-embedding-v4` is documented for Singapore International; its default dimension is 1024, maximum batch 10 inputs and maximum length 8192 tokens/input. Documentation supports endpoint migration by replacing the host while retaining compatible paths. Thus the exact existing Singapore base is the documented access route; no synthetic call has verified the operator's eventual key. [Embedding API](https://www.alibabacloud.com/help/en/model-studio/text-embedding-synchronous-api), [Base URL/host migration](https://www.alibabacloud.com/help/en/model-studio/base-url), [Regional embedding inventory](https://www.alibabacloud.com/help/en/model-studio/model-pricing)

## Application boundary and remaining proof

Keep DeepSeek primary and Qwen Cloud fallback with an explicit per-business permission check **before** transferring customer text. The API key belongs only in backend environment/secrets configuration, never browser code, logs, repository contents or configuration exports. Business configuration stores a secret reference rather than the key.

Embeddings transmit source chunks and customer search queries separately; require explicit business authorization for those data operations. Use the selected embedding model/dimension consistently for ingestion and queries, and rebuild/version the index if either changes. When credentials are absent, report unavailable or use clearly identified simulations; documentation is not measured inference.

This artifact records the explicit endpoint and documented candidate capabilities. No provider API call, model installation, account inspection, provisioning or quality/latency test occurred. Validate the supplied key, candidate model IDs, extraction/reply quality, embedding vectors/limits, timeouts and permission boundaries before live-pilot approval. Exact endpoint choice is final; embedding candidate acceptance remains a human retrieval decision if not already made.
