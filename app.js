import { db, uid, exportAll, importAll } from './db.js';
import {
  fetchWeather, pressureTrend, fetchUsgsNearby, moonPhase, WEATHER_CODES, compass,
  parseDepthCsv, parseDepthXml, parseStockingCsv,
} from './data-sources.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = iso => iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
const fmtTime = iso => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric' });
const status = msg => { $('#status').textContent = msg; if (msg) setTimeout(() => $('#status').textContent === msg && ($('#status').textContent = ''), 4000); };
const arrow = deg => `<span class="arrow" style="transform:rotate(${deg + 180}deg)">↑</span>`;
const M_TO_FT = 3.28084;

const COMMON_SPECIES = ['Largemouth bass', 'Smallmouth bass', 'Walleye', 'Northern pike', 'Muskellunge', 'Bluegill', 'Black crappie', 'White crappie',
  'Yellow perch', 'Rainbow trout', 'Brown trout', 'Brook trout', 'Lake trout', 'Channel catfish', 'Flathead catfish', 'Striped bass', 'White bass', 'Carp', 'Salmon'];

// ---------- Navigation ----------
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'map') setTimeout(() => map.invalidateSize(), 50);
  if (name === 'lakes') renderLakeList();
  if (name === 'log') renderCatchForm();
  if (name === 'stats') renderStats();
  if (name === 'settings') renderStorageInfo();
}
document.querySelectorAll('nav button').forEach(b => b.onclick = () => showView(b.dataset.view));

// ---------- Map ----------
const map = L.map('map', { zoomControl: false }).setView([44.5, -89.5], 6);
L.control.zoom({ position: 'topleft' }).addTo(map);
const street = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' });
const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Esri' });
satellite.addTo(map);
const lakeLayer = L.layerGroup().addTo(map);
const catchLayer = L.layerGroup().addTo(map);
const depthLayer = L.layerGroup().addTo(map);
L.control.layers({ Satellite: satellite, Streets: street }, { Lakes: lakeLayer, Catches: catchLayer, Depth: depthLayer }).addTo(map);
const canvas = L.canvas({ padding: 0.3 });

let picking = null; // callback when the user is choosing a point on the map
map.on('click', e => { if (picking) { const cb = picking; picking = null; cb(e.latlng); } });

$('#btn-locate').onclick = () => locate().then(p => map.setView([p.lat, p.lon], 14)).catch(e => status(e.message));
$('#btn-add-lake').onclick = () => {
  status('Tap the map where the lake/river is');
  picking = ({ lat, lng }) => editLake({ lat, lon: lng });
};

function locate() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('No GPS available'));
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      () => reject(new Error('Location permission denied')), { enableHighAccuracy: true, timeout: 15000 });
  });
}

async function refreshMap() {
  lakeLayer.clearLayers(); catchLayer.clearLayers();
  for (const lake of await db.all('lakes')) {
    L.marker([lake.lat, lake.lon], { title: lake.name }).addTo(lakeLayer)
      .bindPopup(`<b>${esc(lake.name)}</b><br><a href="#" data-open-lake="${lake.id}">Open</a>`);
  }
  for (const c of await db.all('catches')) {
    if (c.lat == null) continue;
    L.circleMarker([c.lat, c.lon], { radius: 6, color: '#fff', weight: 2, fillColor: '#f28c28', fillOpacity: 1 }).addTo(catchLayer)
      .bindPopup(`<b>${esc(c.species)}</b> ${c.length ? c.length + '"' : ''} ${c.weight ? c.weight + ' lb' : ''}<br>${fmtDate(c.time)}${c.lure ? '<br>' + esc(c.lure) : ''}`);
  }
}
document.addEventListener('click', e => {
  const id = e.target.dataset?.openLake;
  if (id) { e.preventDefault(); openLake(id); }
});

