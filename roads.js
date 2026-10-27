// The drive in: chain controls and full road closures on the highways around a water, and the high passes that close
// for winter. Caltrans publishes both live (CWWP2, open to browsers), so California roads are read on the phone;
// Nevada's and Oregon's live feeds need a key or don't answer browsers, so those get the agency's own map links.
// There's no routing: the app doesn't know where you start, so it shows what is within about 60 miles of the water.
import { haversineKm } from './data-sources.js';

export const NEAR_KM = 100;
const CC_DISTRICTS = [1, 2, 3, 6, 7, 8, 9, 10, 11]; // the districts with chain-control points
const ccUrl = d => `https://cwwp2.dot.ca.gov/data/d${d}/cc/ccStatusD${String(d).padStart(2, '0')}.json`;
const lcsUrl = d => `https://cwwp2.dot.ca.gov/data/d${d}/lcs/lcsStatusD${String(d).padStart(2, '0')}.json`;
const MAX_AGE = 30 * 60e3; // conditions change by the hour
const CACHE = 'tb-access';

// Caltrans chain-control levels (statusDescription carries the full wording).
export const CHAIN_LEVELS = {
  'R-0': { short: 'No chains', level: 0 },
  'R-1': { short: 'R1: chains or snow tires', level: 1 },
  'R-2': { short: 'R2: chains unless 4WD with snow tires', level: 2 },
  'R-3': { short: 'R3: chains on all vehicles', level: 3 },
};
export const CHAIN_INFO_URL = 'https://dot.ca.gov/travel/winter-driving-tips/chain-controls';

// Agencies' live maps for each state, and what their chain codes mean.
export const STATE_ROADS = {
  CA: { name: 'Caltrans QuickMap', url: 'https://quickmap.dot.ca.gov/', phone: '1-800-427-7623', more: { name: 'Caltrans road conditions by highway', url: 'https://roads.dot.ca.gov/' } },
  NV: { name: 'NDOT Nevada Roads (511)', url: 'https://www.nvroads.com/', phone: '511', more: { name: 'NDOT traction and chain requirements', url: 'https://www.dot.nv.gov/safety/safe-winter-driving/traction-and-chain-requirement-descriptions' } },
  OR: { name: 'ODOT TripCheck', url: 'https://www.tripcheck.com/', phone: '511', more: { name: 'TripCheck road conditions (text)', url: 'https://www.tripcheck.com/DynamicReports/Report/RoadConditions' } },
};

// High passes that close for the winter. They reopen when crews clear them (some years June), so the line says to
// check, never a date. lat/lon is the summit.
export const SEASONAL_PASSES = [
  { name: 'Tioga Pass (SR-120, Yosemite)', lat: 37.9107, lon: -119.2577, state: 'CA', note: 'Closes with the first big snow (often November) and opens in late spring or early summer.', url: 'https://www.nps.gov/yose/planyourvisit/conditions.htm' },
  { name: 'Sonora Pass (SR-108)', lat: 38.3283, lon: -119.6364, state: 'CA', note: 'Closed through the winter, usually from November until late spring.', url: 'https://roads.dot.ca.gov/roadscell.php?roadnumber=108' },
  { name: 'Ebbetts Pass (SR-4)', lat: 38.5446, lon: -119.8130, state: 'CA', note: 'Closed past Bear Valley through the winter, usually from November until spring.', url: 'https://roads.dot.ca.gov/roadscell.php?roadnumber=4' },
  { name: 'Monitor Pass (SR-89)', lat: 38.6727, lon: -119.6113, state: 'CA', note: 'Closed through the winter, usually from November until spring.', url: 'https://roads.dot.ca.gov/roadscell.php?roadnumber=89' },
  { name: 'Lassen Park Highway (SR-89 in the park)', lat: 40.4600, lon: -121.5050, state: 'CA', note: 'Closed through the park in winter, usually from November until late spring or June.', url: 'https://www.nps.gov/lavo/planyourvisit/conditions.htm' },
  { name: 'Glacier Point Road (Yosemite)', lat: 37.7270, lon: -119.5740, state: 'CA', note: 'Closed past Badger Pass in winter.', url: 'https://www.nps.gov/yose/planyourvisit/conditions.htm' },
  { name: 'McKenzie Pass (OR-242)', lat: 44.2600, lon: -121.8100, state: 'OR', note: 'Closed to cars from November until about June.', url: 'https://www.tripcheck.com/' },
  { name: 'Crater Lake Rim Drive', lat: 42.9440, lon: -122.1090, state: 'OR', note: 'Rim Drive and the north entrance are closed in winter, usually from November until early summer.', url: 'https://www.nps.gov/crla/planyourvisit/conditions.htm' },
];

const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

async function getJson(url, { fetchImpl = fetch } = {}) {
  const key = `https://tackle-box.local/__roads/${encodeURIComponent(url)}`;
  const c = globalThis.caches && await caches.open(CACHE).catch(() => null);
  const hit = c && await c.match(key);
  if (hit) { const j = await hit.json(); if (Date.now() - j.at < MAX_AGE) return j; }
  try {
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(20e3) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = { at: Date.now(), data: await r.json() };
    c?.put(key, new Response(JSON.stringify(j), { headers: { 'Content-Type': 'application/json' } }));
    return j;
  } catch (e) {
    if (hit) return { ...(await hit.clone().json()), stale: true }; // no signal: the last copy, with its age
    throw e;
  }
}

