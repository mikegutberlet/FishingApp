// Shared lookups over the files a state's data jobs write to data/<st>/. states/nv.js (and later states) build on
// this; states/ca.js predates it and keeps its own copy of the same logic.
import { haversineKm } from '../data-sources.js';

export const norm = s => (s ?? '').toLowerCase().replace(/\b(lake|reservoir|river|creek|pond|the|of)\b|[^a-z0-9]/g, '');
export const isRiver = lake => lake.kind === 'river' || /river|creek|stream|slough|canal/i.test(lake.type ?? '');

// Does a free-text place ("West Walker River near Coleville") name this water? Whole words only, so Lake Mead is
// not "Truckee Meadows", and a lake is not the river of the same name (Carson Lake vs Carson River).
const WATER_WORD = /^(lake|lakes|reservoir|pond|ponds|river|creek|slough|wash)$/;
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

  // Statewide lakes and rivers (weekly build from USGS NHD). Rivers become one entry per label point.
  async function statewide() {
    const [l, r] = await Promise.all([load('lakes'), load('rivers')]);
    const lakes = (l?.lakes ?? []).map(x => ({ ...x, kind: 'lake', state: code }));
    const riverLabels = [];
    for (const river of r?.rivers ?? []) {
      for (const [lat, lon] of river.points) riverLabels.push({ ...river, kind: 'river', state: code, lat, lon });
    }
    return { lakes, riverLabels };
  }

  // Best stocked water for a statewide water: close by, preferring a matching name.
  async function matchStockedWater(water) {
    const radius = water.kind === 'river' ? 3 : Math.max(2, Math.sqrt((water.acres ?? 50) / 247) * 2);
    const near = await nearestWaters(water.lat, water.lon, water.kind === 'river' ? 25 : radius);
    const key = norm(water.name);
    const named = near.find(w => key && (norm(w.name).startsWith(key) || key.startsWith(norm(w.name))));
    if (named) return named;
    // Without a matching name, only a stocked point close by: a pond on a big lake's shore isn't the lake.
    const words = new Set(water.name.toLowerCase().match(/[a-z]{4,}/g)?.filter(w => !WATER_WORD.test(w)) ?? []);
    return water.kind === 'river' ? null
      : near.find(w => w.distKm <= Math.min(radius, 1.5) || (w.distKm <= radius && w.name.toLowerCase().match(/[a-z]{4,}/g)?.some(x => words.has(x)))) ?? null;
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
