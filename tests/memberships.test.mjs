import { request as httpRequest } from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { account, otp, invitationToken, client, base } from './helpers.mjs';
async function operator(prefix) {
  const a=await account(prefix);
  assert.equal((await a.request('/api/auth/email-otp/verify-email',{email:a.email,otp:await otp(a.email,'email-verification')})).status,200);
  const login=await a.request('/api/auth/sign-in/email',{email:a.email,password:a.password});
  assert.equal(login.status,200);
  return {...a,id:login.data.user.id,cookie:login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ')};
}
test('Memberships: Owner invites intended verified Operator; Support in B cannot manage B',async()=>{
  const owner=await operator('members-owner'), support=await operator('members-support');
  const b=(await owner.request('/api/businesses',{name:'Membership B'})).data;
  const a=(await support.request('/api/businesses',{name:'Membership A'})).data;
  const path=`/api/businesses/${b.id}`;
  const invite=await owner.request(path+'/invitations',{email:support.email,role:'Support'});
  assert.equal(invite.status,201);
  const token=await invitationToken(support.email);
  assert.equal((await owner.request('/api/invitations/accept',{token})).status,404);
  assert.equal((await support.request('/api/invitations/accept',{token})).status,200);
  assert.equal((await support.request(path)).data.role,'Support');
  assert.equal((await support.request(`/api/businesses/${a.id}/memberships`)).status,200);
  for(const suffix of ['/memberships','/invitations','/configuration','/credentials','/traces']) {
    assert.equal((await support.request(path+suffix)).status,404);
  }
  assert.equal((await support.request(path+'/invitations',{email:owner.email,role:'Owner'})).status,404);
  assert.equal((await support.request('/api/invitations/accept',{token})).status,404);
  const members=await owner.request(path+'/memberships');
  const target=members.data.find(m=>m.operator_id===support.id);
  assert.equal((await owner.request(path+'/memberships/'+support.id,{role:'Support',active:false,revision:target.revision})).status,200);
  assert.equal((await support.request(path)).status,404);
  assert.deepEqual((await support.request('/api/businesses')).data.map(b=>b.id),[a.id]);
});
async function invite(owner,business,target,role='Owner') {
  const result=await owner.request(`/api/businesses/${business.id}/invitations`,{email:target.email,role});
  assert.equal(result.status,201);
  const token=await invitationToken(target.email);
  assert.equal((await target.request('/api/invitations/accept',{token})).status,200);
  return token;
}
// Two independent sockets hold request bodies until both are connected.
async function together(operations) {
  let release,arrived=0;
  const barrier=new Promise(resolve=>{release=resolve;});
  return Promise.all(operations.map(({path,body,cookie})=>new Promise((resolve,reject)=>{
    const payload=JSON.stringify(body);
    const req=httpRequest(base+path,{method:'POST',agent:false,headers:{origin:base,cookie,'content-type':'application/json','content-length':Buffer.byteLength(payload)}},res=>{
      let raw='';res.setEncoding('utf8');res.on('data',s=>raw+=s);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(raw)}));
    });
    req.setTimeout(10000,()=>req.destroy(new Error('Race timeout')));req.on('error',reject);
    req.write(payload.slice(0,-1));
    req.once('socket',socket=>socket.once('connect',async()=>{if(++arrived===operations.length)release();await barrier;req.end(payload.slice(-1));}));
  })));
}
test('Invitations: invalid, unverified, expired, revoked, foreign IDs, stale revisions, and single-use race',async()=>{
  const owner=await operator('invite-owner'),target=await operator('invite-target');
  const b=(await owner.request('/api/businesses',{name:'Invitations B'})).data;
  const foreign=(await target.request('/api/businesses',{name:'Foreign Business'})).data;
  const path=`/api/businesses/${b.id}`;
  const create=()=>owner.request(path+'/invitations',{email:target.email,role:'Support'});
  assert.equal((await (await client())('/api/invitations/accept',{token:'a'.repeat(64)})).status,401);
  assert.equal((await target.request('/api/invitations/accept',{token:'a'.repeat(64)})).status,404);
  assert.equal((await owner.request(path+'/invitations',{email:'invalid',role:'Owner'})).status,400);
  assert.equal((await owner.request(path+'/invitations',{email:target.email,role:'Admin'})).status,400);
  assert.equal((await owner.request(path+'/invitations',{email:target.email,role:'Owner',business_id:foreign.id})).status,400);
  assert.equal((await create()).status,201);
  let token=await invitationToken(target.email);
  assert.equal((await target.request('/api/invitations/accept',{token},{headers:{origin:'https://evil.test'}})).status,403);
  assert.equal((await target.request('/api/invitations/accept',{token,business_id:foreign.id})).status,400);
  const unverified=await account('invite-unverified');
  assert.equal((await unverified.request('/api/invitations/accept',{token})).status,401);
  const oldToken=token;
  const current=await create();token=await invitationToken(target.email);
  assert.notEqual(token,oldToken);
  assert.equal((await target.request('/api/invitations/accept',{token:oldToken})).status,404);
  assert.equal((await target.request(`/api/businesses/${foreign.id}/invitations/${current.data.id}`,{})).status,404);
  assert.equal((await owner.request(path+'/invitations/'+current.data.id,{})).status,200);
  assert.equal((await target.request('/api/invitations/accept',{token})).status,404);
  assert.equal((await create()).status,201);token=await invitationToken(target.email);
  await new Promise(r=>setTimeout(r,21000));
  assert.equal((await target.request('/api/invitations/accept',{token})).status,404);
  assert.equal((await target.request(path)).status,404);
  assert.equal((await create()).status,201);token=await invitationToken(target.email);
  const race=await together([0,1].map(()=>({path:'/api/invitations/accept',body:{token},cookie:target.cookie})));
  assert.deepEqual(race.map(r=>r.status).sort(),[200,404]);
  assert.equal((await owner.request(path+'/memberships/'+target.id,{role:'Owner',active:true,revision:'0'})).status,409);
  assert.equal((await owner.request(`/api/businesses/${foreign.id}/memberships/${target.id}`,{role:'Owner',active:false,revision:'1'})).status,404);
  assert.equal((await owner.request(path+'/memberships/foreign-id',{role:'Support',active:false,revision:'1'})).status,404);
  const member=(await owner.request(path+'/memberships')).data.find(m=>m.operator_id===target.id);
  assert.equal((await owner.request(path+'/memberships/'+target.id,{role:'Owner',active:true,revision:member.revision})).status,200);
  assert.equal((await target.request(path+'/memberships')).status,200);
  const pending=await owner.request(path+'/invitations',{email:target.email,role:'Owner'});
  const pendingToken=await invitationToken(target.email);
  assert.equal((await owner.request(path+'/memberships/'+target.id,{role:'Owner',active:false,revision:'2'})).status,200);
  assert.equal((await target.request(path+'/memberships')).status,404);
  assert.equal((await target.request('/api/invitations/accept',{token:pendingToken})).status,404);
  assert((await owner.request(path+'/invitations')).data.find(i=>i.id===pending.data.id).revoked_at);
  // Public metadata must not expose token verifiers or invitation tokens.
  const metadata=JSON.stringify((await owner.request(path+'/invitations')).data);
  assert(!metadata.includes(pendingToken));assert(!metadata.includes('token_verifier'));
});
test('Memberships: independent concurrent removal/demotion preserve last Owner and current authority',async()=>{
  const first=await operator('race-owner-one'),second=await operator('race-owner-two');
  for(const actions of [['demote','demote'],['revoke','revoke'],['revoke','demote']]) {
    const b=(await first.request('/api/businesses',{name:'Last Owner '+actions.join('/')})).data;
    await invite(first,b,second);
    const path=`/api/businesses/${b.id}`;
    const rows=(await first.request(path+'/memberships')).data;
    const outcomes=await together([first,second].map((owner,i)=>({path:path+'/memberships/'+owner.id,cookie:owner.cookie,body:{role:actions[i]==='demote'?'Support':'Owner',active:actions[i]!=='revoke',revision:rows.find(m=>m.operator_id===owner.id).revision}})));
    assert.deepEqual(outcomes.map(r=>r.status).sort(),[200,409]);
    const remaining=(await Promise.all([first,second].map(o=>o.request(path+'/memberships')))).find(r=>r.status===200);
    assert.equal(remaining.data.filter(m=>m.role==='Owner'&&m.active).length,1);
    const survivor=remaining.data.find(m=>m.role==='Owner'&&m.active);
    const owner=survivor.operator_id===first.id?first:second;
    assert.equal((await owner.request(path+'/memberships/'+owner.id,{role:'Owner',active:false,revision:survivor.revision})).status,409);
    assert.equal((await owner.request(path+'/memberships/'+owner.id,{role:'Support',active:true,revision:survivor.revision})).status,409);
  }
  // Once inviter loses Owner authority, their pending grants cannot confer access.
  const b=(await first.request('/api/businesses',{name:'Revoked inviter'})).data;
  await invite(first,b,second);
  const outsider=await operator('revoked-inviter-target');
  assert.equal((await first.request(`/api/businesses/${b.id}/invitations`,{email:outsider.email,role:'Owner'})).status,201);
  const token=await invitationToken(outsider.email);
  assert.equal((await second.request(`/api/businesses/${b.id}/memberships/${first.id}`,{role:'Support',active:true,revision:'1'})).status,200);
  assert.equal((await outsider.request('/api/invitations/accept',{token})).status,404);
  assert.equal((await second.request(`/api/businesses/${b.id}/memberships/${first.id}`,{role:'Owner',active:true,revision:'2'})).status,200);
  assert.equal((await outsider.request('/api/invitations/accept',{token})).status,404,'Restoring inviter authority must not revive cancelled grants');
});
test('Memberships: unfinished request bodies do not block unrelated service access',async()=>{
  const owner=await operator('slow-body-owner');
  const b=(await owner.request('/api/businesses',{name:'Slow bodies'})).data;
  const requests=[];
  try {
    await Promise.all(Array.from({length:10},()=>new Promise((resolve,reject)=>{
      const req=httpRequest(`${base}/api/businesses/${b.id}/invitations`,{method:'POST',agent:false,headers:{origin:base,cookie:owner.cookie,'content-type':'application/json','content-length':1000}});
      requests.push(req);req.on('error',reject);req.write('{');
      req.once('socket',socket=>socket.once('connect',resolve));
    })));
    // Allow real session validation/body handling to begin on all sockets.
    await new Promise(r=>setTimeout(r,500));
    const ready=await fetch(base+'/health/ready',{signal:AbortSignal.timeout(2000)});
    assert.equal(ready.status,200);
    assert.equal((await owner.request(`/api/businesses/${b.id}`)).status,200);
  } finally {requests.forEach(req=>req.destroy());}
});
