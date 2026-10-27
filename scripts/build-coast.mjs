// Ocean fishing data for California and Oregon. Runs weekly (see .github/workflows/build-coast.yml).
//
//   data/coast/tide-stations.json  { stations: [{ id, name, lat, lon, ref }] }            NOAA CO-OPS tide prediction stations
//   data/coast/spots.json          { spots: [{ id, name, kind, lat, lon, state, publicPier? }] }  piers, jetties, beaches (OpenStreetMap)
//   data/coast/mpas.json           { areas: [{ id, name, type, state, url, bbox, polys }] }   marine protected areas (CDFW ds582, ODFW)
//
// Each part is kept from the last run when its source fails or answers with too little, so one bad week never
// empties the app's layer.
import { writeFile, readFile, mkdir } from 'node:fs/promises';

const OUT = new URL('../data/coast/', import.meta.url);
const UA = { 'User-Agent': 'TackleBox-fishing-app (personal, github.com/mikegutberlet/FishingApp)' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const r5 = x => Math.round(x * 1e5) / 1e5;

async function getJson(url, init = {}, tries = 3) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { ...init, headers: { ...UA, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(init.timeout ?? 120e3) });
      if (!r.ok) throw new Error(`${r.status} ${url.slice(0, 120)}`);
      return await r.json();
    } catch (e) { last = e; console.error(`  try ${i}: ${e.message}`); await sleep(5e3 * i); }
  }
  throw last;
}
async function previous(name) {
  try { return JSON.parse(await readFile(new URL(name, OUT), 'utf8')); } catch { return null; }
}
async function write(name, data, count, min) {
  if (count < min) {
    console.error(`${name}: only ${count} (need ${min}); keeping the previous file`);
    return false;
  }
  await writeFile(new URL(name, OUT), JSON.stringify({ updatedAt: new Date().toISOString(), ...data }));
  console.log(`${name}: wrote ${count}`);
  return true;
}

// Which state a coastal point is in: California south of 42° N; Oregon up to the Columbia River's mouth.
export const coastState = (lat, lon) => lat < 42 ? 'CA' : lat < 46.24 || (lat < 46.27 && lon > -123.9) ? 'OR' : null;

// ---------- Tide stations ----------
async function tideStations() {
  const j = await getJson('https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=tidepredictions');
  return j.stations.filter(s => ['CA', 'OR'].includes(s.state)).map(s => ({ id: s.id, name: s.name, lat: r5(+s.lat), lon: r5(+s.lng), ref: s.type === 'R' }));
}

// ---------- Spots from OpenStreetMap ----------
// Named piers, wharves, jetties, breakwaters, fishing spots and beaches within 300 m of the ocean or bay shoreline
// (OSM's coastline runs around San Francisco Bay and the other bays too). Docks, floats and slips are boating, not fishing.
// Navy and port piers are named for the alphabet or by number ("Mike Pier", "Pier 169"), and tour and patrol boats tie up at others.
const NOT_FISHING = /\b(dock|docks|slip|slips|float|ramp|ferry|runway|light|indicator|gangway|berth|marina|terminal|pumpout|fuel|launch|dinghy|kayak|boathouse|private|patrol|navy|naval|coast guard|uscg|seaplane|cruise|hornblower|small craft|cargo|tanker|fireboat|pilot|tug|research|alpha|bravo|charlie|delta|echo|foxtrot|golf|hotel|india|juliet|kilo|lima|mike|november|oscar|papa|quebec|romeo|sierra|tango|uniform|victor|whiskey|x-ray|yankee|zulu)\b|^[A-Z]{1,2}[- ]?\d*$|^(pier|dock) ?[A-Z0-9]{1,3}$|\bpier \d+$/i;
export function spotKind(t) {
  const name = t.name ?? '';
  if (/private|no/.test(t.access ?? '')) return null;
  if (t.man_made === 'pier') {
    if (NOT_FISHING.test(name) && !/fishing/i.test(name) && t.fishing !== 'yes' && t.leisure !== 'fishing' && t.access !== 'yes') return null;
    if (/jetty|breakwater|groin|groyne/i.test(name)) return 'jetty';
    if (/pier|wharf|fishing/i.test(name) || t.fishing === 'yes' || t.fishing === 'designated' || t.leisure === 'fishing') return 'pier';
    return null;
  }
  if (/breakwater|groyne/.test(t.man_made ?? '')) return 'jetty';
  if (t.leisure === 'fishing') return /pier|wharf/i.test(name) ? 'pier' : /jetty|breakwater/i.test(name) ? 'jetty' : 'spot';
  if (t.natural === 'beach') return t.sport === 'surfing' || t.surfing ? 'surf' : 'beach';
  if (t.sport === 'surfing') return 'surf';
  return null;
}
const RANK = { pier: 0, jetty: 1, spot: 2, surf: 3, beach: 4 };

