// State registry: which state's data serves a water, and the state you've picked for searching.
// Each state module (states/<st>.js) exports the same functions; add a state by importing it here.
import * as CA from './ca.js';
import * as NV from './nv.js';

export const STATES = { CA, NV };
export const list = Object.values(STATES);

function inside([x, y], ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}

// The state whose rough outline holds this point. Just outside every outline (a river on the border), the state
// whose box holds it; null far from every state we have data for.
export function stateAt(lat, lon) {
  return list.find(s => inside([lon, lat], s.outline))
    ?? list.find(s => lon >= s.bbox[0] && lon <= s.bbox[2] && lat >= s.bbox[1] && lat <= s.bbox[3]) ?? null;
}

// The state module for a water: the state saved on it, else where it sits on the map.
export function forLake(lake) {
  return STATES[String(lake?.state ?? '').toUpperCase()] ?? (lake?.lat != null ? stateAt(lake.lat, lake.lon) : null);
}

// Lake level gauge for a water: its state's nearest or name-matching gauge. A station pinned under Edit may belong
// to the next state over (Lake Tahoe's gauge is California's), so look for it in every state.
export async function reservoirFor(lake) {
  const opts = { name: lake.name, acres: lake.acres };
  const S = forLake(lake);
  if (lake.cdecStation) {
    for (const st of [S, ...list.filter(x => x !== S)]) {
      const r = st && await st.nearestReservoir(lake.lat, lake.lon, lake.cdecStation, opts);
      if (r && r.id.toUpperCase() === String(lake.cdecStation).toUpperCase()) return r;
    }
  }
  // A gauge named for this water beats an unnamed nearby one, even across the state line (Lake Tahoe's
  // Nevada shore and California's Tahoe City gauge).
  const own = S ? await S.nearestReservoir(lake.lat, lake.lon, null, opts) : null;
  if (own?.named) return own;
  const base = String(lake.name ?? '').split(/\s+[–—-]\s+/)[0];
  for (const st of list.filter(x => x !== S)) {
    const r = await st.nearestReservoir(lake.lat, lake.lon, null, { ...opts, name: base, maxKm: 40 });
    if (r?.named) return r;
  }
  return own;
}

// The state's stocked-water id saved on a lake (CDFW stock id, NDOW water slug), or null.
export function stockIdOf(lake) {
  const s = forLake(lake);
  return s ? lake[s.stockField] ?? null : null;
}

// States whose box overlaps a map view (Leaflet LatLngBounds).
export function statesIn(bounds) {
  return list.filter(s => bounds.getWest() < s.bbox[2] && bounds.getEast() > s.bbox[0] && bounds.getSouth() < s.bbox[3] && bounds.getNorth() > s.bbox[1]);
}

// The state you search and browse in the Lakes view. Remembered on this device only.
const KEY = 'tb-state';
export function selected(lakes = []) {
  let code = null;
  try { code = localStorage.getItem(KEY); } catch {}
  if (STATES[code]) return STATES[code];
  // First run: the state most of your saved waters are in, else California.
  const counts = {};
  for (const l of lakes) { const s = forLake(l); if (s) counts[s.code] = (counts[s.code] ?? 0) + 1; }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
  return STATES[top] ?? CA;
}
export function select(code) {
  try { localStorage.setItem(KEY, code); } catch {}
}
