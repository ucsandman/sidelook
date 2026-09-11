import {gate,record,MODEL_LABEL} from './harness.js';

// Agent mode is a screen of its own inside the panel, like Computer mode: markup lives in index.html, Set it up lives in Settings.
// The runtime owns every run; this screen only draws what /api/agent hands back and never decides what executed.
// Contract: docs/AGENT_MODE_IMPLEMENTATION.md sections 11 and 12.
const TERMINAL=['completed','partial','blocked','cancelled','failed','uncertain'];
const GLYPH={ok:'✓',verified:'✓',started:'●',pending:'●',blocked:'✗',rejected:'✗',failed:'✗',unverified:'○',uncertain:'○',info:'·'};
const HEALTH_APPS=[['slack','Slack'],['stripe','Stripe'],['hubspot','HubSpot'],['gmail','Gmail'],['dashclaw','DashClaw']];
const VERDICT={claimed:'authorized, not sent',pending_approval:'waiting for approval',executing:'sending',uncertain:'state uncertain'};
const RECONNECT_DELAYS=[1000,2000,4000,8000],RECONNECT_MAX_TRIES=10,SILENCE_MS=25000,POLL_MS=1500;
const plural=(n,word)=>`${n} ${word}${n===1?'':'s'}`;

export function initAgent({api,getSelection,getState,onState}) {
  const $=id=>document.getElementById('agent-'+id);
  const host=document.getElementById('companion'),settings=document.getElementById('settings');
  let run=null,watchController=null,ticker=null,expanded=new Set(),starting=false,deciding=false,answering=false;
  let stopping=false,reconnecting=false,reconnectAttempts=0,reconnectTimer=null,pollTimer=null,silenceTimer=null,lastMessageAt=0;
  // Self healing (docs/AGENT_SELF_HEALING.md §8): the diagnostics panel is fetched once per run, on first open, and
  // discarded when the run changes; Continue keeps its own in-flight flag like Approve/Reject/Answer do.
  let diagnosticsOpen=false,diagnosticsData=null,continuing=false,lastHealthRunStatus=null;

  const show=on=>{$('mode').hidden=!on;host.classList.toggle('agent',on);notify();};
  const notify=()=>onState?.({on:host.classList.contains('agent'),running:!!run && !TERMINAL.includes(run.status)});
  const setError=message=>{$('error').textContent=message || '';$('error').hidden=!message;};
  const launchHeader=()=>{try{const key=sessionStorage.getItem('sidelookLaunch');return key?{'X-Sidelook-Launch':key}:{};}catch{return {};}};

  // A small ndjson fetch that mirrors api()'s header logic (X-Sidelook-Session, the launch key) since api() only sets the ndjson
  // Accept header for /api/build and cannot be extended here. Every {type:'run'} line replaces the run and re-renders it; every
  // line at all (including the 10s heartbeat) marks the stream alive so a silent connection can be told from a dead one.
  async function watch(runId,onRun,alive,signal) {
    const headers={...launchHeader(),'Content-Type':'application/json','X-Sidelook-Session':getState().token,Accept:'application/x-ndjson'};
    const response=await fetch('/api/agent',{method:'POST',signal,headers,body:JSON.stringify({op:'watch',run:runId})});
    if(!response.headers.get('content-type')?.includes('application/x-ndjson')) {
      const data=await response.json();alive();if(data.type==='run') onRun(data.run);
      return;
    }
    const reader=response.body.getReader(),decoder=new TextDecoder();let pending='';
    try {
      while(true) {
        const {value,done}=await reader.read();if(done) break;
        pending+=decoder.decode(value,{stream:true});let end;
        while((end=pending.indexOf('\n'))>=0) {
          const line=pending.slice(0,end);pending=pending.slice(end+1);if(!line.trim()) continue;
          const event=JSON.parse(line);alive();if(event.type==='run') onRun(event.run);
        }
      }
    } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
  }
  function stopWatch(){watchController?.abort();watchController=null;clearInterval(silenceTimer);silenceTimer=null;}
  function stopReconnect(){clearTimeout(reconnectTimer);reconnectTimer=null;}
  function stopPoll(){clearInterval(pollTimer);pollTimer=null;}
  // The stream is gone: a clean end while the run is still open, a fetch/read error, or 25s of silence past the 10s heartbeat.
  // Re-fetch the run directly, then re-open the watch with backoff (1s, 2s, 4s, max 8s); after 10 tries fall back to
  // polling get every 1.5s until the run reaches a terminal status.
  function dropped(runId) {
    if(!run || TERMINAL.includes(run.status)) return;
    stopWatch();reconnect(runId);
  }
  // "Reconnecting to the run" stays up for the whole disconnected stretch, including the poll fallback below; only a
  // received stream message (alive(), in startWatch) or a terminal snapshot (setRun) clears it.
  async function reconnect(runId) {
    reconnecting=true;renderStatus();
    try {const got=await api('/api/agent',{op:'get',run:runId});if(got.run) setRun(got.run);} catch {}
    if(!run || TERMINAL.includes(run.status)) return;
    reconnectAttempts++;
    if(reconnectAttempts>RECONNECT_MAX_TRIES) {startPoll(runId);return;}
    reconnectTimer=setTimeout(()=>startWatch(runId,false),RECONNECT_DELAYS[Math.min(reconnectAttempts-1,RECONNECT_DELAYS.length-1)]);
  }
  function startPoll(runId) {
    stopPoll();
    pollTimer=setInterval(async()=>{
      try {const got=await api('/api/agent',{op:'get',run:runId});if(got.run) setRun(got.run);} catch {}
      if(run && TERMINAL.includes(run.status)) stopPoll();
    },POLL_MS);
  }
  function startWatch(runId,fresh=true) {
    stopWatch();if(fresh) {stopReconnect();stopPoll();reconnectAttempts=0;reconnecting=false;}
    const controller=new AbortController();watchController=controller;lastMessageAt=Date.now();
    silenceTimer=setInterval(()=>{if(Date.now()-lastMessageAt>SILENCE_MS) dropped(runId);},5000);
    watch(runId,setRun,()=>{lastMessageAt=Date.now();if(reconnecting){reconnecting=false;renderStatus();}},controller.signal)
      .then(()=>{if(!controller.signal.aborted) dropped(runId);})
      .catch(error=>{if(controller.signal.aborted) return;dropped(runId);});
  }

  function healthState(info){return !info?.configured?'muted':info.ok?'accent':'warn';}
  // An open or half-open breaker outranks the plain health read for that app: the dot turns warn and its title is the
  // breaker's own reason (docs/AGENT_SELF_HEALING.md §5), so a person sees why the app paused, not just that it isn't ok.
  const openBreakerFor=(health,key)=>(health?.breakers || []).find(b=>b.integration===key && (b.state==='open' || b.state==='half_open')) || null;
  function renderHealth(health) {
    for(const [key,label] of HEALTH_APPS) {
      const el=$('app-'+key);if(!el) continue;
      const info=health?.apps?.[key];const breaker=openBreakerFor(health,key);
      el.className=`agent-app ${breaker?'warn':healthState(info)}`;
      el.title=breaker?breaker.reason:(info?.detail || (info?.configured?'Not responding.':`${label} is not configured.`));
    }
    const open=(health?.breakers || []).filter(b=>b.state==='open' || b.state==='half_open');
    $('breakers').replaceChildren(...open.map(b=>{const li=document.createElement('li');li.textContent=b.reason;return li;}));
    $('breakers').hidden=!open.length;
  }

  function evidenceLines(evidence) {
    if(evidence==null) return '(no evidence)';
    const entries=Object.entries(evidence);
    if(!entries.length) return '(no evidence)';
    return entries.map(([k,v])=>`${k}: ${v && typeof v==='object'?JSON.stringify(v):v}`).join('\n');
  }
  function eventRow(event) {
    // Model events (the reasoning between tool calls) render as a plain muted line with no glyph, so the person sees why
    // a tool was chosen without a doubled row of ticks and dots.
    const li=document.createElement('li');li.className=event.kind==='model'?'agent-row-item agent-row-model':'agent-row-item';
    if(event.kind!=='model') {
      const glyph=document.createElement('span');glyph.className=`agent-glyph agent-glyph-${event.status}`;glyph.textContent=GLYPH[event.status] || '·';glyph.setAttribute('aria-hidden','true');li.append(glyph);
    }
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

  // A source evidence item is either a plain string (a legacy or minimal fixture) or a fact-shaped object {label, value,
  // source, ref}; a Slack quote is prefixed "from Slack" so the quoted words read as data the agent copied, never a claim
  // it is making, and the ref (permalink or id) prints as a second muted line so the person can go look.
  function sourceEvidenceItem(item) {
    const li=document.createElement('li');
    if(typeof item==='string') {li.textContent=item;return li;}
    const value=item.source==='slack'?`from Slack: ${item.value ?? ''}`:(item.value ?? '');
    const text=document.createElement('span');text.textContent=item.label?`${item.label}: ${value}`:value;li.append(text);
    if(item.ref) {const ref=document.createElement('span');ref.className='agent-evidence-ref';ref.textContent=item.ref;li.append(ref);}
    return li;
  }
  function renderApproval() {
    const pending=run?.status==='waiting_for_approval'?run.approvals.find(a=>a.status==='pending'):null;
    $('approval').hidden=!pending;renderDecideBy();if(!pending) return;
    const rows=[['App',pending.app],['Operation',pending.operation],['Customer',pending.entity]];
    if(pending.amount) rows.push(['Amount',pending.amount]);
    rows.push(['Agent reason',pending.reason]);
    const fields=$('approval-fields');fields.replaceChildren();
    for(const [label,value] of rows) {const dt=document.createElement('dt');dt.textContent=label;const dd=document.createElement('dd');dd.textContent=value;fields.append(dt,dd);}
    const evDt=document.createElement('dt');evDt.textContent='Source evidence';const evDd=document.createElement('dd');const list=document.createElement('ul');
    for(const item of pending.sourceEvidence || []) list.append(sourceEvidenceItem(item));
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

  // A verdict word per effect, derived from status (attempts never turns into a claim of its own: a precondition
  // satisfied with 0 attempts never says "attempted"). claimed is authorized but not yet sent, pending_approval is
  // waiting on a person, executing is sending, an executed write with a failed verification is unavailable, any other
  // executed write reads "not verified" until a later read proves it, and the rest of the status names double as words.
  function verdictWord(effect) {
    if(effect.status==='executed') return effect.verification && effect.verification.verified===false?'verification unavailable':'executed, not verified';
    return VERDICT[effect.status] || effect.status;
  }
  function effectRow(effect) {
    const li=document.createElement('li');
    const ids=[effect.effectId,effect.receipt?.id,effect.actionId,effect.decisionId].filter(Boolean).join(' · ');
    li.textContent=`${verdictWord(effect)} · ${effect.app} ${effect.tool}${ids?` · ${ids}`:''}`;
    return li;
  }
  // The summary line says what happened in plurals, then appends the refusal counts (only the ones above zero) so a
  // blocked or rejected run reads its own reason instead of a bare number. run.summary.writes is the only source.
  function summaryLine(s) {
    const w=s.writes || {};const a=s.approvals || {};const inc=s.incidents || {};
    const parts=[plural(s.apps || 0,'app'),plural(s.toolCalls || 0,'tool call'),
      `${w.executed || 0} of ${w.planned || 0} write${w.planned===1?'':'s'} executed`,
      `${w.verified || 0} verified`,plural(a.required || 0,'approval'),
      plural(s.duplicates || 0,'duplicate side effect'),`${s.unresolved || 0} unresolved`];
    const refusals=[['corrected before sending',w.corrected],['blocked',w.blocked],['rejected',w.rejected],['expired',w.expired],['verification unavailable',w.verificationUnavailable],['state uncertain',w.uncertain]]
      .filter(([,n])=>n>0).map(([label,n])=>`${n} ${label}`);
    // Self healing (docs/AGENT_SELF_HEALING.md §8): incidents, inherited writes and recoveries only ever add to the
    // line, after the refusal counts, and only when the run has any.
    const healing=[];
    if(inc.total>0) healing.push(inc.total===1 && inc.recovered===1?'1 incident, recovered':`${plural(inc.total,'incident')}, ${inc.recovered || 0} recovered`);
    if(w.inherited>0) healing.push(`${w.inherited} inherited`);
    if(s.recoveries>0) healing.push(`${s.recoveries} recoveries`);
    const tail=[...refusals,...healing];
    return tail.length?`${parts.join(' · ')} · ${tail.join(', ')}`:parts.join(' · ');
  }
  function renderResume() {
    const r=run?.resume;
    $('resume').hidden=!r;if(!r) return;
    $('resume').textContent=`Resumed after a restart: ${(r.results || []).length} read back, ${r.verified} proven, ${r.uncertain} uncertain`;
  }
  // Continue (docs/AGENT_SELF_HEALING.md §6) offers a next attempt on any terminal run whose goal is unmet; a
  // completed run never shows it.
  function renderContinueButton() {
    $('continue').hidden=!run || run.status==='completed' || !TERMINAL.includes(run.status);
  }
  const words=v=>String(v || '').replace(/_/g,' ');
  function diagnosticsIncidentRow(incident) {
    const li=document.createElement('li');
    li.textContent=`${words(incident.failureClass)} · ${incident.integration} · ${incident.tool || '(none)'} · ${words(incident.recoveryStrategy)} · ${words(incident.recoveryResult)} · ${words(incident.finalDisposition)}`;
    return li;
  }
  function diagnosticsBreakerRow(breaker) {
    const li=document.createElement('li');
    const until=breaker.until?new Date(breaker.until):null;
    const when=until?`${String(until.getHours()).padStart(2,'0')}:${String(until.getMinutes()).padStart(2,'0')}`:'—';
    li.textContent=`${breaker.integration} ${words(breaker.failureClass)} · ${words(breaker.state)} · ${breaker.failures} failures · until ${when}`;
    // No operator op to clear a breaker exists on the server today (docs/AGENT_SELF_HEALING.md §5, §8); the row has
    // no Clear button until one ships.
    return li;
  }
  function renderDiagnostics() {
    $('diagnostics-toggle').setAttribute('aria-expanded',String(diagnosticsOpen));
    $('diagnostics').hidden=!diagnosticsOpen;
    // Cleared whenever there is no data for the run on screen, so a run change never leaves a stale run's incident or
    // breaker rows attributed to the new run (docs/AGENT_SELF_HEALING.md §8).
    $('diagnostics-incidents').replaceChildren(...(diagnosticsData?.incidents || []).map(diagnosticsIncidentRow));
    $('diagnostics-breakers').replaceChildren(...(diagnosticsData?.breakers || []).map(diagnosticsBreakerRow));
  }
  async function toggleDiagnostics() {
    if(!run) return;
    diagnosticsOpen=!diagnosticsOpen;renderDiagnostics();
    if(diagnosticsOpen && !diagnosticsData) {
      try {diagnosticsData=await api('/api/agent',{op:'diagnostics',run:run.runId});renderDiagnostics();}
      catch(error) {setError(error.message);}
    }
  }
  function renderLineage() {
    const parentId=run?.lineage?.parentRunId;
    $('lineage').textContent=parentId?`Continues run ${parentId}`:'';
    $('lineage').hidden=!parentId;
  }
  async function doContinue() {
    if(continuing || !run) return;
    setError('');
    const sel=getSelection();
    const refusal=gate({surface:'agent',configured:sel.configured,token:sel.token,remaining:sel.remaining});
    if(refusal) {setError(refusal);return;}
    continuing=true;controls();
    try {
      const result=await api('/api/agent',{op:'continue',run:run.runId,consent:true,model:sel.model,effort:sel.effort});
      record({surface:'agent',ok:true,frame:false,model:sel.model,effort:sel.effort,remaining:result.remaining});
      setRun(result.run);startWatch(result.run.runId);
    } catch(error) {
      record({surface:'agent',ok:false,outcome:'refused',frame:false,model:sel.model,effort:sel.effort,remaining:sel.remaining});
      setError(error.message);
    } finally {continuing=false;controls();}
  }
  function renderSummary() {
    const terminal=!!run && TERMINAL.includes(run.status);
    $('summary').hidden=!terminal;if(!terminal) {$('diagnostics').hidden=true;$('diagnostics-toggle').setAttribute('aria-expanded','false');return;}
    $('summary-line').textContent=summaryLine(run.summary || {});
    $('effects').replaceChildren(...(run.effects || []).map(effectRow));
    // run.closing is the runtime's own sentence (e.g. "Stopped."), shown plain with no attribution; run.finalMessage is
    // the model's words, shown only under "The agent said" (lib/agent/run.mjs and loop.mjs set the two separately).
    $('closing').textContent=run.closing || '';$('closing').hidden=!run.closing;
    $('final-text').textContent=run.finalMessage || '';$('final').hidden=!run.finalMessage;
    renderResume();renderContinueButton();renderDiagnostics();
  }

  function renderScreen() {
    const active=!!run && !TERMINAL.includes(run.status);
    $('start').hidden=active;$('run').hidden=!run;
  }
  function renderStatus() {
    if(!run) {$('status').textContent='';return;}
    if(stopping) {$('status').textContent='Stopping (finishing the write in flight)';return;}
    if(reconnecting) {$('status').textContent='Reconnecting to the run';return;}
    if(run.currentStep) {
      const secs=Math.max(0,Math.round((Date.now()-(Date.parse(run.currentStep.since) || Date.now()))/1000));
      $('status').textContent=`${run.currentStep.label} · ${secs}s`;
    } else $('status').textContent=run.status.replace(/_/g,' ');
  }
  // The Decide by line rides the same 1s ticker as the elapsed-seconds status, so a pending approval counts down even
  // when the runtime has no currentStep of its own while it waits on a person.
  function renderDecideBy() {
    const pending=run?.status==='waiting_for_approval'?run.approvals.find(a=>a.status==='pending'):null;
    const ms=pending && Date.parse(pending.expiresAt);
    $('decide-by').textContent=ms?`Decide by ${String(new Date(ms).getHours()).padStart(2,'0')}:${String(new Date(ms).getMinutes()).padStart(2,'0')}`:'';
  }
  function updateTicker() {
    const pending=!!(run?.status==='waiting_for_approval' && run.approvals.some(a=>a.status==='pending'));
    if(run && (run.currentStep || pending) && !ticker) ticker=setInterval(()=>{renderStatus();renderDecideBy();},1000);
    if((!run || (!run.currentStep && !pending)) && ticker) {clearInterval(ticker);ticker=null;}
    renderStatus();renderDecideBy();
  }
  function renderModelLine(){$('model-label').textContent=MODEL_LABEL[getSelection().model];}
  // The footer promises the global hotkey only when the shell actually wired one; getState().agentHotkey is set by the
  // parent's shell flag and is undefined until that lands, which reads the same as true (the hotkey exists).
  function renderHotkeyNote(){$('hotkey-note').textContent=getState().agentHotkey===false?'Stop from this panel':'Ctrl+Shift+F12 stops from any app';}
  function controls() {
    $('start-button').disabled=starting;
    $('stop').disabled=!run || TERMINAL.includes(run.status) || stopping;
    const pending=run?.approvals?.find(a=>a.status==='pending');
    $('approve').disabled=deciding || !pending;$('reject').disabled=deciding || !pending;
    $('answer').disabled=answering || run?.status!=='waiting_for_user';
    $('continue').disabled=continuing;
    renderModelLine();renderHotkeyNote();
  }
  function setRun(nextRun) {
    if(nextRun && (!run || run.runId!==nextRun.runId)) {expanded=new Set();diagnosticsOpen=false;diagnosticsData=null;lastHealthRunStatus=null;}
    run=nextRun;
    // A terminal snapshot ends every in-flight recovery: stop is no longer pending, the stream and any fallback close.
    // It also re-reads health, since a breaker can open or clear only across a run (docs/AGENT_SELF_HEALING.md §5, §8).
    // A breaker can also open mid-run: the first snapshot that reports 'recovering' re-reads health too, so the amber
    // dot and the pause line under the head are not stuck showing the run before this one until it ends.
    if(run && TERMINAL.includes(run.status)) {
      stopping=false;reconnecting=false;stopWatch();stopReconnect();stopPoll();
      api('/api/agent',{op:'health'}).then(renderHealth).catch(error=>setError(error.message));
    } else if(run && run.status==='recovering' && lastHealthRunStatus!=='recovering') {
      api('/api/agent',{op:'health'}).then(renderHealth).catch(error=>setError(error.message));
    }
    lastHealthRunStatus=run?run.status:null;
    renderScreen();renderTimeline();renderApproval();renderClarify();renderLineage();renderSummary();updateTicker();controls();notify();
  }

  async function startRun() {
    setError('');
    stopping=false;reconnecting=false;
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
  // Stop leaves the watch open: a write already in flight still needs its verification step, and only the terminal
  // snapshot that arrives on the stream (or the get/poll fallback) should end the run on screen.
  async function stop() {
    if(!run || TERMINAL.includes(run.status) || stopping) return;
    stopping=true;controls();renderStatus();
    try {const result=await api('/api/agent',{op:'cancel',run:run.runId});if(result.run) setRun(result.run);}
    catch(error) {stopping=false;controls();setError(error.message);}
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
  $('diagnostics-toggle').onclick=toggleDiagnostics;
  $('continue').onclick=doContinue;
  document.getElementById('model-choice').addEventListener('change',controls);
  controls();
  return {open,stop};
}
