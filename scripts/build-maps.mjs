// Region map packs: fills <CORPUS_DIR>/maps/<region>/<z>/<x>/<y>.png with USGS topo tiles (public domain) so the
// archive can hand a phone a whole region's map in one go (server/serve.mjs serves them; the app's "Your private
// archive" card downloads them into an offline pack). Runs after the nightly corpus build within a time budget and
// resumes the next night from the files already on disk, so the first fill of a big region takes a few nights.
//
//   regions: <CORPUS_DIR>/maps/regions.json when present, else data/maps/regions.json in the repo
//            { regions: [{ id, name, bounds: [west, south, east, north], zMin, zMax }] }   ids [A-Za-z0-9_-], zoom <= 16
//   writes:  maps/<id>/<z>/<x>/<y>.png            one file per tile, written to .tmp and renamed
//            maps/<id>/missing.json               ["z/x/y", …] tiles USGS has no image for (404); never asked again
//            maps/<id>/index.json                 { id, name, bounds, zMin, zMax, tiles, have, missing, bytes, complete, builtAt }
//            maps/index.json                      { builtAt, regions: [ …each region's index… ] }
//   env:     CORPUS_DIR (required)   MAPS_MINUTES (60; 0 = no limit)   MAPS_CONCURRENCY (4)
//            MAPS_TILE_URL (USGS topo template, {z}/{y}/{x} order; tests point it at a local server)
// Exit 1 only when the folder or the regions file is unusable.
import { mkdir, readFile, writeFile, rename, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { tileList, boundsOf } from '../slippy.js';

const ROOT = process.env.CORPUS_DIR;
const MINUTES = Number(process.env.MAPS_MINUTES ?? 60);
if (!Number.isFinite(MINUTES) || MINUTES < 0) { console.error(`MAPS_MINUTES must be a number of minutes (0 = no limit), not "${process.env.MAPS_MINUTES}"`); process.exit(1); }
const CONCURRENCY = Math.max(1, Number(process.env.MAPS_CONCURRENCY) || 4);
const TILE_URL = process.env.MAPS_TILE_URL || 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}';
const UA = 'TackleBoxArchive/1.0 (+https://github.com/mikegutberlet/FishingApp)';
const MAX_ZOOM = 16;

const die = msg => { console.error(msg); process.exit(1); };
if (!ROOT) die('CORPUS_DIR is not set');
const MAPS = path.join(ROOT, 'maps');
const url = t => TILE_URL.replace('{z}', t.z).replace('{x}', t.x).replace('{y}', t.y);
const key = t => `${t.z}/${t.x}/${t.y}`;
const readJson = async (file, fallback) => { try { return JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } };

async function loadRegions() {
  const own = path.join(MAPS, 'regions.json'), repo = new URL('../data/maps/regions.json', import.meta.url);
  let file = own, data;
  try { data = await readJson(own, null); if (!data) { file = repo.pathname; data = JSON.parse(await readFile(repo, 'utf8')); } }
  catch (e) { die(`cannot read ${file}: ${e.message}`); }
  if (!Array.isArray(data?.regions)) die(`${file}: expected { regions: [...] }`);
  for (const r of data.regions) {
    const ok = /^[\w-]+$/.test(r.id ?? '') && Array.isArray(r.bounds) && r.bounds.length === 4 && r.bounds.every(Number.isFinite)
      && r.bounds[0] < r.bounds[2] && r.bounds[1] < r.bounds[3] && Number.isInteger(r.zMin) && Number.isInteger(r.zMax) && 0 <= r.zMin && r.zMin <= r.zMax && r.zMax <= MAX_ZOOM;
    if (!ok) die(`${file}: bad region ${JSON.stringify(r)} (id [A-Za-z0-9_-], bounds [west, south, east, north], 0 <= zMin <= zMax <= ${MAX_ZOOM})`);
  }
  return data.regions;
}

