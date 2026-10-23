// Stocking tab: the state's plants for the water (CDFW, NDOW), plus your own stocking records.
import { db } from '../../db.js';
import { forLake, stockIdOf } from '../../states/index.js';
import { parseStockingCsv } from '../../data-sources.js';
import { $, esc, fmtDate, status } from '../../ui.js';
import { openLake } from '../lake.js';
import { renderStateReport } from '../state-report.js';
import { isNew, markPlantsSeen } from '../new-plants.js';

export async function renderStocking(lake, body) {
  if (lake.unsaved) {
    body.innerHTML = `<div id="state-stock"><div class="card muted">No state stocking found for this water.</div></div><p class="muted small">Save this water to keep your own stocking notes.</p>`;
    renderStateStocking(lake, $('#state-stock'));
    return;
  }
  const rows = (await db.byLake('stocking', lake.id)).sort((a, b) => b.date.localeCompare(a.date));
  const byYear = {};
  for (const r of rows) { const y = r.date.slice(0, 4); byYear[y] ??= {}; byYear[y][r.species] = (byYear[y][r.species] || 0) + (r.count || 0); }
  const years = Object.keys(byYear).sort();
  const yearTotals = years.map(y => [y, Object.values(byYear[y]).reduce((a, b) => a + b, 0)]);
  const maxTotal = Math.max(1, ...yearTotals.map(t => t[1]));
  body.innerHTML = `<div id="state-stock"></div><div class="card"><h3>${stockIdOf(lake) ? 'Your stocking notes' : 'Stocking history'}</h3>
      ${lake.stockingUrl ? `<p class="small"><a href="${esc(lake.stockingUrl)}" target="_blank" rel="noopener">Latest state stocking report ↗</a></p>` : '<p class="muted small">Add your state’s stocking report link under Edit.</p>'}
      ${years.length ? `<div class="bars">${yearTotals.map(([y, t]) => `<div class="barrow"><span class="lbl">${y}</span><div class="fill" style="width:${t / maxTotal * 70}%"></div><span>${t.toLocaleString()}</span></div>`).join('')}</div>` : '<p class="muted">No stocking records yet.</p>'}
    </div>
    <form class="card form" id="stock-form"><h3>Add a stocking event</h3>
      <div class="row"><label>Date <input name="date" type="date" required></label><label>Species <input name="species" list="species-list" required></label></div>
      <div class="row"><label>Number <input name="count" type="number"></label><label>Size <input name="size" placeholder="fingerling, 7 in…"></label></div>
      <button class="primary">Add</button>
      <label class="file-btn" style="margin-top:8px">Import CSV (date, species, number, size) <input type="file" accept=".csv" hidden id="stock-csv"></label>
    </form>
    ${rows.length ? `<div class="card"><table><tr><th>Date</th><th>Species</th><th>Number</th><th>Size</th><th></th></tr>
      ${rows.map(r => `<tr><td>${esc(r.date)}</td><td>${esc(r.species)}</td><td>${r.count?.toLocaleString() ?? ''}</td><td>${esc(r.size)}</td><td><a href="#" data-del="${r.id}">✕</a></td></tr>`).join('')}</table></div>` : ''}`;
  renderStateStocking(lake, $('#state-stock'));
  $('#stock-form').onsubmit = async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    await db.put('stocking', { lakeId: lake.id, ...f, count: f.count ? +f.count : null });
    openLake(lake.id, 'stocking');
  };
  $('#stock-csv').onchange = async e => {
    try {
      const recs = parseStockingCsv(await e.target.files[0].text());
      for (const r of recs) await db.put('stocking', { lakeId: lake.id, ...r });
      status(`Imported ${recs.length} stocking records`);
      openLake(lake.id, 'stocking');
    } catch (err) { alert(err.message); }
  };
  body.querySelectorAll('[data-del]').forEach(a => a.onclick = async e => { e.preventDefault(); await db.del('stocking', a.dataset.del); openLake(lake.id, 'stocking'); });
}

