// Collects public depth surveys of a state's lakes and reservoirs from USGS ScienceBase and turns each into a
// small GeoJSON of depth contours the map can overlay: data/<st>/bathymetry/<id>.geojson plus index.json.
// Same as build-ca-bathymetry.mjs, for the states in scripts/states.mjs:  node scripts/build-state-bathymetry.mjs nv
// Needs `ogr2ogr`, `gdal_contour`, `gdalinfo`, `gdalwarp` (gdal-bin) and `unzip` on the runner. Runs monthly.
//
// Surveys come as contour shapefiles or as elevation rasters (GeoTIFF, ASCII grid, XYZ). Rasters are contoured
// here with gdal_contour. Contour values are elevations above a datum, not depths: the app subtracts them from
// the lake's current level (from the state's gauges) when it has one, otherwise from the highest contour (about full pool).

import { writeFile, mkdir, readFile, rm, readdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, extname, basename } from 'node:path';
import { stateArg, inOutline } from './states.mjs';

const STATE = stateArg();

const OUT = new URL(`../data/${STATE.st}/bathymetry/`, import.meta.url);
const WORK = `/tmp/bathy-${STATE.st}`;
const UA = { 'User-Agent': 'TackleBox-fishing-app (personal, github.com/mikegutberlet/FishingApp)' };
const SB = 'https://www.sciencebase.gov/catalog';
// ScienceBase ANDs every word and searches summaries too, so short queries with the state's name work well.
const QUERIES = STATE.bathymetryQueries;
const MAX_FILE = 400e6, MAX_GEOJSON = 4e6;
const report = { startedAt: new Date().toISOString(), items: [] };

const INCLUDE = /\b(lake|reservoir|res\.)\b/i;
const TOPIC = /bathymetr|contour|stage-?storage|depth/i;
const EXCLUDE = /orthomosaic|imagery|digital surface model|\bdsm\b|hillshade|water[- ]?table|ground-?water|potentiometric|clay|subsidence|insar|\bned\b|arc-second|tidal|marsh|multibeam|canyon|borderland|delta|slough|\briver\b|ship channel|geochemical|diatom|grain size|seafloor|offshore|coast|ocean|island|estuar|\bbay\b|lagoon|topobathymetric|sediment core|vapor transport/i;

async function get(url, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { headers: UA, redirect: 'follow' });
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return r;
    } catch (e) {
      if (i >= tries) throw e;
      await new Promise(res => setTimeout(res, 5000 * i));
    }
  }
}
const getJson = async url => (await get(url)).json();

async function search(q) {
  const params = new URLSearchParams({ q, format: 'json', max: '300', fields: 'title,spatial,hasChildren' });
  return (await getJson(`${SB}/items?${params}`)).items ?? [];
}
const item = id => getJson(`${SB}/item/${id}?format=json&fields=title,files,spatial,hasChildren,dates`);
const children = async id => (await getJson(`${SB}/items?parentId=${id}&format=json&max=100&fields=title,files,spatial`)).items ?? [];

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70);
// A survey belongs to the state when the middle of its box is inside the state's outline.
const inState = ([w, s, e, n]) => e - w < 3 && n - s < 3 && inOutline([(w + e) / 2, (s + n) / 2], STATE.outline);
const bboxOf = it => { const b = it.spatial?.boundingBox; return b ? [b.minX, b.minY, b.maxX, b.maxY] : null; };
const sh = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 }).toString();

async function walk(dir) {
  const out = [];
  for (const name of await readdir(dir)) {
    const p = join(dir, name);
    if ((await stat(p)).isDirectory()) out.push(...await walk(p)); else out.push(p);
  }
  return out;
}

const isRasterName = f => !/ortho|_hll|dsm|browse|thumb/i.test(basename(f)) && (/\.(tif|tiff|asc|xyz|img|adf)$/i.test(f) || (/\.txt$/i.test(f) && /dem|grid|xyz|bathy|elev/i.test(basename(f))));
const isGoodFile = f => (/\.zip$/i.test(f.name) && !/dwg|cad|jpg|photo|image/i.test(f.name)) || isRasterName(f.name);

