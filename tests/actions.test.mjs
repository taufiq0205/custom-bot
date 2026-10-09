import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { action, agent, attempts, base, business, calls, compose, config, handoff, invitationToken, operator, owned, publish, reply, script, sql, start, wait } from './helpers.mjs';

// Two shapes that must behave identically for every check: an explicit HTTP step, and an agent asking for the same action.
function explicit(key,actionExtra) {
  return config({agents:[agent(`${key}.triage`),agent(`${key}.answer`)],actions:[action('lookup',key,actionExtra)],
    steps:[{id:'triage',type:'agent',agent:'triage',final:false},{id:'order',type:'http',action:'lookup'},{id:'answer',type:'agent',agent:'answer',final:true},handoff],
    links:[['triage','next','order'],['triage','unsupported','support'],['order','success','answer'],['order','failure','support'],['answer','unsupported','support']]});
}
function requested(key,actionExtra) {
  return config({agents:[{...agent(`${key}.helper`),actions:['lookup']}],actions:[action('lookup',key,actionExtra)],
    steps:[{id:'helper',type:'agent',agent:'helper',final:true},handoff],links:[['helper','unsupported','support']]});
}
const next=reply({outcome:'next',context:{order_id:'A-1'}});
const ask=reply({outcome:'action',action:'lookup',input:{order_id:'A-1'}});
const answer=reply({outcome:'reply',reply:'Your order is on its way.'});
// Scripts the agents of one shape: the order number, then the final reply.
const agents=async(key,shape)=>shape==='explicit'
  ?(await script(`${key}.triage`,[next]),await script(`${key}.answer`,[answer]))
  :await script(`${key}.helper`,[ask,answer]);
const finalCalls=async(key,shape)=>shape==='explicit'?(await calls(`${key}.answer`)).length:(await calls(`${key}.helper`)).length-1;
const inbox=(b,c)=>b.owner.request(`/api/businesses/${b.id}/inbox/conversations/${c.conversation.id}`);
const step=shape=>shape==='explicit'?'order':'helper';

let shared;
const owner=async()=>shared??=await operator('actions-owner');

// Runs first: its sign-ups stay clear of the next file's (Better Auth allows 3 sign-ups per 10 s, and a browser cannot wait out a 429).
test('browser: Support sees a completed authorized lookup as a timestamped historical observation',async()=>{
  const o=await owner();
  const b=await business('actions-browser',{owner:o});
  const support=await operator('actions-support');
  assert.equal((await o.request(`/api/businesses/${b.id}/invitations`,{email:support.email,role:'Support'})).status,201);
  assert.equal((await support.request('/api/invitations/accept',{token:await invitationToken(support.email)})).status,200);
  // Support has no access to action controls.
  assert.equal((await support.request(b.controls('action-controls'))).status,404);
  const key=`browser-${crypto.randomUUID()}`;
  await publish(b,explicit(key));
  await agents(key,'explicit');
  await script(key,[owned({status:'<b>shipped</b>',internal_note:'hidden'})]);
  const customer=await start(b);
  await customer.ask('Where is A-1?');
  assert.equal((await customer.request(`${b.id}/conversations/${customer.conversation.id}/handoff`,{})).status,200);
  const browser=await chromium.launch();
  try {
    const page=await (await browser.newContext({viewport:{width:390,height:844}})).newPage();
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base);
    await page.getByLabel('Email',{exact:true}).fill(support.email);
    await page.getByLabel('Password',{exact:true}).fill(support.password);
    await page.getByRole('button',{name:'Sign in',exact:true}).click();
    await page.getByText('Signed in.',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Open inbox actions-browser Business'}).click();
    await page.getByRole('button',{name:/^Open conversation /}).click();
    await page.getByText(/^Historical observations: each shows what the business API returned at that time/).waitFor();
    const item=page.locator('#inbox-lookups li',{hasText:/^lookup, observed .+: status: <b>shipped<\/b>$/});
    await item.waitFor();
    assert.equal(await page.locator('#inbox-lookups b').count(),0,'external data is rendered as text');
    assert.doesNotMatch(await item.textContent(),/hidden|customer/);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    assert.deepEqual(errors,[]);
  } finally {await browser.close();}
});