async function overpassBand(s, n) {
  const box = `${s},-124.9,${n},-116.9`;
  const q = `[out:json][timeout:300];way["natural"="coastline"](${box})->.c;
(nwr["man_made"="pier"]["name"](around.c:300);nwr["man_made"~"^(breakwater|groyne)$"]["name"](around.c:300);nwr["leisure"="fishing"](around.c:400);
 nwr["natural"="beach"]["name"](around.c:300);nwr["sport"="surfing"](${box}););out center tags;`;
  let last;
  // Mirrors time out from GitHub's runners, so only the main server, waiting longer each time it's busy (502/504).
  for (const [i, url] of Array(4).fill('https://overpass-api.de/api/interpreter').entries()) {
    try {
      const r = await fetch(url, { method: 'POST', headers: UA, body: new URLSearchParams({ data: q }), signal: AbortSignal.timeout(400e3) });
      if (!r.ok) throw new Error(`${r.status}`);
      const j = await r.json();
      if (j.remark && /error|timed out|runtime/i.test(j.remark)) throw new Error(j.remark);
      return j.elements;
    } catch (e) { last = e; console.error(`  band ${s}–${n} try ${i + 1}: ${e.message}`); await sleep(30e3 * (i + 1)); }
  }
  throw last;
}

// A band Overpass can't answer keeps last week's spots for that band, so one busy hour doesn't drop a stretch of coast.
async function spots() {
  const all = [], prev = (await previous('spots.json'))?.spots ?? [];
  for (let s = 32.5; s < 46.3; s += 1) {
    let els;
    try { els = await overpassBand(s, Math.min(46.3, s + 1)); } catch (e) {
      const kept = prev.filter(p => p.lat >= s && p.lat < s + 1);
      console.error(`band ${s}–${s + 1} failed (${e.message}); keeping ${kept.length} spots from the last run`);
      all.push(...kept);
      continue;
    }
    let kept = 0;
    for (const e of els) {
      const t = e.tags ?? {}, lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
      const kind = spotKind(t);
      if (!kind || lat == null || !t.name) continue;
      const state = coastState(lat, lon);
      if (!state) continue;
      all.push({ id: `osm-${e.type[0]}${e.id}`, name: t.name.trim(), kind, lat: r5(lat), lon: r5(lon), state,
        ...(kind === 'pier' && { publicPier: /yes|permissive/.test(t.access ?? '') || /city|county|state|port|public|park/i.test(`${t.operator ?? ''} ${t.owner ?? ''} ${t.ownership ?? ''}`) ? true : null }) });
      kept++;
    }
    console.log(`band ${s}–${s + 1}: ${els.length} elements, kept ${kept}`);
    await sleep(5e3);
  }
  // One spot per name within 1 km (a pier drawn as several ways, a beach as several areas): keep the best kind.
  all.sort((a, b) => RANK[a.kind] - RANK[b.kind]);
  const out = [];
  for (const p of all) {
    const dup = out.find(q => q.name.toLowerCase() === p.name.toLowerCase() && Math.hypot((q.lat - p.lat) * 111, (q.lon - p.lon) * 88) < 1);
    if (!dup) out.push(p);
  }
  const by = out.reduce((m, p) => (m[`${p.state} ${p.kind}`] = (m[`${p.state} ${p.kind}`] ?? 0) + 1, m), {});
  console.log('spots by state and kind', JSON.stringify(by));
  console.log('sample piers', JSON.stringify(out.filter(p => p.kind === 'pier').slice(0, 25).map(p => [p.name, p.state, p.publicPier])));
  return out;
}

// ---------- Marine protected areas ----------
const pick = (p, ...keys) => { for (const k of keys) for (const key of Object.keys(p)) if (key.toLowerCase() === k.toLowerCase() && p[key] != null && String(p[key]).trim()) return String(p[key]).trim(); return null; };

