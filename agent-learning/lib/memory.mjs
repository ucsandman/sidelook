// Owns: the bounded, provenance-tagged learning memory that survives across loop runs. Every write goes through
// mergeMemory, which enforces caps, provenance and the instruction gate before anything lands; nothing else in the
// loop is allowed to write agent-learning/memory/learning-memory.json directly. Contract: docs/AGENT_LEARNING_LOOP.md
// section 5.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { assertNoInstruction, sanitizeText } from './sanitize.mjs';

export const CAPS = Object.freeze({
  loops: 20, lessons: 30, failureFamilies: 40, recoveryStrategies: 30, rejectedStrategies: 40,
  unresolved: 15, nextExperiments: 10, trends: 30, lineage: 60, rejectedMemoryItems: 20
});

const SCHEMA_VERSION = 1;

export function EMPTY_MEMORY() {
  return {
    schemaVersion: SCHEMA_VERSION, updatedAt: null, lastIntakeAt: null,
    loops: [], lessons: [], failureFamilies: [], recoveryStrategies: [], rejectedStrategies: [],
    unresolved: [], nextExperiments: [], trends: [], lineage: [], rejectedMemoryItems: []
  };
}

export async function loadMemory(path) {
  let text;
  try { text = await readFile(path, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return EMPTY_MEMORY();
    throw error;
  }
  const memory = JSON.parse(text);
  if (memory?.schemaVersion !== SCHEMA_VERSION) {
    const error = new Error(`Unknown learning memory schemaVersion ${memory?.schemaVersion}.`);
    error.code = 'MEMORY_SCHEMA';
    throw error;
  }
  return memory;
}

export async function saveMemory(path, memory) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(memory, null, 2), 'utf8');
  await rename(tmp, path);
}

// provenance = { runIds:[], incidentIds:[], learnRunId, candidateId?, evaluationId?, regressionIds?:[], source }
export function validateProvenance(p) {
  if (!p || typeof p !== 'object') return false;
  if (!p.learnRunId || typeof p.learnRunId !== 'string') return false;
  const runIds = Array.isArray(p.runIds) ? p.runIds : [];
  const incidentIds = Array.isArray(p.incidentIds) ? p.incidentIds : [];
  // At least one run id, incident id, candidate id or evaluation id: a bare learnRunId is not enough evidence.
  return runIds.length > 0 || incidentIds.length > 0 || !!p.candidateId || !!p.evaluationId;
}

const LESSON_STATUSES = new Set(['provisional', 'confirmed', 'retired']);
const LESSON_CONFIDENCE = new Set(['low', 'medium', 'high']);

// A field's items, oldest-provisional-first order for eviction: every item here carries at least `at` (ISO) and,
// for lessons, `status`. Items without a usable `at` sort last (evicted first) rather than crashing a comparator.
function byAgeAscending(a, b) { return String(a?.at || '').localeCompare(String(b?.at || '')); }

// Evicts the oldest item until `list` is at or under `cap`, skipping any item `protect` says to keep. Returns the
// evicted items (for a caller that wants to know, though mergeMemory only needs the survivors here).
function evictToCap(list, cap, protect = () => false) {
  if (list.length <= cap) return list;
  const protectedItems = list.filter(protect);
  const evictable = list.filter(item => !protect(item)).sort(byAgeAscending);
  const keepCount = Math.max(0, cap - protectedItems.length);
  const kept = evictable.slice(Math.max(0, evictable.length - keepCount));
  // Restore original relative order (newest-appended-last) rather than the eviction sort's order.
  const keptSet = new Set(kept);
  return list.filter(item => protectedItems.includes(item) || keptSet.has(item));
}

function rejected(rejectedList, field, reason) {
  rejectedList.push({ at: new Date().toISOString(), field, reason });
}

// Every incoming string (lesson text, rejected-strategy summary, unresolved note, etc.) passes assertNoInstruction;
// a failure is caught here, never thrown out of mergeMemory, and recorded under rejectedMemoryItems instead.
function safeText(value, field, rejectedList) {
  try { assertNoInstruction(value); return true; }
  catch (error) { rejected(rejectedList, field, error.message); return false; }
}

