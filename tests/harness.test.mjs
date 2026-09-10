import test from 'node:test';
import assert from 'node:assert/strict';
import { statusLine, activityLine, sensorLine, sendLabel, buildLabel, consentLine, gate, record, ledger, sentCount } from '../public/harness.js';
import { families, chipsFor, captureFor, UNKNOWN_CHIPS } from '../public/chips.js';

test('status line never claims the sensors are off while something is on', () => {
  assert.equal(statusLine({token:'t',configured:true}),'Ready · screen & mic off');
  assert.equal(statusLine({token:'t',configured:true,frameAttached:true}),'Ready · 1 frame attached · screen & mic off');
  assert.equal(statusLine({token:'t',configured:true,textAttached:true}),'Ready · window text attached · screen & mic off');
  assert.equal(statusLine({token:'t',configured:true,frameAttached:true,textAttached:true}),'Ready · 1 frame and window text attached · screen & mic off');
  assert.equal(consentLine({surface:'chat',model:'astra',frame:true,text:true}),'Send this message, the attached frame and the window text to Astra (your ChatGPT subscription).');
  assert.equal(statusLine({token:'t',configured:true,stream:{},captureKind:'screen',busy:true,elapsed:42}),'Building · 42s · screen shared (local preview)');
  assert.equal(statusLine({token:'t',configured:true,stream:{},captureKind:'camera'}),'Ready · camera on (local preview)');
  assert.equal(statusLine({dictating:true}),'Listening · mic on (local)');
  assert.equal(statusLine({thinking:true,frameAttached:true}),'Thinking · screen & mic off');
  assert.equal(statusLine({token:'t',configured:true,computerOn:true}),'Computer mode on · Ctrl+Shift+F12 stops it · screen & mic off');
  assert.equal(statusLine({token:'t',configured:false}),'Sign in through Settings · screen & mic off');
  assert.equal(statusLine({token:'t',configured:true,remaining:0}),'Allowance used · open Settings · screen & mic off');
  assert.ok(statusLine({stream:{},captureKind:'screen'}).includes('screen shared'));
});

test('consent sentence names exactly what goes', () => {
  assert.equal(consentLine({surface:'chat',model:'astra'}),'Send this message to Astra (your ChatGPT subscription).');
  assert.equal(consentLine({surface:'chat',model:'astra',earlier:4}),'Send this message and the 4 earlier messages to Astra (your ChatGPT subscription).');
  assert.equal(consentLine({surface:'chat',model:'fable',earlier:4,frame:true}),'Send this message, the 4 earlier messages and the attached frame to Fable 5.1 (your Claude subscription).');
  assert.equal(consentLine({surface:'chat',model:'astra',earlier:1}),'Send this message and the 1 earlier message to Astra (your ChatGPT subscription).');
  assert.equal(consentLine({surface:'build',model:'astra'}),'Send this direction to Astra (your ChatGPT subscription).');
  assert.equal(consentLine({surface:'build',model:'astra',hasSource:true}),'Send this direction and the current prototype source to Astra (your ChatGPT subscription).');
  assert.equal(consentLine({surface:'build',model:'fable',frame:true,hasSource:true}),'Send this direction, the attached frame and the current prototype source to Fable 5.1 (your Claude subscription).');
  assert.match(consentLine({surface:'build',model:'fable',live:true}),/^Live build on: changed snapshots .* Fable 5\.1 automatically, up to 10/);
  assert.equal(consentLine({surface:'computer',model:'fable',windowTitle:'Calculator'}),'Send this task and a fresh reading of Calculator to Fable 5.1 (your Claude subscription).');
  assert.equal(consentLine({surface:'computer',model:'astra'}),'Send this task and a fresh reading of the chosen window to Astra (your ChatGPT subscription).');
});

test('gate refuses in order: words, connection, allowance; no surface has a tick, the button is the consent', () => {
  assert.equal(gate({surface:'build',direction:'  ',configured:true,token:'t'}),'Tell Sidelook what should work first.');
  assert.equal(gate({surface:'build',direction:'Build it',configured:true,token:'t',remaining:5}),null,'words plus a connection is enough; nothing to tick');
  assert.equal(gate({surface:'build',direction:'Build it',ticked:false,configured:true,token:'t',remaining:5}),null,'a stale ticked flag changes nothing');
  assert.equal(gate({surface:'chat',configured:true,token:'t',remaining:5}),null);
  assert.equal(gate({surface:'computer',configured:true,token:'t',remaining:5}),null);
  assert.equal(gate({surface:'chat',configured:false,token:'t'}),'Open Settings and connect your subscription first.');
  assert.equal(gate({surface:'chat',configured:true,token:'t',remaining:0}),'Your local allowance is used up. Open Settings, then Start new allowance.');
});