async function renderStateStocking(lake, el) {
  const S = forLake(lake);
  if (!S) return;
  const stockId = stockIdOf(lake);
  if (!stockId) {
    const near = await S.nearestWaters(lake.lat, lake.lon);
    if (!near.length || !el.isConnected) return;
    el.innerHTML = `<div class="card"><h3>Link to ${S.agency} stocking</h3><p class="small">Pick the matching water to get ${S.name}'s stocking reports automatically.</p>
      ${near.slice(0, 5).map(w => `<div class="lake-item" style="margin:6px 0"><span>${esc(w.name)} <span class="muted small">${w.distKm.toFixed(1)} km</span></span><button data-link="${w.id}">Link</button></div>`).join('')}</div>`;
    el.querySelectorAll('[data-link]').forEach(b => b.onclick = async () => {
      const id = near.find(w => String(w.id) === b.dataset.link).id;
      const linked = { ...lake, state: lake.state || S.code, [S.stockField]: id, stockingUrl: lake.stockingUrl || S.waterUrl(id) };
      if (lake.unsaved) return openLake(linked, 'stocking');
      await db.put('lakes', linked);
      openLake(lake.id, 'stocking');
    });
    return;
  }
  const plants = await S.plantsFor(stockId);
  if (!el.isConnected) return;
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = plants.filter(p => p.weekEnd >= today);
  const past = plants.filter(p => p.weekEnd < today);
  const perYear = Object.entries(past.reduce((m, p) => { const y = p.week.slice(0, 4); m[y] = (m[y] || 0) + 1; return m; }, {})).sort();
  const maxN = Math.max(1, ...perYear.map(r => r[1]));
  // NDOW reports the day, count and size of each stocking; CDFW only the week and species.
  const when = p => p.week === p.weekEnd ? fmtDate(p.week + 'T12:00') : `week of ${fmtDate(p.week + 'T12:00')}`;
  const what = p => `${p.count ? `${p.count.toLocaleString()} ` : ''}${esc(p.species)}${p.inches ? ` (${p.inches}″)` : ''}`;
  const tag = p => isNew(lake, p) && !lake.unsaved ? ' <span class="badge">new</span>' : '';
  const fishPerYear = past.reduce((m, p) => { const y = p.week.slice(0, 4); m[y] = (m[y] || 0) + (p.count || 0); return m; }, {});
  // A calendar feed only where the state publishes one (California's nightly ICS job).
  const feed = S.plantCalendarUrl?.(stockId);
  el.innerHTML = `<div class="card"><h3>${S.agency} plants</h3>
    ${upcoming.length ? `<p>🟢 <b>${upcoming.map(p => `${what(p)} planned ${when(p)}${tag(p)}`).join('<br>')}</b></p>` : ''}
    ${past.length ? `<p class="small">Last plant: ${when(past[0])} (${what(past[0])})${tag(past[0])}</p>` : '<p class="muted small">No plants in the schedule window yet.</p>'}
    ${feed ? `<p class="small">📅 Subscribe to plants: <a href="${esc(feed.replace(/^https?:/, 'webcal:'))}">iPhone / Mac calendar</a> · <a href="https://calendar.google.com/calendar/r?cid=${encodeURIComponent(feed.replace(/^https?:/, 'webcal:'))}" target="_blank" rel="noopener">Google Calendar</a> · <a href="${esc(feed)}" download>.ics file</a>
      <br><span class="muted">Your calendar app checks this water's public plant feed on this app's site; no account, and no list of who subscribed.</span></p>` : ''}
    ${perYear.length ? `<div class="bars">${perYear.map(([y, n]) => `<div class="barrow"><span class="lbl">${y}</span><div class="fill" style="width:${n / maxN * 70}%"></div><span>${n} plant${n > 1 ? 's' : ''}${fishPerYear[y] ? ` · ${fishPerYear[y].toLocaleString()} fish` : ''}</span></div>`).join('')}</div>` : ''}
    ${past.length ? `<details><summary class="small">All ${past.length} plants</summary><table>${past.map(p => `<tr><td>${fmtDate(p.week + 'T12:00')}</td><td>${what(p)}</td></tr>`).join('')}</table></details>` : ''}
    <p class="muted small">${S.plantsNote} <a href="${esc(S.waterUrl(stockId))}" target="_blank" rel="noopener">${S.agency} page ↗</a></p></div><div id="state-report"></div>`;
  markPlantsSeen(lake, plants);
  renderStateReport(lake, el.querySelector('#state-report'));
}
