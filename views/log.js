// The Log view: the catch form (with an automatic weather snapshot) and catch cards used across the app.
import { db } from '../db.js';
import { fetchWeather, pressureTrend, moonPhase, WEATHER_CODES, compass } from '../data-sources.js';
import { $, esc, fmtDate, fmtTime, status, localNow, onShow, showView, undoBar } from '../ui.js';
import { locate, refreshMap } from '../map.js';
import { units, reunit, display, fromLen, fromWt, fromDepth, fromTemp, toLen, toWt, toDepth, toTemp, fmtLen, fmtWt, fmtDepth, fmtTemp } from '../units.js';
import { estimateWeight } from '../weight.js';
import { activeTrip, openTrip, startTripFlow } from './trips.js';
import { tackleLabel } from './tackle.js';
import { showCatchWarnings } from './catch-warnings.js';
import { fmtSpeed } from '../troll.js';
import { openComposer } from '../crew.js';
import { readExif } from '../exif.js';
import { matchWater } from './backfill.js';
import { pastConditions } from '../past-weather.js';
import { openCatch, openViewer } from './catch.js';

let editing = null; // the catch being edited, or null for a new one
let photos = []; // the form's photos, already shrunk: the first is the catch's main photo
let pendingPhotos = Promise.resolve(); // photos still being read when Save is tapped
let lastCatch = null; // the newest catch, for Same as last
const DRAFT = 'tackle-box-catch-draft'; // a half-typed new catch, kept if the app is closed
const DRAFT_FIELDS = ['lakeId', 'species', 'length', 'weight', 'tackleId', 'lure', 'time', 'count', 'notes', 'tags', 'depth', 'waterTemp', 'clarity', 'technique', 'lat', 'lon'];
let draftChecked = false;

// A catch's tags: what you typed, split on commas, trimmed, no repeats.
export const parseTags = text => [...new Map(String(text ?? '').split(',').map(t => t.trim()).filter(Boolean).map(t => [t.toLowerCase(), t])).values()];

// All of a catch's photos: `photo` is the main one (what cards, shares and Stats show), `photos` holds the rest.
export const catchPhotos = c => [c.photo, ...(Array.isArray(c.photos) ? c.photos : [])].filter(p => p instanceof Blob);

