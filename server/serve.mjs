// The private archive server: one small process for your own infrastructure (server/Dockerfile) that
//   1. every night, after pulling the repo so the state data files the GitHub jobs update are fresh, runs
//      scripts/ingest.mjs (your books in <CORPUS_DIR>/library and links in urls.md, filed per water) and then
//      scripts/build-corpus.mjs into CORPUS_DIR (a NAS folder; Google Drive syncs from there), and
//   2. serves that folder over HTTP to the app with a key, so the Info, Getting there and Camping tabs read the archive
//      straight from here (⚙️ gear → Your private archive → server address and key) and keep a copy on the phone.
// Put it behind your own HTTPS (reverse proxy, Cloudflare Tunnel, Tailscale): it speaks plain HTTP on PORT.
//
// Env: CORPUS_DIR (default /corpus), CORPUS_TOKEN (required; the key the app sends as "Authorization: Bearer <key>"),
//      PORT (8787), ALLOW_ORIGIN (https://mikegutberlet.github.io; where the app is served from), BUILD_HOUR (1, local
//      time, TZ honoured; -1 = never build here), BUILD_ON_START (1 = also build when the process starts),
//      INGEST (0 = skip the books-and-links step), MAPS (0 = skip the region map fill), and the builds' own
//      CORPUS_MINUTES, MAPS_MINUTES etc. (scripts/build-corpus.mjs, scripts/build-maps.mjs).
// Routes: GET /health (no key) → { ok, builtAt, waters, lastBuild }; GET /<st>/<id>.json, /<st>/index.json,
//         /tackle-box-private-corpus.json, /docs/<page>.md, and the region map packs /maps/index.json,
//         /maps/<region>/index.json, /maps/<region>/<z>/<x>/<y>.png (key required). Nothing else is served.

import http from 'node:http';
import { stat, readFile, mkdir, open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DIR = path.resolve(process.env.CORPUS_DIR || '/corpus');
const TOKEN = process.env.CORPUS_TOKEN;
const PORT = +(process.env.PORT || 8787);
const ORIGIN = process.env.ALLOW_ORIGIN || 'https://mikegutberlet.github.io';
const BUILD_HOUR = process.env.BUILD_HOUR == null ? 1 : +process.env.BUILD_HOUR;
const STATES = ['ca', 'nv', 'or'];
const REPO = fileURLToPath(new URL('..', import.meta.url));
if (!TOKEN || TOKEN.length < 16) { console.error('CORPUS_TOKEN must be set (16+ characters): the key the app sends'); process.exit(1); }
if (!Number.isInteger(BUILD_HOUR) || BUILD_HOUR > 23) { console.error('BUILD_HOUR must be an hour, 0–23, or -1 for never'); process.exit(1); }
await mkdir(path.join(DIR, 'logs'), { recursive: true });

// ---------- Serving ----------
const TYPES = { '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.png': 'image/png' };
// Map tiles never change once written (one file per tile), so the phone may keep them; everything else is live data.
const cacheHeader = ext => ext === '.png' ? 'public, max-age=31536000, immutable' : 'no-store';
// Under maps/: index.json, <region>/index.json or <region>/<z>/<x>/<y>.png with digit-only z/x/y. Nothing else (not regions.json or missing.json).
const mapsPath = p => (p.length === 2 && p[1] === 'index.json') || (p.length === 3 && /^[\w-]+$/.test(p[1]) && p[2] === 'index.json')
  || (p.length === 5 && /^[\w-]+$/.test(p[1]) && p.slice(2, 4).every(n => /^\d+$/.test(n)) && /^\d+\.png$/.test(p[4]));
const cors = res => { res.setHeader('Access-Control-Allow-Origin', ORIGIN); res.setHeader('Access-Control-Allow-Headers', 'Authorization'); res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS'); res.setHeader('Access-Control-Max-Age', '86400'); res.setHeader('Vary', 'Origin'); };
const send = (res, code, body, type = 'application/json; charset=utf-8') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };
let lastBuild = null;

async function health() {
  const pack = await stat(path.join(DIR, 'tackle-box-private-corpus.json')).catch(() => null);
  let waters = 0;
  for (const st of STATES) waters += (await readFile(path.join(DIR, st, 'index.json'), 'utf8').then(JSON.parse).catch(() => null))?.count ?? 0;
  return { ok: true, builtAt: pack?.mtime.toISOString() ?? null, waters, lastBuild };
}

async function handle(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, '{"error":"GET only"}');
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') return send(res, 200, JSON.stringify(await health()));
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, '{"error":"key required"}');
  // Only the archive's own files: two levels deep at most, json or markdown, no dot segments; or a region map file.
  const parts = url.pathname.split('/').filter(Boolean).map(p => { try { return decodeURIComponent(p); } catch { return '\0'; } });
  const ext = path.extname(parts.at(-1) ?? '');
  const ok = parts[0] === 'maps' ? mapsPath(parts)
    : parts.length && parts.length <= 2 && parts.every(p => /^[\w.-]+$/.test(p) && !p.startsWith('.')) && TYPES[ext] && ext !== '.png' && (parts.length === 1 || [...STATES, 'docs'].includes(parts[0]));
  if (!ok) return send(res, 404, '{"error":"not in the archive"}');
  const file = path.join(DIR, ...parts);
  const s = await stat(file).catch(() => null);
  if (!s?.isFile()) return send(res, 404, '{"error":"not in the archive"}');
  res.writeHead(200, { 'Content-Type': TYPES[ext], 'Content-Length': s.size, 'Last-Modified': s.mtime.toUTCString(), 'Cache-Control': cacheHeader(ext) });
  if (req.method === 'HEAD') return res.end();
  const fh = await open(file);
  try { await pipeline(fh.createReadStream(), res); } catch {} // the phone gave up mid-file: nothing to do
}
const server = http.createServer((req, res) => handle(req, res).catch(e => { console.error(e); if (!res.headersSent) send(res, 500, '{"error":"server error"}'); else res.destroy(); }));
server.listen(PORT, () => console.log(`archive server on :${PORT}, serving ${DIR} to ${ORIGIN}; nightly build at ${BUILD_HOUR < 0 ? 'never' : `${BUILD_HOUR}:00`}`));

