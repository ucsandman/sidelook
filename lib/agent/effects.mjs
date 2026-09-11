// The governed effect engine: the only path in Sidelook that can perform a consequential write.
// precondition -> DashClaw record (allowed | held | blocked) -> approval when held -> execution claim -> the provider request
// -> receipt -> a fresh read that verifies -> the outcome reported to DashClaw. A request that may have left the process is
// never repeated blind: the provider is read first, and only an absent effect is retried. Contract: docs/AGENT_MODE_IMPLEMENTATION.md §8-§9.
import {planEffect,updateEffect,priorEffect,nextSeries,addApproval,resolveApproval,appendEvent,addFact,addError,transition,setStep} from './run.mjs';
import {money,isoDate,sourceOfTruth,emailReference} from './facts.mjs';
import {classifyFailure,recordIncident,resolveIncident} from './incidents.mjs';
import {decideWrite,policyFor} from './recovery.mjs';

const APP_LABEL={stripe:'Stripe',hubspot:'HubSpot',gmail:'Gmail',slack:'Slack'};
// The words the timeline uses for each write, so a recovery row reads as a sentence: "Checking whether Stripe already processed the refund".
const NOUN={stripe:{did:'processed the refund',none:'holds no refund',thing:'refund'},hubspot:{did:'applied the update',none:'holds no update',thing:'update'},gmail:{did:'sent the message',none:'holds no message',thing:'message'}};
const APPROVAL_WINDOW_MS=900000;
const sleep=(ms,signal)=>new Promise((resolve,reject)=>{
  if(signal?.aborted) return reject(new DOMException('Canceled','AbortError'));
  const timer=setTimeout(()=>{signal?.removeEventListener('abort',onAbort);resolve();},ms);
  const onAbort=()=>{clearTimeout(timer);reject(new DOMException('Canceled','AbortError'));};
  signal?.addEventListener('abort',onAbort,{once:true});
});
const err=(code,message,extra={})=>Object.assign(new Error(message),{code,...extra});
const refusal=(code,message)=>({ok:false,code,message});
const domainOf=email=>String(email || '').toLowerCase().split('@')[1] || '';
const now=()=>new Date().toISOString();

// The identity every write binds to: the customer the Slack request named, resolved to a Stripe customer by the tools.
// A contact or a recipient that is not that person (same email, or the same domain as the request) is refused before DashClaw hears of it.
export function boundToCustomer(run,email){
  const target=String(email || '').toLowerCase();
  if(!target) return false;
  const stripeEmail=String(run.entities.stripeCustomer?.email || '').toLowerCase();
  const domain=String(run.entities.customer?.domain || domainOf(stripeEmail)).toLowerCase();
  if(stripeEmail && target===stripeEmail) return true;
  return !!domain && domainOf(target)===domain;
}

