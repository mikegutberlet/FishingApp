// Catch heatmap: where your catches cluster, filtered by species and season. Drawn on the device from your own log.
import { db } from './db.js';
import { esc, onShow } from './ui.js';
import { map, layersControl } from './map.js';

const SEASONS = { all: 'All year', spring: 'Spring (Mar–May)', summer: 'Summer (Jun–Aug)', fall: 'Fall (Sep–Nov)', winter: 'Winter (Dec–Feb)' };
const seasonOf = iso => ['winter', 'winter', 'spring', 'spring', 'spring', 'summer', 'summer', 'summer', 'fall', 'fall', 'fall', 'winter'][new Date(iso).getMonth()];

// Classic heatmap: soft alpha blobs per catch, then each pixel's alpha is mapped through a color ramp.
const ramp = (() => {
  const c = document.createElement('canvas'); c.width = 256; c.height = 1;
  const ctx = c.getContext('2d'), g = ctx.createLinearGradient(0, 0, 256, 0);
  [[0, '#2b6cff'], [0.35, '#00d0ff'], [0.55, '#4cff4c'], [0.75, '#ffe84c'], [1, '#ff3b1f']].forEach(([o, col]) => g.addColorStop(o, col));
  ctx.fillStyle = g; ctx.fillRect(0, 0, 256, 1);
  return ctx.getImageData(0, 0, 256, 1).data;
})();

const HeatLayer = L.Layer.extend({
  points: [],
  onAdd(m) {
    this.canvas = L.DomUtil.create('canvas', 'heat-canvas leaflet-zoom-hide');
    m.getPanes().overlayPane.appendChild(this.canvas);
    m.on('moveend zoomend resize', this.draw, this);
    this.draw();
  },
  onRemove(m) { this.canvas.remove(); m.off('moveend zoomend resize', this.draw, this); },
  setPoints(points) { this.points = points; if (this._map) this.draw(); },
  draw() {
    const m = this._map, size = m.getSize(), c = this.canvas;
    c.width = size.x; c.height = size.y;
    L.DomUtil.setPosition(c, m.containerPointToLayerPoint([0, 0]));
    const ctx = c.getContext('2d'), r = 26;
    for (const [lat, lon] of this.points) {
      const p = m.latLngToContainerPoint([lat, lon]);
      if (p.x < -r || p.y < -r || p.x > size.x + r || p.y > size.y + r) continue;
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      g.addColorStop(0, 'rgba(0,0,0,0.35)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.fillRect(p.x - r, p.y - r, 2 * r, 2 * r);
    }
    if (!size.x || !size.y) return;
    const img = ctx.getImageData(0, 0, size.x, size.y), d = img.data;
    for (let i = 3; i < d.length; i += 4) {
      const a = d[i]; if (!a) continue;
      const k = Math.min(255, a * 2) * 4;
      d[i - 3] = ramp[k]; d[i - 2] = ramp[k + 1]; d[i - 1] = ramp[k + 2]; d[i] = Math.min(220, 60 + a * 2);
    }
    ctx.putImageData(img, 0, 0);
  },
});

const heat = new HeatLayer();
let control = null, filter = { species: '', season: 'all' };

async function refresh() {
  if (!map.hasLayer(heat)) return;
  const catches = (await db.all('catches')).filter(c => c.lat != null && c.time);
  const species = [...new Set(catches.map(c => c.species).filter(Boolean))].sort();
  if (filter.species && !species.includes(filter.species)) filter.species = ''; // its last catch was deleted
  const shown = catches.filter(c => (!filter.species || c.species === filter.species) && (filter.season === 'all' || seasonOf(c.time) === filter.season));
  heat.setPoints(shown.map(c => [c.lat, c.lon]));
  const el = control?.getContainer();
  if (!el) return;
  el.querySelector('[name=species]').innerHTML = `<option value="">All species</option>${species.map(s => `<option ${s === filter.species ? 'selected' : ''}>${esc(s)}</option>`).join('')}`;
  el.querySelector('.heat-count').textContent = `${shown.length} catch${shown.length === 1 ? '' : 'es'}`;
}

export function initHeatmap() {
  layersControl.addOverlay(heat, 'Catch heatmap');
  map.on('overlayadd', e => {
    if (e.layer !== heat) return;
    control = L.control({ position: 'topright' });
    control.onAdd = () => {
      const el = L.DomUtil.create('div', 'heat-ctl leaflet-bar');
      el.innerHTML = `<select name="species" aria-label="Species"></select><select name="season" aria-label="Season">${Object.entries(SEASONS).map(([k, v]) => `<option value="${k}" ${k === filter.season ? 'selected' : ''}>${v}</option>`).join('')}</select><span class="heat-count"></span>`;
      L.DomEvent.disableClickPropagation(el);
      el.onchange = ev => { filter[ev.target.name] = ev.target.value; refresh(); };
      return el;
    };
    control.addTo(map);
    refresh();
  });
  map.on('overlayremove', e => { if (e.layer === heat) { control?.remove(); control = null; } });
  onShow('map', refresh); // new catches since the layer was turned on
}
