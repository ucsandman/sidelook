// One-time Gmail OAuth helper: prints the consent URL, receives the loopback callback, exchanges the code, and prints the
// refresh token once for the person to paste into .env. Contract: docs/AGENT_MODE_IMPLEMENTATION.md sections 7, 17.
// node scripts/gmail-auth.mjs [--open] [--no-browser]
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const SCOPES=['https://www.googleapis.com/auth/gmail.send','https://www.googleapis.com/auth/gmail.readonly'];
const TOKEN_URL='https://oauth2.googleapis.com/token';
const CALLBACK_TIMEOUT_MS=5*60*1000;

export class GoogleAuthError extends Error {
  constructor(code,message){super(message);this.code=code;}
}

// Pure: the exact URL the person opens. No network call, so the test can check the query string directly.
export function consentUrl({clientId,port}){
  const params=new URLSearchParams({
    client_id:clientId,redirect_uri:`http://127.0.0.1:${port}/callback`,response_type:'code',
    scope:SCOPES.join(' '),access_type:'offline',prompt:'consent'
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

// Pure apart from the injected fetch: trades the authorization code for tokens. Throws GoogleAuthError('GOOGLE_<code>', ...)
// naming Google's own error, never a generic message.
export async function exchangeCode({code,clientId,clientSecret,port,fetchImpl=fetch}){
  const body=new URLSearchParams({code,client_id:clientId,client_secret:clientSecret,redirect_uri:`http://127.0.0.1:${port}/callback`,grant_type:'authorization_code'});
  let response;
  try{response=await fetchImpl(TOKEN_URL,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:body.toString()});}
  catch(error){throw new GoogleAuthError('NETWORK',`Could not reach ${TOKEN_URL}: ${error.message}`);}
  let json;
  try{json=await response.json();}
  catch{throw new GoogleAuthError('INVALID_RESPONSE','Google did not return a JSON token response.');}
  if(!response.ok || !json.refresh_token) throw new GoogleAuthError(`GOOGLE_${json.error || response.status}`,json.error_description || json.error || `Google token exchange failed with status ${response.status}.`);
  return {refreshToken:json.refresh_token,accessToken:json.access_token,expiresIn:json.expires_in};
}

function openUrl(url){
  const platform=process.platform;
  const [cmd,args]=platform==='win32'?['cmd.exe',['/c','start','',url]]:platform==='darwin'?['open',[url]]:['xdg-open',[url]];
  try{spawn(cmd,args,{stdio:'ignore',detached:true}).unref();}
  catch(error){console.error(`Could not open a browser automatically (${error.message}); open the URL above by hand.`);}
}

// Waits for the one /callback request the loopback server exists to receive. Resolves the code, rejects a typed error on
// Google's own denial, a malformed callback, or a person who never finishes within the timeout.
function waitForCallback(server){
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{server.close();reject(new GoogleAuthError('CALLBACK_TIMEOUT','No callback arrived within 5 minutes. Run the script again.'));},CALLBACK_TIMEOUT_MS);
    server.on('request',(req,res)=>{
      const url=new URL(req.url,'http://127.0.0.1');
      if(url.pathname!=='/callback'){res.writeHead(404).end('Not found.');return;}
      const error=url.searchParams.get('error'),code=url.searchParams.get('code');
      res.writeHead(200,{'content-type':'text/plain'}).end(error?`Google denied access (${error}). You can close this window.`:'Sidelook has the code. You can close this window.');
      clearTimeout(timer);server.close();
      if(error) reject(new GoogleAuthError(`GOOGLE_${error}`,`Google returned an error: ${error}.`));
      else if(!code) reject(new GoogleAuthError('NO_CODE','The callback carried no authorization code.'));
      else resolve(code);
    });
  });
}

async function loadEnv(){
  try{const {loadConfig}=await import('../lib/agent/config.mjs');loadConfig();}
  catch(error){
    if(error.code!=='ERR_MODULE_NOT_FOUND') throw error;
    if(existsSync('.env')){
      try{process.loadEnvFile('.env');}
      catch(loadError){console.error(`Warning: .env could not be loaded (${loadError.message}); using the process environment as-is.`);}
    }
  }
  return {clientId:process.env.GMAIL_CLIENT_ID || '',clientSecret:process.env.GMAIL_CLIENT_SECRET || ''};
}

async function main(){
  const {clientId,clientSecret}=await loadEnv();
  if(!clientId || !clientSecret){console.error('Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env first (Google Cloud console, OAuth client, Desktop app type).');process.exitCode=1;return;}
  const server=createServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const {port}=server.address();
  const url=consentUrl({clientId,port});
  console.log(`Open this URL and finish Google sign-in:\n${url}`);
  if(process.argv.includes('--open') && !process.argv.includes('--no-browser')) openUrl(url);
  let code;
  try{code=await waitForCallback(server);}
  catch(error){console.error(`Google sign-in failed (${error.code}): ${error.message}`);process.exitCode=1;return;}
  let tokens;
  try{tokens=await exchangeCode({code,clientId,clientSecret,port});}
  catch(error){console.error(`Google token exchange failed (${error.code}): ${error.message}`);process.exitCode=1;return;}
  console.log('Paste this line into .env (shown once, not saved anywhere by this script):');
  console.log(`GMAIL_REFRESH_TOKEN=${tokens.refreshToken}`);
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) await main();