export async function renderCatchForm() {
  const [lakes, tackle] = await Promise.all([db.all('lakes'), db.all('tackle')]);
  lakes.sort((a, b) => a.name.localeCompare(b.name));
  const form = $('#catch-form');
  const current = form.lakeId.value;
  form.lakeId.innerHTML = lakes.length ? lakes.map(l => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('') : '<option value="">Add a lake first (Map → ＋ Lake here)</option>';
  if (current) form.lakeId.value = current;
  // A new catch defaults to now: keep the time fresh until you change it yourself.
  if (!form.time.value || (!editing && form.time.dataset.auto)) { form.time.value = localNow(); form.time.dataset.auto = '1'; }
  const u = units();
  document.querySelectorAll('[data-unit]').forEach(s => s.textContent = u[s.dataset.unit]);
  // If the units setting changed while the form had values, convert them rather than reading them in the new unit.
  const was = form.dataset.units ? JSON.parse(form.dataset.units) : u;
  for (const [k, field] of [['length', 'length'], ['weight', 'weight'], ['depth', 'depth'], ['temp', 'waterTemp']]) {
    if ((was[k] ?? u[k]) === u[k] || form[field].value === '') continue;
    // A value still showing the stored one is re-shown from the stored value, so it stays untouched on save.
    form[field].value = editing && +form[field].value === display(k, editing[field], was[k]) ? display(k, editing[field], u[k]) : reunit(+form[field].value, k, was[k], u[k]);
  }
  form.dataset.units = JSON.stringify(u);
  const tackleId = form.tackleId.value;
  form.tackleId.innerHTML = '<option value="">–</option>' + tackle.sort((a, b) => tackleLabel(a).localeCompare(tackleLabel(b))).map(t => `<option value="${esc(t.id)}">${esc(tackleLabel(t))}</option>`).join('');
  form.tackleId.value = tackleId;
  form.tackleId.closest('label').classList.toggle('hidden', !tackle.length);
  const trip = await activeTrip();
  $('#btn-start-trip').textContent = trip ? '● Trip in progress: open trip mode' : '▶ Trip mode: one-tap logging with GPS track';
  const catches = (await db.all('catches')).sort((a, b) => b.time.localeCompare(a.time));
  renderCatchCards(catches.slice(0, 20), $('#catch-list'), lakes);
  renderSpeciesChips(catches);
  lastCatch = catches[0] ?? null;
  showSameAsLast(lakes);
  renderTagChips(catches);
  if (!draftChecked) { draftChecked = true; restoreDraft(); }
  $('#lure-list').innerHTML = [...new Set([...tackle.map(tackleLabel), ...catches.map(c => c.lure)].filter(Boolean))].map(l => `<option value="${esc(l)}">`).join('');
  showEstimate();
  showCatchWarnings(form, editing?.id);
}

// One-tap species: the ones you catch most, or a few common ones before your first catch.
function renderSpeciesChips(catches) {
  const n = {};
  for (const c of catches) if (c.species) n[c.species] = (n[c.species] ?? 0) + 1;
  const top = Object.keys(n).sort((a, b) => n[b] - n[a]).slice(0, 6);
  const picks = top.length ? top : ['Rainbow trout', 'Largemouth bass', 'Smallmouth bass', 'Striped bass', 'Channel catfish', 'Crappie'];
  $('#species-chips').innerHTML = picks.map(s => `<button type="button" data-species="${esc(s)}">${esc(s)}</button>`).join('');
}
$('#species-chips').onclick = e => {
  const s = e.target.closest('[data-species]')?.dataset.species;
  if (!s) return;
  const f = $('#catch-form');
  f.species.value = s;
  f.species.dispatchEvent(new Event('input', { bubbles: true }));
};

// ---------- Same as last, how many, tags ----------
function showSameAsLast(lakes) {
  const b = $('#btn-same'), c = lastCatch;
  b.classList.toggle('hidden', !c || !!editing);
  if (!c) return;
  const lake = lakes.find(l => l.id === c.lakeId);
  b.textContent = `↺ Same as last: ${[c.species, c.lure, lake?.name].filter(Boolean).join(' · ')}`;
}
// Copies the water, species, lure, technique, depth, clarity, spot, tags and Released from your newest catch. Size, notes and photos start blank.
$('#btn-same').onclick = async () => {
  const c = lastCatch, f = $('#catch-form');
  if (!c || editing) return;
  if (await db.get('lakes', c.lakeId)) f.lakeId.value = c.lakeId;
  const tackleOk = c.tackleId && [...f.tackleId.options].some(o => o.value === c.tackleId);
  f.species.value = c.species ?? ''; f.lure.value = c.lure ?? ''; f.technique.value = c.technique ?? '';
  f.tackleId.value = tackleOk ? c.tackleId : '';
  f.depth.value = toDepth(c.depth) ?? ''; f.clarity.value = c.clarity ?? '';
  f.lat.value = c.lat ?? ''; f.lon.value = c.lon ?? '';
  f.tags.value = (c.tags ?? []).join(', ');
  f.released.checked = !!c.released;
  if ([c.depth, c.clarity, c.technique].some(v => v != null && v !== '')) $('#more-details').open = true;
  f.species.dispatchEvent(new Event('input', { bubbles: true }));
  saveDraft();
  renderTagChips();
  status('Copied from your last catch');
};

const countOf = f => Math.min(200, Math.max(1, Math.round(+f.count.value) || 1));
$('#catch-form').count.addEventListener('input', e => $('#count-hint').classList.toggle('hidden', countOf(e.target.form) < 2));

// Your tags, most used first: tap one to add it to (or take it off) the Tags field.
let tagCounts = {};
function renderTagChips(catches) {
  if (catches) { tagCounts = {}; for (const c of catches) for (const t of c.tags ?? []) tagCounts[t] = (tagCounts[t] ?? 0) + 1; }
  const on = new Set(parseTags($('#catch-form').tags.value).map(t => t.toLowerCase()));
  const tags = Object.keys(tagCounts).sort((a, b) => tagCounts[b] - tagCounts[a]).slice(0, 12);
  $('#tag-chips').innerHTML = tags.map(t => `<button type="button" data-tag="${esc(t)}" class="${on.has(t.toLowerCase()) ? 'on' : ''}">${esc(t)}</button>`).join('');
}
$('#tag-chips').onclick = e => {
  const t = e.target.closest('[data-tag]')?.dataset.tag;
  if (!t) return;
  const f = $('#catch-form'), cur = parseTags(f.tags.value);
  const has = cur.some(x => x.toLowerCase() === t.toLowerCase());
  f.tags.value = (has ? cur.filter(x => x.toLowerCase() !== t.toLowerCase()) : [...cur, t]).join(', ');
  renderTagChips(); saveDraft();
};
$('#catch-form').tags.addEventListener('input', () => renderTagChips());

// ---------- The draft: a new catch you started is kept (without photos) if the app closes before you save ----------
function saveDraft() {
  if (editing) return;
  const f = $('#catch-form');
  const d = Object.fromEntries(DRAFT_FIELDS.map(k => [k, f[k].value]));
  if (f.time.dataset.auto) delete d.time;
  const typed = ['species', 'length', 'weight', 'lure', 'notes', 'tags', 'depth', 'waterTemp', 'technique'].some(k => d[k]);
  try {
    if (typed) localStorage.setItem(DRAFT, JSON.stringify({ ...d, released: f.released.checked, units: units(), savedAt: Date.now() }));
    else localStorage.removeItem(DRAFT);
  } catch { /* storage full or blocked: no draft */ }
}
const clearDraft = () => { try { localStorage.removeItem(DRAFT); } catch { /* blocked */ } };
function restoreDraft(quiet = false) {
  let d;
  try { d = JSON.parse(localStorage.getItem(DRAFT)); } catch { return; }
  if (!d || editing || Date.now() - d.savedAt > 3 * 86400e3) return clearDraft();
  const f = $('#catch-form');
  for (const k of DRAFT_FIELDS) if (d[k] != null && d[k] !== '' && !(k === 'lakeId' && ![...f.lakeId.options].some(o => o.value === d[k]))) f[k].value = d[k];
  // Sizes typed under other unit settings are shown in today's.
  const u = units();
  for (const [k, field] of [['length', 'length'], ['weight', 'weight'], ['depth', 'depth'], ['temp', 'waterTemp']]) {
    if (d[field] !== '' && d[field] != null && d.units?.[k] && d.units[k] !== u[k]) f[field].value = reunit(+d[field], k, d.units[k], u[k]);
  }
  if (d.time) delete f.time.dataset.auto;
  f.released.checked = d.released !== false;
  if (['depth', 'waterTemp', 'clarity', 'technique'].some(k => d[k])) $('#more-details').open = true;
  $('#count-hint').classList.toggle('hidden', countOf(f) < 2);
  f.species.dispatchEvent(new Event('input', { bubbles: true }));
  renderTagChips();
  if (!quiet) status('Your unsaved catch is back');
}
for (const type of ['input', 'change']) $('#catch-form').addEventListener(type, e => { if (e.target.name !== 'photo') saveDraft(); });

function drawFormPhotos() {
  const box = $('#form-photos');
  box.innerHTML = photos.map((p, i) => `<span class="ph"><img src="${URL.createObjectURL(p)}" alt="" data-view="${i}"><a href="#" data-rm="${i}" aria-label="Remove photo">✕</a></span>`).join('');
  box.querySelectorAll('[data-rm]').forEach(a => a.onclick = e => { e.preventDefault(); photos.splice(+a.dataset.rm, 1); drawFormPhotos(); });
  box.querySelectorAll('[data-view]').forEach(img => img.onclick = () => openViewer(photos, +img.dataset.view));
}

// The first photo of a new catch fills in when (if you haven't set it) and where it was taken, read on this phone.
async function fillFromPhoto(file) {
  const f = $('#catch-form'), hint = $('#photo-hint');
  let ex = {};
  try { ex = await readExif(file); } catch { /* no EXIF: nothing to fill */ }
  const got = [];
  if (ex.time && f.time.dataset.auto && Math.abs(Date.parse(ex.time) - Date.now()) > 15 * 60e3 && Date.parse(ex.time) < Date.now()) {
    const d = new Date(ex.time);
    f.time.value = new Date(d - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
    delete f.time.dataset.auto;
    got.push(`${fmtDate(ex.time)} ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`);
  }
  if (ex.lat != null && f.lat.value === '' && f.lon.value === '') {
    f.lat.value = ex.lat.toFixed(6); f.lon.value = ex.lon.toFixed(6);
    const lake = matchWater(ex.lat, ex.lon, await db.all('lakes'), null).lake;
    if (lake) f.lakeId.value = lake.id;
    got.push(lake ? `the spot on ${lake.name}` : 'the spot');
  }
  hint.textContent = got.length ? `From the photo: ${got.join(' · ')}` : '';
  hint.classList.toggle('hidden', !got.length);
  if (got.length) showCatchWarnings(f, editing?.id);
}

$('#catch-form').photo.onchange = e => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  const was = editing;
  const first = !editing && !photos.length;
  const job = (async () => {
    if (first) await fillFromPhoto(files[0]);
    const shrunk = await Promise.allSettled(files.map(x => shrinkPhoto(x)));
    if (editing !== was) return; // another catch was opened meanwhile
    const ok = shrunk.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
    photos.push(...ok);
    drawFormPhotos();
    if (ok.length < files.length) status(`Couldn't read ${files.length - ok.length} photo${files.length - ok.length === 1 ? '' : 's'}`);
  })();
  pendingPhotos = pendingPhotos.then(() => job, () => job);
};

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
$('#catch-form').time.addEventListener('input', e => delete e.target.dataset.auto);
$('#catch-form').length.addEventListener('input', showEstimate);
// Regulation warnings follow the water, species, size, date and Released box.
const WARN_FIELDS = ['lakeId', 'species', 'length', 'time', 'released'];
for (const type of ['input', 'change']) $('#catch-form').addEventListener(type, e => WARN_FIELDS.includes(e.target.name) && showCatchWarnings(e.currentTarget, editing?.id));

// Current weather, wind, pressure and sky at a spot, or null when offline.
export async function snapshotConditions(lat, lon) {
  try {
    const w = await fetchWeather(lat, lon);
    return { airTemp: w.current.temperature_2m, wind: w.current.wind_speed_10m, windDir: w.current.wind_direction_10m, gusts: w.current.wind_gusts_10m,
      pressureInHg: +(w.current.pressure_msl * 0.02953).toFixed(2), pressureTrend: pressureTrend(w)?.label, sky: WEATHER_CODES[w.current.weather_code], cloud: w.current.cloud_cover };
  } catch { return null; } // offline on the water: save without conditions
}

// "Log a catch here" from a water's Catches tab: always a new catch, on that water.
export async function logCatchAt(lakeId) {
  if (editing) resetForm(); // a half-typed new catch is kept, just moved to this water
  showView('log', { render: false });
  await renderCatchForm();
  $('#catch-form').lakeId.value = lakeId;
}

function resetForm() {
  const form = $('#catch-form');
  const lakeId = form.lakeId.value;
  const wasEditing = !!editing;
  editing = null;
  form.reset(); form.lakeId.value = lakeId; form.time.value = localNow(); form.time.dataset.auto = '1';
  $('#catch-form-title').textContent = 'Log a catch';
  $('#btn-cancel-edit').classList.add('hidden');
  $('#more-details').open = false;
  photos = []; drawFormPhotos();
  $('#photo-hint').classList.add('hidden');
  $('#count-hint').classList.add('hidden');
  $('#count-label').classList.remove('hidden');
  // After editing an older catch, the new one you'd started comes back; after saving a new one, its draft is done.
  if (wasEditing) restoreDraft(true); else clearDraft();
}

// Opens the full form on an existing catch, e.g. to add details to a one-tap trip catch.
export async function editCatch(id) {
  const c = await db.get('catches', id);
  showView('log', { render: false });
  await renderCatchForm();
  editing = c;
  const f = $('#catch-form');
  const local = new Date(Date.parse(c.time) - new Date(c.time).getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
  const vals = { lakeId: c.lakeId, species: c.species, time: local, length: toLen(c.length), weight: toWt(c.weight), depth: toDepth(c.depth), waterTemp: toTemp(c.waterTemp), clarity: c.clarity,
    tackleId: c.tackleId || '', lure: c.lure, technique: c.technique, notes: c.notes, lat: c.lat, lon: c.lon, tags: (c.tags ?? []).join(', '), count: 1 };
  for (const [k, v] of Object.entries(vals)) f[k].value = v ?? '';
  delete f.time.dataset.auto;
  f.time.dataset.loaded = local; // the field has minute precision; an unchanged field keeps the stored time
  f.released.checked = !!c.released;
  photos = catchPhotos(c); drawFormPhotos();
  $('#photo-hint').classList.add('hidden');
  $('#more-details').open = [c.depth, c.waterTemp, c.clarity, c.technique].some(v => v != null && v !== '');
  $('#catch-form-title').textContent = 'Edit catch';
  $('#count-label').classList.add('hidden'); $('#count-hint').classList.add('hidden');
  $('#btn-same').classList.add('hidden');
  renderTagChips();
  $('#btn-cancel-edit').classList.remove('hidden');
  showEstimate();
  showCatchWarnings(f, c.id);
  $('#view-log').scrollTop = 0;
}

$('#catch-form').onsubmit = async e => {
  e.preventDefault();
  const form = e.target;
  const submit = form.querySelector('[type=submit]');
  submit.disabled = true;
  try {
    await pendingPhotos; // a photo being read may still fill in the time and water
    const f = Object.fromEntries(new FormData(form));
    if (!f.lakeId) return alert('Add a lake first');
    const editingAtStart = editing;
    // Build on the stored catch, not the copy taken when editing began (a trip's weather snapshot may have landed since).
    const base = editing && await db.get('catches', editing.id);
    if (editing && !base) { resetForm(); return status('That catch was deleted'); }
    const lake = await db.get('lakes', f.lakeId);
    const num = k => f[k] === '' ? null : +f[k];
    // Fields left as shown keep their stored value, so editing in cm/kg/m doesn't nudge them by rounding.
    const keep = (k, to, from) => base && f[k] !== '' && +f[k] === to(base[k]) ? base[k] : from(num(k));
    const time = base && f.time === form.time.dataset.loaded ? base.time : !base && form.time.dataset.auto ? new Date().toISOString() : new Date(f.time).toISOString();
    const moved = base && base.lakeId !== f.lakeId;
    const oldLake = moved && await db.get('lakes', base.lakeId);
    const atOldLake = oldLake && +f.lat === oldLake.lat && +f.lon === oldLake.lon;
    const record = {
      ...base,
      lakeId: f.lakeId, species: f.species.trim(), time,
      length: keep('length', toLen, fromLen), weight: keep('weight', toWt, fromWt), depth: keep('depth', toDepth, fromDepth), waterTemp: keep('waterTemp', toTemp, fromTemp),
      lure: f.lure.trim(), technique: f.technique.trim(), notes: f.notes.trim(), released: !!f.released,
      lat: f.lat && !atOldLake ? +f.lat : lake.lat, lon: f.lon && !atOldLake ? +f.lon : lake.lon,
      photo: photos[0] ?? null, photos: photos.slice(1),
      moon: moonPhase(new Date(time)).name,
      tackleId: f.tackleId || null,
      clarity: f.clarity || null,
      tags: parseTags(f.tags),
    };
    record.weightEst = record.weight == null ? estimateWeight(record.species, record.length) : null;
    // Weather from another time or water doesn't belong to this catch any more.
    if (base && (moved || Math.abs(Date.parse(time) - Date.parse(base.time)) > 3 * 3600e3)) delete record.conditions;
    // A catch belongs to a trip on the same water whose time span holds it.
    const inTrip = t => t && t.lakeId === record.lakeId && time >= t.start.slice(0, 16) && time <= (t.end ?? new Date(Date.now() + 5 * 60e3).toISOString());
    if (base?.tripId && !inTrip(await db.get('trips', base.tripId))) record.tripId = null;
    if (!base) { const trip = await activeTrip(); if (inTrip(trip)) record.tripId = trip.id; }
    // Snapshot conditions when logging within a few hours of the catch, or look up that hour's weather for an older one.
    // Only the water's coordinates (and the date) are sent, never your spot.
    if (!record.conditions) {
      record.conditions = (Math.abs(Date.now() - Date.parse(record.time)) < 3 * 3600e3 ? await snapshotConditions(lake.lat, lake.lon)
        : await pastConditions(lake.lat, lake.lon, record.time)) ?? undefined;
    }
    await db.put('catches', record);
    // How many: the same fish again, without the size, photos and notes (those stay on the first).
    const more = base ? 0 : countOf(form) - 1;
    for (let i = 0; i < more; i++) {
      const { id, updatedAt, ...copy } = record;
      await db.put('catches', { ...copy, length: null, weight: null, weightEst: null, photo: null, photos: [], notes: '' });
    }
    status(base ? 'Catch updated' : more ? `${more + 1} × ${record.species} saved 🎣` : 'Catch saved 🎣');
    if (editing === editingAtStart) resetForm(); // unless another catch was opened for editing meanwhile
    await refreshMap();
    renderCatchForm();
  } finally { submit.disabled = false; }
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
    const n = catchPhotos(c).length;
    card.innerHTML = `${c.photo ? `<span class="catch-ph"><img src="${URL.createObjectURL(c.photo)}" alt="">${n > 1 ? `<span class="ph-count">${n}</span>` : ''}</span>` : ''}<div style="flex:1">
      <b>${esc(c.species)}</b> ${fmtLen(c.length)} ${weightText(c)} ${c.released ? '<span class="muted small">released</span>' : ''}
      <div class="muted small">${esc(lakeName[c.lakeId] || '')} · ${fmtDate(c.time)} ${fmtTime(c.time)}${c.tripId ? ` · <a href="#" data-trip>trip</a>` : ''}</div>
      <div class="small">${[c.lure, c.technique, c.depth != null && fmtDepth(c.depth), c.waterTemp != null && `water ${fmtTemp(c.waterTemp)}`, Number.isFinite(c.trollMph) && c.trollMph >= 0.3 && fmtSpeed(c.trollMph)].filter(Boolean).map(esc).join(' · ')}</div>
      ${cond ? `<div class="muted small">${fmtTemp(cond.airTemp, true)} · ${compass(cond.windDir)} ${Math.round(cond.wind)} mph · ${cond.pressureInHg}" ${cond.pressureTrend ?? ''} · ${esc(cond.sky)} · ${esc(c.moon)}</div>` : ''}
      ${c.notes ? `<div class="small" style="white-space:pre-wrap">${esc(c.notes)}</div>` : ''}
      ${c.tags?.length ? `<div class="tag-list">${c.tags.map(t => `<span class="pill">${esc(t)}</span>`).join('')}</div>` : ''}
      <a href="#" class="small" data-edit>edit</a> · <a href="#" class="small" data-share>share</a> · <a href="#" class="small danger" data-del>delete</a></div>`;
    // Tapping the card (anywhere but its links) opens the catch page, with older and newer from this list.
    card.onclick = e => { if (!e.target.closest('a')) openCatch(c.id, catches.map(x => x.id)); };
    card.querySelector('[data-edit]').onclick = e => { e.preventDefault(); editCatch(c.id); };
    card.querySelector('[data-share]').onclick = e => { e.preventDefault(); openComposer({ catches: [c.id] }); };
    card.querySelector('[data-trip]')?.addEventListener('click', e => { e.preventDefault(); openTrip(c.tripId); });
    card.querySelector('[data-del]').onclick = async e => {
      e.preventDefault();
      const next = card.nextSibling, parent = card.parentNode;
      card.remove();
      await deleteCatch(c, () => parent?.isConnected && parent.insertBefore(card, next?.parentNode === parent ? next : null));
    };
    el.append(card);
  }
}

// Deletes a catch with an Undo bar instead of a confirm dialog. onUndo puts it back on screen.
export async function deleteCatch(c, onUndo = () => {}) {
  c = await db.get('catches', c.id) ?? c; // the stored copy, so Undo brings back the latest edits
  await db.del('catches', c.id);
  refreshMap();
  undoBar(`${c.species || 'Catch'} deleted`, async () => {
    await db.put('catches', c, { touch: false });
    refreshMap();
    onUndo();
  });
}

onShow('log', renderCatchForm);
