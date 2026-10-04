const status = document.querySelector('#status');
let selectedBusiness=null;
// Views change only on sign-in/out, Manage, Open inbox, rail navigation or lost access; never after saves, publishes or polling.
const app=document.querySelector('#app');
const titles={account:'Operator access',home:'Businesses',configuration:'Configuration',knowledge:'Knowledge',team:'Team and website',inbox:'Inbox'};
const managed=['configuration','knowledge','team'];
function show(view) {
  app.dataset.view=view;
  for(const item of document.querySelectorAll('[data-nav]'))item.setAttribute('aria-current',String(item.dataset.nav===view));
  document.querySelector('#crumb-title').textContent=titles[view];
  const business=view==='inbox'?inboxBusiness:managed.includes(view)?selectedBusiness:null;
  document.querySelector('#crumb-business').textContent=business?.name??'Custom Bot';
  // The canvas measures its nodes only while visible.
  if(view==='configuration')window.workflowEditor.shown();
}
function updateRail() {
  for(const item of document.querySelectorAll('[data-nav=configuration],[data-nav=knowledge],[data-nav=team]'))item.disabled=!selectedBusiness;
  document.querySelector('[data-nav=inbox]').disabled=!inboxBusiness;
}
for(const item of document.querySelectorAll('[data-nav]'))item.addEventListener('click',()=>show(item.dataset.nav));
async function request(path, body) {
  const response = await fetch(path, {method: body ? 'POST' : 'GET', headers:{'Content-Type':'application/json'}, body:body?JSON.stringify(body):undefined});
  const data = await response.json();
  if (!response.ok) {
    const message = data.message || data.error || 'Request failed';
    throw Object.assign(new Error(data.code === 'INVALID_EMAIL_OR_PASSWORD'
      ? `${message}. Use your original password, or select Recover access to set a new one.`
      : message), {status:response.status,data});
  }
  return data;
}
async function refresh() {
  const workspace=document.querySelector('#workspace');
  const list=document.querySelector('#businesses');
  try {
    const businesses=await request('/api/businesses');
    workspace.hidden=false;
    list.replaceChildren(...businesses.map(b=>{const li=document.createElement('li');li.append(Object.assign(document.createElement('span'),{textContent:`${b.name} — ${b.role}`}));
      const inboxButton=document.createElement('button');inboxButton.textContent=`Open inbox ${b.name}`;
      inboxButton.addEventListener('click',()=>run(async()=>{if(inboxBusiness?.id!==b.id){closeInbox();inboxBusiness=b;}await loadInbox();show('inbox');}));li.append(inboxButton);
      if(b.role==='Owner'){const button=document.createElement('button');button.className='btn-primary';button.textContent=`Manage ${b.name}`;button.addEventListener('click',()=>run(async()=>{if(!discardEdits())return;clearConfiguration();selectedBusiness=b;show('configuration');await refreshMemberships();await loadConfiguration();await loadKnowledge();}));li.append(button);}
      return li;}));
      if(selectedBusiness && !businesses.some(b=>b.id===selectedBusiness.id&&b.role==='Owner')) {selectedBusiness=null;clearConfiguration();if(managed.includes(app.dataset.view))show('home');}
      if(inboxBusiness && !businesses.some(b=>b.id===inboxBusiness.id)){closeInbox();if(app.dataset.view==='inbox')show('home');}
    if(app.dataset.signedIn!=='true'){app.dataset.signedIn='true';show('home');}
    updateRail();
    await refreshMemberships();
  } catch {workspace.hidden=true;list.replaceChildren();selectedBusiness=null;clearConfiguration();closeInbox();document.querySelector('#membership-panel').hidden=true;
    app.dataset.signedIn='false';updateRail();show('account');}
}
async function run(action) {
  const buttons=[...document.querySelectorAll('button')],disabled=new Map(buttons.map(button=>[button,button.disabled]));
  buttons.forEach(b=>b.disabled=true);
  try {await action();await refresh();} catch(error){status.textContent=error.message;}
  finally {for(const button of document.querySelectorAll('button'))if(disabled.has(button))button.disabled=disabled.get(button);updateRail();window.workflowEditor?.refreshActions();}
}
document.querySelector('#account').addEventListener('submit', event=>{
  event.preventDefault();
  const fields=Object.fromEntries(new FormData(event.currentTarget));
  const {email,password,name,otp}=fields;
  const actions={signup:['sign-up/email',{email,password,name},'Check your mail for a verification code if this is a new account. Already registered? Use your original password or Recover access.'],signin:['sign-in/email',{email,password},'Signed in.'],recover:['email-otp/request-password-reset',{email},'If the account exists, a recovery code has been sent.'],resend:['email-otp/send-verification-otp',{email,type:'email-verification'},'Check your mail for a verification code.'],verify:['email-otp/verify-email',{email,otp},'Email verified. Sign in to continue.'],reset:['email-otp/reset-password',{email,otp,password},'Password reset. Sign in with your new password.']};
  const [path,body,message]=actions[event.submitter.value];
  run(async()=>{await request(`/api/auth/${path}`,body);status.textContent=message;});
});
document.querySelector('#business').addEventListener('submit',event=>{
  event.preventDefault();const name=new FormData(event.currentTarget).get('name');
  run(async()=>{await request('/api/businesses',{name});status.textContent='Business created. You are its Owner.';});
});
document.querySelector('#signout').addEventListener('click',()=>run(async()=>{await request('/api/auth/sign-out',{});document.querySelector('#account').reset();status.textContent='Signed out.';}));
refresh();

