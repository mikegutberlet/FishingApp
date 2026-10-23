// Nightly Oregon data for the app, run by .github/workflows/oregon-daily.yml:
//
//   data/or/plants.json      ODFW's weekly trout stocking schedule (week, water, number of legal, trophy, brood and
//                            fingerling trout), merged with earlier runs so history keeps growing past ODFW's 2 years
//   data/or/waters.json      every water on that schedule, with its zone and office, a map point (ODFW's stocking maps,
//                            USGS NHD, OpenStreetMap), what ODFW's stocking map says about it, and its latest
//                            Recreation Report entry
//   data/or/reports.json     every water in this week's ODFW Recreation Report, stocked or not
//   data/or/reservoirs.json  daily lake levels: USGS lake gauges, Army Corps reservoirs (Willamette, Rogue) and
//                            Reclamation reservoirs (Deschutes, Crooked, Owyhee, Powder)
//   data/or/hab.json         toxic algae (cyanobacteria) advisories from the Oregon Health Authority
//
// Only public data; nothing from anyone's phone is involved. Every source is optional: a failure keeps last run's file.

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { inOutline, STATES } from '../states.mjs';

const OUT = new URL('../../data/or/', import.meta.url);
const OR = STATES.or;
// State sites sit behind firewalls that turn away unknown clients, so those calls go out looking like a browser.
const BROWSER = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', Accept: 'text/html,application/json,*/*', 'Accept-Language': 'en-US,en;q=0.9' };
const UA = { 'User-Agent': 'TackleBox-fishing-app (personal, github.com/mikegutberlet/FishingApp)', Accept: 'application/json' };
const ODFW = 'https://myodfw.com';
const report = { startedAt: new Date().toISOString() };

async function get(url, { headers = UA, tries = 3 } = {}) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(90000) });
      if (!r.ok) throw new Error(`${r.status} ${url.slice(0, 200)}`);
      return r;
    } catch (e) {
      if (i >= tries) throw e;
      await new Promise(res => setTimeout(res, 3000 * i));
    }
  }
}
const getJson = async (url, opts) => (await get(url, opts)).json();
const getText = async (url, opts = { headers: BROWSER }) => (await get(url, opts)).text();
const readOld = async name => { try { return JSON.parse(await readFile(new URL(name, OUT), 'utf8')); } catch { return null; } };
const save = (name, data) => writeFile(new URL(name, OUT), JSON.stringify(data) + '\n');

const ENTITIES = { amp: '&', nbsp: ' ', quot: '"', apos: "'", lt: '<', gt: '>', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', hellip: '…' };
const decode = s => String(s ?? '').replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENTITIES[e.toLowerCase()] ?? m);
const clean = s => decode(String(s ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const round = n => +n.toFixed(5);
const norm = s => decode(s).toLowerCase().replace(/\(.*?\)/g, '').replace(/\b(lake|lakes|reservoir|res|river|creek|pond|ponds|the|of|park)\b|[^a-z0-9]/g, '');
const km = (a, b) => {
  const r = d => d * Math.PI / 180;
  const h = Math.sin(r(b[0] - a[0]) / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(r(b[1] - a[1]) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};
const inOregon = (lat, lon) => inOutline([lon, lat], OR.outline);
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
// "Oct. 19, 2026", "October 19, 2026", "10/19/2026" → 2026-10-19
function isoDate(s) {
  const m = String(s).match(/([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/);
  const mo = m && (MONTHS[m[1].toLowerCase().slice(0, 4)] ?? MONTHS[m[1].toLowerCase().slice(0, 3)]);
  if (mo) return `${m[3]}-${String(mo).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  const n = String(s).match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  return n ? `${n[3].length === 2 ? '20' + n[3] : n[3]}-${n[1].padStart(2, '0')}-${n[2].padStart(2, '0')}` : null;
}
// ODFW's spelling of a water as an id that is safe in backups and data-* attributes (same as states/or.js odfwId):
// letters, digits and "-" as they are, a space as "_", anything else as ".XX" per UTF-8 byte.
const odfwId = raw => [...String(raw)].map(c => /[A-Za-z0-9-]/.test(c) ? c : c === ' ' ? '_'
  : [...new TextEncoder().encode(c)].map(b => '.' + b.toString(16).toUpperCase().padStart(2, '0')).join('')).join('');
// A key that keeps the water word, with Lake and Reservoir as one: "Lost Creek Reservoir" is "Lost Creek Lake",
// not "Lost Lake".
const kindKey = s => decode(s).toLowerCase().replace(/\(.*?\)/g, '').replace(/\b(reservoirs?|res|lakes)\b/g, 'lake').replace(/\bponds\b/g, 'pond')
  .replace(/\b(the|of|park)\b|[^a-z0-9]/g, '');
const tableRows = html => [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(m => [...m[1].matchAll(/<t([dh])\b[^>]*>([\s\S]*?)<\/t\1>/gi)].map(c => ({ html: c[2], text: clean(c[2]) })));

// ---------- ODFW stocking schedule ----------
// ODFW writes waters in capitals with abbreviations: "HENRY HAGG LK", "SILVER CR RES", "N FK SMITH R PD".
const ABBR = { LK: 'Lake', LKS: 'Lakes', RES: 'Reservoir', PD: 'Pond', PDS: 'Ponds', CR: 'Creek', R: 'River', FK: 'Fork', MF: 'Middle Fork', NF: 'North Fork', SF: 'South Fork', EF: 'East Fork', WF: 'West Fork',
  N: 'North', S: 'South', E: 'East', W: 'West', SL: 'Slough', MT: 'Mount', MTN: 'Mountain', ST: 'St.', CK: 'Creek', SPGS: 'Springs', SPG: 'Spring', HWY: 'Highway', CO: 'County', PK: 'Park', UPR: 'Upper', LWR: 'Lower', JR: 'Jr.' };
const SMALL = new Set(['of', 'the', 'and', 'at', 'in', 'on']);
const WORD_ABBR = { ...ABBR, RVR: 'River', WLDLIFE: 'Wildlife', CST: 'Coast', L: 'Lower', U: 'Upper', OHV: 'OHV', MHCC: 'MHCC' };
const word = (w, i) => {
  const m = w.match(/^([^A-Za-z#\d]*)([A-Za-z'.]+|#?\d+\w*)([^A-Za-z]*)$/);
  if (!m) return w;
  const [, pre, core, post] = m, bare = core.replace(/[^A-Za-z]/g, '').toUpperCase();
  if (WORD_ABBR[bare] && /^[A-Za-z]+\.?$/.test(core)) return pre + WORD_ABBR[bare] + post;
  if (/^[IVX]+$/.test(core) || /^#?\d/.test(core)) return w;
  const lower = core.toLowerCase();
  const out = i > 0 && SMALL.has(lower) ? lower : lower.replace(/(^|[\-/'.])([a-z])/g, (x, q, c) => q + c.toUpperCase()).replace(/^Mc([a-z])/, (x, c) => 'Mc' + c.toUpperCase()).replace(/^O'([a-z])/, (x, c) => "O'" + c.toUpperCase());
  return pre + out + post;
};
// "SALISH PD, W" → "West Salish Pond", "EMPIRE LK, LWR" → "Lower Empire Lake", "WILLAMETTE R, CST FK" → "Coast Fork Willamette River",
// "NORTH POWDER PD-1" → "North Powder Pond 1".
function waterName(raw) {
  let [head, ...quals] = decode(raw).replace(/\s+/g, ' ').trim().split(/\s*,\s*/);
  head = head.replace(/\b(PD|LK|RES|R)-(\d+)\b/gi, '$1 $2');
  const words = s => s.split(' ').map(word).join(' ');
  let name = words(head);
  // A lone "B" or "L" after the comma is Big or Little ("CULTUS LK, B", "LAVA LK, L").
  if (quals.length) name = `${quals.map(q => /^[BL]$/i.test(q) ? (/b/i.test(q) ? 'Big' : 'Little') : words(q)).reverse().join(' ')} ${name}`;
  return name.replace(/\s+/g, ' ').trim();
}

