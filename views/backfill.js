// Backfill old catches from photos: read each photo's date and GPS on the device, match it to a water,
// and offer draft catches to confirm. Photos never leave the device.
import { db } from '../db.js';
import * as CA from '../states/ca.js';
import { haversineKm, moonPhase } from '../data-sources.js';
import { $, esc, status } from '../ui.js';
import { refreshMap, statewide as loadedStatewide } from '../map.js';
import { readExif } from '../exif.js';
import { shrinkPhoto } from './log.js';
import { waterRecord } from './lake.js';
import { fromLen, units } from '../units.js';
import { estimateWeight } from '../weight.js';

let drafts = [];

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
  const [lakes, trips, sw, catches] = await Promise.all([db.all('lakes'), db.all('trips'), loadedStatewide ?? CA.statewide(), db.all('catches')]);
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
      const p = trip.track.reduce((best, q) => !best || Math.abs(q[2] - t) < Math.abs(best[2] - t) ? q : best, null);
      if (p) [lat, lon] = p;
    }
    const water = trip ? { lake: lakes.find(l => l.id === trip.lakeId) } : lat != null ? matchWater(lat, lon, lakes, sw) : {};
    const dup = catches.find(c => Math.abs(Date.parse(c.time) - Date.parse(time)) < 10 * 60e3);
    drafts.push({ file, url: URL.createObjectURL(file), time, lat, lon, ...water, tripId: trip?.id ?? null, dup, include: !dup, species: '', length: '', released: true, hadGps: ex.lat != null });
  }
  drafts.sort((a, b) => a.time.localeCompare(b.time));
  drawDrafts();
}

// Nearest saved water, or else the statewide lake or river that contains the point (roughly: within its size).
export function matchWater(lat, lon, lakes, sw) {
  const near = (list, limit) => list.map(w => ({ w, d: haversineKm(lat, lon, w.lat, w.lon) })).filter(x => x.d <= limit(x.w)).sort((a, b) => a.d - b.d)[0]?.w;
  const lakeLimit = w => Math.max(1.5, Math.sqrt((w.acres ?? 0) / 247) * 1.5);
  const lake = near(lakes, lakeLimit);
  if (lake) return { lake };
  const water = near(sw?.lakes ?? [], lakeLimit) ?? near(sw?.riverLabels ?? [], () => 3);
  if (!water) return {};
  return { lake: lakes.find(l => l.nhdId === String(water.id)) ?? null, water };
}

function drawDrafts() {
  const box = $('#bf-drafts');
  if (!box) return;
  db.all('lakes').then(lakes => {
    lakes.sort((a, b) => a.name.localeCompare(b.name));
    const u = units();
    box.innerHTML = drafts.map((d, i) => `<div class="card catch draft" data-i="${i}"><img src="${d.url}" alt="">
      <div class="form" style="flex:1">
        <label class="check"><input type="checkbox" name="include" ${d.include ? 'checked' : ''}> <b>${new Date(d.time).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</b></label>
        ${d.dup ? `<div class="small danger">You already logged a ${esc(d.dup.species)} within 10 minutes of this.</div>` : ''}
        <label>Water <select name="water"><option value="">Pick a water…</option>
          ${d.water && !d.lake ? `<option value="new" selected>${esc(d.water.name)} (adds it to your lakes)</option>` : ''}
          ${lakes.map(l => `<option value="${l.id}" ${d.lake?.id === l.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>
        <div class="muted small">${d.hadGps ? '📍 Location from the photo' : d.lat != null ? '📍 Location from your trip track' : 'No location in this photo'}</div>
        <div class="row"><label>Species <input name="species" list="species-list" value="${esc(d.species)}"></label>
          <label>Length (${u.length}) <input name="length" type="number" step="0.25" inputmode="decimal" value="${esc(d.length)}"></label></div>
        <label class="check"><input type="checkbox" name="released" ${d.released ? 'checked' : ''}> Released</label>
      </div></div>`).join('')
      + (drafts.length ? `<button class="primary" id="bf-save">Save checked catches</button><button id="bf-clear" style="width:100%;margin-top:8px">Discard drafts</button>` : '');
    box.querySelectorAll('.draft').forEach(card => card.oninput = card.onchange = () => {
      const d = drafts[+card.dataset.i], f = n => card.querySelector(`[name=${n}]`);
      Object.assign(d, { include: f('include').checked, species: f('species').value, length: f('length').value, released: f('released').checked, waterChoice: f('water').value });
    });
    box.querySelectorAll('.draft').forEach(card => drafts[+card.dataset.i].waterChoice = card.querySelector('[name=water]').value);
    $('#bf-save')?.addEventListener('click', saveDrafts);
    $('#bf-clear')?.addEventListener('click', () => { drafts = []; box.innerHTML = ''; });
  });
}

async function saveDrafts() {
  const chosen = drafts.filter(d => d.include);
  const missing = chosen.filter(d => !d.waterChoice || !d.species.trim());
  if (missing.length) return alert(`Pick a water and a species for each checked photo (${missing.length} missing).`);
  const btn = $('#bf-save');
  btn.disabled = true; btn.textContent = 'Saving…';
  const added = new Map(); // statewide water id → new lake id
  for (const d of chosen) {
    let lakeId = d.waterChoice;
    if (lakeId === 'new') {
      if (!added.has(d.water.id)) {
        const { unsaved, ...rec } = await waterRecord(d.water);
        added.set(d.water.id, (await db.put('lakes', rec)).id);
      }
      lakeId = added.get(d.water.id);
    }
    const lake = await db.get('lakes', lakeId);
    const length = d.length === '' ? null : fromLen(+d.length);
    await db.put('catches', { lakeId, species: d.species.trim(), time: d.time, length, weight: null, weightEst: estimateWeight(d.species, length), depth: null, waterTemp: null,
      lure: '', technique: '', notes: '', released: d.released, lat: d.lat ?? lake.lat, lon: d.lon ?? lake.lon,
      photo: await shrinkPhoto(d.file), moon: moonPhase(new Date(d.time)).name, tripId: d.tripId && lake.id === (await db.get('trips', d.tripId))?.lakeId ? d.tripId : null, source: 'photo' });
  }
  drafts = drafts.filter(d => !d.include);
  status(`Added ${chosen.length} catch${chosen.length === 1 ? '' : 'es'} from photos`);
  await refreshMap();
  drawDrafts();
}
