// Circuit breakers: a repeat of one failure class on one integration pauses that integration for a while, so a run does not
// spend its attempts on a dead token or an outage and a write is refused before DashClaw ever hears of it. State is per
// process and snapshotted to disk, so an open auth breaker survives a restart. Contract: docs/AGENT_SELF_HEALING.md section 5.
import {mkdirSync,writeFileSync,renameSync,readFileSync} from 'node:fs';
import {dirname} from 'node:path';

export const BREAKER_POLICY=Object.freeze({
  'stripe:authentication_expired':{threshold:2,windowMs:600000,cooldownMs:900000},
  'hubspot:authentication_expired':{threshold:2,windowMs:600000,cooldownMs:900000},
  'gmail:authentication_expired':{threshold:2,windowMs:600000,cooldownMs:900000},
  'slack:authentication_expired':{threshold:2,windowMs:600000,cooldownMs:900000},
  'hubspot:rate_limit':{threshold:3,windowMs:300000,cooldownMs:120000},
  'stripe:rate_limit':{threshold:3,windowMs:300000,cooldownMs:120000},
  'gmail:rate_limit':{threshold:3,windowMs:300000,cooldownMs:120000},
  'slack:rate_limit':{threshold:3,windowMs:300000,cooldownMs:120000},
  '*:transient_provider':{threshold:5,windowMs:300000,cooldownMs:60000},
  '*:timeout_before_request':{threshold:5,windowMs:300000,cooldownMs:60000},
  'dashclaw:dashclaw_unavailable':{threshold:2,windowMs:300000,cooldownMs:60000},
  'model:malformed_model_output':{threshold:4,windowMs:900000,cooldownMs:300000},
  'model:unsupported_tool_request':{threshold:4,windowMs:900000,cooldownMs:300000}
});

const OUTAGE_CLASSES=new Set(['transient_provider','timeout_before_request','rate_limit','dashclaw_unavailable']);
const LABEL={stripe:'Stripe',hubspot:'HubSpot',gmail:'Gmail',slack:'Slack',dashclaw:'DashClaw',model:'The model',sidelook:'Sidelook'};
const WORDS={authentication_expired:'authentication failures',rate_limit:'rate limits',transient_provider:'provider failures',timeout_before_request:'connection failures',dashclaw_unavailable:'unreachable answers',malformed_model_output:'malformed plans',unsupported_tool_request:'unknown tool requests'};
const clock=at=>at?new Date(at).getTime():Date.now();
const hhmm=ms=>{const d=new Date(ms);return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;};