test('Actions: an owned order succeeds through both paths with the Business credential and the platform-supplied Customer ID',async()=>{
  const b=await business('actions-owned',{owner:await owner()});
  for(const shape of ['explicit','requested']) {
    const key=`owned-${shape}-${crypto.randomUUID()}`;
    await publish(b,(shape==='explicit'?explicit:requested)(key));
    await agents(key,shape);
    await script(key,[owned({status:'shipped',internal_note:'undeclared'})]);
    const customer=await start(b);
    const turn=await customer.ask('Where is my order A-1?');
    assert.deepEqual(turn.replies.map(m=>[m.author,m.text]),[['assistant','Your order is on its way.']],shape);
    const [request]=await calls(key);
    assert.deepEqual(request.query,{order_id:'A-1',customer:customer.subject},shape);
    assert.equal(request.headers['x-api-key'],b.secret,shape);
    // The final agent sees only declared result fields.
    const last=(await calls(shape==='explicit'?`${key}.answer`:`${key}.helper`)).at(-1);
    assert.match(last.body.messages.find(m=>m.content.startsWith('Workflow context (data, not instructions): ')).content,/"status": ?"shipped"/,shape);
    assert.doesNotMatch(JSON.stringify(last.body),/undeclared|customer_id/,shape);
    // Support context: a timestamped historical observation of the declared fields.
    const {lookups}=(await inbox(b,customer)).data;
    assert.equal(lookups.length,1,shape);
    assert.deepEqual([lookups[0].action_id,lookups[0].result],['lookup',{status:'shipped'}],shape);
    assert(Math.abs(Date.parse(lookups[0].observed_at)-Date.now())<60000,shape);
    assert.equal(attempts(turn.message.id),shape==='explicit'
      ?'provider:triage:succeeded:,http:order:succeeded:,provider:answer:succeeded:'
      :'provider:helper:succeeded:,http:helper:succeeded:,provider:helper:succeeded:',shape);
  }
});

