// Shared lookups over the files a state's data jobs write to data/<st>/. states/nv.js (and later states) build on
// this; states/ca.js predates it and keeps its own copy of the same logic.
import { haversineKm } from '../data-sources.js';

export const norm = s => (s ?? '').toLowerCase().replace(/\b(lake|reservoir|river|creek|pond|the|of)\b|[^a-z0-9]/g, '');
export const isRiver = lake => lake.kind === 'river' || /river|creek|stream|slough|canal/i.test(lake.type ?? '');

// Names in regulations and agency pages are written several ways: "Walker River, East Fork",
// "East Walker River", "South Fork of the Humboldt River". This key makes those the same.
const regKey = s => String(s ?? '').toLowerCase().replace(/[’']/g, '').replace(/^(.+?),\s*(.+)$/, '$2 $1').replace(/\s*[–—-]\s+.*$/, '')
  .replace(/\b(the|of|fork)\b|[^a-z0-9]/g, '');
const WATER_WORD = /^(lake|reservoir|res|pond|ponds|river|creek|wash)/;
// Same water: same key, or one is the other plus a place ("Lake Tahoe – Cave Rock"), not plus another water word
// ("Cold Creek" is not "Cold Creek Reservoir").
export function sameWater(a, b) {
  const x = regKey(a), y = regKey(b);
  if (x.length < 4 || y.length < 4) return false;
  if (x === y) return true;
  const [long, short] = x.length > y.length ? [x, y] : [y, x];
  // A rule for "Jarbidge River" covers its West Fork too.
  if (/(river|creek)$/.test(short) && long.replace(/^(north|south|east|west|middle)/, '') === short) return true;
  return long.startsWith(short) && !WATER_WORD.test(long.slice(short.length));
}

export function stateData(dir, code) {
  const cache = {};
  const load = name => cache[name] ??= fetch(`data/${dir}/${name}.json`).then(r => r.ok ? r.json() : null).catch(() => null);

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
      .filter(s => s.distKm <= maxKm)
      .sort((a, b) => (b.named - a.named) || a.distKm - b.distKm)[0];
    if (!best) return null;
    const limit = best.named ? maxKm : Math.max(3, Math.sqrt((acres ?? 0) / 247) * 2.5);
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
    return water.kind === 'river' ? null : near.find(w => w.distKm <= radius) ?? null;
  }

  // Historical introductions recorded at this water (USGS NAS): nearby records, or records whose locality names it.
  async function historyFor(lake) {
    const h = await load('history');
    if (!h) return { note: '', statewide: [], local: [] };
    const radius = isRiver(lake) ? 3 : Math.max(1.5, Math.sqrt((lake.acres ?? 50) / 247) * 1.5);
    const key = norm(lake.name);
    const seen = new Set();
    const local = h.places
      .filter(([lat, lon, , , locality]) => (key.length > 3 && norm(locality).includes(key)) || haversineKm(lake.lat, lake.lon, lat, lon) <= radius)
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
    const idx = cache.bathy ??= fetch(`data/${dir}/bathymetry/index.json`).then(r => r.ok ? r.json() : null).catch(() => null);
    const surveys = (await idx)?.surveys ?? [];
    const pad = 0.01;
    return surveys.filter(s => lake.lat >= s.bbox[1] - pad && lake.lat <= s.bbox[3] + pad && lake.lon >= s.bbox[0] - pad && lake.lon <= s.bbox[2] + pad);
  }
  const bathymetryUrl = id => `data/${dir}/bathymetry/${id}.geojson`;

  return { load, waters, plantsFor, dataDates, nearestWaters, nearestReservoir, statewide, history: () => load('history'), matchStockedWater, historyFor, hydroFor, bathymetryFor, bathymetryUrl };
}
