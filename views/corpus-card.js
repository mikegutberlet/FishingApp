// Info tab card "In the archive": what the repo's corpus holds for this water (docs/corpus/README.md), the hand
// notes kept in it, and links to its catalogue entry and JSON file.
import { esc, fmtDate } from '../ui.js';
import { corpusFor, corpusUrl, catalogueUrl } from '../corpus.js';
import { fmtMi } from '../access-rules.js';

export async function renderArchiveCard(lake, el) {
  const url = corpusUrl(lake);
  if (!url) return;
  const f = await corpusFor(lake);
  if (!el.isConnected) return;
  if (!f) { el.innerHTML = `<div class="card"><h3>In the archive</h3><p class="muted small">Not in the app’s archive yet: the nightly job hasn’t reached this water, or you’re offline.</p></div>`; return; }
  const a = f.access?.summary, rows = [];
  if (a?.verdict) rows.push(`<b>Getting there:</b> ${esc(a.verdict)}${a.road ? ` via ${esc(a.road)}` : ''}${a.hikeMi ? `, then ${esc(a.hikeMi)} on foot` : ''}${a.land?.length ? ` · ${esc(a.land.join(', '))} land` : ''} <span class="muted">(${fmtDate(f.access.fetchedAt)})</span>`);
  if (f.camping) rows.push(`<b>Camping:</b> ${f.camping.sites.length} campground${f.camping.sites.length === 1 ? '' : 's'} within ${fmtMi(f.camping.searchKm)} <span class="muted">(${fmtDate(f.camping.fetchedAt)})</span>`);
  const ys = (f.stocking?.history?.years ?? []).map(y => y.y);
  if (ys.length) rows.push(`<b>Stocking records:</b> ${Math.min(...ys)}–${Math.max(...ys)}, ${ys.length} years`);
  if (f.introductions?.length) rows.push(`<b>Introductions on record:</b> ${f.introductions.length}`);
  if (f.rules?.special?.length) rows.push(`<b>Rules that name it:</b> ${f.rules.special.length}`);
  const manual = Object.entries(f.manual ?? {});
  el.innerHTML = `<div class="card"><h3>In the archive</h3>
    <p class="small">${rows.join('<br>') || 'Facts, stocking and rules only so far.'}</p>
    ${f.notes?.length ? `<div class="small"><b>Notes kept with the water</b>${f.notes.map(n => `<p class="small">📝 ${esc(n.text)} <span class="muted">${esc(n.date ?? '')}${n.by ? `, ${esc(n.by)}` : ''}</span></p>`).join('')}</div>` : ''}
    ${manual.length ? `<p class="small muted">Hand-set facts: ${manual.map(([k, v]) => `${esc(k)} = ${esc(String(v))}`).join(', ')}</p>` : ''}
    <p class="muted small">${f.sources?.length ?? 0} sources · first seen ${esc(f.firstSeen ?? '')} · last checked ${fmtDate(f.checkedAt)}${f.changes?.[0] ? ` · last change: ${esc(f.changes[0].text)} (${esc(f.changes[0].date)})` : ''}<br>
    <a href="${esc(catalogueUrl(f))}" target="_blank" rel="noopener">Catalogue entry ↗</a> · <a href="${esc(url)}" target="_blank" rel="noopener">JSON ↗</a> · <a href="https://github.com/mikegutberlet/FishingApp/blob/main/docs/corpus/README.md" target="_blank" rel="noopener">About the archive ↗</a></p></div>`;
}
