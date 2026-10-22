// California: CDFW stocking and CDEC reservoir levels, read from the files the nightly job writes to data/ca/.
// Nevada and Oregon will follow the same shape (states/nv.js, states/or.js).
import { haversineKm } from '../data-sources.js';

const cache = {};
async function load(name) {
  cache[name] ??= fetch(`data/ca/${name}.json`).then(r => r.ok ? r.json() : null).catch(() => null);
  return cache[name];
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
export async function nearestReservoir(lat, lon, pinnedId, maxKm = 25) {
  const r = await load('reservoirs');
  if (!r) return null;
  const pinned = pinnedId && r.reservoirs.find(s => s.id === pinnedId.toUpperCase());
  if (pinned) return { ...pinned, distKm: haversineKm(lat, lon, pinned.lat, pinned.lon), updatedAt: r.updatedAt };
  const best = r.reservoirs
    .map(s => ({ ...s, distKm: haversineKm(lat, lon, s.lat, s.lon) }))
    .sort((a, b) => a.distKm - b.distKm)[0];
  return best && best.distKm <= maxKm ? { ...best, updatedAt: r.updatedAt } : null;
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
