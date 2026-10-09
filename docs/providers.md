# Providers (connected generation)

Connected agents generate with DeepSeek at `https://api.deepseek.com` (an agent may also select a Qwen model directly, under Qwen's permission), and may name one Qwen fallback at exactly `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`. Both use `POST …/chat/completions` in JSON mode. Qwen is sent `enable_thinking: false`, because its JSON mode does not support thinking.

**Keys.** Set `DEEPSEEK_API_KEY` and `DASHSCOPE_API_KEY` (a Singapore/International Model Studio key) in `.env`. Only the worker receives them, and each is sent only to its own endpoint. No key value appears in the app container, API responses, configuration, prompts, attempt rows or logs. Before every generation, decision and extraction call, the worker checks the exact payload (each string, raw and once more JSON-escaped) for the Business's active action credentials and every provider key it holds, and refuses the call if one is present. Without a key, a connected agent is unavailable: the turn fails visibly to support and nothing is sent. Simulation is unaffected.

**Egress.** The default launch keeps the worker on the internal network with no outbound access, so real calls need the connected overlay:

```sh
docker compose -f compose.yaml -f compose.connected.yaml up -d --wait
```

Never combine it with `compose.test.yaml`; the tests prove the worker runs without egress.

**Permissions.** Nothing is sent to a provider unless an Owner currently allows it for that Business and operation (**Team and website → Cloud providers**, or the API). Support Members and other Businesses get `404`.
- `GET /api/businesses/:id/provider-permissions`: every `{provider, operation, allowed, revision, updated_at}` pair (off until allowed), `providers`, the worker's endpoint/key readiness, and `selected`: the latest published version's mode and each agent's `model` and `fallback` (what new conversations use).
- `POST /api/businesses/:id/provider-permissions/:provider/:operation` `{ "allowed": true | false }`, for `deepseek` or `qwen` with `generation` or `extraction`, or `jev` with `decision` (see Decisions). Other pairs are `404`.

Like action controls, permissions are live and override pinned configuration versions. The worker checks the provider's permission before each attempt, and checks that it is unchanged before accepting the output and before delivering the reply. Every change bumps the revision, so revoking (even if allowed again at once) discards output already in flight. The same recheck runs again just before delivery, as defense in depth. An agent's output also cannot travel to a later provider call once its own provider's permission changed.

**Fallback.** A transient failure (timeout, connection error, 429 or 5xx) gets exactly one more attempt. With a `fallback`, that attempt goes to Qwen, if Qwen generation is allowed and its key is set; otherwise the turn hands off and nothing is sent to Qwen. Without a `fallback`, the same model is retried once. There is never a third attempt or provider. Both attempts count toward the 3 agent calls and the 60-second deadline. These are not retried and hand off at once: authentication or authorization failures (401/403), other 4xx errors, non-JSON or truncated output (`finish_reason` other than `stop`), and output outside the agent contract. A blank reply counts as transient, since DeepSeek documents that JSON mode occasionally returns empty content; this also applies to memory extraction. Every agent request ends with a short closing instruction after all data ("Answer now with the one JSON object described in your instructions."), because without it DeepSeek's JSON mode often returned blank replies. Replies are delivered only when the whole turn finishes, so a fallback never follows partly delivered text.

**Processing scope.** Qwen's endpoint is Singapore for access and static storage. Inference may run anywhere in the world except Chinese mainland, so this is not Singapore-only processing. Readiness and the Cloud providers view say so.

**Readiness and measurements.** `GET /health/ready` reports the `mode` (`local`, `test` or `hosted`; in `test` the fixture may answer as the providers) and `generation`: simulation, and for each provider its endpoint, role and whether its key is configured. A configured key is reported as needing `compose.connected.yaml` for outbound calls, and as "account and model access not verified until a measured run", never as available. Each provider attempt records, value-free:
- provider/model and operation;
- whether it was the fallback;
- status and error;
- timing;
- the model the provider reports serving;
- prompt and completion tokens;
- its `payload_check` (see Preview chat and execution traces);
- an estimated cost.

The worker logs one redacted line per attempt with the same data. Cost uses optional `PROVIDER_RATES`, JSON such as `{"deepseek/deepseek-flash":[0.5,2]}` (USD per million input and output tokens, keyed by the served model). Without a rate, no cost is estimated. The Owner trace view arrives with #27.
