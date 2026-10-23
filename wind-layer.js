// "Wind on my lakes" map overlay: an arrow on each saved water pointing the way the wind blows, with its speed.
import { map, layersControl } from './map.js';
import { db } from './db.js';
import { weatherFor } from './forecast.js';
import { windOnWater, bankName } from './wind.js';
import { esc } from './ui.js';

const windLayer = L.layerGroup();
layersControl.addOverlay(windLayer, 'Wind on my lakes');

async function draw() {
  windLayer.clearLayers();
  for (const lake of await db.all('lakes')) {
    weatherFor(lake.lat, lake.lon).then(w => {
      if (!map.hasLayer(windLayer)) return;
      const x = windOnWater(w);
      const icon = L.divIcon({ className: 'wind-pin', iconSize: null,
        html: `<span><i style="transform:rotate(${x.to}deg)">↑</i>${Math.round(x.speed)}</span>` });
      L.marker([lake.lat, lake.lon], { icon, keyboard: false, zIndexOffset: 500 })
        .bindPopup(`<b>${esc(lake.name)}</b><br>${x.calm ? 'Calm' : `${Math.round(x.speed)} mph, gusts ${Math.round(x.gusts)}<br>Blowing into the ${bankName(x.to)} bank`}<br><a href="#" data-open-lake="${lake.id}">Open</a>`)
        .addTo(windLayer);
    }).catch(() => {});
  }
}

map.on('overlayadd', e => { if (e.layer === windLayer) draw(); });