const SIZES = [['legals', 'Legal trout', 'Legal-size rainbow trout, about 8 to 12 inches'], ['trophy', 'Trophy trout', 'Larger trout, 12 inches or more'],
  ['brood', 'Brood trout', 'Retired hatchery brood fish, often several pounds'], ['fingerling', 'Fingerling trout', 'Small trout to grow in the water']];

// The schedule's filters, as ODFW's own stocking-map links write them.
const FILTER = { zone: 'field_zone_value', water: 'field_waterbody_name_value_1', from: 'field_planned_stocking_date_value[date]', to: 'field_planned_stocking_date_end_value[date]' };
export const scheduleLink = raw => `${ODFW}/fishing/species/trout/stocking-schedule?${new URLSearchParams({ [FILTER.zone]: 'All', [FILTER.water]: raw })}`;

function scheduleRows(html) {
  const rows = [];
  let header = null;
  for (const cells of tableRows(html)) {
    const texts = cells.map(c => c.text);
    if (texts.some(t => /^Week of$/i.test(t)) || texts.some(t => /^Waterbody$/i.test(t))) { header = texts.map(t => t.toLowerCase()); continue; }
    if (cells.length < 4) continue;
    const col = re => header ? header.findIndex(h => re.test(h)) : -1;
    const at = (re, i) => texts[col(re) >= 0 ? col(re) : i] ?? '';
    const [from, to] = at(/week/, 0).split(/\s+[–—-]\s+/);
    const week = isoDate(from), weekEnd = isoDate(to ?? from) ?? week;
    const water = at(/water/, 1);
    if (!week || !water) continue;
    const [zone, office] = at(/zone|office/, 2).split('/').map(s => s.trim());
    const num = (re, i) => { const n = parseInt(at(re, i).replace(/[^\d]/g, ''), 10); return Number.isFinite(n) ? n : 0; };
    rows.push({ week, weekEnd, raw: water, zone: zone || null, office: office || null, legals: num(/legal/, 3), trophy: num(/trophy/, 4), brood: num(/brood/, 5), fingerling: num(/finger/, 6), total: num(/total/, 7) });
  }
  return rows;
}

// ODFW keeps 2 years of stockings and the weeks already planned. The print view lists up to 500 rows, so the job
// asks for a month at a time (half a month when a month is full).
// Date windows that came back tonight: a planned stocking in one of them that isn't on tonight's schedule was moved
// or cancelled.
const FETCHED = [];
async function scheduleFetch() {
  const log = report.schedule = { windows: [] };
  const byKey = new Map();
  const day = t => new Date(t).toISOString().slice(0, 10);
  const ask = async (from, to) => {
    const q = new URLSearchParams({ [FILTER.zone]: 'All', [FILTER.water]: '', [FILTER.from]: from, [FILTER.to]: to });
    const rows = scheduleRows(await getText(`${ODFW}/fishing/species/trout/stocking-schedule-print?${q}`));
    log.windows.push(`${from}..${to}: ${rows.length}`);
    return rows;
  };
  const start = Date.now() - 2 * 365 * 864e5, end = Date.now() + 365 * 864e5;
  for (let t = start; t < end; t += 31 * 864e5) {
    const from = day(t), to = day(Math.min(end, t + 30 * 864e5));
    try {
      let rows = await ask(from, to);
      if (rows.length >= 490) rows = [...await ask(from, day(t + 15 * 864e5)), ...await ask(day(t + 16 * 864e5), to)];
      for (const r of rows) byKey.set(`${r.week}|${r.raw}`, r);
      FETCHED.push([from, to]);
    } catch (e) { log.windows.push(`${from}..${to}: ${e.message}`); }
    await new Promise(res => setTimeout(res, 700));
  }
  // The windows didn't work (ODFW changed its filters): take what the plain print view shows.
  if (byKey.size < 100) {
    try { for (const r of scheduleRows(await getText(`${ODFW}/fishing/species/trout/stocking-schedule-print`))) byKey.set(`${r.week}|${r.raw}`, r); } catch (e) { log.printError = e.message; }
  }
  log.rows = byKey.size;
  log.weeks = [...new Set([...byKey.values()].map(r => r.week))].sort().filter((w, i, a) => i === 0 || i === a.length - 1);
  log.sample = [...byKey.values()].slice(0, 3);
  return [...byKey.values()];
}

