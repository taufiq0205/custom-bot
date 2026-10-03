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
