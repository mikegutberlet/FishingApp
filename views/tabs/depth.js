// Depth tab: published depth facts, USGS survey contours, and your own sonar imports.
import { db } from '../../db.js';
import * as CA from '../../states/ca.js';
import { parseDepthCsv, parseDepthXml } from '../../data-sources.js';
import { $, esc, fmtDate, status, M_TO_FT } from '../../ui.js';
import { showDepthSet, showSurvey } from '../../map.js';
import { openLake } from '../lake.js';
import { renderWaypointCard } from '../../waypoints.js';
import { showContours, levelOn } from '../../contours.js';
import { renderTempCard } from '../../thermo.js';
import { sonarExtras, scanDateOf } from '../../sonar.js';

async function renderSurveys(lake, el) {
  const surveys = await CA.bathymetryFor(lake);
  if (!surveys.length || !el.isConnected) return;
  el.innerHTML = `<div class="card"><h3>Depth chart</h3>${surveys.map((s, i) => `<div class="lake-item" style="margin:6px 0"><span class="small">${esc(s.title)}</span><button data-survey="${i}">Show</button></div>`).join('')}
    <p class="muted small">Public USGS survey contours, shown as depth at today's level when the lake has a CDEC gauge.</p></div>`;
  el.querySelectorAll('[data-survey]').forEach(b => b.onclick = () => showSurvey(surveys[+b.dataset.survey], lake));
}

async function depthFacts(lake) {
  const [est, surveys] = await Promise.all([CA.hydroFor(lake).catch(() => null), CA.bathymetryFor(lake).catch(() => [])]);
  const stat = (v, label) => v ? `<div class="stat"><b>${v}</b><span>${label}</span></div>` : '';
  let html = '';
  if (lake.maxDepth || lake.meanDepth) {
    html += `<div class="grid">${stat(lake.maxDepth && `${lake.maxDepth} ft`, 'Max depth')}${stat(lake.meanDepth && `${lake.meanDepth} ft`, 'Average depth')}${stat(lake.elevationFt?.toLocaleString() && `${lake.elevationFt.toLocaleString()} ft`, 'Surface elevation')}</div>
      <p class="muted small">${lake.depthSource === 'Wikidata' ? 'Depth from Wikidata (Wikipedia lake data).' : lake.depthSource === 'LAGOS' ? 'Depth from LAGOS-US DEPTH (published lake surveys).' : 'From your lake notes.'} Reservoirs vary with water level.</p>`;
  } else {
    html += surveys.length ? `<p class="muted small">Tap <b>Show</b> on the survey above for the full contour chart; the legend gives today's max depth.</p>`
      : `<p class="muted small">No published depth survey for this water yet. Your own Deeper scans are the best depth map you can have.</p>`;
    if (!est && lake.elevationFt) html += `<div class="grid">${stat(`${lake.elevationFt.toLocaleString()} ft`, 'Surface elevation')}</div>`;
  }
  if (est) {
    html += `<h4 style="margin:10px 0 4px">Estimated from the lake's shape</h4><div class="grid">${lake.meanDepth ? '' : stat(`${Math.round(est.meanDepthFt)} ft`, 'Average depth (est.)')}${stat(est.volumeAcreFt?.toLocaleString() && `${est.volumeAcreFt.toLocaleString()} ac·ft`, 'Volume (est.)')}${stat(est.shoreMi && `${est.shoreMi} mi`, 'Shoreline')}${stat(est.residenceDays && (est.residenceDays > 730 ? `${(est.residenceDays / 365).toFixed(1)} yr` : `${est.residenceDays} days`), 'Water turnover (est.)')}${(lake.maxDepth || lake.meanDepth) || !lake.elevationFt ? '' : stat(`${lake.elevationFt.toLocaleString()} ft`, 'Surface elevation')}</div>
      <p class="muted small">HydroLAKES models these from the shoreline and surrounding terrain; they are rough guides, not soundings.</p>`;
  }
  return html;
}