// ---------- Map points ----------
// ODFW's trout stocking maps (Google My Maps, one per region) carry each stocked water's point and a write-up
// (amenities, bank access, ramps, other species).
const MYMAPS = { 'Northwest': '1XrU6o1hz6iE7LCDCylxeF68umTc', 'Southwest': '1LG-uzfXhVY0P0_JUBDUuBE6HSGI', 'High Desert': '1NjkYZm2ah_UmHIzugZl11CfkLYc', 'Northeast': '1g7kA11OVF21hcpatZCsu3UoUZSs' };
async function stockingMaps() {
  const out = [];
  report.mymaps = {};
  for (const [region, mid] of Object.entries(MYMAPS)) {
    try {
      const kml = await getText(`https://www.google.com/maps/d/kml?mid=${mid}&forcekml=1`, { headers: { ...BROWSER, Accept: '*/*' } });
      let n = 0;
      for (const m of kml.matchAll(/<Placemark>([\s\S]*?)<\/Placemark>/g)) {
        const name = clean(m[1].match(/<name>([\s\S]*?)<\/name>/)?.[1]?.replace(/<!\[CDATA\[|\]\]>/g, ''));
        const coords = m[1].match(/<coordinates>\s*([-\d.]+),([-\d.]+)/);
        if (!name || !coords) continue;
        const desc = m[1].match(/<description>([\s\S]*?)<\/description>/)?.[1]?.replace(/<!\[CDATA\[|\]\]>/g, '') ?? '';
        const about = decode(desc.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).split('\n').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n').slice(0, 2000);
        const lat = round(+coords[2]), lon = round(+coords[1]);
        if (!inOregon(lat, lon)) continue;
        // Each write-up links to the schedule filtered to the water's name exactly as the schedule spells it.
        const raws = [...decode(desc).matchAll(/field_waterbody_name_value_1=([^&"\s<]+)/g)].map(x => { try { return decodeURIComponent(x[1].replace(/\+/g, ' ')).trim().toUpperCase(); } catch { return null; } }).filter(Boolean);
        out.push({ name, raws, lat, lon, about: about.replace(/\n?Trout Stocking Schedule\s*-*\s*https?:\S+/gi, '').trim() || null, region });
        n++;
      }
      report.mymaps[region] = n;
    } catch (e) { report.mymaps[region] = e.message; }
  }
  report.mymapsSample = out.slice(0, 4);
  return out;
}

async function nhdWaters() {
  const [l, r] = await Promise.all([readOld('lakes.json'), readOld('rivers.json')]);
  const out = [];
  for (const x of l?.lakes ?? []) out.push({ name: x.name, kind: 'lake', lat: x.lat, lon: x.lon, acres: x.acres });
  for (const x of r?.rivers ?? []) for (const [lat, lon] of x.points) out.push({ name: x.name, kind: 'stream', lat, lon, line: x.id });
  return out;
}

// OpenStreetMap Nominatim, at most one request a second as its policy asks; answers are kept between runs.
let GEO = {}, geoCalls = 0;
async function geocode(q) {
  if (q in GEO) return GEO[q];
  if (geoCalls >= 150) return null;
  geoCalls++;
  const b = OR.bbox;
  const params = new URLSearchParams({ q: `${q}, Oregon`, format: 'json', limit: '5', countrycodes: 'us', viewbox: `${b.xmin},${b.ymax},${b.xmax},${b.ymin}`, bounded: '1' });
  await new Promise(res => setTimeout(res, 1100));
  let hits = [];
  try { hits = await getJson(`https://nominatim.openstreetmap.org/search?${params}`); } catch (e) { report.geocodeError = e.message; return null; }
  GEO[q] = hits.filter(h => inOregon(+h.lat, +h.lon) && /water|natural|leisure|waterway|reservoir|park|landuse/i.test(`${h.class} ${h.type}`)).map(h => ({ lat: round(+h.lat), lon: round(+h.lon), type: `${h.class}/${h.type}` }));
  return GEO[q];
}

// ODFW zone of a point: the angling zone outlines the weekly job saves (zones.json).
let ZONES = [];
function inRing([x, y], ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}
const zoneAt = (lat, lon) => ZONES.find(z => lon >= z.bbox[0] && lon <= z.bbox[2] && lat >= z.bbox[1] && lat <= z.bbox[3] && z.polys.some(([outer]) => inRing([lon, lat], outer)))?.name ?? null;
// County of a point, from the outlines the weekly job saves (counties.json).
let COUNTIES = [];
const countyAt = (lat, lon) => COUNTIES.find(c => lon >= c.bbox[0] && lon <= c.bbox[2] && lat >= c.bbox[1] && lat <= c.bbox[3] && c.polys.some(([outer]) => inRing([lon, lat], outer)))?.name ?? null;
const sameZone = (a, b) => !a || !b || a.toLowerCase().replace(/\s*zone$/, '').replace(/ river$/, '') === b.toLowerCase().replace(/\s*zone$/, '').replace(/ river$/, '');
const isFlowing = name => /\b(river|creek|fork|slough|canal)\b/i.test(name) && !/\b(lake|reservoir|pond|ponds|lakes)\b/i.test(name);

// Names to look a water up by: "Silver Creek Reservoir", plus without a "(Bend)" place note, which becomes a hint.
function lookupNames(name) {
  const where = name.match(/\(([^)]+)\)/)?.[1] ?? null;
  const bare = name.replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  const names = new Set([name, bare]);
  if (/ Lake$/.test(bare)) names.add(`Lake ${bare.replace(/ Lake$/, '')}`);
  if (/ Reservoir$/.test(bare)) names.add(bare.replace(/ Reservoir$/, ' Lake'));
  if (/ Lake$/.test(bare)) names.add(bare.replace(/ Lake$/, ' Reservoir'));
  return { names: [...names], where };
}

const zoneOk = (w, c) => !ZONES.length || sameZone(zoneAt(c.lat, c.lon), w.zone);
async function pickPoint(w, maps, nhd) {
  const { names, where } = lookupNames(w.name);
  const keys = new Set(names.map(kindKey).filter(k => k.length >= 5));
  const flowing = isFlowing(w.name);
  const okZone = c => zoneOk(w, c);
  const near = where ? (await geocode(where))?.[0] : null;
  // 1. ODFW's own map: a placemark whose schedule link is this water's exact spelling. That is ODFW saying which
  // water it is, so it stands even just over a zone line (ponds on the Columbia zone's edge).
  const byRaw = maps.filter(m => m.raws.includes(w.raw.toUpperCase()));
  if (byRaw.length) { const b = byRaw.find(okZone) ?? byRaw[0]; return { lat: b.lat, lon: b.lon, via: 'odfw', match: 'raw', about: b.about }; }
  // Then the same name in the right zone (Oregon has many Fish Lakes and Devils Lakes).
  const mHit = maps.filter(m => keys.has(kindKey(m.name))).find(okZone);
  if (mHit) return { lat: mHit.lat, lon: mHit.lon, via: 'odfw', match: 'name', about: mHit.about };
  // 2. USGS NHD names, in the right zone (Oregon has many Clear Lakes and Mud Lakes).
  let same = nhd.filter(c => keys.has(kindKey(c.name)) && (c.kind === 'stream') === flowing && okZone(c));
  if (near) same = same.map(c => ({ ...c, d: km([c.lat, c.lon], [near.lat, near.lon]) })).filter(c => c.d <= 40).sort((a, b) => a.d - b.d);
  if (same.length) {
    const groups = new Set(same.map(c => c.line ?? `${c.lat},${c.lon}`));
    if (near || groups.size === 1 || !flowing) {
      const best = flowing && !near ? same[Math.floor(same.length / 2)] : same.sort((a, b) => (a.d ?? 0) - (b.d ?? 0) || (b.acres ?? 0) - (a.acres ?? 0))[0];
      return { lat: best.lat, lon: best.lon, via: 'nhd', ...(best.acres && { acres: best.acres }) };
    }
  }
  // 3. OpenStreetMap.
  for (const q of names.slice(0, 2)) {
    const hit = ((await geocode(q)) ?? []).filter(okZone)[0];
    if (hit) return { lat: hit.lat, lon: hit.lon, via: 'osm' };
  }
  return null;
}

// ---------- ODFW Recreation Report ----------
// One page per zone, rewritten every week: "best bets" bullets that name the waters fishing well.
const REPORT_ZONES = { northwest: 'Northwest', southwest: 'Southwest', willamette: 'Willamette', central: 'Central', northeast: 'Northeast', southeast: 'Southeast', columbia: 'Columbia River', marine: 'Marine' };
const BOILER = /regulation update page|table of contents|^recreation report$|best bets$|zone\s*[-–]$/i;
async function recreationReport() {
  const out = [];
  report.recreation = {};
  // Zone pages don't all carry a date; the Recreation Report's front page does.
  let weekOf = null;
  try { weekOf = isoDate(clean(await getText(`${ODFW}/recreation-report`)).match(/(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}/)?.[0] ?? ''); } catch {}
  report.recreation.weekOf = weekOf;
  for (const [z, zone] of Object.entries(REPORT_ZONES)) {
    const url = `${ODFW}/recreation-report/fishing-report/${z}-zone`;
    const log = report.recreation[z] = {};
    try {
      const html = await getText(url);
      const main = (html.match(/<main\b[\s\S]*?<\/main>/i)?.[0] ?? html).replace(/<(script|style|nav|header|footer|noscript)[\s\S]*?<\/\1>/gi, '');
      const date = isoDate(clean(main.match(/<time[^>]*>([\s\S]*?)<\/time>/i)?.[1] ?? '')) ?? isoDate(clean(main).match(/(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}/)?.[0] ?? '');
      const items = [];
      let section = null;
      for (const m of main.matchAll(/<(h[2-6]|p|li)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
        const t = clean(m[2]);
        if (!t || BOILER.test(t)) continue;
        // Short all-caps lines are species headings in the Columbia report ("WALLEYE", "STURGEON").
        if (/^h/i.test(m[1]) || (t.length < 40 && t === t.toUpperCase())) { section = t; continue; }
        if (t.length < 30) continue;
        items.push(section && section === section.toUpperCase() && !t.toUpperCase().includes(section) ? `${section[0]}${section.slice(1).toLowerCase()}. ${t}` : t);
      }
      log.date = date; log.items = items.length; log.first = items.slice(0, 3);
      out.push({ zone, date: date ?? weekOf, url, items: [...new Set(items)].slice(0, 80) });
    } catch (e) { log.error = e.message; }
  }
  return out;
}

// Whether a report line talks about this water: its name without the "Lake"/"River" part, as a whole word, in a
// line that names the same kind of water ("Siltcoos and Tahkenitch lakes" is about Siltcoos Lake).
const KIND = [[/\b(lake|lakes|reservoir|reservoirs|res|pond|ponds)\b/i], [/\b(river|rivers|creek|creeks)\b/i], [/\b(canal|canals)\b/i]];
export function mentions(text, name) {
  const bare = name.replace(/\s*\(.*?\)\s*/g, ' ').trim();
  const base = bare.replace(/^Lake\s+/i, '').replace(/\s+(Lake|Lakes|Reservoir|Pond|Ponds|River|Creek|Canal)$/i, '').trim();
  if (base.length < 4 || /^(north|south|east|west|upper|lower|middle|big|little|clear|mud|fish|blue|lost|long|round)$/i.test(base)) return false;
  // A name ending in its water word wants that word ("Malheur Reservoir" isn't "Malheur Lake"). Same as states/or.js.
  const own = bare.match(/\s(Lake|Reservoir|Pond|River|Creek|Canal)$/i)?.[1]?.toLowerCase();
  const kind = own ? new RegExp(`\\b(${own}|${own}s${own === 'reservoir' ? '|res' : ''})\\b`, 'i')
    : KIND.find(([re]) => re.test(bare))?.[0] ?? /\b(lake|lakes|reservoir|res|pond|ponds|river|rivers|creek|creeks)\b/i;
  const b = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The name, then the kind of water within a few words ("Siltcoos and Tahkenitch lakes"), or "Lake Billy Chinook".
  return new RegExp(`\\b${b}\\b(?:[\\s,]+[\\w'’-]+){0,3}?[\\s,]+${kind.source.replace(/\\b/g, '')}\\b`, 'i').test(text) || (/^Lake /i.test(bare) && new RegExp(`\\blake\\s+${b}\\b`, 'i').test(text));
}

async function buildWaters(rows, reports) {
  const [maps, nhd] = await Promise.all([stockingMaps(), nhdWaters()]);
  ZONES = (await readOld('zones.json'))?.zones ?? [];
  COUNTIES = (await readOld('counties.json'))?.counties ?? [];
  GEO = (await readOld('geocode-cache.json')) ?? {};
  // The first runs used slug ids, then ODFW's raw spelling; both carry the raw name, so key old entries by the new id.
  const old = new Map(((await readOld('waters.json'))?.waters ?? []).filter(w => w.raw && (w.id === w.raw || w.id === odfwId(w.raw))).map(w => [odfwId(w.raw), w]));
  const byWater = new Map();
  for (const r of rows) {
    const id = odfwId(r.raw);
    const w = byWater.get(id) ?? { id, raw: r.raw, name: waterName(r.raw), zone: r.zone, office: r.office, weeks: [] };
    w.weeks.push(r.week);
    w.zone ??= r.zone; w.office ??= r.office;
    byWater.set(id, w);
  }
  // Waters no longer on the schedule stay, so their history still has a home.
  for (const [id, w] of old) if (!byWater.has(id)) byWater.set(id, { id, raw: w.raw, name: waterName(w.raw), zone: w.zone, office: w.office, weeks: [] });
  report.points = { nhd: nhd.length, odfwMaps: maps.length, via: {}, unmatched: [] };
  const waters = [];
  for (const w of byWater.values()) {
    const prev = old.get(w.id);
    // Keep last night's ODFW point when it is ODFW's own link for the water or sits in the water's zone; otherwise
    // pick again (early runs, before zones.json, pinned some waters on a same-named water elsewhere).
    const prevOk = prev?.lat != null && (prev.match === 'raw' || zoneOk(w, prev));
    const pt = prev?.via === 'odfw' && prevOk ? prev : await pickPoint(w, maps, nhd) ?? (prevOk ? prev : null);
    if (!pt) report.points.unmatched.push(`${w.raw} → ${w.name} (${w.zone})`);
    report.points.via[pt?.via ?? 'none'] = (report.points.via[pt?.via ?? 'none'] ?? 0) + 1;
    const rep = reports.map(x => ({ ...x, lines: (x.items ?? []).filter(t => mentions(t, w.name)) })).find(x => x.lines.length && (sameZone(x.zone, w.zone) || /Columbia/.test(x.zone)));
    const today = new Date().toISOString().slice(0, 10);
    const years = w.weeks.filter(d => d <= today).map(d => +d.slice(0, 4)).sort();
    waters.push({
      id: w.id, raw: w.raw, name: w.name, type: isFlowing(w.name) ? 'River' : /Pond/.test(w.name) ? 'Pond' : 'Lake', zone: w.zone, office: w.office,
      counties: [w.zone && `${w.zone} Zone`, w.office].filter(Boolean).join(' · '), county: pt ? countyAt(pt.lat, pt.lon) : null,
      lat: pt?.lat ?? null, lon: pt?.lon ?? null, via: pt?.via ?? null, ...(pt?.match && { match: pt.match }), acres: pt?.acres ?? (pt === prev ? prev?.acres : null) ?? null,
      about: pt?.about ?? (pt === prev ? prev?.about : null) ?? null,
      report: rep ? rep.lines.join('\n') : null, reportDate: rep?.date ?? null, reportUrl: rep?.url ?? null, url: scheduleLink(w.raw),
      lastYearStocked: years.at(-1) ?? prev?.lastYearStocked ?? null,
    });
  }
  report.points.geocoderCalls = geoCalls;
  await save('geocode-cache.json', GEO);
  return waters.sort((a, b) => a.name.localeCompare(b.name));
}

async function buildPlants(rows) {
  const old = (await readOld('plants.json'))?.plants ?? [];
  const byKey = new Map();
  const key = p => `${p.stockId}|${p.week}|${p.species}`;
  // The first runs keyed plants by a lowercase slug (dropped), then by ODFW's raw spelling (converted).
  const tonight = new Set(rows.map(r => `${odfwId(r.raw)}|${r.week}`));
  let moved = 0;
  for (const o of old) {
    if (/^[a-z0-9-]+$/.test(o.stockId)) continue;
    const p = /^[\w.:-]*$/.test(o.stockId) ? o : { ...o, stockId: odfwId(o.stockId) };
    // In a window ODFW answered tonight, a stocking not on tonight's schedule was moved or cancelled.
    if (!tonight.has(`${p.stockId}|${p.week}`) && FETCHED.some(([from, to]) => p.week >= from && p.week <= to)) { moved++; continue; }
    byKey.set(key(p), p);
  }
  let fresh = 0;
  for (const r of rows) {
    const stockId = odfwId(r.raw);
    // The schedule can change before the week comes; tonight's numbers replace last night's for that week.
    for (const [k] of SIZES) byKey.delete(key({ stockId, week: r.week, species: SIZES.find(s => s[0] === k)[1] }));
    for (const [k, species] of SIZES) {
      if (!r[k]) continue;
      const p = { week: r.week, weekEnd: r.weekEnd, stockId, water: waterName(r.raw), counties: [r.zone && `${r.zone} Zone`, r.office].filter(Boolean).join(' · '), species, count: r[k], inches: null };
      if (!old.some(o => key(o) === key(p))) fresh++;
      byKey.set(key(p), p);
    }
  }
  // ODFW plans a year ahead and moves weeks as it goes; keep the next 8 weeks, like the other states' schedules.
  const horizon = new Date(Date.now() + 56 * 864e5).toISOString().slice(0, 10);
  for (const [k, p] of byKey) if (p.week > horizon) byKey.delete(k);
  report.plants = { total: byKey.size, new: fresh, kept: old.length, movedOrCancelled: moved };
  return [...byKey.values()].sort((a, b) => b.week.localeCompare(a.week) || a.water.localeCompare(b.water));
}

// ---------- Lake levels ----------
const titleCase = s => s.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase()).replace(/\bNr\b/g, 'near').replace(/\bRes\b/g, 'Reservoir').replace(/\bLk\b/g, 'Lake').replace(/, (Or|Wa|Id)$/, m => m.toUpperCase());

async function usgsLevels() {
  const PARAMS = '62614,62615,00062,00054,00065';
  const rdb = await (await get(`https://waterservices.usgs.gov/nwis/site/?format=rdb&stateCd=or&siteType=LK&parameterCd=${PARAMS}&siteStatus=active&hasDataTypeCd=dv`)).text();
  const lines = rdb.split('\n').filter(l => l && !l.startsWith('#'));
  const head = lines[0].split('\t');
  const sites = lines.slice(2).map(l => Object.fromEntries(l.split('\t').map((v, i) => [head[i], v.trim()])));
  report.usgs = { sites: sites.map(s => `${s.site_no} ${s.station_nm}`) };
  if (!sites.length) return [];
  const dv = await getJson(`https://waterservices.usgs.gov/nwis/dv/?format=json&sites=${sites.map(s => s.site_no).join(',')}&parameterCd=${PARAMS}&period=P60D&siteStatus=all`);
  const out = new Map(sites.map(s => [s.site_no, { id: s.site_no, name: titleCase(s.station_nm), lat: round(+s.dec_lat_va), lon: round(+s.dec_long_va), source: 'USGS', datumFt: +s.alt_va || null, elevation: [], storage: [], _rank: 9 }]));
  for (const ts of dv.value?.timeSeries ?? []) {
    const [, site, param, stat] = ts.name.split(':');
    const r = out.get(site);
    if (!r) continue;
    const vals = (ts.values?.[0]?.value ?? []).map(v => [v.dateTime.slice(0, 10), +v.value]).filter(([, v]) => Number.isFinite(v) && v > -999);
    if (!vals.length) continue;
    const rank = (/0006[25]/.test(param) ? 2 : 0) + (stat === '00003' ? 0 : 1);
    if (param === '00054') { if (!r.storage.length || stat === '00003') r.storage = vals; continue; }
    if (rank >= r._rank) continue;
    r._rank = rank;
    // Gage height above a local datum: add the datum's elevation so it reads as lake elevation.
    const offset = /0006[25]/.test(param) && vals.at(-1)[1] < 1000 && r.datumFt ? r.datumFt : 0;
    // A gage height with no datum to add isn't a lake elevation (Keno: 84 ft); leave it out.
    if (/0006[25]/.test(param) && !offset && vals.at(-1)[1] < 300) continue;
    r.elevation = vals.map(([d, v]) => [d, +(v + offset).toFixed(2)]);
  }
  return [...out.values()].filter(r => r.elevation.length || r.storage.length).map(({ _rank, datumFt, ...r }) => r);
}

// Army Corps reservoirs (Detroit, Green Peter, Lookout Point, Hills Creek, Lost Creek…) from the CWMS Data API.
const CDA = 'https://cwms-data.usace.army.mil/cwms-data';
const CDA_HEADERS = { ...UA, Accept: 'application/json;version=2' };
async function corpsLevels() {
  const log = report.corps = {};
  const cat = await getJson(`${CDA}/catalog/TIMESERIES?office=NWDP&like=${encodeURIComponent('.*\\.Elev-Forebay\\..*')}&page-size=1000`, { headers: CDA_HEADERS });
  const ids = (cat.entries ?? []).map(e => e.name ?? e['time-series-id'] ?? e.tsid).filter(Boolean);
  log.catalog = ids.length;
  log.sampleIds = ids.slice(0, 30);
  // Candidate series per location, best first: revised and "Best" data, daily or hourly; never forecasts.
  const byLoc = new Map();
  const score = id => (/Best/.test(id) ? 0 : /MIXED-REV|CBT-REV|USBR-COMPUTED-REV/.test(id) ? 1 : /REV/.test(id) ? 2 : 3) + (/Ave\.~?1Day/.test(id) ? 0 : /1Hour/.test(id) ? 0.2 : 0.4);
  for (const id of ids) {
    if (/FCST|MODEL|SubSample/i.test(id)) continue;
    const loc = id.split('.')[0];
    byLoc.set(loc, [...(byLoc.get(loc) ?? []), id].sort((a, b) => score(a) - score(b)));
  }
  const out = [];
  const begin = new Date(Date.now() - 60 * 864e5).toISOString(), end = new Date().toISOString();
  log.locations = [];
  for (const [loc, tsids] of byLoc) {
    try {
      const l = await getJson(`${CDA}/locations/${encodeURIComponent(loc)}?office=NWDP`, { headers: CDA_HEADERS });
      const lat = l.latitude, lon = l.longitude;
      if (!Number.isFinite(lat) || !inOregon(lat, lon)) continue;
      const name = l['public-name'] || l['long-name'] || loc;
      if (/canal|diversion|lock|power ?house|feed/i.test(name)) { log.locations.push(`${loc} ${name}: skipped`); continue; }
      let elevation = [], used = null;
      for (const tsid of tsids.slice(0, 4)) {
        const ts = await getJson(`${CDA}/timeseries?name=${encodeURIComponent(tsid)}&office=NWDP&begin=${begin}&end=${end}&unit=EN&page-size=20000`, { headers: CDA_HEADERS });
        const days = new Map();
        for (const [t, v] of ts.values ?? []) if (Number.isFinite(v) && v > 0) days.set(new Date(t).toISOString().slice(0, 10), v);
        elevation = [...days].sort((a, b) => a[0].localeCompare(b[0])).map(([d, v]) => [d, +v.toFixed(2)]);
        used = `${tsid} ${elevation.length} days ${ts.units ?? ''}`;
        if (elevation.length > 5) break;
      }
      log.locations.push(`${loc} ${name}: ${used}`);
      if (elevation.length) out.push({ id: loc, name, lat: round(lat), lon: round(lon), source: 'USACE', elevation, storage: [] });
    } catch (e) { log.locations.push(`${loc}: ${e.message}`); }
  }
  return out;
}

// Reclamation's Pacific Northwest Hydromet: forebay elevation (fb) and active storage (af) of its Oregon reservoirs.
// Station codes: the reservoir's (WIC) first, then the dam's (WICO).
const HYDROMET = [
  ['WICO', 'Wickiup Reservoir', 43.68, -121.69], ['CRAO', 'Crane Prairie Reservoir', 43.80, -121.78], ['PRVO', 'Prineville Reservoir', 44.11, -120.78],
  ['OCHO', 'Ochoco Reservoir', 44.30, -120.73], ['HAYO', 'Haystack Reservoir', 44.49, -121.14], ['OWYO', 'Owyhee Reservoir', 43.64, -117.25],
  ['PHLO', 'Phillips Lake', 44.68, -118.07], ['THFO', 'Thief Valley Reservoir', 45.01, -117.79], ['UNYO', 'Unity Reservoir', 44.50, -118.19],
  ['WARO', 'Warm Springs Reservoir', 43.59, -118.22], ['AGKO', 'Beulah Reservoir', 43.92, -118.16], ['BULO', 'Bully Creek Reservoir', 44.02, -117.40],
];
async function hydrometLevels() {
  const log = report.hydromet = {};
  const s = new Date(Date.now() - 60 * 864e5), e = new Date();
  const out = [];
  for (const [code, name, lat, lon] of HYDROMET) for (const id of [code.slice(0, 3), code]) {
    if (out.some(r => r.name === name)) break;
    const params = `parameter=${id}%20fb,${id}%20af&syer=${s.getUTCFullYear()}&smnth=${s.getUTCMonth() + 1}&sdy=${s.getUTCDate()}&eyer=${e.getUTCFullYear()}&emnth=${e.getUTCMonth() + 1}&edy=${e.getUTCDate()}&format=2`;
    try {
      const csv = await getText(`https://www.usbr.gov/pn-bin/daily.pl?${params}`, { headers: BROWSER, tries: 2 });
      const rows = csv.replace(/\r/g, '').split('\n').map(l => l.split(',').map(c => c.trim())).filter(c => /^\d{4}-\d{2}-\d{2}|^\d{1,2}\/\d{1,2}\/\d{4}/.test(c[0]));
      const day = d => /\//.test(d) ? isoDate(d) : d.slice(0, 10);
      const elevation = rows.filter(r => Number.isFinite(parseFloat(r[1]))).map(r => [day(r[0]), +parseFloat(r[1]).toFixed(2)]);
      const storage = rows.filter(r => Number.isFinite(parseFloat(r[2]))).map(r => [day(r[0]), Math.round(parseFloat(r[2]))]);
      log[id] = `${elevation.length} elev, ${storage.length} storage of ${rows.length} days`;
      if (elevation.length || storage.length) out.push({ id, name, lat, lon, source: 'USBR', elevation, storage });
    } catch (err) { log[id] = err.message; }
  }
  return out;
}

// ---------- Toxic algae ----------
// OHA's advisory table is a SharePoint list the page draws in the browser (CurrentCyanobacteriaAdvisories); the
// job reads the list through SharePoint's REST API. Each row: waterbody, county, status (advisory, precaution,
// lifted) and dates.
const OHA_SITE = 'https://www.oregon.gov/oha/PH/HEALTHYENVIRONMENTS/RECREATION/HARMFULALGAEBLOOMS';
const OHA_PAGE = `${OHA_SITE}/Pages/Blue-GreenAlgaeAdvisories.aspx`;
async function habAdvisories(waters) {
  const listUrl = `${OHA_SITE}/_api/web/GetList('${encodeURIComponent('/oha/PH/HEALTHYENVIRONMENTS/RECREATION/HARMFULALGAEBLOOMS/Lists/CurrentCyanobacteriaAdvisories')}')/items?$top=500`;
  const json = await getJson(listUrl, { headers: { ...BROWSER, Accept: 'application/json;odata=nometadata' } });
  const items = json.value ?? json.d?.results ?? [];
  // An empty list would read as "no advisories anywhere": treat it as a failure and keep last night's file.
  if (!items.length) throw new Error('OHA advisory list came back empty');
  const lakes = (await readOld('lakes.json'))?.lakes ?? [];
  if (!COUNTIES.length) COUNTIES = (await readOld('counties.json'))?.counties ?? [];
  const log = report.hab = { items: items.length, fields: Object.keys(items[0] ?? {}).filter(k => !/^(odata|__|FileSystem|ServerRedirected|ContentType|Compliance|OData_|Attachments|GUID|AuthorId|EditorId|Created|Modified|ID$|Id$)/.test(k)), sample: items.slice(0, 3) };
  // Field names in this list aren't documented; pick them by name.
  const field = (it, re, not) => { const k = Object.keys(it).find(k => re.test(k) && !(not && not.test(k)) && it[k] != null && it[k] !== ''); return k ? it[k] : null; };
  const text = v => typeof v === 'string' ? clean(v) : v && typeof v === 'object' ? clean(v.Description ?? v.Label ?? v.Url ?? JSON.stringify(v)) : v == null ? '' : String(v);
  const advisories = [];
  for (const it of items) {
    if (it.Display_x002d_On_x002d_Page === false) continue;
    const name = text(field(it, /^Title$/) ?? field(it, /water ?body|location|lake/i, /county|date|status/i)).replace(/[\u200b\u00a0]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!name) continue;
    const status = [it.Status, it.Status_x0020_Symbol?.Description, field(it, /status|advisory|level/i, /date|title|waterbody|symbol/i)].flat().filter(Boolean).map(text).join(' ');
    const lifted = field(it, /lift/i);
    const level = /lift/i.test(status) || (lifted && Date.parse(lifted) < Date.now()) ? 'lifted' : /precaution|yellow/i.test(status) ? 'caution' : 'warning';
    if (level === 'lifted') continue;
    const county = text(field(it, /county/i)).replace(/\s*County$/i, '');
    const issued = field(it, /issue|date/i, /lift|modified|created/i);
    const date = issued ? (String(issued).match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? isoDate(String(issued))) : null;
    const lat = +field(it, /^lat|latitude/i), lon = +field(it, /^lon|^long|longitude/i);
    // "South Umpqua River and mainstream Umpqua River" is two waters; "Lake X" is also "X Lake".
    const names = name.split(/[(,]/)[0].split(/\s+and\s+/).map(n => n.replace(/\b(mainstream|mainstem)\s+/i, '').trim()).filter(Boolean);
    const keys = new Set(names.flatMap(n => [kindKey(n), kindKey(n.replace(/^Lake\s+(.+)$/i, '$1 Lake'))]));
    // Only a same-named water in the county OHA gives: Oregon has several Willow Creek Reservoirs and Blue Lakes.
    const counties = county.split(/\s+and\s+|\s*\/\s*|\s*,\s*/).filter(Boolean);
    const inCounty = c => !counties.length || !COUNTIES.length || counties.includes(countyAt(c.lat, c.lon));
    const spot = Number.isFinite(lat) && lat && Number.isFinite(lon) && lon ? { lat: round(lat), lon: round(lon) }
      : lakes.filter(l => keys.has(kindKey(l.name)) && inCounty(l)).sort((a, b) => b.acres - a.acres)[0] ?? waters.find(w => w.lat != null && keys.has(kindKey(w.name)) && inCounty(w));
    const permanent = /permanent/i.test(`${status} ${name}`);
    advisories.push({ name, names, county, level, permanent, advisory: permanent ? 'Permanent recreational use advisory' : level === 'warning' ? 'Recreational use health advisory' : 'Precaution', date,
      detail: text(field(it, /comment|detail|description|note|area/i, /title|waterbody|county/i)).slice(0, 400), lat: spot?.lat ?? null, lon: spot?.lon ?? null });
  }
  // A water across a county line is listed once per county: keep one, naming both.
  for (let i = advisories.length - 1; i >= 0; i--) {
    const a = advisories[i], first = advisories.findIndex(b => b.name === a.name && b.level === a.level);
    if (first < i) { if (a.county && !advisories[first].county.includes(a.county)) advisories[first].county += ` and ${a.county}`; advisories.splice(i, 1); }
  }
  log.advisories = advisories.map(a => `${a.name} (${a.county}): ${a.level} ${a.date ?? ''} ${a.lat != null ? 'located' : 'NO POINT'}`);
  return { updatedAt: new Date().toISOString(), source: 'Oregon Health Authority, current cyanobacteria advisories', portal: OHA_PAGE, advisories };
}

// ---------- Run ----------
await mkdir(OUT, { recursive: true });
let rows = [], reports = [], waters = null;
try { rows = await scheduleFetch(); } catch (e) { report.scheduleError = e.message; console.error('schedule:', e.message); }
try { reports = await recreationReport(); } catch (e) { report.recreationError = e.message; console.error('recreation:', e.message); }
// A zone page that failed tonight keeps last week's lines rather than dropping out.
if (reports.length) for (const old of (await readOld('reports.json'))?.reports ?? []) if (old.items && !reports.some(r => r.zone === old.zone)) reports.push(old);
if (reports.length) await save('reports.json', { updatedAt: new Date().toISOString(), source: 'ODFW Recreation Report (myodfw.com/recreation-report)', reports });
if (rows.length) {
  try {
    waters = await buildWaters(rows, reports.length ? reports : (await readOld('reports.json'))?.reports ?? []);
    await save('waters.json', { updatedAt: new Date().toISOString(), source: 'ODFW weekly trout stocking schedule; map points from ODFW stocking maps, USGS NHD and OpenStreetMap', waters });
  } catch (e) { report.watersError = e.message; console.error('waters:', e.stack); }
  try {
    const plants = await buildPlants(rows);
    await save('plants.json', { updatedAt: new Date().toISOString(), source: 'ODFW weekly trout stocking schedule (myodfw.com)', plants });
  } catch (e) { report.plantsError = e.message; console.error('plants:', e.stack); }
}

const reservoirs = [];
for (const [name, fn] of [['usgs', usgsLevels], ['corps', corpsLevels], ['hydromet', hydrometLevels]]) {
  try { reservoirs.push(...await fn()); } catch (e) { report[`${name}Error`] = e.message; console.error(`${name}:`, e.message); }
}
// A source that failed tonight keeps its stations from the last good run; their last reading shows their age.
if (reservoirs.length) for (const old of (await readOld('reservoirs.json'))?.reservoirs ?? []) if (!reservoirs.some(r => r.source === old.source && r.id === old.id)) reservoirs.push(old);
if (reservoirs.length) {
  await save('reservoirs.json', { updatedAt: new Date().toISOString(), source: 'USGS Water Services, US Army Corps of Engineers (CWMS) and Reclamation Hydromet', units: { elevation: 'ft', storage: 'acre-ft' }, reservoirs });
}
report.reservoirs = reservoirs.map(r => `${r.source} ${r.id} ${r.name}: ${r.elevation.at(-1)?.join(' ') ?? '-'} / ${r.storage.at(-1)?.join(' ') ?? '-'}`);

try { await save('hab.json', await habAdvisories(waters ?? (await readOld('waters.json'))?.waters ?? [])); } catch (e) { report.habError = e.message; console.error('hab:', e.message); }

report.finishedAt = new Date().toISOString();
await writeFile(new URL('update-report.json', OUT), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2).slice(0, 12000));
