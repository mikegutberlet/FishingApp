// The latest line a state agency wrote about a water (NDOW's fishing report, ODFW's Recreation Report), for the
// planner and the Today cards. California's CDFW publishes no per-water report, so its waters get none.
import { forLake } from './states/index.js';
import { esc, fmtDate } from './ui.js';

// First sentence or so, cut at a word.
const firstLine = (text, max = 150) => {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  const s = t.match(/^.{20,}?[.!?](?=\s|$)/)?.[0] ?? t;
  return s.length <= max ? s : `${s.slice(0, max).replace(/\s+\S*$/, '')}…`;
};

export async function reportLine(lake) {
  const S = forLake(lake);
  if (!S?.reportFor || S.code === 'CA') return null;
  const w = await S.reportFor(lake).catch(() => null);
  if (!w?.report) return null;
  const days = w.reportDate ? Math.round((Date.now() - Date.parse(w.reportDate + 'T12:00')) / 864e5) : null;
  return { agency: S.agency, text: firstLine(w.report), date: w.reportDate ?? null, days, url: w.url };
}

export const reportLineHtml = r => r ? `<div class="report-line small${r.days > 60 ? ' old' : ''}"><b>${esc(r.agency)}${r.date ? ` ${esc(r.days > 300 ? fmtDate(r.date) : fmtDate(r.date).replace(/, \d{4}$/, ''))}` : ''}:</b> ${esc(r.text)}${r.days > 60 ? ` <span class="muted">(${Math.round(r.days / 30)} months old)</span>` : ''}</div>` : '';

// Fills every [data-report-for] slot inside root, one water at a time from the given list.
export function fillReportLines(root, lakes) {
  for (const slot of root.querySelectorAll('[data-report-for]')) {
    const lake = lakes.find(l => l.id === slot.dataset.reportFor);
    if (lake) reportLine(lake).then(r => { if (slot.isConnected) slot.innerHTML = reportLineHtml(r); });
  }
}
