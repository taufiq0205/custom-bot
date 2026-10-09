# Demo data (Northwind Kettles)

Everything in this folder is **synthetic** and exists only for the local [portfolio demo](../docs/demo.md). Northwind Kettles is not a real business.

- `cert.pem` / `key.pem`: a self-signed CA certificate and key for the private demo host `northwind.demo.test`. The worker trusts it only for that host, and only in local or test mode.
- `customer-key.json`: the demo shop's customer signing key. It is committed on purpose so the demo works out of the box, which also means anyone can sign in as a demo customer of the demo business. Never register it for any other business.
- `demo.json`: the demo order API key.
- `orders.json`, `documents/`, `site/`: invented orders, policy documents and help site.
- `server.mjs`: the bundled demo service (order API, help site and demo shop page).

These keys protect nothing real. Hosted mode (`APP_MODE=hosted`) refuses the demo settings and the seed.