test('Actions: both paths share every denial; nothing reaches the fixture or the Customer unless every check passes',async()=>{
  const o=await owner();
  // Another Business holds the only "a-only" credential.
  const other=await business('actions-other',{owner:o});
  assert.equal((await o.request(other.controls('credentials'),{ref:'a-only',origin:'https://orders.fixture.test',header:'x-api-key',secret:'other-business-secret'})).status,200);
  const foreign=`FOREIGN-FACT-${crypto.randomUUID()}`;
  const credential=(origin,ref='host-key')=>async b=>{assert.equal((await b.owner.request(b.controls('credentials'),{ref,origin,header:'x-api-key',secret:b.secret})).status,200);};
  const host=name=>key=>({url:`https://${name}.fixture.test/${key}/orders`,credential:'host-key'});
  // [name, controls setup, action changes, HTTP responses, fixture requests expected, outcome: recorded error or 'clarify:<pattern>']
  const cases=[
    ['another Customer\'s order (order ID alone)',null,null,[{json:{status:foreign,customer_id:'customer-someone-else'}}],1,'result not authorized for this Customer'],
    ['a result with no owner field',null,null,[{json:{status:foreign}}],1,'result not authorized for this Customer'],
    ['the owner field with a different type',null,null,[{json:{status:foreign,customer_id:7}}],1,'result not authorized for this Customer'],
    ['revoked action',async b=>{assert.equal((await b.owner.request(b.controls('actions/lookup'),{revoked:true})).status,200);},null,[owned({status:foreign})],0,'action revoked'],
    ['revoked credential',async b=>{assert.equal((await b.owner.request(b.controls('credentials/orders-key/revoke'),{})).status,200);},null,[owned({status:foreign})],0,'credential unavailable'],
    ['revoked authorization policy',async b=>{assert.equal((await b.owner.request(b.controls('authorization-policies/own-orders/revoke'),{})).status,200);},null,[owned({status:foreign})],0,'authorization policy unavailable'],
    ['another Business\'s credential',null,()=>({credential:'a-only'}),[owned({status:foreign})],0,'credential unavailable'],
    ['an unknown authorization policy',null,()=>({authorization:'nobody'}),[owned({status:foreign})],0,'authorization policy unavailable'],
    ['a reachable server on a private address',credential('https://internal.fixture.test'),host('internal'),[owned({status:foreign})],0,'destination address not permitted'],
    ['loopback',credential('https://loopback.fixture.test'),host('loopback'),[],0,'destination address not permitted'],
    ['cloud metadata link-local',credential('https://metadata.fixture.test'),host('metadata'),[],0,'destination address not permitted'],
    ['private 10/8',credential('https://private.fixture.test'),host('private'),[],0,'destination address not permitted'],
    ['credential origin approves another host',credential('https://orders.fixture.test'),host('other'),[owned({status:foreign})],0,'destination not approved'],
    ['an input named like the Customer parameter',null,()=>({input_schema:{type:'object',properties:{order_id:{type:'string'},customer:{type:'string'}},required:['order_id']}}),[owned({status:foreign})],0,'input collides with the Customer parameter'],
    ['the Customer parameter in the action URL',null,key=>({url:`https://orders.fixture.test/${key}/orders?customer=customer-someone-else`}),[owned({status:foreign})],0,'input collides with the Customer parameter'],
    ['a redirect, even to an approved-looking private host, is never followed',null,null,[{status:302,headers:{location:'https://internal.fixture.test/elsewhere'}}],1,'status 302'],
    ['malformed result',null,null,[owned({state:foreign})],1,'result does not match its schema'],
    ['non-JSON result',null,null,[{raw:`<html>${foreign}</html>`}],1,'malformed result'],
    ['authentication failure is not retried',null,null,[{status:401,json:{}}],1,'status 401'],
    ['authorization failure is not retried',null,null,[{status:403,json:{}}],1,'status 403'],
    ['a transient failure retries exactly once',null,null,[{status:503},{status:502}],2,'status 502'],
    ['an anonymous Customer is asked to sign in',null,null,[owned({status:foreign})],0,'clarify:please sign in on this website'],
  ];
  for(const [name,setup,change,responses,requests,outcome] of cases) {
    const b=await business('actions-denial',{owner:o});
    await setup?.(b);
    for(const shape of ['explicit','requested']) {
      const key=`deny-${shape}-${crypto.randomUUID()}`;
      const label=`${name} (${shape})`;
      await publish(b,(shape==='explicit'?explicit:requested)(key,change?.(key)));
      await agents(key,shape);
      await script(key,responses);
      const customer=await start(b,name.startsWith('an anonymous')?null:undefined);
      const turn=await customer.ask('Where is my order A-1?');
      assert.equal((await calls(key)).length,requests,label);
      assert.equal(await finalCalls(key,shape),0,label);
      assert.equal(JSON.stringify(turn.conversation).includes(foreign),false,label);
      assert.deepEqual((await inbox(b,customer)).data.lookups,[],label);
      const http=attempts(turn.message.id).split(',').filter(a=>a.startsWith('http:'));
      if(outcome.startsWith('clarify:')) {
        assert.deepEqual(turn.replies.map(m=>m.author),['assistant'],label);
        assert.match(turn.replies[0].text,new RegExp(outcome.slice(8)),label);
        assert.equal(turn.conversation.control_state,'automated',label);
        continue;
      }
      assert.equal(turn.conversation.messages.some(m=>m.author==='assistant'),false,label);
      assert.equal(turn.conversation.control_state,'waiting-for-support',label);
      assert.equal((await inbox(b,customer)).data.handoff_reason,'workflow-handoff',label);
      assert.deepEqual(http.map(a=>a.split(':').slice(1).join(':')),[...Array(Math.max(requests,1)-1).fill(`${step(shape)}:failed:status 503`),`${step(shape)}:failed:${outcome}`],label);
    }
  }
  // The redirect target was never contacted.
  assert.equal((await calls('elsewhere')).length,0);
});

