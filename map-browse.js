// Browsing the map for somewhere to fish: a search bar, quick layer chips, a preview sheet for the water you tap,
// and the small map on the Today screen that opens the full one.
import { db } from './db.js';
import { map, statewide, loadState, setWaterTap, here, baseLayers, stockedLayer, watersLayer, refreshMap } from './map.js';
import { STATES, forLake, stockIdOf } from './states/index.js';
import { $, esc, fmtDate, icon, showView, status } from './ui.js';
import { openWater, openLake, waterRecord } from './views/lake.js';
import { directionsUrl } from './views/access.js';
import { coastSpots } from './coast.js';
import { entryFor, factsFor, habFor, addFish, fishRows, isSavedLake, ACCESS } from './water-facts.js';

const view = $('#view-map'), search = $('#map-search'), results = $('#map-results'), sheet = $('#water-sheet');
const km = (a, b) => { const r = Math.PI / 180, x = (b.lon - a.lon) * r * Math.cos((a.lat + b.lat) / 2 * r), y = (b.lat - a.lat) * r; return Math.hypot(x, y) * 6371; };
const mi = k => { const m = k * 0.621; return `${m < 10 ? m.toFixed(1) : Math.round(m)} mi`; };
const summary = w => [w.type, w.acres && `${Math.round(w.acres).toLocaleString()} acres`, w.km && `${Math.round(w.km * 0.621)} mi long`, w.lengthKm && `${Math.round(w.lengthKm * 0.621)} mi long`,
  (w.maxDepthFt ?? w.maxDepth) && `${w.maxDepthFt ?? w.maxDepth} ft deep`, w.elevationFt && `${Math.round(w.elevationFt).toLocaleString()} ft elev.`].filter(Boolean).join(' · ');

// ---------- Search ----------
let hits = [];
async function draw() {
  const q = search.value.trim().toLowerCase();
  if (q.length < 2) { results.innerHTML = ''; results.classList.add('hidden'); return; }
  // Every state, not just the one picked under Lakes: a search for Crater Lake should find Oregon's too.
  await Promise.all(Object.values(STATES).map(loadState));
  if (search.value.trim().toLowerCase() !== q) return;
  if (!statewide) { hits = []; results.textContent = 'The water lists didn’t download. Check your signal and try again.'; results.classList.remove('hidden'); return; }
  const c = map.getCenter(), from = { lat: c.lat, lon: c.lng };
  const rivers = [...new Map(statewide.riverLabels.map(r => [r.id, r])).values()];
  const coast = await coastSpots();
  if (search.value.trim().toLowerCase() !== q) return;
  // Names that start with what you typed first, then nearest, with distance shrunk for big waters (a 10,000-acre lake
  // counts as a ninth as far), so Oregon's Crater Lake beats far-off ponds of the same name but not the one next door.
  const size = w => w.acres || (w.km ? w.km * 20 : 0);
  hits = [...statewide.lakes, ...rivers, ...coast].filter(w => w.name.toLowerCase().includes(q))
    .map(w => [(w.name.toLowerCase().startsWith(q) ? 0 : 1e9) + km(from, w) / (1 + Math.log10(Math.max(1, size(w) / 100))) ** 2, w])
    .sort((a, b) => a[0] - b[0]).map(([, w]) => w).slice(0, 30);
  results.innerHTML = hits.length ? hits.map((w, i) => `<button type="button" data-i="${i}"><b>${esc(w.name)}</b><span class="muted small">${esc([summary(w), w.kind === 'coast' ? '' : forLake(w)?.code].filter(Boolean).join(' · '))}${here ? ` · ${mi(km(here, w))} away` : ''}</span></button>`).join('')
    : '<div class="muted small" style="padding:10px">No matches in California, Nevada or Oregon. Try another spelling, or a shorter part of the name.</div>';
  results.classList.remove('hidden');
}
search.oninput = draw;
search.onfocus = () => { if (search.value.trim().length >= 2) results.classList.remove('hidden'); };
results.onclick = e => {
  const b = e.target.closest('[data-i]');
  if (!b) return;
  const w = hits[+b.dataset.i];
  results.classList.add('hidden'); search.blur();
  map.setView([w.lat, w.lon], w.kind === 'river' ? 11 : w.kind === 'coast' ? 15 : 13);
  preview(w);
};
$('#map-search-clear').onclick = () => { search.value = ''; results.innerHTML = ''; results.classList.add('hidden'); };

