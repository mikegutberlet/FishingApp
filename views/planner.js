// Trip planner: pick a day in the next 10, and your saved waters are ranked by forecast (wind, rain, temperature,
// pressure trend), bite windows, days since the last CDFW plant and the lake-level trend.
import { db } from '../db.js';
import { forLake, stockIdOf, reservoirFor } from '../states/index.js';
import { WEATHER_CODES } from '../data-sources.js';
import { weatherFor, localKey, addDays, levelChange } from '../forecast.js';
import { solunar, dayRating, stars, windowSpan, windowLabel } from '../solunar.js';
import { $, esc, fmtDate, showView, onShow } from '../ui.js';
import { openLake } from './lake.js';

const DAY = 864e5;
let picked = 0; // days from today

const dayKey = offset => localKey(addDays(Date.now(), offset));
const dayLabel = key => { const d = new Date(key + 'T12:00'); return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${d.getDate()}`; };
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;

// Score a water for one day: 5 is an ordinary day, 0–10. Each factor adds a reason chip.
export async function scoreDay(lake, w, date) {
  const reasons = [], add = (pts, text, tone = pts > 0 ? 'good' : pts < 0 ? 'bad' : 'ok') => { score += pts; reasons.push({ text, tone }); };
  let score = 5;
  const i = w.daily.time.indexOf(date);
  if (i < 0) return null;
  const d = k => w.daily[k][i];
  const wind = d('wind_speed_10m_max'), gust = d('wind_gusts_10m_max'), rain = d('precipitation_probability_max') ?? 0, hi = d('temperature_2m_max'), code = d('weather_code');
  if (wind <= 8) add(1.5, `Light wind, ${Math.round(wind)} mph`);
  else if (wind <= 14) add(0.5, `Wind ${Math.round(wind)} mph`, 'ok');
  else if (wind <= 20) add(-1, `Breezy, ${Math.round(wind)} mph`);
  else add(-2.5, `Windy, ${Math.round(wind)} mph`);
  if (gust > 30) add(-1, `Gusts ${Math.round(gust)}`);
  if (code >= 95) add(-3, 'Thunderstorms');
  else if (rain >= 70) add(-2, `Rain likely (${rain}%)`);
  else if (rain >= 40) add(-1, `Chance of rain (${rain}%)`);
  if (hi >= 95) add(-1, `Hot, ${Math.round(hi)}°`);
  else if (hi <= 40) add(-1, `Cold, ${Math.round(hi)}°`);
  // Pressure trend into the day: average of the day vs the day before.
  const hours = k => w.hourly.time.map((t, j) => [t, w.hourly.pressure_msl[j]]).filter(([t]) => t.startsWith(k)).map(x => x[1]);
  const p0 = hours(localKey(addDays(Date.parse(date + 'T12:00'), -1))), p1 = hours(date);
  if (p0.length && p1.length) {
    const dp = mean(p1) - mean(p0);
    if (dp <= -3) add(1.5, 'Falling pressure: front coming, fish often feed hard');
    else if (dp >= 4) add(-1, 'Rising pressure after a front: slower bite');
    else add(0, 'Steady pressure');
  }
  const sol = solunar(new Date(date + 'T12:00'), lake.lat, lake.lon), r = dayRating(sol, d('sunrise'), d('sunset'));
  if (r >= 2) add(0.5 * r, `${stars(r)} solunar day`); else add(0, `${stars(r)} solunar day`);
  const stockId = stockIdOf(lake);
  if (stockId) {
    const plants = (await forLake(lake).plantsFor(stockId)).sort((a, b) => b.week.localeCompare(a.week));
    const during = plants.find(p => p.week <= date && (p.weekEnd ?? p.week) >= date);
    const last = plants.find(p => p.week <= date);
    if (during) add(1.5, `${during.species} ${during.week <= dayKey(0) ? 'planted' : 'plant planned'} ${during.weekEnd && during.weekEnd !== during.week ? 'week of ' : 'on '}${fmtDate(during.week + 'T12:00').replace(/, \d{4}$/, '')}`);
    else if (last) {
      const ago = Math.round((Date.parse(date) - Date.parse(last.weekEnd ?? last.week)) / DAY);
      if (ago <= 7) add(2, `Planted ${ago} day${ago === 1 ? '' : 's'} earlier`);
      else if (ago <= 21) add(1, `Planted ${ago} days earlier`);
    }
  }
  const res = await reservoirFor(lake);
  const ch = levelChange(res?.elevation, 7, 4);
  if (ch != null) {
    if (ch >= 1) add(0.5, `Lake rising ${ch.toFixed(1)} ft/week`);
    else if (ch <= -2) add(-0.5, `Lake dropping ${(-ch).toFixed(1)} ft/week`);
  }
  // Best time: the bite window with the least wind, preferring ones near sunrise or sunset.
  const windAt = t => { const j = w.hourly.time.findIndex(x => Date.parse(x) >= t); return j < 0 ? 99 : w.hourly.wind_speed_10m[j]; };
  const light = [d('sunrise'), d('sunset')].map(Date.parse);
  const awake = sol.windows.filter(x => new Date(x.peak).getHours() >= 5 && new Date(x.peak).getHours() <= 21 && x.end > Date.now()); // not one that's over
  const best = awake.map(x => ({ x, v: windAt(x.peak) - (light.some(s => Math.abs(s - x.peak) < 2 * 3600e3) ? 6 : 0) - (x.type === 'major' ? 2 : 0) })).sort((a, b) => a.v - b.v)[0]?.x;
  return { score: Math.max(0, Math.min(10, score)), reasons, best, summary: `${WEATHER_CODES[code] ?? ''}, ${Math.round(d('temperature_2m_min'))}–${Math.round(hi)}°` };
}

export async function renderPlanner() {
  const el = $('#planner');
  const days = Array.from({ length: 10 }, (_, k) => ({ k, key: dayKey(k), label: k === 0 ? 'Today' : k === 1 ? 'Tomorrow' : dayLabel(dayKey(k)) }));
  el.innerHTML = `<div class="lake-bar"><button id="plan-back">‹ Today</button><button id="plan-camp">⛺ Camp trip</button></div><h2>Plan a trip</h2>
    <div class="tabs day-pick">${days.map(d => `<button data-k="${d.k}" class="${d.k === picked ? 'active' : ''}">${d.label}</button>`).join('')}</div>
    <div id="plan-list" class="muted">Ranking your waters…</div>
    <p class="muted small">Scores mix the Open-Meteo forecast, bite windows, state stocking (CDFW, NDOW) and lake levels. 5 is an ordinary day. Forecasts past 5 days are rough.</p>`;
  $('#plan-back').onclick = () => showView('today');
  $('#plan-camp').onclick = () => import('./camp.js').then(m => m.renderCampHome());
  el.querySelectorAll('.day-pick button').forEach(b => b.onclick = () => { picked = +b.dataset.k; renderPlanner(); });
  const lakes = await db.all('lakes');
  if (!lakes.length) { $('#plan-list').innerHTML = '<div class="card">Save some waters first (Lakes → pick your state → Any water), then come back to rank them.</div>'; return; }
  const date = days[picked].key;
  const rows = (await Promise.all(lakes.map(async lake => {
    try { return { lake, ...(await scoreDay(lake, await weatherFor(lake.lat, lake.lon), date)) }; } catch { return { lake, error: true }; }
  }))).filter(r => r.error || r.score != null);
  if (!el.isConnected || date !== days[picked].key) return;
  rows.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  $('#plan-list').classList.remove('muted');
  $('#plan-list').innerHTML = rows.map((r, n) => r.error
    ? `<div class="card plan-item" data-id="${esc(r.lake.id)}"><b>${esc(r.lake.name)}</b><div class="muted small">Forecast unavailable (offline?)</div></div>`
    : `<div class="card plan-item" data-id="${esc(r.lake.id)}">
      <div class="plan-head"><span class="rank">${n + 1}</span><div style="flex:1"><b>${esc(r.lake.name)}</b>${r.lake.favorite ? ' ★' : ''}<div class="muted small">${esc(r.summary)}</div></div>
        <div class="score"><b>${r.score.toFixed(1)}</b><div class="meter"><i style="width:${r.score * 10}%"></i></div></div></div>
      ${r.best ? `<div class="small">Best time: <b>${windowSpan(r.best)}</b>, ${windowLabel(r.best).toLowerCase()}</div>` : ''}
      <div class="chips">${r.reasons.map(x => `<span class="chip ${x.tone}">${esc(x.text)}</span>`).join('')}</div></div>`).join('');
  $('#plan-list').querySelectorAll('.plan-item').forEach(c => c.onclick = () => openLake(c.dataset.id));
}

onShow('planner', renderPlanner);
document.addEventListener('visibilitychange', () => { if (!document.hidden && $('#view-planner').classList.contains('active')) renderPlanner(); });
