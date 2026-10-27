// Trip mode: a GPS track while you fish, one-tap Catch / Bite / Lost buttons, and the trip page afterwards
// (summary, track on a map, journal entry). Tracking only runs while the app is open on screen.
import { db } from '../db.js';
import { haversineKm, moonPhase } from '../data-sources.js';
import { $, esc, fmtDate, status, showView, onShow, localNow, COMMON_SPECIES } from '../ui.js';
import { refreshMap } from '../map.js';
import { openViewer } from './catch.js';
import { renderCatchCards, snapshotConditions, shrinkPhoto, editCatch, weightText } from './log.js';
import { fmtLen, fromLen, units } from '../units.js';
import { estimateWeight } from '../weight.js';

const KEY = 'tackle-box-active-trip';
const SCREEN_KEY = 'tackle-box-keep-screen-on';
let trip = null;          // the active trip record
let watchId = null, lastFix = null, dirty = 0, flushTimer = null, tick = null, wakeLock = null;
let miniMap = null;

export async function activeTrip() {
  const id = localStorage.getItem(KEY);
  // Another tab of the app ended this trip or started a new one: stop following the old one here.
  if (trip && trip.id !== id) { const old = trip; stopTracking(); trip = null; updatePill(); await flush(old); }
  if (trip) return trip;
  const t = id && await db.get('trips', id);
  return t && !t.end ? t : null;
}

