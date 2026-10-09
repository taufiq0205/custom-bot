# Workflow execution

Each Customer message in an `automated` conversation is one turn. The worker runs the conversation's pinned published workflow from its `entry`:

| Step | Behaviour |
| --- | --- |
| `retrieval` | Retrieves the three passages most similar to the Customer's message from each of the step's `sources` (see Knowledge), then continues to `next`. |
| `condition` | `yes` when the structured context field strictly equals `equals` (`true` is not `1`, and `1` equals `1.0`), otherwise `fallback`. |
| `http` | Runs the action through the central action checks (see Actions). It takes the action's input properties from the context. If a required one is missing, the turn sends one clarification built from the property `description` ("To continue, please tell me your order number.") and ends. The next message starts a new turn. A result matching `result_schema` merges its declared top-level properties into the context and goes to `success`. Undeclared properties are dropped. Anything else goes to `failure`. |
| `agent` | In `simulation` mode a final agent gives the labelled simulated reply, and other agents continue with no context. In `connected` mode the agent's model must reply with one JSON object. Intermediate agents return `{"outcome":"next","context":{…}}` (at most 20 flat text/number/boolean fields), which is never shown to the Customer. Final agents return `{"outcome":"reply","reply":"…"}`. Any agent can return `{"outcome":"unsupported"}`, which follows its `unsupported` output. Only the final agent's reply is delivered. Context reaches the model as data in a user message, never as instructions, and an agent cannot overwrite a field set by a verified HTTP result. If it tries, the turn fails. |
| `handoff` | Completes the turn and queues the conversation for support (`workflow-handoff`). |
| `decision` | Asks the selected decision engine which declared choice fits the Customer's message (see Decisions), and follows that choice's output, `uncertain` or `failure`. Adds nothing to the context. |

Limits per Customer message:
- 20 steps.
- 3 agent calls and 5 business HTTP calls. Retries count.
- A 15-second timeout per HTTP attempt, or the action's shorter `timeout_ms`. This is wall-clock time covering connection, headers and a trickled body.
- A 60-second deadline from acceptance.

A transient failure (timeout, connection error, 429 or 5xx) is retried once if budget and time remain. Other failures are not retried: 3xx (redirects are never followed), other 4xx, certificate rejection, and malformed, oversized or non-JSON results. A failed HTTP attempt follows the step's `failure` output.

Exhausting a limit, invalid agent output, a failed provider call or unavailable generation fails the turn visibly with a notice. The conversation goes to support as `automation-failure`, and no assistant text is delivered.

Before every external attempt, and again before accepting the result, the worker briefly locks the conversation. In that check it:
- requires its lease, the turn's execution generation, `automated` control and the submitting chat session to still be current;
- extends the lease to cover only that attempt.

No transaction stays open during a call. A takeover, handoff or sign-out therefore stops all later steps and discards late results. A worker crash fails the turn visibly once the lease lapses, and nothing is replayed. Each attempt is recorded value-free (step, kind, target, status, error, timing) for the Owner traces in #27.

Current limits of this slice:
- Consent and memory revalidation join the same check with #23–#24. Source deletion already does (see Knowledge).
