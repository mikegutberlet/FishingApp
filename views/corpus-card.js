// Info tab card "In the archive": what your private archive holds for this water (docs/corpus/README.md), the hand
// notes and book excerpts kept in it.
import { esc, fmtDate } from '../ui.js';
import { corpusFor, corpusKey } from '../corpus.js';
import { fmtMi } from '../access-rules.js';

// A hand-added note's link may leave out the https:// ("www.example.com/page"), or not be an address at all.
const fullUrl = url => /^https?:\/\//i.test(url) ? url : `https://${url}`;
const hostOf = url => { try { return new URL(fullUrl(url)).hostname; } catch { return url; } };
// Where a hand note came from (scripts/add-notes.mjs): the book and page, or the web page and the day it was read.
const noteSource = s => [s.url ? `<a href="${esc(fullUrl(s.url))}" target="_blank" rel="noopener">${esc(s.title ?? hostOf(s.url))} ↗</a>` : s.title && `<i>${esc(s.title)}</i>`, s.author && esc(s.author), s.page && `p. ${esc(s.page)}`, s.read && s.url && `read ${fmtDate(s.read)}`].filter(Boolean).join(', ');

export async function renderArchiveCard(lake, el) {
  if (!corpusKey(lake)) return;
  const f = await corpusFor(lake);
  if (!el.isConnected) return;
  if (!f) { el.innerHTML = `<div class="card"><h3>In the archive</h3><p class="muted small">Not in your archive yet: connect your archive server or import its pack (⚙️ gear → Your private archive), or the nightly job hasn’t reached this water.</p></div>`; return; }
  const a = f.access?.summary, rows = [];
  if (a?.verdict) rows.push(`<b>Getting there:</b> ${esc(a.verdict)}${a.road ? ` via ${esc(a.road)}` : ''}${a.hikeMi ? `, then ${esc(a.hikeMi)} on foot` : ''}${a.land?.length ? ` · ${esc(a.land.join(', '))} land` : ''} <span class="muted">(${fmtDate(f.access.fetchedAt)})</span>`);
  if (f.camping) rows.push(`<b>Camping:</b> ${f.camping.sites.length} campground${f.camping.sites.length === 1 ? '' : 's'} within ${fmtMi(f.camping.searchKm)} <span class="muted">(${fmtDate(f.camping.fetchedAt)})</span>`);
  const ys = (f.stocking?.history?.years ?? []).map(y => y.y);
  if (ys.length) rows.push(`<b>Stocking records:</b> ${Math.min(...ys)}–${Math.max(...ys)}, ${ys.length} years`);
  if (f.introductions?.length) rows.push(`<b>Introductions on record:</b> ${f.introductions.length}`);
  if (f.rules?.special?.length) rows.push(`<b>Rules that name it:</b> ${f.rules.special.length}`);
  const manual = Object.entries(f.manual ?? {});
  const ex = f.excerpts ?? [];
  el.innerHTML = `<div class="card"><h3>In the archive</h3>
    <p class="small">${rows.join('<br>') || (f.checkedAt ? 'Facts, stocking and rules only so far.' : '')}</p>
    ${f.notes?.length ? `<div class="small"><b>Notes kept with the water</b>${f.notes.map(n => `<p class="small">📝 ${esc(n.text)} <span class="muted">${n.source ? `${noteSource(n.source)} · ` : ''}${esc(n.date ?? '')}${n.by ? `, ${esc(n.by)}` : ''}</span></p>`).join('')}</div>` : ''}
    ${ex.length ? `<div class="small"><b>From your books</b>${ex.map(x => `<p class="small">“${esc(x.text)}” <span class="muted">${x.source ? noteSource(x.source) : ''}</span></p>`).join('')}</div>` : ''}
    ${manual.length ? `<p class="small muted">Hand-set facts: ${manual.map(([k, v]) => `${esc(k)} = ${esc(String(v))}`).join(', ')}</p>` : ''}
    <p class="muted small">${f.checkedAt ? `${f.sources?.length ?? 0} sources · first seen ${esc(f.firstSeen ?? '')} · last checked ${fmtDate(f.checkedAt)}` : 'The nightly job hasn’t built the rest of this water’s record yet.'}${f.changes?.[0] ? ` · last change: ${esc(f.changes[0].text)} (${esc(f.changes[0].date)})` : ''}<br>
    <a href="https://github.com/mikegutberlet/FishingApp/blob/main/docs/corpus/README.md" target="_blank" rel="noopener">About the archive ↗</a></p></div>`;
}
