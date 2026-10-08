import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { action, active, agent, base, business, together, calls, cite, config, handoff, invitationToken, operator, owned, permit, publish, reply, script,
  sql, start, upload, wait } from './helpers.mjs';
// Sign-ups first: Better Auth allows 3 per 10 s.
const owner=await operator('traces-owner'),support=await operator('traces-support'),stranger=await operator('traces-stranger'),coowner=await operator('traces-coowner');
const CHOICES={refund:'A refund, return or replacement',order_status:'Where an order is or when it arrives'};
const answer=(choice,probabilities)=>({json:{model:'jev-1.13.0',answers:{route:{type:'choice',choice,confidence:0.9,probabilities},
  english:{type:'noul',noul:0.99}},usage:{input_tokens:376,output_tokens:56}}});
// Decision first: refund → a final agent; order_status → a final agent that may look up the order; uncertain → a clarifying agent.
const routed=key=>({...config({
  agents:[agent(`${key}.refund`),{...agent(`${key}.status`),actions:['lookup']},agent(`${key}.unsure`)],actions:[action('lookup',key)],
  steps:[{id:'triage',type:'decision',question:`fixture-key:${key} What does the Customer want?`,choices:CHOICES,min_probability:0.6},
    ...['refund','status','unsure'].map(id=>({id,type:'agent',agent:id,final:true})),handoff],
  links:[['triage','refund','refund'],['triage','order_status','status'],['triage','uncertain','unsure'],['triage','failure','support'],
    ...['refund','status','unsure'].map(id=>[id,'unsupported','support'])]}),decision:{engine:'jev'}});
const paths=b=>({preview:`/api/businesses/${b.id}/preview`,traces:`/api/businesses/${b.id}/traces`});
const traceOf=async(b,id,who=b.owner)=>(await who.request(`${paths(b).traces}/${id}`)).data;
// A trace without its timestamps, which tests check separately.
const untimed=turn=>({...turn,created_at:undefined,steps:turn.steps.map(({started_at,finished_at,...s})=>s),
  attempts:turn.attempts.map(({started_at,finished_at,...a})=>a)});
const timed=turn=>[...turn.steps,...turn.attempts].every(x=>x.started_at&&x.finished_at&&new Date(x.finished_at)>=new Date(x.started_at));
// The worker's value-free attestation that a provider payload held no credential of the Business and no provider key.
const checked={checked:true,credential_refs:['orders-key'],provider_keys:['deepseek','jev','qwen'],credential_exposed:false,provider_key_exposed:false};
const generation=(step_ordinal,step_id,extra={})=>({step_ordinal,step_id,kind:'provider',target:'deepseek/deepseek-flash',operation:'generation',status:'succeeded',
  error:null,fallback:false,served_model:'deepseek-flash',prompt_tokens:1000,completion_tokens:100,cost_usd:0.0007,payload_check:checked,...extra});
const jev={kind:'provider',target:'jev/jev-latest',operation:'decision',status:'succeeded',error:null,fallback:false,served_model:'jev-1.13.0',
  prompt_tokens:376,completion_tokens:56,cost_usd:0.00001579,payload_check:checked};
// An Owner preview conversation, driven through the Operator API.
async function preview(b) {
  const created=await b.owner.request(paths(b).preview,{});
  assert.equal(created.status,201,JSON.stringify(created.data));
  const id=created.data.conversation.id,path=`${paths(b).preview}/${id}`;
  return {id,conversation:created.data.conversation,read:async()=>(await b.owner.request(path)).data,
    ask:async text=>{
      const sent=await b.owner.request(path+'/messages',{client_submission_id:`preview-${crypto.randomUUID()}`,text});
      assert.equal(sent.status,202,JSON.stringify(sent.data));
      for(let i=0;i<200;i++) {
        const c=(await b.owner.request(path)).data;
        if(!['queued','running'].includes(c.messages.find(m=>m.id===sent.data.message.id).turn_state))
          return {message:sent.data.message,conversation:c,replies:c.messages.filter(m=>m.reply_to===sent.data.message.id)};
        await wait(250);
      }
      throw new Error('Preview turn did not settle');
    }};
}

