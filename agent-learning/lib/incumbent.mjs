// Owns: freezing a verifiable snapshot of the agent runtime a candidate branches from, and the protected-region
// hash mechanism candidates.mjs (a different lane) uses to detect a touch on governed code. Contract:
// docs/AGENT_LEARNING_LOOP.md section 3, and section 7's protected-region list.
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import * as nodeChildProcess from 'node:child_process';
import { TOOLS, listTools } from '../../lib/agent/tools.mjs';
import { systemPrompt, PLAN_SCHEMA } from '../../lib/agent/planner.mjs';
import { loadConfig, describeConfig } from '../../lib/agent/config.mjs';

const sha256 = text => createHash('sha256').update(text).digest('hex');

// Missing lib/agent/recovery.mjs, breakers.mjs or resume.mjs (still being written alongside this module) hash as
// the literal string 'absent', never throw: an incumbent frozen mid-build of the runtime is still a valid,
// comparable snapshot, just one where that surface has not landed yet.
function hashFile(path) {
  try { return sha256(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return 'absent'; throw error; }
}

// Files with a protected region: not fully off-limits to a candidate (candidates.mjs's own PROTECTED list, section
// 7, owns full-file bans), but these regions inside them are frozen with the incumbent and any change to one
// routes the candidate to needs_human_review.
export const PROTECTED_FILES = [
  'lib/agent/effects.mjs',
  'lib/agent/providers/stripe.mjs',
  'lib/agent/planner.mjs',
  'lib/agent/tools.mjs'
];

// One marker regex names one region; a region's hash covers every line in its file that matches that regex, in
// file order. Names are this module's own labels (the contract names the markers, not names for each); they are
// what shows up in protected.<file>.regions[].name and in a candidate record's governanceTouch.regions.
export const PROTECTED_MARKERS = {
  'lib/agent/effects.mjs': [
    { name: 'REFUND_NOT_HELD', pattern: /REFUND_NOT_HELD/ },
    { name: 'governedClaim', pattern: /deps\.governed\.claim\(/ },
    { name: 'allowUnheldRefunds', pattern: /allowUnheldRefunds/ },
    { name: 'STRIPE_LIVE_REFUSED', pattern: /STRIPE_LIVE_REFUSED/ },
    { name: 'boundToCustomer', pattern: /boundToCustomer/ },
    { name: 'awaitDecision', pattern: /async function awaitDecision/ },
    { name: 'approvedBy', pattern: /approvedBy/ },
    // The financial precondition block of stripe.refund_payment (section 7), a marker of its own: without it the
    // guard at `spec.financial && !deps.config?.flags?.allowUnheldRefunds` was only ever covered incidentally by
    // the allowUnheldRefunds line match.
    { name: 'financial', pattern: /spec\.financial/ }
  ],
  'lib/agent/providers/stripe.mjs': [
    { name: 'guardWrite', pattern: /guardWrite/ },
    { name: 'allowLive', pattern: /allowLive/ }
  ],
  'lib/agent/planner.mjs': [
    { name: 'untrustedData', pattern: /untrusted data/ },
    { name: 'blockedIsFinal', pattern: /blocked or rejected action is final/ }
  ],
  'lib/agent/tools.mjs': [
    { name: 'writeTools', pattern: /WRITE_TOOLS=/ },
    { name: 'readHandlers', pattern: /READ_HANDLERS=/ }
  ]
};

// A region is the marker's own line, extended forward while the running `{`/`}` balance stays open — this captures
// a whole function body (`async function awaitDecision`) or a whole precondition block (`if(spec.financial...){`)
// when the marker opens one, and is just the single line when it does not (`REFUND_NOT_HELD`, `approvedBy`). This
// replaces a line-filter approach that hashed only the lines literally containing the marker token: a change to any
// non-marker line inside the same function or block (for example the `break;` inside `awaitDecision`'s loop) went
// undetected under that approach, which defeats section 7's "changes the awaitDecision function ... routed to
// needs_human_review". Returns null when the marker matches no line in the file (never crashes on a moved marker).
function extractRegion(lines, pattern) {
  const at = lines.findIndex(line => pattern.test(line));
  if (at === -1) return null;
  let end = at, balance = (lines[at].match(/\{/g) || []).length - (lines[at].match(/\}/g) || []).length;
  while (balance > 0 && end < lines.length - 1) {
    end++;
    balance += (lines[end].match(/\{/g) || []).length - (lines[end].match(/\}/g) || []).length;
  }
  return lines.slice(at, end + 1).join('\n');
}

export function protectedRegionHashes(root) {
  const out = {};
  for (const file of PROTECTED_FILES) {
    const markers = PROTECTED_MARKERS[file];
    let lines = null;
    try { lines = readFileSync(join(root, file), 'utf8').split('\n'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    out[file] = {
      regions: markers.map(marker => {
        const region = lines ? extractRegion(lines, marker.pattern) : null;
        return { name: marker.name, sha256: region !== null ? sha256(region) : 'absent' };
      })
    };
  }
  return out;
}

// sha256 over the sorted regression ids+hashes in one set (dev or holdout), read directly off disk: this is what
// lets `compare` refuse a candidate whose parentRevision's corpus does not match the evaluation it ran against.
function corpusHash(dir) {
  let names;
  try { names = readdirSync(dir).filter(name => name.endsWith('.json')); }
  catch (error) { if (error.code === 'ENOENT') return 'absent'; throw error; }
  const rows = names.map(name => {
    const text = readFileSync(join(dir, name), 'utf8');
    let id = name;
    try { id = JSON.parse(text).id || name; } catch { /* malformed scenario file: fall back to the filename as its id */ }
    return { id, hash: sha256(text) };
  }).sort((a, b) => a.id.localeCompare(b.id));
  return sha256(rows.map(r => `${r.id}:${r.hash}`).join('|'));
}

export async function freezeIncumbent({ root, now = () => new Date().toISOString(), git = nodeChildProcess } = {}) {
  if (!root) throw new Error('freezeIncumbent needs a root.');
  const revision = git.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const statusText = git.execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  const dirty = statusText.trim().length > 0;

  const hashes = {
    systemPrompt: sha256(systemPrompt(TOOLS)),
    toolSchemas: sha256(JSON.stringify(listTools())),
    planSchema: sha256(JSON.stringify(PLAN_SCHEMA)),
    effectsSpecs: hashFile(join(root, 'lib/agent/effects.mjs')),
    recoveryPolicy: hashFile(join(root, 'lib/agent/recovery.mjs')),
    breakerPolicy: hashFile(join(root, 'lib/agent/breakers.mjs')),
    adapters: {
      stripe: hashFile(join(root, 'lib/agent/providers/stripe.mjs')),
      hubspot: hashFile(join(root, 'lib/agent/providers/hubspot.mjs')),
      gmail: hashFile(join(root, 'lib/agent/providers/gmail.mjs')),
      slack: hashFile(join(root, 'lib/agent/providers/slack.mjs'))
    },
    http: hashFile(join(root, 'lib/agent/http.mjs')),
    governed: hashFile(join(root, 'lib/agent/governed.mjs')),
    corpus: {
      dev: corpusHash(join(root, 'agent-learning/regressions/dev')),
      holdout: corpusHash(join(root, 'agent-learning/regressions/holdout'))
    }
  };

  let dashclawSdk = null;
  try { dashclawSdk = JSON.parse(readFileSync(join(root, 'node_modules/dashclaw/package.json'), 'utf8')).version || null; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  const config = describeConfig(loadConfig({ root, loadFile: false }));

  return { frozenAt: now(), revision, dirty, hashes, dashclawSdk, config, protected: protectedRegionHashes(root) };
}
