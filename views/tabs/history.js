// History tab: stocking by year (agency reports, archived schedules and the current schedule), recorded
// introductions at this water, and the statewide stocking timeline.
import { forLake } from '../../states/index.js';
import { stockHistoryFor, summarize } from '../../stock-history.js';
import { esc } from '../../ui.js';

const fmt = n => Math.round(n).toLocaleString();

export async function renderHistory(lake, body) {
  body.innerHTML = '<div class="card muted">Loading history…</div>';
  const S = forLake(lake);
  if (!S) { body.innerHTML = '<div class="card muted">Stocking history is only available for California, Nevada and Oregon waters.</div>'; return; }
  const [hist, stock] = await Promise.all([S.historyFor(lake), stockHistoryFor(lake)]);
  if (!body.isConnected) return;
  const item = e => `<div class="hist"><b>${esc(e.year)}</b><div>${esc(e.text)}${e.source ? ` <span class="muted small">(${esc(e.source)})</span>` : ''}</div></div>`;
  body.innerHTML = `
    ${stock ? stockCard(lake, S, stock) : `<div class="card"><h3>Stocking by year</h3><p class="muted small">No ${esc(S.agency)} stocking records found for this water in the reports and archived schedules.</p></div>`}
    <div class="card"><h3>Recorded at ${esc(lake.name)}</h3>${hist.local.length ? hist.local.map(item).join('') : '<p class="muted small">No historical introduction records for this water.</p>'}</div>
    <details class="card"><summary><b>How ${S.name}'s waters were stocked${hist.statewide[0] ? `, ${esc(hist.statewide[0].year)} on` : ''}</b></summary>${hist.statewide.map(item).join('') || '<p class="muted">History not loaded yet.</p>'}</details>
    <p class="muted small">${esc(hist.note)}</p>`;
}

function stockCard(lake, S, stock) {
  const s = summarize(stock);
  const word = s.unit === 'fish' ? 'fish' : 'plants';
  const max = Math.max(1, ...stock.years.map(y => s.val(y) ?? 0));
  // Every year from the first record to now, so gaps show; a gap means no record, not that nothing was stocked.
  const rows = [];
  for (let y = Math.max(s.last, new Date().getFullYear()); y >= s.first; y--) rows.push(stock.years.find(r => r.y === y) ?? { y, none: true });
  const trend = s.vsAvg == null ? '' : ` ${s.latest.y} was ${Math.abs(s.vsAvg) < 5 ? 'about average' : `${Math.abs(s.vsAvg)}% ${s.vsAvg > 0 ? 'above' : 'below'} average`}.`;
  const avgText = s.unit === 'fish'
    ? `${s.counted < s.recorded ? `In the ${s.counted} year${s.counted === 1 ? '' : 's'} with counts, about` : 'About'} ${fmt(s.avg)} fish a year.`
    : `About ${fmt(s.avg)} plant${Math.round(s.avg) === 1 ? '' : 's'} a year.`;
  const year = y => {
    if (y.none) return `<div class="barrow stock-none"><span class="lbl">${y.y}</span><span class="muted small">no record</span></div>`;
    const v = s.val(y);
    const sp = Object.entries(y.sp).sort((a, b) => (b[1][0] ?? 0) - (a[1][0] ?? 0) || b[1][1] - a[1][1]);
    const spText = sp.map(([name, [f, n]]) => `${esc(name)} ${f != null ? fmt(f) : `(${n} plant${n > 1 ? 's' : ''})`}`).join(' · ');
    // A year with plants but no count (California trout) gets a thin bar so it doesn't read as empty.
    const label = v != null ? `${fmt(v)} ${word}` : y.plants ? `${y.plants} plant${y.plants === 1 ? '' : 's'}` : 'stocked';
    const width = v != null ? v / max * 62 : 3;
    return `<details class="stock-year"><summary class="barrow"><span class="lbl">${y.y}</span><div class="fill${v == null ? ' uncounted' : ''}" style="width:${width}%"></div><span>${label}</span></summary>
      <div class="small">${spText || 'Species not listed'}</div>
      <div class="small muted">Source: ${y.src.map(src => `<a href="${esc(src.url)}" target="_blank" rel="noopener">${esc(src.label)} ↗</a>`).join(' · ')}</div></details>`;
  };
  return `<div class="card"><h3>Stocking by year</h3>
    <p class="small">${s.recorded} year${s.recorded === 1 ? '' : 's'} with ${esc(S.agency)} stocking on record, ${s.first}–${s.last}. ${avgText}${trend}</p>
    ${stock.names.some(n => n.toLowerCase() !== String(lake.name).toLowerCase()) ? `<p class="muted small">Listed as ${stock.names.map(esc).join(', ')}.</p>` : ''}
    <div class="bars">${rows.map(year).join('')}</div>
    <p class="muted small">${esc(stock.note)} Tap a year for species and sources.</p></div>`;
}
