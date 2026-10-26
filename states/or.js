// Oregon: ODFW's weekly trout stocking schedule and Recreation Report, USGS, Army Corps and Reclamation lake levels,
// read from the files the Oregon data jobs write to data/or/ (scripts/or/*.mjs and scripts/build-state-*.mjs).
import { stateData } from './common.js';
// Name matching for rules and advisories is Nevada's (same agency-style names: "Walker River, East Fork").
import { sameWater } from './nv.js';
import { haversineKm } from '../data-sources.js';

const d = stateData('or', 'OR');

export const code = 'OR';
export const name = 'Oregon';
export const agency = 'ODFW';
export const stockField = 'odfwWaterId';
export const levelSource = 'USGS';
export const scheduleUrl = 'https://myodfw.com/fishing/species/trout/stocking-schedule';
// ODFW's spelling of a water ("DEVIL'S LK") as an id that is safe in backups and data-* attributes: letters, digits
// and "-" as they are, a space as "_", anything else as ".XX" per UTF-8 byte. The nightly job makes ids the same way.
export const odfwId = raw => [...String(raw)].map(c => /[A-Za-z0-9-]/.test(c) ? c : c === ' ' ? '_'
  : [...new TextEncoder().encode(c)].map(b => '.' + b.toString(16).toUpperCase().padStart(2, '0')).join('')).join('');
export const odfwName = id => {
  const s = String(id).replace(/_/g, ' ');
  try { return decodeURIComponent(s.replace(/\.([0-9A-F]{2})/g, '%$1')); } catch { return s; } // a bad escape from a shared pack
};
// ODFW has no page per water; the schedule filtered to the water's name is closest.
export const waterUrl = id => `${scheduleUrl}?${new URLSearchParams({ field_zone_value: 'All', field_waterbody_name_value_1: odfwName(id) })}`;

// Lakes saved before ids were made safe carry ODFW's raw spelling: rewrite them once (at startup).
// A lake saved from the stocked list (no map water, ODFW's page as its info link) took ODFW's map point, and the
// nightly job moves a point it had on the wrong water (Blue River Reservoir was on Fairview's Blue Lake): such a lake
// follows a move of more than 3 km while it still sits on the ODFW point it was saved with (stockPoint, or one the
// water has had) under the name it was saved with (stockName). One renamed or moved by hand stays, linked. A lake
// saved from a map water's page or added by hand never follows ODFW's point; when that point is more than 20 km off,
// the link was made by mistake (the Deschutes Taylor Lake took The Dalles' TAYLOR LK) and goes, so the app matches
// the lake again. These writes keep the lake's own updatedAt, so a backup merge still keeps newer edits.
export async function migrateSavedIds(db) {
  let stocked = null;
  const put = lake => db.put('lakes', lake, { touch: false });
  for (const l of await db.all('lakes')) {
    if (typeof l.odfwWaterId !== 'string') continue;
    let lake = l;
    if (!/^[\w.:-]*$/.test(l.odfwWaterId)) {
      const id = odfwId(l.odfwWaterId);
      lake = { ...l, odfwWaterId: id, ...(l.stockingUrl?.startsWith(scheduleUrl) && { stockingUrl: waterUrl(id) }), ...(l.infoUrl?.startsWith(scheduleUrl) && { infoUrl: waterUrl(id) }) };
    }
    stocked ??= (await d.load('waters'))?.waters ?? [];
    const w = stocked.find(x => x.id === lake.odfwWaterId);
    if (w?.lat == null || !Number.isFinite(lake.lat)) { if (lake !== l) await put(lake); continue; }
    const km = haversineKm(lake.lat, lake.lon, w.lat, w.lon);
    if (lake.nhdId || lake.infoUrl !== waterUrl(lake.odfwWaterId)) {
      if (km > 20) {
        const { odfwWaterId, ...rest } = lake;
        lake = rest;
        for (const k of ['stockingUrl', 'infoUrl']) if (lake[k]?.startsWith(scheduleUrl)) delete lake[k];
      }
      if (lake !== l) await put(lake);
      continue;
    }
    const on = p => Array.isArray(p) && p[0] === lake.lat && p[1] === lake.lon;
    // Saved before the point was kept: it was saved with ODFW's point if it sits on one ODFW has had (the nightly
    // job lists a water's former points), and was moved by hand otherwise.
    if (!Array.isArray(lake.stockPoint)) {
      const at = [[w.lat, w.lon], ...(w.was ?? [])].find(on);
      if (at) lake = { ...lake, stockPoint: at, stockName: lake.stockName ?? w.name };
    }
    if (on(lake.stockPoint) && lake.name === (lake.stockName ?? lake.name) && km > 3) {
      lake = { ...lake, lat: w.lat, lon: w.lon, stockPoint: [w.lat, w.lon], ...(w.county && { county: w.county }) };
    }
    if (lake !== l) await put(lake);
  }
}
export const searchBy = 'zone';
// The Columbia and the Snake make the north and east lines; the box takes in both rivers.
export const bbox = [-124.75, 41.99, -116.45, 46.3];
export { outline } from './or-outline.js';
export const plantsNote = 'ODFW schedules the week, not the day, and counts each size class: legal (8 to 12″), trophy (12″+), brood fish and fingerlings. Schedules can change with weather and road access.';
export const searchHint = 'Detroit, Deschutes River, Diamond…';
export const stockedHint = 'Hagg, Detroit, Willamette zone…';

