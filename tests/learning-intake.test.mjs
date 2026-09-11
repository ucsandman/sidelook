import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readEvidence,summarizeRun} from '../agent-learning/lib/intake.mjs';
import {createRun,appendEvent} from '../lib/agent/run.mjs';

async function tempDir(){return mkdtemp(join(tmpdir(),'sidelook-learning-intake-'));}

const SENTINEL='INJECT-ME-9f3a';

// Poisons exactly the fields the contract calls out (sourceFacts, events, finalMessage, entities) plus the
// obviously-textual corners of effects/approvals/errors/injection that are NOT on the allowlist (policy, receipt,
// verification.note, reconciliation.note, approval.reason, error.message, injection.text): none of these may
// survive. incidents.sanitizedEvidence.message is deliberately left alone: docs/AGENT_SELF_HEALING.md section 2
// documents it as bounded, scrubbed evidence the runtime itself produces, not retrieved text, so a leak-freedom
// assertion on it belongs to lib/agent/incidents.mjs's own tests, not this allowlist test.
function poisonedRun(overrides={}){
  const run=createRun({goal:'Refund Acme',model:'astra',effort:'low',...overrides});
  run.sourceFacts.push({key:'request',value:SENTINEL,label:'Customer request',source:'slack',ref:'x',at:run.createdAt});
  appendEvent(run,{kind:'tool',status:'ok',label:'slack.find_customer_request',detail:SENTINEL,evidence:{note:SENTINEL}});
  run.finalMessage=SENTINEL;
  run.entities={customer:{name:SENTINEL,email:SENTINEL+'@acme.com'}};
  run.effects.push({effectId:'fx_1',tool:'stripe.refund_payment',app:'stripe',opKey:'refund:pi_1',idempotencyKey:'k',status:'verified',attempts:1,executions:1,
    actionId:'act_1',decisionId:null,attemptId:null,policy:{note:SENTINEL},receipt:{note:SENTINEL},verification:{verified:true,note:SENTINEL},
    reconciliations:[{finding:'present',sweep:false,note:SENTINEL}],error:null,startedAt:run.createdAt,finishedAt:run.createdAt,series:1});
  run.approvals.push({status:'approved',decidedVia:'panel',actionId:'act_1',reason:SENTINEL,createdAt:run.createdAt,decidedAt:run.createdAt});
  run.errors.push({code:'ERR',message:SENTINEL,step:'plan',at:run.createdAt});
  run.incidents=[{incidentId:'inc_'+'a'.repeat(20),runId:run.runId,at:run.createdAt,updatedAt:run.createdAt,integration:'stripe',tool:'stripe.refund_payment',
    operation:'refund:pi_1',phase:'execute',failureClass:'transient_provider',family:'stripe:transient_provider:stripe.refund_payment',severity:'warn',
    providerStatus:500,attemptNumber:1,providerOperationId:null,dashclawActionId:'act_1',effectId:'fx_1',knownState:'not_sent',uncertainState:false,
    recoveryAttempted:true,recoveryStrategy:'retry',recoveryResult:'recovered',verificationResult:'verified',
    sanitizedEvidence:{code:'SERVER',message:'stripe.createRefund failed (failTimes).',ids:{}},finalDisposition:'recovered'}];
  run.injection=[{source:'slack',ref:SENTINEL,riskLevel:'high',categories:['role_override'],text:SENTINEL}];
  return run;
}

test('summarizeRun keeps only the allowlisted fields: the sentinel never survives, in any field',()=>{
  const run=poisonedRun();
  const summary=summarizeRun(run);
  const text=JSON.stringify(summary);
  assert.ok(!text.includes(SENTINEL),`sentinel leaked into RunSummary JSON: ${text}`);
  assert.equal(summary.goalLength,run.goal.length);
  assert.equal(summary.runId,run.runId);
  assert.equal(summary.effects[0].effectId,'fx_1');
  assert.equal(summary.effects[0].verification.verified,true);
  assert.equal(summary.effects[0].reconciliations[0].finding,'present');
  assert.equal(summary.approvals[0].status,'approved');
  assert.equal(summary.errors[0].code,'ERR');
  assert.equal(summary.incidents[0].incidentId,'inc_'+'a'.repeat(20));
  assert.equal(summary.injection[0].riskLevel,'high');
  assert.equal(typeof summary.events,'object');
  assert.equal(summary.events.tool.ok,1);
});

test('summarizeRun never copies goal text, only its length',()=>{
  const run=createRun({goal:'A goal with secret details nobody should see'});
  const summary=summarizeRun(run);
  assert.equal(summary.goal,undefined);
  assert.equal(summary.goalLength,run.goal.length);
});

