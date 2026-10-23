// Waypoints: structure, brush piles, drop-offs, hazards, ramps and spots you mark on the map. Stored only on this
// device; Share includes them only when you choose to share your notes and spots.
import { db } from './db.js';
import { haversineKm } from './data-sources.js';
import { $, esc, fmtDate, status, showView, onShow } from './ui.js';
import { map, layersControl, pickPoint, locate } from './map.js';

export const KINDS = {
  spot: ['⭐', 'Spot'], structure: ['🪨', 'Structure'], brush: ['🌿', 'Brush pile'], dropoff: ['📉', 'Drop-off'], hazard: ['⚠️', 'Hazard'], ramp: ['🚤', 'Ramp'],
};
const kind = w => KINDS[w.kind] ?? KINDS.spot;
export const waypointLayer = L.layerGroup();

export async function refreshWaypoints() {
  waypointLayer.clearLayers();
  for (const w of await db.all('waypoints')) {
    const icon = L.divIcon({ className: 'wpt', html: `<span title="${esc(w.name || kind(w)[1])}">${kind(w)[0]}</span>`, iconSize: [28, 28], iconAnchor: [14, 14] });
    L.marker([w.lat, w.lon], { icon, keyboard: false }).bindPopup(() => popup(w)).addTo(waypointLayer);
  }
}

function popup(w) {
  const el = document.createElement('div');
  el.innerHTML = `<b>${kind(w)[0]} ${esc(w.name || kind(w)[1])}</b><div class="muted small">${esc(kind(w)[1])} · ${fmtDate(w.createdAt)}</div>${w.note ? `<div style="white-space:pre-wrap">${esc(w.note)}</div>` : ''}
    <div class="muted small">${w.lat.toFixed(5)}, ${w.lon.toFixed(5)}</div><a href="#" data-a="edit">Edit</a> · <a href="#" data-a="del">Delete</a>`;
  el.querySelector('[data-a=edit]').onclick = e => { e.preventDefault(); map.closePopup(); editWaypoint(w); };
  el.querySelector('[data-a=del]').onclick = async e => { e.preventDefault(); if (!confirm('Delete this waypoint?')) return; await db.del('waypoints', w.id); map.closePopup(); refreshWaypoints(); };
  return el;
}

// The saved water a point belongs to: the closest one, if it's near enough to plausibly be on it.
async function nearestLake(lat, lon) {
  let best = null, bestKm = Infinity;
  for (const l of await db.all('lakes')) {
    const km = haversineKm(lat, lon, l.lat, l.lon), reach = Math.max(2, Math.sqrt((l.acres ?? 100) / 247) * 3);
    if (km <= reach && km < bestKm) { best = l; bestKm = km; }
  }
  return best;
}

