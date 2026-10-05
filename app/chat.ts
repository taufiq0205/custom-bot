import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PoolClient } from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { errors, importJWK, jwtVerify } from 'jose';
import { changeMemory, readMemory } from './memory.js';
import { origin as platform, pool } from './config.js';
import { body, Failure, keys, message as submitted, uuid, verifier } from './memberships.js';
const route=new RegExp(`^/api/chat/(${uuid})/(?:(identity|logout)|conversations(?:/(${uuid})(/messages|/handoff|/memory)?)?)$`);
const conversationColumns='c.id,c.control_state,c.configuration_version,p.document->\'generation\'->>\'mode\' AS mode';
export type Session={id:string,customer_id:string|null};
const expired=()=>new Failure(401,'Chat session expired; start a new conversation');
const rejected=()=>new Failure(401,'Identity assertion rejected');
// Logout/switch end a session; a verified session also ends when its assertion expires.
async function current(client:PoolClient,business:string,token:string,lock='') {
  return (await client.query(`SELECT id,customer_id FROM chat_sessions WHERE business_id=$1 AND token_verifier=$2
    AND ended_at IS NULL AND (expires_at IS NULL OR expires_at>clock_timestamp()) ${lock}`,[business,verifier(token)])).rows[0] as Session|undefined;
}
// A verified session reaches its Customer's conversations; an anonymous session only its own anonymous ones.
const owned='c.business_id=$1 AND (c.customer_id=$2 OR ($2::uuid IS NULL AND c.customer_id IS NULL AND c.session_id=$3))';
const scope=(business:string,session:Session)=>[business,session.customer_id,session.id];
export async function conversation(client:PoolClient,business:string,session:Session,id:string) {
  // Messages first: a turn's outcome and its control change commit together, so a settled message guarantees the later read
  // shows that control state (the reverse order could pair a failed turn with the state from before it).
  // Operator identities and submission IDs stay internal.
  const messages=await client.query(`SELECT m.id,m.author,m.text,m.simulated,CASE WHEN m.author='customer' THEN m.client_submission_id END AS client_submission_id,
    m.reply_to,m.turn_state,m.citations,m.created_at FROM messages m JOIN conversations c ON c.id=m.conversation_id
    WHERE ${owned} AND m.business_id=$1 AND c.id=$4 ORDER BY m.seq`,[...scope(business,session),id]);
  const found=await client.query(`SELECT ${conversationColumns} FROM conversations c JOIN published_configurations p ON p.business_id=c.business_id AND p.version=c.configuration_version
    WHERE ${owned} AND c.id=$4`,[...scope(business,session),id]);
  if(!found.rowCount)throw new Failure(404,'Conversation not found');
  return {...found.rows[0],messages:messages.rows};
}
export async function open(client:PoolClient,business:string,customer?:{id:string,kid:string,exp:number}) {
  const token=randomBytes(32).toString('hex'),id=randomUUID();
  await client.query('INSERT INTO chat_sessions(id,business_id,token_verifier,customer_id,signing_kid,expires_at) VALUES($1,$2,$3,$4,$5,to_timestamp($6))',
    [id,business,verifier(token),customer?.id??null,customer?.kid??null,customer?.exp??null]);
  return {token,session:{id,customer_id:customer?.id??null}};
}
// New conversations pin the Business's current published configuration.
export async function start(client:PoolClient,business:string,session:Session,preview=false) {
  const id=randomUUID();
  await client.query(`INSERT INTO conversations(id,business_id,session_id,customer_id,configuration_version,preview)
    SELECT $1,$2,$3,$4,max(version),$5 FROM published_configurations WHERE business_id=$2`,[id,business,session.id,session.customer_id,preview]);
  return id;
}
// Lock the conversation first: every turn and control transition takes this lock before its own checks.
async function lock(client:PoolClient,business:string,session:Session,id:string) {
  const locked=await client.query(`SELECT c.execution_generation,c.control_state,c.assignee_id FROM conversations c WHERE ${owned} AND c.id=$4 FOR UPDATE`,[...scope(business,session),id]);
  if(!locked.rowCount)throw new Failure(404,'Conversation not found');
  return locked.rows[0] as {execution_generation:string,control_state:string,assignee_id:string|null};
}
// A resolved conversation reopens under human control with its assignee, or returns to the queue if that Membership has ended.
// The share lock makes a concurrent revocation wait, so it then releases this conversation too.
async function reopen(client:PoolClient,business:string,id:string,assignee:string) {
  const active=(await client.query('SELECT 1 FROM memberships WHERE business_id=$1 AND operator_id=$2 AND active FOR SHARE',[business,assignee])).rowCount;
  await client.query(`UPDATE conversations SET control_state=$2,assignee_id=$3 WHERE id=$1`,[id,active?'human-controlled':'waiting-for-support',active?assignee:null]);
}
// The website's backend signs a JWT (ES256 only) with a key the Owner registered; see docs/customer-identity.md.
async function verify(business:string,assertion:string) {
  let key:{issuer:string,public_jwk:object}|undefined;
  try {
    const {payload,protectedHeader}=await jwtVerify(assertion,async header=>{
      key=typeof header.kid==='string'?(await pool.query('SELECT issuer,public_jwk FROM customer_signing_keys WHERE business_id=$1 AND kid=$2',[business,header.kid])).rows[0]:undefined;
      if(!key)throw rejected();
      return importJWK(key.public_jwk,'ES256');
    },{algorithms:['ES256'],audience:platform,requiredClaims:['iss','aud','sub','iat','exp','jti'],maxTokenAge:3600,clockTolerance:5});
    // jose has checked the signature, alg, aud, exp/nbf and that iat is past and under an hour old.
    const {sub,jti,iat,exp}=payload as {sub:unknown,jti:unknown,iat:number,exp:number};
    if(payload.iss!==key!.issuer||payload.business_id!==business||typeof sub!=='string'||!sub||sub.length>200
      ||typeof jti!=='string'||!jti||jti.length>200||exp-iat>3600)throw rejected();
    return {sub,jti,exp,kid:protectedHeader.kid as string,jwk:key!.public_jwk};
  } catch(error) {
    if(error instanceof errors.JOSEError||error instanceof Failure)throw rejected();
    throw error;
  }
}
// One Customer message in the caller's transaction, after its session check: a new message queues a turn (status 202);
// a retried submission returns the original (200) and never enqueues new work.
export async function submit(client:PoolClient,business:string,session:Session,id:string,submission:string,text:string):Promise<[number,unknown]> {
  const locked=await lock(client,business,session,id);
  const automated=locked.control_state==='automated';
  const columns='id,client_submission_id,text,turn_state,created_at';
  // Under human control the message waits for support and never starts an automated turn.
  const inserted=await client.query(`INSERT INTO messages(id,business_id,conversation_id,author,text,client_submission_id,turn_state,session_id)
    VALUES($1,$2,$3,'customer',$4,$5,$7,$6) ON CONFLICT(conversation_id,client_submission_id) DO NOTHING RETURNING ${columns}`,[randomUUID(),business,id,text,submission,session.id,automated?'queued':'human']);
  if(!inserted.rowCount) {
    // A retried submission returns the original message whatever its turn state.
    const existing=(await client.query(`SELECT ${columns} FROM messages WHERE conversation_id=$1 AND client_submission_id=$2 AND author='customer'`,[id,submission])).rows[0];
    if(existing?.text!==text)throw new Failure(409,'Submission ID already used for a different message');
    return [200,existing];
  }
  const message=inserted.rows[0];
  if(locked.control_state==='resolved')await reopen(client,business,id,locked.assignee_id!);
  if(automated)await client.query(`INSERT INTO jobs(id,business_id,kind,conversation_id,message_id,idempotency_key,execution_generation,deadline)
    VALUES($1,$2,'turn',$3,$4,$5,$6,clock_timestamp()+interval '60 seconds')`,[randomUUID(),business,id,message.id,`turn:${message.id}`,locked.execution_generation]);
  await client.query('UPDATE conversations SET last_message_at=clock_timestamp() WHERE id=$1',[id]);
  return [202,message];
}
// Customer chat runs on Business websites: authority is the session bearer token plus an approved Origin, never cookies.
export async function chat(req:IncomingMessage,res:ServerResponse,path:string,json:(status:number,value:unknown)=>void) {
  if(!path.startsWith('/api/chat/'))return false;
  const reply=(status:number,value:unknown)=>{json(status,value);return true;};
  const match=path.match(route);
  const origin=req.headers.origin;
  if(!match||!origin||!(await pool.query('SELECT 1 FROM website_origins WHERE business_id=$1 AND origin=$2',[match[1],origin])).rowCount)
    return reply(403,{error:'Website origin not approved'});
  res.setHeader('Access-Control-Allow-Origin',origin);
  res.setHeader('Vary','Origin');
  if(req.method==='OPTIONS') {
    res.writeHead(204,{'Access-Control-Allow-Methods':'GET, POST','Access-Control-Allow-Headers':'authorization, content-type','Access-Control-Max-Age':'600'});
    res.end();return true;
  }
  const [,business,action,id,messages]=match;
  let client:PoolClient|undefined;
  try {
    const input=req.method==='POST'?await body(req,16384):null;
    const token=req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    if(req.headers.authorization!==undefined&&!token)throw expired();
    // Verify before taking a pooled client: verification itself queries the pool.
    let identity;
    if(action==='identity'&&req.method==='POST') {
      keys(input,['assertion']);
      if(typeof input.assertion!=='string'||input.assertion.length>8192)throw new Failure(400,'Provide assertion');
      identity=await verify(business,input.assertion);
    }
    client=await pool.connect();
    if(identity) {
      await client.query('BEGIN');
      // The verifying key must still be registered at commit; key removal waits on this lock, then ends the new session too.
      if(!(await client.query('SELECT 1 FROM customer_signing_keys WHERE business_id=$1 AND kid=$2 AND public_jwk=$3 FOR SHARE',[business,identity.kid,identity.jwk])).rowCount)throw rejected();
      if(!(await client.query('INSERT INTO customer_assertions(business_id,jti,expires_at) VALUES($1,$2,to_timestamp($3)) ON CONFLICT DO NOTHING',[business,identity.jti,identity.exp])).rowCount)
        throw rejected();
      // The row lock serializes identity changes on one session; a racing request re-reads the rotated/ended row and fails.
      const presented=token?await current(client,business,token,'FOR UPDATE'):undefined;
      if(token&&!presented)throw expired();
      const customer=(await client.query(`INSERT INTO customers(id,business_id,external_id) VALUES($1,$2,$3)
        ON CONFLICT(business_id,external_id) DO UPDATE SET external_id=EXCLUDED.external_id RETURNING id`,[randomUUID(),business,identity.sub])).rows[0].id;
      const verified={id:customer,kid:identity.kid,exp:identity.exp};
      let issued,session:Session,conversationId:string|undefined;
      if(presented&&(presented.customer_id===null||presented.customer_id===customer)) {
        // Sign-in or refresh keeps the session, so its in-flight turns continue; only its latest conversation links.
        if(presented.customer_id===null)await client.query(`UPDATE conversations SET customer_id=$3 WHERE id=(SELECT id FROM conversations
          WHERE business_id=$1 AND session_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1) AND customer_id IS NULL`,[business,presented.id,customer]);
        issued=randomBytes(32).toString('hex');
        await client.query('UPDATE chat_sessions SET token_verifier=$2,customer_id=$3,signing_kid=$4,expires_at=to_timestamp($5) WHERE id=$1',
          [presented.id,verifier(issued),customer,identity.kid,identity.exp]);
        session={id:presented.id,customer_id:customer};
        conversationId=(await client.query(`SELECT id FROM conversations WHERE business_id=$1 AND session_id=$2 AND customer_id=$3
          ORDER BY created_at DESC,id DESC LIMIT 1`,[business,presented.id,customer])).rows[0]?.id;
      } else {
        // A different Customer on this browser: the previous identity ends and nothing of it carries over.
        if(presented)await client.query('UPDATE chat_sessions SET ended_at=clock_timestamp() WHERE id=$1',[presented.id]);
        ({token:issued,session}=await open(client,business,verified));
      }
      conversationId??=await start(client,business,session);
      await client.query('COMMIT');
      return reply(200,{token:issued,verified:true,expires_at:new Date(identity.exp*1000).toISOString(),conversation:await conversation(client,business,session,conversationId)});
    }
    if(action==='logout'&&req.method==='POST') {
      keys(input,[]);
      if(!token)throw new Failure(401,'Chat session required');
      await client.query('BEGIN');
      const presented=await current(client,business,token,'FOR UPDATE');
      if(!presented)throw expired();
      await client.query('UPDATE chat_sessions SET ended_at=clock_timestamp() WHERE id=$1',[presented.id]);
      const {token:issued,session}=await open(client,business);
      const conversationId=await start(client,business,session);
      await client.query('COMMIT');
      return reply(200,{token:issued,verified:false,conversation:await conversation(client,business,session,conversationId)});
    }
    if(action)throw new Failure(404,'Not found');
    const session=token?await current(client,business,token):undefined;
    if(token&&!session)throw expired();
    if(!id&&req.method==='POST') {
      keys(input,[]);
      await client.query('BEGIN');
      const created=session?{token:undefined,session}:await open(client,business);
      const conversationId=await start(client,business,created.session);
      await client.query('COMMIT');
      return reply(201,{...(created.token?{token:created.token}:{}),conversation:await conversation(client,business,created.session,conversationId)});
    }
    if(!session)throw new Failure(401,'Chat session required');
    if(!id&&req.method==='GET') {
      const list=await client.query(`SELECT c.id,c.control_state,c.configuration_version,c.created_at FROM conversations c
        WHERE ${owned} ORDER BY c.created_at,c.id`,scope(business,session));
      return reply(200,list.rows);
    }
    if(id&&messages==='/memory'&&['GET','POST'].includes(req.method!)) {
      await client.query('BEGIN');
      const verified=await current(client,business,token!,'FOR SHARE');
      if(!verified?.customer_id)throw new Failure(401,'Currently verified Customer required for memory');
      await lock(client,business,verified,id);
      if(req.method==='POST'&&input.action==='enable') {
        const latest=(await client.query('SELECT id FROM conversations WHERE business_id=$1 AND session_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',[business,verified.id])).rows[0];
        if(latest?.id!==id)throw new Failure(409,'Opt in from the current linked conversation; older history is not eligible');
      }
      const result=req.method==='POST'?await changeMemory(client,business,verified.customer_id,id,input):await readMemory(client,business,verified.customer_id);
      await client.query('COMMIT');return reply(200,result);
    }
    if(id&&!messages&&req.method==='GET')return reply(200,await conversation(client,business,session,id));
    if(!(id&&messages&&req.method==='POST'))throw new Failure(404,'Not found');
    if(messages==='/handoff') {
      keys(input,[]);
      await client.query('BEGIN');
      if(!await current(client,business,token!,'FOR SHARE'))throw expired();
      const locked=await lock(client,business,session,id);
      // Asking again while support already has the conversation changes nothing.
      if(locked.control_state==='automated')await client.query(`UPDATE conversations SET control_state='waiting-for-support',handoff_reason='customer-request' WHERE id=$1`,[id]);
      if(locked.control_state==='resolved')await reopen(client,business,id,locked.assignee_id!);
      await client.query('COMMIT');
      return reply(200,await conversation(client,business,session,id));
    }
    const {submission,text}=submitted(input);
    await client.query('BEGIN');
    // Recheck the session under a share lock so logout/switch and this submission serialize.
    if(!await current(client,business,token!,'FOR SHARE'))throw expired();
    const [status,message]=await submit(client,business,session,id,submission,text);
    await client.query('COMMIT');
    return reply(status,{message});
  } catch(error) {
    await client?.query('ROLLBACK');
    if(error instanceof Failure)return reply(error.status,{error:error.message});
    throw error;
  } finally {client?.release();}
}
