// Map overlays for water safety and access: current toxic algae advisories, and ramps/piers/parking/campgrounds.
// Call addSafetyLayers() once at startup (from app.js).
import * as CA from './states/ca.js';
import { map, layersControl, canvas } from './map.js';
import { esc, fmtDate } from './ui.js';
import { HAB_LEVELS } from './views/tabs/safety.js';
import { ACCESS_KINDS, directionsUrl } from './views/access.js';

const HAB_COLORS = { danger: '#b3261e', warning: '#f28c28', caution: '#f2c94c', awareness: '#6fcf97', reported: '#9aa5ab' };

export function addSafetyLayers() {
  const hab = L.layerGroup();
  const access = L.layerGroup();
  layersControl.addOverlay(hab, 'Toxic algae advisories');
  layersControl.addOverlay(access, 'Ramps & access');
  map.on('overlayadd', e => {
    if (e.layer === hab && !hab.getLayers().length) drawHab(hab);
    if (e.layer === access) drawAccess(access);
  });
  map.on('moveend', () => map.hasLayer(access) && drawAccess(access));
  hab.addTo(map); // on by default: it's safety information
}

let habRetry = 31e3;
async function drawHab(layer) {
  const data = await CA.habAdvisories();
  if (!data) { // offline at startup, or the file failed: try again later (backing off), since the layer is on by default
    setTimeout(() => map.hasLayer(layer) && !layer.getLayers().length && drawHab(layer), habRetry);
    habRetry = Math.min(habRetry * 2, 10 * 60e3);
    return;
  }
  for (const a of data.advisories ?? []) {
    const l = HAB_LEVELS[a.level];
    const big = ['danger', 'warning'].includes(a.level);
    for (const [lat, lon] of a.pts) {
      L.circleMarker([lat, lon], { renderer: canvas, radius: big ? 7 : 5, color: '#fff', weight: 1.5, fillColor: HAB_COLORS[a.level], fillOpacity: 0.95 })
        .bindPopup(`<b>${l.icon} Algae ${esc(l.label.toLowerCase())}</b><br>${esc(a.name)}${a.landmark ? ` · ${esc(a.landmark)}` : ''}<br><span style="font-size:12px">${esc(l.advice)}</span><br>
          <span style="font-size:12px;color:#666">${esc(a.detail)} · updated ${fmtDate(a.date + 'T12:00')}</span><br><a href="${esc(data.portal)}" target="_blank" rel="noopener">HABs portal ↗</a>`)
        .addTo(layer);
    }
  }
}

// Thousands of places statewide, so only the ones in view are drawn, and only when zoomed in.
let places = [];
async function drawAccess(layer) {
  if (!places.length) places = await CA.accessPlaces(); // asks again after a failed load
  layer.clearLayers();
  if (map.getZoom() < 11) return;
  const b = map.getBounds().pad(0.1);
  for (const [lat, lon, kind, name, note] of places) {
    if (!b.contains([lat, lon]) || (kind === 'parking' && map.getZoom() < 14)) continue;
    const k = ACCESS_KINDS[kind];
    L.marker([lat, lon], { icon: L.divIcon({ className: 'acc-icon', html: k.icon, iconSize: [22, 22] }), keyboard: false })
      .bindPopup(`<b>${esc(name || k.label)}</b><br>${k.label}${note ? `<br>${esc(note)}` : ''}<br><a href="${directionsUrl(lat, lon)}" target="_blank" rel="noopener">Directions ↗</a>`)
      .addTo(layer);
  }
}