// ---------- The nightly build ----------
// git pull first: the state data files (data/<st>/*.json) are what the GitHub jobs keep current, and the build reads them.
let building = false;
function run(cmd, args, log) {
  return new Promise(resolve => { const p = spawn(cmd, args, { cwd: REPO, env: { ...process.env, CORPUS_DIR: DIR }, stdio: ['ignore', log, log] }); p.on('close', code => resolve(code)); p.on('error', e => { log.write(`${cmd} failed: ${e.message}\n`); resolve(1); }); });
}
async function build() {
  if (building) return;
  building = true;
  const day = new Date().toISOString().slice(0, 10), fh = await open(path.join(DIR, 'logs', `${day}.log`), 'a'), log = fh.createWriteStream();
  log.write(`\n=== build ${new Date().toISOString()} ===\n`);
  const pulled = await run('git', ['pull', '--ff-only', '--quiet'], log);
  if (pulled) log.write('git pull failed; building from the checkout as it is\n');
  // Books and links first, so the catalogue and the pack the build writes carry tonight's passages. An ingest
  // failure is logged and the build still runs.
  const ing = process.env.INGEST === '0' ? null : await run('node', ['scripts/ingest.mjs'], log);
  if (ing !== null) log.write(`=== ingest exit ${ing} ===\n`);
  const code = await run('node', ['scripts/build-corpus.mjs'], log);
  log.write(`=== corpus exit ${code} ===\n`);
  // Region map tiles last: this step takes its whole MAPS_MINUTES budget most nights until the regions are filled.
  const maps = process.env.MAPS === '0' ? null : await run('node', ['scripts/build-maps.mjs'], log);
  lastBuild = { at: new Date().toISOString(), ok: code === 0, ingest: ing === null ? 'off' : ing === 0, maps: maps === null ? 'off' : maps === 0, log: `logs/${day}.log` };
  log.write(`=== done, exit ${code}${maps === null ? '' : `, maps exit ${maps}`} ===\n`);
  log.end(); building = false;
  const part = (name, c) => c === null ? '' : `, ${name} ${c === 0 ? 'ok' : `failed (exit ${c})`}`;
  console.log(`build ${lastBuild.ok ? 'ok' : `failed (exit ${code})`}${part('ingest', ing)}${part('maps', maps)}, see ${lastBuild.log}`);
}
function schedule() {
  if (BUILD_HOUR < 0) return;
  const next = new Date(); next.setHours(BUILD_HOUR, 0, 0, 0); if (next <= new Date()) next.setDate(next.getDate() + 1);
  setTimeout(() => build().finally(schedule), next - new Date());
}
schedule();
if (process.env.BUILD_ON_START === '1') build();
