import type { IncomingMessage } from 'node:http';
import type { PoolClient } from 'pg';
import { pool } from './config.js';
import { body, Failure, keys, uuid } from './memberships.js';
type Issue={path:string,message:string,line?:number,column?:number};
type Check=(value:any,path:string)=>void;
const ID=/^[A-Za-z][A-Za-z0-9_-]{0,63}$/, REF=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/, FIELD=/^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_TEXT=262144;
// PostgreSQL text/jsonb cannot store these.
const unstorable=/\u0000|\p{Cs}/u;
// Outputs each step type must connect before publication.
const outputs=(step:any):string[]=>{
  const all:Record<string,string[]>={retrieval:['next'],condition:['yes','fallback'],http:['success','failure'],agent:step.final===true?['unsupported']:['next','unsupported'],handoff:[]};
  return Object.hasOwn(all,step.type)?all[step.type]:[];
};
const pointer=(key:string)=>'/'+key.replace(/~/g,'~0').replace(/\//g,'~1');
const isObject=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);

// Locates what JSON.parse cannot: syntax errors V8 reports without a position, and duplicate keys (JSON.parse silently keeps the last).
function scan(s:string) {
  let i=0,duplicate:{at:number,key:string}|undefined;
  const number=/-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;
  const fail=()=>{throw i;};
  const space=()=>{while(' \t\n\r'.includes(s[i]??'x'))i++;};
  const word=(w:string)=>{if(!s.startsWith(w,i))fail();i+=w.length;};
  const string=()=>{
    for(i++;;) {
      const c=s[i];
      if(c===undefined||c<' ')fail();
      if(c==='"'){i++;return;}
      if(c!=='\\'){i++;continue;}
      i++;
      if(s[i]==='u'){if(!/^[0-9a-fA-F]{4}$/.test(s.slice(i+1,i+5)))fail();i+=5;}
      else if('"\\/bfnrt'.includes(s[i]??'x'))i++;else fail();
    }
  };
  const value=():void=>{
    space();
    const c=s[i];
    if(c==='{'||c==='[') {
      const close=c==='{'?'}':']',keys=new Set<string>();
      i++;space();
      if(s[i]===close){i++;return;}
      for(;;) {
        if(c==='{') {
          space();if(s[i]!=='"')fail();
          const start=i;string();
          const key=JSON.parse(s.slice(start,i));
          if(keys.has(key))duplicate??={at:start,key};else keys.add(key);
          space();if(s[i]!==':')fail();i++;
        }
        value();space();
        if(s[i]===','){i++;continue;}
        if(s[i]===close){i++;return;}
        fail();
      }
    }
    if(c==='"')return string();
    if(c==='t'||c==='f'||c==='n')return word(c==='t'?'true':c==='f'?'false':'null');
    number.lastIndex=i;
    if(!number.exec(s))fail();
    i=number.lastIndex;
  };
  try {value();space();if(i<s.length)fail();} catch {return {syntax:i,duplicate};}
  return {syntax:undefined,duplicate};
}
const at=(text:string,offset:number)=>{const before=text.slice(0,offset).split('\n');return {line:before.length,column:before.at(-1)!.length+1};};
// Numbers PostgreSQL numeric cannot hold (or JSON.parse silently rounds to 0/Infinity) are replaced by this marker.
const OUT_OF_RANGE=Symbol('out of range');

