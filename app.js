// Startup. Each view lives in views/ and registers itself with onShow(); see ui.js.
// map.js and the views import each other, which is safe because modules only use each other's exports inside
// functions. Keep it that way: no top-level code that touches another app module's const or let exports.
import './lock.js'; // first, so the lock screen is up before anything else draws
import { map, refreshMap } from './map.js';
import { db } from './db.js';
import { STATES } from './states/index.js';
import { migrateSavedIds } from './states/or.js';
import { $, showView, onShow, COMMON_SPECIES } from './ui.js';
import { openLake, openWater } from './views/lake.js';
import { addStateWater } from './views/lakes.js';
import './views/log.js';
import './views/journal.js';
import { resumeTrip } from './views/trips.js';
import './units.js';
import './views/stats.js';
import './views/settings.js';
import './radar.js';
import './wind-layer.js';
import { addSafetyLayers } from './safety-map.js';
import './views/today.js';
import './views/planner.js';
import './views/where.js';
import { initOffline } from './offline.js';
import { initWaypoints } from './waypoints.js';
import { initHeatmap } from './heatmap.js';
import { initRoutes } from './routes.js';
import './map-browse.js';

initOffline();
initWaypoints();
initHeatmap();
initRoutes();
import './insights.js';
import { initCrew } from './crew.js';
import './welcome.js';
import './share-water.js';
import './license.js';
import { checkReminders } from './reminders.js';
import { initCamp } from './views/camp.js';
import { initCoastMap } from './coast-map.js';

document.querySelectorAll('nav button').forEach(b => b.onclick = () => showView(b.dataset.view));

// Links inside map popups and lists: data-open-lake="<id>", data-add-water="<state's stock id>" data-state="CA|NV|OR".
document.addEventListener('click', e => {
  const id = e.target.dataset?.openLake;
  if (id) { e.preventDefault(); openLake(id); }
  const waterId = e.target.dataset?.addWater;
  if (waterId) { e.preventDefault(); addStateWater(waterId, e.target.dataset.state ?? 'CA'); }
});

// ---------- Startup ----------
$('#species-list').innerHTML = COMMON_SPECIES.map(s => `<option value="${s}">`).join('');
addSafetyLayers();
navigator.storage?.persist?.(); // ask the browser not to evict our data
migrateSavedIds(db).catch(e => console.warn('Oregon id migration:', e));
resumeTrip();
initCrew();
initCamp();
initCoastMap();
checkReminders();
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js');
// Today is the home screen. The map starts hidden, so frame your lakes the first time it is shown (a hidden map has no size).
showView('today');
let framed = false, lakeBounds = null;
const frame = () => {
  if (framed || !lakeBounds || !$('#view-map').classList.contains('active')) return;
  framed = true;
  map.invalidateSize();
  map.fitBounds(lakeBounds, { maxZoom: 13 });
};
refreshMap().then(async () => {
  const lakes = await db.all('lakes');
  if (lakes.length) lakeBounds = L.latLngBounds(lakes.map(l => [l.lat, l.lon])).pad(0.3);
  frame();
});
// Size the map as soon as it's shown, so a fitBounds right after showView('map') (depth maps, surveys) sees its real size.
onShow('map', () => { map.invalidateSize(); frame(); });
window.__app = { db, openLake, showView, openWater, ...STATES }; window.__map = map; // handy for debugging from the console
