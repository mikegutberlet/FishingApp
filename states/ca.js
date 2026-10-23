// California: CDFW stocking and CDEC reservoir levels, read from the files the nightly job writes to data/ca/.
// Nevada and Oregon will follow the same shape (states/nv.js, states/or.js).
import { haversineKm } from '../data-sources.js';

const cache = {};
// A failed fetch (offline, or a file the nightly job hasn't written yet) is forgotten after 30 s so it is tried again.
const fetchJson = (key, url) => cache[key] ??= fetch(url).then(r => r.ok ? r.json() : Promise.reject())
  .catch(() => { setTimeout(() => delete cache[key], 30e3); return null; });
async function load(name) {
  return fetchJson(name, `data/ca/${name}.json`);
}

export const code = 'CA';
export const name = 'California';
export const waterUrl = stockId => `https://apps.wildlife.ca.gov/fishing/?stockid=${stockId}`;
export const scheduleUrl = 'https://nrm.dfg.ca.gov/FishPlants/';

// Every CDFW stocked water with a map point, newest plant first, plus its planting history.
export async function waters() {
  const [w, p] = await Promise.all([load('waters'), load('plants')]);
  if (!w) return [];
  const plantsById = new Map();
  for (const plant of p?.plants ?? []) {
    if (!plant.stockId) continue;
    if (!plantsById.has(plant.stockId)) plantsById.set(plant.stockId, []);
    plantsById.get(plant.stockId).push(plant);
  }
  return w.waters.map(water => {
    const plants = plantsById.get(water.id) ?? [];
    return { ...water, name: water.name ?? `CDFW water #${water.id}`, plants, lastPlant: plants[0]?.week ?? null };
  });
}

export async function plantsFor(stockId) {
  const p = await load('plants');
  return (p?.plants ?? []).filter(x => x.stockId === +stockId);
}

export async function dataDates() {
  const [w, p, r] = await Promise.all([load('waters'), load('plants'), load('reservoirs')]);
  return { waters: w?.updatedAt, plants: p?.updatedAt, reservoirs: r?.updatedAt };
}

export async function nearestWaters(lat, lon, maxKm = 5) {
  return (await waters())
    .map(w => ({ ...w, distKm: haversineKm(lat, lon, w.lat, w.lon) }))
    .filter(w => w.distKm <= maxKm)
    .sort((a, b) => a.distKm - b.distKm);
}

// Big reservoirs' gauges sit at the dam, often 15+ km from the middle of the lake, so the search is wide.
// A lake can pin a station id (Edit → CDEC station) when the nearest one is the wrong water.
// Without a name match, a gauge only counts when it sits within a radius that scales with the lake's size,
// so a pond near a big dam doesn't show the dam's level.
export async function nearestReservoir(lat, lon, pinnedId, { name, acres, maxKm = 25 } = {}) {
  const r = await load('reservoirs');
  if (!r) return null;
  const pinned = pinnedId && r.reservoirs.find(s => s.id === pinnedId.toUpperCase());
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

// ---------- Statewide water list (weekly build from USGS NHD) ----------
// Lakes keep their id; rivers are flattened into one entry per label point, all sharing the river's id.
export async function statewide() {
  const [l, r] = await Promise.all([load('lakes'), load('rivers')]);
  const lakes = (l?.lakes ?? []).map(x => ({ ...x, kind: 'lake' }));
  const riverLabels = [];
  for (const river of r?.rivers ?? []) {
    for (const [lat, lon] of river.points) riverLabels.push({ ...river, kind: 'river', lat, lon });
  }
  return { lakes, riverLabels };
}

export async function history() {
  return load('history');
}

const norm = s => (s ?? '').toLowerCase().replace(/\b(lake|reservoir|river|creek|pond|the|of)\b|[^a-z0-9]/g, '');

// Best CDFW stocked water for a statewide water: close by, preferring a matching name.
export async function matchStockedWater(water) {
  const radius = water.kind === 'river' ? 3 : Math.max(2, Math.sqrt((water.acres ?? 50) / 247) * 2);
  const near = await nearestWaters(water.lat, water.lon, water.kind === 'river' ? 25 : radius);
  const key = norm(water.name);
  const named = near.find(w => key && (norm(w.name).startsWith(key) || key.startsWith(norm(w.name))));
  if (named) return named;
  return water.kind === 'river' ? null : near.find(w => w.distKm <= radius) ?? null;
}

// Historical introductions/plantings recorded at this water: nearby records, or records whose locality names it.
export async function historyFor(lake) {
  const h = await load('history');
  if (!h) return { note: '', statewide: [], local: [] };
  const radius = lake.kind === 'river' || /river|creek|stream|slough/i.test(lake.type ?? '') ? 3 : Math.max(1.5, Math.sqrt((lake.acres ?? 50) / 247) * 1.5);
  const key = norm(lake.name);
  const seen = new Set();
  const local = h.places
    .filter(([lat, lon, , , locality]) => (key.length > 3 && norm(locality).includes(key)) || haversineKm(lake.lat, lake.lon, lat, lon) <= radius)
    // One line per species per year: NAS often has several records of the same plant at different spots on a lake.
    .filter(([, , year, species]) => !seen.has(`${year}|${species}`) && seen.add(`${year}|${species}`))
    .map(([, , year, species, locality, status]) => ({ year: String(year), text: `${species}${locality ? ` (${locality})` : ''}${status ? ` · ${status.toLowerCase()}` : ''}` }));
  return { note: h.note, statewide: h.statewide, local };
}

// HydroLAKES estimate (average depth, volume, shoreline) for this lake: same name nearby, or the one lake of
// similar size at this spot. Modelled from shape and terrain, so it is labelled as an estimate in the app.
export async function hydroFor(lake) {
  if (lake.kind === 'river' || /river|creek|stream|slough/i.test(lake.type ?? '')) return null;
  const h = await load('hydrolakes');
  if (!h) return null;
  const key = norm(lake.name);
  const radius = Math.max(1, Math.sqrt((lake.acres ?? 50) / 247) * 1.5);
  const near = h.lakes.map(x => ({ ...x, distKm: haversineKm(lake.lat, lake.lon, x.lat, x.lon) })).filter(x => x.distKm <= Math.max(radius, 8)).sort((a, b) => a.distKm - b.distKm);
  const named = key.length > 2 && near.find(x => norm(x.name) === key);
  if (named) return named;
  const sized = near.find(x => x.distKm <= radius && lake.acres && x.acres / lake.acres > 0.4 && x.acres / lake.acres < 2.5);
  return sized ?? null;
}

// Public depth-contour surveys (USGS) covering this water, if any.
export async function bathymetryFor(lake) {
  const idx = fetchJson('bathy', 'data/ca/bathymetry/index.json');
  const surveys = (await idx)?.surveys ?? [];
  const pad = 0.01;
  return surveys.filter(s => lake.lat >= s.bbox[1] - pad && lake.lat <= s.bbox[3] + pad && lake.lon >= s.bbox[0] - pad && lake.lon <= s.bbox[2] + pad);
}

export const bathymetryUrl = id => `data/ca/bathymetry/${id}.geojson`;
