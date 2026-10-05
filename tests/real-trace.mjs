// Real preview and trace run (#27), not part of npm test. Needs TYPESAFE_API_KEY and DEEPSEEK_API_KEY in .env and the connected,
// non-test stack: docker compose -f compose.yaml -f compose.connected.yaml up --build -d --wait --remove-orphans
// Usage: node tests/real-trace.mjs. Drives only the public Operator and Customer APIs; prints no key values.
import { readFileSync } from 'node:fs';
import { operator, permit, publish, start, wait, workflowSite } from './helpers.mjs';
const final=(id,instructions)=>({id,name:id,instructions:`You work for Northwind Kettles, a small online kettle shop. ${instructions}`,
  model:{provider:'deepseek',name:'deepseek-flash',temperature:0.2,max_tokens:1000}});
const doc={schema_version:1,generation:{mode:'connected'},decision:{engine:'jev'},
  agents:[final('refund','The Customer wants a refund, return or replacement. Ask for their order number and say support will review it within two days.'),
    final('status','The Customer asks where an order is. Ask for their order number so it can be looked up.'),
    final('unsure','Ask one short question to find out what the Customer needs.')],actions:[],
  workflow:{entry:'triage',steps:[
    {id:'triage',type:'decision',question:'What does the Customer want, judging only by `customer_message`?',
      choices:{refund:'A refund, return or replacement for something they bought',order_status:'Where an order is or when it will arrive'},min_probability:0.6,position:{x:0,y:0}},
    ...['refund','status','unsure'].map((id,i)=>({id,type:'agent',agent:id,final:true,position:{x:300,y:i*200}})),
    {id:'support',type:'handoff',position:{x:600,y:0}}],
  connections:[{from:'triage',output:'refund',to:'refund'},{from:'triage',output:'order_status',to:'status'},
    {from:'triage',output:'uncertain',to:'unsure'},{from:'triage',output:'failure',to:'support'},
    ...['refund','status','unsure'].map(id=>({from:id,output:'unsupported',to:'support'}))]}};
const owner=await operator('real-trace');
const b={owner,id:(await owner.request('/api/businesses',{name:'real-trace Business'})).data.id};
await owner.request(`/api/businesses/${b.id}/website-origins`,{origin:workflowSite,approved:true});
await permit(b,'deepseek',true);
await permit(b,'jev',true,'decision');
console.log('published version',await publish(b,doc));
const keys=readFileSync('.env','utf8').split('\n').filter(l=>/^(DEEPSEEK|TYPESAFE|DASHSCOPE)_API_KEY=./.test(l)).map(l=>l.split('=').slice(1).join('='));
const summary=trace=>({version:trace.configuration_version,mode:trace.mode,preview:trace.preview,secrets_found:keys.filter(k=>JSON.stringify(trace).includes(k)).length,
  turns:trace.turns.map(t=>({status:t.status,error:t.error,steps:t.steps.map(s=>`${s.ordinal}. ${s.step_id} ${s.type} ${s.status} → ${s.output} ${JSON.stringify(s.detail)} `+
    `${new Date(s.finished_at)-new Date(s.started_at)} ms`),attempts:t.attempts.map(a=>`[${a.step_ordinal}] ${a.target} ${a.operation} ${a.status}${a.error?` (${a.error})`:''} `+
    `served=${a.served_model} tokens=${a.prompt_tokens}/${a.completion_tokens} cost=${a.cost_usd} ${new Date(a.finished_at)-new Date(a.started_at)} ms`)}))});
// The Owner's preview chat.
const preview=(await owner.request(`/api/businesses/${b.id}/preview`,{})).data.conversation;
console.log('preview pinned',preview.configuration_version,preview.mode);
const path=`/api/businesses/${b.id}/preview/${preview.id}`;
for(const text of ['My kettle arrived with a cracked lid and I would like my money back.','Where is my order? It was supposed to arrive on Tuesday.']) {
  const sent=(await owner.request(path+'/messages',{client_submission_id:`real-${crypto.randomUUID()}`,text})).data.message;
  for(let i=0;i<240;i++){const c=(await owner.request(path)).data;if(!['queued','running'].includes(c.messages.find(m=>m.id===sent.id).turn_state)){
    console.log(JSON.stringify({text,replies:c.messages.filter(m=>m.reply_to===sent.id).map(m=>`${m.author}${m.simulated?' (simulated)':''}: ${m.text}`)}));break;}await wait(250);}
}
console.log(JSON.stringify(summary((await owner.request(`/api/businesses/${b.id}/traces/${preview.id}`)).data),null,1));
// A Customer conversation's trace, from the website chat.
const customer=await start(b,null);
const turn=await customer.ask('hmm');
console.log(JSON.stringify({text:'hmm',replies:turn.replies.map(m=>`${m.author}: ${m.text}`)}));
console.log(JSON.stringify(summary((await owner.request(`/api/businesses/${b.id}/traces/${customer.conversation.id}`)).data),null,1));
console.log('business',b.id);
