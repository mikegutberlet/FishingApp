// Offline lake packs: the map tiles, depth contours and state data a water's page needs, saved on this device so
// the map works with no signal. Each pack is its own cache ("offline-<id>"), which app updates leave alone, and
// sw.js answers tile and data requests from any cache before going to the network.
import { db } from './db.js';
import { forLake } from './states/index.js';
import { $, esc, fmtDate, status, showView, onShow } from './ui.js';
import { map, baseLayers } from './map.js';

const PREFIX = 'offline-';
const META = 'offline-meta.json'; // each pack's cache describes itself at this key
const MAX_TILES = 6000;
const MIN_ZOOM = 10;
// Only the satellite map is downloaded: OpenStreetMap's tile policy doesn't allow bulk or offline prefetching.
// Street tiles you have already looked at stay in sw.js's tile cache.
const MAX_ZOOM = { Satellite: 17 };
const AVG_KB = { Satellite: 20 }; // typical tile size, for the estimate before downloading
// The data files a lake page reads, by state (each state's jobs write data/<st>/).
const SHARED_FILES = ['lakes', 'rivers', 'waters', 'plants', 'reservoirs', 'hydrolakes', 'history'];
const STATE_EXTRAS = { CA: ['hab', 'regs', 'oehha', 'access', 'counties'], NV: ['hab', 'regs', 'advisories', 'counties'],
  OR: ['hab', 'regs', 'advisories', 'counties', 'zones', 'reports'] };
const stateFiles = S => {
  if (!S) return [];
  const dir = `data/${S.code.toLowerCase()}`;
  return [...SHARED_FILES, ...(STATE_EXTRAS[S.code] ?? [])].map(n => `${dir}/${n}.json`).concat(`${dir}/bathymetry/index.json`);
};

// Keyed by the NHD id when the water has one, so saving a water you downloaded before saving keeps its pack.
export const packId = lake => PREFIX + (lake.nhdId ? `nhd-${lake.nhdId}` : lake.id);

// The area to save: the lake's size as a circle (lakes are rarely round, so generously) and its USGS survey, widened
// to take in what you've logged on the water. A logged point counts when it is within ~3 km of that, or within ~3 km
// of another point that counts, so a stretch of river or an arm you logged along is taken in link by link. A point
// away from the rest (a catch logged from home, a stray GPS fix) is left out, so it neither shrinks the zoom range
// nor sends tile requests around a private spot.
async function lakeBounds(lake) {
  const river = lake.kind === 'river' || !!lake.lengthKm;
  const km = river ? 3 : Math.max(0.8, Math.sqrt((lake.acres ?? 40) * 0.004047 / Math.PI) * 2.2);
  const here = L.latLng(lake.lat, lake.lon), core = here.toBounds(km * 2000);
  for (const s of await forLake(lake)?.bathymetryFor(lake).catch(() => []) ?? []) core.extend([[s.bbox[1], s.bbox[0]], [s.bbox[3], s.bbox[2]]]);
  const near = L.latLngBounds(L.latLng(core.getSouth(), core.getWest()).toBounds(6000).getSouthWest(), L.latLng(core.getNorth(), core.getEast()).toBounds(6000).getNorthEast());
  const b = L.latLngBounds(core.getSouthWest(), core.getNorthEast());
  const pts = [];
  if (!lake.unsaved) {
    for (const set of await db.byLake('depthSets', lake.id)) for (let i = 0; i < set.points.length; i += 50) pts.push(set.points[i]);
    for (const store of ['catches', 'waypoints', 'notes']) for (const r of await db.byLake(store, lake.id)) if (r.lat != null) pts.push([r.lat, r.lon]);
  }
  const ok = pts.map(p => [+p?.[0], +p?.[1]]).filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180);
  const kept = ok.filter(p => near.contains(p));
  const far = ok.filter(p => !near.contains(p) && here.distanceTo(p) <= (river ? 25000 : km * 2000 + 5000));
  for (let i = 0; i < kept.length && far.length; i++) for (let j = far.length - 1; j >= 0; j--) if (L.latLng(kept[i]).distanceTo(far[j]) <= 3000) kept.push(...far.splice(j, 1));
  for (const p of kept) b.extend(p);
  return b.pad(0.05);
}

// Slippy-map tile numbers covering a box at one zoom.
function tileRange(b, z) {
  const n = 2 ** z, clamp = v => Math.max(0, Math.min(n - 1, v));
  const x = lon => clamp(Math.floor((lon + 180) / 360 * n));
  const y = lat => { const r = lat * Math.PI / 180; return clamp(Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n)); };
  return { x0: x(b.getWest()), x1: x(b.getEast()), y0: y(b.getNorth()), y1: y(b.getSouth()) };
}
const tilesAt = (b, z) => { const r = tileRange(b, z); return (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1); };