// Depth colors: shallow = light, deep = dark blue.
function depthColor(d, max) {
  const t = Math.min(1, d / (max || 1));
  const stops = [[200, 240, 255], [90, 180, 230], [30, 110, 190], [15, 50, 120], [5, 15, 60]];
  const x = t * (stops.length - 1), i = Math.floor(x), f = x - i, a = stops[i], b = stops[Math.min(i + 1, stops.length - 1)];
  return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * f)).join(',')})`;
}

async function showDepthSet(setId) {
  const set = await db.get('depthSets', setId);
  depthLayer.clearLayers();
  const max = Math.max(...set.points.map(p => p[2]));
  for (const [lat, lon, d] of set.points) {
    L.circleMarker([lat, lon], { renderer: canvas, radius: 4, stroke: false, fillColor: depthColor(d, max), fillOpacity: 0.85 })
      .bindTooltip(`${d.toFixed(1)} ft`).addTo(depthLayer);
  }
  const legend = $('#depth-legend');
  const grad = [0, .25, .5, .75, 1].map(t => depthColor(t * max, max)).join(',');
  legend.innerHTML = `<b>${esc(set.name)}</b><div class="bar" style="background:linear-gradient(90deg,${grad})"></div>0 ft <span style="float:right">${max.toFixed(0)} ft</span><br><a href="#" id="hide-depth">Hide</a>`;
  legend.classList.remove('hidden');
  $('#hide-depth').onclick = e => { e.preventDefault(); depthLayer.clearLayers(); legend.classList.add('hidden'); };
  showView('map');
  map.fitBounds(L.latLngBounds(set.points.map(p => [p[0], p[1]])));
}

// ---------- Lakes ----------
async function renderLakeList() {
  $('#lake-detail').classList.add('hidden');
  const list = $('#lake-list');
  list.classList.remove('hidden');
  const lakes = (await db.all('lakes')).sort((a, b) => a.name.localeCompare(b.name));
  list.innerHTML = `<h2>Lakes & rivers</h2>` + (lakes.length ? '' : `<div class="card muted">No waters yet. Use “＋ Lake here” on the map to add one.</div>`)
    + lakes.map(l => `<div class="card lake-item" data-id="${l.id}"><div><b>${esc(l.name)}</b><div class="muted small">${esc(l.type)}${l.county ? ' · ' + esc(l.county) : ''}${l.state ? ', ' + esc(l.state) : ''}</div></div><span>›</span></div>`).join('');
  list.querySelectorAll('.lake-item').forEach(el => el.onclick = () => openLake(el.dataset.id));
}

function editLake(lake) {
  showView('lakes');
  $('#lake-list').classList.add('hidden');
  const d = $('#lake-detail');
  d.classList.remove('hidden');
  d.innerHTML = `<button id="back">‹ Back</button><h2>${lake.id ? 'Edit' : 'New'} lake / river</h2>
    <form class="card form" id="lake-form">
      <label>Name <input name="name" required value="${esc(lake.name)}"></label>
      <div class="row"><label>Type <select name="type">${['Lake', 'Reservoir', 'River', 'Stream', 'Pond'].map(t => `<option ${lake.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label>State <input name="state" maxlength="2" value="${esc(lake.state)}" placeholder="WI"></label></div>
      <label>County <input name="county" value="${esc(lake.county)}"></label>
      <div class="row"><label>Acres <input name="acres" type="number" value="${esc(lake.acres)}"></label>
        <label>Max depth (ft) <input name="maxDepth" type="number" value="${esc(lake.maxDepth)}"></label></div>
      <label>Water clarity (ft) <input name="clarity" type="number" step="0.5" value="${esc(lake.clarity)}"></label>
      <label>Species present <input name="species" value="${esc(lake.species)}" placeholder="Walleye, Northern pike, Bluegill"></label>
      <label>Regulations / limits <textarea name="regs" rows="2">${esc(lake.regs)}</textarea></label>
      <label>Access / launches <textarea name="access" rows="2">${esc(lake.access)}</textarea></label>
      <label>State lake page (DNR) URL <input name="infoUrl" type="url" value="${esc(lake.infoUrl)}"></label>
      <label>Stocking report URL <input name="stockingUrl" type="url" value="${esc(lake.stockingUrl)}"></label>
      <label>USGS gauge id (optional, pins a specific gauge) <input name="usgsSite" value="${esc(lake.usgsSite)}"></label>
      <div class="row"><label>Lat <input name="lat" type="number" step="any" required value="${lake.lat ?? ''}"></label>
        <label>Lon <input name="lon" type="number" step="any" required value="${lake.lon ?? ''}"></label></div>
      <button class="primary">Save</button>
    </form>${lake.id ? '<button class="danger" id="del-lake">Delete this lake and everything logged on it</button>' : ''}`;
  $('#back').onclick = () => lake.id ? openLake(lake.id) : renderLakeList();
  $('#lake-form').onsubmit = async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const saved = await db.put('lakes', { ...lake, ...f, lat: +f.lat, lon: +f.lon });
    await refreshMap();
    openLake(saved.id);
  };
  const del = $('#del-lake');
  if (del) del.onclick = async () => {
    if (!confirm(`Delete ${lake.name} and all its catches, notes, stocking and depth data?`)) return;
    for (const s of ['catches', 'notes', 'stocking', 'depthSets']) for (const r of await db.byLake(s, lake.id)) await db.del(s, r.id);
    await db.del('lakes', lake.id);
    await refreshMap();
    renderLakeList();
  };
}

