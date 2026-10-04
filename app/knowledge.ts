import type { IncomingMessage } from 'node:http';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { mode, pool } from './config.js';
import { REF } from './configuration.js';
import { body, Failure, keys, uuid } from './memberships.js';
const route=new RegExp(`^/api/businesses/(${uuid})/sources(?:/(${REF.source.slice(1,-1)})(?:/(delete|expire|refresh|website))?)?$`);
// 20 MB. Uploads must declare their length, so an oversized one is refused before any byte is read.
const MAX_DOCUMENT=20_000_000;
const formats:Record<string,string>={pdf:'pdf',docx:'docx',txt:'txt',md:'md',markdown:'md'};
// A website scope: one HTTPS host and path prefix ending in /, no credentials, query or fragment. Dot segments and encoded
// separators are refused, in the text as typed (the URL parser would silently resolve them), so the prefix cannot be escaped;
// the worker checks every crawled URL the same way.
const SCOPE='Provide url (an https:// URL scope ending in /, without query or fragment, at most 200 characters) and optionally required (up to 20 page URLs inside that scope)';
function approved(text:unknown,scope?:string) {
  let url:URL;
  try {url=new URL(String(text));} catch {throw new Failure(400,SCOPE);}
  if(typeof text!=='string'||url.protocol!=='https:'||url.username||url.password||url.search||url.hash||text.includes('?')||text.includes('#')
    ||url.href.length>200||/%2e|%2f|%5c|\\|\/\.\.?(\/|$)/i.test(text)||!(scope?url.href.startsWith(scope):url.pathname.endsWith('/')))throw new Failure(400,SCOPE);
  return url.href;
}
function website(input:Record<string,unknown>) {
  const required=input.required??[];
  if(Object.keys(input).some(k=>k!=='url'&&k!=='required')||!Array.isArray(required)||required.length>20)throw new Failure(400,SCOPE);
  const url=approved(input.url);
  return {url,required:[...new Set(required.map(page=>approved(page,url)))]};
}
// A candidate version and its ingestion job. Website candidates also restart the daily refresh schedule.
async function queue(client:PoolClient,business:string,source:string,version:{document:string,format:string,size:number,content?:Buffer,required?:string[]}) {
  const id=randomUUID();
  await client.query('INSERT INTO source_versions(id,business_id,source_id,document,format,size,content,required) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [id,business,source,version.document,version.format,version.size,version.content??null,version.required??null]);
  await client.query(`INSERT INTO jobs(id,business_id,kind,version_id,idempotency_key,deadline) VALUES($1,$2,'ingest',$3,$4,clock_timestamp()+interval '1 hour')`,
    [randomUUID(),business,id,`ingest:${id}`]);
  if(version.format==='website')await client.query("UPDATE knowledge_sources SET next_refresh_at=memory_now(business_id,$2)+interval '1 day' WHERE id=$1",[source,mode==='test']);
  return id;
}
const live=async(client:PoolClient,business:string,ref:string)=>(await client.query('SELECT id,kind FROM knowledge_sources WHERE business_id=$1 AND ref=$2 AND deleted_at IS NULL FOR UPDATE',[business,ref])).rows[0];
const owner=(client:PoolClient|typeof pool,business:string,user:string)=>client.query("SELECT 1 FROM memberships WHERE business_id=$1 AND operator_id=$2 AND active AND role='Owner'",[business,user]);

// Owner-only knowledge sources. Upload acceptance only queues ingestion; the list reports what actually became active.
export async function knowledge(req:IncomingMessage,path:string,user:{id:string},json:(status:number,value:unknown)=>void) {
  const match=path.match(route);
  if(!match)return false;
  const [,business,ref,control]=match;
  let client:PoolClient|undefined;
  try {
    if(req.method!==(ref?'POST':'GET'))throw new Failure(404,'Not found');
    let upload:{document:string,format:string,content:Buffer}|undefined;
    if(ref&&!control) {
      const document=new URL(req.url??'',`http://x`).searchParams.get('document')??'';
      const format=formats[document.split('.').at(-1)!.toLowerCase()];
      if(!format||document.length>200||/[\u0000-\u001f/\\]/.test(document))throw new Failure(400,'Provide ?document=<file name> ending in .pdf, .docx, .txt, .md or .markdown (at most 200 characters)');
      const length=Number(req.headers['content-length']);
      if(!req.headers['content-length']||!Number.isInteger(length))throw new Failure(411,'Content-Length required');
      if(length>MAX_DOCUMENT)throw new Failure(413,'Documents are limited to 20 MB (20,000,000 bytes); nothing was uploaded');
      if(length===0)throw new Failure(400,'The document is empty');
      // Checked again under the Business lock below; this only avoids reading a non-Owner's upload.
      if(!(await owner(pool,business,user.id)).rowCount)throw new Failure(404,'Business not found');
      const chunks:Buffer[]=[];
      for await(const chunk of req)chunks.push(chunk);
      upload={document,format,content:Buffer.concat(chunks)};
    }
    const input=control?await body(req):null;
    const scope=control==='website'?website(input):null;
    if(input&&!scope)keys(input,[]);
    client=await pool.connect();
    await client.query('BEGIN');
    // Membership changes lock the Business row, so the Owner check holds until commit.
    await client.query('SELECT id FROM businesses WHERE id=$1 FOR SHARE',[business]);
    if(!(await owner(client,business,user.id)).rowCount)throw new Failure(404,'Business not found');
    let result,status=200;
    if(upload||scope) {
      const kind=upload?'document':'website';
      await client.query(`INSERT INTO knowledge_sources(id,business_id,ref,kind,next_refresh_at) VALUES($1,$2,$3,$4,CASE WHEN $4='website' THEN memory_now($2,$5) END)
        ON CONFLICT(business_id,ref) WHERE deleted_at IS NULL DO NOTHING`,[randomUUID(),business,ref,kind,mode==='test']);
      const source=await live(client,business,ref);
      // Deleted by a concurrent request between the insert and the lock.
      if(!source)throw new Failure(409,'The source was deleted meanwhile; nothing was queued. Try again.');
      if(source.kind!==kind)throw new Failure(409,`Source ${ref} is a ${source.kind} source; delete it first or use another source ID`);
      const document=upload?.document??scope!.url;
      const version=await queue(client,business,source.id,upload?{...upload,size:upload.content.length}:{document,format:'website',size:0,required:scope!.required});
      result={ref,version:{id:version,document,state:'queued'},message:upload
        ?'Queued for ingestion. It is used for answers only once it is complete; until then any previous version stays in use.'
        :'Website refresh queued. Its snapshot is used for answers only once every page is complete; until then any previous snapshot stays in use.'};
      status=202;
    } else if(control==='refresh') {
      // The row lock orders this against deletion: a deleted source is never queued again.
      const source=await live(client,business,ref);
      if(!source)throw new Failure(404,'Source not found');
      if(source.kind!=='website')throw new Failure(409,'Only website sources refresh; upload a new document version instead');
      const pending=(await client.query("SELECT id,document,state FROM source_versions WHERE source_id=$1 AND state IN ('queued','running') ORDER BY seq DESC LIMIT 1",[source.id])).rows[0];
      const latest=(await client.query('SELECT document,required FROM source_versions WHERE source_id=$1 ORDER BY seq DESC LIMIT 1',[source.id])).rows[0];
      const version=pending??{id:await queue(client,business,source.id,{document:latest.document,format:'website',size:0,required:latest.required}),document:latest.document,state:'queued'};
      result={ref,version,message:pending?'A refresh is already in progress; its snapshot is used once complete.'
        :'Website refresh queued. Its snapshot is used for answers only once every page is complete; until then any previous snapshot stays in use.'};
      status=202;
    } else if(control==='expire') {
      // Like deletion for answers, but the source stays listed; only a new upload makes it usable again.
      // The row lock waits for any turn rechecking this source; no candidate uploaded before now can activate later.
      const expired=await client.query(`UPDATE knowledge_sources s SET expired_at=clock_timestamp(),active_version_id=NULL,
        expired_through=(SELECT max(seq) FROM source_versions WHERE source_id=s.id)
        WHERE business_id=$1 AND ref=$2 AND deleted_at IS NULL AND active_version_id IS NOT NULL AND kind='document' RETURNING id,expired_at`,[business,ref]);
      // Websites expire by themselves 7 days after their last successful refresh, and the daily refresh would revive an explicit expiry.
      if(!expired.rowCount)throw new Failure(404,'No active document version of this source to expire; website sources expire 7 days after their last successful refresh');
      await client.query("UPDATE source_versions SET state='expired',content=NULL WHERE source_id=$1 AND state IN ('active','queued','running')",[expired.rows[0].id]);
      await client.query('DELETE FROM source_chunks WHERE source_id=$1',[expired.rows[0].id]);
      result={ref,expired_at:expired.rows[0].expired_at};
    } else if(control==='delete') {
      // The row lock waits for any turn rechecking this source, and blocks a late activation; every version and passage goes now.
      const deleted=await client.query('UPDATE knowledge_sources SET deleted_at=clock_timestamp() WHERE business_id=$1 AND ref=$2 AND deleted_at IS NULL RETURNING id',[business,ref]);
      if(!deleted.rowCount)throw new Failure(404,'Source not found');
      await client.query("UPDATE source_versions SET state='deleted',content=NULL WHERE source_id=$1",[deleted.rows[0].id]);
      await client.query('DELETE FROM source_chunks WHERE source_id=$1',[deleted.rows[0].id]);
      result={ref,deleted:true};
    } else {
      // A website's evidence is used for 7 days after its last successful refresh (its active version's activation).
      result=(await client.query(`SELECT s.ref,s.kind,s.expired_at,l.seq<=s.expired_through AS expired,
        CASE WHEN a.id IS NOT NULL THEN json_build_object('document',a.document,'format',a.format,'passages',a.passages,'activated_at',a.finished_at,
          'pages',a.pages,'fresh_until',CASE WHEN s.kind='website' THEN a.finished_at+interval '7 days' END) END AS active,
        CASE WHEN s.kind='website' THEN a.id IS NOT NULL AND a.finished_at+interval '7 days'>memory_now(s.business_id,$2) END AS fresh,
        CASE WHEN s.kind='website' THEN json_build_object('url',l.document,'required',coalesce(l.required,'{}'),'next_refresh_at',s.next_refresh_at) END AS website,
        json_build_object('id',l.id,'document',l.document,'state',l.state,'error',l.error,'uploaded_at',l.created_at,'finished_at',l.finished_at) AS latest
        FROM knowledge_sources s LEFT JOIN source_versions a ON a.id=s.active_version_id
        CROSS JOIN LATERAL (SELECT * FROM source_versions WHERE source_id=s.id ORDER BY seq DESC LIMIT 1) l
        WHERE s.business_id=$1 AND s.deleted_at IS NULL ORDER BY s.ref`,[business,mode==='test'])).rows.map(({expired,...s})=>{
        const failed=s.latest.state==='failed'&&s.latest.error,when=(t:string)=>new Date(t).toISOString();
        return {...s,warning:s.kind==='website'
          ?s.active&&!s.fresh?`Website evidence expired ${when(s.active.fresh_until)}, 7 days after its last successful refresh: not used for answers.${failed?` The latest refresh failed: ${failed}.`:''} A successful refresh makes it usable again.`
            :!failed?null:s.active?`The latest refresh failed: ${failed}. Answers still use the snapshot refreshed ${when(s.active.activated_at)} until ${when(s.active.fresh_until)}.`
            :`The refresh failed: ${failed}. This website source has no usable snapshot.`
          // No upload since the expiry: say so, whatever happened to earlier uploads.
          :expired?`Expired ${when(s.expired_at)}: not used for answers. Upload a replacement to use this source again.`
          :!failed?null:s.active?`The latest upload (${s.latest.document}) failed: ${failed}. Answers still use ${s.active.document}.`
          :`The upload (${s.latest.document}) failed: ${failed}. This source has no usable version.`};
      });
    }
    await client.query('COMMIT');json(status,result);return true;
  } catch(error) {
    await client?.query('ROLLBACK');
    if(error instanceof Failure){json(error.status,{error:error.message});return true;}
    throw error;
  } finally {client?.release();}
}