test('Actions: missing inputs clarify on both paths; an agent cannot request an action it is not permitted',async()=>{
  const b=await business('actions-inputs',{owner:await owner()});
  let key=`missing-explicit-${crypto.randomUUID()}`;
  await publish(b,explicit(key));
  await script(`${key}.triage`,[reply({outcome:'next',context:{intent:'order'}})]);
  let turn=await (await start(b)).ask('Where is my order?');
  assert.deepEqual(turn.replies.map(m=>m.text),['To continue, please tell me your order number.']);
  assert.equal((await calls(key)).length,0);
  key=`missing-requested-${crypto.randomUUID()}`;
  await publish(b,requested(key));
  await script(`${key}.helper`,[reply({outcome:'action',action:'lookup',input:{}})]);
  turn=await (await start(b)).ask('Where is my order?');
  assert.deepEqual(turn.replies.map(m=>m.text),['To continue, please tell me your order number.']);
  assert.equal(turn.conversation.control_state,'automated');
  assert.equal((await calls(key)).length,0);
  // An action outside the agent's permitted list is invalid output: a visible failure, and no request.
  key=`unpermitted-${crypto.randomUUID()}`;
  const doc=requested(key);
  doc.agents[0].actions=[];
  doc.actions.push(action('other',`${key}-other`));
  await publish(b,doc);
  await script(`${key}.helper`,[ask]);
  turn=await (await start(b)).ask('Where is my order?');
  assert.equal(turn.conversation.messages.some(m=>m.author==='assistant'),false);
  assert.match(turn.replies[0].text,/could not be answered automatically/);
  assert.equal((await calls(key)).length,0);
});

test('Actions: two Businesses with identical Customer and order IDs each use only their own credential',async()=>{
  const o=await owner();
  const a=await business('actions-iso-a',{owner:o}),b=await business('actions-iso-b',{owner:o});
  assert.notEqual(a.secret,b.secret);
  const key=`iso-${crypto.randomUUID()}`;
  for(const x of [a,b])await publish(x,explicit(key));
  await script(`${key}.triage`,[next,next]);
  await script(`${key}.answer`,[answer,answer]);
  await script(key,[owned({status:'A shipped'}),owned({status:'B packed'})]);
  const shared='customer-shared-123';
  await (await start(a,shared)).ask('Where is A-1?');
  const bCustomer=await start(b,shared);
  await bCustomer.ask('Where is A-1?');
  const requests=await calls(key);
  assert.deepEqual(requests.map(r=>[r.headers['x-api-key'],r.query.customer,r.query.order_id]),[[a.secret,shared,'A-1'],[b.secret,shared,'A-1']]);
  assert.deepEqual((await inbox(b,bCustomer)).data.lookups.map(l=>l.result),[{status:'B packed'}]);
  // Neither Business can see or manage the other's controls, and Support cannot manage its own.
  assert.equal((await o.request(a.controls('action-controls'))).status,200);
  const stranger=await operator('actions-stranger');
  assert.equal((await stranger.request(a.controls('action-controls'))).status,404);
  assert.equal((await stranger.request(a.controls('credentials'),{ref:'orders-key',origin:'https://orders.fixture.test',header:'x-api-key',secret:'stolen'})).status,404);
});

