// A pin for every lake: each state's named lakes and reservoirs, its stocked rivers and creeks with a known spot,
// and your saved waters. Zoomed out, pins share numbered bubbles; zoomed in, each pin is colored by what the app
// knows about its fish (the same lookups as the "Where should I go?" list: water-facts.js). All of it comes from
// lists already on the phone.
import { db } from './db.js';
import { map, layersControl, lakeLayer, isPicking } from './map.js';
import { statesIn, forLake } from './states/index.js';
import { statePool, withSaved, stockFor, factsFor, stockLake } from './water-facts.js';
import { clusterPins, samePlace, pinTone } from './map-pins-core.js';
import { preview, chooser } from './map-browse.js';
import { $, esc, onShow } from './ui.js';

const KEY = 'tackle-box-pins'; // '0' when you've switched the pins off, this phone only
export const pinsLayer = L.layerGroup();
layersControl.addOverlay(pinsLayer, 'Lake pins');
const bar = $('#pin-bar'), chip = $('#map-chips [data-chip=pins]');
const tick = () => new Promise(r => setTimeout(r));

// ---------- What gets a pin ----------
// Per state: its pool (water-facts.js), and after a background pass which stocked waters a lake already stands for
// (the list's rule: such a water shows once, as the lake). Stocked-only pins wait for that pass.
const states = new Map();
let mine = { saved: [], caught: new Map() }, pins = [], stale = true;
const tones = new Map(); // toneKey -> 'fresh' | 'fish' | 'none', kept until your lakes or catches change
const toneKey = e => `${e.key}|${e.saved?.id ?? ''}`; // a pin learns late that it stands for a water you saved

function loadStates() {
  if (!map.hasLayer(pinsLayer) || !map.getContainer().offsetWidth) return; // hidden: wait until the map is on screen
  const ring = filter?.also(); // a distance filter needs the waters under its ring, on screen or not
  for (const S of new Set([...statesIn(map.getBounds()), ...(ring ? statesIn(ring) : [])])) {
    if (states.has(S.code)) continue;
    states.set(S.code, null);
    // No signal before the lists were kept: say so, and ask again on the next move.
    const none = () => { states.delete(S.code); failed = true; draw(); };
    statePool(S).then(all => {
      if (!all.length) return none();
      const st = { S, all, done: false, claimed: new Set(), link: new Map() };
      states.set(S.code, st);
      failed = false; stale = true; draw();
      linkStocked(st);
    }, none);
  }
}
async function linkStocked(st) {
  let t0 = performance.now();
  for (const e of st.all) {
    if (!e.w) continue;
    const s = await stockFor(e).catch(() => null);
    if (s) { const k = `${st.S.code}:s:${s.id}`; st.claimed.add(k); st.link.set(e.key, k); }
    if (performance.now() - t0 > 12) { await tick(); t0 = performance.now(); } // a few at a time, so the map stays smooth
  }
  st.done = true; stale = true; draw();
}
function build() {
  const loaded = [...states.values()].filter(Boolean);
  const { entries, savedFor } = withSaved(loaded.flatMap(st => st.all), mine.saved);
  // A saved water added from the stocked list stands in for the lake that list entry belongs to.
  const claimed = new Set(), link = new Map();
  for (const st of loaded) { for (const k of st.claimed) claimed.add(k); for (const [a, b] of st.link) link.set(a, b); }
  const done = new Set(loaded.filter(st => st.done).map(st => st.S.code));
  // Until a state's pass is done only your saved ones of its stocked-only waters show, so a saved creek never loses its pin.
  pins = entries.filter(e => e.w || (done.has(e.S.code) ? !claimed.has(e.key) : e.saved))
    .map(e => e.saved || !savedFor.has(link.get(e.key)) ? e : { ...e, saved: savedFor.get(link.get(e.key)) });
  // Saved waters outside the three states still get their pin.
  for (const l of mine.saved) if (!forLake(l) && Number.isFinite(l.lat) && Number.isFinite(l.lon)) pins.push({ key: `mine:${l.id}`, S: null, w: l, name: l.name, type: l.type, lat: l.lat, lon: l.lon, saved: l });
  pins = pins.filter(e => Number.isFinite(e.lat) && Number.isFinite(e.lon));
  stale = false;
  filter?.changed();
}