// Add or edit a waypoint. Opens a sheet; the location comes from GPS or a tap on the map.
export async function editWaypoint(w = {}) {
  const lakes = (await db.all('lakes')).sort((a, b) => a.name.localeCompare(b.name));
  let loc = w.lat != null ? { lat: w.lat, lon: w.lon } : null;
  const draft = { kind: 'spot', ...w };
  if (!draft.id && draft.lakeId === undefined && loc) draft.lakeId = (await nearestLake(loc.lat, loc.lon))?.id ?? '';
  const dlg = document.createElement('dialog');
  dlg.className = 'sheet';
  dlg.innerHTML = `<form class="form" method="dialog"><h3>${w.id ? 'Edit waypoint' : 'New waypoint'}</h3>
    <div class="kinds">${Object.entries(KINDS).map(([k, [icon, label]]) => `<label><input type="radio" name="kind" value="${k}" ${draft.kind === k ? 'checked' : ''}><span>${icon}<br>${label}</span></label>`).join('')}</div>
    <label>Name <input name="name" value="${esc(draft.name ?? '')}" placeholder="Rock pile off the point"></label>
    <label>Note <textarea name="note" rows="2" placeholder="Holds bass at 14 ft in summer">${esc(draft.note ?? '')}</textarea></label>
    <label>Water <select name="lakeId"><option value="">None</option>${lakes.map(l => `<option value="${esc(l.id)}" ${draft.lakeId === l.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>
    <div class="row"><button type="button" id="wpt-gps">📍 My location</button><button type="button" id="wpt-tap">Tap the map</button></div>
    <p id="wpt-loc" class="muted small"></p>
    <div class="row"><button type="button" id="wpt-cancel">Cancel</button><button class="primary" id="wpt-save" value="save">Save</button></div></form>`;
  document.body.append(dlg);
  const form = dlg.querySelector('form');
  const showLoc = () => { $('#wpt-loc', dlg).textContent = loc ? `${loc.lat.toFixed(5)}, ${loc.lon.toFixed(5)}` : 'Set the location with GPS or a tap on the map.'; $('#wpt-save', dlg).disabled = !loc; };
  const setLoc = async p => {
    loc = p;
    if (!form.lakeId.value) { const l = await nearestLake(p.lat, p.lon); if (l) form.lakeId.value = l.id; }
    showLoc();
  };
  showLoc();
  let picking = false;
  dlg.onclose = () => { if (!picking) dlg.remove(); };
  $('#wpt-cancel', dlg).onclick = () => dlg.close(); // not a submit button, so Enter in Name saves instead of cancelling
  $('#wpt-gps', dlg).onclick = () => { $('#wpt-loc', dlg).textContent = 'Finding you…'; locate().then(setLoc).catch(e => { $('#wpt-loc', dlg).textContent = e.message; }); };
  $('#wpt-tap', dlg).onclick = () => {
    // Hide the sheet while the user picks, then bring it back with the spot filled in. While picking, labels and
    // markers let taps through to the map (maps.css), and leaving the map from the bottom bar drops the pick.
    picking = true; dlg.close();
    showView('map', { render: false });
    map.invalidateSize(); // render:false skips map.js's resize, and the hidden map may have measured 0×0
    if (loc) map.panTo([loc.lat, loc.lon]);
    status('Tap the spot for the waypoint');
    const box = map.getContainer(), nav = document.querySelector('nav');
    const finish = () => { box.classList.remove('picking'); nav.removeEventListener('click', abandon, true); picking = false; status(''); };
    const abandon = () => { pickPoint(null); finish(); dlg.remove(); };
    box.classList.add('picking');
    nav.addEventListener('click', abandon, true);
    pickPoint(({ lat, lng }) => { finish(); dlg.showModal(); setLoc({ lat, lon: lng }); });
  };
  $('#wpt-save', dlg).onclick = async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    await db.put('waypoints', { ...w, kind: f.kind, name: f.name.trim(), note: f.note.trim(), lakeId: f.lakeId || null, lat: loc.lat, lon: loc.lon, createdAt: w.createdAt ?? new Date().toISOString() });
    dlg.close();
    status('Waypoint saved');
    if (!map.hasLayer(waypointLayer)) waypointLayer.addTo(map);
    await refreshWaypoints();
    onSaved?.();
  };
  dlg.showModal();
}
let onSaved = null; // lets the Depth tab redraw its list after an edit

// GPX for chartplotters, Navionics, Google Earth and the like. The user chooses where it goes.
export function waypointsGpx(list, name) {
  const x = s => esc(s ?? '');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Tackle Box" xmlns="http://www.topografix.com/GPX/1/1"><metadata><name>${x(name)}</name></metadata>
${list.map(w => `<wpt lat="${+w.lat}" lon="${+w.lon}">${w.createdAt ? `<time>${x(w.createdAt)}</time>` : ''}<name>${x(w.name || kind(w)[1])}</name>${w.note ? `<desc>${x(w.note)}</desc>` : ''}<type>${x(kind(w)[1])}</type></wpt>`).join('\n')}
</gpx>`;
}

// ---------- Waypoints card on a lake's Depth tab ----------
export async function renderWaypointCard(lake, el, redraw) {
  const list = (await db.byLake('waypoints', lake.id)).sort((a, b) => (a.kind + a.name).localeCompare(b.kind + b.name));
  onSaved = () => el.offsetParent && redraw(); // only while this tab is on screen
  el.innerHTML = `<div class="card"><h3>Waypoints</h3>
    ${list.map(w => `<div class="lake-item" style="margin:6px 0"><span>${kind(w)[0]} <b>${esc(w.name || kind(w)[1])}</b>${w.note ? `<span class="muted small"> · ${esc(w.note)}</span>` : ''}</span>
      <span class="acts"><button data-wgo="${esc(w.id)}">Map</button><button data-wedit="${esc(w.id)}">Edit</button></span></div>`).join('') || '<p class="muted small">Mark structure, brush piles, drop-offs, hazards and ramps. Long-press the map, or use 📌 on the map.</p>'}
    <div class="row" style="margin-top:8px"><button id="wpt-add">＋ Add waypoint</button>${list.length ? '<button id="wpt-gpx">⬇ GPX</button>' : ''}</div></div>`;
  $('#wpt-add', el).onclick = () => editWaypoint({ lakeId: lake.id });
  el.querySelectorAll('[data-wedit]').forEach(b => b.onclick = () => editWaypoint(list.find(w => w.id === b.dataset.wedit)));
  el.querySelectorAll('[data-wgo]').forEach(b => b.onclick = () => {
    const w = list.find(x => x.id === b.dataset.wgo);
    if (!map.hasLayer(waypointLayer)) waypointLayer.addTo(map);
    showView('map'); map.setView([w.lat, w.lon], 17);
  });
  const gpx = $('#wpt-gpx', el);
  if (gpx) gpx.onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([waypointsGpx(list, lake.name)], { type: 'application/gpx+xml' }));
    a.download = `${lake.name.replace(/[^\w-]+/g, '-')}-waypoints.gpx`;
    a.click();
  };
}

// Called once from app.js after every module has loaded (see the note there about import cycles).
export function initWaypoints() {
  waypointLayer.addTo(map);
  layersControl.addOverlay(waypointLayer, 'Waypoints');
  refreshWaypoints();
  onShow('map', refreshWaypoints); // picks up waypoints from an imported backup or shared lake
  // Long-press (or right-click) on the map drops a waypoint there. An app added to the iPhone home screen drops
  // "Safari" from its user agent, so Leaflet leaves its long-press emulation off there: turn it on.
  if (L.Browser.touchNative && L.Browser.mobile && 'standalone' in navigator && !map.tapHold?.enabled()) map.tapHold?.enable();
  map.on('contextmenu', e => editWaypoint({ lat: e.latlng.lat, lon: e.latlng.lng }));
  $('#btn-waypoint').onclick = () => editWaypoint();
}
