// Portfolio demo seed: Northwind Kettles, a fictional Business with synthetic data (README, Portfolio demo). Everything is created
// through the app's own APIs, signed in as the Owner, so every authorization and validation check applies. Idempotent: a rerun
// creates only what is missing and reports what already exists. `--connected` also grants the provider permissions and
// publishes connected generation; without it the demo runs in simulation.
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { mode, origin, pool } from './config.js';
if (mode === 'hosted') throw new Error('Demo seeding is disabled in hosted mode');
const connected = process.argv.includes('--connected');
const env = (name: string) => {
  const value = process.env[name];
  if (!value || /REPLACE/.test(value)) throw new Error(`Set ${name} (see README, Portfolio demo)`);
  return value;
};
const owner = {email: env('SEED_OWNER_EMAIL').toLowerCase(), password: env('SEED_OWNER_PASSWORD')};
const support = {email: 'support@northwind-kettles.test', password: env('SEED_SUPPORT_PASSWORD')};
const demo = JSON.parse(await readFile('/demo/demo.json', 'utf8'));
const {kid, kty, crv, x, y} = JSON.parse(await readFile('/demo/customer-key.json', 'utf8'));
const api = 'http://app:3000', mail = 'http://mail:8025';
const report = (created: boolean, what: string) => console.log(`${created ? 'Created' : 'Already exists'}: ${what}`);
type Reply = {status: number, data: any, retry?: number};

// One Operator's API session: same-origin requests carrying its own Better Auth cookie.
function session() {
  const cookies = new Map<string, string>();
  return async (path: string, body?: unknown, raw?: Buffer): Promise<Reply> => {
    const response = await fetch(api + path, {method: body === undefined && !raw ? 'GET' : 'POST', redirect: 'manual',
      headers: {origin, cookie: [...cookies].map(c => c.join('=')).join('; '), ...(raw ? {} : {'content-type': 'application/json'})},
      body: raw ? new Uint8Array(raw) : body === undefined ? undefined : JSON.stringify(body)});
    for (const set of response.headers.getSetCookie()) {
      const [name, value] = set.split(';')[0].split(/=(.*)/s);
      if (value) cookies.set(name, value); else cookies.delete(name);
    }
    return {status: response.status, data: await response.json().catch(() => null), retry: Number(response.headers.get('x-retry-after'))};
  };
}
// Sign-in and sign-up are rate limited: wait out one 429 (at most a minute) instead of failing a quick rerun.
async function limited(send: () => Promise<Reply>) {
  const first = await send();
  if (first.status !== 429) return first;
  await new Promise(r => setTimeout(r, 1000 * (first.retry! >= 1 && first.retry! <= 60 ? first.retry! : 60) + 100));
  return send();
}
function expect(reply: Reply, statuses: number[], what: string) {
  if (!statuses.includes(reply.status)) throw new Error(`${what} failed (${reply.status}): ${reply.data?.error ?? JSON.stringify(reply.data)}`);
  return reply.data;
}
// The newest captured mail for this address and subject sent after `since` (local Mailpit only).
async function captured(email: string, subject: string, since: number) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const listing = await fetch(`${mail}/api/v1/messages`).then(r => r.json()).catch(() => {
      throw new Error('Creating the demo Support account needs local mail capture (Mailpit, COMPOSE_PROFILES=local)');
    });
    const found = listing.messages.find((m: any) => m.Subject === subject && Date.parse(m.Created) >= since - 1000 && m.To.some((t: any) => t.Address === email));
    if (found) return (await fetch(`${mail}/api/v1/message/${found.ID}`).then(r => r.json())).Text as string;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`No ${subject} mail reached ${email}; check the mail service`);
}
async function signIn(account: {email: string, password: string}, create: boolean) {
  const request = session();
  const attempt = () => limited(() => request('/api/auth/sign-in/email', account));
  let login = await attempt();
  if (login.status === 401 && create) {
    const since = Date.now();
    expect(await limited(() => request('/api/auth/sign-up/email', {name: 'Northwind Support (demo)', ...account})), [200], `Sign-up of ${account.email}`);
    const code = (await captured(account.email, 'email-verification', since)).match(/\b\d{8}\b/)![0];
    expect(await request('/api/auth/email-otp/verify-email', {email: account.email, otp: code}), [200], `Verification of ${account.email}`);
    report(true, `Support Operator ${account.email}`);
    login = await attempt();
  } else if (login.status === 200 && create) report(false, `Support Operator ${account.email}`);
  if (login.status !== 200) throw new Error(create
    ? `${account.email} exists but SEED_SUPPORT_PASSWORD does not sign it in (${login.status})`
    : `Register and verify SEED_OWNER_EMAIL in the Operator app first, and set SEED_OWNER_PASSWORD (${login.status})`);
  return request;
}

