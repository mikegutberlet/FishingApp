// Your day at a water, for your craft: the "Your day" card on Conditions (safe-hours strip, storm timing, trip-day
// weather), the day plan sheet (wake, leave-by, on the water, wind up, turnaround, as calendar alarms), the compact
// strip on Today and the planner, the weather-turning watch on the trip screen, and the river rising line.
// Drive time is typed once per water and kept on the water's record, so home never leaves the phone.
import { db } from '../db.js';
import { fetchUsgsNearby, haversineKm } from '../data-sources.js';
import { weatherFor, fetchAlerts, localKey, addDays, forecastAge } from '../forecast.js';
import { solunar, shortTime, windowLabel } from '../solunar.js';
import { cached as cachedAccess } from '../access-lookup.js';
import { sunTimes } from '../sun.js';
import { sendIcs } from '../ics.js';
import { $, esc, status } from '../ui.js';
import { CRAFTS, craftId, setCraft, craftSelect, limits, safeHours, stormTiming, stripHtml, dayCard, airQuality, dayAqi, weatherTurning, alertKey, crossTime, riverRise } from '../boat-weather.js';
import { isRiver } from '../states/common.js';

const dayLabel = (key, k) => { const d = new Date(key + 'T12:00'); return k === 0 ? 'Today' : k === 1 ? 'Tomorrow' : `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${d.getDate()}`; };
const dayKeys = n => Array.from({ length: n }, (_, k) => localKey(addDays(Date.now(), k)));
const lineHtml = l => `<li class="dw-line ${l.tone ?? ''}"><span>${l.icon}</span><span>${esc(l.text)}${l.note ? ` <span class="muted small">(${esc(l.note)})</span>` : ''}</span></li>`;
const round5 = t => Math.round(t / 3e5) * 3e5;

// Last light: civil dusk on the phone (sun.js), falling back to the forecast's sunset + 25 min.
const duskFor = (lake, date, w) => {
  const t = sunTimes(new Date(date + 'T12:00'), lake.lat, lake.lon).dusk;
  if (t) return t;
  const i = w?.daily.time.indexOf(date);
  return i >= 0 ? Date.parse(w.daily.sunset[i]) + 25 * 6e4 : null;
};

// ---------- Water temperature: your own reading first, then a USGS gauge on this water ----------
export async function waterTemp(lake) {
  if (lake.id && !lake.unsaved) {
    const [profiles, catches] = await Promise.all([db.byLake('tempProfiles', lake.id).catch(() => []), db.byLake('catches', lake.id).catch(() => [])]);
    const p = profiles.filter(x => x.date && Date.now() - Date.parse(x.date + 'T12:00') < 10 * 864e5 && x.readings?.length).sort((a, b) => b.date.localeCompare(a.date))[0];
    const top = p?.readings.filter(Array.isArray).slice().sort((a, b) => a[0] - b[0])[0]; // [depth ft, temp °F]
    if (top && Number.isFinite(+top[1])) return { f: +top[1], from: `your reading ${new Date(p.date + 'T12:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` };
    const c = catches.filter(x => Number.isFinite(+x.waterTemp) && x.waterTemp !== null && x.waterTemp !== '' && Date.now() - Date.parse(x.time) < 7 * 864e5).sort((a, b) => b.time.localeCompare(a.time))[0];
    if (c) return { f: +c.waterTemp, from: `logged ${new Date(c.time).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` };
  }
  if (navigator.onLine === false) return null;
  const sites = await fetchUsgsNearby(lake.lat, lake.lon, 0.1).catch(() => []);
  for (const s of sites) {
    const r = s.readings.find(x => x.code === '00010');
    if (r && s.distKm < 10 && Date.now() - Date.parse(r.time) < 2 * 864e5) return { f: r.value * 9 / 5 + 32, from: `USGS gauge ${s.distKm.toFixed(0)} km away` };
  }
  return null;
}

