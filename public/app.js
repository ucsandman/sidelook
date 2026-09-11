import { loadProject, saveProject } from './storage.js';
import { LiveFrames } from './live.js';
import { initComputer } from './computer.js';
import { initAgent } from './agent.js';
import { initCompanion } from './companion.js';
import { gate, buildLabel, record, ledger, renderGate, renderPreview, MODEL_LABEL, ACCOUNT, MODELS, LOCAL, PROVIDERS, choice, usesCredits, billingLine, adoptLocalModels, isLocal, goesTo } from './harness.js';
import { DESIGN_CHIPS } from './chips.js';
import { createSession, selectionChange } from './session.js';

let launchKey = new URLSearchParams(location.hash.slice(1)).get('launch');
if (launchKey) history.replaceState(null,'',location.pathname+location.search);
try {
  if (launchKey && /^[a-f0-9]{64}$/.test(launchKey)) sessionStorage.setItem('sidelookLaunch',launchKey);
  else launchKey = sessionStorage.getItem('sidelookLaunch');
} catch { /* This tab can still work when browser storage is unavailable. */ }
const launchHeaders = () => launchKey ? {'X-Sidelook-Launch':launchKey} : {};

const $ = id => document.getElementById(id);
const state = { token:'', configured:false, stream:null, image:null, imageLabel:'', attached:false, observation:null,
  revisions:[], selected:null, busy:false, consent:false, recognition:null, controller:null, previewSequence:0, remaining:null, setupBusy:false, setupController:null, dictation:false, inputBusy:false,
  elapsed:0, computerOn:false, planning:false };
state.live=false; state.liveCount=0; state.captureKind=null; state.liveFrames=new LiveFrames(); state.liveTimer=null;
state.model='astra'; state.effort='medium'; state.checking=false;
let savedModel=null; // a saved local model is restored once the server has listed it, on the first handshake
try {
  const saved=JSON.parse(localStorage.getItem('sidelookModelPreferences') || localStorage.getItem('jarvisModelPreferences') || '{}'); // legacy key from 0.15 and earlier: read once, written back under the new name
  if (choice(saved.model)) state.model=saved.model; else if (typeof saved.model==='string' && saved.model.includes(':')) savedModel=saved.model;
  if (['low','medium','high','xhigh','max'].includes(saved.effort)) state.effort=saved.effort;
} catch { /* Preferences are optional when browser storage is unavailable. */ }
const selectedLabel = () => MODEL_LABEL[state.model];
const selectedAccount = () => ACCOUNT[state.model];
const selectedIsClaude = () => choice(state.model).provider==='anthropic';
const selectedIsLocal = () => isLocal(state.model);
const effortNotes = {low:'Faster, with lighter reasoning.',medium:'Balances speed and depth.',high:'More reasoning for complex changes.',xhigh:'Extra reasoning; expect a longer wait.',max:'Deepest reasoning; may take much longer and use more allowance.'};
const openSettings = () => { if (!$('settings').open) $('settings').showModal(); };
const notifyState = () => document.dispatchEvent(new Event('sidelook-state'));
// The selector lists the whole catalog, grouped by the CLI and account each model runs on. A model that lacks an effort greys it out;
// a saved effort the new model does not offer moves to that model's deepest level, and the note says so.
// Local runtimes get a group only while they hold a model; an empty runtime shows one disabled line saying how to fill it.
function renderModelChoice(runtimes={}) {
  $('model-choice').replaceChildren(...Object.entries(PROVIDERS).flatMap(([key,provider])=>{
    const entries=(provider.local?LOCAL:MODELS).filter(m=>m.provider===key);
    if(provider.local && !entries.length && !runtimes[key]?.up) return [];
    const group=document.createElement('optgroup');group.label=provider.local?`${provider.account} · on this computer through ${provider.cli}`:`${provider.label} · ${provider.account} through ${provider.cli}`;
    if(entries.length) group.append(...entries.map(m=>new Option(`${m.label} · ${provider.account}`,m.id)));
    else {const empty=new Option(`No chat model loaded in ${provider.account} yet`,'');empty.disabled=true;group.append(empty);}
    return [group];
  }));
  $('model-choice').value=state.model;
}
renderModelChoice();
function settleEffort() {
  const efforts=choice(state.model).efforts;
  for (const option of $('effort-choice').options) option.disabled=!efforts.includes(option.value);
  const moved=!efforts.includes(state.effort);
  if (moved) state.effort=efforts.at(-1);
  return moved;
}
function renderSelection() {
  const moved=settleEffort();
  $('faster-effort').hidden=state.effort==='low';
  $('model-choice').value=state.model; $('effort-choice').value=state.effort;
  $('effort-note').textContent=`${moved?`${selectedLabel()} goes up to ${$('effort-choice').selectedOptions[0].textContent.toLowerCase()} effort, so that is selected. `:''}${effortNotes[state.effort]} Applies to your next request.`;
  $('billing-note').textContent=billingLine(state.model) || (selectedIsLocal()?`${selectedLabel()} runs in ${selectedAccount()} on this computer. Nothing leaves this device for the model.`:`${selectedLabel()} uses your ${selectedAccount()} subscription.`);
  const claude=selectedIsClaude();
  $('install-title').textContent=claude?'Install official Claude Code?':'Install the official Codex CLI?';
  $('install-detail').textContent=claude?'Downloads the verified Claude Code runtime directly from Anthropic’s official npm package into Sidelook’s per-user tools folder. No terminal or administrator access is needed. Claude Code is subject to Anthropic’s terms. No model request is made during installation.':'Downloads the official @openai/codex package through npm and installs it globally on this device. No account or model request is made during installation.';
  $('confirm-install').textContent=claude?'Install Claude Code':'Install Codex';
  $('install-terms').hidden=!claude;
  $('setup-help').href=claude?'https://code.claude.com/docs/en/authentication':selectedIsLocal()?(choice(state.model).provider==='ollama'?'https://ollama.com/':'https://lmstudio.ai/'):'https://developers.openai.com/codex/auth';
  $('setup-detail').textContent=claude?'Sign-in opens Anthropic’s official browser flow and updates Claude Code login on this device. Installation downloads Claude Code into Sidelook’s own tools folder. Each action starts only when you choose it.':selectedIsLocal()?`${selectedAccount()} serves the model on this computer and Codex talks to it locally. Start server runs ${selectedAccount()}’s own command line; nothing is installed or signed in.`:'Sign-in opens the official browser flow and updates Codex login on this device. Installing Codex adds its official npm package globally. Each action starts only when you choose it.';
}
const current = () => state.revisions.find(r => r.id === state.selected);
const showError = message => { $('error-text').textContent = message; $('error').hidden = false; };
const hideError = () => { $('error').hidden = true; };
const time = value => new Date(value).toLocaleTimeString([], { hour:'numeric', minute:'2-digit' });
const versionName = revision => `VERSION ${String(state.revisions.indexOf(revision)+1).padStart(2,'0')}`;
let draftHtml='',draftTimer=null,draftSequence=0,draftShown=true,draftLoading=false,draftSession=null;
function clearDraft() {
  const visible=!$('draft-controls').hidden;
  ++draftSequence;clearTimeout(draftTimer);draftTimer=null;draftHtml='';draftLoading=false;draftSession=null;
  $('draft-controls').hidden=true;$('draft-preview').hidden=true;$('draft-preview').removeAttribute('src');
  $('draft-code').textContent='';
  if(visible) {if(current()) $('preview').hidden=false;else $('preview-empty').hidden=false;}
}
function chooseDraft(show) {
  draftShown=show;$('draft-preview').hidden=!show;$('preview').hidden=show || !current();
  $('preview-empty').hidden=show || !!current();
  $('show-draft').setAttribute('aria-pressed',String(show));$('show-working').setAttribute('aria-pressed',String(!show));
}
async function refreshDraft() {
  draftTimer=null;
  if(!state.busy || !draftHtml || draftLoading) return;
  const sequence=draftSequence,html=draftHtml;draftLoading=true;
  try {
    const result=await api('/api/preview',{html,draft:true,draftSession},state.controller?.signal);
    if(sequence!==draftSequence || !state.busy) return;
    $('draft-preview').src=result.url;
    $('draft-controls').hidden=false;$('show-working').disabled=!current();chooseDraft(draftShown);
  } catch { /* Final source validation and the existing working version are independent. */ }
  finally {
    if(sequence===draftSequence) {draftLoading=false;if(html!==draftHtml && state.busy) draftTimer=setTimeout(refreshDraft,700);}
  }
}
function buildProgress(event) {
  if(!state.busy || state.controller?.signal.aborted) return;
  if(event.type==='phase') {
    if(/^[a-f0-9]{40}$/.test(event.draftSession || '')) draftSession=event.draftSession;
    $('build-phase').textContent=event.phase==='connecting'?(selectedIsLocal()?`Connecting to ${selectedAccount()} on this computer`:'Connecting to your subscription'):event.phase==='loading'?`Loading ${selectedLabel()} into memory`:'Waiting for model output';
    if(event.phase==='waiting') $('build-detail').textContent=event.streaming?'The live draft will appear when HTML starts arriving. Reasoning happens before visible code.':'This Codex CLI returns completed messages. The preview will update as soon as it releases HTML; Anthropic models through Claude Code support incremental drafts.';
  }
  if(event.type!=='draft' || typeof event.html!=='string' || event.html.length>120000) return;
  draftHtml=event.html;$('draft-code').textContent=draftHtml;
  $('build-phase').textContent='Code arriving';$('build-message').textContent=`${selectedLabel()} is writing the page.`;
  $('draft-status').textContent=`Live draft · ${draftHtml.length.toLocaleString()} characters received · unfinished`;
  if(!draftTimer && !draftLoading) draftTimer=setTimeout(()=>{draftTimer=null;refreshDraft();},250);
}
$('show-draft').addEventListener('click',()=>chooseDraft(true));
$('show-working').addEventListener('click',()=>chooseDraft(false));

