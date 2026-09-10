import {gate,record,MODEL_LABEL} from './harness.js';

// Agent mode is a screen of its own inside the panel, like Computer mode: markup lives in index.html, Set it up lives in Settings.
// The runtime owns every run; this screen only draws what /api/agent hands back and never decides what executed.
// Contract: docs/AGENT_MODE_IMPLEMENTATION.md sections 11 and 12.
const TERMINAL=['completed','partial','blocked','cancelled','failed','uncertain'];
const GLYPH={ok:'✓',verified:'✓',started:'●',pending:'●',blocked:'✗',rejected:'✗',failed:'✗',unverified:'○',uncertain:'○',info:'·'};
const HEALTH_APPS=[['slack','Slack'],['stripe','Stripe'],['hubspot','HubSpot'],['gmail','Gmail'],['dashclaw','DashClaw']];
const VERDICT={pending_approval:'attempted',claimed:'attempted',executing:'attempted',uncertain:'state uncertain'};

export function initAgent({api,getSelection,getState,onState}) {
  const $=id=>document.getElementById('agent-'+id);
  const host=document.getElementById('companion'),settings=document.getElementById('settings');
  let run=null,watchController=null,ticker=null,expanded=new Set(),starting=false,deciding=false,answering=false;

  const show=on=>{$('mode').hidden=!on;host.classList.toggle('agent',on);notify();};
  const notify=()=>onState?.({on:host.classList.contains('agent'),running:!!run && !TERMINAL.includes(run.status)});
  const setError=message=>{$('error').textContent=message || '';$('error').hidden=!message;};
  const launchHeader=()=>{try{const key=sessionStorage.getItem('sidelookLaunch');return key?{'X-Sidelook-Launch':key}:{};}catch{return {};}};

  // A small ndjson fetch that mirrors api()'s header logic (X-Sidelook-Session, the launch key) since api() only sets the ndjson
  // Accept header for /api/build and cannot be extended here. Every {type:'run'} line replaces the run and re-renders it.
  async function watch(runId,onRun,signal) {
    const headers={...launchHeader(),'Content-Type':'application/json','X-Sidelook-Session':getState().token,Accept:'application/x-ndjson'};
    const response=await fetch('/api/agent',{method:'POST',signal,headers,body:JSON.stringify({op:'watch',run:runId})});
    if(!response.headers.get('content-type')?.includes('application/x-ndjson')) {
      const data=await response.json();if(data.type==='run') onRun(data.run);
      return;
    }
    const reader=response.body.getReader(),decoder=new TextDecoder();let pending='';
    try {
      while(true) {
        const {value,done}=await reader.read();if(done) break;
        pending+=decoder.decode(value,{stream:true});let end;
        while((end=pending.indexOf('\n'))>=0) {
          const line=pending.slice(0,end);pending=pending.slice(end+1);if(!line.trim()) continue;
          const event=JSON.parse(line);if(event.type==='run') onRun(event.run);
        }
      }
    } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
  }
  function stopWatch(){watchController?.abort();watchController=null;}
  function startWatch(runId) {
    stopWatch();const controller=new AbortController();watchController=controller;
    watch(runId,setRun,controller.signal).catch(error=>{if(controller.signal.aborted) return;setError(error.message);});
  }

  function healthState(info){return !info?.configured?'muted':info.ok?'accent':'warn';}
  function renderHealth(health) {
    for(const [key,label] of HEALTH_APPS) {
      const el=$('app-'+key);if(!el) continue;
      const info=health?.apps?.[key];
      el.className=`agent-app ${healthState(info)}`;
      el.title=info?.detail || (info?.configured?'Not responding.':`${label} is not configured.`);
    }
  }

  function evidenceLines(evidence) {
    if(evidence==null) return '(no evidence)';
    const entries=Object.entries(evidence);
    if(!entries.length) return '(no evidence)';
    return entries.map(([k,v])=>`${k}: ${v && typeof v==='object'?JSON.stringify(v):v}`).join('\n');
  }
  function eventRow(event) {
    const li=document.createElement('li');li.className='agent-row-item';
    const glyph=document.createElement('span');glyph.className=`agent-glyph agent-glyph-${event.status}`;glyph.textContent=GLYPH[event.status] || '·';glyph.setAttribute('aria-hidden','true');li.append(glyph);
    if(event.app) {const tag=document.createElement('span');tag.className='agent-tag';tag.textContent=event.app;li.append(tag);}
    const label=document.createElement('span');label.className='agent-event-label';label.textContent=event.label;li.append(label);
    if(event.detail) {const detail=document.createElement('span');detail.className='agent-event-detail';detail.textContent=event.detail;li.append(detail);}
    if(event.evidence!=null) {
      const button=document.createElement('button');button.type='button';button.className='quiet agent-reveal';button.textContent='Details';
      const open=expanded.has(event.id);button.setAttribute('aria-expanded',String(open));
      const pre=document.createElement('pre');pre.hidden=!open;pre.textContent=evidenceLines(event.evidence);
      button.onclick=()=>{const willOpen=pre.hidden;pre.hidden=!willOpen;button.setAttribute('aria-expanded',String(willOpen));if(willOpen) expanded.add(event.id);else expanded.delete(event.id);};
      li.append(button,pre);
    }
    return li;
  }
  // Phase changes are the head's status word, not rows: only the model, tool, write, approval, policy, verify, recovery, user and error events show here.
  function renderTimeline(){$('timeline').replaceChildren(...(run?.events || []).filter(e=>e.kind!=='phase').map(eventRow));}

  function renderApproval() {
    const pending=run?.status==='waiting_for_approval'?run.approvals.find(a=>a.status==='pending'):null;
    $('approval').hidden=!pending;if(!pending) return;
    const rows=[['App',pending.app],['Operation',pending.operation],['Customer',pending.entity]];
    if(pending.amount) rows.push(['Amount',pending.amount]);
    rows.push(['Agent reason',pending.reason]);
    const fields=$('approval-fields');fields.replaceChildren();
    for(const [label,value] of rows) {const dt=document.createElement('dt');dt.textContent=label;const dd=document.createElement('dd');dd.textContent=value;fields.append(dt,dd);}
    const evDt=document.createElement('dt');evDt.textContent='Source evidence';const evDd=document.createElement('dd');const list=document.createElement('ul');
    for(const item of pending.sourceEvidence || []) {const li=document.createElement('li');li.textContent=typeof item==='string'?item:JSON.stringify(item);list.append(li);}
    evDd.append(list);fields.append(evDt,evDd);
    for(const [label,value] of [['Policy reason',pending.policyReason],['Risk',pending.riskScore],['Action id',pending.actionId]]) {const dt=document.createElement('dt');dt.textContent=label;const dd=document.createElement('dd');dd.textContent=value;fields.append(dt,dd);}
  }
  async function decide(kind) {
    if(deciding || !run) return;
    const pending=run.approvals.find(a=>a.status==='pending');if(!pending) return;
    deciding=true;controls();
    try {const result=await api('/api/agent',{op:kind,run:run.runId,actionId:pending.actionId,consent:true});if(result.run) setRun(result.run);}
    catch(error) {setError(error.message);}
    finally {deciding=false;controls();}
  }

  function renderClarify() {
    const waiting=run?.status==='waiting_for_user';
    $('clarify').hidden=!waiting;if(!waiting) return;
    $('question').textContent=run.clarification?.question || '';
  }
  async function answer() {
    if(answering || !run) return;
    const message=$('answer-text').value.trim();if(!message) return;
    answering=true;controls();
    try {const result=await api('/api/agent',{op:'answer',run:run.runId,message,consent:true});setRun(result.run);$('answer-text').value='';}
    catch(error) {setError(error.message);}
    finally {answering=false;controls();}
  }

  // A verdict word per effect: the raw status names double as words for most of them; a write in flight reads "attempted",
  // "uncertain" reads "state uncertain", and an executed write with a failed verification reads "verification unavailable".
  function verdictWord(effect) {
    if(effect.status==='executed') return effect.verification && effect.verification.verified===false?'verification unavailable':'executed';
    return VERDICT[effect.status] || effect.status;
  }
  function effectRow(effect) {
    const li=document.createElement('li');
    const ids=[effect.effectId,effect.receipt?.id,effect.actionId].filter(Boolean).join(' · ');
    li.textContent=`${verdictWord(effect)} · ${effect.app} ${effect.tool}${ids?` · ${ids}`:''}`;
    return li;
  }
  function renderSummary() {
    const terminal=!!run && TERMINAL.includes(run.status);
    $('summary').hidden=!terminal;if(!terminal) return;
    const s=run.summary || {};const w=s.writes || {};const a=s.approvals || {};
    $('summary-line').textContent=`${s.apps || 0} apps · ${s.toolCalls || 0} tool calls · ${w.planned || 0} writes · ${w.verified || 0} verified · ${a.required || 0} approval${a.required===1?'':'s'} · ${s.duplicates || 0} duplicate side effects · ${s.unresolved || 0} unresolved`;
    $('effects').replaceChildren(...(run.effects || []).map(effectRow));
    $('final-text').textContent=run.finalMessage || '';$('final').hidden=!run.finalMessage;
  }

  function renderScreen() {
    const active=!!run && !TERMINAL.includes(run.status);
    $('start').hidden=active;$('run').hidden=!run;
  }
  function renderStatus() {
    if(!run) {$('status').textContent='';return;}
    if(run.currentStep) {
      const secs=Math.max(0,Math.round((Date.now()-(Date.parse(run.currentStep.since) || Date.now()))/1000));
      $('status').textContent=`${run.currentStep.label} · ${secs}s`;
    } else $('status').textContent=run.status.replace(/_/g,' ');
  }
  function updateTicker() {
    if(run && run.currentStep && !ticker) ticker=setInterval(renderStatus,1000);
    if((!run || !run.currentStep) && ticker) {clearInterval(ticker);ticker=null;}
    renderStatus();
  }
  function renderModelLine(){$('model-label').textContent=MODEL_LABEL[getSelection().model];}
  function controls() {
    $('start-button').disabled=starting;
    $('stop').disabled=!run || TERMINAL.includes(run.status);
    const pending=run?.approvals?.find(a=>a.status==='pending');
    $('approve').disabled=deciding || !pending;$('reject').disabled=deciding || !pending;
    $('answer').disabled=answering || run?.status!=='waiting_for_user';
    renderModelLine();
  }
  function setRun(nextRun) {
    if(nextRun && (!run || run.runId!==nextRun.runId)) expanded=new Set();
    run=nextRun;
    renderScreen();renderTimeline();renderApproval();renderClarify();renderSummary();updateTicker();controls();notify();
  }

  async function startRun() {
    setError('');
    const goal=$('goal').value.trim();
    if(!goal) {setError('Say what the agent should accomplish first.');return;}
    if(starting) return;
    const sel=getSelection();
    const refusal=gate({surface:'agent',configured:sel.configured,token:sel.token,remaining:sel.remaining});
    if(refusal) {setError(refusal);return;}
    starting=true;controls();
    try {
      const result=await api('/api/agent',{op:'create',goal,consent:true,model:sel.model,effort:sel.effort,windowTitle:getState().frontTitle || ''});
      record({surface:'agent',ok:true,frame:false,model:sel.model,effort:sel.effort,remaining:result.remaining});
      setRun(result.run);startWatch(result.run.runId);
    } catch(error) {
      record({surface:'agent',ok:false,outcome:'refused',frame:false,model:sel.model,effort:sel.effort,remaining:sel.remaining});
      setError(error.message);
    } finally {starting=false;controls();}
  }
  async function stop() {
    stopWatch();
    if(!run || TERMINAL.includes(run.status)) return;
    try {const result=await api('/api/agent',{op:'cancel',run:run.runId});if(result.run) setRun(result.run);}
    catch(error) {setError(error.message);}
  }

  async function open() {
    if(settings.open) settings.close();
    show(true);setError('');
    try {renderHealth(await api('/api/agent',{op:'health'}));} catch(error) {setError(error.message);}
    try {
      const {runs}=await api('/api/agent',{op:'list'});
      const newest=runs?.[0];
      if(!newest) {setRun(null);return;}
      const got=await api('/api/agent',{op:'get',run:newest.runId});
      setRun(got.run);
      if(!TERMINAL.includes(got.run.status)) startWatch(got.run.runId);
    } catch(error) {setError(error.message);}
  }

  $('back').onclick=()=>show(false);
  $('open').onclick=open;
  $('start-button').onclick=startRun;
  $('stop').onclick=stop;
  $('approve').onclick=()=>decide('approve');
  $('reject').onclick=()=>decide('reject');
  $('answer').onclick=answer;
  document.getElementById('model-choice').addEventListener('change',controls);
  controls();
  return {open,stop};
}
