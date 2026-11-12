// Drive-up or hike-in: how far the nearest road is from the shore of every lake and located stocked water, from
// OpenStreetMap. Runs monthly (.github/workflows/build-reach.yml), which downloads each state's extract from
// Geofabrik and cuts the roads out of it with scripts/reach-roads.sh, so no map service is asked thousands of
// questions.
//
//   node scripts/build-reach.mjs ca=<roads.geojsonseq> nv=<…> or=<…>     (any of the three)
//   data/<st>/reach.json  { reach: { "<key>": value } }
//     key    n:<id in lakes.json> or s:<id in waters.json> (the app's pool key without the state)
//     value  "d" a road a car can take reaches the shore, "r" only a dirt track does,
//            a number: the far edge in km of the band the nearest road is in (0.8, 1.6, 3.2, 4.8, 8), 9: farther than 8
//
// The rule is the Getting there tab's (access-rules.js): the shore is shoreKm from the water's point, and a road within
// 0.4 km of it is at the water. Every state's roads count for every state's waters, so a lake on a state line sees the
// road on the other side. A state whose road file is missing or too small keeps its old file.

import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { shoreKm, distKmToLine } from '../access-rules.js';
import { haversineKm } from '../data-sources.js';

export const AT = 0.4;
export const BANDS = [0.8, 1.6, 3.2, 4.8, 8];
const FAR = BANDS.at(-1);
// The fewest road lines a whole state can have (California has millions).
const MIN_ROADS = { ca: 500000, nv: 50000, or: 100000 };
const CAR = /^(trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|road)(_link)?$/;
const NO = /^(no|private|permit|customers|delivery|agricultural|forestry|military|discouraged)$/; // as access-lookup.js reads them

// A stocked water with no type on record is typed by its name, as the app does (water-facts.js).
const isStream = w => /river|creek|stream|slough|canal/i.test(w.type ?? (/river|creek|fork|section/i.test(w.name ?? '') ? 'River' : 'Lake'));
export function pointsFor(lakes, stocked) {
  const pt = (key, w, stream) => ({ key, name: w.name, lat: w.lat, lon: w.lon, acres: w.acres ?? null, shore: stream ? 0 : shoreKm(w) });
  return [...lakes.filter(w => w.lat != null).map(w => pt(`n:${w.id}`, w, false)),
    ...stocked.filter(w => w.lat != null).map(w => pt(`s:${w.id}`, w, isStream(w)))];
}

// 'car' a road a car can take, 'track' a dirt track, null for anything the public can't drive (or stop on).
export function roadKind(t) {
  const kind = t.highway === 'track' ? 'track' : CAR.test(t.highway ?? '') ? 'car' : null;
  return kind && ![t.access, t.motor_vehicle, t.vehicle].some(v => NO.test(v ?? '')) ? kind : null;
}

// One line of a road file (GeoJSON text sequence) as { kind, coords: [[lat, lon], …] }, or null.
export function roadFrom(line) {
  const text = line.replace(/^\x1e/, '').trim();
  if (!text) return null;
  let f;
  try { f = JSON.parse(text); } catch { return null; }
  const kind = f.geometry?.type === 'LineString' ? roadKind(f.properties ?? {}) : null;
  return kind ? { kind, coords: f.geometry.coordinates.map(([lon, lat]) => [lat, lon]) } : null;
}

// `near` = km from the shore to the nearest car road and the nearest track (Infinity: none within reach).
export function valueFor(near) {
  if (near.car <= AT) return 'd';
  if (near.track <= AT) return 'r';
  const km = Math.min(near.car, near.track);
  return BANDS.find(b => km <= b) ?? 9;
}

// Feed it every road; it keeps, for each water, the nearest of each kind within 8 km of the shore. Waters are filed
// in tenth-of-a-degree squares, so a road is only measured against the waters around it.
export function finder(points) {
  const CELL = 0.1, cells = new Map(), near = new Map();
  const cell = (lat, lon) => `${Math.floor(lat / CELL)}:${Math.floor(lon / CELL)}`;
  for (const p of points) {
    near.set(p.key, { car: Infinity, track: Infinity });
    const dLat = (p.shore + FAR) / 110.57, dLon = (p.shore + FAR) / (111.32 * Math.cos(p.lat * Math.PI / 180));
    for (let y = Math.floor((p.lat - dLat) / CELL); y <= Math.floor((p.lat + dLat) / CELL); y++) {
      for (let x = Math.floor((p.lon - dLon) / CELL); x <= Math.floor((p.lon + dLon) / CELL); x++) {
        const k = `${y}:${x}`;
        (cells.get(k) ?? cells.set(k, []).get(k)).push(p);
      }
    }
  }
  return {
    add(kind, coords) {
      let s = 90, n = -90, w = 180, e = -180;
      for (const [lat, lon] of coords) { if (lat < s) s = lat; if (lat > n) n = lat; if (lon < w) w = lon; if (lon > e) e = lon; }
      const seen = new Set();
      for (let y = Math.floor(s / CELL); y <= Math.floor(n / CELL); y++) {
        for (let x = Math.floor(w / CELL); x <= Math.floor(e / CELL); x++) {
          for (const p of cells.get(`${y}:${x}`) ?? []) {
            if (seen.has(p)) continue;
            seen.add(p);
            const km = Math.max(0, distKmToLine(p.lat, p.lon, coords) - p.shore), best = near.get(p.key);
            if (km <= FAR && km < best[kind]) best[kind] = km;
          }
        }
      }
    },
    nearest: key => near.get(key),
    values: () => new Map([...near].map(([key, v]) => [key, valueFor(v)])),
  };
}

