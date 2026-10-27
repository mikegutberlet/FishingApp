// The private archive server: one small process for your own infrastructure (server/Dockerfile) that
//   1. runs scripts/build-corpus.mjs every night into CORPUS_DIR (a NAS folder; Google Drive syncs from there), after
//      pulling the repo so the state data files the GitHub jobs update are fresh, and
//   2. serves that folder over HTTP to the app with a key, so the Info, Getting there and Camping tabs read the archive
//      straight from here (⚙️ gear → Your private archive → server address and key) and keep a copy on the phone.
// Put it behind your own HTTPS (reverse proxy, Cloudflare Tunnel, Tailscale): it speaks plain HTTP on PORT.
//
// Env: CORPUS_DIR (default /corpus), CORPUS_TOKEN (required; the key the app sends as "Authorization: Bearer <key>"),
//      PORT (8787), ALLOW_ORIGIN (https://mikegutberlet.github.io; where the app is served from), BUILD_HOUR (1, local
//      time, TZ honoured; -1 = never build here), BUILD_ON_START (1 = also build when the process starts),
//      and the build's own CORPUS_MINUTES etc. (scripts/build-corpus.mjs).
// Routes: GET /health (no key) → { ok, builtAt, waters, lastBuild }; GET /<st>/<id>.json, /<st>/index.json,
//         /tackle-box-private-corpus.json, /docs/<page>.md (key required). Nothing else is served.

import http from 'node:http';
import { stat, readFile, mkdir, open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const DIR = path.resolve(process.env.CORPUS_DIR || '/corpus');
const TOKEN = process.env.CORPUS_TOKEN;
const PORT = +(process.env.PORT || 8787);
const ORIGIN = process.env.ALLOW_ORIGIN || 'https://mikegutberlet.github.io';
const BUILD_HOUR = process.env.BUILD_HOUR == null ? 1 : +process.env.BUILD_HOUR;
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
if (!TOKEN || TOKEN.length < 16) { console.error('CORPUS_TOKEN must be set (16+ characters): the key the app sends'); process.exit(1); }
await mkdir(path.join(DIR, 'logs'), { recursive: true });

// ---------- Serving ----------
const TYPES = { '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8' };
const cors = res => { res.setHeader('Access-Control-Allow-Origin', ORIGIN); res.setHeader('Access-Control-Allow-Headers', 'Authorization'); res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS'); res.setHeader('Access-Control-Max-Age', '86400'); res.setHeader('Vary', 'Origin'); };
const send = (res, code, body, type = 'application/json; charset=utf-8') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };
let lastBuild = null;

async function health() {
  const pack = await stat(path.join(DIR, 'tackle-box-private-corpus.json')).catch(() => null);
  let waters = 0;
  for (const st of ['ca', 'nv', 'or']) waters += (await readFile(path.join(DIR, st, 'index.json'), 'utf8').then(JSON.parse).catch(() => null))?.count ?? 0;
  return { ok: true, builtAt: pack?.mtime.toISOString() ?? null, waters, lastBuild };
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, '{"error":"GET only"}');
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') return send(res, 200, JSON.stringify(await health()));
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, '{"error":"key required"}');
  // Only the archive's own files: two levels deep at most, json or markdown, no dot segments.
  const parts = url.pathname.split('/').filter(Boolean).map(p => { try { return decodeURIComponent(p); } catch { return '\0'; } });
  const ext = path.extname(parts.at(-1) ?? '');
  if (!parts.length || parts.length > 2 || parts.some(p => !/^[\w.-]+$/.test(p) || p.startsWith('.')) || !TYPES[ext] || (parts.length === 2 && !['ca', 'nv', 'or', 'docs'].includes(parts[0]))) return send(res, 404, '{"error":"not in the archive"}');
  const file = path.join(DIR, ...parts);
  const s = await stat(file).catch(() => null);
  if (!s?.isFile()) return send(res, 404, '{"error":"not in the archive"}');
  res.writeHead(200, { 'Content-Type': TYPES[ext], 'Content-Length': s.size, 'Last-Modified': s.mtime.toUTCString(), 'Cache-Control': 'no-store' });
  if (req.method === 'HEAD') return res.end();
  const fh = await open(file);
  fh.createReadStream().pipe(res);
});
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
  const code = await run('node', ['scripts/build-corpus.mjs'], log);
  lastBuild = { at: new Date().toISOString(), ok: code === 0, log: `logs/${day}.log` };
  log.write(`=== done, exit ${code} ===\n`);
  log.end(); building = false;
  console.log(`build ${lastBuild.ok ? 'ok' : `failed (exit ${code})`}, see ${lastBuild.log}`);
}
function schedule() {
  if (BUILD_HOUR < 0) return;
  const next = new Date(); next.setHours(BUILD_HOUR, 0, 0, 0); if (next <= new Date()) next.setDate(next.getDate() + 1);
  setTimeout(() => build().finally(schedule), next - new Date());
}
schedule();
if (process.env.BUILD_ON_START === '1') build();
