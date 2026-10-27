// One water's page: a saved lake with all its tabs, or a statewide water you can look at before saving it.
import { db } from '../db.js';
import { forLake } from '../states/index.js';
import { $, esc, showView, fitTabs, icon } from '../ui.js';
import { map, refreshMap } from '../map.js';
import { renderLakeList, editLake } from './lakes.js';
import { openShareSheet } from '../share-water.js';
import { offlineButton } from '../offline.js';
import { renderConditions } from './tabs/conditions.js';
import { renderDepth } from './tabs/depth.js';
import { renderStocking } from './tabs/stocking.js';
import { renderHistory } from './tabs/history.js';
import { renderLakeCatches } from './tabs/catches.js';
import { renderNotes } from './tabs/notes.js';
import { renderCrew } from './tabs/crew.js';
import { renderInfo } from './tabs/info.js';
import { renderGettingThere } from './tabs/access.js';
import { renderCamping } from './tabs/camping.js';
import { renderKnow } from './tabs/know.js';
import { renderStateSafety, renderNvBanner } from './tabs/nv-safety.js';
import { renderOrBanner } from './tabs/or-safety.js';
import { renderSafety, renderSafetyBanner } from './tabs/safety.js';
import { toggleFavorite } from './today.js';
import { renderTides } from './tabs/tides.js';
import { renderMarine } from './tabs/marine.js';
import { renderOceanRules } from './tabs/ocean-rules.js';
import { isCoast, coastRecord } from '../coast.js';

// Opens a statewide water: the saved lake if you already have it, otherwise a read-only page you can save.
export async function openWater(w, tab = 'conditions') {
  const saved = (await db.all('lakes')).find(l => l.nhdId === String(w.id));
  if (saved) return openLake(saved.id, tab);
  openLake(await waterRecord(w), tab);
}

// A lake record for a statewide water, not yet saved, linked to its state's stocked water when there is one.
export async function waterRecord(w) {
  if (isCoast(w)) return coastRecord(w);
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
  plan: { label: 'Game plan', render: renderKnow },
  depth: { label: 'Depth', render: renderDepth },
  stocking: { label: 'Stocking', render: renderStocking },
  history: { label: 'History', render: renderHistory },
  catches: { label: 'Catches', render: renderLakeCatches },
  notes: { label: 'Notes', render: renderNotes },
  access: { label: 'Getting there', render: renderGettingThere },
  camping: { label: 'Camping', render: renderCamping },
  safety: { label: 'Regs & safety', render: (l, b) => forLake(l)?.code === 'CA' ? renderSafety(l, b) : renderStateSafety(l, b) },
  crew: { label: 'Crew', render: renderCrew },
  info: { label: 'Info', render: renderInfo },
  tides: { label: 'Tides', render: renderTides },
  marine: { label: 'Marine', render: renderMarine },
  oceanrules: { label: 'Ocean rules', render: renderOceanRules },
};
// Tabs on a lake or river, saved; ocean spots (piers, jetties, beaches) get their own set.
const LAKE_TAB_KEYS = ['conditions', 'plan', 'depth', 'stocking', 'history', 'catches', 'notes', 'access', 'camping', 'safety', 'crew', 'info'];
const COAST_TABS = ['conditions', 'tides', 'marine', 'oceanrules', 'catches', 'notes', 'access', 'camping', 'crew', 'info'];
const COAST_WATER_TABS = ['conditions', 'tides', 'marine', 'oceanrules', 'access', 'camping', 'info'];
// Tabs on a water you haven't saved yet (only the ones that work without your own data).
export const WATER_TABS = ['conditions', 'plan', 'stocking', 'depth', 'history', 'access', 'camping', 'safety', 'info'];
const tabsFor = lake => isCoast(lake) ? (lake.unsaved ? COAST_WATER_TABS : COAST_TABS) : lake.unsaved ? WATER_TABS : LAKE_TAB_KEYS;
// A tab asked for that this kind of water doesn't have: the rules tab for "regs", else the first one.
const fitTab = (lake, tab) => tabsFor(lake).includes(tab) ? tab : tab === 'safety' && isCoast(lake) ? 'oceanrules' : tabsFor(lake)[0];
// The state's lake banners (algae, closures) don't apply on the ocean.
function stateBanners(lake, d) {
  if (isCoast(lake)) return;
  if (forLake(lake)?.code === 'CA') renderSafetyBanner(lake, d); else { renderNvBanner(lake, d); renderOrBanner(lake, d); }
}

