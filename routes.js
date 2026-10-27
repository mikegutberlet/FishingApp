// GPX routes: a trail or drive you planned in Gaia, CalTopo, AllTrails or onX, brought in to show on the map and to save
// the map along it for no signal (offline.js), and the walk in from Getting there sent the other way. Routes are read
// on the device and stored only here (the `routes` store); a file you export goes only where you send it.
import { db } from './db.js';
import { haversineKm } from './data-sources.js';
import { $, esc, fmtDate, status, showView, onShow } from './ui.js';
import { map, layersControl } from './map.js';

const MAX_POINTS = 5000; // a long recorded track is thinned to this many points: plenty to follow and to save the map along
export const routeLayer = L.layerGroup();
let added = false;

// The routes for a water: saved with it, or with the statewide water it was before you saved it.
export const routesFor = async lake => (await db.all('routes')).filter(r => (!lake.unsaved && r.lakeId === lake.id) || (lake.nhdId && r.nhdId === String(lake.nhdId)));
export const routeKm = pts => pts.reduce((km, p, i) => i ? km + haversineKm(pts[i - 1][0], pts[i - 1][1], p[0], p[1]) : 0, 0);
const mi = km => `${(km * 0.621371).toFixed(km < 16 ? 1 : 0)} mi`;

// Tracks and routes in a GPX file, one entry per track (its segments joined) or route. Waypoints alone aren't a route.
export function parseGpx(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror') || doc.documentElement.localName !== 'gpx') throw new Error('Not a GPX file');
  const kids = (el, name) => [...el.children].filter(c => c.localName === name);
  const nameOf = el => kids(el, 'name')[0]?.textContent.trim() || '';
  const pt = p => { const lat = +p.getAttribute('lat'), lon = +p.getAttribute('lon'), ele = kids(p, 'ele')[0]; return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [+lat.toFixed(6), +lon.toFixed(6), ele && Number.isFinite(+ele.textContent) ? Math.round(+ele.textContent) : null] : null; };
  const out = [];
  for (const t of kids(doc.documentElement, 'trk')) out.push({ name: nameOf(t), points: kids(t, 'trkseg').flatMap(s => kids(s, 'trkpt').map(pt)).filter(Boolean) });
  for (const r of kids(doc.documentElement, 'rte')) out.push({ name: nameOf(r), points: kids(r, 'rtept').map(pt).filter(Boolean) });
  const fileName = kids(doc.documentElement, 'metadata')[0] && nameOf(kids(doc.documentElement, 'metadata')[0]);
  return out.filter(r => r.points.length > 1).map(r => ({ ...r, name: r.name || fileName || '', points: thin(r.points) }));
}
const thin = pts => pts.length <= MAX_POINTS ? pts : pts.filter((_, i) => i % Math.ceil(pts.length / MAX_POINTS) === 0 || i === pts.length - 1);

// A GPX 1.1 file with tracks and waypoints, which Gaia GPS, CalTopo, onX and Google Earth all import.
export function gpxFile(name, { tracks = [], wpts = [] }) {
  const x = s => esc(s ?? '');
  const ele = p => p[2] != null && Number.isFinite(+p[2]) ? `<ele>${+p[2]}</ele>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Tackle Box" xmlns="http://www.topografix.com/GPX/1/1"><metadata><name>${x(name)}</name></metadata>
${wpts.map(w => `<wpt lat="${+w.lat}" lon="${+w.lon}"><name>${x(w.name)}</name>${w.desc ? `<desc>${x(w.desc)}</desc>` : ''}</wpt>`).join('\n')}
${tracks.map(t => `<trk><name>${x(t.name)}</name><trkseg>${t.points.map(p => `<trkpt lat="${+p[0]}" lon="${+p[1]}">${ele(p)}</trkpt>`).join('')}</trkseg></trk>`).join('\n')}
</gpx>`;
}

// Hands a file to the phone's share sheet (Save to Files, AirDrop, open in Gaia) when it can take files, else downloads it.
export async function sendFile(text, fileName, type = 'application/gpx+xml') {
  const file = new File([text], fileName, { type });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: fileName }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60e3);
}
const fileSafe = s => String(s || 'route').replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '');