// ---------- Quick chips: base map, stocked waters, names ----------
const chips = $('#map-chips');
const BASES = ['Satellite', 'Topo', 'Streets'];
const syncChips = () => {
  chips.querySelector('[data-chip=base]').textContent = BASES.find(n => map.hasLayer(baseLayers[n])) ?? 'Satellite';
  chips.querySelector('[data-chip=stocked]').classList.toggle('on', map.hasLayer(stockedLayer));
  chips.querySelector('[data-chip=names]').classList.toggle('on', map.hasLayer(watersLayer));
};
chips.onclick = e => {
  const c = e.target.closest('[data-chip]')?.dataset.chip;
  if (c === 'base') { // Satellite → Topo → Streets → Satellite
    const now = BASES.find(n => map.hasLayer(baseLayers[n])) ?? 'Satellite', next = BASES[(BASES.indexOf(now) + 1) % BASES.length];
    map.removeLayer(baseLayers[now]); map.addLayer(baseLayers[next]); map.fire('baselayerchange', { layer: baseLayers[next], name: next });
  }
  if (c === 'stocked') map.hasLayer(stockedLayer) ? map.removeLayer(stockedLayer) : map.addLayer(stockedLayer);
  if (c === 'names') map.hasLayer(watersLayer) ? map.removeLayer(watersLayer) : map.addLayer(watersLayer);
  syncChips();
};
map.on('baselayerchange overlayadd overlayremove', syncChips);
syncChips();

// ---------- Preview sheet ----------
// A water from a state's list, one of your saved lakes (water-facts.js isSavedLake), or a stocked water that is
// neither yet (`unsaved`, from a pin: water-facts.js stockLake).
let shown = null;
export async function preview(w) {
  shown = w;
  const stocked = w.kind === undefined && w.unsaved;
  const saved = stocked ? (await db.all('lakes')).find(l => stockIdOf(l) != null && forLake(l) === forLake(w) && String(stockIdOf(l)) === String(stockIdOf(w)))
    : isSavedLake(w) ? w : (await db.all('lakes')).find(l => l.nhdId === String(w.id));
  if (shown !== w) return;
  const lake = saved ?? w;
  sheet.innerHTML = `<div class="sheet-head"><div><b>${esc(lake.name)}</b><div class="muted small">${esc(summary(lake))}</div></div><button class="ghost" id="sheet-close" aria-label="Close">✕</button></div>
    <div class="sheet-facts"><span id="sheet-dist" class="chip">${here ? `📍 ${mi(km(here, lake))} from you` : ''}</span><span id="sheet-stock" class="chip">…</span>${saved ? `<span class="chip ok">★ In my lakes</span>` : ''}</div>
    <div id="sheet-more" class="sheet-more small"></div>
    <div class="row sheet-acts"><button class="primary" id="sheet-open">Open</button>${saved ? '' : `<button id="sheet-save">${icon('plus')}Save</button>`}<a class="btn" href="${directionsUrl(lake.lat, lake.lon)}" target="_blank" rel="noopener">Directions</a></div>`;
  sheet.classList.remove('hidden');
  if (!here) $('#sheet-dist').remove();
  $('#sheet-close').onclick = closeSheet;
  $('#sheet-open').onclick = () => { closeSheet(); saved ? openLake(saved.id) : stocked ? openLake(w, 'stocking') : openWater(w); };
  const save = $('#sheet-save');
  if (save) save.onclick = async () => {
    save.disabled = true;
    const { unsaved, ...rest } = stocked ? w : await waterRecord(w);
    await db.put('lakes', rest);
    await refreshMap();
    status(`${lake.name} saved to my lakes`);
    preview(w);
  };
  more(w, lake, saved);
  // Last plant from the state's stocking list, when the water is on it.
  const S = forLake(lake), stockEl = $('#sheet-stock');
  try {
    const id = lake.kind === 'coast' ? null : saved ? stockIdOf(saved) : stocked ? stockIdOf(w) : (await S?.matchStockedWater(w))?.id;
    const st = id != null && (await S.waters()).find(x => String(x.id) === String(id));
    if (shown !== w || !stockEl.isConnected) return;
    if (!st) stockEl.remove();
    else if (st.lastPlant) { const p = st.plants[0]; stockEl.className = `chip ${Date.now() - Date.parse(st.lastPlant) < 30 * 864e5 ? 'good' : ''}`; stockEl.textContent = `🐟 ${p.weekEnd === st.lastPlant ? 'Planted' : 'Plant week of'} ${fmtDate(st.lastPlant + 'T12:00')} (${p.species})`; }
    else stockEl.textContent = `🐟 Stocked ${st.lastYearStocked ?? 'in past years'}`;
  } catch { stockEl?.remove(); }
}
// The fish, algae advisory and access for the water on the card, from the same lookups as the "Where should I go?"
// list. Rivers from the state lists and waters the app has no facts for get nothing extra.
async function more(w, lake, saved) {
  try {
    const e = await entryFor(lake);
    if (!e) return;
    const [f, hab, catches] = await Promise.all([factsFor(e), habFor(e), saved ? db.byLake('catches', saved.id) : []]);
    const el = $('#sheet-more');
    if (shown !== w || !el) return;
    const fish = new Map([...f.fish].map(([g, s]) => [g, new Set(s)]));
    for (const s of [...catches.map(c => c.species), ...String(saved?.species ?? '').split(/,|;/)]) addFish(fish, s, 'yours');
    const access = f.access && Object.keys(ACCESS).filter(k => f.access.has(k)).map(k => ACCESS[k]).join(', ');
    el.innerHTML = fishRows(fish).map(x => `<div><span class="muted">${x.label}:</span> ${esc(x.names.join(', '))}</div>`).join('')
      + (hab ? '<div class="fd-warn">Toxic algae advisory</div>' : '') + (access ? `<div class="muted">${esc(access)}</div>` : '');
  } catch {}
}

