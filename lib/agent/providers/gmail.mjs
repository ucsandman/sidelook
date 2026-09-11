// Gmail adapter: OAuth refresh-token exchange (cached), an RFC 822 message the caller's Message-ID and body reference ride
// in, and the reads that prove a send actually landed: the message by the id Gmail returned, or a search by Message-ID or
// reference when that id was never received. Contract: sections 6, 7 and 14.
import {ProviderError,request,retryRead} from '../http.mjs';

const TOKEN_URL='https://oauth2.googleapis.com/token';
const API='https://gmail.googleapis.com/gmail/v1';
const toBase64Url=text=>Buffer.from(text,'utf8').toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');

export function createGmail({config,fetchImpl=fetch,now=Date.now}={}){
  let cached=null; // {token, expiresAt}
  async function accessToken(){
    if(cached && cached.expiresAt-60000>now()) return cached.token;
    let res;
    try{
      res=await request({
        url:TOKEN_URL,method:'POST',
        form:{client_id:config.gmail.clientId,client_secret:config.gmail.clientSecret,refresh_token:config.gmail.refreshToken,grant_type:'refresh_token'},
        fetchImpl,label:'Gmail token exchange'
      });
    } catch(error){
      // Google answers a bad or expired refresh token with 400 invalid_grant, not 401: section 14 still calls this AUTH
      // (no retry). A genuine transient failure (network/timeout/5xx) keeps its own retryable classification.
      if(error instanceof ProviderError && error.code==='INVALID') throw new ProviderError('AUTH','Gmail could not exchange the refresh token.',{status:error.status,sentRequest:false,detail:error.detail});
      throw error;
    }
    if(!res.json?.access_token) throw new ProviderError('AUTH','Gmail could not exchange the refresh token.',{status:res.status,sentRequest:true});
    cached={token:res.json.access_token,expiresAt:now()+Number(res.json.expires_in || 3600)*1000};
    return cached.token;
  }
  async function getJson(path,label){
    return await retryRead(async()=>{
      const headers={Authorization:`Bearer ${await accessToken()}`};
      const res=await request({url:`${API}${path}`,method:'GET',headers,fetchImpl,label:`Gmail ${label}`});
      return res.json;
    },{});
  }
  function composeRaw({to,from=config.gmail.from,subject,body,messageId}){
    const lines=[
      `From: ${from}`,`To: ${to}`,`Subject: ${subject}`,`Date: ${new Date(now()).toUTCString()}`,
      `Message-ID: ${messageId}`,'MIME-Version: 1.0','Content-Type: text/plain; charset=utf-8','',body || ''
    ];
    return toBase64Url(lines.join('\r\n'));
  }
  return {
    accessToken,composeRaw,
    async health(){
      const json=await getJson('/users/me/profile','health check');
      return {address:json.emailAddress || ''};
    },
    async send({raw}={}){
      const headers={Authorization:`Bearer ${await accessToken()}`};
      const res=await request({url:`${API}/users/me/messages/send`,method:'POST',headers,body:{raw},fetchImpl,label:'Gmail send'});
      return {id:res.json.id,threadId:res.json.threadId,labelIds:res.json.labelIds || []};
    },
    // The read that verifies a send: Gmail's own id for the message, answered immediately and never subject to search lag.
    async getMessage({id}={}){
      if(!id) return {found:false,id:'',threadId:'',labelIds:[]};
      let meta;
      try{meta=await getJson(`/users/me/messages/${encodeURIComponent(id)}?format=metadata`,'message metadata');}
      catch(error){if(error instanceof ProviderError && error.code==='NOT_FOUND') return {found:false,id:'',threadId:'',labelIds:[]};throw error;}
      return {found:true,id:meta.id,threadId:meta.threadId,labelIds:meta.labelIds || []};
    },
    // The read that reconciles a send whose answer was lost. Gmail keeps a caller's Message-ID only for some senders and
    // replaces it for gmail.com accounts, so the search also matches the reference token the body carries.
    async findByMessageId({messageId,reference}={}){
      const bare=String(messageId || '').replace(/^</,'').replace(/>$/,'');
      const terms=[bare?`rfc822msgid:${bare}`:'',reference?`"${String(reference).replace(/"/g,'')}"`:''].filter(Boolean);
      if(!terms.length) return {found:false,id:'',threadId:'',labelIds:[]};
      const list=await getJson(`/users/me/messages?q=${encodeURIComponent(terms.join(' OR '))}`,'find by message id');
      const first=(list.messages || [])[0];
      if(!first) return {found:false,id:'',threadId:'',labelIds:[]};
      const meta=await getJson(`/users/me/messages/${first.id}?format=metadata`,'message metadata');
      return {found:true,id:meta.id,threadId:meta.threadId,labelIds:meta.labelIds || []};
    }
  };
}
