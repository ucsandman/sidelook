// Prepares the demo records Agent mode's Slack/Stripe/HubSpot reads need, idempotently: safe to run again before every
// demo. Gmail gets a profile read only, never a message. Uses the provider adapters where they have the method and
// plain request() from lib/agent/http.mjs for everything else (customer/payment-intent/contact create, HubSpot property
// options, Slack channel history and chat.postMessage) — never a raw fetch with hand-built auth beyond that helper.
// Contract: docs/AGENT_MODE_IMPLEMENTATION.md sections 6, 7, 15, 17; docs/HACKATHON_SETUP.md section 6.
// node scripts/agent-seed.mjs [--reset]
import {pathToFileURL} from 'node:url';
import {loadConfig} from '../lib/agent/config.mjs';
import {createProviders} from '../lib/agent/providers/index.mjs';
import {request} from '../lib/agent/http.mjs';
import {money} from '../lib/agent/facts.mjs';

const STRIPE_BASE='https://api.stripe.com';
const HUBSPOT_BASE='https://api.hubapi.com';
const SLACK_BASE='https://slack.com/api';
const CHANNEL_ID=/^[CG][A-Z0-9]{6,}$/;
const DEMO_PAYMENT_DESCRIPTION='Sidelook hackathon demo payment';
const DEMO_PAYMENT_CENTS=48500;

const line=(app,note)=>`${app.padEnd(8)} ${note}`;
const stripeAuth=config=>({Authorization:`Bearer ${config.stripe.secretKey}`});
const hubspotAuth=config=>({Authorization:`Bearer ${config.hubspot.token}`});
const slackAuth=config=>({Authorization:`Bearer ${config.slack.token}`});

// A domain reduced to something email-safe: 'acme.com' -> 'acme-com'. The seed email is always demo-<slug>@<domain> so
// it never collides with a real customer's address on the same test account.
function domainSlug(domain){
  const slug=String(domain || '').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
  return slug || 'demo';
}
export const demoEmail=domain=>`demo-${domainSlug(domain)}@${domain}`;

async function slackCall({config,fetchImpl,method,form,label}){
  const res=await request({url:`${SLACK_BASE}/${method}`,method:'POST',headers:slackAuth(config),form,fetchImpl,label:`Slack ${label}`});
  if(!res.json?.ok) throw new Error(`Slack ${label} failed: ${res.json?.error || 'unknown_error'}.`);
  return res.json;
}

// Stripe: find or create the demo customer, then make sure it holds one succeeded, unrefunded $485.00 payment intent
// with the demo description. A fully refunded (or absent) demo payment gets a fresh one; a still-refundable one is left alone.
async function seedStripe({config,providers,fetchImpl,email,log}){
  if(!config.stripe.configured){log(line('stripe','skipped: STRIPE_SECRET_KEY'));return;}
  if(config.stripe.mode==='live'){log(line('stripe','skipped: a live Stripe key is configured; seeding refuses to write to a live account'));return;}
  const matches=await providers.stripe.findCustomer({email});
  // The demo needs exactly one customer for the address, or the agent will (rightly) stop and ask which one. Extra copies of the
  // demo customer, which a search-index lag once produced, are removed here; this only ever runs in test mode.
  for(const extra of matches.slice(1)){
    await request({url:`${STRIPE_BASE}/v1/customers/${encodeURIComponent(extra.id)}`,method:'DELETE',headers:stripeAuth(config),fetchImpl,label:'Stripe duplicate customer delete'});
    log(line('stripe',`removed duplicate demo customer ${extra.id}`));
  }
  let customer=matches[0];
  let customerCreated=false;
  if(!customer){
    const form=new URLSearchParams({email,name:config.demo.customer,description:'Sidelook hackathon demo customer'});
    const res=await request({url:`${STRIPE_BASE}/v1/customers`,method:'POST',headers:stripeAuth(config),form,fetchImpl,label:'Stripe customer create'});
    customer={id:res.json.id,email:res.json.email || email,name:res.json.name || config.demo.customer};
    customerCreated=true;
  }
  log(line('stripe',`customer ${customer.id} (${email}) — ${customerCreated?'created':'already present'}`));
  const payments=await providers.stripe.listRecentPayments({customerId:customer.id});
  const demoPayments=payments.filter(p=>p.description===DEMO_PAYMENT_DESCRIPTION);
  let payment=demoPayments[0];
  let paymentCreated=false;
  if(!payment || !payment.refundable){
    const form=new URLSearchParams({amount:String(DEMO_PAYMENT_CENTS),currency:'usd',customer:customer.id,payment_method:'pm_card_visa',confirm:'true',description:DEMO_PAYMENT_DESCRIPTION});
    form.append('payment_method_types[]','card');
    const res=await request({url:`${STRIPE_BASE}/v1/payment_intents`,method:'POST',headers:stripeAuth(config),form,fetchImpl,label:'Stripe payment intent create'});
    if(res.json.status!=='succeeded') throw new Error(`Stripe payment intent ${res.json.id} did not settle (status ${res.json.status}).`);
    payment={id:res.json.id,amountCents:res.json.amount_received ?? res.json.amount,currency:res.json.currency};
    paymentCreated=true;
  }
  log(line('stripe',`payment ${payment.id} ${money(payment.amountCents,payment.currency)} — ${paymentCreated?'created':'already present'}`));
}

