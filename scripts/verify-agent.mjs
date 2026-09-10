import assert from 'node:assert/strict';
import {createApp} from '../server.mjs';
import {AppError} from '../lib/vision.mjs';
import {browserTools} from './browser.mjs';
import {createRun,appendEvent,transition,planEffect,updateEffect,addApproval,resolveApproval,finish,snapshot,TERMINAL} from '../lib/agent/run.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve,ms));
const plural = (n,word) => `${n} ${word}${n===1?'':'s'}`;
// Mirrors public/agent.js's summaryLine(): plurals, then the refusal counts (only the ones above zero) appended.
const summaryLine = s => {
  const w = s.writes,a = s.approvals;
  const parts = [plural(s.apps,'app'),plural(s.toolCalls,'tool call'),`${w.executed} of ${w.planned} write${w.planned===1?'':'s'} executed`,
    `${w.verified} verified`,plural(a.required,'approval'),plural(s.duplicates,'duplicate side effect'),`${s.unresolved} unresolved`];
  const refusals = [['blocked',w.blocked],['rejected',w.rejected],['expired',w.expired],['verification unavailable',w.verificationUnavailable],['state uncertain',w.uncertain]]
    .filter(([,n]) => n > 0).map(([label,n]) => `${n} ${label}`);
  return refusals.length ? `${parts.join(' · ')} · ${refusals.join(', ')}` : parts.join(' · ');
};