// Two tiers: errors (unparseable, unsupported, duplicate, dangling, non-finite, unsafe) and blockers (incomplete but editable). Both prevent publication.
export function validate(text:string) {
  let doc:any;
  const scanned=scan(text);
  try {
    // Node 22's reviver receives each primitive's source text.
    doc=JSON.parse(text,(_key,value,context?:{source?:string})=>typeof value==='number'&&context?.source
      &&(context.source.length>40||Number(/[eE][+-]?(\d+)/.exec(context.source)?.[1]??0)>308)?OUT_OF_RANGE:value);
  }
  catch(error) {
    const message=(error as Error).message.split(/ at position| is not valid JSON|, "|, \.\.\."/)[0];
    return {json_valid:false,errors:[{path:'',...at(text,scanned.syntax??text.length),message}],blockers:[]};
  }
  const errors:Issue[]=[],blockers:Issue[]=[];
  const err=(path:string,message:string)=>{errors.push({path,message});};
  if(scanned.duplicate)errors.push({path:'',...at(text,scanned.duplicate.at),message:`Duplicate key "${scanned.duplicate.key}"`});
  // Unstorable characters and deep nesting are checked before walking the shape.
  const walk=(v:any,path:string,depth:number):boolean=>{
    if(depth>32){err(path,'Nested too deeply');return false;}
    if(v===OUT_OF_RANGE){err(path,'Number out of range');return true;}
    if(typeof v==='string'&&unstorable.test(v)){err(path,'NUL and unpaired surrogate characters are not allowed');return true;}
    if(v&&typeof v==='object')return Object.entries(v).every(([k,x])=>unstorable.test(k)?(err(path+pointer(k),'NUL and unpaired surrogate characters are not allowed'),true):walk(x,path+pointer(k),depth+1));
    return true;
  };
  if(!walk(doc,'',0))return {json_valid:true,errors,blockers};
  const shape=(v:any,path:string,required:Record<string,Check>,optional:Record<string,Check>={})=>{
    if(!isObject(v))return err(path,'Must be an object');
    for(const k of Object.keys(v))if(!Object.hasOwn(required,k)&&!Object.hasOwn(optional,k))err(path+pointer(k),'Unsupported field');
    for(const [k,check] of Object.entries(required))Object.hasOwn(v,k)?check(v[k],path+pointer(k)):err(path+pointer(k),'Required');
    for(const [k,check] of Object.entries(optional))if(Object.hasOwn(v,k))check(v[k],path+pointer(k));
  };
  const text_=(max:number,pattern?:RegExp):Check=>(v,p)=>{if(typeof v!=='string'||!v.trim()||v.length>max||(pattern&&!pattern.test(v)))err(p,pattern?`Must match ${pattern}`:`Must be text of 1–${max} characters`);};
  const oneOf=(...values:unknown[]):Check=>(v,p)=>{if(!values.includes(v))err(p,`Must be one of ${values.map(x=>JSON.stringify(x)).join(', ')}`);};
  const number=(min:number,max:number,integer=false):Check=>(v,p)=>{if(typeof v!=='number'||!(v>=min&&v<=max)||(integer&&!Number.isInteger(v)))err(p,`Must be ${integer?'an integer':'a number'} from ${min} to ${max}`);};
  const finite:Check=(v,p)=>{if(typeof v!=='number'||!Number.isFinite(v))err(p,'Must be a finite number');};
  const bool:Check=(v,p)=>{if(typeof v!=='boolean')err(p,'Must be true or false');};
  const list=(item:Check,min=0):Check=>(v,p)=>{if(!Array.isArray(v))return err(p,'Must be an array');if(v.length<min)err(p,`Needs at least ${min} item`);v.forEach((x,i)=>item(x,`${p}/${i}`));};
  // IDs are collected leniently first so references can be checked wherever they appear.
  const ids=(items:unknown,path:string)=>{
    const seen=new Map<string,any>();
    if(Array.isArray(items))items.forEach((x,i)=>{if(typeof x?.id!=='string')return;if(seen.has(x.id))err(`${path}/${i}/id`,`Duplicate ID "${x.id}"`);else seen.set(x.id,x);});
    return seen;
  };
  const sources=ids(doc?.sources,'/sources'),agents=ids(doc?.agents,'/agents'),actions=ids(doc?.actions,'/actions'),steps=ids(doc?.workflow?.steps,'/workflow/steps');
  const ref=(known:Map<string,unknown>,kind:string):Check=>(v,p)=>{if(typeof v!=='string')err(p,`Must be a ${kind} ID`);else if(!known.has(v))err(p,`Unknown ${kind} "${v}"`);};
  // A small JSON Schema subset for action inputs/results.
  const schema:Check=(v,p)=>{
    const described={description:text_(500)};
    if(!isObject(v))return err(p,'Must be an object');
    if(v.type==='object')shape(v,p,{type:()=>{},properties:(props,q)=>{
      if(!isObject(props))return err(q,'Must be an object');
      for(const [k,s] of Object.entries(props)){if(!FIELD.test(k))err(q+pointer(k),`Property names must match ${FIELD}`);schema(s,q+pointer(k));}
    }},{...described,required:(names,q)=>{
      if(!Array.isArray(names))return err(q,'Must be an array');
      names.forEach((n,i)=>{if(typeof n!=='string'||!isObject(v.properties)||!Object.hasOwn(v.properties,n)||names.indexOf(n)!==i)err(`${q}/${i}`,'Must name each declared property once');});
    }});
    else if(v.type==='array')shape(v,p,{type:()=>{},items:schema},described);
    else if(['string','number','integer','boolean'].includes(v.type))shape(v,p,{type:()=>{}},described);
    else err(p+'/type','Must be one of "object", "array", "string", "number", "integer", "boolean"');
  };
  const topSchema:Check=(v,p)=>{if(isObject(v)&&v.type!=='object')err(p+'/type','Top-level schema must be "object"');else schema(v,p);};
  // Read-only actions on public HTTPS hostnames; destination approval and DNS checks happen again at run time.
  const destination:Check=(v,p)=>{
    let url:URL|undefined;try{url=new URL(v);}catch{}
    if(typeof v!=='string'||v.length>2000||!url||url.protocol!=='https:'||url.username||url.password||url.hash
      ||/^\[|^\d+\.\d+\.\d+\.\d+$|(^|\.)localhost$/i.test(url.hostname.replace(/\.$/,''))||!url.hostname.replace(/\.$/,'').includes('.'))
      err(p,'Must be an https:// URL on a public hostname, without credentials or fragment');
  };
  const stepFields:Record<string,Record<string,Check>>={
    retrieval:{sources:list(ref(sources,'source'),1)},
    condition:{field:text_(64,FIELD),equals:(v,p)=>{if(!['string','boolean'].includes(typeof v)&&!(typeof v==='number'&&Number.isFinite(v)))err(p,'Must be text, a number or true/false');}},
    http:{action:ref(actions,'action')},
    agent:{agent:ref(agents,'agent'),final:bool},
    handoff:{}
  };
  const step:Check=(v,p)=>{
    if(!isObject(v))return err(p,'Must be an object');
    if(!Object.hasOwn(stepFields,v.type))return err(p+'/type',`Must be one of ${Object.keys(stepFields).map(t=>`"${t}"`).join(', ')}`);
    shape(v,p,{id:text_(64,ID),type:()=>{},position:(pos,q)=>shape(pos,q,{x:finite,y:finite}),...stepFields[v.type]});
  };
  const linked=new Map<string,number>();
  const connection:Check=(v,p)=>{
    shape(v,p,{from:ref(steps,'step'),output:(o,q)=>{
      const from=steps.get(v.from);
      if(from&&!outputs(from).includes(o))err(q,`Step "${v.from}" offers ${outputs(from).map(x=>`"${x}"`).join(', ')||'no outputs'}`);
    },to:(t,q)=>{if(t!==null)ref(steps,'step')(t,q);}});
    if(!isObject(v))return;
    const key=`${v.from}\u0000${v.output}`;
    if(linked.has(key))err(p,`Output "${v.output}" of "${v.from}" is already connected`);else linked.set(key,Number(p.split('/').at(-1)));
  };
  shape(doc,'',{
    schema_version:oneOf(1),
    generation:(v,p)=>shape(v,p,{mode:oneOf('simulation','connected')}),
    agents:list((v,p)=>shape(v,p,{id:text_(64,ID),name:text_(120),instructions:text_(20000)},{
      sources:list(ref(sources,'source')),actions:list(ref(actions,'action')),
      model:(m,q)=>shape(m,q,{provider:oneOf('deepseek','qwen'),name:text_(100)},{temperature:number(0,2),max_tokens:number(1,8192,true)})
    })),
    actions:list((v,p)=>shape(v,p,{id:text_(64,ID),method:oneOf('GET'),url:destination,input_schema:topSchema,result_schema:topSchema,
      credential:text_(100,REF),authorization:text_(100,REF),timeout_ms:number(1,15000,true)})),
    workflow:(v,p)=>shape(v,p,{entry:(e,q)=>{if(e!==null)ref(steps,'step')(e,q);},steps:list(step,1),connections:list(connection)})
  },{
    decision:(v,p)=>shape(v,p,{engine:oneOf('jev','laya','von')},{model:text_(100)}),
    sources:list((v,p)=>shape(v,p,{id:text_(100,REF),priority:number(1,1000,true)}))
  });
  const workflow=doc?.workflow;
  if(isObject(workflow)&&Array.isArray(workflow.steps)) {
    if(workflow.entry===null)blockers.push({path:'/workflow/entry',message:'Choose a start step'});
    workflow.steps.forEach((s:any,i:number)=>{
      if(!isObject(s)||steps.get(s.id)!==s)return;
      for(const output of outputs(s)) {
        const at=linked.get(`${s.id}\u0000${output}`);
        if(at===undefined)blockers.push({path:`/workflow/steps/${i}`,message:`Output "${output}" of "${s.id}" is unconnected`});
        else if(workflow.connections[at].to===null)blockers.push({path:`/workflow/connections/${at}/to`,message:`Output "${output}" of "${s.id}" has no target`});
      }
    });
  }
  return {json_valid:true,errors,blockers};
}

const route=new RegExp(`^/api/businesses/(${uuid})/configuration(?:/(publish)|/versions/(\\d{1,9}))?$`);
const revision=(v:unknown)=>{if(typeof v!=='string'||!/^\d{1,18}$/.test(v))throw new Failure(400,'Provide the expected revision as a string');return v;};
const latest=async(client:PoolClient,business:string)=>(await client.query(`SELECT d.text,d.revision,d.base_version,d.updated_at,
  (SELECT max(version) FROM published_configurations WHERE business_id=d.business_id) AS published_version
  FROM configuration_drafts d WHERE d.business_id=$1`,[business])).rows[0];
// Owner-only draft/publication API; every request rechecks the current Owner Membership under the Business lock.
export async function configuration(req:IncomingMessage,path:string,user:{id:string},json:(status:number,value:unknown)=>void) {
  const match=path.match(route);
  if(!match)return false;
  const [,business,publish,version]=match;
  let client:PoolClient|undefined;
  try {
    if(version?req.method!=='GET':publish?req.method!=='POST':!['GET','POST'].includes(req.method??''))throw new Failure(404,'Not found');
    const input=req.method==='POST'?await body(req,1572864):null;
    if(input&&publish)keys(input,['revision']);
    if(input&&!publish) {
      keys(input,['text','revision']);
      if(typeof input.text!=='string'||input.text.length>MAX_TEXT||unstorable.test(input.text))throw new Failure(400,`Provide text (at most ${MAX_TEXT} characters, without NUL or unpaired surrogates) and revision`);
    }
    const expected=input?revision(input.revision):'';
    client=await pool.connect();
    await client.query('BEGIN');
    // Reads share the lock; writes serialize with each other and with Membership changes.
    await client.query(`SELECT id FROM businesses WHERE id=$1 ${input?'FOR NO KEY UPDATE':'FOR SHARE'}`,[business]);
    if(!(await client.query("SELECT 1 FROM memberships WHERE business_id=$1 AND operator_id=$2 AND active AND role='Owner'",[business,user.id])).rowCount)throw new Failure(404,'Business not found');
    const draft=await latest(client,business);
    if(version) {
      const found=await client.query('SELECT version,document,published_at FROM published_configurations WHERE business_id=$1 AND version=$2',[business,version]);
      if(!found.rowCount)throw new Failure(404,'Version not found');
      await client.query('COMMIT');json(200,found.rows[0]);return true;
    }
    if(!input){await client.query('COMMIT');json(200,{...draft,validation:validate(draft.text)});return true;}
    if(draft.revision!==expected) {
      await client.query('ROLLBACK');
      json(409,{error:'The draft changed since your revision; your text was not saved. Compare with the latest draft before retrying.',latest:draft});return true;
    }
    if(publish) {
      const validation=validate(draft.text);
      if(!validation.json_valid||validation.errors.length||validation.blockers.length) {
        await client.query('ROLLBACK');json(422,{error:'Fix the listed problems before publishing',validation});return true;
      }
      const next=Number(draft.published_version)+1;
      // Publication is the draft's next revision, so a concurrent save or publish of the same revision gets 409.
      await client.query('INSERT INTO published_configurations(business_id,version,document,published_by) VALUES($1,$2,$3,$4)',[business,next,draft.text,user.id]);
      const updated=await client.query('UPDATE configuration_drafts SET revision=revision+1,base_version=$2,updated_by=$3,updated_at=clock_timestamp() WHERE business_id=$1 RETURNING revision',[business,next,user.id]);
      await client.query('COMMIT');json(201,{version:next,revision:updated.rows[0].revision});return true;
    }
    const validation=validate(input.text);
    const valid=validation.json_valid&&!validation.errors.length;
    const updated=await client.query(`UPDATE configuration_drafts SET text=$2,last_valid=coalesce($3::jsonb,last_valid),
      revision=revision+1,updated_by=$4,updated_at=clock_timestamp() WHERE business_id=$1 RETURNING revision,base_version`,[business,input.text,valid?input.text:null,user.id]);
    await client.query('COMMIT');json(200,{...updated.rows[0],validation});return true;
  } catch(error) {
    await client?.query('ROLLBACK');
    if(error instanceof Failure){json(error.status,{error:error.message});return true;}
    throw error;
  } finally {client?.release();}
}
