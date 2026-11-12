// The one set of filter settings and the per-water decision behind it, shared by the "Where should I go?" list
// (views/finder.js) and the map's pins (map-filters.js). Checks that need no lookups live in water-filter-core.js;
// this adds the settings kept on the phone, where distance is measured from, and the checks that read a water's
// facts (fish, access, stocking, your catches, algae).
import { db } from './db.js';
import { locate } from './map.js';
import { clean } from './water-filter-core.js';
import { factsFor, habFor, addFish, hasFish } from './water-facts.js';
import { iceEstimate, allIceLogs } from './know-water.js';

const HOME = 'tackle-box-home', PREFS = 'tackle-box-finder';
const read = k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
export const prefs = () => clean(read(PREFS));
export const savePrefs = patch => { const P = clean({ ...prefs(), ...patch }); write(PREFS, P); return P; };
export const home = () => read(HOME);
export const setHomePoint = ({ lat, lon }) => write(HOME, { lat, lon });

// Where distance is measured from: home or where you are, as picked; left to itself, home when you've set one.
// null when that can't be had (no home set, or location is off).
export async function origin(P = prefs()) {
  const h = home();
  if (P.from !== 'me' && h) return { ...h, label: 'home' };
  if (P.from === 'home') return null;
  try { return { ...await locate(), label: 'where you are' }; } catch { return null; }
}

// Your lakes, your catches by lake, and whether a water is likely iced over today (the ice estimate, with your ice notes).
export async function context() {
  const [saved, catches, logs] = await Promise.all([db.all('lakes'), db.all('catches'), allIceLogs()]);
  const caught = new Map();
  for (const c of catches) if (c.lakeId) (caught.get(c.lakeId) ?? caught.set(c.lakeId, []).get(c.lakeId)).push(c);
  const iced = e => ['iced', 'going'].includes(iceEstimate(e, { logs, allLogs: logs, lakes: saved })?.state);
  return { saved, caught, iced };
}

// An entry (water-facts.js) as the quick checks read it. Size and elevation come from the state's list, else from
// what you saved on the water.
export function shape(e) {
  const w = e.w ?? e.stock ?? {}, s = e.saved ?? null;
  return { lat: e.lat, lon: e.lon, type: e.type, acres: w.acres ?? s?.acres ?? null, elevationFt: w.elevationFt ?? s?.elevationFt ?? null,
    maxDepth: w.maxDepthFt ?? w.maxDepth ?? s?.maxDepth ?? null, saved: s, id: s?.id };
}

// Whether a water passes the settings that need lookups, for the map's pins (no card to fill). With nothing but the
// algae filter on, its fish, access and stocking needn't be looked up at all.
export const passes = async (e, P, ctx) => P.fish.length || P.access.length || P.stocked || P.mine ? !!(await fullPass(e, P, ctx)).hit
  : !(P.noAlgae && e.S && await habFor(e));

// One water against the settings that need its facts. `hit` is the row for a card (the entry plus its facts, fish
// with your own catches added, and how many you've logged), or null. `unknown`: it failed only because the app has no
// fish or access records for it. `stockKey`: the stocked water this lake stands for, so that one shows once.
export async function fullPass(entry, P, ctx, savedFor = new Map()) {
  const f = await factsFor(entry);
  const stockKey = entry.w && f.stock ? `${entry.S.code}:s:${f.stock.id}` : null;
  // As your saved copy if you added it from the stocked list.
  const e = { ...entry, saved: entry.saved ?? savedFor.get(stockKey) };
  const mine = e.saved ? ctx.caught.get(e.saved.id) ?? [] : [];
  const fish = new Map([...f.fish].map(([g, s]) => [g, new Set(s)]));
  for (const s of [...mine.map(c => c.species), ...String(e.saved?.species ?? '').split(/,|;/)]) addFish(fish, s, 'yours');
  const r = { ...e, f, fish, mine: mine.length };
  const cutoff = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  let hit = null, unknown = false;
  if (P.saved && !e.saved) ;
  else if (P.fish.length && !P.fish.some(g => hasFish(fish, g))) unknown = !fish.size;
  else if (P.access.length && !(f.access && P.access.every(k => f.access.has(k)))) unknown = !f.access;
  else if (P.stocked && !(f.lastPlant && f.lastPlant >= cutoff)) ;
  else if (P.mine && !r.mine) ;
  else if ((r.hab = await habFor(e)) && P.noAlgae) ;
  else hit = r;
  return { hit, unknown, stockKey };
}
