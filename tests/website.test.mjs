import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { active, addWebsite, base, business, calls, cite, clockAt, delivered, grounded, handedOff, html, ingested, invitationToken, last, operator,
  publish, refresh, robotsStatus, script, site, siteHost, sources, sql, start, together, upload, visits, wait } from './helpers.mjs';

// One team for the whole file; its sign-ups happen first (Better Auth allows 3 sign-ups per 10 s, and a browser cannot wait out a 429).
let shared;
const team=()=>shared??=(async()=>({owner:await operator('website-owner'),support:await operator('website-support'),outsider:await operator('website-outsider')}))();
const text=s=>Buffer.from(s);
const iso=t=>new Date(t).toISOString();
const source=async(b,ref)=>(await sources(b)).find(s=>s.ref===ref);
const evidence=async flow=>(await last(`${flow}.answer`)).evidence;
// Waits for a candidate newer than `previous` (for example a scheduled refresh) to settle.
async function next(b,ref,previous) {
  for(let i=0;i<240;i++){const s=await source(b,ref);if(s&&s.latest.id!==previous&&!['queued','running'].includes(s.latest.state))return s;await wait(250);}
  throw new Error(`No newer ${ref} snapshot settled`);
}

test('browser: an Owner adds a website with a required page, sees its snapshot and freshness, a failed refresh warning while the snapshot stays, and deletes it',async()=>{
  const t=await team();
  const b=await business('website-browser',{owner:t.owner});
  const browser=await chromium.launch();
  try {
    for(const width of [1280,390]) {
      const key=`browser-${width}-${crypto.randomUUID()}`,scope=`${siteHost}/${key}/help/`,ref=`help-${width}`;
      const pages={'/help/':html('Help','Returns are accepted within 30 days.',['faq']),'/help/faq':html('FAQ','Refunds take 14 days.')};
      await site(key,pages);
      const page=await (await browser.newContext({viewport:{width,height:844}})).newPage();
      const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
      await page.goto(base);
      await page.getByLabel('Email',{exact:true}).fill(t.owner.email);
      await page.getByLabel('Password',{exact:true}).fill(t.owner.password);
      await page.getByRole('button',{name:'Sign in',exact:true}).click();
      await page.getByText('Signed in.',{exact:true}).waitFor();
      await page.getByRole('button',{name:'Manage website-browser Business'}).click();
      await page.getByRole('button',{name:'Knowledge',exact:true}).click();
      await page.getByLabel('Website source ID').fill(ref);
      await page.getByLabel('Website URL').fill(scope);
      await page.getByLabel('Required pages').fill(`${scope}faq`);
      await page.getByRole('button',{name:'Add website'}).click();
      await page.getByText(`Website ${ref} queued for refresh. Answers use it only once every page is complete.`).waitFor();
      const row=page.locator('#knowledge-sources li',{hasText:ref});
      await row.getByText(new RegExp(`Website ${scope.replace(/[.?/]/g,'\\$&')}: Active snapshot: 2 pages, 2 passages, refreshed .+, fresh until .+`)).waitFor();
      // Websites expire by themselves; only documents have Expire.
      assert.equal(await row.getByRole('button',{name:`Expire source: ${ref}`}).count(),0);
      await site(key,{...pages,'/help/faq':{status:503}});
      await row.getByRole('button',{name:`Refresh source: ${ref}`}).click();
      await page.getByText(`Refresh of ${ref} queued. Answers keep using the current snapshot until a complete new one replaces it.`).waitFor();
      await row.locator('.warning',{hasText:`The latest refresh failed: ${scope}faq could not be fetched (status 503)`}).waitFor();
      assert.match(await row.textContent(),/Active snapshot: 2 pages.*Answers still use the snapshot refreshed/);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`no horizontal scroll at ${width}px`);
      await row.getByRole('button',{name:`Delete source: ${ref}`}).click();
      await page.getByText(`Source ${ref} deleted.`).waitFor();
      assert.equal(await page.locator('#knowledge-sources li',{hasText:ref}).count(),0);
      assert.deepEqual(errors,[]);
    }
  } finally {await browser.close();}
});

