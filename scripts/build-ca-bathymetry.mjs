// Collects public depth surveys of California lakes and reservoirs from USGS ScienceBase and turns each into a
// small GeoJSON of depth contours the map can overlay: data/ca/bathymetry/<id>.geojson plus index.json.
// Needs `ogr2ogr`, `gdal_contour`, `gdalinfo`, `gdalwarp` (gdal-bin) and `unzip` on the runner. Runs monthly.
//
// Surveys come as contour shapefiles or as elevation rasters (GeoTIFF, ASCII grid, XYZ). Rasters are contoured
// here with gdal_contour. Contour values are elevations above a datum, not depths: the app subtracts them from
// the lake's current level (CDEC) when it has one, otherwise from the highest contour (about full pool).

import { writeFile, mkdir, readFile, rm, readdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, extname, basename } from 'node:path';

const OUT = new URL('../data/ca/bathymetry/', import.meta.url);
const WORK = '/tmp/bathy';
const UA = { 'User-Agent': 'TackleBox-fishing-app (personal, github.com/mikegutberlet/FishingApp)' };
const SB = 'https://www.sciencebase.gov/catalog';
// ScienceBase ANDs every word and searches summaries too, so short queries with "California" work well.
const QUERIES = ['reservoir bathymetric California', 'lake bathymetric California', 'reservoir contours California', 'lake contours California',
  'bathymetric survey California', 'stage-storage California', 'stage storage reservoir California', 'Lake Tahoe bathymetry', 'bathymetry reservoir California', 'lake depth survey California'];
const MAX_FILE = 400e6, MAX_GEOJSON = 4e6;
const report = { startedAt: new Date().toISOString(), items: [] };

const INCLUDE = /\b(lake|reservoir|res\.)\b/i;
const TOPIC = /bathymetr|contour|stage-?storage|depth/i;
const EXCLUDE = /orthomosaic|imagery|digital surface model|\bdsm\b|hillshade|water[- ]?table|ground-?water|potentiometric|clay|subsidence|insar|\bned\b|arc-second|tidal|marsh|multibeam|canyon|borderland|delta|slough|\briver\b|ship channel|geochemical|diatom|grain size|seafloor|offshore|coast|ocean|island|estuar|\bbay\b|lagoon|topobathymetric|sediment core|vapor transport/i;

async function get(url) {
  const r = await fetch(url, { headers: UA, redirect: 'follow' });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r;
}
const getJson = async url => (await get(url)).json();

async function search(q) {
  const params = new URLSearchParams({ q, format: 'json', max: '300', fields: 'title,spatial,hasChildren' });
  return (await getJson(`${SB}/items?${params}`)).items ?? [];
}
const item = id => getJson(`${SB}/item/${id}?format=json&fields=title,files,spatial,hasChildren,dates`);
const children = async id => (await getJson(`${SB}/items?parentId=${id}&format=json&max=100&fields=title,files,spatial`)).items ?? [];

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70);
const inCalifornia = ([w, s, e, n]) => w > -125 && e < -114 && s > 32.4 && n < 42.1;
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

