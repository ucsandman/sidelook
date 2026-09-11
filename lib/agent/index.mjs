// The Agent mode runtime: one per server process, the owner of every run and the only thing that decides what executed.
// The panel asks it questions through /api/agent and draws the answers. Contract: docs/AGENT_MODE_IMPLEMENTATION.md sections 11 and 12.
import {AppError} from '../vision.mjs';
import {createRun,snapshot,isTerminal,pendingApproval,finish,addError,appendEvent,summary,finalStatus,TERMINAL} from './run.mjs';
import {runLoop} from './loop.mjs';
import {planResume,applyResume,lineageFor} from './resume.mjs';
import {recordIncident,finalizeIncidents,incidentSummary,sanitizeIncident} from './incidents.mjs';

const HEALTH_TTL=20000;
const CONTINUABLE=new Set(['partial','uncertain','failed','cancelled','blocked']);

export class AgentRuntime {
  constructor({inference,store,governed,providers,config,health,breakers=null,incidents=null,now=()=>Date.now()}={}){
    if(typeof inference!=='function') throw new Error('AgentRuntime needs an inference function.');
    this.deps={inference,store,governed,providers,config,breakers,incidents};
    this.healthProbe=health;this.now=now;
    this.entries=new Map();this.healthCache=null;this.stopped=false;
    this.reconciled=false;this.watchDrops=new Set();
  }
  // Every incident goes to its own file the moment it exists, so an interruption still leaves the evidence (docs/AGENT_SELF_HEALING.md §2).
  recordIncident(incident){
    if(!this.deps.incidents) return Promise.resolve();
    return this.deps.incidents.save(incident).catch(()=>{});
  }
  // Runs left behind by an earlier process are never resumed blind: the resume plan says which writes are proven, which must be
  // read back and which can only expire; the reads run; then the terminal status is stamped from the ledger (docs/AGENT_SELF_HEALING.md §6).
  async reconcileStored(){
    if(this.reconciled || !this.deps.store) return;
    this.reconciled=true;
    for(const item of await this.deps.store.list({limit:50})){
      if(TERMINAL.has(item.status)) continue;
      const run=await this.deps.store.load(item.runId);if(!run || TERMINAL.has(run.status)) continue;
      if(!Array.isArray(run.incidents)) run.incidents=[];
      const pending=pendingApproval(run);
      addError(run,{code:'INTERRUPTED',message:'Sidelook stopped while this run was in progress. Nothing was resumed; check each app before acting again.'});
      const plan=planResume(run);
      const incident=recordIncident(run,{integration:'sidelook',tool:'',operation:'resume',phase:'resume',failureClass:'local_process_interruption',error:{code:'INTERRUPTED',message:`Interrupted with ${plan.actions.filter(a=>a.action!=='keep').length} write(s) to settle.`},knownState:'n/a',recoveryAttempted:plan.actions.some(a=>a.action!=='keep'),recoveryStrategy:'resume',announce:'Resumed after a restart: reading back what the providers hold',announceStatus:'started'});
      await this.recordIncident(incident);
      const quiet={run,deps:this.deps,signal:AbortSignal.timeout(30000),emit:()=>{},isCancelled:()=>false,recordIncident:i=>this.recordIncident(i)};
      let results={results:[],uncertain:0,verified:0};
      if(this.deps.providers){
        run.status='executing';
        try {results=await applyResume(quiet,plan);} catch(error){addError(run,{code:error.code || 'RECONCILE',message:error.message,step:'restart'});}
      } else {
        // No providers to ask: nothing in flight can be proven, so it stays uncertain and pending approvals expire.
        for(const effect of run.effects){
          if(['claimed','executing'].includes(effect.status) || (effect.status==='planned' && effect.actionId)) effect.status='uncertain';
          else if(effect.status==='pending_approval') effect.status='expired';
        }
        for(const approval of run.approvals) if(approval.status==='pending'){approval.status='expired';approval.decidedVia=null;}
      }
      run.resume={at:new Date(this.now()).toISOString(),plan,results:results.results,uncertain:results.uncertain,verified:results.verified};
      // A crash is not a transition the state machine knows; the terminal status is stamped directly and the summary derived from the ledgers.
      const terminal=run.effects.some(e=>e.status==='uncertain')?'uncertain':pending?'blocked':finalStatus(run,{runtimeFailure:true});
      const {resolveIncident}=await import('./incidents.mjs');
      resolveIncident(run,incident.incidentId,{recoveryResult:results.uncertain?'stopped_uncertain':results.verified?'recovered':'none',finalDisposition:terminal==='uncertain'?'uncertain':results.verified?'recovered':'info'});
      await this.recordIncident(incident);
      run.status=terminal;run.currentStep=null;run.clarification=null;run.closing='Interrupted before the run could finish.';
      finalizeIncidents(run);
      run.summary=summary(run);
      appendEvent(run,{kind:'phase',status:terminal==='blocked'?'blocked':terminal==='uncertain'?'uncertain':'failed',label:run.status,detail:`Interrupted before the run could finish. Resume read back ${results.results.length} write(s): ${results.verified} proven, ${results.uncertain} still uncertain.`});
      await this.deps.store.save(run);
    }
  }
  async health(){
    const breakers=this.deps.breakers?.snapshot() || [];
    if(this.healthCache && this.now()-this.healthCache.at<HEALTH_TTL) return {...this.healthCache.value,breakers};
    const value=this.healthProbe?await this.healthProbe():{apps:{},ready:false,detail:'No integrations configured.'};
    this.healthCache={at:this.now(),value};
    return {...value,breakers};
  }
  // What the panel's Diagnostics reveals: the incidents of one run (or the newest across runs), the breakers, what a restart found.
  async diagnostics({runId=null}={}){
    const breakers=this.deps.breakers?.snapshot() || [];
    if(runId){
      const run=this.entries.get(runId)?.run || (this.deps.store?await this.deps.store.load(runId):null);
      if(!run) throw new AppError('That run was not found.',404,'RUN_NOT_FOUND');
      // The page gets the sanitized shape (typed fields, scrubbed message, ids), the same one the learning loop reads.
      return {runId,incidents:(run.incidents || []).map(sanitizeIncident),summary:incidentSummary(run),breakers,resume:run.resume || null,lineage:run.lineage?{rootRunId:run.lineage.rootRunId,parentRunId:run.lineage.parentRunId,chain:run.lineage.chain}:null};
    }
    const incidents=(this.deps.incidents?await this.deps.incidents.list({limit:50}):[]).map(sanitizeIncident);
    return {runId:null,incidents,summary:null,breakers,resume:null,lineage:null};
  }
  active(){return [...this.entries.values()].find(entry=>!isTerminal(entry.run)) || null;}
  entry(runId){
    const entry=this.entries.get(runId);
    if(!entry) throw new AppError('That run is not active. Refresh the list.',404,'RUN_NOT_FOUND');
    return entry;
  }
  async create({goal,model,effort,windowTitle,lineage=null}={}){
    if(this.stopped) throw new AppError('Agent mode is stopped.',409);
    if(this.active()) throw new AppError('A run is already in progress. Stop it or wait for it to finish.',409,'RUN_ACTIVE');
    // Repeated malformed plans open the model breaker; a new run waits for it to clear rather than spending turns on the same fault.
    const paused=this.deps.breakers?.check('model',{kind:'model'});
    if(paused?.open) throw new AppError(`${paused.reason}. Try another model or wait.`,429,'MODEL_PAUSED');
    const run=createRun({goal,model,effort,windowTitle,lineage});
    // A continued run carries its parent's unsettled writes on its own ledger, same ids, so a reconcile finds them by the metadata
    // the parent wrote and a proven one is never repeated (docs/AGENT_SELF_HEALING.md §6).
    if(lineage) for(const inherited of lineage.effects || []) run.effects.push({...JSON.parse(JSON.stringify(inherited)),inheritedFrom:{runId:inherited.runId},reconciliations:[],attempts:inherited.status==='uncertain'?1:1});
    const controller=new AbortController();
    const entry={run,controller,watchers:new Set(),userWaiter:null,decisionWaiter:null,cancelled:false,loop:null};
    this.entries.set(run.runId,entry);
    await this.persist(entry);
    const handle={
      run,signal:controller.signal,deps:this.deps,
      emit:()=>this.emit(entry),
      // The engine awaits this before a request leaves the process, so the on-disk ledger names the action and the claim first.
      persist:()=>this.persist(entry),
      recordIncident:incident=>this.recordIncident(incident),
      isCancelled:()=>entry.cancelled,
      waitForUser:()=>new Promise(resolve=>{entry.userWaiter=resolve;this.emit(entry);}),
      waitForDecision:actionId=>new Promise(resolve=>{entry.decisionWaiter={actionId,resolve};this.emit(entry);}),
      // The dashboard decided first: the panel's waiter is dropped so a late press reads as already decided, never as a second decision.
      clearDecision:()=>{entry.decisionWaiter=null;}
    };
    entry.loop=runLoop(handle).catch(error=>{
      // A loop that throws is a runtime bug, never a success: the run fails with the reason on the timeline.
      if(!isTerminal(run)){
        addError(run,{code:error?.code || 'RUNTIME',message:error?.message || String(error)});
        const to=finalStatus(run,{cancelled:entry.cancelled,runtimeFailure:true});
        try{finish(run,to,'The run could not continue.');}
        catch{run.status=to;run.currentStep=null;run.summary=summary(run);}
      }
    }).finally(()=>{entry.userWaiter=null;entry.decisionWaiter=null;this.emit(entry);});
    return snapshot(run);
  }
  async get(runId){
    const entry=this.entries.get(runId);
    if(entry) return snapshot(entry.run);
    const stored=this.deps.store?await this.deps.store.load(runId):null;
    if(!stored) throw new AppError('That run was not found.',404,'RUN_NOT_FOUND');
    return stored;
  }
  // Continue: a new run, same goal, that inherits the parent's proven writes and reads back its unsettled ones before anything new.
  async continueRun(parentRunId,{model,effort,windowTitle}={}){
    const parent=this.entries.get(parentRunId)?.run || (this.deps.store?await this.deps.store.load(parentRunId):null);
    if(!parent) throw new AppError('That run was not found.',404,'RUN_NOT_FOUND');
    if(!isTerminal(parent)) throw new AppError('Stop the run or wait for it to finish before continuing it.',409,'RUN_ACTIVE');
    if(!CONTINUABLE.has(parent.status)) throw new AppError(`A ${parent.status} run has nothing left to continue.`,409,'NOT_CONTINUABLE');
    return this.create({goal:parent.goal,model:model || parent.model,effort:effort || parent.effort,windowTitle:windowTitle ?? parent.context?.windowTitle,lineage:lineageFor(parent)});
  }
  // The page's stream closed before the run ended; the page reconnects on its own, and the fact is recorded once as evidence.
  noteWatchDrop(runId){
    const entry=this.entries.get(runId);
    if(!entry || isTerminal(entry.run) || this.watchDrops.has(runId)) return;
    this.watchDrops.add(runId);
    const incident=recordIncident(entry.run,{integration:'sidelook',tool:'',operation:'watch',phase:'render',failureClass:'renderer_interruption',error:{code:'RENDERER_DROPPED',message:'The panel stopped watching before the run ended.'},knownState:'n/a',recoveryResult:'none',finalDisposition:'info'});
    this.recordIncident(incident);
  }
  async list(){
    const live=[...this.entries.values()].map(e=>({runId:e.run.runId,goal:e.run.goal,status:e.run.status,createdAt:e.run.createdAt}));
    const stored=this.deps.store?await this.deps.store.list({limit:20}):[];
    const seen=new Set(live.map(r=>r.runId));
    return [...live,...stored.filter(r=>!seen.has(r.runId))].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,20);
  }
  // Every change goes to the watchers and to disk; the page never holds a state the runtime does not.
  emit(entry){
    entry.run.updatedAt=new Date(this.now()).toISOString();
    const view=snapshot(entry.run);
    for(const watcher of entry.watchers){try{watcher(view);}catch{entry.watchers.delete(watcher);}}
    this.persist(entry).catch(error=>{addError(entry.run,{code:'PERSIST',message:error.message});});
  }
  async persist(entry){if(this.deps.store) await this.deps.store.save(entry.run);}
  watch(runId,onSnapshot){
    const entry=this.entries.get(runId);
    if(!entry) return null;
    entry.watchers.add(onSnapshot);
    onSnapshot(snapshot(entry.run));
    return ()=>entry.watchers.delete(onSnapshot);
  }
  async answer(runId,message){
    const entry=this.entry(runId);
    if(entry.run.status!=='waiting_for_user' || !entry.userWaiter) throw new AppError('The run is not waiting for an answer.',409,'NOT_WAITING');
    const text=String(message || '').trim().slice(0,2000);
    if(!text) throw new AppError('Type an answer first.');
    const resolve=entry.userWaiter;entry.userWaiter=null;resolve({message:text});
    return snapshot(entry.run);
  }
  async decide(runId,actionId,decision,reason){
    const entry=this.entry(runId);
    const pending=pendingApproval(entry.run);
    if(!pending) {
      const earlier=entry.run.approvals.find(a=>a.actionId===actionId);
      if(earlier) return {run:snapshot(entry.run),approval:earlier,already:true};
      throw new AppError('No approval is waiting on this run.',409,'NO_PENDING_APPROVAL');
    }
    if(pending.actionId!==actionId) throw new AppError('That approval is not the one waiting. Refresh and look again.',409,'APPROVAL_MISMATCH');
    if(!entry.decisionWaiter || entry.decisionWaiter.actionId!==actionId) throw new AppError('The run is not ready for a decision yet.',409,'NOT_WAITING');
    const waiter=entry.decisionWaiter;entry.decisionWaiter=null;
    // The loop submits the decision to DashClaw and reports back; the answer here is only that the decision was taken. A loop that is
    // stopped mid-submission answers within 20 s regardless, so the page's buttons never wait on a promise nobody will settle.
    const outcome=await Promise.race([
      new Promise(resolve=>waiter.resolve({actionId,decision,reason:String(reason || '').slice(0,500),done:resolve})),
      new Promise(resolve=>setTimeout(()=>resolve({ok:false,code:'DECISION_TIMEOUT',message:'The decision was taken but DashClaw did not answer in time. Refresh to see its state.'}),20000).unref?.())
    ]);
    return {run:snapshot(entry.run),approval:entry.run.approvals.find(a=>a.actionId===actionId) || null,...(outcome || {})};
  }
  approve(runId,actionId,reason){return this.decide(runId,actionId,'allow',reason);}
  reject(runId,actionId,reason){return this.decide(runId,actionId,'deny',reason);}
  async cancel(runId){
    const entry=this.entry(runId);
    if(isTerminal(entry.run)) return snapshot(entry.run);
    entry.cancelled=true;entry.controller.abort();
    if(entry.userWaiter){const r=entry.userWaiter;entry.userWaiter=null;r({cancelled:true});}
    if(entry.decisionWaiter){const w=entry.decisionWaiter;entry.decisionWaiter=null;w.resolve({cancelled:true});}
    this.emit(entry);
    return snapshot(entry.run);
  }
  // Emergency stop: every active run is cancelled. Anything a provider already accepted stays done; nothing new starts.
  async stopAll(){
    const active=[...this.entries.values()].filter(e=>!isTerminal(e.run));
    for(const entry of active) await this.cancel(entry.run.runId);
    return {stopped:active.length};
  }
}

