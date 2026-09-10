// Facts are what a provider read proved. Only tools add them (lib/agent/run.mjs addFact); the model only ever repeats them.
// This file turns the ledger into the two things that need it: the prompt's verifiedFacts and DashClaw's source of truth for
// the confirmation email. Contract: docs/AGENT_MODE_IMPLEMENTATION.md section 10.

// DashClaw's non-fabrication extractor only sees money with a literal dollar sign, so every amount is written that way.
export function money(cents,currency='usd'){
  const amount=(Number(cents) || 0)/100;
  const text=amount.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  return String(currency || 'usd').toLowerCase()==='usd'?`$${text}`:`$${text} ${String(currency).toUpperCase()}`;
}
// Stripe hands out unix seconds; HubSpot and Gmail hand out ISO strings. One date shape leaves this file: YYYY-MM-DD.
export function isoDate(value){
  const date=typeof value==='number'?new Date(value*1000):new Date(value);
  return Number.isNaN(date.getTime())?'':date.toISOString().slice(0,10);
}

const ID_PATTERNS=[
  {pattern:'re_[A-Za-z0-9]+',label:'refund_id'},{pattern:'pi_[A-Za-z0-9]+',label:'payment_id'},
  {pattern:'cus_[A-Za-z0-9]+',label:'customer_id'},{pattern:'ch_[A-Za-z0-9]+',label:'charge_id'}
];
// Promises about timing and guarantees never come from a fact, so they may not appear in the email at all.
export const FORBIDDEN_PATTERNS=['within \\d+ (business |working )?days','guarantee','immediately'];

export const verifiedFacts=run=>run.sourceFacts.map(f=>({label:f.label,value:f.value,source:f.source}));

// The corpus the email must trace to. Required facts are the ones a refund confirmation cannot leave out once they exist.
export function sourceOfTruth(run){
  const facts=run.sourceFacts.filter(f=>f.value);
  const allowedFacts=facts.map(f=>({label:f.key,value:f.value}));
  for(const [label,value] of [['customer_email',run.entities.stripeCustomer?.email],['customer_email',run.entities.hubspotContact?.email],['stripe_customer_id',run.entities.stripeCustomer?.id]]){
    if(value && !allowedFacts.some(f=>f.value===value)) allowedFacts.push({label,value:String(value)});
  }
  const required=[];
  for(const key of ['customer_name','refund_amount','refund_id']){
    const fact=facts.find(f=>f.key===key);
    if(fact) required.push({label:key,value:fact.value});
  }
  return {allowedFacts,requiredFacts:required,extract:{money:true,dates:true,percentages:false,patterns:ID_PATTERNS},forbiddenPatterns:FORBIDDEN_PATTERNS};
}
