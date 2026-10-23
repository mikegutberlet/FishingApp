// Nevada: NDOW stocking and fishing reports, USGS and Reclamation lake levels, read from the files the Nevada data
// jobs write to data/nv/ (scripts/nv/*.mjs and scripts/build-state-*.mjs).
import { stateData } from './common.js';
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

// ---------- Safety: toxic algae (nightly), regulations and fish consumption advisories (weekly) ----------
// Names in the regulations and on NDOW's pages are written several ways: "Walker River, East Fork",
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
const reach = lake => /river|creek|stream/i.test(`${lake.kind} ${lake.type}`) ? 3 : Math.max(1.5, Math.sqrt((lake.acres ?? 50) / 247) * 1.5 + 0.5);

function inRing([x, y], ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}
// County and NDOW region (Western, Eastern, Southern) a point is in.
export async function countyAt(lat, lon) {
  const c = await d.load('counties');
  const hit = c?.counties.find(k => lon >= k.bbox[0] && lon <= k.bbox[2] && lat >= k.bbox[1] && lat <= k.bbox[3] && k.polys.some(([outer]) => inRing([lon, lat], outer)));
  return hit ? { county: hit.name, region: hit.region } : null;
}

export async function habAdvisories() {
  return d.load('hab');
}

// Current toxic algae advisories on this water (Nevada Office of State Epidemiology list, matched by name and place).
export async function habFor(lake) {
  const h = await d.load('hab');
  return (h?.advisories ?? []).map(a => ({ ...a, distKm: a.lat != null ? haversineKm(lake.lat, lake.lon, a.lat, a.lon) : null }))
    .filter(a => sameWater(lake.name, a.name.split(/\s+(?:including|incl\.?)\s+|[(,]/i)[0]) ? a.distKm == null || a.distKm < 60 : a.distKm != null && a.distKm <= reach(lake));
}

// Health advisories on eating fish caught here.
export async function fishAdviceFor(lake) {
  const f = await d.load('advisories');
  if (!f) return null;
  const site = f.advisories.filter(a => a.names.some(n => sameWater(lake.name, n)) || a.areas.some(([lat, lon, km]) => haversineKm(lake.lat, lake.lon, lat, lon) <= km));
  return { site, statewide: f.statewide, url: f.url, updatedAt: f.updatedAt };
}

// The rules for this water: special regulations that name it (in its county), its region's general limits,
// closed waters in its county, and the statewide rules.
export async function regsFor(lake) {
  const r = await d.load('regs');
  if (!r) return null;
  const at = await countyAt(lake.lat, lake.lon);
  const ndow = lake.ndowWaterId ? await reportFor(lake) : null;
  const county = at?.county ?? null, region = at?.region ?? ndow?.region ?? null;
  const special = r.waters.filter(w => (!county || !w.county || w.county === county) && [w.name, ...w.aliases].some(n => sameWater(lake.name, n)));
  return {
    county, region, special, regionRules: region ? r.regions[region] : null, closed: r.closed.filter(c => county && c.county === county),
    statewide: r.statewide, booklet: r.booklet, source: r.source, updatedAt: r.updatedAt,
  };
}