test('browser: an Owner previews a version, follows its trace to the draft without changing it, and tells versions apart; Support sees none of it',async()=>{
  const b=await business('traces-browser',{owner});
  const key=`browser-${crypto.randomUUID()}`;
  // Version 2 (simulation): a condition, an intermediate agent, then a final agent. The draft drops the condition ("not in draft")
  // and reuses the intermediate agent's ID for a handoff ("changed in draft").
  const v2={...config({agents:[agent(`${key}.greet`),agent(`${key}.reply`)],steps:[{id:'route',type:'condition',field:'intent',equals:'human'},
    {id:'greet',type:'agent',agent:'greet',final:false},{id:'reply',type:'agent',agent:'reply',final:true},handoff],
    links:[['route','yes','support'],['route','fallback','greet'],['greet','next','reply'],['greet','unsupported','support'],['reply','unsupported','support']]}),
    generation:{mode:'simulation'}};
  await publish(b,v2);
  const draftDoc=structuredClone(v2);
  draftDoc.workflow.entry='reply';
  draftDoc.workflow.steps=draftDoc.workflow.steps.filter(s=>s.id!=='route').map(s=>s.id==='greet'?{id:'greet',type:'handoff',position:s.position}:s);
  draftDoc.workflow.connections=draftDoc.workflow.connections.filter(c=>!['route','greet'].includes(c.from));
  const path=`/api/businesses/${b.id}/configuration`,pretty=JSON.stringify(draftDoc,null,2);
  const saved=await owner.request(path,{text:pretty,revision:(await owner.request(path)).data.revision});
  assert.equal(saved.status,200);
  const unchanged=async text=>{const now=(await owner.request(path)).data;assert.deepEqual([now.revision,now.text],[saved.data.revision,text]);};
  assert.equal((await owner.request(`/api/businesses/${b.id}/invitations`,{email:support.email,role:'Support'})).status,201);
  assert.equal((await support.request('/api/invitations/accept',{token:await invitationToken(support.email)})).status,200);
  const browser=await chromium.launch();
  try {
    const page=await (await browser.newContext({viewport:{width:1440,height:980}})).newPage();
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    page.on('dialog',dialog=>{errors.push(`unexpected dialog: ${dialog.message()}`);dialog.dismiss();});
    await page.goto(base);
    await page.getByLabel('Email',{exact:true}).fill(owner.email);
    await page.getByLabel('Password',{exact:true}).fill(owner.password);
    await page.getByRole('button',{name:'Sign in',exact:true}).click();
    await page.getByRole('button',{name:'Manage traces-browser Business',exact:true}).click();
    await page.getByRole('region',{name:'Workflow canvas'}).waitFor();
    await page.getByRole('button',{name:'▷ Preview chat'}).click();
    const panel=page.getByRole('complementary',{name:'Preview chat'});
    await panel.getByRole('button',{name:'↻ New chat'}).click();
    await page.getByText('New preview chat pinned to published version 2 (simulation).',{exact:true}).waitFor();
    await panel.getByText('Simulation · version 2',{exact:true}).waitFor();
    await panel.getByLabel('Preview message').fill('Hello there');
    await panel.getByRole('button',{name:'Send',exact:true}).click();
    await panel.getByText('Execution trace · version 2 · simulation · 3 steps · completed',{exact:true}).waitFor();
    // Each reply names its pinned version and mode.
    await panel.locator('.msg.agent .msg-meta').filter({hasText:'Simulated assistant'}).getByText('Simulation · version 2').waitFor();
    const missing=panel.getByRole('button',{name:'Trace step 1: route (condition), not in draft'});
    const changed=panel.getByRole('button',{name:'Trace step 2: greet (agent), changed in draft'});
    const present=panel.getByRole('button',{name:'Trace step 3: reply (agent), locate'});
    await panel.getByText(/simulated: no AI model was called/).first().waitFor();
    await present.click();
    await page.locator('[data-step-id="reply"].selected').waitFor();
    await page.getByText(/^Located reply on the canvas\. This turn ran published version 2, not the draft, whose settings may differ\. Configuration unchanged\.$/).waitFor();
    await missing.click();
    await page.getByText('Step route ran in version 2 but is not in the current draft. Configuration unchanged.',{exact:true}).waitFor();
    await changed.click();
    await page.getByText('Step greet ran in version 2 as a step of type agent; the current draft has another type under that ID. Configuration unchanged.',{exact:true}).waitFor();
    assert.equal(await page.locator('.workflow-node.selected').getAttribute('data-step-id'),'reply');
    await unchanged(pretty);
    // JSON view: the step's ID is selected in the text (in the steps, not the agent with the same ID).
    await page.getByRole('button',{name:'JSON',exact:true}).click();
    const editor=page.getByLabel('Configuration JSON');
    await present.click();
    await page.getByText(/^Located reply in the draft JSON\. This turn ran published version 2/).waitFor();
    const selection=await editor.evaluate(e=>[e.value.slice(e.selectionStart,e.selectionEnd),e.selectionStart>e.value.indexOf('"steps"')]);
    assert.deepEqual(selection,['"id": "reply"',true]);
    assert.equal(await editor.inputValue(),pretty);
    await unchanged(pretty);
    // Invalid draft JSON: only a text search, said so, and the text stays exactly as saved.
    const invalid=pretty.replace('"final": true','"final": true,,');
    const broken=await owner.request(path,{text:invalid,revision:saved.data.revision});
    assert.equal(broken.status,200);
    saved.data.revision=broken.data.revision;
    await page.getByRole('button',{name:'Reload draft',exact:true}).click();
    await page.getByText('Latest draft loaded.',{exact:true}).waitFor();
    await present.click();
    await page.getByText(/^Located reply in the draft JSON by text search, because the draft JSON is invalid\. This turn ran published version 2/).waitFor();
    assert.equal(await editor.inputValue(),invalid);
    await unchanged(invalid);
    // A newer publication: the old conversation still reports version 2, and says version 3 is current.
    const earlier=(await owner.request(`/api/businesses/${b.id}/traces`)).data[0].id;
    await publish(b,draftDoc);
    await page.getByRole('button',{name:'Reload draft',exact:true}).click();
    await page.getByText('Latest draft loaded.',{exact:true}).waitFor();
    await panel.getByRole('button',{name:'↻ New chat'}).click();
    await panel.getByText('Simulation · version 3',{exact:true}).waitFor();
    await panel.getByText('Recent conversations').click();
    await panel.getByRole('button',{name:`Open trace ${earlier.slice(0,8)}`}).click();
    await panel.getByText(/pinned to published version 2 \(simulation\)\. Version 3 is published now; New chat uses it\./).waitFor();
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.deepEqual(errors,[]);
    // Support: the Business has no Manage, so no configuration, preview or trace view.
    const other=await (await browser.newContext({viewport:{width:1440,height:980}})).newPage();
    await other.goto(base);
    await other.getByLabel('Email',{exact:true}).fill(support.email);
    await other.getByLabel('Password',{exact:true}).fill(support.password);
    await other.getByRole('button',{name:'Sign in',exact:true}).click();
    await other.getByText('traces-browser Business — Support').waitFor();
    assert.equal(await other.getByRole('button',{name:'Manage traces-browser Business'}).count(),0);
    assert.equal(await other.getByRole('button',{name:'▷ Preview chat'}).isVisible(),false);
    // Another Business's Owner: this Business is not listed at all, so there is nothing to manage, preview or trace.
    const outsider=await (await browser.newContext({viewport:{width:1440,height:980}})).newPage();
    await outsider.goto(base);
    await outsider.getByLabel('Email',{exact:true}).fill(stranger.email);
    await outsider.getByLabel('Password',{exact:true}).fill(stranger.password);
    await outsider.getByRole('button',{name:'Sign in',exact:true}).click();
    await outsider.getByRole('heading',{name:'Your Businesses'}).waitFor();
    await outsider.getByLabel('Business name').waitFor();
    assert.equal(await outsider.getByText('traces-browser Business').count(),0);
  } finally {await browser.close();}
});

