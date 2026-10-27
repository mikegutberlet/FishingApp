// Game plan tab: what to throw and where today, spots for today, the ice estimate on high lakes, and the water's
// year by month. See game-plan.js, spot-book.js and know-water.js.
import { db } from '../../db.js';
import { esc, fmtDate } from '../../ui.js';
import { fmtDepth } from '../../units.js';
import { forecastAge } from '../../forecast.js';
import { gamePlan } from '../../game-plan.js';
import { renderSpotsCard } from '../../spot-book.js';
import { monthProfile, iceEstimate, ICE_STATES, iceLogsFor, allIceLogs, logIce, MONTHS, thisMonth } from '../../know-water.js';

const hourText = h => { const d = new Date(); d.setHours(+h, 0); return d.toLocaleTimeString(undefined, { hour: 'numeric' }).replace(/\s?([AP])M/i, (_, a) => a.toLowerCase()); };

export async function renderKnow(lake, body) {
  body.innerHTML = `<div id="kw-plan" class="card"><h3>🎯 Game plan</h3><p class="muted small">Working it out…</p></div>
    ${lake.unsaved ? '' : '<div id="kw-spots"></div>'}<div id="kw-ice"></div><div id="kw-year"></div>`;
  const redraw = () => body.isConnected && renderKnow(lake, body);
  const plan = await gamePlan(lake).catch(e => ({ error: e }));
  if (!body.isConnected) return;
  const planEl = body.querySelector('#kw-plan');
  if (plan.error) planEl.innerHTML = `<h3>🎯 Game plan</h3><p class="small">Couldn't work out a plan: ${esc(plan.error.message)}</p>`;
  else planEl.innerHTML = planHtml(plan);
  if (!lake.unsaved) renderSpotsCard(lake, body.querySelector('#kw-spots')).catch(() => {});
  renderIce(lake, body.querySelector('#kw-ice'), redraw);
  renderYear(lake, body.querySelector('#kw-year'), plan.ice ?? null);
}

function planHtml(p) {
  const t = p.temp, c = p.clarity;
  const facts = [t ? `Water <b>${t.measured ? '' : '≈'}${t.f}°F</b> <span class="muted">(${esc(t.from)})</span>` : 'Water temperature unknown (no signal and nothing logged)',
    `Clarity <b>${esc(c.clarity ?? 'unknown')}</b>${c.clarity ? ` <span class="muted">(${esc(c.from)})</span>` : ''}`];
  const iced = p.ice && (p.ice.state === 'iced' || p.ice.state === 'going');
  const y = p.yours, list = xs => xs.map(x => `${esc(x.k)} <span class="muted">(${x.n})</span>`).join(', ');
  return `<h3>🎯 Game plan</h3><p class="small">${facts.join(' · ')}</p>
    ${iced ? `<div class="kw-warn small">🧊 ${esc(p.ice.text)}. Fish open water at inlets and edges only, and stay off the ice: spring ice is rotten.</div>` : ''}
    ${y ? `<div class="kw-yours"><b>What worked for you on days like this</b> <span class="muted small">(${y.n} fish on ${y.days} similar day${y.days > 1 ? 's' : ''}${y.here ? ' here' : ', all your waters'})</span>
      <div class="small">${[y.lures.length && `Lures: ${list(y.lures)}`, y.depths.length && `Depth: ${y.depths.map(d => `${esc(d.k)} ft <span class="muted">(${d.n})</span>`).join(', ')}`,
        y.hours.length && `Hours: ${y.hours.map(h => `${hourText(h.k)} <span class="muted">(${h.n})</span>`).join(', ')}`, y.species.length && `Species: ${list(y.species)}`].filter(Boolean).join('<br>')}</div></div>` : ''}
    ${p.picks.length ? p.picks.map(k => `<div class="kw-pick"><div class="kw-pick-head"><b>${esc(k.label)}</b><span class="chip">${esc(k.bandText)}</span></div>
      <div class="small"><b>Where:</b> ${esc(k.where)}</div><div class="small"><b>How:</b> ${esc(k.how)}</div>
      <div class="small"><b>Colors:</b> ${esc(k.colors)}</div>${k.light ? `<div class="small muted">${esc(k.light)}</div>` : ''}</div>`).join('')
      : '<p class="small">No species known for this water yet. Add them on Edit (Species present) or log a catch, and the plan fills in.</p>'}
    <p class="muted small">${y ? 'Your own fish lead; the guide below them is' : 'The guide is'} a rule of thumb for each species at this water temperature and clarity. Water temperature is an estimate unless you logged one in the last 5 days.</p>`;
}