async function layerFeatures(base, layer) {
  const feats = [];
  for (let offset = 0; ; offset += 500) {
    const j = await getJson(`${base}/${layer}/query?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&maxAllowableOffset=0.0002&geometryPrecision=5&resultOffset=${offset}&resultRecordCount=500&f=geojson`);
    feats.push(...(j.features ?? []));
    if (!j.properties?.exceededTransferLimit && !j.exceededTransferLimit && (j.features?.length ?? 0) < 500) break;
  }
  return feats;
}
function toArea(f, state, idPrefix, defaults = {}) {
  const g = f.geometry;
  if (!g) return null;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : null;
  if (!polys?.length) return null;
  let x1 = 180, y1 = 90, x2 = -180, y2 = -90;
  for (const rings of polys) for (const [x, y] of rings[0]) { x1 = Math.min(x1, x); x2 = Math.max(x2, x); y1 = Math.min(y1, y); y2 = Math.max(y2, y); }
  const p = f.properties ?? {};
  const name = pick(p, 'FULLNAME', 'NAME', 'Site_Name', 'SiteName', 'MR_Name', 'Name') ?? defaults.name;
  // ODFW's rows carry a Label (MR, MPA, SPA…) and the take they allow in Descr; CDFW's carry Type and the CCR section.
  const label = pick(p, 'Label');
  const type = pick(p, 'Type', 'TYPE', 'Designation', 'DESIG', 'MPA_Type', 'Site_Type', 'Category', 'Class')
    ?? (label && ({ MR: 'Marine Reserve', MPA: 'Marine Protected Area', SPA: 'Seabird Protection Area' }[label.toUpperCase()] ?? label)) ?? defaults.type ?? '';
  const url = pick(p, 'Hyperlink', 'URL', 'Link', 'Website');
  const note = pick(p, 'Descr', 'Description', 'Allowed_Take');
  const ccr = pick(p, 'CCR');
  return { id: `${idPrefix}${f.id ?? pick(p, 'OBJECTID', 'FID') ?? name}`, name, type, state, url: /^https?:/.test(url ?? '') ? url : null,
    ...(note && { note }), ...(ccr && { ccr: ccr.replace(/\s+/g, ' ') }),
    bbox: [r5(x1), r5(y1), r5(x2), r5(y2)], polys: polys.map(rings => rings.map(ring => ring.map(([x, y]) => [r5(x), r5(y)]))) };
}

async function mpas() {
  const areas = [];
  const CA = 'https://services2.arcgis.com/Uq9r85Potqm3MfRV/arcgis/rest/services/biosds582_fpu/FeatureServer';
  try {
    const feats = await layerFeatures(CA, 0);
    console.log(`CA MPAs: ${feats.length}; fields of the first:`, JSON.stringify(feats[0]?.properties));
    for (const f of feats) { const a = toArea(f, 'CA', 'ca-'); if (a) areas.push(a); }
  } catch (e) { console.error('CA MPAs failed:', e.message); }
  const OR = 'https://services.arcgis.com/uUvqNMGPm7axC2dD/arcgis/rest/services/ODFW_MR_MPA_Boundaries/FeatureServer';
  try {
    const svc = await getJson(`${OR}?f=json`);
    console.log('OR layers', JSON.stringify(svc.layers?.map(l => [l.id, l.name, l.geometryType])));
    for (const l of svc.layers ?? []) {
      if (l.geometryType && l.geometryType !== 'esriGeometryPolygon') continue;
      const feats = await layerFeatures(OR, l.id);
      console.log(`OR layer ${l.id} ${l.name}: ${feats.length}; first:`, JSON.stringify(feats[0]?.properties));
      // The layer name says what kind of area it holds when the rows don't.
      const type = /reserve/i.test(l.name) && !/protected/i.test(l.name) ? 'Marine Reserve' : /seabird/i.test(l.name) ? 'Seabird Protection Area' : /protected/i.test(l.name) ? 'Marine Protected Area' : null;
      for (const f of feats) { const a = toArea(f, 'OR', `or-${l.id}-`, { type }); if (a) areas.push(a); }
    }
  } catch (e) { console.error('OR MPAs failed:', e.message); }
  console.log('MPA types', JSON.stringify(areas.reduce((m, a) => (m[`${a.state} ${a.type}`] = (m[`${a.state} ${a.type}`] ?? 0) + 1, m), {})));
  return areas;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await mkdir(OUT, { recursive: true });
  let failed = 0;
  try { const s = await tideStations(); await write('tide-stations.json', { source: 'NOAA CO-OPS', stations: s }, s.length, 150); } catch (e) { failed++; console.error('tide stations failed:', e.message); }
  try { const a = await mpas(); const ca = a.filter(x => x.state === 'CA').length; await write('mpas.json', { source: 'CDFW ds582; ODFW marine reserve and MPA boundaries', areas: a }, ca >= 100 ? a.length : 0, 100); } catch (e) { failed++; console.error('MPAs failed:', e.message); }
  try { const s = await spots(); await write('spots.json', { source: 'OpenStreetMap contributors (ODbL)', spots: s }, s.length, 300); } catch (e) { failed++; console.error('spots failed:', e.message); }
  const prev = await previous('spots.json');
  console.log('done', failed ? `${failed} part(s) failed` : 'all parts', prev ? `(spots file has ${prev.spots?.length})` : '');
  process.exitCode = failed === 3 ? 1 : 0;
}
