const status = document.querySelector('#status');
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
    list.replaceChildren(...businesses.map(b=>{const li=document.createElement('li');li.textContent=`${b.name} — ${b.role}`;return li;}));
  } catch {workspace.hidden=true;list.replaceChildren();}
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