// One chain-control point: { route, name, place, lat, lon, direction, code, level, text, since, km }.
export function readChain(rec, lat, lon) {
  const cc = rec?.cc ?? rec, l = cc?.location ?? {}, s = cc?.statusData ?? {};
  const pLat = num(l.latitude), pLon = num(l.longitude);
  if (pLat == null || pLon == null || String(cc?.inService) === 'false') return null;
  const code = String(s.status ?? '').trim();
  const ts = s.statusTimestamp ?? {};
  return { route: l.route ?? '', name: l.locationName ?? '', place: l.nearbyPlace ?? '', lat: pLat, lon: pLon, direction: l.direction ?? '',
    code, level: CHAIN_LEVELS[code]?.level ?? (/^R-?\d/.test(code) ? +code.replace(/\D/g, '') : 0), text: s.statusDescription ?? '',
    since: ts.statusDate ? `${ts.statusDate}T${ts.statusTime ?? '00:00:00'}` : null, km: haversineKm(lat, lon, pLat, pLon) };
}

// A full closure of a highway's main lanes that's on now or starts within `days`. Construction on side streets,
// ramps and rest areas doesn't stop you getting there, so those are left out.
export function readClosure(rec, lat, lon, now = Date.now(), days = 3) {
  const x = rec?.lcs ?? rec, b = x?.location?.begin ?? {}, e = x?.location?.end ?? {}, c = x?.closure ?? {};
  if (!/full/i.test(c.typeOfClosure ?? '') || (c.facility && !/mainline|highway/i.test(c.facility))) return null;
  const pts = [[num(b.beginLatitude), num(b.beginLongitude)], [num(e.endLatitude), num(e.endLongitude)]].filter(p => p[0] != null && p[1] != null);
  if (!pts.length) return null;
  const ts = c.closureTimestamp ?? c;
  const start = Date.parse(`${ts.closureStartDate}T${ts.closureStartTime ?? '00:00:00'}`), endIndef = String(ts.isClosureEndIndefinite) === 'true';
  const end = endIndef ? Infinity : Date.parse(`${ts.closureEndDate}T${ts.closureEndTime ?? '23:59:00'}`);
  if (Number.isFinite(end) && end < now) return null;
  if (Number.isFinite(start) && start > now + days * 864e5) return null;
  return { route: b.beginRoute ?? e.endRoute ?? '', from: b.beginLocationName ?? '', to: e.endLocationName ?? '', place: b.beginNearbyPlace ?? '',
    lat: pts[0][0], lon: pts[0][1], km: Math.min(...pts.map(p => haversineKm(lat, lon, p[0], p[1]))),
    start: Number.isFinite(start) ? new Date(start).toISOString() : null, end: Number.isFinite(end) ? new Date(end).toISOString() : null, indefinite: endIndef,
    work: c.typeOfWork ?? '', duration: c.durationOfClosure ?? '', direction: x?.location?.travelFlowDirection ?? '' };
}

// Everything for one water. Returns { chains: [routes with their points], closures, passes, failed, at, stale }.
// Chain points come grouped by highway, nearest first; a highway shows its worst control.
export async function roadsNear(lake, { km = NEAR_KM, fetchImpl, now = Date.now() } = {}) {
  const lat = +lake.lat, lon = +lake.lon, failed = [];
  let at = now, stale = false;
  const districts = new Set();
  const points = [];
  await Promise.all(CC_DISTRICTS.map(async d => {
    try {
      const j = await getJson(ccUrl(d), { fetchImpl });
      at = Math.min(at, j.at); stale ||= !!j.stale;
      for (const r of j.data?.data ?? []) { const p = readChain(r, lat, lon); if (p && p.km <= km) { points.push(p); districts.add(d); } }
    } catch { failed.push(`chain controls (district ${d})`); }
  }));
  // Closures: only the districts with chain points nearby (the big city districts' files run to megabytes).
  const closures = [];
  await Promise.all([...districts].map(async d => {
    try {
      const j = await getJson(lcsUrl(d), { fetchImpl });
      for (const r of j.data?.data ?? []) { const c = readClosure(r, lat, lon, now); if (c && c.km <= km) closures.push(c); }
    } catch { failed.push(`closures (district ${d})`); }
  }));
  const byRoute = new Map();
  // Districts overlap at their edges, and a point can be listed by both: one of each place and direction.
  const seenPts = new Set();
  for (const p of points.sort((a, b) => a.km - b.km)) {
    const k = `${p.route}|${p.name}|${p.direction}`;
    if (seenPts.has(k)) continue;
    seenPts.add(k);
    const r = byRoute.get(p.route) ?? { route: p.route, km: p.km, worst: 0, points: [] };
    r.points.push(p); r.worst = Math.max(r.worst, p.level);
    byRoute.set(p.route, r);
  }
  const seen = new Set();
  const uniq = closures.sort((a, b) => a.km - b.km).filter(c => { const k = `${c.route}|${c.from}|${c.to}|${c.start}`; return !seen.has(k) && seen.add(k); });
  const passes = SEASONAL_PASSES.map(p => ({ ...p, km: haversineKm(lat, lon, p.lat, p.lon) })).filter(p => p.km <= km).sort((a, b) => a.km - b.km);
  return { chains: [...byRoute.values()], closures: uniq.slice(0, 12), passes, failed, at: new Date(at).toISOString(), stale };
}

// Winter-ish: chains matter from October through May (or any month a control is up).
export const chainSeason = (d = new Date()) => d.getMonth() >= 9 || d.getMonth() <= 4;