test('Actions: revocation defeats pinned versions, in-flight results and undelivered replies; observations stay historical',async()=>{
  const o=await owner();
  // Pinned: a conversation started before revocation still cannot use the action.
  let b=await business('actions-pinned',{owner:o});
  let key=`pinned-${crypto.randomUUID()}`;
  await publish(b,explicit(key));
  await agents(key,'explicit');
  await script(key,[owned({status:'shipped'})]);
  let customer=await start(b);
  await publish(b,explicit(`${key}-v2`));
  assert.equal((await b.owner.request(b.controls('actions/lookup'),{revoked:true})).status,200);
  let turn=await customer.ask('Where is A-1?');
  assert.equal(turn.conversation.configuration_version,2);
  assert.equal((await calls(key)).length,0);
  assert.match(attempts(turn.message.id),/http:order:failed:action revoked/);
  // Restoring the action lets new turns look it up again.
  assert.equal((await b.owner.request(b.controls('actions/lookup'),{revoked:false})).status,200);
  await agents(`${key}-v2`,'explicit');
  await script(`${key}-v2`,[owned({status:'shipped'})]);
  assert.deepEqual((await (await start(b)).ask('Where is A-1?')).replies.map(m=>m.text),['Your order is on its way.']);

  // Mid-flight: each change while the request is in flight discards its result.
  const changes=[
    ['credential revoked',b=>b.owner.request(b.controls('credentials/orders-key/revoke'),{})],
    ['credential rotated',b=>b.owner.request(b.controls('credentials'),{ref:'orders-key',origin:'https://orders.fixture.test',header:'x-api-key',secret:`rotated-${crypto.randomUUID()}`})],
    ['policy revoked',b=>b.owner.request(b.controls('authorization-policies/own-orders/revoke'),{})],
    ['action revoked',b=>b.owner.request(b.controls('actions/lookup'),{revoked:true})],
  ];
  for(const [name,change] of changes) {
    b=await business('actions-inflight',{owner:o});
    key=`inflight-${crypto.randomUUID()}`;
    await publish(b,explicit(key));
    await agents(key,'explicit');
    await script(key,[owned({status:'LATE-FACT'},{delay:4})]);
    customer=await start(b);
    const message=await customer.send('Where is A-1?');
    for(let i=0;i<40&&!(await calls(key)).length;i++)await wait(250);
    assert.equal((await change(b)).status,200,name);
    const seen=await customer.settle(message);
    assert.equal(seen.messages.some(m=>m.author==='assistant'),false,name);
    assert.equal((await calls(`${key}.answer`)).length,0,name);
    assert.deepEqual((await inbox(b,customer)).data.lookups,[],name);
    assert.match(attempts(message.id),/http:order:failed:action controls changed/,name);
    assert.equal(seen.control_state,'waiting-for-support',name);
  }

  // Revoked after the lookup but before the reply is delivered: the reply carrying its facts is not delivered.
  b=await business('actions-delivery',{owner:o});
  key=`delivery-${crypto.randomUUID()}`;
  await publish(b,explicit(key));
  await script(`${key}.triage`,[next]);
  await script(`${key}.answer`,[{...reply({outcome:'reply',reply:'Order A-1 has shipped.'}),delay:4}]);
  await script(key,[owned({status:'shipped'})]);
  customer=await start(b);
  const message=await customer.send('Where is A-1?');
  for(let i=0;i<40&&!(await calls(`${key}.answer`)).length;i++)await wait(250);
  assert.equal((await b.owner.request(b.controls('credentials/orders-key/revoke'),{})).status,200);
  const seen=await customer.settle(message);
  assert.equal(seen.messages.some(m=>m.author==='assistant'),false);
  assert.match(seen.messages.find(m=>m.reply_to===message.id).text,/could not be answered automatically/);
  // The completed authorized lookup remains, labelled with when it was observed.
  const {lookups,handoff_reason}=(await inbox(b,customer)).data;
  assert.deepEqual([handoff_reason,lookups.map(l=>l.result)],['automation-failure',[{status:'shipped'}]]);

  // Revoked while a later agent runs: no further provider call receives the looked-up facts.
  b=await business('actions-provider',{owner:o});
  key=`provider-${crypto.randomUUID()}`;
  await publish(b,config({agents:[agent(`${key}.triage`),agent(`${key}.mid`),agent(`${key}.answer`)],actions:[action('lookup',key)],
    steps:[{id:'triage',type:'agent',agent:'triage',final:false},{id:'order',type:'http',action:'lookup'},{id:'mid',type:'agent',agent:'mid',final:false},
      {id:'answer',type:'agent',agent:'answer',final:true},handoff],
    links:[['triage','next','order'],['triage','unsupported','support'],['order','success','mid'],['order','failure','support'],
      ['mid','next','answer'],['mid','unsupported','support'],['answer','unsupported','support']]}));
  await script(`${key}.triage`,[next]);
  await script(`${key}.mid`,[{...reply({outcome:'next',context:{tone:'brief'}}),delay:4}]);
  await script(`${key}.answer`,[answer]);
  await script(key,[owned({status:'PROVIDER-FACT'})]);
  customer=await start(b);
  const later=await customer.send('Where is A-1?');
  for(let i=0;i<40&&!(await calls(`${key}.mid`)).length;i++)await wait(250);
  assert.equal((await b.owner.request(b.controls('actions/lookup'),{revoked:true})).status,200);
  const ended=await customer.settle(later);
  assert.equal((await calls(`${key}.answer`)).length,0);
  assert.equal(ended.messages.some(m=>m.author==='assistant'),false);
  assert.equal((await inbox(b,customer)).data.handoff_reason,'automation-failure');
});

