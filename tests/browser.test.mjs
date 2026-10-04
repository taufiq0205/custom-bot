import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { base, otp } from './helpers.mjs';

const visualConfiguration=()=>({
 schema_version:1,
 generation:{mode:'simulation'},
 decision:{engine:'jev',model:'jev-small'},
 sources:[{id:'policies',priority:1},{id:'catalogue',priority:2}],
 agents:[
  {id:'router',name:'Router',instructions:'Classify the request.',sources:['policies'],actions:[],model:{provider:'qwen',name:'qwen3.7-plus',temperature:0,max_tokens:256}},
  {id:'support',name:'Order support — “ünïcode”',instructions:'Answer from assigned knowledge.\nUse authorized order lookup.',sources:['policies','catalogue'],actions:['order_status'],model:{provider:'deepseek',name:'deepseek-flash',temperature:0.4,max_tokens:1024}}
 ],
 actions:[{id:'order_status',method:'GET',url:'https://orders.example.com/status?format=json',
  input_schema:{type:'object',properties:{order_id:{type:'string',description:'Order number'}},required:['order_id']},
  result_schema:{type:'object',properties:{status:{type:'string'},items:{type:'array',items:{type:'object',properties:{sku:{type:'string'},quantity:{type:'integer'}},required:['sku']}},paid:{type:'boolean'},total:{type:'number'}},required:['status']},
  credential:'order_api',authorization:'order_owner',timeout_ms:15000}],
 workflow:{entry:'retrieve',steps:[
  {id:'retrieve',type:'retrieval',sources:['policies','catalogue'],position:{x:0,y:160}},
  {id:'classify',type:'agent',agent:'router',final:false,position:{x:280.5,y:-40.25}},
  {id:'route',type:'condition',field:'intent',equals:'order_status',position:{x:560,y:160}},
  {id:'lookup',type:'http',action:'order_status',position:{x:840,y:0}},
  {id:'reply',type:'agent',agent:'support',final:true,position:{x:1120,y:200}},
  {id:'handoff',type:'handoff',position:{x:1400,y:440}}
 ],connections:[
  {from:'retrieve',output:'next',to:'classify'},
  {from:'classify',output:'next',to:'route'},{from:'classify',output:'unsupported',to:'handoff'},
  {from:'route',output:'yes',to:'lookup'},{from:'route',output:'fallback',to:'reply'},
  {from:'lookup',output:'success',to:'reply'},{from:'lookup',output:'failure',to:'handoff'},
  {from:'reply',output:'unsupported',to:'handoff'}
 ]}
});
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
  await page.getByRole('button',{name:'Account',exact:true}).click();
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
  await ownerPage.getByRole('button',{name:'Team and website'}).click();
  await ownerPage.getByLabel('Invite email').fill(target.email);
  await ownerPage.getByRole('button',{name:'Send invitation',exact:true}).click();
  await ownerPage.getByText('Invitation sent to the intended email.',{exact:true}).waitFor();
  await targetPage.getByLabel('Invitation token').fill(await invitationToken(target.email));
  await targetPage.getByRole('button',{name:'Accept invitation',exact:true}).click();
  await targetPage.getByText('Browser Memberships — Support',{exact:true}).waitFor();
  assert.equal(await targetPage.getByRole('button',{name:'Manage Browser Memberships'}).count(),0);
  await ownerPage.getByRole('button',{name:'Businesses',exact:true}).click();
  await ownerPage.getByRole('button',{name:'Manage Browser Memberships'}).click();
  await ownerPage.getByRole('button',{name:'Team and website'}).click();
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
  await ownerPage.getByRole('button',{name:'Team and website'}).click();
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
  const open=async()=>{await page.getByRole('button',{name:'Manage Browser Config',exact:true}).click();await page.getByText(/Draft revision \d+ · published version \d+/).waitFor();await page.getByRole('button',{name:'JSON',exact:true}).click();};
  await open();
  assert.equal(JSON.parse(await editor.inputValue()).generation.mode,'simulation');
  const invalid='{\n  "schema_version": 1,\n  "agents": [,]\n}';
  await editor.fill(invalid);
  await page.getByRole('button',{name:'Save draft',exact:true}).click();
  await page.getByText('Draft saved with errors; it cannot be published until they are fixed.',{exact:true}).waitFor();
  await page.getByText(/^Error — Line 3, column 14:/).waitFor();
  assert.equal(await page.getByRole('button',{name:'Publish',exact:true}).isDisabled(),true);
  // Another Owner action refreshes the page data but never replaces the editor text.
  await editor.fill(invalid+' ');
  await page.getByRole('button',{name:'Team and website'}).click();
  await page.getByLabel('Invite email').fill(`browser-config-${crypto.randomUUID()}@example.test`);
  await page.getByRole('button',{name:'Send invitation',exact:true}).click();
  await page.getByText('Invitation sent to the intended email.',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Configuration',exact:true}).click();
  assert.equal(await editor.inputValue(),invalid+' ');
  await page.reload();await open();
  assert.equal(await editor.inputValue(),invalid);
  assert.equal(await page.getByRole('button',{name:'Publish',exact:true}).isDisabled(),true);
  // A structurally valid, incomplete draft lists located publication blockers.
  const doc=(await owner.request(path+'/versions/1')).data.document;
  await editor.fill(JSON.stringify({...doc,workflow:{...doc.workflow,entry:null}},null,2));
  await page.getByRole('button',{name:'Save draft',exact:true}).click();
  await page.getByText('Draft saved; it is incomplete and cannot be published yet.',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Publish',exact:true}).isDisabled(),true);
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
  // A valid draft reopens on the canvas; its text is edited in the JSON view.
  await page.getByRole('button',{name:'JSON',exact:true}).click();
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
  await page.getByRole('button',{name:'Businesses',exact:true}).click();
  await page.getByRole('button',{name:'Manage Browser Config Other'}).click();
  await page.waitForFunction(()=>document.querySelector('#membership-title').textContent.includes('Browser Config Other'));
  assert.equal(await editor.inputValue(),'');
  await page.waitForFunction(()=>/fetch/i.test(document.querySelector('#status').textContent));
  assert.equal(await page.locator('#workflow-editor').isHidden(),true);
  assert.equal(await page.getByRole('button',{name:'Save draft',exact:true}).count(),0);
  const otherAfter=(await owner.request(otherPath)).data;
  assert.equal(otherAfter.text,otherBefore.text);assert.equal(otherAfter.revision,otherBefore.revision);
  await page.unroute(otherDraft);
  // Signing out leaves no draft text in the page.
  await page.getByRole('button',{name:'Businesses',exact:true}).click();
  await page.getByRole('button',{name:'Manage Browser Config Other'}).click();
  await page.getByText(/Draft revision \d+ · published version 1/).waitFor();
  await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await page.getByText('Signed out.',{exact:true}).waitFor();
  assert.equal(await page.locator('#config-text').inputValue(),'');
  const supportPage=await signIn(support);
  await supportPage.getByText('Browser Config — Support',{exact:true}).waitFor();
  assert.equal(await supportPage.getByRole('button',{name:'Manage Browser Config',exact:true}).count(),0);
  assert.equal(await supportPage.getByLabel('Configuration JSON').isVisible(),false);
  // Support's Owner-only rail sections stay disabled.
  for(const name of ['Configuration','Team and website'])assert.equal(await supportPage.getByRole('button',{name,exact:true}).isDisabled(),true,name);
  assert.deepEqual(errors,[]);
 } finally {await browser.close();}
});
test('browser: workflow and JSON edit the complete persisted configuration; invalid JSON stays until discarded',async()=>{
 const {operator,compose,ready}=await import('./helpers.mjs');
 const owner=await operator('browser-visual-owner');
 const business=(await owner.request('/api/businesses',{name:'Browser Visual'})).data;
 const path=`/api/businesses/${business.id}/configuration`;
 const initial=(await owner.request(path)).data;
 const original=visualConfiguration(),text=JSON.stringify(original,null,3);
 const saved=await owner.request(path,{text,revision:initial.revision});
 assert.equal(saved.status,200);assert.deepEqual(saved.data.validation,{json_valid:true,errors:[],blockers:[]});
 const browser=await chromium.launch(),errors=[];
 const page=await browser.newPage({viewport:{width:1440,height:980}});page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
 const open=async()=>{await page.getByRole('button',{name:'Manage Browser Visual',exact:true}).click();await page.getByRole('region',{name:'Workflow canvas'}).waitFor();};
 try {
  await page.goto(base);await page.getByLabel('Email',{exact:true}).fill(owner.email);await page.getByLabel('Password',{exact:true}).fill(owner.password);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.waitForTimeout(1000);assert.equal(await page.locator('#status').innerText(),'Signed in.',`status=${await page.locator('#status').innerText()} pageErrors=${errors.join('; ')}`);await page.getByLabel('Business name').waitFor();assert.deepEqual(errors,[]);await open();
  const code=page.getByLabel('Configuration JSON');
  assert.equal(await page.getByRole('button',{name:'Workflow',exact:true}).getAttribute('aria-pressed'),'true');
  // Only the selected view is shown, and every wire ends on its target's input port (measured on screen, through the camera transform).
  assert.equal(await code.isVisible(),false,'JSON text is hidden in the Workflow view');
  const gaps=await page.evaluate(()=>[...document.querySelectorAll('.workflow-edge[data-to]')].map(edge=>{
    const end=edge.getPointAtLength(edge.getTotalLength()).matrixTransform(edge.getScreenCTM());
    const port=document.querySelector(`[data-step-id="${CSS.escape(edge.dataset.to)}"] .node-input-port`).getBoundingClientRect();
    return Math.hypot(end.x-(port.left+port.width/2),end.y-(port.top+port.height/2));}));
  assert(gaps.length>0&&gaps.every(gap=>gap<3),`wire ends are ${gaps.map(g=>g.toFixed(1)).join(', ')} px from their input ports`);
  assert.equal(await page.locator('[data-step-id="route"]').count(),1);
  assert((await page.locator('#workflow-wires text').allTextContents()).includes('Else'));
  await page.getByRole('button',{name:'Fit workflow to view'}).click();await page.locator('#workflow-canvas').scrollIntoViewIfNeeded();
  const canvas=page.locator('#workflow-canvas'),canvasBox=await canvas.boundingBox(),camera=()=>page.locator('#workflow-world').evaluate(el=>el.style.transform),beforePan=await camera();
  await page.mouse.move(canvasBox.x+canvasBox.width-18,canvasBox.y+canvasBox.height-18);await page.mouse.down();await page.mouse.move(canvasBox.x+canvasBox.width-58,canvasBox.y+canvasBox.height-48,{steps:4});await page.mouse.up();
  assert.notEqual(await camera(),beforePan,'dragging blank canvas pans the workflow');
  await page.getByRole('button',{name:'Fit workflow to view'}).click();
  const port=page.getByRole('button',{name:'Connect classify Unsupported'}),handoff=page.locator('[data-step-id="handoff"]');await port.scrollIntoViewIfNeeded();await handoff.scrollIntoViewIfNeeded();
  const portBox=await port.boundingBox(),handoffBox=await handoff.boundingBox();
  await page.mouse.move(portBox.x+portBox.width/2,portBox.y+portBox.height/2);await page.mouse.down();
  await page.mouse.move(handoffBox.x+handoffBox.width/2,handoffBox.y+handoffBox.height/2,{steps:6});
  assert((await handoff.getAttribute('class')).includes('drop-target'),`source=${JSON.stringify(portBox)} target=${JSON.stringify(handoffBox)} pending=${await page.locator('.workflow-edge.pending').count()}`);
  assert.equal(await page.locator('.workflow-edge.pending').count(),1);
  await page.mouse.up();assert.equal(await page.locator('.workflow-edge.pending').count(),0);
  const route=page.locator('[data-step-id="route"]');await route.focus();await route.press('ArrowRight');await route.press('Enter');await page.getByRole('complementary',{name:'Step settings'}).waitFor();
  await page.getByRole('button',{name:'JSON',exact:true}).click();
  let edited=JSON.parse(await code.inputValue());
  edited.workflow.steps.find(s=>s.id==='route').equals='order_delivery';
  edited.workflow.connections.find(c=>c.from==='route'&&c.output==='fallback').to='handoff';
  await code.fill(JSON.stringify(edited,null,2));await page.getByRole('button',{name:'Workflow',exact:true}).click();
  await page.locator('[data-step-id="route"]').getByText('intent = order_delivery',{exact:true}).waitFor();
  assert((await page.locator('#workflow-wires text').allTextContents()).includes('Else'));

  // Drag a node: the live connection follows before the pointer is released.
  const reply=page.locator('[data-step-id="reply"]'),box=await reply.boundingBox();
  const edge=page.locator('[data-from="lookup"][data-output="success"].workflow-edge');
  const before=await edge.getAttribute('d');
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
  await page.mouse.move(box.x+box.width/2+45,box.y+box.height/2+30,{steps:5});
  const during=await edge.getAttribute('d');assert.notEqual(during,before,'connected edge moves during drag');
  await page.mouse.up();

  await page.getByRole('button',{name:'JSON',exact:true}).click();
  edited=JSON.parse(await code.inputValue());
  assert.deepEqual(edited.decision,original.decision);assert.deepEqual(edited.sources,original.sources);
  assert.deepEqual(edited.agents,original.agents);assert.deepEqual(edited.actions,original.actions);
  await code.fill('{}');assert.equal(await page.getByRole('button',{name:'Publish',exact:true}).isDisabled(),true);assert.deepEqual(errors,[]);
  await code.fill(JSON.stringify(edited,null,2));edited=JSON.parse(await code.inputValue());
  assert.equal(edited.workflow.steps.find(s=>s.id==='route').position.x,580);
  assert.equal(edited.workflow.steps.find(s=>s.id==='route').equals,'order_delivery');
  assert.equal(edited.workflow.connections.find(c=>c.from==='route'&&c.output==='fallback').to,'handoff');
  await page.getByRole('button',{name:'Save draft',exact:true}).click();await page.getByText(/^Draft saved\./).waitFor();
  await compose('restart','app');await ready();await page.reload();await open();
  await page.getByRole('button',{name:'JSON',exact:true}).click();
  const restored=JSON.parse(await code.inputValue());assert.deepEqual(restored,edited);

  // A visual edit rejected by schema validation keeps the exact text reachable in JSON for repair.
  await page.getByRole('button',{name:'Workflow',exact:true}).click();await page.locator('[data-step-id="lookup"]').click();
  await page.getByLabel('HTTPS endpoint').fill('http://orders.example.com/status');
  await page.getByRole('button',{name:'Save draft',exact:true}).click();
  await page.getByText('Draft saved with errors; it cannot be published until they are fixed.',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'JSON',exact:true}).getAttribute('aria-pressed'),'true');
  let invalidVisual=JSON.parse(await code.inputValue());assert.equal(invalidVisual.actions[0].url,'http://orders.example.com/status');
  assert((await page.locator('#config-issues').innerText()).includes('/actions/0/url'));
  await code.fill(text);await page.getByRole('button',{name:'Workflow',exact:true}).click();await page.getByRole('region',{name:'Workflow canvas'}).waitFor();

  // The searchable picker, labelled branches, Tidy, zoom, and safe deletion use the same draft.
  await page.getByRole('button',{name:'Workflow',exact:true}).click();
  await page.getByRole('button',{name:/Add step/}).click();
  await page.getByLabel('Search step types').fill('human takeover');await page.keyboard.press('Enter');
  const added=page.locator('[data-step-id^="handoff_"]').first();await added.waitFor();
  await page.locator('[data-step-id="route"]').click();const branch=page.getByLabel('Else connection from route');await branch.focus();
  assert.equal(await branch.evaluate(el=>document.activeElement===el),true,'connection control accepts keyboard focus');
  assert.equal(await branch.inputValue(),'reply');await branch.press('ArrowDown');await branch.press('ArrowDown');await branch.press('Enter');
  assert.equal(await branch.inputValue(),await added.getAttribute('data-step-id'),'keyboard selection connects a branch');
  const zoom=page.locator('#workflow-zoom'),zoomBefore=await zoom.innerText();
  await page.getByRole('button',{name:'Zoom in',exact:true}).click();
  assert.notEqual(await zoom.innerText(),zoomBefore,'Zoom in changes the displayed canvas scale');
  await page.getByRole('button',{name:'Tidy',exact:true}).click();
  await page.getByRole('button',{name:'JSON',exact:true}).click();
  const arranged=JSON.parse(await code.inputValue()),positions=new Map(arranged.workflow.steps.map(step=>[step.id,step.position]));
  for(const edge of arranged.workflow.connections.filter(edge=>edge.to))
   assert(positions.get(edge.to).x>positions.get(edge.from).x,`Tidy places ${edge.to} to the right of ${edge.from}`);
  await page.getByRole('button',{name:'Workflow',exact:true}).click();
  await page.getByRole('region',{name:'Workflow canvas'}).waitFor();
  assert.equal(await page.getByRole('img',{name:'Workflow minimap'}).isVisible(),true);
  const beforeMap=await camera();await page.locator('#workflow-minimap').click({position:{x:150,y:80}});assert.notEqual(await camera(),beforeMap,'minimap click pans the canvas');
  await added.focus();await added.press('Delete');
  await page.getByRole('dialog',{name:/Delete step/}).waitFor();
  await page.getByText(/route · Else → handoff_/).waitFor();
  await page.getByRole('button',{name:'Delete step',exact:true}).click();
  await page.getByRole('button',{name:'JSON',exact:true}).click();
  edited=JSON.parse(await code.inputValue());
  assert.equal(edited.workflow.connections.find(c=>c.from==='route'&&c.output==='fallback').to,null);
  assert((await page.locator('#config-issues').innerText()).includes('has no target'));

  // Settings remain usable on a narrow screen; explicit and system reduced motion both apply.
  await page.getByRole('checkbox',{name:'Reduce motion'}).check();
  assert.equal(await page.locator('#workflow-editor').evaluate(el=>el.classList.contains('reduce-motion')),true);
  await page.getByRole('button',{name:'Workflow',exact:true}).click();
  await page.setViewportSize({width:390,height:844});
  await page.locator('[data-step-id="route"]').click();
  await page.getByLabel('Field',{exact:true}).waitFor();
  const inspector=await page.locator('#config-inspector').evaluate(el=>getComputedStyle(el).bottom);assert.notEqual(inspector,'auto');
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await page.locator('#workflow-editor').evaluate(el=>getComputedStyle(el).transitionDuration.split(',')[0].trim()),'0s');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);

  // Saved malformed text survives restart and blocks the visual switch; only the explicit discard restores a published version.
  await page.getByRole('button',{name:'JSON',exact:true}).click();
  const invalid='{ broken';await code.fill(invalid);await page.getByRole('button',{name:'Save draft',exact:true}).click();
  await page.getByText('Draft saved with errors; it cannot be published until they are fixed.',{exact:true}).waitFor();
  await page.reload();await page.getByRole('button',{name:'Manage Browser Visual',exact:true}).click();await code.waitFor();assert.equal(await code.inputValue(),invalid);
  await page.getByRole('button',{name:'Workflow',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Invalid JSON or schema. The text stays in JSON'}).waitFor();
  assert.equal(await code.inputValue(),invalid);
  page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'Discard invalid text',exact:true}).click();
  await page.getByRole('region',{name:'Workflow canvas'}).waitFor();

  await page.getByRole('button',{name:'JSON',exact:true}).click();
  const invalidSchema=JSON.stringify({...original,unsupported:true},null,2);await code.fill(invalidSchema);
  await page.getByRole('button',{name:'Workflow',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Invalid JSON or schema. The text stays in JSON'}).waitFor();
  assert.equal(await code.inputValue(),invalidSchema);assert.equal(await page.getByRole('button',{name:'Publish',exact:true}).isDisabled(),true);
  assert(await page.locator('#config-issues').innerText().then(t=>t.includes('/unsupported')));
  page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'Discard invalid text',exact:true}).click();
  await page.getByRole('region',{name:'Workflow canvas'}).waitFor();
  assert.deepEqual(errors,[]);
 } finally {await browser.close();}
});
test('browser: Customer asks for a person; Support claims and replies; reassignment rejects the former assignee but keeps the draft; resolution',async()=>{
 const {operator,invitationToken}=await import('./helpers.mjs');
 const {createServer}=await import('node:http');
 const owner=await operator('browser-inbox-owner'),support=await operator('browser-inbox-support');
 const business=(await owner.request('/api/businesses',{name:'Browser Inbox'})).data;
 assert.equal((await owner.request(`/api/businesses/${business.id}/invitations`,{email:support.email,role:'Support'})).status,201);
 assert.equal((await support.request('/api/invitations/accept',{token:await invitationToken(support.email)})).status,200);
 const site=createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shop</title><h1>Shop</h1><script src="${base}/widget.js" data-business="${business.id}" defer></script>`);});
 await new Promise(r=>site.listen(0,'127.0.0.1',r));
 const approved=`http://127.0.0.1:${site.address().port}`;
 assert.equal((await owner.request(`/api/businesses/${business.id}/website-origins`,{origin:approved,approved:true})).status,200);
 const browser=await chromium.launch();
 const errors=[];
 const page=async()=>{const p=await (await browser.newContext({viewport:{width:390,height:844}})).newPage();p.on('pageerror',e=>errors.push(e.message));return p;};
 const signIn=async(p,a)=>{await p.goto(base);await p.getByLabel('Email',{exact:true}).fill(a.email);await p.getByLabel('Password',{exact:true}).fill(a.password);await p.getByRole('button',{name:'Sign in',exact:true}).click();await p.getByText('Signed in.',{exact:true}).waitFor();};
 const openConversation=async p=>{await p.getByRole('button',{name:'Open inbox Browser Inbox'}).click();await p.getByRole('button',{name:/^Open conversation /}).click();await p.locator('#inbox-meta').waitFor();};
 try {
  const shopper=await page();
  await shopper.goto(approved);
  const chat=shopper.getByRole('log');
  await shopper.getByLabel('Message').fill('I need help with a return');
  await shopper.getByRole('button',{name:'Send',exact:true}).click();
  await chat.getByText(/^Simulated assistant:/).waitFor();
  await shopper.getByRole('button',{name:'Talk to a person'}).click();
  await chat.getByText(/^Notice: Waiting for support\./).waitFor();
  assert.doesNotMatch(await chat.textContent(),/\d+ ?(second|minute|hour)/i,'No response-time promise');
  assert.equal(await shopper.getByRole('button',{name:'Talk to a person'}).isVisible(),false);

  const supportPage=await page();
  await signIn(supportPage,support);
  await openConversation(supportPage);
  await supportPage.getByText(/Waiting for support\. Reason: customer-request\./).waitFor();
  await supportPage.getByRole('log').getByText('Customer: I need help with a return',{exact:true}).waitFor();
  await supportPage.getByRole('button',{name:'Claim',exact:true}).click();
  await supportPage.getByText('Conversation claimed. You are its assignee.',{exact:true}).waitFor();
  await chat.getByText('Notice: Support joined.',{exact:true}).waitFor();
  await supportPage.getByLabel('Reply').fill('Happy to help with your return.');
  await supportPage.getByRole('button',{name:'Send reply',exact:true}).click();
  await supportPage.getByText('Reply sent.',{exact:true}).waitFor();
  assert.equal(await supportPage.getByLabel('Reply').inputValue(),'');
  await chat.getByText('Support: Happy to help with your return.',{exact:true}).waitFor();
  // Customer messages reach support and start no automated reply.
  await shopper.getByLabel('Message').fill('Thanks, it is order 1001');
  await shopper.getByRole('button',{name:'Send',exact:true}).click();
  await supportPage.getByRole('log').getByText('Customer: Thanks, it is order 1001',{exact:true}).waitFor();
  assert.equal(await chat.getByText(/^Simulated assistant:/).count(),1);

  // Reassignment while Support holds a draft: the send is rejected and the draft stays.
  await supportPage.getByLabel('Reply').fill('Draft that must survive');
  const ownerPage=await page();
  await signIn(ownerPage,owner);
  await openConversation(ownerPage);
  await ownerPage.getByLabel('Assign to').selectOption({label:`${owner.email} (Owner)`});
  await ownerPage.getByRole('button',{name:'Reassign',exact:true}).click();
  await ownerPage.getByText('Conversation reassigned.',{exact:true}).waitFor();
  await supportPage.getByRole('button',{name:'Send reply',exact:true}).click();
  await supportPage.getByText(/^Not sent; your reply is kept\./).waitFor();
  assert.equal(await supportPage.getByLabel('Reply').inputValue(),'Draft that must survive');
  assert.equal(await chat.getByText('Support: Draft that must survive').count(),0);
  await supportPage.getByText(new RegExp(`assigned to ${owner.email.replace(/[.+]/g,'\\$&')}`)).waitFor();

  await ownerPage.getByRole('button',{name:'Resolve',exact:true}).click();
  await ownerPage.getByText('Conversation resolved.',{exact:true}).waitFor();
  await chat.getByText(/^Notice: Conversation resolved\./).waitFor();
  for(const p of [shopper,supportPage,ownerPage])assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.deepEqual(errors,[]);
 } finally {await browser.close();site.close();}
});