const fmtDur = ms => { const m = Math.max(0, Math.round(ms / 60e3)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`; };
const clock = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
// Track points are [lat, lon, ms]. A damaged or hand-edited backup can hold anything: numbers written as text are
// read as numbers, and points without a position are skipped.
const num = v => typeof v === 'string' && v.trim() ? Number(v) : v;
const trackOf = t => (Array.isArray(t.track) ? t.track : []).filter(Array.isArray)
  .map(([lat, lon, ms]) => [num(lat), num(lon), ms]).filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
const pointTime = ms => { const d = new Date(typeof ms === 'string' && ms.trim() && isFinite(ms) ? +ms : ms ?? NaN); return isNaN(d) ? null : d; };
// Two tabs can follow the same trip, each with its own copy of the track. Saving adds this tab's points to the stored
// ones (up to the trip's end, if another tab ended it) instead of replacing them.
function withTrack(saved, mine) {
  const have = new Set(trackOf(saved).map(p => p[2])), end = saved.end ? Date.parse(saved.end) : Infinity;
  const add = mine.filter(p => !have.has(p[2]) && p[2] <= end);
  return add.length ? { ...saved, track: [...trackOf(saved), ...add].sort((a, b) => a[2] - b[2]) } : saved;
}
const trackKm = track => track.reduce((km, p, i) => i ? km + haversineKm(track[i - 1][0], track[i - 1][1], p[0], p[1]) : 0, 0);
const tripCatches = async t => (await db.all('catches')).filter(c => c.tripId === t.id).sort((a, b) => a.time.localeCompare(b.time));
const tripEvents = async t => (await db.all('events')).filter(e => e.tripId === t.id);

// ---------- Starting a trip ----------
export async function startTripFlow() {
  const lakes = (await db.all('lakes')).sort((a, b) => a.name.localeCompare(b.name));
  showView('trip', { render: false });
  const el = $('#trip');
  if (!lakes.length) { el.innerHTML = `<h2>Start a trip</h2><div class="card">Save the water you're fishing first: tap its name on the map, then <b>Save to my lakes</b>.</div>`; return; }
  el.innerHTML = `<h2>Start a trip</h2><form class="card form" id="trip-start">
      <label>Where <select name="lakeId">${lakes.map(l => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('')}</select></label>
      <label class="check"><input type="checkbox" name="screen" ${localStorage.getItem(SCREEN_KEY) !== '0' ? 'checked' : ''}> Keep the screen on during the trip</label>
      <button class="primary big">▶ Start trip</button>
      <p class="muted small">Your GPS track is recorded only while Tackle Box is open on screen. iPhones stop location updates as soon as the screen locks or you switch apps,
        so leave “Keep the screen on” ticked for a full track (it uses more battery). The track stays on this device.</p>
    </form>`;
  // Pick the saved water closest to where you are, unless you've already picked one.
  const form = $('#trip-start');
  let picked = false;
  form.lakeId.onchange = () => { picked = true; };
  navigator.geolocation?.getCurrentPosition(p => {
    const near = lakes.map(l => [l, haversineKm(p.coords.latitude, p.coords.longitude, l.lat, l.lon)]).sort((a, b) => a[1] - b[1])[0];
    if (near && near[1] < 25 && !picked && form.isConnected) form.lakeId.value = near[0].id;
  }, () => {}, { timeout: 8000 });
  let starting = false;
  form.onsubmit = async e => {
    e.preventDefault();
    if (starting) return; // a double tap starts one trip
    starting = true;
    if (await activeTrip()) return openTrip((await activeTrip()).id);
    localStorage.setItem(SCREEN_KEY, e.target.screen.checked ? '1' : '0');
    trip = await db.put('trips', { lakeId: e.target.lakeId.value, start: new Date().toISOString(), end: null, track: [], companions: '', rating: null, journal: '', photos: [] });
    localStorage.setItem(KEY, trip.id);
    startTracking();
    openTrip(trip.id);
  };
}

// Called once at startup: picks a trip back up after the app was closed or reloaded.
export async function resumeTrip() {
  if (!await activeTrip()) return;
  trip = await activeTrip();
  startTracking();
  updatePill();
}

function startTracking() {
  if (watchId == null && navigator.geolocation) {
    watchId = navigator.geolocation.watchPosition(onFix, err => { $('#trip-gps') && ($('#trip-gps').textContent = err.code === 1 ? 'Location permission denied: no track' : 'Waiting for GPS…'); },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
  }
  flushTimer ??= setInterval(flush, 30e3);
  tick ??= setInterval(updateClock, 1000);
  keepScreenOn();
}

function stopTracking() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  clearInterval(flushTimer); clearInterval(tick);
  watchId = flushTimer = tick = null;
  wakeLock?.release?.(); wakeLock = null;
}

async function keepScreenOn() {
  if (!trip || localStorage.getItem(SCREEN_KEY) === '0' || wakeLock || document.visibilityState !== 'visible') return;
  try { wakeLock = await navigator.wakeLock?.request('screen'); wakeLock?.addEventListener('release', () => { wakeLock = null; }); } catch { /* not supported or refused */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepScreenOn(); else flush(); });

// Keep a point when it's accurate and you've moved 10 m, or a minute has passed.
function onFix(p) {
  if (!trip) return;
  const { latitude: lat, longitude: lon, accuracy } = p.coords;
  lastFix = { lat, lon, accuracy, time: p.timestamp };
  const gps = $('#trip-gps');
  if (gps) gps.textContent = `GPS ±${Math.round(accuracy)} m · ${trip.track.length} track points`;
  if (accuracy > 50) return;
  const prev = trip.track.at(-1);
  if (prev && haversineKm(prev[0], prev[1], lat, lon) < 0.01 && p.timestamp - prev[2] < 60e3) return;
  trip.track.push([+lat.toFixed(6), +lon.toFixed(6), p.timestamp]);
  if (++dirty >= 10) flush();
}

async function flush(t = trip) {
  if (!t || !dirty) return;
  dirty = 0;
  const saved = await db.get('trips', t.id);
  const next = saved && withTrack(saved, t.track);
  if (next && next !== saved) await db.put('trips', next);
}

// Where you are now if the GPS fix is fresh, otherwise the water's own position.
async function here(t) {
  if (trip?.id === t.id && lastFix && Date.now() - lastFix.time < 120e3) return { lat: lastFix.lat, lon: lastFix.lon };
  const lake = await db.get('lakes', t.lakeId);
  return lake ? { lat: lake.lat, lon: lake.lon } : { lat: null, lon: null };
}

// ---------- The trip pill shown on every other view while a trip runs (styles.css hides it on the trip view) ----------
async function updatePill() {
  const pill = $('#trip-pill');
  pill.classList.toggle('hidden', !trip);
  if (!trip) return;
  pill.dataset.fish = (await tripCatches(trip)).length;
  updateClock();
}
function updateClock() {
  if (!trip) return;
  const t = clock(Date.now() - Date.parse(trip.start));
  const pill = $('#trip-pill');
  pill.textContent = `● Trip ${t} · ${pill.dataset.fish ?? 0} 🐟`;
  const c = $('#trip-clock');
  if (c) c.textContent = t;
}
$('#trip-pill').onclick = () => trip && openTrip(trip.id);

// ---------- Trip page ----------
export async function openTrip(id) {
  const active = await activeTrip(); // first: forgets a trip another tab ended, so it's read fresh below
  let t = trip?.id === id ? trip : await db.get('trips', id);
  if (!t) return;
  if (!t.end && active?.id === id && !trip) { trip = t; startTracking(); }
  // An unfinished trip that isn't running here (e.g. restored from a backup) is closed at its last activity.
  if (!t.end && active?.id !== id) t = await closeStale(t);
  showView('trip', { render: false });
  return t.end ? renderSummary(t) : renderLive(t);
}

export async function closeStale(t) {
  if (t.id === localStorage.getItem(KEY)) return t; // the running trip (maybe in another tab) is never closed here
  const times = [...(await tripCatches(t)).map(c => c.time), ...(await tripEvents(t)).map(e => e.time), ...trackOf(t).map(p => pointTime(p[2])).filter(Boolean).map(d => d.toISOString())];
  const end = times.reduce((a, b) => b > a ? b : a, t.start);
  return db.put('trips', { ...t, end });
}

async function recentSpecies(lake) {
  const catches = (await db.all('catches')).sort((a, b) => b.time.localeCompare(a.time));
  const here = catches.filter(c => c.lakeId === lake?.id).map(c => c.species);
  const fromLake = String(lake?.species ?? '').split(/[,;]/).map(s => s.trim());
  return [...new Set([...here, ...catches.map(c => c.species), ...fromLake, ...COMMON_SPECIES].filter(Boolean))].slice(0, 8);
}

async function renderLive(t) {
  const [lake, catches, events] = await Promise.all([db.get('lakes', t.lakeId), tripCatches(t), tripEvents(t)]);
  const el = $('#trip');
  const bites = events.filter(e => e.kind === 'bite').length, lost = events.filter(e => e.kind === 'lost').length;
  const log = [...catches.map(c => ({ time: c.time, html: `🐟 <b>${esc(c.species)}</b> ${fmtLen(c.length)} ${weightText(c)}`, catchId: c.id })),
    ...events.map(e => ({ time: e.time, html: e.kind === 'bite' ? '💥 Bite' : '💨 Lost fish', eventId: e.id }))].sort((a, b) => b.time.localeCompare(a.time));
  el.innerHTML = `<div class="trip-head"><div><b>${esc(lake?.name ?? 'Trip')}</b><div class="muted small" id="trip-gps">${lastFix ? `GPS ±${Math.round(lastFix.accuracy)} m · ${t.track.length} track points` : 'Waiting for GPS…'}</div></div>
      <div class="trip-clock" id="trip-clock">${clock(Date.now() - Date.parse(t.start))}</div></div>
    <div class="grid trip-stats"><div class="stat"><b>${catches.length}</b><span>Fish</span></div><div class="stat"><b>${bites}</b><span>Bites</span></div><div class="stat"><b>${lost}</b><span>Lost</span></div></div>
    <div class="quick">
      <button class="q-catch" id="q-catch">🐟<span>Catch</span></button>
      <button class="q-bite" id="q-bite">💥<span>Bite</span></button>
      <button class="q-lost" id="q-lost">💨<span>Lost</span></button>
    </div>
    <div id="quick-sheet"></div>
    <div class="card small">${log.length ? log.map(x => `<div class="row trip-log"><span class="muted">${new Date(x.time).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span><span style="flex:1">${x.html}</span>
      ${x.catchId ? `<a href="#" data-edit="${esc(x.catchId)}">details</a>` : `<a href="#" class="danger" data-undo="${esc(x.eventId)}">undo</a>`}</div>`).join('') : '<span class="muted">Tap Catch, Bite or Lost as it happens. Each one is stamped with the time and your GPS spot.</span>'}</div>
    <button id="trip-end" class="danger" style="width:100%">■ End trip</button>
    <p class="muted small">Tracking runs only while this screen is open${wakeLock ? ' (screen is being kept on)' : ''}. On iPhone it stops when the screen locks.</p>`;
  $('#q-catch').onclick = () => speciesPicker(t, lake);
  $('#q-bite').onclick = () => addEvent(t, 'bite');
  $('#q-lost').onclick = () => addEvent(t, 'lost');
  el.querySelectorAll('[data-edit]').forEach(a => a.onclick = e => { e.preventDefault(); editCatch(a.dataset.edit); });
  el.querySelectorAll('[data-undo]').forEach(a => a.onclick = async e => { e.preventDefault(); await db.del('events', a.dataset.undo); renderLive(t); });
  $('#trip-end').onclick = () => endTrip(t);
  updatePill();
}

async function addEvent(t, kind) {
  navigator.vibrate?.(30);
  await db.put('events', { tripId: t.id, lakeId: t.lakeId, kind, time: new Date().toISOString(), ...await here(t) });
  status(kind === 'bite' ? 'Bite logged' : 'Lost fish logged');
  renderLive(t);
}

async function speciesPicker(t, lake) {
  const species = await recentSpecies(lake);
  const sheet = $('#quick-sheet');
  sheet.innerHTML = `<div class="card"><h3>What did you catch?</h3><div class="species-grid">${species.map(s => `<button data-sp="${esc(s)}">${esc(s)}</button>`).join('')}</div>
    <form class="row" id="sp-other" style="margin-top:8px"><input name="sp" list="species-list" placeholder="Other species" style="flex:1;padding:12px;font:inherit"><button>Log</button></form>
    <button id="sp-cancel" style="width:100%;margin-top:8px">Cancel</button></div>`;
  sheet.querySelectorAll('[data-sp]').forEach(b => b.onclick = () => quickCatch(t, b.dataset.sp));
  $('#sp-other').onsubmit = e => { e.preventDefault(); const v = e.target.sp.value.trim(); if (v) quickCatch(t, v); };
  $('#sp-cancel').onclick = () => { sheet.innerHTML = ''; };
  sheet.scrollIntoView({ block: 'nearest' });
}

// One tap saves the catch right away; the size sheet that follows is optional.
async function quickCatch(t, species) {
  navigator.vibrate?.(30);
  const time = new Date().toISOString();
  const pos = await here(t);
  const c = await db.put('catches', { lakeId: t.lakeId, tripId: t.id, species, time, length: null, weight: null, depth: null, waterTemp: null,
    lure: '', technique: '', notes: '', released: true, ...pos, photo: null, moon: moonPhase(new Date(time)).name });
  status(`${species} logged 🎣`);
  refreshMap();
  renderLive(t).then(() => sizeSheet(t, c));
  // Weather snapshot in the background, so a slow signal never holds up the button. It's fetched for the water, never your spot.
  const lake = await db.get('lakes', t.lakeId);
  if (lake) snapshotConditions(lake.lat, lake.lon).then(async cond => { if (cond) { const saved = await db.get('catches', c.id); if (saved) await db.put('catches', { ...saved, conditions: cond }); } });
}

function sizeSheet(t, c) {
  const sheet = $('#quick-sheet');
  sheet.innerHTML = `<form class="card form" id="size-form"><h3>${esc(c.species)}: anything to add?</h3>
    <label>Length (${units().length}) <input name="length" type="number" step="any" min="0" inputmode="decimal" class="big-input"></label>
    <div class="row"><label class="check"><input type="checkbox" name="released" checked> Released</label><label>Photo <input name="photo" type="file" accept="image/*" capture="environment"></label></div>
    <div class="row"><button class="primary">Save</button><button type="button" id="size-skip">Skip</button></div>
    <a href="#" id="size-full" class="small">Full form (lure, depth, notes…)</a></form>`;
  const form = $('#size-form');
  form.onsubmit = async e => {
    e.preventDefault();
    const length = form.length.value === '' ? null : fromLen(+form.length.value);
    const photo = form.photo.files[0] ? await shrinkPhoto(form.photo.files[0]).catch(() => (status("Couldn't read that photo"), null)) : null;
    const saved = await db.get('catches', c.id);
    if (saved) await db.put('catches', { ...saved, length, released: form.released.checked, weightEst: estimateWeight(saved.species, length), photo: photo ?? saved.photo });
    renderLive(t);
  };
  $('#size-skip').onclick = () => { sheet.innerHTML = ''; };
  $('#size-full').onclick = e => { e.preventDefault(); editCatch(c.id); };
}

async function endTrip(t) {
  if (!confirm('End this trip?')) return;
  await activeTrip(); // a page left open in another tab: forget a trip that tab already ended
  const running = trip?.id === t.id;
  if (running) await flush();
  const saved = await db.get('trips', t.id);
  if (running) { trip = null; if (localStorage.getItem(KEY) === t.id) localStorage.removeItem(KEY); stopTracking(); updatePill(); }
  if (!saved) return showView('journal'); // removed meanwhile, e.g. by restoring a backup
  if (saved.end && !running) return renderSummary(saved); // already ended in another tab: keep its end time
  const ended = await db.put('trips', { ...(running ? withTrack(saved, t.track) : saved), end: new Date().toISOString() });
  await linkCatches(ended);
  renderSummary(ended);
}

// Catches logged with the full form on the same water during the trip belong to it too.
export async function linkCatches(t) {
  for (const c of await db.byLake('catches', t.lakeId)) {
    if (!c.tripId && c.time >= t.start.slice(0, 16) && c.time <= t.end) await db.put('catches', { ...c, tripId: t.id });
  }
}

// ---------- After the trip: summary, map, journal ----------
async function renderSummary(t) {
  const [lake, catches, events] = await Promise.all([db.get('lakes', t.lakeId), tripCatches(t), tripEvents(t)]);
  const hours = (Date.parse(t.end) - Date.parse(t.start)) / 3600e3;
  const track = trackOf(t), km = trackKm(track);
  const bySpecies = Object.entries(catches.reduce((m, c) => (m[c.species] = (m[c.species] || 0) + 1, m), {})).sort((a, b) => b[1] - a[1]);
  const biggest = catches.filter(c => c.length).sort((a, b) => b.length - a.length)[0];
  const el = $('#trip');
  el.innerHTML = `<button id="trip-back">‹ Journal</button>
    <h2>${esc(lake?.name ?? 'Trip')}</h2>
    <div class="muted small">${fmtDate(t.start)} · ${new Date(t.start).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}–${new Date(t.end).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</div>
    <div class="card grid">
      <div class="stat"><b>${fmtDur(Date.parse(t.end) - Date.parse(t.start))}</b><span>On the water</span></div>
      <div class="stat"><b>${catches.length}</b><span>Fish</span></div>
      <div class="stat"><b>${hours >= 0.25 ? (catches.length / hours).toFixed(1) : '–'}</b><span>Fish / hour</span></div>
      <div class="stat"><b>${events.filter(e => e.kind === 'bite').length} / ${events.filter(e => e.kind === 'lost').length}</b><span>Bites / lost</span></div>
      ${track.length ? `<div class="stat"><b>${units().depth === 'm' ? `${km.toFixed(1)} km` : `${(km * 0.621371).toFixed(1)} mi`}</b><span>Distance</span></div>` : ''}
      ${biggest ? `<div class="stat"><b>${fmtLen(biggest.length)}</b><span>Biggest · ${esc(biggest.species)}</span></div>` : ''}
    </div>
    ${bySpecies.length ? `<div class="small" style="margin-bottom:12px">${bySpecies.map(([s, n]) => `${esc(s)} ×${n}`).join(' · ')}</div>` : ''}
    ${track.length || catches.length || events.length ? '<div id="trip-map" class="trip-map"></div>' : ''}
    <h2>Journal</h2>
    <form class="card form" id="journal-form">
      <div class="label">Rating <span class="stars">${[1, 2, 3, 4, 5].map(n => `<button type="button" data-star="${n}" class="${n <= (t.rating ?? 0) ? 'on' : ''}">★</button>`).join('')}</span></div>
      <label>Who you fished with <input name="companions" value="${esc(t.companions)}" placeholder="Names"></label>
      <label>How it went <textarea name="journal" rows="5" placeholder="Water clarity, what worked, what didn't…">${esc(t.journal)}</textarea></label>
      <div class="photos">${(t.photos ?? []).map((p, i) => `<span class="ph"><img src="${URL.createObjectURL(p)}" alt=""><a href="#" data-rm="${i}">✕</a></span>`).join('')}</div>
      <label>Add photos <input name="photos" type="file" accept="image/*" multiple></label>
      <button class="primary">Save journal</button>
    </form>
    <h2>Catches</h2><div id="trip-catches"></div>
    <button id="trip-del" class="danger" style="width:100%;margin-top:12px">Delete trip (keeps its catches)</button>`;
  $('#trip-back').onclick = () => showView('journal');
  el.querySelectorAll('#journal-form .ph img').forEach((img, i) => img.onclick = () => openViewer(t.photos, i));
  let rating = t.rating ?? null;
  el.querySelectorAll('[data-star]').forEach(b => b.onclick = () => { rating = +b.dataset.star === rating ? null : +b.dataset.star; el.querySelectorAll('[data-star]').forEach(s => s.classList.toggle('on', +s.dataset.star <= (rating ?? 0))); });
  el.querySelectorAll('[data-rm]').forEach(a => a.onclick = async e => {
    e.preventDefault();
    const saved = await db.get('trips', t.id);
    const f = $('#journal-form');
    saved.photos.splice(+a.dataset.rm, 1);
    // The page redraws, so keep what's in the form too: text, rating and photos picked but not yet saved.
    const picked = (await Promise.allSettled([...f.photos.files].map(p => shrinkPhoto(p)))).filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
    renderSummary(await db.put('trips', { ...saved, rating, companions: f.companions.value.trim(), journal: f.journal.value.trim(), photos: [...saved.photos, ...picked] }));
  });
  $('#journal-form').onsubmit = async e => {
    e.preventDefault();
    const f = e.target;
    const saved = await db.get('trips', t.id);
    const shrunk = await Promise.allSettled([...f.photos.files].map(p => shrinkPhoto(p)));
    const added = shrunk.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
    renderSummary(await db.put('trips', { ...saved, rating, companions: f.companions.value.trim(), journal: f.journal.value.trim(), photos: [...(saved.photos ?? []), ...added] }));
    status(added.length < shrunk.length ? `Journal saved; couldn't read ${shrunk.length - added.length} photo(s)` : 'Journal saved');
  };
  $('#trip-del').onclick = async () => {
    if (!confirm('Delete this trip and its track? Catches stay in your log.')) return;
    for (const c of await tripCatches(t)) await db.put('catches', { ...c, tripId: null });
    for (const ev of await tripEvents(t)) await db.del('events', ev.id);
    await db.del('trips', t.id);
    showView('journal');
  };
  renderCatchCards([...catches].reverse(), $('#trip-catches'));
  drawTripMap(t, lake, catches, events);
}

function drawTripMap(t, lake, catches, events) {
  miniMap?.remove(); miniMap = null;
  const div = $('#trip-map');
  if (!div) return;
  miniMap = L.map(div, { zoomControl: false, attributionControl: false });
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19 }).addTo(miniMap);
  const pts = [];
  const track = trackOf(t);
  if (track.length) {
    const line = track.map(p => [p[0], p[1]]);
    L.polyline(line, { color: '#3fb0d4', weight: 3 }).addTo(miniMap);
    L.circleMarker(line[0], { radius: 5, color: '#fff', weight: 2, fillColor: '#2fbf71', fillOpacity: 1 }).bindTooltip('Start').addTo(miniMap);
    pts.push(...line);
  }
  for (const c of catches) if (c.lat != null) { L.circleMarker([c.lat, c.lon], { radius: 7, color: '#fff', weight: 2, fillColor: '#f28c28', fillOpacity: 1 }).bindTooltip(`${esc(c.species)} ${fmtLen(c.length)}`).addTo(miniMap); pts.push([c.lat, c.lon]); }
  for (const e of events) if (e.lat != null) { L.circleMarker([e.lat, e.lon], { radius: 5, color: '#fff', weight: 1, fillColor: e.kind === 'bite' ? '#f2d028' : '#b3261e', fillOpacity: 1 }).bindTooltip(e.kind === 'bite' ? 'Bite' : 'Lost').addTo(miniMap); pts.push([e.lat, e.lon]); }
  if (!pts.length && lake) pts.push([lake.lat, lake.lon]);
  miniMap.fitBounds(L.latLngBounds(pts).pad(0.2), { maxZoom: 16 });
}