// Assembles the runtime from the environment. The modules it needs land in later tracks; until they exist the server gets a runtime
// with no integrations, and the panel's health line says so.
export async function createAgentRuntime({inference,dataDir}={}){
  let config,providers,governed,store,health,breakers=null,incidents=null;
  try{
    const [{loadConfig},{createProviders},{createGoverned},{RunStore},{createHealth},{CircuitBreakers},{IncidentStore},{join,dirname}]=await Promise.all([
      import('./config.mjs'),import('./providers/index.mjs'),import('./governed.mjs'),import('./store.mjs'),import('./health.mjs'),import('./breakers.mjs'),import('./incidents.mjs'),import('node:path')]);
    config=loadConfig();providers=createProviders({config});governed=createGoverned({config});
    const runsDir=dataDir || config.dataDir;
    store=new RunStore({dir:runsDir});
    // Incidents and the breaker snapshot live beside the runs folder (docs/AGENT_SELF_HEALING.md §2, §5).
    incidents=new IncidentStore({dir:join(dirname(runsDir),'incidents')});
    breakers=new CircuitBreakers({path:join(dirname(runsDir),'breakers.json')});
    health=createHealth({config,providers,governed});
  } catch(error){
    if(error.code!=='ERR_MODULE_NOT_FOUND') throw error;
    health=async()=>({apps:{},ready:false,detail:'Agent mode integrations are not installed in this build.'});
  }
  const runtime=new AgentRuntime({inference,store,governed,providers,config,health,breakers,incidents});
  await runtime.reconcileStored();
  return runtime;
}
