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

export async function nearestReservoir(lat, lon, maxKm = 8) {
  const r = await load('reservoirs');
  if (!r) return null;
  const best = r.reservoirs
    .map(s => ({ ...s, distKm: haversineKm(lat, lon, s.lat, s.lon) }))
    .sort((a, b) => a.distKm - b.distKm)[0];
  return best && best.distKm <= maxKm ? { ...best, updatedAt: r.updatedAt } : null;
}
