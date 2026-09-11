import { mkdir, readFile, readdir, writeFile, copyFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

// A fixed allowlist keeps the local server, credentials and artifacts out of hosting.
const out = '.artifacts/site';
const origin = 'https://sidelook.practicalsystems.io';
await mkdir(out, { recursive:true });
// Remove the obsolete generated sample; the local app keeps its own example.
for (const file of ['demo.html','reference.svg','workbench.png','revision.png']) await unlink(join(out,file)).catch(error=>{if(error.code!=='ENOENT') throw error;});
const allowed = new Set(['index.html','site.css','site.js','vercel.json','mark.svg','plus-jakarta-sans-700.woff2','plus-jakarta-sans-OFL.txt','streaming.png','computer.png','companion.png','share.png','direct.png','versions.png','og.png','robots.txt','sitemap.xml','llms.txt','.vercel','.env.local','.gitignore']);
for (const name of await readdir(out)) if (!allowed.has(name)) throw new Error(`Unexpected deployment file: ${name}. Review it before building.`);
for (const file of ['index.html','site.css','site.js','vercel.json','plus-jakarta-sans-700.woff2','plus-jakarta-sans-OFL.txt']) await copyFile(join('site',file),join(out,file));
for (const [source,target] of [['public/mark.svg','mark.svg'],['docs/images/streaming.png','streaming.png'],['docs/images/social.png','og.png'],['docs/images/computer.png','computer.png'],['docs/images/companion.png','companion.png'],['docs/images/share.png','share.png'],['docs/images/direct.png','direct.png'],['docs/images/versions.png','versions.png']]) await copyFile(source,join(out,target));
await writeFile(join(out,'robots.txt'),`User-agent: *\nAllow: /\nDisallow: /demo.html\nDisallow: /api/\nDisallow: /dashboard/\nDisallow: /thanks/\nSitemap: ${origin}/sitemap.xml\n`);
await writeFile(join(out,'sitemap.xml'),`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/</loc></url></urlset>\n`);
await writeFile(join(out,'llms.txt'),`# sidelook

> A local Windows desktop companion. Ask about the window you're in, turn a sketch into a working web prototype, or work a Windows app one approved action at a time. Runs on the user's own ChatGPT (OpenAI models through Codex) or Claude (Anthropic models through Claude Code) subscription, any model in the catalog. No API key, no metered model API, no model fallback.

- [Website](${origin}/): A prepared walkthrough with captured screenshots of the companion, the builder and Computer mode. The site does not run inference, take a login, or control anything.
- [Source and download](https://github.com/ucsandman/sidelook): MIT-licensed Node.js server plus a Windows launcher that bundles Node and the official Codex CLI. Setup downloads and verifies Claude Code from Anthropic when Fable is chosen. Fable can spend paid Claude usage credits.
- [Practical Systems](https://practicalsystems.io): the company behind Sidelook.

## Companion

Ctrl+Shift+Space opens a compact native panel (WinForms hosting WebView2 in its own persistent profile). It keeps a bounded in-session conversation, does not listen continuously or monitor the screen, and only captures the current window when the user asks for a screenshot. The exact frame is shown before it is sent. Explicit buttons open the builder or Computer mode. Revisions from a browser profile are not imported automatically; Settings, then Import a saved HTML prototype, accepts exported HTML up to 120,000 bytes when the 12-version history has room.

## Builder

Screen or window sharing is the main input. Live build sends changed snapshots after three quiet seconds, at least 30 seconds apart by default (60 seconds or two minutes selectable), ten builds per start, with separate consent. Camera frames, JPEG/PNG/WebP upload, typed directions and local Windows dictation also work. Fable streams incremental HTML drafts with scripts disabled until the finished result validates; Astra's CLI returns finished messages. Desktop, mobile and expanded previews, source view, single-file HTML download, retry preview and up to 12 saved versions are available. A built-in sample needs no login. Generated pages run in a sandboxed iframe with no network, nested frames, camera or microphone.

## Computer mode

Opt-in Windows accessibility control through the same subscription models. Inspect a selected window's accessible tree locally, then plan one action at a time: click, replace text, scroll, supported shortcuts, focus, or open Notepad, Calculator or Paint. Every action needs a single-use approval that expires after one minute. Sessions last ten minutes with at most 20 model steps. Ctrl+Shift+F12 stops control from any app. Planning sends fresh accessible text after consent, never screenshots or audio. No shell tool, canvas drawing, Explorer, terminal or address-bar control, coordinate clicking or administrator prompts.
`);
const html = await readFile(join(out,'index.html'),'utf8');
if (!html.includes(origin) || html.includes('<iframe')) throw new Error('Missing canonical URL or unexpected embedded sample.');
console.log('PASS: built allowlisted public files; no local server or account data included.');
