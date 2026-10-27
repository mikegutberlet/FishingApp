// Tides tab (ocean waters): the nearest NOAA tide station's highs and lows, a two-day curve with "now", what the
// tide is doing for fishing, and a week of highs and lows. Saved on the phone, so it works with no signal.
import { nearestTideStation, tidesFor, tideAt, tideRead, tidePageUrl } from '../../coast.js';
import { esc } from '../../ui.js';

const hm = t => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const day = t => new Date(t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const ft = v => `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)} ft`;
const mi = km => `${(km * 0.621).toFixed(km < 16 ? 1 : 0)} mi`;

export async function renderTides(lake, body) {
  body.innerHTML = `<div class="card" id="oc-tide">Finding the nearest tide station…</div>`;
  const el = body.querySelector('#oc-tide');
  let st;
  try { st = await nearestTideStation(lake.lat, lake.lon); } catch { st = null; }
  if (!body.isConnected) return;
  if (!st) { el.innerHTML = `<h3>Tides</h3><p class="muted small">No NOAA tide station within about 35 miles of this spot${navigator.onLine === false ? ', or the station list hasn’t been saved on this phone yet' : ''}.</p>`; return; }
  try {
    const { data: ev, savedAt } = await tidesFor(st.id);
    if (!body.isConnected) return;
    el.innerHTML = tideHtml(ev, st, savedAt);
  } catch (e) {
    el.innerHTML = `<h3>Tides</h3><p class="muted small">Couldn’t get tides for ${esc(st.name)} (${esc(e.message)}). Open this tab once with signal and they’ll be kept on your phone for the week.</p>
      <p class="small"><a href="${tidePageUrl(st.id)}" target="_blank" rel="noopener">NOAA tide predictions ↗</a></p>`;
  }
}

export function tideHtml(ev, st, savedAt, now = Date.now()) {
  const read = tideRead(ev, now);
  const upcoming = ev.filter(e => e.t > now).slice(0, 4);
  const days = new Map();
  for (const e of ev.filter(e => e.t > now - 6 * 36e5)) {
    const k = new Date(e.t).toDateString();
    if (!days.has(k)) days.set(k, []);
    days.get(k).push(e);
  }
  // Best fishing windows: about 2 h either side of each change, in daylight-agnostic terms (sunrise/sunset is on Conditions).
  return `<h3>Tides · ${esc(st.name)}</h3>
    ${savedAt ? `<p class="saved-wx small">📴 <b>Saved tides</b> from ${esc(new Date(savedAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }))}. Tide predictions don’t change, so these stay right.</p>` : ''}
    ${read ? `<div class="oc-now"><div class="oc-big">${read.rising ? '⬆' : '⬇'} ${ft(read.v)}</div><div><b>${read.phase === 'slack' ? 'Slack water' : read.rising ? 'Rising' : 'Falling'}</b> · ${read.next.type === 'H' ? 'high' : 'low'} ${ft(read.next.v)} at ${hm(read.next.t)}
      <div class="small">${esc(read.text)}${read.big ? ' Big swing today: expect strong current at channel mouths and jetty tips.' : ''}</div></div></div>` : ''}
    ${tideSvg(ev, now)}
    <div class="oc-next">${upcoming.map(e => `<div class="stat"><b>${e.type === 'H' ? 'High' : 'Low'} ${ft(e.v)}</b><span>${new Date(e.t).toDateString() === new Date(now).toDateString() ? '' : day(e.t).split(',')[0] + ' '}${hm(e.t)}</span></div>`).join('')}</div>
    <h3 style="margin-top:12px">This week</h3>
    <table class="days oc-week">${[...days.entries()].slice(0, 7).map(([, list]) => `<tr><td>${esc(day(list[0].t))}</td><td>${list.map(e => `<span class="${e.type === 'H' ? 'oc-h' : 'oc-l'}">${e.type} ${hm(e.t)} ${ft(e.v)}</span>`).join(' ')}</td></tr>`).join('')}</table>
    <p class="muted small">NOAA CO-OPS predictions for station ${esc(st.id)}${st.ref === false ? ' (a secondary station: times and heights are adjusted from a reference station)' : ''}, ${mi(st.distKm)} away. Heights above mean lower low water (MLLW): a minus tide is below it.
      <a href="${tidePageUrl(st.id)}" target="_blank" rel="noopener">NOAA page ↗</a></p>`;
}

// A two-day curve from 3 hours ago, with now marked and each high and low labeled.
export function tideSvg(ev, now = Date.now()) {
  const t0 = now - 3 * 36e5, t1 = now + 45 * 36e5, W = 340, H = 120, pad = 14;
  const pts = [];
  for (let t = t0; t <= t1; t += 15 * 6e4) { const x = tideAt(ev, t); if (x) pts.push([t, x.v]); }
  if (pts.length < 10) return '';
  const vs = pts.map(p => p[1]), lo = Math.min(...vs, 0), hi = Math.max(...vs);
  const X = t => (t - t0) / (t1 - t0) * W, Y = v => pad + (hi - v) / (hi - lo || 1) * (H - 2 * pad);
  const path = pts.map(([t, v], i) => `${i ? 'L' : 'M'}${X(t).toFixed(1)},${Y(v).toFixed(1)}`).join('');
  const turns = ev.filter(e => e.t > t0 && e.t < t1);
  const midnights = [];
  for (let d = new Date(t0); d.setHours(24, 0, 0, 0) < t1;) midnights.push(+d);
  return `<svg class="oc-tide-svg" viewBox="0 0 ${W} ${H + 12}" role="img" aria-label="Tide curve for the next two days">
    <path d="${path}L${W},${H}L0,${H}Z" class="oc-fill"/><path d="${path}" class="oc-line"/>
    ${lo < 0 ? `<line x1="0" x2="${W}" y1="${Y(0)}" y2="${Y(0)}" class="oc-zero"/>` : ''}
    ${midnights.map(m => `<line x1="${X(m)}" x2="${X(m)}" y1="0" y2="${H}" class="oc-mid"/><text x="${X(m) + 3}" y="${H + 10}" class="oc-t">${esc(new Date(m).toLocaleDateString(undefined, { weekday: 'short' }))}</text>`).join('')}
    ${turns.map(e => `<text x="${Math.min(W - 30, Math.max(2, X(e.t) - 14))}" y="${e.type === 'H' ? Y(e.v) - 4 : Y(e.v) + 11}" class="oc-t">${e.v.toFixed(1)}′</text>`).join('')}
    <line x1="${X(now)}" x2="${X(now)}" y1="0" y2="${H}" class="oc-nowline"/><circle cx="${X(now)}" cy="${Y(tideAt(ev, now)?.v ?? 0)}" r="4" class="oc-dot"/>
  </svg>`;
}
