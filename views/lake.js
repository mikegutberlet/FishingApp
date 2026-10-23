// One water's page: a saved lake with all its tabs, or a statewide water you can look at before saving it.
import { db } from '../db.js';
import { forLake } from '../states/index.js';
import { $, esc, showView } from '../ui.js';
import { map, refreshMap } from '../map.js';
import { renderLakeList, editLake } from './lakes.js';
import { shareLake } from './settings.js';
import { renderConditions } from './tabs/conditions.js';
import { renderDepth } from './tabs/depth.js';
import { renderStocking } from './tabs/stocking.js';
import { renderHistory } from './tabs/history.js';
import { renderLakeCatches } from './tabs/catches.js';
import { renderNotes } from './tabs/notes.js';
import { renderInfo } from './tabs/info.js';
import { renderStateSafety, renderNvBanner } from './tabs/nv-safety.js';
import { toggleFavorite } from './today.js';

// Opens a statewide water: the saved lake if you already have it, otherwise a read-only page you can save.
export async function openWater(w, tab = 'conditions') {
  const saved = (await db.all('lakes')).find(l => l.nhdId === String(w.id));
  if (saved) return openLake(saved.id, tab);
  openLake(await waterRecord(w), tab);
}

// A lake record for a statewide water, not yet saved, linked to its state's stocked water when there is one.
export async function waterRecord(w) {
  const S = forLake(w);
  const stocked = await S?.matchStockedWater(w);
  return {
    unsaved: true, nhdId: String(w.id), kind: w.kind, name: w.name, type: w.type, state: S?.code ?? w.state, lat: w.lat, lon: w.lon,
    acres: w.acres ?? null, elevationFt: w.elevationFt ?? null, maxDepth: w.maxDepthFt ?? null, meanDepth: w.meanDepthFt ?? null, depthSource: w.depthSource ?? null,
    lengthKm: w.km ?? null, ...(S && { [S.stockField]: stocked?.id ?? null }), stockingUrl: stocked ? S.waterUrl(stocked.id) : null,
  };
}

export async function saveWater(lake, tab) {
  const { unsaved, ...rest } = lake;
  const saved = await db.put('lakes', rest);
  await refreshMap();
  openLake(saved.id, tab);
}

// Tabs on a saved water, in order. To add one, create views/tabs/<name>.js and add a line here.
export const LAKE_TABS = {
  conditions: { label: 'Conditions', render: renderConditions },
  depth: { label: 'Depth', render: renderDepth },
  stocking: { label: 'Stocking', render: renderStocking },
  history: { label: 'History', render: renderHistory },
  catches: { label: 'Catches', render: renderLakeCatches },
  notes: { label: 'Notes', render: renderNotes },
  safety: { label: 'Regs & safety', render: renderStateSafety },
  info: { label: 'Info', render: renderInfo },
};
// Tabs on a water you haven't saved yet (only the ones that work without your own data).
export const WATER_TABS = ['conditions', 'stocking', 'depth', 'history', 'safety', 'info'];

export async function openLake(id, tab = 'conditions') {
  const lake = typeof id === 'object' ? id : await db.get('lakes', id);
  if (lake.unsaved) return openUnsaved(lake, tab);
  showView('lakes');
  $('#lake-list').classList.add('hidden');
  const d = $('#lake-detail');
  d.classList.remove('hidden');
  d.innerHTML = `<button id="back">‹ All waters</button> <button id="edit">Edit</button> <button id="center">Map</button> <button id="share">Share</button> <button id="fav" title="${lake.favorite ? 'On your Today screen' : 'Add to your Today screen'}">${lake.favorite ? '★' : '☆'}</button>
    <h2>${esc(lake.name)}</h2>
    <div class="tabs">${Object.entries(LAKE_TABS).map(([k, t]) => `<button data-tab="${k}" class="${k === tab ? 'active' : ''}">${t.label}</button>`).join('')}</div>
    <div id="tab-body"></div>`;
  $('#back', d).onclick = renderLakeList;
  $('#edit').onclick = () => editLake(lake);
  $('#center').onclick = () => { showView('map'); map.setView([lake.lat, lake.lon], 14); };
  $('#share').onclick = () => shareLake(lake);
  $('#fav').onclick = () => toggleFavorite(lake, $('#fav'));
  d.querySelectorAll('.tabs button').forEach(b => b.onclick = () => openLake(id, b.dataset.tab));
  const body = $('#tab-body');
  renderNvBanner(lake, d);
  await LAKE_TABS[tab].render(lake, body);
}

function openUnsaved(lake, tab) {
  showView('lakes');
  $('#lake-list').classList.add('hidden');
  const d = $('#lake-detail');
  d.classList.remove('hidden');
  d.innerHTML = `<button id="back">‹ Map</button> <button id="save" class="primary" style="width:auto;padding:8px 12px">＋ Save to my lakes</button>
    <h2>${esc(lake.name)}</h2><div class="muted small">${esc(lake.type)}${lake.acres ? ` · ${lake.acres.toLocaleString()} acres` : ''}${lake.lengthKm ? ` · ${Math.round(lake.lengthKm * 0.621)} mi` : ''}${lake.maxDepth ? ` · max depth ${lake.maxDepth} ft` : ''}</div>
    <div class="tabs">${WATER_TABS.map(k => `<button data-tab="${k}" class="${k === tab ? 'active' : ''}">${LAKE_TABS[k].label}</button>`).join('')}</div>
    <div id="tab-body"></div>`;
  $('#back', d).onclick = () => showView('map');
  $('#save').onclick = () => saveWater(lake, tab);
  d.querySelectorAll('.tabs button').forEach(b => b.onclick = () => openUnsaved(lake, b.dataset.tab));
  renderNvBanner(lake, d);
  LAKE_TABS[tab].render(lake, $('#tab-body'));
}
