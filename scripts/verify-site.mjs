import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { browserTools } from './browser.mjs';
const config = JSON.parse(await readFile('.artifacts/site/vercel.json','utf8'));
const {version}=JSON.parse(await readFile('package.json','utf8'));
const types = {html:'text/html',js:'text/javascript',css:'text/css',svg:'image/svg+xml',png:'image/png',xml:'application/xml',txt:'text/plain',woff2:'font/woff2'};
const server = createServer(async(req,res)=>{
  const path = new URL(req.url,'http://localhost').pathname;
  if (path.includes('..')) {res.writeHead(404).end();return;}
  // Vercel injects its Web Analytics script on the real host; the local copy serves an empty one so the page loads without a 404 in the console.
  if (path === '/_vercel/insights/script.js') {res.writeHead(200,{'Content-Type':'text/javascript'}).end('');return;}
  try {
    const file = path === '/' ? '/index.html' : path;
    const data = await readFile(`.artifacts/site${file}`);
    const headers = Object.fromEntries(config.headers.flatMap(rule => rule.source === '/(.*)' || rule.source === path ? rule.headers.map(h=>[h.key,h.value]) : []));
    res.writeHead(200,{'Content-Type':types[file.split('.').at(-1)] || 'application/octet-stream',...headers}).end(data);
  } catch {res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base = process.argv[2] || `http://127.0.0.1:${server.address().port}`;
const {chromium} = browserTools();
const browser = await chromium.launch({channel:'chrome',headless:true});
const page = await browser.newPage({viewport:{width:1440,height:1000}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
try {
  assert.equal((await page.goto(base)).status(),200);
  // The wordmark face is self-hosted; a missing or misnamed file would fall back to a system sans with nothing else failing.
  await page.evaluate(()=>document.fonts.ready);
  assert.ok(await page.evaluate(()=>document.fonts.check('700 22px "Plus Jakarta Sans"')),'wordmark font did not load');
  await page.getByRole('link',{name:'Walk through an example'}).click();
  const steps = ['Share a window','Choose & direct','Watch it build','Refine & keep'];
  assert.equal(await page.getByRole('tab',{name:steps[0]}).getAttribute('aria-selected'),'true');
  assert.ok(await page.getByText('Keep your design tool open beside Sidelook.',{exact:true}).isVisible());
  await page.getByRole('tab',{name:steps[1]}).click();
  assert.ok(await page.getByText('Say what should work, not just how it should look.',{exact:true}).isVisible());
  await page.getByRole('tab',{name:steps[1]}).press('ArrowRight');
  assert.equal(await page.getByRole('tab',{name:steps[2]}).getAttribute('aria-selected'),'true');
  assert.equal(await page.locator('#journey-result img').getAttribute('src'),'/streaming.png');
  await page.locator('#journey-result img').evaluate(image=>image.decode());
  assert.ok(await page.getByText('This still illustrates the draft stage, not a result of the example direction above.',{exact:false}).isVisible());
  await page.getByRole('tab',{name:steps[2]}).press('End');
  assert.equal(await page.getByRole('tab',{name:steps[3]}).getAttribute('aria-selected'),'true');
  assert.ok(await page.getByText('This page does not perform a live revision.',{exact:false}).isVisible());
  await page.getByRole('tab',{name:steps[3]}).press('Home');
  assert.equal(await page.getByRole('tab',{name:steps[0]}).getAttribute('aria-selected'),'true');
  assert.equal(await page.locator('#walkthrough img[src="/reference.svg"], #walkthrough img[src="/workbench.png"], #walkthrough img[src="/revision.png"]').count(),0);
  // Every step shows the pane it describes, at the size it declares. Three of the four steps used to be text stand-ins
  // for a picture, and the one real capture went two releases stale with its width and height still describing an
  // older file, which reserves the wrong space and shifts the panel as it loads.
  // The panel has to be the open one before its image is read: a lazy image inside a hidden panel never starts loading,
  // so decode() on it waits for a request the browser will not make until a visitor opens that step.
  for(const [index,panel,file] of [[0,'#journey-reference','/share.png'],[1,'#journey-prompt','/direct.png'],[2,'#journey-result','/streaming.png'],[3,'#journey-revision','/versions.png']]){
    await page.getByRole('tab',{name:steps[index]}).click();
    const image=page.locator(`${panel} img`);
    assert.equal(await image.getAttribute('src'),file,`${panel} should show ${file}`);
    const drawn=await image.evaluate(node=>node.decode().then(()=>[node.naturalWidth,node.naturalHeight,Number(node.getAttribute('width')),Number(node.getAttribute('height'))]));
    assert.ok(drawn[0]>0,`${file} did not decode`);
    assert.deepEqual([drawn[2],drawn[3]],[drawn[0],drawn[1]],`${file} declares ${drawn[2]}x${drawn[3]} and is ${drawn[0]}x${drawn[1]}`);
  }
  assert.ok(await page.getByText('This site does not generate anything.',{exact:false}).isVisible());
  assert.equal(await page.locator('#demo, .sample, #reset-demo').count(),0);
  const faq = page.locator('summary').filter({hasText:'Can I generate here without installing anything?'});
  await faq.evaluate(element=>element.scrollIntoView({block:'center'}));
  await faq.press('Enter');
  assert.ok(await page.getByText('This website provides a prepared walkthrough.',{exact:false}).isVisible());
  const href=await page.locator('#download-zip').getAttribute('href');
  assert.equal(href,`https://github.com/ucsandman/sidelook/releases/download/v${version}/Sidelook-${version}-Windows-x64.exe`);
  // The pinned link only counts if a stranger can follow it. A private repository answers 404 to everyone but the
  // maintainer, so the page keeps looking finished while its one button is dead; asserting the href alone never saw it.
  for(const url of [href,`https://github.com/ucsandman/sidelook/releases/tag/v${version}`]){
    const reply=await page.request.fetch(url,{method:'HEAD',maxRedirects:5,failOnStatusCode:false});
    assert.ok(reply.status()<400,`${url} answers ${reply.status()} to an anonymous visitor`);
  }
  // Every version string on the page is the current one, and the old name is gone; 0.15.0 shipped with the old name still in an install-step filename.
  const bodyText=await page.locator('body').innerText();
  const stale=[...new Set(bodyText.match(/Sidelook[ -]0\.\d+\.\d+/g) || [])].filter(v=>!v.endsWith(version));
  assert.deepEqual(stale,[],`stale version strings on the page: ${stale.join(', ')}`);
  const oldName=String.fromCharCode(74,97,114,118,105,115); // the old product name, spelled as char codes so this check doesn't trip the name gate on itself
  assert.doesNotMatch(bodyText,new RegExp(oldName,'i'),'the old product name is on the page');
  assert.doesNotMatch(await page.content(),new RegExp(oldName,'i'),'the old product name is in the page source');
  for(const path of ['/robots.txt','/sitemap.xml','/llms.txt','/og.png','/mark.svg','/streaming.png','/computer.png','/share.png','/direct.png','/versions.png','/plus-jakarta-sans-700.woff2']) assert.equal((await page.request.get(`${base}${path}`)).status(),200,path);
  for(const path of ['/api/session','/server.mjs','/.env','/demo.html','/reference.svg','/workbench.png','/revision.png']) assert.equal((await page.request.get(`${base}${path}`)).status(),404,path);
  await page.getByRole('link',{name:'Computer mode',exact:true}).click();
  await page.locator('#computer img').evaluate(image=>image.decode());
  assert.match(await page.locator('#computer').innerText(),/Ctrl\+Shift\+F12/);
  assert.match(await page.locator('#computer').innerText(),/No canvas drawing/);
  await page.locator('#computer').screenshot({path:'.artifacts/site-computer-desktop.png'});
  await page.goto(base);await page.screenshot({path:'.artifacts/site-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.locator('#computer').screenshot({path:'.artifacts/site-computer-mobile.png'});
  for (const step of steps) {
    await page.getByRole('tab',{name:step}).click();
    assert.equal(await page.locator('[role="tabpanel"]:visible').count(),1);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  }
  for (const panel of ['reference','prompt','result','revision']) {
    await page.locator(`[data-step="${panel}"]`).click();
    await page.locator('#walkthrough').screenshot({path:`.artifacts/walkthrough-${panel}-mobile.png`});
  }
  await page.screenshot({path:'.artifacts/site-mobile.png',fullPage:true});
  await page.setViewportSize({width:1440,height:1000});
  for (const panel of ['reference','prompt','result','revision']) {
    await page.locator(`[data-step="${panel}"]`).click();
    await page.locator('#walkthrough').screenshot({path:`.artifacts/walkthrough-${panel}-desktop.png`});
  }
  assert.deepEqual(errors,[]);
  console.log(`PASS: ${base}; Current walkthrough verified: 4 steps on desktop and mobile, keyboard arrows/Home/End, draft image and replay disclosure, the self-hosted wordmark face loaded, Computer mode guide on desktop/mobile, 11 public assets, 7 removed/private routes, pinned download, no overflow or browser errors.`);
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