// ---------- A journal entry for a day without trip mode ----------
export async function newEntry() {
  const lakes = (await db.all('lakes')).sort((a, b) => a.name.localeCompare(b.name));
  showView('trip', { render: false });
  const now = localNow();
  $('#trip').innerHTML = `<button id="trip-back">‹ Journal</button><h2>New journal entry</h2>
    ${lakes.length ? `<form class="card form" id="entry-form">
      <label>Where <select name="lakeId">${lakes.map(l => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('')}</select></label>
      <div class="row"><label>Started <input name="start" type="datetime-local" required value="${now.slice(0, 11)}06:00"></label>
        <label>Ended <input name="end" type="datetime-local" required value="${now}"></label></div>
      <p class="muted small">Catches you logged on that water between these times are added to the entry.</p>
      <button class="primary">Continue</button></form>` : '<div class="card">Save a water first.</div>'}`;
  $('#trip-back').onclick = () => showView('journal');
  const form = $('#entry-form');
  if (form) form.onsubmit = async e => {
    e.preventDefault();
    const start = new Date(form.start.value).toISOString(), end = new Date(form.end.value).toISOString();
    if (end <= start) return alert('The end has to be after the start');
    const t = await db.put('trips', { lakeId: form.lakeId.value, start, end, track: [], companions: '', rating: null, journal: '', photos: [], manual: true });
    await linkCatches(t);
    renderSummary(t);
  };
}

onShow('journal', () => { miniMap?.remove(); miniMap = null; });