test('Preview: an Owner chats with the published version in simulation; each reply is labelled and traced; previews stay out of the inbox',async()=>{
  const b=await business('traces-preview',{owner});
  const chat=await preview(b);
  assert.deepEqual({...chat.conversation,id:undefined},{id:undefined,control_state:'automated',configuration_version:1,mode:'simulation',preview:true,messages:[]});
  const turn=await chat.ask('Hello there');
  assert.deepEqual(turn.replies.map(m=>[m.author,m.simulated]),[['assistant',true]]);
  assert.match(turn.replies[0].text,/^Simulated reply: no AI model generated this text/);
  const trace=await traceOf(b,chat.id);
  assert.deepEqual({...trace,turns:trace.turns.map(untimed)},{id:chat.id,preview:true,configuration_version:1,mode:'simulation',control_state:'automated',
    handoff_reason:null,published_at:trace.published_at,extractions:[],turns:[{message_id:turn.message.id,status:'completed',error:null,created_at:undefined,
      steps:[{ordinal:1,step_id:'reply',type:'agent',status:'succeeded',output:'reply',error:null,detail:{agent:'assistant',simulated:true}}],attempts:[]}]});
  assert(timed(trace.turns[0]));
  // Previews never reach the support inbox: not listed, and 404 by ID for detail, actions and memory.
  const inbox=`/api/businesses/${b.id}/inbox`;
  assert.equal((await owner.request(inbox)).data.conversations.some(c=>c.id===chat.id),false);
  assert.equal((await owner.request(`${inbox}/conversations/${chat.id}`)).status,404);
  assert.equal((await owner.request(`${inbox}/conversations/${chat.id}/claim`,{revision:'1'})).status,404);
  assert.equal((await owner.request(`${inbox}/conversations/${chat.id}/memory`)).status,404);
  // A retried submission returns the original message and runs no second turn.
  const path=`${paths(b).preview}/${chat.id}/messages`,body={client_submission_id:'preview-retry-1',text:'Once only'};
  const first=await owner.request(path,body),again=await owner.request(path,body);
  assert.deepEqual([first.status,again.status,again.data.message.id],[202,200,first.data.message.id]);
  assert.equal((await owner.request(path,{...body,text:'Different'})).status,409);

  // A later publication pins new previews; the earlier one keeps (and reports) version 1.
  const key=`preview-${crypto.randomUUID()}`;
  await publish(b,config({agents:[agent(`${key}.answer`)],steps:[{id:'answer',type:'agent',agent:'answer',final:true},handoff],links:[['answer','unsupported','support']]}));
  await script(`${key}.answer`,[reply({outcome:'reply',reply:'Connected preview reply.'})]);
  const later=await preview(b);
  assert.deepEqual([later.conversation.configuration_version,later.conversation.mode],[2,'connected']);
  const connected=await later.ask('Hello again');
  assert.deepEqual(connected.replies.map(m=>[m.text,m.simulated]),[['Connected preview reply.',false]]);
  const [laterTurn]=(await traceOf(b,later.id)).turns.map(untimed);
  assert.deepEqual(laterTurn.steps,[{ordinal:1,step_id:'answer',type:'agent',status:'succeeded',output:'reply',error:null,detail:{agent:'answer',citations:[]}}]);
  assert.deepEqual(laterTurn.attempts,[generation(1,'answer')]);
  assert.equal((await chat.read()).configuration_version,1);
  assert.equal((await traceOf(b,chat.id)).configuration_version,1);
  // The trace list shows both, each with its own version and mode, newest first.
  const listed=(await owner.request(paths(b).traces)).data;
  assert.deepEqual(listed.slice(0,2).map(c=>[c.id,c.preview,c.configuration_version,c.mode]),[[later.id,true,2,'connected'],[chat.id,true,1,'simulation']]);
  // A handoff in a preview pauses only that preview; nobody can claim it, and new turns wait.
  await script(`${key}.answer`,[reply({outcome:'unsupported'})]);
  const handed=await later.ask('I need a person');
  assert.equal(handed.conversation.control_state,'waiting-for-support');
  assert.equal((await owner.request(inbox)).data.conversations.some(c=>c.id===later.id),false);
});

