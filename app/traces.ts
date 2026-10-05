import type { IncomingMessage } from 'node:http';
import type { PoolClient } from 'pg';
import { pool } from './config.js';
import { conversation, open, start, submit, type Session } from './chat.js';
import { body, Failure, keys, message, uuid } from './memberships.js';
const route=new RegExp(`^/api/businesses/(${uuid})/(preview|traces)(?:/(${uuid})(/messages)?)?$`);
const pinned=`c.id,c.preview,c.configuration_version,p.document->'generation'->>'mode' AS mode,c.control_state`;
// A preview conversation's anonymous session; its bearer token was never issued, so only this Owner API reaches it.
async function previewSession(client:PoolClient,business:string,id:string):Promise<Session> {
  const found=await client.query('SELECT session_id FROM conversations WHERE business_id=$1 AND id=$2 AND preview',[business,id]);
  if(!found.rowCount)throw new Failure(404,'Preview conversation not found');
  return {id:found.rows[0].session_id,customer_id:null};
}
// The redacted trace: per turn, the job's outcome, the steps it ran (in order) and every external attempt. Value-free by
// construction: the worker records no prompts, messages, passage text, context or result values, inputs or secrets.
async function trace(client:PoolClient,business:string,id:string) {
  const found=await client.query(`SELECT ${pinned},c.handoff_reason,p.published_at FROM conversations c
    JOIN published_configurations p ON p.business_id=c.business_id AND p.version=c.configuration_version WHERE c.business_id=$1 AND c.id=$2`,[business,id]);
  if(!found.rowCount)throw new Failure(404,'Conversation not found');
  // A step still 'started' after its job ended was interrupted (worker stopped or lost the turn mid-step).
  const turns=await client.query(`SELECT j.message_id,j.status,j.error,j.created_at,
    coalesce((SELECT json_agg(json_build_object('ordinal',s.ordinal,'step_id',s.step_id,'type',s.type,
      'status',CASE WHEN s.status='started' AND j.status IN ('completed','failed') THEN 'interrupted' ELSE s.status END,
      'output',s.output,'error',s.error,'detail',s.detail,'started_at',s.started_at,'finished_at',s.finished_at) ORDER BY s.ordinal)
      FROM execution_steps s WHERE s.job_id=j.id),'[]') AS steps,
    coalesce((SELECT json_agg(json_build_object('step_ordinal',a.step_ordinal,'step_id',a.step_id,'kind',a.kind,'target',a.target,
      'operation',a.operation,'status',a.status,'error',a.error,'fallback',a.fallback,'served_model',a.served_model,'prompt_tokens',a.prompt_tokens,
      'completion_tokens',a.completion_tokens,'cost_usd',a.cost_usd,'started_at',a.started_at,'finished_at',a.finished_at) ORDER BY a.id)
      FROM execution_attempts a WHERE a.job_id=j.id),'[]') AS attempts
    FROM jobs j WHERE j.business_id=$1 AND j.conversation_id=$2 AND j.kind='turn' ORDER BY j.created_at,j.id`,[business,id]);
  return {...found.rows[0],turns:turns.rows};
}
// Owner-only preview chat and execution traces; every request rechecks the current Owner Membership under the Business lock.
export async function traces(req:IncomingMessage,path:string,user:{id:string},json:(status:number,value:unknown)=>void) {
  const match=path.match(route);
  if(!match)return false;
  const [,business,kind,id,messages]=match;
  let client:PoolClient|undefined;
  try {
    const write=kind==='preview'&&(messages||!id);
    if(req.method!==(write?'POST':'GET')||(kind==='traces'&&messages))throw new Failure(404,'Not found');
    const input=write?await body(req,16384):null;
    const sent=messages?message(input):null;
    if(input&&!messages)keys(input,[]);
    client=await pool.connect();
    await client.query('BEGIN');
    await client.query('SELECT id FROM businesses WHERE id=$1 FOR SHARE',[business]);
    if(!(await client.query("SELECT 1 FROM memberships WHERE business_id=$1 AND operator_id=$2 AND active AND role='Owner'",[business,user.id])).rowCount)throw new Failure(404,'Business not found');
    let status=200,result;
    if(kind==='traces'&&!id) {
      // ponytail: newest 50 conversations; add paging when an Owner needs older traces.
      result=(await client.query(`SELECT ${pinned},c.created_at,c.last_message_at FROM conversations c
        JOIN published_configurations p ON p.business_id=c.business_id AND p.version=c.configuration_version
        WHERE c.business_id=$1 AND c.last_message_at IS NOT NULL ORDER BY c.last_message_at DESC,c.id LIMIT 50`,[business])).rows;
    } else if(kind==='traces') result=await trace(client,business,id);
    else if(!id) {
      // Pinned to the current published version, exactly like a Customer conversation; never the draft.
      const {session}=await open(client,business);
      const created=await start(client,business,session,true);
      status=201;result={conversation:{...await conversation(client,business,session,created),preview:true}};
    } else if(sent) {
      const [accepted,submitted]=await submit(client,business,await previewSession(client,business,id),id,sent.submission,sent.text);
      status=accepted;result={message:submitted};
    } else result={...await conversation(client,business,await previewSession(client,business,id),id),preview:true};
    await client.query('COMMIT');json(status,result);return true;
  } catch(error) {
    await client?.query('ROLLBACK');
    if(error instanceof Failure){json(error.status,{error:error.message});return true;}
    throw error;
  } finally {client?.release();}
}
