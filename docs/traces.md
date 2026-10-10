# Preview chat and execution traces

In **Configuration**, **▷ Preview chat** lets an Owner chat as an anonymous preview Customer:
- **Pinned version.** Each New chat pins the latest *published* version, exactly like a website conversation; the draft never runs. Every reply shows its version and whether it ran in simulation or connected mode.
- **Real execution.** Connected mode calls the real providers (with their cost) under the same permissions and checks.
- **Never in the inbox.** Preview conversations are invisible to Support. One that reaches a handoff stays paused, so start a New chat.

Under each reply is its **execution trace**:
- **What it shows:** the steps the turn ran, in order, with type, status, route taken and timing. Each provider or HTTP attempt shows its target, status, reason, served model, tokens, cost estimate and whether it was the Qwen fallback.
- **Safe references only:** evidence by source, document and page; decision choice and probability; lookup result and context field *names*; citations.
- **Never shown:** prompts, messages, passage text, field values, inputs, Customer identities or secrets.
- **Turn outcome:** it comes from the job, not from the last step. A step left unfinished by a worker stop shows as `interrupted`.

**Recent conversations** in the same panel opens the trace of any recent Customer or preview conversation.

Selecting a trace step only navigates; nothing in the draft changes:
- **Canvas:** it selects the step's node.
- **JSON view:** it selects the step's ID in the text. If the draft JSON is invalid, it finds the ID by text search and says so.
- **Not in the draft:** a step that ran in an older version but is missing from the draft, or has another type there, is labelled that way and is not located.
- **Version:** every status line names the version that actually ran.

APIs (Owner of the Business only; Support, other Businesses and demoted Owners get `404`):
- `POST /api/businesses/:id/preview` `{}`: `201 {conversation}`, pinned to the latest published version (`configuration_version`, `mode`).
- `GET /api/businesses/:id/preview/:conversationId`: the preview conversation and its messages.
- `POST /api/businesses/:id/preview/:conversationId/messages` `{ "client_submission_id", "text" }`: `202`. A retried submission returns the original (`200`); the same ID with other text gets `409`.
- `GET /api/businesses/:id/traces`: the 50 most recent conversations with messages, each with `preview`, `configuration_version` and `mode`.
- `GET /api/businesses/:id/traces/:conversationId`:
  - the pinned `configuration_version`, `mode` and `published_at`;
  - per turn, the job's `status` and `error`;
  - its `steps`: `ordinal`, `step_id`, `type`, `status`, `output`, `error`, `detail`, and the start and finish times;
  - its `attempts`, each linked to its step by `step_ordinal`, including its memory extraction's (also listed under `extractions`). Every provider attempt that could transfer data has a value-free `payload_check`: `checked`, the active `credential_refs` and configured `provider_keys` it was compared against, and whether a credential or provider key was found (`credential_exposed`, `provider_key_exposed`). A payload holding either is refused before transfer, and so is one whose credentials cannot be read.
