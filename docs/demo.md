# Portfolio demo (Northwind Kettles)

One command prepares a complete, labelled demo of one fictional Business, **Northwind Kettles** (a small kettle and appliance shop). It covers website chat, cited knowledge answers, Customer memory, an authorized order lookup, Jev routing, handoff to the shared inbox and the Owner's trace view. It runs in simulation without any key, or connected with real providers.

**Everything about Northwind Kettles is synthetic.** It is not a real business. Its documents, help site, products, orders and Customers are invented. Its keys protect nothing real. The files live in [`demo/`](../demo):

- `cert.pem`/`key.pem`: a local-only demo CA certificate for `northwind.demo.test`, and its key.
- `customer-key.json`: the shop's Customer signing key. It is committed, so anyone with this repository can sign in as any demo Customer of the demo Business. Never register it for any other Business.
- `demo.json`: the order API key.
- `orders.json`, `documents/` and `site/`: the order data, policy documents and help site.

That is why hosted mode refuses the demo settings and the seed.

## What runs

A `demo` Compose profile adds one bundled service, `demo` ([`demo/server.mjs`](../demo/server.mjs)):

- **HTTPS on the private Docker network as `northwind.demo.test`.** It serves Northwind Kettles' order API (`GET /orders?customer=…[&order_id=…]` with the `x-demo-key` header) and a static help site (`/help/`, with `robots.txt`). The order API returns only the requesting Customer's orders.
- **HTTP on `127.0.0.1:3300`.** The demo shop page embeds the chat widget. Its backend holds the Customer signing key and signs a 10-minute ES256 assertion for the demo Customer `demo-customer-ada` when you click **Sign in as demo customer**. **Sign out** reloads the page without one, and the widget then ends the verified chat session.

The worker reaches the demo service only when `DEMO_PUBLIC_HOSTS=northwind.demo.test` is set (exactly that one name) in `APP_MODE=local`, or in `test` for the test suite. Then that name may resolve to the private network, and its certificate is verified only through the demo CA, which verifies nothing else. Hosted mode refuses `DEMO_PUBLIC_HOSTS` and `DEMO_CA_FILE` at startup. Every other check stays: HTTPS, the approved origin, credentials, the ownership policy, schemas, robots.txt and the crawl scope. Readiness then reports `"demo": "northwind.demo.test: demo service, not a real business"`.

## Prerequisites

- Ports 3100, 8025 and 3300 must be free.
- In `.env`:
  - `COMPOSE_PROFILES=local,demo` and `DEMO_PUBLIC_HOSTS=northwind.demo.test`.
  - `ACTION_CREDENTIAL_KEY` (`openssl rand -hex 32`), so the orders credential can be stored.
  - `SEED_OWNER_EMAIL` and `SEED_OWNER_PASSWORD` for the Owner, and `SEED_SUPPORT_PASSWORD` for the demo Support Operator.
- The embedding model, installed once: `docker compose run --rm models` (needs network).
- Optional: `PROVIDER_RATES`, so traces show cost estimates (see Providers).
- Connected mode only: `DEEPSEEK_API_KEY` and `TYPESAFE_API_KEY` (and optionally `DASHSCOPE_API_KEY` for the Qwen fallback), plus `compose.connected.yaml` for outbound HTTPS (see Providers).

## The command

```sh
docker compose up --build -d --wait
docker compose run --rm models            # once
# Open http://localhost:3100, create the SEED_OWNER_EMAIL account and verify it (code at http://localhost:8025).
docker compose --profile seed run --rm seed                    # simulation, no keys

# Connected, with real providers:
docker compose -f compose.yaml -f compose.connected.yaml up -d --wait
docker compose -f compose.yaml -f compose.connected.yaml --profile seed run --rm seed node dist/seed.js --connected
```

The seed signs in as the Owner and creates everything through the app's own APIs, so every authorization and validation check applies:

