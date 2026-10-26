// Shared lookups over the files a state's data jobs write to data/<st>/. states/nv.js (and later states) build on
// this; states/ca.js predates it and keeps its own copy of the same logic.
import { haversineKm } from '../data-sources.js';

export const norm = s => (s ?? '').toLowerCase().replace(/\b(lake|reservoir|river|creek|pond|the|of)\b|[^a-z0-9]/g, '');
export const isRiver = lake => lake.kind === 'river' || /river|creek|stream|slough|canal/i.test(lake.type ?? '');

// Does a free-text place ("West Walker River near Coleville") name this water? Whole words only, so Lake Mead is
// not "Truckee Meadows", and a lake is not the river of the same name (Carson Lake vs Carson River).
const TYPE_WORDS = /\b(lake|lakes|reservoir|pond|river|creek|slough|wash)\b/i;
function namedIn(lake) {
  const name = String(lake.name ?? '').toLowerCase().split(/\s+[–—-]\s+/)[0];
  // A name with its type word ("Walker Lake") must appear whole: "West Walker River" isn't it.
  const full = name.match(/[a-z0-9]+/g) ?? [];
  if (TYPE_WORDS.test(name) && full.join('').length >= 6) {
    const re = new RegExp(`\\b${full.join('\\W+')}\\b`, 'i');
    return locality => !!locality && re.test(locality);
  }
  const words = name.replace(/\b(lake|reservoir|river|creek|pond|the|of)\b/g, ' ').match(/[a-z0-9]+/g) ?? [];
  if (words.join('').length < 4) return () => false;
  const re = new RegExp(`\\b${words.join('\\W+')}\\b`, 'i');
  const type = isRiver(lake) ? /\b(river|creek|slough|wash)\b/i : /\b(lake|lakes|reservoir|pond)\b/i;
  return locality => !!locality && re.test(locality) && (!TYPE_WORDS.test(locality) || type.test(locality));
}

// A place note after a dash is dropped ("Thomas Creek- Carson Range"), one after a comma goes first ("Salmon Falls
// River, North Fork"), plural water words are read in the singular ("Three Creeks Lake" is "Three Creek Lake"), and
// "West Fork Walker River" is the West Walker River.
const nameWords = s => String(s ?? '').toLowerCase().replace(/\(.*?\)/g, ' ').split(/\s*[–—-]\s+/)[0].replace(/^(.+?),\s*(.+)$/, '$2 $1')
  .replace(/\b(north|south|east|west|middle)\s+fork\b/g, '$1').match(/[a-z0-9]+/g)
  ?.filter(w => !/^(lake|lakes|reservoir|res|pond|ponds|the|of)$/.test(w)).map(w => w.replace(/^(creek|river|spring|slough)s$/, '$1')) ?? [];
// Whether a name is a lake, reservoir or pond rather than a stream ("Willow Creek Reservoir" is, "Lake Creek" isn't).
const stillWater = s => {
  const n = String(s ?? '').replace(/\s*\(.*?\)\s*/g, ' ').split(/\s*[–—-]\s+/)[0].trim();
  return /\b(lake|lakes|reservoir|reservoirs|res|pond|ponds)$/i.test(n) || (/^lake\s/i.test(n) && !/\b(creek|river|slough|fork)$/i.test(n));
};
const streamName = s => /\b(creek|river|slough|fork)$/i.test(String(s ?? '').replace(/\s*\(.*?\)\s*/g, ' ').split(/\s*[–—-]\s+/)[0].replace(/^(.+?),\s*(.+)$/, '$2 $1').trim());

