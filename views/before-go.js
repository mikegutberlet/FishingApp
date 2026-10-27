// Before you go: a checklist for one water and one day. The right license for the state (and waters that take
// either state's), boat inspections, passes, bear canisters for a night out, layers from the forecast, the lures that
// worked on days like this, whether the map is saved for offline, last trip's "next time" note, and your own items.
// Ticks are kept on this device for the day; nothing here leaves it (the forecast is for the water, as everywhere).
import { db } from '../db.js';
import { forLake } from '../states/index.js';
import { isRiver } from '../states/common.js';
import { moonPhase, WEATHER_CODES } from '../data-sources.js';
import { weatherFor, localKey, addDays } from '../forecast.js';
import { analyze } from '../insights.js';
import { listPacks, packId, offlineDialog } from '../offline.js';
import { cached as campingCached } from '../camping.js';
import { $, esc, fmtDate, showView, status } from '../ui.js';
import { toDepth, units } from '../units.js';
import { SHARED_WATERS, LICENSE, BOAT_STATE, BOAT_WATERS, PASS_WATERS, PASS_UNITS, BEAR_UNITS, BEAR_DEFAULT } from '../trip-rules.js';
import { lastNextTime, nextTimeHtml } from './debrief.js';
import { tackleLabel } from './tackle.js';

const TICKS = 'tb-go-ticks', PREFS = 'tb-go-prefs';
const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const STATE_NAME = { CA: 'California', NV: 'Nevada', OR: 'Oregon', WA: 'Washington', ID: 'Idaho' };
const SUGGEST = { day: ['Rods and reels', 'Net', 'Pliers and line clippers', 'Polarized sunglasses', 'Sunscreen', 'Water and snacks', 'Phone charger'],
  night: ['Headlamp', 'Sleeping bag and pad', 'Stove and fuel', 'Cooler and ice', 'First aid kit', 'Camp chair'] };

// Which state's license works here: the water's own state, or either one on a shared water.
export function licenseStates(lake) {
  const S = forLake(lake);
  const shared = SHARED_WATERS.find(w => S && w.states.includes(S.code) && w.re.test(String(lake.name ?? '')));
  return { S, shared, ok: shared?.also ?? (S ? [S.code] : []) };
}

async function licenseSection(lake, day) {
  const { S, shared, ok } = licenseStates(lake);
  if (!S) return [{ id: 'lic', text: 'Check which state’s license this water needs: it is outside California, Nevada and Oregon.' }];
  const rules = LICENSE[S.code];
  const mine = (await db.all('licenses')).filter(r => r.kind === 'license' && ok.includes(r.state || 'CA'));
  const good = mine.filter(r => !r.date || r.date >= day).sort((a, b) => (b.date ?? '9').localeCompare(a.date ?? '9'))[0];
  const old = mine.filter(r => r.date && r.date < day).sort((a, b) => b.date.localeCompare(a.date))[0];
  const names = ok.map(c => STATE_NAME[c]).join(' or ');
  const items = [{
    id: 'lic', tone: good ? 'good' : 'warn', done: !!good,
    text: good ? `${STATE_NAME[good.state || 'CA']} fishing license saved${good.date ? `, good until ${fmtDate(good.date)}` : ''}.`
      : old ? `Your saved ${STATE_NAME[old.state || 'CA']} license ran out on ${fmtDate(old.date)}. You need a ${names} license (age ${rules.age} and up).`
      : `You need a ${names} fishing license (age ${rules.age} and up). None is saved on this phone.`,
    more: `${good ? '' : `<a href="${esc(rules.buy)}" target="_blank" rel="noopener">Buy a ${STATE_NAME[S.code]} license ↗</a> · `}<a href="#" data-go="settings">Your licenses in Settings</a>`,
  }];
  if (shared) items.push({ id: 'lic-shared', text: shared.text, tone: 'info' });
  const sturgeon = /sturgeon/i.test(String(lake.species ?? ''));
  for (const [i, x] of rules.extras.entries()) if (x.when === 'always' || (x.when === 'river' && isRiver(lake)) || (x.when === 'sturgeon' && sturgeon)) items.push({ id: `lic-x${i}`, text: x.text });
  return items;
}

function boatSection(lake) {
  const S = forLake(lake);
  const items = [];
  const here = BOAT_WATERS.filter(w => w.re.test(String(lake.name ?? '')));
  for (const [i, w] of here.entries()) items.push({ id: `boat-w${i}`, text: w.text, tone: 'warn' });
  if (S && BOAT_STATE[S.code]) items.push({ id: 'boat-st', text: BOAT_STATE[S.code] });
  items.push({ id: 'boat-cdd', text: 'Clean, drain and dry the boat, trailer and gear (live well, bilge, waders) before and after.' });
  return items;
}

