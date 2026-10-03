import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import { auth, mail } from './auth.js';
import { origin, pool } from './config.js';
import { memberships } from './memberships.js';
import { chat } from './chat.js';
import { configuration } from './configuration.js';
const authHandler = toNodeHandler(auth);
const endpoints = new Set(['sign-up/email','sign-in/email','sign-out','get-session','email-otp/send-verification-otp','email-otp/verify-email','email-otp/request-password-reset','email-otp/reset-password']);
createServer(async (req,res) => {
  const path = new URL(req.url ?? '/', origin).pathname;
  const json = (status: number, value: unknown) => {res.writeHead(status, {'content-type':'application/json'}); res.end(JSON.stringify(value));};
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    if (path === '/health/ready' && req.method === 'GET') {
      try {
        const worker = await pool.query("SELECT 1 FROM worker_health WHERE id='worker' AND heartbeat > now()-interval '10 seconds'");
        if (!worker.rowCount) return json(503,{error:'Worker unavailable; inspect worker service logs'});
        await pool.query('SELECT 1 FROM businesses LIMIT 1');
        await mail.verify();
        return json(200,{status:'ready', app:'ok', database:'ok', worker:'ok', mail:'ok', generation:'simulation'});
      } catch {return json(503,{error:'Database/migrations or mail unavailable; inspect db, migrate and mail services'});}
    }
    // Website chat enforces each Business's approved origins instead of the Operator app origin.
    if (await chat(req,res,path,json)) return;
    if (!['GET','HEAD'].includes(req.method ?? '') && req.headers.origin !== origin) return json(403,{error:'Same-origin request required'});
    if (path.startsWith('/api/auth/')) {
      if (!endpoints.has(path.slice('/api/auth/'.length))) return json(404,{error:'Not found'});
      return await authHandler(req,res);
    }
    if (path === '/api/businesses' || path.startsWith('/api/businesses/') || path === '/api/invitations/accept') {
      const session = await auth.api.getSession({headers:fromNodeHeaders(req.headers)});
      if (!session?.user.emailVerified) return json(401,{error:'Verified Operator sign-in required'});
      if (await memberships(req,path,session.user,json)) return;
      if (await configuration(req,path,session.user,json)) return;
      if (path === '/api/businesses' && req.method === 'GET') {
        const result = await pool.query('SELECT b.id,b.name,m.role FROM businesses b JOIN memberships m ON m.business_id=b.id WHERE m.operator_id=$1 AND m.active=true ORDER BY b.created_at,b.id', [session.user.id]);
        return json(200,result.rows);
      }
      if (path === '/api/businesses' && req.method === 'POST') {
        if (!(req.headers['content-type']?.split(';')[0].trim() === 'application/json')) return json(415,{error:'JSON required'});
        req.setEncoding('utf8');
        let raw = '';
        for await (const chunk of req) {raw += chunk; if (Buffer.byteLength(raw)>4096) return json(413,{error:'Request too large'});}
        let body;
        try {body=JSON.parse(raw);} catch {return json(400,{error:'Invalid JSON'});}
        if (!body || Object.keys(body).length!==1 || typeof body.name!=='string' || !body.name.trim() || body.name.trim().length>120) return json(400,{error:'Provide only a name (1–120 characters)'});
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const id = randomUUID();
          await client.query('INSERT INTO businesses(id,name) VALUES($1,$2)', [id,body.name.trim()]);
          await client.query("INSERT INTO memberships(business_id,operator_id,role) VALUES($1,$2,'Owner')", [id,session.user.id]);
          await client.query('COMMIT');
          return json(201,{id,name:body.name.trim(),role:'Owner'});
        } catch (error) {await client.query('ROLLBACK'); throw error;} finally {client.release();}
      }
      const id = path.slice('/api/businesses/'.length);
      if (req.method==='GET' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
        const result = await pool.query('SELECT b.id,b.name,m.role FROM businesses b JOIN memberships m ON m.business_id=b.id WHERE b.id=$1 AND m.operator_id=$2 AND m.active=true', [id,session.user.id]);
        return result.rowCount ? json(200,result.rows[0]) : json(404,{error:'Business not found'});
      }
      return json(404,{error:'Not found'});
    }
    const files: Record<string,string> = {'/':'index.html','/ui.js':'ui.js','/style.css':'style.css','/widget.js':'widget.js'};
    if (req.method==='GET' && files[path]) {
      res.setHeader('Content-Type', path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html');
      return res.end(await readFile(`app/public/${files[path]}`));
    }
    json(404,{error:'Not found'});
  } catch {console.error('Request failed; check service readiness'); if (!res.headersSent) json(500,{error:'Operation failed; check service readiness'}); else res.end();}
}).listen(3000,'0.0.0.0',()=>console.log('Operator app listening on port 3000'));
