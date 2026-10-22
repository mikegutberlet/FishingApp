// Collects public depth-contour surveys of California lakes and reservoirs from USGS ScienceBase and converts
// them to small GeoJSON files the map can overlay: data/ca/bathymetry/<id>.geojson plus data/ca/bathymetry/index.json.
// Needs `ogr2ogr` (gdal-bin) and `unzip` on the runner. Runs monthly; new surveys appear slowly.
//
// Contours from these surveys are elevations (feet or meters above a datum), not depths. The app turns them into
// depths using the lake's current level from CDEC when it has one, otherwise the highest contour (about full pool).

import { writeFile, mkdir, readFile, rm, readdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const OUT = new URL('../data/ca/bathymetry/', import.meta.url);
const WORK = '/tmp/bathy';
const UA = { 'User-Agent': 'TackleBox-fishing-app (personal, github.com/mikegutberlet/FishingApp)' };
const SB = 'https://www.sciencebase.gov/catalog';
// ScienceBase's search ANDs every word, so keep queries short and filter by title/location afterwards.
const QUERIES = ['contours NAVD88', 'California contours', 'reservoir contours', 'lake contours', 'bathymetric contours', 'bathymetry California', 'bathymetric survey California', 'Lake Tahoe bathymetry', 'reservoir bathymetry'];
const report = { startedAt: new Date().toISOString(), items: [] };

async function get(url) {
  const r = await fetch(url, { headers: UA, redirect: 'follow' });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r;
}

async function search(q) {
  const params = new URLSearchParams({ q, format: 'json', max: '300', fields: 'title,spatial,hasChildren' });
  const json = await (await get(`${SB}/items?${params}`)).json();
  return json.items ?? [];
}

async function itemFiles(id) {
  const json = await (await get(`${SB}/item/${id}?format=json&fields=title,files,spatial,parentId`)).json();
  return json;
}

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const inCalifornia = ([w, s, e, n]) => w > -125 && e < -114 && s > 32.4 && n < 42.1;

async function walk(dir) {
  const out = [];
  for (const name of await readdir(dir)) {
    const p = join(dir, name);
    if ((await stat(p)).isDirectory()) out.push(...await walk(p)); else out.push(p);
  }
  return out;
}

await mkdir(OUT, { recursive: true });
await rm(WORK, { recursive: true, force: true });
await mkdir(WORK, { recursive: true });

const seen = new Map();
for (const q of QUERIES) {
  try { for (const it of await search(q)) seen.set(it.id, it); } catch (e) { report.searchError = e.message; }
}
const caBox = it => { const b = it.spatial?.boundingBox; return b ? inCalifornia([b.minX, b.minY, b.maxX, b.maxY]) : /california|tahoe/i.test(it.title); };
const candidates = [...seen.values()].filter(it => /contour|bathymetr/i.test(it.title) && !/topograph|land surface|lidar|seafloor|offshore|bay\b|coast|ocean|channel islands/i.test(it.title) && caBox(it));
report.searched = seen.size;
report.candidates = candidates.map(c => c.title);

const index = [];
for (const item of candidates) {
  const entry = { id: item.id, title: item.title };
  report.items.push(entry);
  try {
    const full = await itemFiles(item.id);
    const bb = full.spatial?.boundingBox;
    if (bb && !inCalifornia([bb.minX, bb.minY, bb.maxX, bb.maxY])) { entry.skip = 'outside California'; continue; }
    const zip = (full.files ?? []).find(f => /\.zip$/i.test(f.name) && !/dwg|cad/i.test(f.name));
    if (!zip) { entry.skip = 'no zip'; entry.files = (full.files ?? []).map(f => f.name); continue; }
    const dir = join(WORK, item.id);
    await mkdir(dir, { recursive: true });
    const buf = Buffer.from(await (await get(zip.url)).arrayBuffer());
    entry.zipBytes = buf.length;
    await writeFile(join(dir, 'data.zip'), buf);
    execFileSync('unzip', ['-qo', join(dir, 'data.zip'), '-d', dir]);
    // Nested zips are common in USGS releases.
    for (const f of await walk(dir)) if (/\.zip$/i.test(f) && !f.endsWith('data.zip')) execFileSync('unzip', ['-qo', f, '-d', dir]);
    const shp = (await walk(dir)).find(f => /\.shp$/i.test(f) && /contour/i.test(f)) ?? (await walk(dir)).find(f => /\.shp$/i.test(f));
    if (!shp) { entry.skip = 'no shapefile'; continue; }
    const out = join(dir, 'out.geojson');
    execFileSync('ogr2ogr', ['-f', 'GeoJSON', '-t_srs', 'EPSG:4326', '-simplify', '0.00002', '-lco', 'COORDINATE_PRECISION=5', out, shp]);
    const gj = JSON.parse(await readFile(out, 'utf8'));
    // Find the elevation attribute: the numeric field whose values vary the most.
    const props = gj.features[0]?.properties ?? {};
    const elevField = Object.keys(props).filter(k => typeof props[k] === 'number' && !/^(fid|id|objectid|shape|len)/i.test(k))
      .map(k => ({ k, spread: new Set(gj.features.map(f => f.properties[k])).size })).sort((a, b) => b.spread - a.spread)[0]?.k;
    if (!elevField) { entry.skip = 'no elevation field'; entry.fields = Object.keys(props); continue; }
    const units = /meter|\bm\b/i.test(item.title) ? 'm' : 'ft';
    const features = gj.features.filter(f => f.geometry).map(f => ({ type: 'Feature', properties: { e: +f.properties[elevField] }, geometry: f.geometry }));
    const elevs = features.map(f => f.properties.e);
    let [w, s, e, n] = [180, 90, -180, -90];
    for (const f of features) {
      const coords = f.geometry.type === 'LineString' ? f.geometry.coordinates : f.geometry.coordinates.flat(f.geometry.type === 'MultiPolygon' ? 2 : 1);
      for (const [x, y] of coords) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
    }
    const fileId = slug(item.title);
    const body = JSON.stringify({ type: 'FeatureCollection', features });
    if (body.length > 3e6) { entry.skip = `too large (${body.length})`; continue; }
    await writeFile(new URL(`${fileId}.geojson`, OUT), body);
    index.push({
      id: fileId, title: item.title, source: `https://www.sciencebase.gov/catalog/item/${item.id}`, units, field: elevField,
      minElev: Math.min(...elevs), maxElev: Math.max(...elevs), bbox: [w, s, e, n].map(v => +v.toFixed(5)),
      lat: +((s + n) / 2).toFixed(5), lon: +((w + e) / 2).toFixed(5), bytes: body.length,
    });
    entry.ok = true;
  } catch (e) {
    entry.error = e.message.slice(0, 300);
  }
}

await writeFile(new URL('index.json', OUT), JSON.stringify({ updatedAt: new Date().toISOString(), surveys: index }, null, 1) + '\n');
report.saved = index.length;
await writeFile(new URL('../bathymetry-report.json', OUT), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, items: report.items.length }, null, 2));