// Land units around the water from the Camping tab's lookup (kept on the device), for passes and bear rules.
async function landUnits(lake) {
  const c = await campingCached(lake).catch(() => null);
  return c ? (c.land?.parcels ?? []).map(p => p.unit).filter(Boolean) : null;
}

function passSection(lake, units_) {
  const items = PASS_WATERS.filter(w => w.re.test(String(lake.name ?? ''))).map((w, i) => ({ id: `pass-w${i}`, text: w.text, tone: 'warn' }));
  for (const [i, rule] of PASS_UNITS.entries()) {
    const unit = (units_ ?? []).find(u => rule.re.test(u));
    if (unit && !items.length) items.push({ id: `pass-u${i}`, text: rule.text(unit) });
  }
  return items;
}

function bearSection(units_) {
  if (units_ == null) return [{ id: 'bear', text: `${BEAR_DEFAULT} Open this water’s Camping tab once with signal to check the land around it for canister rules.` }];
  const hits = BEAR_UNITS.map(rule => ({ rule, unit: units_.find(u => rule.re.test(u)) })).filter(x => x.unit);
  return hits.length ? hits.map((x, i) => ({ id: `bear-${i}`, text: x.rule.text(x.unit), tone: x.rule.level === 'required' ? 'warn' : '' })) : [{ id: 'bear', text: BEAR_DEFAULT }];
}

// Clothes for the day's forecast (°F, like the forecast screens).
function layersFrom(w, day, overnight) {
  const i = w.daily.time.indexOf(day);
  if (i < 0) return [];
  const d = k => w.daily[k][i];
  const rise = Date.parse(d('sunrise'));
  const j = w.hourly.time.findIndex(t => Date.parse(t) >= rise - 1800e3);
  const dawn = j >= 0 ? w.hourly.temperature_2m[j] : d('temperature_2m_min');
  const hi = d('temperature_2m_max'), lo = d('temperature_2m_min'), wind = d('wind_speed_10m_max'), gust = d('wind_gusts_10m_max'), rain = d('precipitation_probability_max') ?? 0, code = d('weather_code');
  // A forecast saved for no signal says how old it is.
  const age = w.saved && w.fetchedAt ? ` (saved forecast, ${Math.max(1, Math.round((Date.now() - w.fetchedAt) / 3600e3))} h old)` : '';
  const out = [{ id: 'wx', tone: 'info', text: `${WEATHER_CODES[code] ?? 'Forecast'}${age}: ${Math.round(dawn)}° at dawn, high ${Math.round(hi)}°, wind to ${Math.round(wind)} mph${gust >= wind + 8 ? ` (gusts ${Math.round(gust)})` : ''}${rain >= 20 ? `, ${rain}% chance of rain` : ''}.` }];
  if (dawn <= 40) out.push({ id: 'wx-cold', text: `Warm layers, beanie and gloves: about ${Math.round(dawn)}° at dawn.` });
  else if (dawn <= 55) out.push({ id: 'wx-cool', text: `A warm layer for the morning (${Math.round(dawn)}° at dawn).` });
  if (rain >= 40 || (code >= 51 && code < 95)) out.push({ id: 'wx-rain', text: `Rain jacket${rain ? ` (${rain}% chance)` : ''}.` });
  if (wind >= 12 || gust >= 20) out.push({ id: 'wx-wind', text: `A windbreaker: wind to ${Math.round(wind)} mph, gusts ${Math.round(gust)}.` });
  if ([71, 73, 75, 77, 85, 86].includes(code)) out.push({ id: 'wx-snow', text: 'Snow in the forecast: boots, traction and chains in the car.', tone: 'warn' });
  if (code >= 95) out.push({ id: 'wx-storm', text: 'Thunderstorms in the forecast: plan to be off the water when they build.', tone: 'warn' });
  if (hi >= 85) out.push({ id: 'wx-hot', text: `Sun hat, sunscreen and extra water (high ${Math.round(hi)}°).` });
  else if (code <= 2) out.push({ id: 'wx-sun', text: 'Polarized sunglasses and sunscreen.' });
  if (overnight) {
    const lo2 = w.daily.temperature_2m_min[i + 1] ?? lo;
    out.push({ id: 'wx-night', text: `Night down to about ${Math.round(Math.min(lo, lo2))}°: a sleeping bag rated below that.` });
  }
  return out;
}

