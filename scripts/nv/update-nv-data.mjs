// Nightly Nevada data for the app, run by .github/workflows/nevada-daily.yml:
//
//   data/nv/waters.json      every water NDOW publishes a page for (551 or so): region, type, latest fishing report,
//                            NDOW's write-up, and a map point (USGS NHD / NDOW fishable waters / OpenStreetMap)
//   data/nv/plants.json      every stocking on those pages (date, species, number, average length), merged with
//                            earlier runs so history keeps growing when NDOW trims its tables
//   data/nv/reservoirs.json  daily lake levels and storage: USGS lake gauges, plus Reclamation (RISE) for Mead and Mohave
//   data/nv/hab.json         active toxic algae (HAB) advisories from the Nevada Office of State Epidemiology
//
// Only public data; nothing from anyone's phone is involved. Every source is optional: a failure keeps last run's file.

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { inOutline, STATES } from '../states.mjs';

const OUT = new URL('../../data/nv/', import.meta.url);
const NV = STATES.nv;
// NDOW's site sits behind a firewall that turns away unknown clients, so its calls go out looking like a browser.
const BROWSER = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', Accept: 'application/json,text/html,*/*' };
const UA = { 'User-Agent': 'TackleBox-fishing-app (personal, github.com/mikegutberlet/FishingApp)', Accept: 'application/json' };
const NDOW = 'https://www.ndow.org/wp-json/wp/v2';
const FISHABLE = 'https://services.arcgis.com/RyxlXSfFi87rAosq/ArcGIS/rest/services/NDOWFishableWaters/FeatureServer';
const report = { startedAt: new Date().toISOString() };

async function get(url, { headers = UA, tries = 3 } = {}) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { headers });
      if (!r.ok) throw new Error(`${r.status} ${url.slice(0, 200)}`);
      return r;
    } catch (e) {
      if (i >= tries) throw e;
      await new Promise(res => setTimeout(res, 3000 * i));
    }
  }
}
const getJson = async (url, opts) => (await get(url, opts)).json();
const readOld = async name => { try { return JSON.parse(await readFile(new URL(name, OUT), 'utf8')); } catch { return null; } };
const save = (name, data) => writeFile(new URL(name, OUT), JSON.stringify(data) + '\n');

const ENTITIES = { amp: '&', nbsp: ' ', quot: '"', apos: "'", lt: '<', gt: '>', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', hellip: '…' };
const decode = s => String(s ?? '').replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENTITIES[e.toLowerCase()] ?? m);
// HTML to plain text, one line per paragraph.
const text = html => decode(String(html ?? '').replace(/<\/(p|li|h\d|div)>|<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).split('\n').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
const links = html => [...String(html ?? '').matchAll(/<a[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/gi)].map(m => ({ url: decode(m[1]), label: text(m[2]) }));
const ymd = s => /^\d{8}$/.test(s ?? '') ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}` : null;
const norm = s => decode(s).toLowerCase().replace(/\(.*?\)/g, '').replace(/\b(lake|lakes|reservoir|res|river|creek|pond|ponds|the|of|nwr|wma|park|community)\b|[^a-z0-9]/g, '');
const round = n => +n.toFixed(5);
const km = (a, b) => {
  const r = d => d * Math.PI / 180;
  const h = Math.sin(r(b[0] - a[0]) / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(r(b[1] - a[1]) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};


// ---------- NDOW waters ----------
async function ndowWaters() {
  const terms = async tax => new Map((await getJson(`${NDOW}/${tax}?per_page=100`, { headers: BROWSER })).map(t => [t.id, decode(t.name)]));
  const [regions, types] = await Promise.all([terms('location'), terms('waters_type')]);
  const rows = [];
  for (let page = 1; page < 30; page++) {
    const r = await fetch(`${NDOW}/waters?per_page=100&page=${page}&_fields=id,slug,title,link,modified,location,waters_type,acf`, { headers: BROWSER });
    if (r.status === 400) break; // past the last page
    if (!r.ok) throw new Error(`${r.status} NDOW waters page ${page}`);
    const batch = await r.json();
    rows.push(...batch);
    if (batch.length < 100) break;
  }
  report.ndow = { waters: rows.length };
  return rows.map(w => {
    const acf = w.acf || {};
    const reportLinks = [...links(acf.fishing_report), ...links(acf.pertinent_information), ...links(acf.history)];
    const fishNv = reportLinks.map(l => l.url.match(/fish\.wildlifenv\.com\/waters\/(\d+)/)?.[1]).find(Boolean) ?? null;
    return {
      id: w.slug,
      name: decode(w.title?.rendered).replace(/\s+/g, ' ').trim(),
      ndowType: types.get(w.waters_type?.[0]) ?? null,
      region: regions.get(w.location?.[0]) ?? null,
      url: w.link,
      modified: w.modified,
      report: text(acf.fishing_report).slice(0, 2500) || null,
      reportDate: ymd(acf.fishing_report_date),
      info: text(acf.pertinent_information).slice(0, 2500) || null,
      history: text(acf.history).replace(/\n?To View Map.*$/i, '').slice(0, 1500) || null,
      guides: reportLinks.filter(l => /\.pdf$/i.test(l.url)).slice(0, 4),
      fishNv,
      stocking: Array.isArray(acf.stocking_updates) ? acf.stocking_updates : [],
    };
  });
}

const TYPE = { 'Lake or Reservoir': 'Lake', 'Creek or Stream': 'Stream', River: 'River', 'Community Pond': 'Pond' };
const isFlowing = w => /Creek|River/.test(w.ndowType ?? '') || (/\b(creek|river|fork|canal|ditch|slough)\b/i.test(w.name) && !/\b(pond|ponds|reservoir|lake)\b/i.test(w.name));

// ---------- Map points ----------
// NDOW pages carry no coordinates, so each water is found by name: in the USGS NHD statewide list (weekly job),
// then NDOW's own fishable-waters map layer, then OpenStreetMap's geocoder for whatever is left. Names like
// "Carson River – Douglas" or "Willow Creek- Santa Rosa Range" pick the stretch in that county or near that range.

// NDOW's three regions by county, used to choose between same-named waters (Nevada has dozens of Willow Creeks).
const REGION = {
  Western: ['Washoe', 'Carson City', 'Douglas', 'Lyon', 'Storey', 'Churchill', 'Pershing', 'Humboldt', 'Mineral'],
  Eastern: ['Elko', 'Eureka', 'Lander', 'White Pine'],
  Southern: ['Clark', 'Nye', 'Lincoln', 'Esmeralda'],
};
const regionOfCounty = c => Object.keys(REGION).find(r => REGION[r].includes(c)) ?? null;
let COUNTIES = [];
async function loadCounties() {
  const params = new URLSearchParams({ where: "STATE='32'", outFields: 'BASENAME', outSR: '4326', maxAllowableOffset: '0.004', f: 'geojson' });
  const json = await getJson(`https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1/query?${params}`);
  COUNTIES = json.features.map(f => ({ name: f.properties.BASENAME, polys: f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates }));
  report.counties = COUNTIES.length;
  // The app uses these to tell which county (and so which regulations) a water is in.
  const r4 = n => +n.toFixed(4);
  await save('counties.json', { updatedAt: new Date().toISOString(), source: 'US Census TIGERweb', counties: COUNTIES.map(c => {
    const pts = c.polys.flat(2);
    return { name: c.name, region: regionOfCounty(c.name), bbox: [Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1])), Math.max(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1]))].map(r4),
      polys: c.polys.map(poly => poly.map(ring => ring.map(([x, y]) => [r4(x), r4(y)]))) };
  }) });
}
const countyIn = (lat, lon) => COUNTIES.find(c => c.polys.some(([outer]) => inOutline([lon, lat], outer)))?.name ?? null;
// A water on the state line (Lake Mohave) can sit just outside the outlines: try points ~4 km around it (as the app does).
const countyAt = (lat, lon) => [[0, 0], [0, 0.04], [0, -0.04], [0.04, 0], [-0.04, 0]].map(([a, b]) => countyIn(lat + a, lon + b)).find(Boolean) ?? null;
// Fallback when the county outlines can't be fetched.
const regionAt = (lat, lon) => { const c = countyAt(lat, lon); return c ? regionOfCounty(c) : lat < 38.0 ? 'Southern' : lon > -117.2 ? 'Eastern' : 'Western'; };

async function fishableWaters() {
  const out = [];
  for (const [layer, kind] of [[1, 'lake'], [0, 'stream']]) {
    for (let offset = 0; ; offset += 1000) {
      const params = new URLSearchParams({ where: '1=1', outFields: 'NAME,MAP_LABEL,COUNTY_NAM', outSR: '4326', maxAllowableOffset: '0.001', resultOffset: offset, resultRecordCount: 1000, f: 'geojson' });
      const json = await getJson(`${FISHABLE}/${layer}/query?${params}`);
      // ArcGIS answers errors with a 200 and an error body.
      if (json.error || !Array.isArray(json.features)) throw new Error(`fishable waters layer ${layer}: ${json.error?.message ?? 'no features'}`);
      for (const f of json.features) {
        const g = f.geometry;
        if (!g) continue;
        const pts = g.type === 'Polygon' ? g.coordinates[0] : g.type === 'MultiPolygon' ? g.coordinates.sort((a, b) => b[0].length - a[0].length)[0][0]
          : g.type === 'LineString' ? g.coordinates : g.coordinates.flat();
        if (!pts?.length) continue;
        // Lakes: the vertex nearest the ring's average point. Streams: points spaced along the line, so a
        // county-named stretch can find one inside its county.
        const names = [...new Set([f.properties.NAME, f.properties.MAP_LABEL].filter(Boolean))];
        if (kind === 'lake') {
          const cx = pts.reduce((s, q) => s + q[0], 0) / pts.length, cy = pts.reduce((s, q) => s + q[1], 0) / pts.length;
          const p = pts.reduce((best, q) => (q[0] - cx) ** 2 + (q[1] - cy) ** 2 < (best[0] - cx) ** 2 + (best[1] - cy) ** 2 ? q : best);
          for (const n of names) out.push({ name: n, kind, lat: round(p[1]), lon: round(p[0]) });
        } else {
          const step = Math.max(1, Math.floor(pts.length / 6));
          for (let i = Math.floor(step / 2); i < pts.length; i += step) for (const n of names) out.push({ name: n, kind, lat: round(pts[i][1]), lon: round(pts[i][0]), line: f.id ?? names[0] });
        }
      }
      if ((json.features ?? []).length < 1000) break;
    }
  }
  return out;
}

async function nhdWaters() {
  const [l, r] = await Promise.all([readOld('lakes.json'), readOld('rivers.json')]);
  const out = [];
  for (const x of l?.lakes ?? []) out.push({ name: x.name, kind: 'lake', lat: x.lat, lon: x.lon, acres: x.acres });
  for (const x of r?.rivers ?? []) for (const [lat, lon] of x.points) out.push({ name: x.name, kind: 'stream', lat, lon, km: x.km, line: x.id });
  return out;
}

// OpenStreetMap Nominatim, at most one request a second as its policy asks. Answers are kept between runs
// (geocode-cache.json), so after the first night it is only asked about new waters.
let GEO = {}, geoCalls = 0;
async function geocode(q, { water = false } = {}) {
  if (q in GEO) return GEO[q];
  if (geoCalls >= 200) return null;
  geoCalls++;
  const params = new URLSearchParams({ q: `${q}, Nevada`, format: 'json', limit: '5', countrycodes: 'us', viewbox: `${NV.bbox.xmin},${NV.bbox.ymax},${NV.bbox.xmax},${NV.bbox.ymin}`, bounded: '1' });
  await new Promise(res => setTimeout(res, 1100));
  let hits = [];
  try { hits = await getJson(`https://nominatim.openstreetmap.org/search?${params}`); } catch (e) { report.geocodeError = e.message; return null; }
  const good = hits.filter(h => inOutline([+h.lon, +h.lat], NV.outline) && (!water || /water|natural|leisure|waterway|reservoir|park|landuse/i.test(`${h.class} ${h.type}`)));
  GEO[q] = good.map(h => ({ lat: round(+h.lat), lon: round(+h.lon), type: `${h.class}/${h.type}` }));
  return GEO[q];
}

const DIRS = { N: 'North', S: 'South', E: 'East', W: 'West', NF: 'North Fork', SF: 'South Fork', EF: 'East Fork', WF: 'West Fork', MF: 'Middle Fork' };
// "Walker River, West Fork" → base names to look up (["Walker River, West Fork", "West Fork Walker River", "West Walker River"])
// plus a place qualifier from " – Douglas", "- Santa Rosa Range", "/ Willow Beach" or " at Kirch WMA".
function parseName(name) {
  let n = name.replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
  let where = null;
  const dash = n.match(/^(.+?)(?:\s+[–—-]\s*|\s*[–—]\s+|-\s+)(.+)$/);
  if (dash) { n = dash[1]; where = dash[2]; }
  const at = n.match(/^(.+?)\s+at\s+(.+)$/i);
  if (at) { n = at[1]; where ??= at[2]; }
  const names = new Set();
  const add = s => s && names.add(s.replace(/\s+/g, ' ').trim());
  // "Floyd Lamb Park/ Tule Springs Ponds", "Squaw Valley/ Creek Reservoir": try each half, and the first with the last word.
  const alts = n.split(/\s*\/\s*/).filter(Boolean);
  if (alts.length > 1) { n = alts[0]; add(`${alts[0]} ${alts.at(-1).split(' ').pop()}`); alts.slice(1).forEach(add); }
  // "Humboldt River, Elko": a county after the comma is a place, not part of the name.
  const tail = n.match(/^(.+),\s*([^,]+)$/);
  if (tail && Object.values(REGION).flat().includes(tail[2])) { n = tail[1]; where ??= tail[2]; }
  const noParen = n.replace(/\s*\(.*?\)\s*/g, ' ').trim();
  add(n); add(noParen);
  const inner = n.match(/\((.*?)\)/)?.[1];
  if (inner && !/^\d/.test(inner)) add(n.replace(/\(.*?\)/, '').replace(/^\S+\s+/, `${inner} `)); // "Bowman (Clear) Creek" → "Clear Creek"
  const parts = noParen.split(/\s*,\s*/);
  if (parts.length > 1) {
    const base = parts[0], quals = parts.slice(1).filter(q => !/^(upper|lower)$/i.test(q)).map(q => DIRS[q.toUpperCase()] ?? q);
    add([...quals.reverse(), base].join(' '));
    add([...quals.map(q => q.replace(/\s+Fork$/i, '')), base].join(' '));
    if (quals.length !== parts.length - 1 && !quals.length) add(base);
  }
  add(noParen.replace(/\s*#\s*\d+$/, ''));
  return { names: [...names], where };
}

// OpenStreetMap has few mountain ranges as places, so a range it can't place has its waters looked for in its
// counties: "Thomas Creek- Carson Range" is the Thomas Creek in Washoe, Carson City or Douglas County.
const RANGES = {
  'Carson Range': ['Washoe', 'Carson City', 'Douglas'], 'Santa Rosa Range': ['Humboldt'], 'Jackson Range': ['Humboldt'],
  'Desatoya Range': ['Churchill', 'Lander'], 'Sonoma Range': ['Humboldt', 'Pershing'], 'Toiyabe Range': ['Lander', 'Nye'],
  'Quinn Canyon Range': ['Nye'], 'Monitor Range': ['Nye', 'Eureka'], 'Jarbidge Mountains': ['Elko'], 'Battle Mountain Range': ['Lander'],
  'Eagan Range': ['White Pine', 'Lincoln', 'Nye'], 'Ruby Mountains': ['Elko'],
};
async function pickPoint(w, sources) {
  const { names, where } = parseName(w.name);
  const keys = new Set(names.map(norm).filter(k => k.length >= 3));
  if (!keys.size) return null;
  const flowing = isFlowing(w), pond = /\bponds?\b/i.test(w.name);
  const county = where && COUNTIES.find(c => c.name.toLowerCase() === where.toLowerCase())?.name;
  const range = where && !county ? RANGES[Object.keys(RANGES).find(r => r.toLowerCase() === where.toLowerCase())] : null;
  let near = where && !county ? (await geocode(where))?.[0] : null;
  // A range's point must be in its counties (OpenStreetMap's "Sonoma Range" is a street in Las Vegas).
  if (near && range && !range.includes(countyAt(near.lat, near.lon))) near = null;
  const lines = list => new Set(list.map(c => c.line ?? `${c.lat},${c.lon}`)).size;
  // A place the name gives that OpenStreetMap answered it doesn't have can't choose between the state's same-named
  // waters: with more than one in the NHD list, better no point than the Thomas Creek by Winnemucca (which NDOW's own
  // map layer also has). A failed request is asked again tomorrow.
  if (where && !county && !range && !near && Array.isArray(GEO[where])) {
    const [, list] = sources.find(([via]) => via === 'nhd') ?? [];
    if (lines((list ?? []).filter(c => keys.has(norm(c.name)) && (c.kind === 'stream') === flowing)) > 1) return null;
  }
  for (const [via, list] of sources) {
    // A pond isn't the big lake or reservoir of the same name ("Verdi Pond" vs Verdi Lake).
    let same = list.filter(c => keys.has(norm(c.name)) && (c.kind === 'stream') === flowing && inOutline([c.lon, c.lat], NV.outline) && !(pond && c.acres > 200));
    if (!same.length) continue;
    if (county) same = same.filter(c => countyAt(c.lat, c.lon) === county);
    else if (near) {
      same = same.map(c => ({ ...c, d: km([c.lat, c.lon], [near.lat, near.lon]) })).filter(c => c.d <= 40).sort((a, b) => a.d - b.d);
      // A named spot on a big lake ("Lake Tahoe – Sand Harbor"): use the spot itself.
      if (same[0]?.kind === 'lake' && same[0].acres > 2000 && same[0].d <= 15) return { lat: near.lat, lon: near.lon, via: `${via}+osm` };
    } else if (range) {
      same = same.filter(c => range.includes(countyAt(c.lat, c.lon)));
      // Two of that name in the range's counties: no telling which (NDOW's own layer is asked next).
      if (lines(same) > 1) same = [];
    } else if (w.region && REGION[w.region]) {
      const inRegion = same.filter(c => regionAt(c.lat, c.lon) === w.region);
      // None in the right region: better no point than the wrong water (OpenStreetMap is asked next).
      same = inRegion;
    }
    if (!same.length) continue;
    // A stream's middle label point; otherwise the biggest lake.
    const best = flowing && !near ? same[Math.floor(same.length / 2)] : same.sort((a, b) => (a.d ?? 0) - (b.d ?? 0) || (b.acres ?? 0) - (a.acres ?? 0))[0];
    return { lat: best.lat, lon: best.lon, via, ...(best.acres && { acres: best.acres }) };
  }
  // Nothing by name: ask OpenStreetMap for the water itself.
  for (const q of names.slice(0, 2)) {
    const hits = (await geocode(q, { water: true })) ?? [];
    const hit = (county ? hits.filter(h => countyAt(h.lat, h.lon) === county) : near ? hits.filter(h => km([h.lat, h.lon], [near.lat, near.lon]) <= 40) : range ? hits.filter(h => range.includes(countyAt(h.lat, h.lon))) : hits.filter(h => !w.region || !REGION[w.region] || regionAt(h.lat, h.lon) === w.region))[0];
    if (hit) return { lat: hit.lat, lon: hit.lon, via: 'osm' };
  }
  return null;
}

async function buildWaters(raw) {
  const nhd = await nhdWaters();
  let fishable = [];
  try { fishable = await fishableWaters(); } catch (e) { report.fishableError = e.message; }
  try { await loadCounties(); } catch (e) { report.countiesError = e.message; }
  GEO = (await readOld('geocode-cache.json')) ?? {};
  report.points = { nhd: nhd.length, fishable: fishable.length, via: {} };
  const unmatched = [];
  const waters = [];
  for (const w of raw) {
    const pt = await pickPoint(w, [['nhd', nhd], ['ndow', fishable]]);
    if (!pt) unmatched.push(`${w.name} (${w.region}, ${w.ndowType})`);
    report.points.via[pt?.via ?? 'none'] = (report.points.via[pt?.via ?? 'none'] ?? 0) + 1;
    const plants = w.stocking.map(s => ymd(s.date_stocked)).filter(Boolean).sort();
    waters.push({
      id: w.id, name: w.name, type: TYPE[w.ndowType] ?? null, region: w.region, counties: `${w.region ?? 'Nevada'} region`,
      county: pt ? countyAt(pt.lat, pt.lon) : null, lat: pt?.lat ?? null, lon: pt?.lon ?? null, via: pt?.via ?? null, acres: pt?.acres ?? null, url: w.url,
      report: w.report, reportDate: w.reportDate, info: w.info, history: w.history, guides: w.guides, fishNv: w.fishNv,
      lastYearStocked: plants.length ? +plants.at(-1).slice(0, 4) : null,
    });
  }
  // The NDOW layer or county outlines failed: keep last run's point for any water that has none now.
  if (report.fishableError || report.countiesError) {
    const old = new Map(((await readOld('waters.json'))?.waters ?? []).map(w => [w.id, w]));
    let kept = 0;
    for (const w of waters) {
      const o = old.get(w.id);
      if (w.lat == null && o?.lat != null) { Object.assign(w, { lat: o.lat, lon: o.lon, via: o.via, county: o.county, acres: o.acres }); kept++; }
      else if (w.county == null && o?.county) w.county = o.county;
    }
    report.points.keptFromLastRun = kept;
  }
  report.points.unmatched = unmatched;
  report.points.geocoderCalls = geoCalls;
  await save('geocode-cache.json', GEO);
  return waters.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- Stocking ----------
async function buildPlants(raw) {
  const old = (await readOld('plants.json'))?.plants ?? [];
  const byKey = new Map();
  const key = p => `${p.stockId}|${p.week}|${p.species.toLowerCase()}|${p.count ?? ''}|${p.inches ?? ''}`;
  for (const p of old) byKey.set(key(p), p);
  let fresh = 0;
  for (const w of raw) {
    for (const s of w.stocking) {
      const date = ymd(String(s.date_stocked ?? '').trim());
      const species = String(s.species ?? '').replace(/\s+/g, ' ').trim();
      if (!date || !species) continue;
      const count = parseInt(String(s.stocked ?? '').replace(/[^\d]/g, ''), 10);
      const inches = parseFloat(s.inches);
      const p = { week: date, weekEnd: date, stockId: w.id, water: w.name, counties: `${w.region ?? 'Nevada'} region`, species,
        count: Number.isFinite(count) ? count : null, inches: Number.isFinite(inches) ? inches : null };
      if (!byKey.has(key(p))) fresh++;
      byKey.set(key(p), p);
    }
  }
  report.plants = { total: byKey.size, new: fresh, kept: old.length };
  return [...byKey.values()].sort((a, b) => b.week.localeCompare(a.week) || a.water.localeCompare(b.water));
}

// ---------- Lake levels ----------
const titleCase = s => s.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase()).replace(/\bNr\b/g, 'near').replace(/\bRes\b/g, 'Reservoir').replace(/, (Nv|Ca)$/, m => m.toUpperCase());

const EXTRA_USGS_SITES = ['10337000'];
async function usgsLevels() {
  const PARAMS = '62614,62615,00062,00054';
  const siteList = async query => {
    const rdb = await (await get(`https://waterservices.usgs.gov/nwis/site/?format=rdb&${query}&parameterCd=${PARAMS}&siteStatus=active&hasDataTypeCd=dv`)).text();
    const lines = rdb.split('\n').filter(l => l && !l.startsWith('#'));
    const head = lines[0]?.split('\t') ?? [];
    return lines.slice(2).map(l => Object.fromEntries(l.split('\t').map((v, i) => [head[i], v.trim()])));
  };
  // Lake Tahoe's gauge is at Tahoe City, California, but the lake's Nevada shore needs it too.
  const sites = [...await siteList('stateCd=nv&siteType=LK'), ...await siteList(`sites=${EXTRA_USGS_SITES.join(',')}`).catch(() => [])];
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
    // Daily mean (00003) beats a midnight reading (32400); NAVD/NGVD elevations beat height above a local datum.
    const rank = (param === '00062' ? 2 : 0) + (stat === '00003' ? 0 : 1);
    if (param === '00054') { if (!r.storage.length || stat === '00003') r.storage = vals; continue; }
    if (rank >= r._rank) continue;
    r._rank = rank;
    // Some gauges report height above the gauge datum (Topaz: ~80 ft); add the datum's elevation so it reads as lake elevation.
    const offset = param === '00062' && vals.at(-1)[1] < 1000 && r.datumFt ? r.datumFt : 0;
    r.elevation = vals.map(([d, v]) => [d, +(v + offset).toFixed(2)]);
  }
  return [...out.values()].filter(r => r.elevation.length || r.storage.length).map(({ _rank, datumFt, ...r }) => r);
}

