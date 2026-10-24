// The Lakes view: your saved waters, statewide search, the state stocked-waters finder (CDFW, NDOW, ODFW), and the lake editor.
import { db } from '../db.js';
import { STATES, list as stateList, selected, select, stateAt } from '../states/index.js';
import { $, esc, fmtDate, status, showView, onShow } from '../ui.js';
import { refreshMap, locate } from '../map.js';
import { openLake, openWater } from './lake.js';
import { showNewPlantBadges } from './new-plants.js';
import { activeTrip } from './trips.js';
import { refreshWaypoints } from '../waypoints.js';
import { deletePack, packId } from '../offline.js';

export async function renderLakeList() {
  $('#lake-detail').classList.add('hidden');
  const list = $('#lake-list');
  list.classList.remove('hidden');
  const lakes = (await db.all('lakes')).sort((a, b) => a.name.localeCompare(b.name));
  const S = selected(lakes);
  list.innerHTML = `<h2>Lakes & rivers</h2><label class="state-pick small">State <select id="state-pick">${stateList.map(s => `<option value="${s.code}" ${s === S ? 'selected' : ''}>${s.name}</option>`).join('')}<option value="here">📍 Where I am</option></select></label>
    <div class="row" style="margin-bottom:12px"><button id="find-any" style="flex:1">🔎 Any ${S.name} water</button><button id="find-waters" style="flex:1">🐟 Stocked waters</button></div>`
    + (lakes.length ? '' : `<div class="card muted">No waters yet. Find one above, or use “＋ Lake here” on the map.</div>`)
    + lakes.map(l => `<div class="card lake-item" data-id="${l.id}"><div><b>${esc(l.name)}</b> <span data-new-plants="${l.id}"></span><div class="muted small">${esc(l.type)}${l.county ? ' · ' + esc(l.county) : ''}${l.state ? ', ' + esc(l.state) : ''}</div></div><span>›</span></div>`).join('');
  list.querySelectorAll('.lake-item').forEach(el => el.onclick = () => openLake(el.dataset.id));
  $('#find-waters').onclick = () => renderFindWaters(S);
  $('#find-any').onclick = () => renderFindAny(S);
  $('#state-pick').onchange = async e => {
    if (e.target.value === 'here') {
      try { const p = await locate(); const here = stateAt(p.lat, p.lon); if (here) select(here.code); else status('No state data for where you are yet'); }
      catch (err) { status(err.message); }
    } else select(e.target.value);
    renderLakeList();
  };
  showNewPlantBadges(list, lakes);
}

// Search every named lake, reservoir and river in a state from its statewide list.
async function renderFindAny(S) {
  const list = $('#lake-list');
  list.innerHTML = `<button id="back">‹ My waters</button><h2>${S.name} lakes & rivers</h2>
    <div class="card form"><label>Name <input id="asearch" type="search" placeholder="${S.searchHint}" autofocus></label></div>
    <div id="aresults" class="muted">Loading…</div>`;
  $('#back').onclick = renderLakeList;
  const statewide = await S.statewide();
  if (!$('#aresults')) return;
  $('#aresults').textContent = statewide.lakes.length ? `Type a name to search ${(statewide.lakes.length + new Set(statewide.riverLabels.map(r => r.id)).size).toLocaleString()} waters.` : `The ${S.name} water list hasn't been downloaded yet. It's rebuilt weekly.`;
  const rivers = [...new Map(statewide.riverLabels.map(r => [r.id, r])).values()];
  const draw = () => {
    const q = $('#asearch').value.trim().toLowerCase();
    if (q.length < 2) { $('#aresults').innerHTML = ''; return; }
    const hits = [...statewide.lakes, ...rivers].filter(w => w.name.toLowerCase().includes(q))
      .sort((a, b) => (a.name.toLowerCase().startsWith(q) ? 0 : 1) - (b.name.toLowerCase().startsWith(q) ? 0 : 1) || (b.acres ?? b.km ?? 0) - (a.acres ?? a.km ?? 0)).slice(0, 60);
    $('#aresults').innerHTML = hits.length ? hits.map((w, i) => `<div class="card lake-item" data-i="${i}"><div><b>${esc(w.name)}</b>
        <div class="muted small">${esc(w.type)}${w.acres ? ` · ${w.acres.toLocaleString()} acres` : ''}${w.km ? ` · ${Math.round(w.km * 0.621)} mi` : ''}${w.maxDepthFt ? ` · ${w.maxDepthFt} ft deep` : ''}${w.elevationFt ? ` · ${w.elevationFt.toLocaleString()} ft elev.` : ''}</div></div><span>›</span></div>`).join('')
      : '<div class="card muted">No matches.</div>';
    $('#aresults').querySelectorAll('.lake-item').forEach(el => el.onclick = () => openWater(hits[+el.dataset.i]));
  };
  $('#asearch').oninput = draw;
}

