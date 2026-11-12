// Where should I go? Filters every water the app knows (each state's lakes and stocked waters, plus your saved ones)
// by the fish you want, how you get on the water, how far it is from home, recent stocking and your own catches.
// Everything comes from data already on the phone; facts per water are worked out once and kept for the session.
import { $, esc, fmtDate, status, showView } from '../ui.js';
import { haversineKm } from '../data-sources.js';
import { pickPoint } from '../map.js';
import { units } from '../units.js';
import { groupLabel } from '../game-plan.js';
import { openLake, openWater } from './lake.js';
import { renderLakeList } from './lakes.js';
import { loadPool, withSaved, fishRows, stockLake, ACCESS } from '../water-facts.js';
import { quickPass } from '../water-filter-core.js';
import { prefs, savePrefs, home, setHomePoint, origin, context, shape, fullPass } from '../water-filter.js';

const FISH = ['trout', 'kokanee', 'laker', 'largemouth', 'smallmouth', 'striper', 'crappie', 'panfish', 'catfish', 'walleye'];
// Kinds of trout, by the species list's names (species.js): "Cutthroat trout" also finds Lahontan, Paiute and the rest.
const KINDS = ['Rainbow trout', 'Brown trout', 'Brook trout', 'Cutthroat trout', 'Lahontan cutthroat trout', 'Golden trout', 'Tiger trout', 'Bull trout', 'Cutbow trout', 'Steelhead'];
const MILES = [10, 25, 50, 100, 200, 0];
const metric = () => units().depth === 'm';
const fmtMiles = mi => mi ? (metric() ? `${Math.round(mi * 1.609)} km` : `${mi} mi`) : 'Any';
const distNum = km => metric() ? Math.round(km) : Math.round(km * 0.621371);

function setHome() {
  showView('map');
  status('Tap the map where home is');
  pickPoint(({ lat, lng }) => { setHomePoint({ lat, lon: lng }); showView('lakes', { render: false }); renderFinder(); });
}