async function refreshMemberships() {
  const panel=document.querySelector('#membership-panel');
  panel.hidden=!selectedBusiness;
  if(!selectedBusiness)return;
  document.querySelector('#membership-title').textContent=`${selectedBusiness.name} Memberships`;
  const path=`/api/businesses/${selectedBusiness.id}`;
  const members=await request(path+'/memberships');
  document.querySelector('#members').replaceChildren(...members.map(m=>{
    const li=document.createElement('li');li.append(Object.assign(document.createElement('span'),{textContent:`${m.email} — ${m.role}${m.active?'':' (revoked)'}`}));
    if(m.active)for(const action of ['Change role','Revoke']){
      const button=document.createElement('button');button.textContent=action;button.setAttribute('aria-label',`${action}: ${m.email}`);
      button.addEventListener('click',()=>run(async()=>{
        await request(path+'/memberships/'+m.operator_id,{role:action==='Change role'?(m.role==='Owner'?'Support':'Owner'):m.role,active:action!=='Revoke',revision:m.revision});
        status.textContent='Membership updated.';
      }));li.append(button);
    }
    return li;
  }));
  const invitations=await request(path+'/invitations');
  document.querySelector('#invitations').replaceChildren(...invitations.map(i=>{
    const li=document.createElement('li');
    const state=i.consumed_at?'accepted':i.revoked_at?'revoked':new Date(i.expires_at)<=new Date()?'expired':'pending';
    li.append(Object.assign(document.createElement('span'),{textContent:`${i.email} — ${i.role} invitation (${state})`}));
    if(state==='pending'){const button=document.createElement('button');button.textContent='Cancel invitation';button.setAttribute('aria-label',`Cancel invitation: ${i.email}`);
      button.addEventListener('click',()=>run(async()=>{await request(path+'/invitations/'+i.id,{});status.textContent='Invitation cancelled.';}));li.append(button);}
    return li;
  }));
  const origins=await request(path+'/website-origins');
  document.querySelector('#origins').replaceChildren(...origins.map(origin=>{
    const li=document.createElement('li');li.append(Object.assign(document.createElement('span'),{textContent:origin}));
    const button=document.createElement('button');button.textContent='Remove';button.setAttribute('aria-label',`Remove origin: ${origin}`);
    button.addEventListener('click',()=>run(async()=>{await request(path+'/website-origins',{origin,approved:false});status.textContent='Website origin removed.';}));
    li.append(button);return li;
  }));
  // Generation permissions only; extraction permissions arrive with Customer memory.
  const {permissions,providers,selected}=await request(path+'/provider-permissions');
  const shown=[['deepseek','DeepSeek'],['qwen','Qwen']];
  const models=Object.assign(document.createElement('li'),{textContent:`Published version ${selected.version} (${selected.mode}): `+(selected.agents.map(a=>
    `${a.agent} uses ${a.model}${a.fallback?`, fallback ${a.fallback}`:''}`).join('; ')||'no agent selects a model')+'.'});
  document.querySelector('#providers').replaceChildren(models,...shown.map(([id,name])=>{
    const li=document.createElement('li'),label=document.createElement('label'),box=document.createElement('input');
    box.type='checkbox';box.checked=permissions.some(p=>p.provider===id&&p.operation==='generation'&&p.allowed);
    box.addEventListener('change',()=>run(async()=>{await request(`${path}/provider-permissions/${id}/generation`,{allowed:box.checked});
      status.textContent=`${name} generation ${box.checked?'allowed':'not allowed'}.`;}));
    label.append(box,` Allow ${name} generation`);
    const report=providers?.[id];
    li.append(Object.assign(document.createElement('span'),{textContent:`${name}: ${report?.role??'role unknown'}`}),label,
      Object.assign(document.createElement('p'),{className:'help',textContent:report?`Endpoint ${report.endpoint}. Key ${report.key}.`:'Worker readiness unavailable.'}));
    if(report?.processing)li.append(Object.assign(document.createElement('p'),{className:'warning',textContent:`Processing: ${report.processing}.`}));
    return li;
  }));
}
document.querySelector('#origin').addEventListener('submit',event=>{
  event.preventDefault();const origin=new FormData(event.currentTarget).get('origin');
  run(async()=>{await request(`/api/businesses/${selectedBusiness.id}/website-origins`,{origin,approved:true});event.target.reset();status.textContent='Website origin approved.';});
});
document.querySelector('#invite').addEventListener('submit',event=>{
  event.preventDefault();const input=Object.fromEntries(new FormData(event.currentTarget));
  run(async()=>{await request(`/api/businesses/${selectedBusiness.id}/invitations`,input);status.textContent='Invitation sent to the intended email.';});
});
document.querySelector('#accept-invitation').addEventListener('submit',event=>{
  event.preventDefault();const token=new FormData(event.currentTarget).get('token');
  run(async()=>{await request('/api/invitations/accept',{token});event.target.reset();status.textContent='Invitation accepted.';});
});

