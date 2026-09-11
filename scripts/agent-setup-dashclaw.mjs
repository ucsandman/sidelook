// Installs (or removes) the six DashClaw policies Agent mode depends on. Contract: docs/AGENT_MODE_IMPLEMENTATION.md sections 8, 15.
// node scripts/agent-setup-dashclaw.mjs [--dry-run] [--remove]
import {existsSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const HEADER='x-api-key';

// The six rows, exact names/types/rules from the contract. agent_ids scopes every row to one agent so it never touches another.
// short_list: true is what keeps a row interrupting: without it DashClaw's Short List admission demotes the verdict to warn
// (measured 2026-09-10 on a live org: four rows created without the flag came back as action warn). The org has ten slots.
export const SIDELOOK_POLICIES=[
  // The two holds are `ungrantable`: DashClaw's interruption budget otherwise demotes a hold to `warn` without human review once
  // one command shape has asked more than 10 times in 24 h (builtin:shape_budget; a $485.00 test refund ran unheld on 2026-09-11).
  // Ungrantable stops every automatic relief; a real operator approval still authorizes the claim (evaluate.grants.ts).
  {name:'sidelook-agent: refunds need a human',policy_type:'protected_path',rules:{paths:['**/v1/refunds*'],action:'require_approval',ungrantable:true,short_list:true}},
  {name:'sidelook-agent: hold when the agent is unsure',policy_type:'risk_threshold',rules:{threshold:90,action:'require_approval',ungrantable:true,short_list:true}},
  {name:'sidelook-agent: block over the ceiling',policy_type:'risk_threshold',rules:{threshold:100,action:'block',short_list:true}},
  // content_path/source_path point into the act: DashClaw strips these paths from the decision context it stores, and the
  // execution claim re-evaluates from that stored context plus the act sent with the claim (app/lib/guard/execution.ts).
  // Top-level content/source_of_truth are stripped and then missing at the claim, which fails closed (seen live 2026-09-11).
  {name:'sidelook-agent: no fabricated email',policy_type:'non_fabrication',rules:{action_types:['email'],on_violation:'block',content_path:'act.evidence.content',source_path:'act.evidence.source_of_truth',short_list:true}},
  {name:'sidelook-agent: only api and email',policy_type:'role_constraint',rules:{allowed_action_types:['api','email'],escalate_action:'block',short_list:true}},
  {name:'sidelook-agent: writes carry evidence',policy_type:'require_evidence',rules:{action_types:['api','email'],enforcement:'block',short_list:true}}
];

// The verdict fields the server may rewrite on admission. A stored row whose verdict differs from the one sent is not installed.
const VERDICT_FIELDS=['action','on_violation','escalate_action','enforcement','ungrantable'];
export function verdictDrift(policy,row){
  let stored;try{stored=typeof row?.rules==='string'?JSON.parse(row.rules):(row?.rules || {});}catch{return 'stored rules are not JSON';}
  if(row?.policy_type && row.policy_type!==policy.policy_type) return `stored as ${row.policy_type}`;
  for(const field of VERDICT_FIELDS) if(policy.rules[field]!==undefined && stored[field]!==policy.rules[field]) return `${field} stored as ${stored[field] ?? '(none)'}, sent ${policy.rules[field]}`;
  return null;
}

export class DashClawSetupError extends Error {
  constructor(code,message){super(message);this.code=code;}
}

const safeText=async response=>{try{return await response.text();}catch{return '';}};
const safeJson=async response=>{try{return await response.json();}catch{return null;}};

// Every row already present in the org, by name. A network or auth failure here aborts the whole run: without this list a
// missing-row POST cannot be told apart from a duplicate, and the script must never guess.
async function listExisting({baseUrl,approverKey,fetchImpl}){
  let response;
  try{response=await fetchImpl(`${baseUrl}/api/policies`,{headers:{[HEADER]:approverKey}});}
  catch(error){throw new DashClawSetupError('NETWORK',`Could not reach ${baseUrl}/api/policies: ${error.message}`);}
  if(!response.ok) throw new DashClawSetupError('LIST_FAILED',`GET /api/policies returned ${response.status}: ${await safeText(response)}`);
  const body=await safeJson(response);
  return Array.isArray(body?.policies)?body.policies:[];
}

function policyBody(policy,agentId){
  return {name:policy.name,policy_type:policy.policy_type,rules:JSON.stringify(policy.rules),active:1,agent_ids:JSON.stringify([agentId]),created_by:'sidelook-setup'};
}

// Real DashClaw 409s are not all "duplicate name": the Short List admission path (app/lib/guardrails/short-list.ts) also answers
// 409 with a typed code when the org's ten interrupting slots are full, or when a no-watch-tier type (non_fabrication,
// role_constraint here) cannot be demoted. Only a bare 409 with no such code is treated as "this row already exists".
const SHORT_LIST_CODES=new Set(['SHORT_LIST_FULL','NO_WATCH_TIER']);

async function createOne(policy,{baseUrl,approverKey,agentId,fetchImpl,dryRun}){
  const body=policyBody(policy,agentId);
  if(dryRun){
    console.log(`Would POST /api/policies for "${policy.name}": ${JSON.stringify(body)}`);
    return {name:policy.name,type:policy.policy_type,status:'would-create'};
  }
  let response;
  try{response=await fetchImpl(`${baseUrl}/api/policies`,{method:'POST',headers:{[HEADER]:approverKey,'content-type':'application/json'},body:JSON.stringify(body)});}
  catch(error){return {name:policy.name,type:policy.policy_type,status:`failed: ${error.message}`};}
  if(response.status===409){
    const errorBody=await safeJson(response);
    if(errorBody && SHORT_LIST_CODES.has(errorBody.code)) return {name:policy.name,type:policy.policy_type,status:`failed: ${errorBody.error || errorBody.code}`};
    return {name:policy.name,type:policy.policy_type,status:'present'};
  }
  if(!response.ok) return {name:policy.name,type:policy.policy_type,status:`failed: ${response.status} ${await safeText(response)}`};
  // The server may have admitted the row with a softer verdict; the stored row, not the 201, says what was installed.
  const created=await safeJson(response);
  const drift=created?.policy?verdictDrift(policy,created.policy):null;
  return {name:policy.name,type:policy.policy_type,status:drift?`failed: created but ${drift}`:'created'};
}

async function removeOne(policy,existingByName,{baseUrl,approverKey,fetchImpl,dryRun}){
  const match=existingByName.get(policy.name);
  if(!match) return {name:policy.name,type:policy.policy_type,status:'absent'};
  if(dryRun){
    console.log(`Would DELETE /api/policies?id=${match.id} for "${policy.name}"`);
    return {name:policy.name,type:policy.policy_type,status:'would-remove'};
  }
  let response;
  try{response=await fetchImpl(`${baseUrl}/api/policies?id=${encodeURIComponent(match.id)}`,{method:'DELETE',headers:{[HEADER]:approverKey}});}
  catch(error){return {name:policy.name,type:policy.policy_type,status:`failed: ${error.message}`};}
  if(response.status===404) return {name:policy.name,type:policy.policy_type,status:'absent'};
  if(!response.ok) return {name:policy.name,type:policy.policy_type,status:`failed: ${response.status} ${await safeText(response)}`};
  return {name:policy.name,type:policy.policy_type,status:'removed'};
}

function printTable(rows){
  const nameWidth=Math.max(...rows.map(r=>r.name.length),4);
  const typeWidth=Math.max(...rows.map(r=>r.type.length),4);
  console.log(`${'name'.padEnd(nameWidth)}  ${'type'.padEnd(typeWidth)}  status`);
  for(const row of rows) console.log(`${row.name.padEnd(nameWidth)}  ${row.type.padEnd(typeWidth)}  ${row.status}`);
}

// The one entry point tests drive with a fake fetch: installs the six policies by default, or removes them with remove:true.
// Never throws on an API failure (a row becomes a `failed:` status instead); only a listing failure (which leaves every row
// undecidable) short-circuits the whole run. Returns {ok, rows} so a caller can set its own exit code from the return value.
export async function installDashclawPolicies({baseUrl,approverKey,agentId='sidelook-agent',fetchImpl=fetch,dryRun=false,remove=false}={}){
  if(!baseUrl || !approverKey){
    const rows=SIDELOOK_POLICIES.map(p=>({name:p.name,type:p.policy_type,status:'failed: DASHCLAW_BASE_URL and an approver key (DASHCLAW_APPROVER_API_KEY or DASHCLAW_API_KEY) are required'}));
    printTable(rows);
    return {ok:false,rows};
  }
  let existing;
  try{existing=await listExisting({baseUrl,approverKey,fetchImpl});}
  catch(error){
    const rows=SIDELOOK_POLICIES.map(p=>({name:p.name,type:p.policy_type,status:`failed: ${error.message}`}));
    printTable(rows);
    return {ok:false,rows};
  }
  const existingByName=new Map(existing.filter(p=>p && typeof p.name==='string').map(p=>[p.name,p]));
  const rows=[];
  for(const policy of SIDELOOK_POLICIES){
    if(remove){rows.push(await removeOne(policy,existingByName,{baseUrl,approverKey,fetchImpl,dryRun}));continue;}
    const found=existingByName.get(policy.name);
    if(found){const drift=verdictDrift(policy,found);rows.push({name:policy.name,type:policy.policy_type,status:drift?`failed: present but ${drift} (run --remove, then install again)`:'present'});continue;}
    rows.push(await createOne(policy,{baseUrl,approverKey,agentId,fetchImpl,dryRun}));
  }
  printTable(rows);
  const ok=rows.every(r=>!r.status.startsWith('failed'));
  return {ok,rows};
}

// Same env-loading fallback as lib/agent/index.mjs's createAgentRuntime: prefer lib/agent/config.mjs when Track A has landed it
// (it owns process.loadEnvFile), fall back to a direct local .env read so this script still runs before that module exists.
async function loadEnv(){
  try{const {loadConfig}=await import('../lib/agent/config.mjs');loadConfig();}
  catch(error){
    if(error.code!=='ERR_MODULE_NOT_FOUND') throw error;
    if(existsSync('.env')){
      try{process.loadEnvFile('.env');}
      catch(loadError){console.error(`Warning: .env could not be loaded (${loadError.message}); using the process environment as-is.`);}
    }
  }
  return {
    baseUrl:process.env.DASHCLAW_BASE_URL || '',
    approverKey:process.env.DASHCLAW_APPROVER_API_KEY || process.env.DASHCLAW_API_KEY || '',
    agentId:process.env.DASHCLAW_AGENT_ID || 'sidelook-agent'
  };
}

async function main(){
  const dryRun=process.argv.includes('--dry-run'),remove=process.argv.includes('--remove');
  const {baseUrl,approverKey,agentId}=await loadEnv();
  const {ok}=await installDashclawPolicies({baseUrl,approverKey,agentId,dryRun,remove});
  process.exitCode=ok?0:1;
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) await main();
