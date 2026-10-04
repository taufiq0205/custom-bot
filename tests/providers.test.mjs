import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { action, agent, base, business, calls, compose, config, handoff, invitationToken, operator, owned, permit, publish, reply, script, sql, start, wait } from './helpers.mjs';
// The test overlay's synthetic worker keys; they protect nothing.
const DEEPSEEK_KEY='test-deepseek-key-0000-synthetic',QWEN_KEY='test-dashscope-key-0000-synthetic';
const QWEN='qwen3.7-plus-2026-05-26',QWEN_BASE='https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
const fallback={provider:'qwen',name:QWEN};
// One final agent (its key routes fixture scripts; Qwen scripts use key@qwen) whose unsupported output hands off.
const single=(key,model={})=>config({agents:[{...agent(key),id:'answer',model:{provider:'deepseek',name:'deepseek-flash',...model}}],
  steps:[{id:'answer',type:'agent',agent:'answer',final:true},handoff],links:[['answer','unsupported','support']]});
const answered=text=>reply({outcome:'reply',reply:text});
const providerAttempts=message=>JSON.parse(sql(`SELECT coalesce(json_agg(json_build_object('target',a.target,'operation',a.operation,'fallback',a.fallback,
  'status',a.status,'error',a.error,'served',a.served_model,'tokens',array[a.prompt_tokens,a.completion_tokens],'cost',a.cost_usd) ORDER BY a.id),'[]')
  FROM execution_attempts a JOIN jobs j ON j.id=a.job_id WHERE j.message_id='${message}' AND a.kind='provider'`));
const handedOff=(turn,name)=>{
  assert.equal(turn.conversation.messages.some(m=>m.author==='assistant'),false,name);
  assert.equal(turn.conversation.control_state,'waiting-for-support',name);
  assert.match(turn.replies[0].text,/could not be answered automatically.*passed to support/,name);
};
const inFlight=async key=>{for(let i=0;i<40&&!(await calls(key)).length;i++)await wait(250);assert.equal((await calls(key)).length,1);};
// Sign-ups first: Better Auth allows 3 per 10 s, and the browser journey cannot wait out a 429.
const owner=await operator('providers'),support=await operator('providers-support'),outsider=await operator('providers-outsider');

test('browser: an Owner allows and withdraws provider generation, with readiness and the Qwen processing disclosure',async()=>{
  const b=await business('providers-browser',{owner,generation:false});
  const key=`browser-${crypto.randomUUID()}`;
  await publish(b,single(key));
  await script(key,[answered('Allowed from the browser.')]);
  const browser=await chromium.launch();
  try {
    for(const width of [1280,390]) {
      const page=await (await browser.newContext({viewport:{width,height:900}})).newPage();
      const errors=[];page.on('pageerror',e=>errors.push(e.message));
      await page.goto(base);
      await page.getByLabel('Email',{exact:true}).fill(owner.email);
      await page.getByLabel('Password',{exact:true}).fill(owner.password);
      await page.getByRole('button',{name:'Sign in',exact:true}).click();
      await page.getByRole('button',{name:'Manage providers-browser Business'}).click();
      await page.getByRole('button',{name:'Team and website'}).click();
      await page.getByText('Processing: Singapore access and static storage; inference potentially worldwide excluding Chinese mainland (not Singapore-only processing).',{exact:true}).waitFor();
      await page.getByText(/^Endpoint https:\/\/api\.deepseek\.com\. Key configured; account and model access not verified/).waitFor();
      await page.getByText(`Endpoint ${QWEN_BASE}. Key configured; account and model access not verified until a measured run.`,{exact:true}).waitFor();
      const deepseek=page.getByLabel('Allow DeepSeek generation'),qwen=page.getByLabel('Allow Qwen generation');
      if(width===1280) {
        assert.equal(await deepseek.isChecked(),false);
        assert.equal(await qwen.isChecked(),false);
        await deepseek.check();
        await page.getByText('DeepSeek generation allowed.',{exact:true}).waitFor();
        assert.deepEqual((await (await start(b)).ask('Hello?')).replies.map(m=>[m.author,m.text,m.simulated]),[['assistant','Allowed from the browser.',false]]);
      } else {
        // The permission persisted; withdrawing it stops the next turn before any transfer.
        assert.equal(await deepseek.isChecked(),true);
        await deepseek.uncheck();
        await page.getByText('DeepSeek generation not allowed.',{exact:true}).waitFor();
        const before=(await calls(key)).length;
        handedOff(await (await start(b)).ask('Hello again?'),'withdrawn in the browser');
        assert.equal((await calls(key)).length,before);
      }
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`no horizontal scroll at ${width}px`);
      assert.deepEqual(errors,[]);
    }
  } finally {await browser.close();}
});