async function api(path, body, signal, keepalive=false) {
  if (['/api/build','/api/observe','/api/chat','/api/login','/api/install-codex'].includes(path)) body={...body,model:state.model,effort:state.effort};
  const response = await fetch(path,{ method:'POST',signal,keepalive,headers:{ ...launchHeaders(),'Content-Type':'application/json','X-Sidelook-Session':state.token,...(path==='/api/build'?{Accept:'application/x-ndjson'}:{}) },body:JSON.stringify(body) });
  let data;
  if(response.headers.get('content-type')?.includes('application/x-ndjson')) {
    const reader=response.body.getReader(),decoder=new TextDecoder();let pending='',received=0;
    try {
      while(true) {
        const {value,done}=await reader.read();if(done) break;
        received+=value.length;if(received>32_000_000) throw new Error('The build stream exceeded its size limit.');
        pending+=decoder.decode(value,{stream:true});let end;
        while((end=pending.indexOf('\n'))>=0) {
          const line=pending.slice(0,end);pending=pending.slice(end+1);if(!line.trim()) continue;
          const event=JSON.parse(line);
          if(event.type==='result' || event.type==='error') data=event;else buildProgress(event);
        }
      }
    } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
    if(!data) throw new Error('The build connection ended before a complete result arrived. Your saved versions are safe.');
  } else data=await response.json();
  if (Number.isFinite(data.remaining)) { state.remaining = data.remaining; renderBudget(); }
  if (!response.ok || data.type==='error') { const error = new Error(data.error || 'The request could not be completed.'); error.code = data.code; throw error; }
  return data;
}
function textElement(tag, text, className) {
  const node = document.createElement(tag); node.textContent = text;
  if (className) node.className = className;
  return node;
}
const buildGateView = () => ({ surface:'build', model:state.model, frame:state.attached && !!state.image, hasSource:!!current(), live:state.live });
function updateControls() {
  const controls = ['share-screen','build','connect','upload','example','file','new-session','camera-select','clear-reference','resume','mic','try-demo','frame-remove','use-frame'];
  controls.forEach(id => { $(id).disabled = state.busy || state.setupBusy || state.inputBusy || (!state.token && id === 'build'); });
  $('build').disabled = state.live || state.busy || state.setupBusy || state.inputBusy || state.checking || !state.configured || !state.token || state.remaining === 0;
  for (const id of ['model-choice','effort-choice','faster-effort']) $(id).disabled=state.live || state.busy || state.setupBusy || state.inputBusy;
  $('mic').disabled = state.busy || state.setupBusy || !state.token || !state.dictation;
  $('mic').title = state.dictation ? 'Dictate direction locally' : 'Local dictation is available on Windows after connection';
  for (const id of ['login','install-codex','recheck','reset-budget']) $(id).disabled = state.busy || state.setupBusy || state.checking;
  $('direction').disabled = state.busy || state.setupBusy;
  document.querySelectorAll('#rail-chips .chip').forEach(button => { button.disabled = state.busy || state.setupBusy; });
  for (const id of ['connect','share-screen','upload','example','file','try-demo','new-session','resume','clear-reference']) $(id).disabled ||= state.live;
  $('live-start').disabled=state.busy || state.setupBusy || state.inputBusy || state.checking || !state.configured || !state.token || state.remaining===0 || state.captureKind!=='screen' || !state.stream;
  $('live-start').hidden=state.live; $('live-pause').hidden=!state.live;
  $('live-interval').disabled=state.live || state.busy;
  $('live-controls').dataset.active=String(state.live);
  $('live-count').textContent=`${state.liveCount} / 10 builds`;
  document.querySelectorAll('.revision').forEach(b => { b.disabled = state.busy || state.inputBusy; });
  $('build-overlay').hidden = !state.busy;
  $('source').disabled = !current(); $('download').disabled = !current();
  if (!state.busy) $('activity').textContent = current() ? `${versionName(current()).replace('VERSION','Version')} ready` : 'Ready';
  $('reply-status').textContent = state.busy ? 'Working' : current() ? 'Version ready' : 'Standing by';
  renderAttachment();
  notifyState();
}
function clearObservations() {
  state.observation = null; $('annotations').replaceChildren(); $('observations').replaceChildren();
  $('observation-time').textContent = 'No frame sent yet';
  $('observation-summary').textContent = 'I’ll read the details, connect them to your direction, and build from there.';
  $('understanding').hidden = true;
}
// A chosen image (an upload, the sample, a still taken with Use this frame, the panel's screenshot) is attached; a restored saved frame is shown, not attached.
function setImage(image,label,attach=true) {
  clearObservations(); state.image = image; state.imageLabel = label;
  $('reference').src = image; $('reference').hidden = false; $('camera').hidden = true;
  $('camera-empty').hidden = true; $('frame-label').hidden = false; $('frame-label').textContent = label;
  $('frame-tools').hidden = false; $('resume').hidden = !state.stream;
  $('source-status').textContent = 'Selected frame';
  state.attached = attach; renderAttachment();
}
// Sharing shows a live preview and attaches nothing.
function liveView() {
  state.image = null; state.imageLabel = ''; clearObservations();
  $('reference').hidden = true; $('reference').removeAttribute('src'); $('frame-label').hidden = true; $('frame-tools').hidden = true;
  $('camera').hidden = !state.stream; $('camera-empty').hidden = !!state.stream;
  $('source-status').textContent = state.stream ? state.captureKind==='screen' ? 'Screen shared · local preview' : 'Camera on · local only' : 'Camera off';
  state.attached = false; renderAttachment();
}
function stopCamera() {
  pauseLive('Sharing stopped. No new snapshots will be sent.');
  state.captureKind=null; $('live-controls').hidden=true;
  state.stream?.getTracks().forEach(track => track.stop()); state.stream = null;
  $('camera').srcObject = null; $('camera-controls').hidden = true; $('resume').hidden = true;
  if (!state.image) liveView();
  else $('source-status').textContent='Saved frame · not sharing';
  updateControls();
}
async function startCamera(deviceId) {
  if (state.inputBusy) return;
  hideError(); state.inputBusy = true; updateControls();
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access needs localhost and a supported browser. You can upload a reference instead.');
    stopCamera();
    state.stream = await navigator.mediaDevices.getUserMedia({ video:deviceId ? { deviceId:{ exact:deviceId },width:{ ideal:1920 },height:{ ideal:1080 } } : { width:{ ideal:1920 },height:{ ideal:1080 },facingMode:'environment' }, audio:false });
    state.captureKind='camera';
    $('camera').srcObject = state.stream; await $('camera').play();
    state.stream.getVideoTracks()[0].addEventListener('ended',() => { stopCamera(); showError('The camera disconnected. Reconnect it or upload a reference.'); });
    liveView(); $('camera-controls').hidden = false;
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
    $('camera-select').replaceChildren(...devices.map((d,i) => { const option = textElement('option',d.label || `Camera ${i+1}`); option.value = d.deviceId; return option; }));
    $('camera-select').value = state.stream.getVideoTracks()[0].getSettings().deviceId;
  } catch (error) {
    stopCamera();
    showError(error.name === 'NotAllowedError' ? 'Camera access was declined. Allow it in your browser or upload a reference.'
      : error.name === 'NotReadableError' ? 'The camera is busy. Close the other app using it or upload a reference.' : error.message);
  } finally { state.inputBusy = false; updateControls(); }
}
function showSharedScreen() {
  if(state.captureKind!=='screen' || !state.stream) return;
  state.image=null;state.imageLabel='';
  $('camera').hidden=false; $('reference').hidden=true; $('annotations').replaceChildren();
  $('frame-tools').hidden=true; $('frame-label').hidden=true; $('camera-empty').hidden=true;
  $('source-status').textContent=state.live?'Live build on · screen shared':'Screen shared · local preview';
}
function pauseLive(message='Paused. No new snapshots will be sent.') {
  const wasLive=state.live;
  state.live=false; clearInterval(state.liveTimer); state.liveTimer=null;
  if(wasLive) state.controller?.abort();
  $('live-status').textContent=message; updateControls();
  if(state.captureKind==='screen') $('source-status').textContent='Screen shared · local preview';
}
async function startScreen() {
  let adopted=false;
  if(state.inputBusy || state.busy || state.live) return;
  hideError(); state.inputBusy=true; updateControls();
  try {
    if(!navigator.mediaDevices?.getDisplayMedia) throw new Error('Screen sharing is unavailable in this browser. Use desktop Chrome or Edge, or upload an image.');
    // Must remain directly within the user's click activation, before any await.
    const pending=navigator.mediaDevices.getDisplayMedia({video:{frameRate:{ideal:5,max:10}},audio:false,selfBrowserSurface:'exclude',surfaceSwitching:'exclude',systemAudio:'exclude'});
    const stream=await pending;
    stopCamera(); state.stream=stream; state.captureKind='screen';adopted=true;
    state.stream.getAudioTracks().forEach(track=>track.stop());
    const track=stream.getVideoTracks()[0];
    track.addEventListener('ended',()=>{if(state.stream===stream) stopCamera();});
    track.addEventListener('mute',()=>pauseLive('Screen capture is unavailable. Resume only when the shared window is visible again.'));
    $('camera').srcObject=stream; await $('camera').play();
    state.consent=false; state.liveCount=0; liveView(); $('live-controls').hidden=false;
    $('live-status').textContent='Sharing locally. No automatic frames sent.';
    if(!$('direction').value.trim()) $('direction').value='Build a working web prototype from my shared design. Apply visible changes while preserving existing functionality.';
  } catch(error) {
    if(adopted) stopCamera();
    showError(error.name==='NotAllowedError'?'Screen sharing was canceled or declined. Nothing new is shared.':error.message);
  } finally {state.inputBusy=false;updateControls();}
}
const liveCanvas=document.createElement('canvas');liveCanvas.width=160;liveCanvas.height=90;
const liveContext=liveCanvas.getContext('2d',{willReadFrequently:true});
async function inspectScreen() {
  if(!state.live || state.captureKind!=='screen' || !state.stream) return;
  const track=state.stream.getVideoTracks()[0];
  if(track.readyState!=='live' || track.muted) {pauseLive('Screen capture stopped. Share your window again to continue.');return;}
  if(!$('camera').videoWidth || !$('camera').videoHeight) return;
  liveContext.drawImage($('camera'),0,0,160,90);
  const pixels=liveContext.getImageData(0,0,160,90).data;
  const now=Date.now(),interval=Number($('live-interval').value);
  const verdict=state.liveFrames.inspect(pixels,now,interval);
  if(state.busy) { $('live-status').textContent='Build in progress. Watching locally; only the newest settled frame can go next.';return; }
  if(state.liveCount>=10 || !state.configured || state.remaining===0) {pauseLive('Live build paused. Check your allowance and Settings before starting again.');return;}
  if(!$('direction').value.trim()) {pauseLive('Add a direction before starting Live build again.');return;}
  $('live-status').textContent={unchanged:'Watching locally. No meaningful change to send.',drawing:'Changes detected. Waiting for you to pause drawing…',cooldown:`Waiting between builds. Next eligible in ${Math.ceil((interval-(now-state.liveFrames.lastSent))/1000)}s.`,ready:'Sending one changed screen snapshot.'}[verdict];
  if(verdict!=='ready' || state.inputBusy || state.setupBusy || state.checking || state.recognition) return;
  state.liveFrames.accept(pixels,now);state.liveCount++;
  await beginBuild(true);
}
$('share-screen').addEventListener('click',startScreen);
$('screen-stop').addEventListener('click',stopCamera);
$('live-pause').addEventListener('click',()=>pauseLive());
$('live-start').addEventListener('click',()=>{
  if(state.captureKind!=='screen' || !state.stream || state.busy || !state.configured) return;
  $('live-consent-detail').textContent=`Automatic snapshots go to ${selectedLabel()} through ${goesTo(state.model)}, at least ${Number($('live-interval').value)/1000} seconds apart. ${usesCredits(state.model)?`${selectedLabel()} can automatically consume paid Claude usage credits.`:'Each build uses your subscription allowance.'}`;
  $('live-dialog').showModal();
});
$('live-confirm').addEventListener('click',()=>{
  $('live-dialog').close();
  if(state.captureKind!=='screen' || !state.stream || state.busy || !state.configured || state.setupBusy || state.checking) return;
  state.consent=true;state.live=true;state.liveCount=0;state.liveFrames=new LiveFrames();
  showSharedScreen();updateControls();
  $('live-status').textContent='Live build on. Waiting for a settled frame.';
  state.liveTimer=setInterval(()=>inspectScreen().catch(()=>pauseLive('Live build paused. The screen frame could not be read.')) ,1000);
});
function imageFromElement(element) {
  const w = element.videoWidth || element.naturalWidth, h = element.videoHeight || element.naturalHeight;
  if (!w || !h) throw new Error('The image is not ready. Give it a moment and try again.');
  const scale = Math.min(1,1600/Math.max(w,h));
  const canvas = document.createElement('canvas'); canvas.width = Math.round(w*scale); canvas.height = Math.round(h*scale);
  canvas.getContext('2d').drawImage(element,0,0,canvas.width,canvas.height);
  return canvas.toDataURL('image/jpeg',.86);
}
async function loadImageUrl(url,label) {
  state.inputBusy = true; updateControls();
  try {
    const img = new Image(); img.src = url;
    await img.decode(); setImage(imageFromElement(img),label);
  } finally { state.inputBusy = false; updateControls(); }
}
function renderObservations(observation,stamp) {
  state.observation = observation;
  $('understanding').hidden = false;
  $('observation-summary').textContent = observation.summary;
  $('observation-time').textContent = `From the frame sent at ${time(stamp)}`;
  $('observations').replaceChildren(...observation.observations.map((item,i) => {
    const li = document.createElement('li'), copy = document.createElement('div');
    copy.append(textElement('strong',item.label),textElement('p',item.detail));
    li.append(textElement('span',String(i+1).padStart(2,'0'),'index'),copy); return li;
  }));
  positionAnnotations();
}
function positionAnnotations() {
  const img = $('reference');
  if (!state.observation || img.hidden || !img.naturalWidth) return;
  const w = $('viewfinder').clientWidth, h = $('viewfinder').clientHeight;
  const scale = Math.min(w/img.naturalWidth,h/img.naturalHeight);
  const layer = $('annotations');
  Object.assign(layer.style,{ width:`${img.naturalWidth*scale}px`, height:`${img.naturalHeight*scale}px`,left:`${(w-img.naturalWidth*scale)/2}px`,top:`${(h-img.naturalHeight*scale)/2}px` });
  layer.replaceChildren(...state.observation.observations.map((item,i) => {
    const node = document.createElement('div'); node.className = 'annotation';
    const [x,y,width,height] = item.box;
    Object.assign(node.style,{ left:`${x*100}%`,top:`${y*100}%`,width:`${width*100}%`,height:`${height*100}%` });
    node.append(textElement('span',`${String(i+1).padStart(2,'0')} ${item.label}`)); return node;
  }));
}
async function persist() {
  try { await saveProject({ revisions:state.revisions,selected:state.selected }); }
  catch(error) { showError(error.message); }
}
function renderHistory() {
  $('revision-count').textContent = state.revisions.length ? `${state.revisions.length} saved version${state.revisions.length === 1 ? '' : 's'} · on this device` : 'Every build keeps the previous version.';
  $('revisions').replaceChildren(...state.revisions.map((revision,i) => {
    const button = document.createElement('button'); button.className = 'revision'; button.type = 'button';
    button.setAttribute('aria-current',String(revision.id === state.selected));
    button.setAttribute('aria-label',`Open version ${i+1}: ${revision.title}`); button.disabled = state.busy;
    button.append(textElement('span',`${String(i+1).padStart(2,'0')} / ${revision.title}`),textElement('small',`${time(revision.created)} · ${revision.referenceUsed === false ? 'typed revision' : revision.image ? 'visual reference' : 'typed direction'}`));
    button.addEventListener('click',() => { selectRevision(revision.id,true).catch(e => showError(e.message)); }); return button;
  }));
  if (!state.revisions.length) $('revisions').append(textElement('p','Your first version starts with an idea.','revision-empty'));
}
async function selectRevision(id,restoreEvidence = false) {
  const revision = state.revisions.find(r => r.id === id); if (!revision) return;
  const sequence = ++state.previewSequence;
  state.selected = id;
  $('preview').hidden = true; $('preview-empty').hidden = true;
  $('version-label').textContent = 'Source available';
  renderRevision(revision); renderHistory(); updateControls();
  $('preview-note').textContent = 'Source available. Loading preview…';
  $('retry-preview').hidden = false;
  if (restoreEvidence) {
    if (revision.image) { setImage(revision.image,`Saved reference · ${time(revision.created)}`,false); }
    else { liveView(); }
    if (revision.observation) renderObservations(revision.observation,revision.created);
  }
  await persist();
  if (!state.token) { $('preview-note').textContent = 'Source available. Reconnect to load the preview.'; return; }
  try {
    const result = await api('/api/preview',{ html:revision.html });
    if (sequence !== state.previewSequence) return;
    await loadPreview(result.url);
    if (sequence !== state.previewSequence) return;
    $('preview').hidden = false; $('retry-preview').hidden = true;
    $('preview-note').textContent = revision.demo ? 'Working example · sample data · not a new AI build' : 'Interactive prototype · resets when reopened';
    await markReady(revision);
  } catch(error) {
    if (sequence === state.previewSequence) {
      $('preview-note').textContent = 'Source available. Retry preview or download it.';
      showError(error.message);
    }
  }
}
async function loadPreview(url,signal) {
  const response = await fetch(url,{ signal:signal ? AbortSignal.any([signal,AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('The preview is unavailable. Your source is saved; choose Retry preview.');
  const frame = $('preview'); frame.hidden = true;
  await new Promise((resolve,reject) => {
    const cleanup = () => { clearTimeout(timer); frame.removeEventListener('load',loaded); signal?.removeEventListener('abort',aborted); };
    const loaded = () => { cleanup(); resolve(); };
    const aborted = () => { cleanup(); reject(new DOMException('Canceled','AbortError')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('The preview did not load. Select its saved version to retry.')); },15000);
    frame.addEventListener('load',loaded,{ once:true });
    signal?.addEventListener('abort',aborted,{ once:true });
    if (signal?.aborted) return aborted();
    frame.src = url;
  });
}
function renderRevision(revision) {
  $('prototype-title').textContent = revision.title;
  $('preview-note').textContent = 'Interactive prototype · resets when reopened';
  $('reply-text').textContent = revision.reply;
  $('changes').replaceChildren(...revision.changes.map(change => textElement('li',change)));
}
async function markReady(revision) {
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  if (state.selected === revision.id) { $('version-label').textContent = versionName(revision); updateControls(); }
}
function stopSpeech() {
  window.chrome?.webview?.postMessage({type:'stop-speaking'});
  window.speechSynthesis?.cancel();
}
function say(text) {
  if (!$('companion-spoken').checked) return;
  if (window.chrome?.webview) { window.chrome.webview.postMessage({type:'speak',text}); return; }
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  const voices = speechSynthesis.getVoices();
  utterance.voice = voices.find(v => v.localService && /en-(US|GB)/i.test(v.lang)) || voices.find(v => v.localService && /^en/i.test(v.lang)) || null;
  // Use a local voice only; avoid introducing a second cloud audio provider.
  if (!utterance.voice) { showError('No local English voice is available. Replies remain visible as text.'); return; }
  utterance.rate = 1.02; utterance.pitch = .92; speechSynthesis.speak(utterance);
}
// Exactly what beginBuild() posts, minus the frame's bytes, for the preview dialog.
function buildManifest() {
  const image = state.attached && state.image ? state.imageLabel : null;
  const parent = current();
  return { title:`What goes with ${$('build-label').textContent}`, fields:[
    ['Direction',$('direction').value.trim() || '(nothing typed yet)'],['Frame',image || 'none'],
    ['Prototype source',parent ? `${versionName(parent)} · ${parent.html.length.toLocaleString()} characters` : 'none'],
    ['Model',`${selectedLabel()} · ${state.effort}`],['Goes to',goesTo(state.model)]],
    body:{ image:image ? `<frame: ${image}>` : null, instruction:$('direction').value.trim(), previous:parent ? `<${versionName(parent)} source>` : '', consent:true, model:state.model, effort:state.effort } };
}
async function beginBuild(automatic=false) {
  if (state.live && !automatic) return;
  if (state.busy || state.setupBusy || state.inputBusy || state.checking) return;
  hideError();
  const direction = $('direction').value.trim();
  if (!direction) { showError('Tell Sidelook what should work first, such as “Build a task board.”'); $('direction').focus(); return; }
  if (!state.configured || !state.token) { openSettings(); showError('Check the selected model in Settings, then try again.'); return; }
  if (state.remaining === 0) { openSettings(); showError('Choose Start new allowance in Settings. This does not renew your provider subscription allowance.'); return; }
  // The button is the consent: it says what goes, and the line under the box names it. Only Live build takes a still on its own, under its own permission.
  if (!automatic) {
    const refusal = gate({ surface:'build', direction, configured:state.configured, token:state.token, remaining:state.remaining });
    if (refusal) { showError(refusal); $('direction').focus(); return; }
    state.consent = true;
  } else if (!state.consent) return;
  try {
    if (automatic) setImage(imageFromElement($('camera')),`Screen snapshot · ${time(Date.now())}`);
  } catch(error) { showError(error.message); return; }
  clearDraft();draftShown=true;
  state.busy = true; $('cancel').disabled = false; stopDictation(); stopSpeech();
  state.controller = new AbortController(); const controller = state.controller;
  let completed=false;
  const parent = current();
  const image = state.attached ? state.image : null;
  const previous = parent?.html || '', created = new Date().toISOString(), started = Date.now();
  $('build-phase').textContent = image ? 'Reading and building' : previous ? 'Revising your application' : 'Building your application';
  $('build-overlay').dataset.provider=choice(state.model).provider;
  $('build-message').textContent = `${selectedLabel()} is ${selectedIsClaude() ? 'grinding' : 'thinking'}.`;
  if (image) { $('sent-image').src=image; $('sent-label').textContent=`Last frame sent · ${time(created)} · ${selectedLabel()}`; $('sent-evidence').hidden=false; }
  if (automatic) showSharedScreen();
  $('build-detail').textContent = image ? 'One selected frame, one model turn. Observations and the prototype arrive together. This can take several minutes.' : 'Using your direction and selected source. No image is sent. This can take several minutes.';
  $('build-elapsed').textContent = '0s elapsed · up to 5 minutes';
  state.elapsed = 0;
  const elapsedTimer = setInterval(() => {
    const elapsed = Math.floor((Date.now()-started)/1000); state.elapsed = elapsed;
    $('activity').textContent = `${selectedLabel()} · ${state.effort} · ${elapsed}s`;
    $('build-elapsed').textContent = `${elapsed}s elapsed · ${Math.max(0,300-elapsed)}s until timeout`;
    if (state.controller===controller && !draftHtml) {
      $('build-message').textContent=elapsed<20 ? `${selectedLabel()} is ${selectedIsClaude() ? 'grinding' : 'thinking'}.` : elapsed<60 ? 'Your idea is in motion.' : 'Still working on this version.';
      if(elapsed>=20) $('build-detail').textContent=elapsed<60 ? 'Waiting for the model’s result. You can keep trying the current prototype.' : 'No result yet. Complex builds can take several minutes. Cancel anytime; your saved versions stay here.';
    }
    notifyState();
  },1000);
  updateControls(); $('activity').textContent = `${selectedLabel()} · ${state.effort} · 0s`;
  let sent = false;
  try {
    const built = await api('/api/build',{ image,instruction:direction,previous,consent:true },controller.signal);
    if (controller.signal.aborted) return;
    sent = true; record({ surface:'build', ok:true, frame:!!image, model:state.model, effort:state.effort, remaining:built.remaining });
    // A frame that went leaves the box and stays on the version as evidence. A refusal or a Stop keeps it attached to retry.
    if (image) { state.attached = false; renderAttachment(); }
    const observation = built.result.observation || (image ? null : parent?.observation) || null;
    const revision = { ...built.result,id:crypto.randomUUID(),image:image || parent?.image || null,referenceUsed:!!image,observation,instruction:direction,created,model:built.model,effort:built.effort || state.effort };
    clearDraft();
    // Accept and persist completed inference before attempting any preview work.
    state.revisions.push(revision); state.revisions = state.revisions.slice(-12); state.selected = revision.id;
    state.controller = null; $('cancel').disabled = true;
    renderRevision(revision); renderHistory(); await persist();
    if (!automatic) $('direction').value = '';
    if (observation && image) renderObservations(observation,created);
    $('build-phase').textContent = 'Source ready'; $('build-detail').textContent = 'Opening the preview. You can retry it without generating again.';
    await selectRevision(revision.id,!automatic);
    completed=true;
    $('provider-status').textContent = `${selectedLabel()} · ${state.effort}`;
    say(revision.reply);
  } catch(error) {
    if (error.name !== 'AbortError') {
      showError(error.message);
      if (['LOGIN_REQUIRED','CLI_MISSING','MODEL_UNAVAILABLE','SUBSCRIPTION_LIMIT','SESSION_LIMIT'].includes(error.code)) {
        openSettings(); $('setup-message').textContent = error.message;
      }
    }
  } finally {
    if (!sent) record({ surface:'build', ok:false, outcome:controller.signal.aborted ? 'stopped' : 'refused', frame:!!image, model:state.model, effort:state.effort, remaining:state.remaining });
    clearDraft();
    clearInterval(elapsedTimer); state.busy = false; state.controller = null; state.elapsed = 0;
    if(automatic && !completed) pauseLive('Live build paused after an interrupted build. Review the message, then start again.');
    if(automatic && state.live && state.liveCount>=10) pauseLive('10 builds complete. Start again when you want more updates.');
    if(automatic && state.live) { showSharedScreen(); $('live-status').textContent='Version ready. Watching locally for your next change.'; }
    updateControls(); renderHistory();
  }
}
function stopDictation() {
  state.recognition?.abort(); state.recognition = null;
  $('mic').setAttribute('aria-pressed','false'); renderAttachment(); notifyState();
}
async function startDictation() {
  if (state.recognition) { stopDictation(); return; }
  if (!$('companion-voice').checked) { openSettings(); $('advanced').open = true; $('companion-voice').focus(); showError('Allow local Windows dictation in Settings, then click the microphone.'); return; }
  stopSpeech();
  const recognition = new AbortController(); state.recognition = recognition;
  const base = $('direction').value.trim();
  $('mic').setAttribute('aria-pressed','true'); notifyState();
  try {
    const result = await api('/api/dictate',{ consent:true },recognition.signal);
    if (!recognition.signal.aborted) {
      if(result.text) $('direction').value = `${base ? `${base} ` : ''}${result.text}`.slice(0,4000);
      else showError('No speech was recognized. Try again or type your direction.');
    }
  } catch(error) { if(error.name !== 'AbortError') showError(error.message); }
  finally { if(state.recognition === recognition) stopDictation(); }
}

$('connect').addEventListener('click',() => startCamera());
$('camera-select').addEventListener('change',e => startCamera(e.target.value));
$('camera-off').addEventListener('click',stopCamera);
$('resume').addEventListener('click',liveView);
$('clear-reference').addEventListener('click',liveView);
$('upload').addEventListener('click',() => $('file').click());
$('file').addEventListener('change',async event => {
  const file = event.target.files?.[0]; if (!file) return;
  hideError();
  if (!['image/jpeg','image/png','image/webp'].includes(file.type) || file.size > 20000000) { showError('Choose a JPEG, PNG, or WebP under 20 MB.'); return; }
  const url = URL.createObjectURL(file);
  try { await loadImageUrl(url,'Uploaded · local'); }
  catch { showError('That image could not be opened. Try another file.'); }
  finally { URL.revokeObjectURL(url); event.target.value = ''; }
});
$('example').addEventListener('click',async () => {
  try { await loadImageUrl('/reference.svg','Sample sketch · not your camera'); $('direction').value = 'Build the app in this sketch. Make the task board work: add, move, complete, and search tasks. Use warm ivory, ink, and terracotta.'; }
  catch { showError('The sample sketch could not be opened.'); }
});
$('composer').addEventListener('submit',event => { event.preventDefault(); beginBuild(); });
$('direction').addEventListener('keydown',event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); beginBuild(); } });
$('build-preview').addEventListener('click',() => { renderPreview($('send-preview'),buildManifest(),ledger); $('send-preview').showModal(); });
$('cancel').addEventListener('click',() => { pauseLive('Paused. Your previous version is still here.'); state.controller?.abort(); $('reply-text').textContent = 'Canceled. Your previous version is still here.'; });
$('mic').addEventListener('click',startDictation);
$('dismiss-error').addEventListener('click',hideError);
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click',() => $(button.dataset.close).close()));
$('rail-chips').replaceChildren(...DESIGN_CHIPS.map(chip => { const button = textElement('button',chip.label,'chip'); button.type = 'button'; button.addEventListener('click',() => { if (!state.busy) { $('direction').value = chip.prompt; $('direction').focus(); } }); return button; }));
$('mobile-view').addEventListener('click',() => setViewport(true));
$('desktop-view').addEventListener('click',() => setViewport(false));
function setViewport(mobile) {
  $('preview').classList.toggle('mobile',mobile);
  for (const [id,active] of [['mobile-view',mobile],['desktop-view',!mobile]]) { $(id).classList.toggle('active',active); $(id).setAttribute('aria-pressed',String(active)); }
}
$('expand').addEventListener('click',() => { const expanded = document.querySelector('.stage').classList.toggle('expanded'); $('expand').setAttribute('aria-label',expanded ? 'Collapse preview' : 'Expand preview'); });
document.addEventListener('keydown',event => { if (event.key === 'Escape') { document.querySelector('.stage').classList.remove('expanded'); $('expand').setAttribute('aria-label','Expand preview'); setChat(false); } });
// F6 cycles the studio's panes (Direction, Reference, Stage, the panel column); Shift+F6 goes back. Focus lands on the pane's first control.
document.addEventListener('keydown',event => {
  if (event.key !== 'F6' || document.body.dataset.surface !== 'studio') return;
  const panes = ['.pane-direction','.pane-reference','.stage','#companion'].map(s => document.querySelector(s)).filter(el => el && el.offsetParent !== null);
  if (!panes.length) return; event.preventDefault();
  const at = panes.findIndex(p => p.contains(document.activeElement));
  const next = panes[(at + (event.shiftKey ? -1 : 1) + panes.length) % panes.length];
  (next.querySelector('textarea') || next.querySelector('button:not([disabled]):not([hidden]),select') || next).focus();
});
// Below 1180 the column cannot sit beside the studio, so Chat slides it over the right edge of the stage. Escape, ← Panel, and a window wide enough for the column all close it.
function setChat(open) { document.body.classList.toggle('chat-open',open); $('chat-toggle').setAttribute('aria-expanded',String(open)); }
$('chat-toggle').addEventListener('click',() => setChat(!document.body.classList.contains('chat-open')));
$('companion-back').addEventListener('click',() => setChat(false));
addEventListener('resize',() => { if (innerWidth > 1180) setChat(false); });
$('source').addEventListener('click',() => { if (!current()) return; $('source-code').textContent = current().html; $('source-dialog').showModal(); });
$('download').addEventListener('click',() => {
  const revision = current(); if (!revision) return;
  const url = URL.createObjectURL(new Blob([revision.html],{ type:'text/html' }));
  const link = document.createElement('a'); link.href = url; link.download = `${revision.title.toLowerCase().replace(/[^a-z0-9]+/g,'-').slice(0,60) || 'sidelook-prototype'}.html`;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url),10000);
});
$('new-session').addEventListener('click',() => { if (!state.busy) $('reset-dialog').showModal(); });
$('confirm-reset').addEventListener('click',async () => {
  if (state.busy) return;
  try {
    await saveProject({ revisions:[],selected:null });
    ++state.previewSequence; state.revisions = []; state.selected = null; stopDictation(); stopCamera(); liveView(); $('sent-evidence').hidden=true; $('sent-image').removeAttribute('src');
    $('preview').hidden = true; $('preview').removeAttribute('src'); $('preview-empty').hidden = false;
    $('prototype-title').textContent = 'Your next idea, running.'; $('version-label').textContent = 'No version yet';
    $('preview-note').textContent = 'A real preview will appear here.'; $('reply-text').textContent = 'A fresh page. Show me what’s next.';
    $('changes').replaceChildren(); $('direction').value = ''; $('source-code').textContent = '';
    $('retry-preview').hidden = true; $('reset-dialog').close(); renderHistory(); updateControls(); hideError();
  } catch(error) { showError(error.message); }
});
$('reference').addEventListener('load',positionAnnotations);
new ResizeObserver(positionAnnotations).observe($('viewfinder'));
window.addEventListener('pagehide',() => { state.controller?.abort(); stopCamera(); stopDictation(); stopSpeech(); });
document.addEventListener('visibilitychange',() => { if (document.hidden) stopDictation(); });