// A scripted runtime standing in for lib/agent/index.mjs's AgentRuntime: it speaks the same op surface server.mjs calls
// (health, create, get, list, watch, answer, approve, reject, cancel, stopAll) and builds every run through the real
// pure state model in lib/agent/run.mjs, so the snapshots the page renders are the same shape the real loop would emit.
function createFakeRuntime() {
  const entries = new Map();
  const createCalls = [];
  const cancelCalls = [];
  const entry = runId => { const e = entries.get(runId); if (!e) throw new AppError('That run is not active. Refresh the list.',404,'RUN_NOT_FOUND'); return e; };
  const notify = e => { for (const watcher of e.watchers) { try { watcher(snapshot(e.run)); } catch { e.watchers.delete(watcher); } } };

  async function script(e) {
    appendEvent(e.run,{kind:'model',status:'started',label:'Understanding request',detail:'Reading the goal and choosing the first tool.'});notify(e);await wait(70);if(e.cancelled) return;
    appendEvent(e.run,{kind:'tool',app:'slack',status:'verified',label:'Found cancellation request in Slack',detail:'Acme asked to cancel and be refunded.',evidence:{channel:'#support',permalink:'https://slack.example/archives/C1/p1'}});notify(e);await wait(70);if(e.cancelled) return;
    appendEvent(e.run,{kind:'tool',app:'stripe',status:'verified',label:'Matched acme.com to Stripe customer cus_demo',detail:'One match on domain.',evidence:{customerId:'cus_demo',domain:'acme.com'}});notify(e);await wait(70);if(e.cancelled) return;
    appendEvent(e.run,{kind:'tool',app:'stripe',status:'verified',label:'Found most recent eligible payment pi_demo $485.00',detail:'Refundable: yes.',evidence:{paymentId:'pi_demo',amountCents:48500}});notify(e);await wait(70);if(e.cancelled) return;
    transition(e.run,'executing','Starting the refund.');
    const effect = planEffect(e.run,{tool:'stripe.refund_payment',app:'stripe',opKey:'refund:pi_demo'});
    appendEvent(e.run,{kind:'write',app:'stripe',status:'pending',label:'Refund $485.00 pending',detail:'Waiting for a person to approve this refund.',effectId:effect.effectId});
    updateEffect(e.run,effect.effectId,{status:'pending_approval'});
    addApproval(e.run,{actionId:'act_demo1',effectId:effect.effectId,app:'stripe',operation:'Refund $485.00',entity:'Acme (cus_demo)',amount:'$485.00',currency:'usd',
      reason:'Acme asked for a refund of their most recent eligible payment.',
      sourceEvidence:[
        {label:'Slack request',value:'"please cancel and refund us"',source:'slack',ref:'https://slack.example/archives/C1/p1'},
        {label:'Stripe payment',value:'pi_demo $485.00, refundable',source:'stripe',ref:'pi_demo'}
      ],
      policyReason:'refunds need a human',riskScore:60,expiresAt:new Date(Date.now()+900000).toISOString()});
    transition(e.run,'waiting_for_approval','A refund needs a person.');notify(e);
  }
  async function continueAfterApproval(e) {
    const refund = e.run.effects.find(f => f.tool === 'stripe.refund_payment');
    await wait(60);if(e.cancelled) return;
    appendEvent(e.run,{kind:'write',app:'stripe',status:'ok',label:'Stripe refund created',detail:'Refund re_demo1 for $485.00.',effectId:refund.effectId,evidence:{refundId:'re_demo1'}});
    updateEffect(e.run,refund.effectId,{status:'executed',attempts:1,receipt:{id:'re_demo1',at:new Date().toISOString(),raw:{}}});notify(e);await wait(60);if(e.cancelled) return;
    appendEvent(e.run,{kind:'verify',app:'stripe',status:'verified',label:'Stripe refund verified',detail:'Refund status succeeded.',effectId:refund.effectId,evidence:{refundId:'re_demo1',status:'succeeded'}});
    updateEffect(e.run,refund.effectId,{status:'verified',verification:{at:new Date().toISOString(),verified:true,detail:'Refund status succeeded.'}});notify(e);await wait(60);if(e.cancelled) return;

    const hubspot = planEffect(e.run,{tool:'hubspot.update_customer',app:'hubspot',opKey:'update:contact_demo'});
    appendEvent(e.run,{kind:'write',app:'hubspot',status:'ok',label:'HubSpot customer updated',detail:'hs_lead_status set to Cancelled.',effectId:hubspot.effectId,evidence:{contactId:'contact_demo',property:'hs_lead_status',value:'Cancelled'}});
    updateEffect(e.run,hubspot.effectId,{status:'executed',attempts:1,receipt:{id:'contact_demo',at:new Date().toISOString(),raw:{}}});notify(e);await wait(60);if(e.cancelled) return;
    appendEvent(e.run,{kind:'verify',app:'hubspot',status:'verified',label:'HubSpot state verified',detail:'Read back matches.',effectId:hubspot.effectId,evidence:{property:'hs_lead_status',value:'Cancelled'}});
    updateEffect(e.run,hubspot.effectId,{status:'verified',verification:{at:new Date().toISOString(),verified:true,detail:'Read back matches.'}});notify(e);await wait(60);if(e.cancelled) return;

    appendEvent(e.run,{kind:'tool',app:'gmail',status:'ok',label:'Confirmation prepared',detail:'Draft to acme@acme.com.',evidence:{to:'acme@acme.com',subject:'Your refund'}});notify(e);await wait(60);if(e.cancelled) return;
    appendEvent(e.run,{kind:'policy',app:'dashclaw',status:'ok',label:'DashClaw content verification passed',detail:'Every fact traces to a verified source.'});notify(e);await wait(60);if(e.cancelled) return;

    const gmail = planEffect(e.run,{tool:'gmail.send_message',app:'gmail',opKey:'send:msg_demo'});
    appendEvent(e.run,{kind:'write',app:'gmail',status:'ok',label:'Gmail message sent',detail:'Sent to acme@acme.com.',effectId:gmail.effectId,evidence:{messageId:'msg_demo'}});
    updateEffect(e.run,gmail.effectId,{status:'executed',attempts:1,receipt:{id:'msg_demo',at:new Date().toISOString(),raw:{}}});notify(e);await wait(60);if(e.cancelled) return;
    appendEvent(e.run,{kind:'verify',app:'gmail',status:'verified',label:'Gmail message verified',detail:'Sent mail search found it.',effectId:gmail.effectId,evidence:{messageId:'msg_demo'}});
    updateEffect(e.run,gmail.effectId,{status:'verified',verification:{at:new Date().toISOString(),verified:true,detail:'Sent mail search found it.'}});notify(e);await wait(40);if(e.cancelled) return;

    // finish()'s message is the runtime's own closing line (run.closing, shown plain); the model's words are a
    // separate field the loop sets directly (run.finalMessage, shown only under "The agent said").
    e.run.finalMessage = 'Refunded Acme $485.00, updated HubSpot to Cancelled, and sent confirmation.';
    transition(e.run,'verifying','All writes verified.');
    finish(e.run,'completed','All writes finished.');
    notify(e);
  }

  return {
    createCalls,cancelCalls,
    async health() {
      return {apps:{
        slack:{configured:true,ok:true,detail:'Connected. Watching #support.'},
        stripe:{configured:true,ok:true,detail:'Test mode.',mode:'test'},
        hubspot:{configured:true,ok:false,detail:'Token expired. Reconnect in HubSpot.'},
        gmail:{configured:false,ok:false,detail:'GMAIL_REFRESH_TOKEN is not set.'},
        dashclaw:{configured:true,ok:true,detail:'6 policies installed.'}
      },policies:['refunds need a human','hold when the agent is unsure'],ready:true};
    },
    async list() { return [...entries.values()].map(e => ({runId:e.run.runId,goal:e.run.goal,status:e.run.status,createdAt:e.run.createdAt})).sort((a,b) => b.createdAt.localeCompare(a.createdAt)); },
    async get(runId) { return snapshot(entry(runId).run); },
    async create({goal,model,effort,windowTitle}) {
      if ([...entries.values()].some(e => !TERMINAL.has(e.run.status))) throw new AppError('A run is already in progress. Stop it or wait for it to finish.',409,'RUN_ACTIVE');
      createCalls.push({goal,model,effort,windowTitle});
      const run = createRun({goal,model,effort,windowTitle});
      transition(run,'planning','Reading the goal.');
      const e = {run,watchers:new Set(),cancelled:false};
      entries.set(run.runId,e);
      script(e).catch(() => {});
      return snapshot(run);
    },
    watch(runId,onSnapshot) {
      const e = entries.get(runId);if (!e) return null;
      e.watchers.add(onSnapshot);onSnapshot(snapshot(e.run));
      return () => e.watchers.delete(onSnapshot);
    },
    async answer(runId) { return snapshot(entry(runId).run); },
    async approve(runId,actionId) {
      const e = entry(runId);
      const approval = e.run.approvals.find(a => a.actionId === actionId);
      if (!approval) throw new AppError('No approval is waiting on this run.',409,'NO_PENDING_APPROVAL');
      if (approval.status !== 'pending') return {run:snapshot(e.run),approval,already:true};
      resolveApproval(e.run,actionId,'approved','sidelook');
      updateEffect(e.run,approval.effectId,{status:'claimed'});
      transition(e.run,'executing','Continuing after approval.');
      notify(e);
      continueAfterApproval(e).catch(() => {});
      return {run:snapshot(e.run),approval:e.run.approvals.find(a => a.actionId === actionId)};
    },
    async reject(runId,actionId) {
      const e = entry(runId);
      const approval = e.run.approvals.find(a => a.actionId === actionId);
      if (!approval) throw new AppError('No approval is waiting on this run.',409,'NO_PENDING_APPROVAL');
      if (approval.status !== 'pending') return {run:snapshot(e.run),approval,already:true};
      resolveApproval(e.run,actionId,'rejected','sidelook');
      updateEffect(e.run,approval.effectId,{status:'rejected'});
      appendEvent(e.run,{kind:'approval',app:approval.app,status:'rejected',label:'Refund rejected',detail:'A person rejected this refund.',actionId,effectId:approval.effectId});
      finish(e.run,'blocked','The refund was rejected, so nothing else ran.');
      notify(e);
      return {run:snapshot(e.run),approval:e.run.approvals.find(a => a.actionId === actionId)};
    },
    async cancel(runId) {
      // Like the real runtime: cancel marks the run and hands back the pre-terminal snapshot; the terminal state
      // (the write in flight finishing its verification step) arrives a tick later through the watcher, on the stream.
      cancelCalls.push(runId);
      const e = entry(runId);
      if (TERMINAL.has(e.run.status)) return snapshot(e.run);
      e.cancelled = true;
      const pending = snapshot(e.run);
      setTimeout(() => { if (!TERMINAL.has(e.run.status)) { finish(e.run,'cancelled','Stopped by the user.');notify(e); } },50);
      return pending;
    },
    async stopAll() {
      let stopped = 0;
      for (const e of entries.values()) if (!TERMINAL.has(e.run.status)) { e.cancelled = true;finish(e.run,'cancelled','Sidelook stopped.');stopped++; }
      return {stopped};
    }
  };
}

