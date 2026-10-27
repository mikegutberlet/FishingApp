// More for the Getting there tab: wilderness and trailhead permits with quotas, parking passes and boat inspections
// for a water; trailheads, parking and toilets near it (OpenStreetMap); the fish people have photographed near it
// (iNaturalist); and the roads, trails and trailheads around it as one GPX file. Live lookups send only the water's
// coordinates and are kept on this device (Cache API `tb-access`, like the road lookup).
import { haversineKm } from './data-sources.js';
import { BOAT_STATE, BOAT_WATERS, PASS_WATERS, PASS_UNITS } from './trip-rules.js';

const CACHE = 'tb-access';
const OVERPASS = 'https://overpass-api.de/api/interpreter';
const INAT = 'https://api.inaturalist.org/v1';
const cacheUrl = (kind, key) => `${location.origin}/__access-${kind}/${encodeURIComponent(key)}.json`;
async function cacheGet(kind, key, maxDays) {
  try {
    const r = await (await caches.open(CACHE)).match(cacheUrl(kind, key));
    const d = r ? await r.json() : null;
    return d && Date.now() - Date.parse(d.fetchedAt) < maxDays * 864e5 ? d : d ? { ...d, stale: true } : null;
  } catch { return null; }
}
async function cachePut(kind, key, data) { try { await (await caches.open(CACHE)).put(cacheUrl(kind, key), new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })); } catch {} }
const pointKey = (lat, lon, km, trailKm = km) => `${(+lat).toFixed(3)},${(+lon).toFixed(3)},${(+km).toFixed(1)}${trailKm > km ? `,t${(+trailKm).toFixed(1)}` : ''}`;