// What each write is: how to plan it from the run's evidence, how to do it, how to read it back, how to find it after a lost answer.
const SPECS={
  'stripe.refund_payment':{
    app:'stripe',financial:true,
    plan({run,args,config}){
      if(!run.sourceFacts.some(f=>f.key==='request')) return refusal('MISSING_SOURCE_EVIDENCE','No customer request was found in Slack, so no money moves.');
      const customer=run.entities.stripeCustomer;
      if(!customer && (run.entities.stripeCandidates || []).length>1) return refusal('AMBIGUOUS_IDENTITY','More than one Stripe customer matched. Ask the person which one before refunding.');
      if(!customer) return refusal('IDENTITY_UNRESOLVED','The Stripe customer has not been resolved yet.');
      const payment=run.entities.payment;
      if(!payment || payment.id!==args.paymentId) return refusal('PAYMENT_NOT_OBSERVED','Only the eligible payment the tools observed can be refunded.');
      // The payment must carry the customer it belongs to; a payment without one is not evidence enough to move money.
      if(!payment.customerId || payment.customerId!==customer.id) return refusal('PAYMENT_MISMATCH','That payment does not belong to the matched customer.');
      if(!Number.isFinite(payment.amountCents) || !Number.isFinite(payment.amountRefundedCents)) return refusal('PAYMENT_INCOMPLETE','The payment record does not say how much was already refunded.');
      const refundable=payment.amountCents-payment.amountRefundedCents;
      const amountCents=args.amountCents || refundable;
      if(!(amountCents>0) || amountCents>refundable) return refusal('AMOUNT_EXCEEDS_REFUNDABLE',`Only ${money(refundable,payment.currency)} is refundable on ${payment.id}.`);
      if(config.stripe?.mode==='none') return refusal('CONFIG','Stripe is not configured.');
      const live=config.stripe?.mode==='live';
      if(live && !config.stripe?.allowLive) return refusal('STRIPE_LIVE_REFUSED','A live Stripe key is configured and STRIPE_ALLOW_LIVE is not set. No live write runs.');
      const ceiling=config.stripe?.refundMaxCents ?? 100000;
      const overCeiling=amountCents>ceiling;
      const amount=money(amountCents,payment.currency);
      // Risk is wrapper-computed from evidence: over the ceiling or live money is declared at the score DashClaw blocks.
      const blockWorthy=overCeiling || live;
      return {ok:true,opKey:`refund:${payment.id}`,amountCents,amount,currency:payment.currency,paymentId:payment.id,customer,
        entity:`${customer.name || customer.email || customer.id} (${customer.id})`,operation:`Refund ${amount}`,
        ctx:{actionType:'api',declaredGoal:`Refund ${amount} to ${customer.name || customer.email || customer.id} (${payment.id}) per the Slack cancellation request`,
          riskScore:blockWorthy?100:60,confidence:overCeiling?60:90,systemsTouched:['stripe'],
          act:{method:'POST',url:'https://api.stripe.com/v1/refunds',body:`payment_intent=${payment.id}&amount=${amountCents}`},
          metadata:{amount_cents:amountCents,currency:payment.currency,over_ceiling:overCeiling,ceiling_cents:ceiling,stripe_mode:config.stripe?.mode || 'none'}}};
    },
    async execute({providers,plan,effect,run}){
      const receipt=await providers.stripe.createRefund({paymentIntentId:plan.paymentId,amountCents:plan.amountCents,idempotencyKey:effect.idempotencyKey,metadata:{sidelook_run:run.runId,sidelook_effect:effect.effectId}});
      return {id:receipt.id,at:now(),raw:{status:receipt.status,amountCents:receipt.amountCents,currency:receipt.currency,paymentIntentId:receipt.paymentIntentId,chargeId:receipt.chargeId,created:receipt.created}};
    },
    async verify({providers,plan,receipt}){
      const refund=await providers.stripe.getRefund({id:receipt.id});
      const good=['succeeded','pending'].includes(refund.status) && refund.amountCents===plan.amountCents;
      return {verified:good,detail:good?`Stripe reports refund ${refund.id} ${refund.status} for ${money(refund.amountCents,refund.currency)}.`:`Stripe reports refund ${refund.id} ${refund.status} for ${money(refund.amountCents,refund.currency)}, not the intended ${plan.amount}.`,
        evidence:{refundId:refund.id,status:refund.status,amount:money(refund.amountCents,refund.currency),paymentIntentId:refund.paymentIntentId,chargeId:refund.chargeId}};
    },
    async reconcile({providers,plan,effect}){
      const refunds=await providers.stripe.findRefunds({paymentIntentId:plan.paymentId,metadata:{sidelook_effect:effect.effectId}});
      const found=refunds.find(r=>r.metadata?.sidelook_effect===effect.effectId) || null;
      return found?{finding:'present',receipt:{id:found.id,at:now(),raw:{status:found.status,amountCents:found.amountCents,currency:found.currency,paymentIntentId:found.paymentIntentId,chargeId:found.chargeId,created:found.created}},detail:`Stripe already holds refund ${found.id} for this operation.`}
        :{finding:'absent',detail:'Stripe holds no refund for this operation.'};
    },
    facts({run,plan,receipt,verification}){
      addFact(run,{key:'refund_id',value:receipt.id,label:'refund_id',source:'stripe',ref:receipt.id});
      addFact(run,{key:'refund_amount',value:plan.amount,label:'refund_amount',source:'stripe',ref:receipt.id});
      addFact(run,{key:'refund_status',value:verification?.evidence?.status || receipt.raw?.status || '',label:'refund_status',source:'stripe',ref:receipt.id});
      if(receipt.raw?.created) addFact(run,{key:'refund_date',value:isoDate(receipt.raw.created),label:'refund_date',source:'stripe',ref:receipt.id});
      run.entities.refund={id:receipt.id,amountCents:plan.amountCents,currency:plan.currency,status:verification?.evidence?.status || receipt.raw?.status || '',created:receipt.raw?.created || null};
    }
  },
  'hubspot.update_customer':{
    app:'hubspot',
    plan({run,args,config}){
      const contact=run.entities.hubspotContact;
      if(!contact) return refusal('IDENTITY_UNRESOLVED','The HubSpot contact has not been resolved yet.');
      if(args.contactId && args.contactId!==contact.id) return refusal('CONTACT_NOT_OBSERVED','Only the HubSpot contact the tools observed can be updated.');
      if(!boundToCustomer(run,contact.email)) return refusal('IDENTITY_MISMATCH',`HubSpot contact ${contact.email || contact.id} is not the customer this run is about.`);
      const property=args.property || config.hubspot?.property;
      if(!property || property!==config.hubspot?.property) return refusal('PROPERTY_NOT_ALLOWED',`Only the configured property ${config.hubspot?.property || '(none)'} can be updated.`);
      const value=args.value || config.hubspot?.value;
      const allowed=config.hubspot?.allowedValues?.length?config.hubspot.allowedValues:[config.hubspot?.value].filter(Boolean);
      if(!value || !allowed.includes(value)) return refusal('VALUE_NOT_ALLOWED',`${property} may only be set to ${allowed.join(', ') || '(nothing configured)'}. Call hubspot.update_customer again with only contactId; the value is configured.`);
      return {ok:true,opKey:`update:${contact.id}:${property}`,contactId:contact.id,property,value,entity:`${contact.email || contact.id} (${contact.id})`,operation:`Set ${property} to ${value}`,
        ctx:{actionType:'api',declaredGoal:`Set HubSpot contact ${contact.email || contact.id} ${property} to ${value}`,riskScore:20,confidence:95,systemsTouched:['hubspot'],
          act:{method:'PATCH',url:`https://api.hubapi.com/crm/v3/objects/contacts/${contact.id}`,body:JSON.stringify({properties:{[property]:value}})},metadata:{property,value}}};
    },
    async precheck({providers,plan}){
      const contact=await providers.hubspot.getContact({id:plan.contactId,properties:[plan.property]});
      const current=contact.properties?.[plan.property] ?? null;
      return {satisfied:current===plan.value,current};
    },
    async execute({providers,plan}){
      const result=await providers.hubspot.updateContact({id:plan.contactId,properties:{[plan.property]:plan.value}});
      return {id:String(result.id || plan.contactId),at:now(),raw:{updatedAt:result.updatedAt || null,properties:{[plan.property]:result.properties?.[plan.property] ?? plan.value}}};
    },
    async verify({providers,plan}){
      const contact=await providers.hubspot.getContact({id:plan.contactId,properties:[plan.property]});
      const current=contact.properties?.[plan.property] ?? null;
      return {verified:current===plan.value,detail:current===plan.value?`HubSpot reads ${plan.property} = ${current}.`:`HubSpot reads ${plan.property} = ${current ?? '(empty)'}, not ${plan.value}.`,evidence:{contactId:plan.contactId,property:plan.property,value:current}};
    },
    async reconcile({providers,plan}){
      const contact=await providers.hubspot.getContact({id:plan.contactId,properties:[plan.property]});
      const current=contact.properties?.[plan.property] ?? null;
      return current===plan.value?{finding:'present',receipt:{id:plan.contactId,at:now(),raw:{properties:{[plan.property]:current}}},detail:`HubSpot already reads ${plan.property} = ${current}.`}:{finding:'absent',detail:`HubSpot reads ${plan.property} = ${current ?? '(empty)'}.`};
    },
    facts({run,plan}){
      addFact(run,{key:'crm_status',value:plan.value,label:'crm_status',source:'hubspot',ref:plan.contactId});
      run.entities.hubspotContact={...run.entities.hubspotContact,properties:{...(run.entities.hubspotContact?.properties || {}),[plan.property]:plan.value}};
    }
  },
  'gmail.send_message':{
    // Gmail has no provider-side idempotency, rewrites the Message-ID for gmail.com senders, and its search index lags a send.
    // So a send that may have reached Gmail is never repeated on a single absent read: only a request that provably never left
    // (connection refused) is retried. Verification reads the message by the id Gmail returned; reconciliation, which runs only
    // when that id was never received, searches by Message-ID or the reference token the body carries.
    app:'gmail',noBlindRetry:true,reconcileReads:3,reconcileGapMs:3000,
    plan({run,args,config}){
      const email=run.entities.email;
      if(!email) return refusal('NOT_PREPARED','Prepare the message first; only a prepared message can be sent.');
      if(args.messageId && args.messageId!==email.messageId && args.messageId!==email.preparedId) return refusal('MESSAGE_NOT_PREPARED','That is not the prepared message.');
      if(email.verified!==true && !config.flags?.allowUnverifiedEmail) return refusal('CONTENT_UNVERIFIED',`DashClaw did not verify the message content${email.violations?.length?`: ${email.violations.map(v=>v.label || v.code).join(', ')}`:''}. Prepare it again with facts only.`);
      if(!config.gmail?.from) return refusal('CONFIG','Gmail is not configured.');
      const unsure=email.recipientConfidence!=='high';
      // The logical operation is "this confirmation to this person", not the Message-ID a second prepare would mint afresh.
      // Never key on whether the refund id is a known fact yet: that fact is set only once a refund verifies (see `facts()`
      // below), so an opKey built from it changes mid-lineage and defeats priorEffect's dedupe (docs/AGENT_SELF_HEALING.md §6).
      return {ok:true,opKey:`send:${String(email.to).toLowerCase()}`,email,entity:email.to,operation:`Email ${email.to}`,
        ctx:{actionType:'email',declaredGoal:`Email ${email.to} the refund confirmation${unsure?' (recipient not on file)':''}`,riskScore:unsure?92:30,confidence:unsure?50:90,systemsTouched:['gmail'],
          act:{method:'POST',url:'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',body:`To: ${email.to}\nSubject: ${email.subject}\nMessage-ID: ${email.messageId}\n\n${email.body}`,evidence:{content:email.body,source_of_truth:sourceOfTruth(run)}},
          content:email.body,sourceOfTruth:sourceOfTruth(run),metadata:{message_id:email.messageId,recipient_confidence:email.recipientConfidence || 'low'}}};
    },
    async execute({providers,plan,config}){
      const raw=providers.gmail.composeRaw({to:plan.email.to,from:config.gmail.from,subject:plan.email.subject,body:plan.email.body,messageId:plan.email.messageId});
      const sent=await providers.gmail.send({raw});
      return {id:sent.id,at:now(),raw:{threadId:sent.threadId,labelIds:sent.labelIds || [],messageId:plan.email.messageId}};
    },
    async verify({providers,plan,receipt}){
      const reference=emailReference(plan.email.messageId);
      const found=receipt?.id && typeof providers.gmail.getMessage==='function'
        ?await providers.gmail.getMessage({id:receipt.id})
        :await providers.gmail.findByMessageId({messageId:plan.email.messageId,reference});
      const sent=found.found && (found.labelIds || []).includes('SENT');
      return {verified:sent,detail:sent?`Gmail holds message ${found.id} in Sent (reference ${reference}).`:found.found?`Gmail holds ${found.id} but not under Sent.`:`Gmail holds no message ${receipt?.id || `with reference ${reference}`}.`,evidence:{gmailId:found.id || null,threadId:found.threadId || null,messageId:plan.email.messageId,reference,labels:found.labelIds || []}};
    },
    async reconcile({providers,plan}){
      const reference=emailReference(plan.email.messageId);
      const found=await providers.gmail.findByMessageId({messageId:plan.email.messageId,reference});
      return found.found?{finding:'present',receipt:{id:found.id,at:now(),raw:{threadId:found.threadId,labelIds:found.labelIds || [],messageId:plan.email.messageId,reference}},detail:`Gmail already holds ${found.id} for reference ${reference}.`}:{finding:'absent',detail:`Gmail holds no message with reference ${reference}.`};
    },
    facts({run,receipt}){run.entities.email={...run.entities.email,gmailId:receipt.id,threadId:receipt.raw?.threadId || null,sentAt:receipt.at};}
  }
};
export const WRITE_SPECS=SPECS;

const countExecution=(run,effect)=>updateEffect(run,effect.effectId,{executions:(effect.executions || 0)+1});

