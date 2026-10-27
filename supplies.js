// Last gas, ice and bait: the fuel stations, stores (where ice and drinks usually are) and bait and tackle shops
// closest to a water, from OpenStreetMap. It's straight-line distance from the water, not a route: the app doesn't know
// your way in. Kept on the phone for 30 days, and saved by Ready for no signal, so it's there past the last bar.
import { haversineKm } from './data-sources.js';

const OVERPASS = 'https://overpass-api.de/api/interpreter';
const CACHE = 'tb-access';
export const SUPPLY_KM = 50;
export const MAX_AGE_DAYS = 30;
const keyFor = lake => `https://tackle-box.local/__supplies/${lake.nhdId ? `nhd-${lake.nhdId}` : `${(+lake.lat).toFixed(3)},${(+lake.lon).toFixed(3)}`}.json`;

export const KINDS = {
  gas: { icon: '⛽', label: 'Gas' },
  store: { icon: '🧊', label: 'Store (ice, food)' },
  bait: { icon: '🪱', label: 'Bait and tackle' },
};

// What a place is for this list. A gas station with a shop counts as gas (and usually has ice); a fishing shop or a
// store tagged with bait counts as bait.
export function kindOf(tags = {}) {
  if (tags.shop === 'fishing' || tags.bait === 'yes' || tags.fishing === 'yes' || /fishing|bait/i.test(tags.shop ?? '') || /\bbait\b/i.test(tags.name ?? '')) return 'bait';
  if (tags.amenity === 'fuel') return 'gas';
  if (/^(convenience|supermarket|general|grocery)$/.test(tags.shop ?? '')) return 'store';
  if (/^(outdoor|hunting)$/.test(tags.shop ?? '')) return 'bait';
  return null;
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export function bearing(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180, y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
  return COMPASS[Math.round(((Math.atan2(y, x) / r + 360) % 360) / 45) % 8];
}

export function readPlace(el, lat, lon) {
  const t = el.tags ?? {}, pLat = el.lat ?? el.center?.lat, pLon = el.lon ?? el.center?.lon;
  const kind = kindOf(t);
  if (!kind || pLat == null || pLon == null) return null;
  const town = t['addr:city'] || t['addr:place'] || '';
  return { kind, name: t.name || t.brand || (kind === 'gas' ? 'Gas station' : kind === 'bait' ? 'Bait shop' : 'Store'), town,
    lat: +pLat.toFixed(5), lon: +pLon.toFixed(5), km: haversineKm(lat, lon, pLat, pLon), dir: bearing(lat, lon, pLat, pLon),
    hours: t.opening_hours ?? '', phone: t.phone ?? t['contact:phone'] ?? '', diesel: t['fuel:diesel'] === 'yes',
    osm: `https://www.openstreetmap.org/${el.type}/${el.id}` };
}

export async function cachedSupplies(lake) {
  const c = globalThis.caches && await caches.open(CACHE).catch(() => null);
  const r = c && await c.match(keyFor(lake));
  return r ? r.json() : null;
}

// { at, places: { gas: [...], store: [...], bait: [...] } } nearest first, up to 5 of each.
export async function lookupSupplies(lake, { force = false, fetchImpl = fetch } = {}) {
  const lat = +lake.lat, lon = +lake.lon;
  const old = await cachedSupplies(lake).catch(() => null);
  if (old && !force && Date.now() - Date.parse(old.at) < MAX_AGE_DAYS * 864e5) return old;
  const m = SUPPLY_KM * 1000, a = `(around:${m},${lat},${lon})`;
  const q = `[out:json][timeout:60];(nwr${a}["amenity"="fuel"];nwr${a}["shop"~"^(fishing|convenience|supermarket|general|outdoor|hunting)$"];nwr${a}["bait"="yes"];);out center tags 400;`;
  let last;
  for (const wait of [0, 4000, 12000]) {
    if (wait) await new Promise(r => setTimeout(r, wait));
    try {
      const r = await fetchImpl(OVERPASS, { method: 'POST', body: new URLSearchParams({ data: q }), signal: AbortSignal.timeout(70000) });
      if (r.status === 429 || r.status >= 500) { last = new Error(`${r.status}: server busy`); continue; }
      if (!r.ok) throw new Error(`${r.status}`);
      const j = await r.json();
      const places = { gas: [], store: [], bait: [] };
      for (const el of j.elements ?? []) { const p = readPlace(el, lat, lon); if (p) places[p.kind].push(p); }
      for (const k of Object.keys(places)) places[k] = places[k].sort((x, y) => x.km - y.km).slice(0, 5);
      const out = { at: new Date().toISOString(), places };
      const c = globalThis.caches && await caches.open(CACHE).catch(() => null);
      await c?.put(keyFor(lake), new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json' } }));
      return out;
    } catch (e) {
      last = e;
      if (e.name === 'TimeoutError' || e.name === 'AbortError' || globalThis.navigator?.onLine === false) break;
    }
  }
  if (old) return { ...old, stale: true };
  throw last ?? new Error('Overpass unreachable');
}