const LAKE_TABS = { conditions: 'Conditions', depth: 'Depth', stocking: 'Stocking', catches: 'Catches', notes: 'Notes', info: 'Info' };

async function openLake(id, tab = 'conditions') {
  const lake = await db.get('lakes', id);
  showView('lakes');
  $('#lake-list').classList.add('hidden');
  const d = $('#lake-detail');
  d.classList.remove('hidden');
  d.innerHTML = `<button id="back">‹ All waters</button> <button id="edit">Edit</button> <button id="center">Map</button>
    <h2>${esc(lake.name)}</h2>
    <div class="tabs">${Object.entries(LAKE_TABS).map(([k, v]) => `<button data-tab="${k}" class="${k === tab ? 'active' : ''}">${v}</button>`).join('')}</div>
    <div id="tab-body"></div>`;
  $('#back').onclick = renderLakeList;
  $('#edit').onclick = () => editLake(lake);
  $('#center').onclick = () => { showView('map'); map.setView([lake.lat, lake.lon], 14); };
  d.querySelectorAll('.tabs button').forEach(b => b.onclick = () => openLake(id, b.dataset.tab));
  const body = $('#tab-body');
  await ({ conditions: renderConditions, depth: renderDepth, stocking: renderStocking, catches: renderLakeCatches, notes: renderNotes, info: renderInfo })[tab](lake, body);
}

