import { mkdir, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';
import { Vision } from '../lib/vision.mjs';
import { browserTools } from './browser.mjs';
// The walkthrough's captures, taken from the real studio the same way the browser verifiers take theirs: a synthetic
// signed-in status, the recorded verify:vision response replayed through page.route, and no inference. Every file this
// writes is published, so nothing here may touch a profile, a login or a live provider.
const vision = new Vision({ status:async () => ({ configured:true,cli:true }),inference:async () => { throw new Error('build-captures must not call inference'); } });
const app = createApp({ vision }); await new Promise(resolve => app.listen(0,'127.0.0.1',resolve));
const origin = `http://127.0.0.1:${app.address().port}`;
const { chromium } = browserTools();
await mkdir('.artifacts',{ recursive:true });
const browser = await chromium.launch({ channel:'chrome',headless:true });
// Twice the device pixels: these panes are 379 CSS pixels wide and the page draws them at about 585, so a one-to-one
// capture is upscaled and soft on every screen. The published file is 2x and the page scales it down.
const context = await browser.newContext({ viewport:{ width:1440,height:1100 },deviceScaleFactor:2 });
const page = await context.newPage(); const errors = [];
page.on('pageerror',error => errors.push(error.message));
const written = [];
// A pane is as tall as the studio, and its content usually is not. Published captures stop under the last thing drawn
// in them, so a step's illustration is not mostly empty panel.
const shoot = async (selector,path) => {
  const box = await page.locator(selector).boundingBox();
  const content = await page.locator(selector).evaluate(pane => {
    let edge = 0;
    for (const child of pane.querySelectorAll('*')) { const rect = child.getBoundingClientRect(); if (rect.width && rect.height) edge = Math.max(edge,rect.bottom); }
    return edge;
  });
  const height = Math.min(box.height,Math.max(content - box.y + 16,120));
  await page.screenshot({ path,clip:{ x:Math.round(box.x),y:Math.round(box.y),width:Math.round(box.width),height:Math.round(height) } });
  written.push(path);
};
try {
  await page.goto(origin);
  await page.locator('#provider-status').filter({ hasText:/^Astra · (low|medium|high|xhigh|max)$/ }).waitFor();
  await page.getByRole('button',{ name:'Try a sample sketch' }).click();
  await page.locator('#frame-chip').waitFor();
  // Wait for the sketch to be painted, not merely assigned: decode() on a src the browser has not finished reading
  // throws EncodingError, and a capture taken a frame early shows an empty viewfinder.
  await page.locator('#reference').evaluate(image => image.complete && image.naturalWidth ? null : new Promise(done => image.addEventListener('load',done,{ once:true })));
  assert.equal(await page.locator('#build-label').innerText(),'Build with frame','the direction pane should show that the frame goes with the build');
  await shoot('.pane-reference','docs/images/share.png');
  // Short enough to read whole in the capture; the box scrolls, and a sentence cut in half reads as a rendering fault.
  await page.locator('#direction').fill('Build the task board in this sketch. Add a task, move a card, mark one done.');
  await shoot('.pane-direction','docs/images/direct.png');

  const generated = JSON.parse(await readFile('.artifacts/generated.json','utf8'));
  await page.route('**/api/build',route => route.fulfill({ json:generated }));
  await page.locator('#build').click();
  await page.locator('#version-label').filter({ hasText:'VERSION 01' }).waitFor();
  await page.locator('#direction').fill('Make the heading smaller');
  await page.locator('#build').click();
  await page.locator('#version-label').filter({ hasText:'VERSION 02' }).waitFor();
  const frame = page.frameLocator('#preview');
  await frame.locator('body').waitFor();
  assert.match(await frame.locator('body').innerText(),/DAYLIGHT/i,'the finished prototype should be running in the stage');
  // A shorter window for this one: the page caps a capture at 660 CSS pixels tall and letterboxes anything taller, so a
  // full-height studio would arrive on the site shrunk into the middle of its own frame.
  await page.setViewportSize({ width:1440,height:760 });
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  // The stage and the versions deck in one frame: the prototype, the preview bar above it and the two saved versions
  // under it are one region in the welded studio, and cropping them apart would misrepresent the layout.
  const stage = await page.locator('.stage').boundingBox();
  const deck = await page.locator('.deck').boundingBox();
  await page.screenshot({ path:'docs/images/versions.png',clip:{ x:Math.round(stage.x),y:Math.round(stage.y),width:Math.round(stage.width),height:Math.round(deck.y + deck.height - stage.y) } });
  written.push('docs/images/versions.png');
  assert.deepEqual(errors,[],`browser errors during capture: ${errors.join(', ')}`);
  console.log(`PASS: ${written.length} walkthrough captures from the live studio, no inference and no profile: ${written.join(', ')}.`);
} finally { await browser.close(); app.close(); }
