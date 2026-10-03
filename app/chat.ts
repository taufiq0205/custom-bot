import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PoolClient } from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { pool } from './config.js';
import { body, Failure, keys, uuid, verifier } from './memberships.js';
const route=new RegExp(`^/api/chat/(${uuid})/conversations(?:/(${uuid})(/messages)?)?$`);
const conversationColumns='c.id,c.control_state,c.configuration_version,p.document->\'generation\'->>\'mode\' AS mode';
async function conversation(client:PoolClient,business:string,session:string,id:string) {
  const found=await client.query(`SELECT ${conversationColumns} FROM conversations c JOIN published_configurations p ON p.business_id=c.business_id AND p.version=c.configuration_version
    WHERE c.business_id=$1 AND c.session_id=$2 AND c.id=$3`,[business,session,id]);
  if(!found.rowCount)throw new Failure(404,'Conversation not found');
  const messages=await client.query(`SELECT id,author,text,simulated,client_submission_id,reply_to,turn_state,created_at FROM messages
    WHERE business_id=$1 AND conversation_id=$2 ORDER BY seq`,[business,id]);
  return {...found.rows[0],messages:messages.rows};
}
// Customer chat runs on Business websites: authority is the anonymous bearer token plus an approved Origin, never cookies.
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
  const [,business,id,messages]=match;
  let client:PoolClient|undefined;
  try {
    const input=req.method==='POST'?await body(req,16384):null;
    const token=req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    if(req.headers.authorization!==undefined&&!token)throw new Failure(401,'Chat session expired; start a new conversation');
    const session=token?(await pool.query('SELECT id FROM chat_sessions WHERE business_id=$1 AND token_verifier=$2',[business,verifier(token)])).rows[0]?.id:undefined;
    if(token&&!session)throw new Failure(401,'Chat session expired; start a new conversation');
    client=await pool.connect();
    if(!id&&req.method==='POST') {
      keys(input,[]);
      const issued=session?undefined:randomBytes(32).toString('hex');
      const conversationId=randomUUID();
      await client.query('BEGIN');
      const sessionId=session??randomUUID();
      if(issued)await client.query('INSERT INTO chat_sessions(id,business_id,token_verifier) VALUES($1,$2,$3)',[sessionId,business,verifier(issued)]);
      // New conversations pin the Business's current published configuration.
      await client.query(`INSERT INTO conversations(id,business_id,session_id,configuration_version)
        SELECT $1,$2,$3,max(version) FROM published_configurations WHERE business_id=$2`,[conversationId,business,sessionId]);
      await client.query('COMMIT');
      return reply(201,{...(issued?{token:issued}:{}),conversation:await conversation(client,business,sessionId,conversationId)});
    }
    if(!session)throw new Failure(401,'Chat session required');
    if(!id&&req.method==='GET') {
      const list=await client.query(`SELECT c.id,c.control_state,c.configuration_version,c.created_at FROM conversations c
        WHERE c.business_id=$1 AND c.session_id=$2 ORDER BY c.created_at,c.id`,[business,session]);
      return reply(200,list.rows);
    }
    if(id&&!messages&&req.method==='GET')return reply(200,await conversation(client,business,session,id));
    if(!(id&&messages&&req.method==='POST'))throw new Failure(404,'Not found');
    keys(input,['client_submission_id','text']);
    const submission=input.client_submission_id,text=typeof input.text==='string'?input.text.trim():null;
    if(typeof submission!=='string'||!/^[A-Za-z0-9_-]{8,100}$/.test(submission)||!text||text.length>2000)
      throw new Failure(400,'Provide client_submission_id (8–100 letters, digits, - or _) and text (1–2000 characters)');
    await client.query('BEGIN');
    // Lock the conversation first: every turn transition takes this lock before its own checks.
    const locked=await client.query('SELECT execution_generation FROM conversations WHERE business_id=$1 AND session_id=$2 AND id=$3 FOR UPDATE',[business,session,id]);
    if(!locked.rowCount)throw new Failure(404,'Conversation not found');
    const columns='id,client_submission_id,text,turn_state,created_at';
    const inserted=await client.query(`INSERT INTO messages(id,business_id,conversation_id,author,text,client_submission_id,turn_state)
      VALUES($1,$2,$3,'customer',$4,$5,'queued') ON CONFLICT(conversation_id,client_submission_id) DO NOTHING RETURNING ${columns}`,[randomUUID(),business,id,text,submission]);
    if(!inserted.rowCount) {
      // A retried submission returns the original message whatever its turn state; it never enqueues new work.
      const existing=(await client.query(`SELECT ${columns} FROM messages WHERE conversation_id=$1 AND client_submission_id=$2`,[id,submission])).rows[0];
      if(existing.text!==text)throw new Failure(409,'Submission ID already used for a different message');
      await client.query('COMMIT');
      return reply(200,{message:existing});
    }
    const message=inserted.rows[0];
    await client.query(`INSERT INTO jobs(id,business_id,kind,conversation_id,message_id,idempotency_key,execution_generation,deadline)
      VALUES($1,$2,'turn',$3,$4,$5,$6,clock_timestamp()+interval '60 seconds')`,[randomUUID(),business,id,message.id,`turn:${message.id}`,locked.rows[0].execution_generation]);
    await client.query('UPDATE conversations SET last_message_at=clock_timestamp() WHERE id=$1',[id]);
    await client.query('COMMIT');
    return reply(202,{message});
  } catch(error) {
    await client?.query('ROLLBACK');
    if(error instanceof Failure)return reply(error.status,{error:error.message});
    throw error;
  } finally {client?.release();}
}