const doy = t => { const d = new Date(t); return (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(d.getFullYear(), 0, 0)) / 864e5; };

// The lures that worked on your days most like this one (same season, moon, weather and water).
async function luresSection(lake, day, w) {
  const [catches, tackle] = await Promise.all([db.all('catches'), db.all('tackle')]);
  if (!catches.length) return { items: [], note: 'Log a few catches and this lists the lures that worked on days like this.' };
  const t = Date.parse(day + 'T07:00');
  const ref = { lakeId: lake.id, doy: doy(t), hour: 7, moon: moonPhase(new Date(t)).fraction };
  const i = w?.daily.time.indexOf(day) ?? -1;
  if (i >= 0) Object.assign(ref, { airTemp: (w.daily.temperature_2m_max[i] + w.daily.temperature_2m_min[i]) / 2, wind: w.daily.wind_speed_10m_max[i] });
  const a = analyze(catches, ref, { tackle });
  if (!a.lures.length) return { items: [], note: a.rows.length ? 'Your catches on days like this have no lure logged.' : 'None of your catches came on a day much like this yet.' };
  const box = Object.fromEntries(tackle.map(x => [tackleLabel(x), x]));
  const items = a.lures.map((l, k) => {
    const item = box[l.k];
    return { id: `lure-${k}`, text: `${l.k}: ${l.n} fish on days like this${item?.qty === 0 ? ' · none left in your box' : item?.qty != null ? ` · ${item.qty} in your box` : ''}`, tone: item?.qty === 0 ? 'warn' : '' };
  });
  const depth = a.depths[0] ? ` Most at ${a.depths[0].k.split('–').map(v => toDepth(+v)).join('–')} ${units().depth}.` : '';
  return { items, note: `${a.rows.length} catches on similar days (${a.species.map(s => s.k).slice(0, 2).join(', ')}).${depth}` };
}

async function offlineItem(lake) {
  const p = (await listPacks().catch(() => [])).find(x => x.id === packId(lake));
  return p ? { id: 'offline', done: true, tone: 'good', text: `Map saved for offline (${fmtDate(p.savedAt)}).` }
    : { id: 'offline', tone: 'warn', text: 'Map not saved for offline. Save it while you have signal.', more: '<a href="#" data-go-offline>Save for offline</a>' };
}

