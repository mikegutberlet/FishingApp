// Where should I go? Filters every water the app knows (each state's lakes and stocked waters, plus your saved ones)
// by the fish you want, how you get on the water, how far it is from home, recent stocking and your own catches.
// Everything comes from data already on the phone; facts per water are worked out once and kept for the session.
import { db } from '../db.js';
import { list as stateList, forLake } from '../states/index.js';
import { $, esc, fmtDate, status, showView } from '../ui.js';
import { haversineKm } from '../data-sources.js';
import { locate, pickPoint } from '../map.js';
import { units } from '../units.js';
import { groupOf, groupLabel } from '../game-plan.js';
import { openLake, openWater } from './lake.js';
import { renderLakeList } from './lakes.js';
import { stockHistoryFor } from '../stock-history.js';
import { speciesName, speciesLine, isCatchAll } from '../species.js';

const HOME = 'tackle-box-home', PREFS = 'tackle-box-finder';
const read = k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const prefs = () => ({ fish: [], access: [], miles: 50, stocked: false, mine: false, noAlgae: true, sort: 'near', ...read(PREFS) });

const FISH = ['trout', 'kokanee', 'laker', 'largemouth', 'smallmouth', 'striper', 'crappie', 'panfish', 'catfish', 'walleye'];
// Kinds of trout, by the species list's names (species.js): "Cutthroat trout" also finds Lahontan, Paiute and the rest.
const KINDS = ['Rainbow trout', 'Brown trout', 'Brook trout', 'Cutthroat trout', 'Lahontan cutthroat trout', 'Golden trout', 'Tiger trout', 'Bull trout', 'Cutbow trout', 'Steelhead'];
const ACCESS = { ramp: 'Boat ramp', pier: 'Fishing pier', marina: 'Marina', rental: 'Boat rental', camp: 'Campground', parking: 'Parking' };
const MILES = [10, 25, 50, 100, 200, 0];
// NAS records of fish that didn't take or were removed don't mean the fish is there.
const GONE = /failed|extirpated|eradicated/i;
// "Brown bullhead" is a catfish, not a brown trout.
const group = s => /bullhead/i.test(s ?? '') ? 'catfish' : groupOf(s);
const metric = () => units().depth === 'm';
const fmtMiles = mi => mi ? (metric() ? `${Math.round(mi * 1.609)} km` : `${mi} mi`) : 'Any';
const distNum = km => metric() ? Math.round(km) : Math.round(km * 0.621371);
const isStream = n => /river|creek|fork|section/i.test(n ?? ''); // as views/lakes.js types a stocked water

// ---------- Every water, once per session ----------
let pool = null;
async function loadPool() {
  return pool ??= Promise.all(stateList.map(async S => {
    const [stocked, sw] = await Promise.all([S.waters(), S.statewide()]);
    return [
      ...sw.lakes.map(w => ({ key: `${S.code}:n:${w.id}`, S, w, name: w.name, type: w.type, lat: w.lat, lon: w.lon })),
      ...stocked.filter(w => w.lat != null).map(w => ({ key: `${S.code}:s:${w.id}`, S, stock: w, name: w.name, type: w.type ?? (isStream(w.name) ? 'River' : 'Lake'), lat: w.lat, lon: w.lon })),
    ];
  })).then(parts => parts.flat()).then(all => {
    // Nothing loaded (no signal before the data was cached): ask again next time.
    if (!all.length) { pool = null; facts.clear(); }
    return all;
  });
}