test('Traces: a Customer turn shows its decision, lookup and generations with usage and cost, and nothing secret or valued',async()=>{
  const b=await business('traces-routed',{owner});
  await permit(b,'jev',true,'decision');
  const key=`routed-${crypto.randomUUID()}`;
  await publish(b,routed(key));
  await script(`${key}@jev`,[answer('order_status',{refund:0.1,order_status:0.9})]);
  await script(key,[owned({status:'shipped-on-SECRET-DAY'})]);
  await script(`${key}.status`,[reply({outcome:'action',action:'lookup',input:{order_id:'ORDER-777'}}),reply({outcome:'reply',reply:'It shipped.'})]);
  const customer=await start(b);
  const turn=await customer.ask('Where is my order ORDER-777?');
  assert.deepEqual(turn.replies.map(m=>m.text),['It shipped.']);
  const trace=await traceOf(b,customer.conversation.id);
  assert.deepEqual([trace.preview,trace.configuration_version,trace.mode],[false,2,'connected']);
  const [routedTurn]=trace.turns.map(untimed);
  assert.deepEqual(routedTurn,{message_id:turn.message.id,status:'completed',error:null,created_at:undefined,
    steps:[{ordinal:1,step_id:'triage',type:'decision',status:'succeeded',output:'order_status',error:null,detail:{choice:'order_status',probability:0.9}},
      {ordinal:2,step_id:'status',type:'agent',status:'succeeded',output:'reply',error:null,detail:{agent:'status',lookups:[{action:'lookup',fields:['status']}],citations:[]}}],
    attempts:[{...jev,step_ordinal:1,step_id:'triage'},generation(2,'status'),
      {step_ordinal:2,step_id:'status',kind:'http',target:'lookup',operation:null,status:'succeeded',error:null,fallback:false,served_model:null,
        prompt_tokens:null,completion_tokens:null,cost_usd:null,payload_check:null},generation(2,'status')]});
  assert(timed(trace.turns[0]));
  // Redaction: no credential, provider key, Customer identity, message, input, result value or reply text.
  const text=JSON.stringify(trace);
  for(const secret of [b.secret,'test-deepseek-key','test-typesafe-key',customer.subject,'ORDER-777','SECRET-DAY','It shipped','fixture-key'])
    assert.equal(text.includes(secret),false,secret);

  // Below the threshold: the uncertain route, with the choice that fell short and its probability.
  await script(`${key}@jev`,[answer('refund',{refund:0.55,order_status:0.45})]);
  await script(`${key}.unsure`,[reply({outcome:'reply',reply:'Could you tell me more?'})]);
  const unsure=await customer.ask('Something about my kettle.');
  const unsureSteps=(await traceOf(b,customer.conversation.id)).turns.find(t=>t.message_id===unsure.message.id).steps.map(({started_at,finished_at,...s})=>s);
  assert.deepEqual(unsureSteps[0],{ordinal:1,step_id:'triage',type:'decision',status:'succeeded',output:'uncertain',error:null,detail:{choice:'refund',probability:0.55}});
  // A rejected answer: the failure route with its reason, then the handoff step.
  await script(`${key}@jev`,[{raw:'not json'}]);
  const failed=await (await start(b)).ask('Refund please');
  const failedTrace=await traceOf(b,(await sql(`SELECT conversation_id FROM messages WHERE id='${failed.message.id}'`)));
  assert.deepEqual(failedTrace.turns[0].steps.map(({started_at,finished_at,...s})=>s),[
    {ordinal:1,step_id:'triage',type:'decision',status:'succeeded',output:'failure',error:null,detail:{reason:'malformed decision output'}},
    {ordinal:2,step_id:'support',type:'handoff',status:'succeeded',output:'handoff',error:null,detail:null}]);
  assert.equal(failedTrace.control_state,'waiting-for-support');
  // A stop inside a step: the step failed with the value-free reason, and so did the turn.
  await script(`${key}@jev`,[answer('refund',{refund:0.9,order_status:0.1})]);
  await script(`${key}.refund`,[{status:401,raw:'{}'}]);
  const stopped=await (await start(b)).ask('Refund please');
  const stoppedTrace=await traceOf(b,await sql(`SELECT conversation_id FROM messages WHERE id='${stopped.message.id}'`));
  const [stoppedTurn]=stoppedTrace.turns.map(untimed);
  assert.deepEqual([stoppedTurn.status,stoppedTurn.error],['failed','agent failed: status 401']);
  assert.deepEqual(stoppedTurn.steps.at(-1),{ordinal:2,step_id:'refund',type:'agent',status:'failed',output:null,error:'agent failed: status 401',detail:{agent:'refund'}});
  assert.deepEqual(stoppedTurn.attempts.at(-1),generation(2,'refund',{status:'failed',error:'status 401',served_model:null,prompt_tokens:null,completion_tokens:null,cost_usd:null}));
});