let back = null;
const goBack = () => typeof back === 'function' ? back() : showView(back);
export async function openChecklist(lakeId, day = localKey(), { from = 'today' } = {}) {
  back = from;
  showView('trip', { render: false });
  const el = $('#trip');
  const lakes = (await db.all('lakes')).sort((a, b) => a.name.localeCompare(b.name));
  const lake = lakes.find(l => l.id === lakeId) ?? lakes[0];
  if (!lake) { el.innerHTML = `<button id="go-back">‹ Back</button><h2>Before you go</h2><div class="card">Save a water first: tap its name on the map, then <b>Save to my lakes</b>.</div>`; $('#go-back').onclick = goBack; return; }
  const prefs = read(PREFS, {});
  const overnight = !!prefs.overnight, boat = !!prefs.boat;
  const days = Array.from({ length: 10 }, (_, k) => localKey(addDays(Date.now(), k)));
  if (!days.includes(day)) day = days[0];
  const dayName = k => k === days[0] ? 'Today' : k === days[1] ? 'Tomorrow' : new Date(k + 'T12:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
  el.innerHTML = `<button id="go-back">‹ Back</button><h2>📋 Before you go</h2>
    <form class="card form go-head" id="go-head">
      <label>Where <select name="lake">${lakes.map(l => `<option value="${esc(l.id)}" ${l.id === lake.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>
      <label>When <select name="day">${days.map(k => `<option value="${k}" ${k === day ? 'selected' : ''}>${dayName(k)}</option>`).join('')}</select></label>
      <div class="row"><label class="check"><input type="checkbox" name="overnight" ${overnight ? 'checked' : ''}> Staying overnight</label><label class="check"><input type="checkbox" name="boat" ${boat ? 'checked' : ''}> Bringing a boat</label></div>
    </form>
    <div id="go-next"></div><div id="go-list"><p class="muted">Checking…</p></div>`;
  $('#go-back').onclick = goBack;
  const head = $('#go-head');
  head.onchange = () => {
    write(PREFS, { overnight: head.overnight.checked, boat: head.boat.checked });
    openChecklist(head.lake.value, head.day.value, { from: back });
  };
  $('#go-next').innerHTML = nextTimeHtml(await lastNextTime(lake.id));
  const w = await weatherFor(lake.lat, lake.lon).catch(() => null);
  const units_ = await landUnits(lake);
  const [license, lures, offline, mine] = await Promise.all([licenseSection(lake, day), luresSection(lake, day, w), offlineItem(lake), db.all('checklist')]);
  const own = mine.filter(x => (!x.lakeId || x.lakeId === lake.id) && (!x.overnight || overnight)).sort((a, b) => (a.lakeId ? 1 : 0) - (b.lakeId ? 1 : 0) || a.text.localeCompare(b.text));
  const sections = [
    ['🪪 License', license],
    ...(boat ? [['🚤 Boat', boatSection(lake)]] : []),
    ['🎟️ Passes and permits', passSection(lake, units_), units_ == null ? 'Open this water’s Camping tab once with signal and this checks the forest around it for passes.' : 'No pass known for this water. Posted signs at the parking area have the final word.'],
    ...(overnight ? [['🐻 Food and bears', bearSection(units_)]] : []),
    ['🧥 Layers for the forecast', w ? layersFrom(w, day, overnight) : [], w ? '' : 'Forecast not available (offline?). Check it before you leave.'],
    ['🎣 What worked on days like this', lures.items, lures.note],
    ['📶 No signal out there?', [offline]],
    ['🎒 My items', own.map(x => ({ id: `own-${x.id}`, text: x.text, own: x, tag: x.lakeId ? 'this water' : x.overnight ? 'overnight' : '' }))],
  ];
  const ticks = read(TICKS, {}), key = `${lake.id}|${day}`;
  // Keep two weeks of ticks.
  for (const k of Object.keys(ticks)) if (k.split('|')[1] < localKey(addDays(Date.now(), -14))) delete ticks[k];
  const ticked = new Set(ticks[key] ?? []);
  const item = x => `<label class="go-item ${x.tone ?? ''}"><input type="checkbox" data-tick="${esc(x.id)}" ${ticked.has(x.id) || x.done ? 'checked' : ''}>
    <span>${esc(x.text)}${x.tag ? ` <span class="pill">${esc(x.tag)}</span>` : ''}${x.more ? `<br><span class="small">${x.more}</span>` : ''}${x.own ? ` <a href="#" class="small danger" data-rm-own="${esc(x.own.id)}">remove</a>` : ''}</span></label>`;
  $('#go-list').innerHTML = sections.map(([title, items, note]) => `<div class="card go-sec"><h3>${title}</h3>${items.map(item).join('')}${note && (!items.length || title.includes('worked')) ? `<p class="muted small">${esc(note)}</p>` : ''}
      ${title.includes('My items') ? `<form class="row" id="go-add"><input name="text" placeholder="Add an item" autocomplete="off" style="flex:1"><select name="scope" aria-label="For"><option value="all">Every trip</option><option value="lake">This water</option><option value="night">Overnight trips</option></select><button>Add</button></form>
        <div class="pick-chips">${SUGGEST[overnight ? 'night' : 'day'].filter(s => !mine.some(x => x.text.toLowerCase() === s.toLowerCase())).map(s => `<button type="button" data-suggest="${esc(s)}">+ ${esc(s)}</button>`).join('')}</div>` : ''}</div>`).join('')
    + `<p class="muted small">Rules here are kept by hand for the waters and forests listed in the app and change from year to year: posted signs and the agency have the final word.</p>`;
  const list = $('#go-list');
  list.querySelectorAll('[data-tick]').forEach(b => b.onchange = () => {
    const now = read(TICKS, {}); const set = new Set(now[key] ?? []);
    b.checked ? set.add(b.dataset.tick) : set.delete(b.dataset.tick);
    now[key] = [...set]; write(TICKS, now);
  });
  const add = async (text, scope) => {
    if (!text.trim()) return;
    await db.put('checklist', { text: text.trim(), lakeId: scope === 'lake' ? lake.id : null, overnight: scope === 'night' });
    openChecklist(lake.id, day, { from: back });
  };
  $('#go-add').onsubmit = e => { e.preventDefault(); add(e.target.text.value, e.target.scope.value); };
  list.querySelectorAll('[data-suggest]').forEach(b => b.onclick = () => add(b.dataset.suggest, overnight && SUGGEST.night.includes(b.dataset.suggest) ? 'night' : 'all'));
  list.querySelectorAll('[data-rm-own]').forEach(a => a.onclick = async e => { e.preventDefault(); await db.del('checklist', a.dataset.rmOwn); status('Removed'); openChecklist(lake.id, day, { from: back }); });
  list.querySelector('[data-go-offline]')?.addEventListener('click', async e => { e.preventDefault(); await offlineDialog(lake); });
}
