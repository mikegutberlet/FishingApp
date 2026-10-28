// Your private archive: every stocked water's record, your notes and book excerpts, built nightly into a folder on
// your NAS and Google Drive (scripts/build-corpus.mjs, docs/corpus/README.md). The app reads it from your own archive
// server (server/serve.mjs: address and key set here) and keeps each water it fetches in this phone's own storage, or
// from its pack file imported whole. Nothing in it ever goes to anyone else's server.
import { db } from './db.js';
import { $, esc, fmtDate, status, onShow } from './ui.js';
import { SERVER, serverConf, serverFetch } from './corpus.js';

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
  const c = serverConf();
  el.innerHTML = `<h3>Your private archive</h3>
    <p class="small">Every stocked water’s record plus notes and excerpts from your own books, sites and blogs, built nightly into your private folder. Read it from your own archive server, or import its pack file (tackle-box-private-corpus.json) with the button above. Either way it stays on this phone only.</p>
    <div class="form"><label>Server address <input id="corpus-url" type="url" placeholder="https://archive.example.com" value="${esc(c?.url ?? '')}" autocomplete="off"></label>
    <label>Key <input id="corpus-key" type="password" placeholder="the CORPUS_TOKEN you set on the server" value="${esc(c?.key ?? '')}" autocomplete="off"></label></div>
    <p><button id="corpus-check">${c ? 'Save and check' : 'Connect'}</button>${c ? ` <button class="danger" id="corpus-forget">Forget server</button>` : ''}</p>
    <p class="small muted" id="corpus-server-status">${c ? 'Connected: waters are fetched as you open them and kept here.' : ''}</p>
    ${m ? `<p class="small">Imported pack: ${m.waters} waters${m.library ? `, ${m.library} books` : ''} · built ${fmtDate(m.builtAt)} · imported ${fmtDate(m.importedAt)} <button class="danger" id="private-corpus-clear">Remove from this phone</button></p>` : ''}`;
  $('#corpus-check', el).onclick = async () => {
    const url = $('#corpus-url', el).value.trim().replace(/\/+$/, ''), key = $('#corpus-key', el).value.trim(), out = $('#corpus-server-status', el);
    if (!/^https:\/\/.+|^http:\/\/localhost/.test(url) || !key) { out.textContent = 'Give the server’s https address and its key.'; return; }
    out.textContent = 'Checking…';
    // The address and key are kept only once the server has answered with them, so a typo doesn't slow every lookup.
    const was = localStorage.getItem(SERVER);
    localStorage.setItem(SERVER, JSON.stringify({ url, key }));
    try {
      const h = await serverFetch('health').then(r => r.json());
      if (h?.ok !== true) throw new Error('not an archive server');
      const r = await serverFetch('ca/index.json');
      if (r.status === 401) throw new Error('the key is wrong');
      if (!r.ok && r.status !== 404) throw new Error(`HTTP ${r.status}`);
      out.textContent = `Connected: ${h.waters ?? 0} waters in the archive${h.builtAt ? `, built ${fmtDate(h.builtAt)}` : ''}${h.lastBuild ? `, last nightly run ${h.lastBuild.ok ? 'ok' : 'failed'} ${fmtDate(h.lastBuild.at)}` : ''}.`;
      status('Archive server connected'); renderCard(); $('#corpus-server-status', el).textContent = out.textContent;
    } catch (e) {
      was ? localStorage.setItem(SERVER, was) : localStorage.removeItem(SERVER);
      out.textContent = `Couldn’t reach the archive server (${e.message}). Check the address, the key, and that the server allows this app’s address.`;
    }
  };
  $('#corpus-forget', el)?.addEventListener('click', () => { localStorage.removeItem(SERVER); renderCard(); });
  $('#private-corpus-clear', el)?.addEventListener('click', async () => { if (!confirm('Remove the imported archive from this phone? (The pack on your NAS and Drive stays.)')) return; await db.clear('corpusPrivate'); localStorage.removeItem(META); renderCard(); });
}
onShow('settings', renderCard);
