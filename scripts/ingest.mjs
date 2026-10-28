// The nightly ingest: every book in <CORPUS_DIR>/library/ and every link in <CORPUS_DIR>/urls.md is read, split
// into paragraphs, and each paragraph that names a stocked water is filed on that water's record under
// `passages` (docs/corpus/README.md). Runs in the archive container before scripts/build-corpus.mjs.
//
//   CORPUS_DIR=/path/to/archive node scripts/ingest.mjs [--dry]
//
// A passage belongs to its source (`src`: "library/<file>" or the URL). Each run replaces a source's passages,
// so a re-ingested book or a changed page updates cleanly; a source that is gone (file removed, URL dropped,
// robots.txt now forbids it) takes its passages with it; a URL that failed to fetch keeps last run's. Hand-kept
// sections (notes, excerpts, manual) are never touched. `ingestedAt` is when a passage was first seen.
//
// Beside a book, an optional sidecar <file>.json: { "title", "author", "states": ["ca"], "pages": { "112-118": "ca:18122" } }
// (states limits name matching; pages files whole page ranges on one water). <CORPUS_DIR>/aliases.json adds or
// blocks matching terms: { "Convict": "ca:18122", "Silver Lake": null }. INGEST_DELAY_MS (2000) spaces web fetches.
import { readFile, writeFile, mkdir, readdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { STATES, loadWaters, resolveWater, stubRecord, waterFile } from './corpus-lib.mjs';
import { buildIndex, matchWaters } from './ingest/match.mjs';
import { extractFile, paragraphs, BOOK_EXT } from './ingest/text.mjs';
import { parseUrls, fetchAllowed, fetchPage, articleText, sleep } from './ingest/web.mjs';

const DIR = process.env.CORPUS_DIR ? path.resolve(process.env.CORPUS_DIR) : null;
const DRY = process.argv.includes('--dry');
const DELAY = process.env.INGEST_DELAY_MS == null ? 2000 : +process.env.INGEST_DELAY_MS;
const TAGGED_CAP = 30;
if (!DIR) { console.error('usage: CORPUS_DIR=<private archive folder> node scripts/ingest.mjs [--dry]'); process.exit(1); }
if (!existsSync(DIR)) { console.error(`${DIR}: no such folder`); process.exit(1); }

const now = new Date().toISOString();
const readJson = async (p, fallback = null) => { try { return JSON.parse(await readFile(p, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } };
const sha1 = s => createHash('sha1').update(s).digest('hex');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

const waters = await loadWaters();
const index = buildIndex(waters, (await readJson(path.join(DIR, 'aliases.json'), {})) ?? {});
const byKey = new Map(); for (const st of STATES) for (const w of waters[st]) byKey.set(`${st}:${w.id}`, { st, w });
// A bare water name in urls.md or a sidecar is looked up across the three states.
function refTo(ref) {
  if (/^(ca|nv|or):/i.test(ref)) { const [st, w] = resolveWater(ref, waters); return `${st}:${w.id}`; }
  const found = STATES.flatMap(st => { try { return [resolveWater(`${st}:${ref}`, waters)]; } catch { return []; } });
  if (found.length !== 1) throw new Error(`"${ref}": ${found.length ? 'names a water in more than one state; use st:Name' : 'no stocked water with that name'}`);
  return `${found[0][0]}:${found[0][1].id}`;
}

// Every existing water file is read up front (a gone source's passages must leave every file; the log lines
// report how many) and visited at the end, plus the waters that got passages this run and have no file yet.
const oldCounts = new Map();
function oldCount(src) { return oldCounts.get(src) ?? 0; }
const existing = new Map();
for (const st of STATES) { const d = path.join(DIR, st); if (!existsSync(d)) continue; for (const n of await readdir(d)) if (n.endsWith('.json') && n !== 'index.json') { const f = await readJson(path.join(d, n)); if (f) existing.set(`${st}:${f.id ?? decodeURIComponent(n.slice(0, -5))}`, { file: path.join(d, n), f }); } }
for (const { f } of existing.values()) for (const p of f.passages ?? []) oldCounts.set(p.src, oldCount(p.src) + 1);

// ---------- Collect ----------
const fresh = new Map();          // "st:id" → passages filed this run
const present = new Set();        // sources that exist this run (kept when not reprocessed)
const processed = new Set();      // sources fully read this run (their old passages are replaced)
const file = (key, p) => { const list = fresh.get(key) ?? []; if (!list.some(x => x.src === p.src && x.hash === p.hash)) list.push(p); fresh.set(key, list); };
const passage = (src, meta, page, text, how, matched = [], ambiguous = false) => ({ src, ...meta, ...(page ? { page } : {}), text, matched, how, ...(ambiguous ? { ambiguous: true } : {}), hash: sha1(text) });
const summary = m => { const ws = new Set(); let n = 0; for (const [k, list] of fresh) for (const p of list) if (p.src === m) { n++; ws.add(k); } return `${plural(n, 'passage')} on ${plural(ws.size, 'water')}`; };

const libDir = path.join(DIR, 'library');
const books = existsSync(libDir) ? (await readdir(libDir)).filter(n => !n.startsWith('.') && BOOK_EXT.includes(path.extname(n).toLowerCase())).sort() : [];
for (const name of books) {
  const src = `library/${name}`; present.add(src);
  try {
    const side = (await readJson(path.join(libDir, `${name}.json`), {})) ?? {};
    const r = await extractFile(path.join(libDir, name), path.join(libDir, '.text'));
    if (r.ocr && !r.pages.length) { console.log(`book "${side.title ?? r.title}": needs OCR tools (tesseract, pdftoppm); skipped`); continue; }
    const meta = { kind: 'book', title: side.title ?? r.title, ...((side.author ?? r.author) && { author: side.author ?? r.author }) };
    const ranges = Object.entries(side.pages ?? {}).map(([range, ref]) => { const [a, b] = range.split('-').map(Number); return { a, b: b ?? a, key: refTo(ref) }; });
    for (const { page, text } of paragraphs(r.pages)) {
      for (const h of matchWaters(text, index, { states: side.states })) file(`${h.st}:${h.id}`, passage(src, meta, page, text, 'name', [h.name], h.ambiguous));
      const n = Number(page);
      if (Number.isInteger(n)) for (const rg of ranges) if (n >= rg.a && n <= rg.b) file(rg.key, passage(src, meta, page, text, 'pages'));
    }
    processed.add(src);
    console.log(`book "${meta.title}": ${summary(src)}${r.ocr ? ' (ocr)' : ''}`);
  } catch (e) { console.log(`book "${name}": ${e.message}; kept last run's passages`); }
}

const urls = parseUrls((await readFile(path.join(DIR, 'urls.md'), 'utf8').catch(() => '')));
for (const [i, { url, water }] of urls.entries()) {
  present.add(url);
  if (i) await sleep(DELAY);
  let tagged = null;
  if (water) { try { tagged = refTo(water); } catch (e) { console.log(`web ${url}: ${e.message}; matching by name instead`); } }
  if (!(await fetchAllowed(url))) { processed.add(url); console.log(`web ${url}: robots.txt disallows, removed ${plural(oldCount(url), 'passage')}`); continue; }
  const r = await fetchPage(url);
  if (!r.html) { console.log(`web ${url}: fetch failed (status ${r.status}), kept ${plural(oldCount(url), 'passage')}`); continue; }
  const art = articleText(r.html), meta = { kind: 'web', title: art.title || url, url };
  let n = 0;
  for (const { text } of paragraphs([{ page: '', text: art.paragraphs.join('\n\n') }])) {
    if (tagged) { if (n++ < TAGGED_CAP) file(tagged, passage(url, meta, '', text, 'tagged')); }
    else for (const h of matchWaters(text, index)) file(`${h.st}:${h.id}`, passage(url, meta, '', text, 'name', [h.name], h.ambiguous));
  }
  processed.add(url);
  console.log(`web ${url}: ${summary(url)}`);
}

// ---------- Write ----------
const pageNum = p => { const n = Number(p.page); return Number.isFinite(n) ? n : Infinity; };
let written = 0, removed = 0, total = 0;
const targets = new Set([...existing.keys(), ...fresh.keys()]);
for (const key of targets) {
  const have = existing.get(key), { st, w } = byKey.get(key) ?? { st: key.split(':')[0], w: null };
  const f = have?.f ?? (w && stubRecord(st, w));
  if (!f) continue;
  const prev = f.passages ?? [], kept = prev.filter(p => present.has(p.src) && !processed.has(p.src));
  removed += prev.length - kept.length;
  const firstSeen = new Map(prev.map(p => [`${p.src} ${p.hash}`, p.ingestedAt]));
  const next = [...kept, ...(fresh.get(key) ?? []).map(p => ({ ...p, ingestedAt: firstSeen.get(`${p.src} ${p.hash}`) ?? now }))]
    .sort((a, b) => b.ingestedAt.localeCompare(a.ingestedAt) || pageNum(a) - pageNum(b));
  total += next.length;
  if (JSON.stringify(next) === JSON.stringify(prev)) continue;
  if (next.length) f.passages = next; else delete f.passages;
  if (DRY) { for (const p of fresh.get(key) ?? []) console.log(`${key}  ${p.url ?? p.title}  ${p.page ?? ''}  ${p.text.slice(0, 80)}`); continue; }
  const out = have?.file ?? waterFile(DIR, st, w);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out + '.tmp', JSON.stringify(f, null, f.checkedAt ? 0 : 1) + '\n'); await rename(out + '.tmp', out); written++;
}
console.log(`${plural(books.length + urls.length, 'source')}, ${plural(total, 'passage')} on ${plural([...targets].filter(k => (fresh.get(k)?.length || existing.get(k)?.f.passages?.length)).length, 'water')}; ${plural(removed, 'passage')} removed; ${DRY ? 'dry run, nothing written' : `${plural(written, 'file')} written`}`);
