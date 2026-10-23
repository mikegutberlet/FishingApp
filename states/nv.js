// Nevada: NDOW stocking and fishing reports, USGS and Reclamation lake levels, read from the files the Nevada data
// jobs write to data/nv/ (scripts/nv/*.mjs and scripts/build-state-*.mjs).
import { stateData, norm } from './common.js';
import { haversineKm } from '../data-sources.js';

const d = stateData('nv', 'NV');

export const code = 'NV';
export const name = 'Nevada';
export const agency = 'NDOW';
export const stockField = 'ndowWaterId';
export const levelSource = 'USGS';
export const waterUrl = slug => `https://www.ndow.org/waters/${encodeURIComponent(slug)}/`;
export const scheduleUrl = 'https://www.ndow.org/get-outside/fishing-stocking-reports/';
// Lake Mead and Lake Mohave sit on the Arizona line, so the box takes in the river's east bank too.
export const bbox = [-120.01, 34.99, -114.03, 42.01];
export const outline = [[-120.0, 42.0], [-114.04, 42.0], [-114.04, 36.2], [-114.0, 36.0], [-114.0, 35.0], [-114.63, 35.0], [-120.0, 39.0]];
export const plantsNote = 'NDOW reports each stocking with the number and average length of the fish. History grows each night from the NDOW water pages.';
export const searchHint = 'Pyramid, Truckee River, Wildhorse…';
export const stockedHint = 'Topaz, Sparks Marina, Wildhorse…';

export const { waters, plantsFor, dataDates, nearestWaters, nearestReservoir, statewide, history, matchStockedWater, historyFor, hydroFor, bathymetryFor, bathymetryUrl } = d;

// NDOW's page for a stocked water: latest fishing report and the "pertinent information" write-up.
export async function reportFor(lake) {
  const w = await d.load('waters');
  const id = lake.ndowWaterId ?? (await matchStockedWater(lake))?.id;
  return w?.waters.find(x => x.id === id) ?? null;
}

// ---------- Safety: toxic algae (nightly), fish consumption advisories and regulations (weekly) ----------
const reach = lake => /river|creek|stream/i.test(`${lake.kind} ${lake.type}`) ? 3 : Math.max(1.5, Math.sqrt((lake.acres ?? 50) / 247) * 1.5 + 0.5);
const named = (lake, n) => { const a = norm(lake.name), b = norm(n); return a.length > 2 && b.length > 2 && (a === b || a.startsWith(b) || b.startsWith(a)); };

export async function habAdvisories() {
  return d.load('hab');
}

// Current toxic algae advisories on this water (Nevada Office of State Epidemiology list, matched by name).
export async function habFor(lake) {
  const h = await d.load('hab');
  return (h?.advisories ?? []).map(a => ({ ...a, distKm: a.lat != null ? haversineKm(lake.lat, lake.lon, a.lat, a.lon) : null }))
    .filter(a => named(lake, a.name) ? a.distKm == null || a.distKm < 60 : a.distKm != null && a.distKm <= reach(lake));
}

// Health advisories on eating fish from this water.
export async function fishAdviceFor(lake) {
  const f = await d.load('advisories');
  if (!f) return null;
  const site = f.advisories.filter(a => a.areas.some(([lat, lon, km]) => haversineKm(lake.lat, lake.lon, lat, lon) <= km) || a.names.some(n => named(lake, n)));
  return { site, statewide: f.statewide, url: f.url, updatedAt: f.updatedAt };
}

// Statewide seasons and limits, plus special rules that name this water.
export async function regsFor(lake) {
  const r = await d.load('regs');
  if (!r) return null;
  const special = r.waters.filter(w => [w.name, ...(w.aliases ?? [])].some(n => named(lake, n)));
  return { special, statewide: r.statewide, booklet: r.booklet, updatedAt: r.updatedAt, source: r.source };
}
