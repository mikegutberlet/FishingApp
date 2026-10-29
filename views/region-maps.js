// "Region maps" in the private-archive card (Settings): the regions whose USGS topo tiles the archive server has
// pre-downloaded (scripts/build-maps.mjs), with a Download button that pulls a whole region onto this phone as an
// offline pack (offline.js downloadRegion). Switch the map to Topo to see it with no signal.
import { $, esc } from '../ui.js';
import { serverFetch } from '../corpus.js';
import { regionStatus, downloadRegion, regionPackId, deletePack, renderPacks } from '../offline.js';

const mb = b => `${Math.max(1, Math.round(b / 1e6))} MB`;
const running = new Map(); // region id → AbortController while a download runs

export async function renderRegionMaps(el) {
  if (!el) return;
  el.innerHTML = '<p class="small muted">Region maps: checking the archive…</p>';
  let regions;
  try {
    const r = await serverFetch('maps/index.json');
    if (r.status === 404) regions = [];
    else if (!r.ok) throw new Error(`HTTP ${r.status}`);
    else regions = (await r.json()).regions ?? [];
  } catch (e) {
    el.innerHTML = `<p class="small muted">Region maps: couldn’t reach the archive (${esc(e.message)}).</p>`;
    return;
  }
  const built = regions.filter(r => r.have > 0);
  if (!built.length) { el.innerHTML = '<p class="small muted">Region maps: not built yet on the server (the nightly run fills them a little each night).</p>'; return; }
  const status = await Promise.all(built.map(r => regionStatus(r).catch(() => null)));
  el.innerHTML = `<h4 style="margin:12px 0 4px">Region maps</h4>
    <p class="small muted">A whole region’s topo map from your archive, so the map works between lakes with no signal. Switch the map to <b>Topo</b> to use it.</p>`
    + built.map((r, i) => {
      const st = status[i], run = running.has(r.id);
      const state = run ? 'downloading…' : !st ? 'not on this phone' : st.complete ? `saved, ${mb(st.bytes)}` : `partial: ${st.missing} tile${st.missing === 1 ? '' : 's'} missing`;
      const action = run ? '' : !st ? 'Download' : st.complete ? '' : 'Update';
      return `<div class="lake-item" style="margin:6px 0" data-region="${esc(r.id)}"><div><b>${esc(r.name)}</b><div class="muted small">zoom ${esc(r.zMin)}–${esc(r.zMax)} · ~${mb(r.bytes)}${r.complete ? '' : ` · ${esc(r.have)} of ${esc(r.tiles)} tiles on the server so far`} · <span data-state>${esc(state)}</span></div>
        ${r.bytes > 1e9 && !st ? `<div class="small" style="color:var(--warn,#c60)">Large: ${(r.bytes / 1e9).toFixed(1)} GB. Make sure the phone has room.</div>` : ''}</div>
        <div class="acts">${action ? `<button data-region-get="${esc(r.id)}">${action}</button>` : ''}${st || run ? `<button class="danger" data-region-del="${esc(r.id)}" title="${run ? 'Stop' : 'Delete'}">✕</button>` : ''}</div></div>`;
    }).join('');
  el.querySelectorAll('[data-region-get]').forEach(b => b.onclick = async () => {
    const region = built.find(r => r.id === b.dataset.regionGet), row = b.closest('[data-region]'), out = $('[data-state]', row);
    const ctrl = new AbortController(); running.set(region.id, ctrl);
    b.remove();
    try {
      await downloadRegion(region, { signal: ctrl.signal, onProgress: (n, total) => { out.textContent = `${n} / ${total}`; } });
    } catch (e) { out.textContent = `stopped (${e.message})`; }
    running.delete(region.id);
    if (el.isConnected) { renderRegionMaps(el); renderPacks(); } // the Offline maps list below shows the pack too
  });
  el.querySelectorAll('[data-region-del]').forEach(b => b.onclick = async () => {
    const id = b.dataset.regionDel, ctrl = running.get(id);
    if (ctrl) { ctrl.abort(); return; } // the download loop stops, then re-renders as partial
    if (!confirm(`Delete the ${built.find(r => r.id === id)?.name ?? id} map from this phone?`)) return;
    await deletePack(regionPackId(id));
    renderRegionMaps(el); renderPacks();
  });
}