// The statewide lake list (weekly build) gives each lake's surface elevation, used to sanity-check survey units.
let LAKES = [];
try { LAKES = JSON.parse(await readFile(new URL('../lakes.json', OUT), 'utf8')).lakes.filter(l => l.elevationFt != null); } catch {}
const norm = s => (s ?? '').toLowerCase().replace(/\b(lake|reservoir|res\.?|the|of)\b|[^a-z0-9]/g, '');
// The lake a survey title names, e.g. "Bathymetric data for Whiskeytown Lake, May 2019" -> "whiskeytown".
function lakeKey(title) {
  const m = title.match(/\bLake\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)|([A-Z][A-Za-z.']+(?:\s[A-Z][A-Za-z.']+){0,2})\s+(?:Lake|Reservoir)\b/);
  return m ? norm(m[1] ?? m[2]) : null;
}
function lakeFor(title, center) {
  const key = lakeKey(title);
  let named = key && LAKES.filter(l => norm(l.name) === key);
  if (key && !named.length) named = LAKES.filter(l => norm(l.name).length > 3 && key.endsWith(norm(l.name))); // "Upper Letts Lake" -> Letts Lake
  if (named?.length && center) named = named.filter(l => Math.hypot(l.lat - center[1], (l.lon - center[0]) * 0.8) < 0.15);
  if (named?.length) {
    return (center ? named.sort((a, b) => Math.hypot(a.lat - center[1], a.lon - center[0]) - Math.hypot(b.lat - center[1], b.lon - center[0])) : named.sort((a, b) => b.acres - a.acres))[0];
  }
  if (!center) return null;
  return LAKES.filter(l => Math.hypot(l.lat - center[1], (l.lon - center[0]) * 0.8) < 0.03).sort((a, b) => b.acres - a.acres)[0] ?? null;
}
// Picks the unit under which the lake's surface elevation sits inside the survey's range: the deepest value
// below the surface (by less than any lake is deep) and the highest value at or above it, less a margin for drawdown.
function unitsFit(units, minVal, maxVal, lake) {
  const toFt = units === 'm' ? 3.28084 : 1;
  const lo = minVal * toFt, hi = maxVal * toFt, e = lake.elevationFt;
  return lo < e && e - lo < 1800 && hi >= e - Math.max(40, e * 0.05);
}
function checkUnits(units, minVal, maxVal, lake, entry) {
  if (!lake || !Number.isFinite(minVal) || !Number.isFinite(maxVal)) return units ?? 'ft';
  const fitFt = unitsFit('ft', minVal, maxVal, lake), fitM = unitsFit('m', minVal, maxVal, lake);
  const best = fitFt && fitM ? (units ?? 'ft') : fitFt ? 'ft' : fitM ? 'm' : null;
  if (!best) throw new Error(`survey range ${minVal}-${maxVal} doesn't fit ${lake.name} at ${lake.elevationFt} ft`);
  if (best !== units) entry.unitsCorrected = { from: units ?? null, to: best, minVal, maxVal, lakeElevationFt: lake.elevationFt, lake: lake.name };
  return best;
}
// Contours above the water line are land, not lake bottom; keep only those up to the surface plus a little for full pool.
const surfaceCap = (units, lake) => lake ? (lake.elevationFt + Math.max(40, lake.elevationFt * 0.05)) / (units === 'm' ? 3.28084 : 1) : Infinity;

function unitsOf(...texts) {
  const t = texts.join(' ');
  if (/_ft\b|_ft_|navd88_?ft|\bfeet\b|\bft\b|10-ft|5-ft|2-ft/i.test(t)) return 'ft';
  if (/_m\b|_m_|navd88_?m\b|\bmeters?\b/i.test(t)) return 'm';
  return null;
}

// Elevation attribute of a contour shapefile: the numeric field with the most distinct values.
function elevField(features) {
  const props = features[0]?.properties ?? {};
  return Object.keys(props).filter(k => typeof props[k] === 'number' && !/^(fid|id|objectid|shape|len|area)/i.test(k))
    .map(k => ({ k, spread: new Set(features.map(f => f.properties[k])).size })).sort((a, b) => b.spread - a.spread)[0]?.k;
}