test('Traces: retrieval steps reference evidence by source, document and page, never by passage text',async()=>{
  const b=await business('traces-evidence',{owner});
  const key=`evidence-${crypto.randomUUID()}`;
  assert.equal((await upload(b,'faq','faq.txt',Buffer.from('Kettles carry a two-year warranty covering the heating element.'))).status,202);
  await active(b,'faq','faq.txt');
  await publish(b,config({sources:[{id:'faq',priority:1}],agents:[{...agent(`${key}.answer`),sources:['faq']}],
    steps:[{id:'retrieve',type:'retrieval',sources:['faq']},{id:'answer',type:'agent',agent:'answer',final:true},handoff],
    links:[['retrieve','next','answer'],['answer','unsupported','support']]}));
  await script(`${key}.answer`,[cite('Two years.','E1')]);
  const customer=await start(b);
  const turn=await customer.ask('How long is the warranty?');
  assert.deepEqual(turn.replies.map(m=>m.text),['Two years.']);
  const trace=await traceOf(b,customer.conversation.id);
  const steps=trace.turns[0].steps.map(({started_at,finished_at,...s})=>s);
  assert.deepEqual(steps.map(({ordinal,step_id,type,status,output,error})=>({ordinal,step_id,type,status,output,error})),[
    {ordinal:1,step_id:'retrieve',type:'retrieval',status:'succeeded',output:'next',error:null},
    {ordinal:2,step_id:'answer',type:'agent',status:'succeeded',output:'reply',error:null}]);
  const ref=steps[0].detail.evidence[0];
  assert.deepEqual({...ref,version_id:undefined},{source:'faq',document:'faq.txt',page:null,version_id:undefined,ordinal:0,
    content_sha256:'128e7dfdc68329c99aff8488574c6d0008c69bd67fd11793c2adb517d4b68886'});
  assert.match(ref.version_id,/^[0-9a-f-]{36}$/);
  assert.deepEqual(steps[1].detail,{agent:'answer',citations:[ref]});
  assert.equal(JSON.stringify(trace).includes('heating element'),false);
  assert.deepEqual(trace.extractions,[]);
});

