// The catch page: its photos large, where and when, what it took, the weather and moon, a pin on the map,
// and Edit / Share / Delete. Older and newer step through the list it was opened from. Also the full-screen photo viewer.
import { db } from '../db.js';
import { compass } from '../data-sources.js';
import { $, esc, fmtDate, showView, status } from '../ui.js';
import { fmtLen, fmtDepth, fmtTemp } from '../units.js';
import { editCatch, weightText, catchPhotos, deleteCatch } from './log.js';
import { openTrip } from './trips.js';
import { openLake } from './lake.js';
import { tackleLabel } from './tackle.js';
import { openComposer } from '../crew.js';
import { pastConditions } from '../past-weather.js';

let list = [], from = 'journal', pin = null;

export async function openCatch(id, ids = [id]) {
  const shown = document.querySelector('.view.active')?.id.replace('view-', '');
  if (shown && shown !== 'catch') from = shown;
  list = ids.includes(id) ? ids : [id];
  showView('catch', { render: false });
  return draw(id);
}

function goBack(c) {
  pin?.remove(); pin = null;
  // The lake page and the trip page are drawn for one water or trip, so draw them again rather than just switching back.
  if (from === 'lakes' && c) return openLake(c.lakeId, 'catches');
  if (from === 'trip' && c?.tripId) return openTrip(c.tripId);
  showView(from === 'trip' ? 'journal' : from);
}

const row = (k, v) => v == null || v === '' ? '' : `<div class="c-fact"><span class="muted small">${k}</span><b>${v}</b></div>`;

async function draw(id) {
  const el = $('#catch');
  const c = await db.get('catches', id);
  if (!c) { status('That catch was deleted'); return goBack(null); }
  const [lake, tackle, trip] = await Promise.all([db.get('lakes', c.lakeId), c.tackleId && db.get('tackle', c.tackleId), c.tripId && db.get('trips', c.tripId)]);
  const pics = catchPhotos(c);
  const at = list.indexOf(id), older = list[at + 1], newer = list[at - 1];
  const k = c.conditions;
  const when = new Date(c.time);
  el.innerHTML = `<div class="row c-nav"><button id="c-back">‹ Back</button><span style="flex:1"></span>
      ${list.length > 1 ? `<button id="c-newer" ${newer ? '' : 'disabled'} aria-label="Newer catch">‹ Newer</button><button id="c-older" ${older ? '' : 'disabled'} aria-label="Older catch">Older ›</button>` : ''}</div>
    ${pics.length ? `<div class="c-photos">${pics.map((p, i) => `<img src="${URL.createObjectURL(p)}" alt="" data-i="${i}">`).join('')}</div>
      ${pics.length > 1 ? `<div class="muted small c-swipe">${pics.length} photos · swipe, tap to enlarge</div>` : ''}` : ''}
    <h2 class="c-title">${esc(c.species)}</h2>
    <div class="c-size">${[fmtLen(c.length), weightText(c)].filter(Boolean).join(' · ')}${c.released ? ' <span class="pill">Released</span>' : ' <span class="pill">Kept</span>'}</div>
    <div class="muted small">${lake ? `<a href="#" id="c-lake">${esc(lake.name)}</a> · ` : ''}${fmtDate(c.time)} ${when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}${trip ? ' · <a href="#" id="c-trip">trip</a>' : ''}</div>
    <div class="card c-facts">
      ${row('Lure / bait', esc(c.lure || (tackle ? tackleLabel(tackle) : '')))}
      ${row('Technique', esc(c.technique))}
      ${row('Depth', c.depth != null ? fmtDepth(c.depth) : '')}
      ${row('Water temp', fmtTemp(c.waterTemp))}
      ${row('Clarity', esc(c.clarity))}
      ${row('Moon', esc(c.moon))}
    </div>
    ${k ? `<h3>Conditions</h3><div class="card c-facts">
      ${row('Air', fmtTemp(k.airTemp, true))}
      ${row('Wind', k.wind != null ? `${compass(k.windDir)} ${Math.round(k.wind)} mph${k.gusts != null ? `, gusts ${Math.round(k.gusts)}` : ''}` : '')}
      ${row('Pressure', k.pressureInHg != null ? `${k.pressureInHg}" ${esc(k.pressureTrend ?? '')}` : '')}
      ${row('Sky', esc([k.sky, k.cloud != null && `${Math.round(k.cloud)}% cloud`].filter(Boolean).join(', ')))}
      ${k.source === 'archive' ? '<p class="muted small" style="grid-column:1/-1;margin:0">From the weather archive for that hour at this water.</p>' : ''}
    </div>` : Date.parse(c.time) < Date.now() - 3600e3 && lake ? '<button id="c-weather" style="width:100%">Look up the weather for this catch</button>' : ''}
    ${c.tags?.length ? `<div class="tag-list">${c.tags.map(t => `<span class="pill">${esc(t)}</span>`).join('')}</div>` : ''}
    ${c.notes ? `<h3>Notes</h3><div class="card small" style="white-space:pre-wrap">${esc(c.notes)}</div>` : ''}
    ${Number.isFinite(c.lat) && Number.isFinite(c.lon) ? '<div id="c-map" class="trip-map"></div>' : ''}
    <div class="row c-acts"><button id="c-edit" class="primary">Edit</button><button id="c-share">Share</button><button id="c-del" class="danger">Delete</button></div>`;
  $('#view-catch').scrollTop = 0;
  $('#c-back').onclick = () => goBack(c);
  $('#c-newer')?.addEventListener('click', () => newer && draw(newer));
  $('#c-older')?.addEventListener('click', () => older && draw(older));
  $('#c-lake')?.addEventListener('click', e => { e.preventDefault(); pin?.remove(); pin = null; openLake(c.lakeId, 'catches'); });
  $('#c-trip')?.addEventListener('click', e => { e.preventDefault(); pin?.remove(); pin = null; openTrip(c.tripId); });
  el.querySelectorAll('.c-photos img').forEach(img => img.onclick = () => openViewer(pics, +img.dataset.i));
  $('#c-edit').onclick = () => { pin?.remove(); pin = null; editCatch(c.id); };
  $('#c-share').onclick = () => openComposer({ catches: [c.id] });
  $('#c-del').onclick = async () => {
    const before = list;
    list = list.filter(x => x !== c.id);
    const next = older ?? newer;
    // Undo brings the catch back, and shows it again if you're still on the catch page.
    await deleteCatch(c, () => { if ($('#view-catch').classList.contains('active')) { list = before; draw(c.id); } });
    return next ? draw(next) : goBack(c);
  };
  $('#c-weather')?.addEventListener('click', async e => {
    e.target.disabled = true; e.target.textContent = 'Looking it up…';
    const cond = await pastConditions(lake.lat, lake.lon, c.time);
    const now = cond && await db.get('catches', c.id);
    if (now && !now.conditions) await db.put('catches', { ...now, conditions: cond }, { touch: false });
    if (!cond) status("Couldn't get the weather (offline?)");
    if ($('#c-back')) draw(c.id);
  });
  drawPin(c);
}