// mergeMemory(memory, delta, {now}) -> {memory, rejected:[{field, reason}]}. Pure: takes a memory snapshot and a
// delta, returns a new memory (never mutates the input) plus the list of items this call itself refused.
export function mergeMemory(memory, delta = {}, { now = () => new Date().toISOString() } = {}) {
  const out = JSON.parse(JSON.stringify(memory));
  const rejectedNow = [];
  const at = now();
  out.updatedAt = at;
  if (delta.lastIntakeAt) out.lastIntakeAt = delta.lastIntakeAt;

  // loops: append-only lineage of runs, no provenance gate (the loop's own record of itself).
  for (const loop of delta.loops || []) out.loops.push({ ...loop, at: loop.at || at });
  out.loops = evictToCap(out.loops, CAPS.loops);

  // lessons: text bounded and instruction-checked; provenance required; a confirmed lesson is never evicted.
  const incomingLessons = delta.lessons || [];
  for (const lesson of incomingLessons) {
    if (!lesson || typeof lesson.text !== 'string' || !lesson.text.trim()) { rejected(rejectedNow, 'lessons', 'A lesson needs text.'); continue; }
    if (!validateProvenance(lesson.provenance)) { rejected(rejectedNow, 'lessons', 'A lesson needs provenance with at least one run, incident, candidate or evaluation id.'); continue; }
    if (!safeText(lesson.text, 'lessons', rejectedNow)) continue;
    const status = LESSON_STATUSES.has(lesson.status) ? lesson.status : 'provisional';
    const confidence = LESSON_CONFIDENCE.has(lesson.confidence) ? lesson.confidence : 'low';
    const existing = out.lessons.find(l => l.id === lesson.id);
    const text = sanitizeText(lesson.text, { maxChars: 240 });
    // Never downgrade a confirmed lesson: an update that omits status (every retro re-emit does) must not silently
    // un-confirm it. §5: a lesson leaves 'confirmed' only when a promoted candidate's evaluation contradicts it
    // (an explicit status:'retired' in the delta), never by falling back to 'provisional' here.
    if (existing) {
      const nextStatus = existing.status === 'confirmed' && status !== 'retired' ? 'confirmed' : status;
      existing.text = text; existing.status = nextStatus; existing.confidence = confidence; existing.provenance = lesson.provenance; existing.at = at;
    }
    else out.lessons.push({ id: lesson.id || `lesson_${out.lessons.length + 1}_${Date.now()}`, text, status, confidence, provenance: lesson.provenance, at });
  }

  // lessonsCited: how a provisional lesson becomes confirmed. Two distinct learnRunIds citing with evaluation
  // evidence promote it; a promoted candidate's evaluation contradicting a lesson retires it (the delta names that
  // explicitly via lesson.status:'retired' above, not through lessonsCited).
  for (const citation of delta.lessonsCited || []) {
    const lesson = out.lessons.find(l => l.id === citation.id);
    if (!lesson || lesson.status === 'confirmed') continue;
    lesson.citedBy = Array.isArray(lesson.citedBy) ? lesson.citedBy : [];
    if (!citation.evaluationId) continue;
    if (!lesson.citedBy.some(c => c.learnRunId === citation.learnRunId)) lesson.citedBy.push({ learnRunId: citation.learnRunId, evaluationId: citation.evaluationId });
    const distinctRuns = new Set(lesson.citedBy.map(c => c.learnRunId));
    if (distinctRuns.size >= 2) lesson.status = 'confirmed';
  }
  out.lessons = evictToCap(out.lessons, CAPS.lessons, item => item.status === 'confirmed');

  // failureFamilies: bounded runIds/incidentIds lists (contract cap 10 each), keyed by family key.
  for (const family of delta.failureFamilies || []) {
    if (!family || typeof family.key !== 'string') { rejected(rejectedNow, 'failureFamilies', 'A failure family needs a key.'); continue; }
    const existing = out.failureFamilies.find(f => f.key === family.key);
    const runIds = [...new Set([...(existing?.runIds || []), ...(family.runIds || [])])].slice(-10);
    const incidentIds = [...new Set([...(existing?.incidentIds || []), ...(family.incidentIds || [])])].slice(-10);
    const merged = {
      key: family.key, integration: family.integration ?? existing?.integration ?? null, failureClass: family.failureClass ?? existing?.failureClass ?? null,
      tool: family.tool ?? existing?.tool ?? null, count: (existing?.count || 0) + (family.count || 0),
      firstSeen: existing?.firstSeen || family.firstSeen || at, lastSeen: family.lastSeen || at,
      status: family.status || existing?.status || 'open', regressionIds: [...new Set([...(existing?.regressionIds || []), ...(family.regressionIds || [])])],
      runIds, incidentIds, at
    };
    if (existing) Object.assign(existing, merged); else out.failureFamilies.push(merged);
  }
  out.failureFamilies = evictToCap(out.failureFamilies, CAPS.failureFamilies);

  // recoveryStrategies: success/failure tallies per failureClass+strategy pair.
  for (const strategy of delta.recoveryStrategies || []) {
    if (!strategy || !strategy.failureClass || !strategy.strategy) { rejected(rejectedNow, 'recoveryStrategies', 'A recovery strategy needs a failureClass and a strategy.'); continue; }
    const existing = out.recoveryStrategies.find(s => s.failureClass === strategy.failureClass && s.strategy === strategy.strategy);
    if (existing) { existing.successes += strategy.successes || 0; existing.failures += strategy.failures || 0; existing.provenance = strategy.provenance || existing.provenance; existing.at = at; }
    else out.recoveryStrategies.push({ failureClass: strategy.failureClass, strategy: strategy.strategy, successes: strategy.successes || 0, failures: strategy.failures || 0, provenance: strategy.provenance || null, at });
  }
  out.recoveryStrategies = evictToCap(out.recoveryStrategies, CAPS.recoveryStrategies);

  // rejectedStrategies: never evicted while referenced by nextLoop.recommendedNextExperiment/candidateIdeas
  // (the caller passes referencedHypothesisKeys when it knows what next_loop.json currently cites).
  const referenced = new Set(delta.referencedHypothesisKeys || []);
  for (const strategy of delta.rejectedStrategies || []) {
    if (!strategy || typeof strategy.hypothesisKey !== 'string') { rejected(rejectedNow, 'rejectedStrategies', 'A rejected strategy needs a hypothesisKey.'); continue; }
    if (strategy.summary !== undefined && !safeText(strategy.summary, 'rejectedStrategies', rejectedNow)) continue;
    if (strategy.reason !== undefined && !safeText(strategy.reason, 'rejectedStrategies', rejectedNow)) continue;
    out.rejectedStrategies.push({
      hypothesisKey: strategy.hypothesisKey, summary: sanitizeText(strategy.summary || '', { maxChars: 240 }), reason: sanitizeText(strategy.reason || '', { maxChars: 120 }),
      candidateId: strategy.candidateId || null, evaluationId: strategy.evaluationId || null, learnRunId: strategy.learnRunId || null, at
    });
  }
  out.rejectedStrategies = evictToCap(out.rejectedStrategies, CAPS.rejectedStrategies, item => referenced.has(item.hypothesisKey));

  // unresolved: one open note per familyKey, most recent note wins.
  for (const item of delta.unresolved || []) {
    if (!item || typeof item.familyKey !== 'string') { rejected(rejectedNow, 'unresolved', 'An unresolved item needs a familyKey.'); continue; }
    if (item.note !== undefined && !safeText(item.note, 'unresolved', rejectedNow)) continue;
    const existing = out.unresolved.find(u => u.familyKey === item.familyKey);
    const merged = { familyKey: item.familyKey, since: existing?.since || item.since || at, note: sanitizeText(item.note || '', { maxChars: 200 }) };
    if (existing) Object.assign(existing, merged); else out.unresolved.push(merged);
  }
  out.unresolved = evictToCap(out.unresolved, CAPS.unresolved);

  // nextExperiments: candidate hypotheses for the next run, priority-ordered by the caller.
  for (const experiment of delta.nextExperiments || []) {
    if (!experiment || typeof experiment.hypothesisKey !== 'string') { rejected(rejectedNow, 'nextExperiments', 'A next experiment needs a hypothesisKey.'); continue; }
    if (experiment.summary !== undefined && !safeText(experiment.summary, 'nextExperiments', rejectedNow)) continue;
    out.nextExperiments.push({ hypothesisKey: experiment.hypothesisKey, summary: sanitizeText(experiment.summary || '', { maxChars: 240 }), priority: Number.isInteger(experiment.priority) ? experiment.priority : 3, provenance: experiment.provenance || null });
  }
  out.nextExperiments = evictToCap(out.nextExperiments, CAPS.nextExperiments);

  // trends: one row per learnRunId, numeric only.
  for (const trend of delta.trends || []) {
    if (!trend || typeof trend.learnRunId !== 'string') { rejected(rejectedNow, 'trends', 'A trend needs a learnRunId.'); continue; }
    out.trends.push({ learnRunId: trend.learnRunId, at: trend.at || at, metrics: trend.metrics || {} });
  }
  out.trends = evictToCap(out.trends, CAPS.trends);

  // lineage: append-only candidate history.
  for (const item of delta.lineage || []) {
    if (!item || typeof item.candidateId !== 'string') { rejected(rejectedNow, 'lineage', 'A lineage entry needs a candidateId.'); continue; }
    out.lineage.push({ candidateId: item.candidateId, parentRevision: item.parentRevision || null, hypothesisKey: item.hypothesisKey || null, decision: item.decision || null, reason: item.reason || '', at: item.at || at });
  }
  out.lineage = evictToCap(out.lineage, CAPS.lineage);

  out.rejectedMemoryItems.push(...rejectedNow);
  out.rejectedMemoryItems = evictToCap(out.rejectedMemoryItems, CAPS.rejectedMemoryItems);

  return { memory: out, rejected: rejectedNow };
}

