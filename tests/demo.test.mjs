import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { SignJWT, importJWK } from 'jose';
import { addWebsite, base, calls, cite, client, compose, ingested, limited, operator, otp, received, reply, script, sql, wait } from './helpers.mjs';
// The portfolio demo (README, Portfolio demo) on the test stack: the real bundled demo service, seeded by the documented command.
// Providers are the fixture (answering as api.deepseek.com and api.typesafe.ai). The seed's agents and decision carry no fixture
// key, so the fixture serves them from the '' (generation) and '@jev' (decision) script queues.
const shop='http://localhost:3300';
const OWNER={email:'demo-owner@example.test',password:'Demo-owner-password-35!'};
const SUPPORT={email:'support@northwind-kettles.test',password:'Demo-support-password-35!'};
const env=['-e',`SEED_OWNER_EMAIL=${OWNER.email}`,'-e',`SEED_OWNER_PASSWORD=${OWNER.password}`,'-e',`SEED_SUPPORT_PASSWORD=${SUPPORT.password}`];
const seed=(...args)=>compose('run','--rm',...env,'seed','node','dist/seed.js',...args);
const seedAsync=(...args)=>promisify(execFile)('docker',['compose','-f','compose.yaml','-f','compose.test.yaml','run','--rm',...env,'seed','node','dist/seed.js',...args]);
const created=output=>output.split('\n').filter(l=>l.startsWith('Created'));
const signedIn=async account=>{const request=await client();assert.equal((await limited(()=>request('/api/auth/sign-in/email',account))).status,200);return request;};
const health=async()=>(await fetch(`${base}/health/ready`)).json();
const jev=(choice,probabilities)=>({json:{model:'jev-1.13.0',answers:{route:{type:'choice',choice,confidence:0.9,probabilities},english:{type:'noul',noul:0.99}},
  usage:{input_tokens:376,output_tokens:56}}});

// Sign-ups first (Better Auth allows 3 per 10 s): the demo Owner (once per database), a separate Operator, and the seed's Support account.
const owner=await client();
if((await limited(()=>owner('/api/auth/sign-in/email',OWNER))).status!==200) {
  assert.equal((await owner('/api/auth/sign-up/email',{name:'Demo Owner',...OWNER})).status,200);
  assert.equal((await owner('/api/auth/email-otp/verify-email',{email:OWNER.email,otp:await otp(OWNER.email,'email-verification')})).status,200);
  assert.equal((await owner('/api/auth/sign-in/email',OWNER)).status,200);
}
const outsider=await operator('demo-outsider');
const first=seed();
const B=first.match(/Shop: http:\/\/localhost:3300\/\?business=(\S+)/)[1];
const at=path=>`/api/businesses/${B}/${path}`;

// Better Auth rate-limits every client under one key (no trusted IP header), and each seed run signs in twice: let the sign-in
// window pass so the next file starts with a full budget.
after(()=>wait(61000));

