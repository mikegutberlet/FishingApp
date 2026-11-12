// Boat ramps, fishing piers, parking, campgrounds, marinas, boat rentals and tackle shops in one state,
// from OpenStreetMap via the Overpass API. Runs monthly for each state (.github/workflows/build-safety.yml for
// California, nevada-monthly.yml, oregon-monthly.yml).
//
//   node scripts/build-state-access.mjs <ca|nv|or>
//   data/<st>/access.json  { places: [[lat, lon, kind, name, note]] }  kind: ramp | pier | parking | camp | marina | rental | tackle
//
// Parking is only kept near a ramp or fishing spot, so the file stays small. If Overpass is down, or the answer looks
// incomplete, the old file is kept.

import { writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// The fewest places a whole answer for the state can have (California has about 5,700; Nevada is mostly desert).
export const MIN = { ca: 500, nv: 40, or: 150 };
const UA = { 'User-Agent': 'TackleBox-fishing-app (personal, github.com/mikegutberlet/FishingApp)' };
const MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];

export function queryFor(st) {
  const code = String(st).toLowerCase();
  if (!(code in MIN)) throw new Error(`Unknown state "${st}": ca, nv or or`);
  return `[out:json][timeout:600];area["ISO3166-2"="US-${code.toUpperCase()}"]->.st;
(nwr["leisure"="slipway"](area.st);)->.ramps;
(nwr["leisure"="fishing"](area.st);nwr["man_made"="pier"]["fishing"~"yes|designated"](area.st);)->.fish;
(nwr["tourism"="camp_site"](area.st);)->.camp;
(nwr["leisure"="marina"](area.st);nwr["amenity"="boat_rental"](area.st);nwr["shop"="fishing"](area.st);)->.other;
(nwr["amenity"="parking"](around.ramps:250);nwr["amenity"="parking"](around.fish:150);)->.park;
(.ramps;.fish;.camp;.other;.park;);
out center tags;`;
}

async function overpass(QUERY) {
  let last;
  for (const url of MIRRORS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const r = await fetch(url, { method: 'POST', headers: UA, body: new URLSearchParams({ data: QUERY }), signal: AbortSignal.timeout(900000) });
        if (!r.ok) throw new Error(`${r.status} ${url}`);
        const j = await r.json();
        if (j.remark && !j.elements?.length) throw new Error(`${url}: ${j.remark}`);
        return j;
      } catch (e) { last = e; console.error(`overpass attempt ${attempt} failed: ${e.message}`); await new Promise(r => setTimeout(r, 30000)); }
    }
  }
  throw last;
}

export function kindOf(t) {
  if (t.leisure === 'slipway') return 'ramp';
  if (t.leisure === 'fishing' || t.man_made === 'pier') return 'pier';
  if (t.tourism === 'camp_site') return 'camp';
  if (t.leisure === 'marina') return 'marina';
  if (t.amenity === 'boat_rental') return 'rental';
  if (t.shop === 'fishing') return 'tackle';
  if (t.amenity === 'parking') return 'parking';
  return null;
}

// Short note shown under the name: fee, hours, what kind of boats, and so on, when OSM has it.
export function noteFor(kind, t) {
  const bits = [];
  if (t.fee === 'yes') bits.push(t.charge ? `fee ${t.charge}` : 'fee');
  else if (t.fee === 'no') bits.push('free');
  if (kind === 'ramp' && t.trailer === 'no') bits.push('no trailers (car-top)');
  if (kind === 'ramp' && t.surface) bits.push(t.surface);
  if (kind === 'camp' && t.operator) bits.push(t.operator);
  if (t.opening_hours) bits.push(t.opening_hours === '24/7' ? 'open 24 h' : t.opening_hours);
  if (t.toilets === 'yes') bits.push('restrooms');
  return bits.join(' · ').slice(0, 80);
}

// The service's elements as the file's places, south to north: public ones only, each spot once.
export function placesFrom(elements) {
  const seen = new Set(), places = [], counts = {};
  for (const el of elements) {
    const t = el.tags ?? {};
    if (/^(private|no)$/.test(t.access ?? '')) continue;
    const kind = kindOf(t);
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
    if (!kind || lat == null) continue;
    const p = [+lat.toFixed(5), +lon.toFixed(5), kind, (t.name ?? '').slice(0, 80), noteFor(kind, t)];
    const key = `${kind}|${p[0].toFixed(3)}|${p[1].toFixed(3)}`; // a ramp drawn as a node and a way: keep one
    if (seen.has(key)) continue;
    seen.add(key);
    places.push(p);
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  places.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return { places, counts };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const st = String(process.argv[2] ?? '').toLowerCase();
  const { places, counts } = placesFrom((await overpass(queryFor(st))).elements);
  if (places.length < MIN[st]) throw new Error(`Only ${places.length} places; Overpass result looks incomplete`);
  const out = new URL(`../data/${st}/`, import.meta.url);
  await mkdir(out, { recursive: true });
  await writeFile(new URL('access.json', out), JSON.stringify({ updatedAt: new Date().toISOString(), source: 'OpenStreetMap contributors (ODbL), via Overpass API', places }) + '\n');
  console.log(`access ${st}: ${places.length} places`, JSON.stringify(counts));
}
