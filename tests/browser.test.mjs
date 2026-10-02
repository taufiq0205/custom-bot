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
  await page.getByText('Check your mail for a verification code.').waitFor();
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