test('Website scope: same-host path scope and robots.txt are enforced, private destinations and out-of-scope redirects are denied, and pages are cited by URL',async()=>{
  const t=await team();
  const b=await business('website-scope',{owner:t.owner});
  const key=`scope-${crypto.randomUUID()}`,scope=`${siteHost}/${key}/help/`;
  await site(key,{
    '/help/':html('Help centre','Returns are accepted within 30 days of delivery.',['returns',`/${key}/help/private/secrets`,`/${key}/shop/`,
      `https://other.fixture.test/${key}/help/returns`,'%2e%2e/shop/',`${siteHost}/${key}/help/../shop/`,'moved-in','moved-out','moved-away','moved-private',
      'manual.pdf','gone','mailto:help@example.test']),
    '/help/returns':html('Returns','Refunds are paid within 14 days after we receive the item.'),
    '/help/private/secrets':html('Staff only','STAFF-ONLY-SENTINEL'),
    '/shop/':html('Shop','OUTSIDE-SCOPE-SENTINEL'),
    '/help/moved-in':{status:301,location:'exchanges'},
    '/help/exchanges':html('Exchanges','Exchanges are free within 60 days.'),
    '/help/moved-out':{status:302,location:`/${key}/shop/`},
    '/help/moved-away':{status:302,location:`https://internal.fixture.test/${key}/help/returns`},
    '/help/moved-private':{status:307,location:`/${key}/help/private/secrets`},
    '/help/manual.pdf':{type:'application/pdf',body:'%PDF-1.4 not HTML'},
  },[`Disallow: /${key}/help/private/`]);
  assert.equal((await addWebsite(b,'help',scope)).status,202);
  const help=await active(b,'help',scope);
  assert.deepEqual([help.kind,help.active.pages,help.fresh,help.warning,help.website.url,help.website.required],['website',3,true,null,scope,[]]);
  // Only permitted same-host pages under the scope were requested, each once; disallowed, out-of-scope, other-host and escaped links never were.
  const seen=await visits(key);
  assert.deepEqual([...seen].sort(),['/help/','/help/returns','/help/moved-in','/help/exchanges','/help/moved-out','/help/moved-away','/help/moved-private',
    '/help/manual.pdf','/help/gone'].map(p=>`site.fixture.test/${key}${p}`).sort());
  const robots=(await calls('robots.txt')).filter(c=>c.host==='site.fixture.test').at(-1);
  assert.equal(robots.agent,'CustomBotKnowledge/1.0');

  // Answers retrieve only the permitted pages, and citations resolve to their URLs.
  const flow=`scope-flow-${crypto.randomUUID()}`;
  await publish(b,grounded(flow,{sources:[{id:'help',priority:1}]}));
  await script(`${flow}.answer`,[cite('Refunds are paid within 14 days.','E1','E2','E3')]);
  const turn=await (await start(b)).ask('How long do refunds take?');
  const pages=[scope,`${scope}exchanges`,`${scope}returns`];
  assert.deepEqual((await evidence(flow)).map(e=>[e.source,e.document,e.page]).sort(),pages.map(p=>['help',p,null]));
  assert.doesNotMatch(JSON.stringify(await evidence(flow)),/STAFF-ONLY|OUTSIDE-SCOPE/);
  assert.deepEqual(delivered(turn)[0].citations.map(c=>[c.source,c.document,c.page]).sort(),pages.map(p=>['help',p,null]));

  // A required page that robots.txt disallows, that redirects out of bounds, is gone or is not HTML fails the complete refresh.
  const failures=[
    ['req-robots',`${scope}private/secrets`,`required page ${scope}private/secrets is disallowed by robots.txt`],
    ['req-out',`${scope}moved-out`,`required page ${scope}moved-out was not used: it redirects to ${siteHost}/${key}/shop/, which is outside the approved scope`],
    ['req-into-robots',`${scope}moved-private`,`required page ${scope}moved-private was not used: it redirects to ${scope}private/secrets, which is disallowed by robots.txt`],
    ['req-away',`${scope}moved-away`,`required page ${scope}moved-away was not used: it redirects to https://internal.fixture.test/${key}/help/returns, which is outside the approved scope`],
    ['req-gone',`${scope}gone`,`required page ${scope}gone was not used: it returned status 404`],
    ['req-pdf',`${scope}manual.pdf`,`required page ${scope}manual.pdf was not used: it is not HTML (application/pdf)`],
  ];
  for(const [ref,page] of failures)assert.equal((await addWebsite(b,ref,scope,[page])).status,202);
  for(const [ref,page,error] of failures) {
    const s=await ingested(b,ref);
    assert.deepEqual([s.latest.state,s.latest.error,s.active,s.website.required],['failed',error,null,[page]],ref);
    assert.equal(s.warning,`The refresh failed: ${error}. This website source has no usable snapshot.`);
  }
  // Approved-looking hostnames that resolve to private, loopback or link-local addresses are never contacted.
  for(const host of ['internal','loopback','metadata','private']) {
    assert.equal((await addWebsite(b,`private-${host}`,`https://${host}.fixture.test/${key}/help/`)).status,202);
    const s=await ingested(b,`private-${host}`);
    assert.deepEqual([s.latest.state,s.latest.error],['failed',`robots.txt of https://${host}.fixture.test could not be fetched (destination address not permitted)`]);
  }
  assert.equal((await calls('robots.txt')).filter(c=>c.host==='internal.fixture.test').length,0);
  assert.equal((await calls(key)).filter(c=>c.host!=='site.fixture.test').length,0);

  // robots.txt itself: unreachable (5xx) stops the crawl, 401/403 disallow everything, a missing one (404) permits every page in scope.
  const other=`https://other.fixture.test/${key}/help/`;
  try {
    await robotsStatus('other.fixture.test',503);
    assert.equal((await addWebsite(b,'robots',other)).status,202);
    assert.equal((await ingested(b,'robots')).latest.error,'robots.txt of https://other.fixture.test could not be fetched (status 503)');
    await robotsStatus('other.fixture.test',403);
    assert.equal((await refresh(b,'robots')).status,202);
    assert.equal((await ingested(b,'robots')).latest.error,`required page ${other} is disallowed by robots.txt`);
    await robotsStatus('other.fixture.test',404);
    assert.equal((await refresh(b,'robots')).status,202);
    const s=await ingested(b,'robots');
    assert.deepEqual([s.latest.state,s.active.pages],['active',4]);
  } finally {await robotsStatus('other.fixture.test',null);}

  // Scopes are exact HTTPS URL prefixes; required pages lie inside them.
  for(const input of [{url:`http://site.fixture.test/${key}/help/`},{url:`https://user:pw@site.fixture.test/${key}/help/`},{url:`${scope}?page=1`},{url:`${scope}#top`},
    {url:`${siteHost}/${key}/help`},{url:`${siteHost}/${key}/%2e%2e/help/`},{url:`${scope}${'a/'.repeat(100)}`},{url:scope,required:[`${siteHost}/${key}/shop/`]},
    {url:scope,required:'returns'},{url:scope,required:Array.from({length:21},(_,i)=>`${scope}p${i}`)},{url:scope,extra:true},{url:42},{}]) {
    const refused=await t.owner.request(`/api/businesses/${b.id}/sources/bad/website`,input);
    assert.deepEqual([refused.status,refused.data.error],[400,'Provide url (an https:// URL scope ending in /, without query or fragment, at most 200 characters) and optionally required (up to 20 page URLs inside that scope)'],JSON.stringify(input));
  }
  assert.equal(await source(b,'bad'),undefined);
  // A source stays a document or a website; only websites refresh and only documents are explicitly expired.
  await upload(b,'manual','manual.txt',text('Kettles carry a two-year warranty.'));
  await active(b,'manual','manual.txt');
  const mixed=await addWebsite(b,'manual',scope);
  assert.deepEqual([mixed.status,mixed.data.error],[409,'Source manual is a document source; delete it first or use another source ID']);
  assert.equal((await upload(b,'help','help.txt',text('Hijacked'))).status,409);
  assert.equal((await refresh(b,'manual')).status,409);
  assert.equal((await refresh(b,'missing')).status,404);
  assert.equal((await t.owner.request(`/api/businesses/${b.id}/sources/help/expire`,{})).status,404);
  // Owner-only: Support, outsiders and cross-origin requests neither add, refresh nor read website sources.
  assert.equal((await t.owner.request(`/api/businesses/${b.id}/invitations`,{email:t.support.email,role:'Support'})).status,201);
  assert.equal((await t.support.request('/api/invitations/accept',{token:await invitationToken(t.support.email)})).status,200);
  for(const who of [t.support,t.outsider]) {
    assert.equal((await addWebsite(b,'help',`${siteHost}/${key}/`,undefined,who)).status,404);
    assert.equal((await refresh(b,'help',who)).status,404);
    assert.equal((await who.request(`/api/businesses/${b.id}/sources`)).status,404);
  }
  const crossOrigin=await fetch(`${base}/api/businesses/${b.id}/sources/help/refresh`,{method:'POST',headers:{origin:'https://evil.example.test',cookie:t.owner.cookie,'content-type':'application/json'},body:'{}'});
  assert.equal(crossOrigin.status,403);
  const unchanged=await source(b,'help');
  assert.deepEqual([unchanged.latest.id,unchanged.website.url],[help.latest.id,scope]);
});

