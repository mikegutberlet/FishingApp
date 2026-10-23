// Today: the home screen. Your favourite waters at a glance (wind and which bank it's blowing into, the next
// bite window, lake-level change, new CDFW plants, weather alerts), and the way into the trip planner.
import { db } from '../db.js';
import * as CA from '../states/ca.js';
import { WEATHER_CODES } from '../data-sources.js';
import { weatherFor, fetchAlerts, alertLevel } from '../forecast.js';
import { solunar, dayRating, stars, nextWindow, shortTime } from '../solunar.js';
import { windOnWater, bankName } from '../wind.js';
import { $, esc, fmtDate, arrow, showView, onShow } from '../ui.js';
import { openLake } from './lake.js';

// Slot for the "days like today" insight (workstream E). Register a renderer:
//   registerTodayInsight(async el => { el.innerHTML = '…'; return true; })  // return false to keep the card hidden
const insights = [];
export const registerTodayInsight = fn => insights.push(fn);

export async function toggleFavorite(lake, btn) {
  lake.favorite = !lake.favorite;
  await db.put('lakes', lake);
  if (btn) { btn.textContent = lake.favorite ? '★' : '☆'; btn.title = lake.favorite ? 'On your Today screen' : 'Add to your Today screen'; }
}

let editing = false;

export async function renderToday() {
  const el = $('#today');
  const lakes = (await db.all('lakes')).sort((a, b) => a.name.localeCompare(b.name));
  const favs = lakes.filter(l => l.favorite);
  el.innerHTML = `<div class="today-head"><h2>${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</h2>
      <button id="go-plan">🗓 Plan a trip</button></div>
    <div id="today-insight" class="card hidden" data-slot="days-like-today"></div>
    ${!lakes.length ? `<div class="card">Welcome! Find a water under <b>Lakes</b> (or tap one on the map), save it, and star it with ☆ to see it here every day.</div>`
      : !favs.length || editing ? `<div class="card"><h3>Your favourite waters</h3><p class="muted small">Star the waters you fish most. They show here with today's wind, bite windows, level and plants.</p>
        ${lakes.map(l => `<div class="fav-row"><span>${esc(l.name)}</span><button data-fav="${l.id}">${l.favorite ? '★' : '☆'}</button></div>`).join('')}
        <button id="fav-done" class="primary" style="margin-top:8px">Done</button></div>`
      : favs.map(l => `<div class="card today-lake" data-id="${l.id}"><div class="today-title"><b>${esc(l.name)}</b><span class="today-alert"></span><span class="muted">›</span></div>
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
  weatherFor(lake.lat, lake.lon).then(w => {
    const x = windOnWater(w), c = w.current;
    const sol = solunar(new Date(), lake.lat, lake.lon), r = dayRating(sol, w.daily.sunrise[1], w.daily.sunset[1]);
    const next = nextWindow(lake.lat, lake.lon, now);
    put(0, `<div class="stat"><b>${Math.round(c.temperature_2m)}°F</b><span>${WEATHER_CODES[c.weather_code] ?? ''}</span></div>`);
    put(1, `<div class="stat"><b>${arrow(x.from)} ${Math.round(x.speed)} mph</b><span>${x.calm ? 'Calm' : `Into the ${bankName(x.to)} bank`}</span></div>`);
    if (next) put(2, `<div class="stat"><b>${next.start <= now ? '🐟 Now' : shortTime(next.start)}</b><span>${next.type === 'major' ? 'Major' : 'Minor'} bite · <span class="stars">${stars(r)}</span></span></div>`);
  }).catch(() => put(0, '<div class="stat"><b>–</b><span>Forecast unavailable</span></div>'));
  CA.nearestReservoir(lake.lat, lake.lon, lake.cdecStation, { name: lake.name, acres: lake.acres }).then(res => {
    const e = res?.elevation ?? [];
    if (e.length > 7) { const ch = e.at(-1)[1] - e.at(-8)[1]; put(3, `<div class="stat"><b>${ch > 0 ? '+' : ''}${ch.toFixed(1)} ft</b><span>Level, last 7 days</span></div>`); }
  }).catch(() => {});
  if (lake.cdfwStockId) CA.plantsFor(lake.cdfwStockId).then(plants => {
    const today = new Date().toISOString().slice(0, 10), soon = new Date(now + 7 * 864e5).toISOString().slice(0, 10), recent = new Date(now - 14 * 864e5).toISOString().slice(0, 10);
    const p = plants.filter(x => x.week >= recent && x.week <= soon).sort((a, b) => b.week.localeCompare(a.week))[0];
    if (p) put(4, `<div class="stat new-plant"><b>🐟 ${esc(p.species)}</b><span>${p.week > today ? 'Plant planned' : 'Planted'} week of ${fmtDate(p.week + 'T12:00')}</span></div>`);
  }).catch(() => {});
  fetchAlerts(lake.lat, lake.lon).then(alerts => {
    if (!alerts.length) return;
    const top = alerts.sort((a, b) => alertLevel(b) - alertLevel(a))[0];
    card.querySelector('.today-alert').innerHTML = `<span class="chip ${alertLevel(top) >= 2 ? 'bad' : 'warn'}">⚠️ ${esc(top.event)}</span>`;
  }).catch(() => {});
}

onShow('today', renderToday);
