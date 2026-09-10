// Assembles every provider adapter. An unconfigured app is a plain object whose every method throws ProviderError CONFIG
// naming the missing env var, so callers never branch on undefined. Contract: section 7.
import {ProviderError} from '../http.mjs';
import {createSlack} from './slack.mjs';
import {createStripe} from './stripe.mjs';
import {createHubspot} from './hubspot.mjs';
import {createGmail} from './gmail.mjs';

function unconfigured(app,envNames,methods){
  const fail=async()=>{throw new ProviderError('CONFIG',`${app} is not configured. Set ${envNames}.`,{detail:envNames});};
  return Object.fromEntries(methods.map(name=>[name,fail]));
}

export function createProviders({config,fetchImpl=fetch}={}){
  return {
    slack:config?.slack?.configured
      ?createSlack({config,fetchImpl})
      :unconfigured('Slack','SLACK_BOT_TOKEN',['health','findCustomerRequest','getMessageContext']),
    stripe:config?.stripe?.configured
      ?createStripe({config,fetchImpl})
      :unconfigured('Stripe','STRIPE_SECRET_KEY',['health','findCustomer','listRecentPayments','getPayment','createRefund','getRefund','findRefunds']),
    hubspot:config?.hubspot?.configured
      ?createHubspot({config,fetchImpl})
      :unconfigured('HubSpot','HUBSPOT_ACCESS_TOKEN',['health','findContact','getContact','updateContact']),
    gmail:config?.gmail?.configured
      ?createGmail({config,fetchImpl})
      :unconfigured('Gmail','GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN and GMAIL_FROM',['health','accessToken','composeRaw','send','findByMessageId'])
  };
}