export { sameWater };
export const { waters, plantsFor, dataDates, nearestWaters, nearestReservoir, statewide, history, matchStockedWater, historyFor, hydroFor, bathymetryFor, bathymetryUrl } = d;

function inRing([x, y], ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}
// ODFW angling zone a point is in (Willamette, Central, Northeast…). Rules are set by zone, not county.
export async function zoneAt(lat, lon) {
  const z = await d.load('zones');
  return z?.zones.find(k => lon >= k.bbox[0] && lon <= k.bbox[2] && lat >= k.bbox[1] && lat <= k.bbox[3] && k.polys.some(([outer]) => inRing([lon, lat], outer)))?.name ?? null;
}
// About how many km a point is from a zone (0 inside it), measured to its outline's edges.
async function kmToZone(lat, lon, name) {
  const z = (await d.load('zones'))?.zones.filter(k => sameZone(k.name, name)) ?? [];
  if (!z.length) return 0;
  const k = Math.cos(lat * Math.PI / 180);
  let best = Infinity;
  for (const { polys } of z) for (const [outer] of polys) {
    if (inRing([lon, lat], outer)) return 0;
    for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
      const [ax, ay] = outer[j], [bx, by] = outer[i], dx = (bx - ax) * k, dy = by - ay, px = (lon - ax) * k, py = lat - ay;
      const t = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy || 1)));
      best = Math.min(best, Math.hypot(px - t * dx, py - t * dy) * 111);
    }
  }
  return best;
}
// County a point is in (US Census outlines); some exceptions are for one county's creek of a common name.
export async function countyAt(lat, lon) {
  const c = await d.load('counties');
  return c?.counties.find(k => lon >= k.bbox[0] && lon <= k.bbox[2] && lat >= k.bbox[1] && lat <= k.bbox[3] && k.polys.some(([outer]) => inRing([lon, lat], outer)))?.name ?? null;
}
const sameZone = (a, b) => !!a && !!b && a.toLowerCase().replace(/[\s-]*(zone|river)$/g, '').replace(/-/g, ' ') === b.toLowerCase().replace(/[\s-]*(zone|river)$/g, '').replace(/-/g, ' ');
async function zoneOf(lake) {
  const stocked = lake.odfwWaterId ? (await d.load('waters'))?.waters.find(w => w.id === lake.odfwWaterId) : null;
  return (lake.lat != null ? await zoneAt(lake.lat, lake.lon) : null) ?? stocked?.zone ?? null;
}

