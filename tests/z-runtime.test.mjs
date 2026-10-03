import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile, execFileSync } from 'node:child_process';
import { account, client, otp, base, compose, ready, limited, together } from './helpers.mjs';
const asyncExec=promisify(execFile);
const concurrentCompose=(...args)=>asyncExec('docker',['compose','-f','compose.yaml','-f','compose.test.yaml',...args]);
const consumeTogether=async(path,body)=>(await together([0,1].map(()=>({path,body})))).map(r=>r.status);
test('tokens: independent concurrent consumers and expiry',async()=>{
 const {request,email,password}=await account('race');
 const token=await otp(email,'email-verification');
 const outcomes=await consumeTogether('/api/auth/email-otp/verify-email',{email,otp:token});
 assert.deepEqual(outcomes.sort(),[200,400]);
 await request('/api/auth/sign-in/email',{email,password});
 await request('/api/auth/email-otp/request-password-reset',{email});
 const reset=await otp(email,'forget-password');
 const resets=await consumeTogether('/api/auth/email-otp/reset-password',{email,otp:reset,password:'Race-new-password-938!'});
 assert.deepEqual(resets.sort(),[200,400]);
 const expired=await account('expired');
 const expiredCode=await otp(expired.email,'email-verification');
 await expired.request('/api/auth/email-otp/request-password-reset',{email:expired.email});
 const expiredReset=await otp(expired.email,'forget-password');
 await new Promise(r=>setTimeout(r,9000));
 assert.equal((await limited(()=>expired.request('/api/auth/email-otp/verify-email',{email:expired.email,otp:expiredCode}))).status,400);
 assert.equal((await limited(()=>expired.request('/api/auth/email-otp/reset-password',{email:expired.email,otp:expiredReset,password:'Expired-password-928!'}))).status,400);
 assert.equal((await limited(()=>expired.request('/api/auth/sign-in/email',{email:expired.email,password:expired.password}))).status,403);
});
test('Docker: restart persistence, private services, guarded migrations, seed idempotency and readiness failure',async()=>{
 const {request,email,password}=await account('durable');
 const code=await otp(email,'email-verification');
 assert.equal((await limited(()=>request('/api/auth/email-otp/verify-email',{email,otp:code}))).status,200);
 assert.equal((await limited(()=>request('/api/auth/sign-in/email',{email,password}))).status,200);
 const created=await request('/api/businesses',{name:'Preserved Business'});
 assert.equal(created.status,201);
 const membershipPath='/api/businesses/'+created.data.id;
 const membershipsBefore=(await request(membershipPath+'/memberships')).data;
 assert.equal((await request(membershipPath+'/invitations',{email:`restart-${crypto.randomUUID()}@example.test`,role:'Support'})).status,201);
 const invitationsBefore=(await request(membershipPath+'/invitations')).data;
 compose('restart','db','worker','app');await ready();
 assert.deepEqual((await request(membershipPath+'/memberships')).data,membershipsBefore);
 assert.deepEqual((await request(membershipPath+'/invitations')).data,invitationsBefore);
 assert.equal((await request('/api/businesses/'+created.data.id)).data.name,'Preserved Business');
 const login=await client();
 assert.equal((await limited(()=>login('/api/auth/sign-in/email',{email,password}))).status,200);
 const before=(await login('/api/businesses')).data;
 const migrated=await Promise.all([concurrentCompose('run','--rm','migrate'),concurrentCompose('run','--rm','migrate')]);
 assert(migrated.every(x=>!x.stdout.includes('Applied')));
 const changed=mkdtempSync(join(tmpdir(),'custom-bot-migrations-'));
 writeFileSync(join(changed,'001-auth.sql'),readFileSync('migrations/001-auth.sql','utf8')+'\n-- changed applied migration\n');
 assert.throws(()=>compose('run','--rm','-v',`${changed}:/app/migrations:ro`,'migrate'),e=>e.stderr.includes('Applied migration changed'));
 assert.equal((await request('/health/ready')).status,200);
 const seedEmail='seed-slice-13@example.test', seedPassword='Seed-fixture-password-938!';
 const seedRequest=await client();
 let seedLogin=await seedRequest('/api/auth/sign-in/email',{email:seedEmail,password:seedPassword});
 if(seedLogin.status===401){
  assert.equal((await seedRequest('/api/auth/sign-up/email',{name:'Seed Operator',email:seedEmail,password:seedPassword})).status,200);
  assert.equal((await seedRequest('/api/auth/email-otp/verify-email',{email:seedEmail,otp:await otp(seedEmail,'email-verification')})).status,200);
  seedLogin=await seedRequest('/api/auth/sign-in/email',{email:seedEmail,password:seedPassword});
 }
 assert.equal(seedLogin.status,200);
 await Promise.all([concurrentCompose('run','--rm','-e',`SEED_OWNER_EMAIL=${seedEmail}`,'seed'),concurrentCompose('run','--rm','-e',`SEED_OWNER_EMAIL=${seedEmail}`,'seed')]);
 const first=(await seedRequest('/api/businesses')).data;
 assert.deepEqual(first.map(b=>b.name).sort(),['Harbor Demo','Northstar Demo']);
 compose('run','--rm','-e',`SEED_OWNER_EMAIL=${seedEmail}`,'seed');
 assert.deepEqual((await seedRequest('/api/businesses')).data,first);
 assert.deepEqual((await login('/api/businesses')).data,before);
 assert.equal((await login('/api/businesses/'+created.data.id)).data.name,'Preserved Business');
 assert.throws(()=>compose('run','--rm','-e','APP_MODE=hosted','-e','APP_URL=https://example.test','-e','SMTP_HOST=smtp.example.test','-e',`SEED_OWNER_EMAIL=${email}`,'seed'));
 assert.throws(()=>compose('run','--rm','-e','APP_MODE=hosted','-e','APP_URL=https://example.test','-e','SMTP_HOST=smtp.example.test','-e','TEST_OTP_TTL=8','app','node','dist/server.js'));
 for(const service of ['db','worker']) {
  const id=compose('ps','-q',service).trim();
  const ports=JSON.parse(execFileSync('docker',['inspect','--format','{{json .NetworkSettings.Ports}}',id],{encoding:'utf8'}));
  assert(Object.values(ports||{}).every(v=>v===null));
 }
 compose('stop','worker');await new Promise(r=>setTimeout(r,11000));
 assert.equal((await request('/health/ready')).status,503);
 compose('start','worker');await ready();
 assert.equal((await request('/health/ready')).status,200);
 compose('stop','mail');
 assert.equal((await request('/health/ready')).status,503);
 compose('start','mail');await ready();
 const logs=compose('logs','app','worker','migrate','mail');
 for(const value of [password, ...readFileSync('.env','utf8').split('\n').filter(l=>/^(BETTER_AUTH_SECRET|POSTGRES_PASSWORD)=/.test(l)).map(l=>l.split('=')[1])]) {
  assert.equal(logs.includes(value),false,'Service logs must omit secrets');
 }
});
