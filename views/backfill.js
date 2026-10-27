// Backfill old catches from photos: read each photo's date and GPS on the device, match it to a water,
// and offer draft catches to confirm. Photos never leave the device.
import { db } from '../db.js';
import { forLake, stateAt } from '../states/index.js';
import { haversineKm, moonPhase } from '../data-sources.js';
import { $, esc, status } from '../ui.js';
import { refreshMap } from '../map.js';
import { readExif } from '../exif.js';
import { shrinkPhoto } from './log.js';
import { waterRecord } from './lake.js';
import { reunit, units } from '../units.js';
import { estimateWeight } from '../weight.js';
import { fillMissingWeather } from '../past-weather.js';

let drafts = [];
let saving = false;

export function renderBackfill(el) {
  el.innerHTML = `<div class="card"><h3>Add catches from old photos</h3>
      <p class="small">Pick fish photos from your camera roll. Tackle Box reads when and where each was taken (on this phone, nothing is uploaded),
        finds the water, and makes a draft catch for you to check.</p>
      <label class="file-btn">📷 Choose photos <input type="file" id="bf-files" accept="image/*" multiple hidden></label>
      <p class="muted small">iPhones can strip the location from photos picked in the browser. Photos taken during a trip use that trip's water and track;
        for the rest, pick the water on the draft.</p></div>
    <div id="bf-drafts"></div>`;
  $('#bf-files').onchange = e => readPhotos([...e.target.files]);
  if (drafts.length) drawDrafts();
}

async function readPhotos(files) {
  if (!files.length) return;
  $('#bf-drafts').innerHTML = `<div class="card muted">Reading ${files.length} photo${files.length > 1 ? 's' : ''}…</div>`;
  const [lakes, trips, catches] = await Promise.all([db.all('lakes'), db.all('trips'), db.all('catches')]);
  // Each photo is matched against the statewide list of the state it was taken in (loaded once per state).
  const lists = {};
  const swAt = (lat, lon) => { const S = stateAt(lat, lon); return S ? (lists[S.code] ??= S.statewide()) : null; };
  drafts = [];
  for (const file of files) {
    let ex = {};
    try { ex = await readExif(file); } catch { /* unreadable: fall back to the file date */ }
    const time = ex.time ?? new Date(file.lastModified).toISOString();
    let { lat, lon } = ex;
    // No GPS: if a trip was running at that time, use the trip's track (or its water).
    const trip = trips.find(t => t.end && time >= t.start && time <= t.end);
    if (lat == null && trip) {
      const t = Date.parse(time);
      const p = (Array.isArray(trip.track) ? trip.track : []).filter(q => Array.isArray(q) && Number.isFinite(q[2])).reduce((best, q) => !best || Math.abs(q[2] - t) < Math.abs(best[2] - t) ? q : best, null);
      if (p) [lat, lon] = p;
    }
    const water = trip ? { lake: lakes.find(l => l.id === trip.lakeId) } : lat != null ? matchWater(lat, lon, lakes, await swAt(lat, lon)) : {};
    if (water.water && !water.lake) water.lake = await savedLakeFor(water.water, lakes);
    const dup = catches.find(c => Math.abs(Date.parse(c.time) - Date.parse(time)) < 10 * 60e3);
    drafts.push({ file, url: URL.createObjectURL(file), time, lat, lon, ...water, waterChoice: water.lake?.id ?? (water.water ? 'new' : ''),
      tripId: trip?.id ?? null, dup, include: !dup, species: '', length: '', released: true, hadGps: ex.lat != null });
  }
  drafts.sort((a, b) => a.time.localeCompare(b.time));
  drawDrafts();
}