test('Actions: credentials are encrypted with a key outside the database and never appear in API, prompt, trace, log or database payloads',async()=>{
  const b=await business('actions-secrets',{owner:await owner(),secret:`SENTINEL-SECRET-${crypto.randomUUID()}`});
  const key=`secret-${crypto.randomUUID()}`;
  await publish(b,requested(key));
  await script(`${key}.helper`,[ask,answer,ask]);
  await script(key,[owned({status:'shipped'}),{status:401,json:{}}]);
  const customer=await start(b);
  await customer.ask('Where is my order A-1?');
  const failed=await (await start(b)).ask('And again?');
  assert.equal(failed.conversation.control_state,'waiting-for-support');
  assert.deepEqual((await calls(key)).map(r=>r.headers['x-api-key']),[b.secret,b.secret]);
  const payloads=[
    await b.owner.request(b.controls('action-controls')),
    await b.owner.request(b.controls('credentials'),{ref:'orders-key',origin:'https://orders.fixture.test',header:'x-api-key',secret:b.secret}),
    await b.owner.request(`/api/businesses/${b.id}/configuration`),
    await b.owner.request(`/api/businesses/${b.id}/configuration/versions/2`),
    await b.owner.request(`/api/businesses/${b.id}/inbox`),
    await inbox(b,customer),
    {data:await customer.read()},
    {data:await calls(`${key}.helper`)},
  ];
  const listed=payloads[0].data.credentials;
  assert.deepEqual(listed.map(c=>Object.keys(c).sort()),[['active','header','origin','ref','revision','updated_at']]);
  for(const p of payloads)assert.equal(JSON.stringify(p.data).includes(b.secret),false);
  const keyHex='7e57000000000000000000000000000000000000000000000000000000007e57';
  const dump=compose('exec','-T','db','pg_dump','-U','custom_bot','-d','custom_bot','--data-only');
  for(const value of [b.secret,keyHex])assert.equal(dump.includes(value),false);
  assert.equal(sql(`SELECT count(*) FROM action_credentials WHERE business_id='${b.id}' AND ciphertext IS NOT NULL AND position(convert_to('${b.secret}','UTF8') in ciphertext)=0`),'1');
  const logs=compose('logs','app','worker');
  for(const value of [b.secret,keyHex])assert.equal(logs.includes(value),false);
  // Malformed keys stop startup instead of silently disabling credentials.
  assert.throws(()=>compose('run','--rm','--no-deps','-e','ACTION_CREDENTIAL_KEY=short','worker'),e=>e.stderr.includes('64 hex characters'));
  // The only private-network exemption is refused outside test mode (base Compose file: APP_MODE=local).
  assert.throws(()=>execFileSync('docker',['compose','-f','compose.yaml','run','--rm','--no-deps','-e','TEST_PUBLIC_HOSTS=internal.fixture.test','worker'],
    {encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:60000}),e=>e.stderr.includes('test-only'));
});

