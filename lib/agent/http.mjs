// Fetch with a bound, a typed error taxonomy every provider throws, and bounded read retries. Writes never retry here.
// Contract: docs/AGENT_MODE_IMPLEMENTATION.md sections 4, 7 and 14.
import {redactText} from './redact.mjs';

const CODES=['AUTH','NOT_FOUND','RATE_LIMIT','SERVER','TIMEOUT','NETWORK','INVALID','CONFIG'];
const PRECONNECT=new Set(['ECONNREFUSED','ENOTFOUND','EAI_AGAIN']);

export class ProviderError extends Error {
  constructor(code,message,{status=null,retryable=false,sentRequest=false,detail=''}={}){
    super(message);
    this.name='ProviderError';
    this.code=CODES.includes(code)?code:'SERVER';
    this.status=status;
    this.retryable=retryable;
    this.sentRequest=sentRequest;
    // Defense in depth: an error built from a raw response body must never carry a token even if a provider echoed one back.
    this.detail=redactText(String(detail ?? '')).slice(0,1000);
  }
}

// A rejection with a clean HTTP answer (401/403/400/404/409/422/429) is a definitive "no": the provider looked at the request and
// refused it before any write could have happened. Only a connection failure mid-flight or a 5xx is genuinely ambiguous.
function classify(status){
  if(status===401 || status===403) return {code:'AUTH',retryable:false,sentRequest:false};
  if(status===404) return {code:'NOT_FOUND',retryable:false,sentRequest:false};
  if(status===429) return {code:'RATE_LIMIT',retryable:true,sentRequest:false};
  if(status>=500) return {code:'SERVER',retryable:true,sentRequest:true};
  if(status===400 || status===409 || status===422) return {code:'INVALID',retryable:false,sentRequest:false};
  return {code:'SERVER',retryable:false,sentRequest:true};
}

function retryAfterMs(headers){
  const value=headers?.get?.('retry-after');
  if(!value) return null;
  const seconds=Number(value);
  if(Number.isFinite(seconds)) return Math.max(0,seconds*1000);
  const at=Date.parse(value);
  return Number.isFinite(at)?Math.max(0,at-Date.now()):null;
}

// One bounded HTTP call. `signal` is the caller's own cancellation (a user Stop, a run abort); its abort is never wrapped as a
// ProviderError, so the caller can tell "the provider failed" apart from "we stopped asking".
export async function request({url,method='GET',headers={},body,form,timeoutMs=15000,fetchImpl=fetch,signal,label='request'}={}){
  const composite=signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs);
  const init={method,headers:{...headers},signal:composite};
  if(form!==undefined){
    init.headers={'Content-Type':'application/x-www-form-urlencoded',...init.headers};
    init.body=form instanceof URLSearchParams?form.toString():new URLSearchParams(form).toString();
  } else if(body!==undefined){
    init.headers={'Content-Type':'application/json',...init.headers};
    init.body=typeof body==='string'?body:JSON.stringify(body);
  }
  let response;
  try{
    response=await fetchImpl(url,init);
  } catch(error){
    if(error?.name==='TimeoutError') throw new ProviderError('TIMEOUT',`${label} timed out after ${timeoutMs} ms.`,{retryable:true,sentRequest:true,detail:error.message});
    if(error?.name==='AbortError') throw error; // caller-driven cancellation, not a provider failure
    if(error instanceof TypeError){
      const preConnect=PRECONNECT.has(error.cause?.code);
      throw new ProviderError('NETWORK',`${label} could not reach the network.`,{retryable:true,sentRequest:!preConnect,detail:error.message});
    }
    throw error;
  }
  const text=await response.text().catch(()=>'');
  let json=null;
  try{json=text?JSON.parse(text):null;}catch{json=null;}
  if(!response.ok){
    const {code,retryable,sentRequest}=classify(response.status);
    const error=new ProviderError(code,`${label} failed (${response.status}).`,{status:response.status,retryable,sentRequest,detail:text});
    error.retryAfterMs=retryAfterMs(response.headers);
    throw error;
  }
  return {status:response.status,json,text,headers:response.headers};
}

export function backoffDelay(attempt,baseMs=400,factor=4){
  return baseMs*Math.pow(factor,Math.max(0,attempt-1));
}

function sleep(ms,signal){
  return new Promise((resolve,reject)=>{
    if(ms<=0) return resolve();
    const timer=setTimeout(resolve,ms);
    signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(signal.reason instanceof Error?signal.reason:new DOMException('Aborted','AbortError'));},{once:true});
  });
}

// Retries a read only: a retryable ProviderError (RATE_LIMIT/SERVER/TIMEOUT/NETWORK) backs off exponentially, honouring
// Retry-After when the provider gave one. A write never calls this; effects.mjs decides retries after reconciling.
export async function retryRead(fn,{attempts=3,baseMs=400,factor=4,signal}={}){
  let lastError;
  for(let attempt=1;attempt<=attempts;attempt++){
    if(signal?.aborted) throw signal.reason instanceof Error?signal.reason:new DOMException('Aborted','AbortError');
    try{
      return await fn();
    } catch(error){
      lastError=error;
      const retryable=error instanceof ProviderError && error.retryable;
      if(!retryable || attempt===attempts) throw error;
      await sleep(Math.max(backoffDelay(attempt,baseMs,factor),error.retryAfterMs || 0),signal);
    }
  }
  throw lastError;
}