test('Website page cap and completeness: at most 100 permitted pages; overflow, a missing required page or a failing page fails the whole refresh and keeps the previous snapshot',async()=>{
  const t=await team();
  const b=await business('website-cap',{owner:t.owner});
  const key=`cap-${crypto.randomUUID()}`,scope=`${siteHost}/${key}/`,flow=`cap-flow-${crypto.randomUUID()}`;
  // An index linking n-1 items, plus five robots-disallowed links that never count.
  const catalogue=n=>({'/':html('Catalogue','Our kettle catalogue.',[...Array.from({length:n-1},(_,i)=>`item-${i}`),...Array.from({length:5},(_,i)=>`private/p${i}`)]),
    ...Object.fromEntries(Array.from({length:n-1},(_,i)=>[`/item-${i}`,html(`Item ${i}`,`Kettle model ${i} holds ${i%3+1} litres. CATALOGUE-V1`)]))});
  const disallow=[`Disallow: /${key}/private/`];
  await site(key,catalogue(100),disallow);
  assert.equal((await addWebsite(b,'catalogue',scope)).status,202);
  const first=await active(b,'catalogue',scope);
  assert.equal(first.active.pages,100);
  assert.equal(new Set(await visits(key)).size,100);
  await publish(b,grounded(flow,{sources:[{id:'catalogue',priority:1}]}));
  const ask=async()=>{await script(`${flow}.answer`,[cite('Here is our catalogue.')]);await (await start(b)).ask('How many litres does a kettle hold?');return (await evidence(flow)).map(e=>e.text).join(' | ');};
  assert.match(await ask(),/CATALOGUE-V1/);

  // One more permitted page fails the refresh as soon as it is discovered, before any item is fetched.
  await site(key,{...catalogue(101),'/item-0':html('Item 0','CATALOGUE-V2')},disallow);
  const before=(await visits(key)).length;
  assert.equal((await refresh(b,'catalogue')).status,202);
  let s=await ingested(b,'catalogue');
  assert.deepEqual([s.latest.state,s.latest.error],['failed','the scope has more than 100 permitted pages; narrow the URL scope']);
  assert.deepEqual((await visits(key)).slice(before),[`site.fixture.test/${key}/`]);
  assert.deepEqual([s.active.pages,s.active.activated_at,s.fresh],[100,first.active.activated_at,true]);
  assert.equal(s.warning,`The latest refresh failed: ${s.latest.error}. Answers still use the snapshot refreshed ${iso(first.active.activated_at)} until ${iso(first.active.fresh_until)}.`);

  // Any permitted page failing transiently fails the snapshot; so does a required page that is missing.
  const small={'/':html('Catalogue','Our kettle catalogue. CATALOGUE-V2',['item-0','item-1','gone']),'/item-0':html('Item 0','Kettle 0 holds 2 litres. CATALOGUE-V2'),'/item-1':{status:503}};
  await site(key,small);
  await refresh(b,'catalogue');
  s=await ingested(b,'catalogue');
  assert.equal(s.latest.error,`${scope}item-1 could not be fetched (status 503); a snapshot is complete only with every permitted page`);
  small['/item-1']=html('Item 1','Kettle 1 holds 3 litres. CATALOGUE-V2');
  await site(key,small);
  assert.equal((await addWebsite(b,'catalogue',scope,[`${scope}item-2`])).status,202);
  s=await ingested(b,'catalogue');
  assert.deepEqual([s.latest.error,s.website.required,s.active.pages],[`required page ${scope}item-2 was not used: it returned status 404`,[`${scope}item-2`],100]);
  assert.match(await ask(),/CATALOGUE-V1/);
  assert.doesNotMatch(await ask(),/CATALOGUE-V2/);
  // With the required page present the refresh completes; a discovered page that is gone is skipped.
  small['/item-2']=html('Item 2','Kettle 2 holds 1 litre. CATALOGUE-V2');
  await site(key,small);
  await refresh(b,'catalogue');
  s=await ingested(b,'catalogue');
  assert.deepEqual([s.latest.state,s.active.pages,s.warning],['active',4,null]);
  assert.match(await ask(),/CATALOGUE-V2/);
  assert.doesNotMatch(await ask(),/CATALOGUE-V1/);
});