function eachCoord(geometry, cb) {
  const rec = c => { if (typeof c[0] === 'number') cb(c); else for (const x of c) rec(x); };
  rec(geometry.coordinates);
}
const vertexCount = g => { let n = 0; eachCoord(g, () => n++); return n; };

async function toGeoJson(shp, field, dir, srsArgs = [], simplifies = ['0.00002', '0.00005', '0.0001', '0.0002', '0.0004'], maxE = Infinity) {
  for (const simplify of simplifies) {
    const out = join(dir, `out-${simplify}.geojson`);
    await rm(out, { force: true });
    sh('ogr2ogr', ['-f', 'GeoJSON', ...srsArgs, '-t_srs', 'EPSG:4326', '-simplify', simplify, '-lco', 'COORDINATE_PRECISION=5', '-select', field, out, shp]);
    const gj = JSON.parse(await readFile(out, 'utf8'));
    // Drop the speckle of tiny rings a raster contour produces; they add bytes and no information.
    const features = gj.features.filter(f => f.geometry && Number.isFinite(+f.properties[field]) && +f.properties[field] <= maxE && vertexCount(f.geometry) >= 12)
      .map(f => ({ type: 'Feature', properties: { e: +(+f.properties[field]).toFixed(1) }, geometry: f.geometry }));
    const body = JSON.stringify({ type: 'FeatureCollection', features });
    if (body.length <= MAX_GEOJSON) return { body, features, simplify };
  }
  return null;
}

// USGS "DEM ... .txt" files are usually x,y,z rows. GDAL reads them only when gridded and sorted, so sort first.
async function prepareRaster(raster, dir) {
  try { JSON.parse(sh('gdalinfo', ['-json', raster])); return raster; } catch {}
  if (!/\.txt$/i.test(raster)) throw new Error('unreadable raster');
  const head = sh('head', ['-n', '3', raster]);
  const delim = head.includes(',') ? ',' : /\t/.test(head) ? '\t' : ' ';
  const sorted = join(dir, 'sorted.xyz');
  const hasHeader = /[a-df-z]/i.test(head.split('\n')[0]);
  execFileSync('bash', ['-c', `${hasHeader ? 'tail -n +2' : 'cat'} "${raster}" | tr -s ' ' | sed 's/^ //' | sort -t'${delim === ' ' ? ' ' : delim}' -k2,2g -k1,1g > "${sorted}"`], { stdio: 'ignore' });
  JSON.parse(sh('gdalinfo', ['-json', sorted]));
  return sorted;
}

async function contourRaster(rasterIn, units, dir, lake, entry, times = 1) {
  const raster = await prepareRaster(rasterIn, dir);
  const info = JSON.parse(sh('gdalinfo', ['-json', '-mm', raster]));
  const [w, h] = info.size;
  const band = info.bands?.[0] ?? {};
  const minVal = band.computedMin ?? band.minimum, maxVal = band.computedMax ?? band.maximum;
  // ASCII grids rarely declare their no-data value; a huge negative minimum is one (-9999, -3.4e38).
  const nodata = band.noDataValue ?? (minVal <= -500 ? minVal : null);
  const nodataArgs = nodata != null ? ['-srcnodata', String(nodata), '-dstnodata', String(nodata)] : [];
  let src = raster;
  // A phone doesn't need 1 m cells: coarsen anything over ~1500 px on the long side (about 2-4 m cells).
  const MAX_PX = 1500;
  if (Math.max(w, h) > MAX_PX) {
    const factor = Math.max(w, h) / MAX_PX;
    src = join(dir, 'coarse.tif');
    sh('gdalwarp', ['-overwrite', '-r', 'average', ...nodataArgs, '-ts', String(Math.round(w / factor)), String(Math.round(h / factor)), raster, src]);
  }
  // Units from file names are often wrong or missing, so compare the raster's top value with the lake's elevation.
  const ext = info.wgs84Extent?.coordinates?.[0];
  const center = ext ? [ext.reduce((a, c) => a + c[0], 0) / ext.length, ext.reduce((a, c) => a + c[1], 0) / ext.length] : null;
  lake ??= lakeFor(entry.title, center);
  units = checkUnits(units, minVal, maxVal, lake, entry);
  const base = units === 'm' ? 3 : 10;
  const interval = String(base * times);
  const shp = join(dir, 'contours.shp');
  for (const ext of ['shp', 'shx', 'dbf', 'prj']) await rm(join(dir, `contours.${ext}`), { force: true });
  sh('gdal_contour', ['-i', interval, '-a', 'e', ...(nodata != null ? ['-snodata', String(nodata)] : []), '-f', 'ESRI Shapefile', src, shp]);
  return { shp, field: 'e', interval, units, nodata, lake: lake?.name ?? null, minVal, maxVal, size: [w, h], srs: info.coordinateSystem?.wkt?.slice(0, 80) };
}

