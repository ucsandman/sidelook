// Secret patterns scrubbed from anything stored or emitted. Defense in depth: no token should ever reach here in the first
// place, but a run's events, effect ledger and error text are redacted before they hit disk or the panel regardless.
// Contract: docs/AGENT_MODE_IMPLEMENTATION.md section 4.
const PATTERNS=[
  ['stripe',/\b(?:sk_(?:live|test)_|rk_(?:live|test)_)[A-Za-z0-9]{6,}/g],
  ['slack',/\bxox[abpes]-[A-Za-z0-9-]{6,}/g],
  ['slack',/\bxapp-[A-Za-z0-9-]{6,}/g],
  ['hubspot',/\bpat-[A-Za-z0-9-]{6,}/g],
  ['google',/\bya29\.[A-Za-z0-9_-]{6,}/g],
  ['google',/\b1\/\/[A-Za-z0-9_-]{20,}/g],
  ['google',/\bGOCSPX-[A-Za-z0-9_-]{6,}/g],
  ['dashclaw',/\boc_live_[A-Za-z0-9]{6,}/g],
  ['bearer',/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi],
  ['refresh_token',/refresh_token=[^&\s"']+/gi],
  ['client_secret',/client_secret=[^&\s"']+/gi],
  ['access_token',/access_token=[^&\s"']+/gi]
];

export function redactText(text){
  let out=String(text ?? '');
  for(const [kind,pattern] of PATTERNS) out=out.replace(pattern,`[redacted:${kind}]`);
  return out;
}

// A key named like this hides its value whole, whatever shape it is: the pattern list above only catches known secret
// formats, but a header or field named authorization/cookie/x-api-key/apiKey/token/secret is never printed regardless.
const SECRET_KEYS=new Set(['authorization','cookie','x-api-key','apikey','token','secret']);

export function redact(value){
  if(typeof value==='string') return redactText(value);
  if(Array.isArray(value)) return value.map(redact);
  if(value && typeof value==='object'){
    const out={};
    for(const [key,v] of Object.entries(value)) out[key]=SECRET_KEYS.has(key.toLowerCase())?'[redacted:key]':redact(v);
    return out;
  }
  return value;
}