// The chip in the box is the attachment: attached means it goes, × removes it, and the button says whether it goes.
function renderAttachment() {
  if (!state.image) state.attached = false;
  const attached = state.attached && !!state.image;
  $('frame-chip').hidden = !attached;
  if (attached) { $('frame-chip-image').src = state.image; $('frame-chip-label').textContent = state.imageLabel; }
  else $('frame-chip-image').removeAttribute('src');
  // Use this frame takes one still from the live view, or attaches the saved frame again. Sharing alone attaches nothing.
  const locked = state.live || state.busy || state.setupBusy || state.inputBusy;
  $('frame-attach').hidden = locked || !((!!state.stream && !state.image) || (!!state.image && !attached));
  $('use-frame').textContent = state.image ? 'Attach this frame' : 'Use this frame';
  $('frame-remove').disabled = locked;
  $('build-label').textContent = buildLabel({ frame:attached, version:current() ? versionName(current()).replace('VERSION','Version') : '' });
  renderGate($('build-gate'),buildGateView());
}
function renderBudget() {
  $('budget').textContent = Number.isFinite(state.remaining) ? `${state.remaining} local requests left · your subscription limits still apply` : 'Local allowance unavailable';
}
const renderProviderStatus = () => { $('provider-status').textContent = state.configured ? `${selectedLabel()} · ${state.effort}` : 'Setup needed'; };
// Readiness runs on the orchestrator in session.js: the token lands first, the provider check starts at once, and a saved preview restores beside it.
const session = createSession({
  localSession: async () => {
    const local = await fetch('/api/local-session',{ signal:AbortSignal.timeout(3000),headers:launchHeaders() });
    if (!local.ok) throw new Error('Local connection unavailable. Open Sidelook from its desktop shortcut, then choose Reconnect.');
    return local.json();
  },
  providerSession: async ({ model,effort }) => {
    const response = await fetch('/api/session',{ signal:AbortSignal.timeout(17000),headers:{...launchHeaders(),'X-Sidelook-Model':model,'X-Sidelook-Effort':effort} });
    if (!response.ok) throw new Error('Could not connect to Sidelook. Reopen Sidelook, then choose Reconnect. Your saved source is available.');
    return response.json();
  },
  onLocal: connection => {
    state.token = connection.token; state.remaining = connection.remaining; state.dictation = connection.dictation;
    adoptLocalModels(connection.local?.models); renderModelChoice(connection.local?.runtimes);
    if (savedModel && choice(savedModel)) { state.model = savedModel; savedModel = null; renderSelection(); }
    updateControls(); renderBudget();
  },
  // Only a preview that is not already showing is restored; the source and Retry preview are there either way.
  restorePreview: () => { if (current() && ($('preview').hidden || !$('preview').src)) return selectRevision(state.selected); },
  onPreviewError: error => showError(error.message),
  onReady: session => {
    state.token = session.token; state.configured = session.configured; state.remaining = session.remaining; state.dictation = session.dictation;
    renderProviderStatus();
    $('provider-dot').classList.toggle('ready',session.configured); $('setup-dot').classList.toggle('ready',session.configured);
    $('setup-summary').textContent = session.configured ? `${selectedAccount()} connected` : 'Action needed';
    const cliName=selectedIsClaude()?'Claude Code':'Codex CLI', local=selectedIsLocal();
    $('cli-check').textContent = session.cli === false ? `Official ${cliName} needs installation.` : session.code==='CLI_UPDATE_REQUIRED' ? `Official ${cliName} needs updating.` : `Official ${cliName} is available.`;
    $('login-check').textContent = local ? (session.configured ? `${selectedAccount()} is running with ${selectedLabel()} available.` : session.code==='RUNTIME_DOWN' ? `${selectedAccount()} server is not running.` : `${selectedLabel()} is not in ${selectedAccount()}.`) : session.configured ? `Signed in with ${selectedAccount()}.` : `${selectedAccount()} subscription sign-in is needed.`;
    $('install-codex').hidden = session.cli !== false && session.code!=='CLI_UPDATE_REQUIRED';
    $('install-codex').textContent=`Install official ${cliName}`;
    // A local runtime that is down gets Start server in the sign-in slot (LM Studio only; Ollama is started by the user, and the message says so).
    $('login').hidden = session.configured || session.cli === false || session.code==='CLI_UPDATE_REQUIRED' || (local && (session.code!=='RUNTIME_DOWN' || choice(state.model).provider!=='lmstudio'));
    $('login').textContent=local?`Start ${selectedAccount()} server`:`Sign in with ${selectedAccount()}`;
    $('setup-message').textContent = session.reason || (local ? 'Ready. The model runs on this computer; nothing is sent to a subscription.' : 'Ready. Selected model access and subscription allowance are checked on each request.');
    if (!session.configured) openSettings();
  },
  onError: error => {
    state.configured = false;
    $('provider-status').textContent = 'Local connection unavailable';
    $('provider-dot').classList.remove('ready'); $('setup-dot').classList.remove('ready');
    $('setup-summary').textContent = 'Reconnect needed'; $('setup-message').textContent = error.message;
    showError(error.message);
  },
  onSettled: () => { state.checking=false; renderBudget(); updateControls(); renderAttachment(); }
});
async function refreshSession() {
  state.checking=true; state.configured=false; updateControls();
  $('recheck').disabled = true;
  await session.refresh({ model:state.model,effort:state.effort });
}
$('faster-effort').addEventListener('click',()=>{if(state.busy || state.live) return;$('effort-choice').value='low';$('effort-choice').dispatchEvent(new Event('change'));});
// A new model is checked against the provider again. A new effort is saved and shown at once: it rides on the next request, exactly as before, with nothing to probe.
for (const id of ['model-choice','effort-choice']) $(id).addEventListener('change',async()=>{
  if (state.busy || state.setupBusy) {renderSelection();return;}
  const change=selectionChange({model:state.model,effort:state.effort},{model:$('model-choice').value,effort:$('effort-choice').value});
  state.model=$('model-choice').value; state.effort=$('effort-choice').value; state.consent=false;
  renderSelection();
  try {localStorage.setItem('sidelookModelPreferences',JSON.stringify({model:state.model,effort:state.effort}));} catch { }
  if (change==='model') { hideError(); await refreshSession(); }
  else if (state.configured) renderProviderStatus();
});
async function setupAction(path) {
  if (state.setupBusy || state.busy || !state.token) return;
  state.setupBusy = true; state.setupController = new AbortController();
  $('cancel-setup').hidden = false;
  $('setup-message').textContent = path === '/api/login' ? (selectedIsLocal() ? `Starting the ${selectedAccount()} server on this computer.` : `Complete ${selectedAccount()} sign-in in the browser opened by the official CLI. This can take up to three minutes.`) : `Installing official ${selectedIsClaude()?'Claude Code':'Codex CLI'}. This can take up to three minutes.`;
  updateControls();
  try { await api(path,{ consent:true },state.setupController.signal); await refreshSession(); }
  catch(error) { $('setup-message').textContent = error.name === 'AbortError' ? 'Setup action canceled. Choose Check again to inspect the current state.' : error.message; }
  finally { state.setupBusy = false; state.setupController = null; $('cancel-setup').hidden = true; updateControls(); }
}
$('settings-open').addEventListener('click',openSettings);
$('model-menu').addEventListener('click',openSettings);
$('recheck').addEventListener('click',refreshSession);
$('reconnect').addEventListener('click',async () => { hideError(); await refreshSession(); });
$('login').addEventListener('click',() => setupAction('/api/login'));
$('install-codex').addEventListener('click',() => $('install-dialog').showModal());
$('confirm-install').addEventListener('click',() => { $('install-dialog').close(); setupAction('/api/install-codex'); });
$('cancel-setup').addEventListener('click',() => state.setupController?.abort());
// Start new allowance is a two-step press: the first relabels, the second posts. Any other click puts the label back.
let budgetArmed = false;
const disarmBudget = () => { budgetArmed = false; $('reset-budget').textContent = 'Start new allowance'; };
$('reset-budget').addEventListener('click',async event => {
  event.stopPropagation();
  if (!budgetArmed) { budgetArmed = true; $('reset-budget').textContent = 'Confirm: reset the local counter'; return; }
  disarmBudget();
  try { await api('/api/reset-budget',{ consent:true }); updateControls(); $('setup-message').textContent = 'Local allowance renewed. Your subscription allowance is unchanged.'; }
  catch(error) { showError(error.message); }
});
document.addEventListener('click',event => { if (budgetArmed && event.target !== $('reset-budget')) disarmBudget(); });
$('settings').addEventListener('close',disarmBudget);
$('retry-preview').addEventListener('click',() => selectRevision(state.selected));
$('frame-remove').addEventListener('click',() => { state.attached = false; if (state.image) $('source-status').textContent = 'Saved frame · not attached'; renderAttachment(); });
$('use-frame').addEventListener('click',() => {
  if (state.live || state.busy || state.inputBusy) return;
  hideError();
  try {
    if (state.image) { state.attached = true; $('source-status').textContent = 'Selected frame'; renderAttachment(); }
    else if (state.stream) setImage(imageFromElement($('camera')),`${state.captureKind==='screen' ? 'Screen snapshot' : 'Camera frame'} · ${time(Date.now())}`);
  } catch(error) { showError(error.message); }
});
$('direction').addEventListener('input',()=>{if(state.live) {state.liveFrames.sent=null;state.liveFrames.stableSince=Date.now();}});
$('try-demo').addEventListener('click',async () => {
  if (state.busy || state.inputBusy) return;
  hideError(); state.inputBusy = true; updateControls();
  try {
    const existing = state.revisions.find(r => r.demo);
    if (existing) { await selectRevision(existing.id,true); return; }
    const response = await fetch('/demo.html'); if (!response.ok) throw new Error('The working example could not load. Reconnect and try again.');
    const revision = { id:crypto.randomUUID(),demo:true,title:'DAYLIGHT · Working example',reply:'This is a built-in example with sample data, not a new AI build. Add a task, move it, then describe a change to make it yours.',changes:[],html:await response.text(),created:new Date().toISOString(),image:null,observation:null,referenceUsed:false };
    state.revisions.push(revision); state.revisions = state.revisions.slice(-12);
    await selectRevision(revision.id,true);
    $('prototype').scrollIntoView({ block:'nearest' });
  } catch(error) { showError(error.message); }
  finally { state.inputBusy = false; updateControls(); }
});
window.addEventListener('pagehide',() => state.setupController?.abort());
async function init() {
  renderSelection();
  updateControls();
  try {
    const project = await loadProject();
    state.revisions = Array.isArray(project.revisions) ? project.revisions.slice(-12).filter(r => r && typeof r.html === 'string' && typeof r.id === 'string' && typeof r.title === 'string' && Array.isArray(r.changes)) : [];
    if (state.revisions.length) await selectRevision(state.revisions.some(r => r.id === project.selected) ? project.selected : state.revisions.at(-1).id,true);
  } catch(error) { showError(error.message); }
  await refreshSession();
}
// The Computer mode and Agent mode screens live inside #companion in index.html; each init call queries static markup.
const computer=initComputer({api,getSelection:()=>({model:state.model,effort:state.effort,configured:state.configured,token:state.token,remaining:state.remaining}),onState:s=>{state.computerOn=s.on;state.planning=s.planning;notifyState();}});
const agent=initAgent({api,getSelection:()=>({model:state.model,effort:state.effort,configured:state.configured,token:state.token,remaining:state.remaining}),getState:()=>state,onState:s=>{state.agentOn=s.on;state.agentRunning=s.running;notifyState();}});
initCompanion({api,getState:()=>state,updateControls,
  stopWork:()=>{pauseLive('Paused from the companion.');state.controller?.abort();state.setupController?.abort();stopDictation();stopCamera();$('computer-stop')?.click();agent.stop();},
  openWorkflow:(kind,instruction='',evidence)=>{
    if(kind==='setup'){openSettings();return;}
    // A reply's "Let Sidelook do this" carries the task; the panel's "Open" carries none and keeps whatever was typed.
    if(kind==='computer'){if(instruction)$('computer-task').value=instruction.slice(0,2000);computer.open();return;}
    if(kind==='agent'){agent.open();return;}
    $('direction').value=instruction;if(evidence)setImage(evidence.image,evidence.label);else{state.attached=false;renderAttachment();}$('direction').focus();
  },
  importSource:async(html,name)=>{
    if(state.busy || state.live || state.setupBusy || state.inputBusy)throw new Error('Finish the current task before importing.');
    if(typeof html!=='string'||html.length>120000||!/<html[\s>]/i.test(html)||!/<\/html>/i.test(html))throw new Error('Choose a complete HTML document under 120 KB.');
    if(state.revisions.length>=12)throw new Error('This project already has 12 versions. Download your work and start a new project before importing.');
    const revision={id:crypto.randomUUID(),title:name.replace(/\.html?$/i,'').slice(0,100),reply:'Imported from your HTML file. The preview uses the same restricted sandbox as generated prototypes.',changes:['Imported source'],html,created:new Date().toISOString(),image:null,observation:null,referenceUsed:false};
    state.revisions.push(revision);await selectRevision(revision.id,true);
  }
});
init();
