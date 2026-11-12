// Compare up to three waters side by side. A card's Compare button puts its water in; "Compare (2)" on the map opens
// the sheet: distance, fish, last plant, the picked day's weather for your craft, lake level, elevation, size and
// access, from the same lookups the cards and filters use. The picks last until the app is closed.
import { here } from './map.js';
import { $, esc, fmtDate, status } from './ui.js';
import { units } from './units.js';
import { kmBetween } from './water-filter-core.js';
import { entryFor, factsFor, fishRows, ACCESS } from './water-facts.js';
import { prefs, shape } from './water-filter.js';
import { filterView } from './map-filters.js';
import { weatherLine, dayLabel } from './weather-grid.js';
import { levelFor } from './lake-level.js';
import { openWater, openLake } from './views/lake.js';

const MAX = 3;
const picked = []; // { id, lake, open() }
// The same water whether it comes from a state's list or, once you save it, from your lakes.
const idOf = lake => `${lake.name}|${(+lake.lat).toFixed(4)}|${(+lake.lon).toFixed(4)}`;
export const comparing = lake => picked.some(p => p.id === idOf(lake));

const openBtn = Object.assign(document.createElement('button'), { type: 'button', id: 'compare-open', className: 'on hidden' });
$('#map-chips').prepend(openBtn);
const sheet = $('#compare-sheet'), body = $('#cmp-body');
const isOpen = () => !sheet.classList.contains('hidden');
function sync() {
  openBtn.textContent = `Compare (${picked.length})`;
  openBtn.classList.toggle('hidden', !picked.length);
  if (!picked.length) sheet.classList.add('hidden'); else if (isOpen()) render();
}

// A card's Compare button: in, or out again. `open` opens the water as the card's own Open button would.
// Returns whether the water is being compared now.
export function toggleCompare(lake, open) {
  const id = idOf(lake), i = picked.findIndex(p => p.id === id);
  if (i >= 0) picked.splice(i, 1);
  else if (picked.length >= MAX) status('Compare holds three waters. Remove one first.');
  else picked.push({ id, lake, open });
  sync();
  return comparing(lake);
}
// A water saved from its card is the same water: keep its column, and open your saved copy from now on.
export function compareSaved(lake, open) { const p = picked.find(p => p.id === idOf(lake)); if (p) Object.assign(p, { lake, open }); }

const far = km => units().depth === 'm' ? `${km < 10 ? km.toFixed(1) : Math.round(km)} km` : `${km * 0.621371 < 10 ? (km * 0.621371).toFixed(1) : Math.round(km * 0.621371)} mi`;
const cap = s => s[0].toUpperCase() + s.slice(1);
async function facts({ lake }) {
  const P = prefs(), from = filterView().known ?? here;
  const e = await entryFor(lake).catch(() => null), s = e ? shape(e) : lake;
  const [f, level, wx] = await Promise.all([e ? factsFor(e) : null, e ? levelFor(e) : null, weatherLine(lake, P).catch(() => null)]);
  const acres = s.acres ?? lake.acres, elev = s.elevationFt ?? lake.elevationFt;
  return {
    Distance: from ? far(kmBetween(from, lake)) : null,
    Fish: f && fishRows(f.fish).map(x => `${x.label}: ${x.names.join(', ')}`).join('\n'),
    'Last plant': f?.lastPlant && fmtDate(f.lastPlant),
    [`Weather, ${dayLabel(P.day)}`]: wx?.replace(/^[^:]+: /, '') ?? 'No forecast',
    'Lake level': level && cap(level.text.replace(/^Lake level /, '').replace(/ \(gauge: .*\)$/, '').replace(':', ',')),
    Elevation: elev > 0 ? `${Math.round(elev).toLocaleString()} ft` : null,
    Size: acres > 0 ? `${Math.round(acres).toLocaleString()} acres` : null,
    'Getting on the water': f?.access && Object.keys(ACCESS).filter(k => f.access.has(k)).map(k => ACCESS[k]).join(', '),
  };
}
let run = 0;
async function render() {
  const me = ++run, cols = [...picked];
  const all = await Promise.all(cols.map(facts));
  if (me !== run) return;
  const grid = `style="grid-template-columns: repeat(${cols.length}, minmax(0, 1fr))"`;
  body.innerHTML = `<div class="cmp-names" ${grid}>${cols.map((p, i) => `<div class="cmp-name"><b>${esc(p.lake.name)}</b><button type="button" class="ghost" data-drop="${i}" aria-label="Remove ${esc(p.lake.name)}">✕</button></div>`).join('')}</div>`
    + Object.keys(all[0]).map(label => `<div class="cmp-row"><div class="cmp-label muted small">${esc(label)}</div><div class="cmp-cells" ${grid}>${all.map(a => `<div class="cmp-cell">${esc(a[label] || '–')}</div>`).join('')}</div></div>`).join('')
    + `<div class="cmp-cells cmp-acts" ${grid}>${cols.map((p, i) => `<button type="button" class="cmp-open" data-open="${i}">Open</button>`).join('')}</div>`;
  body.onclick = ev => {
    const drop = ev.target.closest('[data-drop]'), open = ev.target.closest('[data-open]');
    if (drop) { picked.splice(picked.indexOf(cols[+drop.dataset.drop]), 1); sync(); }
    if (open) { sheet.classList.add('hidden'); cols[+open.dataset.open].open(); }
  };
}
openBtn.onclick = () => { $('#filter-sheet').classList.add('hidden'); $('#results-drawer').classList.add('hidden'); $('#water-sheet').classList.add('hidden'); sheet.classList.remove('hidden'); body.scrollTop = 0; render(); };
$('#cmp-done').onclick = () => sheet.classList.add('hidden');
$('#cmp-clear').onclick = () => { picked.length = 0; sync(); };
const view = $('#view-map');
new MutationObserver(() => { if (!view.classList.contains('active')) sheet.classList.add('hidden'); }).observe(view, { attributes: true, attributeFilter: ['class'] });
