// The one filter form: the "Where should I go?" list shows it in its card and the map shows it in a sheet. Every
// change is saved to the shared settings (water-filter.js) and handed to whoever is showing the form.
import { esc } from '../ui.js';
import { units } from '../units.js';
import { groupLabel } from '../game-plan.js';
import { ACCESS } from '../water-facts.js';
import { DEFAULTS } from '../water-filter-core.js';
import { prefs, savePrefs, home } from '../water-filter.js';
import { craftId, setCraft, craftSelect } from '../boat-weather.js';
import { dayLabel } from '../weather-grid.js';

const FISH = ['trout', 'kokanee', 'laker', 'largemouth', 'smallmouth', 'striper', 'crappie', 'panfish', 'catfish', 'walleye'];
// Kinds of trout, by the species list's names (species.js): "Cutthroat trout" also finds Lahontan, Paiute and the rest.
const KINDS = ['Rainbow trout', 'Brown trout', 'Brook trout', 'Cutthroat trout', 'Lahontan cutthroat trout', 'Golden trout', 'Tiger trout', 'Bull trout', 'Cutbow trout', 'Steelhead'];
const MILES = [10, 25, 50, 100, 200, 0];
const metric = () => units().depth === 'm';
export const fmtMiles = mi => mi ? (metric() ? `${Math.round(mi * 1.609)} km` : `${mi} mi`) : 'Any';
const fishLabel = g => KINDS.includes(g) ? g.replace(/ trout$/, '') : groupLabel(g);
const TYPE = { lake: 'Lakes', stream: 'Rivers & creeks' };
// The buckets are cut at 10 and 500 acres and at 4,000 and 7,000 ft (water-filter-core.js).
const SIZE = () => metric() ? { pond: 'Pond, under 4 ha', small: '4 to 200 ha', big: 'Over 200 ha' } : { pond: 'Pond, under 10 acres', small: '10 to 500 acres', big: 'Over 500 acres' };
const WX = { good: 'Good', fair: 'Good or fair' };
const LEVEL = { rising: 'Rising', steady: 'Steady', falling: 'Falling' };
const ELEV = () => metric() ? { low: 'Below 1,200 m', mid: '1,200 to 2,100 m', high: 'Above 2,100 m' } : { low: 'Below 4,000 ft', mid: '4,000 to 7,000 ft', high: 'Above 7,000 ft' };

// Left to itself, distance is measured from home when you've set one, else from where you are.
const fromOf = P => P.from === 'auto' ? (home() ? 'home' : 'me') : P.from;
const isOn = (P, k, v) => Array.isArray(P[k]) ? P[k].includes(v) : k === 'from' ? fromOf(P) === v : String(P[k]) === v;

export function filterForm(P = prefs()) {
  const chip = (k, v, label) => `<button type="button" data-k="${k}" data-v="${esc(v)}" aria-pressed="${isOn(P, k, String(v))}">${esc(label)}</button>`;
  const chips = (k, labels) => Object.entries(labels).map(([v, l]) => chip(k, v, l)).join('');
  const tick = (k, label) => `<label class="check"><input type="checkbox" data-opt="${k}" ${P[k] ? 'checked' : ''}> ${label}</label>`;
  return `<fieldset><legend>Fish I want</legend><div class="fd-chips">${FISH.map(g => chip('fish', g, fishLabel(g))).join('')}</div>
      <div class="fd-chips fd-kinds"><span class="muted small">Kind of trout</span>${KINDS.map(k => chip('fish', k, fishLabel(k))).join('')}</div></fieldset>
    <fieldset><legend>Getting on the water</legend><div class="fd-chips">${chips('access', ACCESS)}</div></fieldset>
    <fieldset><legend>How far</legend><div class="fd-chips">${MILES.map(m => chip('miles', m, fmtMiles(m))).join('')}</div>
      <div class="fd-chips fd-kinds"><span class="muted small">Measure from</span>${chip('from', 'me', 'Where I am')}${chip('from', 'home', 'Home')}<button type="button" class="fd-sethome" data-home>${home() ? 'Move home' : 'Set home'}</button></div></fieldset>
    <fieldset><legend>Weather</legend><div class="fd-chips">${[0, 1, 2, 3, 4, 5, 6, 7].map(n => chip('day', n, dayLabel(n))).join('')}</div>
      <div class="fd-chips fd-kinds"><span class="muted small">Keep waters where that day is</span>${chips('wx', WX)}</div>
      <label class="fd-craft">Graded for ${craftSelect()}</label>
      <div class="muted small">A good day has six hours in a row of wind your craft can take and no storms; a fair day has three. Needs a signal, or a forecast saved in the last two days.</div></fieldset>
    <fieldset><legend>Lake or stream</legend><div class="fd-chips">${chips('type', TYPE)}</div></fieldset>
    <fieldset><legend>Size</legend><div class="fd-chips">${chips('size', SIZE())}</div></fieldset>
    <fieldset><legend>Elevation</legend><div class="fd-chips">${chips('elev', ELEV())}</div></fieldset>
    <fieldset><legend>Lake level</legend><div class="fd-chips">${chips('level', LEVEL)}</div>
      <div class="muted small">Over the last week. Only waters with a level gauge can pass (about 230 reservoirs and lakes).</div></fieldset>
    ${tick('stocked', 'Stocked in the last 30 days or coming up')}
    ${tick('mine', "Only waters where I've logged a catch")}
    ${tick('saved', 'Only my saved waters')}
    ${tick('iceFree', 'Likely ice-free')}
    ${tick('noAlgae', 'Hide waters with a toxic algae advisory')}`;
}

