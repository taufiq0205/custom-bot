import type {PoolClient} from 'pg';
import type {IncomingMessage} from 'node:http';
import {pool,mode} from './config.js';
import {body,Failure,keys,uuid} from './memberships.js';
export const disclosure='Optional: remember only your explicit preferred name, language, communication style and product interests to personalize relevant service within this Business. Each preference expires 90 days after your last explicit confirmation; Operator corrections and use do not extend retention. You can inspect, correct, delete or disable memory. Disable deletes preferences. Conversation history is separate. Sensitive information, inferred traits, complaints, credentials and order facts are excluded.';
export async function readMemory(client:PoolClient,business:string,customer:string) {
 const consent=(await client.query('SELECT enabled,epoch,revision FROM memory_consents WHERE business_id=$1 AND customer_id=$2',[business,customer])).rows[0];
 const preferences=consent?.enabled?(await client.query(`SELECT kind,value,source_message,provenance,corrected_by,confirmed_at,expires_at,revision,consent_epoch
 FROM customer_memories WHERE business_id=$1 AND customer_id=$2 AND consent_epoch=$3 AND expires_at>memory_now($1,$4) ORDER BY kind`,[business,customer,consent.epoch,mode==='test'])).rows:[];
 const pending=(await client.query(`SELECT e.status,e.error FROM memory_extractions e JOIN jobs j ON j.id=e.job_id
 WHERE e.business_id=$1 AND e.customer_id=$2 ORDER BY j.created_at DESC LIMIT 1`,[business,customer])).rows[0];
 return {enabled:consent?.enabled??false,revision:consent?.revision??'0',disclosure_version:'1',disclosure,preferences,extraction:pending??null};
}
export function preference(kind:unknown,value:unknown) {
 if(!['preferred_name','language','communication_style','product_interests'].includes(kind as string)||typeof value!=='string'
 ||!value.trim()||value.trim().length>120||/[\d@\n\r/:=<>]/.test(value)||/\b(password|secret|token|order|complaint|diagnos|religio|politic|credit|address|account|health|medical|sex|race)\w*/i.test(value))
 throw new Failure(400,'Provide a non-sensitive explicit service preference (1–120 characters)');
 const safe:Record<string,RegExp>={preferred_name:/^[A-Za-zÀ-ɏ][A-Za-zÀ-ɏ -]{0,59}$/,language:/^(English|Malay|Mandarin|Chinese|Tamil|Arabic|Spanish|French|German|Japanese|Korean|Indonesian)$/i,communication_style:/^(brief|concise|detailed|formal|casual|simple)$/i,product_interests:/^(photobooks?|photo albums?|albums?|prints?|canvas prints?|mugs?|calendars?|postcards?|frames?|books?|cameras?|shoes|clothes|electronics|watches|furniture|accessories|stationery)$/i};
 if(!safe[kind as string].test(value.trim()))throw new Failure(400,'Please clarify a supported service preference');
 return value.trim();
}
export async function changeMemory(client:PoolClient,business:string,customer:string,conversation:string,input:any,operator?:string) {
 keys(input,input.action==='enable'?['action','revision','disclosure_version']:input.action==='correct'?['action','revision','kind','value']:['action','revision']);
 if(!['enable','disable','delete','correct'].includes(input.action)||typeof input.revision!=='string'||!/^\d{1,18}$/.test(input.revision))throw new Failure(400,'Provide action and revision');
 if(operator&&input.action==='enable')throw new Failure(403,'Only the verified Customer can opt in');
 if(input.action==='enable'&&input.disclosure_version!=='1')throw new Failure(400,'Accept the current memory disclosure');
 const value=input.action==='correct'?preference(input.kind,input.value):null;
 // Session/Business and conversation locks precede consent everywhere, including the worker.
 await client.query('SELECT 1 FROM conversations WHERE business_id=$1 AND id=$2 FOR UPDATE',[business,conversation]);
 await client.query(`INSERT INTO memory_consents(business_id,customer_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,[business,customer]);
 const c=(await client.query('SELECT * FROM memory_consents WHERE business_id=$1 AND customer_id=$2 FOR UPDATE',[business,customer])).rows[0];
 if((input.revision==='0'&&c.revision!=='1')||(input.revision!=='0'&&input.revision!==c.revision))throw new Failure(409,'Memory changed; reload before correcting');
 if(input.action==='correct'&&!c.enabled)throw new Failure(409,'Customer opt-in required');
 if(input.action==='enable'&&c.enabled)throw new Failure(409,'Memory already enabled');
 if(input.action==='enable') {
 // First opt-in permits completed automated statements of this linked conversation; renewal permits only new statements.
 await client.query(`UPDATE memory_consents SET enabled=true,epoch=epoch+1,revision=revision+1,disclosure_version='1',opted_in_at=clock_timestamp(),
 eligible_conversation=$3,source_floor=CASE WHEN epoch=0 THEN 0 ELSE (SELECT coalesce(max(seq),0)+1 FROM messages) END WHERE business_id=$1 AND customer_id=$2`,[business,customer,conversation]);
 } else if(input.action==='correct') {
 const previous=(await client.query(`SELECT confirmed_at,expires_at FROM customer_memories WHERE business_id=$1 AND customer_id=$2 AND kind=$3 AND expires_at>memory_now($1,$4)`,[business,customer,input.kind,mode==='test'])).rows[0];
 if(operator&&!previous)throw new Failure(409,'Operator correction requires an unexpired Customer-confirmed preference');
 await client.query(`UPDATE memory_consents SET revision=revision+1,control_revision=control_revision+1,source_floor=(SELECT coalesce(max(seq),0)+1 FROM messages) WHERE business_id=$1 AND customer_id=$2`,[business,customer]);
 await client.query(`INSERT INTO customer_memories(business_id,customer_id,kind,value,provenance,corrected_by,confirmed_at,expires_at,revision,consent_epoch)
 VALUES($1,$2,$3,$4,$5,$6,coalesce($7,memory_now($1,$11)),coalesce($8,memory_now($1,$11)+interval '90 days'),$9,$10)
 ON CONFLICT(business_id,customer_id,kind) DO UPDATE SET value=EXCLUDED.value,source_message=CASE WHEN EXCLUDED.provenance='operator-correction' THEN customer_memories.source_message ELSE NULL END,provenance=EXCLUDED.provenance,
 corrected_by=EXCLUDED.corrected_by,confirmed_at=EXCLUDED.confirmed_at,expires_at=EXCLUDED.expires_at,revision=EXCLUDED.revision,consent_epoch=EXCLUDED.consent_epoch`,
 [business,customer,input.kind,value,operator?'operator-correction':'customer-correction',operator??null,operator?previous.confirmed_at:null,operator?previous.expires_at:null,BigInt(c.revision)+1n,c.epoch,mode==='test']);
 } else {
 await client.query('DELETE FROM customer_memories WHERE business_id=$1 AND customer_id=$2',[business,customer]);
 await client.query(`UPDATE memory_consents SET enabled=CASE WHEN $3='disable' THEN false ELSE enabled END,epoch=epoch+1,revision=revision+1,
 source_floor=(SELECT coalesce(max(seq),0)+1 FROM messages),disabled_at=CASE WHEN $3='disable' THEN clock_timestamp() ELSE disabled_at END WHERE business_id=$1 AND customer_id=$2`,[business,customer,input.action]);
 }
 // No old extraction may survive a correction, deletion or consent change, even when already outside the process.
 await client.query(`UPDATE memory_extractions SET status='discarded',error='memory controls changed' WHERE business_id=$1 AND customer_id=$2 AND status IN ('queued','running')`,[business,customer]);
 return readMemory(client,business,customer);
}
const route=new RegExp(`^/api/businesses/(${uuid})/inbox/conversations/(${uuid})/memory$`);
export async function operatorMemory(req:IncomingMessage,path:string,user:{id:string},json:(status:number,value:unknown)=>void) {
 const match=path.match(route);if(!match)return false;
 const [,business,id]=match;
 const input=req.method==='POST'?await body(req,4096):null;
 const client=await pool.connect();
 try {
 await client.query('BEGIN');
 await client.query('SELECT 1 FROM businesses WHERE id=$1 FOR SHARE',[business]);
 if(!(await client.query('SELECT 1 FROM memberships WHERE business_id=$1 AND operator_id=$2 AND active',[business,user.id])).rowCount)throw new Failure(404,'Business not found');
 const c=(await client.query('SELECT customer_id FROM conversations WHERE business_id=$1 AND id=$2 FOR UPDATE',[business,id])).rows[0];
 if(!c?.customer_id)throw new Failure(404,'Verified Customer not found');
 if(!['GET','POST'].includes(req.method!))throw new Failure(404,'Not found');
 const result=input?await changeMemory(client,business,c.customer_id,id,input,user.id):await readMemory(client,business,c.customer_id);
 await client.query('COMMIT');json(200,result);
 }catch(error){await client.query('ROLLBACK');if(error instanceof Failure)json(error.status,{error:error.message});else throw error;}finally{client.release();}
 return true;
}
