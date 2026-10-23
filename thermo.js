// Water temperature log for a lake: surface temperature by date from your Deeper scans and catches, and
// temperature-by-depth profiles you take with a drop thermometer, with the thermocline marked.
import { db } from './db.js';
import { $, esc, fmtDate, status, showView } from './ui.js';
import { map, depthLayer, canvas } from './map.js';

// Thermocline: the run of the profile where temperature drops at least 1 °C per meter (about 0.55 °F per ft),
// around its steepest drop.
export function thermocline(readings) {
  const r = readings.slice().sort((a, b) => a[0] - b[0]);
  const rate = i => (r[i][1] - r[i + 1][1]) / Math.max(0.1, r[i + 1][0] - r[i][0]);
  let best = -1;
  for (let i = 0; i < r.length - 1; i++) if (rate(i) >= 0.55 && (best < 0 || rate(i) > rate(best))) best = i;
  if (best < 0) return null;
  let a = best, b = best;
  while (a > 0 && rate(a - 1) >= 0.55) a--;
  while (b < r.length - 2 && rate(b + 1) >= 0.55) b++;
  return { top: r[a][0], bottom: r[b + 1][0], rate: rate(best) };
}

// "10 66", "10, 66" or "10: 66" per line (or separated by ;) → [[depthFt, tempF]].
export function parseProfile(text, { meters = false, celsius = false } = {}) {
  return text.split(/[\n;]+/).map(l => l.trim().split(/[\s,:=]+/).map(Number)).filter(p => p.length >= 2 && p.every(Number.isFinite))
    .map(([d, t]) => [+(meters ? d * 3.28084 : d).toFixed(1), +(celsius ? t * 9 / 5 + 32 : t).toFixed(1)]).sort((a, b) => a[0] - b[0]);
}

const day = d => fmtDate(`${d}T12:00`); // a date without a time, shown as that calendar day
const tempColor = (t, lo, hi) => `hsl(${Math.round(230 - 230 * Math.min(1, Math.max(0, (t - lo) / ((hi - lo) || 1))))},80%,50%)`;