// ---------- Permits and quotas ----------
// Wildernesses and parks in the three states where a permit is needed to go in, matched on the land unit at the
// shore (PAD-US, from the road lookup). `season` is when the permit or quota applies (MM-DD, inclusive); none means
// all year. Each links the booking page and the agency page it was taken from.
const INYO_SRC = { label: 'Inyo National Forest: wilderness permits', url: 'https://www.fs.usda.gov/r05/inyo/permits/wilderness-permits' };
const SIERRA_SRC = { label: 'Sierra National Forest: wilderness permits', url: 'https://www.fs.usda.gov/r05/sierra/permits/obtaining-wilderness-permit' };
const INYO_BOOK = { label: 'Inyo NF wilderness permits (east-side trailheads)', url: 'https://www.recreation.gov/permits/233262' };
const SIERRA_BOOK = { label: 'Sierra NF wilderness permits (west-side trailheads)', url: 'https://www.recreation.gov/permits/445858' };
export const PERMITS = [
  { id: 'whitney', name: 'Mt. Whitney Zone', near: [36.57, -118.26, 6], day: true, overnight: true, season: ['05-01', '11-01'],
    text: 'A permit is needed for day hikes as well as overnight trips. Quota-season permits are given out by a lottery in late winter; what’s left (and cancellations) is released on Recreation.gov.',
    book: [{ label: 'Mt. Whitney permits (Recreation.gov)', url: 'https://www.recreation.gov/permits/445860' }], source: INYO_SRC },
  { id: 'desolation', unit: /\bdesolation\b/i, name: 'Desolation Wilderness', day: true, overnight: true,
    text: 'Day hikes: a free day-use permit you fill in yourself at the trailhead. Overnight: a permit all year, with a daily quota per zone (70% bookable from six months out, 30% kept for walk-ins at the Placerville Ranger Station). Bear canisters are required overnight.',
    book: [{ label: 'Desolation overnight permits (Recreation.gov)', url: 'https://www.recreation.gov/permits/233261' }],
    source: { label: 'Eldorado National Forest: Desolation Wilderness permits', url: 'https://www.fs.usda.gov/r05/eldorado/permits/desolation-wilderness-permits' } },
  { id: 'cascades', unit: /\b(three sisters|mount jefferson|mt\.? jefferson|mount washington|mt\.? washington) wilderness\b/i, name: 'Central Cascades Wilderness', day: 'some', overnight: true, season: ['06-15', '10-15'],
    text: 'June 15 to October 15: an overnight permit from every trailhead, and a day-use permit at 19 of the 79 trailheads (the busiest ones; the trailhead sign says). Day permits open 10 days and 2 days ahead; about 40% of overnight permits open in early April, the rest 7 days ahead. Only the Recreation.gov fee: $1 a person a day, $6 a group overnight.',
    book: [{ label: 'Day-use permits (Recreation.gov)', url: 'https://www.recreation.gov/ticket/facility/300009' }, { label: 'Overnight permits (Recreation.gov)', url: 'https://www.recreation.gov/permits/4675311' }],
    source: { label: 'Willamette National Forest: Central Cascades Wilderness permits', url: 'https://www.fs.usda.gov/r06/willamette/permits/central-cascades-wilderness-permits' } },
  { id: 'yosemite', unit: /\byosemite\b/i, name: 'Yosemite', day: false, overnight: true,
    text: 'Overnight trips in Yosemite’s wilderness need a wilderness permit, with a quota per trailhead. Day hikes don’t (Half Dome’s cables aside).',
    book: [{ label: 'Yosemite wilderness permits (Recreation.gov)', url: 'https://www.recreation.gov/permits/445859' }],
    source: { label: 'Yosemite National Park: wilderness permits', url: 'https://www.nps.gov/yose/planyourvisit/wildpermits.htm' } },
  { id: 'seki', unit: /\b(sequoia|kings canyon|john krebs)\b/i, name: 'Sequoia and Kings Canyon', day: false, overnight: true,
    text: 'Overnight trips in the parks’ wilderness need a wilderness permit, with a quota per trailhead in the main season. Day hikes don’t.',
    book: [{ label: 'Sequoia & Kings Canyon wilderness permits (Recreation.gov)', url: 'https://www.recreation.gov/permits/445857' }],
    source: { label: 'Sequoia and Kings Canyon National Parks: wilderness permits', url: 'https://www.nps.gov/seki/planyourvisit/wilderness_permits.htm' } },
  { id: 'eastsierra', unit: /\b(john muir|ansel adams) wilderness\b/i, name: null, day: false, overnight: true, season: ['05-01', '11-01'],
    text: 'Overnight trips need a wilderness permit all year, with trailhead quotas from May 1 to November 1 (60% bookable six months out, 40% two weeks before). Day hikes don’t, except in the Mt. Whitney Zone. Book with the forest your trailhead is on.',
    book: [INYO_BOOK, SIERRA_BOOK], source: INYO_SRC, also: SIERRA_SRC },
  { id: 'inyo', unit: /\b(golden trout|hoover) wilderness\b/i, name: null, day: false, overnight: true, season: ['05-01', '11-01'],
    text: 'Overnight trips from Inyo National Forest trailheads need a wilderness permit, with trailhead quotas from May 1 to November 1. Day hikes don’t. Starting from another forest’s side? Its ranger district issues the permit.',
    book: [INYO_BOOK], source: INYO_SRC },
  { id: 'sierranf', unit: /\b(dinkey lakes|kaiser) wilderness\b/i, name: null, day: false, overnight: true,
    text: 'Overnight trips need a wilderness permit, with trailhead quotas (about 60% bookable ahead, 40% kept for walk-ups). Day hikes don’t.',
    book: [SIERRA_BOOK], source: SIERRA_SRC },
];

