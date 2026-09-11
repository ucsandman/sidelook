// The bounded model loop: one tool per turn, the runtime executes it, the observation goes back, until the model says done or the
// turn cap ends it. Reads run through the registry's handlers; writes run through the governed effect engine and nowhere else.
// The terminal status comes from the effect ledger, never from the model's closing words. Contract: docs/AGENT_MODE_IMPLEMENTATION.md §5.
import {MAX_TURNS,ALLOWED,transition,appendEvent,setStep,addError,finalStatus,finish,summary} from './run.mjs';
import {PLAN_SCHEMA,systemPrompt,buildPrompt,parsePlan} from './planner.mjs';
import {TOOLS,READ_HANDLERS,WRITE_TOOLS} from './tools.mjs';
import {executeWrite,reconcileUncertain} from './effects.mjs';

const MAX_CONSECUTIVE_BAD=2;

function terminate(run,status,closing){
  if(ALLOWED[run.status]?.includes('verifying') && run.status!=='verifying') transition(run,'verifying','Final verification.');
  if(ALLOWED[run.status]?.includes(status)) return finish(run,status,closing);
  // A status the machine cannot reach from here (a Stop while waiting on a person) is stamped directly with its summary.
  run.status=status;run.closing=String(closing || '').slice(0,400);run.currentStep=null;run.clarification=null;run.summary=summary(run);
  appendEvent(run,{kind:'summary',status:'info',label:'Run summary',evidence:run.summary});
  return run;
}

// What the model may know about the operator's configuration: names and target values, never a token or an address it could misuse.
export function promptSettings(config){
  if(!config) return null;
  return {hubspot:{property:config.hubspot?.property || '',value:config.hubspot?.value || ''},gmail:{from:config.gmail?.from || ''}};
}