// Every fault becomes one incident on the run and on disk, and one mark on the integration's circuit breaker (docs/AGENT_SELF_HEALING.md §2, §5).
function noteIncident(handle,fields){
  const {run,deps}=handle;
  const incident=recordIncident(run,fields);
  handle.recordIncident?.(incident);
  if(fields.breaker!==false) deps.breakers?.recordFailure(fields.integration,fields.failureClass);
  return incident;
}
function settleIncident(handle,incidentId,patch){
  const incident=resolveIncident(handle.run,incidentId,patch);
  if(incident) handle.recordIncident?.(incident);
  return incident;
}
const checkingLabel=spec=>`Checking whether ${APP_LABEL[spec.app]} already ${NOUN[spec.app]?.did || 'performed the write'}`;
// A breaker that is open for this app or for DashClaw refuses the write here, before any policy call: nothing is recorded anywhere but this run.
function breakerRefusal(handle,integration){
  const gate=handle.deps.breakers?.check(integration,{kind:'write'});
  return gate?.open?gate:null;
}
const outcomeResult=async(handle,effect,payload)=>{
  const {run,deps}=handle;
  if(!effect.actionId || effect.outcomeReported) return;
  try {
    const result=await deps.governed.outcome(effect.actionId,payload);
    if(result?.ok===false) appendEvent(run,{kind:'error',status:'info',app:'dashclaw',label:`DashClaw already holds an outcome for this action (${result.currentStatus || result.code})`,detail:`Sidelook wanted to report ${payload.status}; the earlier report stands in DashClaw's ledger.`,effectId:effect.effectId,actionId:effect.actionId});
    effect.outcomeReported=payload.status;
  } catch(error) {
    if(error.name==='AbortError') throw error;
    appendEvent(run,{kind:'error',status:'failed',app:'dashclaw',label:'Outcome could not be reported to DashClaw',detail:error.message,effectId:effect.effectId,actionId:effect.actionId});
  }
};

// One provider read (or several with a pause for an index that lags) to learn whether a write is there. Never a write.
async function reconcile(handle,spec,plan,effect,{reads=1}={}){
  const {run,deps,signal}=handle;
  const attempts=Math.max(1,reads);
  let last={finding:'unknown',detail:''};
  for(let i=1;i<=attempts;i++){
    try {
      last=await spec.reconcile({providers:deps.providers,plan,effect,run});
    } catch(error) {
      if(error.name==='AbortError') throw error;
      last={finding:'unknown',detail:error.message};
    }
    if(last.finding==='present' || last.finding==='unknown') break;
    if(i<attempts) await sleep(spec.reconcileGapMs || 1000,signal).catch(()=>{});
  }
  effect.reconciliations.push({at:now(),finding:last.finding,detail:last.detail,reads:attempts});
  const noun=NOUN[spec.app] || {did:'performed the write',none:'holds no trace of the write'};
  appendEvent(run,{kind:'recovery',status:last.finding==='present'?'ok':last.finding==='absent'?'info':'uncertain',app:spec.app,label:`${APP_LABEL[spec.app]} ${last.finding==='present'?`already ${noun.did}`:last.finding==='absent'?`${noun.none}; nothing was written`:'state unknown'}`,detail:last.detail,effectId:effect.effectId});
  return last;
}

// After any write fails, every earlier write is read again so the timeline proves what already happened before anything is retried.
// A re-read that fails, or disagrees with the receipt, is "unknown" on the sweep: it never demotes a verified write to absent.
async function sweepPrior(handle,current){
  const {run,deps}=handle;
  for(const effect of run.effects){
    if(effect.effectId===current.effectId || !['verified','executed','uncertain'].includes(effect.status)) continue;
    const spec=SPECS[effect.tool];const plan=effect.plan;
    if(!spec || !plan) continue;
    try {
      const result=effect.receipt?await spec.verify({providers:deps.providers,plan,receipt:effect.receipt,run}):await spec.reconcile({providers:deps.providers,plan,effect,run});
      const present=result.verified===true || result.finding==='present';
      effect.reconciliations.push({at:now(),finding:present?'present':result.finding==='absent'?'absent':'unknown',detail:result.detail,sweep:true});
      if(present && effect.status!=='verified' && result.verified) updateEffect(run,effect.effectId,{status:'verified',verification:{at:now(),verified:true,detail:result.detail,reads:1}});
      appendEvent(run,{kind:'recovery',status:present?'verified':'unverified',app:effect.app,label:`Previous ${APP_LABEL[effect.app]} ${NOUN[effect.app]?.thing || effect.opKey.split(':')[0]} ${present?'verified':'could not be confirmed on re-read'}`,detail:result.detail,effectId:effect.effectId,evidence:result.evidence || null});
    } catch(error) {
      if(error.name==='AbortError') throw error;
      effect.reconciliations.push({at:now(),finding:'unknown',detail:error.message,sweep:true});
      appendEvent(run,{kind:'recovery',status:'uncertain',app:effect.app,label:`${APP_LABEL[effect.app]} could not be re-read`,detail:error.message,effectId:effect.effectId});
    }
    handle.emit();
  }
}

// The person's decision from the panel or from the DashClaw dashboard, whichever arrives first; a Stop ends the wait, and so does the
// approval's own deadline, whether or not DashClaw can be reached to say so.
async function awaitDecision(handle,effect,actionId,approval){
  const {run,deps,signal}=handle;
  const deadline=Date.parse(approval.expiresAt) || (Date.now()+APPROVAL_WINDOW_MS);
  let settled=false;
  const poll=async()=>{
    while(!settled){
      try{await sleep(3000,signal);}catch{return null;}
      if(settled) return null;
      if(Date.now()>=deadline) return {via:'sidelook',decision:'expired'};
      const state=await deps.governed.poll(actionId).catch(()=>null);
      if(!state) continue;
      if(state.approvedBy) return {via:'dashclaw',decision:'allow',confirmed:true};
      if(state.expired || state.status==='expired') return {via:'dashclaw',decision:'expired'};
      if(['failed','cancelled'].includes(state.status)) return {via:'dashclaw',decision:'deny'};
    }
    return null;
  };
  const fromPanel=handle.waitForDecision(actionId).then(d=>d?.cancelled?{via:'sidelook',decision:'cancelled'}:{via:'sidelook',...d});
  let outcome;
  while(true){
    outcome=await Promise.race([fromPanel,poll()]);
    if(!outcome || outcome.via!=='sidelook' || outcome.decision==='cancelled' || outcome.decision==='expired') break;
    // The panel's decision goes to DashClaw through the approver key. A refusal there is shown on the card and the wait continues,
    // because the dashboard can still decide it; nothing executes on the panel's word alone.
    const submit=outcome.decision==='allow'?await deps.governed.approve(actionId,outcome.reason || 'Approved in Sidelook').catch(e=>({ok:false,code:e.code || 'GOVERNANCE_UNAVAILABLE',message:e.message}))
      :await deps.governed.reject(actionId,outcome.reason || 'Rejected in Sidelook').catch(e=>({ok:false,code:e.code || 'GOVERNANCE_UNAVAILABLE',message:e.message}));
    outcome.done?.(submit);
    if(submit.ok){
      if(outcome.decision==='deny') break;
      // Approved: DashClaw's own record is what releases the claim, so it is read back before anything continues. An approval
      // that DashClaw accepted but cannot be read back is not confirmed, and nothing runs on an unconfirmed approval.
      outcome.confirmed=false;
      for(let i=0;i<15 && !outcome.confirmed;i++){
        const state=await deps.governed.poll(actionId).catch(()=>null);
        if(state?.approvedBy) outcome.confirmed=true;
        else {try{await sleep(1000,signal);}catch{break;}}
      }
      break;
    }
    if(submit.code==='ALREADY_RESOLVED' || submit.code==='EXPIRED'){
      const state=await deps.governed.poll(actionId).catch(()=>null);
      outcome={via:'dashclaw',decision:state?.approvedBy?'allow':state?.expired || submit.code==='EXPIRED'?'expired':'deny',confirmed:!!state?.approvedBy};
      break;
    }
    approval.error=`${submit.message || submit.code}. You can still decide it in the DashClaw dashboard.`;
    appendEvent(run,{kind:'approval',status:'failed',app:'dashclaw',label:'DashClaw refused the decision from Sidelook',detail:approval.error,actionId,effectId:effect.effectId});
    handle.emit();
    // Re-arm the panel and keep waiting on both sources; this call's poll loop ends first so only one keeps running.
    settled=true;
    return awaitDecision(handle,effect,actionId,approval);
  }
  settled=true;handle.clearDecision?.();
  return outcome || {via:'dashclaw',decision:'cancelled'};
}

