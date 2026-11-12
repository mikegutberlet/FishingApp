// Where should I go? Filters every water the app knows (each state's lakes and stocked waters, plus your saved ones)
// by the fish you want, how you get on the water, how far it is from home, recent stocking and your own catches.
// Everything comes from data already on the phone; facts per water are worked out once and kept for the session.
import { $, esc, fmtDate, status, showView } from '../ui.js';
import { haversineKm } from '../data-sources.js';
import { pickPoint } from '../map.js';
import { units } from '../units.js';
import { openLake, openWater } from './lake.js';
import { renderLakeList } from './lakes.js';
import { loadPool, withSaved, fishRows, stockLake, ACCESS } from '../water-facts.js';
import { quickPass, needsWeather } from '../water-filter-core.js';
import { wxPass } from '../weather-grid-core.js';
import { weatherStage, weatherNotes, dateFor } from '../weather-grid.js';
import { betFor } from '../best-bet.js';
import { prefs, savePrefs, home, setHomePoint, origin, context, shape, fullPass } from '../water-filter.js';
import { filterForm, bindFilterForm, syncForm } from './filter-form.js';

const metric = () => units().depth === 'm';
const distNum = km => metric() ? Math.round(km) : Math.round(km * 0.621371);

function setHome() {
  showView('map');
  status('Tap the map where home is');
  pickPoint(({ lat, lng }) => { setHomePoint({ lat, lon: lng }); savePrefs({ from: 'home' }); showView('lakes', { render: false }); renderFinder(); });
}