// The walk in from Getting there as GPX: the line, where to park and start walking, and the water.
export function exportWalkIn(lake, hike) {
  const pts = hike.coords.map(([lat, lon], i) => [lat, lon, null, i]);
  const gpx = gpxFile(`Walk in to ${lake.name}`, {
    tracks: [{ name: `Walk in to ${lake.name}`, points: pts }],
    wpts: [{ name: 'Start walking', lat: hike.start.lat, lon: hike.start.lon, desc: hike.start.road ?? '' }, { name: lake.name, lat: hike.coords.at(-1)[0], lon: hike.coords.at(-1)[1] }],
  });
  return sendFile(gpx, `${fileSafe(lake.name)}-walk-in.gpx`);
}

async function draw() {
  routeLayer.clearLayers();
  for (const r of await db.all('routes')) {
    if (!r.points?.length) continue;
    L.polyline(r.points.map(p => [p[0], p[1]]), { color: '#e53e9b', weight: 4, opacity: 0.9 }).bindPopup(`<b>${esc(r.name || 'Route')}</b><br>${mi(routeKm(r.points))} · GPX route`).addTo(routeLayer);
    L.circleMarker([r.points[0][0], r.points[0][1]], { radius: 5, color: '#fff', weight: 2, fillColor: '#e53e9b', fillOpacity: 1 }).bindTooltip(`Start: ${esc(r.name || 'route')}`).addTo(routeLayer);
  }
}
function ensureLayer() {
  if (!added) { added = true; layersControl.addOverlay(routeLayer, 'Routes'); }
  if (!map.hasLayer(routeLayer)) routeLayer.addTo(map);
}
onShow('map', () => { if (added) draw(); });

// ---------- Routes card on Getting there ----------
export async function renderRoutesCard(lake, el) {
  if (!el) return;
  const list = await routesFor(lake);
  if (!el.isConnected) return;
  el.innerHTML = `<div class="card"><h3>🧭 Your routes</h3>
    ${list.map(r => `<div class="lake-item" style="margin:6px 0"><span><b>${esc(r.name || 'Route')}</b><span class="muted small"> · ${mi(routeKm(r.points))}${r.createdAt ? ` · added ${fmtDate(r.createdAt)}` : ''}</span></span>
      <span class="acts"><button data-rt-map="${esc(r.id)}">Map</button><button data-rt-gpx="${esc(r.id)}">GPX</button><button class="danger" data-rt-del="${esc(r.id)}" aria-label="Delete">✕</button></span></div>`).join('')
      || '<p class="muted small">Planned the trail or the drive in Gaia, CalTopo, AllTrails or onX? Export it there as GPX and bring it in here: it shows on the map, and <b>Ready for no signal</b> saves the topo map along it.</p>'}
    <label class="file-btn rt-import">⬆ Import a GPX route<input type="file" hidden></label></div>`;
  // No accept filter: iPhones grey out .gpx files when one is set, as they have no type for them.
  el.querySelector('.rt-import input').onchange = async e => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const found = parseGpx(await f.text());
      if (!found.length) return alert('No track or route in that file (only waypoints?).');
      for (const r of found.slice(0, 20)) await db.put('routes', { name: r.name || f.name.replace(/\.gpx$/i, ''), points: r.points, lakeId: lake.unsaved ? null : lake.id, nhdId: lake.nhdId ? String(lake.nhdId) : null, source: 'gpx', createdAt: new Date().toISOString() });
      status(`${found.length > 1 ? `${Math.min(found.length, 20)} routes` : 'Route'} added`);
    } catch (err) { alert(`Couldn't read that file: ${err.message}`); }
    renderRoutesCard(lake, el);
  };
  el.querySelectorAll('[data-rt-map]').forEach(b => b.onclick = async () => {
    const r = list.find(x => x.id === b.dataset.rtMap);
    ensureLayer(); await draw();
    showView('map'); map.invalidateSize();
    map.fitBounds(L.latLngBounds(r.points.map(p => [p[0], p[1]])).pad(0.1), { maxZoom: 16 });
  });
  el.querySelectorAll('[data-rt-gpx]').forEach(b => b.onclick = () => {
    const r = list.find(x => x.id === b.dataset.rtGpx);
    sendFile(gpxFile(r.name, { tracks: [{ name: r.name, points: r.points }] }), `${fileSafe(r.name)}.gpx`);
  });
  el.querySelectorAll('[data-rt-del]').forEach(b => b.onclick = async () => {
    const r = list.find(x => x.id === b.dataset.rtDel);
    if (!confirm(`Delete the route ${r.name || ''}?`)) return;
    await db.del('routes', r.id);
    draw(); renderRoutesCard(lake, el);
  });
}

// Called once from app.js: the Routes overlay appears once there's a route to show.
export async function initRoutes() {
  if ((await db.all('routes')).length) { ensureLayer(); draw(); }
}