// ---------- Filtering (map-filters.js) ----------
// While the map is filtered: `keep(pin)` says which pins stay, `count(inView, all)` what the bar reads (null: the usual
// count), `also()` the bounds a distance ring covers, and `changed()` hears that the set of pins was rebuilt.
let filter = null;
export const setPinFilter = f => { filter = f; };
export const pinList = () => pins;
export const shownPins = () => filter ? pins.filter(filter.keep) : pins; // the pins the map is showing (map-results.js lists them)
// Every state asked for has its waters, and each lake knows the stocked water it stands for.
export const pinsSettled = () => [...states.values()].every(st => st?.done);

// ---------- Drawing ----------
const TEARDROP = '<svg viewBox="0 0 26 32" aria-hidden="true"><path d="M13 31C13 31 2 19.5 2 12a11 11 0 0 1 22 0c0 7.500-11 19-11 19z"/></svg>';
const caughtOn = e => e.saved ? mine.caught.get(e.saved.id) ?? 0 : 0;
const pinIcon = (e, tone) => L.divIcon({ className: `pin tone-${tone}${e.saved ? ' saved' : ''}${caughtOn(e) ? ' caught' : ''}`, html: `${TEARDROP}${e.saved ? '<b>★</b>' : ''}<i></i>`, iconSize: [26, 32], iconAnchor: [13, 31] });
const target = e => e.saved ?? (e.stock && !e.w ? stockLake(e) : e.w);
export { target as pinTarget }; // the water a pin opens
// Your own catches and the species you noted on a saved water count as fish on record.
async function toneOf(e) {
  const f = e.S ? await factsFor(e) : { fish: new Map() };
  const yours = caughtOn(e) || String(e.saved?.species ?? '').trim();
  return pinTone({ lastPlant: f.lastPlant, fish: yours ? new Map([['yours', 1]]) : f.fish });
}

// While you're choosing a point on the map ("Lake here", home, a waypoint), a tap that lands on a pin is still a tap
// on the map: hand over the spot the finger touched, not the pin's own point.
const pickHere = ev => map.fire('click', { latlng: map.mouseEventToLatLng(ev.originalEvent) });