function surfaceChart(days, catches) {
  const all = [...days.flatMap(d => [d.min, d.max]), ...catches.map(c => c.waterTemp)];
  const times = [...days.map(d => Date.parse(`${d.date}T12:00`)), ...catches.map(c => Date.parse(c.time))];
  if (times.length < 2) return '';
  const W = 340, H = 150, P = 28;
  const t0 = Math.min(...times), t1 = Math.max(...times), lo = Math.floor(Math.min(...all) - 1), hi = Math.ceil(Math.max(...all) + 1);
  const x = t => P + (W - P - 8) * (t - t0) / ((t1 - t0) || 1), y = v => 8 + (H - P - 8) * (hi - v) / ((hi - lo) || 1);
  const ticks = [lo, Math.round((lo + hi) / 2), hi];
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Surface temperature by date">
    ${ticks.map(v => `<line x1="${P}" x2="${W - 8}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${P - 4}" y="${y(v) + 4}" text-anchor="end">${v}°</text>`).join('')}
    ${days.map(d => `<line x1="${x(Date.parse(`${d.date}T12:00`))}" x2="${x(Date.parse(`${d.date}T12:00`))}" y1="${y(d.max)}" y2="${y(d.min)}" class="range"/><circle cx="${x(Date.parse(`${d.date}T12:00`))}" cy="${y(d.avg)}" r="4" class="scan"><title>${day(d.date)}: ${d.avg.toFixed(1)}°F (${d.min}–${d.max})</title></circle>`).join('')}
    ${catches.map(c => `<circle cx="${x(Date.parse(c.time))}" cy="${y(c.waterTemp)}" r="3" class="catchdot"><title>${esc(c.species)} ${fmtDate(c.time)}: ${c.waterTemp}°F</title></circle>`).join('')}
    <text x="${P}" y="${H - 6}">${fmtDate(new Date(t0).toISOString())}</text><text x="${W - 8}" y="${H - 6}" text-anchor="end">${fmtDate(new Date(t1).toISOString())}</text></svg>`;
}

function profileChart(profiles) {
  if (!profiles.length) return '';
  const W = 340, H = 220, P = 30;
  const temps = profiles.flatMap(p => p.readings.map(r => r[1])), depths = profiles.flatMap(p => p.readings.map(r => r[0]));
  const lo = Math.floor(Math.min(...temps) - 1), hi = Math.ceil(Math.max(...temps) + 1), dMax = Math.ceil(Math.max(...depths, 5) / 5) * 5;
  const x = t => P + (W - P - 10) * (t - lo) / ((hi - lo) || 1), y = d => 10 + (H - P - 10) * d / dMax;
  const latest = profiles[0], tc = thermocline(latest.readings);
  const dTicks = [0, dMax / 2, dMax].map(Math.round), tTicks = [lo, Math.round((lo + hi) / 2), hi];
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Temperature by depth">
    ${tc ? `<rect x="${P}" width="${W - P - 10}" y="${y(tc.top)}" height="${Math.max(2, y(tc.bottom) - y(tc.top))}" class="thermo"/>` : ''}
    ${dTicks.map(d => `<line x1="${P}" x2="${W - 10}" y1="${y(d)}" y2="${y(d)}" class="grid"/><text x="${P - 4}" y="${y(d) + 4}" text-anchor="end">${d}′</text>`).join('')}
    ${tTicks.map(t => `<text x="${x(t)}" y="${H - 8}" text-anchor="middle">${t}°</text>`).join('')}
    ${profiles.slice().reverse().map(p => `<polyline points="${p.readings.map(([d, t]) => `${x(t)},${y(d)}`).join(' ')}" class="${p === latest ? 'latest' : 'older'}"><title>${day(p.date)}</title></polyline>`).join('')}
    ${latest.readings.map(([d, t]) => `<circle cx="${x(t)}" cy="${y(d)}" r="3" class="scan"><title>${d} ft: ${t}°F</title></circle>`).join('')}</svg>`;
}

// Surface temperature readings of one scan, colored on the map: warm inflows and coves stand out.
export async function showTempMap(setId) {
  const set = await db.get('depthSets', setId);
  depthLayer.clearLayers();
  const ts = set.temps.map(t => t[2]), lo = Math.min(...ts), hi = Math.max(...ts);
  for (const [lat, lon, t] of set.temps) L.circleMarker([lat, lon], { renderer: canvas, radius: 4, stroke: false, fillColor: tempColor(t, lo, hi), fillOpacity: 0.9 }).bindTooltip(`${t}°F`).addTo(depthLayer);
  const legend = $('#depth-legend');
  legend.innerHTML = `<b>${esc(set.name)}: surface temp</b><div class="bar" style="background:linear-gradient(90deg,${[0, .25, .5, .75, 1].map(f => tempColor(lo + f * (hi - lo), lo, hi)).join(',')})"></div>${lo}°F <span style="float:right">${hi}°F</span><br><a href="#" id="hide-depth">Hide</a>`;
  legend.classList.remove('hidden');
  $('#hide-depth').onclick = e => { e.preventDefault(); depthLayer.clearLayers(); legend.classList.add('hidden'); };
  if (!map.hasLayer(depthLayer)) depthLayer.addTo(map);
  showView('map');
  map.fitBounds(L.latLngBounds(set.temps.map(t => [t[0], t[1]])));
}