// What we know about one water: fish (and where that comes from), latest plant and access places. Algae advisories
// are slow to match in Oregon, so they're looked up only for waters that pass the other filters.
const facts = new Map();
function factsFor(e) {
  if (!facts.has(e.key)) facts.set(e.key, (async () => {
    const S = e.S, place = e.w ?? e.stock;
    const id = e.saved?.[S.stockField];
    const stock = e.stock ?? (id != null ? (await S.waters()).find(w => String(w.id) === String(id)) : await S.matchStockedWater(e.w));
    const [hist, access] = await Promise.all([S.historyFor(place), S.accessFor?.(place)]);
    const fish = new Map(), add = (s, src) => addFish(fish, s, src);
    for (const p of stock?.plants ?? []) add(p.species, 'stocked');
    // Past years' reports name the kind more often than the current schedule does ("Rainbow Trout" vs "Legal trout").
    const past = stock ? await stockHistoryFor({ name: stock.name, state: S.code, [S.stockField]: stock.id, lat: stock.lat, lon: stock.lon, county: stock.county ?? stock.counties }) : null;
    for (const y of past?.years ?? []) for (const s of Object.keys(y.sp)) add(s, 'past');
    // historyFor lines read "Species (locality) · status".
    for (const h of hist.local) if (!GONE.test(h.text.split(' · ').at(-1))) add(h.text.split(/ \(| · /)[0], 'on record');
    return { stock, fish, lastPlant: stock?.lastPlant ?? null, access: access ? new Set(access.places.map(p => p.kind)) : null };
  })().catch(() => ({ fish: new Map(), access: null })));
  return facts.get(e.key);
}
// A fish goes in under its group ('trout') and, for trout and kokanee, also under the kind the record names
// ('k:Tiger trout'). Other fish stay by group, so a card's list stays short.
function addFish(fish, s, src) {
  const g = group(s), kind = speciesName(s);
  const named = kind && !isCatchAll(kind) && (speciesLine(kind).includes('Trout') || /kokanee|sockeye/i.test(kind));
  for (const k of [g, named && `k:${kind}`]) if (k) (fish.get(k) ?? fish.set(k, new Set()).get(k)).add(src);
}
const hasFish = (fish, want) => fish.has(want) || [...fish.keys()].some(k => k.startsWith('k:') && speciesLine(k.slice(2)).includes(want));
const habs = new Map();
const habFor = e => habs.get(e.key) ?? habs.set(e.key, (e.S.habFor?.(e.w ?? e.stock) ?? Promise.resolve([])).then(a => a.length, () => 0)).get(e.key);

// ---------- Where distance is measured from ----------
async function origin() {
  const home = read(HOME);
  if (home) return { ...home, label: 'home' };
  try { return { ...await locate(), label: 'where you are' }; } catch { return null; }
}

function setHome() {
  showView('map');
  status('Tap the map where home is');
  pickPoint(({ lat, lng }) => { write(HOME, { lat, lon: lng }); showView('lakes', { render: false }); renderFinder(); });
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
      <div class="fd-from"><span id="fd-from" class="muted">Finding where you are…</span><button type="button" id="fd-home">${read(HOME) ? 'Move home' : 'Set home'}</button></div>
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
  const [from, all, saved, catches] = await Promise.all([origin(), loadPool(), db.all('lakes'), db.all('catches')]);
  if (!$('#fd-from')) return;
  $('#fd-from').textContent = from ? `Distances from ${from.label}` : 'Set home to see distances. Location is off.';
  // Your saved waters stand in for the same water in the state lists, and carry your catches and species notes.
  const caught = new Map();
  for (const c of catches) if (c.lakeId) (caught.get(c.lakeId) ?? caught.set(c.lakeId, []).get(c.lakeId)).push(c);
  const savedFor = new Map();
  const extra = [];
  for (const l of saved) {
    const S = forLake(l);
    const key = l.nhdId && S ? `${S.code}:n:${l.nhdId}` : S && l[S.stockField] != null ? `${S.code}:s:${l[S.stockField]}` : null;
    if (key && all.some(e => e.key === key)) savedFor.set(key, l);
    else if (S && l.lat != null) extra.push({ key: `mine:${l.id}`, S, w: l, name: l.name, type: l.type, lat: l.lat, lon: l.lon, saved: l });
  }
  const entries = [...all.map(e => savedFor.has(e.key) ? { ...e, saved: savedFor.get(e.key) } : e), ...extra];

  const save = patch => { write(PREFS, { ...prefs(), ...patch }); draw(); };
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
    const maxKm = P.miles ? P.miles * 1.609344 : Infinity;
    const near = entries.map(e => ({ ...e, distKm: from ? haversineKm(from.lat, from.lon, e.lat, e.lon) : null }))
      .filter(e => e.distKm == null || e.distKm <= maxKm).sort((a, b) => (a.distKm ?? 0) - (b.distKm ?? 0));
    const today = new Date().toISOString().slice(0, 10), cutoff = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    const hits = [], claimed = new Set();
    const unknown = new Set();
    for (let i = 0; i < near.length; i++) {
      const f = await factsFor(near[i]);
      if (me !== run || !out.isConnected) return;
      // A stocked water that one of the state's lakes already stands for is the same water: show it once,
      // as your saved copy if you added it from the stocked list.
      const stockKey = near[i].w && f.stock ? `${near[i].S.code}:s:${f.stock.id}` : null;
      if (stockKey) claimed.add(stockKey);
      const e = { ...near[i], saved: near[i].saved ?? savedFor.get(stockKey) };
      const mine = e.saved ? caught.get(e.saved.id) ?? [] : [];
      const fish = new Map([...f.fish].map(([g, s]) => [g, new Set(s)]));
      const yours = [...mine.map(c => c.species), ...String(e.saved?.species ?? '').split(/,|;/)];
      for (const s of yours) addFish(fish, s, 'yours');
      const r = { ...e, f, fish, mine: mine.length };
      if (P.fish.length && !P.fish.some(g => hasFish(fish, g))) { if (!fish.size) unknown.add(e.key); }
      else if (P.access.length && !(f.access && P.access.every(k => f.access.has(k)))) { if (!f.access) unknown.add(e.key); }
      else if (P.stocked && !(f.lastPlant && f.lastPlant >= cutoff)) ;
      else if (P.mine && !r.mine) ;
      else if ((r.hab = await habFor(e)) && P.noAlgae) ;
      else hits.push(r);
      if (me !== run) return;
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
      $('#fd-count').textContent = progress ?? (rows.length ? `${rows.length} water${rows.length === 1 ? '' : 's'} match${rows.length === 1 ? 'es' : ''}${unknowns ? `. ${unknowns} more within range have no fish or access records in the app yet.` : '.'}` : '');
      out.innerHTML = rows.length ? rows.slice(0, 60).map((r, i) => card(r, i, today)).join('')
        : progress ? '' : '<div class="card muted">Nothing matches. Try a longer distance or fewer filters.</div>';
      out.querySelectorAll('.fd-item').forEach(el => el.onclick = () => openEntry(rows[+el.dataset.i]));
    }
  }
  draw();
}