test('Website refresh: manual and daily refreshes activate only complete snapshots, older conversations use the updated content, and failures warn while the previous snapshot stays',async()=>{
  const t=await team();
  const b=await business('website-refresh',{owner:t.owner});
  const key=`refresh-${crypto.randomUUID()}`,scope=`${siteHost}/${key}/`,flow=`refresh-flow-${crypto.randomUUID()}`;
  const details=html('Details','Wrapping paper is recycled.');
  const content=(text,extra={})=>site(key,{'/':html('Gift wrapping',text,['details']),'/details':details,...extra});
  await content('Gift wrapping costs 5 dollars.');
  assert.equal((await addWebsite(b,'gifts',scope)).status,202);
  let s=await active(b,'gifts',scope);
  const version=await publish(b,grounded(flow,{sources:[{id:'gifts',priority:1}]}));
  const customer=await start(b);
  const ask=async()=>{await script(`${flow}.answer`,[cite('Here is our gift wrapping policy.')]);await customer.ask('How much is gift wrapping?');return (await evidence(flow)).map(e=>e.text).join(' | ');};
  assert.match(await ask(),/costs 5 dollars/);

  // Manual: a second request while one is pending returns that one; the existing conversation then uses the new snapshot,
  // without changing its pinned configuration.
  await content('Gift wrapping is free.',{'/details':{body:details,delay:2}});
  const first=await refresh(b,'gifts'),again=await refresh(b,'gifts');
  assert.equal(first.status,202);
  assert.deepEqual([again.status,again.data.version.id,again.data.message],[202,first.data.version.id,'A refresh is already in progress; its snapshot is used once complete.']);
  s=await ingested(b,'gifts');
  assert.deepEqual([s.latest.id,s.latest.state],[first.data.version.id,'active']);
  let seen=await ask();
  assert.match(seen,/is free/);
  assert.doesNotMatch(seen,/5 dollars/);
  assert.equal((await customer.read()).configuration_version,version);

  // A failed refresh keeps the previous snapshot answering and warns.
  await content('Gift wrapping costs 7 dollars.',{'/details':{status:503}});
  await refresh(b,'gifts');
  s=await ingested(b,'gifts');
  assert.equal(s.latest.state,'failed');
  assert.equal(s.warning,`The latest refresh failed: ${scope}details could not be fetched (status 503); a snapshot is complete only with every permitted page. `
    +`Answers still use the snapshot refreshed ${iso(s.active.activated_at)} until ${iso(s.active.fresh_until)}.`);
  seen=await ask();
  assert.match(seen,/is free/);
  assert.doesNotMatch(seen,/7 dollars/);

  // Daily: nothing is queued just before a day has passed since the last refresh request; just after, the scheduler refreshes by itself.
  await content('Gift wrapping costs 1 dollar.');
  const due=s.website.next_refresh_at;
  clockAt(b,`'${due}'::timestamptz-interval '30 seconds'`);
  await wait(3000);
  assert.equal((await source(b,'gifts')).latest.id,s.latest.id);
  clockAt(b,`'${due}'::timestamptz+interval '1 second'`);
  s=await next(b,'gifts',s.latest.id);
  assert.deepEqual([s.latest.state,s.warning,s.fresh],['active',null,true]);
  assert(new Date(s.website.next_refresh_at)-new Date(due)>=86400000,'the next daily refresh is a day later');
  assert.match(await ask(),/costs 1 dollar/);
});

