// What scripts/add-notes.mjs and scripts/ingest.mjs share: the stocked-water lists, the name key, resolving
// "st:id" / "st:Name" to a water, and the stub record for a water the nightly job hasn't built yet
// (docs/corpus/README.md).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const STATES = ['ca', 'nv', 'or'];
export const nameKey = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// The stocked waters with a map point: the ones the corpus has (or will have) a file for.
export async function loadWaters() {
  const waters = {};
  for (const st of STATES) {
    let list = [];
    try { list = JSON.parse(await readFile(path.join(ROOT, `data/${st}/waters.json`), 'utf8')).waters ?? []; } catch {}
    waters[st] = list.filter(w => w.lat != null && w.lon != null && w.name);
  }
  return waters;
}

export function resolveWater(ref, waters) {
  const [st, rest] = String(ref).split(/:(.*)/s), list = waters[st?.toLowerCase()];
  if (!list || !rest) throw new Error(`"${ref}": use st:id or st:Name, e.g. ca:175 or ca:Convict Lake`);
  const byId = list.find(w => String(w.id).toLowerCase() === rest.toLowerCase());
  if (byId) return [st.toLowerCase(), byId];
  const byName = list.filter(w => nameKey(w.name) === nameKey(rest));
  if (byName.length === 1) return [st.toLowerCase(), byName[0]];
  throw new Error(byName.length ? `"${ref}" matches ${byName.length} waters: ${byName.map(w => `${st}:${w.id} (${w.counties ?? w.county ?? ''})`).join(', ')}` : `"${ref}": no stocked water with that id or name (try --find)`);
}

export const stubRecord = (st, w) => ({ id: String(w.id), state: st.toUpperCase(), name: w.name, notes: [], manual: {} });
export const waterFile = (dir, st, w) => path.join(dir, st, `${encodeURIComponent(String(w.id))}.json`);