// Names a water goes by in ODFW's and OHA's lists: its own, its stocked water's, and those with the water word
// swapped. The map's "Hills Creek Lake" is the rules' "Hills Creek Reservoir", "Lake Selmac" is "Selmac Lake",
// "Vernonia Lake" is "Vernonia Pond" and "Tenmile Lake" is in "Tenmile Lakes". Lake X and X Lake swap only when X
// isn't itself a water ("Lake Creek" is a creek).
const WATERY = /\b(lake|lakes|reservoir|reservoirs|pond|ponds|river|creek|slough)$/i;
function variants(name) {
  const bare = String(name ?? '').replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  const out = new Set([bare]);
  const front = bare.match(/^Lake\s+(.+)$/i)?.[1];
  const base = bare.match(/^(.+?)\s+(?:Lake|Lakes|Reservoir|Reservoirs|Pond|Ponds)$/i)?.[1] ?? (front && !WATERY.test(front) ? front : null);
  if (base) {
    for (const t of ['Lake', 'Reservoir', 'Pond']) out.add(`${base} ${t}`);
    if (!WATERY.test(base)) out.add(`Lake ${base}`);
  }
  return [...out];
}
// A swapped name stands only when no other water in the same zone goes by it: "Antelope Lake" in Lake County isn't
// Jordan Valley's "Antelope Reservoir", and "Miller Reservoir" isn't Miller Lake. A water of that name within either
// one's size is the same water (ODFW's Phillips Reservoir point is 3.7 km from the middle of Phillips Lake).
const sizeKm = l => Math.max(3, Math.sqrt((Number(l.acres) || 0) / 247) * 2);
// The safety tab asks for a water's names four times over; they're worked out once (again if a file was missing).
const nameCache = new Map();
function namesOf(lake) {
  const k = JSON.stringify([lake.name, lake.odfwWaterId, lake.lat, lake.lon, lake.acres, lake.kind, lake.type]);
  if (!nameCache.has(k)) {
    if (nameCache.size > 100) nameCache.clear();
    nameCache.set(k, findNames(lake));
    Promise.all([d.load('waters'), d.load('lakes')]).then(f => { if (!f.every(Boolean)) nameCache.delete(k); });
  }
  return nameCache.get(k);
}
async function findNames(lake) {
  const id = lake.odfwWaterId ?? (lake.lat != null ? (await matchStockedWater(lake))?.id : null);
  const w = await d.load('waters');
  const stocked = id ? w?.waters.find(x => x.id === id) : null;
  const own = [lake.name, stocked?.name].filter(Boolean);
  const plain = new Set(own.map(n => variants(n)[0]));
  const all = [...new Set(own.flatMap(variants))];
  if (lake.lat == null || all.length === plain.size) return all;
  const [{ lakes }, zone] = await Promise.all([statewide(), zoneOf(lake)]);
  const others = [...lakes, ...(w?.waters ?? []).filter(x => x.lat != null)];
  // The map's lakes of this one's own name close by are this water: a point anywhere on Detroit Lake is on the same
  // water as ODFW's Detroit Reservoir point, which sits on the map's Detroit Lake.
  const mine = lakes.filter(l => plain.has(String(l.name).replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim()) && haversineKm(l.lat, l.lon, lake.lat, lake.lon) <= Math.max(25, sizeKm(l)));
  const same = o => haversineKm(o.lat, o.lon, lake.lat, lake.lon) <= Math.max(sizeKm(o), sizeKm(lake)) || mine.some(l => haversineKm(o.lat, o.lon, l.lat, l.lon) <= sizeKm(l));
  const out = [];
  for (const n of all) {
    const key = n.toLowerCase();
    let taken = false;
    if (!plain.has(n)) {
      for (const o of others) {
        if (String(o.name).replace(/\s*\(.*?\)\s*/g, ' ').trim().toLowerCase() !== key || same(o)) continue;
        if (!zone || sameZone(await zoneAt(o.lat, o.lon), zone)) { taken = true; break; }
      }
    }
    if (!taken) out.push(n);
  }
  return out;
}
// A list's name for a water matches one of the water's names, both read in the singular ("Tenmile Lakes", "Cottage
// Grove Reservoirs", "Twin Lakes"). A reach ("Lower Columbia River", "Mid-Columbia River") also matches the whole
// river, since a map label has no reach.
const singular = s => String(s).replace(/\b(Lake|Reservoir|Pond|Creek|River|Spring|Slough)s\b/gi, '$1');
const listed = (names, n) => {
  const one = singular(n);
  return names.some(a => sameWater(singular(a), one) || (/\b(river|creek)$/i.test(one) && sameWater(singular(a), one.replace(/^(lower|upper|middle|mid)[\s-]+(?!fork\b)/i, ''))));
};
// Which fork a river is: "North Fork Santiam River", "Santiam River, North Fork" and "North Santiam River" are the
// north fork, the Little North Santiam the little north fork, and the Willamette River none. A rule or advisory for
// one fork is for that fork only, and one for the river isn't for its forks ("Umpqua River" isn't the North Umpqua).
const forkOf = s => {
  const n = String(s).replace(/\s*\(.*?\)\s*/g, ' ').trim();
  const m = n.match(/\b((?:little\s+)?(?:north|south|east|west|middle|coast))\s+fork\b/i) ?? n.match(/^((?:little\s+)?(?:north|south|east|west|middle))\s+\S+.*\b(?:river|creek)$/i);
  return m ? m[1].toLowerCase().replace(/\s+/g, ' ') : null;
};
const sameFork = (a, b) => forkOf(a) === forkOf(b);
// "Upper Klamath Lake" is the rules' "Klamath Lake" and "Upper Erma Bell Lake" is in "Erma Bell Lakes", unless the
// list has the water with its Upper/Middle/Lower itself.
function withoutReach(names, listNames) {
  const out = [...names];
  for (const n of names) {
    const m = n.match(/^(?:Upper|Middle|Lower)\s+(?!Fork\b)(.+)$/i);
    // Not when only a water word is left: "Upper Lake" isn't every lake.
    if (m && !/^(lake|lakes|reservoir|reservoirs|pond|ponds|river|creek)$/i.test(m[1]) && !listNames.some(x => listed([n], x))) out.push(m[1]);
  }
  return [...new Set(out)];
}
// A note in a rule's heading that places it, not a county or "Mainstem": "Round Lake (Collawash River)",
// "Rainbow Lake (Charles Metzger County Park)", "Crater Lake National Park", and the basin before a county ("Drift
// Creek (Alsea Basin, Lincoln Co.)"). Same as the weekly job's placeOf.
const placeNote = name => {
  const m = String(name).match(/\(([^)]+)\)/)?.[1]?.replace(/^(.+?),\s*[^,]*\b(?:Co\.?|County)$/i, '$1');
  if (m && !/\b(Co\.?|County)$/i.test(m) && !/^Mainstem\b/i.test(m)) return m;
  return /\bNational Park$/i.test(name) ? String(name) : null;
};
const countiesOf = s => String(s ?? '').split(/\s+and\s+|\s*\/\s*|\s*,\s*/).map(c => c.replace(/\s*County$/i, '').trim()).filter(Boolean);

