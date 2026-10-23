// Offline lake packs: the map tiles, depth contours and state data a water's page needs, saved on this device so
// the map works with no signal. Each pack is its own cache ("offline-<id>"), which app updates leave alone, and
// sw.js answers tile and data requests from any cache before going to the network.
import { db } from './db.js';
import * as CA from './states/ca.js';
import { $, esc, fmtDate, status, showView, onShow } from './ui.js';
import { map, baseLayers } from './map.js';

const PREFIX = 'offline-';
const META = 'offline-meta.json'; // each pack's cache describes itself at this key
const MAX_TILES = 6000;
const MIN_ZOOM = 10;
// OpenStreetMap's tile policy forbids bulk downloads at zoom 17 and up, so street tiles stop at 16.
const MAX_ZOOM = { Satellite: 17, Streets: 16 };
const AVG_KB = { Satellite: 20, Streets: 12 }; // typical tile size, for the estimate before downloading
const STATE_FILES = ['lakes', 'rivers', 'waters', 'plants', 'reservoirs', 'hydrolakes', 'history'].map(n => `data/ca/${n}.json`).concat('data/ca/bathymetry/index.json');

const packId = lake => PREFIX + (lake.id && !lake.unsaved ? lake.id : `nhd-${lake.nhdId}`);

// The area to save: the lake's size as a circle (lakes are rarely round, so generously), widened to cover its
// USGS survey and everything you've logged there.
async function lakeBounds(lake) {
  const km = lake.kind === 'river' || lake.lengthKm ? 3 : Math.max(0.8, Math.sqrt((lake.acres ?? 40) * 0.004047 / Math.PI) * 2.2);
  const b = L.latLng(lake.lat, lake.lon).toBounds(km * 2000);
  for (const s of await CA.bathymetryFor(lake).catch(() => [])) b.extend([[s.bbox[1], s.bbox[0]], [s.bbox[3], s.bbox[2]]]);
  if (!lake.unsaved) {
    for (const set of await db.byLake('depthSets', lake.id)) for (let i = 0; i < set.points.length; i += 50) b.extend([set.points[i][0], set.points[i][1]]);
    for (const store of ['catches', 'waypoints', 'notes']) for (const r of await db.byLake(store, lake.id)) if (r.lat != null) b.extend([r.lat, r.lon]);
  }
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

async function download(pack, urls, onProgress, signal) {
  const cache = await caches.open(pack.id);
  let done = 0, bytes = 0, failed = 0;
  const queue = urls.slice();
  const worker = async () => {
    while (queue.length && !signal.aborted) {
      const url = queue.shift();
      try {
        const have = !url.startsWith('data/') && await cache.match(url); // tiles don't change; the state data does
        if (have) bytes += +(have.headers.get('content-length') || 0);
        else {
          // Tile servers send CORS headers, which lets us see the size; fall back to an opaque copy if one doesn't.
          // #offline tells sw.js to pass it straight through instead of keeping a second copy in its own caches.
          const r = await fetch(`${url}#offline`, { mode: 'cors' }).catch(() => fetch(`${url}#offline`, { mode: 'no-cors' }));
          if (!r.ok && r.type !== 'opaque') throw new Error(r.status);
          const blob = r.type === 'opaque' ? null : await r.clone().blob();
          await cache.put(url, r);
          bytes += blob ? blob.size : 15e3;
        }
      } catch { failed++; }
      onProgress(++done, urls.length);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return { bytes, failed, done };
}

async function readPack(name) {
  const r = await (await caches.open(name)).match(META);
  return r ? r.json() : null;
}

export async function listPacks() {
  if (!('caches' in window)) return [];
  const names = (await caches.keys()).filter(k => k.startsWith(PREFIX));
  return (await Promise.all(names.map(readPack))).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
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
  const active = map.hasLayer(baseLayers.Streets) ? 'Streets' : 'Satellite';
  dlg.innerHTML = `<form class="form" method="dialog"><h3>Save ${esc(lake.name)} for offline</h3>
    ${existing ? `<p class="small">Saved ${fmtDate(existing.savedAt)} · ${(existing.bytes / 1e6).toFixed(0)} MB · zoom ${existing.zMin}–${existing.zMax}. Downloading again updates it.</p>` : ''}
    <p class="muted small">Saves the map, the USGS depth chart and this app's California data for the lake on this phone, so the map, depth and stocking work with no signal. Your catches and depth scans are always on the phone already.</p>
    <label class="check"><input type="checkbox" name="Satellite" ${active === 'Satellite' || existing?.layers.includes('Satellite') ? 'checked' : ''}> Satellite map</label>
    <label class="check"><input type="checkbox" name="Streets" ${active === 'Streets' || existing?.layers.includes('Streets') ? 'checked' : ''}> Street map</label>
    <label>Area <select name="area"><option value="lake">The whole lake</option><option value="view">What the map shows now</option></select></label>
    <p id="off-est" class="small"></p>
    <progress id="off-progress" max="1" value="0" class="hidden"></progress>
    <div class="row"><button value="cancel" id="off-cancel">Cancel</button><button class="primary" id="off-go" value="go">Download</button></div></form>`;
  document.body.append(dlg);
  const form = dlg.querySelector('form');
  const choice = () => {
    const layers = ['Satellite', 'Streets'].filter(n => form[n].checked);
    const bounds = form.area.value === 'view' ? map.getBounds() : lakeBox;
    return { layers, bounds, plan: layers.length ? plan(bounds, layers) : null };
  };
  const estimate = () => {
    const { plan: p } = choice();
    $('#off-go', dlg).disabled = !p || p.tooBig;
    $('#off-est', dlg).innerHTML = !p ? 'Pick at least one map.'
      : p.tooBig ? 'That area is too big to save. Zoom the map in on the part you fish and choose <b>What the map shows now</b>.'
      : `About ${p.tiles.toLocaleString()} map tiles, roughly ${Math.max(1, Math.round(p.mb))} MB, zoom ${p.zMin}–${p.zMax}.${p.capped ? ' Big area, so the closest zoom levels are left out.' : ''}`;
  };
  form.onchange = estimate;
  estimate();
  const abort = new AbortController();
  dlg.onclose = () => { abort.abort(); dlg.remove(); };
  $('#off-go', dlg).onclick = async e => {
    e.preventDefault();
    const { layers, bounds, plan: p } = choice();
    const surveys = await CA.bathymetryFor(lake).catch(() => []);
    const urls = [...STATE_FILES, ...surveys.map(s => CA.bathymetryUrl(s.id)), ...tileUrls(bounds, layers, p.zMin, p.zMax)];
    const bar = $('#off-progress', dlg);
    bar.classList.remove('hidden');
    form.querySelectorAll('input, select, #off-go').forEach(el => el.disabled = true);
    $('#off-cancel', dlg).textContent = 'Stop';
    const pack = { id, lakeId: lake.unsaved ? null : lake.id, nhdId: lake.nhdId ?? null, name: lake.name, layers, zMin: p.zMin, zMax: p.zMax,
      bounds: [bounds.getSouth(), bounds.getWest(), bounds.getNorth(), bounds.getEast()] };
    const result = await download(pack, urls, (n, total) => { bar.value = n / total; $('#off-est', dlg).textContent = `Downloading ${n.toLocaleString()} of ${total.toLocaleString()}…`; }, abort.signal);
    if (abort.signal.aborted && !result.done) return;
    Object.assign(pack, { bytes: result.bytes, tiles: urls.length, failed: result.failed, complete: !abort.signal.aborted, savedAt: new Date().toISOString() });
    await (await caches.open(id)).put(META, new Response(JSON.stringify(pack), { headers: { 'content-type': 'application/json' } }));
    status(abort.signal.aborted ? 'Offline download stopped; what finished is saved' : `${lake.name} saved for offline${result.failed ? ` (${result.failed} tiles failed; download again to retry)` : ''}`);
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
  el.innerHTML = packs.length ? packs.map(p => `<div class="lake-item" style="margin:6px 0"><div><b>${esc(p.name)}</b><div class="muted small">${fmtDate(p.savedAt)} · ${(p.bytes / 1e6).toFixed(0)} MB · ${p.layers.join(' + ')} · zoom ${p.zMin}–${p.zMax}${p.complete ? '' : ' · partial'}${p.failed ? ` · ${p.failed} missing` : ''}</div></div>
      <div class="acts"><button data-off-show="${esc(p.id)}">Map</button><button class="danger" data-off-del="${esc(p.id)}">✕</button></div></div>`).join('')
      + `<p class="muted small">${packs.length} saved · ${(packs.reduce((s, p) => s + p.bytes, 0) / 1e6).toFixed(0)} MB. Open a water and tap <b>⬇ Offline</b> to add or update one.</p>`
    : '<p class="muted small">No lakes saved for offline yet. Open a water and tap <b>⬇ Offline</b> before you head out: the map, depth chart and stocking data will then work with no signal.</p>';
  el.querySelectorAll('[data-off-show]').forEach(b => b.onclick = () => {
    const p = packs.find(x => x.id === b.dataset.offShow);
    outline?.remove();
    outline = L.rectangle([[p.bounds[0], p.bounds[1]], [p.bounds[2], p.bounds[3]]], { color: '#f2c94c', weight: 2, fill: false, dashArray: '6 4', interactive: false }).addTo(map);
    showView('map');
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
onShow('settings', renderPacks);
