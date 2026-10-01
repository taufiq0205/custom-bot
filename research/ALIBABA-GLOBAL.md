# Alibaba Global Qwen fallback and embedding boundary

Reviewed 2026-10-01 for [Verify Alibaba Global Qwen fallback and embedding integration](https://github.com/taufiq0205/custom-bot/issues/10). Supersedes the Singapore recommendation after the operator explicitly chose **Global** deployment. [ALIBABA-SINGAPORE.md](ALIBABA-SINGAPORE.md) remains historical comparison, not the selected endpoint. Documentation only: no account inspection, authenticated calls, installation or runtime testing.

## Global configuration

Create/select a workspace whose service deployment scope is **Global**, in one of these documented regions. Use its actual API Host and same-region/workspace pay-as-you-go key. Appending `/chat/completions` to the OpenAI-compatible base invokes generation.

| Access/static-storage region | Region ID | OpenAI-compatible base |
|---|---|---|
| Japan (Tokyo) | `ap-northeast-1` | `https://{WorkspaceId}.ap-northeast-1.maas.aliyuncs.com/compatible-mode/v1` |
| China (Hong Kong) | `cn-hongkong` | `https://{WorkspaceId}.cn-hongkong.maas.aliyuncs.com/compatible-mode/v1` |
| Germany (Frankfurt) | `eu-central-1` | `https://{WorkspaceId}.eu-central-1.maas.aliyuncs.com/compatible-mode/v1` |
| US (Virginia) | `us-east-1` | `https://{WorkspaceId}.us-east-1.maas.aliyuncs.com/compatible-mode/v1` |

Singapore is International-only; its `dashscope-intl` base is not a Global endpoint. Region controls static storage; Global scope permits worldwide inference. Choosing Tokyo/Hong Kong does not bound processing to that location or exclude Chinese mainland. The storage region remains a human choice. [Regions](https://www.alibabacloud.com/help/en/model-studio/regions/), [Base URLs](https://www.alibabacloud.com/help/en/model-studio/base-url), [Scope definitions](https://www.alibabacloud.com/help/en/model-studio/video-generate-edit-model/)

Regional API keys cannot cross regions. Dedicated hosts require the matching workspace key. Keep credentials server-side; Coding/Token Plans are for interactive coding tools, not backend services. [Key requirements](https://www.alibabacloud.com/help/en/model-studio/get-api-key), [Plan/base pairing](https://www.alibabacloud.com/help/en/model-studio/base-url)

## Documented Global generation

The official inventory explicitly lists **`qwen3.7-plus-2026-05-26`** under **Global** in all four regions above. Retain it as a configurable evaluation candidate for DeepSeek-primary/Qwen-fallback replies and memory extraction; this is inventory evidence, not proof that the operator's account can call it. Global alternatives include the newer Max/Flash families, but adding providers/models is unnecessary before measuring the candidate. [Region/scope/model inventory](https://www.alibabacloud.com/help/en/model-studio/model-pricing)

Qwen3.7-Plus supports text generation, function calls and documented JSON Schema output. Keep `model/messages`, provider-specific options, returned model/usage, completion status and failures explicit. Validate generated values/tool arguments and business authorization. Do not copy DeepSeek-only options or treat schema validity as factual accuracy. [Generation capabilities](https://www.alibabacloud.com/help/en/model-studio/text-generation-model), [Structured output](https://www.alibabacloud.com/help/en/model-studio/qwen-structured-output), [Chat contract](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions)

## Global embeddings are not established

The inspected embedding API lists Singapore, Beijing and Hong Kong. Pricing and rate-limit tables label Singapore vectors **International** and Hong Kong `text-embedding-v4` as **Hong Kong**, not Global. No documented Global embedding model was established for Tokyo, Frankfurt, Virginia or a Hong Kong Global workspace. Do **not** transfer the earlier `text-embedding-v4`/1024 Singapore recommendation into Global configuration as if compatibility were verified. This is an absence in inspected documentation, not proof that no Global embedding service can exist. [Embedding API](https://www.alibabacloud.com/help/en/model-studio/text-embedding-synchronous-api), [Embedding region/scope rate limits](https://www.alibabacloud.com/help/en/model-studio/rate-limit), [Inventory](https://www.alibabacloud.com/help/en/model-studio/model-pricing)

Exact remaining gate: in the chosen **Global workspace**, inspect Model Plaza for authorized embedding IDs and scope, or use its authenticated model-discovery API if supported; then verify `/embeddings` with a synthetic input, vector dimension and declared processing scope. No discovery/API call was performed here. An embedding choice requires either that proof, separately authorized regional embedding configuration, or local/lexical retrieval. Retrieval is a separate decision from Qwen generation fallback.

## Integration and acceptance

Reuse the server-side chat transport with configurable Qwen Global base/key/model. Keep the existing decision engines and retrieval separate. Explicit per-business permission gates local-to-cloud and DeepSeek-to-Qwen fallback before transferring text. Source documents and search queries sent for embeddings need authorization for that operation too.

Before live pilot, verify the chosen region/Global workspace, key permissions, model IDs, generation/extraction/tool behavior, customer-language quality, timeouts/rate limits, provider audit trails and fallback permissions. Account/model access, retrieval choice and measured gates remain open; documentation claims establish neither model quality nor residency-only behavior.