test('the Send button says what goes, and the header sensor line is computed apart from the activity', () => {
  assert.equal(sendLabel({}),'Send');
  assert.equal(sendLabel({frame:true}),'Send with screenshot');
  assert.equal(sendLabel({text:true}),'Send with window text');
  assert.equal(sendLabel({frame:true,text:true}),'Send with screenshot and text');
  assert.equal(sensorLine({}),'screen & mic off');
  assert.equal(sensorLine({dictating:true}),'mic on (local)');
  assert.equal(sensorLine({stream:{},captureKind:'screen'}),'screen shared (local preview)');
  assert.equal(sensorLine({screenOn:true,remaining:'9:42'}),'screen on · following clicks · 9:42');
  assert.equal(sensorLine({screenOn:true,snapshots:true,remaining:'9:12'}),'screen on · fresh screenshots · 9:12');
  assert.equal(sensorLine({screenOn:true,dictating:true,remaining:'9:42'}),'screen on · mic on (local) · 9:42');
  assert.equal(sensorLine({screenOn:false,dictating:true}),'mic on (local)');
  assert.equal(activityLine({thinking:true,frameAttached:true}),'Thinking');
  assert.equal(activityLine({token:'t',configured:true,computerOn:true}),'Computer mode on · Ctrl+Shift+F12 stops it');
  assert.equal(activityLine({token:'t',configured:true,agentRunning:true}),'Agent mode on · Stop ends the run');
  assert.equal(`${activityLine({token:'t',configured:true})} · ${sensorLine({})}`,statusLine({token:'t',configured:true}));
});

test('the Build button says the verb and whether the attached frame goes', () => {
  assert.equal(buildLabel({}),'Build');
  assert.equal(buildLabel({frame:true}),'Build with frame');
  assert.equal(buildLabel({version:'Version 02'}),'Revise Version 02');
  assert.equal(buildLabel({version:'Version 02',frame:true}),'Revise Version 02 with frame');
});

test('ledger counts responses in session order', () => {
  const before=ledger.length;
  assert.equal(record({surface:'chat',frame:true,model:'astra',effort:'medium',remaining:57}),before+1);
  assert.equal(ledger.at(-1).surface,'chat'); assert.ok(ledger.at(-1).at); assert.equal(ledger.at(-1).ok,true);
  record({surface:'chat',ok:false,outcome:'refused',model:'astra',effort:'medium'});
  assert.equal(sentCount(),sentCount(ledger)); assert.equal(sentCount(),ledger.filter(e=>e.ok).length); assert.equal(ledger.at(-1).ok,false);
});

test('chips come from the window family, error first, unknown falls back', () => {
  assert.deepEqual(families('Code','main.js - repo - Visual Studio Code'),['code']);
  assert.deepEqual(families('WindowsTerminal','npm ERR! failed'),['error','terminal']);
  assert.deepEqual(families('chrome','report.pdf - Google Chrome'),['browser','doc']);
  assert.deepEqual(families('','Setup - Something'),['settings']);
  assert.deepEqual(families('',''),['unknown']);
  assert.equal(chipsFor(families('WindowsTerminal','npm ERR! failed'))[0].id,'unstick');
  assert.equal(chipsFor(families('Code','Source Control - repo'),'Source Control - repo').some(c=>c.id==='commit'),true);
  assert.equal(chipsFor(families('Code','main.js'),'main.js').some(c=>c.id==='commit'),false);
  assert.equal(chipsFor(['unknown']),UNKNOWN_CHIPS);
  const unstick=chipsFor(families('WindowsTerminal','npm ERR! failed'))[0];
  assert.equal(captureFor(unstick,['error','terminal']),'frame'); assert.equal(captureFor(unstick,['error']),'text'); assert.equal(captureFor(chipsFor(['browser'])[0],['browser']),'frame');
  for(const list of [['code'],['browser'],['chat'],['sheet'],['doc'],['design'],['settings'],['terminal']]) assert.ok(chipsFor(list).length>=1 && chipsFor(list).length<=3);
});
