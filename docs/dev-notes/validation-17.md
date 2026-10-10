# Issue #17 — JSON configuration and publication

Environment: 2026-10-03, macOS 27.0.1 arm64 / OrbStack, Node 22.22.3, Docker Compose v5.1.2, PostgreSQL 17 (repository-pinned pgvector image), Python 3.14.6 with psycopg 3.3.3, Better Auth 1.7.7, TypeScript 7.0.2, Playwright 1.63.0 / Chromium. No new dependencies.

## Reproduce

Requires this project's `.env`, free loopback ports 3117/8037, locked npm dependencies and Chromium. The tests restart the app and use disposable fixture data. No cloud credentials or external services are used. Chat pinning checks use the existing simulated worker path, which needs no clock or job controls.

```sh
npm ci --ignore-scripts
npx playwright install chromium
npm run typecheck
export COMPOSE_PROJECT_NAME=custom-bot-config-validation APP_URL=http://localhost:3117 MAIL_URL=http://localhost:8037
COMPOSE_FILE=compose.yaml:compose.test.yaml:ports-17.yaml docker compose up --build -d --wait
node --test tests/configuration.test.mjs
node --test --test-name-pattern="invalid JSON across reload" tests/browser.test.mjs
sleep 61   # let Better Auth's per-IP auth limits reset
npm test
```

`ports-17.yaml` has the same shape as `ports-16.yaml` in [validation-16](validation-16.md), with `3117:3000` and `8037:8025`.

## Acceptance evidence

| Criterion | Runnable evidence |
| --- | --- |
| Supported agent/action/source-priority/model/workflow/position values round-trip without stripping fields or exposing secret values | `configuration.test.mjs` round-trip group. The fixture uses every supported field: decision engine/model, sources with priorities, two agents with Qwen/DeepSeek models, temperature and max_tokens, a GET action with nested input/result schemas, all five step types, all eight output kinds, and fractional/negative positions. It is saved with custom indentation and spacing. GET returns the exact text. Publishing creates version 2, whose `document` deep-equals the parsed text. Actions hold only `credential`/`authorization` references. The validation group rejects inline secrets with located errors: `api_key` on an agent, `headers` on an action, and credentials embedded in URLs. |
| Invalid raw JSON survives save/read/restart and cannot execute or publish; structurally valid incomplete drafts remain editable | Invalid group. Invalid text saves (200, `json_valid:false`, error at line 4, column 16). The text is byte-identical after `docker compose restart app`. Publishing returns 422 and creates no version 2. A new Customer conversation still pins version 1 and receives a simulated reply. A draft with `entry:null`, a `null` target and a missing `failure` output saves with zero errors and three located blockers, and publishing it returns 422. Oversized text (262,145 characters) and raw NUL return 400 and leave the draft unchanged. Browser journey: invalid text is saved, an unrelated invitation leaves unsaved editor text untouched, the text is intact after reload, Publish reports the line/column error, and an incomplete draft lists `/workflow/entry` as a blocker. |
| Unknown fields, duplicate/dangling IDs, non-finite positions, invalid schemas, incomplete connections and authorization/read-only bypass block publication with located errors | Validation group, 48 table cases plus 7 located syntax errors. Each case saves (200) and is stored verbatim. It reports an error at the expected JSON Pointer, and publishing returns 422 with the same validation, so the version never advances. Cases include unknown top-level/nested fields, including an Object prototype name (`constructor`); duplicate agent/step/source IDs; dangling entry, connection source/target, step agent/action, and agent/retrieval sources and actions; outputs a step type does not offer; and duplicate outputs. Positions cover `1e999`, `1e-200000` (which `JSON.parse` turns into 0 but PostgreSQL cannot store), a string and a missing value. Duplicate object keys, which `JSON.parse` silently collapses, are reported with line/column. An inherited name (`toString`) as a step type is a located error, not a crash. Also covered: unsupported step type, schema version, mode and provider; unbounded temperature/max_tokens; malformed schema type, undeclared `required` and unknown schema keywords; and a non-object document, NUL in a value or a key, and excessive nesting. Syntax errors are located by line/column, including the ones V8 reports without a position: `[,]`, a bad literal, trailing content, a leading zero, a bad escape, an unterminated string and empty text. Bypass attempts are `POST`, `http:`, `127.0.0.1`, `0x7f000001`, `[::1]`, `*.localhost`, `localhost.` (trailing dot), userinfo, `authorization:null` or a removed `authorization`, a removed credential and `timeout_ms:15001`. Malformed request bodies (missing, extra or wrong-typed fields, `business_id` selector) return 400. |
| Saves and publication require expected revisions and reject stale writes while retaining local text | Race group with independent sockets and a barrier (`together`). Two saves at one revision return exactly `[200,409]`. The 409 carries the winner's `latest` text and revision, and the stored draft is the winner's. A stale save and a stale publish return 409 and change nothing. Browser journey: another Owner client saves, and the page's Save is rejected with a conflict message. The editor keeps the local text, and the server keeps the other Owner's text. Reload asks first: declining keeps the text, and accepting loads the latest. |
| Publication atomically creates an immutable monotonic version and current entry-workflow pointer, with Owner-only API and UI access | Two concurrent publishes of one revision return `[201,409]` and exactly version 2 (no version 3). Publication advances the draft revision. A concurrent publish and save at one revision let exactly one through. A publish win leaves the draft text unchanged, and a save win leaves no new version. Version is `max(version)+1`, inserted under the Business row lock in the same transaction as the draft update. The highest version is the current pointer. Observable in the round-trip group: a conversation started before publication keeps version 1, and conversations started after pin versions 2 and 3. A version 3 in `connected` mode, with no provider, fails new turns with a visible system notice while version 2 conversations still reply in simulation. SQL `UPDATE`/`DELETE` on a published version fails (immutable trigger). Access group: a Support Member and signed-out clients get 404/401 on all four routes. An Owner gets 404 for another Business. Cross-origin and Origin-less POSTs get 403 and change nothing. Demoting an Owner removes access on the existing session's next request. Browser: Support sees the Business without a Manage button or editor. Switching Business works with Business B's draft load forced to fail (`page.route` abort): the editor holding unsaved Business A text is emptied, Save reports "Select Manage again…", and B's draft text and revision are unchanged. After sign-out the editor is empty. |

