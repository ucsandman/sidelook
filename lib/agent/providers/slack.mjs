// Slack adapter: bot-token REST calls, channel-name resolution, a bounded history scan for the customer's cancellation
// request. Slack answers HTTP 200 even on failure, so every call checks json.ok itself. Contract: sections 6 and 7.
import {ProviderError,request,retryRead} from '../http.mjs';

const BASE='https://slack.com/api';
const CHANNEL_ID=/^[CG][A-Z0-9]{6,}$/;
const AUTH_ERRORS=new Set(['invalid_auth','not_authed','account_inactive','token_revoked','no_permission','missing_scope','token_expired']);
const NOT_FOUND_ERRORS=new Set(['channel_not_found','user_not_found','message_not_found','thread_not_found']);

function slackError(json,label){
  const reason=json?.error || 'unknown_error';
  if(AUTH_ERRORS.has(reason)) return new ProviderError('AUTH',`Slack ${label} failed: ${reason}.`,{sentRequest:true,detail:reason});
  if(NOT_FOUND_ERRORS.has(reason)) return new ProviderError('NOT_FOUND',`Slack ${label} failed: ${reason}.`,{sentRequest:true,detail:reason});
  if(reason==='ratelimited') return new ProviderError('RATE_LIMIT',`Slack ${label} failed: ${reason}.`,{retryable:true,sentRequest:true,detail:reason});
  return new ProviderError('SERVER',`Slack ${label} failed: ${reason}.`,{retryable:true,sentRequest:true,detail:reason});
}

export function createSlack({config,fetchImpl=fetch,now=Date.now}={}){
  const auth={Authorization:`Bearer ${config.slack.token}`};
  async function call(method,form,label){
    return await retryRead(async()=>{
      const res=await request({url:`${BASE}/${method}`,method:'POST',headers:auth,form,fetchImpl,label:`Slack ${label}`});
      if(!res.json?.ok) throw slackError(res.json,label);
      return res.json;
    },{});
  }
  // Anything already shaped like a channel id passes straight through; a name is resolved against one bounded page of
  // public channels (conversations.list, limit 200) so a plain "#general" in config still works.
  async function resolveChannels(list){
    const wanted=(list && list.length?list:config.slack.channels).map(c=>String(c).trim().replace(/^#/,'')).filter(Boolean);
    if(!wanted.length) return [];
    let byName=null;
    if(wanted.some(c=>!CHANNEL_ID.test(c))){
      const json=await call('conversations.list',{types:'public_channel',limit:'200'},'channel list');
      byName=new Map((json.channels || []).map(ch=>[String(ch.name || '').toLowerCase(),ch.id]));
    }
    return wanted.map(c=>({id:CHANNEL_ID.test(c)?c:byName?.get(c.toLowerCase()),name:c})).filter(c=>c.id);
  }
  async function authorName(userId,cache){
    if(!userId) return userId || '';
    if(cache.has(userId)) return cache.get(userId);
    try{const json=await call('users.info',{user:userId},'user lookup');const name=json.user?.real_name || json.user?.name || userId;cache.set(userId,name);return name;}
    catch{cache.set(userId,userId);return userId;}
  }
  return {
    // auth.test passes with any scope at all (a chat:write-only token did, 2026-09-11, and the first read then failed with
    // missing_scope), so the probe also lists one channel and, when channels are configured, reads one message from the first.
    async health(){
      await call('auth.test',{},'health check');
      await call('conversations.list',{types:'public_channel',limit:'1'},'channel list');
      const resolved=await resolveChannels([]);
      if(config.slack.channels.length && !resolved.length) throw new ProviderError('NOT_FOUND',`Slack channel ${config.slack.channels[0]} was not found among the public channels.`,{sentRequest:true,detail:'channel_not_found'});
      if(resolved.length) await call('conversations.history',{channel:resolved[0].id,limit:'1'},'channel history');
      return {ok:true,channels:resolved.map(c=>c.name)};
    },
    async findCustomerRequest({customer='',domain='',channels=[],lookbackDays}={}){
      const days=Number.isFinite(lookbackDays) && lookbackDays>0?lookbackDays:config.slack.lookbackDays;
      const resolved=await resolveChannels(channels);
      const oldest=String(Math.floor(now()/1000-days*86400));
      const needles=[customer,domain].filter(Boolean).map(s=>s.toLowerCase());
      const matches=[];
      for(const channel of resolved){
        const json=await call('conversations.history',{channel:channel.id,oldest,limit:'200'},'channel history');
        for(const message of json.messages || []){
          const text=String(message.text || '');
          if(needles.length && !needles.some(n=>text.toLowerCase().includes(n))) continue;
          matches.push({...message,channelId:channel.id,channelName:channel.name});
        }
      }
      matches.sort((a,b)=>Number(b.ts)-Number(a.ts));
      const top=matches.slice(0,5);
      const authorCache=new Map();
      const results=[];
      for(const message of top){
        const author=await authorName(message.user,authorCache);
        let permalink='';
        try{permalink=(await call('chat.getPermalink',{channel:message.channelId,message_ts:message.ts},'permalink')).permalink || '';}
        catch{permalink='';}
        results.push({text:String(message.text || '').slice(0,2000),author,ts:message.ts,channel:message.channelId,channelName:message.channelName,permalink});
      }
      return {messages:results};
    },
    async getMessageContext({channel,ts}={}){
      const json=await call('conversations.replies',{channel,ts,limit:'20'},'thread replies');
      return {replies:(json.messages || []).slice(0,20).map(m=>({text:String(m.text || '').slice(0,2000),author:m.user || '',ts:m.ts}))};
    }
  };
}