// The only view of memory that may reach a generation prompt: bounded, re-sanitized, and only these four buckets.
// Returns a plain object (never a string): the 6,000-char bound is enforced by trimming array entries, never by
// slicing serialized JSON, so what callers receive is always valid, well-typed data.
export function projectForPrompt(memory, { maxChars = 6000 } = {}) {
  const lessons = (memory.lessons || []).filter(l => l.status === 'confirmed' || l.status === 'provisional').map(l => sanitizeText(l.text, { maxChars: 240 }));
  const failureFamilies = [...(memory.failureFamilies || [])].filter(f => f.status === 'open').sort((a, b) => (b.count || 0) - (a.count || 0)).slice(0, 12)
    .map(f => ({ key: sanitizeText(f.key || '', { maxChars: 120 }), count: f.count, status: f.status }));
  const rejectedStrategies = (memory.rejectedStrategies || []).slice(-15).map(r => ({ hypothesisKey: r.hypothesisKey, summary: sanitizeText(r.summary || '', { maxChars: 240 }), reason: sanitizeText(r.reason || '', { maxChars: 120 }) }));
  const nextExperiments = (memory.nextExperiments || []).map(e => ({ hypothesisKey: e.hypothesisKey, summary: sanitizeText(e.summary || '', { maxChars: 240 }), priority: e.priority }));
  const projection = { lessons, failureFamilies, rejectedStrategies, nextExperiments };
  // Trim from the back of the least-recent-first buckets until the whole projection fits; every step stays valid JSON.
  while (JSON.stringify(projection).length > maxChars) {
    if (projection.rejectedStrategies.length) projection.rejectedStrategies.shift();
    else if (projection.nextExperiments.length) projection.nextExperiments.pop();
    else if (projection.failureFamilies.length) projection.failureFamilies.pop();
    else if (projection.lessons.length) projection.lessons.pop();
    else break;
  }
  return projection;
}