// A long reservoir's road can be past the circle (a canyon lake with the road at the dam). A boat ramp, marina, pier
// or rental within three shore-lengths of a water of 100 acres or more says you can drive to it.
export function rampAt(access, p) {
  if (!access?.places || !(p.acres >= 100)) return false;
  const reach = p.shore * 3 + AT;
  return access.places.some(([lat, lon, kind]) => /^(ramp|marina|pier|rental)$/.test(kind) && Math.abs(lat - p.lat) < 0.3 && haversineKm(p.lat, p.lon, lat, lon) <= reach);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const files = Object.fromEntries(process.argv.slice(2).map(a => a.split('=')));
  const states = Object.keys(files);
  if (!states.length || states.some(st => !(st in MIN_ROADS) || !files[st])) throw new Error('Usage: node scripts/build-reach.mjs ca=<roads.geojsonseq> nv=<…> or=<…>');
  const data = {};
  for (const st of states) {
    const dir = new URL(`../data/${st}/`, import.meta.url);
    const read = f => readFile(new URL(f, dir), 'utf8').then(JSON.parse, () => null);
    const [lakes, stocked, access] = await Promise.all(['lakes.json', 'waters.json', 'access.json'].map(read));
    // The same id can be in two states' lists, so a water is filed under its state here.
    data[st] = { dir, access, points: pointsFor(lakes?.lakes ?? [], stocked?.waters ?? []).map(p => ({ ...p, key: `${st}:${p.key}` })) };
  }
  const find = finder(states.flatMap(st => data[st].points));
  for (const st of states) {
    const d = data[st], t = Date.now();
    d.lines = 0; d.roads = 0;
    try {
      for await (const line of createInterface({ input: createReadStream(files[st]), crlfDelay: Infinity })) {
        d.lines++;
        const r = roadFrom(line);
        if (r) { find.add(r.kind, r.coords); d.roads++; }
      }
    } catch (e) { console.error(`reach ${st}: ${files[st]}: ${e.message}`); }
    console.log(`reach ${st}: ${d.lines} road lines, ${d.roads} open to motor vehicles, ${Math.round((Date.now() - t) / 1000)} s`);
  }
  const values = find.values();
  let failed = false;
  const KNOWN = /^(Donner Lake|Lake Aloha|Thousand Island Lake|Caples Lake|Loch Leven Lakes|Gilmore Lake|Lake Tahoe|Shasta Lake|Boca Reservoir|Independence Lake|Marlette Lake|Lahontan Reservoir|Pyramid Lake|Angel Lake|Liberty Lake|Crater Lake|Wallowa Lake|Odell Lake|Waldo Lake|Mirror Lake)$/;
  for (const st of states) {
    const d = data[st];
    if (!d.points.length || d.lines < MIN_ROADS[st]) { console.error(`reach ${st}: ${d.points.length} waters and ${d.lines} road lines is not a whole state; keeping the old file`); failed = true; continue; }
    const reach = {}, tally = {};
    let byRamp = 0;
    for (const p of d.points) {
      const v = values.get(p.key) !== 'd' && rampAt(d.access, p) ? (byRamp++, 'd') : values.get(p.key);
      reach[p.key.slice(st.length + 1)] = v;
      tally[v] = (tally[v] ?? 0) + 1;
    }
    await writeFile(new URL('reach.json', d.dir), JSON.stringify({ updatedAt: new Date().toISOString(), source: 'OpenStreetMap contributors (ODbL), from Geofabrik extracts', reach }) + '\n');
    console.log(`reach ${st}: ${d.points.length} waters (${byRamp} drive-up by a ramp)`, JSON.stringify(tally));
    // For reading the log: the biggest waters that came out as a walk (where the circle is most likely wrong), and
    // some well-known ones with the distances behind their value.
    const val = p => reach[p.key.slice(st.length + 1)];
    const walk = d.points.filter(p => typeof val(p) === 'number').sort((a, b) => (b.acres ?? 0) - (a.acres ?? 0)).slice(0, 15);
    console.log(`reach ${st} biggest not drive-up:`, walk.map(p => `${p.name} (${p.acres} ac) ${val(p)}`).join('; '));
    const km = n => Number.isFinite(n) ? n.toFixed(1) : '-';
    console.log(`reach ${st} known:`, d.points.filter(p => KNOWN.test(p.name ?? '') && p.key.includes(':n:') && p.acres >= 10)
      .map(p => `${p.name} ${val(p)} (road ${km(find.nearest(p.key).car)} km, track ${km(find.nearest(p.key).track)} km)`).join('; '));
  }
  if (failed) process.exit(1);
}
