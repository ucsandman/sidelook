import assert from 'node:assert/strict';
import {createApp} from '../server.mjs';
import {Computer} from '../lib/computer.mjs';
import {browserTools} from './browser.mjs';
let actions=0,armed=false,failRead=false;const planned=[],nativeOps=[];
// After an act the fixture window shows a Display control, so the page can prove it reads the outcome back instead of assuming it.
const computer=new Computer({platform:'win32',native:{close(){armed=false;},async call(data){
  nativeOps.push(data.op);
  if(data.op==='arm'){armed=true;return {armed};}
  if(data.op==='status')return {armed};
  if(data.op==='windows')return {windows:[{id:'1:2:3',title:'Calculator fixture'}]};
  if(data.op==='snapshot'){if(failRead){failRead=false;throw new Error('window gone');}return {title:'Calculator fixture',elements:[{id:'1.2',name:'Seven',type:'Button',enabled:true},...(actions?[{id:'1.9',name:'Display',type:'Text',value:'7',enabled:true}]:[])]};}
  if(data.op==='act'){actions++;return {performed:true};}
}},inference:async request=>{planned.push({model:request.model,effort:request.effort});const none=JSON.parse(request.prompt).snapshot.none===true;return {model:'fixture',result:none?{kind:'launch',element:'',text:'',key:'',app:'notepad',reason:'No window is chosen; open Notepad first.'}:{kind:'click',element:'1.2',text:'',key:'',app:'',reason:'Press Seven in the test calculator.'}};}});
const app=createApp({computer,vision:{status:async()=>({configured:true,cli:true})}});await new Promise(r=>app.listen(0,'127.0.0.1',r));
const {chromium}=browserTools();const browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));let count=0;
try{
  await page.goto(`http://127.0.0.1:${app.address().port}/?companion`);await page.waitForFunction(()=>!document.getElementById('companion-send').disabled);
  assert.equal(await page.locator('#computer-mode').isVisible(),false,'Computer mode is not in the conversation');
  await page.locator('#companion-settings').click();await page.locator('#computer-open').click();await page.locator('#computer-lease').waitFor({state:'visible'});assert.equal(await page.locator('#settings').evaluate(d=>d.open),false,'Set it up leaves Settings');
  await page.locator('#computer-enable').click();await page.getByText('Allow local window inspection before enabling Computer mode.').waitFor();count++;
  await page.locator('#computer-permission').check();await page.locator('#computer-enable').click();await page.locator('#computer-work').waitFor();assert.equal(await page.locator('#computer-lease').evaluate(d=>d.open),false);
  assert.equal(await page.locator('.companion-compose').isVisible(),false,'the screen replaces the conversation');assert.match(await page.locator('#computer-left').innerText(),/^(9|10):\d\d left$/);count++;
  await page.locator('#companion-settings').click();await page.locator('#model-choice').selectOption('fable');await page.locator('#settings-close').click();
  assert.match(await page.locator('#computer-consent-line').innerText(),/the chosen window to Fable 5\.1/);count++;
  await page.locator('#computer-window').selectOption('1:2:3');assert.match(await page.locator('#computer-consent-line').innerText(),/reading of Calculator fixture/);assert.equal(await page.locator('#computer-title').innerText(),'Sidelook in Calculator fixture');
  await page.locator('#computer-inspect').click();await page.waitForFunction(()=>document.querySelector('#computer-snapshot').textContent.includes('Seven'));assert.ok(await page.locator('#computer-read').isVisible());count++;
  await page.locator('#computer-next').click();await page.getByText('Say what Sidelook should do first.').waitFor();assert.equal(planned.length,0);count++;
  await page.locator('#computer-task').fill('Enter seven');await page.locator('#computer-next').click();await page.locator('#computer-review').waitFor();assert.equal(actions,0);
  assert.equal(await page.locator('#computer input[type=checkbox], #computer-mode input[type=checkbox]').count(),0,'no tick anywhere on the screen');assert.equal(await page.locator('#computer-mode details').count(),0,'no details arrow either');assert.deepEqual(planned,[{model:'fable',effort:'medium'}]);assert.match(await page.locator('#computer-step-label').innerText(),/^Step 1 of 20 · waiting for you$/);count++;
  // Before Approve: the consequence, the window and the target read in plain words; references and the full tree wait behind Details.
  const detail=await page.locator('#computer-action-detail').innerText();assert.match(detail,/^In: Calculator fixture\nTarget: Button "Seven"$/);assert.equal(await page.locator('#computer-reason').innerText(),'Press Seven in the test calculator.');
  assert.equal(await page.locator('#computer-diagnostics').isHidden(),true,'diagnostics are behind Details');await page.locator('#computer-details').click();assert.equal(await page.locator('#computer-details').getAttribute('aria-expanded'),'true');
  const diagnostics=await page.locator('#computer-diagnostics').innerText();assert.match(diagnostics,/Control reference: 1\.2/);assert.match(diagnostics,/SENT WITH THIS MODEL STEP · Calculator fixture\nButton: Seven  #1\.2/);assert.equal(await page.locator('#computer-outcome').isHidden(),true);count++;
  // The decision never scrolls (spec 2026-09-11, V2): at a 440x760 panel with Details open, Approve and the target sit inside the body's viewport with no scroll.
  await page.setViewportSize({width:440,height:760});await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  {const bodyBox=await page.locator('.computer-body').boundingBox();
  for(const id of ['computer-approve','computer-action-detail']){const box=await page.locator('#'+id).boundingBox();assert.ok(box&&box.y>=bodyBox.y-1&&box.y+box.height<=bodyBox.y+bodyBox.height+1,`#${id} spans ${Math.round(box?.y)}..${Math.round(box?.y+box?.height)} but the body shows ${Math.round(bodyBox.y)}..${Math.round(bodyBox.y+bodyBox.height)}; the decision and its target stay on screen without scrolling`);}}
  await page.setViewportSize({width:1440,height:1000});count++;
  await page.locator('#companion').screenshot({path:'.artifacts/computer-desktop.png'});
  // Approve: one act, then one local reading of the same window; acceptance and outcome are two different lines; then the next step is planned and waits.
  const plannedBefore=planned.length;
  await page.locator('#computer-approve').click();await page.waitForFunction(()=>document.querySelector('#computer-history').children.length===1);assert.equal(actions,1);assert.equal(await page.locator('#computer-count').innerText(),'1 action');assert.ok(await page.locator('#computer-done').isVisible());
  await page.waitForFunction(()=>/Step 2 of 20/.test(document.querySelector('#computer-step-label').textContent));assert.equal(planned.length,plannedBefore+1,'one plan after Approve, no second action');assert.equal(actions,1);
  const afterApprove=nativeOps.slice(nativeOps.lastIndexOf('act')-1);assert.deepEqual(afterApprove.slice(0,3),['status','act','snapshot'],'one act, then one reading, then the next plan');
  assert.ok(await page.locator('#computer-outcome').isVisible());assert.equal(await page.locator('#computer-outcome-accepted').innerText(),'Windows accepted click · Seven.');assert.equal(await page.locator('#computer-outcome-text').innerText(),'Observed: 1 new · Display = 7.');
  assert.match(await page.locator('#computer-history li').last().innerText(),/Windows accepted the action\. Observed: 1 new · Display = 7\.$/);
  assert.equal(await page.locator('#computer-outcome-tree').isHidden(),true);await page.locator('#computer-outcome-details').click();assert.match(await page.locator('#computer-outcome-tree').innerText(),/READ AFTER THE ACTION · Calculator fixture · local, not sent\n[\s\S]*Text: Display = 7  #1\.9/);
  assert.match(await page.locator('#computer-status').innerText(),/^Nothing has executed\. Approve runs this one action, then plans the next\.$/);assert.ok(await page.locator('#computer-review').isVisible(),'the next proposal waits under the outcome');count++;
  await page.locator('#companion').screenshot({path:'.artifacts/computer-outcome.png'});
  // A reading that fails: the action is not retried, and the page says verification was unavailable instead of guessing.
  await page.locator('#computer-next').click();await page.waitForFunction(()=>/Step 3 of 20/.test(document.querySelector('#computer-step-label').textContent));assert.equal(await page.locator('#computer-outcome').isHidden(),true,'a plan pressed by hand clears the last outcome');
  failRead=true;await page.locator('#computer-approve').click();await page.waitForFunction(()=>document.querySelector('#computer-history').children.length===2);assert.equal(actions,2,'one act per approval, none replayed');
  assert.match(await page.locator('#computer-outcome-text').innerText(),/^Verification was unavailable\. The window could not be read after the action/);assert.equal(await page.locator('#computer-outcome-details').isHidden(),true);
  await page.waitForFunction(()=>/Step 4 of 20/.test(document.querySelector('#computer-step-label').textContent));failRead=false;assert.equal(actions,2);count++;
  // Reject ends the loop: nothing is planned until Plan next action is pressed again.
  const plannedAtReject=planned.length;await page.locator('#computer-reject').click();await page.locator('#computer-review').waitFor({state:'hidden'});assert.equal(actions,2);assert.equal(planned.length,plannedAtReject,'no plan after Reject');assert.match(await page.locator('#computer-status').innerText(),/^Action rejected\. Nothing more is planned/);count++;
  // No window chosen: a plan is allowed, nothing is read, and the review says what would open.
  await page.locator('#computer-window').selectOption('');const snapshotsBefore=nativeOps.filter(o=>o==='snapshot').length;await page.locator('#computer-next').click();await page.locator('#computer-review').waitFor();
  assert.equal(nativeOps.filter(o=>o==='snapshot').length,snapshotsBefore,'no reading without a window');assert.match(await page.locator('#computer-action-title').innerText(),/^LAUNCH · notepad$/);assert.match(await page.locator('#computer-action-detail').innerText(),/Opens: notepad/);
  await page.locator('#computer-reject').click();await page.locator('#computer-review').waitFor({state:'hidden'});await page.locator('#computer-window').selectOption('1:2:3');count++;
  // Back keeps the lease; the conversation says so and Open returns to the screen.
  await page.locator('#computer-back').click();assert.ok(await page.locator('.companion-compose').isVisible());assert.match(await page.locator('#companion-goes-text').innerText(),/^Computer mode on/);assert.equal(armed,true);
  await page.locator('#companion-computer').click();assert.ok(await page.locator('#computer-work').isVisible());count++;
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.locator('#companion').screenshot({path:'.artifacts/computer-mobile.png'});count++;
  await page.locator('#computer-stop').click();await page.locator('#computer-work').waitFor({state:'hidden'});assert.equal(armed,false);assert.ok(await page.locator('.companion-compose').isVisible(),'Stop returns to the conversation');count++;
  assert.deepEqual(errors,[]);count++;
  console.log(`PASS: ${count} Computer UI checks; Set it up from Settings, lease dialog, the screen replacing the conversation, no tick, model from Settings, inspection, plain-words review with references behind Details, approve with a local read-back, an unavailable read-back without replay, reject, Back and Open, stop, mobile overflow and browser errors. ${actions} synthetic actions, ${planned.length} synthetic plans, ${nativeOps.length} synthetic native ops, no model charges.`);
}finally{await browser.close();await new Promise(r=>app.close(r));}
