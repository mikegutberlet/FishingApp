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

// NDOW's three regions, roughly, to pick between same-named waters (there are many Mill Creeks).
const regionOf = ([lat, lon]) => lat < 38.0 ? 'Southern' : lon > -117.2 ? 'Eastern' : 'Western';

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
const isFlowing = w => /Creek|River/.test(w.ndowType ?? '') || /\b(creek|river|fork|canal|ditch|slough)\b/i.test(w.name);

// ---------- Map points ----------
// Candidates by name from three places, best first: last run (so points don't wander), USGS NHD (the weekly
// statewide list), NDOW's own fishable-waters layer, then OpenStreetMap's geocoder for whatever is left.
async function fishableWaters() {
  const out = [];
  for (const [layer, kind] of [[1, 'lake'], [0, 'stream']]) {
    for (let offset = 0; ; offset += 1000) {
      const params = new URLSearchParams({ where: '1=1', outFields: 'NAME,MAP_LABEL,COUNTY_NAM', outSR: '4326', maxAllowableOffset: '0.001', resultOffset: offset, resultRecordCount: 1000, f: 'geojson' });
      const json = await getJson(`${FISHABLE}/${layer}/query?${params}`);
      for (const f of json.features ?? []) {
        const g = f.geometry;
        if (!g) continue;
        const pts = g.type === 'Polygon' ? g.coordinates[0] : g.type === 'MultiPolygon' ? g.coordinates.sort((a, b) => b[0].length - a[0].length)[0][0]
          : g.type === 'LineString' ? g.coordinates : g.coordinates.flat();
        if (!pts?.length) continue;
        // Lakes: the vertex nearest the ring's average point; streams: the middle vertex.
        let p = pts[Math.floor(pts.length / 2)];
        if (kind === 'lake') {
          const cx = pts.reduce((s, q) => s + q[0], 0) / pts.length, cy = pts.reduce((s, q) => s + q[1], 0) / pts.length;
          p = pts.reduce((best, q) => (q[0] - cx) ** 2 + (q[1] - cy) ** 2 < (best[0] - cx) ** 2 + (best[1] - cy) ** 2 ? q : best);
        }
        for (const n of new Set([f.properties.NAME, f.properties.MAP_LABEL].filter(Boolean))) out.push({ name: n, kind, lat: round(p[1]), lon: round(p[0]), county: f.properties.COUNTY_NAM });
      }
      if ((json.features ?? []).length < 1000) break;
    }
  }
  return out;
}

async function nhdWaters() {
  const [l, r] = await Promise.all([readOld('lakes.json'), readOld('rivers.json')]);
  const out = [];
  for (const x of l?.lakes ?? []) out.push({ name: x.name, kind: 'lake', lat: x.lat, lon: x.lon, acres: x.acres, gnis: x.gnis });
  for (const x of r?.rivers ?? []) {
    const mid = x.points[Math.floor(x.points.length / 2)];
    out.push({ name: x.name, kind: 'stream', lat: mid[0], lon: mid[1], km: x.km, gnis: x.gnis });
  }
  return out;
}

// OpenStreetMap Nominatim, at most one request a second as its policy asks, and only for waters with no point yet.
async function geocode(w) {
  const q = `${w.name.replace(/\(.*?\)/g, '').trim()}, Nevada`;
  const params = new URLSearchParams({ q, format: 'json', limit: '5', countrycodes: 'us', viewbox: `${NV.bbox.xmin},${NV.bbox.ymax},${NV.bbox.xmax},${NV.bbox.ymin}`, bounded: '1' });
  await new Promise(res => setTimeout(res, 1100));
  const hits = await getJson(`https://nominatim.openstreetmap.org/search?${params}`, { headers: { ...UA, 'User-Agent': UA['User-Agent'] + ' nominatim' } });
  const good = hits.filter(h => /water|natural|leisure|waterway|reservoir|park/i.test(`${h.class} ${h.type}`) && inOutline([+h.lon, +h.lat], NV.outline));
  const h = good.find(x => !w.region || regionOf([+x.lat, +x.lon]) === w.region) ?? good[0];
  return h ? { lat: round(+h.lat), lon: round(+h.lon), via: 'osm' } : null;
}