async function processItem(it, parentTitle) {
  const entry = { id: it.id, title: it.title, parent: parentTitle };
  report.items.push(entry);
  const full = await item(it.id);
  const files = (full.files ?? []).map(f => ({ name: f.name, url: f.url, size: f.size ?? 0 }));
  entry.files = files.map(f => f.name);
  const bb = bboxOf(full);
  if (bb && !inState(bb)) { entry.skip = `outside ${STATE.name}`; return null; }
  const picks = files.filter(isGoodFile).filter(f => f.size <= MAX_FILE)
    .sort((a, b) => (/contour/i.test(b.name) - /contour/i.test(a.name)) || (/\.tiff?$|\.zip$/i.test(b.name) - /\.tiff?$|\.zip$/i.test(a.name)) || a.size - b.size);
  if (!picks.length) { entry.skip = 'no usable files'; return null; }
  const dir = join(WORK, it.id);
  await mkdir(dir, { recursive: true });
  let shp = null, field = null, units = unitsOf(it.title, parentTitle ?? ''), rasterFile = null;
  const lake = lakeFor(it.title, bb ? [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2] : null);
  for (const pick of picks) {
    const local = join(dir, basename(pick.name));
    await writeFile(local, Buffer.from(await (await get(pick.url)).arrayBuffer()));
    entry.downloaded = (entry.downloaded ?? []).concat(`${pick.name} (${Math.round(pick.size / 1e6)} MB)`);
    if (/\.zip$/i.test(local)) {
      sh('unzip', ['-qo', local, '-d', dir]);
      for (const f of await walk(dir)) if (/\.zip$/i.test(f) && f !== local) try { sh('unzip', ['-qo', f, '-d', dir]); } catch {}
    }
    const all = await walk(dir);
    const contourShp = all.find(f => /\.shp$/i.test(f) && /contour/i.test(basename(f))) ?? all.find(f => /\.shp$/i.test(f));
    if (contourShp) {
      shp = contourShp;
      units ??= unitsOf(basename(contourShp));
      break;
    }
    const rasters = all.filter(isRasterName).filter(f => !/\.zip$/i.test(f)).sort((a, b) => (/\.tiff?$/i.test(b) - /\.tiff?$/i.test(a)));
    for (const r of rasters) {
      try {
        const res = await contourRaster(r, units ?? unitsOf(basename(r)), dir, lake, entry);
        entry.raster = { file: basename(r), ...res };
        shp = res.shp; field = res.field; units = res.units; rasterFile = r;
        break;
      } catch (e) { entry.rasterErrors = (entry.rasterErrors ?? []).concat(`${basename(r)}: ${e.message.slice(0, 160)}`); }
    }
    if (shp) break;
  }
  if (!shp) { entry.skip = 'no contours or readable raster'; return null; }
  if (!field) {
    const probe = join(dir, 'probe.geojson');
    sh('ogr2ogr', ['-f', 'GeoJSON', '-t_srs', 'EPSG:4326', '-simplify', '0.001', probe, shp]);
    field = elevField(JSON.parse(await readFile(probe, 'utf8')).features);
    if (!field) { entry.skip = 'no elevation field'; return null; }
  }
  // Some ASCII exports carry no projection. USGS names them with their UTM zone (UTM11, UTMZ10N), so use that.
  const srsArgs = [];
  try { JSON.parse(sh('ogrinfo', ['-json', '-so', shp])); } catch {}
  const probeInfo = sh('ogrinfo', ['-so', '-al', shp]);
  if (!/PROJCRS|GEOGCRS|PROJCS|GEOGCS/.test(probeInfo)) {
    const zone = `${it.title} ${entry.files.join(' ')} ${(entry.downloaded ?? []).join(' ')}`.match(/UTM\s?Z?(1[01])/i)?.[1] ?? '10';
    srsArgs.push('-s_srs', `EPSG:269${zone}`);
    entry.assumedSrs = `EPSG:269${zone}`;
  }
  if (!rasterFile) {
    // Published contour sets: read their range first to settle the units.
    const probe = join(dir, 'range.geojson');
    sh('ogr2ogr', ['-f', 'GeoJSON', ...srsArgs, '-t_srs', 'EPSG:4326', '-simplify', '0.01', '-select', field, probe, shp]);
    const vals = JSON.parse(await readFile(probe, 'utf8')).features.map(f => +f.properties[field]).filter(Number.isFinite);
    units = checkUnits(units, Math.min(...vals), Math.max(...vals), lake, entry);
  }
  let gj = await toGeoJson(shp, field, dir, srsArgs, rasterFile ? ['0.00005', '0.0001'] : undefined, surfaceCap(units, lake));
  // Raster contours that are still too big get a wider interval rather than cruder lines.
  for (const times of [2, 4, 8]) {
    if (gj || !rasterFile) break;
    const res = await contourRaster(rasterFile, units, dir, lake, entry, times);
    entry.raster = { ...entry.raster, interval: res.interval };
    gj = await toGeoJson(res.shp, res.field, dir, srsArgs, times < 8 ? ['0.00005', '0.0001'] : undefined, surfaceCap(units, lake));
  }
  if (!gj) { entry.skip = 'too large even simplified'; return null; }
  if (!gj.features.length) { entry.skip = 'no contours below the water line'; return null; }
  const elevs = gj.features.map(f => f.properties.e);
  let [w, s, e, n] = [180, 90, -180, -90];
  for (const f of gj.features) eachCoord(f.geometry, ([x, y]) => { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); });
  if (!inState([w, s, e, n])) { entry.skip = `contours outside ${STATE.name}`; return null; }
  const title = parentTitle && !/lake|reservoir/i.test(it.title) ? `${parentTitle} · ${it.title}` : it.title;
  const fileId = slug(title);
  await writeFile(new URL(`${fileId}.geojson`, OUT), gj.body);
  entry.ok = { fileId, features: gj.features.length, bytes: gj.body.length, simplify: gj.simplify, units };
  return {
    id: fileId, title, year: +(title.match(/\b(19|20)\d{2}\b/)?.[0] ?? 0) || null, source: `https://www.sciencebase.gov/catalog/item/${it.id}`,
    lake: lake?.name ?? null, lakeKey: lakeKey(title), units: units ?? 'ft', unitsGuessed: !units && !entry.unitsCorrected, datum: /navd\s?88/i.test(`${title} ${entry.files.join(' ')}`) ? 'NAVD88' : null,
    minElev: Math.min(...elevs), maxElev: Math.max(...elevs), bbox: [w, s, e, n].map(v => +v.toFixed(5)),
    lat: +((s + n) / 2).toFixed(5), lon: +((w + e) / 2).toFixed(5), bytes: gj.body.length,
  };
}

