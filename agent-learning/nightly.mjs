#!/usr/bin/env node
// The nightly runner: one bounded, locked, deadline-limited invocation of the learning loop, written down whatever happens.
// It proposes and evaluates; it never merges, pushes or touches DashClaw policy. Promotion stays with a person
// (docs/AGENT_LEARNING_LOOP.md section 14). Installed on Windows by scripts/install-agent-learn-task.ps1.
//   node agent-learning/nightly.mjs [--deadline-minutes 90] [--model <id>] [--review-model <id>] [--max-candidates 2] [--keep 14]
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir, rm, open } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const HEARTBEAT_MS = 30000, STALE_MS = 10 * 60000;

// The two model choices a scheduled run needs come from the repository .env (a scheduled task carries no shell environment);
// only those two keys are read, line by line, and nothing else in that file ever enters this process.
export function learnSettingsFromEnvFile(text = '') {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(AGENT_LEARN_MODEL|AGENT_LEARN_REVIEW_MODEL)\s*=\s*"?([A-Za-z0-9._:-]{1,60})"?\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
function envFileSettings() {
  try { return learnSettingsFromEnvFile(readFileSync(join(REPO_ROOT, '.env'), 'utf8')); } catch { return {}; }
}

export function parseArgs(argv = [], env = process.env, fromFile = envFileSettings()) {
  const args = { deadlineMinutes: 90, model: env.AGENT_LEARN_MODEL || fromFile.AGENT_LEARN_MODEL || null, reviewModel: env.AGENT_LEARN_REVIEW_MODEL || fromFile.AGENT_LEARN_REVIEW_MODEL || null, maxCandidates: 2, keep: 14,
    root: env.AGENT_LEARN_ROOT || join(REPO_ROOT, '.artifacts', 'agent-learning'), learnScript: join(REPO_ROOT, 'agent-learning', 'learn.mjs'), data: env.SIDELOOK_AGENT_DATA || null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--deadline-minutes') args.deadlineMinutes = Number(argv[++i]);
    else if (a === '--model') args.model = argv[++i];
    else if (a === '--review-model') args.reviewModel = argv[++i];
    else if (a === '--max-candidates') args.maxCandidates = Number(argv[++i]);
    else if (a === '--keep') args.keep = Number(argv[++i]);
    else if (a === '--root') args.root = argv[++i];
    else if (a === '--learn-script') args.learnScript = argv[++i];
    else if (a === '--data') args.data = argv[++i];
  }
  if (!(args.deadlineMinutes > 0)) args.deadlineMinutes = 90;
  if (!(args.keep >= 1)) args.keep = 14;
  return args;
}

const stamp = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

// The lock is a file naming the holder and its last heartbeat; a holder that is dead, or silent past STALE_MS, is taken over.
async function takeLock(path, now) {
  let current = null;
  try { current = JSON.parse(await readFile(path, 'utf8')); } catch { /* no lock */ }
  if (current && Number.isInteger(current.pid) && current.pid !== process.pid && alive(current.pid) && now() - Date.parse(current.heartbeat || 0) < STALE_MS) {
    return { ok: false, holder: current };
  }
  await writeFile(path, JSON.stringify({ pid: process.pid, startedAt: new Date(now()).toISOString(), heartbeat: new Date(now()).toISOString() }), 'utf8');
  return { ok: true };
}

function killTree(child) {
  if (process.platform === 'win32') { try { spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true }); } catch { /* best effort */ } }
  else { try { child.kill('SIGTERM'); } catch { /* best effort */ } }
}

async function summarize(outDir) {
  try {
    const s = JSON.parse(await readFile(join(outDir, 'learning_summary.json'), 'utf8'));
    const candidates = s.candidates || [];
    return { learnRunId: s.learnRunId || null, candidates: candidates.length, promoteEligible: candidates.filter(c => c.decision === 'promote_eligible' || c.status === 'promote_eligible').length,
      rejected: candidates.filter(c => /^rejected/.test(c.decision || c.status || '')).length, needsHumanReview: candidates.filter(c => (c.decision || c.status) === 'needs_human_review').length, reportPath: join(outDir, 'learning_report.md') };
  } catch { return null; }
}