// HubSpot: find or create the demo contact, then make sure the configured status property reads the non-target
// ("OPEN", or the first allowed value that differs from HUBSPOT_STATUS_VALUE) starting state so a demo run has
// something to change. This is also exactly what --reset needs, so it runs the same way every time.
async function seedHubspot({config,providers,fetchImpl,email,log}){
  if(!config.hubspot.configured){log(line('hubspot','skipped: HUBSPOT_ACCESS_TOKEN'));return;}
  let contact=(await providers.hubspot.findContact({email}))[0];
  let created=false;
  if(!contact){
    const res=await request({url:`${HUBSPOT_BASE}/crm/v3/objects/contacts`,method:'POST',headers:hubspotAuth(config),
      body:{properties:{email,firstname:'Dana',lastname:'Acme',company:config.demo.customer}},fetchImpl,label:'HubSpot contact create'});
    contact={id:res.json.id};
    created=true;
  }
  const optionsRes=await request({url:`${HUBSPOT_BASE}/crm/v3/properties/contacts/${encodeURIComponent(config.hubspot.property)}`,method:'GET',headers:hubspotAuth(config),fetchImpl,label:'HubSpot property options'});
  const options=(optionsRes.json?.options || []).map(o=>o.value);
  const target=options.includes('OPEN')?'OPEN':options.find(v=>v!==config.hubspot.value);
  if(!target) throw new Error(`No option on ${config.hubspot.property} differs from ${config.hubspot.value}; there is no starting state to seed.`);
  const current=(await providers.hubspot.getContact({id:contact.id,properties:[config.hubspot.property]})).properties?.[config.hubspot.property] ?? null;
  let value=current;
  if(current!==target){
    const updated=await providers.hubspot.updateContact({id:contact.id,properties:{[config.hubspot.property]:target}});
    value=updated.properties?.[config.hubspot.property] ?? target;
  }
  log(line('hubspot',`contact ${contact.id} (${email}) ${config.hubspot.property}=${value} — ${created?'created':'already present'}`));
}

// Slack: post the cancellation request into SLACK_SEED_CHANNEL unless an identical message is already there within
// the lookback window. Needs a raw channel history/post, since providers.slack only searches the configured
// SLACK_CHANNELS for the agent's own reads, never the seed channel.
async function seedSlack({config,fetchImpl,email,log}){
  if(!config.slack.configured){log(line('slack','skipped: SLACK_BOT_TOKEN'));return;}
  const raw=String(process.env.SLACK_SEED_CHANNEL || '').trim();
  if(!raw){log(line('slack','skipped: SLACK_SEED_CHANNEL'));return;}
  const bare=raw.replace(/^#/,'');
  let channelId=CHANNEL_ID.test(bare)?bare:null;
  if(!channelId){
    const list=await slackCall({config,fetchImpl,method:'conversations.list',form:{types:'public_channel',limit:'200'},label:'channel list'});
    channelId=(list.channels || []).find(ch=>String(ch.name || '').toLowerCase()===bare.toLowerCase())?.id || null;
  }
  if(!channelId) throw new Error(`SLACK_SEED_CHANNEL "${raw}" could not be resolved to a channel id. Check the bot is invited and the name is right.`);
  const text=`Hi, this is Dana at Acme. We have decided to cancel our subscription. Please refund our most recent payment and confirm by email to ${email}.`;
  const oldest=String(Math.floor(Date.now()/1000-config.slack.lookbackDays*86400));
  const history=await slackCall({config,fetchImpl,method:'conversations.history',form:{channel:channelId,oldest,limit:'200'},label:'channel history'});
  let message=(history.messages || []).find(m=>String(m.text || '')===text);
  let created=false;
  if(!message){
    const posted=await slackCall({config,fetchImpl,method:'chat.postMessage',form:{channel:channelId,text},label:'post message'});
    message={ts:posted.ts};
    created=true;
  }
  const permalink=await slackCall({config,fetchImpl,method:'chat.getPermalink',form:{channel:channelId,message_ts:message.ts},label:'permalink'});
  log(line('slack',`request ${permalink.permalink || '(no permalink)'} — ${created?'created':'already present'}`));
}

async function seedGmail({config,providers,log}){
  if(!config.gmail.configured){log(line('gmail','skipped: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_FROM'));return;}
  const {address}=await providers.gmail.health();
  log(line('gmail',`profile sending as ${address}`));
}

// The one entry point tests could drive with fixture config/providers/fetchImpl. --reset only touches Stripe and
// HubSpot (the two states a demo run actually changes); Slack and Gmail need nothing redone between demos.
export async function runSeed({config,providers,fetchImpl=fetch,reset=false,log=console.log}={}){
  const email=demoEmail(config.demo.domain);
  log(reset?`Resetting demo state for ${config.demo.customer} <${email}> (Stripe + HubSpot only).`:`Seeding demo records for ${config.demo.customer} <${email}>.`);
  const steps=reset
    ?[['stripe',()=>seedStripe({config,providers,fetchImpl,email,log})],['hubspot',()=>seedHubspot({config,providers,fetchImpl,email,log})]]
    :[['stripe',()=>seedStripe({config,providers,fetchImpl,email,log})],['hubspot',()=>seedHubspot({config,providers,fetchImpl,email,log})],
      ['slack',()=>seedSlack({config,fetchImpl,email,log})],['gmail',()=>seedGmail({config,providers,log})]];
  const failures=[];
  for(const [app,step] of steps){
    try{await step();}
    catch(error){failures.push(app);log(line(app,`FAILED: ${error.message}`));}
  }
  return {ok:failures.length===0,failures,email};
}

async function main(){
  const reset=process.argv.includes('--reset');
  const config=loadConfig();
  const providers=createProviders({config});
  const {ok}=await runSeed({config,providers,reset});
  process.exitCode=ok?0:1;
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) await main();