export function stateData(dir, code) {
  const cache = {};
  // A failed fetch (offline, or the file isn't there yet) is tried again after 30 s rather than kept for the session.
  const get = (key, url) => cache[key] ??= fetch(url).then(r => r.ok ? r.json() : Promise.reject(new Error(r.status)))
    .catch(() => { setTimeout(() => delete cache[key], 30000); return null; });
  const load = name => get(name, `data/${dir}/${name}.json`);

  // Every stocked water with a map point, newest stocking first, plus its stocking history.
  async function waters() {
    const [w, p] = await Promise.all([load('waters'), load('plants')]);
    if (!w) return [];
    const plantsById = new Map();
    for (const plant of p?.plants ?? []) {
      if (!plantsById.has(plant.stockId)) plantsById.set(plant.stockId, []);
      plantsById.get(plant.stockId).push(plant);
    }
    return w.waters.filter(x => x.lat != null).map(water => {
      const plants = plantsById.get(water.id) ?? [];
      return { ...water, state: code, plants, lastPlant: plants[0]?.week ?? null };
    });
  }

  async function plantsFor(stockId) {
    const p = await load('plants');
    return (p?.plants ?? []).filter(x => x.stockId === stockId);
  }

  async function dataDates() {
    const [w, p, r] = await Promise.all([load('waters'), load('plants'), load('reservoirs')]);
    return { waters: w?.updatedAt, plants: p?.updatedAt, reservoirs: r?.updatedAt };
  }

  async function nearestWaters(lat, lon, maxKm = 5) {
    return (await waters())
      .map(w => ({ ...w, distKm: haversineKm(lat, lon, w.lat, w.lon) }))
      .filter(w => w.distKm <= maxKm)
      .sort((a, b) => a.distKm - b.distKm);
  }

  // Same rules as California's: a pinned station wins; otherwise a gauge whose name matches, or one close enough
  // for the lake's size, so a pond near a big dam doesn't show the dam's level.
  async function nearestReservoir(lat, lon, pinnedId, { name, acres, maxKm = 25 } = {}) {
    const r = await load('reservoirs');
    if (!r) return null;
    const pinned = pinnedId && r.reservoirs.find(s => s.id.toUpperCase() === String(pinnedId).toUpperCase());
    if (pinned) return { ...pinned, distKm: haversineKm(lat, lon, pinned.lat, pinned.lon), updatedAt: r.updatedAt };
    const key = norm(name);
    const best = r.reservoirs
      .map(s => ({ ...s, distKm: haversineKm(lat, lon, s.lat, s.lon), named: key.length > 2 && norm(s.name).includes(key) }))
      // A named gauge may sit at the dam, far from the middle of a big lake (Lake Mead's is 35 km off).
      // An exact name may be 80 km off (Lake Mead's far bays from its middle).
      .filter(s => s.distKm <= (s.named ? (norm(s.name) === key ? 80 : Math.max(maxKm, Math.sqrt((acres ?? 0) / 247) * 4)) : maxKm))
      .sort((a, b) => (b.named - a.named) || a.distKm - b.distKm)[0];
    if (!best) return null;
    const limit = best.named ? Infinity : Math.max(3, Math.sqrt((acres ?? 0) / 247) * 2.5);
    return best.distKm <= limit ? { ...best, updatedAt: r.updatedAt } : null;
  }

  // Statewide lakes and rivers (weekly build from USGS NHD). Rivers become one entry per label point; a label in a
  // lake (the Snake through Brownlee) carries the lake's name as inLake. Built once per file the app has loaded.
  let built = null;
  async function statewide() {
    const [l, r] = await Promise.all([load('lakes'), load('rivers')]);
    if (built?.l === l && built?.r === r) return built.out;
    const lakes = (l?.lakes ?? []).map(x => ({ ...x, kind: 'lake', state: code }));
    const riverLabels = [];
    for (const river of r?.rivers ?? []) {
      for (const [lat, lon, inLake] of river.points) riverLabels.push({ ...river, kind: 'river', state: code, lat, lon, ...(String(inLake ?? '').trim() && { inLake }) });
    }
    built = { l, r, out: { lakes, riverLabels } };
    return built.out;
  }

  // Best stocked water for a statewide water: close by, preferring a matching name.
  async function matchStockedWater(water) {
    const radius = water.kind === 'river' ? 3 : Math.max(2, Math.sqrt((water.acres ?? 50) / 247) * 2);
    const near = await nearestWaters(water.lat, water.lon, water.kind === 'river' ? 25 : radius);
    // Same name: the same words once lake/reservoir/pond and place notes are dropped ("Timber-Linn Lake" is not
    // "Timber Lake", "Lemolo Forebay Number Two" is not "Lemolo Reservoir").
    const key = nameWords(water.name).join('');
    // A creek isn't the reservoir named for it ("Willow Creek" isn't "Willow Creek Reservoir"), nor a lake the creek.
    const kindOk = w => water.kind === 'river' ? !stillWater(w.name) : !(stillWater(water.name) && streamName(w.name));
    const named = key.length >= 3 ? near.filter(w => nameWords(w.name).join('') === key && kindOk(w)) : [];
    // Stocked streams of one name in different places on one point can't be told apart (NDOW pins its Willow Creeks
    // in three ranges on one spot): link none rather than the wrong one. "Big (Alexander) Creek" is Big Creek, and
    // a lake's spots are one lake ("Lake Tahoe – Cave Rock", "– Sand Harbor").
    const place = n => n.replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
    // One of them by this water's whole name is it ("Ruby Lake NWR", not its "– Collection Ditch").
    if (named.length > 1 && named[1].distKm - named[0].distKm < 0.01 && place(named[1].name) !== place(named[0].name) && !stillWater(named[0].name)) {
      return named.find(w => place(w.name).toLowerCase() === place(water.name).toLowerCase()) ?? null;
    }
    if (named.length) return named[0];
    // Otherwise a stocked water whose name holds every word of this one ("Hagg Lake" is "Henry Hagg Lake") or one
    // right on top of it: a pond on a big lake's shore isn't the lake. Right on top doesn't count when the map has the
    // stocked water's own lake next to it (Lilypad Lake is beside Anthony Lake, not Anthony Lake).
    const words = nameWords(water.name).filter(w => w.length >= 3);
    if (water.kind === 'river') return null;
    const byWords = near.find(w => words.length && w.distKm <= radius && kindOk(w) && words.every(x => nameWords(w.name).includes(x)));
    if (byWords) return byWords;
    const close = near.find(w => w.distKm <= 0.3 && kindOk(w));
    if (!close) return null;
    const own = nameWords(close.name).join('');
    const { lakes } = await statewide();
    return lakes.some(l => nameWords(l.name).join('') === own && haversineKm(l.lat, l.lon, close.lat, close.lon) <= 2) ? null : close;
  }

  // Historical introductions recorded at this water (USGS NAS): nearby records, or records whose locality names it.
  async function historyFor(lake) {
    const h = await load('history');
    if (!h) return { note: '', statewide: [], local: [] };
    const radius = isRiver(lake) ? 3 : Math.max(1.5, Math.sqrt((lake.acres ?? 50) / 247) * 1.5);
    const named = namedIn(lake);
    const seen = new Set();
    const local = h.places
      .filter(([lat, lon, , , locality]) => named(locality) || haversineKm(lake.lat, lake.lon, lat, lon) <= radius)
      .filter(([, , year, species]) => !seen.has(`${year}|${species}`) && seen.add(`${year}|${species}`))
      .map(([, , year, species, locality, status]) => ({ year: String(year), text: `${species}${locality ? ` (${locality})` : ''}${status ? ` · ${status.toLowerCase()}` : ''}` }));
    return { note: h.note, statewide: h.statewide, local };
  }

  // HydroLAKES estimate for this lake: same name nearby, or the one lake of similar size at this spot.
  async function hydroFor(lake) {
    if (isRiver(lake)) return null;
    const h = await load('hydrolakes');
    if (!h) return null;
    const key = norm(lake.name);
    const radius = Math.max(1, Math.sqrt((lake.acres ?? 50) / 247) * 1.5);
    const near = h.lakes.map(x => ({ ...x, distKm: haversineKm(lake.lat, lake.lon, x.lat, x.lon) })).filter(x => x.distKm <= Math.max(radius, 8)).sort((a, b) => a.distKm - b.distKm);
    const named = key.length > 2 && near.find(x => norm(x.name) === key);
    if (named) return named;
    return near.find(x => x.distKm <= radius && lake.acres && x.acres / lake.acres > 0.4 && x.acres / lake.acres < 2.5) ?? null;
  }

  // Public depth-contour surveys covering this water.
  async function bathymetryFor(lake) {
    const idx = get('bathy', `data/${dir}/bathymetry/index.json`);
    const surveys = (await idx)?.surveys ?? [];
    const pad = 0.01;
    return surveys.filter(s => lake.lat >= s.bbox[1] - pad && lake.lat <= s.bbox[3] + pad && lake.lon >= s.bbox[0] - pad && lake.lon <= s.bbox[2] + pad);
  }
  const bathymetryUrl = id => `data/${dir}/bathymetry/${id}.geojson`;

  return { load, waters, plantsFor, dataDates, nearestWaters, nearestReservoir, statewide, history: () => load('history'), matchStockedWater, historyFor, hydroFor, bathymetryFor, bathymetryUrl };
}
