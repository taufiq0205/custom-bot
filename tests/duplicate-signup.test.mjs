import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {account,base,otp} from './helpers.mjs';
test('browser: repeated signup explains original password and recovery without replacing credentials',async()=>{
 const {request,email,password}=await account('repeat-signup');
 const browser=await chromium.launch();
 const page=await browser.newPage();
 try {
  await page.goto(base);
  await page.getByLabel('Email',{exact:true}).fill(email);
  await page.getByLabel('Password',{exact:true}).fill('Different-fixture-password-938!');
  await page.getByRole('button',{name:'Create account',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Already registered?'}).waitFor({timeout:3000});
  await page.getByLabel('One-time code').fill(await otp(email,'email-verification'));
  await page.getByRole('button',{name:'Verify email',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Email verified.'}).waitFor();
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Use your original password, or select Recover access to set a new one.'}).waitFor({timeout:3000});
  assert.equal(await page.locator('#workspace').isVisible(),false);
  assert.equal((await request('/api/auth/sign-in/email',{email,password})).status,200);
  await page.getByRole('button',{name:'Recover access',exact:true}).click();
  await page.getByText('If the account exists, a recovery code has been sent.').waitFor();
  await page.getByLabel('One-time code').fill(await otp(email,'forget-password'));
  await page.getByLabel('Password',{exact:true}).fill('Recovered-fixture-password-938!');
  await page.getByRole('button',{name:'Reset password',exact:true}).click();
  await page.getByText('Password reset. Sign in with your new password.').waitFor();
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByLabel('Business name').waitFor();
 }finally{await browser.close();}
});
