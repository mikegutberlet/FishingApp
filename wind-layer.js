// "Wind on my lakes" map overlay: an arrow on each saved water pointing the way the wind blows, with its speed.
import { map, layersControl } from './map.js';
import { db } from './db.js';
import { weatherFor, forecastAge } from './forecast.js';
import { windOnWater, bankName } from './wind.js';
import { esc, onShow } from './ui.js';

const windLayer = L.layerGroup();
layersControl.addOverlay(windLayer, 'Wind on my lakes');

let drawn = 0; // bumps on every draw and on removal, so answers from an older draw are dropped

async function draw() {
  const gen = ++drawn;
  windLayer.clearLayers();
  for (const lake of await db.all('lakes')) {
    weatherFor(lake.lat, lake.lon).then(w => {
      if (gen !== drawn || !map.hasLayer(windLayer)) return;
      const x = windOnWater(w);
      const icon = L.divIcon({ className: 'wind-pin', iconSize: null,
        html: `<span${w.saved ? ' class="wind-saved"' : ''}><i style="transform:rotate(${x.to}deg)">↑</i>${Math.round(x.speed)}${w.saved ? ' 📴' : ''}</span>` });
      L.marker([lake.lat, lake.lon], { icon, keyboard: false, zIndexOffset: 500 })
        .bindPopup(`<b>${esc(lake.name)}</b><br>${x.calm ? 'Calm' : `${Math.round(x.speed)} mph, gusts ${Math.round(x.gusts)}<br>Blowing into the ${bankName(x.to)} bank`}${w.saved ? `<br>📴 Forecast ${esc(forecastAge(w))}` : ''}<br><a href="#" data-open-lake="${esc(lake.id)}">Open</a>`)
        .addTo(windLayer);
    }).catch(() => {});
  }
}

map.on('overlayadd', e => { if (e.layer === windLayer) draw(); });
map.on('overlayremove', e => { if (e.layer === windLayer) { drawn++; windLayer.clearLayers(); } });
// Lakes may have been added, moved or deleted, and the wind changes: redraw when coming back to the map.
onShow('map', () => { if (map.hasLayer(windLayer)) draw(); });
