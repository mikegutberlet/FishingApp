// Drive-up or hike-in: how far the nearest road is from the shore of every lake and located stocked water, from
// OpenStreetMap. Runs monthly (.github/workflows/build-reach.yml), which downloads each state's extract from
// Geofabrik and cuts the roads out of it with scripts/reach-roads.sh, so no map service is asked thousands of
// questions.
//
//   node scripts/build-reach.mjs ca=<prefix> nv=<prefix> or=<prefix>     (any of the three)
//     reads <prefix>-roads.geojsonseq and, when it is there, <prefix>-water.geojsonseq
//   data/<st>/reach.json  { reach: { "<key>": value } }
//     key    n:<id in lakes.json> or s:<id in waters.json> (the app's pool key without the state)
//     value  "d" a road a car can take reaches the shore, "r" only a dirt track does,
//            a number: the far edge in km of the band the nearest road is in (0.8, 1.6, 3.2, 4.8, 8), 9: farther than 8
//
// A road within 0.4 km of the shore is at the water (the Getting there tab's rule, access-rules.js). The shore is the
// lake's own outline where OpenStreetMap draws one around the water's point and its size fits; otherwise it is
// shoreKm from the point, as on the tab. Every state's roads count for every state's waters, so a lake on a state
// line sees the road on the other side. A state whose road file is missing or too small keeps its old file.

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
  const pt = (key, w, stream) => ({ key, name: w.name, lat: w.lat, lon: w.lon, acres: w.acres ?? null, stream, shore: stream ? 0 : shoreKm(w) });
  return [...lakes.filter(w => w.lat != null).map(w => pt(`n:${w.id}`, w, false)),
    ...stocked.filter(w => w.lat != null).map(w => pt(`s:${w.id}`, w, isStream(w)))];
}

// 'car' a road a car can take, 'track' a dirt track, null for anything the public can't drive (or stop on).
export function roadKind(t) {
  const kind = t.highway === 'track' ? 'track' : CAR.test(t.highway ?? '') ? 'car' : null;
  return kind && ![t.access, t.motor_vehicle, t.vehicle].some(v => NO.test(v ?? '')) ? kind : null;
}

// One line of a file (GeoJSON text sequence), or null.
function parse(line) {
  const text = line.replace(/^\x1e/, '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}
const latLon = coords => coords.map(([lon, lat]) => [lat, lon]);

// One line of a road file as { kind, coords: [[lat, lon], …] }, or null.
export function roadFrom(line) {
  const f = parse(line);
  const kind = f?.geometry?.type === 'LineString' ? roadKind(f.properties ?? {}) : null;
  return kind ? { kind, coords: latLon(f.geometry.coordinates) } : null;
}

// One line of a water file as its outer rings [[[lat, lon], …], …], or null. Rivers and canals drawn as areas are
// left out: a pond's point inside one would take the whole river for its shore.
export function waterFrom(line) {
  const f = parse(line), g = f?.geometry;
  if (!g || /^(river|stream|canal|ditch|drain)$/.test(f.properties?.water ?? '')) return null;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : null;
  return polys ? polys.map(p => latLon(p[0])) : null;
}

const KM_LAT = 110.57, kmLon = lat => 111.32 * Math.cos(lat * Math.PI / 180);
const boundsOf = pts => {
  let s = 90, n = -90, w = 180, e = -180;
  for (const [lat, lon] of pts) { if (lat < s) s = lat; if (lat > n) n = lat; if (lon < w) w = lon; if (lon > e) e = lon; }
  return { s, n, w, e };
};
function inRing(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i], [yj, xj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function ringAcres(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][1] * ring[i][0] - ring[i][1] * ring[j][0];
  return Math.abs(a) / 2 * KM_LAT * kmLon(ring[0][0]) / 0.004047;
}

// Shore points along a ring, no more than `step` km apart (wider on a very long shore, to keep at most `max`).
export function outlineOf(ring, step = 0.15, max = 4000) {
  const km = (a, b) => Math.hypot((a[0] - b[0]) * KM_LAT, (a[1] - b[1]) * kmLon(a[0]));
  let total = 0;
  for (let i = 1; i < ring.length; i++) total += km(ring[i - 1], ring[i]);
  const gap = Math.max(step, total / Math.max(1, max - ring.length)), out = [];
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1], b = ring[i], n = Math.max(1, Math.ceil(km(a, b) / gap));
    for (let k = 0; k < n; k++) out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
  }
  return out;
}