test('Traces: Support, other Businesses, signed-out and cross-origin clients are denied; a demoted Owner loses access at once',async()=>{
  const b=await business('traces-access',{owner});
  const theirs=await business('traces-theirs',{owner:stranger});
  const chat=await preview(b),foreign=await preview(theirs);
  await chat.ask('Hello');
  assert.equal((await owner.request(`/api/businesses/${b.id}/invitations`,{email:support.email,role:'Support'})).status,201);
  assert.equal((await support.request('/api/invitations/accept',{token:await invitationToken(support.email)})).status,200);
  const routes=[[paths(b).traces],[`${paths(b).traces}/${chat.id}`],[`${paths(b).preview}/${chat.id}`],[paths(b).preview,{}],
    [`${paths(b).preview}/${chat.id}/messages`,{client_submission_id:'denied-message',text:'Hello'}]];
  for(const [path,body] of routes)assert.equal((await support.request(path,body)).status,404,`Support ${path}`);
  for(const [path,body] of routes)assert.equal((await stranger.request(path,body)).status,404,`other Owner ${path}`);
  // Another Business's conversation is not found through this Business, in either direction.
  assert.equal((await owner.request(`${paths(b).traces}/${foreign.id}`)).status,404);
  assert.equal((await owner.request(`${paths(b).preview}/${foreign.id}`)).status,404);
  assert.equal((await stranger.request(`${paths(theirs).traces}/${chat.id}`)).status,404);
  assert.equal((await stranger.request(`${paths(theirs).preview}/${chat.id}/messages`,{client_submission_id:'cross-business',text:'Hi'})).status,404);
  // A Customer conversation's trace is readable only by Owners.
  const customer=await start(b);
  assert.equal((await support.request(`${paths(b).traces}/${customer.conversation.id}`)).status,404);
  assert.equal((await owner.request(`${paths(b).traces}/${customer.conversation.id}`)).status,200);
  const anonymous=await fetch(`${base}${paths(b).traces}/${chat.id}`);
  assert.equal(anonymous.status,401);
  assert.equal((await owner.request(paths(b).preview,{},{headers:{origin:'https://evil.example'}})).status,403);
  assert.equal((await owner.request(paths(b).preview,{},{headers:{origin:null}})).status,403);
  // Demotion applies on the next request of the existing session.
  assert.equal((await owner.request(`/api/businesses/${b.id}/invitations`,{email:stranger.email,role:'Owner'})).status,201);
  assert.equal((await stranger.request('/api/invitations/accept',{token:await invitationToken(stranger.email)})).status,200);
  assert.equal((await stranger.request(`${paths(b).traces}/${chat.id}`)).status,200);
  const member=(await owner.request(`/api/businesses/${b.id}/memberships`)).data.find(m=>m.operator_id===stranger.id);
  assert.equal((await owner.request(`/api/businesses/${b.id}/memberships/${stranger.id}`,{role:'Support',active:true,revision:member.revision})).status,200);
  assert.equal((await stranger.request(`${paths(b).traces}/${chat.id}`)).status,404);
  assert.equal((await stranger.request(paths(b).preview,{})).status,404);
  // Calls stayed scoped: the denied submissions queued nothing.
  assert.equal(sql(`SELECT count(*) FROM messages WHERE client_submission_id IN ('denied-message','cross-business')`),'0');
});