export async function renderDepth(lake, body) {
  if (lake.unsaved) {
    body.innerHTML = `<div id="surveys"></div><div class="card"><h3>Depth</h3>${await depthFacts(lake)}<p class="small">Save this water to import your Deeper scans and see them as a depth map.</p></div>`;
    renderSurveys(lake, $('#surveys'));
    return;
  }
  const sets = await db.byLake('depthSets', lake.id);
  const redraw = () => openLake(lake.id, 'depth');
  const maxOf = pts => pts.reduce((m, p) => Math.max(m, p[2]), 0);
  body.innerHTML = `<div id="surveys"></div><div class="card"><h3>Your depth maps</h3>
    ${sets.length ? `<button class="primary" id="contours">Contour map from ${sets.length === 1 ? 'your scan' : sets.length === 2 ? 'both scans' : `all ${sets.length} scans`}</button>` : ''}
    <p class="small">Import soundings from your Deeper (Fish Deeper → Lakebook → export) or any sonar: CSV with latitude, longitude and depth columns, or GPX/KML. Every scan of this lake is merged into one contour map.</p>
    <form class="form" id="depth-form"><div class="row"><label>Units in file <select name="units"><option value="ft">Feet</option><option value="m">Meters</option></select></label>
      <label>Name <input name="name" placeholder="Spring 2026 scan"></label></div>
      <label class="file-btn">Choose file… <input type="file" name="file" accept=".csv,.txt,.gpx,.kml" hidden></label></form>
    <div id="scan-review"></div>
    ${await depthFacts(lake)}</div>
    ${sets.map(s => `<div class="card lake-item"><div><b>${esc(s.name)}</b><div class="muted small">${s.points.length.toLocaleString()} points · max ${maxOf(s.points).toFixed(1)} ft · ${s.scanDate ? day(s.scanDate) : `imported ${fmtDate(s.createdAt)}`}${typeof s.levelFt === 'number' ? ` · level ${s.levelFt.toLocaleString()} ft` : ''}${s.temps?.length ? ' · 🌡' : ''}</div></div>
      <div class="acts"><button data-show="${esc(s.id)}">Show</button><button data-edit="${esc(s.id)}">Edit</button><button class="danger" data-del="${esc(s.id)}">✕</button></div></div>`).join('')}
    <div id="temps"></div><div id="waypoints"></div>`;
  body.querySelector('input[type=file]').onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    const f = Object.fromEntries(new FormData($('#depth-form')));
    try {
      const text = await file.text(), xml = /\.(gpx|kml)$/i.test(file.name);
      const { points, unitHint } = xml ? parseDepthXml(text) : parseDepthCsv(text);
      const meters = f.units === 'm' || /\(m\)|_m$|meter/.test(unitHint);
      if (meters) for (const p of points) p[2] *= M_TO_FT;
      const { times, temps } = sonarExtras(text, xml);
      const fromData = scanDateOf(times);
      $('#depth-form').classList.add('hidden');
      scanForm(lake, $('#scan-review'), {
        isNew: true, name: f.name || file.name.replace(/\.\w+$/, ''), scanDate: fromData ?? new Date(file.lastModified).toLocaleDateString('en-CA'),
        summary: `${points.length.toLocaleString()} soundings, deepest ${maxOf(points).toFixed(1)} ft${temps.length ? `, ${temps.length.toLocaleString()} temperature readings` : ''}. ${fromData ? 'Scan date read from the file.' : 'The date is when the file was saved; change it if you scanned on another day.'}`,
      }, async meta => {
        await db.put('depthSets', { lakeId: lake.id, ...meta, points, ...(temps.length ? { temps: temps.map(t => t.slice(0, 3)) } : {}), createdAt: new Date().toISOString() });
        status(`Imported ${points.length.toLocaleString()} depth points`);
        redraw();
      }, redraw);
    } catch (err) { alert(err.message); }
  };
  body.querySelectorAll('[data-show]').forEach(b => b.onclick = () => showDepthSet(b.dataset.show));
  body.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => {
    const set = sets.find(s => s.id === b.dataset.edit);
    $('#depth-form').classList.add('hidden');
    scanForm(lake, $('#scan-review'), { name: set.name, scanDate: set.scanDate, levelFt: set.levelFt, levelSource: set.levelSource }, async meta => { await db.put('depthSets', { ...set, ...meta }); redraw(); }, redraw);
    $('#scan-review').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  $('#contours')?.addEventListener('click', () => showContours(lake));
  renderSurveys(lake, $('#surveys'));
  renderTempCard(lake, $('#temps'), redraw);
  renderWaypointCard(lake, $('#waypoints'), redraw);
  body.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { if (confirm('Delete this depth map?')) { await db.del('depthSets', b.dataset.del); redraw(); } });
}