await mkdir(OUT, { recursive: true });
let oldIndex = [];
try { oldIndex = JSON.parse(await readFile(new URL('index.json', OUT), 'utf8')).surveys ?? []; } catch {}
await rm(WORK, { recursive: true, force: true });
await mkdir(WORK, { recursive: true });

const seen = new Map();
for (const q of QUERIES) {
  try { for (const it of await search(q)) seen.set(it.id, it); } catch (e) { report.searchErrors = (report.searchErrors ?? []).concat(`${q}: ${e.message}`); }
}
const caBox = it => { const b = bboxOf(it); return b ? inState(b) : new RegExp(STATE.name, 'i').test(it.title); };
const candidates = [...seen.values()].filter(it => INCLUDE.test(it.title) && TOPIC.test(it.title) && !EXCLUDE.test(it.title) && caBox(it));
report.searched = seen.size;
report.candidates = candidates.map(c => c.title);
// Everything the searches found and why it was left out, to tune the filters for a new state.
report.rejected = [...seen.values()].filter(it => !candidates.includes(it)).map(it => `${it.title} [${!INCLUDE.test(it.title) ? 'no lake word' : !TOPIC.test(it.title) ? 'no topic' : EXCLUDE.test(it.title) ? 'excluded' : 'outside'}]`).slice(0, 300);

