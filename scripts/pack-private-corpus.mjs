// Packs your private archive into one file the app imports (⚙️ gear → Import → the pack file; private-corpus.js).
// The archive is a folder on your NAS (synced to Google Drive): <dir>/<st>/<id>.json files written by
// CORPUS_DIR=<dir> node scripts/add-notes.mjs, with notes, excerpts and manual values, and <dir>/library/ holding the
// books themselves. The pack lists the books by file name only; their text goes in only as the excerpts you filed.
//
//   node scripts/pack-private-corpus.mjs <dir>           writes <dir>/tackle-box-private-corpus.json

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (!dir || !existsSync(dir)) { console.error('usage: node scripts/pack-private-corpus.mjs <private archive folder>'); process.exit(1); }

const waters = {};
let notes = 0, excerpts = 0;
for (const st of ['ca', 'nv', 'or']) {
  if (!existsSync(path.join(dir, st))) continue;
  for (const name of await readdir(path.join(dir, st))) {
    if (!name.endsWith('.json')) continue;
    const f = JSON.parse(await readFile(path.join(dir, st, name), 'utf8'));
    const { id, state, name: n, notes: ns = [], excerpts: ex = [], manual = {} } = f;
    waters[`${st}/${name.slice(0, -5)}`] = { id, state, name: n, notes: ns, excerpts: ex, manual };
    notes += ns.length; excerpts += ex.length;
  }
}
const library = existsSync(path.join(dir, 'library')) ? (await readdir(path.join(dir, 'library'))).filter(n => !n.startsWith('.')).sort() : [];
const out = path.join(dir, 'tackle-box-private-corpus.json');
await writeFile(out, JSON.stringify({ app: 'tackle-box', kind: 'private-corpus', builtAt: new Date().toISOString(), waters, library }));
console.log(`${out}: ${Object.keys(waters).length} waters, ${notes} notes, ${excerpts} excerpts, ${library.length} books`);
