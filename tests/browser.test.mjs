import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { base, otp } from './helpers.mjs';
test('browser: register, verify, sign in, create Owner Business, recover, sign out', async()=>{
 const browser=await chromium.launch();
 const page=await browser.newPage({viewport:{width:390,height:844}});
 const errors=[]; page.on('pageerror', e=>errors.push(e.message));
 try {
  await page.goto(base);
  const email=`browser-${crypto.randomUUID()}@example.test`;
  await page.getByLabel('Email',{exact:true}).fill(email);
  await page.getByLabel('Password',{exact:true}).fill('Browser-password-928!');
  await page.getByRole('button',{name:'Create account',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Already registered?'}).waitFor();
  await page.getByLabel('One-time code').fill(await otp(email,'email-verification'));
  await page.getByRole('button',{name:'Verify email',exact:true}).click();
  await page.getByText('Email verified. Sign in to continue.').waitFor();
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByLabel('Business name').waitFor();
  await page.getByLabel('Business name').fill('Browser Business');
  await page.getByRole('button',{name:'Create Business as Owner'}).click();
  await page.getByText('Browser Business — Owner').waitFor();
  await page.getByRole('button',{name:'Recover access'}).click();
  await page.getByText('If the account exists, a recovery code has been sent.').waitFor();
  await page.getByLabel('One-time code').fill(await otp(email,'forget-password'));
  await page.getByLabel('Password',{exact:true}).fill('Browser-recovered-928!');
  await page.getByRole('button',{name:'Reset password',exact:true}).click();
  await page.getByText('Password reset. Sign in with your new password.').waitFor();
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByText('Browser Business — Owner').waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await page.getByText('Signed out.',{exact:true}).waitFor();
  assert.equal(await page.locator('#workspace').isVisible(),false);
  assert.deepEqual(errors,[]);
 } finally {await browser.close();}
});
test('browser: invite, accept, promote/demote, cancel, revoke; Support UI hides management',async()=>{
 const {account,invitationToken}=await import('./helpers.mjs');
 const owner=await account('browser-members-owner'),target=await account('browser-members-target');
 for(const a of [owner,target]){
  assert.equal((await a.request('/api/auth/email-otp/verify-email',{email:a.email,otp:await otp(a.email,'email-verification')})).status,200);
 }
 const browser=await chromium.launch();
 const ownerPage=await browser.newPage({viewport:{width:390,height:844}}),targetPage=await browser.newPage({viewport:{width:390,height:844}});
 const errors=[];for(const p of [ownerPage,targetPage])p.on('pageerror',e=>errors.push(e.message));
 const signIn=async(p,a)=>{await p.goto(base);await p.getByLabel('Email',{exact:true}).fill(a.email);await p.getByLabel('Password',{exact:true}).fill(a.password);await p.getByRole('button',{name:'Sign in',exact:true}).click();await p.getByText('Signed in.',{exact:true}).waitFor();await p.getByLabel('Business name').waitFor();};
 try {
  await signIn(ownerPage,owner);await signIn(targetPage,target);
  await ownerPage.getByLabel('Business name').fill('Browser Memberships');
  await ownerPage.getByRole('button',{name:'Create Business as Owner'}).click();
  await ownerPage.getByRole('button',{name:'Manage Browser Memberships'}).click();
  await ownerPage.getByLabel('Invite email').fill(target.email);
  await ownerPage.getByRole('button',{name:'Send invitation',exact:true}).click();
  await ownerPage.getByText('Invitation sent to the intended email.',{exact:true}).waitFor();
  await targetPage.getByLabel('Invitation token').fill(await invitationToken(target.email));
  await targetPage.getByRole('button',{name:'Accept invitation',exact:true}).click();
  await targetPage.getByText('Browser Memberships — Support',{exact:true}).waitFor();
  assert.equal(await targetPage.getByRole('button',{name:'Manage Browser Memberships'}).count(),0);
  await ownerPage.getByRole('button',{name:'Manage Browser Memberships'}).click();
  await ownerPage.getByRole('button',{name:`Change role: ${target.email}`,exact:true}).click();
  await ownerPage.locator('#members li').filter({hasText:`${target.email} — Owner`}).waitFor();
  await targetPage.reload();await targetPage.getByRole('button',{name:'Manage Browser Memberships'}).waitFor();
  await ownerPage.getByRole('button',{name:`Change role: ${target.email}`,exact:true}).click();
  await ownerPage.locator('#members li').filter({hasText:`${target.email} — Support`}).waitFor();
  await ownerPage.getByLabel('Invite email').fill('cancelled-'+crypto.randomUUID()+'@example.test');
  await ownerPage.getByRole('button',{name:'Send invitation',exact:true}).click();
  const cancel=ownerPage.getByRole('button',{name:/Cancel invitation:/});await cancel.waitFor();await cancel.click();
  await ownerPage.getByText('Invitation cancelled.',{exact:true}).waitFor();
  await ownerPage.getByRole('button',{name:`Revoke: ${target.email}`,exact:true}).click();
  await ownerPage.getByText(`${target.email} — Support (revoked)`,{exact:true}).waitFor();
  await targetPage.reload();await targetPage.getByLabel('Business name').waitFor();
  assert.equal(await targetPage.getByText('Browser Memberships — Support',{exact:true}).count(),0);
  await ownerPage.getByRole('button',{name:`Revoke: ${owner.email}`,exact:true}).click();
  await ownerPage.getByText('Keep at least one active Owner',{exact:true}).waitFor();
  for(const p of [ownerPage,targetPage])assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.deepEqual(errors,[]);
 } finally {await browser.close();}
});
test('browser: Owner approves a website; anonymous Customers chat with labelled simulation and browser-scoped history',async()=>{
 const {operator}=await import('./helpers.mjs');
 const {createServer}=await import('node:http');
 const owner=await operator('browser-chat-owner');
 const business=(await owner.request('/api/businesses',{name:'Browser Chat'})).data;
 // A controlled Business website on its own origin embeds the widget from the app.
 const site=createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shop</title><h1>Shop</h1><script src="${base}/widget.js" data-business="${business.id}" defer></script>`);});
 await new Promise(r=>site.listen(0,'127.0.0.1',r));
 const approved=`http://127.0.0.1:${site.address().port}`,unapproved=`http://localhost:${site.address().port}`;
 const browser=await chromium.launch();
 const errors=[];
 const page=async()=>{const p=await (await browser.newContext({viewport:{width:390,height:844}})).newPage();p.on('pageerror',e=>errors.push(e.message));return p;};
 try {
  const ownerPage=await page();
  await ownerPage.goto(base);
  await ownerPage.getByLabel('Email',{exact:true}).fill(owner.email);
  await ownerPage.getByLabel('Password',{exact:true}).fill(owner.password);
  await ownerPage.getByRole('button',{name:'Sign in',exact:true}).click();
  await ownerPage.getByRole('button',{name:'Manage Browser Chat'}).click();
  await ownerPage.getByLabel('Website origin').fill(approved);
  await ownerPage.getByRole('button',{name:'Approve origin',exact:true}).click();
  await ownerPage.getByText('Website origin approved.',{exact:true}).waitFor();
  await ownerPage.getByRole('button',{name:`Remove origin: ${approved}`,exact:true}).waitFor();

  const first=await page();
  await first.goto(approved);
  await first.getByText(/Simulation mode: replies are simulated\. No AI model is used.*Configuration version 1\./).waitFor();
  await first.getByLabel('Message').fill('Where is my order?');
  await first.getByRole('button',{name:'Send',exact:true}).click();
  const log=first.getByRole('log');
  await log.getByText('You: Where is my order?',{exact:true}).waitFor();
  await log.getByText(/^Simulated assistant: Simulated reply: no AI model generated this text/).waitFor();
  await first.reload();
  await first.getByRole('log').getByText('You: Where is my order?',{exact:true}).waitFor();
  assert.equal(await first.getByRole('log').getByRole('listitem').count(),2);

  // Another browser has its own anonymous session and sees none of the first Customer's history.
  const second=await page();
  await second.goto(approved);
  await second.getByText(/Configuration version 1\./).waitFor();
  assert.equal(await second.getByRole('log').getByRole('listitem').count(),0);
  const other=await page();
  await other.goto(unapproved);
  await other.getByText('Chat is unavailable on this website right now.',{exact:true}).waitFor();
  assert.equal(await other.getByRole('button',{name:'Send',exact:true}).isDisabled(),true);
  for(const p of [ownerPage,first,second,other])assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.deepEqual(errors,[]);
 } finally {await browser.close();site.close();}
});
test('browser: a shared browser links only the current anonymous chat; sign-out and account switching hide earlier history',async()=>{
 const {operator}=await import('./helpers.mjs');
 const {createServer}=await import('node:http');
 const {SignJWT,exportJWK,generateKeyPair}=await import('jose');
 const owner=await operator('browser-identity-owner');
 const business=(await owner.request('/api/businesses',{name:'Browser Identity'})).data;
 const {publicKey,privateKey}=await generateKeyPair('ES256',{extractable:true});
 // A controlled Business website: its backend signs a fresh assertion per page for whoever is signed in there.
 const site=createServer(async(req,res)=>{
  const [sub,ttl]={'/as/a':['customer-a',300],'/as/a-short':['customer-a',5],'/as/b':['customer-b',300]}[req.url]??[];
  const iat=Math.floor(Date.now()/1000);
  const assertion=sub?await new SignJWT({iss:approved,aud:new URL(base).origin,business_id:business.id,sub,iat,exp:iat+ttl,jti:crypto.randomUUID()}).setProtectedHeader({alg:'ES256',kid:'browser-key'}).sign(privateKey):'';
  res.writeHead(200,{'content-type':'text/html'});
  res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shop</title><h1>Shop ${sub??'signed out'}</h1><script src="${base}/widget.js" data-business="${business.id}"${assertion?` data-assertion="${assertion}"`:''} defer></script>`);
 });
 await new Promise(r=>site.listen(0,'127.0.0.1',r));
 const approved=`http://127.0.0.1:${site.address().port}`;
 assert.equal((await owner.request(`/api/businesses/${business.id}/website-origins`,{origin:approved,approved:true})).status,200);
 assert.equal((await owner.request(`/api/businesses/${business.id}/customer-keys`,{kid:'browser-key',issuer:approved,public_key:await exportJWK(publicKey)})).status,201);
 const browser=await chromium.launch();
 const errors=[];
 try {
  const page=await (await browser.newContext({viewport:{width:390,height:844}})).newPage();
  page.on('pageerror',e=>errors.push(e.message));
  const log=()=>page.getByRole('log');
  const signedIn=page.getByText(/Signed in: your earlier conversations/);
  await page.goto(approved);
  await page.getByText(/Configuration version 1\./).waitFor();
  await page.getByLabel('Message').fill('Anonymous question from A');
  await page.getByRole('button',{name:'Send',exact:true}).click();
  await log().getByText(/^Simulated assistant:/).waitFor();
  // Signing in on the website links the current anonymous conversation.
  await page.goto(approved+'/as/a');
  await signedIn.waitFor();
  await log().getByText('You: Anonymous question from A',{exact:true}).waitFor();
  // Signing out starts fresh anonymous context, also after reload.
  await page.goto(approved);
  await page.getByText(/Configuration version 1\./).waitFor();
  await page.waitForFunction(()=>!document.body.textContent.includes('Anonymous question from A'));
  assert.equal(await signedIn.count(),0);
  assert.equal(await log().getByRole('listitem').count(),0);
  await page.reload();
  await page.getByText(/Configuration version 1\./).waitFor();
  assert.equal(await log().getByRole('listitem').count(),0);
  assert.equal(await page.getByRole('button',{name:/Open earlier conversation/}).count(),0);
  // Another Customer signs in on the same browser and sees none of A's history.
  await page.goto(approved+'/as/b');
  await signedIn.waitFor();
  await page.getByLabel('Message').fill('Question from B');
  await page.getByRole('button',{name:'Send',exact:true}).click();
  await log().getByText(/^Simulated assistant:/).waitFor();
  assert.equal(await page.getByText('Anonymous question from A').count(),0);
  assert.equal(await page.getByRole('button',{name:/Open earlier conversation/}).count(),0);
  // Switching back to A ends B's access and offers only A's earlier conversation.
  await page.goto(approved+'/as/a');
  await signedIn.waitFor();
  await page.waitForFunction(()=>!document.body.textContent.includes('Question from B'));
  const earlier=page.getByRole('button',{name:/Open earlier conversation/});
  await earlier.first().waitFor();
  assert.equal(await earlier.count(),1);
  await earlier.click();
  await log().getByText('You: Anonymous question from A',{exact:true}).waitFor();
  assert.equal(await page.getByText('Question from B').count(),0);
  // A second tab rotates the shared session for the same Customer and keeps the open conversation;
  // the first tab adopts the rotated token, so its next send succeeds directly.
  const tab=await page.context().newPage();
  tab.on('pageerror',e=>errors.push(e.message));
  await tab.goto(approved+'/as/a');
  await tab.getByRole('log').getByText('You: Anonymous question from A',{exact:true}).waitFor();
  await page.getByLabel('Message').fill('Follow-up from the first tab');
  await page.getByRole('button',{name:'Send',exact:true}).click();
  await log().getByText('You: Follow-up from the first tab',{exact:true}).waitFor();
  assert.equal(await page.getByText(/Your chat session changed/).count(),0);
  await signedIn.waitFor();
  await log().getByText('You: Anonymous question from A',{exact:true}).waitFor();
  // Signing out, then in as B, in the other tab clears this idle tab without any interaction here.
  await tab.goto(approved);
  await tab.getByText(/Configuration version 1\./).waitFor();
  await page.waitForFunction(()=>!document.body.textContent.includes('Anonymous question from A'));
  assert.equal(await signedIn.count(),0);
  await tab.goto(approved+'/as/b');
  await tab.getByText(/Signed in: your earlier conversations/).waitFor();
  await signedIn.waitFor();
  for(const text of ['Anonymous question from A','Follow-up from the first tab','Question from B'])assert.equal(await page.getByText(text).count(),0,text);
  await tab.close();
  // Expiry: an assertion valid for 5 s ends the verified chat server-side; the next send starts fresh anonymous context.
  const loaded=Date.now();
  await page.goto(approved+'/as/a-short');
  await signedIn.waitFor();
  await page.getByLabel('Message').fill('Before expiry');
  await page.getByRole('button',{name:'Send',exact:true}).click();
  await log().getByText(/^Simulated assistant:/).waitFor();
  await new Promise(r=>setTimeout(r,Math.max(0,loaded+6500-Date.now())));
  await page.getByLabel('Message').fill('After expiry');
  await page.getByRole('button',{name:'Send',exact:true}).click();
  await page.getByText(/Your chat session changed/).waitFor();
  assert.equal(await log().getByRole('listitem').count(),0);
  assert.equal(await signedIn.count(),0);
  assert.equal(await page.getByRole('button',{name:/Open earlier conversation/}).count(),0);
  assert.equal(await page.getByText('Before expiry').count(),0);
  assert.equal(await page.getByLabel('Message').inputValue(),'After expiry');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.deepEqual(errors,[]);
 } finally {await browser.close();site.close();}
});
test('browser: Owner keeps invalid JSON across reload, sees located errors, keeps local text on conflict, publishes; Support has no editor',async()=>{
 const {operator,invitationToken}=await import('./helpers.mjs');
 const owner=await operator('browser-config-owner'),support=await operator('browser-config-support');
 const business=(await owner.request('/api/businesses',{name:'Browser Config'})).data;
 const other=(await owner.request('/api/businesses',{name:'Browser Config Other'})).data;
 const path=`/api/businesses/${business.id}/configuration`,otherPath=`/api/businesses/${other.id}/configuration`;
 assert.equal((await owner.request(`/api/businesses/${business.id}/invitations`,{email:support.email,role:'Support'})).status,201);
 assert.equal((await support.request('/api/invitations/accept',{token:await invitationToken(support.email)})).status,200);
 const browser=await chromium.launch();
 const errors=[];
 const signIn=async a=>{const p=await (await browser.newContext({viewport:{width:390,height:844}})).newPage();p.on('pageerror',e=>errors.push(e.message));
  await p.goto(base);await p.getByLabel('Email',{exact:true}).fill(a.email);await p.getByLabel('Password',{exact:true}).fill(a.password);
  await p.getByRole('button',{name:'Sign in',exact:true}).click();await p.getByText('Signed in.',{exact:true}).waitFor();return p;};
 try {
  const page=await signIn(owner);
  const editor=page.getByLabel('Configuration JSON');
  const open=async()=>{await page.getByRole('button',{name:'Manage Browser Config',exact:true}).click();await page.getByText(/Draft revision \d+ · published version \d+/).waitFor();};
  await open();
  assert.equal(JSON.parse(await editor.inputValue()).generation.mode,'simulation');
  const invalid='{\n  "schema_version": 1,\n  "agents": [,]\n}';
  await editor.fill(invalid);
  await page.getByRole('button',{name:'Save draft',exact:true}).click();
  await page.getByText('Draft saved with errors; it cannot be published until they are fixed.',{exact:true}).waitFor();
  await page.getByText(/^Error — Line 3, column 14:/).waitFor();
  // Another Owner action refreshes the page data but never replaces the editor text.
  await editor.fill(invalid+' ');
  await page.getByLabel('Invite email').fill(`browser-config-${crypto.randomUUID()}@example.test`);
  await page.getByRole('button',{name:'Send invitation',exact:true}).click();
  await page.getByText('Invitation sent to the intended email.',{exact:true}).waitFor();
  assert.equal(await editor.inputValue(),invalid+' ');
  await page.reload();await open();
  assert.equal(await editor.inputValue(),invalid);
  await page.getByRole('button',{name:'Publish',exact:true}).click();
  await page.getByText('Not published: fix the listed problems first.',{exact:true}).waitFor();
  // A structurally valid, incomplete draft lists located publication blockers.
  const doc=(await owner.request(path+'/versions/1')).data.document;
  await editor.fill(JSON.stringify({...doc,workflow:{...doc.workflow,entry:null}},null,2));
  await page.getByRole('button',{name:'Publish',exact:true}).click();
  await page.getByText('Not published: fix the listed problems first.',{exact:true}).waitFor();
  await page.getByText('Before publishing — /workflow/entry: Choose a start step',{exact:true}).waitFor();
  // Another Owner's save makes this page's revision stale: the save is rejected and the local text stays.
  const latest=(await owner.request(path)).data;
  assert.equal((await owner.request(path,{text:JSON.stringify(doc),revision:latest.revision})).status,200);
  const local=JSON.stringify({...doc,agents:[{...doc.agents[0],name:'Renamed locally'}]},null,2);
  await editor.fill(local);
  await page.getByRole('button',{name:'Save draft',exact:true}).click();
  await page.getByText(/^Another Owner changed the draft .*Your text is kept here and was not saved/).waitFor();
  assert.equal(await editor.inputValue(),local);
  assert.equal((await owner.request(path)).data.text,JSON.stringify(doc));
  // Reloading asks before discarding; declining keeps the text.
  page.once('dialog',d=>d.dismiss());
  await page.getByRole('button',{name:'Reload draft',exact:true}).click();
  assert.equal(await editor.inputValue(),local);
  page.once('dialog',d=>d.accept());
  await page.getByRole('button',{name:'Reload draft',exact:true}).click();
  await page.getByText('Latest draft loaded.',{exact:true}).waitFor();
  assert.equal(await editor.inputValue(),JSON.stringify(doc));
  await editor.fill(local);
  await page.getByRole('button',{name:'Publish',exact:true}).click();
  await page.getByText(/^Published version 2\./).waitFor();
  await page.getByText(/published version 2$/).waitFor();
  assert.equal((await owner.request(path+'/versions/2')).data.document.agents[0].name,'Renamed locally');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  // If the next Business's draft fails to load, the previous Business's text is gone and cannot be saved there.
  const otherBefore=(await owner.request(otherPath)).data;
  await editor.fill(local+' ');
  const otherDraft=url=>url.pathname===otherPath;
  await page.route(otherDraft,route=>route.abort());
  page.once('dialog',d=>d.accept());
  await page.getByRole('button',{name:'Manage Browser Config Other'}).click();
  await page.waitForFunction(()=>document.querySelector('#membership-title').textContent.includes('Browser Config Other'));
  assert.equal(await editor.inputValue(),'');
  await page.getByRole('button',{name:'Save draft',exact:true}).click();
  await page.getByText('Select Manage again to load this Business configuration.',{exact:true}).waitFor();
  const otherAfter=(await owner.request(otherPath)).data;
  assert.equal(otherAfter.text,otherBefore.text);assert.equal(otherAfter.revision,otherBefore.revision);
  await page.unroute(otherDraft);
  // Signing out leaves no draft text in the page.
  await page.getByRole('button',{name:'Manage Browser Config Other'}).click();
  await page.getByText(/Draft revision \d+ · published version 1/).waitFor();
  await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await page.getByText('Signed out.',{exact:true}).waitFor();
  assert.equal(await page.locator('#config-text').inputValue(),'');
  const supportPage=await signIn(support);
  await supportPage.getByText('Browser Config — Support',{exact:true}).waitFor();
  assert.equal(await supportPage.getByRole('button',{name:'Manage Browser Config',exact:true}).count(),0);
  assert.equal(await supportPage.getByLabel('Configuration JSON').isVisible(),false);
  assert.deepEqual(errors,[]);
 } finally {await browser.close();}
});