// The configuration editor loads only on Manage or Reload, so other actions never replace unsaved text.
let config=null;
const editor=document.querySelector('#config-text');
const configPath=()=>`/api/businesses/${selectedBusiness.id}/configuration`;
// Switching Business or account drops the previous draft, so its text can never be saved elsewhere.
function clearConfiguration(){config=null;clearTimeout(knowledgePoll);document.querySelector('#knowledge-sources').replaceChildren();window.workflowEditor.clear();document.querySelector('#config-issues').replaceChildren();document.querySelector('#config-state').textContent='';}
const discardEdits=()=>!config||editor.value===config.text||confirm('Discard your unsaved configuration edits?');
function showConfiguration(validation) {
  document.querySelector('#config-state').textContent=`Draft revision ${config.revision} · published version ${config.published}`;
  const where=i=>i.line?`Line ${i.line}, column ${i.column}`:i.path||'Document';
  document.querySelector('#config-issues').replaceChildren(
    ...validation.errors.map(i=>Object.assign(document.createElement('li'),{textContent:`Error — ${where(i)}: ${i.message}`})),
    ...validation.blockers.map(i=>Object.assign(document.createElement('li'),{textContent:`Before publishing — ${where(i)}: ${i.message}`})));
}
const conflict=latest=>new Error(`Another Owner changed the draft (now revision ${latest.revision}). Your text is kept here and was not saved. Copy it if needed, then select Reload draft to load the latest.`);
async function loadConfiguration() {
  const data=await request(configPath());
  config={revision:data.revision,text:data.text,published:data.published_version,validation:data.validation};
  window.workflowEditor.load(data);
  showConfiguration(data.validation);
}
const loaded=()=>{if(!config)throw new Error('Select Manage again to load this Business configuration.');};
async function saveConfiguration() {
  loaded();
  const text=editor.value;
  if(text===config.text)return config.validation;
  const data=await request(configPath(),{text,revision:config.revision}).catch(error=>{throw error.status===409?conflict(error.data.latest):error;});
  config={...config,revision:data.revision,text,validation:data.validation};
  window.workflowEditor.setValidation(data.validation);
  showConfiguration(data.validation);
  const {json_valid,errors,blockers}=data.validation;
  status_(!json_valid||errors.length?'Draft saved with errors; it cannot be published until they are fixed.':blockers.length?'Draft saved; it is incomplete and cannot be published yet.':'Draft saved.');
  return data.validation;
}
const status_=message=>{status.textContent=message;};
document.querySelector('#config-save').addEventListener('click',()=>run(saveConfiguration));
document.querySelector('#config-reload').addEventListener('click',()=>run(async()=>{if(!discardEdits())return;config=null;await loadConfiguration();status_('Latest draft loaded.');}));
document.querySelector('#config-publish').addEventListener('click',()=>run(async()=>{
  loaded();
  const validation=editor.value!==config.text?await saveConfiguration():config.validation;
  if(!validation?.json_valid||validation.errors.length||validation.blockers.length){showConfiguration(validation);throw new Error('Not published: fix the listed problems first.');}
  const data=await request(configPath()+'/publish',{revision:config.revision}).catch(error=>{
    if(error.status===409)throw conflict(error.data.latest);
    if(error.status===422){showConfiguration(error.data.validation);throw new Error('Not published: fix the listed problems first.');}
    throw error;
  });
  config={...config,revision:data.revision,published:data.version,validation:{json_valid:true,errors:[],blockers:[]}};
  window.workflowEditor.setValidation(config.validation);
  showConfiguration({errors:[],blockers:[]});
  status_(`Published version ${data.version}. New conversations use it; existing conversations keep their version.`);
}));

