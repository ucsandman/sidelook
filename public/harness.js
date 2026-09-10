// Shared plumbing for both surfaces: one status line, one consent sentence, one gate, one ledger.
// Pure functions first so tests/harness.test.mjs can import this file under node --test.
import {MODELS,LOCAL,PROVIDERS,choice,setLocalModels} from './models.js';
export {MODELS,LOCAL,PROVIDERS,choice};
export const MODEL_LABEL=Object.fromEntries(MODELS.map(m=>[m.id,m.label]));
export const ACCOUNT=Object.fromEntries(MODELS.map(m=>[m.id,PROVIDERS[m.provider].account]));
export const CLI=Object.fromEntries(MODELS.map(m=>[m.id,PROVIDERS[m.provider].cli]));
// The server's enumeration of the local runtimes joins the same maps, so every label below works for a local model too.
// The maps are mutated in place because both surfaces imported them by reference at load.
export function adoptLocalModels(list) {
  for(const stale of LOCAL) {delete MODEL_LABEL[stale.id];delete ACCOUNT[stale.id];delete CLI[stale.id];}
  for(const m of setLocalModels(list)) {MODEL_LABEL[m.id]=m.label;ACCOUNT[m.id]=PROVIDERS[m.provider].account;CLI[m.id]=PROVIDERS[m.provider].cli;}
  return LOCAL;
}
export const isLocal=model=>!!choice(model)?.local;
// Anthropic models can spend paid usage credits; the line names the chosen model. Null when the choice is subscription-only.
export const usesCredits=model=>!!choice(model)?.usageCredits;
export const billingLine=model=>usesCredits(model)?`${MODEL_LABEL[model]} can use paid usage credits on your Claude account.`:null;
// Where a send goes, in the words the manifest and the consent sentence share: a subscription through its CLI, or this computer.
export const goesTo=model=>isLocal(model)?`${ACCOUNT[model]} on this computer through ${CLI[model]}`:`your ${ACCOUNT[model] || ACCOUNT.astra} subscription through ${CLI[model] || CLI.astra}`;
export const ledger=[];

const list=items=>items.length<2?items.join(''):`${items.slice(0,-1).join(', ')} and ${items.at(-1)}`;
const destination=model=>isLocal(model)?`${MODEL_LABEL[model]} (${ACCOUNT[model]} on this computer)`:`${MODEL_LABEL[model] || MODEL_LABEL.astra} (your ${ACCOUNT[model] || ACCOUNT.astra} subscription)`;
const clock=value=>new Date(value).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});

// What Sidelook is doing right now, and what the sensors are doing. Both computed from live state, never from a literal at a call site.
export const activityLine=(v={})=>v.dictating?'Listening':v.thinking?'Thinking':v.capturing?'Choosing a frame':v.busy?`Building · ${v.elapsed || 0}s`:v.planning?'Planning the next action'
  :v.live?`Live build on · ${v.liveCount || 0} of 10 sent`:v.setupBusy?'Setting up':v.checking?'Checking connection':!v.token?'Reconnect in Settings':!v.configured?'Sign in through Settings'
  :v.remaining===0?'Allowance used · open Settings':v.agentRunning?'Agent mode on · Stop ends the run':v.computerOn?'Computer mode on · Ctrl+Shift+F12 stops it':'Ready';
// Sensor words come first. While the Screen on lease runs, the line says so with the countdown; dictation joins it rather than replacing it.
export const sensorLine=(v={})=>v.screenOn?`screen on · ${v.dictating?'mic on (local)':v.snapshots?'fresh screenshots':'following clicks'}${v.remaining?` · ${v.remaining}`:''}`
  :v.dictating?'mic on (local)':v.stream?v.captureKind==='screen'?'screen shared (local preview)':'camera on (local preview)':'screen & mic off';
