import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base, client, compose, invitationToken, operator, ready, together } from './helpers.mjs';
const site='https://shop-config.example.test';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const sql=query=>compose('exec','-T','db','psql','-v','ON_ERROR_STOP=1','-U','custom_bot','-d','custom_bot','-tAc',query);
// One shared Owner keeps the suite under Better Auth's per-IP limits.
const shared=operator('config-owner');
async function business(name) {
  const owner=await shared;
  const created=(await owner.request('/api/businesses',{name})).data;
  return {owner,id:created.id,path:`/api/businesses/${created.id}/configuration`};
}
// Every supported field: sources/priorities, decision, agent models and parameters, nested action schemas, all step types and fractional/negative positions.
const full=()=>({
  schema_version:1,
  generation:{mode:'simulation'},
  decision:{engine:'jev',model:'jev-small'},
  sources:[{id:'policies',priority:1},{id:'catalogue',priority:2}],
  agents:[
    {id:'router',name:'Router',instructions:'Classify the request.',sources:['policies'],actions:[],model:{provider:'qwen',name:'qwen3.7-plus-2026-05-26',temperature:0,max_tokens:256}},
    {id:'support',name:'Order support — “ünïcode”',instructions:'Answer from assigned knowledge.\nUse authorized order lookup.',sources:['policies','catalogue'],actions:['order_status'],model:{provider:'deepseek',name:'deepseek-flash',temperature:0.4,max_tokens:1024}}
  ],
  actions:[{id:'order_status',method:'GET',url:'https://orders.example.com/status?format=json',
    input_schema:{type:'object',properties:{order_id:{type:'string',description:'Order number'}},required:['order_id']},
    result_schema:{type:'object',properties:{status:{type:'string'},items:{type:'array',items:{type:'object',properties:{sku:{type:'string'},quantity:{type:'integer'}},required:['sku']}},paid:{type:'boolean'},total:{type:'number'}},required:['status']},
    credential:'order_api',authorization:'order_owner',timeout_ms:15000}],
  workflow:{entry:'retrieve',steps:[
    {id:'retrieve',type:'retrieval',sources:['policies','catalogue'],position:{x:0,y:160}},
    {id:'classify',type:'agent',agent:'router',final:false,position:{x:280.5,y:-40.25}},
    {id:'route',type:'condition',field:'intent',equals:'order_status',position:{x:560,y:160}},
    {id:'lookup',type:'http',action:'order_status',position:{x:840,y:0}},
    {id:'reply',type:'agent',agent:'support',final:true,position:{x:1120,y:200}},
    {id:'handoff',type:'handoff',position:{x:1400,y:440}},
    {id:'triage',type:'decision',question:'What does the Customer want?',choices:{refund:'A refund, return or replacement',order_status:'Where an order is or when it arrives'},min_probability:0.6,position:{x:-280,y:-120.5}}
  ],connections:[
    {from:'retrieve',output:'next',to:'classify'},
    {from:'classify',output:'next',to:'route'},{from:'classify',output:'unsupported',to:'handoff'},
    {from:'route',output:'yes',to:'lookup'},{from:'route',output:'fallback',to:'reply'},
    {from:'lookup',output:'success',to:'reply'},{from:'lookup',output:'failure',to:'handoff'},
    {from:'reply',output:'unsupported',to:'handoff'},
    {from:'triage',output:'refund',to:'reply'},{from:'triage',output:'order_status',to:'lookup'},
    {from:'triage',output:'uncertain',to:'handoff'},{from:'triage',output:'failure',to:'handoff'}
  ]}
});
const save=(b,text,revision)=>b.owner.request(b.path,{text,revision});
async function current(b){const r=await b.owner.request(b.path);assert.equal(r.status,200);return r.data;}
// A Customer starting chat on the Business website pins the current published version.
async function chat(b) {
  assert.equal((await b.owner.request(`/api/businesses/${b.id}/website-origins`,{origin:site,approved:true})).status,200);
  const call=(token)=>async(path,body)=>{
    const r=await fetch(`${base}/api/chat/${b.id}/${path}`,{method:body===undefined?'GET':'POST',headers:{origin:site,'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:r.status,data:await r.json()};
  };
  return async()=>{
    const created=await call()('conversations',{});
    assert.equal(created.status,201);
    const request=call(created.data.token),path=`conversations/${created.data.conversation.id}`;
    return {version:created.data.conversation.configuration_version,async reply(){
      const sent=await request(path+'/messages',{client_submission_id:crypto.randomUUID(),text:'Hello'});
      assert.equal(sent.status,202);
      for(let i=0;i<80;i++){const c=(await request(path)).data;const done=c.messages.find(m=>m.reply_to===sent.data.message.id);if(done)return done;await wait(250);}
      throw new Error('No reply');
    }};
  };
}

test('Configuration: every supported value round-trips through draft and immutable publication; conversations keep their version',async()=>{
  const b=await business('Config round-trip');
  const start=await chat(b);
  const before=await start();
  assert.equal(before.version,1);
  const initial=await current(b);
  assert.equal(initial.published_version,1);
  assert.deepEqual(initial.validation,{json_valid:true,errors:[],blockers:[]},'A new Business draft is publishable as created');
  // Custom formatting and key order survive exactly; nothing is stripped or rewritten.
  const text=JSON.stringify(full(),null,3).replace('"schema_version": 1','"schema_version":   1');
  const saved=await save(b,text,initial.revision);
  assert.equal(saved.status,200,JSON.stringify(saved.data));
  assert.deepEqual(saved.data.validation,{json_valid:true,errors:[],blockers:[]});
  const draft=await current(b);
  assert.equal(draft.text,text);assert.equal(draft.revision,saved.data.revision);
  const published=await b.owner.request(b.path+'/publish',{revision:draft.revision});
  assert.equal(published.status,201,JSON.stringify(published.data));
  assert.equal(published.data.version,2);
  const version=await b.owner.request(b.path+'/versions/2');
  assert.equal(version.status,200);
  assert.deepEqual(version.data.document,JSON.parse(text));
  const after=await current(b);
  assert.equal(after.text,text);assert.equal(after.published_version,2);assert.equal(after.base_version,2);
  assert.notEqual(after.revision,draft.revision,'Publication is a draft mutation; stale clients must reload');
  // New conversations pin version 2; the earlier conversation keeps version 1. Both still reply (simulation).
  const later=await start();
  assert.equal(later.version,2);
  assert.equal((await before.reply()).simulated,true);
  assert.equal((await later.reply()).simulated,true);
  // Publishing connected mode without providers fails new turns visibly instead of inventing replies; v2 conversations are unaffected.
  const connected=full();connected.generation.mode='connected';
  const r=await save(b,JSON.stringify(connected),after.revision);
  assert.equal((await b.owner.request(b.path+'/publish',{revision:r.data.revision})).data.version,3);
  const third=await start();
  assert.equal(third.version,3);
  assert.equal((await third.reply()).author,'system');
  assert.equal((await later.reply()).simulated,true);
  // Published versions are immutable even to direct SQL.
  assert.throws(()=>sql(`UPDATE published_configurations SET document='{}' WHERE business_id='${b.id}' AND version=2`),e=>e.stderr.includes('immutable'));
  assert.throws(()=>sql(`DELETE FROM published_configurations WHERE business_id='${b.id}' AND version=2`),e=>e.stderr.includes('immutable'));
  assert.deepEqual((await b.owner.request(b.path+'/versions/2')).data.document,JSON.parse(text));
});

test('Configuration: invalid raw JSON survives save and restart but cannot publish or execute; incomplete drafts stay editable',async()=>{
  const b=await business('Config invalid');
  const start=await chat(b);
  const invalid='{\n  "schema_version": 1,\n  "agents": [\n    {"id": "a",}\n  ]\n}';
  const initial=await current(b);
  const saved=await save(b,invalid,initial.revision);
  assert.equal(saved.status,200);
  assert.equal(saved.data.validation.json_valid,false);
  assert.deepEqual(saved.data.validation.errors.map(e=>[e.line,e.column]),[[4,16]]);
  compose('restart','app');await ready();
  const draft=await current(b);
  assert.equal(draft.text,invalid);
  assert.equal(draft.validation.json_valid,false);
  const blocked=await b.owner.request(b.path+'/publish',{revision:draft.revision});
  assert.equal(blocked.status,422);
  assert.equal(blocked.data.validation.json_valid,false);
  assert.equal((await b.owner.request(b.path+'/versions/2')).status,404);
  assert.equal((await current(b)).published_version,1);
  const conversation=await start();
  assert.equal(conversation.version,1);
  assert.equal((await conversation.reply()).simulated,true);
  // Structurally valid but incomplete: entry and an output target may be null; saves succeed, publication lists located blockers.
  const incomplete=full();incomplete.workflow.entry=null;
  incomplete.workflow.connections[0].to=null;
  incomplete.workflow.connections=incomplete.workflow.connections.filter(c=>!(c.from==='lookup'&&c.output==='failure'));
  const r=await save(b,JSON.stringify(incomplete),draft.revision);
  assert.equal(r.status,200);
  assert.deepEqual(r.data.validation.errors,[]);
  assert.deepEqual(r.data.validation.blockers.map(e=>e.path).sort(),['/workflow/connections/0/to','/workflow/entry','/workflow/steps/3']);
  const refused=await b.owner.request(b.path+'/publish',{revision:r.data.revision});
  assert.equal(refused.status,422);
  assert.equal(refused.data.validation.blockers.length,3);
  assert.equal((await current(b)).published_version,1);
  // Oversized text and raw NUL are refused without changing the stored draft.
  assert.equal((await save(b,'x'.repeat(262145),r.data.revision)).status,400);
  assert.equal((await save(b,'{"a":"\u0000"}',r.data.revision)).status,400);
  assert.equal((await current(b)).text,JSON.stringify(incomplete));
  // A decision step needs a selected decision engine before publication.
  const engineless=full();delete engineless.decision;
  const e=await save(b,JSON.stringify(engineless),(await current(b)).revision);
  assert.deepEqual([e.data.validation.errors,e.data.validation.blockers.map(x=>x.path)],[[],['/decision']]);
});

const edit=(change)=>{const c=full();change(c);return JSON.stringify(c);};
const cases=[
  ['unknown top-level field',edit(c=>{c.extra=true;}),'/extra'],
  ['unknown field cannot hide as an Object prototype name',edit(c=>{c.agents[0].constructor='x';}),'/agents/0/constructor'],
  ['secret-looking agent field',edit(c=>{c.agents[0].api_key='sk-test';}),'/agents/0/api_key'],
  ['inline action header',edit(c=>{c.actions[0].headers={authorization:'Bearer x'};}),'/actions/0/headers'],
  ['duplicate agent ID',edit(c=>{c.agents[1].id='router';}),'/agents/1/id'],
  ['duplicate step ID',edit(c=>{c.workflow.steps[1].id='retrieve';}),'/workflow/steps/1/id'],
  ['duplicate source ID',edit(c=>{c.sources[1].id='policies';}),'/sources/1/id'],
  ['dangling connection target',edit(c=>{c.workflow.connections[0].to='missing';}),'/workflow/connections/0/to'],
  ['dangling connection source',edit(c=>{c.workflow.connections[0].from='missing';}),'/workflow/connections/0/from'],
  ['dangling entry',edit(c=>{c.workflow.entry='missing';}),'/workflow/entry'],
  ['dangling step agent',edit(c=>{c.workflow.steps[4].agent='missing';}),'/workflow/steps/4/agent'],
  ['dangling step action',edit(c=>{c.workflow.steps[3].action='missing';}),'/workflow/steps/3/action'],
  ['dangling agent action',edit(c=>{c.agents[1].actions=['missing'];}),'/agents/1/actions/0'],
  ['dangling agent source',edit(c=>{c.agents[1].sources=['missing'];}),'/agents/1/sources/0'],
  ['dangling retrieval source',edit(c=>{c.workflow.steps[0].sources=['missing'];}),'/workflow/steps/0/sources/0'],
  ['output not offered by step type',edit(c=>{c.workflow.connections[5].output='yes';}),'/workflow/connections/5/output'],
  ['duplicate connection output',edit(c=>{c.workflow.connections.push({from:'retrieve',output:'next',to:'handoff'});}),'/workflow/connections/12'],
  ['non-finite position',edit(c=>{c.workflow.steps[0].position.x=123456;}).replace('123456','1e999'),'/workflow/steps/0/position/x'],
  ['non-numeric position',edit(c=>{c.workflow.steps[0].position.y='10';}),'/workflow/steps/0/position/y'],
  ['missing position',edit(c=>{delete c.workflow.steps[5].position;}),'/workflow/steps/5/position'],
  ['unsupported step type',edit(c=>{c.workflow.steps[5].type='script';}),'/workflow/steps/5/type'],
  ['unsupported schema version',edit(c=>{c.schema_version=2;}),'/schema_version'],
  ['unsupported generation mode',edit(c=>{c.generation.mode='offline';}),'/generation/mode'],
  ['unsupported provider',edit(c=>{c.agents[0].model.provider='other';}),'/agents/0/model/provider'],
  ['unbounded temperature',edit(c=>{c.agents[0].model.temperature=5;}),'/agents/0/model/temperature'],
  ['unbounded max_tokens',edit(c=>{c.agents[0].model.max_tokens=1e6;}),'/agents/0/model/max_tokens'],
  ['malformed input schema type',edit(c=>{c.actions[0].input_schema.properties.order_id.type='map';}),'/actions/0/input_schema/properties/order_id/type'],
  ['required names undeclared property',edit(c=>{c.actions[0].input_schema.required=['email'];}),'/actions/0/input_schema/required/0'],
  ['unknown schema keyword',edit(c=>{c.actions[0].result_schema.additionalProperties=true;}),'/actions/0/result_schema/additionalProperties'],
  ['write method',edit(c=>{c.actions[0].method='POST';}),'/actions/0/method'],
  ['plain HTTP destination',edit(c=>{c.actions[0].url='http://orders.example.com/status';}),'/actions/0/url'],
  ['loopback destination',edit(c=>{c.actions[0].url='https://127.0.0.1/status';}),'/actions/0/url'],
  ['encoded loopback destination',edit(c=>{c.actions[0].url='https://0x7f000001/status';}),'/actions/0/url'],
  ['private IPv6 destination',edit(c=>{c.actions[0].url='https://[::1]/status';}),'/actions/0/url'],
  ['localhost destination',edit(c=>{c.actions[0].url='https://api.localhost/status';}),'/actions/0/url'],
  ['credentials in URL',edit(c=>{c.actions[0].url='https://user:secret@orders.example.com/status';}),'/actions/0/url'],
  ['authorization disabled',edit(c=>{c.actions[0].authorization=null;}),'/actions/0/authorization'],
  ['authorization removed',edit(c=>{delete c.actions[0].authorization;}),'/actions/0/authorization'],
  ['credential reference removed',edit(c=>{delete c.actions[0].credential;}),'/actions/0/credential'],
  ['timeout over 15 seconds',edit(c=>{c.actions[0].timeout_ms=15001;}),'/actions/0/timeout_ms'],
  ['NUL character in a value',edit(c=>{c.agents[0].name='bad\u0000name';}),'/agents/0/name'],
  ['excessive nesting',edit(c=>{let s={type:'string'};for(let i=0;i<80;i++)s={type:'array',items:s};c.actions[0].result_schema.properties.deep=s;}),'/actions/0/result_schema/properties/deep'],
  ['document is not an object',JSON.stringify([full()]),''],
  ['inherited name as step type',edit(c=>{c.workflow.steps[5].type='toString';}),'/workflow/steps/5/type'],
  ['number PostgreSQL cannot store',edit(c=>{c.workflow.steps[0].position.x=123456;}).replace('123456','1e-200000'),'/workflow/steps/0/position/x'],
  ['duplicate object key',edit(()=>{}).replace('"name":"Router"','"name":"Router","name":"Other"'),''],
  ['trailing-dot localhost destination',edit(c=>{c.actions[0].url='https://localhost./status';}),'/actions/0/url'],
  ['decision choice named like a reserved output',edit(c=>{c.workflow.steps[6].choices.failure='Something broke';}),'/workflow/steps/6/choices/failure'],
  ['decision choice name that is not a field name',edit(c=>{c.workflow.steps[6].choices['two words']='x';}),'/workflow/steps/6/choices/two words'],
  ['decision with a single choice',edit(c=>{c.workflow.steps[6].choices={refund:'A refund'};}),'/workflow/steps/6/choices'],
  ['decision choice without a description',edit(c=>{c.workflow.steps[6].choices.refund='';}),'/workflow/steps/6/choices/refund'],
  ['decision threshold above 1',edit(c=>{c.workflow.steps[6].min_probability=1.5;}),'/workflow/steps/6/min_probability'],
  ['decision question too long',edit(c=>{c.workflow.steps[6].question='x'.repeat(2001);}),'/workflow/steps/6/question'],
  ['decision connection for an undeclared choice',edit(c=>{c.workflow.connections.push({from:'triage',output:'exchange',to:'handoff'});}),'/workflow/connections/12/output'],
  ['unsupported decision engine',edit(c=>{c.decision.engine='other';}),'/decision/engine'],
  ['NUL character in a key',edit(c=>{c.agents[0]['bad\u0000key']=1;}),'/agents/0/bad'],
];
test('Configuration: unknown, duplicate, dangling, non-finite, malformed and authorization-bypass edits block publication with located errors',async()=>{
  const b=await business('Config validation');
  let revision=(await current(b)).revision;
  for(const [name,text,path] of cases) {
    const saved=await save(b,text,revision);
    assert.equal(saved.status,200,name);
    revision=saved.data.revision;
    assert(saved.data.validation.errors.some(e=>e.path.startsWith(path)&&e.message),`${name}: expected ${path}, got ${JSON.stringify(saved.data.validation.errors)}`);
    assert.equal((await current(b)).text,text,name);
    const refused=await b.owner.request(b.path+'/publish',{revision});
    assert.equal(refused.status,422,name);
    assert.deepEqual(refused.data.validation,saved.data.validation,name);
  }
  // Every kind of JSON syntax error is located, including those V8 reports without a position.
  for(const [text,line,column] of [['[,]',1,2],['{"a":tru}',1,6],['{"a":1} x',1,9],['{"a":01}',1,7],['"\\q"',1,3],['{\n  "a": "x',2,10],['',1,1]]) {
    const saved=await save(b,text,revision);
    revision=saved.data.revision;
    assert.deepEqual(saved.data.validation.errors.map(e=>[e.path,e.line,e.column]),[['',line,column]],text);
  }
  assert.equal((await current(b)).published_version,1);
  assert.equal((await b.owner.request(b.path+'/versions/2')).status,404);
  // Malformed requests change nothing.
  for(const body of [{text:'{}'},{revision},{text:1,revision},{text:'{}',revision,business_id:b.id},{text:'{}',revision:1}])
    assert.equal((await b.owner.request(b.path,body)).status,400,JSON.stringify(body));
  for(const body of [{},{revision:Number(revision)},{revision,text:'{}'}])
    assert.equal((await b.owner.request(b.path+'/publish',body)).status,400,JSON.stringify(body));
});

test('Configuration: stale and concurrent saves/publications are rejected with the latest draft while nothing is overwritten',async()=>{
  const b=await business('Config races');
  const {revision}=await current(b);
  const owner=await shared;
  const texts=[0,1].map(i=>edit(c=>{c.agents[0].name=`Owner ${i}`;}));
  const saves=await together(texts.map(text=>({path:b.path,body:{text,revision},headers:{cookie:owner.cookie}})));
  assert.deepEqual(saves.map(r=>r.status).sort(),[200,409]);
  const winner=saves.find(r=>r.status===200),loser=saves.find(r=>r.status===409);
  const draft=await current(b);
  assert.equal(draft.revision,winner.data.revision);
  assert.equal(loser.data.latest.text,draft.text);
  assert.equal(loser.data.latest.revision,draft.revision);
  assert(texts.includes(draft.text));
  // A stale save or publication changes nothing.
  const stale=await save(b,'{"stale":true}',revision);
  assert.equal(stale.status,409);assert.equal(stale.data.latest.text,draft.text);
  assert.equal((await b.owner.request(b.path+'/publish',{revision})).status,409);
  assert.equal((await current(b)).text,draft.text);
  assert.equal((await current(b)).published_version,1);
  // Two Owners publish the same revision: exactly one monotonic version is created.
  const publications=await together([0,1].map(()=>({path:b.path+'/publish',body:{revision:draft.revision},headers:{cookie:owner.cookie}})));
  assert.deepEqual(publications.map(r=>r.status).sort(),[201,409]);
  assert.equal(publications.find(r=>r.status===201).data.version,2);
  assert.equal((await b.owner.request(b.path+'/versions/3')).status,404);
  // Concurrent publish and save at one revision: one wins, and the draft is never silently replaced.
  const next=(await current(b)).revision;
  const mixed=await together([{path:b.path+'/publish',body:{revision:next},headers:{cookie:owner.cookie}},{path:b.path,body:{text:'{"late":true}',revision:next},headers:{cookie:owner.cookie}}]);
  assert.equal(mixed.filter(r=>r.status===409).length,1);
  const settled=await current(b);
  if(mixed[0].status===201){assert.equal(settled.text,draft.text);assert.equal(settled.published_version,3);}
  else {assert.equal(settled.text,'{"late":true}');assert.equal(settled.published_version,2);}
});

test('Configuration: Owner-only access; Support, other Businesses, signed-out and cross-origin requests are denied',async()=>{
  const b=await business('Config access');
  const support=await operator('config-support');
  assert.equal((await b.owner.request(`/api/businesses/${b.id}/invitations`,{email:support.email,role:'Support'})).status,201);
  assert.equal((await support.request('/api/invitations/accept',{token:await invitationToken(support.email)})).status,200);
  const foreign=(await support.request('/api/businesses',{name:'Support-owned'})).data;
  const {revision,text}=await current(b);
  for(const request of [support.request,await client()]) {
    const expected=request===support.request?404:401;
    assert.equal((await request(b.path)).status,expected);
    assert.equal((await request(b.path,{text:'{}',revision})).status,expected);
    assert.equal((await request(b.path+'/publish',{revision})).status,expected);
    assert.equal((await request(b.path+'/versions/1')).status,expected);
  }
  const foreignPath=`/api/businesses/${foreign.id}/configuration`;
  assert.equal((await b.owner.request(foreignPath)).status,404);
  assert.equal((await b.owner.request(foreignPath+'/versions/1')).status,404);
  assert.equal((await support.request(foreignPath)).status,200,'Support in B can be Owner in another Business');
  assert.equal((await b.owner.request(b.path,{text:'{}',revision},{headers:{origin:'https://evil.test'}})).status,403);
  assert.equal((await b.owner.request(b.path+'/publish',{revision},{headers:{origin:null}})).status,403);
  const after=await current(b);
  assert.equal(after.text,text);assert.equal(after.revision,revision);assert.equal(after.published_version,1);
  // Removing Owner authority applies to the existing session on its next request.
  const members=(await b.owner.request(`/api/businesses/${b.id}/memberships`)).data;
  const s=members.find(m=>m.operator_id===support.id);
  assert.equal((await b.owner.request(`/api/businesses/${b.id}/memberships/${support.id}`,{role:'Owner',active:true,revision:s.revision})).status,200);
  assert.equal((await support.request(b.path)).status,200);
  assert.equal((await b.owner.request(`/api/businesses/${b.id}/memberships/${support.id}`,{role:'Support',active:true,revision:String(Number(s.revision)+1)})).status,200);
  assert.equal((await support.request(b.path)).status,404);
});
