// Drive-up or hike-in: how far the nearest road is from the shore of every lake and located stocked water in a state,
// from OpenStreetMap via the Overpass API. Runs monthly (.github/workflows/build-reach.yml).
//
//   node scripts/build-state-reach.mjs <ca|nv|or>
//   data/<st>/reach.json  { reach: { "<key>": value } }
//     key    n:<id in lakes.json> or s:<id in waters.json> (the app's pool key without the state)
//     value  "d" a road a car can take reaches the shore, "r" only a dirt track does,
//            a number: the far edge in km of the band the nearest road is in (0.8, 1.6, 3.2, 4.8, 8), 9: farther than 8
//
// The rule is the Getting there tab's (access-rules.js): the shore is shoreKm from the water's point, and a road within
// 0.4 km of it is at the water. Only counts are asked for (`out count`), one small circle per water, so the answers
// are a few bytes each. A water that couldn't be asked about keeps last month's value; when fewer than four in five
// answer, the old file stays.

import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { shoreKm } from '../access-rules.js';
import { haversineKm } from '../data-sources.js';
import { overpass } from './build-state-access.mjs';

export const AT = 0.4;
export const BANDS = [0.8, 1.6, 3.2, 4.8, 8];
// Each step asks the waters still open whether a road of that kind lies within `km` of the shore; a yes settles it.
const STEPS = [['car', AT, 'd'], ['track', AT, 'r'], ...BANDS.map(km => ['any', km, km])];
const CAR = 'trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|road';
const NO = '^(no|private|permit|customers|delivery|agricultural|forestry|military|discouraged)$'; // as access-lookup.js reads them
const OPEN = ['access', 'motor_vehicle', 'vehicle'].map(k => `["${k}"!~"${NO}"]`).join('');
const ROADS = { car: `["highway"~"^(${CAR})(_link)?$"]`, track: '["highway"="track"]', any: `["highway"~"^(${CAR}|track)(_link)?$"]` };

// A stocked water with no type on record is typed by its name, as the app does (water-facts.js).
const isStream = w => /river|creek|stream|slough|canal/i.test(w.type ?? (/river|creek|fork|section/i.test(w.name ?? '') ? 'River' : 'Lake'));
export function pointsFor(lakes, stocked) {
  const pt = (key, w, stream) => ({ key, name: w.name, lat: w.lat, lon: w.lon, acres: w.acres ?? null, shore: stream ? 0 : shoreKm(w) });
  return [...lakes.filter(w => w.lat != null).map(w => pt(`n:${w.id}`, w, false)),
    ...stocked.filter(w => w.lat != null).map(w => pt(`s:${w.id}`, w, isStream(w)))];
}

export const ringQuery = (points, kind, km) => '[out:json][timeout:300];\n'
  + points.map(p => `way(around:${Math.round((p.shore + km) * 1000)},${p.lat},${p.lon})${ROADS[kind]}${OPEN};out count;`).join('\n');

export function countsFrom(json, n) {
  const counts = (json?.elements ?? []).filter(e => e.type === 'count').map(e => +e.tags.ways);
  if (counts.length !== n || counts.some(Number.isNaN)) throw new Error(`${counts.length} of ${n} counts${json?.remark ? `: ${json.remark}` : ''}`);
  return counts;
}

// ask(points, kind, km) → for each point, how many such roads (null: couldn't be asked). A water nobody could ask
// about gets no value.
export async function survey(points, ask) {
  const out = new Map();
  let open = points;
  for (const [kind, km, value] of STEPS) {
    if (!open.length) break;
    const counts = await ask(open, kind, km);
    open = open.filter((p, i) => { if (counts[i] > 0) out.set(p.key, value); return counts[i] === 0; });
  }
  for (const p of open) out.set(p.key, 9);
  return out;
}

