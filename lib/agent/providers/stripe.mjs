// Stripe adapter: REST API, Bearer auth, form-encoded writes, query-string reads. Refunds carry Stripe's own
// idempotency key so a retried write can never double-refund. Contract: sections 6, 7 and 14.
import {ProviderError,request,retryRead} from '../http.mjs';

const BASE='https://api.stripe.com';
const isoDate=seconds=>seconds?new Date(seconds*1000).toISOString().slice(0,10):'';
const escapeQuery=value=>String(value).replace(/\\/g,'\\\\').replace(/'/g,"\\'");

function buildParams(obj={}){
  const params=new URLSearchParams();
  for(const [key,value] of Object.entries(obj)){
    if(value===undefined || value===null || value==='') continue;
    if(Array.isArray(value)) for(const v of value) params.append(key,v);
    else params.append(key,String(value));
  }
  return params;
}

export function createStripe({config,fetchImpl=fetch}={}){
  const auth={Authorization:`Bearer ${config.stripe.secretKey}`};
  async function get(path,params,label){
    const qs=buildParams(params).toString();
    return await retryRead(async()=>{
      const res=await request({url:`${BASE}${path}${qs?`?${qs}`:''}`,method:'GET',headers:auth,fetchImpl,label:`Stripe ${label}`});
      return res.json;
    },{});
  }
  async function post(path,params,label,extraHeaders={}){
    const res=await request({url:`${BASE}${path}`,method:'POST',headers:{...auth,...extraHeaders},form:buildParams(params),fetchImpl,label:`Stripe ${label}`});
    return res.json;
  }
  // A write throws before any request leaves the process when Stripe is not configured, or when the key is live and the
  // operator has not explicitly opted into live mode.
  function guardWrite(){
    if(config.stripe.mode==='none') throw new ProviderError('CONFIG','Stripe is not configured.',{detail:'STRIPE_SECRET_KEY'});
    if(config.stripe.mode==='live' && !config.stripe.allowLive) throw new ProviderError('CONFIG','Live Stripe key without STRIPE_ALLOW_LIVE=1',{detail:'STRIPE_ALLOW_LIVE'});
  }
  const mapPayment=pi=>{
    const charge=pi.latest_charge && typeof pi.latest_charge==='object'?pi.latest_charge:null;
    const amountRefundedCents=charge?.amount_refunded ?? 0;
    const amountCents=pi.amount_received ?? pi.amount ?? 0;
    return {
      id:pi.id,chargeId:charge?.id || (typeof pi.latest_charge==='string'?pi.latest_charge:null),
      amountCents,amountRefundedCents,currency:pi.currency,created:isoDate(pi.created),
      description:pi.description || charge?.description || '',
      refundable:pi.status==='succeeded' && (amountCents-amountRefundedCents)>0
    };
  };
  // metadata rides along on every mapped refund (not just findRefunds) so a caller's own reconciliation match against
  // metadata.sidelook_effect works on its own evidence, not only on this adapter's own server-side filter.
  const mapRefund=r=>({
    id:r.id,status:r.status,amountCents:r.amount,currency:r.currency,created:isoDate(r.created),
    paymentIntentId:typeof r.payment_intent==='string'?r.payment_intent:r.payment_intent?.id || '',
    chargeId:typeof r.charge==='string'?r.charge:r.charge?.id || '',metadata:r.metadata || {}
  });
  return {
    async health(){
      const json=await get('/v1/balance',{},'balance');
      return {mode:config.stripe.mode,livemode:!!json.livemode};
    },
    // Query strings, exact: email:'<email>' when an email is given; else name~'<query>'; else name~'<domain>' as the
    // broadest available text search. Stripe search has no reliable email~ operator, so any domain given is always also
    // checked client-side against each result's email, on top of whichever query above actually ran server-side.
    async findCustomer({email='',domain='',query=''}={}){
      let q;
      if(email) q=`email:'${escapeQuery(email)}'`;
      else if(query) q=`name~'${escapeQuery(query)}'`;
      else if(domain) q=`name~'${escapeQuery(domain)}'`;
      else throw new ProviderError('INVALID','Provide an email, domain or query to search Stripe customers.',{});
      const json=await get('/v1/customers/search',{query:q,limit:'10'},'customer search');
      let results=(json.data || []).map(c=>({id:c.id,email:c.email || '',name:c.name || ''}));
      if(domain) results=results.filter(c=>c.email.toLowerCase().endsWith(`@${domain.toLowerCase()}`));
      return results;
    },
    async listRecentPayments({customerId}={}){
      const json=await get('/v1/payment_intents',{customer:customerId,limit:'10','expand[]':'data.latest_charge'},'recent payments');
      return (json.data || []).filter(pi=>pi.status==='succeeded').map(mapPayment).sort((a,b)=>b.created.localeCompare(a.created)).slice(0,10);
    },
    async getPayment({id}={}){
      return mapPayment(await get(`/v1/payment_intents/${encodeURIComponent(id)}`,{'expand[]':'latest_charge'},'payment'));
    },
    async createRefund({paymentIntentId,amountCents,idempotencyKey,metadata={}}={}){
      guardWrite();
      const params={payment_intent:paymentIntentId};
      if(amountCents!==undefined && amountCents!==null) params.amount=amountCents;
      for(const [key,value] of Object.entries(metadata || {})) params[`metadata[${key}]`]=value;
      const headers=idempotencyKey?{'Idempotency-Key':idempotencyKey}:{};
      return mapRefund(await post('/v1/refunds',params,'refund',headers));
    },
    async getRefund({id}={}){
      return mapRefund(await get(`/v1/refunds/${encodeURIComponent(id)}`,{},'refund lookup'));
    },
    async findRefunds({paymentIntentId,metadata}={}){
      const json=await get('/v1/refunds',{payment_intent:paymentIntentId,limit:'20'},'refund list');
      let data=json.data || [];
      if(metadata) data=data.filter(r=>Object.entries(metadata).every(([k,v])=>r.metadata?.[k]===v));
      return data.map(mapRefund);
    }
  };
}
