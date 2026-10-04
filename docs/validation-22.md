# Issue #22: Scoped website knowledge refresh

Environment (2026-10-04):
- macOS 27.0.1 arm64 with OrbStack; Docker Engine 29.4.0 arm64 and Compose 5.1.2.
- Node 22.22.3, TypeScript 7.0.2, Playwright 1.63.0 Chromium.
- Python 3.14.6 worker; PostgreSQL 17 with pgvector 0.8.2. Both images are repository-pinned.
- No new dependencies. Crawling uses the standard library: `http.client` through the existing vetted, address-pinned HTTPS connection, `urllib.robotparser` (longest match with wildcards in 3.14) and `html.parser`.
- Embedding model as in #21.

## Reproduce

Requires this project's `.env`, free loopback ports 3100/8025/3199, locked npm dependencies and the embedding model (the test overlay installs it).

```sh
npm ci --ignore-scripts
npm run typecheck
docker compose -f compose.yaml -f compose.test.yaml up --build -d --wait --remove-orphans
node --test tests/website.test.mjs                 # 7 tests, about 3 minutes
caffeinate -i npm test
docker compose up -d --wait --remove-orphans       # leave test mode
```

**Test sites.** The fixture serves each test's pages persistently under `/<key>/…` on every fixture host, so a scheduled refresh can crawl again at any time without consuming scripted responses. Each host's `/robots.txt` merges every key's rules into one `User-agent: *` group, and a test can make a host's `robots.txt` answer with a fixed status. The worker trusts the test-only CA for `site.fixture.test`, which was added to the reissued test certificate. That name and `other.fixture.test` may resolve to the private Docker network only under `TEST_PUBLIC_HOSTS`. `internal.fixture.test`, `loopback.fixture.test`, `metadata.fixture.test` and `private.fixture.test` resolve to private, loopback and link-local addresses and stay denied.

**Test clock.** Freshness, the daily schedule and activation times use `memory_now(business, testing)`, the per-Business test clock introduced with #23. Tests shift one Business's clock through psql (`test_memory_clock`). Other Businesses' sources, including leftovers from earlier runs, are therefore never made due. Outside test mode, callers pass `testing = false`, and the clock is the real one whatever the table holds.

## Acceptance evidence (`tests/website.test.mjs`)

