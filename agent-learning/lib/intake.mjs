// Owns: reading runtime evidence off disk and turning it into the bounded, allowlisted shape the rest of the
// learning loop is allowed to see. Nothing here copies free text: a run's goal becomes a length, its events become
// counts, its effects keep only the fields section 4 names. Contract: docs/AGENT_LEARNING_LOOP.md section 4.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { STATES } from '../../lib/agent/run.mjs';
import { sanitizeText } from './sanitize.mjs';

// lib/agent/incidents.mjs's sanitizeIncident() is the canonical sanitizer for the runtime's own Incident shape
// (docs/AGENT_SELF_HEALING.md section 2); reuse it when it is there. It may not be (the lane brief says do not
// wait for it), so a local fallback mirrors the same field list and the same scrub rules.
let cachedSanitizeIncident = null;
async function resolveSanitizeIncident() {
  if (cachedSanitizeIncident) return cachedSanitizeIncident;
  try {
    const mod = await import('../../lib/agent/incidents.mjs');
    cachedSanitizeIncident = typeof mod.sanitizeIncident === 'function' ? mod.sanitizeIncident : localSanitizeIncident;
  } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    cachedSanitizeIncident = localSanitizeIncident;
  }
  return cachedSanitizeIncident;
}

const INCIDENT_FIELDS = ['incidentId', 'runId', 'at', 'updatedAt', 'integration', 'tool', 'operation', 'phase', 'failureClass', 'family',
  'severity', 'providerStatus', 'attemptNumber', 'providerOperationId', 'dashclawActionId', 'effectId', 'knownState',
  'uncertainState', 'recoveryAttempted', 'recoveryStrategy', 'recoveryResult', 'verificationResult', 'finalDisposition'];

function localSanitizeIncident(incident) {
  const out = {};
  for (const key of INCIDENT_FIELDS) out[key] = incident?.[key] ?? null;
  out.operation = sanitizeText(out.operation, { maxChars: 200 });
  const evidence = incident?.sanitizedEvidence || {};
  out.sanitizedEvidence = {
    code: String(evidence.code || '').slice(0, 64),
    message: sanitizeText(evidence.message, { maxChars: 300 }),
    ids: evidence.ids && typeof evidence.ids === 'object' ? evidence.ids : {}
  };
  return out;
}

async function listJsonFiles(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return entries.filter(e => e.isFile() && e.name.endsWith('.json')).map(e => join(dir, e.name)).sort();
}

function isRunLike(raw) {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw)
    && typeof raw.runId === 'string' && STATES.includes(raw.status)
    && Array.isArray(raw.events) && Array.isArray(raw.effects) && Array.isArray(raw.approvals);
}

function isIncidentLike(raw) {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw) && typeof raw.incidentId === 'string' && typeof raw.runId === 'string';
}

// Events survive intake only as counts by kind then status: never the label, detail or evidence of any one event.
function countEvents(events) {
  const counts = {};
  for (const event of events) {
    const kind = String(event?.kind || 'unknown');
    const status = String(event?.status || 'unknown');
    counts[kind] = counts[kind] || {};
    counts[kind][status] = (counts[kind][status] || 0) + 1;
  }
  return counts;
}

// Pure and exported so a test can assert the allowlist directly without touching disk. `sanitizeIncidentFn`
// defaults to the local fallback; readEvidence passes the resolved (possibly runtime) sanitizer in.
export function summarizeRun(run, sanitizeIncidentFn = localSanitizeIncident) {
  const effects = Array.isArray(run.effects) ? run.effects.map(e => ({
    effectId: e?.effectId ?? null, tool: e?.tool ?? null, app: e?.app ?? null, opKey: e?.opKey ?? null, status: e?.status ?? null,
    attempts: e?.attempts ?? 0, executions: e?.executions ?? 0,
    reconciliations: Array.isArray(e?.reconciliations) ? e.reconciliations.map(r => ({ finding: r?.finding ?? null, sweep: !!r?.sweep })) : [],
    verification: { verified: e?.verification?.verified ?? null }, error: { code: e?.error?.code ?? null },
    actionId: e?.actionId ?? null, series: e?.series ?? null
  })) : [];
  const approvals = Array.isArray(run.approvals) ? run.approvals.map(a => ({ status: a?.status ?? null, decidedVia: a?.decidedVia ?? null })) : [];
  const errors = Array.isArray(run.errors) ? run.errors.map(er => ({ code: er?.code ?? null, step: er?.step ?? null })) : [];
  const incidents = Array.isArray(run.incidents) ? run.incidents.map(sanitizeIncidentFn) : [];
  const injection = Array.isArray(run.injection) ? run.injection.map(i => ({ source: i?.source ?? null, riskLevel: i?.riskLevel ?? null, categories: Array.isArray(i?.categories) ? i.categories : [] })) : [];
  return {
    runId: run.runId, createdAt: run.createdAt ?? null, status: run.status, model: run.model ?? null, effort: run.effort ?? null,
    turn: run.turn ?? 0, summary: run.summary ?? null, effects, approvals, errors, incidents, injection,
    resume: run.resume ?? null, lineage: { rootRunId: run.lineage?.rootRunId ?? null }, events: countEvents(Array.isArray(run.events) ? run.events : []),
    goalLength: typeof run.goal === 'string' ? run.goal.length : 0
  };
}

export async function readEvidence({ dataDir, since = null, evalReportPath = null } = {}) {
  if (!dataDir) throw new Error('readEvidence needs a dataDir.');
  const sanitizeIncidentFn = await resolveSanitizeIncident();

  const runFiles = await listJsonFiles(join(dataDir, 'runs'));
  const runs = [];
  let runsRead = 0, runsSkipped = 0;
  for (const file of runFiles) {
    let raw;
    try { raw = JSON.parse(await readFile(file, 'utf8')); }
    catch { runsSkipped++; continue; }
    if (!isRunLike(raw)) { runsSkipped++; continue; }
    if (since && raw.createdAt && raw.createdAt < since) continue; // older than the last intake: neither read nor skipped
    runs.push(summarizeRun(raw, sanitizeIncidentFn));
    runsRead++;
  }

  const incidentFiles = await listJsonFiles(join(dataDir, 'incidents'));
  const incidents = [];
  let incidentsRead = 0, incidentsSkipped = 0;
  for (const file of incidentFiles) {
    let raw;
    try { raw = JSON.parse(await readFile(file, 'utf8')); }
    catch { incidentsSkipped++; continue; }
    if (!isIncidentLike(raw)) { incidentsSkipped++; continue; }
    if (since && raw.at && raw.at < since) continue; // older than the last intake: neither read nor skipped
    incidents.push(sanitizeIncidentFn(raw));
    incidentsRead++;
  }

  let evalReport = null, evalReportError = null;
  if (evalReportPath) {
    try { evalReport = JSON.parse(await readFile(evalReportPath, 'utf8')); }
    catch (error) { evalReport = null; evalReportError = error.code === 'ENOENT' ? null : (error.message || String(error)); }
  }

  return { runs, incidents, evalReport, counts: { runsRead, runsSkipped, incidentsRead, incidentsSkipped, evalReportError } };
}
