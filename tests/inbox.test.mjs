import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base, compose, invitationToken, operator, ready, together } from './helpers.mjs';
const site='https://shop-inbox.example.test';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const noPromise=/\d|minute|hour|soon|shortly|within/i;
// A Customer browser on the Business website: approved Origin plus its own bearer token.
const call=token=>async(path,body)=>{
  const r=await fetch(`${base}/api/chat/${path}`,{method:body===undefined?'GET':'POST',
    headers:{origin:site,'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:r.status,data:await r.json().catch(()=>null)};
};
async function customer(business) {
  const created=await call()(`${business}/conversations`,{});
  assert.equal(created.status,201);
  const request=call(created.data.token),path=`${business}/conversations/${created.data.conversation.id}`;
  return {id:created.data.conversation.id,read:async()=>(await request(path)).data,
    send:(id,text)=>request(path+'/messages',{client_submission_id:id,text}),handoff:()=>request(path+'/handoff',{})};
}
// One team for every group keeps the suite under the per-IP auth rate limits.
let shared;
const team=()=>shared??=(async()=>{
  const t={};
  for(const name of ['owner','s1','s2','s3','outsider'])t[name]=await operator(`inbox-${name}`);
  return t;
})();
async function business(name) {
  const t=await team();
  const b=(await t.owner.request('/api/businesses',{name})).data;
  assert.equal((await t.owner.request(`/api/businesses/${b.id}/website-origins`,{origin:site,approved:true})).status,200);
  for(const member of [t.s1,t.s2,t.s3]) {
    assert.equal((await t.owner.request(`/api/businesses/${b.id}/invitations`,{email:member.email,role:'Support'})).status,201);
    assert.equal((await member.request('/api/invitations/accept',{token:await invitationToken(member.email)})).status,200);
  }
  const path=`/api/businesses/${b.id}/inbox`;
  const at=(id,action='')=>`${path}/conversations/${id}${action&&'/'+action}`;
  const act=(o,id,action,input)=>o.request(at(id,action),input);
  const open=async(o,id)=>{const r=await o.request(at(id));assert.equal(r.status,200);return r.data;};
  return {...t,id:b.id,path,at,act,open};
}
async function until(read,check,what) {
  for(let i=0;i<80;i++){const value=await read();if(check(value))return value;await wait(250);}
  throw new Error(`Timed out waiting for ${what}`);
}
const authors=c=>c.messages.map(m=>m.author);
const notices=c=>c.messages.filter(m=>m.author==='system').map(m=>m.text);

test('Inbox: exactly one competing claim; only the current assignee can send, resolve or resume',async()=>{
  const b=await business('Inbox Claims');
  const c=await customer(b.id);
  assert.equal((await c.send('before-handoff','Hello')).status,202);
  await until(c.read,v=>v.messages.some(m=>m.author==='assistant'),'automated reply');
  const asked=await c.handoff();
  assert.equal(asked.status,200);
  assert.equal(asked.data.control_state,'waiting-for-support');
  const waiting=notices(asked.data).at(-1);
  assert.match(waiting,/^Waiting for support\./);
  assert.doesNotMatch(waiting,noPromise,'No response-time promise');
  assert.equal((await c.handoff()).data.messages.length,asked.data.messages.length,'Asking again changes nothing');

  // Shared queue: every Member sees it with the reason; nobody outside the Business does.
  const queue=(await b.s1.request(b.path)).data;
  const listed=queue.conversations.find(x=>x.id===c.id);
  assert.deepEqual([listed.control_state,listed.handoff_reason,listed.assignee_id],['waiting-for-support','customer-request',null]);
  assert.deepEqual(queue.members.map(m=>m.email).sort(),[b.owner.email,b.s1.email,b.s2.email,b.s3.email].sort());
  for(const r of [await b.outsider.request(b.path),await b.outsider.request(b.at(c.id)),await b.act(b.outsider,c.id,'claim',{revision:listed.revision})])
    assert.equal(r.status,404);
  const other=(await b.outsider.request('/api/businesses',{name:'Inbox Elsewhere'})).data;
  assert.equal((await b.outsider.request(`/api/businesses/${other.id}/inbox/conversations/${c.id}`)).status,404,'Foreign conversation IDs disclose nothing');
  const signedOut=await fetch(base+b.at(c.id,'claim'),{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({revision:listed.revision})});
  assert.equal(signedOut.status,401);
  const crossOrigin=await fetch(base+b.at(c.id,'claim'),{method:'POST',headers:{origin:site,cookie:b.s1.cookie,'content-type':'application/json'},body:JSON.stringify({revision:listed.revision})});
  assert.equal(crossOrigin.status,403);
  for(const input of [{},{revision:7},{revision:listed.revision,operator_id:b.s1.id},{revision:'x'}])
    assert.equal((await b.act(b.s1,c.id,'claim',input)).status,400,JSON.stringify(input));

  // Independent clients claim at once: exactly one assignee.
  const competitors=[b.s1,b.s2,b.owner];
  const race=await together(competitors.map(o=>({path:b.at(c.id,'claim'),headers:{cookie:o.cookie},body:{revision:listed.revision}})));
  assert.deepEqual(race.map(r=>r.status).sort(),[200,409,409]);
  const winner=competitors[race.findIndex(r=>r.status===200)];
  const losers=competitors.filter(o=>o!==winner);
  const claimed=await b.open(winner,c.id);
  assert.deepEqual([claimed.control_state,claimed.assignee_id],['human-controlled',winner.id]);
  assert.equal(notices(claimed).at(-1),'Support joined.');
  // Only the assignee can act, even with the current revision; a stale revision fails even for the assignee.
  const before=claimed.messages.length;
  for(const o of losers) {
    assert.equal((await b.act(o,c.id,'messages',{revision:claimed.revision,client_submission_id:`loser-${o.id}`,text:'Not mine'})).status,409);
    assert.equal((await b.act(o,c.id,'resolve',{revision:claimed.revision})).status,409);
    assert.equal((await b.act(o,c.id,'resume',{revision:claimed.revision})).status,409);
    assert.equal((await b.act(o,c.id,'claim',{revision:claimed.revision})).status,409);
  }
  assert.equal((await b.act(winner,c.id,'messages',{revision:listed.revision,client_submission_id:'stale-revision',text:'Stale'})).status,409);
  assert.equal((await b.act(winner,c.id,'resolve',{revision:listed.revision})).status,409);
  assert.equal((await b.open(winner,c.id)).messages.length,before);
  for(const input of [{revision:claimed.revision,client_submission_id:'short',text:'Hi'},{revision:claimed.revision,client_submission_id:'valid-id-1',text:''},
    {revision:claimed.revision,client_submission_id:'valid-id-1',text:'x'.repeat(2001)},{revision:claimed.revision,text:'Hi'}])
    assert.equal((await b.act(winner,c.id,'messages',input)).status,400,JSON.stringify(input));

  // Replies are deduplicated by submission ID, including concurrent retries.
  const reply={revision:claimed.revision,client_submission_id:'reply-one',text:'Hi, this is support.'};
  const retries=await together(Array.from({length:5},()=>({path:b.at(c.id,'messages'),headers:{cookie:winner.cookie},body:reply})));
  assert.deepEqual(retries.map(r=>r.status),[200,200,200,200,200]);
  assert.equal((await b.act(winner,c.id,'messages',{...reply,text:'Different'})).status,409);
  const seen=await c.read();
  const delivered=seen.messages.filter(m=>m.author==='operator');
  assert.deepEqual(delivered.map(m=>m.text),[reply.text]);
  assert.deepEqual(Object.keys(delivered[0]).sort(),['citations','client_submission_id','created_at','id','reply_to','simulated','text','turn_state','author'].sort());
  assert.equal(delivered[0].client_submission_id,null);
  assert.equal(JSON.stringify(seen).includes(winner.email)||JSON.stringify(seen).includes(winner.id),false,'Customers never see Operator identities');

  // Customer messages under human control wait for support and never start automated turns.
  const human=await c.send('during-human','Still there?');
  assert.equal(human.status,202);assert.equal(human.data.message.turn_state,'human');
  await wait(1500);
  const after=await c.read();
  assert.equal(after.messages.filter(m=>m.author==='assistant').length,1,'Only the reply from before the handoff');
  assert.equal(after.control_state,'human-controlled');
});

test('Inbox: reassignment and revocation reject former-assignee sends, deduplicate submissions, and requeue',async()=>{
  const b=await business('Inbox Reassignment');
  const c=await customer(b.id);
  assert.equal((await c.send('automated-1','Hello')).status,202);
  await until(c.read,v=>v.messages.some(m=>m.author==='assistant'),'automated reply');
  // Takeover of an automated conversation is a claim: ownership comes before replying.
  const listed=(await b.s1.request(b.path)).data.conversations.find(x=>x.id===c.id);
  assert.equal(listed.control_state,'automated');
  assert.equal((await b.act(b.s1,c.id,'messages',{revision:listed.revision,client_submission_id:'unowned-1',text:'Hi'})).status,409);
  const taken=await b.act(b.s1,c.id,'claim',{revision:listed.revision});
  assert.equal(taken.status,200);
  assert.deepEqual([taken.data.control_state,taken.data.handoff_reason,taken.data.assignee_id],['human-controlled','operator-takeover',b.s1.id]);
  const held=taken.data.revision;
  assert.equal((await b.act(b.s1,c.id,'messages',{revision:held,client_submission_id:'s1-sent-1',text:'First reply'})).status,200);

  // Reassignment (by an Owner here; Support can too) revokes the former assignee's sending authority at once.
  for(const input of [{revision:held,operator_id:b.outsider.id},{revision:held,operator_id:'unknown'},{revision:held}])
    assert.equal((await b.act(b.owner,c.id,'reassign',input)).status,400,JSON.stringify(input));
  const moved=await b.act(b.owner,c.id,'reassign',{revision:held,operator_id:b.s2.id});
  assert.equal(moved.status,200);
  assert.deepEqual([moved.data.control_state,moved.data.assignee_id],['human-controlled',b.s2.id]);
  assert.notEqual(moved.data.revision,held);
  const draft={client_submission_id:'s1-draft-1',text:'Unsent draft'};
  assert.match((await b.act(b.s1,c.id,'messages',{revision:held,...draft})).data.error,/changed/);
  assert.match((await b.act(b.s1,c.id,'messages',{revision:moved.data.revision,...draft})).data.error,/current assignee/);
  // A retry of a reply delivered before reassignment returns the original and sends nothing new.
  const retry=await b.act(b.s1,c.id,'messages',{revision:held,client_submission_id:'s1-sent-1',text:'First reply'});
  assert.equal(retry.status,200);
  assert.deepEqual((await c.read()).messages.filter(m=>m.author==='operator').map(m=>m.text),['First reply']);
  // Support reassigns too; reassigning back does not revive a draft held at the old revision.
  const back=await b.act(b.s2,c.id,'reassign',{revision:moved.data.revision,operator_id:b.s1.id});
  assert.equal(back.status,200);
  assert.equal((await b.act(b.s1,c.id,'messages',{revision:held,...draft})).status,409);

  // Send racing reassignment: the send commits only if it holds ownership at commit.
  for(let round=0;round<3;round++) {
    const now=await b.open(b.s1,c.id);
    const id=`race-send-${round}`;
    const [send,reassign]=await together([
      {path:b.at(c.id,'messages'),headers:{cookie:b.s1.cookie},body:{revision:now.revision,client_submission_id:id,text:`Race ${round}`}},
      {path:b.at(c.id,'reassign'),headers:{cookie:b.owner.cookie},body:{revision:now.revision,operator_id:b.s2.id}}]);
    assert.equal(reassign.status,200);
    assert([200,409].includes(send.status));
    const sent=(await c.read()).messages.filter(m=>m.text===`Race ${round}`);
    assert.equal(sent.length,send.status===200?1:0);
    const reset=await b.open(b.owner,c.id);
    assert.equal((await b.act(b.owner,c.id,'reassign',{revision:reset.revision,operator_id:b.s1.id})).status,200);
  }

  // Revocation: the revoked assignee loses all access and the conversation returns to the shared queue.
  const members=(await b.owner.request(`/api/businesses/${b.id}/memberships`)).data;
  const s1=members.find(m=>m.operator_id===b.s1.id);
  const current=await b.open(b.s1,c.id);
  const [send,revoke]=await together([
    {path:b.at(c.id,'messages'),headers:{cookie:b.s1.cookie},body:{revision:current.revision,client_submission_id:'revoke-race',text:'Racing revocation'}},
    {path:`/api/businesses/${b.id}/memberships/${b.s1.id}`,headers:{cookie:b.owner.cookie},body:{role:'Support',active:false,revision:s1.revision}}]);
  assert.equal(revoke.status,200);
  assert([200,404].includes(send.status));
  const requeued=await c.read();
  assert.equal(requeued.control_state,'waiting-for-support');
  const raced=requeued.messages.findIndex(m=>m.text==='Racing revocation');
  // A send that won the race committed before the revocation, so it precedes the requeue notice.
  if(send.status===200)assert(raced>=0&&raced<requeued.messages.findLastIndex(m=>m.author==='system'));
  else assert.equal(raced,-1);
  assert.match(notices(requeued).at(-1),/^Waiting for support\./);
  assert.equal((await b.act(b.s1,c.id,'messages',{revision:current.revision,client_submission_id:'after-revoke',text:'Revoked'})).status,404);
  assert.equal((await b.s1.request(b.path)).status,404);
  const queued=await b.open(b.s3,c.id);
  assert.deepEqual([queued.control_state,queued.assignee_id],['waiting-for-support',null]);
  assert.equal((await b.act(b.s3,c.id,'claim',{revision:queued.revision})).status,200);

  // A resolved conversation whose assignee was revoked reopens to the queue, not to the revoked Member.
  const s3=await b.open(b.s3,c.id);
  assert.equal((await b.act(b.s3,c.id,'resolve',{revision:s3.revision})).status,200);
  const s3Membership=(await b.owner.request(`/api/businesses/${b.id}/memberships`)).data.find(m=>m.operator_id===b.s3.id);
  assert.equal((await b.owner.request(`/api/businesses/${b.id}/memberships/${b.s3.id}`,{role:'Support',active:false,revision:s3Membership.revision})).status,200);
  assert.equal((await c.read()).control_state,'resolved');
  assert.equal((await c.send('after-resolve','Me again')).status,202);
  const reopened=await b.open(b.owner,c.id);
  assert.deepEqual([reopened.control_state,reopened.assignee_id],['waiting-for-support',null]);
});

test('Inbox: handoff, takeover and failure immediately pause automation and reject delayed bot replies',async()=>{
  const b=await business('Inbox Pause');
  const running=async(c,id)=>until(c.read,v=>v.messages.find(m=>m.client_submission_id===id)?.turn_state==='running',`${id} running`);
  // Positive control: the same 3 s held step (shorter than the 5 s test lease) delivers when nothing changes.
  const control=await customer(b.id);
  assert.equal((await control.send('control-1','[hold 3s] control')).status,202);
  const controlled=await until(control.read,v=>v.messages.some(m=>m.author==='assistant'),'control reply');
  assert.equal(controlled.messages.find(m=>m.author==='customer').turn_state,'completed');

  const pauses={
    'customer request':async c=>{const r=await c.handoff();assert.equal(r.status,200);return 'waiting-for-support';},
    'operator takeover':async c=>{
      const listed=(await b.s1.request(b.path)).data.conversations.find(x=>x.id===c.id);
      assert.equal((await b.act(b.s1,c.id,'claim',{revision:listed.revision})).status,200);return 'human-controlled';
    }};
  for(const [name,pause] of Object.entries(pauses)) {
    const c=await customer(b.id);
    assert.equal((await c.send('held-turn-1','[hold 3s] delayed')).status,202);
    await running(c,'held-turn-1');
    assert.equal((await c.send('queued-turn-2','Queued behind it')).status,202);
    const state=await pause(c);
    await wait(4500);
    const result=await c.read();
    assert.equal(result.control_state,state,name);
    assert.deepEqual(authors(result).filter(a=>a==='assistant'),[],`${name}: no late or queued automated reply`);
    assert.deepEqual(result.messages.filter(m=>m.author==='customer').map(m=>m.turn_state),['human','human'],name);
  }

  // Automation failure hands off at once: the failed turn is visible and the queued one never runs.
  const draft=(await b.owner.request(`/api/businesses/${b.id}/configuration`)).data;
  const document=JSON.parse(draft.text);document.generation.mode='connected';
  const saved=await b.owner.request(`/api/businesses/${b.id}/configuration`,{text:JSON.stringify(document),revision:draft.revision});
  assert.equal((await b.owner.request(`/api/businesses/${b.id}/configuration/publish`,{revision:saved.data.revision})).status,201);
  const f=await customer(b.id);
  assert.equal((await f.send('fails-turn-1','[hold 1s] first')).status,202);
  assert.equal((await f.send('queued-turn-2','second')).status,202);
  const failed=await until(f.read,v=>v.control_state!=='automated','failure handoff');
  await wait(1500);
  const final=await f.read();
  assert.equal(final.control_state,'waiting-for-support');
  assert.deepEqual(final.messages.filter(m=>m.author==='customer').map(m=>m.turn_state),['failed','human']);
  assert.deepEqual(authors(final).filter(a=>a!=='customer'),['system','system']);
  assert.match(final.messages.find(m=>m.author==='system').text,/connected generation is unavailable/);
  assert.equal(final.messages.length,failed.messages.length);
  assert.equal((await b.s1.request(b.path)).data.conversations.find(x=>x.id===f.id).handoff_reason,'automation-failure');
});

test('Inbox: queue, Away, disconnection and restart keep messages and ownership; resume waits; resolution reopens under human control',async()=>{
  const b=await business('Inbox Lifecycle');
  // Nobody available: the conversation stays queued with automation paused and no response-time promise.
  const team=(await b.s2.request(b.path)).data.members;
  assert(team.every(m=>m.available===false));
  const c=await customer(b.id);
  assert.equal((await c.handoff()).status,200);
  assert.equal((await c.send('queued-1','Anyone there?')).status,202);
  await wait(1500);
  let seen=await c.read();
  assert.deepEqual([seen.control_state,authors(seen)],['waiting-for-support',['system','customer']]);
  for(const text of notices(seen))assert.doesNotMatch(text,noPromise);

  // Availability is manual and never assigns.
  for(const input of [{},{available:'yes'},{available:true,operator_id:b.s1.id}])
    assert.equal((await b.s2.request(b.path+'/availability',input)).status,400);
  assert.equal((await b.s2.request(b.path+'/availability',{available:true})).status,200);
  assert.equal((await b.s2.request(b.path)).data.members.find(m=>m.operator_id===b.s2.id).available,true);
  await wait(1000);
  assert.equal((await b.open(b.s2,c.id)).assignee_id,null);
  const claimed=await b.act(b.s2,c.id,'claim',{revision:(await b.open(b.s2,c.id)).revision});
  assert.equal(claimed.status,200);

  // Away and disconnection (sign-out) keep ownership and the pause; Customer messages are kept.
  assert.equal((await b.s2.request(b.path+'/availability',{available:false})).status,200);
  assert.equal((await b.s2.request('/api/auth/sign-out',{})).status,200);
  assert.equal((await b.s2.request(b.path)).status,401);
  assert.equal((await c.send('while-away','Hello?')).status,202);
  await wait(1500);
  seen=await c.read();
  assert.equal(seen.control_state,'human-controlled');
  assert.equal(authors(seen).includes('assistant'),false);
  const owned=await b.open(b.owner,c.id);
  assert.deepEqual([owned.assignee_id,owned.messages.filter(m=>m.author==='customer').map(m=>m.turn_state)],[b.s2.id,['human','human']]);

  // Restart keeps messages, control and ownership.
  compose('restart','db','app','worker');await ready();
  assert.deepEqual(await c.read(),seen);
  assert.deepEqual(await b.open(b.owner,c.id),owned);
  const signIn=await b.s2.request('/api/auth/sign-in/email',{email:b.s2.email,password:b.s2.password});
  assert.equal(signIn.status,200);
  b.s2.cookie=signIn.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
  assert.equal((await b.act(b.s2,c.id,'messages',{revision:owned.revision,client_submission_id:'after-restart',text:'Back now'})).status,200);

  // Resolution, then a Customer message, reopens under human control with the same assignee and no automated reply.
  assert.equal((await b.act(b.s2,c.id,'resolve',{revision:owned.revision})).status,200);
  seen=await c.read();
  assert.deepEqual([seen.control_state,notices(seen).at(-1)],['resolved','Conversation resolved. Send a message here if you need more help.']);
  const resolved=await b.open(b.s2,c.id);
  assert.equal((await b.act(b.s2,c.id,'messages',{revision:resolved.revision,client_submission_id:'on-resolved',text:'x'})).status,409);
  assert.equal((await c.send('after-resolve','One more thing')).status,202);
  await wait(1500);
  seen=await c.read();
  assert.deepEqual([seen.control_state,notices(seen).at(-1),authors(seen).includes('assistant')],['human-controlled','Support joined.',false]);
  const reopened=await b.open(b.s2,c.id);
  assert.equal(reopened.assignee_id,b.s2.id);

  // Explicit resume replays nothing: no reply to earlier messages until the next Customer message.
  const resumed=await b.act(b.s2,c.id,'resume',{revision:reopened.revision});
  assert.equal(resumed.status,200);
  assert.deepEqual([resumed.data.control_state,resumed.data.assignee_id,resumed.data.handoff_reason],['automated',null,null]);
  await wait(2000);
  seen=await c.read();
  assert.deepEqual([notices(seen).at(-1),authors(seen).at(-1),authors(seen).includes('assistant')],['Automated assistant resumed.','system',false]);
  assert.equal((await b.act(b.s2,c.id,'resume',{revision:resumed.data.revision})).status,409);
  const next=await c.send('next-after-resume','Thanks, bot');
  assert.equal(next.data.message.turn_state,'queued');
  const answered=await until(c.read,v=>v.messages.some(m=>m.author==='assistant'),'reply after resume');
  await wait(1000);
  const replies=(await c.read()).messages.filter(m=>m.author==='assistant');
  assert.deepEqual(replies.map(m=>m.reply_to),[next.data.message.id]);
  assert.equal(answered.messages.filter(m=>m.author==='customer').at(-1).turn_state,'completed');
  const logs=compose('logs','app','worker');
  for(const secret of ['Anyone there?','Back now',b.s2.email])assert.equal(logs.includes(secret),false,'Logs omit chat content and Operator emails');
});
