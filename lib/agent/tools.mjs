// The finite tool registry: what the model may call, what arguments are legal, and the read-only implementations.
// Writes (stripe.refund_payment, hubspot.update_customer, gmail.send_message) have validation and an opKey here and
// no handler; only lib/agent/effects.mjs may perform a write. Contract: docs/AGENT_MODE_IMPLEMENTATION.md section 6.
import {newId,addFact,appendEvent} from './run.mjs';
import {emailReference} from './facts.mjs';

const EMAIL_PATTERN=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_PATTERN=/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
const CHANNEL_PATTERN=/^[A-Za-z0-9_#-]{1,80}$/;
const TS_PATTERN=/^\d{9,10}\.\d{3,6}$/;
const CUSTOMER_ID_PATTERN=/^cus_[A-Za-z0-9]+$/;
const PAYMENT_ID_PATTERN=/^pi_[A-Za-z0-9]+$/;
const REFUND_ID_PATTERN=/^re_[A-Za-z0-9]+$/;
const CONTACT_ID_PATTERN=/^[A-Za-z0-9_-]{1,64}$/;
// A message id the model can search or send must be one Sidelook minted itself; an id it invented never matches.
const MESSAGE_ID_PATTERN=/^<sidelook-run_[a-f0-9]{20}-\d+@sidelook\.local>$/;
const AMOUNT_MAX_CENTS=100_000_000;

const noExtra=()=>[];
const oneOf=fields=>args=>fields.some(f=>args[f])?[]:[`Provide at least one of ${fields.join(', ')}.`];

function checkField(name,spec,value){
  if(spec.type==='integer'){
    const num=typeof value==='number'?value:Number(value);
    if(value===undefined || value===null || value==='') return spec.required?{errors:[`${name} is required.`],value:0}:{errors:[],value:0};
    if(!Number.isInteger(num)) return {errors:[`${name} must be a whole number.`],value:0};
    const errors=[];
    if(num<0) errors.push(`${name} must not be negative.`);
    if(spec.required && num<=0) errors.push(`${name} is required.`);
    if(spec.max!==undefined && num>spec.max) errors.push(`${name} is larger than allowed.`);
    return {errors,value:num};
  }
  const text=typeof value==='string'?value.trim():'';
  if(!text) return spec.required?{errors:[`${name} is required.`],value:''}:{errors:[],value:''};
  const errors=[];
  if(spec.max!==undefined && text.length>spec.max) errors.push(`${name} is longer than ${spec.max} characters.`);
  if(spec.pattern && !spec.pattern.test(text)) errors.push(`${name} is not a valid ${name}.`);
  return {errors,value:text};
}

const clip=(value,max)=>{const text=String(value ?? '');return text.length>max?text.slice(0,max):text;};
const money=cents=>`$${(Math.round(Number(cents) || 0)/100).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const dateOnly=created=>{const d=created instanceof Date?created:new Date(created);return Number.isNaN(d.getTime())?'':d.toISOString().slice(0,10);};
const at=now=>typeof now==='function'?new Date(now()).toISOString():undefined;

export const TOOLS={
  'slack.find_customer_request':{
    name:'slack.find_customer_request',app:'slack',
    description:'Search the configured Slack channels for the newest message naming this customer.',
    readOnly:true,sideEffect:false,risk:'none',requiresVerification:false,
    args:{customer:{type:'string',required:true,max:200}},
    opKey:args=>`find_customer_request:${args.customer}`,validate:noExtra
  },
  'slack.get_message_context':{
    name:'slack.get_message_context',app:'slack',
    description:'Read the bounded thread replies under one Slack message.',
    readOnly:true,sideEffect:false,risk:'none',requiresVerification:false,
    args:{channel:{type:'string',required:true,max:80,pattern:CHANNEL_PATTERN},messageTs:{type:'string',required:true,max:32,pattern:TS_PATTERN}},
    opKey:args=>`get_message_context:${args.channel}:${args.messageTs}`,validate:noExtra
  },
  'stripe.find_customer':{
    name:'stripe.find_customer',app:'stripe',
    description:'Search Stripe customers by email, domain or free text query.',
    readOnly:true,sideEffect:false,risk:'none',requiresVerification:false,
    args:{email:{type:'string',required:false,max:320,pattern:EMAIL_PATTERN},domain:{type:'string',required:false,max:200,pattern:DOMAIN_PATTERN},query:{type:'string',required:false,max:200}},
    opKey:args=>`find_customer:${args.email || args.domain || args.query || ''}`,validate:oneOf(['email','domain','query'])
  },
  'stripe.get_recent_payments':{
    name:'stripe.get_recent_payments',app:'stripe',
    description:'List a Stripe customer\'s recent succeeded payments, newest first, with refund eligibility.',
    readOnly:true,sideEffect:false,risk:'none',requiresVerification:false,
    args:{customerId:{type:'string',required:true,max:80,pattern:CUSTOMER_ID_PATTERN}},
    opKey:args=>`get_recent_payments:${args.customerId}`,validate:noExtra
  },
  'stripe.get_payment':{
    name:'stripe.get_payment',app:'stripe',
    description:'Read one Stripe payment intent and its latest charge.',
    readOnly:true,sideEffect:false,risk:'none',requiresVerification:false,
    args:{paymentId:{type:'string',required:true,max:80,pattern:PAYMENT_ID_PATTERN}},
    opKey:args=>`get_payment:${args.paymentId}`,validate:noExtra
  },
  'stripe.refund_payment':{
    name:'stripe.refund_payment',app:'stripe',
    description:'Refund a Stripe payment, in full or for a given amount. Consequential: governed and held for policy.',
    readOnly:false,sideEffect:true,risk:'financial',requiresVerification:true,
    args:{paymentId:{type:'string',required:true,max:80,pattern:PAYMENT_ID_PATTERN},amountCents:{type:'integer',required:false,max:AMOUNT_MAX_CENTS}},
    opKey:args=>`refund:${args.paymentId}`,validate:noExtra
  },
  'stripe.get_refund':{
    name:'stripe.get_refund',app:'stripe',
    description:'Read one Stripe refund by id.',
    readOnly:true,sideEffect:false,risk:'none',requiresVerification:false,
    args:{refundId:{type:'string',required:true,max:80,pattern:REFUND_ID_PATTERN}},
    opKey:args=>`get_refund:${args.refundId}`,validate:noExtra
  },
  'hubspot.find_customer':{
    name:'hubspot.find_customer',app:'hubspot',
    description:'Search HubSpot contacts by email, domain or free text query.',
    readOnly:true,sideEffect:false,risk:'none',requiresVerification:false,
    args:{email:{type:'string',required:false,max:320,pattern:EMAIL_PATTERN},domain:{type:'string',required:false,max:200,pattern:DOMAIN_PATTERN},query:{type:'string',required:false,max:200}},
    opKey:args=>`find_customer:${args.email || args.domain || args.query || ''}`,validate:oneOf(['email','domain','query'])
  },
  'hubspot.get_customer':{
    name:'hubspot.get_customer',app:'hubspot',
    description:'Read a HubSpot contact\'s configured status property.',
    readOnly:true,sideEffect:false,risk:'none',requiresVerification:false,
    args:{contactId:{type:'string',required:true,max:64,pattern:CONTACT_ID_PATTERN}},
    opKey:args=>`get_customer:${args.contactId}`,validate:noExtra
  },
  'hubspot.update_customer':{
    name:'hubspot.update_customer',app:'hubspot',
    description:'Set a HubSpot contact\'s status property to the configured value. Consequential: governed.',
    readOnly:false,sideEffect:true,risk:'low',requiresVerification:true,
    args:{contactId:{type:'string',required:true,max:64,pattern:CONTACT_ID_PATTERN},property:{type:'string',required:false,max:100},value:{type:'string',required:false,max:200}},
    opKey:args=>`update:${args.contactId}:${args.property || ''}`,validate:noExtra
  },
  'hubspot.verify_customer_state':{
    name:'hubspot.verify_customer_state',app:'hubspot',
    description:'Read a HubSpot contact\'s configured status property back, for the model to confirm.',
    readOnly:true,sideEffect:false,risk:'none',requiresVerification:false,
    args:{contactId:{type:'string',required:true,max:64,pattern:CONTACT_ID_PATTERN}},
    opKey:args=>`verify_customer_state:${args.contactId}`,validate:noExtra
  },
  'gmail.prepare_message':{
    name:'gmail.prepare_message',app:'gmail',
    description:'Compose a reply for review: assigns a Message-ID, checks the content against verified facts, and previews it. No effect.',
    readOnly:true,sideEffect:false,risk:'none',requiresVerification:false,
    args:{to:{type:'string',required:true,max:320,pattern:EMAIL_PATTERN},subject:{type:'string',required:true,max:200},body:{type:'string',required:true,max:5000}},
    opKey:args=>`prepare_message:${args.to}`,validate:noExtra
  },
  'gmail.send_message':{
    name:'gmail.send_message',app:'gmail',
    description:'Send exactly the message already prepared under this Message-ID. Consequential: governed.',
    readOnly:false,sideEffect:true,risk:'external',requiresVerification:true,
    args:{messageId:{type:'string',required:true,max:120,pattern:MESSAGE_ID_PATTERN}},
    opKey:args=>`send:${args.messageId}`,validate:noExtra
  },
  'gmail.find_sent_message':{
    name:'gmail.find_sent_message',app:'gmail',
    description:'Search Gmail for a message already sent under this Message-ID.',
    readOnly:true,sideEffect:false,risk:'none',requiresVerification:false,
    args:{messageId:{type:'string',required:true,max:120,pattern:MESSAGE_ID_PATTERN}},
    opKey:args=>`find_sent_message:${args.messageId}`,validate:noExtra
  }
};

export const WRITE_TOOLS=Object.values(TOOLS).filter(t=>t.sideEffect).map(t=>t.name);

export function listTools(){
  return Object.values(TOOLS).map(t=>({name:t.name,app:t.app,description:t.description,readOnly:t.readOnly,sideEffect:t.sideEffect,risk:t.risk,requiresVerification:t.requiresVerification,args:Object.keys(t.args)}));
}

// The single place plan arguments become validated, normalised tool arguments: only registry-declared fields survive.
export function validateCall(name,args,run){
  const tool=TOOLS[name];
  if(!tool) return {ok:false,errors:[`Unknown tool ${name}.`],args:{}};
  const normalized={},errors=[];
  for(const [field,spec] of Object.entries(tool.args)){
    const {errors:fieldErrors,value}=checkField(field,spec,args?.[field]);
    errors.push(...fieldErrors);
    if(spec.type==='integer'){if(value!==0) normalized[field]=value;}
    else if(value) normalized[field]=value;
  }
  errors.push(...(tool.validate(normalized,run) || []));
  return {ok:errors.length===0,errors,args:normalized};
}

// A DashClaw scan failure is never recorded as clean: an instrument that could not look stays "unknown", not "safe".
async function scanText(governed,text,source){
  if(!governed || typeof governed.scan!=='function') return {riskLevel:'unknown',categories:[]};
  try{
    const result=await governed.scan(text,source);
    if(!result || result.unavailable || result.clean===null) return {riskLevel:'unknown',categories:result?.categories || []};
    return {riskLevel:result.riskLevel || 'unknown',categories:result.categories || []};
  } catch{
    return {riskLevel:'unknown',categories:[]};
  }
}

// facts.mjs (Track D) owns the real non-fabrication source-of-truth builder; until it lands (or in a test that omits
// it) this tool still works from the run's own verified facts.
async function sourceOfTruth(run){
  try{
    const mod=await import('./facts.mjs');
    if(typeof mod.sourceOfTruth==='function') return mod.sourceOfTruth(run);
  } catch(error){
    if(error.code!=='ERR_MODULE_NOT_FOUND') throw error;
  }
  return {allowedFacts:(run.sourceFacts || []).map(f=>({label:f.label,value:f.value})),requiredFacts:[],extract:{money:true,dates:true,percentages:false,patterns:[]}};
}

export const READ_HANDLERS={
  async 'slack.find_customer_request'({args,run,providers,governed,now}){
    let messages;
    try{messages=(await providers.slack.findCustomerRequest({customer:args.customer,domain:undefined,channels:undefined,lookbackDays:undefined}))?.messages;}
    catch(error){appendFailed(run,'slack','slack.find_customer_request',error,at(now));return failedObservation(error);}
    messages=messages || [];
    for(const m of messages){
      const scan=await scanText(governed,m.text,'slack');
      run.injection.push({source:'slack',ref:m.permalink || '',riskLevel:scan.riskLevel,categories:scan.categories});
    }
    const newest=messages[0] || null;
    if(newest){
      const looksLikeDomain=/\./.test(args.customer) && !/[\s@]/.test(args.customer);
      run.entities.customer={name:looksLikeDomain?'':args.customer,email:'',domain:looksLikeDomain?args.customer:'',source:'slack'};
      addFact(run,{key:'request',value:clip(newest.text,500),label:'Customer request',source:'slack',ref:newest.permalink},at(now));
      if(run.entities.customer.name) addFact(run,{key:'customer_name',value:run.entities.customer.name,label:'Customer name',source:'slack',ref:newest.permalink},at(now));
      if(run.entities.customer.domain) addFact(run,{key:'customer_domain',value:run.entities.customer.domain,label:'Customer domain',source:'slack',ref:newest.permalink},at(now));
    }
    appendOk(run,'slack','slack.find_customer_request',{found:messages.length},at(now));
    return {ok:true,found:messages.length,
      request:newest?{untrusted:true,source:'slack',text:clip(newest.text,1500)}:null,
      author:newest?.author || '',ts:newest?.ts || '',channel:newest?.channel || '',permalink:newest?.permalink || ''};
  },
  async 'slack.get_message_context'({args,run,providers,governed,now}){
    let replies;
    try{replies=(await providers.slack.getMessageContext({channel:args.channel,ts:args.messageTs}))?.replies;}
    catch(error){appendFailed(run,'slack','slack.get_message_context',error,at(now));return failedObservation(error);}
    replies=(replies || []).slice(0,20);
    for(const r of replies){
      const scan=await scanText(governed,r.text,'slack');
      run.injection.push({source:'slack',ref:r.permalink || `${args.channel}:${r.ts || ''}`,riskLevel:scan.riskLevel,categories:scan.categories});
    }
    appendOk(run,'slack','slack.get_message_context',{count:replies.length},at(now));
    return {ok:true,count:replies.length,replies:replies.map(r=>({untrusted:true,source:'slack',author:r.author || '',ts:r.ts || '',text:clip(r.text,1500)}))};
  },
  async 'stripe.find_customer'({args,run,providers,now}){
    let matches;
    try{matches=await providers.stripe.findCustomer({email:args.email,domain:args.domain,query:args.query});}
    catch(error){appendFailed(run,'stripe','stripe.find_customer',error,at(now));return failedObservation(error);}
    matches=matches || [];
    if(matches.length===1){
      run.entities.stripeCustomer={id:matches[0].id,email:matches[0].email,name:matches[0].name};
      delete run.entities.stripeCandidates;
      addFact(run,{key:'customer_email',value:matches[0].email || '',label:'Stripe customer email',source:'stripe',ref:matches[0].id},at(now));
    } else if(matches.length>1){
      run.entities.stripeCandidates=matches.map(m=>({id:m.id,email:m.email,name:m.name}));
    }
    appendOk(run,'stripe','stripe.find_customer',{count:matches.length},at(now));
    return {ok:true,count:matches.length,ambiguous:matches.length>1,customers:matches.map(m=>({id:m.id,email:m.email,name:m.name}))};
  },
  async 'stripe.get_recent_payments'({args,run,providers,now}){
    // Only the resolved customer's payments can become the refund target; a customer id from anywhere else is refused here.
    const resolved=run.entities?.stripeCustomer?.id;
    if(!resolved || args.customerId!==resolved){
      const error=Object.assign(new Error(resolved?`Only the resolved customer ${resolved} can be listed.`:'Resolve the Stripe customer first.'),{code:'CUSTOMER_NOT_RESOLVED'});
      appendFailed(run,'stripe','stripe.get_recent_payments',error,at(now));return failedObservation(error);
    }
    let payments;
    try{payments=await providers.stripe.listRecentPayments({customerId:args.customerId});}
    catch(error){appendFailed(run,'stripe','stripe.get_recent_payments',error,at(now));return failedObservation(error);}
    payments=(payments || []).slice(0,10);
    const withRefundable=payments.map(p=>({id:p.id,customerId:p.customerId || args.customerId,chargeId:p.chargeId,amountCents:p.amountCents,amountRefundedCents:p.amountRefundedCents ?? 0,currency:p.currency,created:p.created,description:p.description,
      refundable:(typeof p.refundable==='boolean')?p.refundable:((p.amountReceivedCents ?? p.amountCents ?? 0)-(p.amountRefundedCents ?? 0))>0}));
    const sorted=[...withRefundable].sort((a,b)=>new Date(b.created)-new Date(a.created));
    const chosen=sorted.find(p=>p.refundable) || null;
    if(chosen){
      run.entities.payment=chosen;
      addFact(run,{key:'payment_id',value:chosen.id,label:'Payment id',source:'stripe',ref:chosen.id},at(now));
      addFact(run,{key:'payment_date',value:dateOnly(chosen.created),label:'Payment date',source:'stripe',ref:chosen.id},at(now));
      addFact(run,{key:'payment_amount',value:money(chosen.amountCents),label:'Payment amount',source:'stripe',ref:chosen.id},at(now));
    }
    appendOk(run,'stripe','stripe.get_recent_payments',{count:withRefundable.length},at(now));
    return {ok:true,count:withRefundable.length,payments:withRefundable,chosen:chosen?.id || null};
  },
  async 'stripe.get_payment'({args,run,providers,now}){
    let payment;
    try{payment=await providers.stripe.getPayment({id:args.paymentId});}
    catch(error){appendFailed(run,'stripe','stripe.get_payment',error,at(now));return failedObservation(error);}
    appendOk(run,'stripe','stripe.get_payment',{id:args.paymentId},at(now));
    return {ok:true,payment};
  },
  async 'stripe.get_refund'({args,run,providers,now}){
    let refund;
    try{refund=await providers.stripe.getRefund({id:args.refundId});}
    catch(error){appendFailed(run,'stripe','stripe.get_refund',error,at(now));return failedObservation(error);}
    appendOk(run,'stripe','stripe.get_refund',{id:args.refundId},at(now));
    return {ok:true,refund};
  },
  async 'hubspot.find_customer'({args,run,providers,now}){
    let matches;
    try{matches=await providers.hubspot.findContact({email:args.email,domain:args.domain,query:args.query});}
    catch(error){appendFailed(run,'hubspot','hubspot.find_customer',error,at(now));return failedObservation(error);}
    matches=matches || [];
    if(matches.length===1) run.entities.hubspotContact={id:matches[0].id,email:matches[0].email,properties:matches[0].properties || {}};
    appendOk(run,'hubspot','hubspot.find_customer',{count:matches.length},at(now));
    return {ok:true,count:matches.length,ambiguous:matches.length>1,contacts:matches.map(m=>({id:m.id,email:m.email}))};
  },
  async 'hubspot.get_customer'({args,run,providers,config,now}){
    const property=config?.hubspot?.property || 'hs_lead_status';
    let contact;
    try{contact=await providers.hubspot.getContact({id:args.contactId,properties:[property]});}
    catch(error){appendFailed(run,'hubspot','hubspot.get_customer',error,at(now));return failedObservation(error);}
    appendOk(run,'hubspot','hubspot.get_customer',{id:args.contactId,property},at(now));
    return {ok:true,contactId:args.contactId,property,value:contact?.properties?.[property] ?? null};
  },
  async 'hubspot.verify_customer_state'({args,run,providers,config,now}){
    const property=config?.hubspot?.property || 'hs_lead_status';
    let contact;
    try{contact=await providers.hubspot.getContact({id:args.contactId,properties:[property]});}
    catch(error){appendFailed(run,'hubspot','hubspot.verify_customer_state',error,at(now));return failedObservation(error);}
    appendOk(run,'hubspot','hubspot.verify_customer_state',{id:args.contactId,property},at(now));
    return {ok:true,contactId:args.contactId,property,value:contact?.properties?.[property] ?? null};
  },
  async 'gmail.prepare_message'({args,run,governed,config,now}){
    const n=run.events.filter(e=>e.kind==='tool' && e.label==='gmail.prepare_message').length+1;
    const messageId=`<sidelook-${run.runId}-${n}@sidelook.local>`;
    // The reference line is part of the message from here on: DashClaw checks it, the approver sees it, Gmail sends it, and
    // a reconciliation read finds the message by it when Gmail's own id was never received.
    const reference=emailReference(messageId);
    const body=`${String(args.body).replace(/\s+$/,'')}\n\nReference: ${reference}`;
    const stripeEmail=(run.entities?.stripeCustomer?.email || '').toLowerCase();
    const hubspotEmail=(run.entities?.hubspotContact?.email || '').toLowerCase();
    const to=args.to.toLowerCase();
    // High confidence means the address is the matched customer's own (Stripe) or a contact at the customer's domain; an address that
    // only ever appeared in retrieved text is low, so the send is declared at the risk that holds it for a person.
    const customerDomain=String(run.entities?.customer?.domain || stripeEmail.split('@')[1] || '').toLowerCase();
    const boundHubspot=!!hubspotEmail && (hubspotEmail===stripeEmail || (!!customerDomain && hubspotEmail.endsWith('@'+customerDomain)));
    const recipientConfidence=((!!stripeEmail && to===stripeEmail) || (boundHubspot && to===hubspotEmail))?'high':'low';
    let verified=null,violations=[];
    if(governed && typeof governed.check==='function'){
      const truth=await sourceOfTruth(run);
      const declaredGoal=clip(`Prepare an email to ${args.to} for: ${run.goal}`,300);
      try{
        // governed.mjs's own ctx convention is camelCase; it translates to DashClaw's snake_case wire fields itself.
        // The check carries the same act the send will, so an evidence-first policy grades it the same way; nothing is recorded.
        const act=governed.actForHttp?governed.actForHttp({method:'POST',url:'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',body:`To: ${args.to}\nSubject: ${args.subject}\nMessage-ID: ${messageId}\n\n${body}`}):undefined;
        const result=await governed.check({actionType:'email',declaredGoal,riskScore:30,content:body,sourceOfTruth:truth,...(act?{act}:{})});
        // DashClaw answers with a non_fabrication array of {verdict, violations, receipt}; verified means the verdict is a pass and nothing else blocked.
        const checks=Array.isArray(result?.nonFabrication)?result.nonFabrication:[];
        verified=['allow','warn','require_approval'].includes(result?.decision) && checks.length>0 && checks.every(c=>c.verdict==='pass');
        violations=checks.flatMap(c=>c.violations || []);
        if(!checks.length && result?.decision!=='block') violations=[{code:'no_policy',label:'no non-fabrication policy ran'}];
      } catch(error){
        appendFailed(run,'gmail','gmail.prepare_message',error,at(now));
        return failedObservation(error);
      }
    }
    const preparedId=newId('prep');
    run.entities.email={preparedId,messageId,reference,to:args.to,subject:args.subject,body,verified,violations,recipientConfidence};
    appendOk(run,'gmail','gmail.prepare_message',{to:args.to,recipientConfidence,verified},at(now));
    return {ok:true,preparedId,messageId,reference,recipientConfidence,verified,violations,preview:{to:args.to,subject:args.subject,body}};
  },
  async 'gmail.find_sent_message'({args,run,providers,now}){
    let result;
    try{result=await providers.gmail.findByMessageId({messageId:args.messageId,reference:emailReference(args.messageId)});}
    catch(error){appendFailed(run,'gmail','gmail.find_sent_message',error,at(now));return failedObservation(error);}
    // The provider always answers with an object; its own `found` flag is the truth, not merely whether a value came back.
    const found=typeof result?.found==='boolean'?result.found:!!result;
    appendOk(run,'gmail','gmail.find_sent_message',{messageId:args.messageId,found},at(now));
    return {ok:true,found,message:result || null};
  }
};

function appendOk(run,app,label,evidence,when){
  appendEvent(run,{kind:'tool',status:'ok',label,app,evidence},when);
}
function appendFailed(run,app,label,error,when){
  appendEvent(run,{kind:'tool',status:'failed',label,app,detail:String(error?.message || error),evidence:{code:error?.code || 'ERROR'}},when);
}
function failedObservation(error){
  return {ok:false,error:{code:error?.code || 'ERROR',message:String(error?.message || error)}};
}
