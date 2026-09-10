// The Agent mode runtime: one per server process, the owner of every run and the only thing that decides what executed.
// The panel asks it questions through /api/agent and draws the answers. Contract: docs/AGENT_MODE_IMPLEMENTATION.md sections 11 and 12.
import {AppError} from '../vision.mjs';
import {createRun,snapshot,isTerminal,pendingApproval,finish,addError,appendEvent,summary,TERMINAL} from './run.mjs';
import {runLoop} from './loop.mjs';

const HEALTH_TTL=20000;

export class AgentRuntime {
  constructor({inference,store,governed,providers,config,health,now=()=>Date.now()}={}){
    if(typeof inference!=='function') throw new Error('AgentRuntime needs an inference function.');
    this.deps={inference,store,governed,providers,config};
    this.healthProbe=health;this.now=now;
    this.entries=new Map();this.healthCache=null;this.stopped=false;
    this.reconciled=false;
  }
  // Runs left behind by an earlier process are never resumed blind: a pending approval becomes blocked, anything else in flight is uncertain.
  async reconcileStored(){
    if(this.reconciled || !this.deps.store) return;
    this.reconciled=true;
    for(const item of await this.deps.store.list({limit:50})){
      if(TERMINAL.has(item.status)) continue;
      const run=await this.deps.store.load(item.runId);if(!run || TERMINAL.has(run.status)) continue;
      const pending=pendingApproval(run);
      addError(run,{code:'INTERRUPTED',message:'Sidelook stopped while this run was in progress. Nothing was resumed; check each app before acting again.'});
      for(const effect of run.effects) if(['claimed','executing','pending_approval'].includes(effect.status)) effect.status=effect.status==='pending_approval'?'expired':'uncertain';
      for(const approval of run.approvals) if(approval.status==='pending'){approval.status='expired';approval.decidedVia=null;}
      // A crash is not a transition the state machine knows; the terminal status is stamped directly and the summary derived from the ledgers.
      run.status=pending?'blocked':'uncertain';run.currentStep=null;run.clarification=null;run.finalMessage='Interrupted before the run could finish.';
      run.summary=summary(run);
      appendEvent(run,{kind:'phase',status:pending?'blocked':'uncertain',label:run.status,detail:'Interrupted before the run could finish.'});
      await this.deps.store.save(run);
    }
  }
  async health(){
    if(this.healthCache && this.now()-this.healthCache.at<HEALTH_TTL) return this.healthCache.value;
    const value=this.healthProbe?await this.healthProbe():{apps:{},ready:false,detail:'No integrations configured.'};
    this.healthCache={at:this.now(),value};
    return value;
  }
  active(){return [...this.entries.values()].find(entry=>!isTerminal(entry.run)) || null;}
  entry(runId){
    const entry=this.entries.get(runId);
    if(!entry) throw new AppError('That run is not active. Refresh the list.',404,'RUN_NOT_FOUND');
    return entry;
  }
  async create({goal,model,effort,windowTitle}={}){
    if(this.stopped) throw new AppError('Agent mode is stopped.',409);
    if(this.active()) throw new AppError('A run is already in progress. Stop it or wait for it to finish.',409,'RUN_ACTIVE');
    const run=createRun({goal,model,effort,windowTitle});
    const controller=new AbortController();
    const entry={run,controller,watchers:new Set(),userWaiter:null,decisionWaiter:null,cancelled:false,loop:null};
    this.entries.set(run.runId,entry);
    await this.persist(entry);
    const handle={
      run,signal:controller.signal,deps:this.deps,
      emit:()=>this.emit(entry),
      isCancelled:()=>entry.cancelled,
      waitForUser:()=>new Promise(resolve=>{entry.userWaiter=resolve;this.emit(entry);}),
      waitForDecision:actionId=>new Promise(resolve=>{entry.decisionWaiter={actionId,resolve};this.emit(entry);})
    };
    entry.loop=runLoop(handle).catch(error=>{
      // A loop that throws is a runtime bug, never a success: the run fails with the reason on the timeline.
      if(!isTerminal(run)){
        addError(run,{code:error?.code || 'RUNTIME',message:error?.message || String(error)});
        const to=entry.cancelled?'cancelled':'failed';
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
    // The loop submits the decision to DashClaw and reports back; the answer here is only that the decision was taken.
    const outcome=await new Promise(resolve=>waiter.resolve({actionId,decision,reason:String(reason || '').slice(0,500),done:resolve}));
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
  let config,providers,governed,store,health;
  try{
    const [{loadConfig},{createProviders},{createGoverned},{RunStore},{createHealth}]=await Promise.all([
      import('./config.mjs'),import('./providers/index.mjs'),import('./governed.mjs'),import('./store.mjs'),import('./health.mjs')]);
    config=loadConfig();providers=createProviders({config});governed=createGoverned({config});store=new RunStore({dir:dataDir || config.dataDir});
    health=createHealth({config,providers,governed});
  } catch(error){
    if(error.code!=='ERR_MODULE_NOT_FOUND') throw error;
    health=async()=>({apps:{},ready:false,detail:'Agent mode integrations are not installed in this build.'});
  }
  const runtime=new AgentRuntime({inference,store,governed,providers,config,health});
  await runtime.reconcileStored();
  return runtime;
}