// Knowledge sources. An upload only queues ingestion; the list shows what is actually active and polls while an upload is pending.
let knowledgePoll;
async function loadKnowledge() {
  clearTimeout(knowledgePoll);
  const business=selectedBusiness;
  const sources=await request(`/api/businesses/${business.id}/sources`);
  if(business!==selectedBusiness)return;
  document.querySelector('#knowledge-title').textContent=`${business.name} knowledge sources`;
  const pending=s=>['queued','running'].includes(s.latest.state);
  document.querySelector('#knowledge-sources').replaceChildren(...(sources.length?sources.map(s=>{
    const li=document.createElement('li'),text=document.createElement('div');
    text.append(Object.assign(document.createElement('strong'),{textContent:s.ref}),` — ${s.active?`Active: ${s.active.document} (${s.active.passages} passages, since ${new Date(s.active.activated_at).toLocaleString()})`:'No usable version'}${pending(s)?` · Ingesting ${s.latest.document}…`:''}`);
    if(s.warning)text.append(Object.assign(document.createElement('p'),{className:'warning',textContent:s.warning}));
    const remove=Object.assign(document.createElement('button'),{className:'btn-danger',textContent:'Delete'});
    remove.setAttribute('aria-label',`Delete source: ${s.ref}`);
    remove.addEventListener('click',()=>run(async()=>{
      if(!confirm(`Delete ${s.ref}? Answers stop using every version of it at once, including in existing conversations.`))return;
      await request(`/api/businesses/${business.id}/sources/${encodeURIComponent(s.ref)}/delete`,{});await loadKnowledge();status_(`Source ${s.ref} deleted.`);
    }));
    const controls=[remove];
    if(s.active) {
      const expire=Object.assign(document.createElement('button'),{textContent:'Expire'});
      expire.setAttribute('aria-label',`Expire source: ${s.ref}`);
      expire.addEventListener('click',()=>run(async()=>{
        if(!confirm(`Expire ${s.ref}? Answers stop using it at once, including in existing conversations, until you upload a replacement.`))return;
        await request(`/api/businesses/${business.id}/sources/${encodeURIComponent(s.ref)}/expire`,{});await loadKnowledge();status_(`Source ${s.ref} expired.`);
      }));
      controls.unshift(expire);
    }
    li.append(text,...controls);return li;
  }):[Object.assign(document.createElement('li'),{textContent:'No knowledge sources yet.'})]));
  if(sources.some(pending))knowledgePoll=setTimeout(()=>loadKnowledge().catch(()=>{}),2000);
}
document.querySelector('#knowledge-upload').addEventListener('submit',event=>{
  event.preventDefault();
  const form=event.currentTarget,ref=form.elements.ref.value.trim(),file=form.elements.file.files[0];
  run(async()=>{
    const response=await fetch(`/api/businesses/${selectedBusiness.id}/sources/${encodeURIComponent(ref)}?document=${encodeURIComponent(file.name)}`,{method:'POST',body:file});
    const data=await response.json();
    if(!response.ok)throw new Error(data.error||'Upload failed');
    form.reset();status_(`${file.name} queued for ingestion. Answers use it only once it is complete.`);await loadKnowledge();
  });
});

