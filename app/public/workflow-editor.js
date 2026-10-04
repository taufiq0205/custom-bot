(()=>{
const $=selector=>document.querySelector(selector),
 root=$('#workflow-editor'),code=$('#config-text'),canvas=$('#workflow-canvas'),world=$('#workflow-world'),
 nodes=$('#workflow-nodes'),wires=$('#workflow-wires'),inspector=$('#config-inspector');
// A decision routes on each declared choice, then on its two safe routes (the server rejects choices with those names).
const ROUTES=['uncertain','failure'];
const OUTPUTS={retrieval:['next'],condition:['yes','fallback'],http:['success','failure'],agent:s=>s.final?['unsupported']:['next','unsupported'],handoff:[],
 decision:s=>[...Object.keys(s.choices&&typeof s.choices==='object'&&!Array.isArray(s.choices)?s.choices:{}).filter(c=>!ROUTES.includes(c)),...ROUTES]};
// Step colours follow the validated prototype.
const TYPES={retrieval:{label:'Knowledge',icon:'▤',color:'#0c7166',description:'Search assigned knowledge'},condition:{label:'Condition',icon:'⑂',color:'#8f5400',description:'Branch on a field'},http:{label:'API action',icon:'↗',color:'#3f47b5',description:'Read live business data'},agent:{label:'Agent',icon:'✦',color:'#6b39b8',description:'Generate a customer reply'},decision:{label:'Decision',icon:'◇',color:'#0b6aa2',description:'Route on a typed Jev choice'},handoff:{label:'Human takeover',icon:'☏',color:'#bf2f4b',description:'Pause and send to support'}};
const EDGE_KIND={next:'ok',yes:'ok',success:'ok',fallback:'alt',failure:'bad',unsupported:'bad',uncertain:'alt'};
const EDGE_TEXT={yes:'Yes',fallback:'Else',success:'Success',failure:'Failure',unsupported:'Unsupported',uncertain:'Uncertain'};
const GRID=20,clone=value=>JSON.parse(JSON.stringify(value));
let documentDraft=null,validation={json_valid:true,errors:[],blockers:[]},validatedText='',view='visual',selected=null,selectedEdge=null;
let camera={x:0,y:0,k:1},live={},metrics={},pending=null,pickerContext=null,deleteId=null,services={run:fn=>fn(),save:async()=>validation,loadPublished:async()=>null};
const stepOf=(doc,id)=>doc?.workflow?.steps?.find(step=>step.id===id);
const outputs=step=>typeof OUTPUTS[step.type]==='function'?OUTPUTS[step.type](step):OUTPUTS[step.type]||[];
const connections=doc=>doc?.workflow?.connections||[];
const connectionOf=(doc,from,output)=>connections(doc).find(edge=>edge.from===from&&edge.output===output);
const $status=message=>{const status=$('#status');if(status)status.textContent=message;};
const stepType=step=>TYPES[step.type]?.label||step.type;
const stepTitle=step=>step.type==='agent'?(documentDraft?.agents?.find(agent=>agent.id===step.agent)?.name||step.id):step.id.replace(/[_-]/g,' ').replace(/^./,c=>c.toUpperCase());
const outputLabel=(step,key)=>key==='yes'?`If ${step.field} = ${String(step.equals)}`:key==='next'?'Next':key==='fallback'?'Else':key==='success'?'Success':key==='failure'?'Failure':key==='unsupported'?'Unsupported':key==='uncertain'?'Uncertain':key;
const edgeKind=key=>EDGE_KIND[key]||'ok';
const position=(id)=>live[id]||stepOf(documentDraft,id)?.position||{x:0,y:0};
const svg=(name,attrs={})=>{const node=document.createElementNS('http://www.w3.org/2000/svg',name);for(const [key,value] of Object.entries(attrs))node.setAttribute(key,String(value));return node;};
const el=(name,attrs={},...children)=>{const node=document.createElement(name);for(const [key,value]of Object.entries(attrs)){if(key==='dataset')Object.assign(node.dataset,value);else if(key==='className')node.className=value;else if(key==='text')node.textContent=value;else if(key in node&&!key.startsWith('aria-'))node[key]=value;else node.setAttribute(key,String(value));}node.append(...children.flat().filter(child=>child!=null));return node;};
const focusKey=()=>document.activeElement?.dataset?.focusKey;

function localValidation(doc){
 const errors=[],blockers=[],ids=new Set(doc.workflow.steps.map(step=>step.id));
 const addError=(path,message)=>errors.push({path,message});
 if(doc.workflow.entry===null)blockers.push({path:'/workflow/entry',message:'Choose a start step'});
 else if(!ids.has(doc.workflow.entry))addError('/workflow/entry','Choose an existing step');
 doc.workflow.steps.forEach((step,index)=>{
  if(!Number.isFinite(step.position?.x))addError(`/workflow/steps/${index}/position/x`,'Position must be finite');
  if(!Number.isFinite(step.position?.y))addError(`/workflow/steps/${index}/position/y`,'Position must be finite');
  if(step.type==='retrieval'&&(!step.sources?.length||step.sources.some(id=>!doc.sources?.some(source=>source.id===id))))addError(`/workflow/steps/${index}/sources`,'Choose existing knowledge sources');
  if(step.type==='http'&&!doc.actions?.some(action=>action.id===step.action))addError(`/workflow/steps/${index}/action`,'Choose an existing action');
  if(step.type==='agent'&&!doc.agents?.some(agent=>agent.id===step.agent))addError(`/workflow/steps/${index}/agent`,'Choose an existing agent');
  for(const output of outputs(step)){
   const matches=connections(doc).filter(edge=>edge.from===step.id&&edge.output===output);
   if(matches.length!==1){blockers.push({path:`/workflow/steps/${index}`,message:`Output "${output}" of "${step.id}" is unconnected`});continue;}
   if(matches[0].to===null)blockers.push({path:`/workflow/connections/${connections(doc).indexOf(matches[0])}/to`,message:`Output "${output}" of "${step.id}" has no target`});
   else if(!ids.has(matches[0].to))addError(`/workflow/connections/${connections(doc).indexOf(matches[0])}/to`,'Choose an existing step');
  }
 });
 return {json_valid:true,errors,blockers};
}

function validationForCurrentText(){
 if(code.value!==validatedText){
  let parsed;try{parsed=JSON.parse(code.value);}catch(error){return {json_valid:false,errors:[{path:'',line:1,column:1,message:error.message}],blockers:[]};}
  try{const current=localValidation(parsed);return documentDraft||current.errors.length||current.blockers.length?current:validation;}
  catch{return {json_valid:true,errors:[{path:'',message:'Configuration shape is invalid. Save draft to see schema errors.'}],blockers:[]};}
 }
 return validation;
}
function renderIssues(){
 const current=validationForCurrentText(),list=$('#config-issues');
 const where=issue=>issue.line?`Line ${issue.line}, column ${issue.column}`:issue.path||'Document';
 list.replaceChildren(...current.errors.map(issue=>el('li',{text:`Error — ${where(issue)}: ${issue.message}`})),...current.blockers.map(issue=>el('li',{text:`Before publishing — ${where(issue)}: ${issue.message}`})));
 const hasErrors=current.errors.length>0||!current.json_valid;
 $('#json-error-box').hidden=!(view==='json'&&hasErrors);
 $('#json-errors').replaceChildren(...current.errors.map(issue=>el('li',{text:`${where(issue)}: ${issue.message}`})));
 $('#config-discard-invalid').hidden=!hasErrors;
 $('#json-go-error').hidden=!current.errors.some(issue=>issue.line&&issue.column);
 $('#config-publish').disabled=current.errors.length>0||current.blockers.length>0||!current.json_valid;
}
function renderGutter(){
 const lines=code.value.split('\n').length;
 $('#json-gutter').textContent=Array.from({length:lines},(_,i)=>i+1).join('\n');
}
function renderOutline(){
 const outline=$('#json-outline'),text=code.value,items=[];
 for(const match of text.matchAll(/^\s{2}"([^"\n]+)"\s*:/gm))if(!items.some(item=>item.name===match[1]))items.push({name:match[1],offset:match.index});
 for(const match of text.matchAll(/^\s{8}"id"\s*:\s*"([^"\n]+)"/gm))items.push({name:`Step · ${match[1]}`,offset:match.index});
 outline.replaceChildren(...items.map((item,index)=>el('button',{type:'button',text:item.name,dataset:{focusKey:`outline:${index}`},onclick:()=>jump(item.offset,item.name.length)})));
}
function jump(offset,length){if(offset==null)return;code.focus();code.setSelectionRange(offset,offset+length);const line=textBefore(offset).split('\n').length-1;code.scrollTop=Math.max(0,line*parseFloat(getComputedStyle(code).lineHeight)-80);$('#json-gutter').scrollTop=code.scrollTop;}
function textBefore(offset){return code.value.slice(0,offset);}
function errorOffset(){const issue=validationForCurrentText().errors[0];if(!issue?.line||!issue.column)return null;let offset=0;for(let line=1;line<issue.line;line++){const end=code.value.indexOf('\n',offset);if(end<0)return null;offset=end+1;}return offset+issue.column-1;}

function render(){
 const active=focusKey();
 root.hidden=!documentDraft&&!code.value;
 $('#workflow-view').hidden=view!=='visual'||!documentDraft;
 $('#json-view').hidden=view!=='json'||root.hidden;
 $('#workflow-tab').setAttribute('aria-pressed',String(view==='visual'));
 $('#json-tab').setAttribute('aria-pressed',String(view==='json'));
 if(document.activeElement!==code&&view==='json'&&documentDraft)code.value=JSON.stringify(documentDraft,null,2);
 renderIssues();renderGutter();renderOutline();
 if(view==='visual'&&documentDraft){renderInspector();drawGraph();}
 if(active)document.querySelector(`[data-focus-key="${CSS.escape(active)}"]`)?.focus({preventScroll:true});
}
function setLocalDocument(next,message){
 documentDraft=next;code.value=JSON.stringify(documentDraft,null,2);validation=localValidation(documentDraft);render();
 if(message)$status(message);
}
function edit(mutator,message){if(!documentDraft)return;const next=clone(documentDraft);mutator(next);setLocalDocument(next,message);}
function setConnection(doc,from,output,to){
 const existing=doc.workflow.connections.find(edge=>edge.from===from&&edge.output===output);
 if(existing)existing.to=to;else doc.workflow.connections.push({from,output,to});
}
function normalizedOutputs(doc,step){
 const supported=outputs(step);doc.workflow.connections=doc.workflow.connections.filter(edge=>edge.from!==step.id||supported.includes(edge.output));
 for(const output of supported)if(!connectionOf(doc,step.id,output))doc.workflow.connections.push({from:step.id,output,to:null});
}

function renderInspector(){
 const step=stepOf(documentDraft,selected);inspector.hidden=!step;
 if(!step)return;
 $('#inspector-kind').textContent=stepType(step);$('#inspector-name').textContent=stepTitle(step);$('#inspector-step-id').value=step.id;
 const entry=$('#inspector-entry');entry.replaceChildren();
 if(documentDraft.workflow.entry===step.id)entry.append(el('span',{className:'entry-badge',text:'START · conversations begin here'}));
 else entry.append(el('button',{type:'button',text:'Make this the start step',onclick:()=>edit(doc=>{doc.workflow.entry=step.id;},`${step.id} is now the start step.`)}));
 const fields=$('#inspector-fields');fields.replaceChildren();
 if(step.type==='retrieval'){
  const input=el('input',{id:'retrieval-sources',value:(step.sources||[]).join(', '),dataset:{focusKey:'field:sources'}});
  input.addEventListener('change',()=>edit(doc=>{stepOf(doc,step.id).sources=input.value.split(',').map(v=>v.trim()).filter(Boolean);},'Knowledge sources updated.'));
  fields.append(labeled('Knowledge source IDs (comma-separated)',input));
 }
 if(step.type==='condition'){
  const field=el('input',{id:'condition-field',value:step.field||'',dataset:{focusKey:'field:condition'}});
  field.addEventListener('change',()=>edit(doc=>{stepOf(doc,step.id).field=field.value;},'Condition field updated.'));
  const equals=el('input',{id:'condition-equals',value:String(step.equals??''),dataset:{focusKey:'field:equals'}});
  equals.addEventListener('change',()=>{let value=equals.value;try{value=JSON.parse(value);}catch{}if(!['string','boolean'].includes(typeof value)&&!(typeof value==='number'&&Number.isFinite(value)))value=equals.value;edit(doc=>{stepOf(doc,step.id).equals=value;},'Condition value updated.');});
  fields.append(labeled('Field',field),labeled('Equals',equals));
 }
 if(step.type==='http'){
  const select=el('select',{id:'http-action',dataset:{focusKey:'field:action'}},el('option',{value:'',text:'Choose an action'}),...(documentDraft.actions||[]).map(action=>el('option',{value:action.id,text:action.id})));
  select.value=step.action||'';select.addEventListener('change',()=>edit(doc=>{stepOf(doc,step.id).action=select.value;},'API action updated.'));
  fields.append(labeled('API action',select));
  const action=documentDraft.actions?.find(item=>item.id===step.action);
  if(action){const url=el('input',{id:'action-url',type:'url',maxlength:2000,value:action.url,dataset:{focusKey:'field:action-url'}});url.addEventListener('change',()=>edit(doc=>{const item=doc.actions.find(item=>item.id===step.action);if(item)item.url=url.value;},'API endpoint updated.'));fields.append(labeled('HTTPS endpoint',url),el('p',{className:'inspector-note',text:`Credential reference: ${action.credential} · authorization policy: ${action.authorization}. Secrets stay hidden.`}));}
 }
 if(step.type==='agent'){
  const select=el('select',{id:'agent-reference',dataset:{focusKey:'field:agent'}},el('option',{value:'',text:'Choose an agent'}),...(documentDraft.agents||[]).map(agent=>el('option',{value:agent.id,text:`${agent.name} · ${agent.id}`})));
  select.value=step.agent||'';select.addEventListener('change',()=>edit(doc=>{stepOf(doc,step.id).agent=select.value;},'Agent updated.'));
  const final=el('input',{id:'agent-final',type:'checkbox',checked:step.final===true,dataset:{focusKey:'field:final'}});final.style.width='auto';
  final.addEventListener('change',()=>edit(doc=>{const node=stepOf(doc,step.id);node.final=final.checked;normalizedOutputs(doc,node);},'Agent output mode updated.'));
  const agent=documentDraft.agents?.find(item=>item.id===step.agent);
  fields.append(labeled('Agent',select),labeled('Final customer reply',final));
  if(agent){const name=el('input',{id:'agent-name',maxlength:120,value:agent.name,dataset:{focusKey:'field:agent-name'}});name.addEventListener('change',()=>edit(doc=>{const item=doc.agents.find(item=>item.id===step.agent);if(item)item.name=name.value;},'Agent name updated.'));
   const instructions=el('textarea',{id:'agent-instructions',maxlength:20000,value:agent.instructions,dataset:{focusKey:'field:agent-instructions'}});instructions.rows=5;instructions.addEventListener('change',()=>edit(doc=>{const item=doc.agents.find(item=>item.id===step.agent);if(item)item.instructions=instructions.value;},'Agent instructions updated.'));
   fields.append(labeled('Agent name',name),labeled('Instructions',instructions));}
 }
 if(step.type==='decision'){
  const question=el('textarea',{id:'decision-question',maxlength:2000,value:step.question||'',dataset:{focusKey:'field:decision-question'}});question.rows=3;
  question.addEventListener('change',()=>edit(doc=>{stepOf(doc,step.id).question=question.value;},'Decision question updated.'));
  // One choice per line, "name: description"; changing the names adds or removes their connections.
  const choices=el('textarea',{id:'decision-choices',value:Object.entries(step.choices||{}).map(([name,text])=>`${name}: ${text}`).join('\n'),dataset:{focusKey:'field:decision-choices'}});choices.rows=4;
  choices.addEventListener('change',()=>edit(doc=>{const node=stepOf(doc,step.id);
   node.choices=Object.fromEntries(choices.value.split('\n').filter(line=>line.trim()).map(line=>{const at=line.indexOf(':');return at<0?[line.trim(),'']:[line.slice(0,at).trim(),line.slice(at+1).trim()];}));
   normalizedOutputs(doc,node);},'Decision choices updated.'));
  const threshold=el('input',{id:'decision-threshold',type:'number',min:0,max:1,step:0.05,value:String(step.min_probability??''),dataset:{focusKey:'field:decision-threshold'}});
  threshold.addEventListener('change',()=>edit(doc=>{stepOf(doc,step.id).min_probability=Number(threshold.value);},'Decision threshold updated.'));
  const engine=documentDraft.decision;
  fields.append(labeled('Question',question),labeled('Choices (one per line, name: description)',choices),labeled('Minimum probability of the chosen option',threshold),
   el('p',{className:'inspector-note',text:`${engine?`Engine: ${engine.engine}/${engine.model||(engine.engine==='jev'?'jev-latest':'default')}.`:'No decision engine selected.'} Only the choice name picks the route; it never writes the reply or authorizes an action.`}));
 }
 if(step.type==='handoff')fields.append(el('p',{className:'inspector-note',text:'Pauses automation and places the conversation in the support queue.'}));
 const links=$('#inspector-connections');links.replaceChildren(el('h5',{text:'Connections'}));
 for(const output of outputs(step)){
  const link=connectionOf(documentDraft,step.id,output),select=el('select',{id:`connection-${step.id}-${output}`,dataset:{focusKey:`connection:${step.id}:${output}`},'aria-label':`${outputLabel(step,output)} connection from ${step.id}`},el('option',{value:'',text:'— Unconnected —'}),...documentDraft.workflow.steps.filter(target=>target.id!==step.id).map(target=>el('option',{value:target.id,text:`${stepTitle(target)} · ${target.id}`})));
  select.value=link?.to||'';select.addEventListener('change',()=>edit(doc=>setConnection(doc,step.id,output,select.value||null),select.value?`${step.id} · ${outputLabel(step,output)} connected.`:`${step.id} · ${outputLabel(step,output)} is unconnected.`));
  select.addEventListener('keydown',event=>{const delta=event.key==='ArrowDown'?1:event.key==='ArrowUp'?-1:0;if(!delta)return;event.preventDefault();select.selectedIndex=Math.max(0,Math.min(select.options.length-1,select.selectedIndex+delta));select.dispatchEvent(new Event('change',{bubbles:true}));});
  links.append(labeled(outputLabel(step,output),select));
 }
 $('#delete-step').disabled=documentDraft.workflow.steps.length<=1;
}
function labeled(label,control){const id=control.id;return el('div',{className:'inspector-field'},el('label',{htmlFor:id,text:label}),control);}

function nodeDetail(step){
 if(step.type==='retrieval')return `Sources · ${(step.sources||[]).join(', ')||'none selected'}`;
 if(step.type==='condition')return `${step.field||'field'} = ${String(step.equals??'')}`;
 if(step.type==='http')return `GET · ${step.action||'action not selected'}`;
 if(step.type==='agent')return documentDraft.agents?.find(agent=>agent.id===step.agent)?.name||`Agent · ${step.agent||'not selected'}`;
 if(step.type==='decision')return `Choices · ${Object.keys(step.choices||{}).join(', ')||'none'}`;
 return 'Pauses automation';
}
function nodeElement(step){
 const type=TYPES[step.type]||TYPES.handoff,entry=documentDraft.workflow.entry===step.id;
 const node=el('article',{className:`workflow-node${selected===step.id?' selected':''}`,tabIndex:0,role:'group',dataset:{stepId:step.id,stepType:step.type,focusKey:`node:${step.id}`},'aria-label':`${type.label} step ${step.id}${entry?', start step':''}. Arrow keys move; Enter opens settings; Delete opens safe delete.`,style:`left:${position(step.id).x}px;top:${position(step.id).y}px;--node-color:${type.color}`});
 node.append(el('span',{className:'node-input-port','aria-hidden':'true'}));
 const head=el('div',{className:'node-heading'},el('span',{className:'node-icon',text:type.icon}),el('div',{},el('div',{className:'node-kind',text:type.label}),el('div',{className:'node-title',text:stepTitle(step)})));
 if(entry)head.append(el('span',{className:'entry-badge',text:'START'}));
 node.append(head,el('div',{className:'node-detail',text:nodeDetail(step)}));
 const outs=el('div',{className:'node-outputs'});
 for(const output of outputs(step)){
  const target=connectionOf(documentDraft,step.id,output)?.to??null;
  const row=el('div',{className:`node-output${target===null?' unconnected':''}`},el('span',{text:`${target===null?'Unconnected · ':''}${outputLabel(step,output)}`}));
  row.append(el('button',{type:'button',className:'output-port',title:'Drag to connect or click to insert a step',dataset:{output,from:step.id},'aria-label':`Connect ${step.id} ${outputLabel(step,output)}`,style:`--port-color:${target===null?'var(--rose)':`var(--${edgeKind(output)==='ok'?'teal':edgeKind(output)==='bad'?'rose':'muted'})`}`}));
  outs.append(row);
 }
 node.append(outs);
 node.addEventListener('click',event=>{if(!event.target.closest('.output-port'))select(step.id);});
 node.addEventListener('keydown',event=>{
  if(event.target!==node)return;
  if(event.key==='Enter'||event.key===' '){event.preventDefault();select(step.id);return;}
  if(event.key==='Delete'||event.key==='Backspace'){event.preventDefault();askDelete(step.id);return;}
  if(event.key==='Escape'){selected=null;selectedEdge=null;render();return;}
  const delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];if(!delta)return;
  event.preventDefault();const amount=event.shiftKey?100:GRID;edit(doc=>{const p=stepOf(doc,step.id).position;p.x+=delta[0]*amount;p.y+=delta[1]*amount;},`Moved ${step.id} with the keyboard.`);ensureVisible(step.id);
 });
 node.addEventListener('pointerdown',event=>{
  if(event.button!==0||event.target.closest('button'))return;
  event.stopPropagation();node.setPointerCapture(event.pointerId);
  const startX=event.clientX,startY=event.clientY,start=position(step.id);let moved=false;
  const move=ev=>{
   const dx=(ev.clientX-startX)/camera.k,dy=(ev.clientY-startY)/camera.k;if(!moved&&Math.hypot(dx,dy)<3)return;
   moved=true;node.classList.add('dragging');const next={x:ev.altKey?Math.round(start.x+dx):Math.round((start.x+dx)/GRID)*GRID,y:ev.altKey?Math.round(start.y+dy):Math.round((start.y+dy)/GRID)*GRID};live[step.id]=next;
   node.style.left=`${next.x}px`;node.style.top=`${next.y}px`;drawWires();drawMinimap();
  };
  const finish=ev=>{
   node.removeEventListener('pointermove',move);node.removeEventListener('pointerup',finish);node.removeEventListener('pointercancel',finish);
   if(!moved)return;const next=live[step.id];delete live[step.id];
   if(ev.type==='pointercancel'){node.classList.remove('dragging');node.style.left=`${start.x}px`;node.style.top=`${start.y}px`;drawWires();drawMinimap();$status('Move cancelled; the position is unchanged.');return;}
   selected=step.id;selectedEdge=null;edit(doc=>{stepOf(doc,step.id).position=next;},`Moved ${step.id}.`);
  };
  node.addEventListener('pointermove',move);node.addEventListener('pointerup',finish);node.addEventListener('pointercancel',finish);
 });
 node.querySelector('.output-port')?.closest('.node-outputs')?.querySelectorAll('.output-port').forEach(port=>wirePort(port,step));
 return node;
}
function wirePort(port,step){
 port.addEventListener('pointerdown',event=>{
  if(event.button!==0)return;event.stopPropagation();event.preventDefault();port.setPointerCapture(event.pointerId);
  const startX=event.clientX,startY=event.clientY,key=port.dataset.output;let moved=false,target=null;
  const move=ev=>{
   if(!moved&&Math.hypot(ev.clientX-startX,ev.clientY-startY)<4)return;moved=true;
   const point=toWorld(ev.clientX,ev.clientY);pending={from:step.id,output:key,...point};
   const hit=document.elementFromPoint(ev.clientX,ev.clientY)?.closest('.workflow-node'),next=hit&&hit.dataset.stepId!==step.id?hit.dataset.stepId:null;
   if(next!==target){document.querySelector('.workflow-node.drop-target')?.classList.remove('drop-target');target=next;if(next)hit.classList.add('drop-target');}
   drawWires();
  };
  const finish=ev=>{
   port.removeEventListener('pointermove',move);port.removeEventListener('pointerup',finish);port.removeEventListener('pointercancel',finish);
   const point=pending;pending=null;document.querySelector('.workflow-node.drop-target')?.classList.remove('drop-target');
   if(ev.type==='pointercancel'){drawWires();return;}
   if(!moved){openPicker({from:step.id,output:key,carry:true});return;}
   if(target){selectedEdge=null;edit(doc=>setConnection(doc,step.id,key,target),`Connected ${step.id} · ${outputLabel(step,key)} → ${target}.`);return;}
   drawWires();if(document.elementFromPoint(ev.clientX,ev.clientY)?.closest('#workflow-canvas'))openPicker({from:step.id,output:key,position:{x:point.x,y:point.y-20},carry:false});
  };
  port.addEventListener('pointermove',move);port.addEventListener('pointerup',finish);port.addEventListener('pointercancel',finish);
 });
}
function drawGraph(){
 if(!documentDraft)return;live={};nodes.replaceChildren(...documentDraft.workflow.steps.map(nodeElement));metrics={};
 // Port centres from layout offsets relative to their node, so camera transforms and transitions cannot skew them.
 const centre=(element,node)=>{let x=node.clientLeft+element.offsetWidth/2,y=node.clientTop+element.offsetHeight/2;for(let at=element;at&&at!==node;at=at.offsetParent){x+=at.offsetLeft;y+=at.offsetTop;}return {x,y};};
 for(const node of nodes.children){
  metrics[node.dataset.stepId]={input:centre(node.querySelector('.node-input-port'),node),outputs:{},size:{w:node.offsetWidth,h:node.offsetHeight}};
  for(const port of node.querySelectorAll('.output-port'))metrics[node.dataset.stepId].outputs[port.dataset.output]=centre(port,node);
 }
 drawWires();applyCamera();
}
function curve(a,b){const dx=Math.max(48,Math.abs(b.x-a.x)/2);return `M${a.x} ${a.y} C${a.x+dx} ${a.y}, ${b.x-dx} ${b.y}, ${b.x} ${b.y}`;}
function drawWires(){
 if(!documentDraft)return;wires.replaceChildren();
 for(const step of documentDraft.workflow.steps)for(const output of outputs(step)){
  const connection=connectionOf(documentDraft,step.id,output),target=connection?.to;
  if(!target||!metrics[step.id]?.outputs[output]||!metrics[target]?.input)continue;
  const a={x:position(step.id).x+metrics[step.id].outputs[output].x,y:position(step.id).y+metrics[step.id].outputs[output].y},b={x:position(target).x+metrics[target].input.x,y:position(target).y+metrics[target].input.y},d=curve(a,b),mid={x:(a.x+b.x)/2,y:(a.y+b.y)/2},kind=edgeKind(output),selectedLink=selectedEdge?.from===step.id&&selectedEdge.output===output;
  wires.append(svg('path',{d,class:`workflow-edge ${kind}${selectedLink?' selected':''}`, 'data-from':step.id,'data-output':output,'data-to':target}));
  const hit=svg('path',{d,class:'workflow-edge-hit','data-from':step.id,'data-output':output});hit.addEventListener('click',event=>{event.stopPropagation();selectedEdge={from:step.id,output};selected=null;render();$status(`Selected ${step.id} · ${outputLabel(step,output)}. Press Delete or choose Disconnect selected link.`);});wires.append(hit);
  if(EDGE_TEXT[output]){const label=svg('text',{x:mid.x,y:mid.y-4,class:`workflow-edge-label ${kind}`,'text-anchor':'middle'});label.textContent=EDGE_TEXT[output];wires.append(label);}
 }
 if(pending&&metrics[pending.from]?.outputs[pending.output]){const a={x:position(pending.from).x+metrics[pending.from].outputs[pending.output].x,y:position(pending.from).y+metrics[pending.from].outputs[pending.output].y};wires.append(svg('path',{d:curve(a,pending),class:'workflow-edge pending'}));}
 $('#disconnect-edge').hidden=!selectedEdge;
}
function applyCamera(){
 world.style.transform=`translate(${camera.x}px,${camera.y}px) scale(${camera.k})`;
 const grid=GRID*camera.k;canvas.style.backgroundSize=`${grid}px ${grid}px`;canvas.style.backgroundPosition=`${camera.x}px ${camera.y}px`;
 $('#workflow-zoom').textContent=`${Math.round(camera.k*100)}%`;drawMinimap();
}
function toWorld(clientX,clientY){const rect=canvas.getBoundingClientRect();return {x:(clientX-rect.left-camera.x)/camera.k,y:(clientY-rect.top-camera.y)/camera.k};}
function bounds(){let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity;for(const step of documentDraft.workflow.steps){const p=position(step.id),size=metrics[step.id]?.size||{w:244,h:150};left=Math.min(left,p.x);top=Math.min(top,p.y);right=Math.max(right,p.x+size.w);bottom=Math.max(bottom,p.y+size.h);}return {x:left,y:top,w:Math.max(1,right-left),h:Math.max(1,bottom-top)};}
function usable(){const rect=canvas.getBoundingClientRect(),panel=inspector.getBoundingClientRect();if(!inspector.hidden&&window.matchMedia('(max-width: 720px)').matches)return {w:rect.width,h:Math.max(180,panel.top-rect.top-12)};if(!inspector.hidden&&panel.left>rect.left+rect.width/2)return {w:panel.left-rect.left-20,h:rect.height};return {w:rect.width,h:rect.height};}
function fitView(){if(!documentDraft)return;const rect=canvas.getBoundingClientRect(),area=usable(),graph=bounds(),padding=64;if(!rect.width)return;camera.k=Math.max(.35,Math.min(1,(area.w-padding*2)/graph.w,(area.h-padding*2)/graph.h));camera.x=(area.w-graph.w*camera.k)/2-graph.x*camera.k;camera.y=(area.h-graph.h*camera.k)/2-graph.y*camera.k;applyCamera();}
function centerOn(id){const step=stepOf(documentDraft,id);if(!step)return;const area=usable(),size=metrics[id]?.size||{w:244,h:150};camera.x=area.w/2-(step.position.x+size.w/2)*camera.k;camera.y=area.h/2-(step.position.y+size.h/2)*camera.k;applyCamera();}
function ensureVisible(id){const node=nodes.querySelector(`[data-step-id="${CSS.escape(id)}"]`);if(!node)return;const rect=node.getBoundingClientRect(),view=canvas.getBoundingClientRect(),area=usable();if(rect.left<view.left||rect.top<view.top||rect.right>view.left+area.w||rect.bottom>view.top+area.h)centerOn(id);}
function zoomAt(factor,clientX,clientY){const rect=canvas.getBoundingClientRect(),x=clientX==null?rect.width/2:clientX-rect.left,y=clientY==null?rect.height/2:clientY-rect.top,next=Math.max(.25,Math.min(2,camera.k*factor));camera.x=x-(x-camera.x)*next/camera.k;camera.y=y-(y-camera.y)*next/camera.k;camera.k=next;applyCamera();drawWires();}
function drawMinimap(){
 const map=$('#workflow-minimap');if(!documentDraft||map.hidden)return;map.replaceChildren(svg('title',{},));const box={w:184,h:112},graph=bounds(),scale=Math.min((box.w-18)/graph.w,(box.h-18)/graph.h),offset={x:(box.w-graph.w*scale)/2-graph.x*scale,y:(box.h-graph.h*scale)/2-graph.y*scale};
 for(const step of documentDraft.workflow.steps){const p=position(step.id),size=metrics[step.id]?.size||{w:244,h:150};map.append(svg('rect',{x:offset.x+p.x*scale,y:offset.y+p.y*scale,width:Math.max(3,size.w*scale),height:Math.max(3,size.h*scale),rx:2,class:'map-node',fill:(TYPES[step.type]||TYPES.handoff).color}));}
 const visible=usable(),rect=canvas.getBoundingClientRect(),worldLeft=-camera.x/camera.k,worldTop=-camera.y/camera.k;
 map.append(svg('rect',{x:offset.x+worldLeft*scale,y:offset.y+worldTop*scale,width:visible.w/camera.k*scale,height:visible.h/camera.k*scale,class:'map-viewport'}));
 map._map={scale,offset,rect:map.getBoundingClientRect()};
}
function panFromMap(event){const map=$('#workflow-minimap'),state=map._map;if(!state)return;const worldX=(event.clientX-state.rect.left-state.offset.x)/state.scale,worldY=(event.clientY-state.rect.top-state.offset.y)/state.scale,area=usable();camera.x=area.w/2-worldX*camera.k;camera.y=area.h/2-worldY*camera.k;applyCamera();drawWires();}

function select(id){selected=id;selectedEdge=null;render();ensureVisible(id);}
function disconnect(){if(!selectedEdge)return;const link={...selectedEdge};selectedEdge=null;edit(doc=>setConnection(doc,link.from,link.output,null),`Disconnected ${link.from} · ${outputLabel(stepOf(documentDraft,link.from),link.output)}. Connect it before publishing.`);}
function typeRows(){
 const list=$('#step-picker-options');if(list.childElementCount)return;
 for(const [type,info]of Object.entries(TYPES)){const button=el('button',{type:'button',dataset:{type,search:`${type} ${info.label} ${info.description}`.toLowerCase()},onclick:()=>{const ctx=pickerContext;$('#step-picker').close();addStep(type,ctx);}},el('span',{className:'node-icon',text:info.icon}),el('span',{text:`${info.label} · ${info.description}`}));list.append(button);}
}
function openPicker(context=null){if(!documentDraft||$('#step-picker').open)return;pickerContext=context;typeRows();const search=$('#step-picker-search');search.value='';$('#step-picker-options').querySelectorAll('button').forEach(button=>button.hidden=false);$('#step-picker').showModal();search.focus();}
function addStep(type,context){
 let index=1,id;do{id=`${type}_${index++}`;}while(stepOf(documentDraft,id));
 const steps=documentDraft.workflow.steps,anchor=context?.from?stepOf(documentDraft,context.from):null,oldTarget=context?.carry?connectionOf(documentDraft,context.from,context.output)?.to:null;
 let p=context?.position?{x:Math.round(context.position.x/GRID)*GRID,y:Math.round(context.position.y/GRID)*GRID}:anchor?{x:anchor.position.x+300,y:anchor.position.y}:toWorld(canvas.getBoundingClientRect().left+canvas.clientWidth/2,canvas.getBoundingClientRect().top+canvas.clientHeight/2);
 const size={w:244,h:160};
 if(!context?.position)while(steps.some(step=>{const q=step.position;return p.x<q.x+260&&p.x+size.w>q.x&&p.y<q.y+170&&p.y+size.h>q.y;}))p.y+=180;
 const step={id,type,position:p};
 if(type==='retrieval')step.sources=documentDraft.sources?.[0]?[documentDraft.sources[0].id]:[];
 if(type==='condition'){step.field='intent';step.equals='value';}
 if(type==='http')step.action=documentDraft.actions?.[0]?.id||'';
 if(type==='agent'){step.agent=documentDraft.agents?.[0]?.id||'';step.final=true;}
 if(type==='decision'){step.question='What does the Customer want?';step.choices={refund:'A refund, return or replacement',other:'Anything else'};step.min_probability=0.6;}
 const next=clone(documentDraft);next.workflow.steps.push(step);
 // Decision steps share one engine; Jev unless another is already selected.
 if(type==='decision')next.decision??={engine:'jev'};
 for(const output of outputs(step))next.workflow.connections.push({from:id,output,to:null});
 if(context?.from){setConnection(next,context.from,context.output,id);const first=outputs(step)[0];if(context.carry&&first&&oldTarget)setConnection(next,id,first,oldTarget);}
 selected=id;selectedEdge=null;setLocalDocument(next,`${stepType(step)} step ${id} added.`);requestAnimationFrame(()=>{centerOn(id);ensureVisible(id);});
}
function askDelete(id){
 const step=stepOf(documentDraft,id);if(!step||documentDraft.workflow.steps.length<=1)return;deleteId=id;
 const incoming=connections(documentDraft).filter(edge=>edge.to===id),outgoing=connections(documentDraft).filter(edge=>edge.from===id&&edge.to!==null),isEntry=documentDraft.workflow.entry===id,list=$('#step-delete-links');
 list.replaceChildren(...(isEntry?[el('li',{text:'Start step · workflow entry will be cleared'})]:[]),...incoming.map(edge=>el('li',{text:`${edge.from} · ${outputLabel(stepOf(documentDraft,edge.from),edge.output)} → ${id} (will become unconnected)`})),...outgoing.map(edge=>el('li',{text:`${id} · ${outputLabel(step,edge.output)} → ${edge.to} (removed with step)`})));
 $('#step-delete-summary').textContent=`Delete ${id}? ${incoming.length+(isEntry?1:0)} incoming reference${incoming.length+(isEntry?1:0)===1?'':'s'} will be cleared; ${outgoing.length} outgoing link${outgoing.length===1?'':'s'} will be removed with the step.`;
 $('#step-delete-dialog').showModal();
}
function confirmDelete(){
 const id=deleteId;$('#step-delete-dialog').close();deleteId=null;if(!id)return;
 const count=connections(documentDraft).filter(edge=>edge.to===id).length+(documentDraft.workflow.entry===id?1:0),outgoing=connections(documentDraft).filter(edge=>edge.from===id&&edge.to!==null).length;
 selected=null;selectedEdge=null;
 edit(doc=>{doc.workflow.steps=doc.workflow.steps.filter(step=>step.id!==id);doc.workflow.connections=doc.workflow.connections.filter(edge=>edge.from!==id).map(edge=>edge.to===id?{...edge,to:null}:edge);if(doc.workflow.entry===id)doc.workflow.entry=null;},`Deleted ${id}; cleared ${count} incoming link${count===1?'':'s'}. Nothing was rerouted.`);
 $status(`Deleted ${id}; cleared ${count} incoming reference${count===1?'':'s'} and removed ${outgoing} outgoing link${outgoing===1?'':'s'}. Nothing was rerouted.`);
}

function tidy(){
 if(!documentDraft)return;const ids=documentDraft.workflow.steps.map(step=>step.id),depth=new Map();if(documentDraft.workflow.entry)depth.set(documentDraft.workflow.entry,0);
 for(let pass=0;pass<ids.length;pass++)for(const edge of connections(documentDraft))if(edge.to&&depth.has(edge.from))depth.set(edge.to,Math.max(depth.get(edge.to)??0,depth.get(edge.from)+1));
 let last=Math.max(-1,...depth.values());for(const id of ids)if(!depth.has(id))depth.set(id,++last);
 const rows=new Map();edit(doc=>{for(const step of doc.workflow.steps){const column=depth.get(step.id)??0,row=rows.get(column)||0;rows.set(column,row+1);step.position={x:column*300,y:row*180};}},'Workflow arranged from left to right.');fitView();
}

async function switchToVisual(){
 if(view==='visual')return;
 const result=await services.save();
 if(!result||!result.json_valid||result.errors?.length){view='json';render();$status('Invalid JSON or schema. The text stays in JSON until repaired or explicitly discarded.');return;}
 try{documentDraft=JSON.parse(code.value);}catch{view='json';render();$status('Invalid JSON. The text stays in JSON until repaired or explicitly discarded.');return;}
 validation=result;validatedText=code.value;view='visual';selected=null;selectedEdge=null;render();requestAnimationFrame(fitView);$status('Workflow view updated from the JSON draft.');
}
function switchToJson(){if(view==='json')return;if(!documentDraft)return;code.value=JSON.stringify(documentDraft,null,2);view='json';render();code.focus();}
async function discardInvalid(){
 if(!validation.errors.length&&!validationForCurrentText().errors.length)return;
 const confirmed=confirm(`Discard invalid text and restore published version ${$('#config-state').textContent.match(/published version (\d+)/)?.[1]||'currently published'}?`);if(!confirmed)return;
 const data=await services.loadPublished();if(!data?.document)throw new Error('Could not load the published configuration. Invalid text is unchanged.');
 code.value=JSON.stringify(data.document,null,2);const result=await services.save();
 if(result?.errors?.length)throw new Error('The published configuration failed validation; invalid text is unchanged.');
 documentDraft=JSON.parse(code.value);validation=result;validatedText=code.value;view='visual';selected=null;render();requestAnimationFrame(fitView);$status('Invalid text discarded; the published configuration is loaded into the draft.');
}
function initializeMotion(){
 let value=false;try{value=localStorage.getItem('workflow-reduced-motion')==='true';}catch{}
 $('#reduce-workflow-motion').checked=value;root.classList.toggle('reduce-motion',value);
 $('#reduce-workflow-motion').addEventListener('change',event=>{const enabled=event.currentTarget.checked;root.classList.toggle('reduce-motion',enabled);try{localStorage.setItem('workflow-reduced-motion',String(enabled));}catch{};});
}

$('#workflow-tab').addEventListener('click',()=>services.run(switchToVisual));
$('#json-tab').addEventListener('click',switchToJson);
$('#add-step').addEventListener('click',()=>openPicker());
$('#workflow-tidy').addEventListener('click',tidy);
$('#workflow-fit').addEventListener('click',fitView);
$('#workflow-zoom-in').addEventListener('click',()=>zoomAt(1.15));
$('#workflow-zoom-out').addEventListener('click',()=>zoomAt(1/1.15));
$('#disconnect-edge').addEventListener('click',disconnect);
$('#close-inspector').addEventListener('click',()=>{selected=null;render();});
$('#delete-step').addEventListener('click',()=>selected&&askDelete(selected));
$('#confirm-step-delete').addEventListener('click',confirmDelete);
$('#step-picker').querySelector('.close-dialog').addEventListener('click',()=>$('#step-picker').close());
$('#step-delete-dialog').querySelector('.close-dialog').addEventListener('click',()=>$('#step-delete-dialog').close());
$('#step-picker-search').addEventListener('input',event=>{const query=event.currentTarget.value.trim().toLowerCase();$('#step-picker-options').querySelectorAll('button').forEach(button=>button.hidden=!button.dataset.search.includes(query));});
$('#step-picker-search').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();$('#step-picker-options').querySelector('button:not([hidden])')?.click();}if(event.key==='ArrowDown'){event.preventDefault();$('#step-picker-options').querySelector('button:not([hidden])')?.focus();}});
$('#step-picker-options').addEventListener('keydown',event=>{const list=[...$('#step-picker-options').querySelectorAll('button:not([hidden])')],index=list.indexOf(document.activeElement);if(event.key==='ArrowDown'){event.preventDefault();list[Math.min(list.length-1,index+1)]?.focus();}if(event.key==='ArrowUp'){event.preventDefault();index<=0?$('#step-picker-search').focus():list[index-1].focus();}});
$('#config-text').addEventListener('input',()=>{renderGutter();renderOutline();renderIssues();});
$('#config-text').addEventListener('scroll',()=>{$('#json-gutter').scrollTop=code.scrollTop;});
$('#json-go-error').addEventListener('click',()=>{const offset=errorOffset();if(offset!=null)jump(offset,1);});
$('#config-discard-invalid').addEventListener('click',()=>services.run(discardInvalid));
$('#workflow-canvas').addEventListener('wheel',event=>{event.preventDefault();if(event.ctrlKey||event.metaKey)zoomAt(Math.exp(-Math.max(-120,Math.min(120,event.deltaY))*.002),event.clientX,event.clientY);else{camera.x-=event.deltaX;camera.y-=event.deltaY;applyCamera();drawWires();}},{passive:false});
canvas.addEventListener('pointerdown',event=>{
 if(event.button!==0||event.target.closest('.workflow-node,#workflow-minimap,.workflow-edge-hit'))return;
 const x=event.clientX,y=event.clientY,start={...camera};let moved=false;canvas.setPointerCapture(event.pointerId);canvas.classList.add('panning');
 const move=ev=>{if(Math.hypot(ev.clientX-x,ev.clientY-y)>3)moved=true;camera.x=start.x+ev.clientX-x;camera.y=start.y+ev.clientY-y;applyCamera();drawWires();};
 const finish=()=>{canvas.removeEventListener('pointermove',move);canvas.removeEventListener('pointerup',finish);canvas.removeEventListener('pointercancel',finish);canvas.classList.remove('panning');if(!moved&&(selected||selectedEdge)){selected=null;selectedEdge=null;render();}};
 canvas.addEventListener('pointermove',move);canvas.addEventListener('pointerup',finish);canvas.addEventListener('pointercancel',finish);
});
$('#workflow-minimap').addEventListener('pointerdown',event=>{if(event.button!==0)return;const map=$('#workflow-minimap');map.setPointerCapture(event.pointerId);panFromMap(event);const move=ev=>panFromMap(ev),finish=()=>{map.removeEventListener('pointermove',move);map.removeEventListener('pointerup',finish);map.removeEventListener('pointercancel',finish);};map.addEventListener('pointermove',move);map.addEventListener('pointerup',finish);map.addEventListener('pointercancel',finish);});
canvas.addEventListener('focusin',event=>{const node=event.target.closest('.workflow-node');if(node)ensureVisible(node.dataset.stepId);});
document.addEventListener('keydown',event=>{
 if(root.hidden||view!=='visual'||document.querySelector('dialog[open]'))return;
 const target=event.target;if(target instanceof HTMLInputElement||target instanceof HTMLTextAreaElement||target instanceof HTMLSelectElement||target.isContentEditable)return;
 if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();openPicker();return;}
 if(event.key==='/'&&!event.metaKey&&!event.ctrlKey&&!event.altKey){event.preventDefault();openPicker();return;}
 if((event.key==='Delete'||event.key==='Backspace')&&selectedEdge){event.preventDefault();disconnect();return;}
 if(event.key==='Escape'&&(selected||selectedEdge)){selected=null;selectedEdge=null;render();}
});
window.addEventListener('resize',()=>{if(view==='visual'&&documentDraft){drawGraph();}});
initializeMotion();

window.workflowEditor={
 load(data){root.hidden=false;code.value=data.text;validation=data.validation;validatedText=data.text;selected=null;selectedEdge=null;camera={x:0,y:0,k:1};live={};documentDraft=data.validation?.json_valid&&!data.validation?.errors?.length?JSON.parse(data.text):null;view=documentDraft?'visual':'json';render();requestAnimationFrame(fitView);},
 clear(){documentDraft=null;validation={json_valid:true,errors:[],blockers:[]};validatedText='';code.value='';selected=null;selectedEdge=null;view='visual';root.hidden=true;render();},
 setValidation(value){validation=value;validatedText=code.value;if(value?.json_valid&&!value?.errors?.length){try{documentDraft=JSON.parse(code.value);}catch{documentDraft=null;}}else documentDraft=null;if(!documentDraft)view='json';render();},
 setServices(value){services={...services,...value};},
 shown(){if(view==='visual'&&documentDraft){drawGraph();fitView();}},
 refreshActions(){renderIssues();},
 getText(){return code.value;},
 getValidation(){return validationForCurrentText();}
};
})();
