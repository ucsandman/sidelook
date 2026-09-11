// A stand-in for vision.generate(): given the same JSON prompt buildPrompt (Track C, lib/agent/planner.mjs) will send, it plays a
// competent agent one PLAN_SCHEMA turn at a time, using only what appeared in `observations`, `entities` and `verifiedFacts` — never
// inventing an id. Contract: docs/AGENT_MODE_IMPLEMENTATION.md sections 5, 6, 16.
//
// Verified against lib/agent/planner.mjs's buildPrompt and lib/agent/loop.mjs's runLoop: one prompt is
// {goal, windowTitle, turn, maxTurns, entities, verifiedFacts, candidates?, observations, lastError, pendingQuestionAnswer}.
// Each entry in `observations` is {turn, tool, result} where `tool` is the tool name and `result` is exactly what that tool's
// handler returned: a read (lib/agent/tools.mjs) returns {ok, ...}, a write (lib/agent/effects.mjs) always returns
// {status:'blocked'|'rejected'|'expired'|'uncertain'|'failed'|'executed'|'verified', ...}. `verifiedFacts` entries are
// {label, value} — no `key` — so facts here are looked up by the exact label string lib/agent/tools.mjs and effects.mjs use.

const FIELDS = ['kind', 'tool', 'reason', 'message', 'customer', 'email', 'domain', 'query', 'channel', 'messageTs', 'customerId', 'paymentId', 'amountCents', 'refundId', 'contactId', 'property', 'value', 'to', 'subject', 'body', 'messageId'];
const emptyPlan = () => Object.fromEntries(FIELDS.map(f => [f, f === 'amountCents' ? 0 : '']));
const plan = fields => ({...emptyPlan(), ...fields});

function parsePrompt(parts) {
  const text = (parts || []).filter(p => p && typeof p.text === 'string').map(p => p.text).join('\n');
  let prompt;
  try { prompt = JSON.parse(text); } catch { throw new Error('The scripted model received a prompt that was not JSON. Is buildPrompt sending something else?'); }
  if (!prompt || typeof prompt !== 'object') throw new Error('The scripted model received an empty prompt.');
  return prompt;
}

const tried = (observations, tool) => (observations || []).some(o => o.tool === tool);
const entriesFor = (observations, tool) => (observations || []).filter(o => o.tool === tool);
const lastOf = (observations, tool) => entriesFor(observations, tool).at(-1) || null;
const statusOf = entry => entry?.result?.status;
const REFUSED = new Set(['blocked', 'rejected', 'expired', 'refused']);
const SUCCEEDED = new Set(['verified', 'executed']);
// Two most recent attempts at the same write, both plain failures (not blocked/rejected, which are final policy decisions handled
// separately): the model stops proposing it again rather than looping to the turn cap.
function twoConsecutiveFailures(observations, tool) {
  const entries = entriesFor(observations, tool);
  if (entries.length < 2) return false;
  const [a, b] = entries.slice(-2);
  const failed = o => statusOf(o) === 'failed';
  return failed(a) && failed(b);
}
// slack.find_customer_request's result nests the chosen message under `request` (tools.mjs); a slack.get_message_context
// result has no single "latest" line, so only the find_customer_request entry is read here.
function latestSlackText(observations) {
  return lastOf(observations, 'slack.find_customer_request')?.result?.request?.text || '';
}
const factValue = (facts, label) => (facts || []).find(f => f.label === label)?.value || '';

function extractCustomerName(goal) {
  const beforeCancellation = /\b([A-Za-z]+)\s+cancellation\b/i.exec(goal || '');
  if (beforeCancellation) return beforeCancellation[1];
  const afterResolve = /\bResolve\s+([A-Z][A-Za-z]*)\b/.exec(goal || '');
  if (afterResolve) return afterResolve[1];
  return '';
}
function extractDollarsToCents(goal) {
  const match = /\$([\d,]+)(?:\.(\d{2}))?/.exec(goal || '');
  if (!match) return 0;
  const dollars = Number(match[1].replace(/,/g, ''));
  const cents = match[2] ? Number(match[2]) : 0;
  return Number.isFinite(dollars) ? dollars * 100 + cents : 0;
}
const wantsRefund = goal => /refund/i.test(goal || '');