// Several waters on one spot (a bubble no zoom can split): pick which one to look at.
export function chooser(waters) {
  shown = waters;
  sheet.innerHTML = `<div class="sheet-head"><div><b>${waters.length} waters here</b></div><button class="ghost" id="sheet-close" aria-label="Close">✕</button></div>
    <div class="sheet-pick">${waters.map((w, i) => `<button type="button" data-i="${i}">${esc(w.name)}<span class="muted small">${esc(w.type ?? '')}</span></button>`).join('')}</div>`;
  sheet.classList.remove('hidden');
  $('#sheet-close').onclick = closeSheet;
  sheet.querySelector('.sheet-pick').onclick = e => { const b = e.target.closest('[data-i]'); if (b) preview(waters[+b.dataset.i]); };
}
export function closeSheet() { shown = null; sheet.classList.add('hidden'); }
setWaterTap(preview);
map.on('tapempty', closeSheet);
new MutationObserver(() => { if (!view.classList.contains('active')) { closeSheet(); results.classList.add('hidden'); } }).observe(view, { attributes: true, attributeFilter: ['class'] });

// ---------- The small map on Today ----------
// Looks at your favorite waters (or all your lakes, or where the big map is), and a tap opens the big map right there.
let mini = null;
export async function mountTodayMap(el) {
  if (mini) { mini.remove(); mini = null; }
  mini = L.map(el, { zoomControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, touchZoom: false, boxZoom: false, keyboard: false, attributionControl: false });
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, crossOrigin: true }).addTo(mini);
  const lakes = (await db.all('lakes')).filter(l => Number.isFinite(l.lat) && Number.isFinite(l.lon));
  const favs = lakes.filter(l => l.favorite), focus = favs.length ? favs : lakes;
  for (const l of lakes) L.circleMarker([l.lat, l.lon], { radius: l.favorite ? 7 : 5, color: '#fff', weight: 2, fillColor: l.favorite ? '#f2b928' : '#3fb0d4', fillOpacity: 1 }).bindTooltip(l.name, { permanent: focus.length <= 4 && focus.includes(l), direction: 'top', className: 'mini-tip' }).addTo(mini);
  if (focus.length === 1) mini.setView([focus[0].lat, focus[0].lon], 11);
  else if (focus.length) mini.fitBounds(L.latLngBounds(focus.map(l => [l.lat, l.lon])), { padding: [28, 28], maxZoom: 12 });
  else mini.setView(map.getCenter(), Math.max(map.getZoom(), 6));
  setTimeout(() => mini?.invalidateSize(), 60);
  el.onclick = () => { map.setView(mini.getCenter(), mini.getZoom(), { animate: false }); showView('map'); };
}