// The water that contains the point (roughly: within its size): one of yours, or a statewide lake or river.
// A closer statewide water wins over a big saved statewide lake nearby, so a photo at a small lake next to a big one lands right.
// Lakes you placed yourself (no NHD id) always win: they may be the same water as the statewide one.
export function matchWater(lat, lon, lakes, sw) {
  const near = (list, limit) => list.map(w => ({ w, d: haversineKm(lat, lon, w.lat, w.lon) })).filter(x => x.d <= limit(x.w)).sort((a, b) => a.d - b.d)[0];
  const lakeLimit = w => Math.max(1.5, Math.sqrt((w.acres ?? 0) / 247) * 1.5);
  const mine = near(lakes, lakeLimit), state = near(sw?.lakes ?? [], lakeLimit);
  if (mine && (!state || !mine.w.nhdId || mine.w.nhdId === String(state.w.id) || mine.d <= state.d)) return { lake: mine.w };
  const water = state?.w ?? near(sw?.riverLabels ?? [], () => 3)?.w;
  if (!water) return mine ? { lake: mine.w } : {};
  return { lake: lakes.find(l => l.nhdId === String(water.id)) ?? null, water };
}

// Your saved lake for a statewide water: the same NHD id, or a lake added from the stocked-waters finder (no NHD id)
// for the same stocked water (CDFW, NDOW). The stocked match alone can point a big lake at a small stocked water nearby, so the finder lake
// also has to share the name or sit on the water.
const norm = s => (s ?? '').toLowerCase().replace(/\b(lake|reservoir|river|creek|pond|the|of)\b|[^a-z0-9]/g, '');
const sameName = (a, b) => { const x = norm(a), y = norm(b); return !!x && !!y && (x.startsWith(y) || y.startsWith(x)); };
async function savedLakeFor(water, lakes) {
  const byNhd = lakes.find(l => l.nhdId === String(water.id));
  if (byNhd) return byNhd;
  const S = forLake(water);
  const stocked = await S?.matchStockedWater(water);
  // Same name, or the finder lake's pin lies inside the water (its equivalent-circle radius).
  const inside = l => haversineKm(l.lat, l.lon, water.lat, water.lon) <= Math.sqrt((water.acres ?? 0) / 776);
  return stocked ? lakes.find(l => !l.nhdId && l[S.stockField] != null && String(l[S.stockField]) === String(stocked.id) && (sameName(l.name, water.name) || inside(l))) ?? null : null;
}