// The run's last word on anything still uncertain: provider reads only. Present becomes verified through the normal read-back,
// absent becomes failed (nothing executed), unknown stays uncertain and the run ends uncertain. DashClaw hears the outcome here,
// once, for effects whose earlier branches deliberately left it unreported. `handle.only` names one effect (resume reads them in order).
export async function reconcileUncertain(handle){
  const {run}=handle;
  for(const effect of run.effects.filter(e=>e.status==='uncertain' && (!handle.only || e.effectId===handle.only))){
    const spec=SPECS[effect.tool];if(!spec || !effect.plan) continue;
    // One effect's failure here (an illegal transition, a provider read that throws unexpectedly) never abandons the rest
    // of the ledger: every other uncertain effect still gets its own final check (docs/AGENT_SELF_HEALING.md §6).
    try {
      appendEvent(run,{kind:'recovery',status:'started',app:spec.app,label:`${checkingLabel(spec)} (final check)`,effectId:effect.effectId});
      const found=await reconcile(handle,spec,effect.plan,effect,{reads:spec.reconcileReads || 1});
      const pending=run.incidents.filter(i=>i.effectId===effect.effectId && i.finalDisposition==='pending');
      if(found.finding==='present'){updateEffect(run,effect.effectId,{status:'executed',receipt:found.receipt});countExecution(run,effect);for(const i of pending) settleIncident(handle,i.incidentId,{knownState:'present',uncertainState:false,recoveryAttempted:true,recoveryResult:'reconciled_present',providerOperationId:found.receipt?.id || null});await finishVerification(handle,spec,effect.plan,effect,{});}
      else if(found.finding==='absent'){
        updateEffect(run,effect.effectId,{status:'failed',error:{code:'ABSENT_AFTER_RECONCILE',message:'The provider holds no trace of this write; it did not happen.'}});
        for(const i of pending) settleIncident(handle,i.incidentId,{knownState:'absent',uncertainState:false,recoveryAttempted:true,recoveryResult:'reconciled_absent',finalDisposition:'failed'});
        await outcomeResult(handle,effect,{status:'failed',error_message:'The provider holds no trace of this write after reconciliation.'});
      } else {
        // Unknowable after every allowed read: its own incident, at the severity a person should look at first.
        for(const i of pending) settleIncident(handle,i.incidentId,{uncertainState:true,recoveryAttempted:true,recoveryResult:'stopped_uncertain',finalDisposition:'uncertain'});
        noteIncident(handle,{integration:spec.app,tool:effect.tool,operation:effect.opKey,phase:'reconcile',failureClass:'unknown_external_state',error:{code:'UNKNOWN_STATE',message:found.detail || 'The provider state could not be read.'},effectId:effect.effectId,dashclawActionId:effect.actionId,knownState:'sent_unknown',uncertainState:true,recoveryAttempted:true,recoveryStrategy:'stop_uncertain',recoveryResult:'stopped_uncertain',finalDisposition:'uncertain',breaker:false});
        await outcomeResult(handle,effect,{status:'partial',progress:{state:'uncertain',reconciliations:effect.reconciliations.length},summary:'Provider state could not be established after a lost response.'});
      }
    } catch(error) {
      if(error.name==='AbortError') throw error;
      addError(run,{code:error.code || 'RECONCILE',message:error.message,step:'reconcile'});
    }
    handle.emit();
  }
}

// A restart's read-back of a write the provider accepted before the interruption (docs/AGENT_SELF_HEALING.md §6): the normal
// verification, on the persisted plan and receipt, never a new request.
export async function verifyExecuted(handle,effect){
  const spec=SPECS[effect.tool];
  if(!spec || !effect.plan || !effect.receipt) return {verified:false,detail:'Nothing to verify: the effect has no plan or receipt.'};
  await finishVerification(handle,spec,effect.plan,effect,{alreadyDone:true});
  return effect.verification || {verified:false,detail:'Verification did not run.'};
}

export function summarizeEffect(effect){
  const words={planned:'planned',blocked:'blocked',rejected:'rejected',pending_approval:'waiting for approval',claimed:'authorized, not sent',executing:'sending',executed:effect.verification && effect.verification.verified===false?'verification unavailable':'executed, not verified',verified:'verified',failed:'failed',uncertain:'state uncertain',expired:'expired'};
  return words[effect.status] || effect.status;
}

