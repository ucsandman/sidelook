import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError, Vision } from './lib/vision.mjs';
import { Assistant } from './lib/assistant.mjs';
import { runProcess, subscriptionLogin, installCodex, SubscriptionError } from './lib/subscription.mjs';
import { MODELS, selection, SelectionError, choice } from './lib/models.mjs';
import { localModels } from './lib/local.mjs';
import { Computer } from './lib/computer.mjs';
import { createAgentRuntime } from './lib/agent/index.mjs';

export const PREVIEW_CSP = "sandbox allow-scripts allow-forms; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
export const DRAFT_CSP = "sandbox; default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
const APP_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
export const assets = new Map([
  ['/', ['index.html','text/html']], ['/style.css',['style.css','text/css']],
  ['/companion.js',['companion.js','text/javascript']], ['/companion.css',['companion.css','text/css']],
  ['/chips.js',['chips.js','text/javascript']], ['/harness.js',['harness.js','text/javascript']], ['/models.js',['models.js','text/javascript']],
  ['/computer.js',['computer.js','text/javascript']], ['/live.js',['live.js','text/javascript']], ['/follow.js',['follow.js','text/javascript']], ['/eyes.js',['eyes.js','text/javascript']], ['/session.js',['session.js','text/javascript']], ['/app.js',['app.js','text/javascript']], ['/storage.js',['storage.js','text/javascript']],
  ['/mark.svg',['mark.svg','image/svg+xml']], ['/reference.svg',['reference.svg','image/svg+xml']],
  ['/demo.html',['demo.html','text/html']]
]);

const isLocalSelection = data => !!choice(data?.model)?.local;

async function readJson(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new AppError('Send JSON.',415);
  if (Number(req.headers['content-length']) > 5_000_000) throw new AppError('This request is too large.',413);
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 5_000_000) throw new AppError('This request is too large.',413);
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString());
    if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error();
    return data;
  } catch { throw new AppError('The request is not valid JSON.'); }
}

