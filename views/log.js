// The Log view: the catch form (with an automatic weather snapshot) and catch cards used across the app.
import { db } from '../db.js';
import { fetchWeather, pressureTrend, moonPhase, WEATHER_CODES, compass } from '../data-sources.js';
import { $, esc, fmtDate, fmtTime, status, localNow, onShow, showView } from '../ui.js';
import { locate, refreshMap } from '../map.js';
import { units, fromLen, fromWt, fromDepth, toLen, toWt, toDepth, fmtLen, fmtWt, fmtDepth } from '../units.js';
import { estimateWeight } from '../weight.js';
import { activeTrip, openTrip, startTripFlow } from './trips.js';
import { tackleLabel } from './tackle.js';

let editing = null; // the catch being edited, or null for a new one

export async function renderCatchForm() {
  const [lakes, tackle] = await Promise.all([db.all('lakes'), db.all('tackle')]);
  lakes.sort((a, b) => a.name.localeCompare(b.name));
  const form = $('#catch-form');
  const current = form.lakeId.value;
  form.lakeId.innerHTML = lakes.length ? lakes.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('') : '<option value="">Add a lake first (Map → ＋ Lake here)</option>';
  if (current) form.lakeId.value = current;
  if (!form.time.value) form.time.value = localNow();
  const u = units();
  document.querySelectorAll('[data-unit]').forEach(s => s.textContent = u[s.dataset.unit]);
  const tackleId = form.tackleId.value;
  form.tackleId.innerHTML = '<option value="">–</option>' + tackle.sort((a, b) => tackleLabel(a).localeCompare(tackleLabel(b))).map(t => `<option value="${t.id}">${esc(tackleLabel(t))}</option>`).join('');
  form.tackleId.value = tackleId;
  form.tackleId.closest('label').classList.toggle('hidden', !tackle.length);
  const trip = await activeTrip();
  $('#btn-start-trip').textContent = trip ? '● Trip in progress: open trip mode' : '▶ Trip mode: one-tap logging with GPS track';
  const catches = (await db.all('catches')).sort((a, b) => b.time.localeCompare(a.time));
  renderCatchCards(catches.slice(0, 20), $('#catch-list'), lakes);
  $('#lure-list').innerHTML = [...new Set([...tackle.map(tackleLabel), ...catches.map(c => c.lure)].filter(Boolean))].map(l => `<option value="${esc(l)}">`).join('');
  showEstimate();
}

$('#btn-gps').onclick = () => locate().then(p => { const f = $('#catch-form'); f.lat.value = p.lat.toFixed(6); f.lon.value = p.lon.toFixed(6); }).catch(e => status(e.message));
$('#btn-start-trip').onclick = async () => { const t = await activeTrip(); t ? openTrip(t.id) : startTripFlow(); };
$('#btn-cancel-edit').onclick = () => { resetForm(); renderCatchForm(); };
$('#catch-form').tackleId.onchange = async e => {
  const t = e.target.value && await db.get('tackle', e.target.value);
  if (t) $('#catch-form').lure.value = tackleLabel(t);
};
// While weight is blank, show the length-based estimate as its placeholder.
const showEstimate = () => {
  const f = $('#catch-form');
  const est = estimateWeight(f.species.value, fromLen(f.length.value === '' ? null : +f.length.value));
  f.weight.placeholder = est ? `≈ ${toWt(est)} estimated` : '';
};
$('#catch-form').species.addEventListener('input', showEstimate);
$('#catch-form').length.addEventListener('input', showEstimate);

// Current weather, wind, pressure and sky at a spot, or null when offline.
export async function snapshotConditions(lat, lon) {
  try {
    const w = await fetchWeather(lat, lon);
    return { airTemp: w.current.temperature_2m, wind: w.current.wind_speed_10m, windDir: w.current.wind_direction_10m, gusts: w.current.wind_gusts_10m,
      pressureInHg: +(w.current.pressure_msl * 0.02953).toFixed(2), pressureTrend: pressureTrend(w)?.label, sky: WEATHER_CODES[w.current.weather_code], cloud: w.current.cloud_cover };
  } catch { return null; } // offline on the water: save without conditions
}

function resetForm() {
  const form = $('#catch-form');
  const lakeId = form.lakeId.value;
  editing = null;
  form.reset(); form.lakeId.value = lakeId; form.time.value = localNow();
  $('#catch-form-title').textContent = 'Log a catch';
  $('#btn-cancel-edit').classList.add('hidden');
}

