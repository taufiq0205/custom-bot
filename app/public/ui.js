const status = document.querySelector('#status');
let selectedBusiness=null;
async function request(path, body) {
  const response = await fetch(path, {method: body ? 'POST' : 'GET', headers:{'Content-Type':'application/json'}, body:body?JSON.stringify(body):undefined});
  const data = await response.json();
  if (!response.ok) {
    const message = data.message || data.error || 'Request failed';
    throw new Error(data.code === 'INVALID_EMAIL_OR_PASSWORD'
      ? `${message}. Use your original password, or select Recover access to set a new one.`
      : message);
  }
  return data;
}
async function refresh() {
  const workspace=document.querySelector('#workspace');
  const list=document.querySelector('#businesses');
  try {
    const businesses=await request('/api/businesses');
    workspace.hidden=false;
    list.replaceChildren(...businesses.map(b=>{const li=document.createElement('li');li.textContent=`${b.name} — ${b.role}`;
      if(b.role==='Owner'){const button=document.createElement('button');button.textContent=`Manage ${b.name}`;button.addEventListener('click',()=>run(async()=>{selectedBusiness=b;await refreshMemberships();}));li.append(button);}
      return li;}));
      if(selectedBusiness && !businesses.some(b=>b.id===selectedBusiness.id&&b.role==='Owner')) selectedBusiness=null;
    await refreshMemberships();
  } catch {workspace.hidden=true;list.replaceChildren();selectedBusiness=null;document.querySelector('#membership-panel').hidden=true;}
}
async function run(action) {
  const buttons=[...document.querySelectorAll('button')];
  buttons.forEach(b=>b.disabled=true);
  try {await action();await refresh();} catch(error){status.textContent=error.message;}
  finally {buttons.forEach(b=>b.disabled=false);}
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
    const li=document.createElement('li');li.textContent=`${m.email} — ${m.role}${m.active?'':' (revoked)'}`;
    if(m.active)for(const action of ['Change role','Revoke']){
      const button=document.createElement('button');button.textContent=`${action}: ${m.email}`;
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
    li.textContent=`${i.email} — ${i.role} invitation (${state})`;
    if(state==='pending'){const button=document.createElement('button');button.textContent=`Cancel invitation: ${i.email}`;
      button.addEventListener('click',()=>run(async()=>{await request(path+'/invitations/'+i.id,{});status.textContent='Invitation cancelled.';}));li.append(button);}
    return li;
  }));
  const origins=await request(path+'/website-origins');
  document.querySelector('#origins').replaceChildren(...origins.map(origin=>{
    const li=document.createElement('li');li.textContent=origin;
    const button=document.createElement('button');button.textContent=`Remove origin: ${origin}`;
    button.addEventListener('click',()=>run(async()=>{await request(path+'/website-origins',{origin,approved:false});status.textContent='Website origin removed.';}));
    li.append(button);return li;
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
