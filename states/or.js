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
// ODFW has no page per water; the schedule filtered to the water (ids are ODFW's spelling of the name) is closest.
export const waterUrl = id => `${scheduleUrl}?field_zone_value=All&field_waterbody_name_value_1=${encodeURIComponent(id).replace(/%20/g, '+')}`;
export const searchBy = 'zone';
// The Columbia and the Snake make the north and east lines; the box takes in both rivers.
export const bbox = [-124.75, 41.99, -116.45, 46.3];
export const outline = [[-124.6, 42.0], [-117.03, 42.0], [-117.03, 44.3], [-116.9, 44.5], [-116.46, 45.6], [-116.92, 46.0], [-119.0, 46.0], [-119.3, 45.93],
  [-120.5, 45.7], [-121.2, 45.65], [-122.25, 45.55], [-122.76, 45.65], [-122.8, 45.9], [-123.1, 46.18], [-123.9, 46.27], [-124.2, 46.27], [-124.2, 45.0], [-124.6, 42.8]];
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

// Whether a Recreation Report line is about this water: its name without "Lake"/"River", then that kind of water
// within a few words ("Siltcoos and Tahkenitch lakes" is about Siltcoos Lake). Same test as the nightly job's.
const KIND = [/\b(lake|lakes|reservoir|reservoirs|res|pond|ponds)\b/i, /\b(river|rivers|creek|creeks)\b/i, /\b(canal|canals)\b/i];
export function mentions(text, name) {
  const bare = String(name ?? '').replace(/\s*\(.*?\)\s*/g, ' ').trim();
  const base = bare.replace(/^Lake\s+/i, '').replace(/\s+(Lake|Lakes|Reservoir|Pond|Ponds|River|Creek|Canal)$/i, '').trim();
  if (base.length < 4 || /^(north|south|east|west|upper|lower|middle|big|little|clear|mud|fish|blue|lost|long|round)$/i.test(base)) return false;
  const kind = KIND.find(re => re.test(bare)) ?? /\b(lake|lakes|reservoir|res|pond|ponds|river|rivers|creek|creeks)\b/i;
  const b = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    const hit = r.reports.map(x => ({ ...x, lines: (x.items ?? []).filter(t => mentions(t, lake.name)) }))
      .find(x => x.lines.length && (!zone || sameZone(zone, x.zone) || /Columbia|Marine/.test(x.zone)));
    if (hit) rep = { text: hit.lines.join('\n'), date: hit.date, url: hit.url };
  }
  if (!stocked && !rep) return null;
  return { name: stocked?.name ?? lake.name, url: rep?.url ?? (stocked ? waterUrl(stocked.id) : scheduleUrl), report: rep?.text ?? null, reportDate: rep?.date ?? null, info: stocked?.about ?? null };
}

// ---------- Safety: toxic algae (nightly), regulations and fish consumption advisories (weekly) ----------
const reach = lake => /river|creek|stream/i.test(`${lake.kind} ${lake.type}`) ? 3 : Math.max(1.5, Math.sqrt((lake.acres ?? 50) / 247) * 1.5 + 0.5);

export async function habAdvisories() {
  return d.load('hab');
}

// Current toxic algae advisories on this water (Oregon Health Authority list, matched by name and place).
export async function habFor(lake) {
  const h = await d.load('hab');
  return (h?.advisories ?? []).map(a => ({ ...a, distKm: a.lat != null ? haversineKm(lake.lat, lake.lon, a.lat, a.lon) : null }))
    .filter(a => sameWater(lake.name, a.name.split(/[(,]/)[0].trim()) ? a.distKm == null || a.distKm < 60 : a.distKm != null && a.distKm <= reach(lake));
}

// Oregon Health Authority advice on eating fish caught here.
export async function fishAdviceFor(lake) {
  const f = await d.load('advisories');
  if (!f) return null;
  const site = f.advisories.filter(a => a.names.some(n => sameWater(lake.name, n)));
  return { site, statewide: f.statewide, meal: f.meal, url: f.url, updatedAt: f.updatedAt };
}

// The rules for this water: its zone's general limits, the exceptions ODFW lists for it, and the statewide rules.
// The Columbia and Snake have zones of their own, matched by name as well as by place.
export async function regsFor(lake) {
  const r = await d.load('regs');
  if (!r) return null;
  const zone = await zoneOf(lake);
  const zoneKey = Object.keys(r.zones).find(z => sameZone(z, zone ?? '')) ?? null;
  const county = lake.lat != null ? await countyAt(lake.lat, lake.lon) : null;
  // Outside every zone (not in Oregon) only the Columbia and Snake rules, which name their river, can apply.
  const special = r.waters.filter(w => (!w.county || (county && county === w.county)) && (zoneKey ? w.zone === zoneKey || /Columbia|Snake/.test(w.zone) : /Columbia|Snake/.test(w.zone))
    && [w.name, ...w.aliases].some(n => sameWater(lake.name, n)));
  return { zone: zoneKey ?? zone, special, zoneRules: zoneKey ? r.zones[zoneKey] : null, statewide: r.statewide, booklet: r.booklet, updates: r.updates, source: r.source, updatedAt: r.updatedAt };
}