test('Actions: a provider payload holding a credential or provider key is refused before transfer; every attempt attests its check value-free',async()=>{
  // Quotes and backslashes: a lookup result reaches the provider as JSON text inside a message, so they are escaped twice.
  const b=await business('actions-payload',{owner:await owner(),secret:`SENTINEL"q\\uote\\-${crypto.randomUUID()}`});
  const key=`payload-${crypto.randomUUID()}`;
  await publish(b,requested(key));
  const provider=async c=>(await b.owner.request(`/api/businesses/${b.id}/traces/${c.conversation.id}`)).data.turns.at(-1).attempts.filter(a=>a.kind==='provider');
  const check=(extra={})=>({checked:true,credential_refs:['orders-key'],provider_keys:['deepseek','jev','qwen'],credential_exposed:false,provider_key_exposed:false,...extra});
  const sent=async()=>(await calls(`${key}.helper`)).length;
  await script(`${key}.helper`,[ask,answer]);
  await script(key,[owned({status:'shipped'})]);
  const normal=await start(b);
  assert.deepEqual((await normal.ask('Where is my order A-1?')).replies.map(m=>m.text),['Your order is on its way.']);
  assert.deepEqual((await provider(normal)).map(a=>[a.status,a.payload_check]),[['succeeded',check()],['succeeded',check()]]);
  // A lookup result echoing the credential: the generation that would carry it is refused and the turn goes to support.
  await script(`${key}.helper`,[ask]);
  await script(key,[owned({status:b.secret})]);
  const echoed=await start(b),before=await sent();
  assert.equal((await echoed.ask('Where is my order A-1?')).conversation.control_state,'waiting-for-support');
  assert.equal(await sent(),before+1);
  assert.deepEqual((await provider(echoed)).map(a=>[a.status,a.error,a.payload_check]),
    [['succeeded',null,check()],['failed','private secret in provider payload',check({credential_exposed:true})]]);
  // A Customer message holding the worker's provider key never leaves either.
  const typed=await start(b);
  assert.equal((await typed.ask('My key is test-deepseek-key-0000-synthetic')).conversation.control_state,'waiting-for-support');
  assert.equal(await sent(),before+1);
  assert.deepEqual((await provider(typed)).map(a=>[a.status,a.payload_check]),[['failed',check({provider_key_exposed:true})]]);
  // A credential that cannot be read blocks the transfer: the check fails closed.
  sql(`UPDATE action_credentials SET ciphertext='\\x00' WHERE business_id='${b.id}'`);
  const unreadable=await start(b);
  assert.equal((await unreadable.ask('Where is my order A-1?')).conversation.control_state,'waiting-for-support');
  assert.equal(await sent(),before+1);
  assert.deepEqual((await provider(unreadable)).map(a=>[a.status,a.error,a.payload_check.checked]),[['failed','provider payload check unavailable',false]]);
  const evidence=JSON.stringify([(await calls(`${key}.helper`)).map(c=>c.body),...await Promise.all([normal,echoed,typed,unreadable].map(c=>b.owner.request(`/api/businesses/${b.id}/traces/${c.conversation.id}`)))]);
  for(const value of [b.secret,JSON.stringify(b.secret).slice(1,-1),'test-deepseek-key'])assert.equal(evidence.includes(value),false,value);
});
