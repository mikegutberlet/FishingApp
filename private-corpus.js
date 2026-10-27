// Your private archive: notes and book excerpts kept on your NAS and Google Drive (scripts/private-corpus/), packed
// into one file and imported here into this phone's own storage. corpus.js lays it over the repo's public copy of
// each water, so the Info tab shows both. Nothing in it is ever fetched from, or sent to, a server.
import { db } from './db.js';
import { $, esc, fmtDate, status, onShow } from './ui.js';

const META = 'corpus-private';
export const isPrivateCorpus = data => data?.app === 'tackle-box' && data.kind === 'private-corpus' && data.waters && typeof data.waters === 'object';

export async function importPrivateCorpus(data) {
  await db.clear('corpusPrivate');
  let n = 0;
  for (const [id, w] of Object.entries(data.waters)) {
    if (!/^[a-z]{2}\/[^/]+$/.test(id) || !w || typeof w !== 'object') continue;
    await db.put('corpusPrivate', { ...w, id }, { touch: false }); n++;
  }
  localStorage.setItem(META, JSON.stringify({ builtAt: data.builtAt ?? null, waters: n, library: (data.library ?? []).length, importedAt: new Date().toISOString() }));
  status(`Private archive: ${n} waters`);
  renderCard();
}

function renderCard() {
  const el = $('#private-corpus-card');
  if (!el) return;
  let m = null; try { m = JSON.parse(localStorage.getItem(META)); } catch {}
  el.innerHTML = `<h3>Your private archive</h3>
    <p class="small">${m ? `${m.waters} waters with your notes and book excerpts${m.library ? `, ${m.library} books` : ''} · built ${fmtDate(m.builtAt)} · imported ${fmtDate(m.importedAt)}` : 'Notes and excerpts from your own books, sites and blogs, kept on your NAS and Google Drive. Import the pack file with the button above; it stays on this phone only.'}</p>
    ${m ? `<button class="danger" id="private-corpus-clear">Remove from this phone</button>` : ''}`;
  $('#private-corpus-clear', el)?.addEventListener('click', async () => { if (!confirm('Remove your private archive from this phone? (The pack on your NAS and Drive stays.)')) return; await db.clear('corpusPrivate'); localStorage.removeItem(META); renderCard(); });
}
onShow('settings', renderCard);
