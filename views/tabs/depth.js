// Depth tab: published depth facts, USGS survey contours, and your own sonar imports.
import { db } from '../../db.js';
import { forLake } from '../../states/index.js';
import { parseDepthCsv, parseDepthXml } from '../../data-sources.js';
import { $, esc, fmtDate, status, M_TO_FT } from '../../ui.js';
import { showDepthSet, showSurvey } from '../../map.js';
import { openLake } from '../lake.js';

async function renderSurveys(lake, el) {
  const surveys = await forLake(lake)?.bathymetryFor(lake) ?? [];
  if (!surveys.length || !el.isConnected) return;
  el.innerHTML = `<div class="card"><h3>Depth chart</h3>${surveys.map((s, i) => `<div class="lake-item" style="margin:6px 0"><span class="small">${esc(s.title)}</span><button data-survey="${i}">Show</button></div>`).join('')}
    <p class="muted small">Public USGS survey contours, shown as depth at today's level when the lake has a level gauge.</p></div>`;
  el.querySelectorAll('[data-survey]').forEach(b => b.onclick = () => showSurvey(surveys[+b.dataset.survey], lake));
}

async function depthFacts(lake) {
  const S = forLake(lake);
  const [est, surveys] = await Promise.all([S?.hydroFor(lake).catch(() => null), S?.bathymetryFor(lake).catch(() => []) ?? []]);
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
  body.innerHTML = `<div id="surveys"></div><div class="card"><h3>Your depth maps</h3>
    <p class="small">Import soundings from your Deeper (Fish Deeper → Lakebook → export) or any sonar: CSV with latitude, longitude and depth columns, or GPX/KML.</p>
    <form class="form" id="depth-form"><div class="row"><label>Units in file <select name="units"><option value="ft">Feet</option><option value="m">Meters</option></select></label>
      <label>Name <input name="name" placeholder="Spring 2026 scan"></label></div>
      <label class="file-btn">Choose file… <input type="file" name="file" accept=".csv,.txt,.gpx,.kml" hidden></label></form>
    ${await depthFacts(lake)}</div>
    ${sets.map(s => `<div class="card lake-item"><div><b>${esc(s.name)}</b><div class="muted small">${s.points.length.toLocaleString()} points · max ${Math.max(...s.points.map(p => p[2])).toFixed(1)} ft · ${fmtDate(s.createdAt)}</div></div>
      <div><button data-show="${s.id}">Show</button> <button class="danger" data-del="${s.id}">✕</button></div></div>`).join('')}`;
  body.querySelector('input[type=file]').onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    const f = Object.fromEntries(new FormData($('#depth-form')));
    try {
      const text = await file.text();
      const { points, unitHint } = /\.(gpx|kml)$/i.test(file.name) ? parseDepthXml(text) : parseDepthCsv(text);
      const meters = f.units === 'm' || /\(m\)|_m$|meter/.test(unitHint);
      if (meters) for (const p of points) p[2] *= M_TO_FT;
      await db.put('depthSets', { lakeId: lake.id, name: f.name || file.name, points, createdAt: new Date().toISOString() });
      status(`Imported ${points.length.toLocaleString()} depth points`);
      openLake(lake.id, 'depth');
    } catch (err) { alert(err.message); }
  };
  body.querySelectorAll('[data-show]').forEach(b => b.onclick = () => showDepthSet(b.dataset.show));
  renderSurveys(lake, $('#surveys'));
  body.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { if (confirm('Delete this depth map?')) { await db.del('depthSets', b.dataset.del); openLake(lake.id, 'depth'); } });
}
