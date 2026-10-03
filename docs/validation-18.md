# Issue #18 — Human takeover and shared inbox

Environment: 2026-10-03, macOS 27.0.1 arm64 / OrbStack, Node 22.22.3, Docker Compose v5.1.2, PostgreSQL 17 (repository-pinned pgvector image), Python 3.14.6 with psycopg 3.3.3, Better Auth 1.7.7, TypeScript 7.0.2, Playwright 1.63.0 / Chromium. No new dependencies.

## Reproduce

Requires this project's `.env`, free loopback ports 3118/8038, locked npm dependencies and Chromium. The tests restart db/app/worker in the isolated Compose project, so use disposable fixture data. No cloud credentials, providers or external services are used.

```sh
npm ci --ignore-scripts
npx playwright install chromium
npm run typecheck
export COMPOSE_PROJECT_NAME=custom-bot-inbox-validation APP_URL=http://localhost:3118 MAIL_URL=http://localhost:8038
COMPOSE_FILE=compose.yaml:compose.test.yaml:ports-18.yaml docker compose up --build -d --wait
node --test tests/inbox.test.mjs
node --test --test-name-pattern="asks for a person" tests/browser.test.mjs
sleep 61   # let Better Auth's per-IP auth limits reset
npm test
```

`ports-18.yaml` has the same shape as `ports-16.yaml` in [validation-16](validation-16.md), with `3118:3000` and `8038:8025`.

Time-dependent cases need no clock hook. Delayed automated results use the existing test-only `[hold Ns]` prefix with a 3 s hold, shorter than the 5 s test lease. A discarded result therefore comes from the pause, not from lease expiry. A positive control with the same hold and no control change delivers its reply. Races use independent sockets released together by a barrier (`together`).

## Design

- Control state, assignee and revision live on the conversation. Every control change goes through one database trigger, whichever service makes it (app, worker or Membership revocation). In the same transaction it increments the execution generation, marks queued/running automated turns failed (`paused for human support`), sets their Customer messages to `turn_state: "human"`, and posts the Customer notice. The worker accepts a result only while its job is still running and the conversation is automated at the job's generation. It also refuses to claim a turn otherwise.
- Operator actions hold the Business row `FOR SHARE` (Membership changes take it exclusively) and the conversation row `FOR UPDATE`. Membership, revision and assignee checks therefore hold at commit.
- `revision` changes only when control or the assignee changes, so Customer messages do not invalidate an Operator's reply.
- Revoking a Membership, by any writer, fires a trigger that returns that Member's human-controlled conversations to the queue.
- A Customer message after resolution takes `FOR SHARE` on the retained assignee's Membership. A concurrent revocation therefore either happens first (the conversation goes to the queue) or waits and then requeues it.

## Acceptance evidence