async function renderConditions(lake, body) {
  const moon = moonPhase();
  body.innerHTML = `<div class="card" id="wx">Loading weather…</div><div class="card" id="water">Looking for USGS gauges…</div>
    <div class="card"><h3>Windy</h3>
      <iframe class="windy" loading="lazy" src="https://embed.windy.com/embed2.html?lat=${lake.lat}&lon=${lake.lon}&detailLat=${lake.lat}&detailLon=${lake.lon}&zoom=10&level=surface&overlay=wind&product=ecmwf&menu=&message=true&marker=true&calendar=now&pressure=true&type=map&location=coordinates&detail=true&metricWind=mph&metricTemp=%C2%B0F"></iframe>
      <p class="small"><a href="https://www.windy.com/${lake.lat.toFixed(3)}/${lake.lon.toFixed(3)}?${lake.lat.toFixed(3)},${lake.lon.toFixed(3)},11" target="_blank" rel="noopener">Open in Windy (uses your Premium login)</a>
      · <a href="https://myradar.com/" target="_blank" rel="noopener">Open MyRadar</a></p></div>`;
  try {
    const w = await fetchWeather(lake.lat, lake.lon);
    if (!body.isConnected) return; // user moved on before the forecast arrived
    const c = w.current, trend = pressureTrend(w);
    const now = Date.parse(c.time);
    const hours = w.hourly.time.map((t, i) => ({ t, i })).filter(({ t }) => Date.parse(t) >= now).slice(0, 24);
    $('#wx').innerHTML = `<h3>Now · ${WEATHER_CODES[c.weather_code] ?? ''}</h3>
      <div class="grid">
        <div class="stat"><b>${Math.round(c.temperature_2m)}°F</b><span>Feels ${Math.round(c.apparent_temperature)}°</span></div>
        <div class="stat"><b>${arrow(c.wind_direction_10m)} ${Math.round(c.wind_speed_10m)} mph</b><span>${compass(c.wind_direction_10m)}, gusts ${Math.round(c.wind_gusts_10m)}</span></div>
        <div class="stat"><b>${(c.pressure_msl * 0.02953).toFixed(2)}"</b><span>Pressure${trend ? ` · ${trend.label}` : ''}</span></div>
        <div class="stat"><b>${c.cloud_cover}%</b><span>Cloud cover</span></div>
        <div class="stat"><b>${moon.illumination}%</b><span>${moon.name}</span></div>
        <div class="stat"><b>☀ ${fmtTime(w.daily.sunrise[1])}</b><span>Sunset ${fmtTime(w.daily.sunset[1])}</span></div>
      </div>
      <h3 style="margin-top:12px">Next 24 hours</h3>
      <div class="hours">${hours.map(({ t, i }) => `<div class="hour">${fmtTime(t)}<br><b>${Math.round(w.hourly.temperature_2m[i])}°</b><br>${arrow(w.hourly.wind_direction_10m[i])} ${Math.round(w.hourly.wind_speed_10m[i])}<br><span class="muted">g${Math.round(w.hourly.wind_gusts_10m[i])}</span><br>${w.hourly.precipitation_probability[i] ?? 0}%💧</div>`).join('')}</div>
      <h3 style="margin-top:12px">7 days</h3>
      <table>${w.daily.time.slice(1).map((t, j) => { const i = j + 1; return `<tr><td>${new Date(t + 'T12:00').toLocaleDateString(undefined, { weekday: 'short' })}</td><td>${WEATHER_CODES[w.daily.weather_code[i]] ?? ''}</td><td>${Math.round(w.daily.temperature_2m_min[i])}–${Math.round(w.daily.temperature_2m_max[i])}°</td><td>${arrow(w.daily.wind_direction_10m_dominant[i])} ${Math.round(w.daily.wind_speed_10m_max[i])} (g${Math.round(w.daily.wind_gusts_10m_max[i])})</td><td>${w.daily.precipitation_probability_max[i] ?? 0}%</td></tr>`; }).join('')}</table>
      <p class="muted small">Open-Meteo forecast · moon phase computed on device</p>`;
  } catch (e) { if (body.isConnected) $('#wx').textContent = `Weather: ${e.message} (offline?)`; }
  try {
    let sites = await fetchUsgsNearby(lake.lat, lake.lon);
    if (!body.isConnected) return;
    if (lake.usgsSite) sites = sites.filter(s => s.id === lake.usgsSite).concat(sites.filter(s => s.id !== lake.usgsSite));
    $('#water').innerHTML = `<h3>Water (USGS)</h3>` + (sites.length ? sites.slice(0, 3).map(s => `<p><b>${esc(s.name)}</b> <span class="muted small">#${s.id} · ${s.distKm.toFixed(1)} km</span><br>
      ${s.readings.map(r => r.code === '00010' ? `Water temp: <b>${(r.value * 9 / 5 + 32).toFixed(1)}°F</b>` : `${esc(r.name.split(',')[0])}: <b>${r.value} ${esc(r.unit)}</b>`).join('<br>')}
      <br><span class="muted small">${fmtDate(s.readings[0].time)} ${fmtTime(s.readings[0].time)}</span></p>`).join('') : '<p class="muted">No active gauges nearby. Common for natural lakes; rivers and reservoirs usually have one.</p>');
  } catch (e) { if (body.isConnected) $('#water').textContent = `USGS: ${e.message}`; }
}

