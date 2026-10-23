// California: CDFW stocking and CDEC reservoir levels, read from the files the nightly job writes to data/ca/.
// Every state module has the same shape (see states/index.js); Nevada is states/nv.js.
import { haversineKm } from '../data-sources.js';

const cache = {};
// A failed fetch (offline, or a file the nightly job hasn't written yet) is forgotten after 30 s so it is tried again.
const fetchJson = (key, url) => cache[key] ??= fetch(url).then(r => r.ok ? r.json() : Promise.reject())
  .catch(() => { setTimeout(() => delete cache[key], 30e3); return null; });
async function load(name) {
  return fetchJson(name, `data/ca/${name}.json`);
}

export const code = 'CA';
export const name = 'California';
export const waterUrl = stockId => `https://apps.wildlife.ca.gov/fishing/?stockid=${stockId}`;
export const scheduleUrl = 'https://nrm.dfg.ca.gov/FishPlants/';
// What states/index.js needs to route a water here.
export const agency = 'CDFW';
export const stockField = 'cdfwStockId';
export const levelSource = 'CDEC';
export const bbox = [-124.5, 32.5, -114.1, 42.05];
// The oblique Nevada line is a geodesic, so it is drawn with vertices (a straight lat/lon edge is up to 10 km off).
export const outline = [[-125, 42], [-120.0, 42], [-120.0, 39.0], [-119.298, 38.514], [-118.605, 38.024], [-117.92, 37.529], [-117.244, 37.03], [-116.577, 36.528], [-115.919, 36.022], [-115.27, 35.512], [-114.63, 35.0], [-114.57, 34.8], [-114.13, 34.27], [-114.5, 33.05], [-114.44, 32.92], [-114.46, 32.8], [-114.53, 32.745], [-114.72, 32.72], [-117.12, 32.53], [-125, 32.53]];
export const plantsNote = 'CDFW publishes the week and species, not counts. History grows each night from the public schedule.';
export const searchHint = 'Shasta, Kern River, Convict…';
export const stockedHint = 'Lake Cachuma, Shasta, Mono…';
// Nightly calendar feed of a stocked water's plants (scripts/build-ca-ics.mjs), as an absolute URL calendar apps can fetch.
export const plantCalendarUrl = stockId => new URL(`data/ca/ics/${+stockId}.ics`, location.href).href;

// Every CDFW stocked water with a map point, newest plant first, plus its planting history.
export async function waters() {
  const [w, p] = await Promise.all([load('waters'), load('plants')]);
  if (!w) return [];
  const plantsById = new Map();
  for (const plant of p?.plants ?? []) {
    if (!plant.stockId) continue;
    if (!plantsById.has(plant.stockId)) plantsById.set(plant.stockId, []);
    plantsById.get(plant.stockId).push(plant);
  }
  return w.waters.map(water => {
    const plants = plantsById.get(water.id) ?? [];
    return { ...water, name: water.name ?? `CDFW water #${water.id}`, plants, lastPlant: plants[0]?.week ?? null };
  });
}

export async function plantsFor(stockId) {
  const p = await load('plants');
  return (p?.plants ?? []).filter(x => x.stockId === +stockId);
}

export async function dataDates() {
  const [w, p, r] = await Promise.all([load('waters'), load('plants'), load('reservoirs')]);
  return { waters: w?.updatedAt, plants: p?.updatedAt, reservoirs: r?.updatedAt };
}

export async function nearestWaters(lat, lon, maxKm = 5) {
  return (await waters())
    .map(w => ({ ...w, distKm: haversineKm(lat, lon, w.lat, w.lon) }))
    .filter(w => w.distKm <= maxKm)
    .sort((a, b) => a.distKm - b.distKm);
}