| Criterion | Runnable evidence |
| --- | --- |
| Same-host URL/path scope and robots rules are enforced; private destinations and out-of-scope redirects are denied | **Scope** test. A site links to an in-scope page, a robots-disallowed page, a same-host page outside the path, the same page on another host, `%2e%2e/` and `/../` escapes, a mailto link, and redirects that go in scope, out of scope, to another host and into a disallowed path, plus a PDF and a 404:<br>• the snapshot holds exactly 3 pages. The fixture log shows exactly the 9 permitted requests, each once, all on `site.fixture.test`. The disallowed, out-of-scope, escaped and other-host URLs were never requested.<br>• robots.txt is requested as `CustomBotKnowledge/1.0`.<br>• Retrieval returns only the three permitted pages. A reply citing `E1–E3` is delivered as `{source, document: <page URL>, page: null}`, with no disallowed or outside text.<br>• Six required pages each fail the whole refresh with their exact error: disallowed; redirected out of scope; redirected into a disallowed path; redirected to another host; 404; not HTML.<br>• Scopes on `internal`, `loopback`, `metadata` and `private.fixture.test` fail with `destination address not permitted`. The fixture never received a request for `internal.fixture.test`.<br>• robots.txt answering 503 fails the refresh, and 403 forbids even the start page. 404 permits every page, including the formerly disallowed one (4 pages).<br>• Thirteen invalid scopes get `400`, including `%2e%2e`, which the URL parser would otherwise resolve silently.<br>• Document and website kinds cannot be mixed (`409`). Only websites refresh, and only documents expire explicitly.<br>• Support, an outsider and a cross-origin request get `404`/`403`, and the source is unchanged. |
| Robust link handling (added after review) | **Links** test:<br>• raw `café` and `size guide` links are percent-encoded once (`/caf%C3%A9`, `/size%20guide`; the pre-encoded duplicate is fetched once) and cited by encoded URL.<br>• A malformed `https://[oops` link and a `?sort=asc` variant are skipped. The fixture log shows exactly 4 requests.<br>• A Windows-1252 page whose charset is declared only in `<meta>` is stored as "Crème brûlée is served daily."<br>• A `robots.txt` redirected to another host is followed, and the snapshot activates. Redirected to `internal.fixture.test`, it fails with `destination address not permitted`. |
| At most 100 pages; overflow or missing required pages fails the complete refresh | **Page cap** test:<br>• 100 permitted pages, with five robots-disallowed links not counted, activate as 100 pages.<br>• One more page fails with `the scope has more than 100 permitted pages; narrow the URL scope`. Only the index was requested, and the 100-page snapshot keeps answering with a warning naming its refresh time and freshness limit.<br>• A permitted page answering 503 fails the refresh, and a missing required page fails it. Answers still use the 100-page snapshot.<br>• With the required page present, the refresh completes, and a discovered 404 page is skipped. |
| Manual and daily scheduled refreshes activate only complete candidates and keep prior evidence plus warnings on failure | **Refresh** test:<br>• a manual refresh replaces the content used by an existing conversation without changing its pinned configuration version. A second request while one is pending returns the same candidate.<br>• A refresh with a 503 page fails, warns, and the previous snapshot keeps answering.<br>• Daily: with the Business clock 30 s before the next refresh time, nothing is queued within 3 s. One second after it, the worker queues and activates a new snapshot without any request, and schedules the next one a day later.<br>• A refresh that comes due while another is held mid-crawl is not repeated after it: 3 s later, the held one is still the latest.<br>**Browser** journey at 1280 and 390 px: add a website with a required page; the row shows "Active snapshot: 2 pages, 2 passages, refreshed …, fresh until …" and has no Expire control. Refresh against a failing page shows the warning while the snapshot stays; then delete. No horizontal scroll and no page errors. |
| Deterministic clock: website evidence is excluded 7 days after its last successful refresh; document eligibility is separate | **Freshness** test, with a website and a document in one Business:<br>• fresh_until is exactly 7 days after activation.<br>• At 7 days minus 1 minute, the overdue daily refresh runs and fails, and the website still answers.<br>• At 7 days plus 1 second, retrieval returns only the document, `fresh` is false, and the warning reads "Website evidence expired … A successful refresh makes it usable again." At 400 days the document still answers.<br>• A turn whose provider holds the website's passages across the 7-day boundary is not delivered (`knowledge source deleted or expired before delivery`) and hands off.<br>• A successful refresh makes the website answer again. |
| Updated content reaches older conversations; deletion/refresh races cannot reactivate deleted sources | **Refresh** test (older conversations, above).<br>**Deletion races** test:<br>• a source deleted while its manual refresh, or its clock-triggered daily refresh, is held before activation never activates. No sentinel passage exists, and re-adding the ID starts a new source.<br>• Five refresh/delete pairs from independent clients, released by a barrier, produced both orders (`202` and `404`). Afterwards, every version of every deleted source is `deleted`, no passage remains, and no ingestion is pending. |

## Code review fixes

`/code-review` found 10 issues against the spec and correctness. Eight are fixed, and the regressions are now covered by tests that failed before the fixes:
- **Raw non-ASCII or space characters in a link failed the whole refresh.** `http.client` sends paths as-is and raised an error, which counted as a transient failure. Links are now percent-encoded (links test).
- **A malformed link (`https://[oops`) failed the refresh** with a misleading "document could not be processed". Malformed links and redirects are now skipped (links test).
- **Query-string variants counted toward the 100-page limit.** They are now skipped (links test).
- **A `robots.txt` redirected to another host failed the crawl.** It is followed now, as RFC 9309 asks, with every hop vetted (links test).
- **A charset declared only in the page was ignored,** so legacy pages were decoded as UTF-8 and garbled (links test).
- **A refresh coming due mid-crawl ran again right after it.** The schedule now counts from completion (refresh test).
- **Re-indexing a website re-crawled its active scope** rather than the latest one the Owner approved. It now crawls the latest scope; there is no test, since this needs an encoding change and a worker restart.
- **A failed version with an empty error showed no warning.** It now says "unknown error".

Not changed:
- **An index for the schedule scan.** It is a small per-loop query over live website sources, and adding the index means changing `017-websites.sql`, which is already applied in local databases. Add it if the scan shows up in measurements.
- **One shared definition of the 7-day freshness rule.** The rule is written in four commented places (retrieval, delivery recheck and the two list fields). A shared SQL function would need its own migration; the freshness test and two mutants cover all four.

## Mutation checks

Each mutant was applied to `worker/worker.py` (before the review fixes, which left these lines unchanged) and built into the worker image. Its test was then run, and the file was restored with `git checkout`. Every mutant made its test fail.