test('Website freshness: evidence is excluded seven days after the last successful refresh, at once and in flight, while documents stay eligible',async()=>{
  const t=await team();
  const b=await business('website-fresh',{owner:t.owner});
  const key=`fresh-${crypto.randomUUID()}`,scope=`${siteHost}/${key}/`,flow=`fresh-flow-${crypto.randomUUID()}`;
  await site(key,{'/':html('Opening hours','The shop opens at nine.')});
  assert.equal((await addWebsite(b,'hours',scope)).status,202);
  await upload(b,'manual','manual.txt',text('The shop opens at nine on weekdays.'));
  const fresh=await active(b,'hours',scope);
  await active(b,'manual','manual.txt');
  const refreshed=fresh.active.activated_at;
  assert.equal(new Date(fresh.active.fresh_until)-new Date(refreshed),7*86400000);
  await publish(b,grounded(flow,{sources:[{id:'hours',priority:1},{id:'manual',priority:2}]}));
  const customer=await start(b);
  const ask=async()=>{await script(`${flow}.answer`,[cite('We open at nine.')]);await customer.ask('When do you open?');return (await evidence(flow)).map(e=>e.source).sort();};
  assert.deepEqual(await ask(),['hours','manual']);
  // From now on every refresh fails, so the snapshot only ages. The test clock moves this Business only.
  await site(key,{'/':{status:503}});
  const at=offset=>clockAt(b,`'${refreshed}'::timestamptz+interval '${offset}'`);

  // A minute before seven days: the overdue daily refresh runs and fails, and the snapshot still answers.
  at('7 days -1 minute');
  let s=await next(b,'hours',fresh.latest.id);
  assert.deepEqual([s.latest.state,s.fresh],['failed',true]);
  assert.equal(s.warning,`The latest refresh failed: ${scope} could not be fetched (status 503); a snapshot is complete only with every permitted page. `
    +`Answers still use the snapshot refreshed ${iso(refreshed)} until ${iso(fresh.active.fresh_until)}.`);
  assert.deepEqual(await ask(),['hours','manual']);
  // A second past seven days the website stops answering at once; the document is unaffected, however long it has been.
  at('7 days 1 second');
  assert.deepEqual(await ask(),['manual']);
  s=await source(b,'hours');
  assert.equal(s.fresh,false);
  assert.equal(s.warning,`Website evidence expired ${iso(fresh.active.fresh_until)}, 7 days after its last successful refresh: not used for answers. `
    +`The latest refresh failed: ${s.latest.error}. A successful refresh makes it usable again.`);
  at('400 days');
  assert.deepEqual(await ask(),['manual']);

  // Reaching seven days while a provider holds the website's passages withholds the reply.
  at('7 days -1 minute');
  await script(`${flow}.answer`,[{...cite('We open at nine.','E1'),delay:4}]);
  const before=(await calls(`${flow}.answer`)).length;
  const late=await start(b);
  const message=await late.send('When do you open?');
  for(let i=0;i<40&&(await calls(`${flow}.answer`)).length===before;i++)await wait(250);
  assert.deepEqual((await evidence(flow)).map(e=>e.source).sort(),['hours','manual']);
  at('7 days 1 second');
  const settled=await late.settle(message);
  handedOff({conversation:settled,replies:settled.messages.filter(m=>m.reply_to===message.id)});
  assert.equal(sql(`SELECT error FROM jobs WHERE message_id='${message.id}'`),'knowledge source deleted or expired before delivery');

  // A successful refresh makes the website answer again, fresh for another seven days.
  await site(key,{'/':html('Opening hours','The shop opens at eight.')});
  await refresh(b,'hours');
  s=await ingested(b,'hours');
  assert.deepEqual([s.latest.state,s.fresh,s.warning],['active',true,null]);
  assert.deepEqual(await ask(),['hours','manual']);
  assert.match((await evidence(flow)).find(e=>e.source==='hours').text,/opens at eight/);
});

