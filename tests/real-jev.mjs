// Real Jev integration run (#29), not part of npm test. Needs TYPESAFE_API_KEY and DEEPSEEK_API_KEY in .env and the connected,
// non-test stack: docker compose -f compose.yaml -f compose.connected.yaml up --build -d --wait --remove-orphans
// Usage: node tests/real-jev.mjs [model]. Drives only the public Operator and Customer APIs; prints no key values.
import { execFileSync } from 'node:child_process';
import { business, permit, publish, start } from './helpers.mjs';
const sql=query=>execFileSync('docker',['compose','exec','-T','db','psql','-U','custom_bot','-d','custom_bot','-tAc',query],{encoding:'utf8'}).trim();
const model=process.argv[2];
const final=(id,instructions)=>({id,name:id,instructions:`You work for Northwind Kettles, a small online kettle shop. ${instructions}`,
  model:{provider:'deepseek',name:'deepseek-flash',temperature:0.2,max_tokens:300}});
const doc={schema_version:1,generation:{mode:'connected'},decision:{engine:'jev',...(model?{model}:{})},
  agents:[final('refund','The Customer wants a refund, return or replacement. Ask for their order number and say support will review it within two days.'),
    final('status','The Customer asks where an order is. Ask for their order number so it can be looked up.'),
    final('other','Answer briefly and politely; you cannot look anything up.'),
    final('unsure','Ask one short question to find out what the Customer needs.')],actions:[],
  workflow:{entry:'triage',steps:[
    {id:'triage',type:'decision',question:'What does the Customer want, judging only by `customer_message`?',
      choices:{refund:'A refund, return or replacement for something they bought',order_status:'Where an order is or when it will arrive',other:'Anything else'},min_probability:0.6,position:{x:0,y:0}},
    ...['refund','status','other','unsure'].map((id,i)=>({id,type:'agent',agent:id,final:true,position:{x:300,y:i*200}})),
    {id:'support',type:'handoff',position:{x:600,y:0}}],
  connections:[{from:'triage',output:'refund',to:'refund'},{from:'triage',output:'order_status',to:'status'},{from:'triage',output:'other',to:'other'},
    {from:'triage',output:'uncertain',to:'unsure'},{from:'triage',output:'failure',to:'support'},
    ...['refund','status','other','unsure'].map(id=>({from:id,output:'unsupported',to:'support'}))]}};
const b=await business('real-jev');
await permit(b,'jev',true,'decision');
console.log('published version',await publish(b,doc));
const cases=[
  ['My kettle arrived with a cracked lid and I would like my money back.','refund'],
  ['Where is my order? It was supposed to arrive on Tuesday.','status'],
  ['Do you sell descaling tablets?','other'],
  ['Can I swap the blue kettle I ordered for the red one?','refund'],
  ['Hola, mi hervidor llegó roto y quiero un reembolso.','support'],
  ['hmm','unsure or support'],
];
for(const [text,expected] of cases) {
  const turn=await (await start(b)).ask(text);
  const rows=sql(`SELECT a.step_id||'|'||a.target||'|'||a.status||'|'||coalesce(a.error,'')||'|'||coalesce(a.served_model,'')||'|'||coalesce(a.prompt_tokens::text,'')||'/'||coalesce(a.completion_tokens::text,'')
    ||'|'||round(extract(epoch FROM a.finished_at-a.started_at)::numeric,2) FROM execution_attempts a JOIN jobs j ON j.id=a.job_id WHERE j.message_id='${turn.message.id}' ORDER BY a.id`);
  console.log(JSON.stringify({text,expected,state:turn.conversation.control_state,replies:turn.replies.map(m=>`${m.author}: ${m.text}`),attempts:rows.split('\n')},null,1));
}
// Revoked permission: nothing is sent.
await permit(b,'jev',false,'decision');
const denied=await (await start(b)).ask('My kettle arrived broken, refund please.');
console.log(JSON.stringify({revoked:true,state:denied.conversation.control_state,replies:denied.replies.length,
  attempts:sql(`SELECT a.target||'|'||a.status||'|'||a.error FROM execution_attempts a JOIN jobs j ON j.id=a.job_id WHERE j.message_id='${denied.message.id}'`)}));
console.log('business',b.id);