const index = [];
const done = new Set();
const yearOf = t => +(t.match(/\b(19|20)\d{2}\b/)?.[0] ?? 0);
const contourKeys = new Set(candidates.filter(c => /contour/i.test(c.title)).map(c => lakeKey(c.title)).filter(Boolean));
// Published contours first, then newest surveys first, so each lake ends up with its best single survey.
candidates.sort((a, b) => (/contour/i.test(b.title) - /contour/i.test(a.title)) || yearOf(b.title) - yearOf(a.title));
const savedKeys = new Set();
for (const cand of candidates) {
  const key = lakeKey(cand.title);
  // A lake with a published contour set doesn't need its DEM contoured too, and one survey per lake is enough.
  if (key && savedKeys.has(key)) { report.items.push({ id: cand.id, title: cand.title, skip: 'newer survey of this lake already saved' }); done.add(cand.id); continue; }
  if (/digital elevation model|\bdem\b/i.test(cand.title) && key && contourKeys.has(key)) {
    report.items.push({ id: cand.id, title: cand.title, skip: 'contours published separately' }); done.add(cand.id); continue;
  }
  const queue = [{ it: cand, parent: null }];
  if (cand.hasChildren) {
    try { for (const ch of await children(cand.id)) queue.push({ it: ch, parent: cand.title }); } catch (e) { report.items.push({ id: cand.id, title: cand.title, childrenError: e.message }); }
  }
  for (const { it, parent } of queue) {
    if (done.has(it.id)) continue;
    done.add(it.id);
    const k = lakeKey(it.title) ?? key;
    if (k && savedKeys.has(k)) continue;
    if (/digital elevation model|\bdem\b/i.test(it.title) && k && contourKeys.has(k)) { report.items.push({ id: it.id, title: it.title, skip: 'contours published separately' }); continue; }
    try {
      const entry = await processItem(it, parent);
      if (entry) { index.push(entry); if (entry.lakeKey) savedKeys.add(entry.lakeKey); }
    } catch (e) {
      report.items.push({ id: it.id, title: it.title, error: e.message.slice(0, 300), at: (e.stack ?? '').split('\n')[1]?.trim() });
    }
    await rm(join(WORK, it.id), { recursive: true, force: true });
  }
}

// A lake this run couldn't rebuild keeps last run's survey rather than vanishing from the app.
for (const old of oldIndex) {
  const key = old.lakeKey ?? lakeKey(old.title);
  if (index.some(i => i.id === old.id || (key && i.lakeKey === key))) continue;
  try { await stat(new URL(`${old.id}.geojson`, OUT)); } catch { continue; }
  index.push({ ...old, lakeKey: key, keptFromLastRun: true });
  report.keptFromLastRun = (report.keptFromLastRun ?? []).concat(old.title);
}

// Remove files from earlier runs that no longer have an index entry.
const keep = new Set(index.map(i => `${i.id}.geojson`));
for (const name of await readdir(OUT)) if (name.endsWith('.geojson') && !keep.has(name)) await rm(new URL(name, OUT));