// One line under the name: what it is, where, and how big. Inside the h2 so safety banners still land right after the title block.
const lakeSummary = l => {
  const bits = [l.type, l.county && `${l.county}${l.state ? ', ' + l.state : ''}`, +l.acres && `${(+l.acres).toLocaleString()} acres`,
    l.lengthKm && `${Math.round(l.lengthKm * 0.621)} mi`, l.maxDepth && `${l.maxDepth} ft deep`].filter(Boolean);
  return bits.length ? `<small>${bits.map(esc).join(' · ')}</small>` : '';
};

export async function openLake(id, tab = 'conditions') {
  const lake = typeof id === 'object' ? id : await db.get('lakes', id);
  if (lake.unsaved) return openUnsaved(lake, tab);
  tab = fitTab(lake, tab);
  showView('lakes');
  $('#lake-list').classList.add('hidden');
  const d = $('#lake-detail');
  d.classList.remove('hidden');
  d.innerHTML = `<div class="lake-bar"><button id="back" class="ghost">‹ All waters</button><button id="fav" title="${lake.favorite ? 'On your Today screen' : 'Add to your Today screen'}">${lake.favorite ? '★' : '☆'}</button></div>
    <h2 class="lake-name">${esc(lake.name)}${lakeSummary(lake)}</h2>
    <div class="lake-acts"><button id="edit">${icon('edit')}Edit</button><button id="center">${icon('map')}Map</button><button id="share">${icon('share')}Share</button></div>
    <div class="lake-tabs"><div class="tabs">${tabsFor(lake).map(k => `<button data-tab="${k}" class="${k === tab ? 'active' : ''}">${LAKE_TABS[k].label}</button>`).join('')}</div></div>
    <div id="tab-body"></div>`;
  $('#back', d).onclick = renderLakeList;
  $('#edit').onclick = () => editLake(lake);
  $('#center').onclick = () => { showView('map'); map.setView([lake.lat, lake.lon], 14); };
  $('#share').onclick = () => openShareSheet(lake);
  $('#fav').onclick = () => toggleFavorite(lake, $('#fav'));
  $('#share').after(offlineButton(lake));
  const go = document.createElement('button');
  go.innerHTML = '📋 Before you go';
  go.onclick = () => import('./before-go.js').then(m => m.openChecklist(lake.id, undefined, { from: () => openLake(lake.id) }));
  $('.lake-acts', d).append(go);
  d.querySelectorAll('.tabs button').forEach(b => b.onclick = () => openLake(id, b.dataset.tab));
  fitTabs($('.tabs', d));
  const body = $('#tab-body');
  stateBanners(lake, d);
  await LAKE_TABS[tab].render(lake, body);
}

function openUnsaved(lake, tab) {
  tab = fitTab(lake, tab);
  showView('lakes');
  $('#lake-list').classList.add('hidden');
  const d = $('#lake-detail');
  d.classList.remove('hidden');
  d.innerHTML = `<div class="lake-bar"><button id="back" class="ghost">‹ Map</button></div>
    <h2 class="lake-name">${esc(lake.name)}${lakeSummary(lake)}</h2>
    <div class="lake-acts"><button id="save" class="primary">${icon('plus')}Save to my lakes</button><button id="share">${icon('share')}Share</button></div>
    <div class="lake-tabs"><div class="tabs">${tabsFor(lake).map(k => `<button data-tab="${k}" class="${k === tab ? 'active' : ''}">${LAKE_TABS[k].label}</button>`).join('')}</div></div>
    <div id="tab-body"></div>`;
  $('#back', d).onclick = () => showView('map');
  $('#save').onclick = () => saveWater(lake, tab);
  $('#share').onclick = () => openShareSheet(lake);
  $('#save').after(offlineButton(lake));
  d.querySelectorAll('.tabs button').forEach(b => b.onclick = () => openUnsaved(lake, b.dataset.tab));
  fitTabs($('.tabs', d));
  stateBanners(lake, d);
  LAKE_TABS[tab].render(lake, $('#tab-body'));
}