// Big reservoirs' gauges sit at the dam, often 15+ km from the middle of the lake, so the search is wide.
// A lake can pin a station id (Edit → CDEC station) when the nearest one is the wrong water.
// Without a name match, a gauge only counts when it sits within a radius that scales with the lake's size,
// so a pond near a big dam doesn't show the dam's level.
export async function nearestReservoir(lat, lon, pinnedId, { name, acres, maxKm = 25 } = {}) {
  const r = await load('reservoirs');
  if (!r) return null;
  const pinned = pinnedId && r.reservoirs.find(s => s.id === pinnedId.toUpperCase());
  if (pinned) return { ...pinned, distKm: haversineKm(lat, lon, pinned.lat, pinned.lon), updatedAt: r.updatedAt };
  const key = norm(name);
  const best = r.reservoirs
    .map(s => ({ ...s, distKm: haversineKm(lat, lon, s.lat, s.lon), named: key.length > 2 && norm(s.name).includes(key) }))
    .filter(s => s.distKm <= maxKm)
    .sort((a, b) => (b.named - a.named) || a.distKm - b.distKm)[0];
  if (!best) return null;
  const limit = best.named ? maxKm : Math.max(3, Math.sqrt((acres ?? 0) / 247) * 2.5);
  return best.distKm <= limit ? { ...best, updatedAt: r.updatedAt } : null;
}

// ---------- Statewide water list (weekly build from USGS NHD) ----------
// Lakes keep their id; rivers are flattened into one entry per label point, all sharing the river's id.
export async function statewide() {
  const [l, r] = await Promise.all([load('lakes'), load('rivers')]);
  const lakes = (l?.lakes ?? []).map(x => ({ ...x, kind: 'lake', state: code }));
  const riverLabels = [];
  for (const river of r?.rivers ?? []) {
    for (const [lat, lon] of river.points) riverLabels.push({ ...river, kind: 'river', state: code, lat, lon });
  }
  return { lakes, riverLabels };
}

export async function history() {
  return load('history');
}

const norm = s => (s ?? '').toLowerCase().replace(/\b(lake|reservoir|river|creek|pond|the|of)\b|[^a-z0-9]/g, '');

// Best CDFW stocked water for a statewide water: close by, preferring a matching name.
export async function matchStockedWater(water) {
  const radius = water.kind === 'river' ? 3 : Math.max(2, Math.sqrt((water.acres ?? 50) / 247) * 2);
  const near = await nearestWaters(water.lat, water.lon, water.kind === 'river' ? 25 : radius);
  const key = norm(water.name);
  const named = near.find(w => key && (norm(w.name).startsWith(key) || key.startsWith(norm(w.name))));
  if (named) return named;
  return water.kind === 'river' ? null : near.find(w => w.distKm <= radius) ?? null;
}

// Historical introductions/plantings recorded at this water: nearby records, or records whose locality names it.
export async function historyFor(lake) {
  const h = await load('history');
  if (!h) return { note: '', statewide: [], local: [] };
  const radius = lake.kind === 'river' || /river|creek|stream|slough/i.test(lake.type ?? '') ? 3 : Math.max(1.5, Math.sqrt((lake.acres ?? 50) / 247) * 1.5);
  const key = norm(lake.name);
  const seen = new Set();
  const local = h.places
    .filter(([lat, lon, , , locality]) => (key.length > 3 && norm(locality).includes(key)) || haversineKm(lake.lat, lake.lon, lat, lon) <= radius)
    // One line per species per year: NAS often has several records of the same plant at different spots on a lake.
    .filter(([, , year, species]) => !seen.has(`${year}|${species}`) && seen.add(`${year}|${species}`))
    .map(([, , year, species, locality, status]) => ({ year: String(year), text: `${species}${locality ? ` (${locality})` : ''}${status ? ` · ${status.toLowerCase()}` : ''}` }));
  return { note: h.note, statewide: h.statewide, local };
}

