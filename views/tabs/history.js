// History tab: recorded introductions at this water and the statewide stocking timeline.
import * as CA from '../../states/ca.js';
import { esc } from '../../ui.js';

export async function renderHistory(lake, body) {
  body.innerHTML = '<div class="card muted">Loading history…</div>';
  const [hist, plants] = await Promise.all([CA.historyFor(lake), lake.cdfwStockId ? CA.plantsFor(lake.cdfwStockId) : []]);
  if (!body.isConnected) return;
  const perYear = Object.entries(plants.reduce((m, p) => { const y = p.week.slice(0, 4); m[y] = (m[y] || 0) + 1; return m; }, {})).sort().reverse();
  const item = e => `<div class="hist"><b>${esc(e.year)}</b><div>${esc(e.text)}${e.source ? ` <span class="muted small">(${esc(e.source)})</span>` : ''}</div></div>`;
  body.innerHTML = `
    <div class="card"><h3>Recorded at ${esc(lake.name)}</h3>${hist.local.length ? hist.local.map(item).join('') : '<p class="muted small">No historical introduction records for this water.</p>'}</div>
    ${perYear.length ? `<div class="card"><h3>CDFW plants by year</h3>${perYear.map(([y, n]) => `<div class="hist"><b>${y}</b><div>${n} plant${n > 1 ? 's' : ''}</div></div>`).join('')}</div>` : ''}
    <details class="card"><summary><b>How California's waters were stocked, 1870 on</b></summary>${hist.statewide.map(item).join('') || '<p class="muted">History not loaded yet.</p>'}</details>
    <p class="muted small">${esc(hist.note)}</p>`;
}
