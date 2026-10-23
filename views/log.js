// The Log view: the catch form (with an automatic weather snapshot) and catch cards used across the app.
import { db } from '../db.js';
import { fetchWeather, pressureTrend, moonPhase, WEATHER_CODES, compass } from '../data-sources.js';
import { $, esc, fmtDate, fmtTime, status, localNow, onShow } from '../ui.js';
import { locate, refreshMap } from '../map.js';

export async function renderCatchForm() {
  const lakes = (await db.all('lakes')).sort((a, b) => a.name.localeCompare(b.name));
  const form = $('#catch-form');
  const current = form.lakeId.value;
  form.lakeId.innerHTML = lakes.length ? lakes.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('') : '<option value="">Add a lake first (Map → ＋ Lake here)</option>';
  if (current) form.lakeId.value = current;
  if (!form.time.value) form.time.value = localNow();
  const catches = (await db.all('catches')).sort((a, b) => b.time.localeCompare(a.time));
  renderCatchCards(catches.slice(0, 20), $('#catch-list'), lakes);
  $('#lure-list').innerHTML = [...new Set(catches.map(c => c.lure).filter(Boolean))].map(l => `<option value="${esc(l)}">`).join('');
}

$('#btn-gps').onclick = () => locate().then(p => { const f = $('#catch-form'); f.lat.value = p.lat.toFixed(6); f.lon.value = p.lon.toFixed(6); }).catch(e => status(e.message));

$('#catch-form').onsubmit = async e => {
  e.preventDefault();
  const form = e.target;
  const f = Object.fromEntries(new FormData(form));
  if (!f.lakeId) return alert('Add a lake first');
  const lake = await db.get('lakes', f.lakeId);
  const num = k => f[k] === '' ? null : +f[k];
  const record = {
    lakeId: f.lakeId, species: f.species.trim(), time: new Date(f.time).toISOString(),
    length: num('length'), weight: num('weight'), depth: num('depth'), waterTemp: num('waterTemp'),
    lure: f.lure.trim(), technique: f.technique.trim(), notes: f.notes.trim(), released: !!f.released,
    lat: f.lat ? +f.lat : lake.lat, lon: f.lon ? +f.lon : lake.lon,
    photo: form.photo.files[0] ? await shrinkPhoto(form.photo.files[0]) : null,
    moon: moonPhase(new Date(f.time)).name,
  };
  // Snapshot conditions when logging within a few hours of the catch.
  if (Math.abs(Date.now() - Date.parse(record.time)) < 3 * 3600e3) {
    try {
      const w = await fetchWeather(record.lat, record.lon);
      record.conditions = { airTemp: w.current.temperature_2m, wind: w.current.wind_speed_10m, windDir: w.current.wind_direction_10m, gusts: w.current.wind_gusts_10m,
        pressureInHg: +(w.current.pressure_msl * 0.02953).toFixed(2), pressureTrend: pressureTrend(w)?.label, sky: WEATHER_CODES[w.current.weather_code], cloud: w.current.cloud_cover };
    } catch { /* offline on the water: save without conditions */ }
  }
  await db.put('catches', record);
  form.reset(); form.lakeId.value = record.lakeId; form.time.value = localNow();
  status('Catch saved 🎣');
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

export async function renderCatchCards(catches, el, lakes) {
  lakes ??= await db.all('lakes');
  const lakeName = Object.fromEntries(lakes.map(l => [l.id, l.name]));
  el.innerHTML = catches.length ? '' : '<div class="card muted">No catches yet.</div>';
  for (const c of catches) {
    const card = document.createElement('div');
    card.className = 'card catch';
    const cond = c.conditions;
    card.innerHTML = `${c.photo ? `<img src="${URL.createObjectURL(c.photo)}" alt="">` : ''}<div style="flex:1">
      <b>${esc(c.species)}</b> ${c.length ? `${c.length}"` : ''} ${c.weight ? `${c.weight} lb` : ''} ${c.released ? '<span class="muted small">released</span>' : ''}
      <div class="muted small">${esc(lakeName[c.lakeId] || '')} · ${fmtDate(c.time)} ${fmtTime(c.time)}</div>
      <div class="small">${[c.lure, c.technique, c.depth != null && `${c.depth} ft`, c.waterTemp != null && `water ${c.waterTemp}°F`].filter(Boolean).map(esc).join(' · ')}</div>
      ${cond ? `<div class="muted small">${Math.round(cond.airTemp)}°F · ${compass(cond.windDir)} ${Math.round(cond.wind)} mph · ${cond.pressureInHg}" ${cond.pressureTrend ?? ''} · ${esc(cond.sky)} · ${esc(c.moon)}</div>` : ''}
      ${c.notes ? `<div class="small" style="white-space:pre-wrap">${esc(c.notes)}</div>` : ''}
      <a href="#" class="small danger" data-del>delete</a></div>`;
    card.querySelector('[data-del]').onclick = async e => {
      e.preventDefault();
      if (!confirm('Delete this catch?')) return;
      await db.del('catches', c.id); card.remove(); refreshMap();
    };
    el.append(card);
  }
}

onShow('log', renderCatchForm);