| Mutation | Caught by |
| --- | --- |
| Redirect hops not re-checked | Scope |
| robots.txt ignored | Scope |
| Path prefix ignored (host only) | Scope |
| Page cap ignored | Page cap |
| A transient page failure skipped instead of failing | Page cap |
| Retrieval ignores freshness | Freshness |
| Delivery recheck ignores freshness | Freshness |
| Scheduler ignores the due time | Refresh |
| A deleted source's candidate can activate | Deletion races |

The API's raw-text scope check was found by the scope test before any mutation: the URL parser turned `…/k/%2e%2e/help/` into the different scope `…/help/`, which was accepted.

## Real integration run (2026-10-04)

First run at 16:39 UTC on `5eb4c47`. It was repeated at 17:14 UTC on the reviewed code (`026fac7`) with identical outcomes: `w3.org` again gave 41 pages and 911 passages, in 46 s; the answer used 379 input and 67 output tokens.

Afterwards, the 10 real-site sources of these synthetic Businesses were deleted (the delete endpoint's three statements, in one transaction), so no daily refresh crawls those third-party sites again.

The worker crawled real public sites and used real DeepSeek for one answer. Synthetic Businesses were used, and no key values were printed.

| Stack | Site | Result |
| --- | --- | --- |
| Default (`docker compose up`; the worker has no outbound access) | `https://example.com/` | Fails: `robots.txt of https://example.com could not be fetched (connection failed); website refresh needs outbound HTTPS (compose.connected.yaml)` |
| Connected (`compose.connected.yaml`) | `https://example.com/` (robots.txt 404) | Active in 0.8 s: 1 page, 1 passage, fresh until 7 days later |
| Connected | `https://www.w3.org/WAI/fundamentals/` | Active in 56 s: **41 pages**, 911 passages, every page URL inside the scope |
| Connected | `https://docs.python.org/3/library/` (258 links) | Fails at discovery: `the scope has more than 100 permitted pages; narrow the URL scope` |
| Connected | `https://www.iana.org/help/` (redirects to `/help`) | Fails: `required page … was not used: it redirects to https://www.iana.org/help, which is outside the approved scope` |
| Connected, real DeepSeek | "What is the example.com domain for?" | Reply grounded in the page, citing `{source: example, document: https://example.com/, page: null}`; `deepseek-flash`, 379 input and 72 output tokens |

## Decisions

- **Complete means every permitted page.** A transient failure (timeout, 429 or 5xx) on any permitted page, or on robots.txt, fails the refresh, so a snapshot is never silently partial. A discovered page that is gone (4xx), not HTML, or redirected out of bounds is skipped, because the site says it is not content in scope. A required page, the scope URL included, fails the refresh for any of these reasons.
- **robots.txt follows RFC 9309 as Python 3.14 implements it.** A missing robots.txt (4xx) allows everything; 401 and 403 forbid everything (Python's choice); an unreachable one stops the crawl.
- **Websites expire by themselves.** Explicit expiry (#21) stays document-only. The daily refresh would otherwise revive an expired website.
- **One test clock per Business.** #23 introduced `memory_now()`, which this slice reuses rather than adding a second clock.
- **The schedule runs from completion.** The next daily refresh is due a day after the last one finished, or was requested while one is pending. A refresh that comes due mid-crawl is therefore not repeated right after it. The worker's single ingestion thread only checks the schedule between jobs, so counting from the request would have done exactly that.
- **Links with a query string are skipped,** like the approved scope itself. Otherwise sorting, paging and tracking variants fill the 100-page limit with duplicates.

## Not established by this slice

- **JavaScript-rendered sites, sitemaps, `noindex`/`nofollow` and crawl-delay.** Pages are read as served HTML, and links come from `<a href>` only.
- **Answer quality over websites.** As in #21, the fixture provider is scripted. The single real answer above is an integration check, not an evaluation.
- **Crawl performance and politeness.** Requests run one at a time with a 15 s bound each. There is no crawl-delay or per-host rate limit (`ponytail`: add when a refresh of 100 pages proves too aggressive for a real site).

## Results

| Run | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `node --test tests/website.test.mjs`, before the review | 6/6 pass |
| `node --test tests/website.test.mjs`, after the review fixes | 7/7 pass, 0 failed assertions |
| `node --test --test-concurrency=1 tests/knowledge.test.mjs tests/memory.test.mjs` | 29/29 pass |
| Mutation checks | 9/9 caught |
| Real integration run, before and after the review | as recorded above |
| `caffeinate -i npm test`, full suite after the review fixes (2026-10-04, 24.1 min) | **89/89 pass, 0 failed, cancelled or skipped** |
