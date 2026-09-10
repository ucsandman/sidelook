// Atomic on-disk persistence for one run per file: the last successful write is the only truth the runtime trusts after a restart.
// Contract: docs/AGENT_MODE_IMPLEMENTATION.md section 4.
import {mkdir,writeFile,rename,readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {STATES} from './run.mjs';

const RUN_ID=/^run_[a-f0-9]{20}$/;
const identity=value=>value;

function malformed(run){
  if(!run || typeof run!=='object' || Array.isArray(run)) return true;
  if(!STATES.includes(run.status)) return true;
  if(!Array.isArray(run.events) || !Array.isArray(run.effects) || !Array.isArray(run.approvals)) return true;
  return false;
}

export class RunStore {
  constructor({dir,redactor}={}){
    if(!dir) throw new Error('RunStore needs a directory.');
    this.dir=dir;this.redactor=redactor || null;this.chains=new Map();this.dirReady=null;
  }
  async ensureDir(){
    if(!this.dirReady) this.dirReady=mkdir(this.dir,{recursive:true});
    await this.dirReady;
  }
  // The redactor defaults to Track A's redact.mjs; a build without it yet (or a test that injects its own) still works.
  async resolveRedactor(){
    if(this.redactor) return this.redactor;
    try{
      const mod=await import('./redact.mjs');
      this.redactor=typeof mod.redact==='function'?mod.redact:identity;
    } catch(error){
      if(error.code!=='ERR_MODULE_NOT_FOUND') throw error;
      this.redactor=identity;
    }
    return this.redactor;
  }
  path(runId){return join(this.dir,`${runId}.json`);}
  // Two saves of the same run never interleave: each runId gets its own promise chain, so a second save waits for the first's rename.
  save(run){
    const runId=run?.runId;
    if(typeof runId!=='string' || !RUN_ID.test(runId)) return Promise.reject(new Error(`RunStore.save needs a valid runId, got ${JSON.stringify(runId)}.`));
    const previous=this.chains.get(runId) || Promise.resolve();
    const next=previous.then(()=>this.writeOnce(runId,run),()=>this.writeOnce(runId,run));
    this.chains.set(runId,next.catch(()=>{}));
    return next;
  }
  async writeOnce(runId,run){
    await this.ensureDir();
    const redactor=await this.resolveRedactor();
    const redacted=(await redactor(run)) ?? run;
    const text=JSON.stringify(redacted);
    const file=this.path(runId),tmp=`${file}.tmp`;
    await writeFile(tmp,text,'utf8');
    await rename(tmp,file);
  }
  // Missing, unparsable and malformed all read the same to a caller: nothing usable was on disk.
  async load(runId){
    if(typeof runId!=='string' || !RUN_ID.test(runId)) return null;
    let text;
    try{text=await readFile(this.path(runId),'utf8');}
    catch{return null;}
    let run;
    try{run=JSON.parse(text);}
    catch{return null;}
    if(malformed(run)) return null;
    return run;
  }
  // File mtimes are not reliable enough on every filesystem to rank close writes (measured: two saves a few ms
  // apart landed with the same mtimeMs on NTFS), so every matching file is read and the ledger's own createdAt
  // decides the order; only the newest `limit` survive the slice.
  async list({limit=50}={}){
    await this.ensureDir();
    let entries;
    try{entries=await readdir(this.dir,{withFileTypes:true});}
    catch{return [];}
    const runIds=entries.filter(e=>e.isFile() && e.name.endsWith('.json')).map(e=>e.name.slice(0,-'.json'.length)).filter(id=>RUN_ID.test(id));
    const loaded=await Promise.all(runIds.map(runId=>this.load(runId)));
    const items=loaded.filter(Boolean).map(run=>({runId:run.runId,goal:run.goal,status:run.status,createdAt:run.createdAt,updatedAt:run.updatedAt}));
    items.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
    return items.slice(0,Math.max(0,limit));
  }
}