function drawPin(c) {
  pin?.remove(); pin = null;
  const div = $('#c-map');
  if (!div || typeof L === 'undefined') return;
  pin = L.map(div, { zoomControl: false, attributionControl: false }).setView([c.lat, c.lon], 15);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19 }).addTo(pin);
  L.circleMarker([c.lat, c.lon], { radius: 8, color: '#fff', weight: 2, fillColor: '#f28c28', fillOpacity: 1 }).addTo(pin);
}

// ---------- Full-screen photos: swipe or use the arrows, tap ✕ or press Escape to close ----------
export function openViewer(blobs, start = 0) {
  if (!blobs.length) return;
  const urls = blobs.map(b => URL.createObjectURL(b));
  let i = Math.min(Math.max(start, 0), urls.length - 1);
  const v = document.createElement('div');
  v.className = 'viewer';
  v.innerHTML = `<img alt=""><button class="v-close" aria-label="Close">✕</button>
    ${urls.length > 1 ? '<button class="v-prev" aria-label="Previous photo">‹</button><button class="v-next" aria-label="Next photo">›</button><div class="v-count"></div>' : ''}`;
  const show = n => { i = (n + urls.length) % urls.length; v.querySelector('img').src = urls[i]; const ct = v.querySelector('.v-count'); if (ct) ct.textContent = `${i + 1} / ${urls.length}`; };
  const close = () => { v.remove(); document.removeEventListener('keydown', key); urls.forEach(u => URL.revokeObjectURL(u)); };
  const key = e => { if (e.key === 'Escape') close(); if (e.key === 'ArrowLeft') show(i - 1); if (e.key === 'ArrowRight') show(i + 1); };
  v.querySelector('.v-close').onclick = close;
  v.querySelector('.v-prev')?.addEventListener('click', () => show(i - 1));
  v.querySelector('.v-next')?.addEventListener('click', () => show(i + 1));
  let x0 = null;
  v.addEventListener('touchstart', e => { x0 = e.touches.length === 1 ? e.touches[0].clientX : null; }, { passive: true });
  v.addEventListener('touchend', e => {
    if (x0 == null || urls.length < 2) return;
    const dx = e.changedTouches[0].clientX - x0;
    if (Math.abs(dx) > 50) show(i + (dx < 0 ? 1 : -1));
    x0 = null;
  });
  document.addEventListener('keydown', key);
  document.body.append(v);
  show(i);
}
