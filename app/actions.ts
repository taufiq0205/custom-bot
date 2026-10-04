import type { IncomingMessage } from 'node:http';
import type { PoolClient } from 'pg';
import { createCipheriv, randomBytes } from 'node:crypto';
import { credentialKey, pool } from './config.js';
import { FIELD, publicHttps, REF } from './configuration.js';
import { body, Failure, keys, uuid } from './memberships.js';
const PROVIDERS=['deepseek','qwen'],OPERATIONS=['generation','extraction'];
const route=new RegExp(`^/api/businesses/(${uuid})/(?:(action-controls)|(credentials|authorization-policies)(?:/(${REF.source.slice(1,-1)})/(revoke))?|actions/([A-Za-z][A-Za-z0-9_-]{0,63})|(provider-permissions)(?:/(${PROVIDERS.join('|')})/(${OPERATIONS.join('|')}))?)$`);
// Visible ASCII; no CR/LF can reach a request header.
const SECRET=/^[\x21-\x7e](?:[\x20-\x7e]{0,4094}[\x21-\x7e])?$/;

// AES-256-GCM: nonce ‖ ciphertext ‖ tag, bound to its Business and reference so ciphertext cannot be moved between them.
function seal(business:string,ref:string,secret:string) {
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',credentialKey!,nonce);
  cipher.setAAD(Buffer.from(`${business}/${ref}`));
  return Buffer.concat([nonce,cipher.update(secret,'utf8'),cipher.final(),cipher.getAuthTag()]);
}

