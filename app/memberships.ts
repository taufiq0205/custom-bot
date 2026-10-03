import type { IncomingMessage } from 'node:http';
import type { PoolClient } from 'pg';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { pool, mode } from './config.js';
import { mail } from './auth.js';
import { importJWK } from 'jose';
export const uuid='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ttl=mode==='test' ? Number(process.env.TEST_INVITATION_TTL ?? 604800) : 604800;
if (!Number.isInteger(ttl) || ttl<1 || ttl>604800) throw new Error('Invalid invitation TTL');
export const verifier=(token:string)=>createHash('sha256').update(token).digest('hex');
export class Failure extends Error {constructor(public status:number,message:string){super(message);}}
export async function body(req:IncomingMessage,limit=4096) {
  if(req.headers['content-type']?.split(';')[0].trim()!=='application/json') throw new Failure(415,'JSON required');
  req.setEncoding('utf8');let raw='';
  for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>limit)throw new Failure(413,'Request too large');}
  try {const value=JSON.parse(raw);if(!value||Array.isArray(value)||typeof value!=='object')throw 0;return value;}
  catch {throw new Failure(400,'Invalid JSON object');}
}
export function keys(value:Record<string,unknown>,expected:string[]) {
  if(Object.keys(value).length!==expected.length || expected.some(k=>!(k in value))) throw new Failure(400,'Unexpected or missing fields');
}
export async function memberships(req:IncomingMessage,path:string,user:{id:string,email:string},json:(status:number,value:unknown)=>void) {
  const match=path.match(new RegExp(`^/api/businesses/(${uuid})/(memberships|invitations|website-origins|customer-keys)(?:/([^/]+))?$`));
  const accept=path==='/api/invitations/accept';
  if(!match&&!accept)return false;
  let client:PoolClient|undefined;
  try {
    const input=req.method==='POST'?await body(req):null;
    client=await pool.connect();
    await client.query('BEGIN');
    if(accept && req.method==='POST') {
      keys(input,['token']);
      if(typeof input.token!=='string'||!/^[a-f0-9]{64}$/.test(input.token))throw new Failure(404,'Invitation unavailable');
      // Discover only the lock key; recheck all permissions and expiry after taking it.
      const lookup=await client.query('SELECT business_id FROM invitations WHERE token_verifier=$1 AND email=$2',[verifier(input.token),user.email.toLowerCase()]);
      if(!lookup.rowCount)throw new Failure(404,'Invitation unavailable');
      const business=lookup.rows[0].business_id;
      await client.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE',[business]);
      const invite=await client.query(`UPDATE invitations i SET consumed_at=clock_timestamp()
        WHERE i.token_verifier=$1 AND i.email=$2 AND i.consumed_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>clock_timestamp()
        AND EXISTS(SELECT 1 FROM memberships m WHERE m.business_id=i.business_id AND m.operator_id=i.inviter_id AND m.active AND m.role='Owner')
        RETURNING i.business_id,i.role`,[verifier(input.token),user.email.toLowerCase()]);
      if(!invite.rowCount)throw new Failure(404,'Invitation unavailable');
      const member=await client.query(`INSERT INTO memberships(business_id,operator_id,role) VALUES($1,$2,$3)
        ON CONFLICT(business_id,operator_id) DO UPDATE SET active=true,role=EXCLUDED.role,revision=memberships.revision+1
        WHERE NOT memberships.active RETURNING role`,[business,user.id,invite.rows[0].role]);
      if(!member.rowCount)throw new Failure(409,'Already an active Member');
      await client.query('COMMIT');json(200,{business_id:business,role:member.rows[0].role});return true;
    }
    if(!match)throw new Failure(404,'Not found');
    const [,business,resource,target]=match;
    // Every privileged operation derives authority from the CURRENT Membership in this Business.
    // NO KEY UPDATE still serializes Business administration, but lets chat's foreign-key checks proceed (no deadlock with key removal).
    await client.query('SELECT id FROM businesses WHERE id=$1 FOR NO KEY UPDATE',[business]);
    const owner=await client.query("SELECT 1 FROM memberships WHERE business_id=$1 AND operator_id=$2 AND active AND role='Owner'",[business,user.id]);
    if(!owner.rowCount)throw new Failure(404,'Business not found');
    let result;
    if(resource==='memberships' && !target && req.method==='GET') {
      result=await client.query('SELECT m.operator_id,u.email,m.role,m.active,m.revision FROM memberships m JOIN "user" u ON u.id=m.operator_id WHERE m.business_id=$1 ORDER BY u.email',[business]);
    } else if(resource==='memberships' && target && req.method==='POST') {
      keys(input,['role','active','revision']);
      if(!['Owner','Support'].includes(input.role)||typeof input.active!=='boolean'||typeof input.revision!=='string'||!/^\d+$/.test(input.revision))throw new Failure(400,'Invalid Membership update');
      const existing=await client.query('SELECT revision FROM memberships WHERE business_id=$1 AND operator_id=$2',[business,target]);
      if(!existing.rowCount)throw new Failure(404,'Membership not found');
      if(existing.rows[0].revision!==input.revision)throw new Failure(409,'Membership changed; reload before updating');
      result=await client.query('UPDATE memberships SET role=$3,active=$4,revision=revision+1 WHERE business_id=$1 AND operator_id=$2 RETURNING operator_id,role,active,revision',[business,target,input.role,input.active]);
      if(!input.active || input.role!=='Owner')await client.query('UPDATE invitations SET revoked_at=clock_timestamp() WHERE business_id=$1 AND inviter_id=$2 AND consumed_at IS NULL AND revoked_at IS NULL',[business,target]);
      if(!input.active)await client.query('UPDATE invitations SET revoked_at=clock_timestamp() WHERE business_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL AND email=(SELECT lower(email) FROM "user" WHERE id=$2)',[business,target]);
    } else if(resource==='invitations' && !target && req.method==='GET') {
      result=await client.query('SELECT id,email,role,expires_at,consumed_at,revoked_at FROM invitations WHERE business_id=$1 ORDER BY created_at,id',[business]);
    } else if(resource==='invitations' && !target && req.method==='POST') {
      keys(input,['email','role']);
      if(typeof input.email!=='string'||input.email.length>254||!/^\S+@[^\s@]+\.[^\s@]+$/.test(input.email)||!['Owner','Support'].includes(input.role))throw new Failure(400,'Valid email and Owner/Support role required');
      const email=input.email.toLowerCase();
      const token=randomBytes(32).toString('hex'),id=randomUUID();
      // Superseding invitations invalidate older grants for this email.
      await client.query('UPDATE invitations SET revoked_at=clock_timestamp() WHERE business_id=$1 AND email=$2 AND consumed_at IS NULL AND revoked_at IS NULL',[business,email]);
      await client.query("INSERT INTO invitations(id,business_id,email,role,token_verifier,expires_at,inviter_id) VALUES($1,$2,$3,$4,$5,clock_timestamp()+$6*interval '1 second',$7)",[id,business,email,input.role,verifier(token),ttl,user.id]);
      await mail.sendMail({from:process.env.MAIL_FROM??'support@example.test',to:email,subject:'Business invitation',text:`An Owner invited you as ${input.role}. Sign in with this verified email, then accept in the Operator app.\nInvitation token: ${token}\nExpires in ${ttl} seconds. Use once.`});
      await client.query('COMMIT');json(201,{id,email,role:input.role});return true;
    } else if(resource==='invitations' && target && req.method==='POST' && new RegExp(`^${uuid}$`).test(target)) {
      keys(input,[]);
      result=await client.query('UPDATE invitations SET revoked_at=clock_timestamp() WHERE business_id=$1 AND id=$2 AND consumed_at IS NULL AND revoked_at IS NULL RETURNING id',[business,target]);
      if(!result.rowCount)throw new Failure(404,'Invitation unavailable');
    } else if(resource==='website-origins' && !target && req.method==='GET') {
      const origins=await client.query('SELECT origin FROM website_origins WHERE business_id=$1 ORDER BY origin',[business]);
      await client.query('COMMIT');json(200,origins.rows.map(r=>r.origin));return true;
    } else if(resource==='website-origins' && !target && req.method==='POST') {
      // Per-origin approve/withdraw cannot lose a concurrent Owner's change, so no revision is needed.
      keys(input,['origin','approved']);
      if(typeof input.origin!=='string'||input.origin.length>200||typeof input.approved!=='boolean')throw new Failure(400,'Provide origin and approved');
      let parsed;try{parsed=new URL(input.origin);}catch{throw new Failure(400,'Website origin must look like https://shop.example.com');}
      if(parsed.origin!==input.origin||!(mode==='hosted'?['https:']:['https:','http:']).includes(parsed.protocol))throw new Failure(400,'Website origin must look like https://shop.example.com');
      await client.query(input.approved?'INSERT INTO website_origins(business_id,origin) VALUES($1,$2) ON CONFLICT DO NOTHING':'DELETE FROM website_origins WHERE business_id=$1 AND origin=$2',[business,input.origin]);
      result={rows:[{origin:input.origin,approved:input.approved}]};
    } else if(resource==='customer-keys' && !target && req.method==='GET') {
      const listed=await client.query('SELECT kid,issuer,public_jwk AS public_key,created_at FROM customer_signing_keys WHERE business_id=$1 ORDER BY created_at,kid',[business]);
      await client.query('COMMIT');json(200,listed.rows);return true;
    } else if(resource==='customer-keys' && !target && req.method==='POST') {
      // Only a P-256 public key is accepted: the website keeps its private key, and keys never change (rotate with a new kid).
      keys(input,['kid','issuer','public_key']);
      const jwk=input.public_key;
      if(typeof input.kid!=='string'||!/^[A-Za-z0-9._-]{1,100}$/.test(input.kid)||typeof input.issuer!=='string'||!input.issuer||input.issuer.length>200
        ||!jwk||typeof jwk!=='object'||Object.keys(jwk).sort().join()!=='crv,kty,x,y'||jwk.kty!=='EC'||jwk.crv!=='P-256'||typeof jwk.x!=='string'||typeof jwk.y!=='string')
        throw new Failure(400,'Provide kid, issuer and an EC P-256 public JWK (kty, crv, x, y only)');
      try {await importJWK(jwk,'ES256');} catch {throw new Failure(400,'Public key is not a valid P-256 point');}
      result=await client.query('INSERT INTO customer_signing_keys(business_id,kid,issuer,public_jwk) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING kid,issuer',[business,input.kid,input.issuer,{kty:'EC',crv:'P-256',x:jwk.x,y:jwk.y}]);
      if(!result.rowCount)throw new Failure(409,'Key ID already registered; register a new kid to rotate');
      await client.query('COMMIT');json(201,result.rows[0]);return true;
    } else if(resource==='customer-keys' && target && req.method==='POST') {
      // Removing a key also ends the Customer sessions it verified.
      keys(input,[]);
      result=await client.query('DELETE FROM customer_signing_keys WHERE business_id=$1 AND kid=$2 RETURNING kid',[business,target]);
      if(!result.rowCount)throw new Failure(404,'Key not found');
      await client.query('UPDATE chat_sessions SET ended_at=clock_timestamp() WHERE business_id=$1 AND signing_kid=$2 AND ended_at IS NULL',[business,target]);
    } else throw new Failure(404,'Not found');
    await client.query('COMMIT');json(200,target||resource==='website-origins'?result.rows[0]:result.rows);return true;
  } catch(error) {
    await client?.query('ROLLBACK');
    if(error instanceof Failure){json(error.status,{error:error.message});return true;}
    if((error as {code?:string}).code==='23514'){json(409,{error:'Keep at least one active Owner'});return true;}
    throw error;
  } finally {client?.release();}
}