// Offer it every drawn water; each lake keeps the ring around its point whose size is nearest its own. A ring more
// than five times bigger or smaller than the lake on record is something else (a bay it sits in, an island pond),
// and a lake with no size on record only takes a ring under 2,000 acres. A point that is in no ring of its size (a
// reservoir's point is often at the dam, a winding one's on a bend of dry land) takes the ring of its size whose
// shore passes within the lake's own radius of it.
export function matcher(points) {
  const CELL = 0.1, cells = new Map(), best = new Map(), wrong = new Map(), FIT = Math.log(5);
  for (const p of points) {
    if (p.stream) continue;
    const k = `${Math.floor(p.lat / CELL)}:${Math.floor(p.lon / CELL)}`;
    (cells.get(k) ?? cells.set(k, []).get(k)).push(p);
  }
  return {
    offer(rings) {
      for (const ring of rings) {
        const b = boundsOf(ring);
        let acres = null;
        // One square farther each way: a point beside the ring can be in the next square.
        for (let y = Math.floor(b.s / CELL) - 1; y <= Math.floor(b.n / CELL) + 1; y++) {
          for (let x = Math.floor(b.w / CELL) - 1; x <= Math.floor(b.e / CELL) + 1; x++) {
            for (const p of cells.get(`${y}:${x}`) ?? []) {
              const gap = Math.hypot(Math.max(0, b.s - p.lat, p.lat - b.n) * KM_LAT, Math.max(0, b.w - p.lon, p.lon - b.e) * kmLon(p.lat));
              const inside = gap === 0 && inRing(p.lat, p.lon, ring);
              if (!inside && !(p.acres > 0 && gap <= p.shore)) continue;
              acres ??= ringAcres(ring);
              const size = p.acres > 0 ? Math.abs(Math.log(acres / p.acres)) : acres <= 2000 ? acres / 1e6 : Infinity;
              if (size > FIT) {
                if (inside && p.acres > 0 && size < (wrong.get(p.key)?.size ?? Infinity)) wrong.set(p.key, { size, acres });
                continue;
              }
              // A ring beside the point never beats one around it.
              const off = inside ? size : size + FIT + 1;
              if (off >= (best.get(p.key)?.off ?? Infinity) || !inside && distKmToLine(p.lat, p.lon, ring) > p.shore) continue;
              best.set(p.key, { off, ring });
            }
          }
        }
      }
    },
    outlines: () => new Map([...best].map(([key, b]) => [key, outlineOf(b.ring)])),
    // For the log: lakes with no shoreline that sit in a drawn water of another size, with that water's acres.
    wrongSize: () => new Map([...wrong].filter(([key]) => !best.has(key)).map(([key, w]) => [key, Math.round(w.acres)])),
  };
}

// `near` = km from the shore to the nearest car road and the nearest track (Infinity: none within reach).
export function valueFor(near) {
  if (near.car <= AT) return 'd';
  if (near.track <= AT) return 'r';
  const km = Math.min(near.car, near.track);
  return BANDS.find(b => km <= b) ?? 9;
}

