import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { base, compose, invitationToken, operator, ready, together } from './helpers.mjs';
const siteA='https://shop-a.example.test', siteB='https://shop-b.example.test';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
// A Customer browser on a Business website: Origin plus its own anonymous bearer token, no cookies.
const customer=(origin,token)=>async(path,body,method)=>{
  const response=await fetch(`${base}/api/chat/${path}`,{method:method??(body===undefined?'GET':'POST'),
    headers:{...(origin?{origin}:{}),...(token?{authorization:`Bearer ${token}`}:{}),'content-type':'application/json'},
    body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,data:await response.json().catch(()=>null),headers:response.headers};
};
async function chatBusiness(prefix) {
  const owner=await operator(prefix);
  const business=(await owner.request('/api/businesses',{name:`${prefix} Business`})).data;
  assert.equal((await owner.request(`/api/businesses/${business.id}/website-origins`,{origin:siteA,approved:true})).status,200);
  return {owner,business};
}
async function start(business,origin=siteA) {
  const created=await customer(origin)(`${business.id}/conversations`,{});
  assert.equal(created.status,201,JSON.stringify(created.data));
  return {token:created.data.token,conversation:created.data.conversation,request:customer(origin,created.data.token),path:`${business.id}/conversations/${created.data.conversation.id}`};
}
async function settled(session,until=c=>c.messages.every(m=>m.author!=='customer'||['completed','failed'].includes(m.turn_state))) {
  for(let i=0;i<120;i++){const c=(await session.request(session.path)).data;if(until(c))return c;await wait(250);}
  throw new Error('Conversation did not settle');
}
const replies=(conversation,message)=>conversation.messages.filter(m=>m.reply_to===message.id);

test('Website chat: Business-approved origins and session-scoped conversations',async()=>{
  const {owner,business:a}=await chatBusiness('chat-origins');
  const b=(await owner.request('/api/businesses',{name:'Chat Other Business'})).data;
  const origins=id=>`/api/businesses/${id}/website-origins`;
  for(const origin of ['javascript:alert(1)','https://shop.example.test/path','ftp://shop.example.test','not a url','https://user@shop.example.test',' https://shop.example.test',`https://${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.example.test`])
    assert.equal((await owner.request(origins(a.id),{origin,approved:true})).status,400,origin);
  assert.equal((await owner.request(origins(a.id),{origin:siteA,approved:true,business_id:b.id})).status,400);
  assert.equal((await owner.request(origins(a.id),{origin:siteA,approved:true})).status,200);
  assert.equal((await owner.request(origins(b.id),{origin:siteB,approved:true})).status,200);
  assert.deepEqual((await owner.request(origins(a.id))).data,[siteA]);
  const support=await operator('chat-origins-support');
  assert.equal((await owner.request(`/api/businesses/${a.id}/invitations`,{email:support.email,role:'Support'})).status,201);
  assert.equal((await support.request('/api/invitations/accept',{token:await invitationToken(support.email)})).status,200);
  assert.equal((await support.request(origins(a.id))).status,404);
  assert.equal((await support.request(origins(a.id),{origin:'https://support.example.test',approved:true})).status,404);

  // Unknown Business, unapproved and missing origins are indistinguishable and grant no CORS access.
  for(const [origin,id] of [[siteB,a.id],[null,a.id],[siteA,crypto.randomUUID()]]) {
    const denied=await customer(origin)(`${id}/conversations`,{});
    assert.equal(denied.status,403);assert.equal(denied.headers.get('access-control-allow-origin'),null);
    assert(!JSON.stringify(denied.data).includes('Chat'));
  }
  const preflight=await customer(siteA)(`${a.id}/conversations`,undefined,'OPTIONS');
  assert.equal(preflight.status,204);
  assert.equal(preflight.headers.get('access-control-allow-origin'),siteA);
  assert.match(preflight.headers.get('access-control-allow-headers'),/authorization/);
  assert.equal((await customer(siteB)(`${a.id}/conversations`,undefined,'OPTIONS')).status,403);

  const first=await start(a);
  assert.match(first.token,/^[a-f0-9]{64}$/);
  assert.deepEqual({...first.conversation,id:undefined},{id:undefined,control_state:'automated',configuration_version:1,mode:'simulation',messages:[]});
  const second=await first.request(`${a.id}/conversations`,{});
  assert.equal(second.status,201);assert.equal(second.data.token,undefined);
  assert.deepEqual((await first.request(`${a.id}/conversations`)).data.map(c=>c.id).sort(),[first.conversation.id,second.data.conversation.id].sort());
  const other=await start(a);
  assert.deepEqual((await other.request(`${a.id}/conversations`)).data.map(c=>c.id),[other.conversation.id]);
  assert.equal((await other.request(first.path)).status,404);
  assert.equal((await other.request(first.path+'/messages',{client_submission_id:'foreign-1',text:'Hi'})).status,404);
  assert.equal((await customer(siteA,'f'.repeat(64))(first.path)).status,401);
  assert.equal((await customer(siteA,'not-a-token')(`${a.id}/conversations`,{})).status,401);
  // A token from Business A cannot select Business B, even from B's approved website.
  assert.equal((await customer(siteB,first.token)(`${b.id}/conversations`)).status,401);
  assert.equal((await customer(siteB,first.token)(`${b.id}/conversations/${first.conversation.id}`)).status,401);
  assert.equal((await customer(siteA)(`${a.id}/conversations`,{business_id:b.id})).status,400);
  assert.equal((await first.request(first.path)).headers.get('access-control-allow-origin'),siteA);

  // Withdrawing an origin cuts off existing sessions on their next request.
  assert.equal((await owner.request(origins(a.id),{origin:siteA,approved:false})).status,200);
  assert.deepEqual((await owner.request(origins(a.id))).data,[]);
  assert.equal((await first.request(first.path)).status,403);
  assert.equal((await owner.request(origins(a.id),{origin:siteA,approved:true})).status,200);
  assert.equal((await first.request(first.path)).status,200);
});

test('Website chat: duplicate submissions deliver exactly one message and turn, including concurrent retries',async()=>{
  const {business}=await chatBusiness('chat-duplicates');
  const session=await start(business);
  const send=body=>session.request(session.path+'/messages',body);
  for(const body of [{text:'Hi'},{client_submission_id:'ok-id-1',text:''},{client_submission_id:'ok-id-1',text:'x'.repeat(2001)},
    {client_submission_id:'bad id!',text:'Hi'},{client_submission_id:'short',text:'Hi'},{client_submission_id:'ok-id-1',text:7},{client_submission_id:'ok-id-1',text:'Hi',author:'assistant'}])
    assert.equal((await send(body)).status,400,JSON.stringify(body));
  const sent=await send({client_submission_id:'submission-1',text:'Hello there'});
  assert.equal(sent.status,202);
  assert.equal(sent.data.message.client_submission_id,'submission-1');
  const repeat=await send({client_submission_id:'submission-1',text:'Hello there'});
  assert.equal(repeat.status,200);assert.equal(repeat.data.message.id,sent.data.message.id);
  assert.equal((await send({client_submission_id:'submission-1',text:'Different text'})).status,409);
  const unicode=await send({client_submission_id:'submission-unicode',text:'é'.repeat(2000)});
  assert.equal(unicode.status,202);

  const race=await together(Array.from({length:8},()=>({path:`/api/chat/${session.path}/messages`,headers:{origin:siteA,authorization:`Bearer ${session.token}`},body:{client_submission_id:'race-submission',text:'Concurrent retry'}})));
  assert.deepEqual(race.map(r=>r.status).sort(),[200,200,200,200,200,200,200,202]);
  assert.equal(new Set(race.map(r=>r.data.message.id)).size,1);

  const done=await settled(session);
  const customers=done.messages.filter(m=>m.author==='customer');
  assert.deepEqual(customers.map(m=>m.client_submission_id),['submission-1','submission-unicode','race-submission']);
  assert.equal(customers[1].text,'é'.repeat(2000));
  for(const message of customers) {
    assert.equal(message.turn_state,'completed');
    const [reply,...extra]=replies(done,message);
    assert.deepEqual(extra,[]);
    assert.equal(reply.author,'assistant');assert.equal(reply.simulated,true);
    assert.match(reply.text,/^Simulated reply: no AI model generated this text/);
  }
  assert.equal((await send({client_submission_id:'race-submission',text:'Concurrent retry'})).status,200);
  await wait(1500);
  assert.equal((await session.request(session.path)).data.messages.length,done.messages.length);
});

test('Website chat: worker leases, crash and late results without replay, restart persistence',async()=>{
  const readiness=await fetch(base+'/health/ready').then(r=>r.json());
  assert.equal(readiness.generation,'simulation');
  const {business}=await chatBusiness('chat-runtime');
  const session=await start(business);
  const send=(id,text)=>session.request(session.path+'/messages',{client_submission_id:id,text});
  const message=async id=>(await session.request(session.path)).data.messages.find(m=>m.client_submission_id===id);
  const marker=`private-chat-text-${crypto.randomUUID()}`;
  assert.equal((await send('crash-turn-1',`[hold 25s] ${marker}`)).status,202);
  for(let i=0;i<40&&(await message('crash-turn-1')).turn_state!=='running';i++)await wait(250);
  assert.equal((await message('crash-turn-1')).turn_state,'running');
  // The held external step keeps no transaction or conversation lock open.
  const started=Date.now();
  assert.equal((await send('queued-turn-2','Queued behind the held turn')).status,202);
  assert(Date.now()-started<1000,'send must not wait for the running turn');
  const idle=compose('exec','-T','db','psql','-U','custom_bot','-d','custom_bot','-tAc',"SELECT count(*) FROM pg_stat_activity WHERE state LIKE 'idle in transaction%'");
  assert.equal(idle.trim(),'0');
  assert.equal((await fetch(base+'/health/ready')).status,200);
  assert.equal((await message('queued-turn-2')).turn_state,'queued');

  compose('kill','worker');compose('start','worker');
  const failed=await settled(session);
  const crashed=failed.messages.find(m=>m.client_submission_id==='crash-turn-1');
  assert.equal(crashed.turn_state,'failed');
  assert.deepEqual(replies(failed,crashed).map(m=>m.author),['system']);
  assert.match(replies(failed,crashed)[0].text,/interrupted.*not retried automatically/);
  const queued=failed.messages.find(m=>m.client_submission_id==='queued-turn-2');
  assert.equal(queued.turn_state,'completed');
  assert.equal(replies(failed,queued)[0].simulated,true);
  // Resubmitting a failed submission returns the original message and never replays it.
  const retried=await send('crash-turn-1',`[hold 25s] ${marker}`);
  assert.equal(retried.status,200);assert.equal(retried.data.message.turn_state,'failed');

  // A worker still busy after its lease expires cannot deliver its late result.
  assert.equal((await send('late-turn-3','[hold 8s] late result')).status,202);
  const late=await settled(session);
  const lateMessage=late.messages.find(m=>m.client_submission_id==='late-turn-3');
  assert.equal(lateMessage.turn_state,'failed');
  assert.deepEqual(replies(late,lateMessage).map(m=>m.author),['system']);
  assert.equal((await send('after-late-4','Still working?')).status,202);
  const healthy=await settled(session);
  assert.equal(healthy.messages.at(-1).simulated,true);
  await wait(Math.max(0,started+27000-Date.now()));
  const noReplay=(await session.request(session.path)).data;
  assert.deepEqual(noReplay,healthy);

  compose('restart','db','app','worker');await ready();
  assert.deepEqual((await session.request(session.path)).data,noReplay);
  assert.deepEqual((await session.request(`${business.id}/conversations`)).data.map(c=>c.id),[session.conversation.id]);
  // The seeded starting configuration cannot be changed, even outside the API.
  for(const sql of [`UPDATE published_configurations SET document='{}' WHERE business_id='${business.id}'`,`DELETE FROM published_configurations WHERE business_id='${business.id}'`])
    assert.throws(()=>compose('exec','-T','db','psql','-v','ON_ERROR_STOP=1','-U','custom_bot','-d','custom_bot','-tAc',sql),e=>e.stderr.includes('Published configurations are immutable'));
  // Test job controls are refused outside test mode.
  assert.throws(()=>execFileSync('docker',['compose','-f','compose.yaml','-f','compose.test.yaml','run','--rm','--no-deps','-e','APP_MODE=local','worker'],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:60000}),e=>e.stderr.includes('test-only'));
  const logs=compose('logs','app','worker');
  for(const secret of [session.token,marker])assert.equal(logs.includes(secret),false,'Service logs must omit chat content and tokens');
});
