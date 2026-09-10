import {activityLine,sensorLine,sendLabel,gate,record,ledger,renderPreview,MODEL_LABEL,usesCredits,isLocal,goesTo} from './harness.js';
import {families,chipsFor,captureFor,UNKNOWN_CHIPS,TONES} from './chips.js';
import {Follow} from './follow.js';
import {eyeOffset,eyeCenters} from './eyes.js';

// The mark's eyes look toward the cursor: in-page moves drive them here; when the pointer is outside the window the shell posts it (type 'cursor').
const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');
let lastLook=0;
function lookAt(cursor){
  for(const svg of document.querySelectorAll('.mark-live')){
    const r=svg.getBoundingClientRect();if(!r.width)continue;
    const eyes=svg.querySelectorAll('.eye');
    eyeCenters(eyeOffset({size:r.width,left:r.left,top:r.top,cursor,reducedMotion:reducedMotion.matches})).forEach(([x,y],i)=>{eyes[i].setAttribute('cx',x.toFixed(2));eyes[i].setAttribute('cy',y.toFixed(2));});
  }
}
document.addEventListener('mousemove',e=>{const now=performance.now();if(now-lastLook<40)return;lastLook=now;lookAt({x:e.clientX,y:e.clientY});});
lookAt(null);

// The panel. Its markup lives in index.html; this file only queries and wires it.
// One box, one button. Attached means it goes; the Send button says what goes; there is no tick.
export function initCompanion({api,getState,updateControls,openWorkflow,stopWork,importSource}) {
  const native=window.chrome?.webview;
  const host=document.getElementById('companion');
  const $=id=>document.getElementById('companion-'+id);
  const settings=document.getElementById('settings'),preview=document.getElementById('send-preview'),tone=document.getElementById('rewrite-tone');
  let history=[],frame=null,text=null,controller=null,dictation=null,capturing=false,reading=false,captureEpoch=0,captureRequest=null,front=null,chips=[],pendingRoute=null,quickAsk=false,copyButton=null;
  // What the next send would carry, against the server's own limit in lib/assistant.mjs: 12 messages of 2,000 characters.
  const CONTEXT_BUDGET=24000,COMPACT='Summarize the earlier messages of this conversation in under 150 words so the conversation can continue from the summary alone, as the reply, without markdown.';
  // The tokens the model reported: the last send, and this chat's running total. Cached input is counted beside each, never inside it. null means nothing has gone yet.
  let lastTokens=null,lastCached=0,chatTokens=0,chatCached=0,meterKey='';
  // boxHeight is a height the user dragged the box to with the grip; null means the box fits its text. postedHeight is the last panel height sent to the shell.
  let boxHeight=null,postedHeight=0;
  if(native)document.body.dataset.native='';
  // followRequest is the requestId of a follow-driven capture, so the fact "this was a follow capture" travels with the request and survives stop()/endFollow rather than living in a bare flag.
  // followTimer is the one deadline timer (capture due or lease end); followClock is the once-a-second countdown text. Neither runs the full render.
  const follow=new Follow();let followTimer=null,followClock=null,offNote='',followRequest=null;
  const post=value=>native?.postMessage(value);
  const error=message=>{$('error').textContent=message;$('error').hidden=!message;};
  const clock=value=>new Date(value).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});
  const kb=image=>`${Math.round(image.length*3/4/1024)} KB`;
  try {const savedTone=localStorage.getItem('sidelookTone') ?? localStorage.getItem('jarvisTone'); tone.value=savedTone in TONES?savedTone:'plainer';} catch {tone.value='plainer';} // legacy key from 0.15 and earlier: read once, written back under the new name
  tone.onchange=()=>{try{localStorage.setItem('sidelookTone',tone.value);}catch{}};
  function showSurface(next,notify=true) {
    document.body.dataset.surface=next==='studio'?'studio':'companion';
    $('bench').hidden=next==='studio';
    if(notify)post({type:'resize',mode:next==='studio'?'workbench':next==='dock'?'dock':'panel'});
    if(next==='companion')setTimeout(()=>$('input').focus(),100);
  }
  const currentFamilies=()=>front?families(front.process,front.title):['unknown'];
  const DESKTOP='desktop';
  const appName=()=>{if(front?.id===DESKTOP)return 'the desktop';const name=String(front?.process || '').replace(/\.exe$/i,'');return name?name[0].toUpperCase()+name.slice(1):'the window';};
  const readFront=value=>value && typeof value==='object' && typeof value.title==='string' && value.title.trim()?{title:value.title.trim().slice(0,200),process:String(value.process || '').slice(0,100),id:String(value.id || '').slice(0,32),icon:typeof value.icon==='string' && value.icon.length<=65536 && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value.icon)?value.icon:''}:null;
  const view=()=>{const s=getState();return {dictating:!!dictation || !!s.recognition,thinking:!!controller,capturing:capturing || reading,busy:s.busy,elapsed:s.elapsed,planning:s.planning,live:s.live,liveCount:s.liveCount,setupBusy:s.setupBusy,checking:s.checking,token:s.token,configured:s.configured,remaining:s.remaining,computerOn:s.computerOn,agentRunning:s.agentRunning,frameAttached:!!frame,textAttached:!!text,stream:s.stream,captureKind:s.captureKind,screenOn:follow.state.on,snapshots:follow.state.snapshots};};
  const running=v=>!!(v.dictating || v.thinking || v.capturing || v.busy || v.planning || v.live || v.setupBusy || v.agentRunning);
  // The attachment chips describe themselves from state, so the caption can never disagree with what goes.
  function renderStrips() {
    if(frame)$('frame-time').textContent=`Captured ${clock(frame.capturedAt)} · ${kb(frame.image)}${follow.state.on && follow.state.snapshots?' · replaces itself after each pause':''}`;
    if(text)$('text-volume').textContent=`${text.controls} controls · ${text.characters.toLocaleString()} characters${text.truncated?' · cut short':''}`;
  }
  // One line under the buttons: how full the context the next send would carry is, what the last send cost, and what this chat has cost.
  // It rewrites only when a number changes, so an idle panel stays still.
  const tokenWords=(count,cached,unit='')=>`${count.toLocaleString()}${unit}${cached?` (${cached.toLocaleString()} cached)`:''}`;
  const contextChars=()=>history.slice(-12).reduce((sum,message)=>sum+message.text.length,0);
  function renderMeter() {
    const percent=Math.round(contextChars()/CONTEXT_BUDGET*100);
    const key=`${percent}|${lastTokens}|${lastCached}|${chatTokens}|${chatCached}`;
    if(key===meterKey)return;
    meterKey=key;
    const value=document.createElement('span');value.textContent=`${percent}%`;if(percent>80)value.className='warn';
    $('meter').replaceChildren('Context ',value,lastTokens===null?' · no sends yet':` · last send ${tokenWords(lastTokens,lastCached,' tokens')} · this chat ${tokenWords(chatTokens,chatCached)}`);
  }
  // What the model reported this send cost. A reply without a count is counted as zero rather than guessed at.
  function countTokens(result) {
    lastTokens=Number(result.tokens) || 0;lastCached=Number(result.cachedTokens) || 0;
    chatTokens+=lastTokens;chatCached+=lastCached;
  }
  // A break in the conversation, on the list with the messages: what stays on screen is not what goes to the model.
  function divider(body) {
    const li=document.createElement('li');li.className='companion-divider';li.textContent=body;
    $('messages').append(li);while($('messages').children.length>24)$('messages').firstElementChild.remove();
    li.scrollIntoView({block:'end',behavior:'smooth'});
  }
  function render() {
    const s=getState(),locked=!!controller || !!dictation || s.busy || s.live || s.setupBusy || s.inputBusy;
    for(const id of ['clear','import','capture','remove','text-remove'])$(id).disabled=locked || capturing || reading;
    // Nothing to clear and nothing to summarize when the model would receive nothing.
    for(const id of ['clear-context','compact'])$(id).disabled=locked || capturing || reading || !history.length;
    host.querySelectorAll('.starter,.companion-followups button').forEach(button=>button.disabled=locked || capturing || reading);
    $('send').disabled=locked || s.checking || !s.configured || !s.token || s.remaining===0;
    // The button says what goes. With only words in the box it is the arrow alone; an attachment puts its name on the button.
    const label=sendLabel({frame:!!frame,text:!!text});$('send').textContent=label==='Send'?'↑':`${label} ↑`;$('send').setAttribute('aria-label',label);
    $('input').disabled=!!controller;
    $('mic').disabled=!!controller || s.busy || s.setupBusy || s.live || !s.dictation || !s.token;
    // The lease countdown goes only to sensorLine, in its own object; activityLine keeps reading the numeric allowance from v so "Allowance used" still shows while following.
    const v=view(),sensor=sensorLine(follow.state.on?{...v,remaining:follow.remaining()}:v),activity=activityLine(v),busy=running(v);
    $('status').textContent=sensor[0].toUpperCase()+sensor.slice(1);
    $('dot').className=sensor==='screen & mic off'?'':'on';
    $('sense').title=follow.state.on?'Stop following':'Let Sidelook follow your screen';
    $('note').textContent=offNote;$('note').hidden=!offNote;
    $('running').hidden=!busy;$('goes').hidden=busy;
    $('activity').textContent=activity;
    // The model in ink, the credits warning beside it when it applies; the account is in Settings and What goes.
    if(activity==='Ready'){const model=document.createElement('b');model.textContent=MODEL_LABEL[s.model];$('goes-text').replaceChildren(model,usesCredits(s.model)?' · may use paid credits':isLocal(s.model)?' · on this computer':'');}
    else $('goes-text').textContent=activity;
    $('computer').hidden=!s.computerOn;
    $('agent').hidden=!s.agentRunning;
    renderStrips();renderMeter();
    $('hide').hidden=!native;$('drag').disabled=!native;
    fitPanel();
  }
  // The box fits its text: one line at rest, a line more per line typed, eight lines at most, then it scrolls inside. A height dragged with the grip sticks until the box is emptied.
  function fitBox() {
    const input=$('input');
    if(boxHeight){input.style.height=`${boxHeight}px`;input.style.overflowY='auto';return;}
    input.style.height='auto';const wanted=Math.min(input.scrollHeight,168);input.style.height=`${wanted}px`;input.style.overflowY=input.scrollHeight>168?'auto':'hidden';
  }
  // The panel is as tall as its content. The page measures what it would need and tells the shell, which pins the bottom edge and moves the top; an open dialog counts too.
  function fitPanel() {
    if(!native || document.body.dataset.surface!=='companion')return;
    const dialog=[...document.querySelectorAll('dialog[open]')][0];
    const computerOn=host.classList.contains('computer'),agentOn=host.classList.contains('agent');
    // The scroll area flexes to the window, so its own height says nothing; its children do.
    const scroll=document.querySelector('.companion-scroll'),inner=[...scroll.children].reduce((sum,el)=>sum+el.offsetHeight,0)+14;
    const body=computerOn?document.getElementById('computer-mode').scrollHeight:agentOn?document.getElementById('agent-mode').scrollHeight:inner+document.querySelector('.companion-compose').offsetHeight;
    let height=Math.ceil(document.querySelector('.companion-header').offsetHeight+body+2);
    if(dialog)height=Math.max(height,dialog.scrollHeight+64);
    if(height===postedHeight)return;
    postedHeight=height;post({type:'resize',height});
  }
  // Numbered or bulleted replies become lists; everything else stays a paragraph. No Markdown parser.
  function renderText(container,body) {
    const lines=body.split('\n');
    const ordered=lines.filter(line=>/^\d+\.\s/.test(line)).length>=2,bullets=lines.filter(line=>/^-\s/.test(line)).length>=2;
    if(!ordered && !bullets){const p=document.createElement('p');p.textContent=body;container.append(p);return;}
    let listEl=null,para=[];
    const flush=()=>{const chunk=para.join('\n').trim();if(chunk){const p=document.createElement('p');p.textContent=chunk;container.append(p);}para=[];};
    for(const line of lines) {
      const item=ordered && /^\d+\.\s/.test(line)?['ol',line.replace(/^\d+\.\s/,'')]:bullets && /^-\s/.test(line)?['ul',line.replace(/^-\s/,'')]:null;
      if(item){flush();if(!listEl || listEl.tagName.toLowerCase()!==item[0]){listEl=document.createElement(item[0]);container.append(listEl);}const li=document.createElement('li');li.textContent=item[1];listEl.append(li);}
      else {listEl=null;para.push(line);}
    }
    flush();
  }
  // Write-only clipboard. "Copied" appears only after the shell or the browser confirms the write; a refusal is said out loud.
  function copied(ok,reason) {
    const button=copyButton;copyButton=null;
    if(ok){if(button){button.textContent='Copied';setTimeout(()=>{button.textContent='Copy';},1500);}return;}
    if(button)button.textContent='Copy';
    error(reason || 'The clipboard refused the text. Select the reply and copy it yourself.');
  }
  function copyText(value,button) {
    const body=String(value).slice(0,8000);copyButton=button;
    if(native){post({type:'copy',text:body});return;}
    if(!navigator.clipboard?.writeText){copied(false,'This browser has no clipboard access. Select the reply and copy it yourself.');return;}
    navigator.clipboard.writeText(body).then(()=>copied(true),()=>copied(false,'The browser refused the clipboard. Select the reply and copy it yourself.'));
  }
  // Evidence stays on the message it went with: a thumbnail in the bubble, named for screen readers, that opens the exact screenshot or text.
  function evidenceToggle(label,thumb,node) {
    const button=document.createElement('button');button.type='button';button.className='companion-evidence';button.append(thumb);button.setAttribute('aria-label',label);button.title=label;button.setAttribute('aria-expanded','false');
    node.hidden=true;button.onclick=()=>{node.hidden=!node.hidden;button.setAttribute('aria-expanded',String(!node.hidden));};
    return [button,node];
  }
  // No name labels: yours is a bubble on the right, Sidelook's is plain text.
  function addMessage(role,body,evidence,sentText) {
    const li=document.createElement('li');li.className='companion-message '+role;
    if(role==='user'){
      const bubble=document.createElement('div');bubble.className='companion-bubble';
      if(evidence){const thumb=document.createElement('img');thumb.src=evidence.image;thumb.alt='';const img=document.createElement('img');img.src=evidence.image;img.alt='Exact screenshot sent with this message';const [button,full]=evidenceToggle(`Screenshot sent · ${evidence.label}`,thumb,img);bubble.append(button);li.append(full);}
      if(sentText){const thumb=document.createElement('span');thumb.textContent='Aa';const pre=document.createElement('pre');pre.textContent=sentText.text;const [button,full]=evidenceToggle(`Text sent · ${sentText.title} · ${sentText.controls} controls${sentText.truncated?' · cut short':''}`,thumb,pre);bubble.append(button);li.append(full);}
      const p=document.createElement('p');p.textContent=body;bubble.append(p);li.prepend(bubble);
    } else {
      renderText(li,body);
      const copy=document.createElement('button');copy.type='button';copy.className='quiet companion-copy';copy.textContent='Copy';copy.onclick=()=>copyText(body,copy);li.append(copy);
    }
    $('messages').append(li);while($('messages').children.length>24)$('messages').firstElementChild.remove();
    slimDeck(true);li.scrollIntoView({block:'end',behavior:'smooth'});return li;
  }
  // Once there is a conversation the tile is one line above the box and the starters go; a new window in front brings them back.
  function slimDeck(slim) {
    $('deck').classList.toggle('slim',slim);$('deck').hidden=slim && !front;renderTile();
  }
  function renderFollowUps(reply,items) {
    const list=(items || []).filter(item=>typeof item==='string' && item.trim()).slice(0,3);
    if(!list.length)return;
    const wrap=document.createElement('div');wrap.className='companion-followups';
    for(const item of list){const button=document.createElement('button');button.type='button';button.textContent=item;button.onclick=()=>{$('input').value=item;$('input').focus();};wrap.append(button);}
    reply.append(wrap);
  }
  // Attached means it goes. A new capture replaces the old one; × removes it; a send that reached the model clears it.
  function setFrame(value) {
    frame=value;$('context').hidden=!value;
    if(value){$('frame').src=value.image;$('frame-label').textContent=value.label;}
    else $('frame').removeAttribute('src');
    render();
  }
  // The window's accessible text, every character shown before it can go, with an honest volume line.
  function setText(value) {
    text=value;$('text').hidden=!value;$('text-body').hidden=!value;
    if(value){$('text-label').textContent=`Text from ${value.title}`;$('text-body').textContent=value.text || '(no accessible text)';}
    else $('text-body').textContent='';
    render();
  }
  function afterCapture(ok) {
    const route=pendingRoute;pendingRoute=null;
    if(route==='build'){
      if(ok && frame){const direction=$('input').value.trim();$('input').value='';openWorkflow('build',direction,frame);showSurface('studio');}
      else error('No screenshot was taken, so nothing went to the studio. Try the button again.');
      quickAsk=false;return;
    }
    if(quickAsk){quickAsk=false;if(ok)setTimeout(()=>$('input').focus(),300);}
  }
  async function capture(keepError=false) {
    if(capturing || reading || controller)return;
    if(!keepError)error('');capturing=true;const epoch=++captureEpoch;render();
    if(native){captureRequest=crypto.randomUUID();post({type:'capture',requestId:captureRequest});return;}
    let stream,ok=false;
    try {
      stream=await navigator.mediaDevices.getDisplayMedia({video:true,audio:false});
      const video=document.createElement('video');video.muted=true;video.srcObject=stream;await video.play();
      const canvas=document.createElement('canvas'),scale=Math.min(1,1440/video.videoWidth);canvas.width=Math.round(video.videoWidth*scale);canvas.height=Math.round(video.videoHeight*scale);canvas.getContext('2d').drawImage(video,0,0,canvas.width,canvas.height);
      if(epoch===captureEpoch){setFrame({image:canvas.toDataURL('image/jpeg',.8),label:(stream.getVideoTracks()[0].label || 'Selected screen').slice(0,200),capturedAt:new Date().toISOString()});ok=true;}
    }catch(e){if(e.name!=='NotAllowedError')error('Screen capture is unavailable. Open the studio to upload an image or use a camera.');}
    finally{stream?.getTracks().forEach(track=>track.stop());if(epoch===captureEpoch){capturing=false;render();afterCapture(ok);}}
  }
  // Read the accessible text of the window that was in front. Read-only on the server: it never arms Computer mode. Returns false when nothing could be read.
  async function readText() {
    if(capturing || reading || controller)return false;
    if(!front){error('Summon Sidelook from the window you want read, then press the button again.');return false;}
    error('');reading=true;render();
    try {
      const result=await api('/api/computer',{op:'read',title:front.title,consent:true});
      setText({title:result.title,controls:result.controls,characters:result.characters,truncated:result.truncated===true,text:String(result.text || '')});
      return true;
    }catch(e){error(e.message);return false;}
    finally{reading=false;render();}
  }
  function speak(body) {
    if(!$('spoken').checked)return;
    if(native){post({type:'speak',text:body});return;}
    const voice=window.speechSynthesis?.getVoices().find(v=>v.localService && /^en/i.test(v.lang));
    if(!voice){error('No local English voice is available. The reply is shown above.');return;}
    speechSynthesis.cancel();const utterance=new SpeechSynthesisUtterance(body);utterance.voice=voice;speechSynthesis.speak(utterance);
  }
  function stop() {
    controller?.abort();dictation?.abort();post({type:'cancel-capture',requestId:captureRequest});captureEpoch++;capturing=false;captureRequest=null;pendingRoute=null;quickAsk=false;
    // A follow capture cancelled here never answers, so the reducer must not wait for it; the lease itself stays on.
    if(followRequest){followRequest=null;follow.failed();armFollow();}
    post({type:'stop-speaking'});window.speechSynthesis?.cancel();stopWork();render();
  }
  // The exact body submit() posts, and a description of it for the preview. Only the screenshot's bytes are elided from the preview.
  function requestBody() {
    const evidence=frame,read=text;
    const body={instruction:$('input').value.trim(),history:history.slice(-12),...(evidence?{image:evidence.image}:{}),...(read?{windowText:read.text,windowTextTruncated:read.truncated===true}:{}),...(evidence || read?{contextLabel:(evidence?evidence.label:read.title)}:{}),consent:true};
    return {body,evidence,read};
  }
  function manifest() {
    const s=getState();const {body,evidence,read}=requestBody();
    return {title:'What goes with the next send',fields:[
      ['Message',body.instruction || '(nothing typed yet)'],['Earlier messages',String(body.history.length)],
      ['Screenshot',evidence?`${evidence.label} · ${kb(evidence.image)} JPEG`:'none'],
      ['Window text',read?`${read.title} · ${read.controls} controls · ${read.characters.toLocaleString()} characters${read.truncated?' · cut short':''}`:'none'],
      ['Model',`${MODEL_LABEL[s.model]} · ${s.effort}`],['Goes to',goesTo(s.model)],
      ['Last send',lastTokens===null?'nothing has gone yet':`${tokenWords(lastTokens,lastCached,' tokens')}`],['This chat',lastTokens===null?'nothing has gone yet':`${tokenWords(chatTokens,chatCached,' tokens')}`]],
      body:{...body,model:s.model,effort:s.effort,...(evidence?{image:`<screenshot: ${evidence.label}>`}:{})}};
  }
  function showPreview() {renderPreview(preview,manifest(),ledger);preview.showModal();}
  async function submit() {
    const s=getState();if(controller || dictation || capturing || reading || s.busy || s.live || s.setupBusy || s.inputBusy)return;
    const instruction=$('input').value.trim();if(!instruction)return;
    const refusal=gate({surface:'chat',configured:s.configured,token:s.token,remaining:s.remaining});
    if(refusal){error(refusal);return;}
    error('');const request=new AbortController();controller=request;s.inputBusy=true;updateControls();render();
    const {body,evidence,read}=requestBody();
    const user=addMessage('user',instruction,evidence,read);
    // Only the response decides what happened: a send clears the box and its attachments, a refusal or a Stop keeps them here to retry.
    let outcome='refused';
    try {
      const result=await api('/api/chat',body,request.signal);
      if(request.signal.aborted){outcome='stopped';return;}
      outcome='sent';countTokens(result);record({surface:'chat',ok:true,frame:!!evidence,text:!!read,model:s.model,effort:s.effort,remaining:result.remaining,tokens:lastTokens,cachedTokens:lastCached});
      history.push({role:'user',text:instruction.slice(0,2000)},{role:'assistant',text:result.result.reply.slice(0,2000)});history=history.slice(-12);
      const reply=addMessage('assistant',result.result.reply);$('input').value='';boxHeight=null;fitBox();
      if(evidence)setFrame(null);if(read)setText(null);
      if(['build','computer'].includes(result.result.suggestion)){
        const button=document.createElement('button');button.type='button';button.className='companion-workflow';button.textContent=result.result.suggestion==='build'?'Build this in the studio':'Let Sidelook do this';
        // The studio gets the screenshot that went with this message, the one shown on it, and asks its own permission before any build.
        button.onclick=()=>{if(result.result.suggestion==='build')showSurface('studio');openWorkflow(result.result.suggestion,instruction,evidence);};reply.append(button);
      }
      renderFollowUps(reply,result.result.followUps);
      speak(result.result.reply);
    }catch(e){
      user.classList.add('interrupted');
      if(e.name==='AbortError'){outcome='stopped';error('Stopped. Your message is still here to edit or retry.');}
      else error(e.message);
    }
    finally{
      if(outcome!=='sent')record({surface:'chat',ok:false,outcome,frame:!!evidence,text:!!read,model:s.model,effort:s.effort,remaining:s.remaining});
      if(controller===request){controller=null;s.inputBusy=false;updateControls();render();}
    }
  }
  // Compact: one send that trades the earlier messages for a summary of them. Same gate, same Stop, same ledger as a message;
  // the summary is not a message, so the divider is the only thing that appears on screen.
  async function compact() {
    const s=getState();if(controller || dictation || capturing || reading || s.busy || s.live || s.setupBusy || s.inputBusy || !history.length)return;
    const refusal=gate({surface:'chat',configured:s.configured,token:s.token,remaining:s.remaining});
    if(refusal){error(refusal);return;}
    error('');const request=new AbortController();controller=request;s.inputBusy=true;updateControls();render();
    const before=contextChars();
    let outcome='refused';
    try {
      const result=await api('/api/chat',{instruction:COMPACT,history:history.slice(-12),consent:true},request.signal);
      if(request.signal.aborted){outcome='stopped';return;}
      outcome='sent';countTokens(result);record({surface:'chat',ok:true,frame:false,text:false,model:s.model,effort:s.effort,remaining:result.remaining,tokens:lastTokens,cachedTokens:lastCached});
      history=[{role:'assistant',text:`Summary of the earlier conversation: ${result.result.reply}`.slice(0,2000)}];
      divider(`Compacted: ${before.toLocaleString()} to ${contextChars().toLocaleString()} characters`);
    }catch(e){
      if(e.name==='AbortError'){outcome='stopped';error('Stopped. The conversation is unchanged.');}
      else error(e.message);
    }
    finally{
      if(outcome!=='sent')record({surface:'chat',ok:false,outcome,frame:false,text:false,model:s.model,effort:s.effort,remaining:s.remaining});
      if(controller===request){controller=null;s.inputBusy=false;updateControls();render();}
    }
  }
  async function dictate() {
    if(dictation){dictation.abort();return;}
    if(!$('voice').checked){if(!settings.open)settings.showModal();document.getElementById('advanced').open=true;$('voice').focus();error('Allow local Windows dictation in Settings, then click Mic. Audio is not sent to the model.');return;}
    error('');post({type:'stop-speaking'});window.speechSynthesis?.cancel();
    const request=new AbortController();dictation=request;const s=getState();s.inputBusy=true;updateControls();$('mic').setAttribute('aria-pressed','true');render();
    try{const result=await api('/api/dictate',{consent:true},request.signal);if(!request.signal.aborted){if(result.text)$('input').value=($('input').value+' '+result.text).trim().slice(0,4000);else error('No speech recognized. Try again or type your message.');}}
    catch(e){if(e.name!=='AbortError')error(e.message);}
    finally{if(dictation===request){dictation=null;s.inputBusy=false;updateControls();$('mic').setAttribute('aria-pressed','false');render();$('input').focus();}}
  }
  // The starters: chips chosen locally from the window that was in front at summon. Nothing is captured or read until a starter or Screenshot is pressed.
  const chipPrompt=chip=>chip.prompt.replace('{tone}',TONES[tone.value] || TONES.plainer);
  async function useChip(chip) {
    if(controller || capturing || reading)return;
    error('');$('input').value=chipPrompt(chip);fitBox();
    if(chip.route==='build'){pendingRoute='build';capture();return;}
    const take=captureFor(chip,currentFamilies());
    if(take==='text'){
      if(await readText()){$('input').focus();return;}
      // The read failed for a reason worth reading; keep it on screen and fall back to a screenshot.
      error(`${$('error').textContent} Taking a screenshot instead.`);capture(true);return;
    }
    if(take==='frame')capture();
    $('input').focus();
  }
  // The picker: every open window plus the whole desktop, from the shell, titles only. It replaces the starters until something is picked.
  function openPicker() {
    if(!native || capturing || reading || controller)return;
    $('targets').replaceChildren();$('front').setAttribute('aria-expanded','true');post({type:'windows'});
  }
  function closePicker() {$('targets').hidden=true;$('chips').hidden=false;$('front').setAttribute('aria-expanded','false');}
  const lease=document.getElementById('screen-lease');
  function openLease(){if(!native){error('Following clicks needs the Windows app.');return;}document.getElementById('screen-lease-note').textContent='';if(!lease.open)lease.showModal();}
  function startFollow(snapshots){lease.close();offNote='';post({type:'screen-on',snapshots});}
  function stopFollow(){post({type:'screen-off'});}
  // The page's clock for the lease. One timer waits for the next deadline the reducer names (a capture due after the quiet gap, or the lease end);
  // a separate once-a-second clock rewrites only the countdown text. A deadline that lands while the page is busy stays due and is taken by the next free tick.
  function armFollow(){
    clearTimeout(followTimer);followTimer=null;
    const wait=follow.next();
    if(wait!==null)followTimer=setTimeout(followTick,wait);
  }
  function followTick(){
    followTimer=null;
    const verb=follow.tick(Date.now(),capturing || reading || !!controller);
    if(verb==='expired'){endFollow('expired');return;}
    if(verb==='busy')return;
    if(verb==='capture'){capture(true);followRequest=captureRequest;}
    armFollow();render();
  }
  function renderCountdown(){
    if(!follow.state.on)return;
    if(followTimer===null)armFollow();
    const sensor=sensorLine({...view(),remaining:follow.remaining()}),text=sensor[0].toUpperCase()+sensor.slice(1);
    if($('status').textContent!==text)$('status').textContent=text;
  }
  function endFollow(reason){
    follow.stop();clearTimeout(followTimer);followTimer=null;clearInterval(followClock);followClock=null;
    offNote=reason==='expired'?'Screen off · followed for 10 minutes':'Screen off · stopped early';
    renderDeck();render();
  }
  // Thumbnail for the reducer's "did it change" test, drawn locally from the captured frame.
  async function thumbnail(image){const img=new Image();img.src=image;await img.decode();const c=document.createElement('canvas');c.width=160;c.height=90;c.getContext('2d').drawImage(img,0,0,160,90);return c.getContext('2d').getImageData(0,0,160,90).data;}
  function renderPicker(list) {
    const rows=[{id:DESKTOP,title:'Whole desktop',process:'',note:'every monitor, without Sidelook'},...list.map(w=>({id:String(w.id || '').slice(0,32),title:String(w.title || '').slice(0,200),process:String(w.process || '').slice(0,100),minimized:w.minimized===true})).filter(w=>w.id && w.title)];
    $('targets').replaceChildren(...rows.map(row=>{
      const button=document.createElement('button');button.type='button';button.className='starter';button.setAttribute('aria-current',String(front?.id===row.id));
      const label=document.createElement('strong');label.textContent=row.title;
      const pretty=row.process?row.process[0].toUpperCase()+row.process.slice(1).replace(/\.exe$/i,''):'';
      const small=document.createElement('small');small.textContent=row.note || (pretty?pretty+(row.minimized?' · minimized':''):(row.minimized?'minimized':''));
      const wrap=document.createElement('span');wrap.append(label,small);button.append(wrap);
      button.onclick=()=>{error('');post({type:'select-target',target:row.id});};
      return button;
    }));
    $('chips').hidden=true;$('targets').hidden=false;$('deck').hidden=false;$('deck').classList.remove('slim');$('targets').firstElementChild?.focus();
  }
  // The tile is the window Sidelook will look at: its app icon, its title, the app's name, and under a lease the control under the cursor. Pressing it opens the picker.
  function renderTile() {
    const tile=$('front');tile.hidden=!front || !native;
    if(!front)return;
    const app=front.id===DESKTOP?'':appName(),element=follow.state.element?.name?`${follow.state.element.name} ${follow.state.element.type || ''}`.trim():'';
    $('front-icon').hidden=!front.icon;if(front.icon)$('front-icon').src=front.icon;else $('front-icon').removeAttribute('src');
    $('front-letter').textContent=front.id===DESKTOP?'⧉':(app[0] || '?');
    const title=$('front-title');title.replaceChildren();
    if($('deck').classList.contains('slim') && app){const em=document.createElement('em');em.textContent=app;title.append(em,` · ${front.title}`);}
    else title.textContent=front.title;
    $('front-app').textContent=[app,element].filter(Boolean).join(' · ');
  }
  // The starters show while the conversation is empty, and again when Sidelook is summoned from a different window mid-conversation.
  function renderDeck(show=false) {
    const fams=currentFamilies();
    chips=front?chipsFor(fams,front.title):UNKNOWN_CHIPS;
    if(show)slimDeck(false);
    renderTile();
    $('input').placeholder=front?'Ask about this window…':'Ask Sidelook…';
    $('chips').replaceChildren(...chips.map(chip=>{
      const button=document.createElement('button');button.type='button';button.className='starter';button.dataset.chip=chip.id;button.title=chipPrompt(chip);
      const label=document.createElement('strong');label.textContent=chip.label;
      const wrap=document.createElement('span');wrap.append(label);
      button.append(wrap);button.onclick=()=>useChip(chip);
      return button;
    }));
    render();
  }
  $('form').onsubmit=e=>{e.preventDefault();submit();};
  $('input').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();submit();}};
  $('input').addEventListener('input',()=>{if(!$('input').value)boxHeight=null;fitBox();});
  // The grip: drag the box taller than its eight lines. The height sticks until the box is emptied.
  $('grip').onpointerdown=e=>{
    e.preventDefault();const startY=e.clientY,startHeight=$('input').offsetHeight;$('grip').setPointerCapture(e.pointerId);
    const move=ev=>{boxHeight=Math.max(21,Math.min(480,startHeight+ev.clientY-startY));fitBox();};
    const up=()=>{$('grip').removeEventListener('pointermove',move);$('grip').removeEventListener('pointerup',up);$('grip').removeEventListener('pointercancel',up);};
    $('grip').addEventListener('pointermove',move);$('grip').addEventListener('pointerup',up);$('grip').addEventListener('pointercancel',up);
  };
  // The borderless panel's edges: the page names the edge and the shell runs the native resize.
  for(const edge of host.querySelectorAll('.companion-edges i'))edge.onpointerdown=e=>{e.preventDefault();post({type:'drag',edge:edge.dataset.edge});};
  // Anything that changes the content's height tells the shell: messages, the deck, the box, the error line, a dialog opening or closing.
  if(native && typeof ResizeObserver==='function'){
    const watch=new ResizeObserver(()=>fitPanel());
    for(const id of ['messages','deck','form','error','note'])watch.observe($(id));
    watch.observe(document.getElementById('computer-mode'));
    watch.observe(document.getElementById('agent-mode'));
    new MutationObserver(()=>fitPanel()).observe(document.body,{attributeFilter:['open'],subtree:true});
  }
  $('capture').onclick=()=>capture();$('remove').onclick=()=>{setFrame(null);follow.chipRemoved();};$('mic').onclick=dictate;$('stop').onclick=stop;
  $('text-remove').onclick=()=>setText(null);
  $('settings').onclick=()=>{if(!settings.open)settings.showModal();};
  $('preview').onclick=showPreview;
  document.getElementById('settings-preview').onclick=showPreview;
  $('bench').onclick=()=>{if(settings.open)settings.close();showSurface('studio');};$('back').onclick=()=>showSurface('companion');
  $('computer').onclick=()=>openWorkflow('computer','');
  $('agent').onclick=()=>openWorkflow('agent','');
  $('hide').onclick=()=>{stop();showSurface('dock');};$('drag').onpointerdown=()=>post({type:'drag'});
  $('front').onclick=()=>{if($('targets').hidden)openPicker();else closePicker();};
  document.getElementById('model-choice').addEventListener('change',render);
  // New chat empties the screen and the context; Clear context keeps the screen and drops what the next send would carry.
  $('clear').onclick=()=>{history=[];lastTokens=null;lastCached=0;chatTokens=0;chatCached=0;$('messages').replaceChildren();slimDeck(false);renderTile();setFrame(null);setText(null);error('');$('input').value='';boxHeight=null;fitBox();};
  $('clear-context').onclick=()=>{if(!history.length)return;history=[];error('');divider('Context cleared');render();};
  $('compact').onclick=compact;
  $('spoken').onchange=()=>{if(!$('spoken').checked){post({type:'stop-speaking'});window.speechSynthesis?.cancel();}};
  $('voice').onchange=()=>{if(!$('voice').checked)dictation?.abort();};
  $('sense').onclick=()=>{if(follow.state.on)stopFollow();else openLease();};document.getElementById('screen-follow').onclick=()=>startFollow(false);document.getElementById('screen-snapshots').onclick=()=>startFollow(true);
  $('import').onclick=()=>$('import-file').click();
  $('import-file').onchange=async e=>{const file=e.target.files?.[0];if(!file)return;try{if(file.size>120000)throw Error('Choose an HTML prototype under 120 KB.');await importSource(await file.text(),file.name);if(settings.open)settings.close();showSurface('studio');}catch(e){error(e.message);}finally{$('import-file').value='';}};
  native?.addEventListener('message',async event=>{
    const data=event.data;if(!data || typeof data!=='object')return;
    if(data.type==='stop')stop();
    if(data.type==='host-ready'){
      showSurface(data.mode==='workbench'?'studio':'companion',false);
      const before=front?.title;
      front=readFront(data.front);
      document.getElementById('hotkey-note').hidden=!(data.hotkeys && data.hotkeys.quickAsk===false);
      if(front?.title!==before)closePicker();
      renderDeck(!!front && front.title!==before);render();
    }
    if(data.type==='windows')renderPicker(Array.isArray(data.windows)?data.windows.slice(0,60):[]);
    // The shell confirms what it will look at from now on; the starters follow the app, and a stale row says so.
    if(data.type==='target'){
      if(data.via==='click'){
        const verb=follow.click({front:readFront(data.front),element:data.element && typeof data.element.name==='string'?{name:data.element.name.slice(0,100),type:String(data.element.type||'').slice(0,40)}:null});
        front=readFront(data.front);closePicker();armFollow();if(verb==='deck')renderDeck(true);else renderDeck();render();return;
      }
      if(data.ok!==true){error('That window is no longer open. Pick another.');post({type:'windows'});return;}
      front=readFront(data.front);closePicker();renderDeck(true);render();
    }
    // The shell reports the lease's state: on with the countdown and hotkey flag, off with why, or unavailable if its mouse hook never installed (no lease started, so nothing to stop).
    if(data.type==='screen'){
      if(data.on===true){follow.start({snapshots:data.snapshots===true,expires:Number(data.expires)||Date.now()+600000});armFollow();clearInterval(followClock);followClock=setInterval(renderCountdown,1000);if(data.hotkey===false)offNote='Ctrl+Shift+F12 is held by Computer mode · stop from the header line';render();}
      else if(data.reason==='unavailable'){if(lease.open)document.getElementById('screen-lease-note').textContent='Following is unavailable right now.';else error('Following is unavailable right now.');}
      else endFollow(data.reason==='expired'?'expired':'stopped');
    }
    // Ctrl+Shift+E: never while something is in flight, and never over a message the user is still writing.
    if(data.type==='quick-ask'){
      if(controller || capturing || reading || dictation)return;
      if(!$('input').value.trim()){$('input').value=chipPrompt(chips[0] || UNKNOWN_CHIPS[0]);fitBox();}
      quickAsk=true;capture();
    }
    if(data.type==='copied')copied(data.ok===true,data.error);
    if(data.type==='capture'&&capturing&&data.requestId===captureRequest){
      captureRequest=null;const wasFollow=data.requestId===followRequest;followRequest=null;let ok=false;
      if(typeof data.image==='string'&&data.image.length<=4500000&&/^data:image\/jpeg;base64,/.test(data.image)){
        const value={image:data.image,label:String(data.label||'Selected window').slice(0,200),capturedAt:data.capturedAt};
        if(wasFollow){ok=follow.captured(await thumbnail(data.image));if(ok)setFrame(value);}
        else {setFrame(value);ok=true;}
      } else if(!wasFollow) error('The captured image could not be used.');
      else follow.failed();
      capturing=false;armFollow();render();if(!wasFollow)afterCapture(ok);
    }
    // A follow capture that fails (the window moved or closed) is not the user's mistake, so it shows no error and does not run afterCapture.
    if(data.type==='capture-error'&&capturing&&data.requestId===captureRequest){
      capturing=false;captureRequest=null;const wasFollow=data.requestId===followRequest;followRequest=null;
      if(wasFollow)follow.failed();else error(data.error || 'Choose a window, then summon Sidelook again.');
      armFollow();render();if(!wasFollow)afterCapture(false);
    }
    if(data.type==='speech-error')error(data.error || 'Local speech is unavailable.');
    if(data.type==='cursor')lookAt({x:data.x-data.left,y:data.y-data.top});
  });
  document.addEventListener('sidelook-state',render);
  window.addEventListener('pagehide',()=>{controller?.abort();dictation?.abort();post({type:'cancel-capture',requestId:captureRequest});post({type:'stop-speaking'});post({type:'screen-off'});});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)dictation?.abort();});
  showSurface(native || new URLSearchParams(location.search).has('companion')?'companion':'studio',false);renderDeck();fitBox();render();
  return {showPreview};
}
