// Prints Agent mode's health across all five integrations, the same object the panel's app dots read from
// POST /api/agent {op:'health'}. Never prints a secret: only the health object returned by lib/agent/health.mjs
// (booleans, status words, and detail strings that are themselves already redacted) ever reaches stdout.
// Contract: docs/AGENT_MODE_IMPLEMENTATION.md sections 8, 11, 17.
// node scripts/agent-health.mjs [--json]
import {pathToFileURL} from 'node:url';
import {loadConfig} from '../lib/agent/config.mjs';
import {createProviders} from '../lib/agent/providers/index.mjs';
import {createGoverned} from '../lib/agent/governed.mjs';
import {createHealth} from '../lib/agent/health.mjs';

const NAME_WIDTH=8,STATUS_WIDTH=6;
const line=(name,ok,detail)=>`${name.padEnd(NAME_WIDTH)}  ${(ok?'ok':'FAIL').padEnd(STATUS_WIDTH)}  ${detail}`;

function stripeDetail(app){
  const base=app.detail || (app.ok?'Reachable.':'');
  return `${base}${base?'; ':''}mode: ${app.mode || 'none'}`;
}
// health.mjs already folds the approver role and non-fabrication presence into `detail` once DashClaw answers; this only
// adds them back when detail has nothing to say yet (not configured, or the probe itself failed) so the two facts the
// hackathon setup cares about are never missing from the line.
function dashclawDetail(app){
  const base=app.detail || '';
  if(/approver/i.test(base)) return base;
  const approver=`approver role: ${app.approverRole || 'unknown'}`;
  const nonFab=`non-fabrication policy: ${app.nonFabrication?'present':'missing'}`;
  return base?`${base}; ${approver}; ${nonFab}`:`${approver}; ${nonFab}`;
}

export async function checkHealth({env=process.env}={}){
  const config=loadConfig({env});
  const providers=createProviders({config});
  const governed=createGoverned({config});
  const health=createHealth({config,providers,governed});
  return health();
}

async function main(){
  const asJson=process.argv.includes('--json');
  const result=await checkHealth();
  if(asJson){
    console.log(JSON.stringify(result,null,2));
    process.exitCode=result.ready?0:1;
    return;
  }
  const {apps}=result;
  console.log(line('slack',apps.slack.ok,apps.slack.detail || (apps.slack.ok?'Reachable.':'')));
  console.log(line('stripe',apps.stripe.ok,stripeDetail(apps.stripe)));
  console.log(line('hubspot',apps.hubspot.ok,apps.hubspot.detail || (apps.hubspot.ok?'Reachable.':'')));
  console.log(line('gmail',apps.gmail.ok,apps.gmail.detail || (apps.gmail.ok?`Sending as ${apps.gmail.address}.`:'')));
  console.log(line('dashclaw',apps.dashclaw.ok,dashclawDetail(apps.dashclaw)));
  console.log(`ready: ${result.ready?'yes':'no'}`);
  process.exitCode=result.ready?0:1;
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) await main();