function card(r, i, today) {
  // Each fish once, under the best evidence for it: your catches, then the current schedule, then past stocking
  // reports, then a USGS record.
  const by = { yours: "You've caught", stocked: 'Stocked', past: 'Stocked before', 'on record': 'On record' }, rows = {};
  // A group shows by its kinds when the records name them ("Rainbow trout, Tiger trout"), else by its own name ("Trout").
  const kinds = [...r.fish.keys()].filter(k => k.startsWith('k:'));
  for (const [g, all] of r.fish) {
    const named = new Set(g.startsWith('k:') ? [] : kinds.filter(k => group(k.slice(2)) === g).flatMap(k => [...r.fish.get(k)]));
    const src = [...all].filter(s => !named.has(s));
    if (src.length) (rows[Object.keys(by).find(k => src.includes(k))] ??= []).push(g.startsWith('k:') ? g.slice(2) : groupLabel(g));
  }
  const fish = Object.keys(by).filter(k => rows[k]).map(k => `<div class="small fd-fish"><span>${by[k]}:</span> ${esc(rows[k].join(', '))}</div>`).join('');
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
  const S = r.S, w = r.stock;
  openLake({ unsaved: true, name: w.name, type: r.type, state: S.code, county: w.county ?? w.counties, lat: w.lat, lon: w.lon, acres: w.acres ?? null,
    [S.stockField]: w.id, stockingUrl: S.waterUrl(w.id), infoUrl: S.waterUrl(w.id) }, 'stocking');
}
