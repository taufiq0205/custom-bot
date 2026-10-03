import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT, UnsecuredJWT, exportJWK, generateKeyPair } from 'jose';
import { base, compose, invitationToken, operator, together } from './helpers.mjs';
const site='https://shop-identity.example.test';
const audience=new URL(base).origin;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const customer=(token,origin=site)=>async(path,body)=>{
  const response=await fetch(`${base}/api/chat/${path}`,{method:body===undefined?'GET':'POST',
    headers:{origin,...(token?{authorization:`Bearer ${token}`}:{}),'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,data:await response.json().catch(()=>null)};
};
// A Business website backend: holds its private key and signs short-lived assertions for its own customer IDs.
async function website(kid='site-key-1',issuer=site) {
  const {publicKey,privateKey}=await generateKeyPair('ES256',{extractable:true});
  const sign=(business,sub,{claims={},header={},iat=Math.floor(Date.now()/1000),ttl=300,key=privateKey,alg='ES256',omit=[]}={})=>{
    const payload={iss:issuer,aud:audience,business_id:business.id,sub,iat,exp:iat+ttl,jti:crypto.randomUUID(),...claims};
    for(const name of omit)delete payload[name];
    return new SignJWT(payload).setProtectedHeader({alg,kid,...header}).sign(key);
  };
  return {kid,issuer,publicJwk:await exportJWK(publicKey),privateJwk:await exportJWK(privateKey),sign};
}
let sharedOwner;
async function setup(prefix,keys=1) {
  // One Owner for every group keeps the suite under the per-IP auth rate limits.
  const owner=await (sharedOwner??=operator('identity-owner'));
  const business=(await owner.request('/api/businesses',{name:`${prefix} Business`})).data;
  assert.equal((await owner.request(`/api/businesses/${business.id}/website-origins`,{origin:site,approved:true})).status,200);
  const sites=[];
  for(let i=0;i<keys;i++) {
    const s=await website(`site-key-${i+1}`);
    assert.equal((await owner.request(`/api/businesses/${business.id}/customer-keys`,{kid:s.kid,issuer:s.issuer,public_key:s.publicJwk})).status,201);
    sites.push(s);
  }
  return {owner,business,site:sites[0]};
}
// A browser: anonymous session first, then whatever identity the website propagates.
async function browser(business) {
  const created=await customer()(`${business.id}/conversations`,{});
  assert.equal(created.status,201);
  const b={business,token:created.data.token,conversation:created.data.conversation.id};
  b.request=(path,body)=>customer(b.token)(`${business.id}${path}`,body);
  b.identify=async assertion=>{const r=await b.request('/identity',{assertion});if(r.status===200){b.token=r.data.token;b.conversation=r.data.conversation.id;}return r;};
  b.logout=async()=>{const r=await b.request('/logout',{});if(r.status===200){b.token=r.data.token;b.conversation=r.data.conversation.id;}return r;};
  b.send=(id,text,conversation=b.conversation)=>b.request(`/conversations/${conversation}/messages`,{client_submission_id:id,text});
  b.read=(conversation=b.conversation)=>b.request(`/conversations/${conversation}`);
  b.list=async()=>(await b.request('/conversations')).data.map(c=>c.id).sort();
  return b;
}
async function settled(b,conversation=b.conversation) {
  for(let i=0;i<120;i++){const c=(await b.read(conversation)).data;if(c.messages.every(m=>m.author!=='customer'||['completed','failed'].includes(m.turn_state)))return c;await wait(250);}
  throw new Error('Conversation did not settle');
}
const repliesTo=(c,id)=>c.messages.filter(m=>m.reply_to===c.messages.find(x=>x.client_submission_id===id).id);
const sql=query=>compose('exec','-T','db','psql','-v','ON_ERROR_STOP=1','-U','custom_bot','-d','custom_bot','-tAc',query);

test('Customer identity: Owner-registered public keys; only valid ES256 assertions authenticate',async()=>{
  const {owner,business,site:s}=await setup('identity-verify');
  const keys=`/api/businesses/${business.id}/customer-keys`;
  const p384=await exportJWK((await generateKeyPair('ES384',{extractable:true})).publicKey);
  const rsa=await exportJWK((await generateKeyPair('RS256',{extractable:true})).publicKey);
  for(const body of [{kid:'k2',issuer:site,public_key:s.privateJwk},{kid:'k2',issuer:site,public_key:p384},{kid:'k2',issuer:site,public_key:rsa},
    {kid:'bad kid!',issuer:site,public_key:s.publicJwk},{kid:'k2',issuer:'',public_key:s.publicJwk},{kid:'k2',issuer:site,public_key:{...s.publicJwk,x:'AAAA'}},
    {kid:'k2',issuer:site,public_key:{...s.publicJwk,alg:'HS256'}},{kid:'k2',issuer:site},{kid:'k2',issuer:site,public_key:s.publicJwk,business_id:business.id}])
    assert.equal((await owner.request(keys,body)).status,400,JSON.stringify(body).slice(0,80));
  assert.equal((await owner.request(keys,{kid:s.kid,issuer:site,public_key:s.publicJwk})).status,409);
  const listed=(await owner.request(keys)).data;
  assert.deepEqual(listed.map(k=>[k.kid,k.issuer]),[[s.kid,site]]);
  assert.equal(JSON.stringify(listed).includes(s.privateJwk.d),false);
  const support=await operator('identity-verify-support');
  assert.equal((await owner.request(`/api/businesses/${business.id}/invitations`,{email:support.email,role:'Support'})).status,201);
  assert.equal((await support.request('/api/invitations/accept',{token:await invitationToken(support.email)})).status,200);
  assert.equal((await support.request(keys)).status,404);
  assert.equal((await support.request(keys,{kid:'k3',issuer:site,public_key:s.publicJwk})).status,404);
  assert.equal((await support.request(`${keys}/${s.kid}`,{})).status,404);

  // Another Business registers the same website key: a token for one Business is still rejected by the other.
  const other=(await owner.request('/api/businesses',{name:'identity-verify Other'})).data;
  assert.equal((await owner.request(`/api/businesses/${other.id}/website-origins`,{origin:site,approved:true})).status,200);
  assert.equal((await owner.request(`/api/businesses/${other.id}/customer-keys`,{kid:s.kid,issuer:site,public_key:s.publicJwk})).status,201);

  const now=Math.floor(Date.now()/1000);
  const forger=await website(s.kid);
  const secret=new TextEncoder().encode(JSON.stringify(s.publicJwk));
  const p384Key=(await generateKeyPair('ES384')).privateKey;
  const rejected={
    forged:await forger.sign(business,'customer-1'),
    expired:await s.sign(business,'customer-1',{iat:now-600,ttl:300}),
    notYetValid:await s.sign(business,'customer-1',{claims:{nbf:now+600}}),
    issuedInFuture:await s.sign(business,'customer-1',{iat:now+600}),
    tooLong:await s.sign(business,'customer-1',{ttl:7200}),
    wrongAudience:await s.sign(business,'customer-1',{claims:{aud:'https://other-platform.example.test'}}),
    wrongBusiness:await s.sign(other,'customer-1'),
    wrongIssuer:await s.sign(business,'customer-1',{claims:{iss:'https://evil.example.test'}}),
    unknownKid:await s.sign(business,'customer-1',{header:{kid:'unknown'}}),
    missingKid:await new SignJWT({iss:site,aud:audience,business_id:business.id,sub:'customer-1',iat:now,exp:now+300,jti:crypto.randomUUID()}).setProtectedHeader({alg:'ES256'}).sign((await generateKeyPair('ES256')).privateKey),
    missingExp:await s.sign(business,'customer-1',{omit:['exp']}),
    missingJti:await s.sign(business,'customer-1',{omit:['jti']}),
    missingSub:await s.sign(business,'customer-1',{omit:['sub']}),
    emptySub:await s.sign(business,''),
    numericSub:await s.sign(business,'x',{claims:{sub:42}}),
    algNone:new UnsecuredJWT({iss:site,aud:audience,business_id:business.id,sub:'customer-1',iat:now,exp:now+300,jti:crypto.randomUUID()}).encode(),
    hmacWithPublicKey:await s.sign(business,'customer-1',{alg:'HS256',key:secret}),
    es384:await s.sign(business,'customer-1',{alg:'ES384',key:p384Key}),
    garbage:'not.a.jwt',
  };
  const b=await browser(business);
  const anonymous=b.token;
  assert.equal((await b.send('anon-msg-1','Before login')).status,202);
  for(const [name,assertion] of Object.entries(rejected)) {
    const r=await b.request('/identity',{assertion});
    assert.equal(r.status,401,name);
    assert.deepEqual(r.data,{error:'Identity assertion rejected'},name);
  }
  // Nothing changed: the anonymous session still owns its anonymous conversation.
  assert.equal(b.token,anonymous);
  assert.equal((await b.read()).status,200);
  for(const body of [{},{assertion:7},{assertion:await s.sign(business,'customer-1'),customer_id:'customer-2'}])
    assert.equal((await b.request('/identity',body)).status,400);

  const valid=await s.sign(business,'customer-1');
  const login=await b.identify(valid);
  assert.equal(login.status,200,JSON.stringify(login.data));
  assert.equal(login.data.verified,true);
  assert.match(login.data.token,/^[a-f0-9]{64}$/);
  assert.notEqual(login.data.token,anonymous);
  assert.equal(login.data.conversation.messages[0].text,'Before login');
  assert.equal((await customer(anonymous)(`${business.id}/conversations`)).status,401);
  // Assertions are single-use: a replayed (for example cached) assertion cannot reopen the Customer's history.
  const replay=await browser(business);
  assert.equal((await replay.identify(valid)).status,401);
  assert.deepEqual(await replay.list(),[replay.conversation]);
  // The same subject in another Business is a different Customer.
  const elsewhere=await browser(other);
  assert.equal((await elsewhere.identify(await s.sign(other,'customer-1'))).status,200);
  assert.deepEqual(await elsewhere.list(),[elsewhere.conversation]);
  assert.equal((await customer(elsewhere.token)(`${business.id}/conversations`)).status,401);
  // Email and phone claims never authenticate or merge Customers.
  const email={email:'same@example.test',phone_number:'+15550100'};
  const x=await browser(business),y=await browser(business);
  assert.equal((await x.identify(await s.sign(business,'email-x',{claims:email}))).status,200);
  assert.equal((await y.identify(await s.sign(business,'email-y',{claims:email}))).status,200);
  assert.deepEqual(await y.list(),[y.conversation]);
  assert.equal((await y.read(x.conversation)).status,404);
  assert.equal((await y.identify(await s.sign(business,'same@example.test'))).status,200);
  assert.deepEqual(await y.list(),[y.conversation]);

  // Concurrent identity requests beyond the pool size (10) all succeed. (Smoke check: pool starvation is timing-dependent.)
  const crowd=await Promise.all(Array.from({length:12},()=>browser(business)));
  const signed=await Promise.all(crowd.map((c,i)=>s.sign(business,`crowd-${i}`)));
  const burst=await together(crowd.map((c,i)=>({path:`/api/chat/${business.id}/identity`,headers:{origin:site,authorization:`Bearer ${c.token}`},body:{assertion:signed[i]}})));
  assert.deepEqual(burst.map(r=>r.status),Array(12).fill(200));

  // Removing a key ends the sessions it verified on their next request.
  assert.equal((await owner.request(`${keys}/${s.kid}`,{})).status,200);
  assert.equal((await owner.request(`${keys}/${s.kid}`,{})).status,404);
  assert.equal((await x.read()).status,401);
  assert.equal((await (await browser(business)).identify(await s.sign(business,'customer-1'))).status,401);
});

test('Customer identity: only the current anonymous conversation links; linked conversations never move',async()=>{
  const {business,site:s}=await setup('identity-link');
  const b=await browser(business);
  const first=b.conversation;
  assert.equal((await b.send('older-anon-1','Older anonymous question')).status,202);
  const second=(await b.request('/conversations',{})).data.conversation.id;
  b.conversation=second;
  assert.equal((await b.send('current-anon-1','Current anonymous question')).status,202);
  assert.equal((await b.identify(await s.sign(business,'link-x'))).status,200);
  assert.equal(b.conversation,second);
  assert.deepEqual(await b.list(),[second]);
  assert.equal((await b.read(first)).status,404);
  // Conversations the verified session starts belong to the Customer.
  const started=(await b.request('/conversations',{})).data.conversation.id;
  // A second device signs in as the same Customer: shared history plus its own linked conversation.
  const device=await browser(business);
  assert.equal((await device.identify(await s.sign(business,'link-x'))).status,200);
  assert.deepEqual(await device.list(),[device.conversation,second,started].sort());
  const settledSecond=await settled(device,second);
  assert.equal(settledSecond.messages[0].text,'Current anonymous question');

  // Switching account on this browser starts fresh; X's conversation is never relinked to Y.
  const xToken=b.token;
  const switched=await b.identify(await s.sign(business,'link-y'));
  assert.equal(switched.status,200);
  assert.notEqual(b.conversation,started);
  assert.deepEqual(switched.data.conversation.messages,[]);
  assert.deepEqual(await b.list(),[b.conversation]);
  assert.equal((await customer(xToken)(`${business.id}/conversations`)).status,401);
  assert.deepEqual(await device.list(),[device.conversation,second,started].sort());
  // Even outside the API, a linked conversation's Customer cannot change.
  assert.throws(()=>sql(`UPDATE conversations SET customer_id=NULL WHERE id='${second}'`),e=>e.stderr.includes('Conversation Customer cannot change'));

  // Independent clients race two identities onto one anonymous conversation: exactly one links.
  for(const [a,c] of [['race-a','race-b'],['race-c',null]]) {
    const r=await browser(business);
    const headers={origin:site,authorization:`Bearer ${r.token}`};
    const ops=[{path:`/api/chat/${business.id}/identity`,headers,body:{assertion:await s.sign(business,a)}},
      c?{path:`/api/chat/${business.id}/identity`,headers,body:{assertion:await s.sign(business,c)}}:{path:`/api/chat/${business.id}/logout`,headers,body:{}}];
    const results=await together(ops);
    assert.deepEqual(results.map(x=>x.status).sort(),[200,401],JSON.stringify(results));
    const winner=results.find(x=>x.status===200).data;
    const owners=(await Promise.all([a,c].filter(Boolean).map(async sub=>{
      const check=await browser(business);await check.identify(await s.sign(business,sub));return (await check.list()).includes(r.conversation)?sub:null;}))).filter(Boolean);
    if(winner.verified)assert.equal(owners.length,1);
    else {assert.deepEqual(owners,[]);assert.notEqual(winner.conversation.id,r.conversation);}
    assert.equal((await customer(r.token)(`${business.id}/conversations`)).status,401);
  }
});

test('Customer identity: logout, expiry and switching end access; delayed results are revalidated',async()=>{
  const {business,site:s}=await setup('identity-shared');
  const marker=`identity-private-${crypto.randomUUID()}`;
  const b=await browser(business);
  const assertion=await s.sign(business,'shared-x');
  assert.equal((await b.identify(assertion)).status,200);
  assert.equal((await b.send('x-message-1',marker)).status,202);
  const xConversation=b.conversation,xToken=b.token;
  await settled(b);
  const out=await b.logout();
  assert.equal(out.status,200);
  assert.equal(out.data.verified,false);
  assert.deepEqual(out.data.conversation.messages,[]);
  assert.notEqual(b.conversation,xConversation);
  assert.deepEqual(await b.list(),[b.conversation]);
  for(const r of [await customer(xToken)(`${business.id}/conversations`),await customer(xToken)(`${business.id}/conversations/${xConversation}`),
    await customer(xToken)(`${business.id}/conversations/${xConversation}/messages`,{client_submission_id:'after-logout',text:'Hi'}),
    await customer(xToken)(`${business.id}/logout`,{})])assert.equal(r.status,401);
  assert.equal((await b.read(xConversation)).status,404);
  assert.equal((await customer()(`${business.id}/logout`,{})).status,401);

  // Expiry ends the verified session on its next request, server-side.
  const e=await browser(business);
  assert.equal((await e.identify(await s.sign(business,'shared-x',{ttl:3}))).status,200);
  assert.equal((await e.read(xConversation)).status,200);
  await wait(3500);
  assert.equal((await e.read(xConversation)).status,401);
  assert.equal((await e.request('/conversations')).status,401);

  // Delayed results: positive control first, then logout, switch and expiry during the held step.
  const held=async(sub,ttl=300)=>{const h=await browser(business);assert.equal((await h.identify(await s.sign(business,sub,{ttl}))).status,200);return h;};
  // A 2 s session may expire before its turn is claimed; the claim-time check must then fail it instead.
  const running=async(h,id)=>{for(let i=0;i<40;i++){const r=await h.read();if(r.status===401||r.data.messages.find(m=>m.client_submission_id===id)?.turn_state==='running')return;await wait(100);}throw new Error('Turn did not start');};
  const control=await held('delay-control');
  assert.equal((await control.send('control-1','[hold 3s] control')).status,202);
  const delivered=await settled(control);
  assert.deepEqual(repliesTo(delivered,'control-1').map(m=>[m.author,m.simulated]),[['assistant',true]]);

  const cases=[['delay-logout',h=>h.logout()],['delay-switch',async h=>h.identify(await s.sign(business,'delay-intruder'))],['delay-expiry',()=>wait(2500),2]];
  for(const [sub,change,ttl] of cases) {
    const h=await held(sub,ttl);
    const conversation=h.conversation;
    assert.equal((await h.send(`${sub}-1`,`[hold 3s] ${marker}`)).status,202);
    await running(h,`${sub}-1`);
    assert.equal((await change(h))?.status??200,200);
    await wait(4000);
    if(sub!=='delay-expiry') {
      assert.deepEqual((await h.read()).data.messages,[]);
      assert.equal(JSON.stringify((await h.request('/conversations')).data).includes(conversation),false);
    }
    // The Customer sees a visible failure, not a reply delivered after their identity ended.
    const back=await browser(business);
    assert.equal((await back.identify(await s.sign(business,sub))).status,200);
    const result=await settled(back,conversation);
    const message=result.messages.find(m=>m.client_submission_id===`${sub}-1`);
    assert.equal(message.turn_state,'failed',sub);
    assert.deepEqual(repliesTo(result,`${sub}-1`).map(m=>m.author),['system'],sub);
    assert.match(repliesTo(result,`${sub}-1`)[0].text,/chat session ended/);
  }
  const logs=compose('logs','app','worker');
  for(const secret of [assertion,'shared-x',marker,xToken])assert.equal(logs.includes(secret),false,'Logs must omit assertions, subjects, messages and tokens');
});
