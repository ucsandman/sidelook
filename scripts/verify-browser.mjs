import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';
import { Vision } from '../lib/vision.mjs';
import { browserTools } from './browser.mjs';
// Self-hosted on a free port with a synthetic signed-in status, so it never needs the desktop app quit or a real login.
// Model responses come from the recorded verify:vision fixtures via page.route, never from inference.
const vision = new Vision({ status:async () => ({ configured:true,cli:true }),inference:async () => { throw new Error('verify-browser must not call inference'); } });
const app = createApp({ vision }); await new Promise(resolve => app.listen(0,'127.0.0.1',resolve));
const origin = `http://127.0.0.1:${app.address().port}`;
const { chromium } = browserTools();
await mkdir('.artifacts',{ recursive:true });
const browser = await chromium.launch({ channel:'chrome',headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'] });
const context = await browser.newContext({ viewport:{ width:1440,height:1100 },permissions:['camera'] });
const page = await context.newPage(); const errors = [];
page.on('pageerror',error => errors.push(error.message));
const checks = [];
try {
  await page.goto(origin);
  await page.locator('#provider-status').filter({ hasText:/^Astra · (low|medium|high|xhigh|max)$/ }).waitFor();
  assert.ok(await page.locator('#companion').isVisible(),'the column stays beside the studio at 1440');
  await page.screenshot({ path:'.artifacts/workbench-desktop.png',fullPage:true });
  checks.push('desktop initial render with the column beside the studio');
  await page.getByRole('button',{ name:'Connect camera',exact:true }).click();
  await page.getByText('Camera on · local only',{ exact:true }).waitFor();
  assert.ok(await page.locator('#camera').evaluate(video => video.videoWidth > 0));
  await page.getByRole('button',{ name:'Turn off',exact:true }).click();
  assert.equal(await page.locator('#camera').evaluate(video => video.srcObject),null);
  checks.push('camera permission, frame, and stream stop (synthetic device)');
  await page.getByRole('button',{ name:'Try a sample sketch' }).click();
  await page.locator('#reference').evaluate(img => img.decode());
  assert.match(await page.locator('#frame-label').innerText(),/Sample sketch/);
  let cloudRequests = 0; const bodies = [];
  page.on('request',r => { if (/\/api\/(build|observe)$/.test(r.url())) { cloudRequests++; bodies.push(r.postDataJSON()); } });
  await page.locator('#frame-chip').waitFor();assert.equal(await page.locator('#build-label').innerText(),'Build with frame');
  assert.equal(await page.locator('#composer input[type=checkbox]').count(),0,'no tick in the composer');
  const sketchDirection=await page.locator('#direction').inputValue();await page.locator('#direction').fill('');
  await page.locator('#build').click();
  assert.match(await page.locator('#error-text').innerText(),/Tell Sidelook what should work first/);
  assert.equal(cloudRequests,0);await page.locator('#direction').fill(sketchDirection);
  checks.push('sample labeled and attached; the button says the frame goes; an empty direction makes zero cloud requests');

  // Use the actual result of verify:vision to test the rendered output, without another paid call.
  const generated = JSON.parse(await readFile('.artifacts/generated.json','utf8'));
  const observed = JSON.parse(await readFile('.artifacts/observation.json','utf8'));
  assert.equal(generated.model,'gpt-6-astra');
  assert.equal(observed.model,'gpt-6-astra');
  await page.route('**/api/observe',route => route.fulfill({ json:observed }));
  await page.route('**/api/build',route => route.fulfill({ json:generated }));
  await page.locator('#build').click();
  await page.locator('#version-label').filter({ hasText:'VERSION 01' }).waitFor();
  assert.equal(cloudRequests,1); assert.equal(typeof bodies[0].image,'string');
  assert.equal(await page.locator('#frame-chip').isHidden(),true,'the frame leaves the box after it went');
  assert.equal(await page.locator('#build-label').innerText(),'Revise Version 01','the button names the version the next direction revises');
  const frame = page.frameLocator('#preview');
  await frame.locator('body').waitFor();
  assert.match(await frame.locator('body').innerText(),/DAYLIGHT/i);
  checks.push('generated app renders inside sandbox (recorded real provider response); tick and include clear');
  await page.locator('#direction').fill('Make the heading smaller');
  await page.locator('#build').click();
  await page.locator('#version-label').filter({ hasText:'VERSION 02' }).waitFor();
  assert.equal(cloudRequests,2); assert.equal(bodies[1].image,null);
  checks.push('the frame rides only while it is attached in the box');
  await page.getByRole('button',{ name:'Mobile preview',exact:true }).click();
  assert.equal(Math.round((await page.locator('#preview').boundingBox()).width),375);
  await page.getByRole('button',{ name:'Desktop preview',exact:true }).click();
  await page.getByRole('button',{ name:'Source',exact:true }).click();
  assert.match(await page.locator('#source-code').textContent(),/<!doctype html>/i);
  await page.getByRole('button',{ name:'Close source' }).click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button',{ name:'Download',exact:true }).click();
  assert.match((await downloading).suggestedFilename(),/\.html$/);
  checks.push('mobile preview, source inspection, and HTML download');
  await page.screenshot({ path:'.artifacts/workbench-built.png',fullPage:true });
  await page.reload();
  await page.locator('#version-label').filter({ hasText:'VERSION 02' }).waitFor();
  assert.match(await frame.locator('body').innerText(),/DAYLIGHT/i);
  checks.push('version and evidence restored from browser storage');
  // The studio at every width it can be dragged to: the column inline, the chat overlay when it cannot sit inline, one column with a scrolling rail, and never a sideways scrollbar.
  const settle = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  const atWidth = async width => { await page.setViewportSize({ width,height:900 }); await settle(); };
  const shot = async width => { await atWidth(width); await page.screenshot({ path:`.artifacts/studio-${width}.png`,fullPage:true }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),`horizontal overflow at ${width}px`); };
  await shot(1480);
  assert.ok(await page.locator('#companion').isVisible(),'the column stays inline at 1480');
  assert.equal(await page.locator('#chat-toggle').isVisible(),false,'no Chat button while the column is inline');
  // F6 walks the four panes in order and lands on a control that is actually on screen; Shift+F6 walks back. Observed failing first when the
  // handler picked a button inside a hidden wrapper: focus never left the direction pane.
  await page.locator('#direction').focus();
  const paneOf = () => page.evaluate(() => { const a=document.activeElement; return a.closest('.pane-direction')?'direction':a.closest('.pane-reference')?'reference':a.closest('.stage')?'stage':a.closest('#companion')?'panel':'none'; });
  const walk = [];
  for (let i = 0; i < 4; i++) { await page.keyboard.press('F6'); walk.push(await paneOf()); }
  assert.deepEqual(walk,['reference','stage','panel','direction'],'F6 cycles direction, reference, stage, panel');
  await page.keyboard.press('Shift+F6'); assert.equal(await paneOf(),'panel','Shift+F6 walks back');
  checks.push('F6 cycles the four studio panes and Shift+F6 walks back');
  await shot(1180);
  for (const width of [1100,800]) {
    await atWidth(width);
    assert.equal(await page.locator('#companion').isVisible(),false,`the column steps aside at ${width}`);
    assert.ok(await page.locator('#chat-toggle').isVisible(),`Chat is offered at ${width}`);
    await page.locator('#chat-toggle').click();
    assert.ok(await page.locator('#companion').isVisible(),`the chat overlay opens at ${width}`);
    assert.equal(await page.locator('#chat-toggle').getAttribute('aria-expanded'),'true');
    await page.screenshot({ path:`.artifacts/studio-${width}-chat.png`,fullPage:true });
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#companion').isVisible(),false,`Escape closes the chat overlay at ${width}`);
    assert.equal(await page.locator('#chat-toggle').getAttribute('aria-expanded'),'false');
  }
  await shot(900);
  await shot(800);
  assert.ok(await page.evaluate(() => { const rail = document.querySelector('.rail'),stage = document.querySelector('.stage'); return rail.getBoundingClientRect().bottom <= stage.getBoundingClientRect().top + 1 && getComputedStyle(rail).overflowY === 'auto'; }),'one column at 800: the rail stacks above the stage and keeps its own scroll');
  await shot(760);
  // An overlay left open must not survive a window wide enough for the column to come back inline.
  await atWidth(1100); await page.locator('#chat-toggle').click(); await atWidth(1480);
  assert.equal(await page.evaluate(() => document.body.classList.contains('chat-open')),false,'the overlay closes when the column returns');
  assert.equal(await page.locator('#companion-bench').isVisible(),false,'Bench is hidden while the studio is open');
  await page.locator('#companion-back').click();
  assert.ok(await page.locator('#companion-bench').isVisible(),'the panel header carries Bench');
  assert.equal(await page.locator('.app-shell').isVisible(),false,'← Panel leaves the studio');
  await page.screenshot({ path:'.artifacts/panel-bench.png',fullPage:true });
  await page.locator('#companion-bench').click();
  await page.locator('.app-shell').waitFor();
  assert.equal(await page.locator('#companion-expand').count(),0,'the studio no longer hides inside Settings');
  checks.push('Bench opens the studio from the panel header; the studio reflows at 1480, 1180, 1100, 900, 800 and 760 with no horizontal overflow, the chat overlay opens, closes on Escape, and closes again when the column returns');
  await page.setViewportSize({ width:390,height:844 });
  await page.screenshot({ path:'.artifacts/workbench-mobile.png',fullPage:true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  checks.push('390px mobile layout without horizontal overflow');
  await page.getByRole('button',{ name:'New project',exact:true }).click();
  await page.getByRole('button',{ name:'Clear and start fresh',exact:true }).click();
  await page.getByText('Your first version starts with an idea.',{ exact:true }).waitFor();
  await page.reload();
  await page.locator('#provider-status').filter({ hasText:/^Astra · (low|medium|high|xhigh|max)$/ }).waitFor();
  assert.equal(await page.locator('.revision').count(),0);
  checks.push('new-project purge survives reload');
  assert.deepEqual(errors,[]);
  await writeFile('.artifacts/browser-report.json',JSON.stringify({ checks,errors },null,2));
  console.log(`PASS: ${checks.length} browser checks, ${errors.length} page errors.\n${checks.map(c=>`- ${c}`).join('\n')}`);
} finally { await browser.close(); await new Promise(resolve => app.close(resolve)); }