| Criterion | Runnable evidence |
| --- | --- |
| Exactly one competing claim succeeds; only the current assignee can send, resolve or resume, with commit-time authority/revision checks | `inbox.test.mjs` claims group. Three Members claim one queued conversation at once: `[200,409,409]`, one assignee. Each loser gets 409 for send, resolve, resume and claim with the current revision. The assignee gets 409 with a stale revision. Message count is unchanged. Malformed bodies return 400. A non-Member, and an Owner of another Business using that Business's path with this conversation's ID, get 404. Signed-out gets 401, cross-origin gets 403. Customers see `operator` replies without Operator email/ID or submission IDs. Reassignment group: an Operator cannot reply to an automated conversation before claiming it (409). Claiming it is a takeover (`operator-takeover`). |
| Reassignment or revocation rejects former-assignee sends, deduplicates submissions, preserves unsent drafts | Reassignment group. After an Owner reassigns, the former assignee's send fails with a stale revision (`changed`) and with the new revision (`current assignee`). Reassigning back does not revive a send at the old revision. Support can reassign too. A retry of a reply delivered before reassignment returns the original (200), with no duplicate. Five concurrent identical submissions return 200 with one message; the same ID with different text returns 409. Three send-vs-reassign barrier rounds: the reply exists if and only if the send returned 200. Send-vs-revocation barrier race: revocation returns 200. A send that won precedes the requeue notice; one that lost returns 404 and is absent. The conversation is back in the queue, the revoked Member gets 404 everywhere, and another Member claims it. Drafts: browser journey, below. |
| Human request, takeover and failure immediately increment execution generation and reject delayed bot replies/actions/extraction | Pause group. For a Customer request and an Operator takeover, each made during a held running turn with a second turn queued: after the hold, there is no assistant message, and both Customer messages are `human`. Failure: with a published `connected` configuration and no provider, the first turn fails visibly. The conversation is `waiting-for-support` (`automation-failure`), and the queued second turn never runs. Generation itself is internal; its effect is observed through rejected late results. **Actions and memory extraction do not exist yet** (#19/#20/#23). Their jobs must use the same generation/control acceptance check, which the trigger advances. |
| Messages and ownership survive queueing, Away, disconnection and restart, with accurate customer statuses and no response-time promise | Lifecycle group. With nobody available, a queued conversation keeps Customer messages and gets no automated reply. Availability validates input, shows to the team and assigns nothing. After Away plus sign-out (a disconnected assignee), the conversation stays `human-controlled` with the same assignee. Customer messages are stored as `human` with no automated reply. After `docker compose restart db app worker`, Customer and Operator views are byte-identical, and the assignee signs in again and replies. Status notices: `Waiting for support…`, `Support joined.`, `Automated assistant resumed.`, `Conversation resolved…`. No notice contains a digit or `minute/hour/soon/shortly/within`. Logs omit chat text and Operator emails. |
| Explicit resume waits for the next Customer message without replay; a message after resolution reopens under human control with the retained assignee | Lifecycle group. Resolve, then a Customer message: `human-controlled`, same assignee, `Support joined.`, no automated reply. A reply to a resolved conversation is 409. Resume: `automated`, assignee cleared, `Automated assistant resumed.`. After 2 s no automated reply exists for earlier messages; a second resume is 409. The next Customer message is `queued`, and exactly one assistant reply arrives, for that message. Reassignment group: a resolved conversation whose assignee was revoked reopens to the queue instead (`waiting-for-support`, no assignee). |

Browser journey (`browser.test.mjs`, 390 px viewport, separate fixture website origin):
1. The Customer chats, selects **Talk to a person** and sees *Waiting for support* with no time promise; the button hides.
2. Support signs in, opens the inbox, sees the reason and history, and claims. The Customer sees *Support joined.*
3. Support's reply reaches the Customer as `Support: …`. The next Customer message reaches Support with no simulated reply.
4. Support types a draft. The Owner reassigns to themself in another browser. Support's **Send reply** reports *Not sent; your reply is kept.*, the reply box still holds the draft, and the Customer never receives it.
5. The Owner resolves, and the Customer sees *Conversation resolved*.

There is no horizontal scroll and there are no page errors.

## Mutation checks

Each mutation was built into the running images (or applied to the live trigger function), run against its group, then restored. A guard now records a mutant that fails to build instead of silently testing the previous image.

| Mutation | Result |
| --- | --- |
| Send/resolve/resume without the assignee check | Claims group failed |
| Claim reads the conversation without `FOR UPDATE` | Claims group failed (race) |
| Revocation leaves human-controlled assignments | Reassignment group failed. The first attempt was **not detected** because the mutant (`if(false)`) did not compile and the previous image was tested. It was rerun with a compiling mutant. After review, the release moved into a Membership trigger; replacing that trigger function with a no-op also failed the group. |
| Reopen ignores whether the retained assignee is still a Member | Reassignment group failed |
| Customer messages under human control start automated turns | Claims group failed |
| Control trigger leaves queued/running turns alone | Pause group failed |
| …and the worker accepts results whatever the generation/control state | Pause group failed |
| Operator UI clears a rejected reply | Browser journey failed |

## Recorded result

Focused groups on rebuilt images of the final code: inbox **4 passed, 0 failed**; browser **6 passed, 0 failed** (including the inbox journey). Typecheck passed.

Final full isolated suite on a fresh database and rebuilt images of the committed code: **29 groups passed, 0 failed/cancelled/skipped; 811.6 s** (includes rate-limit waits).

```text
# tests 29
# pass 29
# fail 0
# cancelled 0
# skipped 0
# duration_ms 811607.69325
```

One existing assertion changed on purpose. In `chat.test.mjs`, a connected-mode turn that fails with no provider now also hands off, so its conversation has a second system notice (*Waiting for support*) and `control_state: "waiting-for-support"`.

## Review

`/code-review high` returned 10 findings. Fixed:
- An idle automated conversation was never polled by the widget, so a Customer did not see an Operator takeover until sending a message. Idle conversations now poll every 10 s, and queued/human ones every 3 s.
- The Operator UI's 3 s poll adopted the server's newest revision, so a reassignment made on an out-of-date view would succeed. Polling now refreshes the view but keeps the revision the Operator last opened or acted on, so the server returns 409.
- Selecting **Open inbox** for the already-open Business dropped every reply draft. It now only reloads.
- Revocation's release ran only in the Membership API. It is now a database trigger, consistent with the control trigger and the last-Owner guard.
- Resume kept the old handoff reason on an automated conversation. It is now cleared (asserted in the lifecycle group).
- **Talk to a person** was visible before chat loaded, or when it failed to load. It is now hidden until a conversation renders as automated.
- Chat and inbox duplicated the submission/text validation, and Reassign duplicated the post-action handler. Both now share one helper.
- `docs/validation-18.md` is included in the commit.

Kept: inbox reads take the Business row `FOR SHARE`, as configuration reads do, and the list is not indexed. The `ponytail:` note on the 200-row list marks paging/indexing for when load testing measures it.

Also found while re-running the browser suite: the new **Open inbox** button text joined the Business list item's text, which broke exact-text lookups in two existing journeys. The label is now its own element.

## Not in this slice

Timestamped lookup results and permitted Customer memory in Operator context arrive with actions (#20) and memory (#22). Action and extraction jobs (#19/#20/#23) must reuse the generation/control acceptance check. The inbox lists the newest 200 conversations that have messages, with no paging. Drafts are kept in the open page, per conversation, not on the server.