const day = d => fmtDate(`${d}T12:00`); // a date without a time, shown as that calendar day

// Name, scan date and the lake level that day, filled from CDEC when the lake has a gauge with a reading then.
// The level is what lets scans from different water levels share one contour map.
function scanForm(lake, el, draft, save, cancel) {
  el.innerHTML = `<form class="form inset" id="scan-form"><h4 class="sub">${draft.isNew ? 'Check the scan, then save' : 'Edit scan'}</h4>
    ${draft.summary ? `<p class="small">${esc(draft.summary)}</p>` : ''}
    <label>Name <input name="name" value="${esc(draft.name ?? '')}" required></label>
    <div class="row"><label>Scan date <input type="date" name="scanDate" value="${esc(draft.scanDate ?? '')}"></label>
      <label>Lake level that day (ft) <input type="number" step="0.01" name="levelFt" inputmode="decimal" value="${typeof draft.levelFt === 'number' ? draft.levelFt : ''}" placeholder="optional"></label></div>
    <p class="muted small" id="level-hint"></p>
    <div class="row"><button type="button" id="scan-cancel">Cancel</button><button class="primary">Save</button></div></form>`;
  const form = $('#scan-form', el), hintEl = $('#level-hint', el);
  // The level last filled in from the gauge, the date it was for, and the gauge. Seeded from the saved scan, so an
  // edit keeps a CDEC level the app no longer has a reading for (it only keeps about 30 days).
  const fromGauge = /^CDEC ./.test(draft.levelSource ?? '') && typeof draft.levelFt === 'number';
  let auto = fromGauge ? draft.levelFt : null, autoDate = fromGauge ? draft.scanDate : null, station = fromGauge ? draft.levelSource.slice(5) : null;
  const cdecLink = id => `<a href="https://cdec.water.ca.gov/dynamicapp/staMeta?station_id=${esc(id)}" target="_blank" rel="noopener">CDEC ↗</a>`;
  const hint = async () => {
    const date = form.scanDate.value;
    // A gauge reading belongs to its date: clear it only when the date has changed and the value wasn't retyped.
    const stale = () => { if (auto != null && date !== autoDate && +form.levelFt.value === auto) { form.levelFt.value = ''; auto = autoDate = null; } };
    if (!date) { stale(); hintEl.textContent = 'Add the date you scanned so scans from different water levels line up.'; return; }
    const lv = await levelOn(lake, date);
    if (form.scanDate.value !== date) return; // the date changed again while this was looking it up
    if (lv.station) station = lv.station;
    if (lv.levelFt != null) {
      if (form.levelFt.value === '' || +form.levelFt.value === auto) { form.levelFt.value = lv.levelFt; auto = lv.levelFt; autoDate = date; }
      hintEl.textContent = `CDEC ${lv.station} read ${lv.levelFt.toLocaleString()} ft on ${day(lv.date)}.`;
    } else if (lv.station) {
      stale();
      hintEl.innerHTML = lv.first
        ? `The ${esc(lv.station)} gauge readings in the app start ${day(lv.first)}. For an older scan, look the level up on ${cdecLink(lv.station)} and type it in, or leave it blank.`
        : `The ${esc(lv.station)} gauge doesn't report the lake level in the app. Look it up on ${cdecLink(lv.station)} and type it in, or leave it blank.`;
    } else {
      stale();
      hintEl.textContent = 'No lake level gauge for this water. Leave the level blank unless you know it; scans are then combined as recorded.';
    }
  };
  form.scanDate.onchange = hint;
  hint();
  $('#scan-cancel', el).onclick = cancel;
  const saveBtn = $('button.primary', el);
  form.onsubmit = async e => {
    e.preventDefault();
    if (saveBtn.disabled) return; // a second tap while a big scan is still saving
    saveBtn.disabled = true;
    const level = form.levelFt.value === '' ? null : +form.levelFt.value;
    try { await save({ name: form.name.value.trim(), scanDate: form.scanDate.value || null, levelFt: level, levelSource: level == null ? null : level === auto && station ? `CDEC ${station}` : 'entered' }); }
    catch (err) { saveBtn.disabled = false; alert(err.message); }
  };
}