export function createApp({ vision = new Vision(), assistant = new Assistant({vision}), computer, agent, maxCalls = 60, login = subscriptionLogin, install = installCodex, local = localModels, instanceId, desktopKey } = {}) {
  computer ||= new Computer({launcherInstance:instanceId});
  if (desktopKey !== undefined && !/^[a-f0-9]{64}$/.test(desktopKey)) throw new Error('Invalid desktop launch key.');
  const matchesKey = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && timingSafeEqual(Buffer.from(value),Buffer.from(desktopKey));
  const token = randomBytes(32).toString('hex');
  const previews = new Map();
  let busy = false; let calls = 0; let draftSession=null; let dictating = false;
  // One model turn of Agent mode is one subscription request, under the same single-flight flag and allowance as every other send.
  // The loop waits its turn (up to a minute) instead of failing when a chat or a build holds the flag.
  const agentInference = async (request,signal) => {
    const until = Date.now()+60000;
    while (busy) {
      if (signal?.aborted) throw new DOMException('Canceled','AbortError');
      if (Date.now() > until) throw new AppError('Another model request is still running.',409,'BUSY');
      await new Promise(resolve => setTimeout(resolve,250));
    }
    if (calls >= maxCalls) throw new AppError('Your local Sidelook request allowance is used up. Choose Start new allowance in Setup.',429,'SESSION_LIMIT');
    busy = true; calls++;
    try {
      const timeout = AbortSignal.timeout(isLocalSelection(request) ? 300000 : 180000);
      return await vision.generate(request.system,[{ text:request.prompt }],request.schema,signal ? AbortSignal.any([signal,timeout]) : timeout,{ model:request.model,effort:request.effort });
    } finally { busy = false; }
  };
  const agentReady = agent ? Promise.resolve(agent) : createAgentRuntime({ inference:agentInference });
  agentReady.catch(() => {});
  const server = http.createServer(async (req,res) => {
    const port = server.address().port;
    const hosts = [`127.0.0.1:${port}`,`localhost:${port}`];
    const host = req.headers.host;
    const origin = req.headers.origin;
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Security-Policy',APP_CSP);
    res.setHeader('Permissions-Policy','camera=(self), microphone=(self), geolocation=(), display-capture=(self)');
    const send = (status,value) => {
      if (res.destroyed) return;
      if(res.headersSent) {res.end(JSON.stringify({type:status>=400?'error':'result',...value})+'\n');return;}
      res.writeHead(status, {'Content-Type':'application/json; charset=utf-8'});
      res.end(JSON.stringify(value));
    };
    try {
      if (!hosts.includes(host) || (origin && !hosts.some(h => origin === `http://${h}`))
        || req.headers['sec-fetch-site'] === 'cross-site') throw new AppError('Only the local Sidelook page can use this service.',403);
      const url = new URL(req.url,`http://${host}`);
      if (req.method === 'GET' && url.pathname === '/api/health') return send(200,{ app:'sidelook',ready:true,...(instanceId ? {instanceId} : {}) });
      if (desktopKey && url.pathname.startsWith('/api/') && !matchesKey(req.headers['x-sidelook-launch'])) throw new AppError('Open Sidelook from its desktop shortcut to reconnect this browser.',403);
      if (req.method === 'GET' && url.pathname === '/api/local-session') {
        // The local runtimes are probed on every handshake (1.5 s cap each), so the selector lists what LM Studio or Ollama hold right now.
        const seen=await local(AbortSignal.timeout(2500)).catch(()=>({runtimes:{},models:[]}));
        return send(200,{ token,models:MODELS,local:seen,remaining:maxCalls-calls,dictation:process.platform === 'win32' });
      }
      if (req.method === 'GET' && url.pathname === '/api/session') {
        const selected=selection({model:req.headers['x-sidelook-model'],effort:req.headers['x-sidelook-effort']});
        const status = await vision.status(AbortSignal.timeout(15000),selected);
        return send(200,{ token, ...status, remaining:maxCalls-calls,dictation:process.platform === 'win32' });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/preview/')) {
        const entry = previews.get(url.pathname.slice('/preview/'.length));
        const html=typeof entry==='string'?entry:entry?.html;
        if (!html) throw new AppError('This preview expired. Select its version again.',404);
        res.setHeader('Content-Security-Policy',entry?.draft?DRAFT_CSP:PREVIEW_CSP);
        res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=(), display-capture=()');
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
        return res.end(html);
      }
      if (req.method === 'GET' && assets.has(url.pathname)) {
        const [name,type] = assets.get(url.pathname);
        const data = await readFile(new URL(`./public/${name}`,import.meta.url));
        res.writeHead(200,{'Content-Type':`${type}; charset=utf-8`}); return res.end(data);
      }
      if (req.method !== 'POST' || !['/api/chat','/api/computer','/api/agent','/api/observe','/api/build','/api/preview','/api/dictate','/api/login','/api/install-codex','/api/reset-budget'].includes(url.pathname)) throw new AppError('Not found.',404);
      if (req.headers['x-sidelook-session'] !== token) throw new AppError('Reload Sidelook to reconnect your local session.',403);
      const data = await readJson(req);
      if (url.pathname === '/api/agent') {
        // Agent mode: the runtime owns every run; this route only relays operations and streams snapshots. Contract: docs/AGENT_MODE_IMPLEMENTATION.md §11.
        const runtime = await agentReady;
        const runId = typeof data.run === 'string' ? data.run.slice(0,64) : '';
        const op = data.op;
        if (op === 'health') return send(200,await runtime.health());
        if (op === 'list') return send(200,{ runs:await runtime.list() });
        if (op === 'get') return send(200,{ run:await runtime.get(runId) });
        if (op === 'create') {
          if (data.consent !== true) throw new AppError('Press Start to send this goal to your model and let the agent work.',403);
          const selected = selection(data);
          const goal = typeof data.goal === 'string' ? data.goal : '';
          if (!goal.trim() || goal.length > 2000) throw new AppError('Say what the agent should accomplish, under 2,000 characters.');
          if (calls >= maxCalls) throw new AppError('Your local Sidelook request allowance is used up. Choose Start new allowance in Setup.',429,'SESSION_LIMIT');
          const run = await runtime.create({ goal,...selected,windowTitle:typeof data.windowTitle === 'string' ? data.windowTitle : '' });
          return send(200,{ run,remaining:maxCalls-calls });
        }
        if (op === 'watch') {
          if (req.headers.accept !== 'application/x-ndjson') throw new AppError('Watch needs an ndjson stream.',406);
          let pending = null, timer = null, last = null, closed = false;
          const write = value => { if (closed || res.destroyed) return; if (!res.headersSent) res.writeHead(200,{ 'Content-Type':'application/x-ndjson; charset=utf-8','X-Accel-Buffering':'no' }); if (res.writableLength < 4_000_000) res.write(JSON.stringify(value)+'\n'); };
          const flush = () => { timer = null; if (!pending) return; const view = pending; pending = null; write({ type:'run',run:view }); if (['completed','partial','blocked','cancelled','failed','uncertain'].includes(view.status)) end(); };
          const end = () => { if (closed) return; closed = true; clearInterval(heartbeat); clearTimeout(timer); unsubscribe?.(); if (!res.destroyed) res.end(); };
          const heartbeat = setInterval(() => write({ type:'heartbeat',at:new Date().toISOString() }),10000);
          const unsubscribe = runtime.watch(runId,view => { pending = view; last = view; if (!timer) timer = setTimeout(flush,150); });
          if (!unsubscribe) { clearInterval(heartbeat); return send(200,{ type:'run',run:await runtime.get(runId) }); }
          res.once('close',end);
          if (last && ['completed','partial','blocked','cancelled','failed','uncertain'].includes(last.status)) { clearTimeout(timer); timer = null; pending = null; write({ type:'run',run:last }); end(); }
          return;
        }
        if (op === 'answer') {
          if (data.consent !== true) throw new AppError('Press Answer to send this to your model.',403);
          return send(200,{ run:await runtime.answer(runId,data.message) });
        }
        if (op === 'approve' || op === 'reject') {
          if (data.consent !== true) throw new AppError(op === 'approve' ? 'Press Approve to submit this decision to DashClaw.' : 'Press Reject to submit this decision to DashClaw.',403);
          const actionId = typeof data.actionId === 'string' ? data.actionId.slice(0,128) : '';
          if (!actionId) throw new AppError('The approval is missing its action id. Refresh and look again.');
          return send(200,await runtime[op](runId,actionId,typeof data.reason === 'string' ? data.reason : ''));
        }
        if (op === 'cancel') return send(200,{ run:await runtime.cancel(runId) });
        throw new AppError('Unsupported agent operation.');
      }
      if(url.pathname==='/api/computer') {
        if(data.op==='propose' && (busy || calls>=maxCalls)) throw new AppError(busy?'Another model request is running.':'Your local request allowance is used up. Reset it in Setup.',409);
        const controller=new AbortController();const abort=()=>{controller.abort();if(data.op!=='status' && data.op!=='read')computer.stop();};
        res.once('close',abort);
        if(data.op==='propose'){busy=true;calls++;}
        try {return send(200,{...await computer.handle(data,controller.signal),remaining:maxCalls-calls});}
        finally {if(data.op==='propose')busy=false;res.removeListener('close',abort);}
      }
      if (url.pathname === '/api/reset-budget') {
        if (data.consent !== true) throw new AppError('Confirm a new local request allowance.',403);
        if (busy) throw new AppError('Wait for the current request to finish.',409,'BUSY');
        calls = 0; return send(200,{ remaining:maxCalls });
      }
      if (url.pathname === '/api/login' || url.pathname === '/api/install-codex') {
        const selected=selection(data);
        if (data.consent !== true) throw new AppError('Choose Sign in with ChatGPT to start login.',403);
        if (busy) throw new AppError('Wait for the current request to finish.',409,'BUSY');
        busy = true;
        const controller = new AbortController(); const abort = () => controller.abort();
        res.once('close',abort);
        try { return send(200,await (url.pathname === '/api/login' ? login : install)(AbortSignal.any([controller.signal,AbortSignal.timeout(180000)]),selected)); }
        finally { busy = false; res.removeListener('close',abort); }
      }
      if (url.pathname === '/api/dictate') {
        if (data.consent !== true) throw new AppError('Allow local microphone use before dictating.',403);
        if (process.platform !== 'win32') throw new AppError('Local Windows dictation is unavailable on this platform. Type your direction.',503);
        if (dictating) throw new AppError('Another dictation session is active.',409);
        dictating = true;
        const controller = new AbortController();
        const abort = () => controller.abort(); res.once('close',abort);
        try {
          const powershell=join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
          const result = await runProcess(powershell,['-NoProfile','-File',fileURLToPath(new URL('./scripts/dictate.ps1',import.meta.url))],{ signal:AbortSignal.any([controller.signal,AbortSignal.timeout(30000)]) });
          if (result.code !== 0) throw new AppError('Windows local dictation could not start. Check your default microphone and installed English speech recognition.',503);
          return send(200,JSON.parse(result.stdout));
        } finally { dictating=false; res.removeListener('close',abort); }
      }
      if (url.pathname === '/api/preview') {
        if(data.draft===true && (!draftSession || data.draftSession!==draftSession)) throw new AppError('This draft build has ended.',409);
        if (typeof data.html !== 'string' || data.html.length > 120000 || !data.html.trim()) throw new AppError('Invalid preview.');
        const id = randomBytes(20).toString('hex');
        previews.set(id,data.draft===true?{html:data.html,draft:true,session:draftSession}:data.html);
        while (previews.size > 24) previews.delete(previews.keys().next().value);
        return send(200,{ url: `/preview/${id}` });
      }
      if (url.pathname === '/api/chat') {
        if (data.consent !== true) throw new AppError('Allow sharing through your selected subscription before chatting.',403);
        if (busy) throw new AppError('Another request is still finishing. Try again in a moment.',409,'BUSY');
        assistant.validate(data);
        if (calls >= maxCalls) throw new AppError('Your local Sidelook request allowance is used up. Choose Start new allowance in Setup. Your saved work stays here.',429,'SESSION_LIMIT');
        busy = true;
        const controller = new AbortController();
        const abort = () => controller.abort();
        res.once('close',abort);
        try {
          calls++;
          // A local model on a small GPU pays a cold prefill of Codex's prompt; measured 2026-09-06 at up to 154 s, so it gets the build's budget.
          return send(200,{ ...await assistant.chat(data,AbortSignal.any([controller.signal,AbortSignal.timeout(isLocalSelection(data) ? 300000 : 120000)])),remaining:maxCalls-calls });
        } finally { busy=false;res.removeListener('close',abort); }
      }
      if (data.consent !== true) throw new AppError('Allow sharing through your OpenAI subscription before building.',403);
      if (busy) throw new AppError('Another request is still finishing. Try again in a moment.',409,'BUSY');
      vision.validate?.(data,url.pathname);
      if (calls >= maxCalls) throw new AppError('Your local Sidelook request allowance is used up. Choose Start new allowance in Setup. Your saved work stays here.',429,'SESSION_LIMIT');
      busy = true;
      const controller = new AbortController();
      const abort = () => controller.abort();
      res.once('close',abort);
      const signal = AbortSignal.any([controller.signal,AbortSignal.timeout(url.pathname === '/api/build' || isLocalSelection(data) ? 300000 : 120000)]);
      try {
        calls++;
        const streaming=url.pathname==='/api/build' && req.headers.accept==='application/x-ndjson';
        let updates=0;
        if(streaming) draftSession=randomBytes(20).toString('hex');
        const progress=streaming ? event=>{
          if(signal.aborted || res.destroyed || updates>=250) return;
          const value=event.type==='draft' && typeof event.html==='string' && event.html.length<=120000 ? {type:'draft',html:event.html} : event.type==='phase' && ['connecting','loading','waiting'].includes(event.phase) ? {type:'phase',phase:event.phase,streaming:event.streaming===true,draftSession} : null;
          if(!value) return;
          if(!res.headersSent) res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8','X-Accel-Buffering':'no'});
          if(res.writableLength>1_000_000) return;
          updates++;res.write(JSON.stringify(value)+'\n');
        } : undefined;
        progress?.({type:'phase',phase:'connecting'});
        const value = url.pathname === '/api/observe' ? await vision.observe(data,signal) : await vision.build(data,signal,progress);
        if (!signal.aborted) send(200,{ ...value,remaining:maxCalls-calls });
      } finally {
        for(const [id,entry] of previews) if(entry?.draft && entry.session===draftSession) previews.delete(id);
        draftSession=null;busy=false;res.removeListener('close',abort);
      }
    } catch (error) {
      const interrupted = ['AbortError','TimeoutError'].includes(error.name);
      const safe = error instanceof AppError || error instanceof SubscriptionError || error instanceof SelectionError;
      send(error.status || (interrupted ? 504 : 500),{ code:safe ? error.code : interrupted ? 'TIMEOUT' : 'REQUEST_FAILED',remaining:maxCalls-calls,error:safe ? error.message : interrupted ? 'The request timed out or was canceled. Your saved versions are safe. Try a smaller change.' : 'Sidelook could not complete that request. Try again.' });
    }
  });
  server.requestTimeout = 320000;
  server.headersTimeout = 10000;
  server.on('close',()=>{computer.stop();agentReady.then(runtime=>runtime.stopAll()).catch(()=>{});});
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const desktopArg=process.argv.find(arg=>arg.startsWith('--desktop-instance='));
  const instanceId=desktopArg?.split('=')[1];
  if(desktopArg && !/^[a-f0-9]{32}$/.test(instanceId || '')) throw new Error('Invalid desktop instance identifier.');
  const desktopKey=process.env.SIDELOOK_DESKTOP_KEY;
  delete process.env.SIDELOOK_DESKTOP_KEY;
  if (desktopArg && !desktopKey) throw new Error('Desktop launch key is required.');
  const app = createApp({instanceId,desktopKey});
  app.listen(4317,'127.0.0.1',() => console.log('Sidelook is ready at http://127.0.0.1:4317'));
  app.on('error',error => { console.error(error.code === 'EADDRINUSE' ? 'Port 4317 is in use. Sidelook may already be running.' : 'Could not start Sidelook.'); process.exitCode = 1; });
}
