// Northwind Kettles, the bundled demo service (fictional business, synthetic data; see README, Portfolio demo).
// HTTPS on the private Docker network as northwind.demo.test: a static help site and an order API that returns only the requesting
// Customer's orders. HTTP on loopback: the demo shop page, whose backend holds the Customer signing key and signs short-lived
// identity assertions for the demo Customer. Every key, certificate and record here is synthetic and protects nothing real.
import { createServer as https } from 'node:https';
import { createServer as http } from 'node:http';
import { createPrivateKey, randomUUID, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
const here = new URL('.', import.meta.url).pathname;
const read = name => readFileSync(here + name);
const demo = JSON.parse(read('demo.json')), orders = JSON.parse(read('orders.json'));
const {kid, ...jwk} = JSON.parse(read('customer-key.json'));
const key = createPrivateKey({key: jwk, format: 'jwk'});
const app = new URL(process.env.APP_URL ?? 'http://localhost:3100').origin;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const send = (res, status, type, body, headers = {}) => {res.writeHead(status, {'content-type': type, 'cache-control': 'no-store', ...headers}); res.end(body);};
const json = (res, status, value) => send(res, status, 'application/json', JSON.stringify(value));

https({key: read('key.pem'), cert: read('cert.pem')}, (req, res) => {
  const url = new URL(req.url ?? '/', `https://${demo.host}`);
  if (url.pathname === '/orders' && req.method === 'GET') {
    if (req.headers['x-demo-key'] !== demo.orders_key) return json(res, 401, {error: 'invalid key'});
    const customer = url.searchParams.get('customer'), id = url.searchParams.get('order_id');
    if (!customer) return json(res, 400, {error: 'customer required'});
    // Only the requesting Customer's orders; another Customer's order number finds nothing.
    return json(res, 200, {customer_id: customer, orders: orders.filter(o => o.customer_id === customer && (!id || o.order_id === id))
      .map(({customer_id, ...order}) => order)});
  }
  const evaluationPages = {'/eval-conflict/': 'help/standard-delivery.html', '/eval-injection/': 'help/eval-injection.html'};
  const file = url.pathname === '/robots.txt' ? 'robots.txt' : evaluationPages[url.pathname] ??
    (/^\/help\/([a-z-]+\.html)?$/.exec(url.pathname) && `help/${url.pathname.slice(6) || 'index.html'}`);
  if (req.method !== 'GET' || !file) return send(res, 404, 'text/plain', 'not found');
  send(res, 200, file.endsWith('.txt') ? 'text/plain' : 'text/html; charset=utf-8', read(`site/${file}`));
}).listen(443);

// A fresh single-use assertion on every page load while the demo Customer is signed in (docs/customer-identity.md).
function assertion(business) {
  const iat = Math.floor(Date.now() / 1000), part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = `${part({alg: 'ES256', kid})}.${part({iss: demo.shop, aud: app, business_id: business, sub: demo.customer, iat, exp: iat + 600, jti: randomUUID()})}`;
  return `${body}.${sign('sha256', Buffer.from(body), {key, dsaEncoding: 'ieee-p1363'}).toString('base64url')}`;
}
const escape = s => s.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);
const products = [['Aurora Glass Kettle', 'GBP 49', 'Borosilicate glass, blue LED, removable limescale filter.'],
  ['Copper Whistle Kettle', 'GBP 65', 'Stovetop kettle with a brass whistle.'], ['Limescale filter (2-pack)', 'GBP 8', 'Fits the Aurora Glass Kettle.']];
function shop(business, signedIn) {
  const query = `?business=${business}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Northwind Kettles (demo shop)</title><style>
*{box-sizing:border-box}body{margin:0;font-family:system-ui,sans-serif;background:#f6f4ef;color:#1d2321;line-height:1.5}
header,main,footer{padding:16px;max-width:64rem;margin:0 auto}header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between}
.banner{background:#1d2321;color:#fff;padding:8px 16px;font-size:.875rem;text-align:center}
.products{display:grid;grid-template-columns:repeat(auto-fit,minmax(14rem,1fr));gap:12px;padding:0;list-style:none}
.products li,.chat{background:#fff;border:1px solid #ddd8cc;border-radius:8px;padding:16px}
button{font:inherit;padding:6px 14px;border-radius:6px;border:1px solid #0f766e;background:#0f766e;color:#fff;cursor:pointer}
form{margin:0}
</style></head><body>
<p class="banner">Demo shop: Northwind Kettles is a fictional business. Products, orders and customers are synthetic.</p>
<header><h1>Northwind Kettles</h1>
${signedIn ? `<p>Signed in as the demo customer (Ada). <form method="post" action="/logout${query}"><button>Sign out</button></form></p>`
  : `<form method="post" action="/login${query}"><button>Sign in as demo customer</button></form>`}</header>
<main><h2>Kettles and spares</h2><ul class="products">${products.map(([name, price, text]) => `<li><h3>${name}</h3><p>${price}</p><p>${text}</p></li>`).join('')}</ul>
<div class="chat"><script src="${app}/widget.js" data-business="${business}"${signedIn ? ` data-assertion="${escape(assertion(business))}"` : ''} defer></script></div></main>
<footer><small>Help: returns, warranty, delivery, kettle care and order tracking. Try the chat.</small></footer></body></html>`;
}
http((req, res) => {
  const url = new URL(req.url ?? '/', demo.shop), business = url.searchParams.get('business') ?? '';
  if (!uuid.test(business)) return send(res, 404, 'text/plain', 'Open the shop link the demo seed printed (http://localhost:3300/?business=...).');
  const back = {location: `/?business=${business}`};
  if (req.method === 'POST' && url.pathname === '/login')
    return send(res, 303, 'text/plain', '', {...back, 'set-cookie': 'demo_customer=1; Path=/; HttpOnly; SameSite=Lax'});
  if (req.method === 'POST' && url.pathname === '/logout')
    return send(res, 303, 'text/plain', '', {...back, 'set-cookie': 'demo_customer=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'});
  if (req.method !== 'GET' || url.pathname !== '/') return send(res, 404, 'text/plain', 'not found');
  send(res, 200, 'text/html; charset=utf-8', shop(business, /(^|;\s*)demo_customer=1(;|$)/.test(req.headers.cookie ?? '')));
}).listen(3300, () => console.log(`Demo shop on ${demo.shop}; demo service on https://${demo.host} (synthetic, not a real business)`));
