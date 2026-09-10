import {gate,record,ledger,renderGate,renderPreview,MODEL_LABEL,ACCOUNT,CLI} from './harness.js';

// Computer mode is a screen of its own inside the panel: the window, the task, the one action waiting for you.
// Markup lives in index.html; the lease is <dialog id="computer-lease">; Set it up lives in Settings.
export function initComputer({api,getSelection,onState}) {
  const $=id=>document.getElementById('computer-'+id);
  const host=document.getElementById('companion'),lease=document.getElementById('computer-lease'),preview=document.getElementById('send-preview'),settings=document.getElementById('settings');
  let owner='',busy=false,proposal=null,controller=null,epoch=0,deadline=0,ticker=null,planning=false,ticks=0;
  const status=text=>{$('status').textContent=text;$('status').hidden=!text;};
  const notify=()=>onState?.({on:!!owner,planning});
  const windowTitle=()=>$('window').value?$('window').selectedOptions[0]?.text || '':'';
  const gateView=()=>({surface:'computer',model:getSelection().model,windowTitle:windowTitle()});
  // The screen replaces the conversation while it is open. The lease outlives it: Back keeps control armed, Stop ends it.
  const show=on=>{$('mode').hidden=!on;host.classList.toggle('computer',on);};
  function open(){if(settings.open)settings.close();if(owner){show(true);return;}$('lease-note').textContent='';if(!lease.open)lease.showModal();}
  function left(){if(!owner){$('left').textContent='';return;}const ms=Math.max(0,deadline-Date.now());$('left').textContent=`${Math.floor(ms/60000)}:${String(Math.floor(ms%60000/1000)).padStart(2,'0')} left`;}
  const showRead=text=>{$('snapshot').textContent=text;$('read').hidden=!text;};
  // The full tree, with its control references, lives behind a Details button (a button, not a <details> arrow: the panel has none).
  const treeText=elements=>(elements || []).map(e=>`${e.type}: ${e.name || '(unnamed)'}${e.value?` = ${e.value}`:''}${e.enabled===false?' [disabled]':''}${e.id?`  #${e.id}`:''}`).join('\n');
  const reveal=(button,node)=>{button.onclick=()=>{node.hidden=!node.hidden;button.setAttribute('aria-expanded',String(!node.hidden));};};
  const collapse=(button,node)=>{node.hidden=true;button.setAttribute('aria-expanded','false');};
  reveal($('details'),$('diagnostics'));reveal($('outcome-details'),$('outcome-tree'));
  // After an approved action: what Windows accepted, then what one local reading of the same window showed, or that no reading was possible.
  function showOutcome(action,observation){
    $('outcome').hidden=!action;if(!action)return;
    $('outcome-accepted').textContent=`Windows accepted ${action.kind} · ${action.name || action.app || action.title}.`;
    $('outcome-text').textContent=observation.available?observation.summary:`Verification was unavailable. ${observation.summary}`;
    $('outcome-text').classList.toggle('unverified',!observation.available);
    const tree=observation.available?`READ AFTER THE ACTION · ${observation.title} · local, not sent\n${treeText(observation.reading?.elements)}`:'';
    $('outcome-tree').textContent=tree;$('outcome-details').hidden=!tree;collapse($('outcome-details'),$('outcome-tree'));
  }
  function controls(){
    for(const id of ['refresh','inspect','launch','next','approve','reject','window','task','app','preview']) $(id).disabled=busy || !owner;
    $('inspect').disabled||=!$('window').value;
    $('enable').disabled=busy || !!owner;$('stop').disabled=false;
    $('approve').disabled=busy || !owner || !proposal || Date.now()>proposal.expires;
    $('title').textContent=windowTitle()?`Sidelook in ${windowTitle()}`:'Computer mode';
    renderGate($('gate'),gateView());left();
  }
  const call=(op,body={},signal)=>api('/api/computer',{op,owner,...body},signal);
  function count(){const n=$('history').children.length;$('count').textContent=`${n} action${n===1?'':'s'}`;$('done').hidden=!n;}
  function log(text){const li=document.createElement('li');li.textContent=text;$('history').append(li);count();}
  async function work(fn){
    if(busy)return;
    busy=true;const sequence=epoch;controller=new AbortController();controls();
    try {await fn(controller.signal,()=>sequence===epoch);}
    catch(error){if(sequence===epoch){if(lease.open)$('lease-note').textContent=error.message;else status(error.message);}}
    finally {if(sequence===epoch){busy=false;controller=null;controls();}}
  }
  function clearProposal(){proposal=null;$('review').hidden=true;controls();}
  async function windows(signal){
    const result=await call('windows',{},signal);const previous=$('window').value;
    $('window').replaceChildren(new Option('Choose a window',''));
    for(const window of result.windows)$('window').append(new Option(window.title,window.id));
    if(result.windows.some(w=>w.id===previous))$('window').value=previous;
    controls();
  }
  async function stop(){
    const wasOn=!!owner;
    ++epoch;controller?.abort();controller=null;owner='';busy=false;planning=false;clearInterval(ticker);clearProposal();
    show(false);$('work').hidden=true;$('permission').checked=false;showRead('');showOutcome(null);controls();notify();if(wasOn)status('Computer control is stopped. Anything already delivered stays done.');
    try{await call('stop');}catch{status('Connection unavailable. Press Ctrl+Shift+F12 to stop locally. Control also expires automatically.');}
  }
  $('open').onclick=open;
  $('back').onclick=()=>show(false);
  $('enable').onclick=()=>{
    if(!$('permission').checked){$('lease-note').textContent='Allow local window inspection before enabling Computer mode.';return;}
    $('lease-note').textContent='';
    work(async(signal,current)=>{
      const result=await call('enable',{consent:true},signal);if(!current())return;
      owner=result.owner;deadline=result.expires;lease.close();$('work').hidden=false;show(true);$('history').replaceChildren();count();showOutcome(null);notify();
      await windows(signal);status('Choose a window, or say the task and let the model open the app. Ctrl+Shift+F12 stops control from any app.');
      ticks=0;
      ticker=setInterval(async()=>{
        if(!owner)return;
        left();
        if(Date.now()>=deadline){await stop();return;}
        if(proposal && Date.now()>proposal.expires){$('expiry').textContent='This action expired. Reject it and plan another action.';controls();}
        if(++ticks%2 || busy)return;
        try {const s=await call('status');if(!s.armed)await stop();}catch{/* The local expiry and global shortcut remain available. */}
      },1000);
    });
  };
  $('stop').onclick=stop;
  $('permission').onchange=()=>{if(!$('permission').checked && (owner || busy))stop();};
  $('refresh').onclick=()=>work(async signal=>{clearProposal();await windows(signal);status('Window list refreshed. Choose the app you want to control.');});
  $('window').onchange=()=>{clearProposal();showRead('');showOutcome(null);controls();};
  $('task').oninput=()=>clearProposal();
  document.getElementById('model-choice').addEventListener('change',controls);
  $('inspect').onclick=()=>work(async signal=>{
    clearProposal();const result=await call('inspect',{window:$('window').value},signal);
    showRead(result.elements.map(e=>`${e.type}: ${e.name || '(unnamed)'}${e.value?` = ${e.value}`:''}${e.enabled?'':' [disabled]'}`).join('\n'));
    status(`Read ${result.elements.length} accessible controls locally. Nothing was sent to a model.`);
  });
  $('launch').onclick=()=>work(async signal=>{
    clearProposal();await call('launch',{app:$('app').value},signal);log(`You opened ${$('app').selectedOptions[0].text}.`);await windows(signal);status('App launch requested. Refresh the list if needed, then select the new window.');
  });
  $('preview').onclick=()=>{
    const sel=getSelection();
    renderPreview(preview,{title:'What goes with Plan next action',fields:[
      ['Task',$('task').value.trim() || '(nothing typed yet)'],['Window',windowTitle() || '(none chosen · the model can only propose opening Notepad, Calculator or Paint)'],
      ['Fresh reading',windowTitle()?'the window’s accessible controls and text, read when you press Plan next action':'nothing: no window is chosen, so nothing is read'],['Recent actions',`${$('history').children.length} from this session`],
      ['Model',`${MODEL_LABEL[sel.model]} · ${sel.effort}`],['Goes to',`your ${ACCOUNT[sel.model]} subscription through ${CLI[sel.model]}`]],
      body:{op:'propose',task:$('task').value,window:$('window').value,model:sel.model,effort:sel.effort,consent:true}},ledger);
    preview.showModal();
  };
  // One model step: a fresh reading of the chosen window (or none) and the task go to the model, and one proposal comes back for review.
  // Pressed by hand, or run once after an approved action so the next proposal is waiting instead of a button.
  async function plan(signal,current,afterApprove=false){
    const sel=getSelection();
    if(!$('task').value.trim())throw new Error('Say what Sidelook should do first.');
    const refusal=gate({surface:'computer',configured:sel.configured,token:sel.token,remaining:sel.remaining});
    if(refusal)throw new Error(refusal);
    clearProposal();const start=Date.now();planning=true;notify();status(`${MODEL_LABEL[sel.model]} is planning the next action…`);
    const timer=setInterval(()=>status(`Planning the next action · ${Math.floor((Date.now()-start)/1000)}s elapsed · no desktop action is running`),1000);
    let result;
    try{result=await call('propose',{task:$('task').value,window:$('window').value,model:sel.model,effort:sel.effort,consent:true},signal);record({surface:'computer',ok:true,frame:false,model:sel.model,effort:sel.effort,remaining:result.remaining});}
    catch(error){record({surface:'computer',ok:false,outcome:'refused',frame:false,model:sel.model,effort:sel.effort,remaining:sel.remaining});throw error;}
    finally{clearInterval(timer);planning=false;notify();}
    if(!current())return;
    if(!afterApprove)showOutcome(null);
    const action=result.proposal;proposal=action.kind==='done'?null:action;
    $('review').hidden=false;$('step-label').textContent=action.kind==='done'?`Step ${result.steps} of 20 · the model’s report`:`Step ${result.steps} of 20 · waiting for you`;
    $('action-title').textContent=action.kind==='done'?'Model report':`${action.kind.toUpperCase()} · ${action.name || action.app || action.title}`;
    $('reason').textContent=action.reason;
    // What matters before Approve, in plain words: where, on what, and what it replaces, sends or opens. References and the tree sit behind Details.
    const target=action.kind==='launch'?`Opens: ${action.app}`:`Target: ${action.type || 'window'} "${action.name || '(the window itself)'}"${action.context?` in ${action.context}`:''}`;
    $('action-detail').textContent=action.kind==='done'?'No action will run.':[`In: ${action.title}`,target,action.kind==='type'?`Replaces the whole value with:\n${action.text}`:'',action.kind==='key'?`Sends: ${action.key}`:'',action.kind==='scroll'?`Scrolls: ${action.key}`:''].filter(Boolean).join('\n');
    $('diagnostics').textContent=`Automation ID: ${action.automationId || '(none)'}\nControl reference: ${action.element || '(window)'}\nParent: ${action.context || '(none)'}\nState: ${action.state || '(none)'}\n\nSENT WITH THIS MODEL STEP · ${result.snapshot.title}\n${treeText(result.snapshot.elements)}`;
    collapse($('details'),$('diagnostics'));$('details').hidden=action.kind==='done';
    $('expiry').textContent=action.kind==='done'?'Check the application yourself to confirm the outcome.':'Expires in one minute. Check the target before you approve.';
    $('approve').hidden=action.kind==='done';status(action.kind==='done'?'Review the model’s report.':'Nothing has executed. Approve runs this one action, then plans the next.');
    $('review').scrollIntoView({block:'nearest'});
  }
  $('next').onclick=()=>work(plan);
  $('approve').onclick=()=>work(async(signal,current)=>{
    const action=proposal;if(!action)throw new Error('Request a fresh action.');
    // The proposal stays until Windows accepts it, so a busy broker (a read in flight) leaves it approvable.
    const done=await call('approve',{id:action.id,consent:true},signal);if(!current())return;proposal=null;
    // The broker read the window back once, locally. No model step runs until Plan next action is pressed again.
    const observation=done.observation && typeof done.observation.summary==='string'?done.observation:{available:false,summary:'No reading came back.'};
    log(`${action.kind} · ${action.name || action.app || action.title}: Windows accepted the action. ${observation.summary}`);clearProposal();
    showOutcome(action,observation);
    // A launch that found its window makes it the chosen one, so the next step reads it. The title changes to say so.
    if(observation.launched){await windows(signal);if(!current())return;$('window').value=observation.launched.id;showRead('');controls();}
    status(observation.available?'Delivered and read back locally. Planning the next step…':'Delivered. Verification was unavailable; check the app before you approve the next step.');
    // The next proposal is planned now, so the loop is one yes per action instead of two presses. Reject or Stop ends it; nothing runs without Approve.
    await plan(signal,current,true);
  });
  $('reject').onclick=()=>work(async signal=>{await call('reject',{},signal);clearProposal();status('Action rejected. Nothing more is planned until you press Plan next action.');});
  window.addEventListener('pagehide',()=>{controller?.abort();if(owner)api('/api/computer',{op:'stop'},undefined,true).catch(()=>{});});
  controls();return {state:()=>({on:!!owner,planning}),open};
}