async function renderDepth(lake, body) {
  const sets = await db.byLake('depthSets', lake.id);
  body.innerHTML = `<div class="card"><h3>Depth maps</h3>
    <p class="small">Import soundings from your Deeper (Fish Deeper → Lakebook → export) or any sonar: CSV with latitude, longitude and depth columns, or GPX/KML.</p>
    <form class="form" id="depth-form"><div class="row"><label>Units in file <select name="units"><option value="ft">Feet</option><option value="m">Meters</option></select></label>
      <label>Name <input name="name" placeholder="Spring 2026 scan"></label></div>
      <label class="file-btn">Choose file… <input type="file" name="file" accept=".csv,.txt,.gpx,.kml" hidden></label></form>
    ${lake.maxDepth ? `<p class="muted small">Recorded max depth: ${esc(lake.maxDepth)} ft</p>` : ''}</div>
    ${sets.map(s => `<div class="card lake-item"><div><b>${esc(s.name)}</b><div class="muted small">${s.points.length.toLocaleString()} points · max ${Math.max(...s.points.map(p => p[2])).toFixed(1)} ft · ${fmtDate(s.createdAt)}</div></div>
      <div><button data-show="${s.id}">Show</button> <button class="danger" data-del="${s.id}">✕</button></div></div>`).join('')}`;
  body.querySelector('input[type=file]').onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    const f = Object.fromEntries(new FormData($('#depth-form')));
    try {
      const text = await file.text();
      const { points, unitHint } = /\.(gpx|kml)$/i.test(file.name) ? parseDepthXml(text) : parseDepthCsv(text);
      const meters = f.units === 'm' || /\(m\)|_m$|meter/.test(unitHint);
      if (meters) for (const p of points) p[2] *= M_TO_FT;
      await db.put('depthSets', { lakeId: lake.id, name: f.name || file.name, points, createdAt: new Date().toISOString() });
      status(`Imported ${points.length.toLocaleString()} depth points`);
      openLake(lake.id, 'depth');
    } catch (err) { alert(err.message); }
  };
  body.querySelectorAll('[data-show]').forEach(b => b.onclick = () => showDepthSet(b.dataset.show));
  body.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { if (confirm('Delete this depth map?')) { await db.del('depthSets', b.dataset.del); openLake(lake.id, 'depth'); } });
}

async function renderStocking(lake, body) {
  const rows = (await db.byLake('stocking', lake.id)).sort((a, b) => b.date.localeCompare(a.date));
  const byYear = {};
  for (const r of rows) { const y = r.date.slice(0, 4); byYear[y] ??= {}; byYear[y][r.species] = (byYear[y][r.species] || 0) + (r.count || 0); }
  const years = Object.keys(byYear).sort();
  const yearTotals = years.map(y => [y, Object.values(byYear[y]).reduce((a, b) => a + b, 0)]);
  const maxTotal = Math.max(1, ...yearTotals.map(t => t[1]));
  body.innerHTML = `<div class="card"><h3>Stocking history</h3>
      ${lake.stockingUrl ? `<p class="small"><a href="${esc(lake.stockingUrl)}" target="_blank" rel="noopener">Latest state stocking report ↗</a></p>` : '<p class="muted small">Add your state’s stocking report link under Edit.</p>'}
      ${years.length ? `<div class="bars">${yearTotals.map(([y, t]) => `<div class="barrow"><span class="lbl">${y}</span><div class="fill" style="width:${t / maxTotal * 70}%"></div><span>${t.toLocaleString()}</span></div>`).join('')}</div>` : '<p class="muted">No stocking records yet.</p>'}
    </div>
    <form class="card form" id="stock-form"><h3>Add a stocking event</h3>
      <div class="row"><label>Date <input name="date" type="date" required></label><label>Species <input name="species" list="species-list" required></label></div>
      <div class="row"><label>Number <input name="count" type="number"></label><label>Size <input name="size" placeholder="fingerling, 7 in…"></label></div>
      <button class="primary">Add</button>
      <label class="file-btn" style="margin-top:8px">Import CSV (date, species, number, size) <input type="file" accept=".csv" hidden id="stock-csv"></label>
    </form>
    ${rows.length ? `<div class="card"><table><tr><th>Date</th><th>Species</th><th>Number</th><th>Size</th><th></th></tr>
      ${rows.map(r => `<tr><td>${esc(r.date)}</td><td>${esc(r.species)}</td><td>${r.count?.toLocaleString() ?? ''}</td><td>${esc(r.size)}</td><td><a href="#" data-del="${r.id}">✕</a></td></tr>`).join('')}</table></div>` : ''}`;
  $('#stock-form').onsubmit = async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    await db.put('stocking', { lakeId: lake.id, ...f, count: f.count ? +f.count : null });
    openLake(lake.id, 'stocking');
  };
  $('#stock-csv').onchange = async e => {
    try {
      const recs = parseStockingCsv(await e.target.files[0].text());
      for (const r of recs) await db.put('stocking', { lakeId: lake.id, ...r });
      status(`Imported ${recs.length} stocking records`);
      openLake(lake.id, 'stocking');
    } catch (err) { alert(err.message); }
  };
  body.querySelectorAll('[data-del]').forEach(a => a.onclick = async e => { e.preventDefault(); await db.del('stocking', a.dataset.del); openLake(lake.id, 'stocking'); });
}