index.sort((a, b) => a.title.localeCompare(b.title) || (b.year ?? 0) - (a.year ?? 0));
await writeFile(new URL('index.json', OUT), JSON.stringify({ updatedAt: new Date().toISOString(), surveys: index }, null, 1) + '\n');
report.saved = index.map(i => `${i.title} (${Math.round(i.bytes / 1e3)} KB, ${i.units})`);
// HydroLAKES (Messager et al. 2016): every lake over 10 ha with an average depth and volume estimated from its
// shape and the surrounding terrain. Estimates, not soundings, but they cover thousands of lakes no survey does.
async function buildHydroLakes() {
  const dir = join(WORK, 'hydrolakes');
  await mkdir(dir, { recursive: true });
  const zip = join(dir, 'polys.zip');
  const r = await get('https://data.hydrosheds.org/file/hydrolakes/HydroLAKES_polys_v10_shp.zip');
  await writeFile(zip, Buffer.from(await r.arrayBuffer()));
  sh('unzip', ['-qo', zip, '-d', dir]);
  const shp = (await walk(dir)).find(f => /\.shp$/i.test(f));
  if (!shp) throw new Error('no shapefile in HydroLAKES zip');
  const layer = basename(shp, '.shp');
  const csv = join(dir, `${STATE.st}.csv`);
  sh('ogr2ogr', ['-f', 'CSV', '-spat', String(STATE.bbox.xmin), String(STATE.bbox.ymin), String(STATE.bbox.xmax), String(STATE.bbox.ymax), '-dialect', 'SQLite',
    '-sql', `SELECT Hylak_id, Lake_name, Lake_type, Lake_area, Depth_avg, Vol_total, Shore_len, Res_time, Elevation, ST_X(ST_Centroid(geometry)) AS lon, ST_Y(ST_Centroid(geometry)) AS lat, geometry FROM "${layer}"`, csv, shp]);
  const lines = (await readFile(csv, 'utf8')).replace(/\r/g, '').split('\n').filter(Boolean);
  const header = lines[0].split(',').map(h => h.toLowerCase());
  const col = n => header.indexOf(n.toLowerCase());
  const rows = [];
  const splitCsv = line => { const out = []; let cur = '', q = false; for (const ch of line) { if (ch === '"') q = !q; else if (ch === ',' && !q) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out; };
  for (const line of lines.slice(1)) {
    const c = splitCsv(line);
    const lat = +c[col('lat')], lon = +c[col('lon')], area = +c[col('Lake_area')], depth = +c[col('Depth_avg')];
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !(depth > 0) || !inState([lon - 0.01, lat - 0.01, lon + 0.01, lat + 0.01])) continue;
    rows.push({
      id: +c[col('Hylak_id')], name: c[col('Lake_name')] || null, type: +c[col('Lake_type')] === 2 ? 'Reservoir' : 'Lake',
      lat: +lat.toFixed(4), lon: +lon.toFixed(4), acres: Math.round(area * 247.105), meanDepthFt: +(depth * 3.28084).toFixed(1),
      volumeAcreFt: Math.round(+c[col('Vol_total')] * 810.7), shoreMi: +(+c[col('Shore_len')] * 0.6214).toFixed(1),
      residenceDays: Math.round(+c[col('Res_time')]) || null, elevationFt: Math.round(+c[col('Elevation')] * 3.28084),
    });
  }
  await writeFile(new URL('../hydrolakes.json', OUT), JSON.stringify({
    updatedAt: new Date().toISOString(), source: 'HydroLAKES v1.0 (Messager et al. 2016), average depth and volume modelled from lake shape and terrain', lakes: rows,
  }) + '\n');
  report.hydrolakes = { rows: rows.length };
  await rm(dir, { recursive: true, force: true });
}
try { await buildHydroLakes(); } catch (e) { report.hydrolakesError = e.message.slice(0, 300); console.error('hydrolakes:', e.message); }

report.finishedAt = new Date().toISOString();
await writeFile(new URL('../bathymetry-report.json', OUT), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ searched: report.searched, candidates: report.candidates.length, saved: report.saved, hydrolakes: report.hydrolakes ?? report.hydrolakesError }, null, 2));