test('readEvidence reads runs/*.json and incidents/*.json, and the sentinel never survives on disk either',async()=>{
  const dataDir=await tempDir();
  await mkdir(join(dataDir,'runs'),{recursive:true});
  await mkdir(join(dataDir,'incidents'),{recursive:true});
  const run=poisonedRun();
  await writeFile(join(dataDir,'runs',`${run.runId}.json`),JSON.stringify(run),'utf8');
  const incident={incidentId:'inc_'+'b'.repeat(20),runId:run.runId,at:run.createdAt,updatedAt:run.createdAt,integration:'hubspot',
    tool:'hubspot.update_customer',operation:'update:123',phase:'execute',failureClass:'transient_provider',
    family:'hubspot:transient_provider:hubspot.update_customer',severity:'warn',providerStatus:500,attemptNumber:2,
    providerOperationId:null,dashclawActionId:null,effectId:null,knownState:'not_sent',uncertainState:false,recoveryAttempted:true,
    recoveryStrategy:'retry',recoveryResult:'recovered',verificationResult:'verified',finalDisposition:'recovered',
    sanitizedEvidence:{code:'SERVER',message:'hubspot.updateContact failed (failTimes).',ids:{}}};
  await writeFile(join(dataDir,'incidents',`${incident.incidentId}.json`),JSON.stringify(incident),'utf8');

  const evidence=await readEvidence({dataDir});
  assert.equal(evidence.counts.runsRead,1);
  assert.equal(evidence.counts.runsSkipped,0);
  assert.equal(evidence.counts.incidentsRead,1);
  assert.equal(evidence.runs.length,1);
  assert.equal(evidence.incidents.length,1);
  assert.equal(evidence.evalReport,null);
  const text=JSON.stringify(evidence);
  assert.ok(!text.includes(SENTINEL),`sentinel leaked into readEvidence output: ${text}`);
  await rm(dataDir,{recursive:true,force:true});
});

test('readEvidence skips a malformed run file and counts it, never throws',async()=>{
  const dataDir=await tempDir();
  await mkdir(join(dataDir,'runs'),{recursive:true});
  await writeFile(join(dataDir,'runs','not-json.json'),'{not valid','utf8');
  await writeFile(join(dataDir,'runs','wrong-shape.json'),JSON.stringify({runId:'run_x',status:'not_a_status'}),'utf8');
  const good=createRun({goal:'Fine'});
  await writeFile(join(dataDir,'runs',`${good.runId}.json`),JSON.stringify(good),'utf8');
  const evidence=await readEvidence({dataDir});
  assert.equal(evidence.counts.runsRead,1);
  assert.equal(evidence.counts.runsSkipped,2);
  await rm(dataDir,{recursive:true,force:true});
});

test('readEvidence tolerates a missing dataDir/runs and dataDir/incidents entirely (fresh install)',async()=>{
  const dataDir=await tempDir();
  const evidence=await readEvidence({dataDir});
  assert.deepEqual(evidence.counts,{runsRead:0,runsSkipped:0,incidentsRead:0,incidentsSkipped:0,evalReportError:null});
  assert.deepEqual(evidence.runs,[]);
  assert.deepEqual(evidence.incidents,[]);
  await rm(dataDir,{recursive:true,force:true});
});

test('readEvidence honours `since`: a run older than the cutoff is neither read nor counted as skipped',async()=>{
  const dataDir=await tempDir();
  await mkdir(join(dataDir,'runs'),{recursive:true});
  const oldRun=createRun({goal:'Old',at:'2026-01-01T00:00:00.000Z'});
  const newRun=createRun({goal:'New',at:'2026-09-01T00:00:00.000Z'});
  await writeFile(join(dataDir,'runs',`${oldRun.runId}.json`),JSON.stringify(oldRun),'utf8');
  await writeFile(join(dataDir,'runs',`${newRun.runId}.json`),JSON.stringify(newRun),'utf8');
  const evidence=await readEvidence({dataDir,since:'2026-06-01T00:00:00.000Z'});
  assert.equal(evidence.runs.length,1);
  assert.equal(evidence.runs[0].runId,newRun.runId);
  assert.equal(evidence.counts.runsRead,1);
  assert.equal(evidence.counts.runsSkipped,0);
  await rm(dataDir,{recursive:true,force:true});
});

test('readEvidence loads an optional evalReportPath, and tolerates a missing or unparsable one',async()=>{
  const dataDir=await tempDir();
  const reportPath=join(dataDir,'eval.json');
  await writeFile(reportPath,JSON.stringify({scenarios:[],metrics:{scenarioPassRate:1}}),'utf8');
  const withReport=await readEvidence({dataDir,evalReportPath:reportPath});
  assert.deepEqual(withReport.evalReport,{scenarios:[],metrics:{scenarioPassRate:1}});
  assert.equal(withReport.counts.evalReportError,null);
  const missing=await readEvidence({dataDir,evalReportPath:join(dataDir,'nope.json')});
  assert.equal(missing.evalReport,null);
  assert.equal(missing.counts.evalReportError,null,'a missing file is not an error, per the contract');
  await rm(dataDir,{recursive:true,force:true});
});

test('readEvidence records evalReportError for an unparsable eval report, instead of a silent null',async()=>{
  const dataDir=await tempDir();
  const reportPath=join(dataDir,'eval.json');
  await writeFile(reportPath,'{not valid json','utf8');
  const evidence=await readEvidence({dataDir,evalReportPath:reportPath});
  assert.equal(evidence.evalReport,null);
  assert.ok(evidence.counts.evalReportError,'a parse failure must be recorded, not silently swallowed');
  await rm(dataDir,{recursive:true,force:true});
});

test('readEvidence counts a malformed incident file under incidentsSkipped',async()=>{
  const dataDir=await tempDir();
  await mkdir(join(dataDir,'incidents'),{recursive:true});
  await writeFile(join(dataDir,'incidents','bad.json'),'{not valid','utf8');
  await writeFile(join(dataDir,'incidents','wrong-shape.json'),JSON.stringify({notAnIncident:true}),'utf8');
  const evidence=await readEvidence({dataDir});
  assert.equal(evidence.counts.incidentsRead,0);
  assert.equal(evidence.counts.incidentsSkipped,2);
  await rm(dataDir,{recursive:true,force:true});
});

test('readEvidence throws when called without a dataDir',async()=>{
  await assert.rejects(readEvidence({}));
});