- the Business, with a `demo_seeds` marker;
- the Support Operator `support@northwind-kettles.test`, signed up, verified through Mailpit, invited and accepted;
- the approved website origin `http://localhost:3300`, and the Customer signing key `northwind-demo-1`;
- the orders credential `northwind-orders` (sent only to `https://northwind.demo.test`), and the ownership policy `own-orders` (`customer` → `customer_id`);
- the sources: the policy PDF (`policies`, priority 1, page-level facts on returns, warranty and delivery), the care guide in Markdown (`care-guide`, priority 2), and the help site (`help-centre`, priority 3, crawled from `https://northwind.demo.test/help/`, never a third-party site);
- the published workflow. A Jev `decision` (`policy`, `order` or `other`, threshold 0.6) leads to one of three routes:
  - `policy`: retrieval, then the `policy` agent answers with citations;
  - `order`: an `http` lookup of `my_orders`, then the `orders` agent answers;
  - `other`, `uncertain`, `failure`, and an unsupported answer: handoff.

  Both agents use `deepseek/deepseek-flash` with the `qwen3.7-plus-2026-05-26` fallback. The `orders` agent may also look up one order by number.
- with `--connected` only: the Business's provider permissions (DeepSeek and Qwen generation and extraction, Jev decisions), and `generation.mode: "connected"`. Without it, the published workflow runs in simulation. The seed never revokes permissions it granted earlier; revoke them under **Cloud providers**.

It then waits for ingestion and the crawl, and prints the shop link, `http://localhost:3300/?business=<id>`.

A rerun creates only what is missing and prints `Already exists:` for the rest. Two concurrent runs serialize on a database lock. Changing modes publishes a new version.

## Walkthrough

1. **Chat with a cited answer.** Open the shop link and ask *"What is your returns policy?"*.
   - Connected: the answer cites `northwind-policies.pdf, page 1`.
   - Simulation: the reply is labelled simulated and contains no business facts. The trace still shows the passages retrieval found.
2. **Memory** (connected).
   - Click **Sign in as demo customer**, then opt in under **Customer memory**.
   - Save the preferences: `preferred_name` `Ada` and `communication_style` `brief` (**Save preference correction**).
   - The next answer addresses Ada by name and stays brief.

   The model can also extract a preference from chat, but only from a message that is the statement alone (*"Please call me Ada."*), and Jev routes such a message to support. Product interests accept only a fixed list, and kettles are not on it. In simulation, opt-in and preferences work, but replies are not generated.

3. **Order lookup.** Signed in, ask *"Where is my order?"*. The worker calls the demo order API as `demo-customer-ada` and checks that the result is hers. It gets NK-1001 and NK-1002, never another Customer's NK-2001. Signed out, the assistant asks you to sign in.
4. **Jev route.** Each message is first routed by Jev. Simulation sends no Jev request; it picks the choice whose description shares the most words with the message, and the trace labels that a keyword match.
5. **Handoff.** Say *"hello"* (or anything outside policies and orders). The conversation waits for support. Sign in at http://localhost:3100 as `support@northwind-kettles.test`, open the Northwind Kettles inbox, claim it and reply.
6. **Traces.** As the Owner, open **Traces** for that conversation. It shows:
   - the Jev choice and probability (or the simulated keyword match);
   - the retrieved and cited passages;
   - the lookup's returned fields;
   - each model call with tokens and cost;
   - the published version it ran on.

## Reset

- **Restore the setup.** Rerun the seed. It republishes the demo configuration if it changed, and uploads a deleted source again. It also re-stores a revoked credential, re-approves a withdrawn origin and re-invites a removed Support Member.
- **A new key.** The orders credential is encrypted with `ACTION_CREDENTIAL_KEY`. After changing that key, revoke `northwind-orders` (**Actions**) and rerun the seed.
- **Start with no chat history in the shop.** Sign out, then clear the site data of `localhost:3300`.
- **Wipe everything.** `docker compose down -v` deletes all local data: every Business, account and conversation, not only the demo's.
