// The map: base layers, overlays, statewide water labels, your lakes and catches, and depth display.
import { db } from './db.js';
import * as CA from './states/ca.js';
import { $, esc, fmtDate, status, M_TO_FT, showView, onShow } from './ui.js';
import { openWater } from './views/lake.js';
import { editLake } from './views/lakes.js';

export const map = L.map('map', { zoomControl: false }).setView([44.5, -89.5], 6);
L.control.zoom({ position: 'topleft' }).addTo(map);
const street = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' });
const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Esri' });
satellite.addTo(map);
export const baseLayers = { Satellite: satellite, Streets: street };
const lakeLayer = L.layerGroup().addTo(map);
const catchLayer = L.layerGroup().addTo(map);
export const depthLayer = L.layerGroup().addTo(map);
const stockedLayer = L.layerGroup();
const watersLayer = L.layerGroup().addTo(map);
// Other modules add their own overlays with layersControl.addOverlay(layer, 'Name').
export const layersControl = L.control.layers({ Satellite: satellite, Streets: street }, { 'California waters': watersLayer, 'My lakes': lakeLayer, Catches: catchLayer, Depth: depthLayer, 'CA stocked waters': stockedLayer }).addTo(map);
map.on('overlayadd', async e => {
  if (e.layer !== stockedLayer || stockedLayer.getLayers().length) return;
  const recent = Date.now() - 30 * 864e5;
  for (const w of await CA.waters()) {
    const fresh = w.lastPlant && Date.parse(w.lastPlant) > recent;
    L.circleMarker([w.lat, w.lon], { renderer: canvas, radius: fresh ? 6 : 4, color: '#fff', weight: 1, fillColor: fresh ? '#2fbf71' : '#8aa4b0', fillOpacity: 0.9 })
      .bindPopup(`<b>${esc(w.name)}</b><br>${esc(w.counties)}<br>${w.lastPlant ? `Last plant: week of ${fmtDate(w.lastPlant)} (${esc(w.plants[0].species)})` : `Last stocked ${w.lastYearStocked ?? '?'}`}<br><a href="#" data-add-water="${w.id}">Add to my lakes</a>`)
      .addTo(stockedLayer);
  }
});
export const canvas = L.canvas({ padding: 0.3 });

let picking = null, cancelPick = null; // callback when the user is choosing a point on the map, and what to run if that pick is dropped
export const pickPoint = (cb, onCancel = null) => { const c = cancelPick; picking = cb; cancelPick = onCancel; c?.(); };
map.on('click', e => {
  if (picking) { const cb = picking; picking = null; cancelPick = null; cb(e.latlng); return; }
  const w = nearestLabeledWater(e.latlng);
  if (w) openWater(w);
});

// ---------- Statewide labels: every named California lake and river ----------
export let statewide = null;
let shownWaters = [];
CA.statewide().then(d => { statewide = d; drawWaterLabels(); });
map.on('moveend', drawWaterLabels);
map.on('overlayadd overlayremove', drawWaterLabels);

// Show bigger waters first as you zoom out, every named one when zoomed in close.
// Labels that would overlap an already placed one are skipped, and a river gets one label per view when zoomed out.
function drawWaterLabels() {
  watersLayer.clearLayers();
  shownWaters = [];
  if (!statewide || !map.hasLayer(watersLayer)) return;
  const z = map.getZoom();
  if (z < 7) return;
  const minAcres = z >= 12 ? 0 : z >= 11 ? 20 : z >= 10 ? 80 : z >= 9 ? 300 : z >= 8 ? 1500 : 6000;
  const b = map.getBounds().pad(0.05);
  const center = map.getCenter();
  const lakes = statewide.lakes.filter(l => l.acres >= minAcres && b.contains([l.lat, l.lon]));
  let rivers = statewide.riverLabels.filter(r => (z >= 11 || (r.type === 'River' && (z >= 9 || r.km >= 150))) && b.contains([r.lat, r.lon]));
  if (z < 12) {
    const best = new Map();
    for (const r of rivers) {
      const d = Math.hypot(r.lat - center.lat, r.lon - center.lng);
      if (!best.has(r.id) || d < best.get(r.id).d) best.set(r.id, { r, d });
    }
    rivers = [...best.values()].map(x => x.r);
  }
  const placed = [];
  const fits = (w, px) => {
    const box = { x1: px.x - w.name.length * 3.4, x2: px.x + w.name.length * 3.4, y1: px.y - 8, y2: px.y + 8 };
    if (placed.some(p => box.x1 < p.x2 && box.x2 > p.x1 && box.y1 < p.y2 && box.y2 > p.y1)) return false;
    placed.push(box);
    return true;
  };
  const candidates = [...lakes.sort((a, b) => b.acres - a.acres), ...rivers.sort((a, b) => b.km - a.km)];
  for (const w of candidates) {
    if (shownWaters.length >= 400) break;
    if (!fits(w, map.latLngToContainerPoint([w.lat, w.lon]))) continue;
    shownWaters.push(w);
    const label = L.divIcon({ className: `wlabel ${w.kind}`, html: `<span>${esc(w.name)}</span>`, iconSize: null });
    L.marker([w.lat, w.lon], { icon: label, keyboard: false }).on('click', () => openWater(w)).addTo(watersLayer);
  }
}