function drawDrafts() {
  const box = $('#bf-drafts');
  if (!box) return;
  db.all('lakes').then(lakes => {
    lakes.sort((a, b) => a.name.localeCompare(b.name));
    for (const d of drafts) {
      // A water saved by an earlier partial save is now one of yours; a water deleted since needs picking again.
      const l = d.water && d.waterChoice === 'new' && lakes.find(l => l.nhdId === String(d.water.id));
      if (l) { d.lake = l; d.waterChoice = l.id; }
      if (d.waterChoice && d.waterChoice !== 'new' && !lakes.some(l => l.id === d.waterChoice)) { d.lake = null; d.waterChoice = d.water ? 'new' : ''; }
    }
    const u = units();
    // Lengths typed before a units change are converted, not read in the new unit.
    for (const d of drafts) {
      if (d.length !== '' && d.lengthUnit && d.lengthUnit !== u.length) d.length = String(reunit(+d.length, 'length', d.lengthUnit, u.length));
      d.lengthUnit = u.length;
    }
    box.innerHTML = drafts.map((d, i) => d.saved ? '' : `<div class="card catch draft" data-i="${i}"><img src="${d.url}" alt="">
      <div class="form" style="flex:1">
        <label class="check"><input type="checkbox" name="include" ${d.include ? 'checked' : ''}> <b>${new Date(d.time).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</b></label>
        ${d.dup ? `<div class="small danger">You already logged a ${esc(d.dup.species)} within 10 minutes of this.</div>` : ''}
        <label>Water <select name="water"><option value="">Pick a water…</option>
          ${d.water && !d.lake ? `<option value="new" ${d.waterChoice === 'new' ? 'selected' : ''}>${esc(d.water.name)} (adds it to your lakes)</option>` : ''}
          ${lakes.map(l => `<option value="${esc(l.id)}" ${d.waterChoice === l.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>
        <div class="muted small">${d.hadGps ? '📍 Location from the photo' : d.lat != null ? '📍 Location from your trip track' : 'No location in this photo'}</div>
        <div class="row"><label>Species <input name="species" list="species-list" value="${esc(d.species)}"></label>
          <label>Length (${u.length}) <input name="length" type="number" step="any" min="0" inputmode="decimal" value="${esc(d.length)}"></label></div>
        <label class="check"><input type="checkbox" name="released" ${d.released ? 'checked' : ''}> Released</label>
      </div></div>`).join('')
      + (drafts.length ? `<button class="primary" id="bf-save" ${saving ? 'disabled' : ''}>${saving ? 'Saving…' : 'Save checked catches'}</button><button id="bf-clear" style="width:100%;margin-top:8px">Discard drafts</button>` : '');
    box.querySelectorAll('.draft').forEach(card => card.oninput = card.onchange = () => {
      const d = drafts[+card.dataset.i], f = n => card.querySelector(`[name=${n}]`);
      Object.assign(d, { include: f('include').checked, species: f('species').value, length: f('length').value, lengthUnit: units().length, released: f('released').checked, waterChoice: f('water').value });
    });
    $('#bf-save')?.addEventListener('click', saveDrafts);
    $('#bf-clear')?.addEventListener('click', () => { drafts = []; box.innerHTML = ''; });
  });
}

async function saveDrafts() {
  if (saving) return;
  const chosen = drafts.filter(d => d.include && !d.saved);
  const missing = chosen.filter(d => !d.waterChoice || !d.species.trim());
  if (missing.length) return alert(`Pick a water and a species for each checked photo (${missing.length} missing).`);
  const btn = $('#bf-save');
  btn.disabled = true; btn.textContent = 'Saving…';
  saving = true;
  let saved = 0, unreadable = 0;
  const added = [];
  try {
    for (const d of chosen) {
      try {
        // Shrink first: a photo this browser can't decode (e.g. HEIC on Android) still saves the catch, without the photo.
        const photo = await shrinkPhoto(d.file).catch(() => (unreadable++, null));
        const lakeId = d.waterChoice === 'new' ? await addWater(d.water) : d.waterChoice;
        const lake = await db.get('lakes', lakeId);
        if (!lake) throw new Error('That water was deleted');
        const length = d.length === '' ? null : reunit(+d.length, 'length', d.lengthUnit ?? units().length, 'in');
        const trip = d.tripId && await db.get('trips', d.tripId);
        added.push(await db.put('catches', { lakeId, species: d.species.trim(), time: d.time, length, weight: null, weightEst: estimateWeight(d.species, length), depth: null, waterTemp: null,
          lure: '', technique: '', notes: '', released: d.released, lat: d.lat ?? lake.lat, lon: d.lon ?? lake.lon,
          photo, moon: moonPhase(new Date(d.time)).name, tripId: trip?.lakeId === lakeId ? trip.id : null, source: 'photo' }));
        d.saved = true; saved++;
      } catch (err) { console.error(err); }
    }
  } finally {
    saving = false;
    drafts = drafts.filter(d => !d.saved);
    status(`Added ${saved} catch${saved === 1 ? '' : 'es'} from photos${unreadable ? ` (${unreadable} photo${unreadable === 1 ? '' : 's'} couldn't be read)` : ''}${chosen.length > saved ? `; ${chosen.length - saved} failed` : ''}`);
    await refreshMap();
    drawDrafts();
    // The weather on each photo's day and hour, in the background (only each water's location and the date are sent).
    if (added.length) fillMissingWeather(undefined, added.map(c => c.id));
  }
}

// Saves a statewide water to your lakes, or returns the one you already have.
async function addWater(water) {
  const lakes = await db.all('lakes');
  const have = await savedLakeFor(water, lakes);
  if (have) return have.id;
  const { unsaved, ...rec } = await waterRecord(water);
  return (await db.put('lakes', rec)).id;
}
