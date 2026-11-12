// Filters on the map: the pins narrow to the waters that pass the same settings the "Where should I go?" list uses
// (water-filter.js). The map shows every pin until you filter here: a switch kept on this phone says whether the
// shared settings hide pins. Adds the Filters sheet, the chips for what is on, the distance ring and the
// "Stocked lately" quick chip.
import { map, pickPoint } from './map.js';
import { $, esc, showView, status, onShow } from './ui.js';
import { quickPass, active, needsFacts, needsWeather, off } from './water-filter-core.js';
import { wxPass } from './weather-grid-core.js';
import { weatherStage, CAP } from './weather-grid.js';
import { prefs, savePrefs, home, setHomePoint, origin, context, shape, passes, mapFilterOn, setMapFilter } from './water-filter.js';
import { filterForm, bindFilterForm, syncForm, chipLabel, fmtMiles } from './views/filter-form.js';
import { renderFinder } from './views/finder.js';
import { pinsLayer, setPinFilter, pinList, pinsSettled, redrawPins, loadPinStates } from './map-pins.js';

let on = mapFilterOn();
const setOn = v => { on = v; setMapFilter(v); };

const sheet = $('#filter-sheet'), form = sheet.querySelector('.filter-body'), chipsEl = $('#filter-chips'), noteEl = $('#filter-note');
const quickChip = $('#map-chips [data-chip=stocked-lately]');
const tick = () => new Promise(r => setTimeout(r));

// ---------- Which pins pass ----------
let P = prefs(), from = null, fromKey = '', fromAt = 0, ctx = null;
// A fix on where you are is good for a few minutes, then asked for again: you may have driven on.
const moved = () => from?.label === 'where you are' && Date.now() - fromAt > 5 * 60e3;
// One question at a time: a second pass that needs the same origin waits for the first one's answer.
let asking = null;
const ask = key => (asking?.key === key ? asking : asking = { key, answer: origin(P).finally(() => { asking = null; }) }).answer;
let token = 0, work = null; // work: 'origin' while finding where distance starts, 'quick' and then { checked, total } while checking waters
const verdicts = new Map(), noSize = new Set(); // per pin, for the settings as they are now
// The weather filter runs last, on the pins that pass everything else: { grade, line } per pin, null when there is no
// forecast for it (it stays), nothing yet when its square hasn't been asked for (it waits).
const wx = new Map();
let wxInfo = { beyond: 0, saved: false };
// Squares that may still be asked for, for these settings and this ring or view: however many passes it takes (waters
// arrive state by state), one view asks for no more than the cap.
let wxLeft = CAP, wxFor = '';
const wxOk = k => !P.wx || (wx.has(k) && wxPass(wx.get(k)?.grade, P.wx));
const vkey = e => `${e.key}|${e.saved?.id ?? ''}`; // a pin learns late that it stands for a water you saved
const filtering = () => on && map.hasLayer(pinsLayer);
const ringOn = () => !!(filtering() && from && P.miles);
const ringBounds = () => L.latLng(from.lat, from.lon).toBounds(2 * P.miles * 1609.344);