export class CircuitBreakers {
  constructor({policy=BREAKER_POLICY,now=Date.now,path=null}={}){
    this.policy=policy;this.now=now;this.path=path;this.keys=new Map();
    if(path) this.load();
  }
  rule(integration,failureClass){return this.policy[`${integration}:${failureClass}`] || this.policy[`*:${failureClass}`] || null;}
  entry(key){
    if(!this.keys.has(key)){const [integration,failureClass]=key.split(':');this.keys.set(key,{key,integration,failureClass,state:'closed',failures:[],openedAt:null,until:null,reason:'',trialTaken:false});}
    return this.keys.get(key);
  }
  // Open breakers for this integration answer first; after the cooldown one trial call is let through (half open), and the
  // next recordSuccess closes the circuit while the next recordFailure opens it again for a full cooldown.
  check(integration,{kind='read'}={}){
    const at=this.now();
    for(const entry of this.keys.values()){
      if(entry.integration!==integration) continue;
      if(entry.state==='open' && at>=entry.until){entry.state='half_open';entry.trialTaken=false;this.save();}
      if(entry.state==='half_open'){
        if(!entry.trialTaken){entry.trialTaken=true;return {open:false,trial:true,key:entry.key};}
        return {open:true,halfOpen:true,key:entry.key,failureClass:entry.failureClass,reason:entry.reason,until:new Date(entry.until).toISOString(),failures:entry.failures.length,kind};
      }
      if(entry.state==='open') return {open:true,halfOpen:false,key:entry.key,failureClass:entry.failureClass,reason:entry.reason,until:new Date(entry.until).toISOString(),failures:entry.failures.length,kind};
    }
    return {open:false};
  }
  recordFailure(integration,failureClass,at){
    const rule=this.rule(integration,failureClass);
    const key=`${integration}:${failureClass}`;
    if(!rule) return {opened:false,key,failures:0,tracked:false};
    const now=clock(at);
    const entry=this.entry(key);
    entry.failures=entry.failures.filter(t=>now-t<rule.windowMs);
    entry.failures.push(now);
    let opened=false;
    if(entry.state==='half_open' || (entry.state==='closed' && entry.failures.length>=rule.threshold)){
      entry.state='open';entry.openedAt=now;entry.until=now+rule.cooldownMs;entry.trialTaken=false;opened=true;
      entry.reason=`${LABEL[integration] || integration} paused: ${entry.failures.length} ${WORDS[failureClass] || failureClass.replace(/_/g,' ')} in ${Math.round(rule.windowMs/60000)} min · clears at ${hhmm(entry.until)}`;
    }
    this.save();
    return {opened,key,failures:entry.failures.length,tracked:true,reason:entry.reason,until:entry.until?new Date(entry.until).toISOString():null};
  }
  // A success closes a half-open circuit (the trial call worked) and clears the count of outage-shaped faults, which a
  // working call disproves. An expired token or a malformed plan is not disproved by an unrelated call succeeding: those
  // counts age out by their window alone, so one good read cannot keep a dead write token from tripping its breaker.
  recordSuccess(integration){
    let changed=false;
    for(const entry of this.keys.values()){
      if(entry.integration!==integration) continue;
      if(entry.state==='half_open'){entry.state='closed';entry.openedAt=null;entry.until=null;entry.reason='';entry.trialTaken=false;entry.failures=[];changed=true;continue;}
      if(entry.state==='closed' && OUTAGE_CLASSES.has(entry.failureClass) && entry.failures.length){entry.failures=[];changed=true;}
    }
    if(changed) this.save();
    return changed;
  }
  snapshot(){
    const at=this.now();
    return [...this.keys.values()].filter(e=>e.state!=='closed' || e.failures.length).map(e=>({key:e.key,integration:e.integration,failureClass:e.failureClass,
      state:e.state==='open' && at>=e.until?'half_open':e.state,failures:e.failures.length,openedAt:e.openedAt?new Date(e.openedAt).toISOString():null,until:e.until?new Date(e.until).toISOString():null,reason:e.reason}));
  }
  open(){return this.snapshot().filter(e=>e.state!=='closed');}
  // An operator action from the diagnostics view; the runtime itself never resets a breaker.
  reset(key){
    if(!this.keys.has(key)) return false;
    this.keys.delete(key);this.save();
    return true;
  }
  load(){
    try{
      const parsed=JSON.parse(readFileSync(this.path,'utf8'));
      for(const e of parsed?.keys || []){
        if(typeof e?.key!=='string' || !['open','half_open','closed'].includes(e.state)) continue;
        const [integration,failureClass]=e.key.split(':');
        this.keys.set(e.key,{key:e.key,integration,failureClass,state:e.state,failures:Array.isArray(e.failures)?e.failures.filter(Number.isFinite):[],openedAt:e.openedAt ?? null,until:e.until ?? null,reason:String(e.reason || ''),trialTaken:false});
      }
    }catch{/* no snapshot yet, or an unreadable one: start closed */}
  }
  save(){
    if(!this.path) return;
    try{
      mkdirSync(dirname(this.path),{recursive:true});
      const tmp=`${this.path}.tmp`;
      writeFileSync(tmp,JSON.stringify({version:1,savedAt:new Date(this.now()).toISOString(),keys:[...this.keys.values()].map(e=>({key:e.key,state:e.state,failures:e.failures,openedAt:e.openedAt,until:e.until,reason:e.reason}))}));
      renameSync(tmp,this.path);
    }catch{/* a snapshot that cannot be written never stops a run; the in-memory state still holds */}
  }
}