// Reclamation's RISE API: Lake Mead (Hoover Dam) and Lake Mohave (Davis Dam) daily elevation and storage.
const RISE = 'https://data.usbr.gov';
const RISE_HEADERS = { ...UA, Accept: 'application/vnd.api+json' };
// RISE places each gauge at its dam; the app matches gauges to waters by distance, so store a point on the lake.
const RISE_LAKES = [{ location: 3514, id: 'MEAD', name: 'Lake Mead', lat: 36.16237, lon: -114.39388 }, { location: 3513, id: 'MOHAVE', name: 'Lake Mohave', lat: 35.47811, lon: -114.65932 }];
async function riseLevels() {
  const out = [];
  report.rise = {};
  const since = new Date(Date.now() - 62 * 864e5).toISOString().slice(0, 10);
  for (const lake of RISE_LAKES) {
    const log = report.rise[lake.name] = { items: [] };
    try {
      const loc = (await getJson(`${RISE}/rise/api/location/${lake.location}`, { headers: RISE_HEADERS })).data;
      const [lon, lat] = loc.attributes.locationCoordinates.coordinates;
      const items = [];
      for (const rec of loc.relationships?.catalogRecords?.data ?? []) {
        const r = await getJson(`${RISE}${rec.id}`, { headers: RISE_HEADERS });
        for (const it of r.data?.relationships?.catalogItems?.data ?? []) items.push(it.id);
      }
      const picked = {};
      for (const id of items) {
        const it = (await getJson(`${RISE}${id}`, { headers: RISE_HEADERS })).data?.attributes ?? {};
        log.items.push(`${id} ${it.itemTitle}`);
        const t = it.itemTitle ?? '';
        if (!/daily/i.test(t) || /model|forecast|projected|24-month|mtom/i.test(t)) continue;
        if (/elevation/i.test(t) && /lake|reservoir/i.test(t) && !/tailwater|release/i.test(t)) picked.elevation ??= it._id;
        if (/storage/i.test(t) && !/change/i.test(t)) picked.storage ??= it._id;
      }
      log.picked = picked;
      const series = async itemId => {
        if (!itemId) return [];
        const res = await getJson(`${RISE}/rise/api/result?itemId=${itemId}&dateTime%5Bafter%5D=${since}&order%5BdateTime%5D=ASC&itemsPerPage=100`, { headers: RISE_HEADERS });
        return (res.data ?? []).map(x => [x.attributes.dateTime.slice(0, 10), +x.attributes.result]).filter(([, v]) => Number.isFinite(v));
      };
      const elevation = await series(picked.elevation), storage = await series(picked.storage);
      log.points = { elevation: elevation.length, storage: storage.length };
      if (elevation.length || storage.length) out.push({ id: lake.id, name: lake.name, lat: round(lake.lat ?? lat), lon: round(lake.lon ?? lon), source: 'USBR', elevation, storage });
    } catch (e) { log.error = e.message; }
  }
  return out;
}