test('Website deletion races: a deleted source is never reactivated by a held manual or daily refresh, or by a refresh racing the deletion',async()=>{
  const t=await team();
  const b=await business('website-delete',{owner:t.owner});
  const remove=ref=>b.owner.request(`/api/businesses/${b.id}/sources/${ref}/delete`,{});
  const key=`delete-${crypto.randomUUID()}`,scope=`${siteHost}/${key}/`;
  const plain=()=>site(key,{'/':html('Returns','Returns are accepted within 30 days.')});
  const running=async ref=>{for(let i=0;i<40&&(await source(b,ref))?.latest.state!=='running';i++)await wait(250);assert.equal((await source(b,ref)).latest.state,'running');};

  for(const trigger of ['manual','daily']) {
    const ref=`held-${trigger}`;
    await plain();
    assert.equal((await addWebsite(b,ref,scope)).status,202);
    const s=await active(b,ref,scope);
    // Test only: a first page starting "[hold 6s]" holds the crawled snapshot before activation.
    await site(key,{'/':html('','[hold 6s] Returns are accepted forever. LATE-SENTINEL')});
    if(trigger==='manual')assert.equal((await refresh(b,ref)).status,202);
    else clockAt(b,`'${s.website.next_refresh_at}'::timestamptz+interval '1 second'`);
    await running(ref);
    assert.equal((await remove(ref)).status,200);
    await wait(7000);
    assert.equal(await source(b,ref),undefined);
    assert.equal(sql(`SELECT count(*) FROM source_chunks WHERE business_id='${b.id}' AND content LIKE '%LATE-SENTINEL%'`),'0');
    // The same source ID starts a new source; the late snapshot never attaches to it.
    await plain();
    assert.equal((await addWebsite(b,ref,scope)).status,202);
    assert.notEqual((await active(b,ref,scope)).latest.id,s.latest.id);
    assert.equal((await remove(ref)).status,200);
  }

  // A refresh request and a deletion from independent clients, released together.
  await plain();
  const outcomes=new Set();
  for(let i=0;i<5;i++) {
    const ref=`race-${i}`,path=`/api/businesses/${b.id}/sources/${ref}`,headers={cookie:b.owner.cookie};
    assert.equal((await addWebsite(b,ref,scope)).status,202);
    await active(b,ref,scope);
    const [refreshed,deleted]=await together([{path:`${path}/refresh`,body:{},headers},{path:`${path}/delete`,body:{},headers}]);
    assert.equal(deleted.status,200);
    assert([202,404].includes(refreshed.status),JSON.stringify(refreshed));
    outcomes.add(refreshed.status);
  }
  await wait(3000);
  assert.deepEqual(await sources(b),[]);
  // Every version of every deleted source stays deleted, without passages, and no ingestion is left pending.
  assert.equal(sql(`SELECT count(*) FROM source_versions v JOIN knowledge_sources s ON s.id=v.source_id WHERE s.business_id='${b.id}' AND v.state<>'deleted'`),'0');
  assert.equal(sql(`SELECT count(*) FROM source_chunks WHERE business_id='${b.id}'`),'0');
  assert.equal(sql(`SELECT count(*) FROM jobs WHERE business_id='${b.id}' AND kind='ingest' AND status IN ('queued','running')`),'0');
  console.log(`refresh/delete race outcomes: ${[...outcomes].sort()}`);
});
