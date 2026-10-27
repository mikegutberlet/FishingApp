// "Days like today": scores every catch you've logged by how much its day resembles today (season, pressure trend,
// air temp, wind, moon, time of day and the water), then says what worked on those days. All on device.
import { db } from './db.js';
import { moonPhase, pressureTrend, compass } from './data-sources.js';
import { weatherFor } from './forecast.js';
import { esc, fmtDate, $ } from './ui.js';
import { toDepth, units } from './units.js';
import { tackleLabel } from './views/tackle.js';

const SYNODIC = 29.530588853;
const g = (d, w) => Math.exp(-((d / w) ** 2));
const circ = (a, b, n) => { const d = Math.abs(a - b) % n; return Math.min(d, n - d); };
const doy = t => { const d = new Date(t); return (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(d.getFullYear(), 0, 0)) / 864e5; };
const hourOf = t => { const d = new Date(t); return d.getHours() + d.getMinutes() / 60; };
const TREND = { Rising: 1, Steady: 0, Falling: -1 };

// How alike are catch c's conditions and `ref`? 0–1, with the reasons that matched.
// Factors a catch has no data for (logged offline: no weather) count as half-alike, so they neither win nor lose.
export function similarity(c, ref) {
  const f = [];
  const add = (w, s) => f.push([w, s]);
  const t = Date.parse(c.time);
  add(3, g(circ(doy(t), ref.doy, 365.25), 20));                                      // within ~3 weeks of the date
  add(1, g(circ(moonPhase(new Date(t)).fraction, ref.moon, 1) * SYNODIC, 4));        // moon within ~4 days
  add(1, g(circ(hourOf(t), ref.hour, 24), 2.5));                                     // time of day
  add(1.5, c.lakeId === ref.lakeId ? 1 : 0);                                         // same water
  const k = c.conditions;
  add(2, k?.pressureTrend && ref.trend ? 1 - Math.abs(TREND[k.pressureTrend] - TREND[ref.trend]) / 2 : 0.5);
  add(2, k?.airTemp != null && ref.airTemp != null ? g(k.airTemp - ref.airTemp, 8) : 0.5);
  add(1.5, k?.wind != null && ref.wind != null ? g(k.wind - ref.wind, 6) : 0.5);
  return f.reduce((s, [w, x]) => s + w * x, 0) / f.reduce((s, [w]) => s + w, 0);
}

// Today's conditions at a water, from the same forecast the rest of the app uses (one request per water).
export async function conditionsNow(lake) {
  const now = Date.now(), ref = { lakeId: lake.id, doy: doy(now), hour: hourOf(now), moon: moonPhase(new Date()).fraction, moonName: moonPhase(new Date()).name };
  try {
    const w = await weatherFor(lake.lat, lake.lon);
    Object.assign(ref, { airTemp: w.current.temperature_2m, wind: w.current.wind_speed_10m, windDir: w.current.wind_direction_10m, trend: pressureTrend(w)?.label });
  } catch { /* offline: season, moon, time and water still work */ }
  return ref;
}

const top = (rows, key, n = 3) => {
  const m = new Map();
  for (const { c, s } of rows) { const k = key(c); if (k == null || k === '') continue; m.set(k, (m.get(k) ?? 0) + s); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ k, v, n: rows.filter(r => key(r.c) === k).length }));
};

// The catches most like today, and what they have in common.
export function analyze(catches, ref, { tackle = [], minScore = 0.6, max = 40 } = {}) {
  const lure = Object.fromEntries(tackle.map(t => [t.id, tackleLabel(t)]));
  const rows = catches.map(c => ({ c, s: similarity(c, ref) })).filter(r => r.s >= minScore).sort((a, b) => b.s - a.s).slice(0, max);
  const days = new Map();
  for (const r of rows) {
    const key = `${new Date(r.c.time).toDateString()}|${r.c.lakeId}`;
    const d = days.get(key) ?? { time: r.c.time, lakeId: r.c.lakeId, fish: 0, s: 0, species: new Set() };
    d.fish++; d.s = Math.max(d.s, r.s); d.species.add(r.c.species);
    days.set(key, d);
  }
  const band = c => c.depth == null ? null : `${Math.floor(c.depth / 5) * 5}–${Math.floor(c.depth / 5) * 5 + 5}`;
  const hours = c => { const h = new Date(c.time).getHours(); return `${h}`; };
  return {
    rows, days: [...days.values()].sort((a, b) => b.s - a.s || b.fish - a.fish),
    species: top(rows, c => c.species), lures: top(rows, c => lure[c.tackleId] ?? c.lure), depths: top(rows, band, 2),
    waters: top(rows, c => c.lakeId), hours: top(rows, hours, 2),
  };
}