// Work out the pins again. `reset`: the settings, your lakes or your catches changed, so nothing known still holds;
// otherwise only pins not yet looked at are checked (more waters arrived). `fitNext`: then show the ring, or those points.
let waiting = null, fitNext = null; // asked for while the map was off screen: done when it shows
async function refresh(reset = true) {
  // Off screen nothing is worked out (and your location isn't asked for) until the map is shown.
  if (!map.getContainer().offsetWidth) { waiting = !!waiting || reset; return; }
  const me = ++token;
  P = prefs();
  if (reset) { verdicts.clear(); noSize.clear(); wx.clear(); wxInfo = { beyond: 0, saved: false }; }
  work = null;
  if (!filtering()) { paint(); return redrawPins(); }
  // Where distance is measured from. Asked again when the choice or home changes, or when it couldn't be had last time.
  const key = P.miles ? `${P.from}|${JSON.stringify(home())}` : '';
  if (!ctx || key !== fromKey || (reset && key && (!from || moved()))) {
    work = 'origin'; paint(); redrawPins();
    const [f, c] = await Promise.all([key ? ask(key) : null, ctx ?? context()]);
    if (me !== token) return;
    from = f; fromKey = key; fromAt = Date.now(); ctx = c;
  }
  if (fitNext) { const fit = fitNext; fitNext = null; const b = ringOn() ? ringBounds() : fit.length ? L.latLngBounds(fit) : null; if (b) map.fitBounds(b, { paddingTopLeft: [16, 150], paddingBottomRight: [16, 24], animate: false, maxZoom: 13 }); }
  loadPinStates(); // the states under the ring
  // The checks that need no lookups settle most pins at once; the rest are looked up, nearest the middle of the map first.
  const quick = { from, iced: ctx.iced }, facts = needsFacts(P), todo = [];
  let t0 = performance.now(), drawn = t0;
  for (const e of pinList()) {
    const k = vkey(e);
    if (verdicts.has(k)) continue;
    const q = quickPass(shape(e), P, quick);
    if (q.unknown) noSize.add(k);
    if (!q.ok || !facts) verdicts.set(k, q.ok); else todo.push(e);
    if (performance.now() - t0 > 12) { if (work !== 'quick') { work = 'quick'; redrawPins(); } await tick(); if (me !== token) return; t0 = performance.now(); } // the ice estimate takes a moment per water
  }
  const c = map.getCenter(), far = e => (e.lat - c.lat) ** 2 + (e.lon - c.lng) ** 2;
  todo.sort((a, b) => far(a) - far(b));
  work = todo.length ? { checked: 0, total: todo.length } : null;
  paint(); redrawPins();
  t0 = drawn = performance.now();
  for (const e of todo) {
    const hit = await passes(e, P, ctx).catch(() => false);
    if (me !== token) return;
    verdicts.set(vkey(e), hit); work.checked++;
    if (performance.now() - t0 > 12) { // a few at a time, so the map stays smooth; pins appear as they pass
      if (performance.now() - drawn > 400) { redrawPins(); drawn = performance.now(); }
      await tick(); if (me !== token) return; t0 = performance.now();
    }
  }
  // Weather, where a pin passed the rest: every such pin under a distance ring, else the ones on screen (moving the
  // map asks for more), nearest first and capped (weather-grid.js).
  if (needsWeather(P)) {
    const view = map.getBounds().pad(0.2), ring = ringOn();
    const items = pinList().filter(e => verdicts.get(vkey(e)) === true && !wx.has(vkey(e)) && (ring || view.contains([e.lat, e.lon]))).map(e => ({ lat: e.lat, lon: e.lon, acres: shape(e).acres, e }));
    const px = map.project(c, map.getZoom()); // the view to within a thumb's width: the map settling into its size isn't a move
    const asksFor = JSON.stringify(P) + (ring ? `|${from.lat},${from.lon}` : `|${map.getZoom()}|${Math.round(px.x / 64)}|${Math.round(px.y / 64)}`);
    if (asksFor !== wxFor) { wxFor = asksFor; wxLeft = CAP; }
    if (items.length) {
      work = 'weather'; paint(); redrawPins();
      // The allowance is taken before asking, so a pass that starts meanwhile can't spend it twice. That pass then
      // finds nothing to ask with, so when this one is no longer the latest it calls for one more, which grades from
      // the forecasts that just arrived.
      const cap = wxLeft;
      wxLeft = 0;
      const st = await weatherStage(items, P, ring ? from : { lat: c.lat, lon: c.lng }, { cap });
      wxLeft += cap - st.asked;
      if (me !== token) return later(false);
      for (const it of items) if (st.grades.has(it)) wx.set(vkey(it.e), st.grades.get(it));
      wxInfo = { beyond: st.beyond, saved: st.saved || wxInfo.saved };
    }
  }
  if (work) { work = null; paint(); redrawPins(); }
}
// Several reasons to look again can arrive together (a state's waters, your lakes): one pass covers them.
let queued = null;
function later(reset) {
  if (queued == null) setTimeout(() => { const r = queued; queued = null; refresh(r); });
  queued = !!queued || reset;
}

const said = $('#filter-status');
setPinFilter({
  keep: e => !filtering() || (verdicts.get(vkey(e)) === true && wxOk(vkey(e))),
  // With the weather filter on, a pin's color is its weather on the picked day.
  tone: e => filtering() && P.wx ? { good: 'wx-good', fair: 'wx-fair' }[wx.get(vkey(e))?.grade] ?? null : null,
  // What the bar reads while the map is filtered; the sheet shows the same line.
  count(inView, all) {
    const text = !on ? null : work === 'origin' ? 'Finding where you are…' : work === 'quick' ? 'Checking waters…' : work === 'weather' ? 'Checking the weather…'
      : work ? `Checking ${work.checked.toLocaleString()} of ${work.total.toLocaleString()} waters…`
      : !pinsSettled() ? 'Loading waters…'
      : ringOn() ? `${all.toLocaleString()} water${all === 1 ? ' matches' : 's match'} within ${fmtMiles(P.miles)}`
      : `${inView.toLocaleString()} matching water${inView === 1 ? '' : 's'} in view`;
    said.textContent = text ?? 'The map is showing every water.';
    return text;
  },
  also: () => ringOn() ? ringBounds() : null,
  changed: () => { if (on) later(false); },
});

// ---------- The ring, the chips for what's on, and the note under them ----------
const ringLayer = L.layerGroup();
const keyWx = Object.assign(document.createElement('div'), { className: 'pin-key-wx hidden',
  innerHTML: '<span><i class="pin-dot tone-wx-good"></i>Good weather</span><span><i class="pin-dot tone-wx-fair"></i>Fair weather</span><div class="muted">With the weather filter on, a pin\'s color is the weather on the day you picked, for your craft.</div>' });
