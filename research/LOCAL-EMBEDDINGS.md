# Local embeddings for the English-only pilot

Reviewed 2026-10-02. Research for [issue #11](https://github.com/taufiq0205/custom-bot/issues/11). The user's English-only pilot supersedes the initial multilingual comparison. These are deployment candidates, not an accepted model choice or measured results. No packages, weights, or runtime APIs were exercised.

## Recommendation

Start with **`BAAI/bge-small-en-v1.5`**, using the existing Python worker, Sentence Transformers, PyTorch FP32 and explicit CPU execution. It fits the English retrieval task with a small downloadable model. Compare `intfloat/e5-small-v2` only if the retrieval pilot exposes misses; both have essentially the same footprint. BGE's publisher reports English MTEB retrieval evidence, but this does not establish accuracy on our customer knowledge base or speed on this Mac. [BGE model card](https://huggingface.co/BAAI/bge-small-en-v1.5), [E5 model card](https://huggingface.co/intfloat/e5-small-v2).

## Small shortlist

Weight sizes below are decimal GB/MB, not total process RAM or container size. Rounded parameter estimates marked `~` follow weight size divided by four bytes for FP32; Qwen's 0.6B is publisher specified.

| Model | Scope / license | Parameters | Dimensions / maximum input | Published primary weight artifact | FP32 weight memory estimate |
|---|---|---:|---|---|---:|
| BGE-small-en-v1.5 | English / MIT | ~33M | 384 / 512 tokens | 133MB safetensors | ~0.13GB |
| E5-small-v2 | English / MIT | 33.4M | 384 / 512 tokens | 133MB safetensors | ~0.13GB |
| multilingual-e5-small | 100 languages / MIT | ~118M | 384 / 512 tokens | 471MB safetensors | ~0.47GB |
| multilingual-e5-base | 100 languages / MIT | ~278M | 768 / 512 tokens | 1.11GB safetensors | ~1.11GB |
| Qwen3-Embedding-0.6B | 100+ languages / Apache-2.0 | 0.6B | 32–1024 / 32K tokens | 1.19GB BF16 safetensors | ~2.4GB if loaded FP32 |
| BGE-M3 | 100+ languages / MIT | ~567M | 1024 / 8192 tokens | 2.27GB FP32 pytorch_model.bin; no safetensors at inspected upstream root | ~2.27GB |

Sources: publisher [BGE files](https://huggingface.co/BAAI/bge-small-en-v1.5/tree/main), [E5 files](https://huggingface.co/intfloat/e5-small-v2/tree/main); multilingual E5 [small card](https://huggingface.co/intfloat/multilingual-e5-small), [small files](https://huggingface.co/intfloat/multilingual-e5-small/tree/main), [base card](https://huggingface.co/intfloat/multilingual-e5-base), [base files](https://huggingface.co/intfloat/multilingual-e5-base/tree/main); [Qwen card](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B), [Qwen files](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/tree/main); [BGE-M3 card](https://huggingface.co/BAAI/bge-m3), [BGE-M3 files](https://huggingface.co/BAAI/bge-m3/tree/main), [Sentence Transformers model benchmarks](https://www.sbert.net/docs/sentence_transformer/usage/efficiency.html).

Multilingual E5 is a later low-footprint multilingual option, not needed for English-only. Qwen is a conditional quality/long-context candidate if measured retrieval needs justify substantially larger weights; its requirements include Transformers >=4.51.0 and Sentence Transformers >=2.7.0. BGE-M3's sparse/multivector capabilities add no demonstrated value to our initial dense retrieval. Publisher multilingual benchmarks and English benchmarks use different corpora; do not treat their scores as a customer-service ranking. [Qwen card](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B), [E5 technical report](https://arxiv.org/html/2402.05672v1), [BGE-M3 card](https://huggingface.co/BAAI/bge-m3).

## Retrieval contract

- BGE: prepend the publisher's retrieval instruction to short queries; passages remain plain. Use normalized embeddings and cosine/dot-product consistently. The model supports omission of instructions, but choose and freeze one policy after evaluation. [BGE usage](https://huggingface.co/BAAI/bge-small-en-v1.5).
- E5 variants: apply `query: ` and `passage: ` respectively, including non-English inputs for multilingual E5; normalize. Missing prefixes degrade retrieval. English E5-small-v2 truncates beyond 512 tokens. [English E5](https://huggingface.co/intfloat/e5-small-v2), [multilingual E5](https://huggingface.co/intfloat/multilingual-e5-small).
- Qwen: instructions apply to queries, documents remain unprefixed; its Sentence Transformers `query` prompt can supply the task instruction. Fix the selected dimension, rather than varying it per request. [Qwen usage](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B), [packaged prompts](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/blob/main/config_sentence_transformers.json).

Proposed initial chunk budget: roughly 300–400 model tokens, leaving room for prefixes and special tokens within 512. This is an implementation starting point to evaluate, not a model guarantee. Measure tokenizer counts, never assume words equal tokens. Similarity scores are rankings, not calibrated answer confidence; derive any abstention threshold from labeled negatives. [BGE score guidance](https://huggingface.co/BAAI/bge-small-en-v1.5), [E5 score guidance](https://huggingface.co/intfloat/e5-small-v2).

## Mac, offline operation, and storage

Keep one model loaded in the existing worker; retain PostgreSQL vector storage. No TEI service, FlagEmbedding, LangChain, additional vector database, ONNX conversion, or quantization is necessary for the first proof. Sentence Transformers defaults to PyTorch FP32 and supports explicit CPU selection. Published efficiency timings use other hardware/datasets, not this arm64 Mac. ARM64 package/image compatibility and total memory remain build/run proof gates. [Official efficiency docs](https://www.sbert.net/docs/sentence_transformer/usage/efficiency.html), [installation docs](https://sbert.net/docs/installation.html).

CPU is the portable Linux-container path. Native macOS MPS is a separate optional host-worker optimization: Apple documents Apple Silicon/macOS prerequisites and a runtime availability check; it does not demonstrate acceleration inside our Linux Docker worker. Do not assume CUDA or MPS availability from the Mac host alone. [Apple PyTorch guidance](https://developer.apple.com/metal/pytorch/), [Laya's documented Docker platform distinction](https://github.com/NandhaKishorM/laya/blob/main/docs/docker-platforms.md).

The table estimates **weights only**. Actual RSS also includes framework, tokenizer, activations, batches and temporary loading buffers; PostgreSQL and Docker consume additional host RAM. BF16 disk size does not guarantee BF16 CPU execution or speed. Download only one chosen weight format plus required tokenizer/config/pooling files; repository totals include duplicate weights and optional exports. BGE's first weight-plus-tokenizer bundle is approximately 135MB, excluding Python/container dependencies. [BGE files](https://huggingface.co/BAAI/bge-small-en-v1.5/tree/main).

Pin a full upstream commit, dependency versions, model ID, dimensions, prompt policy, tokenizer/chunk policy and normalization in the index metadata. Pre-cache all required files in a persistent volume during provisioning. Hugging Face supports revision-pinned downloads and cache-only `HF_HUB_OFFLINE=1`; disable telemetry and prove restart/query success with outbound network denied. Missing cache files must fail clearly. Model/dimension/prompt changes require a new index and re-embedding both sources and queries; even equal dimensions do not make two model spaces interchangeable. [Download/cache docs](https://huggingface.co/docs/huggingface_hub/en/guides/download), [offline/telemetry variables](https://huggingface.co/docs/huggingface_hub/en/package_reference/environment_variables).

Local inference keeps embedding source text and queries on the host. It does **not** make the chatbot entirely local: retrieved passages sent to DeepSeek or authorized Qwen generation still leave the host. Business-scoped cloud permission remains required; embeddings must not silently fall back to cloud. Tenant filtering and access control belong to the storage/retrieval layer, not the embedding model.

## Proof before adoption

Use labeled English questions, paraphrases, typos, confusing near-matches and unanswerable questions against two synthetic businesses. Compare BGE and E5 with the same corpus/chunks; record Recall@5/MRR and false-positive abstention behavior. Require zero cross-business retrieval and tune thresholds on held-out negatives. Final numeric quality/latency acceptance belongs to the pilot decision, not publisher benchmarks.

On the actual Mac/container record architecture, explicit CPU device, cold/warm latency, peak RSS, batch size and index build duration; test persistent cache/index restart without network. Reuse the existing end-to-end grounding and handoff gates after retrieval passes. No observed Mac performance, corpus accuracy, offline behavior, or compatible installed dependencies is claimed by this research.
