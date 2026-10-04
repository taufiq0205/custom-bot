import type { IncomingMessage } from 'node:http';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { pool } from './config.js';
import { REF } from './configuration.js';
import { body, Failure, keys, uuid } from './memberships.js';
const route=new RegExp(`^/api/businesses/(${uuid})/sources(?:/(${REF.source.slice(1,-1)})(/delete)?)?$`);
// 20 MiB. Uploads must declare their length, so an oversized one is refused before any byte is read.
export const MAX_DOCUMENT=20*1024*1024;
const formats:Record<string,string>={pdf:'pdf',docx:'docx',txt:'txt',md:'md',markdown:'md'};
const owner=(client:PoolClient|typeof pool,business:string,user:string)=>client.query("SELECT 1 FROM memberships WHERE business_id=$1 AND operator_id=$2 AND active AND role='Owner'",[business,user]);

// Owner-only knowledge sources. Upload acceptance only queues ingestion; the list reports what actually became active.
export async function knowledge(req:IncomingMessage,path:string,user:{id:string},json:(status:number,value:unknown)=>void) {
  const match=path.match(route);
  if(!match)return false;
  const [,business,ref,remove]=match;
  let client:PoolClient|undefined;
  try {
    if(req.method!==(ref?'POST':'GET'))throw new Failure(404,'Not found');
    let upload:{document:string,format:string,content:Buffer}|undefined;
    if(ref&&!remove) {
      const document=new URL(req.url??'',`http://x`).searchParams.get('document')??'';
      const format=formats[document.split('.').at(-1)!.toLowerCase()];
      if(!format||document.length>200||/[\u0000-\u001f/\\]/.test(document))throw new Failure(400,'Provide ?document=<file name> ending in .pdf, .docx, .txt, .md or .markdown (at most 200 characters)');
      const length=Number(req.headers['content-length']);
      if(!req.headers['content-length']||!Number.isInteger(length))throw new Failure(411,'Content-Length required');
      if(length>MAX_DOCUMENT)throw new Failure(413,'Documents are limited to 20 MiB; nothing was uploaded');
      if(length===0)throw new Failure(400,'The document is empty');
      // Checked again under the Business lock below; this only avoids reading a non-Owner's upload.
      if(!(await owner(pool,business,user.id)).rowCount)throw new Failure(404,'Business not found');
      const chunks:Buffer[]=[];
      for await(const chunk of req)chunks.push(chunk);
      upload={document,format,content:Buffer.concat(chunks)};
    }
    const input=remove?await body(req):null;
    if(input)keys(input,[]);
    client=await pool.connect();
    await client.query('BEGIN');
    // Membership changes lock the Business row, so the Owner check holds until commit.
    await client.query('SELECT id FROM businesses WHERE id=$1 FOR SHARE',[business]);
    if(!(await owner(client,business,user.id)).rowCount)throw new Failure(404,'Business not found');
    let result,status=200;
    if(upload) {
      await client.query('INSERT INTO knowledge_sources(id,business_id,ref) VALUES($1,$2,$3) ON CONFLICT(business_id,ref) WHERE deleted_at IS NULL DO NOTHING',[randomUUID(),business,ref]);
      const source=(await client.query('SELECT id FROM knowledge_sources WHERE business_id=$1 AND ref=$2 AND deleted_at IS NULL FOR UPDATE',[business,ref])).rows[0]?.id;
      // Deleted by a concurrent request between the insert and the lock.
      if(!source)throw new Failure(409,'The source was deleted meanwhile; nothing was uploaded. Upload again.');
      const version=randomUUID();
      await client.query('INSERT INTO source_versions(id,business_id,source_id,document,format,size,content) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [version,business,source,upload.document,upload.format,upload.content.length,upload.content]);
      await client.query(`INSERT INTO jobs(id,business_id,kind,version_id,idempotency_key,deadline) VALUES($1,$2,'ingest',$3,$4,clock_timestamp()+interval '1 hour')`,
        [randomUUID(),business,version,`ingest:${version}`]);
      result={ref,version:{id:version,document:upload.document,state:'queued'},
        message:'Queued for ingestion. It is used for answers only once it is complete; until then any previous version stays in use.'};
      status=202;
    } else if(remove) {
      // The row lock waits for any turn rechecking this source, and blocks a late activation; every version and passage goes now.
      const deleted=await client.query('UPDATE knowledge_sources SET deleted_at=clock_timestamp() WHERE business_id=$1 AND ref=$2 AND deleted_at IS NULL RETURNING id',[business,ref]);
      if(!deleted.rowCount)throw new Failure(404,'Source not found');
      await client.query("UPDATE source_versions SET state='deleted',content=NULL WHERE source_id=$1",[deleted.rows[0].id]);
      await client.query('DELETE FROM source_chunks WHERE source_id=$1',[deleted.rows[0].id]);
      result={ref,deleted:true};
    } else {
      result=(await client.query(`SELECT s.ref,
        CASE WHEN a.id IS NOT NULL THEN json_build_object('document',a.document,'format',a.format,'passages',a.passages,'activated_at',a.finished_at) END AS active,
        json_build_object('id',l.id,'document',l.document,'state',l.state,'error',l.error,'uploaded_at',l.created_at,'finished_at',l.finished_at) AS latest
        FROM knowledge_sources s LEFT JOIN source_versions a ON a.id=s.active_version_id
        CROSS JOIN LATERAL (SELECT * FROM source_versions WHERE source_id=s.id ORDER BY seq DESC LIMIT 1) l
        WHERE s.business_id=$1 AND s.deleted_at IS NULL ORDER BY s.ref`,[business])).rows.map(s=>({...s,
        warning:s.latest.state!=='failed'?null:s.active?`The latest upload (${s.latest.document}) failed: ${s.latest.error}. Answers still use ${s.active.document}.`
          :`The upload (${s.latest.document}) failed: ${s.latest.error}. This source has no usable version.`}));
    }
    await client.query('COMMIT');json(status,result);return true;
  } catch(error) {
    await client?.query('ROLLBACK');
    if(error instanceof Failure){json(error.status,{error:error.message});return true;}
    throw error;
  } finally {client?.release();}
}