// Whether a Recreation Report line is about this water: its name without "Lake"/"River", then that kind of water
// within a few words ("Siltcoos and Tahkenitch lakes" is about Siltcoos Lake). Same test as the nightly job's.
const KIND = [/\b(lake|lakes|reservoir|reservoirs|res|pond|ponds)\b/i, /\b(river|rivers|creek|creeks)\b/i, /\b(canal|canals)\b/i];
export function mentions(text, name) {
  const bare = String(name ?? '').replace(/\s*\(.*?\)\s*/g, ' ').trim();
  const base = bare.replace(/^Lake\s+/i, '').replace(/\s+(Lake|Lakes|Reservoir|Pond|Ponds|River|Creek|Canal)$/i, '').trim();
  if (base.length < 4 || /^(north|south|east|west|upper|lower|middle|big|little|clear|mud|fish|blue|lost|long|round)$/i.test(base)) return false;
  // A name ending in its water word wants that word ("Malheur Reservoir" isn't "Malheur Lake"), as does "Lake X".
  const own = bare.match(/\s(Lake|Reservoir|Pond|River|Creek|Canal)$/i)?.[1]?.toLowerCase() ?? (/^Lake\s/i.test(bare) ? 'lake' : null);
  const kind = own ? new RegExp(`\\b(${own}|${own}s${own === 'reservoir' ? '|res' : ''})\\b`, 'i')
    : KIND.find(re => re.test(bare)) ?? /\b(lake|lakes|reservoir|res|pond|ponds|river|rivers|creek|creeks)\b/i;
  const b = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s-]?'); // "Yellow Jacket" is also "Yellowjacket"
  return new RegExp(`\\b${b}\\b(?:[\\s,]+[\\w'’-]+){0,3}?[\\s,]+${kind.source.replace(/\\b/g, '')}\\b`, 'i').test(text) || (/^Lake /i.test(bare) && new RegExp(`\\blake\\s+${b}\\b`, 'i').test(text));
}

// What ODFW writes about a water: this week's Recreation Report lines that name it, and its stocking-map notes.
export async function reportFor(lake) {
  const [w, r] = await Promise.all([d.load('waters'), d.load('reports')]);
  const id = lake.odfwWaterId ?? (await matchStockedWater(lake))?.id;
  const stocked = w?.waters.find(x => x.id === id) ?? null;
  let rep = stocked?.report ? { text: stocked.report, date: stocked.reportDate, url: stocked.reportUrl } : null;
  if (!rep && r) {
    const zone = await zoneOf(lake);
    const names = await namesOf(lake);
    const hit = r.reports.map(x => ({ ...x, lines: (x.items ?? []).filter(t => names.some(n => mentions(t, n))) }))
      .find(x => x.lines.length && (!zone || sameZone(zone, x.zone) || /Columbia|Marine/.test(x.zone)));
    if (hit) rep = { text: hit.lines.join('\n'), date: hit.date, url: hit.url };
  }
  if (!stocked && !rep) return null;
  return { name: stocked?.name ?? lake.name, url: rep?.url ?? (stocked ? waterUrl(stocked.id) : scheduleUrl), report: rep?.text ?? null, reportDate: rep?.date ?? null, info: stocked?.about ?? null };
}