function pickPoint(w, sources) {
  const key = norm(w.name);
  if (key.length < 3) return null;
  const flowing = isFlowing(w);
  for (const [via, list] of sources) {
    const same = list.filter(c => norm(c.name) === key && (c.kind === 'stream') === flowing && inOutline([c.lon, c.lat], NV.outline));
    if (!same.length) continue;
    // Prefer one in NDOW's region for the water, then the biggest.
    const inRegion = same.filter(c => !w.region || w.region === 'Headquarters' || regionOf([c.lat, c.lon]) === w.region);
    const pool = inRegion.length ? inRegion : same.length === 1 ? same : [];
    const best = pool.sort((a, b) => (b.acres ?? b.km ?? 0) - (a.acres ?? a.km ?? 0))[0];
    if (best) return { lat: best.lat, lon: best.lon, via, ...(best.acres && { acres: best.acres }), ...(best.county && { county: best.county }) };
  }
  return null;
}

async function buildWaters(raw) {
  const old = new Map(((await readOld('waters.json'))?.waters ?? []).map(w => [w.id, w]));
  const nhd = await nhdWaters();
  let fishable = [];
  try { fishable = await fishableWaters(); } catch (e) { report.fishableError = e.message; }
  report.points = { nhd: nhd.length, fishable: fishable.length, via: {} };
  const unmatched = [];
  let geocoded = 0;
  const waters = [];
  for (const w of raw) {
    const prev = old.get(w.id);
    let pt = pickPoint(w, [['nhd', nhd], ['ndow', fishable]]);
    if (!pt && prev?.lat != null) pt = { lat: prev.lat, lon: prev.lon, via: prev.via, county: prev.county };
    if (!pt && geocoded < 150) {
      geocoded++;
      try { pt = await geocode(w); } catch (e) { report.geocodeError = e.message; }
    }
    if (!pt) unmatched.push(`${w.name} (${w.region}, ${w.ndowType})`);
    report.points.via[pt?.via ?? 'none'] = (report.points.via[pt?.via ?? 'none'] ?? 0) + 1;
    const plants = w.stocking.map(s => ymd(s.date_stocked)).filter(Boolean).sort();
    waters.push({
      id: w.id, name: w.name, type: TYPE[w.ndowType] ?? null, region: w.region, counties: `${w.region ?? 'Nevada'} region`, county: pt?.county ?? null,
      lat: pt?.lat ?? null, lon: pt?.lon ?? null, via: pt?.via ?? null, acres: pt?.acres ?? null, url: w.url,
      report: w.report, reportDate: w.reportDate, info: w.info, history: w.history, guides: w.guides, fishNv: w.fishNv,
      lastYearStocked: plants.length ? +plants.at(-1).slice(0, 4) : null,
    });
  }
  report.points.unmatched = unmatched;
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

async function usgsLevels() {
  const PARAMS = '62614,62615,00062,00054';
  const rdb = await (await get(`https://waterservices.usgs.gov/nwis/site/?format=rdb&stateCd=nv&siteType=LK&parameterCd=${PARAMS}&siteStatus=active&hasDataTypeCd=dv`)).text();
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
const RISE_LAKES = [{ location: 3514, id: 'MEAD', name: 'Lake Mead' }, { location: 3513, id: 'MOHAVE', name: 'Lake Mohave' }];
async function riseLevels() {
  const out = [];
  report.rise = {};
  const since = new Date(Date.now() - 62 * 864e5).toISOString().slice(0, 10);
  for (const lake of RISE_LAKES) {
    const log = report.rise[lake.name] = { items: [] };
    try {
      const loc = (await getJson(`${RISE}/rise/api/location/${lake.location}`)).data;
      const [lon, lat] = loc.attributes.locationCoordinates.coordinates;
      const items = [];
      for (const rec of loc.relationships?.catalogRecords?.data ?? []) {
        const r = await getJson(`${RISE}${rec.id}`);
        for (const it of r.data?.relationships?.catalogItems?.data ?? []) items.push(it.id);
      }
      const picked = {};
      for (const id of items) {
        const it = (await getJson(`${RISE}${id}`)).data?.attributes ?? {};
        log.items.push(`${id} ${it.itemTitle}`);
        const t = it.itemTitle ?? '';
        if (!/daily/i.test(t) || /model|forecast|projected|24-month|mtom/i.test(t)) continue;
        if (/elevation/i.test(t) && /lake|reservoir/i.test(t) && !/tailwater|release/i.test(t)) picked.elevation ??= it._id;
        if (/storage/i.test(t) && !/change/i.test(t)) picked.storage ??= it._id;
      }
      log.picked = picked;
      const series = async itemId => {
        if (!itemId) return [];
        const res = await getJson(`${RISE}/rise/api/result?itemId=${itemId}&dateTime%5Bafter%5D=${since}&order%5BdateTime%5D=ASC&itemsPerPage=100`);
        return (res.data ?? []).map(x => [x.attributes.dateTime.slice(0, 10), +x.attributes.result]).filter(([, v]) => Number.isFinite(v));
      };
      const elevation = await series(picked.elevation), storage = await series(picked.storage);
      log.points = { elevation: elevation.length, storage: storage.length };
      if (elevation.length || storage.length) out.push({ id: lake.id, name: lake.name, lat: round(lat), lon: round(lon), source: 'USBR', elevation, storage });
    } catch (e) { log.error = e.message; }
  }
  return out;
}

// ---------- Toxic algae ----------
const HAB_LEVEL = { watch: 'caution', warning: 'warning', danger: 'danger' };
async function habAdvisories(waters) {
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
    const name = text(m[1]).replace(/,\s*[^,]*,\s*NV$/i, '').trim();
    const body = text(m[2]);
    // The newest change comes first; "upgraded/downgraded ... to a HAB Danger" beats the first level mentioned.
    const moved = body.match(/(?:upgraded|downgraded|lowered|raised|changed|placed on)[^.]*?\bHAB (Watch|Warning|Danger)/i);
    const level = (moved ?? body.match(/\bHAB (Watch|Warning|Danger)/i))?.[1];
    if (!level) continue;
    const dm = body.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
    const date = dm ? `${dm[3].length === 2 ? '20' + dm[3] : dm[3]}-${dm[1].padStart(2, '0')}-${dm[2].padStart(2, '0')}` : null;
    const key = norm(name.split(/[(,]/)[0]);
    const spot = waters.find(w => w.lat != null && norm(w.name) === key) ?? lakes.filter(l => norm(l.name) === key).sort((a, b) => b.acres - a.acres)[0];
    advisories.push({ name, level: HAB_LEVEL[level.toLowerCase()], advisory: `HAB ${level[0].toUpperCase()}${level.slice(1).toLowerCase()}`, date, detail: body.slice(0, 400), landmark: '', lat: spot?.lat ?? null, lon: spot?.lon ?? null });
  }
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
if (reservoirs.length) {
  await save('reservoirs.json', { updatedAt: new Date().toISOString(), source: 'USGS Water Services and Reclamation RISE', units: { elevation: 'ft', storage: 'acre-ft' }, reservoirs });
}
report.reservoirs = reservoirs.map(r => `${r.source} ${r.id} ${r.name}: ${r.elevation.at(-1)?.join(' ') ?? '-'} / ${r.storage.at(-1)?.join(' ') ?? '-'}`);

try { await save('hab.json', await habAdvisories(waters ?? (await readOld('waters.json'))?.waters ?? [])); } catch (e) { report.habError = e.message; console.error('hab:', e.message); }

report.finishedAt = new Date().toISOString();
await writeFile(new URL('update-report.json', OUT), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2).slice(0, 6000));