const DESIRED_SOURCES = [{ref: 'policies', file: 'northwind-policies.pdf'}, {ref: 'care-guide', file: 'kettle-care.md'}];
const model = {provider: 'deepseek', name: 'deepseek-flash', temperature: 0.2, fallback: {provider: 'qwen', name: 'qwen3.7-plus-2026-05-26'}};
const text = {type: 'string'};
const configuration = {
  schema_version: 1, generation: {mode: connected ? 'connected' : 'simulation'}, decision: {engine: 'jev'},
  sources: [{id: 'policies', priority: 1}, {id: 'care-guide', priority: 2}, {id: 'help-centre', priority: 3}],
  agents: [
    {id: 'policy', name: 'Policy answers', sources: ['policies', 'care-guide', 'help-centre'], model,
      instructions: 'You are the help assistant of Northwind Kettles, a fictional demo kettle shop. Answer briefly and only from the knowledge evidence, and cite every passage you rely on. If the evidence does not answer the question, answer unsupported.'},
    {id: 'orders', name: 'Order updates', actions: ['my_orders'], model,
      instructions: 'You give order updates for Northwind Kettles, a fictional demo kettle shop. Use only the orders in the live business data of the workflow context; never guess or invent order facts. If the Customer names an order that is not there, say it is not on their account. If the data does not answer the question, answer unsupported.'}],
  actions: [{id: 'my_orders', method: 'GET', url: `https://${demo.host}/orders`,
    input_schema: {type: 'object', properties: {order_id: {type: 'string', description: 'your order number (for example NK-1001)'}}},
    result_schema: {type: 'object', required: ['customer_id', 'orders'], properties: {customer_id: text, orders: {type: 'array', items: {type: 'object',
      required: ['order_id', 'item', 'status', 'estimated_delivery'], properties: {order_id: text, item: text, status: text, estimated_delivery: text}}}}},
    credential: 'northwind-orders', authorization: 'own-orders', timeout_ms: 10000}],
  workflow: {entry: 'triage', steps: [
    {id: 'triage', type: 'decision', question: 'What does the Customer need help with?', min_probability: 0.6, position: {x: 0, y: 160}, choices: {
      policy: 'Questions about returns, refunds, warranty, delivery times or costs, or kettle care and descaling',
      order: 'Questions about my order: where it is, its status, tracking, or when it arrives',
      other: 'Greetings, small talk or anything else'}},
    {id: 'search', type: 'retrieval', sources: ['policies', 'care-guide', 'help-centre'], position: {x: 280, y: 0}},
    {id: 'answer', type: 'agent', agent: 'policy', final: true, position: {x: 560, y: 0}},
    {id: 'lookup', type: 'http', action: 'my_orders', position: {x: 280, y: 200}},
    {id: 'update', type: 'agent', agent: 'orders', final: true, position: {x: 560, y: 200}},
    {id: 'support', type: 'handoff', position: {x: 840, y: 360}}],
  connections: [['triage', 'policy', 'search'], ['triage', 'order', 'lookup'], ['triage', 'other', 'support'], ['triage', 'uncertain', 'support'],
    ['triage', 'failure', 'support'], ['search', 'next', 'answer'], ['answer', 'unsupported', 'support'], ['lookup', 'success', 'update'],
    ['lookup', 'failure', 'support'], ['update', 'unsupported', 'support']].map(([from, output, to]) => ({from, output, to}))}
};
const PERMISSIONS = ['deepseek/generation', 'deepseek/extraction', 'qwen/generation', 'qwen/extraction', 'jev/decision'];