// Asks in batches. A batch the service chokes on is halved and asked again, down to `least` waters; those are given
// up (null). Past `deadline` nothing more is asked.
export function asker(fetchJson, { size = 120, least = 15, pause = 2000, deadline = Infinity } = {}) {
  const batch = async (pts, kind, km) => {
    if (Date.now() > deadline) return pts.map(() => null);
    try {
      const counts = countsFrom(await fetchJson(ringQuery(pts, kind, km)), pts.length);
      if (pause) await new Promise(r => setTimeout(r, pause));
      return counts;
    } catch (e) {
      console.error(`reach: ${pts.length} waters (${kind}, ${km} km) failed: ${e.message}`);
      if (pts.length <= least) return pts.map(() => null);
      const half = Math.ceil(pts.length / 2);
      return [...await batch(pts.slice(0, half), kind, km), ...await batch(pts.slice(half), kind, km)];
    }
  };
  return async (points, kind, km) => {
    const out = [];
    for (let i = 0; i < points.length; i += size) out.push(...await batch(points.slice(i, i + size), kind, km));
    return out;
  };
}

// A long reservoir's road can be past the circle (a canyon lake with the road at the dam). A boat ramp, marina, pier
// or rental within three shore-lengths of a water of 100 acres or more says you can drive to it.
export function rampAt(access, p) {
  if (!access || !(p.acres >= 100)) return false;
  const reach = p.shore * 3 + AT;
  return access.places.some(([lat, lon, kind]) => /^(ramp|marina|pier|rental)$/.test(kind) && Math.abs(lat - p.lat) < 0.3 && haversineKm(p.lat, p.lon, lat, lon) <= reach);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const st = String(process.argv[2] ?? '').toLowerCase();
  if (!['ca', 'nv', 'or'].includes(st)) throw new Error(`Unknown state "${st}": ca, nv or or`);
  const dir = new URL(`../data/${st}/`, import.meta.url);
  const read = f => readFile(new URL(f, dir), 'utf8').then(JSON.parse, () => null);
  const [lakes, stocked, access, old] = await Promise.all(['lakes.json', 'waters.json', 'access.json', 'reach.json'].map(read));
  const points = pointsFor(lakes?.lakes ?? [], stocked?.waters ?? []);
  if (!points.length) throw new Error(`No waters in data/${st}`);
  const minutes = +process.env.REACH_MINUTES || 30;
  const got = await survey(points, asker(overpass, { deadline: Date.now() + minutes * 60e3 }));
  const answered = got.size;
  if (answered < points.length * 0.8) throw new Error(`Only ${answered} of ${points.length} waters answered; keeping the old file`);
  const reach = {};
  let byRamp = 0, kept = 0;
  for (const p of points) {
    let v = got.get(p.key);
    if (v === undefined && old?.reach?.[p.key] !== undefined) { v = old.reach[p.key]; kept++; }
    if (v !== 'd' && rampAt(access, p)) { v = 'd'; byRamp++; }
    if (v !== undefined) reach[p.key] = v;
  }
  await writeFile(new URL('reach.json', dir), JSON.stringify({ updatedAt: new Date().toISOString(), source: 'OpenStreetMap contributors (ODbL), via Overpass API', reach }) + '\n');
  const tally = {};
  for (const v of Object.values(reach)) tally[v] = (tally[v] ?? 0) + 1;
  console.log(`reach ${st}: ${Object.keys(reach).length} of ${points.length} waters (${answered} answered, ${kept} kept from last time, ${byRamp} drive-up by a ramp)`, JSON.stringify(tally));
  // For reading the log: the biggest waters that came out as a walk (where the circle is most likely wrong), and some
  // well-known ones.
  const walk = points.filter(p => typeof reach[p.key] === 'number').sort((a, b) => (b.acres ?? 0) - (a.acres ?? 0)).slice(0, 15);
  console.log('biggest not drive-up:', walk.map(p => `${p.name} (${p.acres} ac) ${reach[p.key]}`).join('; '));
  const KNOWN = /^(Donner Lake|Lake Aloha|Thousand Island Lake|Caples Lake|Loch Leven Lakes|Gilmore Lake|Lake Tahoe|Shasta Lake|Marlette Lake|Lahontan Reservoir|Pyramid Lake|Angel Lake|Crater Lake|Wallowa Lake|Green Lakes|Odell Lake|Waldo Lake)$/;
  console.log('known:', points.filter(p => KNOWN.test(p.name ?? '') && p.key.startsWith('n:')).map(p => `${p.name} ${reach[p.key]}`).join('; '));
}