// The panel's Send button says what goes. Attached means it goes; there is no tick.
export const sendLabel=(v={})=>v.frame && v.text?'Send with screenshot and text':v.frame?'Send with screenshot':v.text?'Send with window text':'Send';
// The studio's button says the same: the verb (a first build, or a revision of the selected version) and whether the attached frame goes.
export const buildLabel=(v={})=>`${v.version?`Revise ${v.version}`:'Build'}${v.frame?' with frame':''}`;
// activity[ · attachment] · sensor, for the studio's status line.
export function statusLine(v={}) {
  const activity=activityLine(v),sensor=sensorLine(v);
  const parts=[activity];
  if(activity==='Ready' && v.frameAttached && v.textAttached) parts.push('1 frame and window text attached');
  else if(activity==='Ready' && v.frameAttached) parts.push('1 frame attached');
  else if(activity==='Ready' && v.textAttached) parts.push('window text attached');
  parts.push(sensor);
  return parts.join(' · ');
}

// One sentence describing exactly what the next press sends.
export function consentLine(v={}) {
  const to=destination(v.model);
  if(v.surface==='computer') return `Send this task and a fresh reading of ${v.windowTitle || 'the chosen window'} to ${to}.`;
  if(v.surface==='build') {
    if(v.live) return `Live build on: changed snapshots of the shared window go to ${MODEL_LABEL[v.model] || MODEL_LABEL.astra} automatically, up to 10, under the permission you gave. Pause stops it.`;
    const items=['this direction'];
    if(v.frame) items.push('the attached frame');
    if(v.hasSource) items.push('the current prototype source');
    return `Send ${list(items)} to ${to}.`;
  }
  const items=['this message'];
  if(v.earlier) items.push(`the ${v.earlier} earlier message${v.earlier===1?'':'s'}`);
  if(v.frame) items.push('the attached frame');
  if(v.text) items.push('the window text');
  return `Send ${list(items)} to ${to}.`;
}

// Refusal text, or null when the press may go out. Order: the words, the connection, the allowance.
// On every surface the button is the consent: Send and Build say what goes, Plan next action names the window whose reading goes. No tick anywhere.
export function gate(v={}) {
  if(v.surface==='build' && v.direction!==undefined && !String(v.direction).trim()) return 'Tell Sidelook what should work first.';
  if(!v.configured || !v.token) return 'Open Settings and connect your subscription first.';
  if(v.remaining===0) return 'Your local allowance is used up. Open Settings, then Start new allowance.';
  return null;
}

export function record(entry) {
  ledger.push({at:new Date().toISOString(),ok:entry.ok!==false,...entry});
  return ledger.length;
}
export const sentCount=(entries=ledger)=>entries.filter(entry=>entry.ok!==false).length;

export function renderGate(root,view) {
  if(!root) return;
  const line=root.querySelector('.consent-line'),billing=root.querySelector('.billing');
  if(line) line.textContent=consentLine(view);
  if(billing) {const text=billingLine(view.model);billing.textContent=text || '';billing.hidden=!text;}
}

export function renderPreview(dialog,manifest,entries=ledger) {
  if(!dialog) return;
  const title=dialog.querySelector('#send-preview-title'),fields=dialog.querySelector('#send-preview-list'),body=dialog.querySelector('#send-preview-body'),rows=dialog.querySelector('#send-ledger'),empty=dialog.querySelector('#send-ledger-empty');
  if(title) title.textContent=manifest?.title || 'What goes with the next send';
  if(fields) fields.replaceChildren(...(manifest?.fields || []).flatMap(([label,value])=>{const dt=document.createElement('dt');dt.textContent=label;const dd=document.createElement('dd');dd.textContent=value;return [dt,dd];}));
  if(body) body.textContent=manifest?.body?JSON.stringify(manifest.body,null,1):'';
  if(rows) rows.replaceChildren(...entries.map(entry=>{const li=document.createElement('li');li.textContent=`${clock(entry.at)} · ${entry.surface==='build'?'studio build':entry.surface==='computer'?'computer plan':entry.surface==='agent'?'agent run':'message'} · ${MODEL_LABEL[entry.model] || entry.model || 'Astra'} · ${entry.effort || 'medium'}${entry.ok===false?` · ${entry.outcome==='stopped'?'stopped':'refused'}, nothing reached the model`:` · ${entry.frame?'frame sent':'no frame'}${entry.text?' · window text sent':''}${Number.isFinite(entry.remaining)?` · ${entry.remaining} left`:''}`}`;if(entry.ok===false)li.className='refused';return li;}));
  if(empty) empty.hidden=entries.length>0;
}