// ---------- Toxic algae ----------
const HAB_LEVEL = { watch: 'caution', warning: 'warning', danger: 'danger' };
async function habAdvisories(waters) {
  // The town check needs county outlines even on a night the waters build didn't load them.
  if (!COUNTIES.length) COUNTIES = (await readOld('counties.json'))?.counties ?? [];
  const url = 'https://nvose.org/hot-topic-harmful-algal-blooms/';
  const html = await (await get(url, { headers: BROWSER })).text();
  // The page has accordions per year: "Active HAB Reports" first, then inactive and past years.
  const start = html.search(/Active HAB Reports/i);
  if (start < 0) throw new Error('No "Active HAB Reports" section');
  const rest = html.slice(start);
  const end = rest.slice(20).search(/accordions__title/);
  const section = end > 0 ? rest.slice(0, end + 20) : rest;
  const lakes = (await readOld('lakes.json'))?.lakes ?? [];
  const advisories = [];
  for (const m of section.matchAll(/<summary[^>]*>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g)) {
    const summary = text(m[1]);
    const name = summary.replace(/,\s*[^,]*,\s*NV$/i, '').trim();
    const body = text(m[2]);
    // "Mountain View Pond, Gardnerville, NV" or "... in Gardnerville, NV": the town tells same-named ponds apart.
    const town = summary.match(/,\s*([^,]+),\s*NV$/i)?.[1] ?? body.match(/\bin ([A-Z][\w .]+?), NV\b/)?.[1] ?? null;
    // The newest change comes first. "lowered from a HAB Warning to a HAB Watch" is a Watch: take the level after
    // "to", then "placed on / downgraded to", then the first level mentioned.
    const level = (body.match(/\bto an? HAB (Watch|Warning|Danger)/i) ?? body.match(/(?:upgraded|downgraded|lowered|raised|changed|placed on|returned)(?: to)? an? HAB (Watch|Warning|Danger)/i)
      ?? body.match(/\bHAB (Watch|Warning|Danger)/i))?.[1];
    if (!level) continue;
    const dm = body.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
    const date = dm ? `${dm[3].length === 2 ? '20' + dm[3] : dm[3]}-${dm[1].padStart(2, '0')}-${dm[2].padStart(2, '0')}` : null;
    const key = norm(name.split(/\s+(?:including|incl\.?)\s+|[(,]/i)[0]);
    let spot = waters.find(w => w.lat != null && norm(parseName(w.name).names.at(-1)) === key) ?? lakes.filter(l => norm(l.name) === key).sort((a, b) => b.acres - a.acres)[0];
    const townAt = town ? (await geocode(town))?.[0] : null;
    if (townAt && (!spot || countyAt(spot.lat, spot.lon) !== countyAt(townAt.lat, townAt.lon))) spot = townAt;
    advisories.push({ name, town, level: HAB_LEVEL[level.toLowerCase()], advisory: `HAB ${level[0].toUpperCase()}${level.slice(1).toLowerCase()}`, date, detail: body.length > 400 ? body.slice(0, body.lastIndexOf('.', 400) + 1 || 400) : body, landmark: '', lat: spot?.lat ?? null, lon: spot?.lon ?? null });
  }
  // Nothing parsed from a section that still talks about advisories: the markup changed. Keep last night's list.
  if (!advisories.length && /HAB|advisory/i.test(text(section).replace(/Active HAB Reports/i, '')) && !/no active/i.test(text(section))) throw new Error('Active HAB section not parsed');
  report.hab = advisories.map(a => `${a.name}: ${a.advisory} ${a.date} ${a.lat != null ? 'located' : 'NO POINT'}`);
  return { updatedAt: new Date().toISOString(), source: url, portal: url, advisories };
}

// ---------- Run ----------
await mkdir(OUT, { recursive: true });
let raw = null, waters = null;
try { raw = await ndowWaters(); } catch (e) { report.ndowError = e.message; console.error('ndow:', e.message); }
if (raw?.length) {
  try {
    waters = await buildWaters(raw);
    await save('waters.json', { updatedAt: new Date().toISOString(), source: 'NDOW water pages (ndow.org/waters); map points from USGS NHD, NDOW fishable waters and OpenStreetMap', waters });
  } catch (e) { report.watersError = e.message; console.error('waters:', e.stack); }
  try {
    const plants = await buildPlants(raw);
    await save('plants.json', { updatedAt: new Date().toISOString(), source: 'NDOW stocking updates on each water page', plants });
  } catch (e) { report.plantsError = e.message; console.error('plants:', e.stack); }
}

const reservoirs = [];
try { reservoirs.push(...await usgsLevels()); } catch (e) { report.usgsError = e.message; console.error('usgs:', e.message); }
try { reservoirs.push(...await riseLevels()); } catch (e) { report.riseError = e.message; console.error('rise:', e.message); }
// A source that was down keeps last run's stations (their last dated reading shows their age).
const oldRes = (await readOld('reservoirs.json'))?.reservoirs ?? [];
const kept = oldRes.filter(o => !reservoirs.some(r => r.id === o.id));
if (reservoirs.length) report.keptStations = kept.map(o => o.id);
reservoirs.push(...(reservoirs.length ? kept : []));
if (reservoirs.length) {
  await save('reservoirs.json', { updatedAt: new Date().toISOString(), source: 'USGS Water Services and Reclamation RISE', units: { elevation: 'ft', storage: 'acre-ft' }, reservoirs });
}
report.reservoirs = reservoirs.map(r => `${r.source} ${r.id} ${r.name}: ${r.elevation.at(-1)?.join(' ') ?? '-'} / ${r.storage.at(-1)?.join(' ') ?? '-'}`);

if (!Object.keys(GEO).length) GEO = (await readOld('geocode-cache.json')) ?? {};
try { await save('hab.json', await habAdvisories(waters ?? (await readOld('waters.json'))?.waters ?? [])); } catch (e) { report.habError = e.message; console.error('hab:', e.message); }
await save('geocode-cache.json', GEO);

report.finishedAt = new Date().toISOString();
if (report.ndowError || report.watersError || report.plantsError || report.habError || report.fishableError) process.exitCode = 1;
await writeFile(new URL('update-report.json', OUT), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2).slice(0, 6000));
