import assert from 'node:assert/strict';
export const base = process.env.APP_URL || 'http://localhost:3100';
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
    const listing = await fetch('http://localhost:8025/api/v1/messages').then(r => r.json());
    const message = listing.messages.find(m => m.To.some(t => t.Address === email) && m.Subject === type);
    if (message) {
      const detail = await fetch(`http://localhost:8025/api/v1/message/${message.ID}`).then(r => r.json());
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
  let signup=await request('/api/auth/sign-up/email', {name:'Operator',email,password});
  if(signup.status===429){
    await new Promise(r=>setTimeout(r,1000*(Number(signup.headers.get('retry-after'))||10)+100));
    signup=await request('/api/auth/sign-up/email', {name:'Operator',email,password});
  }
  assert.equal(signup.status,200);
  return { request, email, password };
}