test('Providers: DeepSeek generation needs the Business\'s live permission and uses the worker\'s key at its fixed endpoint',async()=>{
  const b=await business('providers-gate',{owner,generation:false});
  const key=`gate-${crypto.randomUUID()}`;
  await publish(b,single(key));
  await script(key,[answered('Hello from DeepSeek.')]);
  // Without permission nothing is sent.
  const denied=await (await start(b)).ask('Hello?');
  handedOff(denied,'no permission');
  assert.equal((await calls(key)).length,0);
  assert.deepEqual(providerAttempts(denied.message.id).map(a=>[a.target,a.status,a.error]),[['deepseek/deepseek-flash','failed','deepseek generation not permitted']]);
  // An extraction permission does not permit generation.
  await permit(b,'deepseek',true,'extraction');
  handedOff(await (await start(b)).ask('Hello?'),'extraction only');
  assert.equal((await calls(key)).length,0);

  await permit(b,'deepseek',true);
  const customer=await start(b);
  const allowed=await customer.ask('Hello?');
  assert.deepEqual(allowed.replies.map(m=>[m.author,m.text,m.simulated]),[['assistant','Hello from DeepSeek.',false]]);
  const [sent]=await calls(key);
  assert.deepEqual([sent.headers.host,sent.path,sent.headers.authorization,sent.body.model,sent.body.response_format],
    ['api.deepseek.com','/chat/completions',`Bearer ${DEEPSEEK_KEY}`,'deepseek-flash',{type:'json_object'}]);
  assert.equal('enable_thinking' in sent.body,false);
  assert.deepEqual(providerAttempts(allowed.message.id),[{target:'deepseek/deepseek-flash',operation:'generation',fallback:false,status:'succeeded',error:null,
    served:'deepseek-flash',tokens:[1000,100],cost:0.0007}]);
  // The served model is recorded as the provider reports it; a model without a configured rate has no cost estimate.
  await script(key,[{...answered('Served by another model.'),model:'deepseek-flash-2026-09',usage:{prompt_tokens:12,completion_tokens:3}}]);
  const other=await customer.ask('Which model?');
  assert.deepEqual(providerAttempts(other.message.id).map(a=>[a.served,a.tokens,a.cost]),[['deepseek-flash-2026-09',[12,3],null]]);

  // Permissions are per Business: another Business of the same Owner with the same workflow sends nothing.
  const c=await business('providers-gate-other',{owner,generation:false});
  await publish(c,single(key));
  handedOff(await (await start(c)).ask('Hello?'),'other Business');
  assert.equal((await calls(key)).length,2);
  // Neither the Customer nor Support payloads carry key values.
  for(const payload of [await customer.read(),(await b.owner.request(`/api/businesses/${b.id}/inbox/conversations`)).data])
    for(const secret of [DEEPSEEK_KEY,QWEN_KEY])assert.equal(JSON.stringify(payload).includes(secret),false);
});