window.workflowEditor.setServices({run,save:saveConfiguration,loadPublished:()=>request(`${configPath()}/versions/${config.published}`)});

// Shared inbox. Polling refreshes the list and open conversation but never touches reply drafts, and never adopts a newer revision:
// actions carry the revision the Operator last opened or acted on, so the server rejects them after someone else changed control.
let inboxBusiness=null,inbox=null,opened=null,drafts=new Map(),poll;
const reply=document.querySelector('#inbox-reply');
const inboxPath=()=>`/api/businesses/${inboxBusiness.id}/inbox`;
const states={'automated':'Automated','waiting-for-support':'Waiting for support','human-controlled':'Human-controlled','resolved':'Resolved'};
// Switching Business or account drops every draft, so none can be sent elsewhere.
function closeInbox(){clearInterval(poll);inboxBusiness=inbox=opened=null;drafts=new Map();reply.value='';document.querySelector('#inbox-panel').hidden=true;document.querySelector('#inbox-conversation').hidden=true;}
async function loadInbox() {
  const business=inboxBusiness;
  const data=await request(inboxPath());
  if(business!==inboxBusiness)return;
  inbox=data;
  const me=data.members.find(m=>m.operator_id===data.operator_id);
  document.querySelector('#inbox-panel').hidden=false;
  document.querySelector('#inbox-title').textContent=`${business.name} inbox`;
  document.querySelector('#inbox-availability').textContent=`You are ${me.available?'Available':'Away'}. Availability never assigns conversations.`;
  document.querySelector('#inbox-toggle').textContent=me.available?'Set Away':'Set Available';
  const available=data.members.filter(m=>m.available).map(m=>m.email);
  document.querySelector('#inbox-team').textContent=available.length?`Available: ${available.join(', ')}`:'Nobody is available.';
  document.querySelector('#inbox-list').replaceChildren(...data.conversations.map(c=>{
    const li=document.createElement('li');
    li.textContent=`${states[c.control_state]}${c.assignee_email?` — ${c.assignee_email}`:''}${c.handoff_reason?` (${c.handoff_reason})`:''} · ${new Date(c.last_message_at).toLocaleString()}`;
    const button=document.createElement('button');button.textContent=`Open conversation ${c.id.slice(0,8)}`;
    button.addEventListener('click',()=>run(async()=>{keepDraft();opened={id:c.id};reply.value=drafts.get(c.id)??'';await loadConversation();}));
    li.append(button);return li;
  }));
  // Polling keeps the Operator's chosen assignee selected.
  const assignee=document.querySelector('#inbox-assignee'),chosen=assignee.value;
  assignee.replaceChildren(...data.members.map(m=>Object.assign(document.createElement('option'),{value:m.operator_id,textContent:`${m.email} (${m.role})`})));
  if(data.members.some(m=>m.operator_id===chosen))assignee.value=chosen;
  clearInterval(poll);
  poll=setInterval(()=>{loadInbox().then(()=>opened&&loadConversation(true)).catch(()=>{});},3000);
}
const keepDraft=()=>{if(opened)drafts.set(opened.id,reply.value);};
async function loadConversation(polled=false) {
  const id=opened.id;
  const c=await request(`${inboxPath()}/conversations/${id}`);
  if(opened?.id!==id)return;
  opened={...c,revision:polled?opened.revision:c.revision};
  document.querySelector('#inbox-conversation').hidden=false;
  const mine=c.assignee_id===inbox.operator_id;
  document.querySelector('#inbox-meta').textContent=`${states[c.control_state]}${c.assignee_email?`, assigned to ${mine?'you':c.assignee_email}`:''}${c.handoff_reason?`. Reason: ${c.handoff_reason}`:''}. ${c.verified?'Verified Customer':'Anonymous Customer'}.`;
  const panel=document.querySelector('#inbox-memory');
  panel.hidden=!c.verified;
  if(c.verified&&!polled) {
    const data=await request(`${inboxPath()}/conversations/${id}/memory`);
    if(opened?.id===id)window.memoryControls(panel,data,input=>run(async()=>{
      await request(`${inboxPath()}/conversations/${id}/memory`,input);await loadConversation();status_('Memory updated.');
    }),false);
  }
  const who=m=>m.author==='customer'?'Customer':m.author==='operator'?`Support (${m.operator_email})`:m.author==='system'?'Notice':m.simulated?'Simulated assistant':'Assistant';
  const sources=m=>m.citations?` (Sources: ${m.citations.map(x=>x.page?`${x.document}, page ${x.page}`:x.document).join('; ')})`:'';
  document.querySelector('#inbox-messages').replaceChildren(...c.messages.map(m=>Object.assign(document.createElement('li'),{textContent:`${who(m)}: ${m.text}${sources(m)}`})));
  // External data: text only.
  const value=v=>v!==null&&typeof v==='object'?JSON.stringify(v):String(v);
  document.querySelector('#inbox-lookups').replaceChildren(...(c.lookups.length?c.lookups.map(l=>Object.assign(document.createElement('li'),
    {textContent:`${l.action_id}, observed ${new Date(l.observed_at).toLocaleString()}: ${Object.entries(l.result).map(([k,v])=>`${k}: ${value(v)}`).join(', ')}`}))
    :[Object.assign(document.createElement('li'),{textContent:'None'})]));
}
const act=(action,body={})=>request(`${inboxPath()}/conversations/${opened.id}/${action}`,{revision:opened.revision,...body});
const control=(action,message,input=()=>({}))=>()=>run(async()=>{if(!opened)return;await act(action,input());await loadConversation();await loadInbox();status_(message);});
document.querySelector('#inbox-claim').addEventListener('click',control('claim','Conversation claimed. You are its assignee.'));
document.querySelector('#inbox-resolve').addEventListener('click',control('resolve','Conversation resolved.'));
document.querySelector('#inbox-resume').addEventListener('click',control('resume','Returned to the automated assistant. It replies to the next Customer message.'));
document.querySelector('#inbox-reassign').addEventListener('click',control('reassign','Conversation reassigned.',()=>({operator_id:document.querySelector('#inbox-assignee').value})));
document.querySelector('#inbox-toggle').addEventListener('click',()=>run(async()=>{const me=inbox.members.find(m=>m.operator_id===inbox.operator_id);await request(inboxPath()+'/availability',{available:!me.available});await loadInbox();status_(`You are now ${me.available?'Away':'Available'}.`);}));
// A rejected reply stays in the box; retrying the same text reuses its submission ID, so it is never sent twice.
let pendingReply=null;
document.querySelector('#inbox-send').addEventListener('click',()=>run(async()=>{
  const text=reply.value.trim();
  if(!opened||!text)return;
  if(pendingReply?.text!==text||pendingReply.conversation!==opened.id)pendingReply={id:crypto.getRandomValues(new Uint32Array(4)).join('-'),text,conversation:opened.id};
  try {await act('messages',{client_submission_id:pendingReply.id,text});}
  catch(error){throw new Error(`Not sent; your reply is kept. ${error.message}`);}
  pendingReply=null;reply.value='';drafts.delete(opened.id);
  await loadConversation();status_('Reply sent.');
}));
