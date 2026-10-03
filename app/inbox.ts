import type { IncomingMessage } from 'node:http';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { pool } from './config.js';
import { body, Failure, keys, message, uuid } from './memberships.js';
const route=new RegExp(`^/api/businesses/(${uuid})/inbox(?:/(availability)|/conversations/(${uuid})(?:/(claim|reassign|messages|resolve|resume))?)?$`);
type Conversation={control_state:string,assignee_id:string|null,revision:string};
const changed=()=>new Failure(409,'This conversation changed (claimed, reassigned, resolved or resumed). Nothing was sent or changed; reload it before acting.');
const notAssignee=()=>new Failure(409,'Only the current assignee can do this. Nothing was sent or changed.');
async function detail(client:PoolClient,business:string,id:string) {
  const found=await client.query(`SELECT c.id,c.control_state,c.assignee_id,u.email AS assignee_email,c.handoff_reason,c.revision,c.configuration_version,
    c.customer_id IS NOT NULL AS verified,c.last_message_at FROM conversations c LEFT JOIN "user" u ON u.id=c.assignee_id WHERE c.business_id=$1 AND c.id=$2`,[business,id]);
  if(!found.rowCount)throw new Failure(404,'Conversation not found');
  const messages=await client.query(`SELECT m.id,m.author,u.email AS operator_email,m.text,m.simulated,m.reply_to,m.turn_state,m.created_at FROM messages m
    LEFT JOIN "user" u ON u.id=m.operator_id WHERE m.business_id=$1 AND m.conversation_id=$2 ORDER BY m.seq`,[business,id]);
  return {...found.rows[0],messages:messages.rows};
}
// Shared support queue: every active Owner/Support Member of the Business, never another Business's.
export async function inbox(req:IncomingMessage,path:string,user:{id:string},json:(status:number,value:unknown)=>void) {
  const match=path.match(route);
  if(!match)return false;
  const [,business,availability,id,action]=match;
  let client:PoolClient|undefined;
  try {
    const write=!!(availability||action);
    if(req.method!==(write?'POST':'GET'))throw new Failure(404,'Not found');
    const input=write?await body(req,16384):null;
    client=await pool.connect();
    await client.query('BEGIN');
    // Authority is the current Membership; holding the Business lock until commit makes a concurrent revocation wait for this request.
    // Availability updates the Membership row, so it takes the same lock Membership administration does.
    await client.query(`SELECT id FROM businesses WHERE id=$1 ${availability?'FOR NO KEY UPDATE':'FOR SHARE'}`,[business]);
    if(!(await client.query('SELECT 1 FROM memberships WHERE business_id=$1 AND operator_id=$2 AND active',[business,user.id])).rowCount)throw new Failure(404,'Business not found');
    let result;
    if(availability) {
      keys(input,['available']);
      if(typeof input.available!=='boolean')throw new Failure(400,'Provide available (true or false)');
      // Availability is shown to the team only: it never assigns, releases or resumes a conversation.
      await client.query('UPDATE memberships SET available=$3 WHERE business_id=$1 AND operator_id=$2',[business,user.id,input.available]);
      result={available:input.available};
    } else if(!id) {
      const members=await client.query(`SELECT m.operator_id,u.email,m.role,m.available FROM memberships m JOIN "user" u ON u.id=m.operator_id
        WHERE m.business_id=$1 AND m.active ORDER BY u.email`,[business]);
      // ponytail: newest 200 conversations with messages, queue first; add paging when a Business outgrows it.
      const conversations=await client.query(`SELECT c.id,c.control_state,c.assignee_id,u.email AS assignee_email,c.handoff_reason,c.revision,
        c.customer_id IS NOT NULL AS verified,c.last_message_at FROM conversations c LEFT JOIN "user" u ON u.id=c.assignee_id
        WHERE c.business_id=$1 AND c.last_message_at IS NOT NULL ORDER BY c.control_state='waiting-for-support' DESC,c.last_message_at DESC,c.id LIMIT 200`,[business]);
      result={operator_id:user.id,members:members.rows,conversations:conversations.rows};
    } else if(!action) result=await detail(client,business,id);
    else {
      const reply=action==='messages'?message(input,['revision']):null;
      if(!reply)keys(input,action==='reassign'?['revision','operator_id']:['revision']);
      if(typeof input.revision!=='string'||!/^\d{1,18}$/.test(input.revision))throw new Failure(400,'Provide revision');
      if(action==='reassign'&&typeof input.operator_id!=='string')throw new Failure(400,'Provide revision and operator_id');
      // Every check below holds the conversation lock until commit, so control and ownership cannot change in between.
      const locked=await client.query('SELECT control_state,assignee_id,revision FROM conversations WHERE business_id=$1 AND id=$2 FOR UPDATE',[business,id]);
      if(!locked.rowCount)throw new Failure(404,'Conversation not found');
      const c=locked.rows[0] as Conversation;
      if(reply) {
        // A retried submission returns the original reply and never sends twice, whatever happened since.
        const existing=(await client.query(`SELECT id,author,operator_id,text,created_at FROM messages WHERE conversation_id=$1 AND client_submission_id=$2`,[id,reply.submission])).rows[0];
        if(existing) {
          if(existing.author!=='operator'||existing.operator_id!==user.id||existing.text!==reply.text)throw new Failure(409,'Submission ID already used for a different message');
          await client.query('COMMIT');json(200,{message:{id:existing.id,text:existing.text,created_at:existing.created_at}});return true;
        }
      }
      if(c.revision!==input.revision)throw changed();
      const assignee=c.assignee_id===user.id&&c.control_state==='human-controlled';
      if(action==='claim') {
        // Exactly one claim of a queued (or, as a takeover, automated) conversation succeeds; ownership comes before replying.
        if(!['automated','waiting-for-support'].includes(c.control_state))throw new Failure(409,'Already assigned. Ask for reassignment instead.');
        await client.query(`UPDATE conversations SET control_state='human-controlled',assignee_id=$2,
          handoff_reason=CASE WHEN control_state='automated' THEN 'operator-takeover' ELSE handoff_reason END WHERE id=$1`,[id,user.id]);
      } else if(action==='reassign') {
        if(c.control_state==='automated')throw new Failure(409,'This conversation is automated. Claim it to take over.');
        const target=await client.query('SELECT 1 FROM memberships WHERE business_id=$1 AND operator_id=$2 AND active',[business,input.operator_id]);
        if(!target.rowCount)throw new Failure(400,'Choose an active Member of this Business');
        await client.query(`UPDATE conversations SET assignee_id=$2,control_state=CASE WHEN control_state='resolved' THEN 'resolved' ELSE 'human-controlled' END WHERE id=$1`,[id,input.operator_id]);
      } else if(!assignee) throw notAssignee();
      else if(reply) {
        await client.query(`INSERT INTO messages(id,business_id,conversation_id,author,operator_id,text,client_submission_id) VALUES($1,$2,$3,'operator',$4,$5,$6)`,
          [randomUUID(),business,id,user.id,reply.text,reply.submission]);
        await client.query('UPDATE conversations SET last_message_at=clock_timestamp() WHERE id=$1',[id]);
      } else if(action==='resolve') await client.query(`UPDATE conversations SET control_state='resolved' WHERE id=$1`,[id]);
      // Resume replays nothing: the next Customer message starts the next automated turn.
      else await client.query(`UPDATE conversations SET control_state='automated',assignee_id=NULL,handoff_reason=NULL WHERE id=$1`,[id]);
      result=await detail(client,business,id);
    }
    await client.query('COMMIT');json(200,result);return true;
  } catch(error) {
    await client?.query('ROLLBACK');
    if(error instanceof Failure){json(error.status,{error:error.message});return true;}
    throw error;
  } finally {client?.release();}
}