// A tap on open water picks the closest labeled lake or river within ~40 px.
function nearestLabeledWater(latlng) {
  const p = map.latLngToContainerPoint(latlng);
  let best = null, bestD = 40;
  for (const w of shownWaters) {
    const d = p.distanceTo(map.latLngToContainerPoint([w.lat, w.lon]));
    if (d < bestD) { bestD = d; best = w; }
  }
  return best;
}


$('#btn-locate').onclick = () => locate().then(p => map.setView([p.lat, p.lon], 14)).catch(e => status(e.message));
$('#btn-add-lake').onclick = () => {
  status('Tap the map where the lake/river is');
  pickPoint(({ lat, lng }) => editLake({ lat, lon: lng }));
};

export function locate() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('No GPS available'));
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      () => reject(new Error('Location permission denied')), { enableHighAccuracy: true, timeout: 15000 });
  });
}

export async function refreshMap() {
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

// Depth colors: shallow = light, deep = dark blue.
export function depthColor(d, max) {
  const t = Math.min(1, d / (max || 1));
  const stops = [[200, 240, 255], [90, 180, 230], [30, 110, 190], [15, 50, 120], [5, 15, 60]];
  const x = t * (stops.length - 1), i = Math.floor(x), f = x - i, a = stops[i], b = stops[Math.min(i + 1, stops.length - 1)];
  return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * f)).join(',')})`;
}

export async function showDepthSet(setId) {
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

// Contour surveys store elevations; depth = surface elevation - contour elevation.
export async function showSurvey(survey, lake) {
  const [gj, res] = await Promise.all([fetch(CA.bathymetryUrl(survey.id)).then(r => r.json()), CA.nearestReservoir(lake.lat, lake.lon, lake.cdecStation, { name: lake.name, acres: lake.acres })]);
  const toFt = survey.units === 'm' ? M_TO_FT : 1;
  const current = res?.elevation?.at(-1)?.[1];
  // Only trust the CDEC level if it falls within the survey's range (same datum, same lake).
  const surfaceFt = current && current > survey.minElev * toFt && current < survey.maxElev * toFt + 30 ? current : survey.maxElev * toFt;
  const maxDepth = surfaceFt - survey.minElev * toFt;
  depthLayer.clearLayers();
  L.geoJSON(gj, {
    filter: f => f.properties.e * toFt <= surfaceFt,
    style: f => ({ color: depthColor(surfaceFt - f.properties.e * toFt, maxDepth), weight: 1.5, opacity: 0.9, fill: false }),
    onEachFeature: (f, layer) => layer.bindTooltip(`${Math.round(surfaceFt - f.properties.e * toFt)} ft deep`, { sticky: true }),
  }).addTo(depthLayer);
  const legend = $('#depth-legend');
  const grad = [0, .25, .5, .75, 1].map(t => depthColor(t * maxDepth, maxDepth)).join(',');
  legend.innerHTML = `<b>${esc(lake.name)} contours</b><div class="bar" style="background:linear-gradient(90deg,${grad})"></div>0 ft <span style="float:right">${Math.round(maxDepth)} ft</span>
    <div class="muted" style="font-size:11px">${surfaceFt === current ? `At today's level, ${Math.round(current)} ft (CDEC ${esc(res.id)})` : 'At full pool'} · USGS survey</div><a href="#" id="hide-depth">Hide</a>`;
  legend.classList.remove('hidden');
  $('#hide-depth').onclick = e => { e.preventDefault(); depthLayer.clearLayers(); legend.classList.add('hidden'); };
  if (!map.hasLayer(depthLayer)) depthLayer.addTo(map);
  showView('map');
  map.fitBounds([[survey.bbox[1], survey.bbox[0]], [survey.bbox[3], survey.bbox[2]]]);
}

onShow('map', () => setTimeout(() => map.invalidateSize(), 50));