const hourText = h => { const d = new Date(); d.setHours(+h, 0); return d.toLocaleTimeString(undefined, { hour: 'numeric' }).replace(/\s?([AP])M/i, (_, a) => a.toLowerCase()); };
const conditionsText = ref => [new Date().toLocaleDateString(undefined, { month: 'long' }), ref.trend && `${ref.trend.toLowerCase()} pressure`,
  ref.airTemp != null && `${Math.round(ref.airTemp)}°F`, ref.wind != null && `${compass(ref.windDir)} ${Math.round(ref.wind)} mph`, ref.moonName.toLowerCase()].filter(Boolean).join(', ');

// Which water to compare against: the one asked for, else your first favourite, else where you've caught the most.
export async function defaultLake(lakes, catches) {
  const favs = lakes.filter(l => l.favorite);
  if (favs.length) return favs[0];
  const n = id => catches.filter(c => c.lakeId === id).length;
  return [...lakes].sort((a, b) => n(b.id) - n(a.id))[0] ?? null;
}

// Renders the insight into el. Returns false when there's nothing worth showing (no catches yet).
export async function renderDaysLikeToday(el, { lakeId = null, compact = false } = {}) {
  const [catches, lakes, tackle] = await Promise.all([db.all('catches'), db.all('lakes'), db.all('tackle')]);
  if (!catches.length || !lakes.length) return false;
  const lake = lakes.find(l => l.id === lakeId) ?? await defaultLake(lakes, catches);
  const ref = await conditionsNow(lake);
  const a = analyze(catches, ref, { tackle });
  const name = Object.fromEntries(lakes.map(l => [l.id, l.name]));
  const list = (xs, fmt = x => esc(x.k)) => xs.map(x => `${fmt(x)} <span class="muted">(${x.n})</span>`).join(', ');
  const pick = compact ? '' : `<label class="form small" style="margin:0">Conditions at <select id="dlt-lake" style="display:inline-block;width:auto">${lakes.map(l => `<option value="${l.id}" ${l.id === lake.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>`;
  el.innerHTML = `<h3>📈 Days like today</h3>
    <p class="small muted">${esc(conditionsText(ref))}${compact ? ` at ${esc(lake.name)}` : ''}</p>${pick}
    ${a.rows.length < 2 ? `<p class="small">${a.rows.length === 1 ? 'Only one of your catches came on a day much like this one so far.' : catches.length === 1 ? 'Your one catch didn’t come on a day much like this one.' : `None of your ${catches.length} catches came on a day much like this one yet.`} Every catch you log (with its weather) sharpens this.</p>`
      : `<p class="small"><b>${a.rows.length} catches</b> on ${a.days.length} similar day${a.days.length > 1 ? 's' : ''}.</p>
      <div class="dlt">
        <div><span class="muted small">Species</span><div>${list(a.species)}</div></div>
        ${a.lures.length ? `<div><span class="muted small">Lures</span><div>${list(a.lures)}</div></div>` : ''}
        ${a.depths.length ? `<div><span class="muted small">Depth</span><div>${list(a.depths, x => x.k.split('–').map(v => toDepth(+v)).join('–') + ' ' + units().depth)}</div></div>` : ''}
        <div><span class="muted small">Best hours</span><div>${list(a.hours, x => hourText(x.k))}</div></div>
        ${a.waters.length > 1 || a.waters[0]?.k !== lake.id ? `<div><span class="muted small">Waters</span><div>${list(a.waters, x => esc(name[x.k] ?? '?'))}</div></div>` : ''}
      </div>
      ${compact ? '' : `<h3 style="margin-top:10px">Most alike</h3>${a.days.slice(0, 5).map(d => `<div class="tl-row small"><b>${Math.round(d.s * 100)}%</b> ${fmtDate(d.time)} · ${esc(name[d.lakeId] ?? '')} · ${d.fish} fish (${[...d.species].map(esc).join(', ')})</div>`).join('')}`}`}`;
  $('#dlt-lake', el)?.addEventListener('change', e => renderDaysLikeToday(el, { lakeId: e.target.value }));
  return true;
}

// Fill the Today screen's slot when that screen is in this build.
// It may register after Today first drew itself, so fill the slot once now too.
const todayInsight = el => renderDaysLikeToday(el, { compact: true });
if (document.getElementById('view-today')) import('./views/today.js').then(m => {
  m.registerTodayInsight?.(todayInsight);
  const slot = document.getElementById('today-insight');
  if (slot && document.getElementById('view-today').classList.contains('active')) todayInsight(slot).then(show => show && slot.classList.remove('hidden'));
}).catch(() => {});
