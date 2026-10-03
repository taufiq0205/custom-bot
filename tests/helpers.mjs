import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
export const base = process.env.APP_URL || 'http://localhost:3100';
const mailBase = process.env.MAIL_URL || 'http://localhost:8025';
// The suite shares one client IP, so Better Auth's per-IP limits can apply; wait out the public Retry-After once.
export async function limited(send) {
  const first=await send();
  if(first.status!==429)return first;
  await new Promise(r=>setTimeout(r,1000*(Number(first.headers.get('retry-after'))||10)+100));
  return send();
}
export async function client() {
  let cookie = '';
  return async (path, body, options = {}) => {
    const headers = { 'content-type':'application/json', origin:base, cookie, ...options.headers };
    if (headers.origin === null) delete headers.origin;
    const payload = options.chunks ? new ReadableStream({async start(controller) {
      for(const chunk of options.chunks){controller.enqueue(chunk);await new Promise(r=>setTimeout(r,20));}
      controller.close();
    }}) : body === undefined ? undefined : JSON.stringify(body);
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
      headers,
      body: payload, ...(options.chunks ? {duplex:'half'} : {})
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) cookie = cookies.map(c => c.split(';')[0]).join('; ');
    const data = await response.json();
    return { status: response.status, data, headers: response.headers };
  };
}
export async function otp(email, type) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const listing = await fetch(mailBase+'/api/v1/messages').then(r => r.json());
    const message = listing.messages.find(m => m.To.some(t => t.Address === email) && m.Subject === type);
    if (message) {
      const detail = await fetch(`${mailBase}/api/v1/message/${message.ID}`).then(r => r.json());
      return detail.Text.match(/\b\d{8}\b/)[0];
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`No captured ${type} mail`);
}
export async function account(prefix) {
  const request = await client();
  const email = `${prefix}-${crypto.randomUUID()}@example.test`;
  const password = 'Fixture-password-937!';
  const signup=await limited(()=>request('/api/auth/sign-up/email', {name:'Operator',email,password}));
  assert.equal(signup.status,200);
  return { request, email, password };
}

export async function invitationToken(email) {
  for(let i=0;i<30;i++) {
    const list=await fetch(mailBase+'/api/v1/messages').then(r=>r.json());
    const message=list.messages.find(m=>m.Subject==='Business invitation'&&m.To.some(t=>t.Address===email));
    if(message){const detail=await fetch(`${mailBase}/api/v1/message/${message.ID}`).then(r=>r.json());return detail.Text.match(/Invitation token: (\S+)/)[1];}
    await new Promise(r=>setTimeout(r,100));
  }
  throw new Error('Invitation mail not received');
}

export async function operator(prefix) {
  const a=await account(prefix);
  assert.equal((await a.request('/api/auth/email-otp/verify-email',{email:a.email,otp:await otp(a.email,'email-verification')})).status,200);
  const login=await limited(()=>a.request('/api/auth/sign-in/email',{email:a.email,password:a.password}));
  assert.equal(login.status,200);
  return {...a,id:login.data.user.id,cookie:login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ')};
}
export const compose=(...args)=>execFileSync('docker',['compose','-f','compose.yaml','-f','compose.test.yaml',...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
export async function ready(){for(let i=0;i<60;i++){try{if((await fetch(base+'/health/ready')).ok)return;}catch{}await new Promise(r=>setTimeout(r,500));}throw new Error('Readiness timeout');}
// Independent sockets hold request bodies incomplete until every request is connected.
export async function together(operations) {
  let release,arrived=0;
  const barrier=new Promise(resolve=>{release=resolve;});
  return Promise.all(operations.map(({path,body,headers})=>new Promise((resolve,reject)=>{
    const payload=JSON.stringify(body);
    const req=httpRequest(base+path,{method:'POST',agent:false,headers:{origin:base,...headers,'content-type':'application/json','content-length':Buffer.byteLength(payload)}},res=>{
      let raw='';res.setEncoding('utf8');res.on('data',s=>raw+=s);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(raw)}));
    });
    req.setTimeout(10000,()=>req.destroy(new Error('Race timeout')));req.on('error',reject);
    req.write(payload.slice(0,-1));
    req.once('socket',socket=>socket.once('connect',async()=>{if(++arrived===operations.length)release();await barrier;req.end(payload.slice(-1));}));
  })));
}