// Old nightly directories beyond `keep` go; the durable records under agent-learning/ are never touched here.
async function prune(root, keep) {
  const dirs = (await readdir(root, { withFileTypes: true }).catch(() => [])).filter(d => d.isDirectory() && /^nightly-\d{8}T/.test(d.name)).map(d => d.name).sort();
  const doomed = dirs.slice(0, Math.max(0, dirs.length - keep));
  for (const name of doomed) await rm(join(root, name), { recursive: true, force: true }).catch(() => {});
  return doomed.length;
}

export async function runNightly(options = {}) {
  const now = options.now || Date.now;
  const args = { ...parseArgs([], options.env || process.env), ...options };
  const root = resolve(args.root);
  await mkdir(root, { recursive: true });
  const lockPath = join(root, 'nightly.lock'), statusPath = join(root, 'nightly-status.json');
  const startedAt = new Date(now()).toISOString();
  const lock = await takeLock(lockPath, now);
  if (!lock.ok) {
    const status = { startedAt, finishedAt: startedAt, status: 'skipped_locked', holder: lock.holder, outDir: null, summary: null };
    await writeFile(statusPath, JSON.stringify(status, null, 2), 'utf8');
    return status;
  }
  const outDir = join(root, `nightly-${stamp(new Date(now()))}`);
  await mkdir(outDir, { recursive: true });
  const logHandle = await open(join(outDir, 'nightly.log'), 'w');
  const learnArgs = [args.learnScript, '--out', outDir, '--max-candidates', String(args.maxCandidates), ...(args.model ? ['--model', args.model] : []), ...(args.reviewModel ? ['--review-model', args.reviewModel] : []), ...(args.data ? ['--data', args.data] : [])];
  let status = 'failed', exitCode = null, timedOut = false;
  const child = spawn(process.execPath, learnArgs, { cwd: REPO_ROOT, stdio: ['ignore', logHandle.fd, logHandle.fd], windowsHide: true });
  const heartbeat = setInterval(() => { writeFile(lockPath, JSON.stringify({ pid: process.pid, startedAt, heartbeat: new Date(now()).toISOString() }), 'utf8').catch(() => {}); }, HEARTBEAT_MS);
  const deadline = setTimeout(() => { timedOut = true; killTree(child); }, args.deadlineMinutes * 60000);
  exitCode = await new Promise(resolve => { child.once('exit', code => resolve(code)); child.once('error', () => resolve(1)); });
  clearInterval(heartbeat); clearTimeout(deadline);
  await logHandle.close();
  if (timedOut) status = 'timed_out';
  else status = exitCode === 0 ? 'completed' : 'failed';
  const summary = await summarize(outDir);
  const pruned = await prune(root, args.keep);
  const result = { startedAt, finishedAt: new Date(now()).toISOString(), status, exitCode, deadlineMinutes: args.deadlineMinutes, model: args.model || 'none (template-only)', outDir, log: join(outDir, 'nightly.log'), summary, pruned,
    promotion: 'never automatic: a person runs learn.mjs --promote and merges' };
  await writeFile(statusPath, JSON.stringify(result, null, 2), 'utf8');
  await rm(lockPath, { force: true }).catch(() => {});
  return result;
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === resolve(fileURLToPath(import.meta.url)).toLowerCase()) {
  const args = parseArgs(process.argv.slice(2));
  runNightly(args).then(result => {
    const s = result.summary;
    console.log(`nightly ${result.status}${s ? `: ${s.candidates} candidate(s), ${s.promoteEligible} promote_eligible, ${s.rejected} rejected, ${s.needsHumanReview} needs_human_review` : ''}${result.outDir ? ` · ${result.outDir}` : ''}`);
    process.exitCode = result.status === 'completed' ? 0 : result.status === 'skipped_locked' ? 2 : 1;
  }).catch(error => { console.error(error); process.exitCode = 1; });
}
