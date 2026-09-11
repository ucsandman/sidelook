// Owns: the one gate every string crosses before it can reach a generation prompt or learning memory. Redacts
// secrets first (reusing the runtime's own patterns), then strips the identity-bearing shapes the learning loop
// must never carry (emails, urls, absolute paths, Message-IDs), then refuses text that reads like an attempt to
// steer the loop itself. Contract: docs/AGENT_LEARNING_LOOP.md section 4 (intake and sanitization).
import { redactText } from '../../lib/agent/redact.mjs';

// Deliberately excludes '_' so a Sidelook Message-ID (`sidelook-run_<hex>-<n>@sidelook.local`, underscore in the
// local part) survives this pass and is still there for the MESSAGE_ID pass below to catch as a whole token.
const EMAIL_PATTERN = /\b[A-Za-z0-9.+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}\b/g;
const URL_PATTERN = /\bhttps?:\/\/\S+/gi;
const WINDOWS_PATH_PATTERN = /\b[A-Za-z]:\\[^\s"'<>]+/g;
const POSIX_PATH_PATTERN = /(?<![\w/])\/(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]*/g;
const MESSAGE_ID_PATTERN = /<[^\s<>@]+@[^\s<>@]+>/g;

// Non-global copies for a single .test() call each: a global regex carries lastIndex state across calls, which is
// exactly the kind of bug that silently misses the second string in a batch.
const EMAIL_TEST = /\b[A-Za-z0-9.+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}\b/;
const URL_TEST = /\bhttps?:\/\/\S+/i;

// Message-IDs run before the generic email pass on purpose (a deviation from the contract prose's listed order,
// section 4): a Sidelook Message-ID's local part contains an underscore before the @, which EMAIL_PATTERN (by
// design) does not match whole, so the email pass would otherwise eat only the tail of it and leave the
// `sidelook-run_...` prefix sitting outside a now-broken `<...<email>>` wrapper. Running message-id first consumes
// the whole angle-bracketed token in one piece, which is what section 4 actually asks for ("Message-IDs -> <message-id>").
export function sanitizeText(text, { maxChars = 300 } = {}) {
  let out = redactText(text);
  out = out.replace(MESSAGE_ID_PATTERN, '<message-id>');
  out = out.replace(EMAIL_PATTERN, '<email>');
  out = out.replace(URL_PATTERN, '<url>');
  out = out.replace(WINDOWS_PATH_PATTERN, '<path>');
  out = out.replace(POSIX_PATH_PATTERN, '<path>');
  return out.length > maxChars ? out.slice(0, maxChars) : out;
}

// Keys whose value is dropped whole by sanitizeForPrompt, wherever they appear in the object tree: these carry raw
// retrieved or user-facing text that must never reach a generation prompt, however deep it is nested.
export const DENYLIST_KEYS = ['text', 'body', 'subject', 'detail', 'message', 'preview', 'content', 'raw', 'evidence', 'finalMessage', 'goal'];
const DENYLIST_SET = new Set(DENYLIST_KEYS);

function dropDenylisted(value) {
  if (Array.isArray(value)) return value.map(dropDenylisted);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      if (DENYLIST_SET.has(key)) continue;
      out[key] = dropDenylisted(v);
    }
    return out;
  }
  return value;
}

function sanitizeStrings(value) {
  if (typeof value === 'string') return sanitizeText(value);
  if (Array.isArray(value)) return value.map(sanitizeStrings);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, v] of Object.entries(value)) out[key] = sanitizeStrings(v);
    return out;
  }
  return value;
}

// Returns the bounded JSON text of a sanitized value: what actually gets spliced into a generation prompt, never
// the object itself, so a caller cannot forget the char bound by reaching past this function's return value.
export function sanitizeForPrompt(value, { maxChars = 6000 } = {}) {
  const dropped = dropDenylisted(value);
  const sanitized = sanitizeStrings(dropped);
  let text;
  try { text = JSON.stringify(sanitized); }
  catch { text = String(sanitized); }
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

// Phrasing that tries to redirect the loop's own behavior, from inside data the loop only ever reads: a lesson, a
// retro note, sanitized incident evidence. None of this is a place instructions belong.
const INSTRUCTION_PATTERNS = [
  /ignore (?:all|previous|prior) instructions/i,
  /you are now/i,
  /system prompt/i,
  /disregard/i,
  /from now on/i,
  /always (?:do|refund|approve|send)/i,
  /never (?:verify|check|ask)/i
];

export function isInstructionLike(text) {
  const s = String(text ?? '');
  if (INSTRUCTION_PATTERNS.some(pattern => pattern.test(s))) return true;
  if (URL_TEST.test(s)) return true;
  if (EMAIL_TEST.test(s)) return true;
  return false;
}

export function assertNoInstruction(text) {
  if (!isInstructionLike(text)) return;
  const error = new Error('Text looks instruction-like and was refused before it could enter learning memory or a prompt.');
  error.code = 'INSTRUCTION_LIKE';
  throw error;
}