test('Races: a preview created during a publication pins one whole version; a demotion during preview and trace requests leaves no partial access',async()=>{
  const b=await business('traces-races',{owner});
  const key=`race-${crypto.randomUUID()}`,path=`/api/businesses/${b.id}/configuration`;
  const doc=config({agents:[agent(`${key}.answer`)],steps:[{id:'answer',type:'agent',agent:'answer',final:true},handoff],links:[['answer','unsupported','support']]});
  const saved=await owner.request(path,{text:JSON.stringify(doc),revision:(await owner.request(path)).data.revision});
  await script(`${key}.answer`,[reply({outcome:'reply',reply:'Raced reply.'})]);
  const [published,created]=await together([{path:path+'/publish',body:{revision:saved.data.revision},headers:{cookie:owner.cookie}},
    {path:paths(b).preview,body:{},headers:{cookie:owner.cookie}}]);
  assert.deepEqual([published.status,created.status],[201,201]);
  const pinned=created.data.conversation;
  // Whichever won, the preview reports one version and its own mode, and runs exactly that version.
  assert.deepEqual([pinned.configuration_version,pinned.mode],pinned.configuration_version===1?[1,'simulation']:[2,'connected']);
  const id=pinned.id,sent=await owner.request(`${paths(b).preview}/${id}/messages`,{client_submission_id:'race-ask-1',text:'Hello'});
  assert.equal(sent.status,202);
  let trace;
  for(let i=0;i<120;i++){trace=await traceOf(b,id);if(trace.turns[0]?.status==='completed')break;await wait(250);}
  assert.equal(trace.configuration_version,pinned.configuration_version);
  assert.deepEqual(trace.turns[0].steps.map(s=>[s.step_id,s.detail]),pinned.configuration_version===1?[['reply',{agent:'assistant',simulated:true}]]:[['answer',{agent:'answer',citations:[]}]]);

  // A co-Owner is demoted while sending a preview message and reading a trace: each request is wholly before or after it.
  assert.equal((await owner.request(`/api/businesses/${b.id}/invitations`,{email:coowner.email,role:'Owner'})).status,201);
  assert.equal((await coowner.request('/api/invitations/accept',{token:await invitationToken(coowner.email)})).status,200);
  const member=(await owner.request(`/api/businesses/${b.id}/memberships`)).data.find(m=>m.operator_id===coowner.id);
  const demotedId=`race-demoted-${crypto.randomUUID()}`;
  const [demoted,message,read]=await together([
    {path:`/api/businesses/${b.id}/memberships/${coowner.id}`,body:{role:'Support',active:true,revision:member.revision},headers:{cookie:owner.cookie}},
    {path:`${paths(b).preview}/${id}/messages`,body:{client_submission_id:demotedId,text:'During demotion'},headers:{cookie:coowner.cookie}},
    {path:paths(b).preview,body:{},headers:{cookie:coowner.cookie}}]);
  assert.equal(demoted.status,200);
  assert(message.status===202||message.status===404,String(message.status));
  assert(read.status===201||read.status===404,String(read.status));
  assert.equal(sql(`SELECT count(*) FROM messages WHERE client_submission_id='${demotedId}' AND conversation_id='${id}'`),message.status===202?'1':'0');
  // Afterwards nothing is reachable.
  assert.equal((await coowner.request(`${paths(b).traces}/${id}`)).status,404);
  assert.equal((await coowner.request(paths(b).preview,{})).status,404);
});