// One tile: fetch, retry once after 2 s, write atomically. Returns 'have' | 'missing' | 'failed'.
async function fetchTile(t, file) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url(t), { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30000) });
      if (r.status === 404) return 'missing';
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      // ArcGIS answers some errors as HTTP 200 with a JSON body: never save one as a tile (it would be served and cached as immutable).
      if (!/^image\//.test(r.headers.get('content-type') ?? '')) throw new Error(`not an image (${r.headers.get('content-type') ?? 'no type'})`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length) throw new Error('empty body');
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file + '.tmp', buf); await rename(file + '.tmp', file);
      return 'have';
    } catch (e) { if (attempt) { console.error(`  ${key(t)}: ${e.message}`); return 'failed'; } await new Promise(r => setTimeout(r, 2000)); }
  }
}

// What's on disk for a region: file count and bytes. Walks maps/<id>/<z>/<x>/ (three levels), ignoring .tmp leftovers.
async function onDisk(dir) {
  let have = 0, bytes = 0;
  for (const z of await readdir(dir).catch(() => [])) {
    if (!/^\d+$/.test(z)) continue;
    for (const x of await readdir(path.join(dir, z)).catch(() => [])) {
      if (!/^\d+$/.test(x)) continue;
      for (const f of await readdir(path.join(dir, z, x)).catch(() => [])) {
        if (!/^\d+\.png$/.test(f)) continue;
        have++; bytes += (await stat(path.join(dir, z, x, f))).size;
      }
    }
  }
  return { have, bytes };
}

async function buildRegion(region, deadline) {
  const dir = path.join(MAPS, region.id);
  await mkdir(dir, { recursive: true });
  const missing = new Set(await readJson(path.join(dir, 'missing.json'), []));
  const all = [...tileList(boundsOf(region.bounds), region.zMin, Math.min(region.zMax, MAX_ZOOM))];
  const todo = [];
  for (const t of all) { if (missing.has(key(t))) continue; try { await stat(path.join(dir, `${key(t)}.png`)); } catch { todo.push(t); } }
  let i = 0, failed = 0, stopped = false;
  const worker = async () => {
    while (i < todo.length) {
      if (deadline && Date.now() > deadline) { stopped = true; return; }
      const t = todo[i++];
      const got = await fetchTile(t, path.join(dir, `${key(t)}.png`));
      if (got === 'missing') missing.add(key(t)); else if (got === 'failed') failed++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
  const sorted = [...missing].sort();
  await writeFile(path.join(dir, 'missing.json'), JSON.stringify(sorted));
  const { have, bytes } = await onDisk(dir);
  const complete = have + sorted.length >= all.length;
  const index = { id: region.id, name: region.name, bounds: region.bounds, zMin: region.zMin, zMax: Math.min(region.zMax, MAX_ZOOM), tiles: all.length, have, missing: sorted.length, bytes, complete, builtAt: new Date().toISOString() };
  await writeFile(path.join(dir, 'index.json'), JSON.stringify(index, null, 1));
  const why = complete ? 'complete' : stopped ? 'budget reached, continues next run' : `${failed} failed, retried next run`;
  console.log(`region "${region.name}": ${have}/${all.length} tiles (${sorted.length} not available), ${Math.round(bytes / 1e6)} MB, ${why}`);
  return { index, stopped };
}

async function main() {
  try { await mkdir(MAPS, { recursive: true }); } catch (e) { die(`cannot create ${MAPS}: ${e.message}`); }
  const regions = await loadRegions();
  const deadline = MINUTES > 0 ? Date.now() + MINUTES * 60000 : 0;
  const out = [];
  for (const region of regions) {
    if (deadline && Date.now() > deadline) {   // out of time: keep the previous index for the rest, if any
      const idx = await readJson(path.join(MAPS, region.id, 'index.json'), null);
      if (idx) out.push(idx); console.log(`region "${region.name}": skipped, budget reached, continues next run`); continue;
    }
    out.push((await buildRegion(region, deadline)).index);
  }
  await writeFile(path.join(MAPS, 'index.json'), JSON.stringify({ builtAt: new Date().toISOString(), regions: out }, null, 1));
}
main().catch(e => die(e.stack ?? String(e)));
