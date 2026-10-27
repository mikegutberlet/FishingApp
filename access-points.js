// Map overlay "Trailheads & parking": trailheads, car parks, toilets and taps from OpenStreetMap for the area on
// screen, looked up when the overlay is on and you're zoomed in far enough (only the map's bounds are sent).
// Getting there's "Show on map" adds the points it already has. See access-more.js.
import { map, layersControl } from './map.js';
import { esc } from './ui.js';
import { overpassPoints, POINT_KIND } from './access-more.js';

const layer = L.layerGroup();
const seen = new Set();
const MIN_ZOOM = 12;
let added = false, timer = null, busy = false, lastBox = null;

const popup = p => `<b>${POINT_KIND[p.kind].icon} ${esc(p.name || POINT_KIND[p.kind].label)}</b>${p.name ? `<br>${POINT_KIND[p.kind].label}` : ''}${p.facts.length ? `<br>${esc(p.facts.join(' · '))}` : ''}
  <br><a href="https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lon}" target="_blank" rel="noopener">Directions ↗</a> · <a href="${esc(p.source.url)}" target="_blank" rel="noopener">OpenStreetMap ↗</a>`;
function add(points) {
  for (const p of points) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    L.marker([p.lat, p.lon], { icon: L.divIcon({ className: 'acc-icon', html: POINT_KIND[p.kind].icon, iconSize: [22, 22] }), keyboard: false, title: p.name ?? POINT_KIND[p.kind].label }).bindPopup(popup(p)).addTo(layer);
  }
}

// Inside the last box looked up: nothing new to fetch.
const inside = (b, box) => box && b.getSouth() >= box[0] && b.getWest() >= box[1] && b.getNorth() <= box[2] && b.getEast() <= box[3];
async function load() {
  if (!map.hasLayer(layer) || map.getZoom() < MIN_ZOOM || busy || navigator.onLine === false) return;
  const b = map.getBounds();
  if (inside(b, lastBox)) return;
  // A little beyond the screen, so a small pan doesn't fetch again.
  const pb = b.pad(0.3), box = [pb.getSouth(), pb.getWest(), pb.getNorth(), pb.getEast()];
  busy = true;
  try { add(await overpassPoints(box.map(v => v.toFixed(5)).join(','))); lastBox = box; }
  catch (e) { console.warn('trailheads layer:', e.message); }
  busy = false;
}
const later = () => { clearTimeout(timer); timer = setTimeout(load, 800); };

export function initAccessPoints() {
  if (added) return;
  added = true;
  layersControl.addOverlay(layer, 'Trailheads & parking');
  map.on('overlayadd', e => { if (e.layer === layer) load(); });
  map.on('moveend', later);
}
export function showPoints(points) {
  initAccessPoints();
  add(points);
  layer.addTo(map);
}