## Mutation checks

Each mutation was built into the running images and run against its group, then restored.

| Mutation | Result |
| --- | --- |
| Publication does not advance the draft revision | Race group failed (two publishes of one revision both 201) |
| Publication ignores blockers | Invalid group failed |
| Unknown fields accepted | Validation group failed |
| Support Membership accepted as Owner | Access group failed |
| Operator UI reloads the editor on every refresh | Browser journey failed (an unrelated invitation replaced unsaved text) |
| Manage on another Business no longer clears the editor | Browser journey failed (previous Business's text remained) |
| Syntax locator ignores bad literals | First **not detected**. A located-syntax-error table was added, which then failed the validation group |

## Recorded result

Focused groups on rebuilt images of the final code: configuration **5 passed, 0 failed**; configuration browser journey **1 passed, 0 failed**. Typecheck passed.

Before the review fixes, the full isolated suite passed: **24 passed, 0 failed/cancelled/skipped; 669.6 s**.

Final full isolated suite on rebuilt images of the committed code: **24 groups passed, 0 failed/cancelled/skipped; 663.9 s** (includes rate-limit waits).

```text
# tests 24
# pass 24
# fail 0
# cancelled 0
# skipped 0
# duration_ms 663899.486042
```

## Legacy Business drafts

The migration ran on an empty database, so its backfill was checked separately. In a rolled-back transaction, a Business was inserted with the original `004` starting document and the trigger disabled, then 006's backfill `INSERT` was run against it. The resulting draft text validates with `errors: []` and exactly one blocker, `/workflow/steps/0`: output `"unsupported"` of `"reply"` is unconnected. That matches the README. Existing local Businesses get this draft when migration 006 runs.

## Review

`/code-review high` returned 10 findings. Fixed:
- An inherited name such as `toString` as a step type made validation throw (500), so the draft was not saved. Output lookup now uses `Object.hasOwn`.
- Numbers such as `1e-200000` passed as 0 but failed PostgreSQL's jsonb cast on save/publish (500). A `JSON.parse` reviver now uses each number's source text and rejects exponents beyond ±308 or more than 40 characters, with a located error.
- Duplicate object keys were silently collapsed. The syntax scanner now reports the first one with line/column.
- `https://localhost./` passed the destination check. A trailing dot is now ignored when matching localhost.
- A NUL in a key was reported at the parent path; it is now reported at the key's own pointer.
- UI: Manage on another Business kept the previous draft in the editor if loading failed, so Save could send Business A's text with a matching revision to Business B. Switching Business, sign-out and losing Owner access now clear the editor. Save/Publish refuse to run without a loaded draft.
- UI: the duplicate fetch helper was removed. `request()` now attaches the status and data to its error.
- Read-only GETs took the exclusive Business lock. They now use `FOR SHARE`.

Kept: `last_valid` is written but not yet read. The specification's draft record requires the last valid representation, and the visual editor's discard flow (#25) will read it. With the number fix, its jsonb cast can no longer fail.

## Not in this slice

Visual canvas editing (#25), base/local/latest comparison and apply/discard flows (#26; the 409 already returns the latest draft), preview and traces (#27), execution of the new step types (#19), and run-time destination approval, DNS checks and credential records (#20). The validator rejects IP-literal and localhost destinations as a first gate, not as the DNS/redirect enforcement. 
