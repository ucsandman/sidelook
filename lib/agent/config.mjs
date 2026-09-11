// Env loading for Agent mode: names in contract section 17, the Stripe live-key classification, and failure injection flags.
// Never logs a value; describeConfig() is the only thing safe to hand the UI.
import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ProviderError} from './http.mjs';

const REPO_ROOT=fileURLToPath(new URL('../../',import.meta.url));

function stripeMode(secretKey){
  if(!secretKey) return 'none';
  if(/^sk_test_|^rk_test_/.test(secretKey)) return 'test';
  if(/^sk_live_|^rk_live_/.test(secretKey)) return 'live';
  return 'none';
}

function splitList(value){
  return String(value || '').split(',').map(v=>v.trim()).filter(Boolean);
}

function defaultDataDir(env){
  if(env.SIDELOOK_AGENT_DATA) return env.SIDELOOK_AGENT_DATA;
  if(process.platform==='win32') return join(env.LOCALAPPDATA || join(homedir(),'AppData','Local'),'Sidelook','agent','runs');
  return join(homedir(),'.sidelook','agent','runs');
}

export function loadConfig({env=process.env,root=REPO_ROOT,loadFile=true}={}){
  if(loadFile){
    // A source checkout reads the repo's .env; the packaged app has an immutable install folder, so it reads the one beside its data
    // (%LOCALAPPDATA%\Sidelook\.env). The first file found wins; variables already in the environment are never overwritten.
    const candidates=[join(root,'.env'),...(process.platform==='win32'?[join(env.LOCALAPPDATA || join(homedir(),'AppData','Local'),'Sidelook','.env')]:[join(homedir(),'.sidelook','.env')])];
    const path=candidates.find(candidate=>existsSync(candidate));
    if(path){
      try{process.loadEnvFile(path);}
      catch(error){throw new ProviderError('CONFIG',`Could not load ${path}.`,{detail:error.message});}
    }
  }
  // A test key wins whenever one is present: a machine that also holds a live key stays in test mode unless the test key is removed on purpose.
  const secretKey=env.STRIPE_TEST_SECRET_KEY || env.STRIPE_SECRET_KEY || '';
  const refundMaxCents=Number(env.AGENT_REFUND_MAX_CENTS);
  const lookbackDays=Number(env.SLACK_LOOKBACK_DAYS);
  const hubspotValue=env.HUBSPOT_STATUS_VALUE || 'UNQUALIFIED';
  const gmailConfigured=!!(env.GMAIL_CLIENT_ID && env.GMAIL_CLIENT_SECRET && env.GMAIL_REFRESH_TOKEN && env.GMAIL_FROM);
  return {
    dashclaw:{
      baseUrl:env.DASHCLAW_BASE_URL || '',apiKey:env.DASHCLAW_API_KEY || '',
      approverApiKey:env.DASHCLAW_APPROVER_API_KEY || env.DASHCLAW_API_KEY || '',
      agentId:env.DASHCLAW_AGENT_ID || 'sidelook-agent',agentName:'Sidelook Agent Mode',
      configured:!!(env.DASHCLAW_BASE_URL && env.DASHCLAW_API_KEY)
    },
    slack:{
      token:env.SLACK_BOT_TOKEN || '',channels:splitList(env.SLACK_CHANNELS),
      lookbackDays:Number.isFinite(lookbackDays) && lookbackDays>0?lookbackDays:30,
      configured:!!env.SLACK_BOT_TOKEN
    },
    stripe:{
      secretKey,mode:stripeMode(secretKey),allowLive:env.STRIPE_ALLOW_LIVE==='1',
      refundMaxCents:Number.isFinite(refundMaxCents) && refundMaxCents>0?refundMaxCents:100000,
      configured:!!secretKey
    },
    hubspot:{
      token:env.HUBSPOT_ACCESS_TOKEN || '',property:env.HUBSPOT_STATUS_PROPERTY || 'hs_lead_status',value:hubspotValue,
      allowedValues:env.HUBSPOT_ALLOWED_VALUES?splitList(env.HUBSPOT_ALLOWED_VALUES):[hubspotValue],
      configured:!!env.HUBSPOT_ACCESS_TOKEN
    },
    gmail:{
      clientId:env.GMAIL_CLIENT_ID || '',clientSecret:env.GMAIL_CLIENT_SECRET || '',refreshToken:env.GMAIL_REFRESH_TOKEN || '',
      from:env.GMAIL_FROM || '',configured:gmailConfigured
    },
    demo:{customer:env.AGENT_DEMO_CUSTOMER || 'Acme',domain:env.AGENT_DEMO_DOMAIN || 'acme.com',email:String(env.AGENT_DEMO_EMAIL || '').trim().toLowerCase(),blockEmail:String(env.AGENT_DEMO_BLOCK_EMAIL || '').trim().toLowerCase()},
    flags:{failHubspotOnce:env.HACKATHON_FAIL_HUBSPOT_ONCE==='1',allowUnverifiedEmail:env.AGENT_ALLOW_UNVERIFIED_EMAIL==='1'},
    dataDir:defaultDataDir(env)
  };
}

// The only view of config the UI may see: booleans and settings that were never secrets, no tokens, no keys, no base URLs.
export function describeConfig(config){
  return {
    dashclaw:{configured:config.dashclaw.configured,agentId:config.dashclaw.agentId},
    slack:{configured:config.slack.configured,channels:config.slack.channels.length,lookbackDays:config.slack.lookbackDays},
    stripe:{configured:config.stripe.configured,mode:config.stripe.mode,allowLive:config.stripe.allowLive,refundMaxCents:config.stripe.refundMaxCents},
    hubspot:{configured:config.hubspot.configured,property:config.hubspot.property,value:config.hubspot.value,allowedValues:config.hubspot.allowedValues},
    gmail:{configured:config.gmail.configured,from:config.gmail.configured?config.gmail.from:''},
    demo:{customer:config.demo.customer,domain:config.demo.domain}
  };
}
