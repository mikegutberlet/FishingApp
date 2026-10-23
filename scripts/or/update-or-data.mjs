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
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
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
const tableRows = html => [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(m => [...m[1].matchAll(/<t([dh])\b[^>]*>([\s\S]*?)<\/t\1>/gi)].map(c => ({ html: c[2], text: clean(c[2]) })));

// ---------- ODFW stocking schedule ----------
// ODFW writes waters in capitals with abbreviations: "HENRY HAGG LK", "SILVER CR RES", "N FK SMITH R PD".
const ABBR = { LK: 'Lake', LKS: 'Lakes', RES: 'Reservoir', PD: 'Pond', PDS: 'Ponds', CR: 'Creek', R: 'River', FK: 'Fork', MF: 'Middle Fork', NF: 'North Fork', SF: 'South Fork', EF: 'East Fork', WF: 'West Fork',
  N: 'North', S: 'South', E: 'East', W: 'West', SL: 'Slough', MT: 'Mount', MTN: 'Mountain', ST: 'St.', CK: 'Creek', SPGS: 'Springs', SPG: 'Spring', HWY: 'Highway', CO: 'County', PK: 'Park', UPR: 'Upper', LWR: 'Lower', JR: 'Jr.' };
const SMALL = new Set(['of', 'the', 'and', 'at', 'in', 'on']);
function waterName(raw) {
  const words = decode(raw).replace(/\s+/g, ' ').trim().split(' ');
  return words.map((w, i) => {
    const bare = w.replace(/[^A-Za-z]/g, '').toUpperCase();
    if (ABBR[bare] && /^[A-Za-z]+\.?$/.test(w) && !(i === 0 && /^[NSEW]$/.test(bare) && words.length === 1)) return ABBR[bare];
    if (/^\(?[IVX]+\)?$/.test(w) || /^#?\d/.test(w)) return w;
    const lower = w.toLowerCase();
    if (i > 0 && SMALL.has(lower)) return lower;
    return lower.replace(/(^|[(\-/'.])([a-z])/g, (m, p, c) => p + c.toUpperCase()).replace(/^Mc([a-z])/, (m, c) => 'Mc' + c.toUpperCase());
  }).join(' ').replace(/\bFork ([A-Z][a-z]+ (?:River|Creek))/, 'Fork $1');
}

const SIZES = [['legals', 'Legal trout', 'Legal-size rainbow trout, about 8 to 12 inches'], ['trophy', 'Trophy trout', 'Larger trout, 12 inches or more'],
  ['brood', 'Brood trout', 'Retired hatchery brood fish, often several pounds'], ['fingerling', 'Fingerling trout', 'Small trout to grow in the water']];

// The schedule page's filter form: field names for the zone, waterbody and date range, so the job can ask for the
// whole window ODFW keeps (2 years back, and the weeks already planned).
function formFields(html) {
  const form = html.match(/<form\b[^>]*views-exposed-form[\s\S]*?<\/form>/i)?.[0] ?? html.match(/<form\b[\s\S]*?<\/form>/gi)?.find(f => /date|zone|waterbody/i.test(f)) ?? '';
  const fields = [...form.matchAll(/<(input|select)\b[^>]*\bname="([^"]+)"[^>]*>/gi)].map(m => ({ tag: m[1].toLowerCase(), name: decode(m[2]), type: m[0].match(/type="([^"]+)"/i)?.[1] ?? null, value: decode(m[0].match(/value="([^"]*)"/i)?.[1] ?? '') }));
  const action = decode(form.match(/action="([^"]*)"/i)?.[1] ?? '');
  return { action, fields };
}

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

async function scheduleFetch() {
  const url = `${ODFW}/fishing/species/trout/stocking-schedule`;
  const first = await getText(url);
  const form = formFields(first);
  const log = report.schedule = { form, pages: [] };
  const byKey = new Map();
  const add = (rows, label) => { for (const r of rows) byKey.set(`${r.week}|${r.raw}`, r); log.pages.push(`${label}: ${rows.length} rows`); };
  add(scheduleRows(first), 'default');
  // Ask for the full window ODFW keeps, if the form has date fields.
  const dateFields = form.fields.filter(f => /date|min|max|start|end/i.test(f.name) && f.tag === 'input');
  const start = new Date(Date.now() - 2 * 365 * 864e5).toISOString().slice(0, 10), end = new Date(Date.now() + 365 * 864e5).toISOString().slice(0, 10);
  const params = new URLSearchParams();
  for (const f of form.fields) {
    if (f.tag === 'select' && /zone/i.test(f.name)) params.set(f.name, 'All');
    else if (dateFields.includes(f)) params.set(f.name, /max|end|to/i.test(f.name) ? end : start);
    else if (f.type === 'hidden' && !/form_build_id|form_token/.test(f.name)) params.set(f.name, f.value);
  }
  const base = form.action ? new URL(form.action, url).href.split('?')[0] : url;
  const tries = dateFields.length ? [params] : [];
  // Drupal date filters are often "<name>[min]" / "<name>[max]" or "start_date" / "end_date"; try the usual ones too.
  for (const [a, b] of [['field_date_value[min]', 'field_date_value[max]'], ['start_date', 'end_date'], ['field_stocking_date_value[min]', 'field_stocking_date_value[max]'], ['date[min]', 'date[max]']]) {
    tries.push(new URLSearchParams({ [a]: start, [b]: end }));
  }
  for (const p of tries) {
    for (let page = 0; page < 80; page++) {
      if (page) p.set('page', page); else p.delete('page');
      const u = `${base}?${p}`;
      let html;
      try { html = await getText(u); } catch (e) { log.pages.push(`${u}: ${e.message}`); break; }
      const rows = scheduleRows(html);
      const before = byKey.size;
      add(rows, `${p.toString().slice(0, 160)}`);
      const hasNext = /[?&]page=\d+/.test(html.match(/<nav[^>]*pager[\s\S]*?<\/nav>/i)?.[0] ?? html.match(/class="[^"]*pager[\s\S]{0,3000}/i)?.[0] ?? '');
      if (!rows.length || byKey.size === before || !hasNext) break;
      await new Promise(res => setTimeout(res, 800));
    }
    if (byKey.size > 400) break; // the window came back; no need to try other field names
  }
  // The print view sometimes lists everything on one page.
  try { add(scheduleRows(await getText(`${ODFW}/fishing/species/trout/stocking-schedule-print`)), 'print'); } catch (e) { log.pages.push(`print: ${e.message}`); }
  log.rows = byKey.size;
  log.sample = [...byKey.values()].slice(0, 5);
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
        out.push({ name, lat, lon, about: about || null, region });
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

async function pickPoint(w, maps, nhd) {
  const { names, where } = lookupNames(w.name);
  const keys = new Set(names.map(norm).filter(k => k.length >= 3));
  const flowing = isFlowing(w.name);
  const okZone = c => !ZONES.length || sameZone(zoneAt(c.lat, c.lon), w.zone);
  const near = where ? (await geocode(where))?.[0] : null;
  // 1. ODFW's own map: same name (it spells waters out in full).
  const mm = maps.filter(m => keys.has(norm(m.name)) || norm(m.name) === norm(w.raw));
  const mHit = mm.find(okZone) ?? (mm.length === 1 ? mm[0] : null);
  if (mHit) return { lat: mHit.lat, lon: mHit.lon, via: 'odfw', about: mHit.about };
  // 2. USGS NHD names, in the right zone (Oregon has many Clear Lakes and Mud Lakes).
  let same = nhd.filter(c => keys.has(norm(c.name)) && (c.kind === 'stream') === flowing && okZone(c));
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
// One page per zone, rewritten every week: a short entry per water, each starting with the water's name.
const REPORT_ZONES = ['northwest', 'southwest', 'willamette', 'central', 'northeast', 'southeast', 'snake-river', 'columbia'];
const WATERISH = /\b(lake|lakes|reservoir|res|pond|ponds|river|creek|fork|bay|slough|channel|canal|marina|beach|estuary|jetty|basin)\b/i;
async function recreationReport() {
  const entries = [];
  report.recreation = {};
  for (const z of REPORT_ZONES) {
    const url = `${ODFW}/recreation-report/fishing-report/${z}-zone`;
    const log = report.recreation[z] = {};
    try {
      let html = await getText(url);
      const date = isoDate(clean(html.match(/<time[^>]*>([\s\S]*?)<\/time>/i)?.[1] ?? '')) ?? isoDate(html.match(/(?:Updated|Week of|published)[^<]{0,40}?([A-Z][a-z]+\.? \d{1,2},? \d{4})/)?.[1] ?? '') ?? null;
      const main = html.match(/<main\b[\s\S]*?<\/main>/i)?.[0] ?? html;
      const body = main.replace(/<(script|style|nav|header|footer|noscript)[\s\S]*?<\/\1>/gi, '');
      const blocks = [...body.matchAll(/<(h[2-6]|p|li|div class="[^"]*field[^"]*")\b[^>]*>([\s\S]*?)<\/(?:h[2-6]|p|li|div)>/gi)].map(m => ({ tag: m[1].slice(0, 2).toLowerCase(), html: m[2], text: clean(m[2]) })).filter(b => b.text);
      log.date = date; log.blocks = blocks.length;
      log.outline = blocks.slice(0, 40).map(b => `${b.tag}: ${b.text.slice(0, 90)}`);
      let cur = null;
      for (const b of blocks) {
        const lead = clean(b.html.match(/^\s*<(?:strong|b)>([\s\S]*?)<\/(?:strong|b)>/i)?.[1] ?? '');
        if (/^h/.test(b.tag) && b.text.length < 90 && WATERISH.test(b.text)) { cur = { name: b.text.replace(/[:.]$/, ''), text: [] }; entries.push({ zone: z, date, url, entry: cur }); continue; }
        if (lead && lead.length < 90 && WATERISH.test(lead)) {
          cur = { name: lead.replace(/[:.\-–]\s*$/, '').trim(), text: [] };
          entries.push({ zone: z, date, url, entry: cur });
          const rest = b.text.slice(lead.length).replace(/^[\s:.\-–]+/, '');
          if (rest) cur.text.push(rest);
          continue;
        }
        if (/^h/.test(b.tag)) { cur = null; continue; }
        if (cur && cur.text.join(' ').length < 2500) cur.text.push(b.text);
      }
    } catch (e) { log.error = e.message; }
    log.entries = entries.filter(e => e.zone === z).length;
  }
  const out = entries.filter(e => e.entry.text.length).map(e => ({ name: e.entry.name, zone: e.zone, date: e.date, url: e.url, text: e.entry.text.join('\n').slice(0, 2500) }));
  report.recreationSample = out.slice(0, 6);
  return out;
}

async function buildWaters(rows, reports) {
  const [maps, nhd] = await Promise.all([stockingMaps(), nhdWaters()]);
  ZONES = (await readOld('zones.json'))?.zones ?? [];
  GEO = (await readOld('geocode-cache.json')) ?? {};
  const old = new Map(((await readOld('waters.json'))?.waters ?? []).map(w => [w.id, w]));
  const byWater = new Map();
  for (const r of rows) {
    const id = slug(r.raw);
    const w = byWater.get(id) ?? { id, raw: r.raw, name: waterName(r.raw), zone: r.zone, office: r.office, weeks: [] };
    w.weeks.push(r.week);
    w.zone ??= r.zone; w.office ??= r.office;
    byWater.set(id, w);
  }
  for (const w of old.values()) if (!byWater.has(w.id)) byWater.set(w.id, { id: w.id, raw: w.raw ?? w.name, name: w.name, zone: w.zone, office: w.office, weeks: [] });
  report.points = { nhd: nhd.length, odfwMaps: maps.length, via: {}, unmatched: [] };
  const waters = [];
  for (const w of byWater.values()) {
    const prev = old.get(w.id);
    // Keep last night's point unless it came from a weaker source than tonight's.
    const pt = prev?.via === 'odfw' ? prev : await pickPoint(w, maps, nhd) ?? (prev?.lat != null ? prev : null);
    if (!pt) report.points.unmatched.push(`${w.raw} → ${w.name} (${w.zone})`);
    report.points.via[pt?.via ?? 'none'] = (report.points.via[pt?.via ?? 'none'] ?? 0) + 1;
    const rep = reports.filter(x => sameZone(x.zone.replace(/-/g, ' '), w.zone) && lookupNames(w.name).names.some(n => norm(n) === norm(x.name)))[0];
    const years = w.weeks.map(d => +d.slice(0, 4)).sort();
    waters.push({
      id: w.id, raw: w.raw, name: w.name, type: isFlowing(w.name) ? 'River' : /Pond/.test(w.name) ? 'Pond' : 'Lake', zone: w.zone, office: w.office,
      counties: [w.zone && `${w.zone} Zone`, w.office].filter(Boolean).join(' · '),
      lat: pt?.lat ?? null, lon: pt?.lon ?? null, via: pt?.via ?? null, acres: pt?.acres ?? prev?.acres ?? null,
      about: pt?.about ?? prev?.about ?? null,
      report: rep?.text ?? null, reportDate: rep?.date ?? null, reportUrl: rep?.url ?? null,
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
  for (const p of old) byKey.set(key(p), p);
  let fresh = 0;
  for (const r of rows) {
    const stockId = slug(r.raw);
    // The schedule can change before the week comes; tonight's numbers replace last night's for that week.
    for (const [k] of SIZES) byKey.delete(key({ stockId, week: r.week, species: SIZES.find(s => s[0] === k)[1] }));
    for (const [k, species] of SIZES) {
      if (!r[k]) continue;
      const p = { week: r.week, weekEnd: r.weekEnd, stockId, water: waterName(r.raw), counties: [r.zone && `${r.zone} Zone`, r.office].filter(Boolean).join(' · '), species, count: r[k], inches: null };
      if (!old.some(o => key(o) === key(p))) fresh++;
      byKey.set(key(p), p);
    }
  }
  report.plants = { total: byKey.size, new: fresh, kept: old.length };
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
  // One series per location: a daily average if there is one, else hourly.
  const byLoc = new Map();
  const score = id => (/Ave\.1Day/.test(id) ? 0 : /Inst\.1Hour/.test(id) ? 1 : /Inst\.15Minutes/.test(id) ? 2 : 5) + (/CBT-REV|Best|REV/.test(id) ? 0 : 0.5);
  for (const id of ids) {
    const loc = id.split('.')[0];
    if (!byLoc.has(loc) || score(id) < score(byLoc.get(loc))) byLoc.set(loc, id);
  }
  const out = [];
  const begin = new Date(Date.now() - 60 * 864e5).toISOString(), end = new Date().toISOString();
  log.locations = [];
  for (const [loc, tsid] of byLoc) {
    try {
      const l = await getJson(`${CDA}/locations/${encodeURIComponent(loc)}?office=NWDP`, { headers: CDA_HEADERS });
      const lat = l.latitude, lon = l.longitude;
      if (!Number.isFinite(lat) || !inOregon(lat, lon)) { log.locations.push(`${loc}: outside (${lat}, ${lon})`); continue; }
      const ts = await getJson(`${CDA}/timeseries?name=${encodeURIComponent(tsid)}&office=NWDP&begin=${begin}&end=${end}&page-size=20000`, { headers: CDA_HEADERS });
      const days = new Map();
      for (const [t, v] of ts.values ?? []) if (Number.isFinite(v)) days.set(new Date(t).toISOString().slice(0, 10), v);
      const elevation = [...days].sort((a, b) => a[0].localeCompare(b[0])).map(([d, v]) => [d, +v.toFixed(2)]);
      log.locations.push(`${loc} ${l['public-name'] ?? ''}: ${tsid} ${elevation.length} days ${ts.units ?? ''}`);
      if (!elevation.length || !/ft/i.test(ts.units ?? 'ft')) continue;
      out.push({ id: loc, name: l['public-name'] || l['long-name'] || loc, lat: round(lat), lon: round(lon), source: 'USACE', elevation, storage: [] });
    } catch (e) { log.locations.push(`${loc}: ${e.message}`); }
  }
  return out;
}

// Reclamation's Pacific Northwest Hydromet: forebay elevation (fb) and active storage (af) of its Oregon reservoirs.
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
  for (const [id, name, lat, lon] of HYDROMET) {
    const params = `parameter=${id}%20fb,${id}%20af&syer=${s.getUTCFullYear()}&smnth=${s.getUTCMonth() + 1}&sdy=${s.getUTCDate()}&eyer=${e.getUTCFullYear()}&emnth=${e.getUTCMonth() + 1}&edy=${e.getUTCDate()}&format=2`;
    try {
      const csv = await getText(`https://www.usbr.gov/pn-bin/daily.pl?${params}`, { headers: BROWSER, tries: 2 });
      const rows = csv.replace(/\r/g, '').split('\n').map(l => l.split(',').map(c => c.trim())).filter(c => /^\d{4}-\d{2}-\d{2}|^\d{1,2}\/\d{1,2}\/\d{4}/.test(c[0]));
      const day = d => /\//.test(d) ? isoDate(d) : d.slice(0, 10);
      const elevation = rows.filter(r => Number.isFinite(parseFloat(r[1]))).map(r => [day(r[0]), +parseFloat(r[1]).toFixed(2)]);
      const storage = rows.filter(r => Number.isFinite(parseFloat(r[2]))).map(r => [day(r[0]), Math.round(parseFloat(r[2]))]);
      log[id] = `${elevation.length} elev, ${storage.length} storage${rows.length ? '' : `; ${csv.slice(0, 160).replace(/\s+/g, ' ')}`}`;
      if (elevation.length || storage.length) out.push({ id, name, lat, lon, source: 'USBR', elevation, storage });
    } catch (err) { log[id] = err.message; }
  }
  return out;
}

// ---------- Toxic algae ----------
// OHA's advisory table: a status icon (red advisory, yellow precaution, blue lifted), the water, county, dates.
async function habAdvisories(waters) {
  const page = 'https://www.oregon.gov/oha/ph/healthyenvironments/recreation/harmfulalgaeblooms/pages/blue-greenalgaeadvisories.aspx';
  const html = await getText(page);
  const lakes = (await readOld('lakes.json'))?.lakes ?? [];
  const rows = tableRows(html);
  const log = report.hab = { rows: rows.length, sample: rows.slice(0, 8).map(r => r.map(c => `${c.text}${/<img/i.test(c.html) ? ` [img ${c.html.match(/(?:alt|src)="([^"]+)"/i)?.[1] ?? ''}]` : ''}`)) };
  let header = null;
  const advisories = [];
  for (const cells of rows) {
    const texts = cells.map(c => c.text);
    if (!header && texts.some(t => /water\s*body|waterbody|location/i.test(t)) && texts.some(t => /county|date|issued/i.test(t))) { header = texts.map(t => t.toLowerCase()); continue; }
    const all = cells.map(c => `${c.text} ${c.html.match(/(?:alt|src|title)="([^"]+)"/gi)?.join(' ') ?? ''}`).join(' ');
    const status = /lifted|blue/i.test(all) ? 'lifted' : /precaution|yellow/i.test(all) ? 'caution' : /advisory|red/i.test(all) ? 'warning' : null;
    if (!status || status === 'lifted') continue;
    const col = re => header?.findIndex(h => re.test(h)) ?? -1;
    const pick = (re, fallback) => { const i = col(re); return i >= 0 ? texts[i] : fallback; };
    const name = pick(/water|location/, texts.find(t => t && WATERISH.test(t)) ?? '');
    if (!name) continue;
    const county = pick(/county/, '');
    const date = isoDate(pick(/issued|date/, texts.find(t => isoDate(t)) ?? '')) ?? null;
    const key = norm(name.split(/[(,]/)[0]);
    const spot = waters.find(w => w.lat != null && norm(w.name) === key) ?? lakes.filter(l => norm(l.name) === key).sort((a, b) => b.acres - a.acres)[0];
    advisories.push({ name, county, level: status, advisory: status === 'warning' ? 'Recreational use health advisory' : 'Precaution', date, detail: texts.filter(t => t && t !== name && t !== county).join(' · ').slice(0, 400), lat: spot?.lat ?? null, lon: spot?.lon ?? null });
  }
  // The permanent advisories are written as headings, not table rows.
  for (const m of html.matchAll(/<(h[2-5]|strong)\b[^>]*>([^<]*Permanent[^<]*Advisory[^<]*)<\/\1>([\s\S]{0,1500}?)(?=<h[2-5]|<table)/gi)) {
    const title = clean(m[2]);
    const what = title.replace(/^.*?Advisory:\s*/i, '');
    for (const n of what.split(/\s+and\s+|,\s*/).map(s => s.replace(/^(the\s+)?mainstem\s+/i, '').trim()).filter(Boolean)) {
      const key = norm(n);
      const spot = lakes.find(l => norm(l.name) === key);
      advisories.push({ name: n.replace(/^\w/, c => c.toUpperCase()), county: title.match(/^(\w+) County/)?.[1] ?? '', level: 'warning', permanent: true, advisory: 'Permanent recreational use advisory', date: null, detail: clean(m[3]).slice(0, 400), lat: spot?.lat ?? null, lon: spot?.lon ?? null });
    }
  }
  log.advisories = advisories.map(a => `${a.name} (${a.county}): ${a.level} ${a.date ?? ''} ${a.lat != null ? 'located' : 'NO POINT'}`);
  return { updatedAt: new Date().toISOString(), source: page, portal: page, advisories };
}

// ---------- Run ----------
await mkdir(OUT, { recursive: true });
let rows = [], reports = [], waters = null;
try { rows = await scheduleFetch(); } catch (e) { report.scheduleError = e.message; console.error('schedule:', e.message); }
try { reports = await recreationReport(); } catch (e) { report.recreationError = e.message; console.error('recreation:', e.message); }
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
if (reservoirs.length) {
  await save('reservoirs.json', { updatedAt: new Date().toISOString(), source: 'USGS Water Services, US Army Corps of Engineers (CWMS) and Reclamation Hydromet', units: { elevation: 'ft', storage: 'acre-ft' }, reservoirs });
}
report.reservoirs = reservoirs.map(r => `${r.source} ${r.id} ${r.name}: ${r.elevation.at(-1)?.join(' ') ?? '-'} / ${r.storage.at(-1)?.join(' ') ?? '-'}`);

try { await save('hab.json', await habAdvisories(waters ?? (await readOld('waters.json'))?.waters ?? [])); } catch (e) { report.habError = e.message; console.error('hab:', e.message); }

report.finishedAt = new Date().toISOString();
await writeFile(new URL('update-report.json', OUT), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2).slice(0, 12000));
