// Probes all five integrations in parallel, bounded, and never throws: the /api/agent health op and the panel's app
// dots read this directly. Contract: sections 7, 8 and 11.
import {redactText} from './redact.mjs';

const TIMEOUT_MS=6000;

function withTimeout(promise){
  let timer;
  const bound=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Health check timed out.')),TIMEOUT_MS);});
  return Promise.race([promise,bound]).finally(()=>clearTimeout(timer));
}
const failDetail=error=>redactText(String(error?.message ?? error)).slice(0,300);

async function probeSlack(config,providers){
  const configured=!!config?.slack?.configured;
  try{await withTimeout(providers.slack.health());return {configured,ok:true,detail:''};}
  catch(error){return {configured,ok:false,detail:failDetail(error)};}
}
async function probeStripe(config,providers){
  const configured=!!config?.stripe?.configured;
  try{const result=await withTimeout(providers.stripe.health());return {configured,ok:true,mode:result?.mode || config?.stripe?.mode || 'none',detail:''};}
  catch(error){return {configured,ok:false,mode:config?.stripe?.mode || 'none',detail:failDetail(error)};}
}
async function probeHubspot(config,providers){
  const configured=!!config?.hubspot?.configured;
  try{await withTimeout(providers.hubspot.health());return {configured,ok:true,detail:''};}
  catch(error){return {configured,ok:false,detail:failDetail(error)};}
}
async function probeGmail(config,providers){
  const configured=!!config?.gmail?.configured;
  try{const result=await withTimeout(providers.gmail.health());return {configured,ok:true,address:result?.address || '',detail:''};}
  catch(error){return {configured,ok:false,address:'',detail:failDetail(error)};}
}
async function probeDashclaw(governed){
  if(!governed) return {configured:false,ok:false,approverRole:'unknown',nonFabrication:false,policies:[],detail:'DashClaw is not configured.'};
  try{
    const result=await withTimeout(governed.health());
    // ok means the instance answered its health probe, not merely that keys are set. The Sidelook rows are counted by name prefix
    // so the line under the goal can say how much of the hackathon pack is installed (scripts/agent-setup-dashclaw.mjs installs six).
    // Only the rows Agent mode depends on are listed; a real org carries hundreds of unrelated rows (measured 2026-09-10: 194).
    const all=result?.policies || [];
    const policies=all.filter(name=>String(name).startsWith('sidelook-agent:'));
    const sidelookPolicies=policies.length;
    const reachable=!!result?.configured && !!result?.version;
    return {
      configured:!!result?.configured,ok:reachable,approverRole:result?.approverRole || 'unknown',
      nonFabrication:!!result?.nonFabrication,policies,sidelookPolicies,version:result?.version || null,
      detail:!result?.configured?'DashClaw is not configured.':!reachable?'DashClaw did not answer its health probe.':`${sidelookPolicies} of 6 Sidelook policies installed · approver ${result?.approverRole || 'unknown'} · non-fabrication ${result?.nonFabrication?'on':'off'}`
    };
  } catch(error){return {configured:false,ok:false,approverRole:'unknown',nonFabrication:false,policies:[],detail:failDetail(error)};}
}

export function createHealth({config,providers,governed}={}){
  return async function health(){
    const [slack,stripe,hubspot,gmail,dashclaw]=await Promise.all([
      probeSlack(config,providers),probeStripe(config,providers),probeHubspot(config,providers),probeGmail(config,providers),probeDashclaw(governed)
    ]);
    const apps={slack,stripe,hubspot,gmail,dashclaw};
    const list=Object.values(apps);
    const ready=list.every(app=>!app.configured || app.ok) && dashclaw.ok===true;
    const configuredCount=list.filter(app=>app.configured).length;
    const okCount=list.filter(app=>app.ok).length;
    return {apps,ready,detail:`${okCount} of ${configuredCount} configured app(s) healthy.`};
  };
}