const lock = await pool.connect();
try {
  // Concurrent seeds run one after another; the later one finds everything in place.
  await lock.query('SELECT pg_advisory_lock(130035)');
  const ready = await fetch(`${api}/health/ready`).then(r => r.json());
  if (!String(ready.knowledge).startsWith('available')) throw new Error('Install the embedding model first: docker compose run --rm models');
  if (!ready.demo) throw new Error('Enable the demo service first: DEMO_PUBLIC_HOSTS=northwind.demo.test and COMPOSE_PROFILES with demo (README, Portfolio demo)');
  const as = await signIn(owner, false);
  let business = (await pool.query('SELECT business_id FROM demo_seeds WHERE name=$1', [demo.business])).rows[0]?.business_id as string | undefined;
  if (business) {
    if (expect(await as(`/api/businesses/${business}`), [200, 404], 'Business lookup')?.role !== 'Owner')
      throw new Error(`${demo.business} exists, but SEED_OWNER_EMAIL is not its Owner`);
    report(false, `Business ${demo.business}`);
  } else {
    business = expect(await as('/api/businesses', {name: demo.business}), [201], 'Business creation').id as string;
    await pool.query('INSERT INTO demo_seeds(name,business_id) VALUES($1,$2)', [demo.business, business]);
    report(true, `Business ${demo.business}`);
  }
  const at = (path: string) => `/api/businesses/${business}/${path}`;

  const members = expect(await as(at('memberships')), [200], 'Membership listing') as {email: string, role: string, active: boolean}[];
  const member = members.find(m => m.email === support.email && m.active && m.role === 'Support');
  const since = Date.now();
  if (!member) expect(await as(at('invitations'), {email: support.email, role: 'Support'}), [201], 'Support invitation');
  const helper = await signIn(support, true);
  if (!member) {
    const token = (await captured(support.email, 'Business invitation', since)).match(/Invitation token: (\S+)/)![1];
    expect(await helper('/api/invitations/accept', {token}), [200], 'Support invitation acceptance');
  }
  report(!member, `Support Membership of ${support.email}`);

  const origins = expect(await as(at('website-origins')), [200], 'Website origin listing') as string[];
  if (!origins.includes(demo.shop)) expect(await as(at('website-origins'), {origin: demo.shop, approved: true}), [200], 'Website origin approval');
  report(!origins.includes(demo.shop), `approved website origin ${demo.shop}`);

  const keys = expect(await as(at('customer-keys')), [200], 'Customer key listing') as {kid: string, public_key: {x: string, y: string}}[];
  const key = keys.find(k => k.kid === kid);
  if (key && (key.public_key.x !== x || key.public_key.y !== y)) throw new Error(`Customer key ${kid} is registered with a different public key`);
  if (!key) expect(await as(at('customer-keys'), {kid, issuer: demo.shop, public_key: {kty, crv, x, y}}), [201], 'Customer key registration');
  report(!key, `Customer signing key ${kid}`);

  const controls = expect(await as(at('action-controls')), [200], 'Action control listing');
  const credential = controls.credentials.find((c: any) => c.ref === 'northwind-orders' && c.active && c.origin === `https://${demo.host}`);
  if (!credential) expect(await as(at('credentials'), {ref: 'northwind-orders', origin: `https://${demo.host}`, header: 'x-demo-key', secret: demo.orders_key}),
    [200], 'Orders credential (needs ACTION_CREDENTIAL_KEY)');
  report(!credential, 'orders credential northwind-orders');
  const policy = controls.policies.find((p: any) => p.ref === 'own-orders' && p.active && p.customer_parameter === 'customer' && p.owner_field === 'customer_id');
  if (!policy) expect(await as(at('authorization-policies'), {ref: 'own-orders', customer_parameter: 'customer', owner_field: 'customer_id'}), [200], 'Ownership policy');
  report(!policy, 'ownership policy own-orders');

  const listed = expect(await as(at('sources')), [200], 'Source listing') as {ref: string}[];
  for (const {ref, file} of DESIRED_SOURCES) {
    const exists = listed.some(s => s.ref === ref);
    if (!exists) expect(await as(at(`sources/${ref}?document=${file}`), undefined, await readFile(`/demo/documents/${file}`)), [202], `Upload of ${file}`);
    report(!exists, `document source ${ref} (${file})`);
  }
  const site = listed.some(s => s.ref === 'help-centre');
  if (!site) expect(await as(at('sources/help-centre/website'), {url: `https://${demo.host}/help/`}), [202], 'Help site source');
  report(!site, `website source help-centre (https://${demo.host}/help/)`);

  if (connected) {
    const granted = expect(await as(at('provider-permissions')), [200], 'Provider permission listing').permissions as {provider: string, operation: string, allowed: boolean}[];
    for (const pair of PERMISSIONS) {
      const allowed = granted.some(g => `${g.provider}/${g.operation}` === pair && g.allowed);
      if (!allowed) expect(await as(at(`provider-permissions/${pair}`), {allowed: true}), [200], `Permission ${pair}`);
      report(!allowed, `provider permission ${pair}`);
    }
  }

  const draft = expect(await as(at('configuration')), [200], 'Configuration');
  const current = expect(await as(at(`configuration/versions/${draft.published_version}`)), [200], 'Published configuration');
  const same = isDeepStrictEqual(current.document, configuration);
  if (!same) {
    const saved = expect(await as(at('configuration'), {text: JSON.stringify(configuration, null, 2), revision: draft.revision}), [200], 'Configuration draft');
    if (saved.validation.errors.length || saved.validation.blockers.length) throw new Error(`Demo configuration invalid: ${JSON.stringify(saved.validation)}`);
    const published = expect(await as(at('configuration/publish'), {revision: saved.revision}), [201], 'Configuration publication');
    console.log(`Created: published configuration version ${published.version} (${configuration.generation.mode})`);
  } else report(false, `published configuration version ${draft.published_version} (${configuration.generation.mode})`);

  // Ingestion and the help-site crawl run in the worker; report what became usable.
  for (let attempt = 0; attempt < 360; attempt++) {
    const states = (expect(await as(at('sources')), [200], 'Source listing') as {ref: string, latest: {state: string}}[]);
    if (states.every(s => !['queued', 'running'].includes(s.latest.state))) {
      for (const s of states as any[]) console.log(`Knowledge ${s.ref}: ${s.active ? `active, ${s.active.passages} passages` : 'not usable'}${s.warning ? ` (${s.warning})` : ''}`);
      break;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  console.log(`Demo ready in ${configuration.generation.mode} mode. Shop: ${demo.shop}/?business=${business}`);
  console.log(`Operator app: ${origin} (Owner ${owner.email}; Support ${support.email})`);
} finally {
  await lock.query('SELECT pg_advisory_unlock_all()').catch(() => {});
  lock.release();
  await pool.end();
}