// One consequential write, start to finish. Returns the observation the model sees.
export async function executeWrite(handle,tool,args){
  const {run,deps,signal}=handle;
  const spec=SPECS[tool];
  if(!spec) throw err('UNKNOWN_WRITE',`${tool} is not a governed write.`);
  const app=spec.app,label=APP_LABEL[app];
  const refuse=(code,message,incidentFields=null)=>{
    appendEvent(run,{kind:'policy',status:'blocked',app,label:`${label} write refused before it started`,detail:message,evidence:{code}});
    const effect=planEffect(run,{tool,app,opKey:`refused:${code}:${run.effects.length}`});
    updateEffect(run,effect.effectId,{status:'blocked',error:{code,message},policy:{decision:'refused',reasons:[message],matchedPolicies:['sidelook:precondition'],riskScore:null}});
    // The refusal is evidence: a precondition the model can correct reads as info, an identity the tools could not settle asks the person.
    const failureClass=incidentFields?.failureClass || classifyFailure({error:{code},phase:'precondition'});
    noteIncident(handle,{integration:incidentFields?.integration || app,tool,operation:planned?.opKey || tool,phase:'precondition',failureClass,error:{code,message},effectId:effect.effectId,knownState:'not_sent',
      recoveryStrategy:incidentFields?.recoveryStrategy || (failureClass==='ambiguous_identity'?'ask_user':'none'),recoveryResult:incidentFields?.recoveryResult || (failureClass==='ambiguous_identity'?'asked_user':'none'),
      breaker:incidentFields?.breaker===true,...(incidentFields?.severity?{severity:incidentFields.severity}:{})});
    handle.emit();
    // A refusal here is the runtime's own precondition, not a DashClaw verdict: the model may call again with corrected
    // arguments (the first live run stopped after one, because the prompt then called every block final).
    return {tool,status:'refused',code,detail:message,next:'Nothing was sent. Correct the arguments and call the tool again, or move on if the observation says the write cannot be made.'};
  };
  const planned=spec.plan({run,args,config:deps.config || {}});
  if(!planned.ok) return refuse(planned.code,planned.message);
  // An open circuit for this app, or for DashClaw, refuses the write before any policy call (docs/AGENT_SELF_HEALING.md §5).
  const appGate=breakerRefusal(handle,app);
  if(appGate) return refuse('CIRCUIT_OPEN',`${appGate.reason}. Nothing was sent; the circuit clears on its own.`,{failureClass:appGate.failureClass,recoveryStrategy:'open_breaker',recoveryResult:'failed_closed',severity:'warn'});
  const dashclawGate=breakerRefusal(handle,'dashclaw');
  if(dashclawGate) return refuse('GOVERNANCE_UNAVAILABLE',`${dashclawGate.reason}. Nothing runs without DashClaw.`,{integration:'dashclaw',failureClass:'dashclaw_unavailable',recoveryStrategy:'open_breaker',recoveryResult:'failed_closed',severity:'warn'});
  // Money needs the human-in-the-loop policy to exist on the instance; without it the run refuses locally rather than trusting DashClaw's default allow.
  if(spec.financial && !deps.config?.flags?.allowUnheldRefunds){
    const names=await deps.governed.policyNames?.().catch(()=>null);
    if(!Array.isArray(names)) return refuse('GOVERNANCE_UNAVAILABLE','DashClaw could not list its policies, so no money moves.',{integration:'dashclaw',failureClass:'dashclaw_unavailable',recoveryStrategy:'fail_closed',recoveryResult:'failed_closed',severity:'high',breaker:true});
    if(!names.some(name=>/refunds need a human/i.test(name))) return refuse('REFUND_HOLD_POLICY_MISSING','The DashClaw policy that holds refunds for a person is not installed for this agent. Run npm run agent:setup-dashclaw first.',{integration:'dashclaw',failureClass:'dashclaw_block',recoveryStrategy:'fail_closed',recoveryResult:'failed_closed'});
  }
  const prior=priorEffect(run,tool,planned.opKey);
  // A write the parent run accepted but never read back (a continued run): verify it now, never repeat it.
  if(prior && prior.status==='executed' && prior.inheritedFrom && prior.plan && prior.receipt){
    appendEvent(run,{kind:'recovery',status:'started',app,label:`${label}: verifying a write from run ${prior.inheritedFrom.runId} before anything new`,effectId:prior.effectId});
    return finishVerification(handle,spec,prior.plan,prior,{alreadyDone:true});
  }
  if(prior && ['verified','executed','claimed','executing','pending_approval'].includes(prior.status)){
    appendEvent(run,{kind:'policy',status:'info',app,label:`${label}: this write already happened ${prior.inheritedFrom?`in run ${prior.inheritedFrom.runId}`:'in this run'} and is not repeated`,detail:`${planned.operation} · ${summarizeEffect(prior)}`,effectId:prior.effectId,evidence:prior.receipt});
    handle.emit();
    return {tool,status:prior.status==='verified'?'verified':'executed',alreadyDone:true,receipt:prior.receipt,detail:`Already done ${prior.inheritedFrom?'in the earlier run':'in this run'}; not repeated.`};
  }
  if(prior && prior.status==='uncertain'){
    appendEvent(run,{kind:'recovery',status:'started',app,label:`${checkingLabel(spec)} (an earlier attempt, before anything new)`,effectId:prior.effectId});
    const found=await reconcile(handle,spec,prior.plan,prior,{reads:spec.reconcileReads || 1});
    const pending=run.incidents.filter(i=>i.effectId===prior.effectId && i.finalDisposition==='pending');
    if(found.finding==='present'){updateEffect(run,prior.effectId,{status:'executed',receipt:found.receipt});countExecution(run,prior);for(const i of pending) settleIncident(handle,i.incidentId,{knownState:'present',uncertainState:false,recoveryAttempted:true,recoveryResult:'reconciled_present',providerOperationId:found.receipt?.id || null});return finishVerification(handle,spec,prior.plan,prior,{alreadyDone:true});}
    if(found.finding==='unknown' || spec.noBlindRetry){handle.emit();return {tool,status:'uncertain',detail:'An earlier attempt could not be reconciled. Nothing new was sent.'};}
    updateEffect(run,prior.effectId,{status:'failed',error:{code:'ABSENT_AFTER_RECONCILE',message:'The earlier attempt did not happen.'}});
    for(const i of pending) settleIncident(handle,i.incidentId,{knownState:'absent',uncertainState:false,recoveryAttempted:true,recoveryResult:'reconciled_absent',finalDisposition:'failed'});
    await outcomeResult(handle,prior,{status:'failed',error_message:'The earlier attempt did not happen.'});
  }
  // A fresh attempt after one the provider proved absent, here or in an earlier run of this lineage, is a new logical attempt
  // with its own idempotency key and its own DashClaw action; a proven-present one never gets this far (docs/AGENT_SELF_HEALING.md §6).
  const series=nextSeries(run,tool,planned.opKey);
  if(spec.precheck){
    try {
      const check=await spec.precheck({providers:deps.providers,plan:planned,run});
      if(check.satisfied){
        const effect=planEffect(run,{tool,app,opKey:planned.opKey});effect.plan=planned;
        updateEffect(run,effect.effectId,{status:'verified',attempts:0,receipt:{id:planned.contactId || 'already',at:now(),raw:{current:check.current}},verification:{at:now(),verified:true,detail:'Already in the target state; nothing was written.',reads:1}});
        spec.facts?.({run,plan:planned,receipt:effect.receipt,verification:effect.verification});
        appendEvent(run,{kind:'verify',status:'verified',app,label:`${label} already in the target state`,detail:`${planned.operation} · no write was needed.`,effectId:effect.effectId,evidence:{current:check.current}});
        handle.emit();
        return {tool,status:'verified',alreadySatisfied:true,detail:'Already in the target state; nothing was written.'};
      }
    } catch(error) {
      if(error.name==='AbortError') throw error;
      appendEvent(run,{kind:'tool',status:'failed',app,label:`${label} could not be read before writing`,detail:error.message});
      handle.emit();
      return {tool,status:'failed',code:error.code || 'READ_FAILED',detail:`The precondition read failed: ${error.message}`};
    }
  }
  const effect=planEffect(run,{tool,app,opKey:planned.opKey,series});effect.plan=planned;effect.executions=0;
  let ctx;
  try {ctx={...planned.ctx,act:deps.governed.actForHttp(planned.ctx.act)};}
  catch(error){updateEffect(run,effect.effectId,{status:'failed',error:{code:'ACT_INVALID',message:error.message}});handle.emit();return {tool,status:'failed',code:'ACT_INVALID',detail:error.message};}
  setStep(run,`${label}: ${planned.operation}`);
  appendEvent(run,{kind:'write',status:'started',app,label:planned.operation,detail:`DashClaw is deciding whether this may run.`,effectId:effect.effectId});
  handle.emit();
  let recorded;
  try {recorded=await deps.governed.record(effect,ctx);deps.breakers?.recordSuccess('dashclaw');}
  catch(error){
    if(error.name==='AbortError') throw error;
    updateEffect(run,effect.effectId,{status:'blocked',error:{code:error.code || 'GOVERNANCE_UNAVAILABLE',message:error.message},policy:{decision:'unavailable',reasons:[error.message],matchedPolicies:[],riskScore:null}});
    const incident=noteIncident(handle,{integration:'dashclaw',tool,operation:planned.opKey,phase:'govern',failureClass:'dashclaw_unavailable',error,effectId:effect.effectId,knownState:'not_sent',recoveryStrategy:'fail_closed',recoveryResult:'failed_closed',finalDisposition:'blocked'});
    appendEvent(run,{kind:'policy',status:'blocked',app:'dashclaw',label:'DashClaw could not be reached; nothing runs without it',detail:error.message,effectId:effect.effectId,incidentId:incident.incidentId});
    handle.emit();
    return {tool,status:'blocked',code:'GOVERNANCE_UNAVAILABLE',detail:error.message};
  }
  updateEffect(run,effect.effectId,{actionId:recorded.actionId || null,decisionId:recorded.decisionId || null,policy:{decision:recorded.decision,reasons:recorded.reasons || [],matchedPolicies:recorded.matchedPolicies || [],riskScore:recorded.riskScore ?? null,nonFabrication:recorded.nonFabrication || null}});
  if(recorded.actionId) run.dashclaw.actionIds.push(recorded.actionId);
  // The action id is on disk before anything else happens, so a crash from here on leaves a record that names what to look up.
  await handle.persist?.();
  if(recorded.state==='blocked'){
    updateEffect(run,effect.effectId,{status:'blocked',error:{code:'POLICY_BLOCK',message:(recorded.reasons || []).join('; ') || 'Blocked by DashClaw policy.'}});
    noteIncident(handle,{integration:'dashclaw',tool,operation:planned.opKey,phase:'govern',failureClass:'dashclaw_block',error:{code:'POLICY_BLOCK',message:(recorded.reasons || []).join('; ') || 'Blocked by DashClaw policy.'},effectId:effect.effectId,dashclawActionId:recorded.actionId,knownState:'not_sent',recoveryResult:'none',finalDisposition:'blocked',breaker:false});
    appendEvent(run,{kind:'policy',status:'blocked',app:'dashclaw',label:`DashClaw blocked: ${planned.operation}`,detail:(recorded.reasons || []).join('; ') || 'Blocked by policy.',actionId:recorded.actionId,effectId:effect.effectId,evidence:{matchedPolicies:recorded.matchedPolicies,riskScore:recorded.riskScore,nonFabrication:recorded.nonFabrication}});
    if(recorded.nonFabrication?.length) appendEvent(run,{kind:'policy',status:'blocked',app:'dashclaw',label:'DashClaw content verification failed',detail:recorded.nonFabrication.flatMap(n=>n.violations || []).map(v=>`${v.label || v.code}${v.detail?` (${v.detail})`:''}`).join(', '),actionId:recorded.actionId,effectId:effect.effectId});
    handle.emit();
    return {tool,status:'blocked',code:'POLICY_BLOCK',reasons:recorded.reasons,matchedPolicies:recorded.matchedPolicies,detail:'DashClaw blocked this action. Do not retry it with other arguments.'};
  }
  if(recorded.state==='pending'){
    updateEffect(run,effect.effectId,{status:'pending_approval'});
    const approval=addApproval(run,{actionId:recorded.actionId,effectId:effect.effectId,app,operation:planned.operation,entity:planned.entity,amount:planned.amount || null,currency:planned.currency || null,
      reason:args.reason || '',sourceEvidence:run.sourceFacts.filter(f=>['request','customer_name','payment_id','payment_amount','payment_date'].includes(f.key)).map(f=>({label:f.label,value:f.value,source:f.source,ref:f.ref})),
      policyReason:(recorded.reasons || []).join('; ') || (recorded.matchedPolicies || []).join(', ') || 'Held for approval by DashClaw policy.',matchedPolicies:recorded.matchedPolicies || [],riskScore:recorded.riskScore ?? null,expiresAt:new Date(Date.now()+APPROVAL_WINDOW_MS).toISOString()});
    appendEvent(run,{kind:'approval',status:'pending',app:'dashclaw',label:`DashClaw: approval required for ${planned.operation}`,detail:approval.policyReason,actionId:recorded.actionId,effectId:effect.effectId,evidence:{riskScore:recorded.riskScore,matchedPolicies:recorded.matchedPolicies}});
    transition(run,'waiting_for_approval',`Waiting for a decision on ${planned.operation}.`);
    setStep(run,'Waiting for your decision');
    handle.emit();
    const decision=await awaitDecision(handle,effect,recorded.actionId,approval);
    if(decision.decision==='cancelled'){
      resolveApproval(run,recorded.actionId,'expired','sidelook');
      updateEffect(run,effect.effectId,{status:'expired',error:{code:'CANCELLED',message:'Stopped before a decision was made.'}});
      appendEvent(run,{kind:'approval',status:'info',app:'dashclaw',label:'Stopped while waiting for the decision; nothing ran',actionId:recorded.actionId,effectId:effect.effectId});
      await deps.governed.reject(recorded.actionId,'Stopped in Sidelook before a decision').catch(()=>{});
      handle.emit();
      throw new DOMException('Canceled','AbortError');
    }
    if(decision.decision==='deny'){
      resolveApproval(run,recorded.actionId,'rejected',decision.via);
      updateEffect(run,effect.effectId,{status:'rejected',error:{code:'REJECTED',message:`Rejected ${decision.via==='sidelook'?'in Sidelook':'in the DashClaw dashboard'}.`}});
      noteIncident(handle,{integration:'dashclaw',tool,operation:planned.opKey,phase:'approval',failureClass:'approval_denied',error:{code:'REJECTED',message:`Rejected ${decision.via==='sidelook'?'in Sidelook':'in the DashClaw dashboard'}.`},effectId:effect.effectId,dashclawActionId:recorded.actionId,knownState:'not_sent',recoveryResult:'none',finalDisposition:'blocked',breaker:false});
      appendEvent(run,{kind:'approval',status:'rejected',app:'dashclaw',label:`Rejected: ${planned.operation}`,detail:`Nothing ran. Decided ${decision.via==='sidelook'?'in Sidelook':'in DashClaw'}.`,actionId:recorded.actionId,effectId:effect.effectId});
      transition(run,'executing','Continuing after a rejection.');handle.emit();
      return {tool,status:'rejected',detail:'The person rejected this action. Do not retry it.'};
    }
    if(decision.decision==='expired'){
      resolveApproval(run,recorded.actionId,'expired',decision.via);
      updateEffect(run,effect.effectId,{status:'expired',error:{code:'APPROVAL_EXPIRED',message:'The approval expired before a decision was made.'}});
      noteIncident(handle,{integration:'dashclaw',tool,operation:planned.opKey,phase:'approval',failureClass:'approval_expired',error:{code:'APPROVAL_EXPIRED',message:'The approval expired before a decision was made.'},effectId:effect.effectId,dashclawActionId:recorded.actionId,knownState:'not_sent',recoveryResult:'none',finalDisposition:'blocked',breaker:false});
      appendEvent(run,{kind:'approval',status:'failed',app:'dashclaw',label:`Approval expired: ${planned.operation}`,detail:'Nothing ran.',actionId:recorded.actionId,effectId:effect.effectId});
      transition(run,'executing','Continuing after an expired approval.');handle.emit();
      return {tool,status:'expired',detail:'The approval expired. Do not retry it.'};
    }
    if(!decision.confirmed){
      resolveApproval(run,recorded.actionId,'approved',decision.via);
      updateEffect(run,effect.effectId,{status:'blocked',error:{code:'APPROVAL_UNCONFIRMED',message:'DashClaw accepted the decision but could not be read back; nothing ran.'}});
      noteIncident(handle,{integration:'dashclaw',tool,operation:planned.opKey,phase:'approval',failureClass:'approval_expired',error:{code:'APPROVAL_UNCONFIRMED',message:'DashClaw accepted the decision but could not be read back; nothing ran.'},effectId:effect.effectId,dashclawActionId:recorded.actionId,knownState:'not_sent',recoveryStrategy:'fail_closed',recoveryResult:'failed_closed',finalDisposition:'blocked',breaker:false});
      appendEvent(run,{kind:'approval',status:'blocked',app:'dashclaw',label:`Approval not confirmed: ${planned.operation}`,detail:'DashClaw accepted the decision but its record could not be read back, so nothing ran.',actionId:recorded.actionId,effectId:effect.effectId});
      transition(run,'executing','Continuing after an unconfirmed approval.');handle.emit();
      return {tool,status:'blocked',code:'APPROVAL_UNCONFIRMED',detail:'The approval could not be confirmed with DashClaw. Nothing ran.'};
    }
    resolveApproval(run,recorded.actionId,'approved',decision.via);
    appendEvent(run,{kind:'approval',status:'ok',app:'dashclaw',label:`Approved: ${planned.operation}`,detail:`Decided ${decision.via==='sidelook'?'in Sidelook':'in the DashClaw dashboard'}. DashClaw holds the grant; the execution claim comes next.`,actionId:recorded.actionId,effectId:effect.effectId});
    transition(run,'executing','Approved; executing.');handle.emit();
  }
  // Money moves only after a person said yes. DashClaw can answer `warn` for the very policy that holds refunds: its
  // interruption budget demotes require_approval to warn "WITHOUT human review" once one command shape has asked more than
  // 10 times in 24 h (`builtin:shape_budget`, app/lib/guard/evaluate.grants.ts), and a warn is an allow. Seen live on
  // 2026-09-11 after a day of demo refunds: a $485.00 refund ran with no card. The hold is the promise this screen makes,
  // so a refund DashClaw did not hold is refused here and closed on DashClaw as failed.
  if(spec.financial && recorded.state==='allowed' && !recorded.approvedBy && !deps.config?.flags?.allowUnheldRefunds){
    const matched=(recorded.matchedPolicies || []).join(', ');
    const why=`DashClaw answered ${recorded.decision || 'allow'} instead of holding this refund for a person${matched?` (${matched})`:''}.`;
    updateEffect(run,effect.effectId,{status:'blocked',error:{code:'REFUND_NOT_HELD',message:why}});
    noteIncident(handle,{integration:'dashclaw',tool,operation:planned.opKey,phase:'govern',failureClass:'dashclaw_block',error:{code:'REFUND_NOT_HELD',message:why},effectId:effect.effectId,dashclawActionId:recorded.actionId,knownState:'not_sent',recoveryStrategy:'fail_closed',recoveryResult:'failed_closed',finalDisposition:'blocked',severity:'high',breaker:false});
    appendEvent(run,{kind:'policy',status:'blocked',app:'dashclaw',label:`Refused: ${planned.operation} was not held for a person`,detail:`${why} Sidelook does not move money without an approval; check the refunds policy at /policies on DashClaw.`,actionId:recorded.actionId,effectId:effect.effectId,evidence:{decision:recorded.decision,matchedPolicies:recorded.matchedPolicies,riskScore:recorded.riskScore}});
    await outcomeResult(handle,effect,{status:'failed',error_message:`Sidelook refused to run this refund: ${why}`});
    handle.emit();
    return {tool,status:'blocked',code:'REFUND_NOT_HELD',detail:'No person approved this refund, so it did not run. Do not retry it; say so in the closing message.'};
  }
  if(recorded.state==='replayed_claimed'){
    // A previous process claimed this exact action. Whether it executed is the provider's word, not ours.
    appendEvent(run,{kind:'recovery',status:'started',app,label:`${checkingLabel(spec)} (DashClaw shows an earlier claim for this write)`,actionId:recorded.actionId,effectId:effect.effectId});
    const found=await reconcile(handle,spec,planned,effect,{reads:spec.reconcileReads || 1});
    if(found.finding==='present'){updateEffect(run,effect.effectId,{status:'executed',receipt:found.receipt,attempts:1});countExecution(run,effect);return finishVerification(handle,spec,planned,effect,{});}
    updateEffect(run,effect.effectId,{status:found.finding==='absent'?'failed':'uncertain',error:{code:'CLAIM_CONSUMED',message:'The execution claim was already used by an earlier attempt.'}});
    noteIncident(handle,{integration:'dashclaw',tool,operation:planned.opKey,phase:'claim',failureClass:found.finding==='absent'?'dashclaw_block':'unknown_external_state',error:{code:found.finding==='absent'?'CLAIM_CONSUMED':'UNKNOWN_STATE',message:'The execution claim was already used by an earlier attempt.'},effectId:effect.effectId,dashclawActionId:recorded.actionId,knownState:found.finding==='absent'?'absent':'sent_unknown',uncertainState:found.finding!=='absent',recoveryAttempted:true,recoveryStrategy:'reconcile',recoveryResult:found.finding==='absent'?'reconciled_absent':'stopped_uncertain',finalDisposition:found.finding==='absent'?'failed':'uncertain',breaker:false});
    handle.emit();
    return {tool,status:found.finding==='absent'?'failed':'uncertain',code:'CLAIM_CONSUMED',detail:'An earlier attempt already used the execution claim; nothing new ran.'};
  }
  if(signal.aborted) throw new DOMException('Canceled','AbortError');
  // The claim: one execution attempt bound to this action, this agent and this exact act. Nothing runs without its confirmation.
  try {
    const claimed=await deps.governed.claim(recorded.actionId,ctx.act);
    updateEffect(run,effect.effectId,{status:'claimed',attemptId:claimed.attemptId});
    deps.breakers?.recordSuccess('dashclaw');
    appendEvent(run,{kind:'policy',status:'ok',app:'dashclaw',label:`DashClaw ${recorded.state==='pending'?'released':'allowed'}: ${planned.operation}`,detail:`Execution claim ${claimed.attemptId.slice(0,8)}… confirmed.`,actionId:recorded.actionId,effectId:effect.effectId,evidence:{riskScore:recorded.riskScore,matchedPolicies:recorded.matchedPolicies,attemptId:claimed.attemptId}});
  } catch(error) {
    if(error.name==='AbortError') throw error;
    const uncertain=error.code==='CLAIM_UNCERTAIN';
    updateEffect(run,effect.effectId,{status:uncertain?'uncertain':'blocked',error:{code:error.code || 'CLAIM_REFUSED',message:error.message}});
    const incident=noteIncident(handle,{integration:'dashclaw',tool,operation:planned.opKey,phase:'claim',failureClass:uncertain?'dashclaw_unavailable':'dashclaw_block',error,effectId:effect.effectId,dashclawActionId:recorded.actionId,knownState:'not_sent',uncertainState:uncertain,recoveryStrategy:'fail_closed',recoveryResult:'failed_closed',finalDisposition:uncertain?'uncertain':'blocked',breaker:uncertain});
    appendEvent(run,{kind:'policy',status:uncertain?'uncertain':'blocked',app:'dashclaw',label:uncertain?'The execution claim could not be confirmed; nothing ran':`DashClaw refused the execution claim: ${planned.operation}`,detail:error.message,actionId:recorded.actionId,effectId:effect.effectId,incidentId:incident.incidentId});
    handle.emit();
    return {tool,status:uncertain?'uncertain':'blocked',code:error.code,detail:error.message};
  }
  // The claim is on disk before the request leaves: a crash after this point leaves an effect that reconciliation can look up.
  await handle.persist?.();
  return performAndVerify(handle,spec,planned,effect);
}