// Opens the full form on an existing catch, e.g. to add details to a one-tap trip catch.
export async function editCatch(id) {
  const c = await db.get('catches', id);
  showView('log', { render: false });
  await renderCatchForm();
  editing = c;
  const f = $('#catch-form');
  const local = new Date(Date.parse(c.time) - new Date(c.time).getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
  const vals = { lakeId: c.lakeId, species: c.species, time: local, length: toLen(c.length), weight: toWt(c.weight), depth: toDepth(c.depth), waterTemp: c.waterTemp,
    tackleId: c.tackleId || '', lure: c.lure, technique: c.technique, notes: c.notes, lat: c.lat, lon: c.lon };
  for (const [k, v] of Object.entries(vals)) f[k].value = v ?? '';
  f.released.checked = !!c.released;
  $('#catch-form-title').textContent = 'Edit catch';
  $('#btn-cancel-edit').classList.remove('hidden');
  showEstimate();
  $('#view-log').scrollTop = 0;
}

$('#catch-form').onsubmit = async e => {
  e.preventDefault();
  const form = e.target;
  const f = Object.fromEntries(new FormData(form));
  if (!f.lakeId) return alert('Add a lake first');
  const lake = await db.get('lakes', f.lakeId);
  const num = k => f[k] === '' ? null : +f[k];
  const time = new Date(f.time).toISOString();
  const record = {
    ...editing,
    lakeId: f.lakeId, species: f.species.trim(), time,
    length: fromLen(num('length')), weight: fromWt(num('weight')), depth: fromDepth(num('depth')), waterTemp: num('waterTemp'),
    lure: f.lure.trim(), technique: f.technique.trim(), notes: f.notes.trim(), released: !!f.released,
    lat: f.lat ? +f.lat : lake.lat, lon: f.lon ? +f.lon : lake.lon,
    photo: form.photo.files[0] ? await shrinkPhoto(form.photo.files[0]) : editing?.photo ?? null,
    moon: moonPhase(new Date(f.time)).name,
    tackleId: f.tackleId || null,
  };
  record.weightEst = record.weight == null ? estimateWeight(record.species, record.length) : null;
  if (!editing) {
    const trip = await activeTrip();
    if (trip && trip.lakeId === record.lakeId) record.tripId = trip.id;
  }
  // Snapshot conditions when logging within a few hours of the catch.
  if (!record.conditions && Math.abs(Date.now() - Date.parse(record.time)) < 3 * 3600e3) {
    record.conditions = await snapshotConditions(record.lat, record.lon) ?? undefined;
  }
  await db.put('catches', record);
  status(editing ? 'Catch updated' : 'Catch saved 🎣');
  resetForm();
  await refreshMap();
  renderCatchForm();
};

// Keep photos small so IndexedDB and backups stay manageable.
export async function shrinkPhoto(file, maxDim = 1600) {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
}

// Weight as logged, or the length-based estimate marked with ≈ (worked out on the fly for catches logged before estimates).
export const weightEstimate = c => c.weight ? null : c.weightEst ?? estimateWeight(c.species, c.length);
export const weightText = c => c.weight ? fmtWt(c.weight) : weightEstimate(c) ? `≈${fmtWt(weightEstimate(c))}` : '';

export async function renderCatchCards(catches, el, lakes) {
  lakes ??= await db.all('lakes');
  const lakeName = Object.fromEntries(lakes.map(l => [l.id, l.name]));
  el.innerHTML = catches.length ? '' : '<div class="card muted">No catches yet.</div>';
  for (const c of catches) {
    const card = document.createElement('div');
    card.className = 'card catch';
    const cond = c.conditions;
    card.innerHTML = `${c.photo ? `<img src="${URL.createObjectURL(c.photo)}" alt="">` : ''}<div style="flex:1">
      <b>${esc(c.species)}</b> ${fmtLen(c.length)} ${weightText(c)} ${c.released ? '<span class="muted small">released</span>' : ''}
      <div class="muted small">${esc(lakeName[c.lakeId] || '')} · ${fmtDate(c.time)} ${fmtTime(c.time)}${c.tripId ? ` · <a href="#" data-trip>trip</a>` : ''}</div>
      <div class="small">${[c.lure, c.technique, c.depth != null && fmtDepth(c.depth), c.waterTemp != null && `water ${c.waterTemp}°F`].filter(Boolean).map(esc).join(' · ')}</div>
      ${cond ? `<div class="muted small">${Math.round(cond.airTemp)}°F · ${compass(cond.windDir)} ${Math.round(cond.wind)} mph · ${cond.pressureInHg}" ${cond.pressureTrend ?? ''} · ${esc(cond.sky)} · ${esc(c.moon)}</div>` : ''}
      ${c.notes ? `<div class="small" style="white-space:pre-wrap">${esc(c.notes)}</div>` : ''}
      <a href="#" class="small" data-edit>edit</a> · <a href="#" class="small danger" data-del>delete</a></div>`;
    card.querySelector('[data-edit]').onclick = e => { e.preventDefault(); editCatch(c.id); };
    card.querySelector('[data-trip]')?.addEventListener('click', e => { e.preventDefault(); openTrip(c.tripId); });
    card.querySelector('[data-del]').onclick = async e => {
      e.preventDefault();
      if (!confirm('Delete this catch?')) return;
      await db.del('catches', c.id); card.remove(); refreshMap();
    };
    el.append(card);
  }
}

onShow('log', renderCatchForm);