async function renderIce(lake, el, redraw) {
  const [logs, all, lakes] = await Promise.all([lake.unsaved ? [] : iceLogsFor(lake.id), allIceLogs(), db.all('lakes')]);
  const ice = iceEstimate(lake, { logs, allLogs: all, lakes });
  if (!ice) { el.innerHTML = ''; return; }
  logs.sort((a, b) => b.date.localeCompare(a.date));
  el.innerHTML = `<div class="card"><h3>🧊 Ice</h3><p><b>${esc(ice.text)}</b></p>
    <p class="muted small">${esc(ice.basis)} (${Math.round(+lake.elevationFt).toLocaleString()} ft${Math.abs(ice.e - lake.elevationFt) > 200 ? `, counts like ${Math.round(ice.e / 100) * 100} ft at this latitude` : ''}). Snowy winters run late, dry ones early.</p>
    ${ice.state === 'never' ? '' : lake.unsaved ? '<p class="muted small">Save this water to note the ice when you see it; your notes sharpen the estimate for all your high waters.</p>'
      : `<div class="row kw-ice-acts">${Object.entries(ICE_STATES).map(([k, [i, label]]) => `<button data-ice="${k}">${i} ${label} today</button>`).join('')}</div>
      ${logs.length ? `<details class="small"><summary>Your ice notes (${logs.length})</summary>${logs.slice(0, 20).map(l => `<div class="lake-item">${fmtDate(l.date)} · ${ICE_STATES[l.state]?.[0] ?? ''} ${esc(ICE_STATES[l.state]?.[1] ?? l.state)}<button class="danger" data-icedel="${esc(l.id)}">✕</button></div>`).join('')}</details>` : ''}`}</div>`;
  el.querySelectorAll('[data-ice]').forEach(b => b.onclick = async () => { await logIce(lake.id, b.dataset.ice); redraw(); });
  el.querySelectorAll('[data-icedel]').forEach(b => b.onclick = async () => { await db.del('iceLogs', b.dataset.icedel); redraw(); });
}

async function renderYear(lake, el, ice) {
  const [profiles, catches] = lake.unsaved ? [[], []] : await Promise.all([db.byLake('tempProfiles', lake.id), db.byLake('catches', lake.id)]);
  const p = monthProfile(lake, { profiles, catches, ice });
  const now = thisMonth();
  const cell = (main, mine) => `${main ? esc(main) : '<span class="muted">–</span>'}${mine ? `<div class="kw-mine">You: ${esc(mine)}</div>` : ''}`;
  el.innerHTML = `<div class="card"><h3>📅 This water by month</h3>
    ${p.studied ? `<p class="small">From the <a href="${esc(p.studied.source)}" target="_blank" rel="noopener">${esc(p.studied.by)} ↗</a>: ${esc(p.studied.note)}</p>` : ''}
    <div class="kw-year-wrap"><table class="kw-year small"><thead><tr><th>Month</th><th>Water</th><th>Thermocline</th><th>Oxygen and clarity</th></tr></thead><tbody>
    ${p.rows.map(r => `<tr class="${r.m === now ? 'kw-now' : ''}"><th>${MONTHS[r.m]}${r.yours.fish ? `<div class="kw-mine">${r.yours.fish} 🐟</div>` : ''}</th>
      <td>${cell(r.strat, r.yours.surface)}</td><td>${cell(r.thermo, r.yours.thermo)}</td>
      <td>${cell([r.oxygen, r.clarity].filter(Boolean).join('. '), [r.yours.clarity, r.yours.depth && `fish at ${r.yours.depth}`].filter(Boolean).join(', '))}</td></tr>`).join('')}
    </tbody></table></div>
    <p class="muted small">${p.studied ? 'Months the report covers are its figures; the rest are' : 'These are'} rules of thumb from the water's size${+lake.maxDepth ? `, ${fmtDepth(+lake.maxDepth)} depth` : ''}, elevation and ${p.productive ? 'likely algae growth (low, warm or murky water runs short of oxygen deep in summer)' : 'clarity'}.
      "You" rows are your temperature profiles (Depth tab), water temps, clarity and depths logged with catches, across all years.</p></div>`;
}
