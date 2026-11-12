// The results drawer: the bar's List button opens a list of the waters the map is showing, under the map, closest
// first. Tap a row and the map goes to that water and opens its card. With a distance ring on, the list holds every
// water inside it; otherwise the ones in view, and it follows the map as you move it.
import { map, here } from './map.js';
import { $, esc, showView } from './ui.js';
import { units } from './units.js';
import { rankRows } from './map-results-core.js';
import { shownPins, pinTarget } from './map-pins.js';
import { filterView } from './map-filters.js';
import { preview, closeSheet } from './map-browse.js';
import { prefs, savePrefs } from './water-filter.js';
import { renderFinder } from './views/finder.js';

const drawer = $('#results-drawer'), rowsEl = $('#rd-rows');
const isOpen = () => !drawer.classList.contains('hidden');
const far = km => units().depth === 'm' ? `${km < 10 ? km.toFixed(1) : Math.round(km)} km` : `${km * 0.621371 < 10 ? (km * 0.621371).toFixed(1) : Math.round(km * 0.621371)} mi`;
const FROM = { home: 'home', 'where you are': 'you' };

let rows = [];
function render() {
  if (!isOpen()) return;
  const v = filterView(), view = map.getBounds(), c = map.getCenter();
  const pins = v.from ? shownPins() : shownPins().filter(e => view.contains([e.lat, e.lon]));
  // Distance is from where the ring is measured; with no ring, from where you are or home when the app already knows
  // (it doesn't ask for your location just for this), else from the middle of the map.
  const ref = v.from ?? (here ? { ...here, label: 'where you are' } : v.known ?? { lat: c.lat, lon: c.lng });
  // With best-bet scores on, each row says its score, and the list can lead with the best bets (the list's own sort).
  const byBet = v.score && prefs().sort === 'bet';
  const d = rankRows(pins, ref, { sort: byBet ? 'bet' : 'near', score: v.score ? e => v.bet(e)?.score : undefined });
  $('#rd-sort').classList.toggle('hidden', !v.score);
  $('#rd-sort').textContent = byBet ? 'Sort by distance' : 'Sort by best bet';
  rows = d.rows;
  $('#rd-count').textContent = `${d.total.toLocaleString()} water${d.total === 1 ? '' : 's'}${v.from ? '' : ' in view'}, ${byBet ? 'best bet' : `closest to ${FROM[ref.label] ?? 'the middle of the map'}`} first`;
  $('#rd-note').textContent = d.total > rows.length ? `Showing the ${byBet ? 'best' : 'nearest'} ${rows.length} of ${d.total.toLocaleString()}. Zoom in, or add filters.` : '';
  const top = rowsEl.scrollTop;
  rowsEl.innerHTML = rows.length ? rows.map(({ e, km, score }, i) => {
    const wx = v.wx(e);
    return `<button type="button" class="rd-row" data-i="${i}"><span class="rd-main"><b>${esc(e.name)}</b><span class="muted small">${esc([e.saved && '★ Saved', e.type, far(km), score != null && `Best bet ${score}`].filter(Boolean).join(' · '))}</span>${wx?.line ? `<span class="small rd-wx">${esc(wx.line)}</span>` : ''}</span><span aria-hidden="true">›</span></button>`;
  }).join('') : `<div class="rd-empty muted">${v.busy ? 'Checking waters…' : v.on ? 'Nothing matches. Try a longer distance or fewer filters.' : 'No waters in view. Zoom out, or move the map.'}</div>`;
  rowsEl.scrollTop = top;
}
// The pins are drawn again whenever what's showing changes (a move, a filter, more waters checked): so is the list.
let soon = 0;
document.addEventListener('tb-pins-drawn', () => { if (isOpen()) { clearTimeout(soon); soon = setTimeout(render, 120); } });

function open() {
  closeSheet(); $('#filter-sheet').classList.add('hidden');
  drawer.classList.remove('hidden', 'tall');
  rowsEl.scrollTop = 0;
  render();
}
const close = () => drawer.classList.add('hidden');
$('#pin-list').onclick = () => isOpen() ? close() : open();
$('#rd-close').onclick = close;
$('#rd-sort').onclick = () => { savePrefs({ sort: prefs().sort === 'bet' ? 'near' : 'bet' }); rowsEl.scrollTop = 0; render(); };
$('#pin-filters').addEventListener('click', close);
$('#rd-full').onclick = () => { close(); showView('lakes', { render: false }); renderFinder(); };
rowsEl.onclick = ev => {
  const r = rows[+ev.target.closest('.rd-row')?.dataset.i];
  if (!r) return;
  close();
  map.setView([r.e.lat, r.e.lon], Math.max(map.getZoom(), 12));
  preview(pinTarget(r.e));
};
// Swipe the head up for a taller list, down for a shorter one and then away; the grip does the same for a tap.
const head = drawer.querySelector('.rd-head');
let y0 = null;
head.addEventListener('touchstart', ev => { y0 = ev.touches[0].clientY; }, { passive: true });
head.addEventListener('touchend', ev => {
  const dy = ev.changedTouches[0].clientY - y0;
  if (dy < -40) drawer.classList.add('tall'); else if (dy > 40) drawer.classList.contains('tall') ? drawer.classList.remove('tall') : close();
}, { passive: true });
drawer.querySelector('.rd-grip').onclick = () => drawer.classList.toggle('tall');
const view = $('#view-map');
new MutationObserver(() => { if (!view.classList.contains('active')) close(); }).observe(view, { attributes: true, attributeFilter: ['class'] });