// HydroLAKES estimate (average depth, volume, shoreline) for this lake: same name nearby, or the one lake of
// similar size at this spot. Modelled from shape and terrain, so it is labelled as an estimate in the app.
export async function hydroFor(lake) {
  if (lake.kind === 'river' || /river|creek|stream|slough/i.test(lake.type ?? '')) return null;
  const h = await load('hydrolakes');
  if (!h) return null;
  const key = norm(lake.name);
  const radius = Math.max(1, Math.sqrt((lake.acres ?? 50) / 247) * 1.5);
  const near = h.lakes.map(x => ({ ...x, distKm: haversineKm(lake.lat, lake.lon, x.lat, x.lon) })).filter(x => x.distKm <= Math.max(radius, 8)).sort((a, b) => a.distKm - b.distKm);
  const named = key.length > 2 && near.find(x => norm(x.name) === key);
  if (named) return named;
  const sized = near.find(x => x.distKm <= radius && lake.acres && x.acres / lake.acres > 0.4 && x.acres / lake.acres < 2.5);
  return sized ?? null;
}

// Public depth-contour surveys (USGS) covering this water, if any.
export async function bathymetryFor(lake) {
  const idx = fetchJson('bathy', 'data/ca/bathymetry/index.json');
  const surveys = (await idx)?.surveys ?? [];
  const pad = 0.01;
  return surveys.filter(s => lake.lat >= s.bbox[1] - pad && lake.lat <= s.bbox[3] + pad && lake.lon >= s.bbox[0] - pad && lake.lon <= s.bbox[2] + pad);
}

export const bathymetryUrl = id => `data/ca/bathymetry/${id}.geojson`;

// ---------- Water safety: algae advisories (nightly), fish advisories, regulations, access (weekly/monthly) ----------
const isRiver = lake => lake.kind === 'river' || /river|creek|stream|slough|canal/i.test(lake.type ?? '');
// How far from the water's point something can be and still belong to it.
const reachKm = lake => isRiver(lake) ? 3 : Math.max(1.5, Math.sqrt((lake.acres ?? 50) / 247) * 1.5 + 0.5);
const nameMatch = (a, b) => { const x = norm(a), y = norm(b); return x.length > 2 && y.length > 2 && (x === y || x.startsWith(y) || y.startsWith(x)); };

export async function habAdvisories() {
  return load('hab');
}

// Does a report/advisory named `name` at `distKm` belong to this water? Same name nearby, or close by and not
// obviously about another water (big lakes have small lakes and creeks around them).
const WATER_WORD = /\b(lake|lakes|reservoir|pond|lagoon|creek|river|slough|canal|stream)\b/i;
function belongs(lake, names, distKm, maxNameKm) {
  if (names.some(n => nameMatch(n, lake.name)) && distKm <= maxNameKm) return true;
  if (distKm > reachKm(lake) + 0.5) return false;
  return distKm <= 1 || !names.some(n => WATER_WORD.test(n ?? ''));
}

// Current toxic algae advisories on this water.
export async function habFor(lake) {
  const h = await load('hab');
  return (h?.advisories ?? []).map(a => ({ ...a, distKm: Math.min(...a.pts.map(([lat, lon]) => haversineKm(lake.lat, lake.lon, lat, lon))) }))
    .filter(a => belongs(lake, [a.name, a.alt], a.distKm, 40));
}

// OEHHA advice on eating fish from this water, or the statewide advice for its kind of water.
export async function fishAdviceFor(lake) {
  const o = await load('oehha');
  if (!o) return null;
  const site = o.advisories.map(a => ({ ...a, distKm: haversineKm(lake.lat, lake.lon, a.lat, a.lon) }))
    .filter(a => belongs(lake, a.name.split(/,| and /), a.distKm, 60))
    .sort((a, b) => a.distKm - b.distKm);
  const pick = re => o.statewide.find(s => re.test(s.name));
  const statewide = isRiver(lake) ? pick(/rivers|streams/i) : pick(/lakes|reservoirs/i);
  return { site, statewide, migrate: pick(/migrate/i), url: o.url, updatedAt: o.updatedAt };
}