test('Providers: a transient DeepSeek failure allows exactly one permitted Qwen attempt; other failures hand off without fallback',async()=>{
  const b=await business('providers-fallback',{owner});
  await permit(b,'qwen',true);
  const key=`fallback-${crypto.randomUUID()}`,qwenKey=`${key}@qwen`;
  await publish(b,single(key,{temperature:0.2,fallback}));

  await script(key,[{status:503,raw:'{}'}]);
  await script(qwenKey,[answered('From Qwen.')]);
  const recovered=await (await start(b)).ask('Hello?');
  assert.deepEqual(recovered.replies.map(m=>[m.author,m.text,m.simulated]),[['assistant','From Qwen.',false]]);
  const [deepseek]=await calls(key),[qwen]=await calls(qwenKey);
  // Each key goes only to its own provider; Qwen uses exactly the approved base, the same messages and JSON mode without thinking.
  assert.deepEqual([qwen.headers.host,qwen.path,qwen.headers.authorization,qwen.body.model,qwen.body.enable_thinking,qwen.body.temperature],
    ['dashscope-intl.aliyuncs.com','/compatible-mode/v1/chat/completions',`Bearer ${QWEN_KEY}`,QWEN,false,0.2]);
  assert.equal(deepseek.headers.authorization,`Bearer ${DEEPSEEK_KEY}`);
  assert.deepEqual(qwen.body.messages,deepseek.body.messages);
  assert.deepEqual(providerAttempts(recovered.message.id),[
    {target:'deepseek/deepseek-flash',operation:'generation',fallback:false,status:'failed',error:'status 503',served:null,tokens:[null,null],cost:null},
    {target:`qwen/${QWEN}`,operation:'generation',fallback:true,status:'succeeded',error:null,served:QWEN,tokens:[1000,100],cost:0.0014}]);

  const cases=[
    // [name, DeepSeek responses, Qwen responses, expected error of the last attempt]
    ['429 is transient too',[{status:429,raw:'{}'}],[answered('From Qwen.')],null],
    ['Qwen also transient: no third attempt',[{status:503,raw:'{}'}],[{status:502,raw:'{}'}],'status 502'],
    ['DeepSeek authentication failure: no fallback',[{status:401,raw:'{}'}],[],'status 401'],
    ['DeepSeek authorization failure: no fallback',[{status:403,raw:'{}'}],[],'status 403'],
    ['output that is not JSON: no fallback',[{content:'Sure! Your order shipped.'}],[],null],
    ['truncated output: no fallback',[{...answered('Your order has'),finish:'length'}],[],'incomplete provider output'],
    ['provider body that is not a completion: no fallback',[{raw:'{"choices":[]}'}],[],'invalid provider output'],
    ['output outside the final-agent contract: no fallback',[reply({outcome:'next',context:{}})],[],null],
    ['Qwen output invalid after fallback',[{status:500,raw:'{}'}],[{content:'not json'}],null],
  ];
  for(const [name,first,second,error] of cases) {
    const before=[(await calls(key)).length,(await calls(qwenKey)).length];
    await script(key,first);await script(qwenKey,second);
    const turn=await (await start(b)).ask('Hello?');
    assert.deepEqual([(await calls(key)).length-before[0],(await calls(qwenKey)).length-before[1]],[first.length,second.length],name);
    if(name==='429 is transient too'){assert.deepEqual(turn.replies.map(m=>m.text),['From Qwen.'],name);continue;}
    handedOff(turn,name);
    if(error)assert.equal(providerAttempts(turn.message.id).at(-1).error,error,name);
  }

  // A Qwen fallback that is not permitted is never attempted.
  await permit(b,'qwen',false);
  await script(key,[{status:503,raw:'{}'}]);await script(qwenKey,[answered('Should not be sent')]);
  const before=(await calls(qwenKey)).length;
  const unpermitted=await (await start(b)).ask('Hello?');
  handedOff(unpermitted,'fallback not permitted');
  assert.equal((await calls(qwenKey)).length,before);
  assert.deepEqual(providerAttempts(unpermitted.message.id).map(a=>[a.target,a.fallback,a.status,a.error]),
    [['deepseek/deepseek-flash',false,'failed','status 503'],[`qwen/${QWEN}`,true,'failed','qwen generation not permitted']]);

  // Without a configured fallback, a transient failure retries DeepSeek once instead.
  const plain=`plain-${crypto.randomUUID()}`;
  await publish(b,single(plain));
  await script(plain,[{status:503,raw:'{}'},answered('Second DeepSeek try.')]);
  assert.deepEqual((await (await start(b)).ask('Hello?')).replies.map(m=>m.text),['Second DeepSeek try.']);
  assert.equal((await calls(`${plain}@qwen`)).length,0);
});