async function renderLakeCatches(lake, body) {
  const catches = (await db.byLake('catches', lake.id)).sort((a, b) => b.time.localeCompare(a.time));
  body.innerHTML = `<button class="primary" id="log-here">＋ Log a catch here</button><div id="lc" style="margin-top:12px"></div>`;
  $('#log-here').onclick = () => { showView('log'); $('#catch-form').lakeId.value = lake.id; };
  renderCatchCards(catches, $('#lc'));
}

async function renderNotes(lake, body) {
  const notes = (await db.byLake('notes', lake.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  body.innerHTML = `<form class="card form" id="note-form"><label>New note <textarea name="text" rows="4" required placeholder="Weed edge on the north bay held fish at 12 ft…"></textarea></label>
    <div class="row"><button type="button" id="note-pin">📍 Pin to a spot</button><span id="note-loc" class="muted small"></span></div>
    <button class="primary" style="margin-top:8px">Save note</button></form>
    ${notes.map(n => `<div class="card"><div class="muted small">${fmtDate(n.createdAt)}${n.lat ? ` · <a href="#" data-goto="${n.lat},${n.lon}">spot</a>` : ''} · <a href="#" data-del="${n.id}">delete</a></div><div style="white-space:pre-wrap">${esc(n.text)}</div></div>`).join('')}`;
  let loc = null;
  $('#note-pin').onclick = () => {
    showView('map'); map.setView([lake.lat, lake.lon], 14); status('Tap the spot');
    picking = ({ lat, lng }) => { loc = { lat, lon: lng }; showView('lakes'); $('#note-loc').textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`; };
  };
  $('#note-form').onsubmit = async e => {
    e.preventDefault();
    await db.put('notes', { lakeId: lake.id, text: e.target.text.value, createdAt: new Date().toISOString(), ...loc });
    openLake(lake.id, 'notes');
  };
  body.querySelectorAll('[data-del]').forEach(a => a.onclick = async e => { e.preventDefault(); await db.del('notes', a.dataset.del); openLake(lake.id, 'notes'); });
  body.querySelectorAll('[data-goto]').forEach(a => a.onclick = e => { e.preventDefault(); const [la, lo] = a.dataset.goto.split(','); showView('map'); map.setView([+la, +lo], 17); L.popup().setLatLng([+la, +lo]).setContent('Note spot').openOn(map); });
}

function renderInfo(lake, body) {
  const field = (k, v) => v ? `<tr><th>${k}</th><td>${esc(v)}</td></tr>` : '';
  body.innerHTML = `<div class="card"><table>
    ${field('Type', lake.type)}${field('State', lake.state)}${field('County', lake.county)}${field('Acres', lake.acres)}
    ${field('Max depth (ft)', lake.maxDepth)}${field('Clarity (ft)', lake.clarity)}${field('Species', lake.species)}
    ${field('Regulations', lake.regs)}${field('Access', lake.access)}${field('Coordinates', `${lake.lat.toFixed(5)}, ${lake.lon.toFixed(5)}`)}
  </table>${lake.infoUrl ? `<p><a href="${esc(lake.infoUrl)}" target="_blank" rel="noopener">State lake page ↗</a></p>` : ''}
  <p class="muted small">Tap Edit to fill in details from your state DNR lake page.</p></div>`;
}

// ---------- Catch log ----------
async function renderCatchForm() {
  const lakes = (await db.all('lakes')).sort((a, b) => a.name.localeCompare(b.name));
  const form = $('#catch-form');
  const current = form.lakeId.value;
  form.lakeId.innerHTML = lakes.length ? lakes.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('') : '<option value="">Add a lake first (Map → ＋ Lake here)</option>';
  if (current) form.lakeId.value = current;
  if (!form.time.value) form.time.value = localNow();
  const catches = (await db.all('catches')).sort((a, b) => b.time.localeCompare(a.time));
  renderCatchCards(catches.slice(0, 20), $('#catch-list'), lakes);
  $('#lure-list').innerHTML = [...new Set(catches.map(c => c.lure).filter(Boolean))].map(l => `<option value="${esc(l)}">`).join('');
}
const localNow = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

$('#btn-gps').onclick = () => locate().then(p => { const f = $('#catch-form'); f.lat.value = p.lat.toFixed(6); f.lon.value = p.lon.toFixed(6); }).catch(e => status(e.message));

$('#catch-form').onsubmit = async e => {
  e.preventDefault();
  const form = e.target;
  const f = Object.fromEntries(new FormData(form));
  if (!f.lakeId) return alert('Add a lake first');
  const lake = await db.get('lakes', f.lakeId);
  const num = k => f[k] === '' ? null : +f[k];
  const record = {
    lakeId: f.lakeId, species: f.species.trim(), time: new Date(f.time).toISOString(),
    length: num('length'), weight: num('weight'), depth: num('depth'), waterTemp: num('waterTemp'),
    lure: f.lure.trim(), technique: f.technique.trim(), notes: f.notes.trim(), released: !!f.released,
    lat: f.lat ? +f.lat : lake.lat, lon: f.lon ? +f.lon : lake.lon,
    photo: form.photo.files[0] ? await shrinkPhoto(form.photo.files[0]) : null,
    moon: moonPhase(new Date(f.time)).name,
  };
  // Snapshot conditions when logging within a few hours of the catch.
  if (Math.abs(Date.now() - Date.parse(record.time)) < 3 * 3600e3) {
    try {
      const w = await fetchWeather(record.lat, record.lon);
      record.conditions = { airTemp: w.current.temperature_2m, wind: w.current.wind_speed_10m, windDir: w.current.wind_direction_10m, gusts: w.current.wind_gusts_10m,
        pressureInHg: +(w.current.pressure_msl * 0.02953).toFixed(2), pressureTrend: pressureTrend(w)?.label, sky: WEATHER_CODES[w.current.weather_code], cloud: w.current.cloud_cover };
    } catch { /* offline on the water: save without conditions */ }
  }
  await db.put('catches', record);
  form.reset(); form.lakeId.value = record.lakeId; form.time.value = localNow();
  status('Catch saved 🎣');
  await refreshMap();
  renderCatchForm();
};

// Keep photos small so IndexedDB and backups stay manageable.
async function shrinkPhoto(file, maxDim = 1600) {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
}

async function renderCatchCards(catches, el, lakes) {
  lakes ??= await db.all('lakes');
  const lakeName = Object.fromEntries(lakes.map(l => [l.id, l.name]));
  el.innerHTML = catches.length ? '' : '<div class="card muted">No catches yet.</div>';
  for (const c of catches) {
    const card = document.createElement('div');
    card.className = 'card catch';
    const cond = c.conditions;
    card.innerHTML = `${c.photo ? `<img src="${URL.createObjectURL(c.photo)}" alt="">` : ''}<div style="flex:1">
      <b>${esc(c.species)}</b> ${c.length ? `${c.length}"` : ''} ${c.weight ? `${c.weight} lb` : ''} ${c.released ? '<span class="muted small">released</span>' : ''}
      <div class="muted small">${esc(lakeName[c.lakeId] || '')} · ${fmtDate(c.time)} ${fmtTime(c.time)}</div>
      <div class="small">${[c.lure, c.technique, c.depth != null && `${c.depth} ft`, c.waterTemp != null && `water ${c.waterTemp}°F`].filter(Boolean).map(esc).join(' · ')}</div>
      ${cond ? `<div class="muted small">${Math.round(cond.airTemp)}°F · ${compass(cond.windDir)} ${Math.round(cond.wind)} mph · ${cond.pressureInHg}" ${cond.pressureTrend ?? ''} · ${esc(cond.sky)} · ${esc(c.moon)}</div>` : ''}
      ${c.notes ? `<div class="small" style="white-space:pre-wrap">${esc(c.notes)}</div>` : ''}
      <a href="#" class="small danger" data-del>delete</a></div>`;
    card.querySelector('[data-del]').onclick = async e => {
      e.preventDefault();
      if (!confirm('Delete this catch?')) return;
      await db.del('catches', c.id); card.remove(); refreshMap();
    };
    el.append(card);
  }
}

// ---------- Stats ----------
async function renderStats() {
  const [catches, lakes] = await Promise.all([db.all('catches'), db.all('lakes')]);
  const el = $('#stats');
  if (!catches.length) { el.innerHTML = '<div class="card muted">Log some catches to see patterns.</div>'; return; }
  const count = (arr, key) => Object.entries(arr.reduce((m, c) => { const k = key(c); if (k != null && k !== '') m[k] = (m[k] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]);
  const bars = (title, rows) => { const max = Math.max(...rows.map(r => r[1])); return `<div class="card"><h3>${title}</h3><div class="bars">${rows.slice(0, 10).map(([k, v]) => `<div class="barrow"><span class="lbl">${esc(k)}</span><div class="fill" style="width:${v / max * 60}%"></div><span>${v}</span></div>`).join('')}</div></div>`; };
  const lakeName = Object.fromEntries(lakes.map(l => [l.id, l.name]));
  const biggest = [...catches].filter(c => c.length).sort((a, b) => b.length - a.length)[0];
  el.innerHTML = `<div class="card grid">
      <div class="stat"><b>${catches.length}</b><span>Fish logged</span></div>
      <div class="stat"><b>${new Set(catches.map(c => c.species)).size}</b><span>Species</span></div>
      <div class="stat"><b>${biggest ? biggest.length + '"' : '–'}</b><span>Longest${biggest ? ' · ' + esc(biggest.species) : ''}</span></div>
      <div class="stat"><b>${Math.round(catches.filter(c => c.released).length / catches.length * 100)}%</b><span>Released</span></div>
    </div>
    ${bars('By species', count(catches, c => c.species))}
    ${bars('By lake', count(catches, c => lakeName[c.lakeId]))}
    ${bars('Best lures', count(catches, c => c.lure))}
    ${bars('Hour of day', count(catches, c => new Date(c.time).getHours()).sort((a, b) => a[0] - b[0]).map(([h, v]) => [`${h}:00`, v]))}
    ${bars('Pressure trend', count(catches, c => c.conditions?.pressureTrend))}
    ${bars('Moon phase', count(catches, c => c.moon))}
    ${bars('Depth (ft)', count(catches, c => c.depth == null ? null : `${Math.floor(c.depth / 5) * 5}–${Math.floor(c.depth / 5) * 5 + 5}`))}`;
}

// ---------- Backup ----------
$('#btn-export').onclick = async () => {
  const data = await exportAll();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  a.download = `tackle-box-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
};
$('#import-file').onchange = async e => {
  try {
    const data = JSON.parse(await e.target.files[0].text());
    const replace = confirm('Replace everything on this device with the backup? (Cancel = merge)');
    await importAll(data, { replace });
    await refreshMap();
    status('Backup imported');
  } catch (err) { alert(err.message); }
};
async function renderStorageInfo() {
  const counts = await Promise.all(['lakes', 'catches', 'notes', 'stocking', 'depthSets'].map(s => db.all(s).then(r => `${r.length} ${s === 'depthSets' ? 'depth maps' : s}`)));
  const est = await navigator.storage?.estimate?.();
  const persisted = await navigator.storage?.persisted?.();
  $('#storage-info').textContent = `${counts.join(' · ')}${est ? ` · ${(est.usage / 1e6).toFixed(1)} MB used` : ''}${persisted ? ' · protected from browser cleanup' : ''}`;
}

// ---------- Startup ----------
$('#species-list').innerHTML = COMMON_SPECIES.map(s => `<option value="${s}">`).join('');
navigator.storage?.persist?.(); // ask the browser not to evict our data
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js');
refreshMap().then(async () => {
  const lakes = await db.all('lakes');
  if (lakes.length) map.fitBounds(L.latLngBounds(lakes.map(l => [l.lat, l.lon])).pad(0.3), { maxZoom: 13 });
});
window.__app = { db, openLake, showView }; // handy for debugging from the console
