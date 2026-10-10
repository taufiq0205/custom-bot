# Alibaba Singapore Qwen fallback and embeddings

Final selection: [ALIBABA-SELECTED-ENDPOINT.md](ALIBABA-SELECTED-ENDPOINT.md) records the exact Qwen Cloud endpoint chosen by the operator and supersedes earlier endpoint recommendations. This file is informational comparison.


Historical comparison: the operator subsequently chose Global deployment. [ALIBABA-GLOBAL.md](ALIBABA-GLOBAL.md) supersedes this Singapore endpoint/embedding recommendation.

Reviewed 2026-10-01 for [Verify Alibaba Singapore Qwen fallback and embedding integration](https://github.com/taufiq0205/custom-bot/issues/10). Primary official documentation only; no account inspection, authenticated API calls, installations, model tests, pricing comparison, or legal review. Earlier four-provider findings remain in [PROVIDER-INTEGRATIONS.md](PROVIDER-INTEGRATIONS.md).

## Region is not inference scope

Current documentation, updated September 28, distinguishes **region** (access point/static storage) from **service deployment scope** (inference location). Singapore (`ap-southeast-1`) supports **International** only. Global is a separate scope available in other regions/workspaces. Requests enter and return through the chosen region, while inference runs in that scope. Therefore, “global endpoint (Singapore)” should be recorded as **Singapore access/storage with International inference**, unless the operator explicitly chooses another region's Global scope. [Regions and endpoints](https://www.alibabacloud.com/help/en/model-studio/regions/)

Alibaba defines International inference as worldwide **excluding Chinese mainland**, with static storage in the selected region; Global inference is worldwide. Singapore does **not** promise Singapore-only computation. The scope description is also explicit in Alibaba's deployment documentation for its video models; the general region guide confirms that the scope determines inference placement. These documentation statements do not establish contractual retention guarantees or measured processing locations. [Deployment scope definitions](https://www.alibabacloud.com/help/en/model-studio/use-video-generation/), [Region guide](https://www.alibabacloud.com/help/en/model-studio/regions/)

## Access and configuration

| Setting | Documented value |
|---|---|
| Existing Singapore OpenAI-compatible base | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` |
| Recommended new production base | `https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` |
| Text generation | `POST {base}/chat/completions` |
| Text vectors | `POST {base}/embeddings` |
| Authentication | `Authorization: Bearer <Singapore Model Studio API key>`; keep `DASHSCOPE_API_KEY` server-side |

The existing DashScope domain remains available; the workspace-dedicated domain is recommended for production. Obtain the actual API Host from the console rather than inventing a workspace ID. It requires a key belonging to that workspace; region-specific keys/model lists cannot be used across regions. Use a pay-as-you-go key/base pair: Coding Plan and Token Plan endpoints are for interactive coding tools, not backend services. [Base URLs](https://www.alibabacloud.com/help/en/model-studio/base-url), [Key creation](https://www.alibabacloud.com/help/en/model-studio/get-api-key)

Activate Model Studio for Singapore using an Alibaba account or an appropriately permitted RAM identity; service activation is per region. Actual access, model authorization, account completion and billing remain unverified. [Activation FAQ](https://www.alibabacloud.com/help/en/model-studio/faq-about-alibaba-cloud-model-studio)

## Generation recommendation

Keep DeepSeek as the primary generator and configure Qwen as the authorized fallback. A conservative proposed Qwen ID is **`qwen3.7-plus-2026-05-26`**, a listed Singapore International snapshot; its moving alias `qwen3.7-plus` is also documented. Alibaba recommends the Plus family for chatbots and document processing. This is a candidate for evaluation, not an established quality winner. [Singapore inventory](https://www.alibabacloud.com/help/en/model-studio/model-pricing), [Text-generation guidance](https://www.alibabacloud.com/help/en/model-studio/text-generation-model)

Qwen accepts `model` plus conversational `messages`, returns generated text through `choices[].message.content`, and supports SSE streaming and function tools. Tool requests return `tool_calls`; Qwen does not guarantee `tool_choice=required` in non-thinking mode and does not support it in thinking mode. Validate arguments and authorization in application code. [Chat API](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions)

For memory extraction, `response_format={"type":"json_object"}` requires a JSON instruction and does not guarantee field names/types. The detailed supported-model list includes Qwen3.7-Plus for `json_schema` with `strict:true`; test the chosen snapshot/account. The same structured-output page contains an older summary saying only selected Plus models and a broader detailed list, so rely on actual endpoint validation before claiming capability. Schema compliance does not prove factual accuracy or safe memory contents. [Structured output](https://www.alibabacloud.com/help/en/model-studio/qwen-structured-output)

## Retrieval recommendation

Singapore explicitly offers **`text-embedding-v4`**, **`qwen3.7-text-embedding`**, and `text-embedding-v3`. Proposed first-pilot choice: configurable **`text-embedding-v4` with 1024 dimensions**, a documented default. It supports up to 10 inputs/request and 8192 tokens/input; other dimensions range from 64 to 2048, and 100+ languages are documented. The newer `qwen3.7-text-embedding` offers default 1024 dimensions, up to 20 rows and 128000 tokens/row; it is an alternative, not a necessary dependency for short chunks. [Embedding API and Singapore model table](https://www.alibabacloud.com/help/en/model-studio/text-embedding-synchronous-api)

Use the same selected embedding model/dimensions for source chunks and queries. Store model, dimensions and index version; changing them requires a separate/rebuilt index. Cloud embeddings send source text and search queries to Alibaba independently of generation fallback. Explicit business authorization must cover that operation too; permitting Qwen generation fallback alone should not implicitly authorize all document/query embedding transfers. This is a recommended application policy.

## Smallest integration and proof boundary

Reuse the server-side OpenAI-compatible generation transport with separate provider base/key/model and capability settings; do not forward DeepSeek-only options unchanged. Add one embedding request path rather than a new agent framework. Keep Jev/Laya/Von decision routing separate.

Gate every fallback before sending text: explicitly authorized business, permitted provider/data operation, bounded timeout/retry policy, and no duplicate external side effect. If DeepSeek and approved Qwen both fail, hand off or show a clearly identified simulation; no third provider is assumed.

Before live pilot, validate Singapore workspace/key/model access, both reply/extraction modes, embedding dimensions/limits, customer-language quality, timeout/rate-limit behavior, privacy permissions and actual provider audit traces. No latency, availability, residence-only, or quality claim follows from this documentation review. Numeric pilot gates and acceptance of corrected Singapore International terminology remain human decisions.
