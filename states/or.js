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
export const odfwName = id => decodeURIComponent(String(id).replace(/_/g, ' ').replace(/\.([0-9A-F]{2})/g, '%$1'));
// ODFW has no page per water; the schedule filtered to the water's name is closest.
export const waterUrl = id => `${scheduleUrl}?${new URLSearchParams({ field_zone_value: 'All', field_waterbody_name_value_1: odfwName(id) })}`;

// Lakes saved before ids were made safe carry ODFW's raw spelling: rewrite them once (at startup).
export async function migrateSavedIds(db) {
  for (const l of await db.all('lakes')) {
    if (typeof l.odfwWaterId !== 'string' || /^[\w.:-]*$/.test(l.odfwWaterId)) continue;
    const id = odfwId(l.odfwWaterId);
    await db.put('lakes', { ...l, odfwWaterId: id, ...(l.stockingUrl?.startsWith(scheduleUrl) && { stockingUrl: waterUrl(id) }), ...(l.infoUrl?.startsWith(scheduleUrl) && { infoUrl: waterUrl(id) }) });
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
// swapped. The map's "Hills Creek Lake" is the rules' "Hills Creek Reservoir", "Lake Selmac" is "Selmac Lake" and
// "Tenmile Lake" is in "Tenmile Lakes". Lake X and X Lake swap only when X isn't itself a water ("Lake Creek").
function variants(name) {
  const bare = String(name ?? '').replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  const out = new Set([bare]);
  const front = bare.match(/^Lake\s+(.+)$/i)?.[1];
  const base = bare.match(/^(.+?)\s+(?:Lake|Lakes|Reservoir|Reservoirs)$/i)?.[1] ?? front;
  if (base) {
    for (const t of ['Lake', 'Reservoir']) out.add(`${base} ${t}`);
    if (!/\b(lake|lakes|reservoir|pond|ponds|river|creek|slough)$/i.test(base)) out.add(`Lake ${base}`);
  }
  return [...out];
}
async function namesOf(lake) {
  const id = lake.odfwWaterId ?? (lake.lat != null ? (await matchStockedWater(lake))?.id : null);
  const stocked = id ? (await d.load('waters'))?.waters.find(w => w.id === id) : null;
  return [...new Set([lake.name, stocked?.name].filter(Boolean).flatMap(variants))];
}
// A list's name for a water matches one of the water's names, read in the singular ("Tenmile Lakes", "Cottage Grove
// Reservoirs"). A reach ("Lower Columbia River", "Mid-Columbia River") also matches the whole river, since a map
// label has no reach.
const listed = (names, n) => {
  const one = String(n).replace(/\b(Lake|Reservoir|Pond)s\b/gi, '$1');
  return names.some(a => sameWater(a, one) || (/\b(river|creek)$/i.test(one) && sameWater(a, one.replace(/^(lower|upper|middle|mid)[\s-]+/i, ''))));
};
const countiesOf = s => String(s ?? '').split(/\s+and\s+|\s*\/\s*|\s*,\s*/).map(c => c.replace(/\s*County$/i, '').trim()).filter(Boolean);

// Whether a Recreation Report line is about this water: its name without "Lake"/"River", then that kind of water
// within a few words ("Siltcoos and Tahkenitch lakes" is about Siltcoos Lake). Same test as the nightly job's.
const KIND = [/\b(lake|lakes|reservoir|reservoirs|res|pond|ponds)\b/i, /\b(river|rivers|creek|creeks)\b/i, /\b(canal|canals)\b/i];
export function mentions(text, name) {
  const bare = String(name ?? '').replace(/\s*\(.*?\)\s*/g, ' ').trim();
  const base = bare.replace(/^Lake\s+/i, '').replace(/\s+(Lake|Lakes|Reservoir|Pond|Ponds|River|Creek|Canal)$/i, '').trim();
  if (base.length < 4 || /^(north|south|east|west|upper|lower|middle|big|little|clear|mud|fish|blue|lost|long|round)$/i.test(base)) return false;
  // A name ending in its water word wants that word ("Malheur Reservoir" isn't "Malheur Lake").
  const own = bare.match(/\s(Lake|Reservoir|Pond|River|Creek|Canal)$/i)?.[1]?.toLowerCase();
  const kind = own ? new RegExp(`\\b(${own}|${own}s${own === 'reservoir' ? '|res' : ''})\\b`, 'i')
    : KIND.find(re => re.test(bare)) ?? /\b(lake|lakes|reservoir|res|pond|ponds|river|rivers|creek|creeks)\b/i;
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

// Current toxic algae advisories on this water (Oregon Health Authority list). OHA names the water and its county:
// a name match counts in that county (anywhere in it), a point match only close by and not in another county.
export async function habFor(lake) {
  const [h, names, county] = await Promise.all([d.load('hab'), namesOf(lake), lake.lat != null ? countyAt(lake.lat, lake.lon) : null]);
  return (h?.advisories ?? []).map(a => ({ ...a, distKm: a.lat != null && lake.lat != null ? haversineKm(lake.lat, lake.lon, a.lat, a.lon) : null }))
    .filter(a => {
      const counties = countiesOf(a.county), inCounty = !counties.length || !county || counties.includes(county);
      if ((a.names ?? [a.name.split(/[(,]/)[0].trim()]).some(n => listed(names, n))) return counties.length && county ? inCounty : a.distKm == null || a.distKm < 60;
      return inCounty && a.distKm != null && a.distKm <= reach(lake);
    });
}

// Oregon Health Authority advice on eating fish caught here.
export async function fishAdviceFor(lake) {
  const f = await d.load('advisories');
  if (!f) return null;
  const names = await namesOf(lake);
  const site = f.advisories.filter(a => a.names.some(n => listed(names, n)));
  return { site, statewide: f.statewide, meal: f.meal, url: f.url, updatedAt: f.updatedAt };
}

// The rules for this water: its zone's general limits, the exceptions ODFW lists for it, and the statewide rules.
// The Columbia and Snake have zones of their own, matched by name as well as by place.
export async function regsFor(lake) {
  const r = await d.load('regs');
  if (!r) return null;
  const [zone, names, county] = await Promise.all([zoneOf(lake), namesOf(lake), lake.lat != null ? countyAt(lake.lat, lake.lon) : null]);
  let zoneKey = Object.keys(r.zones).find(z => sameZone(z, zone ?? '')) ?? null;
  // Outside every zone (not in Oregon) only the Columbia and Snake rules, which name their river, can apply.
  // A rule for one county's water ("Beaver Creek (Nestucca Basin, Tillamook Co.)") applies only in that county.
  // A Columbia or Snake rule names a water by the river (Eagle Creek and Herman Creek in the Gorge), so it applies
  // only within about 25 km of that zone, not to a same-named creek in Union or Lane County.
  const near = {};
  for (const z of ['Columbia River', 'Snake River']) near[z] = lake.lat == null || await kmToZone(lake.lat, lake.lon, z) <= 25;
  const special = r.waters.filter(w => {
    const counties = w.counties ?? (w.county ? [w.county] : []);
    const river = /Columbia|Snake/.test(w.zone);
    return (!counties.length || (county && counties.includes(county))) && (zoneKey ? w.zone === zoneKey || river : river)
      && (!river || near[/Columbia/.test(w.zone) ? 'Columbia River' : 'Snake River']) && [w.name, ...w.aliases].some(n => listed(names, n));
  });
  // The Columbia and Snake zones are the rivers and their reservoirs, thinner than the zone map can show: a water
  // named in their rules (Brownlee, Hells Canyon) gets that zone's limits unless its own zone's rules name it too.
  const river = special.find(w => /Columbia|Snake/.test(w.zone));
  if (river && !special.some(w => w.zone === zoneKey)) zoneKey = river.zone;
  return { zone: zoneKey ?? zone, inOregon: !!zone, special, zoneRules: zoneKey ? r.zones[zoneKey] : null, statewide: r.statewide, booklet: r.booklet, updates: r.updates, source: r.source, updatedAt: r.updatedAt };
}