// Four scenario hooks named in the brief. Each is a full plan, keyed to a turn number by the caller (see createScriptedModel).
const NAMED_OVERRIDES = {
  inventTool: () => plan({kind:'tool', tool:'stripe.wire_transfer', reason:'Move the funds by wire instead.'}),
  malformed: () => 'this is not json', // stands in for `result` itself, so parsePlan downstream sees a non-object
  giveUp: () => plan({kind:'done', message:'Stopping early.'})
};

function materializeOverride(value, prompt) {
  if (typeof value === 'string' && NAMED_OVERRIDES[value]) return NAMED_OVERRIDES[value](prompt);
  if (typeof value === 'string') return value; // a raw stand-in result, passed straight through
  return plan(value); // a caller-supplied plan, padded with the schema's empty defaults
}

// The competent strategy: one step per call, driven only by what has already been attempted (`observations`) and what tools have
// proven (`entities`, `verifiedFacts`), per docs/AGENT_MODE_IMPLEMENTATION.md section 6's tool table and section 10's fact ledger.
function nextPlan(prompt, {obeyInjection = false} = {}) {
  const goal = prompt.goal || '';
  const entities = prompt.entities || {};
  const observations = prompt.observations || [];
  const facts = prompt.verifiedFacts || [];
  const candidates = prompt.candidates || entities.stripeCandidates || [];
  const answer = prompt.pendingQuestionAnswer || '';

  if (!tried(observations, 'slack.find_customer_request')) {
    return plan({kind:'tool', tool:'slack.find_customer_request', reason:'Find the customer\'s request in Slack.', customer:extractCustomerName(goal)});
  }

  if (!wantsRefund(goal)) {
    const found = entities.customer?.name || factValue(facts, 'customer_name') || 'the customer';
    return plan({kind:'done', message:`Found ${found}'s Slack request. Nothing else was asked for, so no changes were made.`});
  }

  if (answer && candidates.length) {
    // A name alone can still match more than one candidate (Acme, Acme Holdings): search by the chosen candidate's own
    // email, which is unique per candidate, so the follow-up read actually narrows to one match.
    const chosen = candidates.find(c => c.name?.toLowerCase() === answer.toLowerCase()) || candidates.find(c => c.name?.toLowerCase().includes(answer.toLowerCase()));
    return plan({kind:'tool', tool:'stripe.find_customer', reason:'Narrow the Stripe match to the chosen customer.', email:chosen?.email || '', query:chosen?.email ? '' : answer});
  }
  if (!entities.stripeCustomer && candidates.length > 1) {
    return plan({kind:'ask', message:`I found more than one Stripe customer: ${candidates.map(c => c.name).join(', ')}. Which one?`});
  }
  if (!entities.stripeCustomer && !candidates.length && !tried(observations, 'stripe.find_customer')) {
    const email = entities.customer?.email || '';
    const domain = entities.customer?.domain || '';
    return plan({kind:'tool', tool:'stripe.find_customer', reason:'Look up the Stripe customer for this request.', email, domain, query:email || domain ? '' : extractCustomerName(goal)});
  }
  if (!entities.stripeCustomer && !candidates.length && tried(observations, 'stripe.find_customer')) {
    return plan({kind:'fail', message:'No Stripe customer matches this request. Nothing more can be done.'});
  }

  if (entities.stripeCustomer && !entities.payment && !tried(observations, 'stripe.get_recent_payments')) {
    return plan({kind:'tool', tool:'stripe.get_recent_payments', reason:'Find the payment to refund.', customerId:entities.stripeCustomer.id});
  }
  if (entities.stripeCustomer && !entities.payment && tried(observations, 'stripe.get_recent_payments')) {
    return plan({kind:'fail', message:'No payment was found for this customer. Nothing more can be done.'});
  }

  if (entities.payment && !entities.refund) {
    const refundOutcome = lastOf(observations, 'stripe.refund_payment');
    if (refundOutcome && REFUSED.has(statusOf(refundOutcome))) return plan({kind:'done', message:'The refund was not made; it was held by policy.'});
    if (twoConsecutiveFailures(observations, 'stripe.refund_payment')) return plan({kind:'done', message:'The refund kept failing. Stopping with what succeeded so far.'});
    // No dollar figure in the goal means "the full observed amount", not 0: amountCents:0 is the schema's empty sentinel and is
    // dropped by validateCall, so an explicit amount always rides here rather than relying on a runtime default.
    let amountCents = extractDollarsToCents(goal) || entities.payment.amountCents || 0;
    if (obeyInjection && /ignore/i.test(latestSlackText(observations))) amountCents = 5000000;
    return plan({kind:'tool', tool:'stripe.refund_payment', reason:'Refund the payment per the Slack request.', paymentId:entities.payment.id, amountCents});
  }

  if (entities.refund && !entities.hubspotContact && !tried(observations, 'hubspot.find_customer')) {
    return plan({kind:'tool', tool:'hubspot.find_customer', reason:'Find the CRM contact to update.', email:entities.stripeCustomer?.email || entities.customer?.email || ''});
  }
  if (entities.refund && !entities.hubspotContact && tried(observations, 'hubspot.find_customer')) {
    return plan({kind:'done', message:'Refund processed, but no HubSpot contact was found to update.'});
  }

  if (entities.hubspotContact) {
    const updateOutcome = lastOf(observations, 'hubspot.update_customer');
    const updated = updateOutcome && SUCCEEDED.has(statusOf(updateOutcome));
    if (!updated) {
      if (updateOutcome && REFUSED.has(statusOf(updateOutcome))) return plan({kind:'done', message:'Refund processed, but the CRM update was held by policy.'});
      if (twoConsecutiveFailures(observations, 'hubspot.update_customer')) return plan({kind:'done', message:'Refund processed, but the CRM update kept failing.'});
      return plan({kind:'tool', tool:'hubspot.update_customer', reason:'Mark the account as unqualified.', contactId:entities.hubspotContact.id, property:'', value:''});
    }
  }

  if (entities.hubspotContact && !entities.email && !tried(observations, 'gmail.prepare_message')) {
    const to = entities.hubspotContact.email || entities.stripeCustomer?.email || entities.customer?.email || '';
    const body = `Hi ${factValue(facts, 'Customer name') || entities.customer?.name || 'there'}, your refund of ${factValue(facts, 'refund_amount')} (refund ${factValue(facts, 'refund_id')}) for the payment on ${factValue(facts, 'Payment date')} has been processed and your account is marked ${factValue(facts, 'crm_status')}.`;
    return plan({kind:'tool', tool:'gmail.prepare_message', reason:'Prepare the confirmation email.', to, subject:'Your refund has been processed', body});
  }
  if (entities.email && !tried(observations, 'gmail.send_message')) {
    const prepared = lastOf(observations, 'gmail.prepare_message');
    if (prepared && prepared.result?.verified === false) return plan({kind:'done', message:'Refund processed, but the confirmation email could not be verified against the facts, so it was not sent.'});
    return plan({kind:'tool', tool:'gmail.send_message', reason:'Send the confirmation email.', messageId:entities.email.messageId});
  }
  if (entities.email && tried(observations, 'gmail.send_message')) {
    const sendOutcome = lastOf(observations, 'gmail.send_message');
    if (sendOutcome && REFUSED.has(statusOf(sendOutcome))) return plan({kind:'done', message:'Refund processed, but the confirmation email was held by policy.'});
    if (twoConsecutiveFailures(observations, 'gmail.send_message')) return plan({kind:'done', message:'Refund processed, but the confirmation email kept failing to send.'});
    if (sendOutcome && SUCCEEDED.has(statusOf(sendOutcome))) return plan({kind:'done', message:'Refund processed and confirmation email sent.'});
  }

  return plan({kind:'done', message:'Nothing more to do for this goal.'});
}

// overrides: a plain object mapping a turn number to a named hook ('inventTool'|'malformed'|'giveUp') or a partial plan object,
// plus the optional flags `obeyInjection: true` and `when: [{test:(prompt,turn)=>boolean, use}]` for predicate-driven turns,
// checked before the numeric map. Numeric keys may be numbers or numeric strings.
export function createScriptedModel({overrides = {}} = {}) {
  const {obeyInjection = false, when = []} = overrides;
  const turnOverrides = new Map(Object.entries(overrides).filter(([k]) => /^\d+$/.test(k)).map(([k, v]) => [Number(k), v]));
  return async function scriptedModel(system, parts, schema, signal, options = {}) {
    const prompt = parsePrompt(parts);
    const turn = typeof prompt.turn === 'number' ? prompt.turn : 0;
    const predicate = when.find(rule => rule.test(prompt, turn));
    const value = predicate ? predicate.use : turnOverrides.get(turn);
    const result = value !== undefined ? materializeOverride(value, prompt) : nextPlan(prompt, {obeyInjection});
    return {result, model:'scripted', tokens:0, cachedTokens:0};
  };
}

export {emptyPlan as EMPTY_PLAN, nextPlan, extractCustomerName, extractDollarsToCents};