// Feed it every road; it keeps, for each water, the nearest of each kind within 8 km of the shore. The shore is the
// water's `outline` when it has one, else `shore` km around its point. Waters are filed in tenth-of-a-degree squares,
// so a road is only measured against the waters around it, and a water that already has a car road at its shore, or
// one nearer than this road can be, is skipped.
export function finder(points) {
  const CELL = 0.1, cells = new Map(), near = new Map();
  for (const p of points) {
    const pts = p.outline ?? [[p.lat, p.lon]], shore = p.outline ? 0 : p.shore, b = boundsOf(pts), lonKm = kmLon(p.lat);
    const w = { pts, shore, b, lonKm, best: { car: Infinity, track: Infinity } };
    near.set(p.key, w.best);
    const dLat = (shore + FAR) / KM_LAT, dLon = (shore + FAR) / lonKm;
    for (let y = Math.floor((b.s - dLat) / CELL); y <= Math.floor((b.n + dLat) / CELL); y++) {
      for (let x = Math.floor((b.w - dLon) / CELL); x <= Math.floor((b.e + dLon) / CELL); x++) {
        const k = `${y}:${x}`;
        (cells.get(k) ?? cells.set(k, []).get(k)).push(w);
      }
    }
  }
  return {
    add(kind, coords) {
      const r = boundsOf(coords), seen = new Set();
      for (let y = Math.floor(r.s / CELL); y <= Math.floor(r.n / CELL); y++) {
        for (let x = Math.floor(r.w / CELL); x <= Math.floor(r.e / CELL); x++) {
          for (const w of cells.get(`${y}:${x}`) ?? []) {
            if (w.best.car <= AT || seen.has(w)) continue;
            seen.add(w);
            // No nearer than the gap between the two boxes: most roads are ruled out here.
            const limit = Math.min(w.best[kind], FAR) + w.shore;
            const gap = Math.hypot(Math.max(0, r.s - w.b.n, w.b.s - r.n) * KM_LAT, Math.max(0, r.w - w.b.e, w.b.w - r.e) * w.lonKm);
            if (gap >= limit) continue;
            const dLat = limit / KM_LAT, dLon = limit / w.lonKm;
            let km = Infinity;
            for (const [lat, lon] of w.pts) {
              if (lat < r.s - dLat || lat > r.n + dLat || lon < r.w - dLon || lon > r.e + dLon) continue;
              const d = distKmToLine(lat, lon, coords);
              if (d < km) km = d;
            }
            km = Math.max(0, km - w.shore);
            if (km <= FAR && km < w.best[kind]) w.best[kind] = km;
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
  if (!states.length || states.some(st => !(st in MIN_ROADS) || !files[st])) throw new Error('Usage: node scripts/build-reach.mjs ca=<prefix> nv=<prefix> or=<prefix>');
  const lines = file => createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  const secs = t => `${Math.round((Date.now() - t) / 1000)} s`;
  const data = {};
  for (const st of states) {
    const dir = new URL(`../data/${st}/`, import.meta.url);
    const read = f => readFile(new URL(f, dir), 'utf8').then(JSON.parse, () => null);
    const [lakes, stocked, access] = await Promise.all(['lakes.json', 'waters.json', 'access.json'].map(read));
    // The same id can be in two states' lists, so a water is filed under its state here.
    data[st] = { dir, access, points: pointsFor(lakes?.lakes ?? [], stocked?.waters ?? []).map(p => ({ ...p, key: `${st}:${p.key}` })) };
  }
  const points = states.flatMap(st => data[st].points);

  // Shorelines first. A state with no water file (or a lake nobody drew) is measured from its point and size.
  const match = matcher(points);
  for (const st of states) {
    const t = Date.now();
    let n = 0;
    try { for await (const line of lines(`${files[st]}-water.geojsonseq`)) { const rings = waterFrom(line); if (rings) { match.offer(rings); n++; } } }
    catch (e) { console.error(`reach ${st}: no shorelines: ${e.message}`); }
    console.log(`reach ${st}: ${n} drawn waters read, ${secs(t)}`);
  }
  const outlines = match.outlines(), wrongSize = match.wrongSize();
  for (const p of points) if (outlines.has(p.key)) p.outline = outlines.get(p.key);

  const find = finder(points);
  for (const st of states) {
    const d = data[st], t = Date.now();
    d.lines = 0; d.roads = 0;
    try {
      for await (const line of lines(`${files[st]}-roads.geojsonseq`)) {
        d.lines++;
        const r = roadFrom(line);
        if (r) { find.add(r.kind, r.coords); d.roads++; }
      }
    } catch (e) { console.error(`reach ${st}: no roads: ${e.message}`); }
    console.log(`reach ${st}: ${d.lines} road lines, ${d.roads} open to motor vehicles, ${secs(t)}`);
  }
  const values = find.values();
  let failed = false;
  const KNOWN = /^(Donner Lake|Lake Aloha|Thousand Island Lake|Caples Lake|Loch Leven Lakes|Gilmore Lake|Lake Tahoe|Shasta Lake|Boca Reservoir|Independence Lake|Hetch Hetchy Reservoir|Hell Hole Reservoir|Salt Springs Reservoir|Marlette Lake|Lahontan Reservoir|Pyramid Lake|Angel Lake|Liberty Lake|Rye Patch Reservoir|Crater Lake|Wallowa Lake|Odell Lake|Waldo Lake|Lake Owyhee|Cultus Lake)$/;
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
    const lakes = d.points.filter(p => !p.stream);
    console.log(`reach ${st}: ${d.points.length} waters, ${lakes.filter(p => p.outline).length} of ${lakes.length} lakes by their shoreline (${lakes.filter(p => wrongSize.has(p.key)).length} more sit in a drawn water of another size), ${byRamp} drive-up by a ramp`, JSON.stringify(tally));
    // For reading the log: the biggest waters that came out as a walk, and some well-known ones with the distances
    // behind their value ("shore": measured from the drawn shoreline, "circle": from the point and size).
    const val = p => reach[p.key.slice(st.length + 1)], how = p => p.outline ? 'shore' : wrongSize.has(p.key) ? `circle, in a drawn water of ${wrongSize.get(p.key)} ac` : 'circle';
    const walk = d.points.filter(p => typeof val(p) === 'number').sort((a, b) => (b.acres ?? 0) - (a.acres ?? 0)).slice(0, 15);
    console.log(`reach ${st} biggest not drive-up:`, walk.map(p => `${p.name} (${p.acres} ac, ${how(p)}) ${val(p)}`).join('; '));
    const km = n => Number.isFinite(n) ? n.toFixed(1) : '-';
    console.log(`reach ${st} known:`, d.points.filter(p => KNOWN.test(p.name ?? '') && p.key.includes(':n:') && p.acres >= 10)
      .map(p => `${p.name} ${val(p)} (${how(p)}, road ${km(find.nearest(p.key).car)} km, track ${km(find.nearest(p.key).track)} km)`).join('; '));
  }
  if (failed) process.exit(1);
}
