# Human takeover and shared inbox

Each Business has one shared support queue. Every active Owner and Support Member selects **Open inbox** beside the Business to see it. A conversation is `automated`, `waiting-for-support`, `human-controlled` or `resolved`.

- A Customer selects **Talk to a person** (`POST /api/chat/:businessId/conversations/:id/handoff` `{}`), an automated turn fails (see Workflow execution), or the workflow reaches a handoff step. Each puts the conversation in the queue.
- An Operator can **Claim** a queued conversation. Claiming an automated conversation takes it over directly; an Operator must own a conversation before replying.
- Every control change happens in one transaction, enforced by a database trigger whichever service makes it. It increments the conversation's execution generation, stops its queued and running automated turns (their late results are discarded), and posts the Customer notice: *Waiting for support*, *Support joined*, *Automated assistant resumed* or *Conversation resolved*. No notice promises a response time.
- Customer messages sent while queued or under human control are stored with `turn_state: "human"` and never start an automated turn.
- Only the current assignee can reply, **Resolve** or **Return to automated assistant**. Any Member can reassign a queued, human-controlled or resolved conversation to an active Member.
- Resume replays nothing. The next Customer message starts the next automated turn.
- A Customer message after resolution reopens the conversation under human control with the same assignee. If that Membership has been revoked, it returns to the queue instead.
- Revoking a Membership returns that Member's human-controlled conversations to the queue.
- Available/Away is manual and shown to the team only. It never assigns, releases or resumes a conversation. Away, sign-out and restarts keep assignments, messages and the pause.

Operator inbox API (verified Operator session, same-origin):
- `GET /api/businesses/:id/inbox`: your `operator_id`, active `members` (`email`, `role`, `available`) and up to 200 conversations with messages. The queue is listed first.
- `GET /api/businesses/:id/inbox/conversations/:conversationId`: `control_state`, `assignee_id`/`assignee_email`, `handoff_reason` (`customer-request`, `operator-takeover`, `automation-failure`, `workflow-handoff`), `revision` and the full message history.
- `POST /api/businesses/:id/inbox/availability` `{ "available": boolean }`.
- `POST …/conversations/:conversationId/claim|resolve|resume` `{ "revision": "…" }`; `…/reassign` `{ "revision", "operator_id" }`; `…/messages` `{ "revision", "client_submission_id", "text" }`.

`revision` changes whenever control or the assignee changes. Customer messages and replies do not change it. A stale revision, or an action by anyone but the assignee, returns `409` and changes nothing. All checks run under the conversation lock at commit. The Operator UI keeps a rejected reply in its box. A retried `client_submission_id` returns the original reply (`200`) and never sends twice. A non-Member gets `404`. Customers see Operator replies as `operator` messages without Operator identities.

The conversation detail also returns `lookups`: each completed authorized lookup's declared result fields with `observed_at`. The inbox shows them as historical observations, not current status. Customer memory arrives with #22.