// Boat ramps, piers, parking, campgrounds, marinas, rentals and tackle shops near the water (OpenStreetMap).
export async function accessFor(lake) {
  const a = await load('access');
  if (!a) return null;
  const r = reachKm(lake);
  const limit = { ramp: r + 1, pier: r + 1, parking: r + 0.5, marina: r + 1, rental: r + 1, camp: r + 4, tackle: r + 15 };
  const near = [];
  for (const [lat, lon, kind, name, note] of a.places) {
    if (Math.abs(lat - lake.lat) > 0.3 || Math.abs(lon - lake.lon) > 0.4) continue;
    const distKm = haversineKm(lake.lat, lake.lon, lat, lon);
    if (distKm <= (limit[kind] ?? r)) near.push({ lat, lon, kind, name, note, distKm });
  }
  return { places: near.sort((x, y) => x.distKm - y.distKm), updatedAt: a.updatedAt };
}

export async function accessPlaces() {
  return (await load('access'))?.places ?? [];
}

// ---------- Fishing regulations (weekly build from Title 14, CCR) ----------
const insideRing = ([x, y], ring) => {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
};
export async function countyAt(lat, lon) {
  const c = await load('counties');
  const hit = c?.counties.find(k => lon >= k.bbox[0] && lon <= k.bbox[2] && lat >= k.bbox[1] && lat <= k.bbox[3]
    && k.polys.some(([outer, ...holes]) => insideRing([lon, lat], outer) && !holes.some(h => insideRing([lon, lat], h))));
  return hit?.name ?? null;
}

// Regulation names say "Virginia Lakes, Upper and Lower" or "American River, North Fork"; NHD says "Upper Virginia Lake".
// Upper/Lower only pair up lakes; "Upper Truckee River" is its own river.
const regKey = (s, kind) => norm(String(s ?? '').replace(kind === 'lake' ? /\b(upper|lower)\b/gi : /^$/, '').replace(/\b(north|south|middle|east|west)\s+fork\b/gi, '').replace(/\blakes\b/gi, 'lake'));

// Special regulations that name this water (or its county, for county-wide rules), and the statewide rules that apply.
export async function regsFor(lake) {
  const r = await load('regs');
  if (!r) return null;
  const county = await countyAt(lake.lat, lake.lon) ?? lake.county?.split(',')[0].trim() ?? null;
  const kind = isRiver(lake) ? 'stream' : 'lake';
  const key = regKey(lake.name, kind);
  const special = r.waters.filter(w => {
    if (w.scope === 'district') return false;
    if (w.counties.length && county && !w.counties.includes(county)) return false;
    if (w.water && w.water !== kind && !(w.tributariesOnly && kind === 'lake')) return false;
    if (w.scope === 'county') return !!county && w.counties.length > 0;
    return key.length > 2 && [w.name, ...w.aliases].some(n => regKey(n, w.water ?? kind) === key);
  });
  // "Trinity River: See Klamath River, subsection (b)(50)." brings in the rules it points to.
  for (const w of [...special]) {
    for (const [, ref] of w.parts.map(p => p.season).join(' ').matchAll(/subsection \(b\)\((\d+(?:\.\d+)?)\)/gi)) {
      const to = r.waters.find(x => x.sec === w.sec && x.ref === `(b)(${ref})`);
      if (to && !special.includes(to)) special.push(to);
    }
  }
  return { county, kind, special: special.map(w => ({ ...w, parts: w.parts.map(p => ({ ...p, open: partOpen(p) })) })), statewide: r.statewide.filter(s => s.applies === 'all' || s.applies === kind), booklet: r.booklet, updatedAt: r.updatedAt };
}