// ---------- The screen ----------
let run = 0;
export async function renderFinder() {
  const list = $('#lake-list');
  $('#lake-detail').classList.add('hidden');
  list.classList.remove('hidden');
  const P = prefs();
  const chip = (attr, v, label, on) => `<button type="button" data-${attr}="${v}" aria-pressed="${on}">${esc(label)}</button>`;
  list.innerHTML = `<button id="back">‹ My waters</button><h2>Where should I go?</h2>
    <div class="card form fd-filters">
      <div class="fd-from"><span id="fd-from" class="muted">Finding where you are…</span><button type="button" id="fd-home">${home() ? 'Move home' : 'Set home'}</button></div>
      <fieldset><legend>Fish I want</legend><div class="fd-chips">${FISH.map(g => chip('fish', g, groupLabel(g), P.fish.includes(g))).join('')}</div>
        <div class="fd-chips fd-kinds"><span class="muted small">Kind of trout</span>${KINDS.map(k => chip('fish', k, k.replace(/ trout$/, ''), P.fish.includes(k))).join('')}</div></fieldset>
      <fieldset><legend>Getting on the water</legend><div class="fd-chips">${Object.entries(ACCESS).map(([k, l]) => chip('access', k, l, P.access.includes(k))).join('')}</div></fieldset>
      <fieldset><legend>How far</legend><div class="fd-chips">${MILES.map(m => chip('miles', m, fmtMiles(m), P.miles === m)).join('')}</div></fieldset>
      <label class="check"><input type="checkbox" data-opt="stocked" ${P.stocked ? 'checked' : ''}> Stocked in the last 30 days or coming up</label>
      <label class="check"><input type="checkbox" data-opt="mine" ${P.mine ? 'checked' : ''}> Only waters where I've logged a catch</label>
      <label class="check"><input type="checkbox" data-opt="noAlgae" ${P.noAlgae ? 'checked' : ''}> Hide waters with a toxic algae advisory</label>
      <label>Sort <select id="fd-sort"><option value="near">Closest first</option><option value="stocked" ${P.sort === 'stocked' ? 'selected' : ''}>Most recently stocked</option></select></label>
    </div>
    <div id="fd-count" class="muted small" aria-live="polite"></div><div id="fd-results"></div>
    <p class="muted small">Fish lists come from state stocking reports, USGS records of introduced fish and your own catches. California's and Oregon's current schedules say only “trout”, so a kind of trout is matched from past reports, USGS records and your catches. Native fish that were never stocked or recorded don't show up, so a water left out may still hold them. Ramps, piers, marinas, rentals, campgrounds and parking come from OpenStreetMap and cover California only for now. Distances are straight-line.</p>`;
  $('#back').onclick = renderLakeList;
  $('#fd-home').onclick = setHome;
  const [from, all, ctx] = await Promise.all([origin(), loadPool(), context()]);
  if (!$('#fd-from')) return;
  $('#fd-from').textContent = from ? `Distances from ${from.label}` : 'Set home to see distances. Location is off.';
  const { entries, savedFor } = withSaved(all, ctx.saved);

  const save = patch => { savePrefs(patch); draw(); };
  list.querySelector('.fd-filters').onclick = e => {
    const b = e.target.closest('button[data-fish], button[data-access], button[data-miles]');
    if (!b) return;
    const P = prefs();
    if (b.dataset.miles != null) { list.querySelectorAll('[data-miles]').forEach(x => x.setAttribute('aria-pressed', x === b)); return save({ miles: +b.dataset.miles }); }
    const kind = b.dataset.fish ? 'fish' : 'access', v = b.dataset[kind], on = !P[kind].includes(v);
    b.setAttribute('aria-pressed', on);
    save({ [kind]: on ? [...P[kind], v] : P[kind].filter(x => x !== v) });
  };
  list.querySelectorAll('[data-opt]').forEach(el => el.onchange = () => save({ [el.dataset.opt]: el.checked }));
  $('#fd-sort').onchange = e => save({ sort: e.target.value });


  async function draw() {
    const me = ++run, P = prefs(), out = $('#fd-results');
    if (!out) return;
    // The checks that need no lookups first (distance, lake or stream, size, elevation, saved, ice), nearest first.
    const quick = { from, iced: ctx.iced }, unknown = new Set(), noSize = new Set();
    const near = entries.map(e => ({ ...e, distKm: from ? haversineKm(from.lat, from.lon, e.lat, e.lon) : null }))
      .filter(e => { const q = quickPass(shape(e), P, quick); if (q.unknown) noSize.add(e.key); return q.ok; }).sort((a, b) => (a.distKm ?? 0) - (b.distKm ?? 0));
    const today = new Date().toISOString().slice(0, 10);
    const hits = [], claimed = new Set();
    for (let i = 0; i < near.length; i++) {
      // A stocked water that one of the state's lakes already stands for is the same water: show it once.
      const { hit, unknown: un, stockKey } = await fullPass(near[i], P, ctx, savedFor);
      if (me !== run || !out.isConnected) return;
      if (stockKey) claimed.add(stockKey);
      if (hit) hits.push(hit); else if (un) unknown.add(near[i].key);
      if (i % 80 === 79 || i === near.length - 1) {
        show(hits.filter(h => !(h.stock && claimed.has(h.key))), i + 1 < near.length ? `Checking ${i + 1} of ${near.length} waters…` : null);
        await new Promise(res => setTimeout(res));
        if (me !== run) return;
      }
    }
    if (!near.length) show([], null);
    function show(rows, progress) {
      if (P.sort === 'stocked') rows = [...rows].sort((a, b) => (b.f.lastPlant ?? '').localeCompare(a.f.lastPlant ?? '') || (a.distKm ?? 0) - (b.distKm ?? 0));
      const unknowns = [...unknown].filter(k => !claimed.has(k)).length;
      const sizeless = noSize.size ? ` ${noSize.size.toLocaleString()} left out: no size or elevation on record.` : '';
      $('#fd-count').textContent = progress ?? (rows.length ? `${rows.length} water${rows.length === 1 ? '' : 's'} match${rows.length === 1 ? 'es' : ''}${unknowns ? `. ${unknowns} more within range have no fish or access records in the app yet.` : '.'}${sizeless}` : sizeless.trim());
      out.innerHTML = rows.length ? rows.slice(0, 60).map((r, i) => card(r, i, today)).join('')
        : progress ? '' : '<div class="card muted">Nothing matches. Try a longer distance or fewer filters.</div>';
      out.querySelectorAll('.fd-item').forEach(el => el.onclick = () => openEntry(rows[+el.dataset.i]));
    }
  }
  draw();
}

function card(r, i, today) {
  const fish = fishRows(r.fish).map(x => `<div class="small fd-fish"><span>${x.label}:</span> ${esc(x.names.join(', '))}</div>`).join('');
  const plant = r.f.lastPlant && `${r.f.lastPlant > today ? 'Plant planned' : 'Last stocked'} ${fmtDate(r.f.lastPlant)}`;
  const access = r.f.access && Object.keys(ACCESS).filter(k => r.f.access.has(k)).map(k => ACCESS[k]).join(', ');
  return `<div class="card lake-item fd-item" data-i="${i}">
    ${r.distKm != null ? `<span class="fd-post"><b>${distNum(r.distKm).toLocaleString()}</b>${metric() ? 'km' : 'mi'}</span>` : ''}
    <div class="fd-body"><b>${esc(r.name)}</b><div class="muted small">${esc(r.type ?? '')}${r.S ? ', ' + r.S.code : ''}${r.saved ? ' · saved' : ''}${r.mine ? ` · ${r.mine} catch${r.mine === 1 ? '' : 'es'} logged` : ''}</div>
      ${fish}${plant ? `<div class="small">${plant}</div>` : ''}
      ${access ? `<div class="small muted">${esc(access)}</div>` : ''}${r.hab ? '<div class="small fd-warn">Toxic algae advisory</div>' : ''}</div><span>›</span></div>`;
}

async function openEntry(r) {
  if (r.saved) return openLake(r.saved.id);
  if (r.w) return openWater(r.w);
  openLake(stockLake(r), 'stocking');
}
