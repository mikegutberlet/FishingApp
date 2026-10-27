// Multi-year stocking history for a water, from data/<st>/stock-history.json (scripts/build-stock-history.mjs):
// agency annual reports and archived copies of the stocking schedules, merged with the current schedule.
import { haversineKm } from './data-sources.js';
import { forLake, stockIdOf } from './states/index.js';
import { nameKey } from './name-key.js';

const files = {};
const load = code => files[code] ??= fetch(`data/${code.toLowerCase()}/stock-history.json`).then(r => r.ok ? r.json() : null)
  .catch(() => { setTimeout(() => delete files[code], 30e3); return null; });

// The file's entries by stock id, statewide water id and name key, built once: the finder looks up thousands of waters.
const indexes = new WeakMap();
function indexOf(h) {
  if (!indexes.has(h)) {
    const by = new Map(), add = (k, w) => (by.get(k) ?? by.set(k, []).get(k)).push(w);
    for (const w of h.waters) { for (const id of w.ids ?? []) add(`id:${id}`, w); if (w.nhd) add(`nhd:${w.nhd}`, w); if (w.key) add(`key:${w.key}`, w); }
    indexes.set(h, by);
  }
  return indexes.get(h);
}

// The history entries for this water: by the state's stock id, else the statewide water id, else the same name
// close by (an entry without a point needs the same name and county).
export async function stockHistoryFor(lake) {
  const S = forLake(lake);
  const h = S && await load(S.code);
  if (!h) return null;
  const stockId = stockIdOf(lake), nhd = lake.nhdId ? String(lake.nhdId) : null, key = nameKey(lake.name);
  const at = indexOf(h), find = k => at.get(k) ?? [];
  let hits = [...new Set([...(stockId != null ? find(`id:${stockId}`) : []), ...(nhd ? find(`nhd:${nhd}`) : [])])].sort((a, b) => h.waters.indexOf(a) - h.waters.indexOf(b));
  // An entry whose name fits several waters and couldn't be placed is left out rather than shown on all of them.
  if (!hits.length && key.length > 2) hits = find(`key:${key}`).filter(w => !w.ambiguous && (w.lat != null && lake.lat != null
    ? haversineKm(w.lat, w.lon, lake.lat, lake.lon) <= 15
    : !w.county || !lake.county || nameKey(w.county) === nameKey(lake.county)));
  if (!hits.length) return null;
  // Several entries can be one water (a river's sections); add their years together.
  const years = new Map();
  for (const w of hits) for (const y of w.years) {
    const t = years.get(y.y) ?? { y: y.y, fish: null, plants: null, sp: {}, src: new Set() };
    if (y.fish != null) t.fish = (t.fish ?? 0) + y.fish;
    if (y.plants != null) t.plants = (t.plants ?? 0) + y.plants;
    // sp: species → [fish or null, plants].
    for (const [s, [f, n]] of Object.entries(y.sp)) { const c = t.sp[s] ??= [null, 0]; if (f != null) c[0] = (c[0] ?? 0) + f; c[1] += n; }
    for (const i of y.src) t.src.add(i);
    years.set(y.y, t);
  }
  return {
    names: [...new Set(hits.map(w => w.name))], note: h.note, updatedAt: h.updatedAt,
    years: [...years.values()].sort((a, b) => b.y - a.y).map(y => ({ ...y, src: [...y.src].map(i => h.sources[i]) })),
  };
}

// Summary numbers for the chart: what each bar measures (fish when any year has counts, else plants), the long-run
// average over the years with a count, and how the latest full year compares with it. California rivers mix counted
// salmon releases with uncounted trout plants, so a year can have plants and no fish.
export function summarize(hist) {
  const unit = hist.years.some(y => y.fish != null) ? 'fish' : 'plants';
  const val = y => unit === 'fish' ? y.fish : y.plants;
  const any = hist.years.filter(y => (y.fish ?? 0) > 0 || (y.plants ?? 0) > 0);
  const rec = hist.years.filter(y => (val(y) ?? 0) > 0);
  const first = Math.min(...hist.years.map(y => y.y)), last = Math.max(...hist.years.map(y => y.y));
  const avg = rec.length ? rec.reduce((a, y) => a + val(y), 0) / rec.length : 0;
  const thisYear = new Date().getFullYear();
  const latest = rec.find(y => y.y < thisYear) ?? rec[0];
  const vsAvg = latest && avg && rec.length >= 3 ? Math.round((val(latest) / avg - 1) * 100) : null;
  return { unit, val, first, last, avg, latest, vsAvg, recorded: any.length, counted: rec.length };
}