// The write, its failure, and what the recovery policy allows next. Every fault is classified and recorded before anything
// is decided; a request that may have reached the provider is read back before any retry; a retry happens only when the
// policy row for that class says so and the provider proved the write absent (docs/AGENT_SELF_HEALING.md §4).
async function performAndVerify(handle,spec,plan,effect){
  const {run,deps,signal}=handle;
  const app=spec.app,label=APP_LABEL[app],verb=effect.opKey.split(':')[0];
  let receipt=null,attempt=0,waitMs=0;
  while(!receipt){
    if(signal.aborted) throw new DOMException('Canceled','AbortError');
    attempt++;
    if(attempt>1){appendEvent(run,{kind:'recovery',status:'started',app,label:`Retrying ${label} safely`,detail:`Attempt ${attempt}${waitMs?` after a ${Math.round(waitMs/100)/10} s pause`:''}. A read proved nothing was written.`,effectId:effect.effectId});handle.emit();await sleep(waitMs,signal);}
    updateEffect(run,effect.effectId,{status:'executing',attempts:effect.attempts+1});
    setStep(run,`${label}: ${plan.operation}`);handle.emit();
    // Durable before the request leaves, on a retry the same as on the first attempt: a crash from here on finds 'executing'
    // (resume.mjs reconciles it) and never a stale 'failed' from the decision that led to this retry.
    await handle.persist?.();
    try {
      if(deps.config?.flags?.failHubspotOnce && app==='hubspot' && !run.context.failHubspotInjected){
        run.context.failHubspotInjected=true;
        throw err('SERVER','HubSpot answered 503 Service Unavailable (injected once by HACKATHON_FAIL_HUBSPOT_ONCE).',{sentRequest:false,retryable:true,injected:true});
      }
      receipt=await spec.execute({providers:deps.providers,plan,effect,run,config:deps.config || {}});
      updateEffect(run,effect.effectId,{status:'executed',receipt});countExecution(run,effect);
      deps.breakers?.recordSuccess(app);
      appendEvent(run,{kind:'write',status:'pending',app,label:`${label} ${verb} accepted`,detail:`Receipt ${receipt.id}. Not yet verified.`,effectId:effect.effectId,actionId:effect.actionId,evidence:{id:receipt.id,...receipt.raw}});
    } catch(error) {
      if(error.name==='AbortError') throw error;
      const mayHaveReached=error.sentRequest!==false;
      const failureClass=classifyFailure({error,phase:'execute',sentRequest:mayHaveReached});
      // One incident per fault episode: a second attempt that fails the same way updates the record instead of adding another.
      const open=run.incidents.find(i=>i.effectId===effect.effectId && i.failureClass===failureClass && i.phase==='execute' && i.recoveryResult==='pending');
      const incident=open
        ?(deps.breakers?.recordFailure(app,failureClass),settleIncident(handle,open.incidentId,{attemptNumber:attempt,knownState:mayHaveReached?'sent_unknown':'not_sent',uncertainState:mayHaveReached,sanitizedEvidence:{code:error.code || 'UNKNOWN',message:error.message}}))
        :noteIncident(handle,{integration:app,tool:effect.tool,operation:effect.opKey,phase:'execute',failureClass,error,effectId:effect.effectId,attemptNumber:attempt,dashclawActionId:effect.actionId,knownState:mayHaveReached?'sent_unknown':'not_sent',uncertainState:mayHaveReached});
      appendEvent(run,{kind:'write',status:mayHaveReached?'uncertain':'failed',app,label:`${label} ${verb} failed`,detail:`${error.message}${mayHaveReached?' The request may have reached the provider.':''}`,effectId:effect.effectId,evidence:{code:error.code || 'UNKNOWN',sentRequest:mayHaveReached,failureClass},incidentId:incident.incidentId});
      transition(run,'recovering',`${label} failed; checking previous effects before anything is retried.`);
      appendEvent(run,{kind:'recovery',status:'started',app,label:'Checking previous effects',effectId:effect.effectId});
      handle.emit();
      await sweepPrior(handle,effect);
      let decision=decideWrite({failureClass,attempt,spec,finding:null,retryAfterMs:error.retryAfterMs});
      if(decision.action==='reconcile' || decision.action==='refresh_read'){
        updateEffect(run,effect.effectId,{status:'uncertain'});
        settleIncident(handle,incident.incidentId,{recoveryAttempted:true,recoveryStrategy:decision.action});
        appendEvent(run,{kind:'recovery',status:'started',app,label:checkingLabel(spec),detail:decision.reason,effectId:effect.effectId,incidentId:incident.incidentId});
        const found=await reconcile(handle,spec,plan,effect,{reads:spec.reconcileReads || 1});
        if(found.finding==='present'){
          receipt=found.receipt;updateEffect(run,effect.effectId,{status:'executed',receipt});countExecution(run,effect);
          settleIncident(handle,incident.incidentId,{knownState:'present',uncertainState:false,recoveryResult:'reconciled_present',providerOperationId:receipt.id});
          transition(run,'executing','The write is there; verifying.');handle.emit();
          break;
        }
        if(found.finding==='absent') settleIncident(handle,incident.incidentId,{knownState:'absent',uncertainState:false,recoveryResult:'reconciled_absent'});
        decision=decideWrite({failureClass,attempt,spec,finding:found.finding,retryAfterMs:error.retryAfterMs});
      } else {
        effect.reconciliations.push({at:now(),finding:'absent',detail:'The request never left this process.',presend:true});
      }
      if(decision.action==='retry' || decision.action==='wait_then_retry'){
        waitMs=decision.waitMs;
        // Never durably 'failed' for an attempt about to be retried (docs/AGENT_SELF_HEALING.md §4): the ledger only reads
        // 'failed' once nothing more will be sent. The next loop turn sets 'executing' and persists it before the resend.
        settleIncident(handle,incident.incidentId,{recoveryAttempted:true,recoveryStrategy:decision.action,recoveryResult:'pending'});
        transition(run,'executing','Retrying after the checks.');handle.emit();
        continue;
      }
      if(decision.action==='stop_uncertain'){
        updateEffect(run,effect.effectId,{status:'uncertain',error:{code:error.code || 'UNKNOWN',message:error.message}});
        settleIncident(handle,incident.incidentId,{uncertainState:true,recoveryAttempted:incident.recoveryAttempted,recoveryStrategy:incident.recoveryStrategy==='none'?'stop_uncertain':incident.recoveryStrategy,recoveryResult:'stopped_uncertain',finalDisposition:'uncertain'});
        transition(run,'executing','State could not be established.');handle.emit();
        return {tool:effect.tool,status:'uncertain',detail:`${decision.reason}. Nothing was retried.`};
      }
      // stop_partial, fail_closed or ask_user: the effect ends here, the ledger says why, DashClaw hears it.
      updateEffect(run,effect.effectId,{status:'failed',error:{code:error.code || 'UNKNOWN',message:error.message}});
      settleIncident(handle,incident.incidentId,{recoveryStrategy:incident.recoveryStrategy==='none'?decision.action:incident.recoveryStrategy,recoveryResult:decision.action==='fail_closed'?'failed_closed':attempt>1?'retried_failed':'stopped_partial',finalDisposition:'failed'});
      transition(run,'executing',`${label} failed.`);handle.emit();
      await outcomeResult(handle,effect,{status:'failed',error_message:error.message.slice(0,1000)});
      return {tool:effect.tool,status:'failed',code:error.code || 'UNKNOWN',detail:`${label} failed and was not retried further: ${error.message} (${decision.reason}).`};
    }
  }
  return finishVerification(handle,spec,plan,effect,{});
}

