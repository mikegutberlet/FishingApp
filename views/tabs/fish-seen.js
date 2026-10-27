// "Fish seen near here": species people have photographed within a few miles of the water and had identified on
// iNaturalist (research grade), with the latest photos. Fun on little-known waters, noisy everywhere: an angler's
// photo of a catch counts the same as a snorkeler's. Drawn on the Game plan tab. See access-more.js.
import { esc, fmtDate } from '../../ui.js';
import { fishSeen, cachedFishSeen, fishKm } from '../../access-more.js';
import { fmtMi } from '../../access-rules.js';

export async function renderFishSeen(lake, el) {
  if (!el || lake.kind === 'ocean' || !Number.isFinite(+lake.lat)) return;
  const km = fishKm(lake), lat = +lake.lat, lon = +lake.lon;
  const paint = (d, note = '') => {
    if (!el.isConnected) return;
    if (!d) { el.innerHTML = note ? `<div class="card"><h3>🐟 Fish seen near here</h3><p class="muted small">${note}</p></div>` : ''; return; }
    const name = t => esc(t?.common ? t.common.replace(/^./, c => c.toUpperCase()) : t?.name ?? 'Fish');
    el.innerHTML = `<div class="card"><h3>🐟 Fish seen near here</h3>
      ${d.species.length ? `<p class="small">${d.species.slice(0, 12).map(s => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${name(s)}</a> <span class="muted">(${s.count})</span>`).join(' · ')}</p>
        ${d.recent.some(o => o.photo) ? `<div class="fs-strip">${d.recent.filter(o => o.photo).slice(0, 6).map(o => `<a class="fs-ph" href="${esc(o.url)}" target="_blank" rel="noopener" title="${esc(o.photoBy ?? '')}">
          <img src="${esc(o.photo)}" alt="${name(o.taxon)}" loading="lazy"><span class="small">${name(o.taxon)}${o.date ? `<br><span class="muted">${esc(fmtDate(o.date))}</span>` : ''}</span></a>`).join('')}</div>` : ''}`
        : `<p class="muted small">No identified fish photos within ${fmtMi(km)} yet.</p>`}
      <p class="muted small" style="margin-top:6px">${d.total ? `${d.total} species` : 'Nothing'} from research-grade <a href="${esc(d.searchUrl)}" target="_blank" rel="noopener">iNaturalist observations ↗</a> within ${fmtMi(km)}, all years; photos belong to their owners and open on iNaturalist. Anyone’s sighting counts, so it shows what lives here, not what’s biting.${note ? ` ${note}` : ''} Looked up ${fmtDate(d.fetchedAt)}.</p></div>`;
  };
  const have = await cachedFishSeen(lat, lon, km);
  if (have) paint(have);
  if (have && !have.stale) return;
  if (navigator.onLine === false) return;
  try { paint(await fishSeen(lat, lon, km)); }
  catch (e) { paint(have, have ? '' : `Couldn’t reach iNaturalist (${esc(e.message)}).`); }
}
