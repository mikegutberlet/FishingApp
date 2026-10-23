// Today: the home screen. Your favourite waters at a glance (wind and which bank it's blowing into, the next
// bite window, lake-level change, new CDFW plants, weather alerts), and the way into the trip planner.
import { db } from '../db.js';
import { forLake, stockIdOf, reservoirFor } from '../states/index.js';
import { WEATHER_CODES } from '../data-sources.js';
import { weatherFor, fetchAlerts, alertLevel, localKey, addDays, levelChange } from '../forecast.js';
import { solunar, dayRating, stars, nextWindow, shortTime } from '../solunar.js';
import { windOnWater, bankName } from '../wind.js';
import { $, esc, fmtDate, arrow, showView, onShow } from '../ui.js';
import { openLake } from './lake.js';

// Slot for the "days like today" insight (workstream E). Register a renderer:
//   registerTodayInsight(async el => { el.innerHTML = '…'; return true; })  // return false to keep the card hidden
const insights = [];
export const registerTodayInsight = fn => insights.push(fn);

// Re-reads the lake first: the page's copy can be stale (the Stocking tab saves plantsSeen on the same record).
export async function toggleFavorite(lake, btn) {
  const fresh = (await db.get('lakes', lake.id)) ?? lake;
  fresh.favorite = lake.favorite = !lake.favorite;
  await db.put('lakes', fresh);
  if (btn) { btn.textContent = lake.favorite ? '★' : '☆'; btn.title = lake.favorite ? 'On your Today screen' : 'Add to your Today screen'; }
}

let editing = false, renderedAt = 0;

export async function renderToday() {
  const el = $('#today');
  renderedAt = Date.now();
  const lakes = (await db.all('lakes')).sort((a, b) => a.name.localeCompare(b.name));
  const favs = lakes.filter(l => l.favorite);
  el.innerHTML = `<div class="today-head"><h2>${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</h2>
      <button id="go-plan">🗓 Plan a trip</button></div>
    <div id="today-insight" class="card hidden" data-slot="days-like-today"></div>
    ${!lakes.length ? `<div class="card">Welcome! Find a water under <b>Lakes</b> (or tap one on the map), save it, and star it with ☆ to see it here every day.</div>`
      : !favs.length || editing ? `<div class="card"><h3>Your favourite waters</h3><p class="muted small">Star the waters you fish most. They show here with today's wind, bite windows, level and plants.</p>
        ${lakes.map(l => `<div class="fav-row"><span>${esc(l.name)}</span><button data-fav="${esc(l.id)}">${l.favorite ? '★' : '☆'}</button></div>`).join('')}
        <button id="fav-done" class="primary" style="margin-top:8px">Done</button></div>`
      : favs.map(l => `<div class="card today-lake" data-id="${esc(l.id)}"><div class="today-title"><b>${esc(l.name)}</b><span class="today-alert"></span><span class="muted">›</span></div>
          <div class="grid today-grid"><div class="muted small">Loading…</div></div></div>`).join('') + '<p class="small"><a href="#" id="fav-edit">Change favourites</a></p>'}`;
  $('#go-plan').onclick = () => showView('planner');
  el.querySelectorAll('[data-fav]').forEach(b => b.onclick = () => toggleFavorite(lakes.find(l => l.id === b.dataset.fav), b));
  const done = $('#fav-done'), edit = $('#fav-edit');
  if (done) done.onclick = () => { editing = false; renderToday(); };
  if (edit) edit.onclick = e => { e.preventDefault(); editing = true; renderToday(); };
  if (!editing) el.querySelectorAll('.today-lake').forEach(card => {
    card.onclick = () => openLake(card.dataset.id);
    fillCard(card, favs.find(l => l.id === card.dataset.id));
  });
  const slot = $('#today-insight');
  for (const fn of insights) Promise.resolve(fn(slot)).then(show => show !== false && slot.innerHTML && slot.classList.remove('hidden')).catch(() => {});
}

async function fillCard(card, lake) {
  const grid = card.querySelector('.today-grid'), stats = [];
  const put = (order, html) => { stats[order] = html; grid.innerHTML = stats.filter(Boolean).join(''); };
  const now = Date.now();
  // The bite window is computed on the device, so it shows offline; the forecast adds the sunrise/sunset bonus to its stars.
  const next = nextWindow(lake.lat, lake.lon, now);
  const putBite = w => {
    if (!next) return;
    const i = w?.daily.time.indexOf(localKey(next.peak)) ?? -1;
    const r = dayRating(solunar(new Date(next.peak), lake.lat, lake.lon), w?.daily.sunrise[i], w?.daily.sunset[i]);
    const tomorrow = next.start > now && localKey(next.start) !== localKey(now);
    put(2, `<div class="stat"><b>${next.start <= now ? '🐟 Now' : shortTime(next.start)}</b><span>${next.type === 'major' ? 'Major' : 'Minor'} bite${tomorrow ? ' tomorrow' : ''} · <span class="stars">${stars(r)}</span></span></div>`);
  };
  putBite(null);
  weatherFor(lake.lat, lake.lon).then(w => {
    const x = windOnWater(w), c = w.current;
    put(0, `<div class="stat"><b>${Math.round(c.temperature_2m)}°F</b><span>${WEATHER_CODES[c.weather_code] ?? ''}</span></div>`);
    put(1, `<div class="stat"><b>${arrow(x.from)} ${Math.round(x.speed)} mph</b><span>${x.calm ? 'Calm' : `Into the ${bankName(x.to)} bank`}</span></div>`);
    putBite(w);
  }).catch(() => put(0, '<div class="stat"><b>–</b><span>Forecast unavailable</span></div>'));
  reservoirFor(lake).then(res => {
    const ch = levelChange(res?.elevation, 7, 4);
    if (ch != null) put(3, `<div class="stat"><b>${ch > 0 ? '+' : ''}${ch.toFixed(1)} ft</b><span>Level, last 7 days</span></div>`);
  }).catch(() => {});
  const stockId = stockIdOf(lake);
  if (stockId) forLake(lake).plantsFor(stockId).then(plants => {
    const today = localKey(now), soon = localKey(addDays(now, 7)), recent = localKey(addDays(now, -14));
    const p = plants.filter(x => x.week >= recent && x.week <= soon).sort((a, b) => b.week.localeCompare(a.week))[0];
    if (p) put(4, `<div class="stat new-plant"><b>🐟 ${esc(p.species)}</b><span>${p.week > today ? 'Plant planned' : 'Planted'} ${p.weekEnd && p.weekEnd !== p.week ? 'week of ' : ''}${fmtDate(p.week + 'T12:00')}</span></div>`);
  }).catch(() => {});
  fetchAlerts(lake.lat, lake.lon).then(alerts => {
    if (!alerts.length) return;
    const top = alerts.sort((a, b) => alertLevel(b) - alertLevel(a))[0];
    card.querySelector('.today-alert').innerHTML = `<span class="chip ${alertLevel(top) >= 2 ? 'bad' : 'warn'}">⚠️ ${esc(top.event)}</span>`;
  }).catch(() => {});
}

onShow('today', renderToday);
// An installed app can sit in memory overnight: refresh the home screen when it comes back on a new day or after 15 minutes.
document.addEventListener('visibilitychange', () => {
  if (document.hidden || editing || !$('#view-today').classList.contains('active')) return;
  if (localKey(renderedAt) !== localKey() || Date.now() - renderedAt > 15 * 60e3) renderToday();
});