export async function runLoop(handle){
  const {run,deps,signal}=handle;
  const registry=TOOLS,system=systemPrompt(registry);
  const observations=[];
  let consecutiveBad=0,terminal=null,pendingAnswer=null,cancelled=false,runtimeFailure=false;
  const stopped=()=>signal.aborted || handle.isCancelled();
  try {
    transition(run,'planning','Understanding the request.');
    appendEvent(run,{kind:'model',status:'started',label:'Understanding request',detail:run.goal});
    handle.emit();
    if(deps.governed?.session) run.dashclaw.sessionId=await deps.governed.session(run.runId,run.goal).catch(()=>null);
    while(run.turn<MAX_TURNS){
      if(stopped()){cancelled=true;break;}
      run.turn++;
      if(run.status!=='planning') transition(run,'planning','Choosing the next step.');
      setStep(run,'Thinking');handle.emit();
      let response;
      try {response=await deps.inference({system,prompt:buildPrompt(run,{observations,pendingAnswer,settings:promptSettings(deps.config)}),schema:PLAN_SCHEMA,model:run.model,effort:run.effort},signal);}
      catch(error){
        if(error.name==='AbortError' || stopped()){cancelled=true;break;}
        addError(run,{code:error.code || 'MODEL',message:error.message,step:'model'});
        observations.push({turn:run.turn,error:{code:error.code || 'MODEL',message:error.message}});
        if(++consecutiveBad>=MAX_CONSECUTIVE_BAD){runtimeFailure=true;break;}
        continue;
      }
      pendingAnswer=null;
      const parsed=parsePlan(response?.result,registry);
      if(!parsed.ok){
        // Malformed output executes nothing. The model hears why once; twice in a row ends the run.
        addError(run,{code:parsed.error.code || 'MALFORMED_PLAN',message:parsed.error.message,step:'model'});
        observations.push({turn:run.turn,error:parsed.error});
        if(++consecutiveBad>=MAX_CONSECUTIVE_BAD){runtimeFailure=true;break;}
        continue;
      }
      consecutiveBad=0;
      const plan=parsed.plan;
      if(plan.kind==='ask'){
        run.clarification={question:plan.message,options:[]};
        appendEvent(run,{kind:'user',status:'pending',label:'The agent asks',detail:plan.message});
        transition(run,'waiting_for_user',plan.message);setStep(run,'Waiting for your answer');handle.emit();
        const answer=await handle.waitForUser();
        if(!answer || answer.cancelled || stopped()){cancelled=true;break;}
        run.clarification=null;
        appendEvent(run,{kind:'user',status:'ok',label:'You answered',detail:answer.message});
        observations.push({turn:run.turn,userAnswer:answer.message});pendingAnswer=answer.message;
        transition(run,'planning','Answer received.');
        continue;
      }
      if(plan.kind==='done' || plan.kind==='fail'){terminal=plan;break;}
      const tool=registry[plan.tool];
      appendEvent(run,{kind:'model',status:'info',app:tool.app,label:`${tool.readOnly?'Read':'Write'}: ${plan.tool}`,detail:plan.reason});
      transition(run,'executing',`Running ${plan.tool}.`);setStep(run,plan.tool);handle.emit();
      let observation;
      try {
        if(WRITE_TOOLS.includes(plan.tool)) observation=await executeWrite(handle,plan.tool,{...plan.args,reason:plan.reason});
        else observation=await READ_HANDLERS[plan.tool]({args:plan.args,run,providers:deps.providers,governed:deps.governed,config:deps.config,signal,now:Date.now});
      } catch(error) {
        if(error.name==='AbortError' || stopped()){cancelled=true;break;}
        appendEvent(run,{kind:'tool',status:'failed',app:tool.app,label:`${plan.tool} failed`,detail:error.message,evidence:{code:error.code || 'TOOL'}});
        observation={tool:plan.tool,status:'failed',code:error.code || 'TOOL',detail:error.message};
      }
      observations.push({turn:run.turn,tool:plan.tool,result:observation});
      if(run.status==='executing') transition(run,'planning','Step done.');
      setStep(run,null);handle.emit();
    }
    if(!terminal && !cancelled && !runtimeFailure && run.turn>=MAX_TURNS){runtimeFailure=true;addError(run,{code:'TURN_CAP',message:`The agent used ${MAX_TURNS} turns without finishing.`,step:'model'});}
  } catch(error) {
    if(error.name==='AbortError' || stopped()) cancelled=true;
    else {runtimeFailure=true;addError(run,{code:error.code || 'RUNTIME',message:error.message,step:'runtime'});}
  }
  // Nothing unresolved is left as a guess: an uncertain write gets one more reconciliation before the ledger decides the terminal.
  // A Stop stops new work, not finding out what already happened, so the final reads run on their own short signal after a Stop.
  if(run.effects.some(e=>e.status==='uncertain')){
    const reads=cancelled?{...handle,signal:AbortSignal.timeout(30000)}:handle;
    try {await reconcileUncertain(reads);} catch(error){if(error.name!=='AbortError') addError(run,{code:error.code || 'RECONCILE',message:error.message,step:'verify'});}
  }
  // The model's `fail` says the goal was not met; the ledger still decides how. Nothing done reads failed, a policy refusal reads
  // blocked, verified writes read partial. Live Demo C in the panel, 2026-09-11: a DashClaw block followed by `fail` read Failed.
  const status=finalStatus(run,{cancelled,runtimeFailure,gaveUp:terminal?.kind==='fail'});
  run.finalMessage=String(terminal?.message || '').slice(0,1200);
  const closing=cancelled?'Stopped.':status==='uncertain'?'A write could not be confirmed either way. Check the app before acting again.':runtimeFailure?'The run could not finish.':'';
  if(terminal) appendEvent(run,{kind:'model',status:terminal.kind==='done'?'ok':'failed',label:terminal.kind==='done'?'The agent reports done':'The agent reports it cannot continue',detail:terminal.message});
  terminate(run,status,closing);
  handle.emit();
  return run;
}