// Zoom range and size for a box and set of layers, dropping the closest zooms until it fits under the cap.
export function plan(bounds, layers) {
  const count = top => layers.reduce((sum, name) => { let n = 0; for (let z = MIN_ZOOM; z <= Math.min(top, MAX_ZOOM[name]); z++) n += tilesAt(bounds, z); return sum + n; }, 0);
  const full = Math.max(...layers.map(n => MAX_ZOOM[n]));
  let zMax = full;
  while (zMax > MIN_ZOOM + 2 && count(zMax) > MAX_TILES) zMax--;
  const tiles = count(zMax);
  const kb = layers.reduce((sum, name) => { let n = 0; for (let z = MIN_ZOOM; z <= Math.min(zMax, MAX_ZOOM[name]); z++) n += tilesAt(bounds, z); return sum + n * AVG_KB[name]; }, 0);
  return { zMin: MIN_ZOOM, zMax, tiles, mb: kb / 1024, capped: zMax < full, tooBig: tiles > MAX_TILES };
}

// The exact URLs Leaflet will ask for, so the service worker finds them (same subdomain rule as L.TileLayer).
function tileUrls(bounds, layers, zMin, zMax) {
  const urls = [];
  for (const name of layers) {
    const layer = baseLayers[name], subs = layer.options.subdomains;
    for (let z = zMin; z <= Math.min(zMax, MAX_ZOOM[name]); z++) {
      const r = tileRange(bounds, z);
      for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) urls.push(L.Util.template(layer._url, { s: subs[Math.abs(x + y) % subs.length], x, y, z, r: '' }));
    }
  }
  return urls;
}

const writeMeta = (cache, pack) => cache.put(META, new Response(JSON.stringify(pack), { headers: { 'content-type': 'application/json' } }));