// ---------- Safety: toxic algae (nightly), regulations and fish consumption advisories (weekly) ----------
const reach = lake => /river|creek|stream/i.test(`${lake.kind} ${lake.type}`) ? 3 : Math.max(1.5, Math.sqrt((lake.acres ?? 50) / 247) * 1.5 + 0.5);
// The lake a river label is in (the Snake through Brownlee, the Owyhee through Lake Owyhee): the weekly job tags each
// label with it. A saved river is in it while it sits on that label, not once moved by hand.
async function lakeOf(lake) {
  if (lake.kind !== 'river' || lake.lat == null) return null;
  const { riverLabels } = await statewide();
  const id = String(lake.nhdId ?? lake.id);
  return riverLabels.find(x => String(x.id) === id && x.lat === lake.lat && x.lon === lake.lon)?.inLake ?? null;
}
// A water's names for advisories: its own and, for a river label in a lake, the lake's.
async function namesHere(lake) {
  const [names, inLake] = await Promise.all([namesOf(lake), lakeOf(lake)]);
  return inLake ? [...new Set([...names, ...await namesOf({ name: inLake, kind: 'lake', lat: lake.lat, lon: lake.lon })])] : names;
}

export async function habAdvisories() {
  return d.load('hab');
}

// Current toxic algae advisories on this water (Oregon Health Authority list). OHA names the water and its county:
// a name match is for the map's water of that name in that county, a point match only close by and not in another
// county.
export async function habFor(lake) {
  const [h, names, county, { lakes, riverLabels }, inLake] = await Promise.all([d.load('hab'), namesHere(lake), lake.lat != null ? countyAt(lake.lat, lake.lon) : null, statewide(), lakeOf(lake)]);
  // A river is often the county line (the North Santiam between Marion and Linn), so a label is in the counties of its
  // river's labels within 15 km too.
  const id = lake.kind === 'river' && lake.lat != null ? String(lake.nhdId ?? lake.id) : null;
  const along = id ? await Promise.all(riverLabels.filter(x => String(x.id) === id && haversineKm(x.lat, x.lon, lake.lat, lake.lon) <= 15).map(x => countyAt(x.lat, x.lon))) : [];
  // A point match is for the water OHA named: not when that water is a lake of its own right there (Fairview Lake is
  // next to Blue Lake, not Blue Lake; NHD's Lake Owyhee is OHA's Owyhee Reservoir), unless this water is on that
  // lake: the map's lake nearest it, within its size (a spot saved on Lake Owyhee). A river label beside a small lake
  // (the Alsea by Eckman Lake) is on it only by the weekly job's tag.
  const closest = lake.lat == null ? null : lakes.reduce((b, l) => { const km = haversineKm(l.lat, l.lon, lake.lat, lake.lon); return !b || km < b.km ? { l, km } : b; }, null);
  const onIt = l => !!closest && (closest.l === l || (!!l.gnis && closest.l.gnis === l.gnis)) && closest.km <= reach(closest.l) && (lake.kind !== 'river' || l.acres >= 1000);
  const elsewhere = a => a.lat != null && lakes.some(l => l.name !== lake.name && haversineKm(l.lat, l.lon, a.lat, a.lon) <= 1 && (a.names ?? [a.name]).some(n => listed(variants(l.name), n)) && !onIt(l));
  const out = [];
  for (const a of h?.advisories ?? []) {
    const distKm = a.lat != null && lake.lat != null ? haversineKm(lake.lat, lake.lon, a.lat, a.lon) : null;
    const counties = countiesOf(a.county), here = !counties.length || !county || counties.includes(county);
    // The river's other counties count for an advisory that names it, not for one that is only close by.
    const inCounty = here || along.some(c => counties.includes(c));
    // "Powder River arm" is part of Brownlee, not the Powder River; a fork is only that fork.
    const own = (a.names ?? [a.name.split(/[(,]/)[0].trim()]).filter(n => !/\barm$/i.test(n));
    const byName = own.find(n => listed(names.filter(x => sameFork(x, n)), n));
    if (byName ? await namedHere(lake, a, byName, counties, inCounty, lakes, inLake) : here && distKm != null && distKm <= reach(lake) && !elsewhere(a)) out.push({ ...a, distKm });
  }
  return out;
}
// Whether an advisory that names this water is for it. The map's waters of that name decide (one per NHD lake: a
// big reservoir's pieces share one). On one of them, it is that water's advisory when that water is in OHA's county,
// across a county or state line too (Brownlee and Owyhee are 50 miles long); with several in the county, it is for
// the one nearest OHA's point (Bull Run's Blue Lake isn't Fairview's). A lake added by hand away from all of them
// goes by its county; a river label in that lake (inLake) is on it however far from the lake's point.
async function namedHere(lake, a, n, counties, inCounty, lakes, inLake) {
  if (lake.lat == null) return inCounty;
  const groups = new Map();
  // Only names with the advisory's own word ("brownlee") are worth comparing, which keeps the safety tab quick.
  const word = String(n).toLowerCase().replace(/[’']/g, '').split(/[^a-z0-9]+/).find(w => w.length >= 4 && !/^(lake|lakes|reservoir|reservoirs|pond|ponds|river|creek|fork|north|south|east|west|middle|upper|lower|little|mount|saint)$/.test(w));
  for (const l of lakes) {
    if (word && !String(l.name).toLowerCase().replace(/[’']/g, '').includes(word)) continue;
    if (!listed(variants(l.name), n)) continue;
    const k = l.gnis ?? l.id ?? `${l.lat},${l.lon}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(l);
  }
  const all = [...groups.values()], inOha = [];
  for (const g of all) if (!counties.length || (await Promise.all(g.map(l => countyAt(l.lat, l.lon)))).some(c => counties.includes(c))) inOha.push(g);
  if (!inOha.length) return inCounty;
  const from = (g, lat, lon) => Math.min(...g.map(l => haversineKm(l.lat, l.lon, lat, lon)));
  const nearest = (list, lat, lon) => list.reduce((b, g) => !b || from(g, lat, lon) < from(b, lat, lon) ? g : b, null);
  const mine = nearest(all, lake.lat, lake.lon);
  if (!(inLake && listed(variants(inLake), n)) && from(mine, lake.lat, lake.lon) > Math.max(...mine.map(sizeKm))) return inCounty;
  return inOha.includes(mine) && (inOha.length === 1 || a.lat == null || mine === nearest(inOha, a.lat, a.lon));
}

// OHA splits the Columbia and the Willamette by landmark, so a water on them gets the reach it sits in: below
// Bonneville Dam, the dam's forebay at Bradford Island up to Ruckel Creek, then on up to McNary Dam; the Willamette
// below the Sellwood Bridge. The forebay is in Lake Bonneville, so only a river label above the dam stands for it,
// looking down the reservoir to it (the next label up is 12 km off).
const REACHES = [
  { re: /^Lower Columbia/i, river: 'Columbia', at: (lat, lon) => lon < -121.945 },
  { re: /Bradford Island/i, river: 'Columbia', at: (lat, lon) => lon >= -121.945 && lon < -121.915, above: (lat, lon) => lon >= -121.945, spread: [[0, 0], [0, -0.05], [0, -0.1], [0, -0.15]] },
  { re: /^Mid-Columbia/i, river: 'Columbia', at: (lat, lon) => lon >= -121.915 && lon < -119.2975 },
  { re: /^Lower Willamette/i, river: 'Willamette', at: lat => lat >= 45.46 },
];
// Oregon Health Authority advice on eating fish caught here. A row is for its zone's waters (an Antelope Reservoir
// row isn't for another zone's Antelope Lake) and for the river's fork it names (the Willamette row isn't the Middle
// Fork's). The Columbia's pools and the Snake's reservoirs get their river's rows.
export async function fishAdviceFor(lake) {
  const f = await d.load('advisories');
  if (!f) return null;
  const [names, zone] = await Promise.all([namesHere(lake), zoneOf(lake)]);
  // On a river: named for it, or a big water in (or right by) its zone, for the Columbia's pools and the Snake's
  // reservoirs (Lake Celilo, Hells Canyon).
  const named = river => names.some(n => forkOf(n) == null && sameWater(n.replace(/^(lower|upper|middle|mid)[\s-]+/i, ''), `${river} River`));
  const pool = async river => (lake.acres ?? 0) >= 1000 && lake.lat != null && await kmToZone(lake.lat, lake.lon, `${river} River`) <= 1;
  const on = { Columbia: named('Columbia') || await pool('Columbia'), Snake: named('Snake') || await pool('Snake'), Willamette: named('Willamette') };
  // A river label stands for the ~15 km around it, so it gets the reaches that stretch reaches (Bradford Island's
  // 3 km falls between two Columbia labels).
  const spread = lake.kind === 'river' ? [[0, 0], [0.07, 0], [-0.07, 0], [0, 0.1], [0, -0.1]] : [[0, 0]];
  const site = f.advisories.filter(a => {
    const reach = REACHES.find(x => x.re.test(a.area));
    const near = lake.kind === 'river' && reach?.spread ? reach.spread : spread;
    if (reach) return on[reach.river] && (lake.lat == null || ((!reach.above || reach.above(lake.lat, lake.lon)) && near.some(([y, x]) => reach.at(lake.lat + y, lake.lon + x))));
    if (/Snake/.test(a.zone) && on.Snake) return true;
    if (zone && !/^(multiple|statewide|columbia|snake)/i.test(a.zone ?? '') && !sameZone(a.zone, zone)) return false;
    // "Powder River arm" is the arm of Brownlee the row names, not the Powder River.
    return a.names.some(n => /\barm$/i.test(n) ? names.some(x => x.toLowerCase() === n.toLowerCase()) : listed(names.filter(x => sameFork(x, n)), n));
  });
  return { site, statewide: f.statewide, meal: f.meal, url: f.url, updatedAt: f.updatedAt };
}

// Whether a water is the one a rule's place note means. The zone's waters of the rule's name (lakes, rivers with all
// their labels, stocked waters; ones within 3 km are one water) are measured to the place: the note's river labels
// ("Collawash River", "South Santiam", "Sandy River Basin"), the lake it names ("Outlet of Miller Lake") or the point
// the weekly job looked up ("Charles Metzger County Park", "Wallowa Mountains"). The rule is for the one nearest it,
// if that is within 25 km (40 km of a mountain range's middle). With no place to measure by, it stands only on a lake
// that is the zone's one water of that name: a stream's labels miss small creeks (Wallowa Hatchery's Spring Creek).
async function atPlace(lake, rule) {
  const [{ lakes, riverLabels }, w] = await Promise.all([statewide(), d.load('waters')]);
  const name = rule.aliases[0] ?? rule.name.replace(/\s*\(.*?\)\s*/g, ' ').trim();
  const named = o => o.lat != null && listed([String(o.name).replace(/\s*\(.*?\)\s*/g, ' ').trim()], name);
  const groups = [];
  const add = (pts, key) => {
    const hit = groups.find(g => (key && g.keys.has(key)) || g.pts.some(p => pts.some(q => haversineKm(p[0], p[1], q[0], q[1]) <= 3)));
    if (hit) { hit.pts.push(...pts); if (key) hit.keys.add(key); } else groups.push({ pts: [...pts], keys: new Set(key ? [key] : []) });
  };
  // A rule for one county's water ("Drift Creek (Alsea Basin, Lincoln Co.)") is measured among that county's.
  const counties = rule.counties ?? (rule.county ? [rule.county] : []);
  const inZone = async ([lat, lon]) => sameZone(await zoneAt(lat, lon), rule.zone) && (!counties.length || counties.includes(await countyAt(lat, lon)));
  for (const o of [...lakes, ...(w?.waters ?? [])]) if (named(o) && await inZone([o.lat, o.lon])) add([[o.lat, o.lon]], null);
  const rivers = new Map();
  for (const x of riverLabels) if (named(x)) { if (!rivers.has(x.id)) rivers.set(x.id, []); rivers.get(x.id).push([x.lat, x.lon]); }
  for (const [id, pts] of rivers) if ((await Promise.all(pts.map(inZone))).some(Boolean)) add(pts, `river:${id}`);
  const note = placeNote(rule.name);
  let place = null;
  if (/\b(river|creek|fork|santiam|willamette)(\s+basin)?$|\bbasin$/i.test(note)) {
    const river = note.replace(/\s+Basin$/i, '').replace(/^(?!.*\b(?:River|Creek)$)(.+)$/i, '$1 River');
    const labels = riverLabels.filter(x => sameWater(x.name, river) && sameFork(x.name, river));
    if (labels.length) place = labels.map(x => [x.lat, x.lon]);
  }
  const water = note?.replace(/^(?:(?:outlet|inlet)\s+(?:of|to)|above|below)\s+/i, '');
  if (!place && /\b(lake|lakes|reservoir|pond)$/i.test(water ?? '')) {
    const pts = [];
    for (const l of lakes) if (listed(variants(l.name), water) && await kmToZone(l.lat, l.lon, rule.zone) <= 30) pts.push([l.lat, l.lon]);
    if (pts.length) place = pts;
  }
  if (!place && rule.near) place = [rule.near];
  if (!place) return !/river|creek|stream/i.test(`${lake.kind} ${lake.type}`) && groups.length < 2;
  // This water: its river, else the one it sits on (a creek's labels are 15 km apart), else a water of its own.
  const from = (g, lat, lon) => Math.min(...g.pts.map(p => haversineKm(p[0], p[1], lat, lon)));
  const mine = groups.find(g => lake.kind === 'river' && g.keys.has(`river:${lake.nhdId ?? lake.id}`))
    ?? groups.filter(g => from(g, lake.lat, lake.lon) <= (/river|creek|stream/i.test(`${lake.kind} ${lake.type}`) ? 8 : 3)).sort((a, b) => from(a, lake.lat, lake.lon) - from(b, lake.lat, lake.lon))[0]
    ?? { pts: [[lake.lat, lake.lon]], keys: new Set() };
  const toPlace = g => Math.min(...place.map(([lat, lon]) => from(g, lat, lon)));
  const best = [...groups.filter(g => g !== mine), mine].reduce((b, g) => toPlace(g) < toPlace(b) ? g : b);
  return best === mine && toPlace(mine) <= (/\b(mountains?|range|hills|wilderness)$/i.test(note) ? 40 : 25);
}

// The rules for this water: its zone's general limits, the exceptions ODFW lists for it, and the statewide rules.
// The Columbia and Snake have zones of their own, matched by name as well as by place. A river label in a lake
// (the Snake in Brownlee) gets the lake's rules too, and the zone's limits for lakes.
export async function regsFor(lake) {
  const r = await d.load('regs');
  if (!r) return null;
  const [zone, own, county, inLake] = await Promise.all([zoneOf(lake), namesHere(lake), lake.lat != null ? countyAt(lake.lat, lake.lon) : null, lakeOf(lake)]);
  const names = withoutReach(own, r.waters.flatMap(w => [w.name, ...w.aliases]));
  let zoneKey = Object.keys(r.zones).find(z => sameZone(z, zone ?? '')) ?? null;
  // Outside every zone (not in Oregon) only the Columbia and Snake rules, which name their river, can apply.
  // A rule for one county's water ("Beaver Creek (Nestucca Basin, Tillamook Co.)") applies only in that county.
  // A Columbia or Snake rule names a water by the river (Eagle Creek and Herman Creek in the Gorge), so it applies
  // only within about 10 km of that zone, not to a same-named creek in Union or Lane County or up the Clackamas.
  const near = {};
  for (const z of ['Columbia River', 'Snake River']) near[z] = lake.lat == null || await kmToZone(lake.lat, lake.lon, z) <= 10;
  // A river's heading "and Tributaries" is for its forks too ("Indian Creek and Tributaries" is the North Fork's
  // rule), unless the zone lists that fork under a heading of its own. One that names a fork or the mainstem isn't.
  const tribs = w => /\btributar/i.test(w.name) && !/\bmainstem\b/i.test(w.name) && forkOf(w.name) == null;
  const ownHeading = (x, zone) => r.waters.some(o => o.zone === zone && [o.name, ...o.aliases].some(n => forkOf(n) != null && forkOf(n) === forkOf(x) && listed([x], n)));
  const special = r.waters.filter(w => {
    const counties = w.counties ?? (w.county ? [w.county] : []);
    const river = /Columbia|Snake/.test(w.zone);
    return (!counties.length || (county && counties.includes(county))) && (zoneKey ? w.zone === zoneKey || river : river)
      && (!river || near[/Columbia/.test(w.zone) ? 'Columbia River' : 'Snake River'])
      // A fork's rule is for that fork ("Willamette River, Middle Fork" isn't the Willamette), and a name the heading
      // gives without the fork is still the fork's ("Wilson River" under "Wilson River, Little North Fork").
      && [w.name, ...w.aliases].some(n => listed(names.filter(x => forkOf(x) === (forkOf(n) ?? forkOf(w.name))
        || (tribs(w) && forkOf(n) == null && forkOf(x) != null && !ownHeading(x, w.zone))), n));
  });
  // A rule placed by a note in its heading ("Round Lake (Collawash River)") is for the water there. A label's lake
  // is placed as the lake ("Cottonwood Reservoir (Goose Lake Basin, Lake Co.)" on Cottonwood Creek's label in it).
  const lakeNames = inLake ? await namesOf({ name: inLake, kind: 'lake', lat: lake.lat, lon: lake.lon }) : [];
  const as = w => [w.name, ...w.aliases].some(n => listed(lakeNames, n)) ? { name: inLake, kind: 'lake', lat: lake.lat, lon: lake.lon } : lake;
  for (const w of [...special]) if (placeNote(w.name) && lake.lat != null && !await atPlace(as(w), w)) special.splice(special.indexOf(w), 1);
  // The Columbia and Snake zones are the rivers and their reservoirs, thinner than the zone map can show: a water
  // named in their rules (Brownlee, Hells Canyon) gets that zone's limits unless its own zone's rules name it too.
  const river = special.find(w => /Columbia|Snake/.test(w.zone));
  if (river && !special.some(w => w.zone === zoneKey)) zoneKey = river.zone;
  const lakeRow = special.some(w => [w.name, ...w.aliases].some(n => listed(lakeNames, n)));
  return { zone: zoneKey ?? zone, inOregon: !!(zone ?? zoneKey), inLake, lakeRow, special, zoneRules: zoneKey ? r.zones[zoneKey] : null, statewide: r.statewide, booklet: r.booklet, updates: r.updates, source: r.source, updatedAt: r.updatedAt };
}