const runtime = createFakeRuntime();
const app = createApp({agent:runtime,vision:{status:async () => ({configured:true,cli:true})}});
await new Promise(r => app.listen(0,'127.0.0.1',r));
const {chromium} = browserTools();const browser = await chromium.launch({channel:'chrome',headless:true});const page = await browser.newPage({viewport:{width:1440,height:1000}});
const errors = [];page.on('pageerror',e => errors.push(e.message));let count = 0;
try {
  await page.goto(`http://127.0.0.1:${app.address().port}/?companion`);await page.waitForFunction(() => !document.getElementById('companion-send').disabled);
  assert.equal(await page.locator('#agent-mode').isVisible(),false,'Agent mode is not in the conversation');

  // Settings opens the screen, and Settings itself closes.
  await page.locator('#companion-settings').click();await page.locator('#agent-open').click();await page.locator('#agent-run').waitFor({state:'attached'});
  assert.equal(await page.locator('#agent-mode').isVisible(),true);assert.equal(await page.locator('#settings').evaluate(d => d.open),false,'Set it up leaves Settings');
  assert.equal(await page.locator('.companion-compose').isVisible(),false,'the screen replaces the conversation');count++;

  // The five indicators render from health: two accent (configured and ok), one warn (configured, not ok), one muted (unconfigured), and DashClaw itself.
  await page.waitForFunction(() => document.getElementById('agent-app-hubspot').className === 'agent-app warn');
  assert.equal(await page.locator('#agent-app-slack').getAttribute('class'),'agent-app accent');
  assert.equal(await page.locator('#agent-app-stripe').getAttribute('class'),'agent-app accent');
  assert.equal(await page.locator('#agent-app-hubspot').getAttribute('class'),'agent-app warn');
  assert.equal(await page.locator('#agent-app-gmail').getAttribute('class'),'agent-app muted');
  assert.equal(await page.locator('#agent-app-dashclaw').getAttribute('class'),'agent-app accent');
  assert.match(await page.locator('#agent-app-hubspot').getAttribute('title'),/Token expired/);count++;
  await page.locator('#companion').screenshot({path:'.artifacts/agent-desktop.png'});

  // The model line names the model chosen in Settings, live.
  await page.locator('#companion-settings').click();await page.locator('#model-choice').selectOption('fable');await page.locator('#settings-close').click();
  assert.equal(await page.locator('#agent-model-label').innerText(),'Fable 5.1');count++;

  // Start with an empty goal is refused locally; nothing is created.
  await page.locator('#agent-start-button').click();await page.getByText('Say what the agent should accomplish first.').waitFor();
  assert.equal(runtime.createCalls.length,0);count++;

  // Start posts create with consent (the server 403s without it, so a run only appears once it was included) and the model from Settings.
  const firstGoal = "Resolve Acme's cancellation request: refund the most recent eligible payment, update the CRM, and email them confirmation.";
  await page.locator('#agent-goal').fill(firstGoal);
  await page.locator('#agent-start-button').click();await page.locator('#agent-run').waitFor({state:'visible'});
  assert.deepEqual(runtime.createCalls,[{goal:firstGoal,model:'fable',effort:'medium',windowTitle:''}]);
  assert.equal(await page.locator('#agent-start').isVisible(),false,'the goal box steps aside while a run is active');count++;

  // Timeline rows appear as they stream: the verified reads carry a check mark, the write shows the pending line.
  await page.waitForFunction(() => document.getElementById('agent-timeline').textContent.includes('Found cancellation request'));
  const checkRowsSoFar = await page.locator('#agent-timeline .agent-glyph-verified').count();
  assert.ok(checkRowsSoFar >= 1,'a verified read renders a check mark while the run streams');
  await page.waitForFunction(() => document.getElementById('agent-timeline').textContent.includes('Refund $485.00 pending'));
  assert.equal(await page.locator('#agent-timeline .agent-glyph-verified').count(),3,'three verified reads render a check mark');
  assert.match(await page.locator('#agent-timeline').innerText(),/Refund \$485\.00 pending/);count++;

  // The approval card, with no checkbox and no <details> anywhere on the screen.
  await page.locator('#agent-approval').waitFor({state:'visible'});
  assert.equal(await page.locator('#agent-mode input[type=checkbox]').count(),0,'no tick anywhere on the screen');
  assert.equal(await page.locator('#agent-mode details').count(),0,'no details element either');
  const fields = await page.locator('#agent-approval-fields').innerText();
  assert.match(fields,/App\nstripe/);assert.match(fields,/Amount\n\$485\.00/);assert.match(fields,/Action id\nact_demo1/);
  assert.equal(await page.locator('#agent-approve').isVisible(),true);assert.equal(await page.locator('#agent-reject').isVisible(),true);count++;

  // Each source fact carries its ref as a second muted line, the Slack quote reads as data with a "from Slack" prefix,
  // and Decide by counts down from the approval's expiresAt on the same ticker.
  const evidenceText = await page.locator('#agent-approval-fields ul').innerText();
  assert.match(evidenceText,/Slack request: from Slack: "please cancel and refund us"/);
  assert.match(evidenceText,/https:\/\/slack\.example\/archives\/C1\/p1/);
  assert.match(evidenceText,/Stripe payment: pi_demo \$485\.00, refundable\npi_demo/);
  assert.match(await page.locator('#agent-decide-by').innerText(),/^Decide by \d{2}:\d{2}$/);count++;

  // Details is a button revealing the evidence, never a <details> arrow.
  const detailsButtons = page.locator('#agent-timeline .agent-reveal');
  await detailsButtons.first().click();
  assert.match(await page.locator('#agent-timeline pre').first().innerText(),/channel: #support/);count++;

  await page.locator('#companion').screenshot({path:'.artifacts/agent-approval.png'});

  // Approve continues to the summary; the numbers on the page equal run.summary.
  const firstRunId = runtime.createCalls.length === 1 ? (await runtime.list())[0].runId : null;
  await page.locator('#agent-approve').click();
  await page.waitForFunction(() => document.getElementById('agent-summary').offsetParent !== null,{timeout:10000});
  const finalRun = await runtime.get(firstRunId);
  const s = finalRun.summary;
  const summaryText = await page.locator('#agent-summary-line').innerText();
  assert.equal(summaryText,summaryLine(s));
  assert.equal(s.writes.planned,3);assert.equal(s.writes.executed,3);assert.equal(s.writes.verified,3);assert.equal(s.approvals.required,1);assert.equal(s.duplicates,0);assert.equal(s.unresolved,0);
  const effects = await page.locator('#agent-effects').innerText();assert.match(effects,/verified · stripe stripe\.refund_payment/);
  // run.closing (the runtime's own sentence) reads plain with no attribution; run.finalMessage (the model's words)
  // reads only under "The agent said". They are two different fields, rendered two different ways.
  assert.equal(await page.locator('#agent-closing').innerText(),'All writes finished.');
  assert.match(await page.locator('#agent-final').innerText(),/The agent said[\s\S]*Refunded Acme \$485\.00/);count++;
  await page.locator('#companion').screenshot({path:'.artifacts/agent-summary.png'});

  // A second run that is rejected ends blocked, with the rejection visible and the refusal counted on the summary line.
  await page.locator('#agent-start').waitFor({state:'visible'});
  await page.locator('#agent-goal').fill('Resolve a second, unrelated cancellation.');
  await page.locator('#agent-start-button').click();await page.locator('#agent-approval').waitFor({state:'visible'});
  const rejectedRunId = (await runtime.list())[0].runId;
  await page.locator('#agent-reject').click();
  await page.waitForFunction(() => document.getElementById('agent-status').textContent.trim() === 'blocked');
  assert.match(await page.locator('#agent-timeline').innerText(),/Refund rejected/);
  const rs = (await runtime.get(rejectedRunId)).summary;
  assert.equal(rs.writes.rejected,1,'the rejected write is on the ledger');
  assert.equal(await page.locator('#agent-summary-line').innerText(),summaryLine(rs));count++;

  // Stop during a run disables itself immediately (the run is still finishing its write in flight) and posts cancel;
  // the terminal status only lands once the fake runtime's watcher notifies it a tick later, proving the page picks the
  // terminal state up from the stream rather than the immediate (pre-terminal) response.
  await page.locator('#agent-start').waitFor({state:'visible'});
  await page.locator('#agent-goal').fill('A third run, stopped early.');
  await page.locator('#agent-start-button').click();await page.locator('#agent-run').waitFor({state:'visible'});
  const cancelsBefore = runtime.cancelCalls.length;
  await page.locator('#agent-stop').click();
  assert.equal(await page.locator('#agent-stop').isDisabled(),true,'Stop disables itself before the terminal snapshot arrives');
  await page.waitForFunction(() => document.getElementById('agent-status').textContent.trim() === 'cancelled');
  assert.equal(runtime.cancelCalls.length,cancelsBefore + 1);count++;

  // Back and Open keep the run.
  await page.locator('#agent-back').click();assert.equal(await page.locator('.companion-compose').isVisible(),true);assert.equal(await page.locator('#agent-mode').isVisible(),false);
  await page.locator('#companion-settings').click();await page.locator('#agent-open').click();await page.locator('#agent-run').waitFor({state:'visible'});
  assert.match(await page.locator('#agent-summary-line').innerText(),/apps ·/);count++;

  // Mobile width has no horizontal overflow.
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.locator('#companion').screenshot({path:'.artifacts/agent-mobile.png'});count++;

  assert.deepEqual(errors,[]);count++;
  console.log(`PASS: ${count} Agent mode UI checks; Set it up from Settings, five health indicators, the model line, an empty-goal refusal, Start with consent, streamed timeline rows, the DashClaw approval card with no tick and no details, source evidence refs and a Slack quote read as data, a Decide by countdown, Details revealing evidence, Approve to a summary matching run.summary with the runtime's closing line kept apart from the model's final words, Reject to blocked with its refusal counted on the summary line, Stop disabling itself immediately and the terminal state arriving on the stream, Back and Open keeping the run, mobile overflow and browser errors. ${runtime.createCalls.length} synthetic runs, ${runtime.cancelCalls.length} synthetic cancels, no model charges.`);
} finally { await browser.close();await new Promise(r => app.close(r)); }