export async function renderTempCard(lake, el, redraw) {
  const [sets, profiles, catches] = await Promise.all([db.byLake('depthSets', lake.id), db.byLake('tempProfiles', lake.id), db.byLake('catches', lake.id)]);
  profiles.sort((a, b) => b.date.localeCompare(a.date));
  const scans = sets.filter(s => s.temps?.length).map(s => {
    const ts = s.temps.map(t => t[2]);
    return { id: s.id, name: s.name, date: s.scanDate ?? s.createdAt.slice(0, 10), min: Math.min(...ts), max: Math.max(...ts), avg: ts.reduce((a, b) => a + b, 0) / ts.length };
  }).sort((a, b) => b.date.localeCompare(a.date));
  const catchTemps = catches.filter(c => c.waterTemp != null && c.time);
  const tc = profiles[0] && thermocline(profiles[0].readings);
  el.innerHTML = `<div class="card"><h3>Water temperature</h3>
    ${scans.length || catchTemps.length ? `<h4 class="sub">Surface</h4>${surfaceChart(scans, catchTemps)}
      ${scans.map(s => `<div class="lake-item small" style="margin:4px 0"><span>${day(s.date)} · <b>${s.avg.toFixed(1)}°F</b> <span class="muted">(${s.min}–${s.max}) ${esc(s.name)}</span></span><button data-tmap="${s.id}">Map</button></div>`).join('')}
      <p class="muted small">${scans.length ? 'Blue dots: your scans (bar = coolest to warmest reading). ' : ''}${catchTemps.length ? 'Orange: water temp logged with catches. ' : ''}A Deeper measures the temperature where it floats, so scans give surface temperature.</p>`
    : '<p class="muted small">Import a Deeper scan that has a temperature column, or log water temp with your catches, to build a surface temperature log here.</p>'}
    <h4 class="sub">By depth</h4>
    ${profiles.length ? `${profileChart(profiles)}<p class="small">${tc ? `<b>Thermocline about ${tc.top}–${tc.bottom} ft</b> on ${day(profiles[0].date)} (the shaded band). Fish often hold just above it in summer.` : `No thermocline in the ${day(profiles[0].date)} profile: the water is mixed top to bottom.`}</p>
      ${profiles.map(p => `<div class="lake-item small" style="margin:4px 0"><span>${p === profiles[0] ? '<b>' : ''}${day(p.date)}${p === profiles[0] ? '</b>' : ''} · ${p.readings.length} readings, ${p.readings[0][1]}°F at ${p.readings[0][0]} ft to ${p.readings.at(-1)[1]}°F at ${p.readings.at(-1)[0]} ft${p.note ? ` · ${esc(p.note)}` : ''}</span><button class="danger" data-pdel="${p.id}">✕</button></div>`).join('')}`
    : '<p class="muted small">Lower a thermometer and note the temperature every few feet to find the thermocline, where summer fish hold.</p>'}
    <details><summary class="small">＋ Add a temperature profile</summary><form class="form" id="profile-form" style="margin-top:8px">
      <div class="row"><label>Date <input type="date" name="date" required value="${new Date().toLocaleDateString('en-CA')}"></label>
        <label>Units <select name="units"><option value="ft-f">ft, °F</option><option value="m-c">m, °C</option><option value="ft-c">ft, °C</option></select></label></div>
      <label>Depth and temperature, one pair per line <textarea name="readings" rows="5" required placeholder="0 72\n5 71\n10 69\n15 62\n20 55\n30 51"></textarea></label>
      <label>Note <input name="note" placeholder="Main basin by the dam"></label>
      <button class="primary">Save profile</button></form></details></div>`;
  el.querySelectorAll('[data-tmap]').forEach(b => b.onclick = () => showTempMap(b.dataset.tmap));
  el.querySelectorAll('[data-pdel]').forEach(b => b.onclick = async () => { if (confirm('Delete this profile?')) { await db.del('tempProfiles', b.dataset.pdel); redraw(); } });
  $('#profile-form', el).onsubmit = async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const readings = parseProfile(f.readings, { meters: f.units.startsWith('m'), celsius: f.units.endsWith('c') });
    if (readings.length < 2) return alert('Enter at least two depth and temperature pairs, like "10 66".');
    await db.put('tempProfiles', { lakeId: lake.id, date: f.date, readings, note: f.note.trim(), createdAt: new Date().toISOString() });
    status('Profile saved');
    redraw();
  };
}