// Browse a state's stocked waters and add one as a lake in a tap.
async function renderFindWaters(S) {
  const list = $('#lake-list');
  list.innerHTML = `<button id="back">‹ My waters</button><h2>${S.name} stocked waters</h2>
    <div class="card form"><label>Search by name or ${S.searchBy ?? 'county'} <input id="wsearch" type="search" placeholder="${S.stockedHint}"></label>
      <label class="check"><input type="checkbox" id="wrecent" checked> Planted in the last 30 days or coming up</label></div>
    <div id="wresults" class="muted">Loading ${S.agency} data…</div><p class="muted small" id="wdates"></p>`;
  $('#back').onclick = renderLakeList;
  const [all, mine, dates] = await Promise.all([S.waters(), db.all('lakes'), S.dataDates()]);
  if (!all.length) { $('#wresults').textContent = `${S.name} data has not been downloaded yet. It refreshes nightly; check back tomorrow.`; return; }
  $('#wdates').textContent = `${S.agency} stocking reports, updated ${fmtDate(dates.plants)}. Plants are subject to change.`;
  const added = new Map(mine.filter(l => l[S.stockField] != null).map(l => [String(l[S.stockField]), l.id]));
  const cutoff = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const draw = () => {
    const q = $('#wsearch').value.trim().toLowerCase();
    const recentOnly = $('#wrecent').checked;
    const hits = all
      .filter(w => !q || w.name.toLowerCase().includes(q) || (w.counties ?? '').toLowerCase().includes(q))
      .filter(w => !recentOnly || (w.lastPlant && w.lastPlant >= cutoff))
      .sort((a, b) => (b.lastPlant ?? '').localeCompare(a.lastPlant ?? '') || a.name.localeCompare(b.name))
      .slice(0, 100);
    $('#wresults').innerHTML = hits.length ? hits.map(w => `<div class="card lake-item"><div><b>${esc(w.name)}</b>
        <div class="muted small">${esc(w.counties)} · ${w.lastPlant ? `${w.lastPlant > new Date().toISOString().slice(0, 10) ? 'Planned' : 'Planted'} ${w.plants[0].weekEnd === w.lastPlant ? '' : 'week of '}${fmtDate(w.lastPlant + 'T12:00')}: ${esc(w.plants[0].species)} · ${w.plants.length} plants on record` : `last stocked ${w.lastYearStocked ?? 'unknown'}`}</div></div>
        ${added.has(String(w.id)) ? `<button data-open-lake="${added.get(String(w.id))}">Open</button>` : `<button data-add-water="${esc(w.id)}" data-state="${S.code}">＋ Add</button>`}</div>`).join('')
      : '<div class="card muted">No matches.</div>';
  };
  $('#wsearch').oninput = draw;
  $('#wrecent').onchange = draw;
  draw();
}

// stockId is the state's id for a stocked water (a CDFW number, an NDOW slug), as text from a data-add-water link.
export async function addStateWater(stockId, code = 'CA') {
  const S = STATES[code];
  const existing = (await db.all('lakes')).find(l => l[S.stockField] != null && String(l[S.stockField]) === String(stockId));
  if (existing) return openLake(existing.id);
  const w = (await S.waters()).find(x => String(x.id) === String(stockId));
  if (!w) return;
  const lake = await db.put('lakes', {
    name: w.name, type: w.type ?? (/river|creek|fork|section/i.test(w.name) ? 'River' : 'Lake'), state: S.code, county: w.county ?? w.counties,
    lat: w.lat, lon: w.lon, stockPoint: [w.lat, w.lon], [S.stockField]: w.id, stockingUrl: S.waterUrl(w.id), infoUrl: S.waterUrl(w.id),
  });
  await refreshMap();
  openLake(lake.id, 'stocking');
}