let run = 0, failed = false;
async function draw() {
  const me = ++run;
  pinsLayer.clearLayers();
  const on = map.hasLayer(pinsLayer);
  bar.classList.toggle('hidden', !on);
  if (!on || !map.getContainer().offsetWidth) return;
  if (stale) build();
  const z = map.getZoom(), view = map.getBounds(), near = view.pad(0.2);
  const shown = filter ? pins.filter(filter.keep) : pins;
  const count = shown.reduce((n, e) => n + view.contains([e.lat, e.lon]), 0);
  const loading = [...states.values()].includes(null);
  $('#pin-count').textContent = pins.length || !(loading || failed) ? filter?.count(count, shown.length) ?? `${count.toLocaleString()} water${count === 1 ? '' : 's'} in view`
    : loading ? 'Loading waters…' : 'The water lists didn’t download. Check your signal, then move the map.';
  document.dispatchEvent(new Event('tb-pins-drawn')); // the results drawer lists what is showing
  const waiting = [];
  for (const g of clusterPins(shown.filter(e => near.contains([e.lat, e.lon])), z)) {
    if (g.pins.length > 1) {
      const n = g.pins.length, size = n < 10 ? 30 : n < 100 ? 36 : 44;
      L.marker([g.lat, g.lon], { icon: L.divIcon({ className: 'pin-bubble', html: `<span>${n.toLocaleString()}</span>`, iconSize: [size, size] }), title: `${n} waters`, keyboard: false })
        .on('click', ev => {
          if (isPicking()) return pickHere(ev);
          // Waters no zoom can pull apart are offered as a list.
          if (samePlace(g.pins) || z >= map.getMaxZoom()) chooser(g.pins.map(target));
          else map.fitBounds(L.latLngBounds(g.pins.map(p => [p.lat, p.lon])), { maxZoom: z + 3, padding: [50, 50] });
        }).addTo(pinsLayer);
      continue;
    }
    const e = g.pins[0], known = filter?.tone(e) ?? tones.get(toneKey(e));
    const m = L.marker([e.lat, e.lon], { icon: pinIcon(e, known ?? 'wait'), title: e.name, keyboard: false, zIndexOffset: e.saved ? 500 : 0 })
      .on('click', ev => isPicking() ? pickHere(ev) : preview(target(e))).addTo(pinsLayer);
    if (!known) waiting.push([e, m]);
  }
  // Colors for the pins that don't have one yet, a few at a time so the map stays smooth. A newer draw drops the rest.
  let t0 = performance.now();
  for (const [e, m] of waiting) {
    const tone = await toneOf(e);
    if (me !== run) return;
    tones.set(toneKey(e), tone);
    m.getElement()?.classList.replace('tone-wait', `tone-${tone}`);
    if (performance.now() - t0 > 12) { await tick(); if (me !== run) return; t0 = performance.now(); }
  }
}

export { draw as redrawPins, loadStates as loadPinStates };

// ---------- Your lakes and catches ----------
async function readMine() {
  const [saved, catches] = await Promise.all([db.all('lakes'), db.all('catches')]);
  const caught = new Map();
  for (const c of catches) if (c.lakeId) caught.set(c.lakeId, (caught.get(c.lakeId) ?? 0) + 1);
  mine = { saved, caught };
  tones.clear(); stale = true; draw();
}
document.addEventListener('tb-lakes-changed', readMine);

// ---------- On and off, the count and the key ----------
$('#pin-key').innerHTML = `<span><i class="pin-dot tone-fresh"></i>Stocked lately</span><span><i class="pin-dot tone-fish"></i>Fish on record</span><span><i class="pin-dot tone-none"></i>No fish records yet</span><span>★ Saved</span><span><i class="pin-dot caught"></i>You've caught fish here</span>
  <div class="muted">${esc('Stocked lately: planted in the last 30 days, or a plant is coming. Fish on record: state stocking reports, USGS records of introduced fish, or your own catches. A grey pin may still hold fish that were never stocked or recorded.')}</div>`;
$('#pin-key-btn').onclick = e => { const shown = $('#pin-key').classList.toggle('hidden'); e.currentTarget.setAttribute('aria-expanded', !shown); };
chip.addEventListener('click', () => map.hasLayer(pinsLayer) ? map.removeLayer(pinsLayer) : map.addLayer(pinsLayer));
// With the pins on they stand for your lakes too (a star), so the plain "My lakes" markers step aside.
const sync = () => {
  const on = map.hasLayer(pinsLayer);
  chip.classList.toggle('on', on);
  map.getContainer().classList.toggle('pins-on', on);
  if (on && map.hasLayer(lakeLayer)) map.removeLayer(lakeLayer);
};
map.on('overlayadd overlayremove', e => {
  if (e.layer !== pinsLayer) return;
  const on = e.type === 'overlayadd';
  try { localStorage.setItem(KEY, on ? '1' : '0'); } catch {}
  if (!on && !map.hasLayer(lakeLayer)) map.addLayer(lakeLayer);
  sync(); loadStates(); draw();
});
map.on('moveend', () => { loadStates(); draw(); });
onShow('map', () => setTimeout(() => { loadStates(); draw(); }, 60));
let off = false;
try { off = localStorage.getItem(KEY) === '0'; } catch {}
if (!off) pinsLayer.addTo(map);
sync();
readMine();
