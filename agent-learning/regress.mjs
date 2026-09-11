#!/usr/bin/env node
// The regression corpus runner: CLI and module. Loads agent-learning/regressions/<set>/reg_*.json, validates each against
// the schema in docs/AGENT_LEARNING_LOOP.md §8, and runs them through eval/run.mjs's own scenario driver so a regression
// gets exactly the same pass/fail, invariants and incidents shape as the fixed eval suite.
// `node agent-learning/regress.mjs --set dev|holdout|all [--root <tree>] [--json <path>]`
import {readdir,readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runScenarios,printTable} from '../eval/run.mjs';

// Resolved from this file's own location, not process.cwd(), so this works the same whether invoked from the repo root or
// spawned by agent-learning/lib/evaluate.mjs with cwd set to a candidate worktree.
const DEFAULT_ROOT=fileURLToPath(new URL('..',import.meta.url));

const REQUIRED_TOP_LEVEL=['id','name','set','family','source','fingerprint','goal','expect'];

function schemaError(file,field,detail){
  return Object.assign(new Error(`${file}: ${field} ${detail}`),{code:'REGRESSION_SCHEMA',file,field});
}

function validateScenario(file,scenario){
  if(!scenario || typeof scenario!=='object') throw schemaError(file,'(root)','must be a JSON object');
  for(const field of REQUIRED_TOP_LEVEL) if(scenario[field]===undefined) throw schemaError(file,field,'is required');
  if(typeof scenario.id!=='string' || !scenario.id.startsWith('reg_')) throw schemaError(file,'id','must be a string starting with "reg_"');
  if(typeof scenario.name!=='string' || !scenario.name) throw schemaError(file,'name','must be a nonempty string');
  if(scenario.set!=='dev' && scenario.set!=='holdout') throw schemaError(file,'set','must be "dev" or "holdout"');
  if(typeof scenario.goal!=='string' || !scenario.goal) throw schemaError(file,'goal','must be a nonempty string');
  if(!scenario.expect || typeof scenario.expect!=='object') throw schemaError(file,'expect','must be an object');
  if(typeof scenario.expect.status!=='string') throw schemaError(file,'expect.status','must be a string');
  if(!scenario.expect.writes || typeof scenario.expect.writes!=='object') throw schemaError(file,'expect.writes','must be an object');
  if(!scenario.expect.approvals || typeof scenario.expect.approvals!=='object') throw schemaError(file,'expect.approvals','must be an object');
  if(typeof scenario.expect.recovered!=='boolean') throw schemaError(file,'expect.recovered','must be a boolean');
  if(typeof scenario.expect.noSuccessClaim!=='boolean') throw schemaError(file,'expect.noSuccessClaim','must be a boolean');
  for(const optional of ['fixtures','faults','dashclaw','model']) if(scenario[optional]!==undefined && typeof scenario[optional]!=='object') throw schemaError(file,optional,'must be an object when present');
}

// Reads and validates every reg_*.json in agent-learning/regressions/<set>/ (set 'all' reads dev and holdout). Returns
// scenario objects in the shape eval/run.mjs's runScenarios expects (string ids are fine for the runner).
export async function loadCorpus({root=DEFAULT_ROOT,set}={}){
  const sets=set==='all' ? ['dev','holdout'] : [set];
  const scenarios=[];
  for(const oneSet of sets){
    const dir=join(root,'agent-learning','regressions',oneSet);
    const files=(await readdir(dir).catch(() => [])).filter(f=>/^reg_.*\.json$/.test(f)).sort();
    for(const file of files){
      const path=join(dir,file);
      let scenario;
      try{scenario=JSON.parse(await readFile(path,'utf8'));}
      catch(error){throw schemaError(file,'(parse)',`could not be parsed as JSON: ${error.message}`);}
      validateScenario(file,scenario);
      scenarios.push(scenario);
    }
  }
  return scenarios;
}

function parseArgs(argv){
  const args={set:null,root:DEFAULT_ROOT,json:null};
  for(let i=0;i<argv.length;i++){
    if(argv[i]==='--set') args.set=argv[++i];
    else if(argv[i]==='--root') args.root=argv[++i];
    else if(argv[i]==='--json') args.json=argv[++i];
  }
  return args;
}

async function main(){
  const args=parseArgs(process.argv.slice(2));
  if(args.set!=='dev' && args.set!=='holdout' && args.set!=='all'){
    console.error('Usage: node agent-learning/regress.mjs --set dev|holdout|all [--root <tree>] [--json <path>]');
    process.exitCode=1;
    return;
  }
  const scenarios=await loadCorpus({root:args.root,set:args.set});
  const report={generatedAt:new Date().toISOString(),set:args.set,scenarios:[],metrics:null};
  if(!scenarios.length){
    console.log(`0 regression scenarios in ${args.set}.`);
    report.metrics={scenarioPassRate:0,scenariosPassed:0,scenariosTotal:0};
    if(args.json){await mkdir(dirname(args.json),{recursive:true}).catch(() => {});await writeFile(args.json,JSON.stringify(report,null,2));}
    process.exitCode=0;
    return;
  }
  const {scenarios:results,metrics}=await runScenarios(scenarios);
  printTable(results);
  console.log(`\n${metrics.scenariosPassed}/${metrics.scenariosTotal} regression scenarios passed in ${args.set} (${Math.round(metrics.scenarioPassRate*100)}%).`);
  report.scenarios=results;
  report.metrics=metrics;
  if(args.json){await mkdir(dirname(args.json),{recursive:true}).catch(() => {});await writeFile(args.json,JSON.stringify(report,null,2));}
  process.exitCode=results.every(r=>r.pass) ? 0 : 1;
}

// Only a direct `node agent-learning/regress.mjs` runs the CLI; agent-learning/lib/evaluate.mjs spawns exactly that.
// path.resolve compares real filesystem paths, not a percent-encoded URL pathname: `new URL(import.meta.url).pathname`
// percent-encodes characters like a space, so a checkout under e.g. "C:/Users/First Last/..." made the old comparison
// fail silently (main() never ran, the CLI printed nothing and wrote no --json report) on any path containing a space.
if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === resolve(fileURLToPath(import.meta.url)).toLowerCase()) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