// Owner-only live action controls and provider permissions. Secrets are write-only: no response ever contains one.
export async function actions(req:IncomingMessage,path:string,user:{id:string},json:(status:number,value:unknown)=>void) {
  const match=path.match(route);
  if(!match)return false;
  const [,business,controls,resource,ref,revoke,action,permissions,provider,operation]=match;
  const listing=controls||(permissions&&!provider);
  let client:PoolClient|undefined;
  try {
    if(req.method!==(listing?'GET':'POST'))throw new Failure(404,'Not found');
    const input=listing?null:await body(req,16384);
    client=await pool.connect();
    await client.query('BEGIN');
    // The worker share-locks the Business while it checks controls, so a change here waits for (or is seen by) every in-flight check.
    await client.query(`SELECT id FROM businesses WHERE id=$1 ${listing?'FOR SHARE':'FOR NO KEY UPDATE'}`,[business]);
    if(!(await client.query("SELECT 1 FROM memberships WHERE business_id=$1 AND operator_id=$2 AND active AND role='Owner'",[business,user.id])).rowCount)throw new Failure(404,'Business not found');
    let result;
    if(listing&&permissions) {
      // Every provider/operation pair, off unless granted, the worker's key/endpoint readiness (never key values), and the models
      // and fallbacks the latest published version (used by new conversations) selects.
      const granted=(await client.query('SELECT provider,operation,allowed,revision,updated_at FROM provider_permissions WHERE business_id=$1',[business])).rows;
      const worker=(await client.query("SELECT generation FROM worker_health WHERE id='worker'")).rows[0];
      const published=(await client.query('SELECT version,document FROM published_configurations WHERE business_id=$1 ORDER BY version DESC LIMIT 1',[business])).rows[0];
      result={permissions:PROVIDERS.flatMap(p=>OPERATIONS.map(o=>granted.find(g=>g.provider===p&&g.operation===o)??{provider:p,operation:o,allowed:false,revision:null,updated_at:null})),
        providers:worker?.generation??null,
        selected:{version:published.version,mode:published.document.generation.mode,agents:published.document.agents.filter((a:any)=>a.model).map((a:any)=>
          ({agent:a.id,model:`${a.model.provider}/${a.model.name}`,fallback:a.model.fallback?`${a.model.fallback.provider}/${a.model.fallback.name}`:null}))}};
    } else if(listing) {
      result={credentials:(await client.query('SELECT ref,origin,header,active,revision,updated_at FROM action_credentials WHERE business_id=$1 ORDER BY ref',[business])).rows,
        policies:(await client.query('SELECT ref,customer_parameter,owner_field,active,revision,updated_at FROM authorization_policies WHERE business_id=$1 ORDER BY ref',[business])).rows,
        revoked_actions:(await client.query('SELECT action_id,revoked_at FROM action_revocations WHERE business_id=$1 ORDER BY action_id',[business])).rows};
    } else if(provider) {
      keys(input,['allowed']);
      if(typeof input.allowed!=='boolean')throw new Failure(400,'Provide allowed (true or false)');
      // Every change bumps the revision, so the worker discards outputs produced under the previous permission.
      result=(await client.query(`INSERT INTO provider_permissions(business_id,provider,operation,allowed,updated_by) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(business_id,provider,operation) DO UPDATE SET allowed=EXCLUDED.allowed,revision=provider_permissions.revision+1,
        updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp() RETURNING provider,operation,allowed,revision,updated_at`,[business,provider,operation,input.allowed,user.id])).rows[0];
    } else if(action) {
      keys(input,['revoked']);
      if(typeof input.revoked!=='boolean')throw new Failure(400,'Provide revoked (true or false)');
      await client.query(input.revoked?'INSERT INTO action_revocations(business_id,action_id,revoked_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING'
        :'DELETE FROM action_revocations WHERE business_id=$1 AND action_id=$2',input.revoked?[business,action,user.id]:[business,action]);
      result={action_id:action,revoked:input.revoked};
    } else if(revoke) {
      keys(input,[]);
      const table=resource==='credentials'?'action_credentials':'authorization_policies';
      // Revoking a credential erases its ciphertext; restoring it means storing the secret again.
      const revoked=await client.query(`UPDATE ${table} SET active=false,${resource==='credentials'?'ciphertext=NULL,':''}revision=revision+1,updated_by=$3,updated_at=clock_timestamp()
        WHERE business_id=$1 AND ref=$2 RETURNING ref,active,revision`,[business,ref,user.id]);
      if(!revoked.rowCount)throw new Failure(404,'Not found');
      result=revoked.rows[0];
    } else if(resource==='credentials') {
      keys(input,['ref','origin','header','secret']);
      const url=publicHttps(input.origin);
      if(typeof input.ref!=='string'||!REF.test(input.ref)||!url||url.origin!==input.origin
        ||typeof input.header!=='string'||!/^(authorization|x-[a-z0-9-]{1,60})$/.test(input.header)||typeof input.secret!=='string'||!SECRET.test(input.secret))
        throw new Failure(400,'Provide ref, origin (https://api.example.com), header ("authorization" or "x-…", lower case) and secret (1–4096 visible ASCII characters)');
      if(!credentialKey)throw new Failure(503,'Credential storage is not configured: set ACTION_CREDENTIAL_KEY (openssl rand -hex 32) for the app and worker');
      // Storing again rotates the secret (and may move it to another origin); in-flight results under the old revision are discarded.
      result=(await client.query(`INSERT INTO action_credentials(business_id,ref,origin,header,ciphertext,updated_by) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(business_id,ref) DO UPDATE SET origin=EXCLUDED.origin,header=EXCLUDED.header,ciphertext=EXCLUDED.ciphertext,active=true,
        revision=action_credentials.revision+1,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()
        RETURNING ref,origin,header,active,revision,updated_at`,[business,input.ref,input.origin,input.header,seal(business,input.ref,input.secret),user.id])).rows[0];
    } else {
      keys(input,['ref','customer_parameter','owner_field']);
      if(typeof input.ref!=='string'||!REF.test(input.ref)||!FIELD.test(String(input.customer_parameter))||!FIELD.test(String(input.owner_field))
        ||typeof input.customer_parameter!=='string'||typeof input.owner_field!=='string')
        throw new Failure(400,`Provide ref, customer_parameter and owner_field (names matching ${FIELD})`);
      result=(await client.query(`INSERT INTO authorization_policies(business_id,ref,customer_parameter,owner_field,updated_by) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(business_id,ref) DO UPDATE SET customer_parameter=EXCLUDED.customer_parameter,owner_field=EXCLUDED.owner_field,active=true,
        revision=authorization_policies.revision+1,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()
        RETURNING ref,customer_parameter,owner_field,active,revision,updated_at`,[business,input.ref,input.customer_parameter,input.owner_field,user.id])).rows[0];
    }
    await client.query('COMMIT');json(200,result);return true;
  } catch(error) {
    await client?.query('ROLLBACK');
    if(error instanceof Failure){json(error.status,{error:error.message});return true;}
    throw error;
  } finally {client?.release();}
}
