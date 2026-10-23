// Startup. Each view lives in views/ and registers itself with onShow(); see ui.js.
// map.js and the views import each other, which is safe because modules only use each other's exports inside
// functions. Keep it that way: no top-level code that touches another app module's const or let exports.
import { map, refreshMap } from './map.js';
import { db } from './db.js';
import * as CA from './states/ca.js';
import { $, showView, COMMON_SPECIES } from './ui.js';
import { openLake, openWater } from './views/lake.js';
import { addStateWater } from './views/lakes.js';
import './views/log.js';
import './views/stats.js';
import './views/settings.js';

document.querySelectorAll('nav button').forEach(b => b.onclick = () => showView(b.dataset.view));

// Links inside map popups and lists: data-open-lake="<id>", data-add-water="<CDFW stock id>".
document.addEventListener('click', e => {
  const id = e.target.dataset?.openLake;
  if (id) { e.preventDefault(); openLake(id); }
  const waterId = e.target.dataset?.addWater;
  if (waterId) { e.preventDefault(); addStateWater(+waterId); }
});

// ---------- Startup ----------
$('#species-list').innerHTML = COMMON_SPECIES.map(s => `<option value="${s}">`).join('');
navigator.storage?.persist?.(); // ask the browser not to evict our data
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js');
refreshMap().then(async () => {
  const lakes = await db.all('lakes');
  if (lakes.length) map.fitBounds(L.latLngBounds(lakes.map(l => [l.lat, l.lon])).pad(0.3), { maxZoom: 13 });
});
window.__app = { db, openLake, showView, openWater, CA }; window.__map = map; // handy for debugging from the console
