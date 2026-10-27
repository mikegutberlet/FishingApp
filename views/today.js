// Today: the home screen. Your favorite waters at a glance, one swipeable card each (sky, temperature, wind and which bank
// it's blowing into, the next bite window, pressure trend, lake-level change, new CDFW plants, weather alerts), and the way into the trip planner.
import { db } from '../db.js';
import { forLake, stockIdOf, reservoirFor } from '../states/index.js';
import { WEATHER_CODES, pressureTrend } from '../data-sources.js';
import { weatherFor, fetchAlerts, alertLevel, localKey, addDays, levelChange, forecastAge } from '../forecast.js';
import { solunar, dayRating, stars, nextWindow, shortTime } from '../solunar.js';
import { windOnWater, bankName } from '../wind.js';
import { $, esc, fmtDate, arrow, showView, onShow, emptyState, icon } from '../ui.js';
import { openLake } from './lake.js';
import { dayStripHtml } from './day-plan.js';
import { fillReportLines } from '../report-line.js';

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
      <div class="row"><button id="go-ready" title="Save forecast, maps and lookups for no signal">📴 Ready</button><button id="go-plan">${icon('calendar')}Plan a trip</button></div></div>
    <div id="today-where"></div>
    <div id="today-insight" class="card hidden" data-slot="days-like-today"></div>
    <div id="today-backup" class="card hidden"></div>
    <div id="today-camp" class="card hidden"></div>
    ${!lakes.length ? emptyState('🎣', 'Welcome! Find a water you fish, save it, and star it with ☆ to see its wind, bite windows, level and plants here every day.', ['🔎 Find a water', 'lakes'], ['🗺️ Open the map', 'map'])
      : !favs.length || editing ? `<div class="card"><h3>Your favorite waters</h3><p class="muted small">Star the waters you fish most. They show here with today's wind, bite windows, level and plants.</p>
        ${lakes.map(l => `<div class="fav-row"><span>${esc(l.name)}</span><button data-fav="${esc(l.id)}">${l.favorite ? '★' : '☆'}</button></div>`).join('')}
        <button id="fav-done" class="primary" style="margin-top:8px">Done</button></div>`
      : `<div class="today-carousel${favs.length > 1 ? ' multi' : ''}">${favs.map(l => `<div class="card today-lake" data-id="${esc(l.id)}">
          <div class="hero sky-clear"><div class="today-title"><b>${esc(l.name)}</b><span class="today-alert"></span><span>›</span></div>
            <div class="hero-now"><span class="hero-temp">–</span><div><div class="hero-sky">Loading forecast…</div><div class="hero-wind"></div></div></div></div>
          <div class="grid today-grid"></div><div class="kw-today small" data-plan-for="${esc(l.id)}"></div><div data-report-for="${esc(l.id)}"></div></div>`).join('')}</div>
        ${favs.length > 1 ? `<div class="dots-row">${favs.map((_, i) => `<i class="${i ? '' : 'on'}"></i>`).join('')}</div>` : ''}
        <p class="small"><a href="#" id="fav-edit">Change favorites</a></p>`}
    <div class="card map-card"><div class="map-card-head"><b>Map</b><span class="muted small">${lakes.length ? 'Your waters · tap to browse' : 'Tap to browse lakes and rivers'}</span><span>›</span></div><div id="today-map"></div></div>`;
  import('../map-browse.js').then(m => m.mountTodayMap($('#today-map', el))); // dynamic: map-browse pulls in the map, which pulls in this view
  import('./where.js').then(m => m.renderWhereCard($('#today-where', el))); // dynamic too: where.js pulls in the map
  import('./camp.js').then(m => m.todayCamp($('#today-camp', el))).catch(() => {}); // the camp trip you're on, or the next one
  import('../backup-prompt.js').then(m => m.todayBackup($('#today-backup', el))).catch(() => {}); // back up before a multi-day trip
  $('#go-plan').onclick = () => showView('planner');
  $('#go-ready').onclick = () => import('../ready.js').then(m => m.readyDialog());
  el.querySelectorAll('[data-fav]').forEach(b => b.onclick = () => toggleFavorite(lakes.find(l => l.id === b.dataset.fav), b));
  const done = $('#fav-done'), edit = $('#fav-edit');
  if (done) done.onclick = () => { editing = false; renderToday(); };
  if (edit) edit.onclick = e => { e.preventDefault(); editing = true; renderToday(); };
  if (!editing) fillReportLines(el, favs);
  if (!editing) import('../game-plan.js').then(m => m.fillPlanLines(el, favs)).catch(() => {}); // "what to throw" line per water
  if (!editing) el.querySelectorAll('.today-lake').forEach(card => {
    card.onclick = () => openLake(card.dataset.id);
    fillCard(card, favs.find(l => l.id === card.dataset.id));
  });
  // Swipe between favorite waters; the dots follow.
  const strip = $('.today-carousel.multi', el);
  if (strip) strip.addEventListener('scroll', () => {
    const i = Math.round(strip.scrollLeft / strip.firstElementChild.offsetWidth);
    el.querySelectorAll('.dots-row i').forEach((d, j) => d.classList.toggle('on', i === j));
  }, { passive: true });
  const slot = $('#today-insight');
  for (const fn of insights) Promise.resolve(fn(slot)).then(show => show !== false && slot.innerHTML && slot.classList.remove('hidden')).catch(() => {});
}

async function fillCard(card, lake) {
  const grid = card.querySelector('.today-grid'), hero = card.querySelector('.hero'), stats = [];
  const put = (order, html) => { stats[order] = html; grid.innerHTML = stats.filter(Boolean).join(''); };
  const now = Date.now();
  // The bite window is computed on the device, so it shows offline; the forecast adds the sunrise/sunset bonus to its stars.
  const next = nextWindow(lake.lat, lake.lon, now);
  const putBite = w => {
    if (!next) return;
    const i = w?.daily.time.indexOf(localKey(next.peak)) ?? -1;
    const r = dayRating(solunar(new Date(next.peak), lake.lat, lake.lon), w?.daily.sunrise[i], w?.daily.sunset[i]);
    const tomorrow = next.start > now && localKey(next.start) !== localKey(now);
    put(0, `<div class="stat"><b>${next.start <= now ? '🐟 Now' : shortTime(next.start)}</b><span>${next.type === 'major' ? 'Major' : 'Minor'} bite${tomorrow ? ' tomorrow' : ''} · <span class="stars">${stars(r)}</span></span></div>`);
  };
  putBite(null);
  weatherFor(lake.lat, lake.lon).then(w => {
    const x = windOnWater(w), c = w.current, trend = pressureTrend(w);
    hero.className = `hero ${skyClass(w)}`;
    hero.querySelector('.hero-temp').textContent = `${Math.round(c.temperature_2m)}°`;
    hero.querySelector('.hero-sky').textContent = (WEATHER_CODES[c.weather_code] ?? '') + (w.saved ? ` · 📴 ${forecastAge(w)}` : '');
    hero.querySelector('.hero-wind').innerHTML = `${arrow(x.from)} ${Math.round(x.speed)} mph${x.gusts >= x.speed + 5 ? `, gusts ${Math.round(x.gusts)}` : ''} · ${x.calm ? 'calm' : `into the ${bankName(x.to)} bank`}`;
    put(1, `<div class="stat"><b>${(c.pressure_msl * 0.02953).toFixed(2)}"</b><span>Pressure${trend ? ` · ${trend.label.toLowerCase()} ${trend.delta > 1 ? '↗' : trend.delta < -1 ? '↘' : '→'}` : ''}</span></div>`);
    putBite(w);
    grid.insertAdjacentHTML('afterend', dayStripHtml(w, localKey(), lake, { orTomorrow: true })); // your craft's safe hours today
  }).catch(() => { hero.className = 'hero sky-cloud'; hero.querySelector('.hero-sky').textContent = 'Forecast unavailable (offline?)'; });
  reservoirFor(lake).then(res => {
    const ch = levelChange(res?.elevation, 7, 4);
    if (ch != null) put(2, `<div class="stat"><b>${ch > 0 ? '+' : ''}${ch.toFixed(1)} ft</b><span>Level, last 7 days</span></div>`);
  }).catch(() => {});
  const stockId = stockIdOf(lake);
  if (stockId) forLake(lake).plantsFor(stockId).then(plants => {
    const today = localKey(now), soon = localKey(addDays(now, 7)), recent = localKey(addDays(now, -14));
    const p = plants.filter(x => x.week >= recent && x.week <= soon).sort((a, b) => b.week.localeCompare(a.week))[0];
    if (p) put(3, `<div class="stat new-plant"><b>🐟 ${esc(p.species)}</b><span>${p.week > today ? 'Plant planned' : 'Planted'} ${p.weekEnd && p.weekEnd !== p.week ? 'week of ' : ''}${fmtDate(p.week + 'T12:00')}</span></div>`);
  }).catch(() => {});
  fetchAlerts(lake.lat, lake.lon).then(alerts => {
    if (!alerts.length) return;
    const top = alerts.sort((a, b) => alertLevel(b) - alertLevel(a))[0];
    card.querySelector('.today-alert').innerHTML = `<span class="chip ${alertLevel(top) >= 2 ? 'bad' : 'warn'}">⚠️ ${esc(top.event)}</span>`;
  }).catch(() => {});
}

// The card's backdrop follows the sky: night, rain or snow, cloud, or clear.
function skyClass(w) {
  const c = w.current, i = w.daily.time.indexOf(c.time.slice(0, 10)), t = Date.parse(c.time);
  if (i >= 0 && (t < Date.parse(w.daily.sunrise[i]) || t > Date.parse(w.daily.sunset[i]))) return 'sky-night';
  if (c.weather_code >= 51) return 'sky-rain';
  return c.weather_code >= 3 || c.cloud_cover > 70 ? 'sky-cloud' : 'sky-clear';
}

onShow('today', renderToday);
// An installed app can sit in memory overnight: refresh the home screen when it comes back on a new day or after 15 minutes.
document.addEventListener('visibilitychange', () => {
  if (document.hidden || editing || !$('#view-today').classList.contains('active')) return;
  if (localKey(renderedAt) !== localKey() || Date.now() - renderedAt > 15 * 60e3) renderToday();
});