async function finishVerification(handle,spec,plan,effect,{alreadyDone=false}){
  const {run,deps,signal}=handle;
  const app=spec.app,label=APP_LABEL[app],verb=effect.opKey.split(':')[0];
  if(run.status!=='verifying') transition(run,'verifying',`Verifying ${label}.`);
  setStep(run,`Verifying ${label}`);handle.emit();
  let verification;
  const readOnce=async()=>{
    const result=await spec.verify({providers:deps.providers,plan,receipt:effect.receipt,run});
    return {at:now(),verified:result.verified===true,detail:result.detail,reads:1,evidence:result.evidence || null};
  };
  try {
    verification=await readOnce();
    deps.breakers?.recordSuccess(app);
    // A definitive read that disagrees with the receipt: the policy allows bounded re-reads, never a second execution.
    if(!verification.verified){
      const policy=policyFor('verification_mismatch').writes;
      const mismatch=noteIncident(handle,{integration:app,tool:effect.tool,operation:effect.opKey,phase:'verify',failureClass:'verification_mismatch',error:{code:'VERIFICATION_MISMATCH',message:verification.detail},effectId:effect.effectId,dashclawActionId:effect.actionId,providerOperationId:effect.receipt?.id || null,knownState:'present',recoveryAttempted:true,recoveryStrategy:'refresh_read',breaker:false});
      for(let i=0;i<(policy.refreshReads || 0) && !verification.verified;i++){
        try{await sleep(policy.refreshGapMs || 1000,signal);}catch{break;}
        verification=await readOnce();verification.reads=i+2;
      }
      settleIncident(handle,mismatch.incidentId,verification.verified?{recoveryResult:'recovered',verificationResult:'verified',finalDisposition:'recovered'}:{recoveryResult:'stopped_partial',verificationResult:'mismatch',finalDisposition:'partial'});
    }
  } catch(error) {
    if(error.name==='AbortError') throw error;
    const incident=noteIncident(handle,{integration:app,tool:effect.tool,operation:effect.opKey,phase:'verify',failureClass:classifyFailure({error,phase:'verify'}),error,effectId:effect.effectId,dashclawActionId:effect.actionId,providerOperationId:effect.receipt?.id || null,knownState:'present',recoveryResult:'none',verificationResult:'unverified',finalDisposition:'partial'});
    verification={at:now(),verified:false,detail:`Verification was unavailable: ${error.message}`,reads:1,evidence:null,incidentId:incident.incidentId};
  }
  updateEffect(run,effect.effectId,{status:verification.verified?'verified':'executed',verification});
  if(verification.verified){
    spec.facts?.({run,plan,receipt:effect.receipt,verification});
    // A runtime refusal of an earlier call to this same tool (wrong arguments, a read not yet done) is answered by this verified
    // write: it stays on the ledger as what happened, but no longer counts as a block the run ends with. DashClaw verdicts are
    // never superseded; only the runtime's own preconditions are.
    for(const prior of run.effects){
      if(prior.effectId!==effect.effectId && prior.tool===effect.tool && prior.status==='blocked' && prior.policy?.matchedPolicies?.includes('sidelook:precondition') && !prior.superseded) updateEffect(run,prior.effectId,{superseded:true});
    }
    // A same-operation attempt the provider proved absent, then replaced by this fresh series: it is not a second
    // unresolved effect the run ends on, just the evidence that earned the new series (docs/AGENT_SELF_HEALING.md §4, §6).
    for(const prior of run.effects){
      if(prior.effectId!==effect.effectId && prior.tool===effect.tool && prior.opKey===effect.opKey && prior.status==='failed' && prior.error?.code==='ABSENT_AFTER_RECONCILE' && !prior.superseded) updateEffect(run,prior.effectId,{superseded:true});
    }
    // Every incident this write left open ends here: recovered when a recovery ran, otherwise closed as information.
    for(const incident of run.incidents.filter(i=>i.effectId===effect.effectId && (i.finalDisposition==='pending' || i.recoveryResult==='pending' || i.verificationResult==='pending'))){
      settleIncident(handle,incident.incidentId,{recoveryResult:incident.recoveryAttempted?'recovered':(incident.recoveryResult==='pending'?'none':incident.recoveryResult),verificationResult:'verified',finalDisposition:incident.recoveryAttempted?'recovered':(incident.finalDisposition==='pending'?'info':incident.finalDisposition)});
    }
  }
  appendEvent(run,{kind:'verify',status:verification.verified?'verified':'unverified',app,label:verification.verified?`${label} ${verb} verified`:`${label} ${verb} not verified`,detail:verification.detail,effectId:effect.effectId,actionId:effect.actionId,evidence:verification.evidence,incidentId:verification.incidentId || null});
  // A second execution of one logical operation is the one thing this engine exists to prevent; if the ledger ever counts it, say so at the top.
  if((effect.executions || 0)>1) noteIncident(handle,{integration:app,tool:effect.tool,operation:effect.opKey,phase:'verify',failureClass:'duplicate_effect_detected',error:{code:'DUPLICATE_EFFECT',message:`${label} performed this operation ${effect.executions} times.`},effectId:effect.effectId,dashclawActionId:effect.actionId,knownState:'present',recoveryResult:'none',finalDisposition:'partial',breaker:false,announce:`Duplicate side effect: ${label} ${verb}`,announceStatus:'failed'});
  const recovered=verification.verified && (effect.attempts>1 || (effect.reconciliations || []).some(r=>!r.sweep && r.finding==='present'));
  if(recovered) appendEvent(run,{kind:'recovery',status:'verified',app,label:'Recovered',detail:`${label} ${verb} verified after ${effect.attempts} attempt${effect.attempts===1?'':'s'}${(effect.reconciliations || []).some(r=>!r.sweep && r.finding==='present')?' and a read that found it already there':''}; nothing was repeated.`,effectId:effect.effectId,actionId:effect.actionId});
  transition(run,'executing',verification.verified?`${label} verified.`:`${label} verification unavailable.`);
  handle.emit();
  await outcomeResult(handle,effect,verification.verified?{status:'completed',summary:verification.detail.slice(0,1000)}:{status:'partial',progress:{state:'executed_unverified',receipt:effect.receipt?.id || null},summary:verification.detail.slice(0,1000)});
  return {tool:effect.tool,status:verification.verified?'verified':'executed',alreadyDone,receipt:effect.receipt,verified:verification.verified,detail:verification.detail};
}
