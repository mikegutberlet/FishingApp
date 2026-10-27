// Spot book: every waypoint gets its own page of the fish you've caught on it and the conditions it produces in,
// and "spots for today" ranks a water's spots by how much today looks like the days they gave you fish.
// A fish belongs to the nearest waypoint within 60 m of where it was logged. All on the phone.
import { db } from './db.js';
import { haversineKm, compass } from './data-sources.js';
import { similarity, conditionsNow } from './insights.js';
import { KINDS, editWaypoint } from './waypoints.js';
import { $, esc, fmtDate, showView } from './ui.js';
import { fmtDepth, fmtTemp } from './units.js';
import { MONTHS } from './know-water.js';
import { tackleLabel } from './views/tackle.js';

export const SPOT_M = 60;
const hasPos = c => Number.isFinite(+c.lat) && Number.isFinite(+c.lon) && c.lat !== null && c.lon !== null;

// Waypoint id -> its catches; and the catches with a position that sit on no waypoint.
export function assign(waypoints, catches) {
  const by = new Map(waypoints.map(w => [w.id, []])), loose = [];
  for (const c of catches) {
    if (!hasPos(c)) continue;
    let best = null, bestM = SPOT_M;
    for (const w of waypoints) { const m = haversineKm(+c.lat, +c.lon, w.lat, w.lon) * 1000; if (m <= bestM) { best = w; bestM = m; } }
    if (best) by.get(best.id).push(c); else loose.push(c);
  }
  return { by, loose };
}

// Groups of 3+ logged fish within 50 m of each other that aren't on a waypoint yet: "save this as a spot?".
export function hotSpots(loose) {
  const left = [...loose], out = [];
  while (left.length) {
    const seed = left.shift(), group = [seed];
    for (let i = left.length - 1; i >= 0; i--) if (haversineKm(+seed.lat, +seed.lon, +left[i].lat, +left[i].lon) * 1000 <= 50) group.push(...left.splice(i, 1));
    const fish = group.reduce((s, c) => s + (+c.count || 1), 0);
    if (fish >= 3) out.push({ lat: group.reduce((s, c) => s + +c.lat, 0) / group.length, lon: group.reduce((s, c) => s + +c.lon, 0) / group.length, catches: group, fish });
  }
  return out.sort((a, b) => b.fish - a.fish);
}

