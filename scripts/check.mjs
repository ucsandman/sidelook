import { execFileSync } from 'node:child_process';
import { readdir, readFile, access } from 'node:fs/promises';
import { assets } from '../server.mjs';
const files = ['server.mjs'];
// lib/agent and eval nest one level (providers); every JavaScript file under them is checked like the rest.
const listJs = async dir => (await readdir(dir,{ withFileTypes:true,recursive:true })).filter(entry => entry.isFile() && /\.(mjs|js)$/.test(entry.name)).map(entry => `${entry.parentPath.replaceAll('\\','/')}/${entry.name}`);
for (const dir of ['lib','public','site','scripts','tests','eval']) {
  files.push(...await listJs(dir).catch(() => []));
}
for (const file of files) execFileSync(process.execPath,['--check',file],{ stdio:'pipe' });

// Every served route must exist on disk, and every local reference in public/ must be a served route.
const routes = new Map([...assets].map(([route,[name]]) => [route,name]));
for (const [route,name] of routes) await access(`public/${name}`).catch(() => { throw new Error(`Asset route ${route} points at a missing file public/${name}.`); });
let references = 0;
const sources = (await readdir('public')).filter(file => /\.(html|js|css)$/.test(file));
for (const file of sources) {
  const text = await readFile(`public/${file}`,'utf8');
  const found = [...text.matchAll(/(?:src|href)="(\/[^"?#]*)"|from\s+'\.\/([^']+)'|import\('\/([^']+)'\)|url\(\/([^)]+)\)/g)].map(m => m[1] || `/${m[2] || m[3] || m[4]}`);
  for (const path of found) {
    references++;
    if (!routes.has(path)) throw new Error(`public/${file} references ${path}, which server.mjs does not serve.`);
  }
}

// Type floor: nothing under 12px in the app, per PRODUCT.md.
let declarations = 0, stylesheets = 0;
for (const file of sources.filter(f => f.endsWith('.css'))) {
  stylesheets++;
  const text = await readFile(`public/${file}`,'utf8');
  const small = [...text.matchAll(/font(?:-size)?\s*:[^;{}]*?\b([1-9]|1[01])px/g)];
  declarations += small.length;
  if (small.length) throw new Error(`public/${file} has ${small.length} font declaration(s) under 12px, first: "${small[0][0]}".`);
}

// The clipboard is write-only. A read would make "screen & mic off" untrue, so none may exist in the page or the shell.
let clipboardReads = 0, clipboardFiles = 0;
const shipped = ['server.mjs', ...sources.map(f => `public/${f}`), ...await listJs('lib'), ...(await readdir('desktop')).filter(f => /\.cs$/.test(f)).map(f => `desktop/${f}`), ...(await readdir('scripts')).filter(f => /\.(cs|ps1|cmd)$/.test(f)).map(f => `scripts/${f}`)];
for (const file of shipped) {
  clipboardFiles++;
  const text = await readFile(file,'utf8');
  clipboardReads += (text.match(/clipboard\.readText\(|clipboard\.read\(|Clipboard\.(GetText|GetData|GetDataObject|Contains\w*|GetImage|GetFileDropList)\(|GetClipboardData|Get-Clipboard|OpenClipboard/g) || []).length;
}
if (clipboardReads) throw new Error(`${clipboardReads} clipboard read site(s) found; the clipboard is write-only.`);

const html = await readFile('public/index.html','utf8');
if (!html.includes('name="robots" content="noindex,nofollow"')) throw new Error('Missing local-app noindex.');

// The product is Sidelook. The old name may survive only on lines marked `legacy` (kernel object names that keep the upgrade path,
// the old profile folder) and in history files, which are not scanned. Anything else is a miss the retro should record.
const gateFiles = [...new Set([
  ...shipped, ...files, 'package.json', 'README.md', 'PRODUCT.md', 'DESIGN.md', 'CONTRIBUTING.md', 'SECURITY.md',
  'docs/COMPUTER.md', 'docs/MODELS.md', 'docs/WINDOWS.md', 'docs/SITE.md', 'Start Sidelook.cmd', '.env.example',
  ...(await readdir('public')).filter(f => /\.(html|css)$/.test(f)).map(f => `public/${f}`),
  ...(await readdir('site')).filter(f => /\.(html|css|js|json)$/.test(f)).map(f => `site/${f}`),
  ...(await readdir('scripts')).filter(f => /\.(mjs|ps1|cmd)$/.test(f)).map(f => `scripts/${f}`),
  ...(await readdir('tests')).map(f => `tests/${f}`),
])].filter(f => f !== 'site/vercel.json'); // its redirect source must keep matching the old Vercel project host
// docs/SITE.md is a runbook followed by a release log. The log is history (old exe names, the old host) and is not scanned;
// the scan stops at the first version heading, which is where the log begins.
const runbookOnly = new Map([['docs/SITE.md', /^## \d/]]);
let legacyLines = 0; const missing = [], nameHits = [];
for (const file of gateFiles) {
  if (!(await access(file).then(() => true, () => false))) { missing.push(file); continue; }
  let lines = (await readFile(file,'utf8')).split('\n');
  const logStart = runbookOnly.get(file);
  if (logStart) { const at = lines.findIndex(line => logStart.test(line)); if (at > 0) lines = lines.slice(0,at); }
  // The next line holds both words, so the gate counts itself as one of the legacy lines below.
  lines.forEach((line,i) => { if (!/jarvis/i.test(line)) return; if (/legacy/.test(line)) { legacyLines++; return; } nameHits.push(`${file}:${i+1}`); });
}
if (missing.length) throw new Error(`Name gate could not read ${missing.length} listed file(s): ${missing.join(', ')}`);
if (nameHits.length) throw new Error(`Old product name in ${nameHits.length} place(s): ${nameHits.slice(0,12).join(', ')}`);
// 19 today: thirteen kernel object names the upgrade path needs (the launcher, Computer.cs and the four lifecycle checks that
// open them), two profile-folder moves, the IndexedDB name, two localStorage fallbacks, and the counting line above, which
// holds both words itself.
if (legacyLines > 19) throw new Error(`${legacyLines} legacy-marked lines; the allowance is 19.`);

console.log(`PASS: syntax checked ${files.length} JavaScript files; assets: ${routes.size} routes on disk, ${references} references resolved; scanned ${stylesheets} stylesheets, ${declarations} declarations under 12px; ${clipboardFiles} files scanned, ${clipboardReads} clipboard reads; local page is noindex.; name gate: ${gateFiles.length} files, ${legacyLines} legacy lines`);
