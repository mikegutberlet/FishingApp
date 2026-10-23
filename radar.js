// Rain radar overlay from RainViewer: the last 2 hours in 10-minute frames, with play/pause and a time slider.
// RainViewer's free tiles stop at zoom 7, so closer in they are scaled up (blocky but still shows the cells).
import { map, layersControl } from './map.js';
import { fetchRadarFrames } from './forecast.js';
import { esc } from './ui.js';

const radar = L.layerGroup();
layersControl.addOverlay(radar, 'Rain radar');

let frames = [], layers = [], shown = -1, timer = null, refresh = null, control = null;

// Frames are only fetched once shown, so leaving the radar on the latest frame costs one set of tiles.
const frameLayer = i => layers[i] ??= L.tileLayer(frames[i].url, { opacity: 0, maxNativeZoom: 7, maxZoom: 19, zIndex: 5, attribution: '<a href="https://www.rainviewer.com/" target="_blank" rel="noopener">RainViewer</a>' }).addTo(radar);

function show(i) {
  if (!frames[i]) return;
  frameLayer(i);
  layers[shown]?.setOpacity(0);
  layers[i].setOpacity(0.7);
  shown = i;
  const el = control?.getContainer();
  if (!el) return;
  el.querySelector('input').value = i;
  el.querySelector('.radar-time').textContent = new Date(frames[i].time).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) + (i === frames.length - 1 ? ' (latest)' : '');
}

function stop() {
  clearInterval(timer); timer = null;
  const b = control?.getContainer().querySelector('.radar-play');
  if (b) b.textContent = '▶';
}
function play() {
  stop();
  control.getContainer().querySelector('.radar-play').textContent = '⏸';
  timer = setInterval(() => show((shown + 1) % frames.length), 600);
}

async function load() {
  try { frames = await fetchRadarFrames(); } catch (e) { control.getContainer().querySelector('.radar-time').textContent = esc(e.message); return; }
  radar.clearLayers();
  layers = [];
  shown = -1;
  const input = control.getContainer().querySelector('input');
  input.max = frames.length - 1;
  show(frames.length - 1);
}

map.on('overlayadd', e => {
  if (e.layer !== radar) return;
  control = L.control({ position: 'topright' });
  control.onAdd = () => {
    const el = L.DomUtil.create('div', 'radar-ctl leaflet-bar');
    el.innerHTML = `<button class="radar-play" title="Play">▶</button><input type="range" min="0" max="0" value="0" aria-label="Radar time"><span class="radar-time">Loading radar…</span>`;
    L.DomEvent.disableClickPropagation(el);
    el.querySelector('.radar-play').onclick = () => timer ? stop() : play();
    el.querySelector('input').oninput = ev => { stop(); show(+ev.target.value); };
    return el;
  };
  control.addTo(map);
  load();
  refresh = setInterval(load, 10 * 60e3);
});

map.on('overlayremove', e => {
  if (e.layer !== radar) return;
  stop(); clearInterval(refresh);
  control?.remove(); control = null;
  radar.clearLayers(); layers = [];
});