const tally = (rows, key) => {
  const m = new Map();
  for (const c of rows) { const k = key(c); if (k == null || k === '') continue; m.set(k, (m.get(k) ?? 0) + (+c.count || 1)); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};
const hourBand = h => h < 5 ? 'Night' : h < 9 ? 'Dawn' : h < 16 ? 'Midday' : h < 20 ? 'Evening' : 'Night';

// What a spot's fish have in common.
export function spotStats(rows, tackle = []) {
  const lure = Object.fromEntries(tackle.map(t => [t.id, tackleLabel(t)]));
  const k = rows.map(c => c.conditions ?? {});
  const nums = a => a.filter(v => Number.isFinite(+v) && v !== null && v !== '').map(Number);
  const temps = nums(rows.map(c => c.waterTemp)), depths = nums(rows.map(c => c.depth));
  const span = (a, f) => a.length ? (Math.min(...a) === Math.max(...a) ? f(Math.min(...a)) : `${f(Math.min(...a))}–${f(Math.max(...a))}`) : null;
  return {
    fish: rows.reduce((s, c) => s + (+c.count || 1), 0),
    species: tally(rows, c => c.species), lures: tally(rows, c => lure[c.tackleId] ?? c.lure),
    months: tally(rows, c => MONTHS[new Date(c.time).getMonth()]), hours: tally(rows, c => hourBand(new Date(c.time).getHours())),
    wind: tally(rows.filter(c => Number.isFinite(c.conditions?.windDir) && c.conditions.wind >= 4), c => compass(c.conditions.windDir)),
    calm: rows.filter(c => c.conditions?.wind != null && c.conditions.wind < 4).length,
    pressure: tally(k.map((x, i) => ({ ...rows[i], p: x.pressureTrend })), c => c.p), sky: tally(k.map((x, i) => ({ ...rows[i], s: x.sky })), c => c.s),
    temp: span(temps, v => fmtTemp(v, true)), depth: span(depths, v => fmtDepth(v)), last: rows.map(c => c.time).sort().at(-1),
  };
}

// Today's ranking for a water's spots: the sum over each spot's fish of how alike their day was to today, with the
// reasons that match. Spots with no fish yet come last, in name order.
export async function spotsForToday(lake, { ref } = {}) {
  const [waypoints, catches] = await Promise.all([db.byLake('waypoints', lake.id), db.byLake('catches', lake.id)]);
  ref ??= await conditionsNow(lake);
  const { by, loose } = assign(waypoints, catches);
  const ranked = waypoints.map(w => {
    const rows = by.get(w.id);
    const score = rows.reduce((s, c) => s + similarity(c, ref) * (+c.count || 1), 0);
    const why = [];
    const month = new Date().getMonth(), near = rows.filter(c => Math.min(Math.abs(new Date(c.time).getMonth() - month), 12 - Math.abs(new Date(c.time).getMonth() - month)) <= 1);
    if (near.length) why.push(`${near.length} of ${rows.length} fish within a month of this date`);
    if (ref.trend) { const p = rows.filter(c => c.conditions?.pressureTrend === ref.trend).length; if (p) why.push(`${p} on ${ref.trend.toLowerCase()} pressure`); }
    if (ref.wind != null && ref.wind >= 4 && Number.isFinite(ref.windDir)) { const d = rows.filter(c => c.conditions?.wind >= 4 && Math.abs(((c.conditions.windDir - ref.windDir + 540) % 360) - 180) <= 45).length; if (d) why.push(`${d} with a ${compass(ref.windDir)} wind like today`); }
    else if (ref.wind != null && ref.wind < 4) { const d = rows.filter(c => c.conditions?.wind != null && c.conditions.wind < 4).length; if (d) why.push(`${d} on calm days`); }
    return { w, rows, score, why, fish: rows.reduce((s, c) => s + (+c.count || 1), 0) };
  }).sort((a, b) => b.score - a.score || (a.w.name ?? '').localeCompare(b.w.name ?? ''));
  return { ranked, hot: hotSpots(loose), ref };
}

const kindOf = w => KINDS[w.kind] ?? KINDS.spot;
const list = (xs, n = 3) => xs.slice(0, n).map(([k, v]) => `${esc(k)} <span class="muted">(${v})</span>`).join(', ');

// The spot's own page, in a sheet.
export async function openSpot(id, { onClose } = {}) {
  const w = await db.get('waypoints', id);
  if (!w) return;
  const [catches, tackle, lake] = await Promise.all([w.lakeId ? db.byLake('catches', w.lakeId) : db.all('catches'), db.all('tackle'), w.lakeId ? db.get('lakes', w.lakeId) : null]);
  const others = w.lakeId ? await db.byLake('waypoints', w.lakeId) : [w];
  const rows = (assign(others, catches).by.get(w.id) ?? []).sort((a, b) => b.time.localeCompare(a.time));
  const s = spotStats(rows, tackle);
  const dlg = document.createElement('dialog');
  dlg.className = 'sheet kw-sheet';
  const line = (label, html) => html ? `<div class="kw-line"><span class="muted small">${label}</span><div>${html}</div></div>` : '';
  dlg.innerHTML = `<div class="form"><h3>${kindOf(w)[0]} ${esc(w.name || kindOf(w)[1])}</h3>
    <p class="muted small">${esc(kindOf(w)[1])}${lake ? ` · ${esc(lake.name)}` : ''} · ${w.lat.toFixed(5)}, ${w.lon.toFixed(5)}</p>
    ${w.note ? `<p style="white-space:pre-wrap">${esc(w.note)}</p>` : ''}
    ${rows.length ? `<p><b>${s.fish} fish</b> logged within ${SPOT_M} m${s.last ? `, last on ${fmtDate(s.last)}` : ''}.</p>
      <div class="kw-lines">${line('Species', list(s.species))}${line('Lures', list(s.lures))}${line('Months', list(s.months, 4))}${line('Time of day', list(s.hours))}
      ${line('Wind', [list(s.wind, 2), s.calm ? `calm <span class="muted">(${s.calm})</span>` : ''].filter(Boolean).join(', '))}${line('Pressure', list(s.pressure))}${line('Sky', list(s.sky, 2))}
      ${line('Water temp', s.temp && esc(s.temp))}${line('Depth', s.depth && esc(s.depth))}</div>
      <h4 class="sub">Fish here</h4>${rows.slice(0, 30).map(c => `<div class="small kw-fish">${fmtDate(c.time)} · ${esc(c.species ?? '')}${+c.count > 1 ? ` ×${+c.count}` : ''}${c.length ? ` · ${+c.length}"` : ''}${c.lure || c.tackleId ? ` · ${esc(c.lure || tackleLabel(tackle.find(t => t.id === c.tackleId) ?? {}))}` : ''}</div>`).join('')}`
    : `<p class="small">No fish logged on this spot yet. Catches logged with a location within ${SPOT_M} m of it land here, including the quick Catch taps in trip mode.</p>`}
    <div class="row" style="margin-top:10px"><button type="button" data-a="map">Map</button><button type="button" data-a="edit">Edit</button><button type="button" class="primary" data-a="close">Close</button></div></div>`;
  document.body.append(dlg);
  const close = () => { dlg.close(); dlg.remove(); onClose?.(); };
  dlg.querySelector('[data-a=close]').onclick = close;
  dlg.querySelector('[data-a=edit]').onclick = () => { close(); editWaypoint(w); };
  dlg.querySelector('[data-a=map]').onclick = async () => { close(); const { map } = await import('./map.js'); showView('map'); map.setView([w.lat, w.lon], 17); };
  dlg.addEventListener('cancel', e => { e.preventDefault(); close(); });
  dlg.showModal();
  return dlg;
}

// The "Spots for today" card on a water's Game plan tab.
export async function renderSpotsCard(lake, el, { ref } = {}) {
  const { ranked, hot } = await spotsForToday(lake, { ref });
  const withFish = ranked.filter(r => r.fish);
  el.innerHTML = `<div class="card"><h3>📍 Spots for today</h3>
    ${!ranked.length ? '<p class="muted small">Mark your spots as waypoints (long-press the map, or ＋ on the Depth tab). Each one gets a page of the fish you catch on it, and they are ranked here for the day.</p>'
      : `${withFish.length ? '' : '<p class="muted small">None of your spots has a fish logged on it yet. Log catches with a location (trip mode does it for you) and they rank here.</p>'}
      ${ranked.map((r, i) => `<div class="lake-item kw-spot" data-spot="${esc(r.w.id)}"><span>${r.fish ? `<b class="kw-rank">${i + 1}</b>` : ''}${kindOf(r.w)[0]} <b>${esc(r.w.name || kindOf(r.w)[1])}</b>
        <span class="muted small">${r.fish ? ` · ${r.fish} fish${r.why.length ? ` · ${esc(r.why.join(', '))}` : ''}` : ' · no fish yet'}</span></span><span>›</span></div>`).join('')}`}
    ${hot.length ? `<h4 class="sub">Not marked yet</h4>${hot.slice(0, 3).map((h, i) => `<div class="lake-item"><span class="small">🔥 ${h.fish} fish within 50 m (${esc([...new Set(h.catches.map(c => c.species).filter(Boolean))].slice(0, 2).join(', '))})</span><button data-hot="${i}">Save as spot</button></div>`).join('')}` : ''}</div>`;
  el.querySelectorAll('[data-spot]').forEach(b => b.onclick = () => openSpot(b.dataset.spot, { onClose: () => el.isConnected && renderSpotsCard(lake, el, { ref }) }));
  el.querySelectorAll('[data-hot]').forEach(b => b.onclick = () => { const h = hot[+b.dataset.hot]; editWaypoint({ lat: +h.lat.toFixed(6), lon: +h.lon.toFixed(6), lakeId: lake.id, kind: 'spot', name: 'Hot spot' }); });
}
