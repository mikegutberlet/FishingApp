// The Stats view: days like today, patterns across everything you've logged, catch rates from trips, and a year in review.
import { db } from '../db.js';
import { $, esc, fmtDate, onShow, emptyState } from '../ui.js';
import { fmtLen, toDepth, units } from '../units.js';
import { renderDaysLikeToday } from '../insights.js';
import { bestsBySpecies } from './bests.js';
import { tackleLabel } from './tackle.js';
import { weightText, weightEstimate, editCatch } from './log.js';
import { openTrip } from './trips.js';

let tab = 'patterns', year = null;

const count = (arr, key) => Object.entries(arr.reduce((m, c) => { const k = key(c); if (k != null && k !== '') m[k] = (m[k] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]);
const bars = (title, rows, fmt = v => v, note = '') => {
  if (!rows.length) return '';
  const max = Math.max(...rows.map(r => r[1]));
  return `<div class="card"><h3>${title}</h3><div class="bars">${rows.slice(0, 10).map(([k, v]) => `<div class="barrow"><span class="lbl">${esc(k)}</span><div class="fill" style="width:${v / max * 60}%"></div><span>${fmt(v)}</span></div>`).join('')}</div>${note ? `<p class="muted small">${note}</p>` : ''}</div>`;
};

// A lure's color: the tackle box entry's color, else a color word in the free-text lure name.
const COLORS = ['green pumpkin', 'watermelon', 'chartreuse', 'firetiger', 'rainbow', 'white', 'black', 'blue', 'red', 'orange', 'pink', 'purple', 'yellow', 'brown', 'silver', 'gold', 'olive', 'shad', 'crawfish', 'craw', 'natural', 'clear', 'glow'];
export const lureColor = (c, tackle) => {
  const t = c.tackleId && tackle[c.tackleId];
  if (t?.color) return t.color.toLowerCase();
  const l = (c.lure ?? '').toLowerCase();
  return COLORS.find(x => l.includes(x)) ?? null;
};

// Hours on the water per trip (ended trips only), and fish per hour, overall and by key.
const tripHours = t => t.end ? Math.max(0, (Date.parse(t.end) - Date.parse(t.start)) / 36e5) : 0;
function rates(trips, catches, key) {
  const m = new Map();
  for (const t of trips) {
    const h = tripHours(t);
    if (h < 0.25) continue;
    const k = key(t), r = m.get(k) ?? { h: 0, fish: 0, trips: 0 };
    r.h += h; r.fish += catches.filter(c => c.tripId === t.id).length; r.trips++;
    m.set(k, r);
  }
  return [...m.entries()].map(([k, r]) => ({ k, ...r, rate: r.fish / r.h }));
}

// Fish per hour by hour of day: each trip's time is split across the clock hours it covered.
function hourlyRate(trips, catches) {
  const hours = Array(24).fill(0), fish = Array(24).fill(0);
  for (const t of trips) {
    if (!t.end) continue;
    for (let x = Date.parse(t.start), end = Date.parse(t.end); x < end;) {
      const d = new Date(x), next = Math.min(end, new Date(d).setMinutes(60, 0, 0));
      hours[d.getHours()] += (next - x) / 36e5; x = next;
    }
    for (const c of catches) if (c.tripId === t.id) fish[new Date(c.time).getHours()]++;
  }
  return hours.map((h, i) => [i, h, fish[i]]).filter(([, h]) => h >= 0.5);
}

const hourName = h => { const d = new Date(); d.setHours(h, 0); return d.toLocaleTimeString(undefined, { hour: 'numeric' }); };
const rate = v => `${v.toFixed(2)}/h`;

export async function renderStats() {
  const el = $('#stats');
  const [catches, lakes, trips, tackleRows] = await Promise.all([db.all('catches'), db.all('lakes'), db.all('trips'), db.all('tackle')]);
  if (!catches.length) { el.innerHTML = emptyState('📊', 'Log a few catches and your best lures, depths, times and conditions show up here.', ['🐟 Log a catch', 'log']); return; }
  el.innerHTML = `<div class="tabs"><button data-t="patterns" class="${tab === 'patterns' ? 'active' : ''}">Patterns</button><button data-t="year" class="${tab === 'year' ? 'active' : ''}">Year in review</button></div><div id="stats-body"></div>`;
  el.querySelectorAll('[data-t]').forEach(b => b.onclick = () => { tab = b.dataset.t; renderStats(); });
  const body = $('#stats-body');
  const data = { catches, lakes, trips, tackle: Object.fromEntries(tackleRows.map(t => [t.id, t])), lakeName: Object.fromEntries(lakes.map(l => [l.id, l.name])) };
  if (tab === 'year') return renderYear(body, data);
  renderPatterns(body, data);
}

function renderPatterns(el, { catches, trips, tackle, lakeName }) {
  const biggest = [...catches].filter(c => c.length).sort((a, b) => b.length - a.length)[0];
  const done = trips.filter(t => t.end && tripHours(t) >= 0.25);
  const all = rates(done, catches, () => 'all')[0];
  const byWater = rates(done, catches, t => lakeName[t.lakeId] ?? '?').sort((a, b) => b.rate - a.rate);
  const byHour = hourlyRate(done, catches).map(([h, hrs, f]) => [hourName(h), f / hrs]);
  const clarity = count(catches, c => c.clarity);
  // In each kind of water, which color caught the most.
  const colorByClarity = clarity.map(([cl]) => [cl, count(catches.filter(c => c.clarity === cl), c => lureColor(c, tackle))[0]]).filter(([, top]) => top);
  const d = units().depth;
  el.innerHTML = `<div class="card" id="dlt-card"><div class="muted small">Looking at today's conditions…</div></div>
    <div class="card grid">
      <div class="stat"><b>${catches.length}</b><span>Fish logged</span></div>
      <div class="stat"><b>${new Set(catches.map(c => c.species)).size}</b><span>Species</span></div>
      <div class="stat"><b>${biggest ? fmtLen(biggest.length) : '–'}</b><span>Longest${biggest ? ' · ' + esc(biggest.species) : ''}</span></div>
      <div class="stat"><b>${Math.round(catches.filter(c => c.released).length / catches.length * 100)}%</b><span>Released</span></div>
      ${all ? `<div class="stat"><b>${rate(all.rate)}</b><span>Fish per hour · ${all.trips} trips</span></div>` : ''}
    </div>
    ${byWater.length ? `<div class="card"><h3>Catch rate by water</h3><table><tr><th>Water</th><th>Trips</th><th>Hours</th><th>Fish/h</th></tr>
      ${byWater.map(r => `<tr><td>${esc(r.k)}</td><td>${r.trips}</td><td>${r.h.toFixed(1)}</td><td><b>${r.rate.toFixed(2)}</b></td></tr>`).join('')}</table>
      <p class="muted small">From trips you recorded in trip mode (time on the water and the fish logged during it).</p></div>` : ''}
    ${bars('Catch rate by hour of day', byHour, rate, 'Fish per hour on the water at that hour, across your trips.')}
    ${bars('By species', count(catches, c => c.species))}
    ${bars('By lake', count(catches, c => lakeName[c.lakeId]))}
    ${bars('Best lures', count(catches, c => (c.tackleId && tackle[c.tackleId] ? tackleLabel(tackle[c.tackleId]) : c.lure)))}
    ${bars('By lure color', count(catches, c => lureColor(c, tackle)), v => v, 'From the color in your tackle box, or a color named in the lure.')}
    ${bars('By water clarity', clarity, v => v, colorByClarity.length ? 'Best color · ' + colorByClarity.map(([cl, [color, n]]) => `${esc(cl)}: ${esc(color)} (${n})`).join(' · ') : '')}
    ${bars('Hour of day', count(catches, c => new Date(c.time).getHours()).sort((a, b) => a[0] - b[0]).map(([h, v]) => [hourName(+h), v]))}
    ${bars('Pressure trend', count(catches, c => c.conditions?.pressureTrend))}
    ${bars('Moon phase', count(catches, c => c.moon))}
    ${bars(`Depth (${d})`, count(catches, c => c.depth == null ? null : Math.floor(c.depth / 5) * 5).sort((a, b) => a[0] - b[0]).map(([lo, v]) => [`${toDepth(+lo)}–${toDepth(+lo + 5)}`, v]))}`;
  const card = $('#dlt-card');
  renderDaysLikeToday(card).then(ok => { if (!ok) card.remove(); }).catch(() => card.remove());
}

function renderYear(el, { catches, trips, lakeName, tackle }) {
  const years = [...new Set(catches.map(c => new Date(c.time).getFullYear()))].sort((a, b) => b - a);
  if (!years.includes(year)) year = years[0];
  const inYear = x => new Date(x).getFullYear() === year;
  const cs = catches.filter(c => inYear(c.time)).sort((a, b) => a.time.localeCompare(b.time));
  const ts = trips.filter(t => inYear(t.start) && t.end);
  const hours = ts.reduce((h, t) => h + tripHours(t), 0), tripFish = cs.filter(c => ts.some(t => t.id === c.tripId)).length;
  const days = new Set(cs.map(c => new Date(c.time).toDateString())).size;
  const before = new Set(catches.filter(c => new Date(c.time).getFullYear() < year).map(c => c.species?.toLowerCase()));
  const newSpecies = bestsBySpecies(cs).filter(s => !before.has(s.species.toLowerCase()));
  const longest = [...cs].filter(c => c.length).sort((a, b) => b.length - a.length)[0];
  const heaviest = [...cs].map(c => [c, c.weight ?? weightEstimate(c)]).filter(([, w]) => w).sort((a, b) => b[1] - a[1])[0]?.[0];
  const bestTrip = ts.map(t => [t, cs.filter(c => c.tripId === t.id).length]).sort((a, b) => b[1] - a[1])[0];
  const months = Array.from({ length: 12 }, (_, m) => [new Date(year, m, 1).toLocaleDateString(undefined, { month: 'short' }), cs.filter(c => new Date(c.time).getMonth() === m).length]);
  const bestMonth = [...months].sort((a, b) => b[1] - a[1])[0];
  const topWater = count(cs, c => lakeName[c.lakeId])[0], topLure = count(cs, c => (c.tackleId && tackle[c.tackleId] ? tackleLabel(tackle[c.tackleId]) : c.lure))[0];
  const photos = cs.filter(c => c.photo).slice(-8);
  const link = (c, text) => `<a href="#" data-catch="${c.id}">${text}</a>`;
  el.innerHTML = `<div class="row" style="margin-bottom:8px"><h2 style="flex:1;margin:0">${year} on the water</h2>
      ${years.length > 1 ? `<select id="yr">${years.map(y => `<option ${y === year ? 'selected' : ''}>${y}</option>`).join('')}</select>` : ''}</div>
    <div class="card grid yir">
      <div class="stat"><b>${cs.length}</b><span>Fish</span></div>
      <div class="stat"><b>${new Set(cs.map(c => c.species)).size}</b><span>Species</span></div>
      <div class="stat"><b>${days}</b><span>Days with a fish</span></div>
      <div class="stat"><b>${ts.length}</b><span>Trips · ${hours.toFixed(0)} h on the water</span></div>
      ${hours >= 1 ? `<div class="stat"><b>${rate(tripFish / hours)}</b><span>Fish per hour on trips</span></div>` : ''}
      <div class="stat"><b>${cs.length ? Math.round(cs.filter(c => c.released).length / cs.length * 100) : 0}%</b><span>Released</span></div>
    </div>
    <div class="card yir-list">
      ${longest ? `<div>📏 <b>Longest</b> ${link(longest, `${esc(longest.species)} ${fmtLen(longest.length)}`)} <span class="muted small">${fmtDate(longest.time)} · ${esc(lakeName[longest.lakeId] ?? '')}</span></div>` : ''}
      ${heaviest ? `<div>⚖️ <b>Heaviest</b> ${link(heaviest, `${esc(heaviest.species)} ${weightText(heaviest)}`)} <span class="muted small">${fmtDate(heaviest.time)} · ${esc(lakeName[heaviest.lakeId] ?? '')}</span></div>` : ''}
      ${topWater ? `<div>🏞️ <b>Top water</b> ${esc(topWater[0])} <span class="muted small">${topWater[1]} fish</span></div>` : ''}
      ${bestMonth?.[1] ? `<div>📅 <b>Best month</b> ${esc(bestMonth[0])} <span class="muted small">${bestMonth[1]} fish</span></div>` : ''}
      ${topLure ? `<div>🪝 <b>Go-to lure</b> ${esc(topLure[0])} <span class="muted small">${topLure[1]} fish</span></div>` : ''}
      ${bestTrip?.[1] ? `<div>🎣 <b>Best trip</b> <a href="#" data-trip="${bestTrip[0].id}">${esc(lakeName[bestTrip[0].lakeId] ?? 'Trip')}, ${fmtDate(bestTrip[0].start)}</a> <span class="muted small">${bestTrip[1]} fish</span></div>` : ''}
      ${newSpecies.length ? `<div>✨ <b>New species</b> ${newSpecies.map(s => esc(s.species)).join(', ')}</div>` : ''}
    </div>
    ${bars('Fish by month', months.filter(([, v]) => v).length ? months : [])}
    ${bars('Species', count(cs, c => c.species))}
    ${photos.length ? `<div class="card"><h3>Photos</h3><div class="photos">${photos.map(c => `<span class="ph" data-catch="${c.id}"><img src="${URL.createObjectURL(c.photo)}" alt="${esc(c.species)}"></span>`).join('')}</div></div>` : ''}`;
  $('#yr')?.addEventListener('change', e => { year = +e.target.value; renderStats(); });
  el.querySelectorAll('[data-catch]').forEach(a => a.onclick = e => { e.preventDefault(); editCatch(a.dataset.catch); });
  el.querySelectorAll('[data-trip]').forEach(a => a.onclick = e => { e.preventDefault(); openTrip(a.dataset.trip); });
}

onShow('stats', renderStats);
