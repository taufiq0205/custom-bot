# Configuration (JSON)

Each Business has one shared configuration draft and a series of immutable published versions. Owners select **Manage**, edit **Configuration JSON**, then **Save draft** or **Publish**. Support Operators and other Businesses get no editor and `404` from the API.

- `GET /api/businesses/:id/configuration`: `{text, revision, base_version, published_version, updated_at, validation}`.
- `POST /api/businesses/:id/configuration` `{ "text": "raw JSON text", "revision": "expected revision" }` saves the text verbatim, even when it is invalid, and returns the new `revision` and `validation`. Text may be at most 262,144 characters, without NUL or unpaired surrogates.
- `POST /api/businesses/:id/configuration/publish` `{ "revision": "expected revision" }` publishes the *saved* draft at that revision. It returns `201 {version, revision}`, or `422 {validation}` when the draft has problems.
- `GET /api/businesses/:id/configuration/versions/:version` returns that immutable published `document`.

`validation` is `{json_valid, errors, blockers}`. Every entry is located: a parse error gives `line`/`column`, and other entries give a JSON Pointer `path` such as `/workflow/steps/2/position/x`.

- **Errors** cover unparseable JSON, duplicate object keys, out-of-range numbers, unknown fields, wrong types, duplicate IDs or connections, dangling references, non-finite positions (for example `1e999`) and malformed action schemas. They also cover write methods, non-HTTPS or IP/localhost destinations, URLs with credentials, and missing credential or authorization-policy references.
- **Blockers** cover a `null` entry and unconnected required outputs. The draft stays saved and editable, but it cannot be published.

Both kinds block publication. Only published versions ever execute.

A stale `revision` returns `409` with the `latest` draft and saves nothing. The editor keeps your local text, and reloading asks before discarding it. Publication also advances the draft revision, so two Owners publishing the same revision create exactly one version. A version is `max(version)+1`, created in the same transaction under the Business lock. The highest version is the current entry workflow for new conversations. Existing conversations keep the version they started with.

Schema version 1. Top-level fields:
- `schema_version`: `1`.
- `generation`: `{mode: "simulation" | "connected"}`.
- optional `decision`: `{engine: "jev" | "laya" | "von", model?}`, the one engine every `decision` step uses (required once a workflow has one). Jev's model defaults to `jev-latest`; Laya and Von arrive with #30 (see Decisions).
- optional `sources`: `[{id, priority: 1–1000}]`. A source `id` names the Knowledge source uploaded under that ID. When passages conflict, the lower priority number takes precedence.
- `agents`: `[{id, name, instructions, sources?, actions?, model?: {provider: "deepseek" | "qwen", name, temperature?: 0–2, max_tokens?: 1–8192, fallback?: {provider: "qwen", name}}}]`. Only a DeepSeek model may name a fallback (see Providers). Model names are free choices; the evaluated candidates are `deepseek-flash` (which DeepSeek serves with DeepSeek-V4.1-Flash) and `qwen3.7-plus-2026-05-26`.
- `actions`: `[{id, method: "GET", url, input_schema, result_schema, credential, authorization, timeout_ms: 1–15000}]`. `credential` and `authorization` are references, never secret values. Schemas use a JSON Schema subset: `type`, `properties`, `required`, `items` and `description`.
- `workflow`: `{entry, steps, connections}`.

Every step has `id`, `type` and a finite `position {x, y}`. The step types and the outputs each must connect:

| Type | Fields | Outputs |
| --- | --- | --- |
| `retrieval` | `sources` | `next` |
| `condition` | `field`, `equals` | `yes`, `fallback` |
| `http` | `action` | `success`, `failure` |
| `agent` | `agent`, `final` | final agents: `unsupported`; others: `next`, `unsupported` |
| `handoff` | none | none |
| `decision` | `question` (1–2000 characters), `choices` (2–20 `{name: description}`; names like field names, not `uncertain` or `failure`), `min_probability` (0–1) | each choice name, `uncertain`, `failure` |

Connections are `{from, output, to}`, and `to` may be `null` in a draft.

New Businesses start with a publishable simulation draft: one agent with its `unsupported` output connected to a handoff. Businesses created before this slice keep their original version 1, whose single agent lacks that connection. Their draft therefore shows one blocker until a handoff is connected.
