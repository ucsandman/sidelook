import test from 'node:test';
import assert from 'node:assert/strict';
import {loadConfig,describeConfig} from '../lib/agent/config.mjs';
import {blockEmail,demoEmail} from '../scripts/agent-seed.mjs';

test('defaults: nothing configured, sensible fallback values, no file load attempted',()=>{
  const config=loadConfig({env:{},loadFile:false});
  assert.equal(config.dashclaw.agentId,'sidelook-agent');
  assert.equal(config.dashclaw.agentName,'Sidelook Agent Mode');
  assert.equal(config.dashclaw.configured,false);
  assert.deepEqual(config.slack.channels,[]);
  assert.equal(config.slack.lookbackDays,30);
  assert.equal(config.slack.configured,false);
  assert.equal(config.stripe.mode,'none');
  assert.equal(config.stripe.allowLive,false);
  assert.equal(config.stripe.refundMaxCents,100000);
  assert.equal(config.stripe.configured,false);
  assert.equal(config.hubspot.property,'hs_lead_status');
  assert.equal(config.hubspot.value,'UNQUALIFIED');
  assert.deepEqual(config.hubspot.allowedValues,['UNQUALIFIED']);
  assert.equal(config.hubspot.configured,false);
  assert.equal(config.gmail.configured,false);
  assert.equal(config.demo.customer,'Acme');
  assert.equal(config.demo.domain,'acme.com');
  assert.equal(config.flags.failHubspotOnce,false);
  assert.equal(config.flags.allowUnverifiedEmail,false);
  assert.ok(config.dataDir.length>0);
});

test('every configured value reads through, including the approver key default',()=>{
  const env={
    DASHCLAW_BASE_URL:'https://dashclaw.example',DASHCLAW_API_KEY:'oc_live_fakekey123456',DASHCLAW_AGENT_ID:'demo-agent',
    SLACK_BOT_TOKEN:'xoxb-fake-slack-token',SLACK_CHANNELS:'general, #sales , C0123456',SLACK_LOOKBACK_DAYS:'14',
    STRIPE_SECRET_KEY:'sk_test_fake',AGENT_REFUND_MAX_CENTS:'50000',
    HUBSPOT_ACCESS_TOKEN:'pat-fake-hubspot',HUBSPOT_STATUS_PROPERTY:'lifecycle',HUBSPOT_STATUS_VALUE:'LOST',HUBSPOT_ALLOWED_VALUES:'LOST,CHURNED',
    GMAIL_CLIENT_ID:'client-id',GMAIL_CLIENT_SECRET:'client-secret',GMAIL_REFRESH_TOKEN:'refresh-token',GMAIL_FROM:'agent@example.com',
    AGENT_DEMO_CUSTOMER:'Widgetco',AGENT_DEMO_DOMAIN:'widgetco.com',
    HACKATHON_FAIL_HUBSPOT_ONCE:'1',AGENT_ALLOW_UNVERIFIED_EMAIL:'1',
    SIDELOOK_AGENT_DATA:'C:/tmp/sidelook-agent-data'
  };
  const config=loadConfig({env,loadFile:false});
  assert.equal(config.dashclaw.baseUrl,'https://dashclaw.example');
  assert.equal(config.dashclaw.apiKey,'oc_live_fakekey123456');
  assert.equal(config.dashclaw.approverApiKey,'oc_live_fakekey123456','defaults to the agent key when no approver key is set');
  assert.equal(config.dashclaw.agentId,'demo-agent');
  assert.equal(config.dashclaw.configured,true);
  assert.deepEqual(config.slack.channels,['general','#sales','C0123456']);
  assert.equal(config.slack.lookbackDays,14);
  assert.equal(config.slack.configured,true);
  assert.equal(config.stripe.refundMaxCents,50000);
  assert.equal(config.hubspot.property,'lifecycle');
  assert.equal(config.hubspot.value,'LOST');
  assert.deepEqual(config.hubspot.allowedValues,['LOST','CHURNED']);
  assert.equal(config.gmail.configured,true);
  assert.equal(config.gmail.from,'agent@example.com');
  assert.equal(config.demo.customer,'Widgetco');
  assert.equal(config.demo.domain,'widgetco.com');
  assert.equal(config.flags.failHubspotOnce,true);
  assert.equal(config.flags.allowUnverifiedEmail,true);
  assert.equal(config.dataDir,'C:/tmp/sidelook-agent-data');
});