// The form's controls as the settings have them now (after a change made somewhere else, such as a chip on the map).
export function syncForm(root, P = prefs()) {
  root.querySelectorAll('button[data-k]').forEach(b => b.setAttribute('aria-pressed', isOn(P, b.dataset.k, b.dataset.v)));
  root.querySelectorAll('input[data-opt]').forEach(el => { el.checked = !!P[el.dataset.opt]; });
  root.querySelectorAll('[data-home]').forEach(b => { b.textContent = home() ? 'Move home' : 'Set home'; });
  root.querySelectorAll('select[name=craft]').forEach(el => { el.value = craftId(); });
}

// `onChange(P, key)` runs after each change is saved. `setHome()` is how this screen lets you pick home on the map.
export function bindFilterForm(root, onChange, { setHome } = {}) {
  const apply = (patch, key) => { const P = savePrefs(patch); syncForm(root, P); onChange(P, key); };
  root.onclick = e => {
    if (e.target.closest('[data-home]')) return setHome?.();
    const b = e.target.closest('button[data-k]');
    if (!b) return;
    const { k, v } = b.dataset, P = prefs();
    if (k === 'from' && v === 'home' && !home()) return setHome?.(); // nowhere to measure from yet
    apply(Array.isArray(P[k]) ? { [k]: P[k].includes(v) ? P[k].filter(x => x !== v) : [...P[k], v] }
      : k === 'miles' || k === 'day' ? { [k]: +v } : k === 'from' ? { from: v }
      : { [k]: P[k] === v ? DEFAULTS[k] : v }, k); // a single choice: tap it again for "either"
  };
  root.onchange = e => {
    const el = e.target.closest('input[data-opt]');
    if (el) return apply({ [el.dataset.opt]: el.checked }, el.dataset.opt);
    // The craft is the app's one craft setting (boat-weather.js), not a filter of its own.
    if (e.target.matches('select[name=craft]')) { setCraft(e.target.value); onChange(prefs(), 'craft'); }
  };
}

// A filter that is on, as the short words of a chip. `from` is where distance is measured from (water-filter.js origin).
export function chipLabel(key, P, from) {
  const join = (labels, picked) => picked.map(v => labels[v] ?? v).join(', ');
  return { fish: () => P.fish.map(fishLabel).join(', '), access: () => join(ACCESS, P.access),
    miles: () => from ? `${fmtMiles(P.miles)} from ${from.label}` : `Within ${fmtMiles(P.miles)}`,
    stocked: () => 'Stocked lately', mine: () => 'My catches', saved: () => 'Saved', noAlgae: () => 'No algae advisories',
    type: () => TYPE[P.type], size: () => join(SIZE(), P.size), elev: () => join(ELEV(), P.elev), level: () => `Level: ${join(LEVEL, P.level)}`, iceFree: () => 'Likely ice-free',
    wx: () => `${WX[P.wx]} weather ${P.day ? dayLabel(P.day).split(' ')[0] : 'today'}` }[key]();
}