async function toGeoJson(shp, field, dir, srsArgs = []) {
  for (const simplify of ['0.00002', '0.00005', '0.0001', '0.0002', '0.0004']) {
    const out = join(dir, `out-${simplify}.geojson`);
    await rm(out, { force: true });
    sh('ogr2ogr', ['-f', 'GeoJSON', ...srsArgs, '-t_srs', 'EPSG:4326', '-simplify', simplify, '-lco', 'COORDINATE_PRECISION=5', '-select', field, out, shp]);
    const gj = JSON.parse(await readFile(out, 'utf8'));
    // Drop the speckle of tiny rings a raster contour produces; they add bytes and no information.
    const features = gj.features.filter(f => f.geometry && Number.isFinite(+f.properties[field]) && vertexCount(f.geometry) >= 12)
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

async function contourRaster(rasterIn, units, dir) {
  const raster = await prepareRaster(rasterIn, dir);
  const info = JSON.parse(sh('gdalinfo', ['-json', raster]));
  const [w, h] = info.size;
  let src = raster;
  // Keep the contouring quick: coarsen anything over ~20M cells.
  if (w * h > 20e6) {
    const factor = Math.ceil(Math.sqrt(w * h / 20e6));
    src = join(dir, 'coarse.tif');
    sh('gdalwarp', ['-overwrite', '-r', 'average', '-ts', String(Math.round(w / factor)), String(Math.round(h / factor)), raster, src]);
  }
  // Big lakes get 20 ft contours so the file stays small enough for a phone.
  const big = w * h > 12e6;
  const interval = units === 'm' ? (big ? '6' : '3') : (big ? '20' : '10');
  const shp = join(dir, 'contours.shp');
  sh('gdal_contour', ['-i', interval, '-a', 'e', '-f', 'ESRI Shapefile', src, shp]);
  return { shp, field: 'e', interval, size: [w, h], srs: info.coordinateSystem?.wkt?.slice(0, 80) };
}

async function processItem(it, parentTitle) {
  const entry = { id: it.id, title: it.title, parent: parentTitle };
  report.items.push(entry);
  const full = await item(it.id);
  const files = (full.files ?? []).map(f => ({ name: f.name, url: f.url, size: f.size ?? 0 }));
  entry.files = files.map(f => f.name);
  const bb = bboxOf(full);
  if (bb && !inCalifornia(bb)) { entry.skip = 'outside California'; return null; }
  const picks = files.filter(isGoodFile).filter(f => f.size <= MAX_FILE)
    .sort((a, b) => (/contour/i.test(b.name) - /contour/i.test(a.name)) || (/\.tiff?$|\.zip$/i.test(b.name) - /\.tiff?$|\.zip$/i.test(a.name)) || a.size - b.size);
  if (!picks.length) { entry.skip = 'no usable files'; return null; }
  const dir = join(WORK, it.id);
  await mkdir(dir, { recursive: true });
  let shp = null, field = null, units = unitsOf(it.title, parentTitle ?? '');
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
        const u = units ?? unitsOf(basename(r)) ?? 'ft';
        const res = await contourRaster(r, u, dir);
        entry.raster = { file: basename(r), ...res };
        shp = res.shp; field = res.field; units = u;
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
  const gj = await toGeoJson(shp, field, dir, srsArgs);
  if (!gj) { entry.skip = 'too large even simplified'; return null; }
  const elevs = gj.features.map(f => f.properties.e);
  let [w, s, e, n] = [180, 90, -180, -90];
  for (const f of gj.features) eachCoord(f.geometry, ([x, y]) => { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); });
  if (!inCalifornia([w, s, e, n])) { entry.skip = 'contours outside California'; return null; }
  const title = parentTitle && !/lake|reservoir/i.test(it.title) ? `${parentTitle} · ${it.title}` : it.title;
  const fileId = slug(title);
  await writeFile(new URL(`${fileId}.geojson`, OUT), gj.body);
  entry.ok = { fileId, features: gj.features.length, bytes: gj.body.length, simplify: gj.simplify, units };
  return {
    id: fileId, title, year: +(title.match(/\b(19|20)\d{2}\b/)?.[0] ?? 0) || null, source: `https://www.sciencebase.gov/catalog/item/${it.id}`,
    units: units ?? 'ft', unitsGuessed: !units, datum: /navd\s?88/i.test(`${title} ${entry.files.join(' ')}`) ? 'NAVD88' : null,
    minElev: Math.min(...elevs), maxElev: Math.max(...elevs), bbox: [w, s, e, n].map(v => +v.toFixed(5)),
    lat: +((s + n) / 2).toFixed(5), lon: +((w + e) / 2).toFixed(5), bytes: gj.body.length,
  };
}

await mkdir(OUT, { recursive: true });
await rm(WORK, { recursive: true, force: true });
await mkdir(WORK, { recursive: true });

const seen = new Map();
for (const q of QUERIES) {
  try { for (const it of await search(q)) seen.set(it.id, it); } catch (e) { report.searchErrors = (report.searchErrors ?? []).concat(`${q}: ${e.message}`); }
}
const caBox = it => { const b = bboxOf(it); return b ? inCalifornia(b) : /california|calif\.|tahoe/i.test(it.title); };
const candidates = [...seen.values()].filter(it => INCLUDE.test(it.title) && TOPIC.test(it.title) && !EXCLUDE.test(it.title) && caBox(it));
report.searched = seen.size;
report.candidates = candidates.map(c => c.title);

const index = [];
const done = new Set();
const contourTitles = candidates.filter(c => /contour/i.test(c.title)).map(c => c.title.split(',')[0].toLowerCase());
candidates.sort((a, b) => /contour/i.test(b.title) - /contour/i.test(a.title));
for (const cand of candidates) {
  // A lake with a published contour set doesn't need its DEM contoured too.
  if (/digital elevation model|\bdem\b/i.test(cand.title) && contourTitles.includes(cand.title.split(',')[0].toLowerCase())) {
    report.items.push({ id: cand.id, title: cand.title, skip: 'contours published separately' });
    continue;
  }
  const queue = [{ it: cand, parent: null }];
  if (cand.hasChildren) {
    try { for (const ch of await children(cand.id)) queue.push({ it: ch, parent: cand.title }); } catch (e) { report.items.push({ id: cand.id, title: cand.title, childrenError: e.message }); }
  }
  for (const { it, parent } of queue) {
    if (done.has(it.id)) continue;
    done.add(it.id);
    try {
      const entry = await processItem(it, parent);
      if (entry) index.push(entry);
    } catch (e) {
      report.items.push({ id: it.id, title: it.title, error: e.message.slice(0, 300), at: (e.stack ?? '').split('\n')[1]?.trim() });
    }
    await rm(join(WORK, it.id), { recursive: true, force: true });
  }
}

// Remove files from earlier runs that no longer have an index entry.
const keep = new Set(index.map(i => `${i.id}.geojson`));
for (const name of await readdir(OUT)) if (name.endsWith('.geojson') && !keep.has(name)) await rm(new URL(name, OUT));

index.sort((a, b) => a.title.localeCompare(b.title) || (b.year ?? 0) - (a.year ?? 0));
await writeFile(new URL('index.json', OUT), JSON.stringify({ updatedAt: new Date().toISOString(), surveys: index }, null, 1) + '\n');
report.saved = index.map(i => `${i.title} (${Math.round(i.bytes / 1e3)} KB, ${i.units})`);
report.finishedAt = new Date().toISOString();
await writeFile(new URL('../bathymetry-report.json', OUT), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ searched: report.searched, candidates: report.candidates.length, saved: report.saved }, null, 2));