// Is a season like "Last Sat. in Apr. through Nov. 15." open on a date? true / false, or null when the wording isn't understood.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const ORD = { first: 1, second: 2, third: 3, fourth: 4 };
function seasonDay(phrase, year) {
  const p = phrase.toLowerCase().replace(/^the\s+/, '').replace(/\./g, '').trim();
  let m;
  if ((m = p.match(/^(sun|mon|tue|wed|thu|fri|sat)\w*\s+preceding\s+(.+)$/))) {
    const ref = seasonDay(m[2], year);
    if (!ref) return null;
    const d = new Date(ref); d.setDate(d.getDate() - 1);
    while (d.getDay() !== DAYS.indexOf(m[1])) d.setDate(d.getDate() - 1);
    return d;
  }
  if (/^memorial day$/.test(p)) { const d = new Date(year, 4, 31); while (d.getDay() !== 1) d.setDate(d.getDate() - 1); return d; }
  if ((m = p.match(/^(first|second|third|fourth|last)\s+(sun|mon|tue|wed|thu|fri|sat)\w*\s+in\s+([a-z]{3})[a-z]*$/))) {
    const month = MONTHS.indexOf(m[3]), day = DAYS.indexOf(m[2]);
    if (m[1] === 'last') { const d = new Date(year, month + 1, 0); while (d.getDay() !== day) d.setDate(d.getDate() - 1); return d; }
    const d = new Date(year, month, 1); while (d.getDay() !== day) d.setDate(d.getDate() + 1); d.setDate(d.getDate() + 7 * (ORD[m[1]] - 1)); return d;
  }
  if ((m = p.match(/^last day (?:in|of) ([a-z]{3})[a-z]*$/))) return new Date(year, MONTHS.indexOf(m[1]) + 1, 0);
  if ((m = p.match(/^(?:(?:sun|mon|tue|wed|thu|fri|sat)\w*,?\s+)?([a-z]{3})[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?$/)) && MONTHS.includes(m[1])) return new Date(year, MONTHS.indexOf(m[1]), +m[2]);
  return null;
}
// The start and end of the "A through B" range that holds day, false when day is outside it, null when not understood.
function inRange(a, b, day) {
  for (const y of [day.getFullYear() - 1, day.getFullYear()]) {
    const start = seasonDay(a, y);
    let end = seasonDay(b, y);
    if (!start || !end) return null;
    if (end < start) end = seasonDay(b, y + 1); // e.g. Nov. 16 through the Fri. preceding the last Sat. in Apr.
    if (day >= start && day <= end) return { start, end };
  }
  return false;
}
export function seasonOpen(season, date = new Date()) {
  const s = String(season ?? '').trim();
  if (!s) return null;
  if (/^closed to all fishing all year/i.test(s)) return false;
  if (/^all year/i.test(s)) return true;
  // Drop the dot of "Apr." or "Sat." but keep a sentence end: "the last day in Feb. Only artificial lures..."
  const t = s.replace(/\b(jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec|sun|mon|tue|wed|thu|fri|sat)\.(?=\s*(\S*))/gi,
    (m, abbr, next) => /^(?:[,\da-z]|[Pp]receding|[Ff]ollowing|[Tt]hrough)/.test(next) ? abbr : m);
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  // "Apr. 1 through the fourth Fri. in May and Oct. 1 through Dec. 31." is two ranges.
  const ranges = t.match(/^[^.,]*/)[0].split(/\s+and\s+/).map(range => {
    const m = range.match(/^(.+?)\s+(?:through|to)\s+(.+)$/i);
    return m ? inRange(m[1], m[2], day) : null;
  });
  if (ranges.includes(null)) return null;
  const hit = ranges.find(Boolean);
  if (!hit) return false;
  // "Dec. 1 through Mar. 7, but only on Sat., Sun., Wed., legal holidays and opening and closing days."
  const only = t.match(/but only on\s+([^.]*)/i)?.[1];
  const days = only ? [...only.toLowerCase().matchAll(/\b(sun|mon|tue|wed|thu|fri|sat)/g)].map(m => m[1]) : [];
  if (!days.length || days.includes(DAYS[day.getDay()])) return true;
  if (/opening/i.test(only) && (+day === +hit.start || +day === +hit.end)) return true;
  return /holiday/i.test(only) ? null : false; // we can't tell a legal holiday
}
// A row whose bag says "Closed to all fishing." is closed during its season; outside it, we can't tell.
const partOpen = (p, date) => {
  const open = seasonOpen(p.season, date);
  return /^closed to all fishing/i.test(p.bag ?? '') ? (open ? false : null) : open;
};

// Which special-regulation group a species falls under: 'trout' (incl. salmon, steelhead), 'bass' (black bass), 'catfish', or null.
export const regGroup = species => /trout|steelhead|salmon/i.test(species) ? 'trout' : /\bbass\b/i.test(species) && !/striped|white/i.test(species) ? 'bass' : /catfish|bullhead/i.test(species) ? 'catfish' : null;

// Warnings for a catch against the rules here: closed season, release-only, size limits, bag limit.
// `kept` is how many of this species group you've already kept here today. A released fish only gets the season warnings.
// Returns plain-text strings.
export async function catchWarnings(lake, { species = '', length, time, kept = 0, released = false } = {}) {
  const regs = await regsFor(lake);
  if (!regs?.county) return []; // not inside a California county: these rules don't apply
  const when = time ? new Date(time) : new Date();
  const out = [];
  const group = regGroup(species);
  if (!group) return out;
  const mine = regs.special.filter(w => !w.tributariesOnly && (group === 'bass' ? w.sec === '5.00' : group === 'catfish' ? w.sec === '5.15' : /^7\./.test(w.sec)));
  const sp = species.toLowerCase().replace(/\bking salmon\b/, 'chinook salmon');
  const names = list => [...list].map(m => m[1].trim()).filter(n => n.toLowerCase().split(/\s+and\s+/).some(x => sp.includes(x.replace(/s$/, ''))));
  for (const w of mine) {
    const ref = `§${w.sec}${w.ref}`;
    // Rules for the whole water; rules that differ by reach only count when every reach agrees (we can't tell which reach you're on).
    const whole = w.parts.filter(p => !p.where); // continuation rows carry their reach's "where", so this is whole-water rows only
    const parts = whole.length ? whole : w.parts;
    const open = parts.map(p => partOpen(p, when));
    if (parts.length && open.every(o => o === false)) out.push(whole.length ? `Closed season here on this date (${ref}).` : `Every reach listed for this water is closed on this date (${ref}).`);
    if (released || !whole.length) continue;
    const now = parts.find((p, i) => open[i] !== false) ?? parts[0];
    const rule = `${now.bag ?? ''}. ${now.size ?? ''}`;
    const bag = parseInt(now.bag, 10);
    const crFor = names(rule.matchAll(/catch and release (?:only for|of) ([a-z ]+?)(?=[.,]|$)/gi));
    const closedFor = names(rule.matchAll(/closed to the take(?: and possession)? of ([a-z ]+?)(?=[.,]|$)/gi));
    if (bag === 0 || /catch and release only\s*(?:\.|$)/im.test(rule)) out.push(`Catch and release only (${ref}).`);
    else if (crFor.length) out.push(`Catch and release only for ${crFor[0]} (${ref}).`);
    else if (closedFor.length) out.push(`No ${closedFor[0].toLowerCase().replace(/ and /, ' or ')} may be kept here (${ref}).`);
    else {
      if (Number.isFinite(bag) && kept + 1 > bag) out.push(`Over the ${bag}-fish daily bag limit (${ref}).`);
      if (group === 'trout' && /hatchery/i.test(now.bag ?? '') && !/hatchery/.test(sp)) out.push(`Only hatchery trout or steelhead (adipose fin clipped) may be kept (${ref}).`);
      const min = now.size?.match(/(\d+)-inch minimum/i)?.[1];
      if (min && length && +length < +min) out.push(`Under the ${min}-inch minimum size (${ref}).`);
    }
  }
  if (!mine.length && group === 'trout' && regs.kind === 'stream' && seasonOpen('Last Sat. in Apr. through Nov. 15.', when) === false) out.push('Statewide stream trout season is closed (0 bag, artificial barbless lures only) (§5.85).');
  if (released) return out;
  if (!mine.length && group === 'trout' && kept + 1 > 5) out.push('Over the statewide 5-trout daily bag limit (§5.85).');
  if (!mine.some(w => w.sec === '5.00') && group === 'bass' && regs.kind === 'lake' && length && +length < 12) out.push('Under the 12-inch minimum for black bass in lakes (§5.00).');
  if (!mine.some(w => w.sec === '5.00') && group === 'bass' && kept + 1 > 5) out.push('Over the 5-bass daily bag limit (§5.00).');
  return out;
}