// Website chat from the demo shop's approved origin.
const chat=async(path,body,token)=>{
  const response=await fetch(`${base}/api/chat/${B}${path}`,{method:body?'POST':'GET',
    headers:{origin:shop,'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:body&&JSON.stringify(body)});
  return {status:response.status,data:await response.json()};
};
// The shop backend's own fresh assertion for the signed-in demo Customer.
const shopAssertion=async()=>(await (await fetch(`${shop}/?business=${B}`,{headers:{cookie:'demo_customer=1'}})).text()).match(/data-assertion="([^"]+)"/)[1];
// The same synthetic demo key, signing for another demo Customer.
const assertionFor=async sub=>{
  const {kid,...jwk}=JSON.parse(readFileSync('demo/customer-key.json','utf8')),iat=Math.floor(Date.now()/1000);
  return new SignJWT({iss:shop,aud:new URL(base).origin,business_id:B,sub,iat,exp:iat+600,jti:crypto.randomUUID()}).setProtectedHeader({alg:'ES256',kid}).sign(await importJWK(jwk,'ES256'));
};
async function customer(assertion) {
  let opened=await chat('/conversations',{});
  assert.equal(opened.status,201);
  if(assertion){opened=await chat('/identity',{assertion},opened.data.token);assert.equal(opened.status,200,JSON.stringify(opened.data));}
  const token=opened.data.token,id=opened.data.conversation.id;
  return {token,id,ask:async text=>{
    const sent=await chat(`/conversations/${id}/messages`,{client_submission_id:`demo-${crypto.randomUUID()}`,text},token);
    assert.equal(sent.status,202);
    for(let i=0;i<200;i++) {
      const c=(await chat(`/conversations/${id}`,undefined,token)).data;
      if(!['queued','running'].includes(c.messages.find(m=>m.id===sent.data.message.id).turn_state))
        return {message:sent.data.message,conversation:c,replies:c.messages.filter(m=>m.reply_to===sent.data.message.id)};
      await wait(250);
    }
    throw new Error('Turn did not settle');
  }};
}
const trace=async id=>(await owner(at(`traces/${id}`))).data;
const lookups=async id=>(await owner(at(`inbox/conversations/${id}`))).data.lookups.map(l=>l.result);
const providerAttempts=id=>Number(sql(`SELECT count(*) FROM execution_attempts a JOIN jobs j ON j.id=a.job_id WHERE j.conversation_id='${id}' AND a.kind='provider'`));

test('Demo seed: one documented command through the APIs; reruns, also concurrent ones, change nothing; hosted mode refuses',async()=>{
  const snapshot=async()=>{
    // After a long compose run the pooled keep-alive socket may already be closed ("other side closed"): retry once.
    const read=async path=>(await owner(at(path)).catch(()=>owner(at(path)))).data;
    const configuration=await read('configuration');
    return {businesses:(await owner('/api/businesses').catch(()=>owner('/api/businesses'))).data.filter(b=>b.name==='Northwind Kettles'),memberships:await read('memberships'),
      origins:await read('website-origins'),keys:await read('customer-keys'),controls:await read('action-controls'),
      permissions:(await read('provider-permissions')).permissions,configuration:[configuration.revision,configuration.published_version],
      sources:(await read('sources')).map(s=>[s.ref,s.latest.id,s.latest.state,s.active?.document])};
  };
  const before=await snapshot();
  assert.deepEqual(before.businesses,[{id:B,name:'Northwind Kettles',role:'Owner'}]);
  assert.deepEqual(before.sources,[['care-guide',before.sources[0][1],'active','kettle-care.md'],['help-centre',before.sources[1][1],'active','https://northwind.demo.test/help/'],
    ['policies',before.sources[2][1],'active','northwind-policies.pdf']]);
  assert.deepEqual(before.origins,[shop]);
  assert.deepEqual(before.keys.map(k=>[k.kid,k.issuer]),[['northwind-demo-1',shop]]);
  assert.deepEqual(before.controls.credentials.map(c=>[c.ref,c.origin,c.header,c.active]),[['northwind-orders','https://northwind.demo.test','x-demo-key',true]]);
  assert.deepEqual(before.controls.policies.map(p=>[p.ref,p.customer_parameter,p.owner_field,p.active]),[['own-orders','customer','customer_id',true]]);
  assert.deepEqual(before.memberships.map(m=>[m.email,m.role,m.active]),[[OWNER.email,'Owner',true],[SUPPORT.email,'Support',true]]);
  // Written by the Owner's API requests (which record the acting Operator), never directly.
  const ownerId=sql(`SELECT id FROM "user" WHERE email='${OWNER.email}'`);
  assert.equal(sql(`SELECT string_agg(DISTINCT updated_by,',') FROM action_credentials WHERE business_id='${B}'`),ownerId);
  // Version 1 is every Business's system-published starting configuration; the Owner published the rest.
  assert.deepEqual(sql(`SELECT DISTINCT coalesce(published_by,'system') FROM published_configurations WHERE business_id='${B}'`).split('\n').sort(),[ownerId,'system'].sort());
  assert.equal(sql(`SELECT count(*) FROM demo_seeds WHERE name='Northwind Kettles'`),'1');

  // Two concurrent reruns after a seed stopped before recording its marker: without the seed lock both would adopt the Business and
  // one would fail on the marker's key. Both succeed, and the Business is adopted once.
  sql(`DELETE FROM demo_seeds WHERE name='Northwind Kettles'`);
  const outputs=await Promise.all([seedAsync(),seedAsync()]);
  assert.equal(sql(`SELECT string_agg(business_id::text,',') FROM demo_seeds WHERE name='Northwind Kettles'`),B);
  for(const {stdout} of outputs) {
    assert.deepEqual(created(stdout),[]);
    assert.match(stdout,/Already exists: Business Northwind Kettles/);
    assert.match(stdout,/Already exists: published configuration version \d+ \(simulation\)/);
  }
  assert.deepEqual(await snapshot(),before);
  const again=seed();
  assert.deepEqual(created(again),[]);
  assert.equal(again.split('\n').filter(l=>l.startsWith('Already exists')).length,11);
  assert.deepEqual(await snapshot(),before);

  // Refusals: hosted mode, and an Owner the app does not sign in. Neither changes anything.
  assert.throws(()=>compose('run','--rm',...env,'-e','APP_MODE=hosted','-e','APP_URL=https://example.test','-e','SMTP_HOST=smtp.example.test','seed'),
    e=>e.stderr.includes('Demo seeding is disabled in hosted mode'));
  assert.throws(()=>compose('run','--rm',...env,'-e','SEED_OWNER_PASSWORD=Wrong-password-0000!','seed'),e=>e.stderr.includes('Register and verify SEED_OWNER_EMAIL'));
  // Another Operator cannot take the demo Business over by naming it.
  assert.throws(()=>compose('run','--rm',...env,'-e',`SEED_OWNER_EMAIL=${outsider.email}`,'-e',`SEED_OWNER_PASSWORD=${outsider.password}`,'seed'),
    e=>e.stderr.includes('SEED_OWNER_EMAIL is not its Owner'));
  // Without the running demo service the seed stops with a clear message instead of pointing sources and lookups at nothing.
  compose('stop','demo');
  try {assert.throws(()=>seed(),e=>e.stderr.includes('Enable the demo service first'));} finally {compose('start','demo');}
  assert.deepEqual(await snapshot(),before);
});

test('Demo service: labelled in readiness; only local or test mode with exactly its host reaches it; hosted refuses both settings',async()=>{
  assert.equal((await health()).demo,'northwind.demo.test: demo service, not a real business');
  const base=(...args)=>execFileSync('docker',['compose','-f','compose.yaml','run','--rm','--no-deps',...args,'worker'],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:60000});
  for(const setting of [['-e','DEMO_PUBLIC_HOSTS=northwind.demo.test'],['-e','DEMO_CA_FILE=/demo/cert.pem']])
    assert.throws(()=>base('-e','APP_MODE=hosted',...setting),e=>e.stderr.includes('local-only'));
  assert.throws(()=>base('-e','DEMO_PUBLIC_HOSTS=internal.fixture.test'),e=>e.stderr.includes('must be exactly northwind.demo.test'));
  assert.throws(()=>base('-e','DEMO_PUBLIC_HOSTS=northwind.demo.test,internal.fixture.test','-e','DEMO_CA_FILE=/demo/cert.pem'),e=>e.stderr.includes('must be exactly'));

  // Without the setting the demo host is just a private address: crawling it is refused, and readiness drops the label.
  const b={owner:outsider,id:(await outsider.request('/api/businesses',{name:'Demo gate Business'})).data.id};
  compose('stop','worker');
  const bare=compose('run','-d','--no-deps','-e','DEMO_PUBLIC_HOSTS=','-e','DEMO_CA_FILE=','worker').trim();
  try {
    let state;
    for(let i=0;i<80;i++){state=await health().catch(()=>({}));if(state.status==='ready'&&!state.demo)break;await wait(250);}
    assert.equal(state.demo,undefined);
    assert.equal((await addWebsite(b,'demo-help','https://northwind.demo.test/help/')).status,202);
    const source=await ingested(b,'demo-help');
    assert.equal(source.latest.state,'failed');
    assert.match(source.latest.error,/not permitted/);
  } finally {execFileSync('docker',['rm','-f',bare],{stdio:'ignore'});compose('start','worker');}
  for(let i=0;i<80&&!(await health().catch(()=>({}))).demo;i++)await wait(250);
  assert.equal(compose('ps','--format','{{.Service}}').split('\n').filter(n=>n==='worker').length,1);
  // With another CA (the fixture's, which every other test host uses), the demo certificate is rejected: only the demo CA verifies it.
  compose('stop','worker');
  const wrongCa=compose('run','-d','--no-deps','-e','DEMO_CA_FILE=/fixture/cert.pem','worker').trim();
  try {
    for(let i=0;i<80&&!(await health().catch(()=>({}))).demo;i++)await wait(250);
    assert.equal((await outsider.request(`/api/businesses/${b.id}/sources/demo-help/refresh`,{})).status,202);
    const source=await ingested(b,'demo-help');
    assert.equal(source.latest.state,'failed');
    assert.match(source.latest.error,/certificate/);
  } finally {execFileSync('docker',['rm','-f',wrongCa],{stdio:'ignore'});compose('start','worker');}
  for(let i=0;i<80&&!(await health().catch(()=>({}))).demo;i++)await wait(250);
  // The allowlisted worker crawls the same scope.
  assert.equal((await outsider.request(`/api/businesses/${b.id}/sources/demo-help/refresh`,{})).status,202);
  assert.equal((await ingested(b,'demo-help')).latest.state,'active');
  await outsider.request(`/api/businesses/${b.id}/sources/demo-help/delete`,{});
});

test('Demo walkthrough in simulation: labelled replies, simulated routes, retrieval, authorized lookups, handoff and logout; no provider call',async()=>{
  seed();
  const anonymous=await customer();
  const policy=await anonymous.ask('What is your returns policy?');
  assert.equal(policy.conversation.mode,'simulation');
  assert.deepEqual(policy.replies.map(m=>[m.author,m.simulated,m.citations]),[['assistant',true,null]]);
  assert.match(policy.replies[0].text,/^Simulated reply: no AI model generated this text/);
  const [turn]=(await trace(anonymous.id)).turns;
  assert.deepEqual(turn.steps.map(s=>[s.step_id,s.status,s.output]),[['triage','succeeded','policy'],['search','succeeded','next'],['answer','succeeded','reply']]);
  assert.deepEqual(turn.steps[0].detail,{simulated:true,choice:'policy'});
  assert(turn.steps[1].detail.evidence.some(e=>e.document==='northwind-policies.pdf'),JSON.stringify(turn.steps[1].detail));
  assert.deepEqual(turn.steps[2].detail,{agent:'policy',simulated:true});
  assert.deepEqual(turn.attempts,[]);
  // Orders need a verified Customer; nothing is looked up for an anonymous one.
  const anonymousOrder=await anonymous.ask('Where is my order?');
  assert.deepEqual(anonymousOrder.replies.map(m=>m.text),['To continue, please sign in on this website so I can confirm the order is yours.']);
  assert.deepEqual(await lookups(anonymous.id),[]);

  const ada=await customer(await shopAssertion());
  const order=await ada.ask('Where is my order?');
  assert.deepEqual(order.replies.map(m=>[m.author,m.simulated]),[['assistant',true]]);
  assert.deepEqual(await lookups(ada.id),[{customer_id:'demo-customer-ada',orders:[
    {order_id:'NK-1001',item:'Aurora Glass Kettle',status:'shipped',estimated_delivery:'in 2 business days'},
    {order_id:'NK-1002',item:'Limescale filter (2-pack)',status:'processing',estimated_delivery:'in 4 business days'}]}]);
  const adaTurn=(await trace(ada.id)).turns.at(-1);
  assert.deepEqual(adaTurn.steps.map(s=>[s.step_id,s.output]),[['triage','order'],['lookup','success'],['update','reply']]);
  assert.deepEqual(adaTurn.steps[1].detail,{lookups:[{action:'my_orders',fields:['customer_id','orders']}]});
  // Another verified Customer gets only their own order; Ada's never reach them.
  const ben=await customer(await assertionFor('demo-customer-ben'));
  await ben.ask('When will my order arrive?');
  assert.deepEqual((await lookups(ben.id)).map(r=>[r.customer_id,r.orders.map(o=>o.order_id)]),[['demo-customer-ben',['NK-2001']]]);

  // Memory in simulation: the verified Customer opts in and states a preference; nothing is extracted without a model.
  // The demo Customer persists across runs, so start from memory off; end with it off, so connected turns extract nothing.
  const memory=`/conversations/${ada.id}/memory`;
  let state=(await chat(memory,undefined,ada.token)).data;
  if(state.enabled)state=(await chat(memory,{action:'disable',revision:state.revision},ada.token)).data;
  const enabled=await chat(memory,{action:'enable',revision:state.revision,disclosure_version:'1'},ada.token);
  assert.equal(enabled.status,200,JSON.stringify(enabled.data));
  const corrected=await chat(memory,{action:'correct',revision:enabled.data.revision,kind:'preferred_name',value:'Ada'},ada.token);
  assert.deepEqual(corrected.data.preferences.map(p=>[p.kind,p.value,p.provenance]),[['preferred_name','Ada','customer-correction']]);
  assert.equal((await chat(memory,{action:'disable',revision:corrected.data.revision},ada.token)).data.enabled,false);

  // Anything else goes to the shared inbox, where Support sees it.
  const other=await ada.ask('hello');
  assert.deepEqual(other.replies,[]);
  assert.equal(other.conversation.control_state,'waiting-for-support');
  const support=await signedIn(SUPPORT);
  const queued=(await support(at('inbox'))).data.conversations.find(c=>c.id===ada.id);
  assert.deepEqual([queued.control_state,queued.handoff_reason,queued.verified],['waiting-for-support','workflow-handoff',true]);
  for(const c of [anonymous,ada,ben])assert.equal(providerAttempts(c.id),0);

  // Logout ends the verified session; its token no longer reaches anything.
  const out=await chat('/logout',{},ada.token);
  assert.equal(out.status,200);
  assert.equal(out.data.verified,false);
  assert.equal((await chat(`/conversations/${ada.id}`,undefined,ada.token)).status,401);
});

test('Demo walkthrough connected (fixture providers): permissions only when asked, Jev routes, cited answers, order answers from the lookup, handoff',async()=>{
  const output=seed('--connected');
  assert.match(output,/provider permission jev\/decision/);
  assert.match(output,/published configuration version \d+ \(connected\)/);
  assert.deepEqual((await owner(at('provider-permissions'))).data.permissions.map(p=>[`${p.provider}/${p.operation}`,p.allowed]),
    [['deepseek/generation',true],['deepseek/extraction',true],['qwen/generation',true],['qwen/extraction',true],['jev/decision',true]]);
  const ready=await health();
  for(const provider of ['deepseek','qwen','jev'])assert.match(ready.generation[provider].key,/^configured/);
  assert.deepEqual(created(seed('--connected')),[]);

  const ada=await customer(await shopAssertion());
  await script('@jev',[jev('policy',{policy:0.9,order:0.05,other:0.05})]);
  await script('',[cite('Unused kettles can be returned within 30 days of delivery.','E1')]);
  const policy=await ada.ask('Can I return my kettle?');
  assert.equal(policy.conversation.mode,'connected');
  assert.deepEqual(policy.replies.map(m=>[m.author,m.simulated,m.text]),[['assistant',false,'Unused kettles can be returned within 30 days of delivery.']]);
  assert.equal(policy.replies[0].citations.length,1);
  const evidence=received((await calls('')).at(-1)).evidence;
  assert(evidence.some(e=>e.document==='northwind-policies.pdf'&&e.page===1),JSON.stringify(evidence.map(e=>[e.document,e.page])));
  const cited=evidence.find(e=>e.id==='E1');
  assert.deepEqual(policy.replies[0].citations,[{source:cited.source,document:cited.document,page:cited.page}]);

  await script('@jev',[jev('order',{policy:0.05,order:0.9,other:0.05})]);
  await script('',[reply({outcome:'reply',reply:'NK-1001 has shipped and arrives in 2 business days.'})]);
  const order=await ada.ask('Where is my order?');
  assert.deepEqual(order.replies.map(m=>m.text),['NK-1001 has shipped and arrives in 2 business days.']);
  assert.deepEqual(received((await calls('')).at(-1)).context.orders.map(o=>o.order_id),['NK-1001','NK-1002']);
  const [decision]=(await trace(ada.id)).turns.at(-1).steps;
  assert.deepEqual(decision.detail,{choice:'order',probability:0.9});

  // Below the threshold, or anything else: the inbox.
  await script('@jev',[jev('policy',{policy:0.4,order:0.35,other:0.25})]);
  const unsure=await ada.ask('hmm');
  assert.deepEqual([unsure.replies,unsure.conversation.control_state],[[],'waiting-for-support']);
  const anonymous=await customer();
  await script('@jev',[jev('other',{policy:0.05,order:0.05,other:0.9})]);
  const other=await anonymous.ask('Tell me a joke');
  assert.deepEqual([other.replies,other.conversation.control_state],[[],'waiting-for-support']);
});

test('browser: the demo shop at 1280 and 390 px: signed-in cited answer, handoff to the inbox, sign-out, and an idempotent seed rerun',async()=>{
  seed('--connected');
  const browser=await chromium.launch();
  const errors=[];
  try {
    for(const width of [1280,390]) {
      const context=await browser.newContext({viewport:{width,height:900}});
      const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
      await page.goto(`${shop}/?business=${B}`);
      await page.getByText('Demo shop: Northwind Kettles is a fictional business. Products, orders and customers are synthetic.').waitFor();
      await page.getByRole('button',{name:'Sign in as demo customer'}).click();
      const widget=page.getByRole('region',{name:'Website chat'});
      await widget.getByText(/Signed in: your earlier conversations/).waitFor();
      await script('@jev',[jev('policy',{policy:0.9,order:0.05,other:0.05})]);
      await script('',[cite('Refunds reach your original payment method within 5 business days.','E1')]);
      await widget.getByLabel('Message').fill('How long do refunds take?');
      await widget.getByRole('button',{name:'Send',exact:true}).click();
      await widget.getByText('Assistant: Refunds reach your original payment method within 5 business days.',{exact:false}).waitFor();
      await widget.getByText(/Sources: \S/).waitFor();

      await script('@jev',[jev('other',{policy:0.05,order:0.05,other:0.9})]);
      const greeting=`hello from ${width} px`;
      await widget.getByLabel('Message').fill(greeting);
      await widget.getByRole('button',{name:'Send',exact:true}).click();
      await widget.getByText(/^Notice: Waiting for support\./).waitFor();
      const conversation=await page.evaluate(b=>JSON.parse(localStorage.getItem(`custom-bot-chat:${b}`)).conversation,B);

      const inbox=await (await browser.newContext({viewport:{width,height:900}})).newPage();inbox.on('pageerror',e=>errors.push(e.message));
      await inbox.goto(base);
      await inbox.getByLabel('Email',{exact:true}).fill(SUPPORT.email);await inbox.getByLabel('Password',{exact:true}).fill(SUPPORT.password);
      await inbox.getByRole('button',{name:'Sign in',exact:true}).click();await inbox.getByText('Signed in.',{exact:true}).waitFor();
      await inbox.getByRole('button',{name:'Open inbox Northwind Kettles'}).click();
      await inbox.getByRole('button',{name:`Open conversation ${conversation.slice(0,8)}`}).click();
      await inbox.getByText(/Waiting for support\. Reason: workflow-handoff\./).waitFor();
      await inbox.getByRole('log').getByText(`Customer: ${greeting}`,{exact:true}).waitFor();

      await page.getByRole('button',{name:'Sign out'}).click();
      await page.getByRole('button',{name:'Sign in as demo customer'}).waitFor();
      await widget.getByText(/Configuration version \d+\.$/).waitFor();
      for(const p of [page,inbox])assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`horizontal scroll at ${width} px`);
      await context.close();await inbox.context().close();
    }
    // A rerun changes nothing the Owner sees: still one demo Business, at the same published version.
    const version=(await owner(at('configuration'))).data.published_version;
    assert.deepEqual(created(seed('--connected')),[]);
    const page=await (await browser.newContext({viewport:{width:390,height:900}})).newPage();page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base);
    await page.getByLabel('Email',{exact:true}).fill(OWNER.email);await page.getByLabel('Password',{exact:true}).fill(OWNER.password);
    await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByText('Signed in.',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Open inbox Northwind Kettles'}).count(),1);
    assert.equal((await owner(at('configuration'))).data.published_version,version);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    assert.deepEqual(errors,[]);
  } finally {await browser.close();}
  // Leave the demo in its default simulation mode for later files.
  seed();
});