test('an explicit DASHCLAW_APPROVER_API_KEY overrides the agent-key default',()=>{
  const config=loadConfig({env:{DASHCLAW_API_KEY:'agent-key',DASHCLAW_APPROVER_API_KEY:'approver-key'},loadFile:false});
  assert.equal(config.dashclaw.apiKey,'agent-key');
  assert.equal(config.dashclaw.approverApiKey,'approver-key');
});

test('Stripe mode classification: prefix decides test/live/none, independent of configured',()=>{
  assert.equal(loadConfig({env:{},loadFile:false}).stripe.mode,'none');
  assert.equal(loadConfig({env:{STRIPE_SECRET_KEY:'sk_test_fake'},loadFile:false}).stripe.mode,'test');
  assert.equal(loadConfig({env:{STRIPE_SECRET_KEY:'rk_test_fake'},loadFile:false}).stripe.mode,'test');
  assert.equal(loadConfig({env:{STRIPE_SECRET_KEY:'sk_live_fake'},loadFile:false}).stripe.mode,'live');
  assert.equal(loadConfig({env:{STRIPE_SECRET_KEY:'rk_live_fake'},loadFile:false}).stripe.mode,'live');
  const oddPrefix=loadConfig({env:{STRIPE_SECRET_KEY:'not_a_real_prefix'},loadFile:false});
  assert.equal(oddPrefix.stripe.mode,'none','an unrecognized prefix is treated as none, not trusted as live or test');
  assert.equal(oddPrefix.stripe.configured,true,'a key is present, so the app is still configured even though its mode is unknown');
  const live=loadConfig({env:{STRIPE_SECRET_KEY:'sk_live_fake',STRIPE_ALLOW_LIVE:'1'},loadFile:false});
  assert.equal(live.stripe.allowLive,true);
  assert.equal(loadConfig({env:{STRIPE_SECRET_KEY:'sk_live_fake',STRIPE_ALLOW_LIVE:'yes'},loadFile:false}).stripe.allowLive,false,'only the literal 1 turns the guard off');
});

test('SLACK_LOOKBACK_DAYS and AGENT_REFUND_MAX_CENTS fall back to their defaults on garbage input',()=>{
  const config=loadConfig({env:{SLACK_LOOKBACK_DAYS:'not-a-number',AGENT_REFUND_MAX_CENTS:'-5'},loadFile:false});
  assert.equal(config.slack.lookbackDays,30);
  assert.equal(config.stripe.refundMaxCents,100000);
});

test('describeConfig() carries only booleans and non-secret settings, never a token or the dashclaw key',()=>{
  const config=loadConfig({env:{
    DASHCLAW_BASE_URL:'https://dashclaw.example',DASHCLAW_API_KEY:'oc_live_fakekey123456',
    SLACK_BOT_TOKEN:'xoxb-fake',SLACK_CHANNELS:'general,sales',
    STRIPE_SECRET_KEY:'sk_test_fake',HUBSPOT_ACCESS_TOKEN:'pat-fake',
    GMAIL_CLIENT_ID:'id',GMAIL_CLIENT_SECRET:'secret',GMAIL_REFRESH_TOKEN:'refresh',GMAIL_FROM:'agent@example.com'
  },loadFile:false});
  const described=describeConfig(config);
  const text=JSON.stringify(described);
  assert.ok(!text.includes('oc_live_fakekey123456'));
  assert.ok(!text.includes('xoxb-fake'));
  assert.ok(!text.includes('sk_test_fake'));
  assert.ok(!text.includes('pat-fake'));
  assert.ok(!text.includes('"secret"'));
  assert.equal(described.dashclaw.configured,true);
  assert.equal(described.slack.channels,2);
  assert.equal(described.stripe.mode,'test');
  assert.equal(described.gmail.from,'agent@example.com');
  const unconfigured=describeConfig(loadConfig({env:{},loadFile:false}));
  assert.equal(unconfigured.gmail.from,'','an unconfigured app never surfaces its address either');
});

test('demo addresses: AGENT_DEMO_EMAIL and AGENT_DEMO_BLOCK_EMAIL are read lowercased; Demo C defaults to an alias of the demo inbox',()=>{
  const config=loadConfig({env:{AGENT_DEMO_EMAIL:' Wes+Acme@Example.com ',AGENT_DEMO_BLOCK_EMAIL:''},loadFile:false});
  assert.equal(config.demo.email,'wes+acme@example.com');assert.equal(config.demo.blockEmail,'');
  assert.equal(blockEmail(config.demo.email,'globex.com'),'wes+globex-com@example.com');
  assert.equal(blockEmail('','globex.com'),demoEmail('globex.com'));
  assert.equal(demoEmail('acme.com'),'demo-acme-com@acme.com');
});
