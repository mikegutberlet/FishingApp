// Files hand notes onto waters in the private archive (<CORPUS_DIR>/<st>/<id>.json, see docs/corpus/README.md), each
// with the book, page or web page it came from, and optionally the passage itself as an excerpt. The archive lives
// outside this public repo, so a note may quote Goobs's own books freely.
//
//   CORPUS_DIR=/path/to/archive node scripts/add-notes.mjs notes.json
//   node scripts/add-notes.mjs --find "convict"      which waters match a name, with the ids to use
//
//   notes.json: [{ "water": "ca:175" or "ca:Convict Lake", "text": "…", "by": "Goobs", "date": "2026-10-27",
//                  "excerpt": "the passage, when worth keeping whole",
//                  "source": { "title": "…", "author": "…", "page": "112", "url": "https://…", "read": "2026-10-27" } }]
//
// A water the nightly job hasn't reached yet gets a file holding only its notes; the job builds the rest of it
// on its next visit and keeps the notes (and only then lists the water in the index and catalogue). Run
// CORPUS_DOCS_ONLY=1 node scripts/build-corpus.mjs afterwards to refresh the catalogue and the pack the app imports.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DIR = process.env.CORPUS_DIR ? path.resolve(process.env.CORPUS_DIR) : null;
const MAX_CHARS = 400;
const today = new Date().toISOString().slice(0, 10);
const readJson = async p => { try { return JSON.parse(await readFile(path.join(ROOT, p), 'utf8')); } catch { return null; } };
const key = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// The stocked waters with a map point: the ones the corpus has (or will have) a file for.
const waters = {};
for (const st of ['ca', 'nv', 'or']) waters[st] = ((await readJson(`data/${st}/waters.json`))?.waters ?? []).filter(w => w.lat != null && w.lon != null && w.name);

function resolve(ref) {
  const [st, rest] = String(ref).split(/:(.*)/s), list = waters[st?.toLowerCase()];
  if (!list || !rest) throw new Error(`"${ref}": use st:id or st:Name, e.g. ca:175 or ca:Convict Lake`);
  const byId = list.find(w => String(w.id).toLowerCase() === rest.toLowerCase());
  if (byId) return [st.toLowerCase(), byId];
  const byName = list.filter(w => key(w.name) === key(rest));
  if (byName.length === 1) return [st.toLowerCase(), byName[0]];
  throw new Error(byName.length ? `"${ref}" matches ${byName.length} waters: ${byName.map(w => `${st}:${w.id} (${w.counties ?? w.county ?? ''})`).join(', ')}` : `"${ref}": no stocked water with that id or name (try --find)`);
}

if (process.argv[2] === '--find') {
  const q = key(process.argv[3] ?? '');
  for (const [st, list] of Object.entries(waters)) for (const w of list) if (key(w.name).includes(q)) console.log(`${st}:${w.id}\t${w.name}\t${w.counties ?? w.county ?? ''}`);
  process.exit(0);
}

if (!process.argv[2] || !DIR) { console.error('usage: CORPUS_DIR=<private archive folder> node scripts/add-notes.mjs notes.json | --find "name"'); process.exit(1); }
const notes = JSON.parse(await readFile(process.argv[2], 'utf8'));
const bad = [], byFile = new Map();
for (const [i, n] of notes.entries()) {
  try {
    const [st, w] = resolve(n.water);
    const text = String(n.text ?? '').replace(/\s+/g, ' ').trim();
    if (!text) throw new Error('no text');
    if (text.length > MAX_CHARS) throw new Error(`text is ${text.length} characters; keep a note to a short fact (≤ ${MAX_CHARS})`);
    const s = n.source ?? {};
    if (!s.title && !s.url) throw new Error('source needs a title or a url');
    if (s.url && !/^https?:\/\/\S+$/.test(s.url)) throw new Error(`source url "${s.url}" must start with http:// or https://`);
    const source = Object.fromEntries(Object.entries({ title: s.title, author: s.author, page: s.page != null ? String(s.page) : undefined, url: s.url, read: s.read ?? (s.url ? today : undefined) }).filter(([, v]) => v));
    const file = path.join(DIR, st, `${encodeURIComponent(String(w.id))}.json`);
    if (!byFile.has(file)) byFile.set(file, { st, w, add: [] });
    byFile.get(file).add.push({ date: n.date ?? today, by: n.by ?? 'Goobs', text, source, excerpt: n.excerpt ? String(n.excerpt).trim() : undefined });
  } catch (e) { bad.push(`#${i + 1}: ${e.message}`); }
}
if (bad.length) { console.error(bad.join('\n')); process.exit(1); }

// Every file is read before any is written. No file yet is fine; one that can't be read (cloud-only, half-written)
// stops the run rather than being overwritten with a stub.
const existing = new Map();
for (const file of byFile.keys()) {
  try { existing.set(file, JSON.parse(await readFile(file, 'utf8'))); } catch (e) { if (e.code !== 'ENOENT') { console.error(`${file}: ${e.message}. Nothing was written.`); process.exit(1); } }
}

let added = 0, skipped = 0;
for (const [file, { st, w, add }] of byFile) {
  const f = existing.get(file) ?? { id: String(w.id), state: st.toUpperCase(), name: w.name, notes: [], manual: {} };
  f.notes ??= [];
  for (const n of add) {
    if (f.notes.some(o => key(o.text) === key(n.text))) { skipped++; continue; }
    // The passage is kept beside the note, as an excerpt the app shows under "From your books".
    if (n.excerpt) (f.excerpts ??= []).push({ text: n.excerpt, source: n.source });
    delete n.excerpt; f.notes.push(n); added++;
  }
  await mkdir(path.dirname(file), { recursive: true });
  // Built files are compact; a notes-only file is small and stays readable.
  await writeFile(file, JSON.stringify(f, null, f.checkedAt ? 0 : 1) + '\n');
  console.log(`${path.relative(process.cwd(), file)} ${w.name}: ${f.notes.length} notes${f.excerpts?.length ? `, ${f.excerpts.length} excerpts` : ''}${f.checkedAt ? '' : ' (not built yet; the nightly job fills in the rest)'}`);
}
console.log(`${added} added, ${skipped} already there`);