export function editLake(lake) {
  showView('lakes');
  $('#lake-list').classList.add('hidden');
  const d = $('#lake-detail');
  d.classList.remove('hidden');
  d.innerHTML = `<button id="back">‹ Back</button><h2>${lake.id ? 'Edit' : 'New'} lake / river</h2>
    <form class="card form" id="lake-form">
      <label>Name <input name="name" required value="${esc(lake.name)}"></label>
      <div class="row"><label>Type <select name="type">${['Lake', 'Reservoir', 'River', 'Stream', 'Pond'].map(t => `<option ${lake.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label>State <input name="state" maxlength="2" value="${esc(lake.state)}" placeholder="WI"></label></div>
      <label>County <input name="county" value="${esc(lake.county)}"></label>
      <div class="row"><label>Acres <input name="acres" type="number" value="${esc(lake.acres)}"></label>
        <label>Max depth (ft) <input name="maxDepth" type="number" value="${esc(lake.maxDepth)}"></label></div>
      <label>Water clarity (ft) <input name="clarity" type="number" step="0.5" value="${esc(lake.clarity)}"></label>
      <label>Species present <input name="species" value="${esc(lake.species)}" placeholder="Walleye, Northern pike, Bluegill"></label>
      <label>Regulations / limits <textarea name="regs" rows="2">${esc(lake.regs)}</textarea></label>
      <label>Access / launches <textarea name="access" rows="2">${esc(lake.access)}</textarea></label>
      <label>State lake page (DNR) URL <input name="infoUrl" type="url" value="${esc(lake.infoUrl)}"></label>
      <label>Stocking report URL <input name="stockingUrl" type="url" value="${esc(lake.stockingUrl)}"></label>
      <label>USGS gauge id (optional, pins a specific gauge) <input name="usgsSite" value="${esc(lake.usgsSite)}"></label>
      <label>Lake level station (optional: CDEC id like SHA in California, USGS site number in Nevada and Oregon) <input name="cdecStation" value="${esc(lake.cdecStation)}"></label>
      <div class="row"><label>Lat <input name="lat" type="number" step="any" required value="${lake.lat ?? ''}"></label>
        <label>Lon <input name="lon" type="number" step="any" required value="${lake.lon ?? ''}"></label></div>
      <button class="primary">Save</button>
    </form>${lake.id ? '<button class="danger" id="del-lake">Delete this lake and everything logged on it</button>' : ''}`;
  $('#back', d).onclick = () => lake.id ? openLake(lake.id) : renderLakeList();
  $('#lake-form').onsubmit = async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const current = lake.id ? await db.get('lakes', lake.id) : null; // fields other screens saved since the form opened
    const saved = await db.put('lakes', { ...lake, ...current, ...f, lat: +f.lat, lon: +f.lon });
    await refreshMap();
    openLake(saved.id);
  };
  const del = $('#del-lake');
  if (del) del.onclick = async () => {
    if ((await activeTrip())?.lakeId === lake.id) return alert('End your trip on this water first.');
    if (!confirm(`Delete ${lake.name} and all its catches, notes, trips, stocking, depth data, waypoints, temperature profiles and offline map?`)) return;
    for (const s of ['catches', 'notes', 'stocking', 'depthSets', 'trips', 'waypoints', 'tempProfiles']) for (const r of await db.byLake(s, lake.id)) await db.del(s, r.id);
    for (const ev of await db.all('events')) if (ev.lakeId === lake.id) await db.del('events', ev.id);
    refreshWaypoints();
    if ('caches' in window) await deletePack(packId(lake));
    await db.del('lakes', lake.id);
    await refreshMap();
    renderLakeList();
  };
}

onShow('lakes', renderLakeList);
