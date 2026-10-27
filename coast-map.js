// Map overlays for the ocean: piers, jetties and surf beaches (tap one for its page, like a lake), and marine
// protected areas colored by what you may take. Call initCoastMap() once at startup (from app.js).
import { map, layersControl, canvas, onWaterTap } from './map.js';
import { coastSpots, mpas, COAST_KINDS } from './coast.js';
import { mpaType } from './ocean-rules.js';
import { esc } from './ui.js';

const TAKE_COLOR = { none: '#c62828', some: '#f2a33a' };
// A rough line down the CA and OR coast (and around SF Bay), close enough to tell whether the map shows the coast.
const COASTLINE = (() => {
  const pts = [[46.25, -124.0], [45.5, -123.95], [44.6, -124.07], [43.4, -124.3], [42.0, -124.2], [41.0, -124.12], [40.4, -124.4], [39.4, -123.8], [38.3, -123.05],
    [37.8, -122.51], [37.85, -122.3], [38.05, -122.25], [37.6, -122.15], [37.8, -122.51], [37.2, -122.4], [36.95, -121.95], [36.6, -121.9], [35.7, -121.3], [35.2, -120.8],
    [34.45, -120.45], [34.4, -119.7], [34.0, -118.5], [33.75, -118.4], [33.6, -117.9], [33.2, -117.4], [32.53, -117.12]];
  const out = [];
  for (let i = 1; i < pts.length; i++) for (let k = 0; k < 10; k++) { const [a, b] = [pts[i - 1], pts[i]]; out.push([a[0] + (b[0] - a[0]) * k / 10, a[1] + (b[1] - a[1]) * k / 10]); }
  return out;
})();
export const spotsLayer = L.layerGroup(), mpaLayer = L.layerGroup();

export function initCoastMap() {
  layersControl.addOverlay(spotsLayer, 'Piers & surf spots');
  layersControl.addOverlay(mpaLayer, 'Marine protected areas');
  map.on('overlayadd', e => {
    if (e.layer === spotsLayer) drawSpots();
    if (e.layer === mpaLayer) drawMpas();
  });
  map.on('moveend', () => map.hasLayer(spotsLayer) && drawSpots());
  // On by default once you're looking at the coast: a pier is a water like any lake, and MPAs are safety (no-take) lines.
  const coastInView = () => map.getZoom() >= 9 && COASTLINE.some(p => map.getBounds().contains(p));
  const auto = () => {
    if (!coastInView()) return;
    map.off('moveend', auto);
    if (!map.hasLayer(spotsLayer)) spotsLayer.addTo(map);
    if (!map.hasLayer(mpaLayer)) mpaLayer.addTo(map);
  };
  map.on('moveend', auto);
  map.whenReady(auto);
}

// Spots in view, zoomed in to 10 or closer (a few thousand along the coast).
async function drawSpots() {
  const all = await coastSpots();
  spotsLayer.clearLayers();
  if (map.getZoom() < 10) return;
  const b = map.getBounds().pad(0.1), z = map.getZoom();
  for (const s of all) {
    if (!b.contains([s.lat, s.lon])) continue;
    if (z < 12 && (s.coastKind === 'beach' || s.coastKind === 'spot')) continue; // piers and jetties first
    const k = COAST_KINDS[s.coastKind] ?? COAST_KINDS.spot;
    L.marker([s.lat, s.lon], { icon: L.divIcon({ className: `oc-pin oc-${s.coastKind}`, html: `<span>${k.icon}</span>${z >= 13 ? `<b>${esc(s.name)}</b>` : ''}`, iconSize: null }), title: s.name, keyboard: false })
      .on('click', () => onWaterTap(s)).addTo(spotsLayer);
  }
}

let mpaDrawn = false;
async function drawMpas() {
  if (mpaDrawn) return;
  const list = await mpas();
  if (!list.length) return;
  mpaDrawn = true;
  for (const a of list) {
    const t = mpaType(a.key), color = TAKE_COLOR[t.take] ?? TAKE_COLOR.some;
    const latlngs = a.polys.map(rings => rings.map(ring => ring.map(([x, y]) => [y, x])));
    L.polygon(latlngs, { renderer: canvas, color, weight: 1.5, fillColor: color, fillOpacity: t.take === 'none' ? 0.22 : 0.12 })
      .bindPopup(`<b>${t.take === 'none' ? '⛔ ' : ''}${esc(a.name)}</b><br>${esc(t.label)}<br><span style="font-size:12px">${esc(t.note)}</span>${a.url ? `<br><a href="${esc(a.url)}" target="_blank" rel="noopener">Rules for this area ↗</a>` : ''}<br><span style="font-size:11px;color:#666">${a.state === 'CA' ? 'CDFW' : 'ODFW'} boundary, not for navigation</span>`)
      .addTo(mpaLayer);
  }
}
