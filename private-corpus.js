// Your private archive: every stocked water's record, your notes and book excerpts, built nightly into a folder on
// your NAS and Google Drive (scripts/build-corpus.mjs, docs/corpus/README.md) and imported here from its pack file
// into this phone's own storage. corpus.js reads it from there. Nothing in it is ever fetched from, or sent to, a server.
import { db } from './db.js';
import { $, esc, fmtDate, status, onShow } from './ui.js';

const META = 'corpus-private';
export const isPrivateCorpus = data => data?.app === 'tackle-box' && data.kind === 'private-corpus' && data.waters && typeof data.waters === 'object';

export async function importPrivateCorpus(data) {
  const rows = Object.entries(data.waters).filter(([id, w]) => /^[a-z]{2}\/[^/]+$/.test(id) && w && typeof w === 'object').map(([id, w]) => ({ ...w, id }));
  // All or nothing: a write that fails (storage full) keeps the archive already on the phone, and its line in Settings.
  await db.replaceAll('corpusPrivate', rows);
  const n = rows.length;
  localStorage.setItem(META, JSON.stringify({ builtAt: data.builtAt ?? null, waters: n, library: (data.library ?? []).length, importedAt: new Date().toISOString() }));
  status(`Private archive: ${n} waters`);
  renderCard();
}

function renderCard() {
  const el = $('#private-corpus-card');
  if (!el) return;
  let m = null; try { m = JSON.parse(localStorage.getItem(META)); } catch {}
  el.innerHTML = `<h3>Your private archive</h3>
    <p class="small">${m ? `${m.waters} waters with their records, your notes and book excerpts${m.library ? `, ${m.library} books` : ''} · built ${fmtDate(m.builtAt)} · imported ${fmtDate(m.importedAt)}` : 'Every stocked water’s record plus notes and excerpts from your own books, sites and blogs, built nightly into your private folder. Import its pack file (tackle-box-private-corpus.json) with the button above; it stays on this phone only.'}</p>
    ${m ? `<button class="danger" id="private-corpus-clear">Remove from this phone</button>` : ''}`;
  $('#private-corpus-clear', el)?.addEventListener('click', async () => { if (!confirm('Remove your private archive from this phone? (The pack on your NAS and Drive stays.)')) return; await db.clear('corpusPrivate'); localStorage.removeItem(META); renderCard(); });
}
onShow('settings', renderCard);