test('Providers: the fallback spends the 3-agent-call budget and the deadline',async()=>{
  const b=await business('providers-budget',{owner});
  await permit(b,'qwen',true);
  const key=`budget-${crypto.randomUUID()}`;
  const step=(id,final)=>({...agent(`${key}.${id}`),id,model:{provider:'deepseek',name:'deepseek-flash',fallback}});
  await publish(b,config({agents:[step('s1'),step('s2'),step('s3')],
    steps:[{id:'s1',type:'agent',agent:'s1',final:false},{id:'s2',type:'agent',agent:'s2',final:false},{id:'s3',type:'agent',agent:'s3',final:true},handoff],
    links:[['s1','next','s2'],['s1','unsupported','support'],['s2','next','s3'],['s2','unsupported','support'],['s3','unsupported','support']]}));
  const next=reply({outcome:'next',context:{intent:'help'}});
  await script(`${key}.s1`,[{status:503,raw:'{}'}]);await script(`${key}.s1@qwen`,[next]);
  await script(`${key}.s2`,[next]);await script(`${key}.s3`,[answered('Done.')]);
  const turn=await (await start(b)).ask('Help me');
  assert.equal(turn.conversation.messages.some(m=>m.author==='assistant'),false);
  assert.match(turn.replies[0].text,/reached the automated assistant's limits/);
  assert.deepEqual(await Promise.all(['s1','s1@qwen','s2','s3','s3@qwen'].map(async s=>(await calls(`${key}.${s}`)).length)),[1,1,1,0,0]);

  // A DeepSeek attempt that hangs until little time is left leaves no room for a fallback: the deadline ends the turn.
  const slow=`deadline-${crypto.randomUUID()}`;
  await publish(b,single(slow,{fallback}));
  await script(slow,[{status:503,raw:'{}',delay:59.7}]);await script(`${slow}@qwen`,[answered('Too late')]);
  const late=await (await start(b)).ask('Hello?');
  assert.equal(late.conversation.messages.some(m=>m.author==='assistant'),false);
  assert.equal((await calls(`${slow}@qwen`)).length,0);
  assert.equal(late.conversation.control_state,'waiting-for-support');
});

test('Providers races: revoking a permission defeats in-flight output and every later transfer',async()=>{
  const b=await business('providers-races',{owner});
  await permit(b,'qwen',true);

  // Revoked while DeepSeek generates: the late output is discarded and nothing is delivered.
  let key=`revoke-${crypto.randomUUID()}`;
  await publish(b,single(key,{fallback}));
  await script(key,[{...answered('Late reply'),delay:4}]);
  let customer=await start(b),message=await customer.send('Hello?');
  await inFlight(key);
  await permit(b,'deepseek',false);
  let turn={message,conversation:await customer.settle(message)};
  turn.replies=turn.conversation.messages.filter(m=>m.reply_to===message.id);
  handedOff(turn,'revoked in flight');
  assert.equal(providerAttempts(message.id).at(-1).error,'provider permission changed');
  assert.equal((await calls(`${key}@qwen`)).length,0);

  // Revoked and allowed again while in flight: the permission changed, so the output is still discarded.
  await permit(b,'deepseek',true);
  await script(key,[{...answered('Late reply'),delay:4}]);
  customer=await start(b);message=await customer.send('Hello?');
  for(let i=0;i<40&&(await calls(key)).length<2;i++)await wait(250);
  await permit(b,'deepseek',false);await permit(b,'deepseek',true);
  turn={message,conversation:await customer.settle(message)};
  turn.replies=turn.conversation.messages.filter(m=>m.reply_to===message.id);
  handedOff(turn,'revoked and restored in flight');

  // Qwen revoked while DeepSeek fails slowly: no fallback transfer happens.
  key=`revoke-qwen-${crypto.randomUUID()}`;
  await publish(b,single(key,{fallback}));
  await script(key,[{status:503,raw:'{}',delay:4}]);await script(`${key}@qwen`,[answered('Should not be sent')]);
  customer=await start(b);message=await customer.send('Hello?');
  await inFlight(key);
  await permit(b,'qwen',false);
  await customer.settle(message);
  assert.equal((await calls(`${key}@qwen`)).length,0);
  assert.equal(providerAttempts(message.id).at(-1).error,'qwen generation not permitted');

  // An earlier agent's DeepSeek output may not travel on once DeepSeek is revoked, even to another permitted provider.
  await permit(b,'qwen',true);
  key=`revoke-earlier-${crypto.randomUUID()}`;
  await publish(b,config({agents:[agent(`${key}.triage`),{...agent(`${key}.answer`),model:{provider:'qwen',name:QWEN}}],actions:[action('lookup',key)],
    steps:[{id:'triage',type:'agent',agent:'triage',final:false},{id:'order',type:'http',action:'lookup'},{id:'answer',type:'agent',agent:'answer',final:true},handoff],
    links:[['triage','next','order'],['triage','unsupported','support'],['order','success','answer'],['order','failure','support'],['answer','unsupported','support']]}));
  await script(`${key}.triage`,[reply({outcome:'next',context:{order_id:'A-1'}})]);
  await script(key,[owned({status:'ok'},{delay:4})]);
  await script(`${key}.answer@qwen`,[answered('Should not be sent')]);
  customer=await start(b);message=await customer.send('Where is A-1?');
  await inFlight(key);
  await permit(b,'deepseek',false);
  const ended=await customer.settle(message);
  assert.equal(ended.messages.some(m=>m.author==='assistant'),false);
  assert.equal((await calls(`${key}.answer@qwen`)).length,0);
  assert.equal(ended.control_state,'waiting-for-support');
});

test('Providers: Owner-only controls, readiness disclosure, fallback validation and no key values in responses, rows or logs',async()=>{
  const readiness=await fetch(base+'/health/ready').then(r=>r.json());
  assert.deepEqual(readiness.generation,{simulation:'always available, labelled as simulated',
    deepseek:{endpoint:'https://api.deepseek.com',key:'configured; account and model access not verified until a measured run',role:'final replies'},
    qwen:{endpoint:QWEN_BASE,key:'configured; account and model access not verified until a measured run',
      role:'one fallback attempt after a transient DeepSeek failure, when permitted',
      processing:'Singapore access and static storage; inference potentially worldwide excluding Chinese mainland (not Singapore-only processing)'}});

  const b=await business('providers-controls',{owner});
  assert.equal((await owner.request(`/api/businesses/${b.id}/invitations`,{email:support.email,role:'Support'})).status,201);
  assert.equal((await support.request('/api/invitations/accept',{token:await invitationToken(support.email)})).status,200);
  const path=`/api/businesses/${b.id}/provider-permissions`;
  const listing=(await owner.request(path)).data;
  assert.deepEqual(listing.providers,{deepseek:readiness.generation.deepseek,qwen:readiness.generation.qwen});
  assert.deepEqual(listing.permissions.map(p=>[p.provider,p.operation,p.allowed]),
    [['deepseek','generation',true],['deepseek','extraction',false],['qwen','generation',false],['qwen','extraction',false]]);
  for(const who of [support,outsider]) {
    assert.equal((await who.request(path)).status,404);
    assert.equal((await who.request(path+'/qwen/generation',{allowed:true})).status,404);
  }
  assert.equal((await owner.request(path+'/qwen/generation',{allowed:true},{headers:{origin:'https://evil.example'}})).status,403);
  assert.equal((await owner.request(path+'/qwen/generation',{allowed:'yes'})).status,400);
  assert.equal((await owner.request(path+'/qwen/generation',{allowed:true,extra:1})).status,400);
  assert.equal((await owner.request(path+'/openai/generation',{allowed:true})).status,404);
  assert.equal((await owner.request(path)).data.permissions.find(p=>p.provider==='qwen'&&p.operation==='generation').allowed,false);

  // Only a DeepSeek model may name a fallback, and only Qwen.
  const draft=`/api/businesses/${b.id}/configuration`;
  const validation=async doc=>(await owner.request(draft,{text:JSON.stringify(doc),revision:(await owner.request(draft)).data.revision})).data.validation.errors;
  const key=`controls-${crypto.randomUUID()}`;
  assert.deepEqual(await validation(single(key,{fallback})),[]);
  assert.deepEqual((await validation(single(key,{provider:'qwen',name:QWEN,fallback}))).map(e=>e.path),['/agents/0/model/fallback']);
  assert.deepEqual((await validation(single(key,{fallback:{provider:'deepseek',name:'deepseek-flash'}}))).map(e=>e.path),['/agents/0/model/fallback/provider']);
  assert.deepEqual((await validation(single(key,{fallback:{provider:'qwen',name:QWEN,temperature:1}}))).map(e=>e.path),['/agents/0/model/fallback/temperature']);

  // A provider rejection that echoes the key reveals it nowhere.
  await publish(b,single(key));
  const marker=`private-customer-text-${crypto.randomUUID()}`;
  await script(key,[{status:401,raw:JSON.stringify({error:`invalid key ${DEEPSEEK_KEY}`})}]);
  const customer=await start(b);
  const rejected=await customer.ask(marker);
  handedOff(rejected,'echoed key');
  await script(key,[answered('Logged reply.')]);
  const logged=await customer.ask('Hello?');
  const rows=sql(`SELECT json_agg(a) FROM execution_attempts a JOIN jobs j ON j.id=a.job_id WHERE j.message_id IN ('${rejected.message.id}','${logged.message.id}')`);
  const payloads=[rows,JSON.stringify(await customer.read()),JSON.stringify((await owner.request(`/api/businesses/${b.id}/inbox/conversations/${customer.conversation.id}`)).data),
    JSON.stringify(listing),JSON.stringify(readiness),compose('logs','app','worker')];
  for(const payload of payloads)for(const secret of [DEEPSEEK_KEY,QWEN_KEY])assert.equal(payload.includes(secret),false);
  // Each attempt is logged value-free with provider, model, outcome, latency, usage and cost; never Customer text.
  const logs=compose('logs','worker');
  assert.equal(logs.includes(marker),false);
  assert.match(logs,new RegExp(`Provider attempt job=\\S+ step=answer deepseek/deepseek-flash generation failed in \\d+\\.\\d+s served=None tokens=None/None cost_usd=None error=status 401`));
  assert.match(logs,/Provider attempt job=\S+ step=answer deepseek\/deepseek-flash generation succeeded in \d+\.\d+s served=deepseek-flash tokens=1000\/100 cost_usd=0\.0007/);
  assert.match(logs,new RegExp(`Provider attempt job=\\S+ step=answer qwen/${QWEN.replace(/\./g,'\\.')} \\(fallback\\) generation succeeded`));
});

test('Providers: without keys connected agents are unavailable and nothing is sent; simulation stays labelled',async()=>{
  const b=await business('providers-keyless',{owner});
  await permit(b,'qwen',true);
  const key=`keyless-${crypto.randomUUID()}`,both=`keyless-fallback-${crypto.randomUUID()}`;
  await publish(b,single(key));
  const simulated=await business('providers-simulated',{owner});
  const keyless=(...variables)=>compose('run','-d','--no-deps',...variables.flatMap(v=>['-e',`${v}=`]),'worker').trim();
  const remove=name=>execFileSync('docker',['rm','-f',name],{stdio:'ignore'});
  // The stopped worker's heartbeat stays fresh for a few seconds, so wait for the new worker's own report.
  const reporting=async(deepseek,qwen)=>{
    for(let i=0;i<60;i++) {
      const response=await fetch(base+'/health/ready');
      const g=response.ok&&(await response.json()).generation;
      if(g&&g.deepseek.key.startsWith(deepseek)&&g.qwen.key.startsWith(qwen))return g;
      await wait(500);
    }
    throw new Error('The keyless worker never reported');
  };
  compose('stop','worker');
  let name;
  try {
    name=keyless('DEEPSEEK_API_KEY','DASHSCOPE_API_KEY');
    const generation=await reporting('missing','missing');
    assert.deepEqual([generation.deepseek.key,generation.qwen.key],['missing: set DEEPSEEK_API_KEY for the worker','missing: set DASHSCOPE_API_KEY for the worker']);
    await script(key,[answered('Should not be sent')]);
    const turn=await (await start(b)).ask('Is this real?');
    assert.equal(turn.conversation.messages.some(m=>m.author==='assistant'),false);
    assert.match(turn.replies[0].text,/connected generation is unavailable/);
    assert.equal(turn.conversation.control_state,'waiting-for-support');
    assert.equal((await calls(key)).length,0);
    const labelled=await (await start(simulated)).ask('Hello?');
    assert.deepEqual(labelled.replies.map(m=>[m.author,m.simulated]),[['assistant',true]]);
    assert.match(labelled.replies[0].text,/^Simulated reply: no AI model generated this text/);
    remove(name);

    // A DeepSeek key without a Qwen key: the fallback is unavailable, so a transient failure hands off without a transfer.
    name=keyless('DASHSCOPE_API_KEY');
    await reporting('configured','missing');
    await publish(b,single(both,{fallback}));
    await script(both,[{status:503,raw:'{}'}]);await script(`${both}@qwen`,[answered('Should not be sent')]);
    const fallbackless=await (await start(b)).ask('Hello?');
    handedOff(fallbackless,'no Qwen key');
    assert.equal((await calls(`${both}@qwen`)).length,0);
    assert.equal(sql(`SELECT j.error FROM jobs j WHERE j.message_id='${fallbackless.message.id}'`),'agent failed: qwen fallback unavailable: DASHSCOPE_API_KEY not set');
  } finally {
    if(name)remove(name);
    compose('start','worker');
    await reporting('configured','configured');
  }
});