$('#pin-key').prepend(keyWx);
function paint() {
  ringLayer.clearLayers();
  if (ringOn()) {
    L.circle([from.lat, from.lon], { radius: P.miles * 1609.344, className: 'filter-ring', color: '#fff', weight: 2.5, dashArray: '7 7', fill: false, interactive: false }).addTo(ringLayer);
    L.circleMarker([from.lat, from.lon], { radius: 5, className: 'filter-origin', color: '#fff', weight: 2, fillColor: '#14352e', fillOpacity: 1, interactive: false }).addTo(ringLayer);
    ringLayer.addTo(map);
  } else ringLayer.remove();
  chipsEl.classList.toggle('hidden', !on);
  chipsEl.innerHTML = on ? active(P).map(k => `<button type="button" data-off="${k}" aria-label="Remove filter: ${esc(chipLabel(k, P, from))}">${esc(chipLabel(k, P, from))} <span aria-hidden="true">✕</span></button>`).join('') + '<button type="button" id="filter-clear">Clear</button>' : '';
  const left = on && (P.size.length || P.elev.length) ? pinList().filter(e => noSize.has(vkey(e))).length : 0;
  const noWx = on && P.wx ? pinList().filter(e => verdicts.get(vkey(e)) === true && wx.get(vkey(e)) === null).length : 0;
  const notes = [on && P.miles && work !== 'origin' && ctx && !from && "Location is off, so distance isn't applied", left && `${left.toLocaleString()} left out: no size or elevation on record`,
    noWx && `No forecast for ${noWx.toLocaleString()} water${noWx === 1 ? '' : 's'}, so weather isn't applied to them`, on && P.wx && wxInfo.beyond && 'Weather is checked for the nearest 300 areas. Zoom in, or shorten the distance', on && P.wx && wxInfo.saved && 'Using forecasts saved earlier'].filter(Boolean);
  keyWx.classList.toggle('hidden', !(on && P.wx));
  noteEl.textContent = notes.join('. ');
  noteEl.classList.toggle('hidden', !notes.length);
  quickChip.classList.toggle('on', filtering() && P.stocked);
  $('#pin-filters').classList.toggle('on', on);
  $('#filter-use').classList.toggle('hidden', on);
}

// Any change made here starts filtering the map. `viaChip`: it was the quick chip alone that switched filtering on,
// so switching the chip off again brings every pin back.
let viaChip = false;
function changed() { viaChip = false; setOn(true); syncForm(form); refresh(); }
chipsEl.onclick = e => {
  if (e.target.closest('#filter-clear')) { viaChip = false; setOn(false); return refresh(); } // the settings stay for next time
  const b = e.target.closest('[data-off]');
  if (b) { savePrefs(off(b.dataset.off)); changed(); }
};
quickChip.addEventListener('click', () => {
  const want = !(filtering() && prefs().stocked);
  savePrefs({ stocked: want });
  if (!want && viaChip) { viaChip = false; setOn(false); syncForm(form); return refresh(); }
  const was = on;
  if (!map.hasLayer(pinsLayer)) map.addLayer(pinsLayer);
  changed(); viaChip = want && !was;
});

// ---------- The Filters sheet, List, and "Show on map" from the list ----------
const closeSheet = () => sheet.classList.add('hidden');
$('#pin-filters').onclick = () => {
  form.innerHTML = filterForm(prefs());
  bindFilterForm(form, changed, { setHome() {
    closeSheet();
    status('Tap the map where home is');
    pickPoint(({ lat, lng }) => { setHomePoint({ lat, lon: lng }); savePrefs({ from: 'home' }); changed(); });
  } });
  form.scrollTop = 0;
  sheet.classList.remove('hidden');
};
$('#filter-done').onclick = closeSheet;
$('#filter-use').onclick = changed;
$('#pin-list').onclick = () => { closeSheet(); showView('lakes', { render: false }); renderFinder(); };
document.addEventListener('tb-show-on-map', e => {
  viaChip = false; setOn(true);
  if (!map.hasLayer(pinsLayer)) map.addLayer(pinsLayer);
  fitNext = e.detail?.points ?? []; waiting = true;
  showView('map');
});
onShow('map', () => setTimeout(() => { // once the map has its size
  if (waiting != null) { const r = waiting; waiting = null; refresh(r); } else if (on && moved()) refresh();
}, 80));

map.on('overlayadd overlayremove', e => { if (e.layer === pinsLayer && on) later(false); });
// With no ring the weather is checked for what's on screen: moving the map asks for the rest.
map.on('moveend', () => { if (filtering() && P.wx && !ringOn()) later(false); });
document.addEventListener('tb-craft', () => { if (on && P.wx) later(true); }); // the craft changed somewhere in the app
document.addEventListener('tb-lakes-changed', () => { ctx = null; if (on) later(true); });
paint();
if (on) later(true);