// ---------- The screen ----------
let run = 0;
export async function renderFinder() {
  const list = $('#lake-list');
  $('#lake-detail').classList.add('hidden');
  list.classList.remove('hidden');
  const P = prefs();
  list.innerHTML = `<button id="back">‹ My waters</button><h2>Where should I go?</h2>
    <div class="card form fd-filters">
      <div id="fd-from" class="muted fd-from">Finding where you are…</div>
      ${filterForm(P)}
      <label>Sort <select id="fd-sort"><option value="near">Closest first</option><option value="stocked" ${P.sort === 'stocked' ? 'selected' : ''}>Most recently stocked</option><option value="bet" ${P.sort === 'bet' && P.score ? 'selected' : ''}>Best bet for the day</option></select></label>
    </div>
    <div class="fd-line"><div id="fd-count" class="muted small" aria-live="polite"></div><button type="button" id="fd-show-map">Show on map</button></div><div id="fd-results"></div>
    <p class="muted small">Fish lists come from state stocking reports, USGS records of introduced fish and your own catches. California's and Oregon's current schedules say only “trout”, so a kind of trout is matched from past reports, USGS records and your catches. Native fish that were never stocked or recorded don't show up, so a water left out may still hold them. Ramps, piers, marinas, rentals, campgrounds and parking come from OpenStreetMap for all three states, refreshed monthly; a place nobody has mapped there doesn't show. Size and elevation come from the states' lake lists, and stocked rivers and creeks have neither, so they drop out when you filter by size or elevation. “Likely ice-free” is an estimate from elevation, the time of year and your own ice notes. Distances are straight-line.</p>`;
  $('#back').onclick = renderLakeList;
  let [from, all, ctx] = await Promise.all([origin(P), loadPool(), context()]);
  if (!$('#fd-from')) return;
  const said = () => { $('#fd-from').textContent = from ? `Distances from ${from.label}` : home() ? "Location is off, so distance isn't applied." : 'Set home to see distances. Location is off.'; };
  said();
  const { entries, savedFor } = withSaved(all, ctx.saved);

  let asked = 0; // a slow fix on where you are mustn't land on top of a later choice
  bindFilterForm(list.querySelector('.fd-filters'), async (P, key) => {
    if (key === 'from') { const mine = ++asked, f = await origin(P); if (mine !== asked || !$('#fd-from')) return; from = f; said(); }
    if (key === 'score' && !P.score && P.sort === 'bet') { savePrefs({ sort: 'near' }); $('#fd-sort').value = 'near'; } // no scores to sort by
    draw();
  }, { setHome });
  // Sorting by best bet needs the scores: it switches them on.
  $('#fd-sort').onchange = e => { savePrefs({ sort: e.target.value, ...(e.target.value === 'bet' ? { score: true } : {}) }); syncForm(list.querySelector('.fd-filters')); draw(); };
  // The map takes the same settings (map-filters.js) and fits itself to the distance ring, or to these results.
  let found = [];
  $('#fd-show-map').onclick = () => document.dispatchEvent(new CustomEvent('tb-show-on-map', { detail: { points: found.map(r => [r.lat, r.lon]) } }));

  async function draw() {
    const me = ++run, P = prefs(), out = $('#fd-results');
    if (!out) return;
    // The checks that need no lookups first (distance, lake or stream, size, elevation, saved, ice), nearest first.
    // "Only my saved waters" waits for the lookups: a lake you saved from the stocked list is only known as yours there.
    const quick = { from, iced: ctx.iced }, quickP = { ...P, saved: false }, unknown = new Set(), noSize = new Set();
    const near = entries.map(e => ({ ...e, distKm: from ? haversineKm(from.lat, from.lon, e.lat, e.lon) : null }))
      .filter(e => { const q = quickPass(shape(e), quickP, quick); if (q.unknown) noSize.add(e.key); return q.ok; }).sort((a, b) => (a.distKm ?? 0) - (b.distKm ?? 0));
    const today = new Date().toISOString().slice(0, 10);
    const hits = [], claimed = new Set();
    for (let i = 0; i < near.length; i++) {
      // A stocked water that one of the state's lakes already stands for is the same water: show it once.
      const { hit, unknown: un, stockKey } = await fullPass(near[i], P, ctx, savedFor);
      if (me !== run || !out.isConnected) return;
      if (stockKey) claimed.add(stockKey);
      if (hit) hits.push(hit); else if (un) unknown.add(near[i].key);
      if (i % 80 === 79 || i === near.length - 1) {
        const last = i + 1 === near.length, rows = P.wx && !last ? [] : hits.filter(h => !(h.stock && claimed.has(h.key)));
        if (needsWeather(P) && last) return weather(rows);
        show(rows, last ? null : `Checking ${i + 1} of ${near.length} waters…`);
        await new Promise(res => setTimeout(res));
        if (me !== run) return;
      }
    }
    if (!near.length) show([], null);
    // The weather filter comes last, so forecasts are asked for only where a water passed everything else.
    async function weather(rows) {
      $('#fd-count').textContent = 'Checking the weather…';
      const items = rows.map(r => ({ lat: r.lat, lon: r.lon, acres: shape(r).acres, r }));
      const st = await weatherStage(items, P, from);
      if (me !== run || !out.isConnected) return;
      const kept = [], date = dateFor(P);
      let t0 = performance.now();
      for (const it of items) {
        if (P.wx && !(st.grades.has(it) && wxPass(st.grades.get(it)?.grade, P.wx))) continue;
        const w = st.forecasts.get(it);
        kept.push({ ...it.r, wx: st.grades.get(it)?.line, bet: P.score && w ? await betFor(it.r, w, date) : null });
        if (P.score && performance.now() - t0 > 12) { // a few at a time, so the page stays live; a newer pass ends this one
          $('#fd-count').textContent = 'Scoring the day…';
          await new Promise(res => setTimeout(res));
          if (me !== run || !out.isConnected) return;
          t0 = performance.now();
        }
      }
      if (me !== run || !out.isConnected) return;
      show(kept, null, weatherNotes(st, 'Shorten the distance, or add filters', !!P.wx).map(n => `${n}.`).join(' '));
    }
    function show(rows, progress, wxNote = '') {
      if (P.sort === 'bet' && P.score) rows = [...rows].sort((a, b) => (b.bet?.score ?? -1) - (a.bet?.score ?? -1) || (a.distKm ?? 0) - (b.distKm ?? 0));
      if (P.sort === 'stocked') rows = [...rows].sort((a, b) => (b.f.lastPlant ?? '').localeCompare(a.f.lastPlant ?? '') || (a.distKm ?? 0) - (b.distKm ?? 0));
      found = rows;
      const unknowns = [...unknown].filter(k => !claimed.has(k)).length;
      const sizeless = (noSize.size ? ' Waters with no size or elevation on record are left out.' : '') + (wxNote && ` ${wxNote}`);
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
      ${r.wx ? `<div class="small fd-wx">${esc(r.wx)}</div>` : ''}${r.bet ? `<div class="small fd-bet"><b>Best bet ${r.bet.score} of 10</b>${r.bet.why ? ` · ${esc(r.bet.why)}` : ''}</div>` : ''}${fish}${r.level ? `<div class="small">${esc(r.level.text)}</div>` : ''}${plant ? `<div class="small">${plant}</div>` : ''}
      ${access ? `<div class="small muted">${esc(access)}</div>` : ''}${r.hab ? '<div class="small fd-warn">Toxic algae advisory</div>' : ''}</div><span>›</span></div>`;
}

async function openEntry(r) {
  if (r.saved) return openLake(r.saved.id);
  if (r.w) return openWater(r.w);
  openLake(stockLake(r), 'stocking');
}
