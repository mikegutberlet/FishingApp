// What a state agency writes about a water, for states that publish it (Nevada: NDOW's fishing report and
// write-up on each water's page). States without it (reportFor not exported) show nothing.
import { forLake } from '../states/index.js';
import { esc, fmtDate } from '../ui.js';

const paras = t => t.split('\n').map(p => `<p class="small">${esc(p)}</p>`).join('');

// Latest fishing report, on the Stocking tab.
export async function renderStateReport(lake, el) {
  const S = forLake(lake);
  const w = await S?.reportFor?.(lake);
  if (!w?.report || !el?.isConnected) return;
  const days = w.reportDate ? Math.round((Date.now() - Date.parse(w.reportDate + 'T12:00')) / 864e5) : null;
  el.innerHTML = `<div class="card"><h3>${S.agency} fishing report</h3>
    ${w.reportDate ? `<p class="muted small">${fmtDate(w.reportDate + 'T12:00')}${days > 60 ? ` · ${Math.round(days / 30)} months old` : ''}</p>` : ''}${paras(w.report)}
    <p class="muted small">From <a href="${esc(w.url)}" target="_blank" rel="noopener">${esc(w.name)} on ${S.agency.toLowerCase()}.org ↗</a>, refreshed nightly.</p></div>`;
}

// NDOW's write-up (size, species, tactics, facilities), history and angler guides, on the Info tab.
export async function renderStateInfo(lake, el) {
  const S = forLake(lake);
  const w = await S?.reportFor?.(lake);
  if (!w || !(w.info || w.history || w.guides?.length) || !el?.isConnected) return;
  el.innerHTML = `<div class="card"><h3>About ${esc(w.name)} (${S.agency})</h3>${w.info ? paras(w.info) : ''}
    ${w.history ? `<details><summary class="small">History</summary>${paras(w.history)}</details>` : ''}
    ${w.guides?.length ? `<p class="small">${w.guides.map(g => `<a href="${esc(g.url)}" target="_blank" rel="noopener">${esc(g.label || 'Angler guide')} ↗</a>`).join('<br>')}</p>` : ''}
    <p class="muted small"><a href="${esc(w.url)}" target="_blank" rel="noopener">${S.agency} page ↗</a></p></div>`;
}
