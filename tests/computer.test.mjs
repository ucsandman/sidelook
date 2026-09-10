import test from 'node:test';
import assert from 'node:assert/strict';
import {Computer,observed} from '../lib/computer.mjs';
import {createApp} from '../server.mjs';

const proposed={kind:'click',element:'1.2',text:'',key:'',app:'',reason:'Press the fixture button.'};
function fixture(inference=async()=>({result:proposed,model:'test'})){
  const acts=[];let armed=false;
  const native={close(){armed=false;},async call(d){
    if(d.op==='arm'){armed=true;return {armed};}
    if(d.op==='status')return {armed};
    if(d.op==='windows')return {windows:[{id:'42:7:8',title:'Fixture'},{id:'9:9:9',title:'  Padded title  '}]};
    if(d.op==='snapshot')return {title:'Fixture',elements:[{id:'1.2',name:'Calculate',type:'Button',enabled:true}]};
    if(d.op==='act'){assert.ok(armed);acts.push(d);return {performed:true};}
  }};
  return {computer:new Computer({native,inference,platform:'win32'}),acts,native};
}
async function enable(c){return (await c.handle({op:'enable',consent:true})).owner;}
const request=owner=>({op:'propose',owner,task:'Calculate a result',window:'42:7:8',consent:true,model:'astra',effort:'low'});
test('computer requires consent and an owning tab; inference alone cannot act',async()=>{
  const {computer:c,acts}=fixture();await assert.rejects(c.handle({op:'enable'}),/Allow/);
  const owner=await enable(c);await assert.rejects(c.handle({...request('foreign')}),/Enable/);
  const {proposal}=await c.handle(request(owner));assert.equal(acts.length,0);
  await assert.rejects(c.handle({op:'approve',owner,id:proposal.id}),/expired/);
  await c.handle({op:'approve',owner,id:proposal.id,consent:true});assert.equal(acts.length,1);
  await assert.rejects(c.handle({op:'approve',owner,id:proposal.id,consent:true}),/already used/);assert.equal(acts.length,1);
});
test('reject, expiry and emergency stop invalidate actions',async()=>{
  const {computer:c,acts,native}=fixture();const owner=await enable(c);
  const {proposal}=await c.handle(request(owner));await c.handle({op:'reject',owner});
  await assert.rejects(c.handle({op:'approve',owner,id:proposal.id,consent:true}));
  await c.handle(request(owner));c.pending.expires=Date.now()-1;
  await assert.rejects(c.handle({op:'approve',owner,id:c.pending.id,consent:true}),/expired/);
  await c.handle(request(owner));native.close();await assert.rejects(c.handle({op:'approve',owner,id:c.pending.id,consent:true}),/emergency stop/);
  assert.equal(acts.length,0);
});
test('stop during inference cannot publish a late proposal or execute it',async()=>{
  let release,started;const running=new Promise(r=>started=r);
  const {computer:c,acts}=fixture(async()=>{started();await new Promise(r=>release=r);return {result:proposed};});
  const owner=await enable(c);const pending=c.handle(request(owner));await running;c.stop();release();
  await assert.rejects(pending,/stopped/);assert.equal(c.pending,null);assert.equal(acts.length,0);
});
test('unknown actions, controls, apps and raw shortcut strings fail closed',async()=>{
  for(const action of [{...proposed,kind:'shell'},{...proposed,element:'invented'},{...proposed,kind:'launch',app:'powershell'},{...proposed,kind:'key',key:'^r'}]){
    const {computer:c,acts}=fixture(async()=>({result:action}));const owner=await enable(c);
    await assert.rejects(c.handle(request(owner)));assert.equal(acts.length,0);c.stop();
  }
});
test('read is read-only: it never arms, grants no owner, and reports truncation honestly',async()=>{
  const {computer:c,acts,native}=fixture();const ops=[];const call=native.call.bind(native);native.call=async d=>{ops.push(d.op);return call(d);};
  await assert.rejects(c.handle({op:'read',title:'Fixture'}),/Allow/);
  await assert.rejects(c.handle({op:'read',title:'Missing',consent:true}),/not open/);
  ops.length=0;
  await c.handle({op:'read',title:'Padded title',consent:true});
  const read=await c.handle({op:'read',title:'Fixture',consent:true});
  assert.deepEqual(read,{title:'Fixture',controls:1,characters:'Button: Calculate'.length,truncated:false,text:'Button: Calculate'});
  assert.deepEqual(ops,['windows','snapshot','windows','snapshot']);assert.equal(c.owner,null);assert.equal(c.pending,null);assert.equal(acts.length,0);
  assert.equal((await native.call({op:'status'})).armed,false);
  await assert.rejects(c.handle({op:'approve',id:'x',consent:true}),/Enable/);
  const {readable}=await import('../lib/computer.mjs');
  const big=readable({title:'T',limited:true,elements:Array.from({length:3},(_,i)=>({type:'Edit',name:`Field ${i}`,value:'x'.repeat(9000)}))});
  assert.equal(big.truncated,true);assert.equal(big.characters,20000);assert.equal(big.controls,3);
});
test('approve reads the same window once afterwards and reports what it saw, never a second act',async()=>{
  const {computer:c,acts,native}=fixture();const ops=[];const call=native.call.bind(native);
  native.call=async d=>{ops.push(d.op);if(d.op==='snapshot' && acts.length)return {title:'Fixture',elements:[{id:'1.2',name:'Calculate',type:'Button',enabled:true},{id:'1.3',name:'Result',type:'Text',value:'42',enabled:true}]};return call(d);};
  const owner=await enable(c);const {proposal}=await c.handle(request(owner));ops.length=0;
  const done=await c.handle({op:'approve',owner,id:proposal.id,consent:true});
  assert.deepEqual(ops,['status','act','snapshot'],'one act, then one reading of the same window');
  assert.equal(done.observation.available,true);assert.equal(done.observation.added,1);assert.equal(done.observation.summary,'Observed: 1 new · Result = 42.');
  assert.equal(done.observation.reading.elements.length,2);assert.equal(acts.length,1);
  assert.equal(c.history.at(-1).result,'Windows accepted the action. Observed: 1 new · Result = 42.');
});
test('an observation that fails says so and never replays the action; a launch finds the new window in the list and never reads inside it',async()=>{
  const {computer:c,acts,native}=fixture();const ops=[];const call=native.call.bind(native);
  native.call=async d=>{ops.push(d.op);if(d.op==='snapshot' && acts.length)throw new Error('window gone');return call(d);};
  const owner=await enable(c);const {proposal}=await c.handle(request(owner));ops.length=0;
  const done=await c.handle({op:'approve',owner,id:proposal.id,consent:true});
  assert.deepEqual(ops,['status','act','snapshot']);assert.equal(acts.length,1,'no retry');
  assert.equal(done.observation.available,false);assert.match(done.observation.summary,/could not be read after the action/);
  assert.match(c.history.at(-1).result,/^Windows accepted the action\. The window could not be read/);
  const l=fixture(async()=>({result:{...proposed,kind:'launch',element:'',app:'notepad'}}));const lops=[];const lcall=l.native.call.bind(l.native);
  l.native.call=async d=>{lops.push(d.op);if(d.op==='windows' && l.acts.length)return {windows:[{id:'42:7:8',title:'Fixture'},{id:'9:9:9',title:'  Padded title  '},{id:'77:1:1',title:'Untitled - Notepad'}]};return lcall(d);};
  const lowner=await enable(l.computer);const {proposal:lp}=await l.computer.handle(request(lowner));lops.length=0;
  const opened=await l.computer.handle({op:'approve',owner:lowner,id:lp.id,consent:true});
  assert.deepEqual(lops,['status','windows','act','windows'],'the list before and after, never a snapshot');assert.equal(opened.observation.available,true);
  assert.deepEqual(opened.observation.launched,{id:'77:1:1',title:'Untitled - Notepad'});assert.equal(opened.observation.summary,'Opened "Untitled - Notepad". It is now the chosen window.');
  assert.equal(l.computer.target,'77:1:1','the next plan for the same task keeps its history');
  const n=fixture(async()=>({result:{...proposed,kind:'launch',element:'',app:'notepad'}}));n.computer.observeTimeout=60;
  const nowner=await enable(n.computer);const {proposal:np}=await n.computer.handle(request(nowner));
  const missed=await n.computer.handle({op:'approve',owner:nowner,id:np.id,consent:true});
  assert.equal(missed.observation.available,false);assert.match(missed.observation.summary,/No new window appeared in time/);
});
test('a plan with no window chosen reads nothing and can only propose a launch or a report',async()=>{
  const seen=[];const {computer:c,native}=fixture(async r=>{seen.push(JSON.parse(r.prompt));return {result:{...proposed,kind:'launch',element:'',app:'notepad',reason:'Notepad is not open.'}};});
  const ops=[];const call=native.call.bind(native);native.call=async d=>{ops.push(d.op);return call(d);};
  const owner=await enable(c);const {proposal}=await c.handle({...request(owner),window:''});
  assert.equal(proposal.kind,'launch');assert.equal(proposal.app,'notepad');assert.deepEqual(ops,['arm','status'],'no snapshot without a window');
  assert.deepEqual(seen[0].snapshot,{title:'',elements:[],none:true});
  const click=fixture(async()=>({result:proposed}));const cowner=await enable(click.computer);
  await assert.rejects(click.computer.handle({...request(cowner),window:''}),/No window is chosen/);assert.equal(click.acts.length,0);
  const {proposal:again}=await c.handle({...request(owner)});assert.equal(again.kind,'launch','a chosen window still allows a launch');
});
test('a reading that hangs is reported as unread within its own bound, shorter than an action, with no replay',async()=>{
  const {computer:c,acts,native}=fixture();c.observeTimeout=40;const call=native.call.bind(native);let hung=0;
  native.call=async d=>{if(d.op==='snapshot' && acts.length){hung++;return new Promise(()=>{});}return call(d);};
  const owner=await enable(c);const {proposal}=await c.handle(request(owner));
  const started=Date.now();const done=await c.handle({op:'approve',owner,id:proposal.id,consent:true});
  assert.ok(Date.now()-started<1000,'the approve answered within the reading bound, not the 20 s action bound');
  assert.equal(done.observation.available,false);assert.match(done.observation.summary,/took too long to read/);assert.equal(acts.length,1);assert.equal(hung,1);
  assert.equal(c.busy,false,'the broker is free for the next manual step');
});
test('observed() states the target value for type, the diff for the rest, and never claims success',()=>{
  const before={title:'Notepad',elements:[{id:'e1',name:'Text editor',type:'Edit',value:'',enabled:true}]};
  const typed=observed({kind:'type',element:'e1',text:'hello',title:'Notepad'},before,{title:'Notepad',elements:[{id:'e1',name:'Text editor',type:'Edit',value:'hello',enabled:true}]});
  assert.equal(typed.summary,'Observed: Text editor now reads "hello".');assert.equal(typed.target.value,'hello');
  const partial=observed({kind:'type',element:'e1',text:'hello',title:'Notepad'},before,{title:'Notepad',elements:[{id:'e1',name:'Text editor',type:'Edit',value:'hel',enabled:true}]});
  assert.match(partial.summary,/reads "hel", not the requested text/);
  const same=observed({kind:'click',element:'e1',title:'Notepad'},before,before);
  assert.equal(same.summary,'Observed: no change in the accessible controls. Check the app yourself.');assert.equal(same.changed.length,0);
  const moved=observed({kind:'click',element:'e1',title:'Notepad'},before,{title:'Save As',elements:[]});
  assert.equal(moved.sameWindow,false);assert.match(moved.summary,/window is now "Save As"/);
  const changed=observed({kind:'key',element:'e1',key:'enter',title:'Notepad'},before,{title:'Notepad',elements:[{id:'e1',name:'Text editor',type:'Edit',value:'x'.repeat(300),enabled:true}]});
  assert.match(changed.summary,/^Observed: 1 control changed · Text editor: was "", now "x{60}…"\.$/);
  assert.equal(changed.reading.elements[0].value.length,201,'values in the reading are bounded');
  assert.ok(!/success|done/i.test(typed.summary+same.summary+changed.summary));
});
test('desktop route rejects foreign origins and missing session token',async()=>{
  const {computer}=fixture();const app=createApp({computer});await new Promise(r=>app.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${app.address().port}`;
  try{
    const session=await(await fetch(base+'/api/local-session')).json();
    const post=headers=>fetch(base+'/api/computer',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({op:'enable',consent:true})});
    assert.equal((await post({})).status,403);
    assert.equal((await post({'X-Sidelook-Session':session.token,Origin:'https://evil.example'})).status,403);
    assert.equal((await post({'X-Sidelook-Session':session.token,Origin:base})).status,200);
  }finally{await new Promise(r=>app.close(r));}
});