// "MM-DD" range against today: { on: true } in season, or the date it starts.
export function permitSeason(p, now = new Date()) {
  if (!p.season) return { on: true, allYear: true };
  const md = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const [a, b] = p.season, on = a <= b ? md >= a && md <= b : md >= a || md <= b;
  const fmt = s => new Date(`2000-${s}T12:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return { on, from: fmt(a), to: fmt(b) };
}

// Where each state's boat rule comes from, and Lake Tahoe's own inspection program.
export const BOAT_SRC = {
  CA: { label: 'California State Parks Division of Boating and Waterways: quagga and zebra mussels', url: 'https://dbw.parks.ca.gov/?page_id=28702' },
  NV: { label: 'Nevada Department of Wildlife: aquatic invasive species', url: 'https://www.ndow.org/get-outside/aquatic-invasive-species-prevention-program/' },
  OR: { label: 'Oregon State Marine Board: aquatic invasive species program', url: 'https://www.oregon.gov/osmb/boater-info/pages/aquatic-invasive-species-program.aspx' },
};
export const TAHOE_SRC = { label: 'Lake Tahoe boat inspections (TRPA and Tahoe Resource Conservation District)', url: 'https://tahoeboatinspections.com/' };

// Where the parking-pass rules come from (trip-rules.js PASS_UNITS: Adventure Pass in southern California,
// Northwest Forest Pass in Oregon).
export const PASS_SRC = {
  CA: { label: 'Forest Service passes in California (Adventure Pass)', url: 'https://www.fs.usda.gov/r05/passes' },
  OR: { label: 'Forest Service passes in Oregon (Northwest Forest Pass)', url: 'https://www.fs.usda.gov/r06/passes' },
};

// What applies at this water: permits (by land unit or place), parking passes and the boat rule.
// parcels: the road lookup's PAD-US land records ({ unit, designation, manager }); state: 'CA' | 'NV' | 'OR'.
export function rulesFor(lake, { lat, lon, parcels = [], state = null } = {}) {
  const units = parcels.map(p => p.unit).filter(Boolean);
  const permits = [];
  for (const p of PERMITS) {
    const unit = p.unit ? units.find(u => p.unit.test(u)) : null;
    const near = p.near && Number.isFinite(lat) && haversineKm(lat, lon, p.near[0], p.near[1]) <= p.near[2];
    if (unit || near) permits.push({ ...p, name: p.name ?? unit, unit: unit ?? null });
  }
  // Mt. Whitney Zone's own rule covers the John Muir one there.
  const whitney = permits.some(p => p.id === 'whitney');
  const passes = [];
  for (const w of PASS_WATERS) if (w.re.test(lake.name ?? '')) passes.push(w.text);
  if (!passes.length) for (const u of PASS_UNITS) { const unit = units.find(x => u.re.test(x)); if (unit) { passes.push(u.text(unit)); break; } }
  const boatWater = BOAT_WATERS.find(w => w.re.test(lake.name ?? ''));
  const boat = boatWater?.text ?? (state ? BOAT_STATE[state] ?? null : null);
  return { permits: whitney ? permits.filter(p => p.id !== 'eastsierra') : permits, passes, boat, boatHere: !!boatWater };
}

// ---------- Trailheads, parking and toilets (OpenStreetMap) ----------
const NOT_PUBLIC = /^(private|no|customers|delivery|permit|residents|military)$/;
export const POINT_KIND = { trailhead: { icon: '🥾', label: 'Trailhead' }, parking: { icon: '🅿️', label: 'Parking' }, toilets: { icon: '🚻', label: 'Toilets' }, water: { icon: '🚰', label: 'Drinking water' } };
// "fee", "free", "12 spaces", "gravel", "dawn to dusk": what's known about a point, from its tags.
export function pointFacts(t) {
  return [
    t.fee === 'yes' ? (t.charge ? `fee: ${t.charge}` : 'fee') : t.fee === 'no' ? 'free' : null,
    t.capacity && /^\d+$/.test(t.capacity) ? `${t.capacity} spaces` : null,
    t.surface && t.surface !== 'asphalt' && t.surface !== 'paved' ? t.surface.replace(/_/g, ' ') : null,
    t.parking === 'street_side' || t.parking === 'lane' ? 'roadside' : null,
    t.opening_hours ? `hours: ${t.opening_hours}` : null,
    t.access && !['yes', 'public'].includes(t.access) ? `access: ${t.access}` : null,
    t.operator ? t.operator : null,
  ].filter(Boolean);
}
export function osmPoint(e) {
  const t = e.tags ?? {}, c = e.center ?? e;
  if (c.lat == null) return null;
  const kind = t.highway === 'trailhead' ? 'trailhead' : t.amenity === 'parking' ? 'parking' : t.amenity === 'toilets' ? 'toilets' : t.amenity === 'drinking_water' ? 'water' : null;
  if (!kind || NOT_PUBLIC.test(t.access ?? '')) return null;
  return { kind, id: `${e.type}/${e.id}`, name: t.name ?? null, lat: +c.lat.toFixed(5), lon: +c.lon.toFixed(5), facts: pointFacts(t), source: { label: 'OpenStreetMap', url: `https://www.openstreetmap.org/${e.type}/${e.id}` } };
}
export const pointsQuery = (bbox, trailBbox = bbox) => `[out:json][timeout:40];(nwr[highway=trailhead](${trailBbox});nwr[amenity=parking](${bbox});nwr[amenity=toilets](${bbox});node[amenity=drinking_water](${bbox}););out tags center 300;`;
export async function overpassPoints(bbox, trailBbox = bbox) {
  let last;
  for (const wait of [0, 4000]) {
    if (wait) await new Promise(r => setTimeout(r, wait));
    try {
      const r = await fetch(OVERPASS, { method: 'POST', body: new URLSearchParams({ data: pointsQuery(bbox, trailBbox) }), signal: AbortSignal.timeout(50000) });
      if (r.status === 429 || r.status >= 500) { last = new Error(`${r.status}: server busy`); continue; }
      if (!r.ok) { last = new Error(`${r.status}`); break; } // a bad request won't get better by asking again
      const j = await r.json();
      if (j.remark && !j.elements?.length) { last = new Error(j.remark); break; }
      return (j.elements ?? []).map(osmPoint).filter(Boolean);
    } catch (e) { last = e; if (e.name === 'TimeoutError' || globalThis.navigator?.onLine === false) break; }
  }
  throw last ?? new Error('OpenStreetMap unreachable');
}
const bboxAround = (lat, lon, km) => { const dLat = km / 111, dLon = km / (111 * Math.cos(lat * Math.PI / 180)); return [lat - dLat, lon - dLon, lat + dLat, lon + dLon].map(v => v.toFixed(5)).join(','); };

// Trailheads, parking, toilets and taps within km of a point (trailheads within trailKm), nearest first. Kept 30 days.
export async function nearbyPoints(lat, lon, km, { force = false, trailKm = km } = {}) {
  const key = pointKey(lat, lon, km, trailKm);
  const have = await cacheGet('points', key, 30);
  if (have && !have.stale && !force) return have;
  try {
    const points = (await overpassPoints(bboxAround(lat, lon, km), bboxAround(lat, lon, trailKm)))
      .map(p => ({ ...p, km: +haversineKm(lat, lon, p.lat, p.lon).toFixed(2) })).filter(p => p.km <= (p.kind === 'trailhead' ? trailKm : km) * 1.05).sort((a, b) => a.km - b.km);
    const data = { fetchedAt: new Date().toISOString(), lat, lon, km, trailKm, points };
    await cachePut('points', key, data);
    return data;
  } catch (e) { if (have) return { ...have, error: e.message }; throw e; }
}
// How far to look: the road lookup's search area, and far enough to reach the trailhead of a walk in.
export const pointsKm = data => Math.min(8, Math.max(3, (data.searchKm ?? 3) + 1, (data.hike?.km ?? 0) + 1.5));
// No road you can drive comes within the search area (Lake Aloha, Green Lakes): the trailheads are farther out, so
// look for them (only them) up to 12 km (7.5 miles) away.
export const trailheadKm = (data, s) => s.vehicle ? pointsKm(data) : Math.max(12, pointsKm(data));
export const cachedPoints = (lat, lon, km, trailKm = km) => cacheGet('points', pointKey(lat, lon, km, trailKm), 30);

// ---------- Fish seen nearby (iNaturalist) ----------
// Research-grade observations of ray-finned fish (Actinopterygii) within km: species with counts, and the latest
// photographed ones. Kept 7 days. Photos stay on iNaturalist's servers under their owners' licences.
export const inatSearchUrl = (lat, lon, km) => `https://www.inaturalist.org/observations?lat=${(+lat).toFixed(4)}&lng=${(+lon).toFixed(4)}&radius=${km}&iconic_taxa=Actinopterygii&quality_grade=research`;
const taxonOf = t => t ? { id: t.id, name: t.name, common: t.preferred_common_name ?? null, photo: t.default_photo?.square_url ?? null, photoBy: t.default_photo?.attribution ?? null, url: `https://www.inaturalist.org/taxa/${t.id}` } : null;
export async function fishSeen(lat, lon, km, { force = false } = {}) {
  const key = pointKey(lat, lon, km);
  const have = await cacheGet('inat', key, 7);
  if (have && !have.stale && !force) return have;
  const q = new URLSearchParams({ lat: (+lat).toFixed(4), lng: (+lon).toFixed(4), radius: String(km), iconic_taxa: 'Actinopterygii', quality_grade: 'research' });
  const get = async path => { const r = await fetch(`${INAT}/${path}`, { signal: AbortSignal.timeout(20000), headers: { Accept: 'application/json' } }); if (!r.ok) throw new Error(`iNaturalist ${r.status}`); return r.json(); };
  try {
    const [counts, recent] = await Promise.all([
      get(`observations/species_counts?${q}&per_page=15`),
      get(`observations?${q}&photos=true&order_by=observed_on&order=desc&per_page=8`),
    ]);
    const data = {
      fetchedAt: new Date().toISOString(), lat, lon, km, total: counts.total_results ?? 0,
      species: (counts.results ?? []).map(r => ({ count: r.count, ...taxonOf(r.taxon) })),
      recent: (recent.results ?? []).map(o => ({ id: o.id, url: /^https:\/\//.test(o.uri) ? o.uri : `https://www.inaturalist.org/observations/${o.id}`, date: o.observed_on ?? null, taxon: taxonOf(o.taxon),
        photo: o.photos?.[0]?.url?.replace('/square.', '/small.') ?? null, photoBy: o.photos?.[0]?.attribution ?? null, place: o.place_guess ?? null })),
      searchUrl: inatSearchUrl(lat, lon, km),
    };
    await cachePut('inat', key, data);
    return data;
  } catch (e) { if (have) return { ...have, error: e.message }; throw e; }
}
export const cachedFishSeen = (lat, lon, km) => cacheGet('inat', pointKey(lat, lon, km), 7);
// How far around a water to look: the shore plus a little, more for big lakes, at most 10 km.
export const fishKm = lake => Math.min(10, Math.max(2, Math.round(Math.sqrt((Number(lake.acres) || 50) * 0.004047 / Math.PI) + 1.5)));

// ---------- Roads, trails and trailheads as one GPX ----------
// s: the Getting there summary (access-rules.js summarize); points: nearby trailheads and parking. Each road and
// trail is a track named with what it takes to drive or what it allows, so Gaia, CalTopo or onX show it offline.
export function accessGpxParts(lake, s, hike, points = [], classText = {}) {
  const tracks = [];
  const label = (f, what) => [f.name || (f.kind === 'trail' ? 'Unnamed trail' : 'Unnamed road'), what].filter(Boolean).join(' · ');
  for (const r of s.roads ?? []) for (const p of r.paths ?? []) tracks.push({ name: label(r, classText[r.cls]?.label), points: p.map(([a, b]) => [a, b, null]) });
  for (const t of s.trails ?? []) for (const p of t.paths ?? []) tracks.push({ name: label(t, 'trail'), points: p.map(([a, b]) => [a, b, null]) });
  if (hike?.coords?.length > 1) tracks.unshift({ name: `Walk in to ${lake.name}`, points: hike.coords.map(([a, b]) => [a, b, null]) });
  const wpts = [
    { name: lake.name, lat: s.at?.lat ?? lake.lat, lon: s.at?.lon ?? lake.lon },
    ...(hike?.start ? [{ name: 'Start walking', lat: hike.start.lat, lon: hike.start.lon, desc: hike.start.road ?? '' }] : []),
    ...points.filter(p => p.kind === 'trailhead' || p.kind === 'parking').slice(0, 30).map(p => ({ name: p.name || POINT_KIND[p.kind].label, lat: p.lat, lon: p.lon, desc: [POINT_KIND[p.kind].label, ...p.facts].join(', ') })),
    ...(s.lockedGates ?? []).map(g => ({ name: g.name || 'Gate', lat: g.lat, lon: g.lon, desc: `Gate${g.tags?.access ? ` (${g.tags.access})` : ''}` })),
  ];
  return { tracks: tracks.filter(t => t.points.length > 1), wpts };
}