// Fetches whatever the pack doesn't have yet. Only readable 2xx responses are kept (the tile servers send CORS
// headers), each stored with its size so the pack's total can be summed without reading every body back.
async function download(cache, urls, onProgress, signal, checkpoint) {
  let done = 0, bytes = 0;
  const queue = urls.slice();
  const worker = async () => {
    while (queue.length && !signal.aborted) {
      const url = queue.shift();
      try {
        const have = !url.startsWith('data/') && await cache.match(url); // tiles don't change; the state data does
        if (!have || have.type === 'opaque') {
          // #offline tells sw.js to pass it straight through instead of keeping a second copy in its own caches.
          const r = await fetch(`${url}#offline`, { mode: 'cors', signal });
          if (!r.ok) throw new Error(r.status);
          const blob = await r.blob();
          await cache.put(url, new Response(blob, { headers: { 'content-type': r.headers.get('content-type') || blob.type, 'content-length': String(blob.size) } }));
          bytes += blob.size;
        }
      } catch { /* counted as missing below */ }
      onProgress(++done, urls.length);
      if (done % 250 === 0) await checkpoint(bytes);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
}

// What the pack's cache really holds: total size, and how many of the pack's URLs are still missing.
async function survey(cache, urls) {
  const have = new Set((await cache.keys()).map(r => r.url));
  const sizes = await cache.matchAll();
  const bytes = sizes.reduce((s, r) => s + (+r.headers.get('content-length') || 0), 0);
  return { bytes, missing: urls.filter(u => !have.has(new URL(u, location.href).href)).length };
}

async function readPack(name) {
  if (!(await caches.has(name))) return null; // caches.open would create an empty one
  const r = await (await caches.open(name)).match(META);
  return r ? r.json() : null;
}

export async function listPacks() {
  if (!('caches' in window)) return [];
  const names = (await caches.keys()).filter(k => k.startsWith(PREFIX));
  // A cache with no description is a download that was cut off before it started writing one: list it so it can be deleted.
  return (await Promise.all(names.map(async n => (await readPack(n)) ?? { id: n, name: 'Unfinished download', unknown: true, bytes: 0 })))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const deletePack = id => caches.delete(id);

// ---------- "Save for offline" on a water's page ----------
export async function offlineDialog(lake) {
  if (!('caches' in window)) return alert('This browser can\'t save maps for offline use.');
  const id = packId(lake);
  const existing = await readPack(id);
  const lakeBox = await lakeBounds(lake);
  const dlg = document.createElement('dialog');
  dlg.className = 'sheet';
  dlg.innerHTML = `<form class="form" method="dialog"><h3>Save ${esc(lake.name)} for offline</h3>
    ${existing ? `<p class="small">Saved ${fmtDate(existing.savedAt)} · ${(existing.bytes / 1e6).toFixed(0)} MB · zoom ${existing.zMin}–${existing.zMax}. Downloading again updates it.</p>` : ''}
    <p class="muted small">Saves the satellite map, the USGS depth chart and this app's ${esc(forLake(lake)?.name ?? 'state')} data for the lake on this phone, so the map, depth and stocking work with no signal. Your catches and depth scans are always on the phone already.</p>
    <p class="muted small">The satellite map is saved. The street map can't be downloaded in advance (OpenStreetMap doesn't allow it), but street areas you've already looked at stay cached.</p>
    <label>Area <select name="area"><option value="lake">The whole lake</option><option value="view">What the map shows now</option></select></label>
    <p id="off-est" class="small"></p>
    <progress id="off-progress" max="1" value="0" class="hidden"></progress>
    <div class="row"><button value="cancel" id="off-cancel">Cancel</button><button class="primary" id="off-go" value="go">Download</button></div></form>`;
  document.body.append(dlg);
  const form = dlg.querySelector('form');
  // The map is hidden behind this page, so use the last view it showed (see initOffline), never its current size.
  const view = viewBounds && viewBounds.getNorth() > viewBounds.getSouth() && viewBounds.getEast() > viewBounds.getWest() ? viewBounds : null;
  if (!view) form.area.querySelector('[value=view]').disabled = true;
  // The pack remembers each area it was asked for. An earlier area this one doesn't cover (in extent and zooms) stays
  // on the list, and if an earlier download didn't finish, its missing tiles are fetched too and counted in the estimate.
  const layers = ['Satellite'], box = b => L.latLngBounds([b[0], b[1]], [b[2], b[3]]);
  const areaTiles = a => tileUrls(box(a.bounds), layers, a.zMin, a.zMax);
  // A pack saved before areas were kept: its box, at the zooms plan() allows for that box.
  const earlier = existing?.areas ?? (existing?.bounds ? [{ bounds: existing.bounds, zMin: existing.zMin, zMax: Math.min(existing.zMax, plan(box(existing.bounds), layers).zMax) }] : []);
  const held = existing && !existing.complete ? new Set((await (await caches.open(id)).keys()).map(r => r.url)) : null;
  const choice = () => {
    const bounds = form.area.value === 'view' && view ? view : lakeBox, p = plan(bounds, layers);
    const kept = earlier.filter(a => !(bounds.contains(box(a.bounds)) && p.zMin <= a.zMin && p.zMax >= a.zMax));
    const own = new Set(tileUrls(bounds, layers, p.zMin, p.zMax));
    const left = held ? [...new Set(kept.flatMap(areaTiles))].filter(u => !own.has(u) && !held.has(new URL(u, location.href).href)) : [];
    return { bounds, p, kept, own, left, tooBig: p.tooBig || own.size + left.length > MAX_TILES };
  };
  const estimate = () => {
    const { p, left, tooBig } = choice();
    const more = left.length ? ` Plus ${left.length.toLocaleString()} tiles the last download didn't finish, about ${Math.max(1, Math.round(left.length * AVG_KB.Satellite / 1024))} MB.` : '';
    $('#off-go', dlg).disabled = tooBig;
    $('#off-est', dlg).innerHTML = p.tooBig ? 'That area is too big to save. Zoom the map in on the part you fish and choose <b>What the map shows now</b>.'
      : tooBig ? `That's too much at once with the ${left.length.toLocaleString()} tiles the last download didn't finish. Delete this lake under Data → Offline maps and start again, or choose a smaller area.`
      : `About ${p.tiles.toLocaleString()} map tiles, roughly ${Math.max(1, Math.round(p.mb))} MB, zoom ${p.zMin}–${p.zMax}.${p.capped ? ' Big area, so the closest zoom levels are left out.' : ''}${more}`;
  };
  form.onchange = estimate;
  estimate();
  const abort = new AbortController();
  dlg.onclose = () => { abort.abort(); dlg.remove(); };
  $('#off-go', dlg).onclick = async e => {
    e.preventDefault();
    const { bounds, p, kept, own, left } = choice();
    const S = forLake(lake);
    const surveys = await S?.bathymetryFor(lake).catch(() => []) ?? [];
    const bar = $('#off-progress', dlg);
    bar.classList.remove('hidden');
    form.querySelectorAll('input, select, #off-go').forEach(el => el.disabled = true);
    $('#off-cancel', dlg).textContent = 'Stop';
    // The description is written before the first tile and every 250 tiles, so a download cut off by the phone
    // (iOS stops background pages) still shows up in Data. The final check covers every area the pack holds.
    const here = { bounds: [bounds.getSouth(), bounds.getWest(), bounds.getNorth(), bounds.getEast()], zMin: p.zMin, zMax: p.zMax };
    const areas = [...kept, here];
    const all = areas.reduce((u, a) => u.extend(box(a.bounds)), box(here.bounds));
    const data = [...stateFiles(S), ...surveys.map(s => S.bathymetryUrl(s.id))];
    const urls = [...data, ...new Set(areas.flatMap(areaTiles))];
    const pack = { id, nhdId: lake.nhdId ?? null, lakeId: lake.unsaved ? null : lake.id, name: lake.name, layers, areas,
      zMin: Math.min(...areas.map(a => a.zMin)), zMax: Math.max(...areas.map(a => a.zMax)),
      bounds: [all.getSouth(), all.getWest(), all.getNorth(), all.getEast()], bytes: existing?.bytes ?? 0, complete: false, savedAt: new Date().toISOString() };
    const cache = await caches.open(id);
    const checkpoint = got => writeMeta(cache, Object.assign(pack, { bytes: (existing?.bytes ?? 0) + got, missing: null }));
    await writeMeta(cache, pack);
    await download(cache, [...data, ...own, ...left], (n, total) => { bar.value = n / total; $('#off-est', dlg).textContent = `Downloading ${n.toLocaleString()} of ${total.toLocaleString()}…`; }, abort.signal, checkpoint);
    const { bytes, missing } = await survey(cache, urls);
    Object.assign(pack, { bytes, missing, complete: !missing, savedAt: new Date().toISOString() });
    await writeMeta(cache, pack);
    status(abort.signal.aborted ? 'Offline download stopped; what finished is saved' : `${lake.name} saved for offline${missing ? ` (${missing} tiles failed; download again to retry)` : ''}`);
    if (dlg.open) dlg.close();
  };
  dlg.showModal();
}

// A button for the water's page header.
export function offlineButton(lake) {
  const b = document.createElement('button');
  b.textContent = '⬇ Offline';
  b.onclick = () => offlineDialog(lake);
  return b;
}

// ---------- Offline maps list in the Data view ----------
let outline = null;
async function renderPacks() {
  const el = $('#offline-areas');
  if (!el) return;
  const packs = await listPacks();
  const missing = p => p.missing ?? p.failed; // packs saved before the description tracked what's missing
  el.innerHTML = packs.length ? packs.map(p => `<div class="lake-item" style="margin:6px 0"><div><b>${esc(p.name)}</b><div class="muted small">${p.unknown ? 'Cut off before it finished; delete it and download again'
      : `${fmtDate(p.savedAt)} · ${(p.bytes / 1e6).toFixed(0)} MB · zoom ${esc(p.zMin)}–${esc(p.zMax)}${p.complete ? '' : ' · partial, download again to finish'}${missing(p) ? ` · ${esc(missing(p))} tiles missing` : ''}`}</div></div>
      <div class="acts">${p.bounds ? `<button data-off-show="${esc(p.id)}">Map</button>` : ''}<button class="danger" data-off-del="${esc(p.id)}">✕</button></div></div>`).join('')
      + `<p class="muted small">${packs.length} saved · ${(packs.reduce((s, p) => s + p.bytes, 0) / 1e6).toFixed(0)} MB. Open a water and tap <b>⬇ Offline</b> to add or update one.</p>`
    : '<p class="muted small">No lakes saved for offline yet. Open a water and tap <b>⬇ Offline</b> before you head out: the map, depth chart and stocking data will then work with no signal.</p>';
  el.querySelectorAll('[data-off-show]').forEach(b => b.onclick = () => {
    const p = packs.find(x => x.id === b.dataset.offShow);
    outline?.remove();
    outline = L.rectangle([[p.bounds[0], p.bounds[1]], [p.bounds[2], p.bounds[3]]], { color: '#f2c94c', weight: 2, fill: false, dashArray: '6 4', interactive: false }).addTo(map);
    showView('map');
    map.invalidateSize(); // the map may have measured 0×0 while hidden (a rotation on this page)
    map.fitBounds(outline.getBounds());
    setTimeout(() => { outline?.remove(); outline = null; }, 8000);
  });
  el.querySelectorAll('[data-off-del]').forEach(b => b.onclick = async () => {
    const p = packs.find(x => x.id === b.dataset.offDel);
    if (!confirm(`Delete the offline map for ${p.name}?`)) return;
    await deletePack(p.id);
    renderPacks();
  });
}

// Called once from app.js after every module has loaded (see the note there about import cycles).
// Remembers the last area the map really showed: while a water's page is open the map is hidden, and a rotation then
// makes Leaflet measure it as 0×0, so reading its bounds at download time would give a single point.
let viewBounds = null;
export function initOffline() {
  const remember = () => { const s = map.getSize(); if (s.x && s.y) viewBounds = map.getBounds(); };
  map.on('moveend resize', remember);
  remember();
  onShow('settings', renderPacks);
}