// The walk in and out from Getting there (its saved lookup), in minutes, or null when it's a drive to the water.
async function walkTimes(lake) {
  const a = await cachedAccess(lake).catch(() => null), st = a?.hike?.stats;
  return st && a.hike.km > 0.08 ? { in: Math.round(st.minIn), out: Math.round(st.minOut) } : null;
}

// ---------- The Conditions card ----------
export async function renderDayCard(lake, el, w) {
  const keys = dayKeys(Math.min(7, w.daily.time.filter(t => t >= localKey()).length));
  let picked = safeHours(w, keys[0], lake)?.hours.length ? 0 : 1; // after dark, tomorrow
  const [walk, water] = await Promise.all([walkTimes(lake), waterTemp(lake).catch(() => null)]);
  let aq = null;
  airQuality(lake.lat, lake.lon).then(a => { aq = a; if (el.isConnected) draw(); }).catch(() => {});
  const draw = () => {
    if (!el.isConnected) return;
    const date = keys[picked], id = craftId(), day = safeHours(w, date, lake, id);
    const extra = { aqi: dayAqi(aq, date), water: picked <= 1 ? water : null, dusk: duskFor(lake, date, w), walkOut: (lake.walkOutMin ?? walk?.out) || 0 };
    const lines = dayCard(w, date, lake, id, extra);
    el.innerHTML = `<div class="dw-head"><h3>Your day</h3>${craftSelect(id)}</div>
      <div class="tabs dw-days">${keys.map((k, i) => `<button type="button" data-d="${i}" class="${i === picked ? 'active' : ''}">${dayLabel(k, i)}</button>`).join('')}</div>
      ${day ? `<p class="dw-sum ${day.tone}"><b>${esc(day.lim.icon)} ${esc(day.summary)}</b></p>${stripHtml(day)}
        ${day.storm && !day.storm.past ? `<p class="dw-storm">⛈️ <b>${esc(day.storm.text)}</b></p>` : ''}
        <p class="muted small">Gust speed in each hour. Green is fine for ${esc(day.lim.a)}, amber is marginal (over ${day.lim.good} mph or gusts over ${day.lim.gGood}), red is off the water (over ${day.lim.max} / ${day.lim.gMax}, or storms)${day.lim.big ? '; a little stricter on big open water' : ''}.</p>` : '<p class="muted">No forecast for this day.</p>'}
      <ul class="dw-lines">${lines.map(lineHtml).join('')}</ul>
      ${w.saved ? `<p class="muted small">📴 From the forecast ${esc(forecastAge(w))}.</p>` : ''}
      ${aq?.saved ? `<p class="muted small">📴 Air quality saved ${esc(new Date(aq.savedAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric' }))}.</p>` : ''}
      <button type="button" class="primary dw-plan-btn">⏰ Plan my day: leave-by and turnaround alarms</button>`;
    el.querySelector('select').onchange = e => { setCraft(e.target.value); draw(); };
    el.querySelectorAll('[data-d]').forEach(b => b.onclick = () => { picked = +b.dataset.d; draw(); });
    el.querySelector('.dw-plan-btn').onclick = () => openDayPlan(lake, date);
  };
  draw();
  el.classList.remove('hidden');
}

// One line for Today and the planner: the craft's summary and a thin strip. On Today after dark, tomorrow's.
export function dayStripHtml(w, date, lake, { orTomorrow = false } = {}) {
  let day = safeHours(w, date, lake), when = '';
  if (!day?.hours.length && orTomorrow) { day = safeHours(w, localKey(addDays(Date.parse(date + 'T12:00'), 1)), lake); when = 'Tomorrow · '; }
  if (!day?.hours.length) return '';
  return `<div class="dw-mini"><span class="dw-sum ${day.tone}">${when}${esc(day.lim.icon)} ${esc(day.summary)}</span>${stripHtml(day, { compact: true })}${day.storm && !day.storm.past ? `<span class="dw-storm small">⛈️ ${esc(day.storm.text)}</span>` : ''}</div>`;
}

// ---------- The day plan ----------
// Bite windows worth building a morning or evening around: those that start in daylight (or within an hour of it).
function targets(lake, w, date) {
  const di = w.daily.time.indexOf(date), rise = Date.parse(w.daily.sunrise[di]), set = Date.parse(w.daily.sunset[di]);
  const sol = solunar(new Date(date + 'T12:00'), lake.lat, lake.lon);
  const list = [{ key: 'light', t: rise - 30 * 6e4, label: `First light, ${shortTime(rise - 30 * 6e4)}` }];
  for (const x of sol.windows) if (x.start >= rise - 36e5 && x.start <= set - 36e5) list.push({ key: `bite-${x.start}`, t: x.start, label: `${windowLabel(x)} bite, ${shortTime(x.start)}` });
  return list;
}

// Every time in the plan, worked back from when you want to be fishing and forward from the forecast.
// Pure, for tests: w, date, lake, { craft, onWater (ms), driveMin, walkIn, walkOut, readyMin, dusk (ms) }.
export function planDay(w, date, lake, o) {
  const lim = limits(o.craft, lake), m = 6e4, setup = lim.setup;
  const onWater = Math.floor(o.onWater / 3e5) * 3e5; // on the 5 minutes, a little early
  const arrive = onWater - (o.walkIn + setup) * m, leave = arrive - o.driveMin * m, wake = leave - o.readyMin * m;
  const until = o.dusk ?? onWater + 14 * 36e5;
  const first = (...ts) => ts.filter(t => t != null).sort((a, b) => a - b)[0] ?? null;
  const windUp = first(crossTime(w, 'wind_gusts_10m', lim.gGood, onWater, until), crossTime(w, 'wind_speed_10m', lim.good, onWater, until));
  const storm = stormTiming(w, date);
  const stormOff = storm && storm.end > onWater ? Math.max(onWater, storm.offBy) : null;
  const offBy = first(crossTime(w, 'wind_gusts_10m', lim.gMax, onWater, until), crossTime(w, 'wind_speed_10m', lim.max, onWater, until), stormOff);
  // Turn around in time to be off the water before it turns, and back at the truck by last light.
  const byDark = o.dusk ? o.dusk - (o.walkOut + setup) * m : null, byWeather = offBy ? offBy - setup * m : null;
  const turn = first(byDark, byWeather);
  const why = turn == null ? '' : turn === byWeather ? (stormOff && offBy === stormOff ? 'storms' : 'wind') : 'last light';
  return { lim, wake, leave, arrive, onWater, windUp: windUp && (!offBy || windUp < offBy) ? round5(windUp) : null, offBy: offBy && round5(offBy), turn: turn && round5(Math.max(turn, onWater)), why, storm,
    tooLate: offBy != null && offBy <= onWater + 30 * m };
}

const READY_KEY = 'tackle-box-ready-min';
const readyMin = () => { try { return +(localStorage.getItem(READY_KEY) ?? 30); } catch { return 30; } };

export async function openDayPlan(lake, date = localKey()) {
  const w = await weatherFor(lake.lat, lake.lon).catch(() => null);
  if (!w?.daily.time.includes(date)) return alert('No forecast for that day yet (offline?). Open the water with signal first, or use 📴 Ready.');
  const walk = await walkTimes(lake), tgts = targets(lake, w, date), dusk = duskFor(lake, date, w);
  const di = w.daily.time.indexOf(date), rise = Date.parse(w.daily.sunrise[di]);
  const dflt = tgts.find(x => x.key !== 'light' && x.t >= rise - 30 * 6e4 && x.t <= rise + 2.5 * 36e5)?.key ?? 'light';
  const dlg = document.createElement('dialog');
  dlg.className = 'sheet dw-sheet';
  const d = new Date(date + 'T12:00');
  dlg.innerHTML = `<form class="form" method="dialog"><h3>⏰ Day plan · ${esc(lake.name)}</h3>
    <p class="muted small">${esc(d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }))}${w.saved ? ` · 📴 forecast ${esc(forecastAge(w))}` : ''}</p>
    <label>Your craft ${craftSelect()}</label>
    <label>Be fishing for <select name="target">${tgts.map(x => `<option value="${esc(x.key)}" ${x.key === dflt ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}<option value="custom">A time I pick</option></select></label>
    <label class="dw-custom hidden">On the water at <input name="custom" type="time" value="06:00"></label>
    <div class="row"><label>Drive (min) <input name="drive" type="number" min="0" step="5" inputmode="numeric" value="${lake.driveMin ?? ''}" placeholder="e.g. 90"></label>
      <label>Get ready (min) <input name="ready" type="number" min="0" step="5" inputmode="numeric" value="${readyMin()}"></label></div>
    <div class="row"><label>Walk in (min) <input name="walkIn" type="number" min="0" step="5" inputmode="numeric" value="${lake.walkInMin ?? walk?.in ?? 0}"></label>
      <label>Walk out (min) <input name="walkOut" type="number" min="0" step="5" inputmode="numeric" value="${lake.walkOutMin ?? walk?.out ?? 0}"></label></div>
    <p class="muted small">${walk ? `Walk times from Getting there (${walk.in} min in, ${walk.out} out); change them if you know better. ` : ''}Drive time is typed by you and kept with this water on your phone: no map service ever sees where you live.</p>
    <div id="dw-out"></div>
    <div class="row"><button value="cancel">Close</button><button class="primary" id="dw-ics" value="ics">📅 Add alarms to my calendar</button></div></form>`;
  document.body.append(dlg);
  const f = dlg.querySelector('form'), out = $('#dw-out', dlg);
  let plan = null;
  const walksOut = p => p.why === 'last light' && +f.walkOut.value > 0; // turning around for the weather is getting off the water
  const calc = () => {
    f.querySelector('.dw-custom').classList.toggle('hidden', f.target.value !== 'custom');
    const [hh, mm] = (f.custom.value || '06:00').split(':').map(Number);
    const onWater = f.target.value === 'custom' ? new Date(`${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`).getTime() : tgts.find(x => x.key === f.target.value).t;
    const n = v => Math.max(0, +v || 0);
    plan = planDay(w, date, lake, { craft: f.craft.value, onWater, driveMin: n(f.drive.value), walkIn: n(f.walkIn.value), walkOut: n(f.walkOut.value), readyMin: n(f.ready.value), dusk });
    const p = plan;
    const rows = [
      n(f.ready.value) && ['⏰', 'Wake', p.wake],
      ['🚙', 'Leave by', p.leave, n(f.drive.value) ? '' : 'type your drive time above'],
      ['🎣', 'On the water', p.onWater, n(f.walkIn.value) ? `after a ${n(f.walkIn.value)} min walk in` : ''],
      p.windUp && ['💨', 'Wind picks up', p.windUp, `past ${p.lim.good} mph for ${p.lim.a}`],
      p.offBy && ['🛑', p.storm && p.why === 'storms' ? 'Storms: off the water by' : 'Too rough by', p.offBy],
      p.turn && [walksOut(p) ? '🥾' : '↩️', walksOut(p) ? 'Start walking out by' : `${p.lim.off} by`, p.turn, p.why === 'last light' ? `back at the truck by last light, ${shortTime(dusk)}` : `before the ${p.why}`],
    ].filter(Boolean).sort((a, b) => a[2] - b[2]);
    out.innerHTML = `${p.tooLate ? `<p class="dw-sum bad"><b>It turns rough within half an hour of when you'd be on the water. Pick another time or day, or fish from shore.</b></p>` : ''}
      <table class="dw-plan">${rows.map(([i, label, t, note]) => `<tr><td>${i}</td><td>${esc(label)}</td><td><b>${shortTime(t)}</b>${t < Date.now() ? ' <span class="muted small">(past)</span>' : ''}${note ? `<div class="muted small">${esc(note)}</div>` : ''}</td></tr>`).join('')}</table>
      <p class="muted small">Calendar alarms ring even with the app closed and no signal.</p>`;
    $('#dw-ics', dlg).disabled = rows.every(r => r[2] < Date.now());
  };
  f.oninput = calc;
  f.craft.onchange = () => { setCraft(f.craft.value); calc(); };
  calc();
  dlg.onclose = () => dlg.remove();
  $('#dw-ics', dlg).onclick = async e => {
    e.preventDefault();
    const n = v => Math.max(0, +v || 0);
    // Keep the times you typed with this water, and the get-ready time for every water.
    try { localStorage.setItem(READY_KEY, String(n(f.ready.value))); } catch {}
    if (!lake.unsaved && lake.id) {
      const fresh = await db.get('lakes', lake.id);
      if (fresh) {
        const walkIn = n(f.walkIn.value), walkOut = n(f.walkOut.value);
        Object.assign(fresh, { driveMin: f.drive.value === '' ? null : n(f.drive.value), walkInMin: walkIn !== (walk?.in ?? 0) ? walkIn : fresh.walkInMin ?? null, walkOutMin: walkOut !== (walk?.out ?? 0) ? walkOut : fresh.walkOutMin ?? null });
        await db.put('lakes', fresh);
        Object.assign(lake, { driveMin: fresh.driveMin, walkInMin: fresh.walkInMin, walkOutMin: fresh.walkOutMin });
      }
    }
    const p = plan, uid = `day-${lake.id ?? lake.nhdId}-${date}`, now = Date.now();
    const ev = [
      n(f.ready.value) && { uid: `${uid}-wake`, start: p.wake, summary: `⏰ Wake up: ${lake.name}`, description: `Leave by ${shortTime(p.leave)}. On the water ${shortTime(p.onWater)}.`, alarms: [0] },
      { uid: `${uid}-leave`, start: p.leave, summary: `🚙 Leave for ${lake.name}`, description: `On the water by ${shortTime(p.onWater)}.`, alarms: [10, 0] },
      p.windUp && { uid: `${uid}-wind`, start: p.windUp, summary: `💨 Wind picking up at ${lake.name}`, description: `Over ${p.lim.good} mph for ${p.lim.a}. Stay near the launch.`, alarms: [0] },
      p.turn && { uid: `${uid}-turn`, start: p.turn, summary: walksOut(p) ? `🥾 Start walking out: ${lake.name}` : `↩️ ${p.lim.off}: ${lake.name}`, description: p.why === 'last light' ? `Last light ${shortTime(dusk)}.` : p.why === 'storms' ? `Thunderstorms forecast. Off the water by ${shortTime(p.offBy)}.` : `Too windy by ${shortTime(p.offBy)}.`, alarms: [15, 0] },
    ].filter(x => x && x.start > now);
    if (!ev.length) return status('Those times have passed');
    await sendIcs(`${lake.name}-day-plan-${date}.ics`, ev, { title: `Day plan: ${lake.name}`, text: `Alarms for ${lake.name}` });
  };
  dlg.showModal();
}

// ---------- Weather-turning watch on the trip screen ----------
// Redrawn with the trip screen and every 5 minutes while it's open. Alerts already in effect at the trip's start
// are listed quietly; one issued after you started gets the loud banner.
const SEEN_KEY = id => `tackle-box-trip-alerts-${id}`;
let watchTimer = null;
const riverSite = new Map(); // lake id -> nearest gauge id
export async function tripWatch(t, lake, el) {
  clearInterval(watchTimer);
  watchTimer = setInterval(() => { if (!el.isConnected) return clearInterval(watchTimer); paint(); }, 5 * 60e3);
  const paint = async () => {
    const w = await weatherFor(lake.lat, lake.lon).catch(() => null);
    if (!el.isConnected) return;
    const alerts = await fetchAlerts(lake.lat, lake.lon).catch(() => []);
    let seen;
    try { seen = JSON.parse(localStorage.getItem(SEEN_KEY(t.id))); } catch {}
    if (!Array.isArray(seen)) { seen = alerts.map(alertKey); try { localStorage.setItem(SEEN_KEY(t.id), JSON.stringify(seen)); } catch {} }
    const seenSet = new Set(seen), old = alerts.filter(a => seenSet.has(alertKey(a)));
    const x = w ? weatherTurning(w, lake, craftId(), Date.now(), alerts, seenSet) : { banners: [], steps: [] };
    const river = isRiver(lake) && navigator.onLine !== false ? await riverNow(lake).catch(() => null) : null;
    if (river?.fast) x.banners.unshift({ tone: 'bad', icon: '🌊', text: `River ${river.text.replace(/^./, c => c.toLowerCase())}. Get out of the channel and off low gravel bars.` });
    if (!el.isConnected) return;
    el.innerHTML = `${x.banners.map(b => `<div class="dw-banner ${b.tone}" role="alert"><span>${b.icon}</span><b>${esc(b.text)}</b></div>`).join('')}
      ${x.steps.length ? `<div class="dw-watch"><div class="dw-watch-head"><span>Next 2 hours · ${esc(CRAFTS[craftId()].icon)} ${esc(CRAFTS[craftId()].short)}</span>${river && !river.fast ? `<span class="chip ${river.tone}">🌊 ${esc(river.label)}</span>` : ''}</div>
        <div class="dw-strip">${x.steps.map((s, k) => `<span class="dw-h ${s.tone}" title="${esc(`${shortTime(s.t)}: wind ${Math.round(s.wind)}, gusts ${Math.round(s.gust)}`)}">${k % 2 === 0 ? `<i>${k ? shortTime(s.t).replace(/[ap]m$/, '') : 'now'}</i>` : ''}<b>${Math.round(s.gust)}</b></span>`).join('')}</div>
        ${old.length ? `<div class="small">⚠️ In effect: ${old.map(a => esc(a.event)).join(', ')}</div>` : ''}
        ${w?.saved ? `<div class="muted small">📴 From the forecast ${esc(forecastAge(w))}: a change that wasn't forecast then can't show here.</div>` : ''}</div>` : ''}`;
  };
  paint();
}
async function riverNow(lake) {
  let id = lake.usgsSite ?? riverSite.get(lake.id);
  if (!id) {
    const s = (await fetchUsgsNearby(lake.lat, lake.lon, 0.1)).find(x => x.readings.some(r => r.code === '00065' || r.code === '00060') && haversineKm(lake.lat, lake.lon, x.lat, x.lon) < 15);
    if (!s) return null;
    riverSite.set(lake.id, id = s.id);
  }
  return riverRise(id);
}

// ---------- River rising line on a gauge in Conditions ----------
// Fills `el` with the line, and puts a banner at the top of the tab when a river (`river`) is rising fast.
export function riverLine(siteId, el, river, body) {
  riverRise(siteId).then(r => {
    if (!r || !el.isConnected) return;
    el.innerHTML = `<br>🌊 <span class="chip ${r.tone}">${esc(r.text)}</span>`;
    if (r.fast && river && !body.querySelector('.dw-banner.river')) body.querySelector('#alerts')?.insertAdjacentHTML('beforebegin', `<div class="dw-banner bad river" role="alert"><span>🌊</span><b>${esc(r.text)} at the gauge. Rivers can keep rising for hours after rain or a dam release: stay out of the channel.</b></div>`);
  }).catch(() => {});
}
