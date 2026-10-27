// Weather call for your boat and your day: one craft setting (shore, float tube, kayak, small boat) turns the hourly
// forecast into a green/amber/red strip of safe hours, storm timing, a trip-day card, the weather-turning watch on the
// trip screen, and the river rising line. All of it is worked out on the phone from the forecast already fetched
// (or saved for no signal); the only new requests are air quality (Open-Meteo, the water's coordinates) and a
// USGS gauge's last three hours (the gauge's id).
import { localKey, addDays, hourIndex, KEEP_DAYS } from './forecast.js';
import { WEATHER_CODES } from './data-sources.js';
import { shortTime } from './solunar.js';

// ---------- The craft ----------
// Wind limits in mph: up to `good` sustained / `gGood` gusts is fine, past `max` / `gMax` it's time to be off the
// water, between them is marginal. Shore and wading anglers only care about strong wind and storms.
export const CRAFTS = {
  shore: { label: 'Shore or wading', short: 'Shore', a: 'shore fishing', icon: '🥾', good: 20, gGood: 30, max: 30, gMax: 40, setup: 5, off: 'Pack up' },
  tube: { label: 'Float tube', short: 'Float tube', a: 'a float tube', icon: '🛟', good: 6, gGood: 10, max: 10, gMax: 15, setup: 15, off: 'Kick for shore' },
  kayak: { label: 'Kayak or canoe', short: 'Kayak', a: 'a kayak', icon: '🛶', good: 10, gGood: 15, max: 15, gMax: 22, setup: 15, off: 'Paddle in' },
  boat: { label: 'Small boat (under 20 ft)', short: 'Boat', a: 'a small boat', icon: '🚤', good: 15, gGood: 22, max: 22, gMax: 30, setup: 20, off: 'Head for the ramp' },
};
const CRAFT_KEY = 'tackle-box-craft';
export const craftId = () => { try { const c = localStorage.getItem(CRAFT_KEY); return CRAFTS[c] ? c : 'shore'; } catch { return 'shore'; } };
export const setCraft = id => { try { localStorage.setItem(CRAFT_KEY, id); } catch {} document.dispatchEvent(new CustomEvent('tb-craft', { detail: id })); };
export const craftSelect = (id = craftId(), name = 'craft') => `<select name="${name}" class="dw-craft">${Object.entries(CRAFTS).map(([k, c]) => `<option value="${k}" ${k === id ? 'selected' : ''}>${c.icon} ${c.label}</option>`).join('')}</select>`;

// Big open water builds waves sooner: limits drop a little on lakes over 5,000 acres (not for shore).
export function limits(id, lake) {
  const c = CRAFTS[id] ?? CRAFTS.shore;
  const cut = id !== 'shore' && +lake?.acres >= 5000 ? 2 : 0;
  return { ...c, id, good: c.good - cut, gGood: c.gGood - cut, max: c.max - cut, gMax: c.gMax - cut, big: cut > 0 };
}

const THUNDER = c => c >= 95;
const HEAVY = c => [65, 67, 75, 82, 86].includes(c);
const RAINY = c => c >= 51 && c < 95;

// One forecast hour for a craft: tone 'good' | 'warn' | 'bad' and why.
export function rateHour(w, i, lim) {
  const h = w.hourly, wind = h.wind_speed_10m[i] ?? 0, gust = h.wind_gusts_10m[i] ?? wind, code = h.weather_code?.[i] ?? 0, pop = h.precipitation_probability?.[i] ?? 0;
  const why = [];
  let tone = 'good';
  const worse = t => { if (t === 'bad' || tone === 'good') tone = t; };
  if (THUNDER(code)) { worse('bad'); why.push('thunderstorms'); }
  if (wind > lim.max || gust > lim.gMax) { worse('bad'); why.push(`wind ${Math.round(wind)}, gusts ${Math.round(gust)}`); }
  else if (wind > lim.good || gust > lim.gGood) { worse('warn'); why.push(`wind ${Math.round(wind)}, gusts ${Math.round(gust)}`); }
  if (HEAVY(code) && pop >= 50) { worse('warn'); why.push(WEATHER_CODES[code].toLowerCase()); }
  // The hour before a storm is when you should be heading in.
  if (tone !== 'bad' && THUNDER(h.weather_code?.[i + 1] ?? 0)) { worse('warn'); why.push('storm next hour'); }
  return { tone, why: why.join(', '), wind, gust, code, pop, t: Date.parse(h.time[i]) };
}

// The hours of a local day worth fishing: an hour before sunrise to an hour after sunset.
function dayHours(w, date) {
  const di = w.daily.time.indexOf(date);
  if (di < 0) return null;
  const rise = Date.parse(w.daily.sunrise[di]), set = Date.parse(w.daily.sunset[di]);
  const idx = [];
  w.hourly.time.forEach((t, i) => { const ms = Date.parse(t); if (t.startsWith(date) && ms >= rise - 36e5 - 59 * 6e4 && ms <= set + 36e5) idx.push(i); });
  return { idx, rise, set, di };
}

// "1 pm", "noon"; hrShort drops am/pm ("good till 11").
const hr = t => { const d = new Date(t); return d.getHours() === 12 && !d.getMinutes() ? 'noon' : d.toLocaleTimeString(undefined, { hour: 'numeric' }).replace(/\s?([AP])M$/i, (_, a) => ` ${a.toLowerCase()}m`); };
const hrShort = t => hr(t).replace(/ [ap]m$/, '');
// "1–5 pm", "11 am–2 pm"
const span = (a, b) => { const x = hr(a), y = hr(b); return x.slice(-2) === y.slice(-2) && / [ap]m$/.test(x) ? `${hrShort(a)}–${y}` : `${x}–${y}`; };
const isToday = date => date === localKey();

// The day for one craft: hourly tones, a one-line summary ("Float tube: good till 11, off by 1") and storm timing.
// From now on when the day is today.
export function safeHours(w, date, lake, id = craftId()) {
  const d = dayHours(w, date);
  if (!d?.idx.length) return null;
  const lim = limits(id, lake), now = Date.now();
  let hours = d.idx.map(i => ({ i, ...rateHour(w, i, lim) }));
  if (isToday(date)) hours = hours.filter(x => x.t + 36e5 > now);
  if (!hours.length) return { lim, hours, summary: 'Daylight is over for today', tone: 'ok', storm: null };
  // Runs of the same tone, then words.
  const runs = [];
  for (const x of hours) { const last = runs.at(-1); if (last?.tone === x.tone) { last.end = x.t + 36e5; last.n++; } else runs.push({ tone: x.tone, start: x.t, end: x.t + 36e5, n: 1 }); }
  const parts = [];
  runs.forEach((r, k) => {
    const first = k === 0, last = k === runs.length - 1, prev = runs[k - 1];
    if (r.tone === 'good') parts.push(first && last ? 'good all day' : first ? `good till ${hrShort(r.end)}` : last ? `good again from ${hr(r.start)}` : `good ${span(r.start, r.end)}`);
    else if (r.tone === 'bad') parts.push(first ? (last ? 'too rough all day' : `too rough till ${hr(r.end)}`) : `off by ${hrShort(r.start)}`);
    else if (!(prev?.tone === 'good' && runs[k + 1]?.tone === 'bad' && r.n <= 1)) parts.push(first && last ? 'marginal all day' : first ? `marginal till ${hr(r.end)}` : last ? `marginal from ${hr(r.start)}` : `marginal ${span(r.start, r.end)}`);
  });
  const worst = hours.some(x => x.tone === 'bad') ? 'bad' : hours.some(x => x.tone === 'warn') ? 'warn' : 'good';
  return { lim, hours, summary: `${lim.short}: ${parts.slice(0, 3).join(', ')}`, tone: worst, storm: stormTiming(w, date, d) };
}

// "Thunderstorms 1–5 pm: off by noon". The first block of storm hours in the day (any hour, not only daylight).
export function stormTiming(w, date, d = dayHours(w, date)) {
  const h = w.hourly, idx = h.time.map((t, i) => i).filter(i => h.time[i].startsWith(date) && THUNDER(h.weather_code?.[i]));
  if (!idx.length) return null;
  let a = idx[0], b = a;
  while (idx.includes(b + 1)) b++;
  const start = Date.parse(h.time[a]), end = Date.parse(h.time[b]) + 36e5, pop = Math.max(...idx.filter(i => i >= a && i <= b).map(i => h.precipitation_probability?.[i] ?? 0));
  const offBy = start - 36e5;
  const later = idx.some(i => i > b + 1);
  return { start, end, offBy, pop, text: `Thunderstorms ${span(start, end)}${pop ? ` (${pop}%)` : ''}: off the water by ${hr(offBy)}${later ? ', more later' : ''}`,
    hail: idx.some(i => h.weather_code[i] >= 96), past: isToday(date) && end < Date.now(), night: d && (end <= d.rise - 36e5 || start >= d.set + 36e5) };
}

// A row of hour cells, coloured by tone. Tapping one shows why in its title.
export function stripHtml(day, { compact = false } = {}) {
  if (!day?.hours.length) return '';
  return `<div class="dw-strip${compact ? ' compact' : ''}" role="img" aria-label="${escAttr(day.summary)}">${day.hours.map((x, k) => `<span class="dw-h ${x.tone}" title="${escAttr(`${hr(x.t)}: ${x.why || 'fine'}`)}">${!compact && (k % 2 === 0) ? `<i>${hrShort(x.t)}</i>` : ''}${compact ? '' : `<b>${Math.round(x.gust)}</b>`}</span>`).join('')}</div>`;
}
const escAttr = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

// When something crosses a limit between two forecast hours, the minute it does (straight line between the hours).
export function crossTime(w, key, limit, from, to) {
  const h = w.hourly, i = hourIndex(w, from);
  for (let j = i; j < h.time.length - 1; j++) {
    const t0 = Date.parse(h.time[j]), t1 = Date.parse(h.time[j + 1]), v0 = h[key][j], v1 = h[key][j + 1];
    if (t0 > to) break;
    if (v0 > limit && t0 >= from - 36e5) return Math.max(from, t0);
    if (v1 > limit) { const t = t0 + (limit - v0) / (v1 - v0) * (t1 - t0); if (t <= to) return Math.max(from, t); }
  }
  return null;
}
const round5 = t => Math.round(t / 3e5) * 3e5;

// The next two hours at 15-minute steps (forecast hours joined by straight lines) and what's coming that matters
// for this craft: gusts or wind past the limit, a storm, rain starting. Alerts that weren't in `seen` are new.
export function weatherTurning(w, lake, id = craftId(), now = Date.now(), alerts = [], seen = new Set()) {
  const lim = limits(id, lake), h = w.hourly, end = now + 2 * 36e5;
  const at = (key, t) => { const i = hourIndex(w, t), t0 = Date.parse(h.time[i]), t1 = Date.parse(h.time[i + 1] ?? h.time[i]); const v0 = h[key][i] ?? 0, v1 = h[key][i + 1] ?? v0; return t1 > t0 ? v0 + (v1 - v0) * Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : v0; };
  const steps = Array.from({ length: 9 }, (_, k) => {
    const t = now + k * 15 * 6e4, i = hourIndex(w, t), wind = at('wind_speed_10m', t), gust = at('wind_gusts_10m', t), code = h.weather_code?.[i] ?? 0;
    const tone = THUNDER(code) || wind > lim.max || gust > lim.gMax ? 'bad' : wind > lim.good || gust > lim.gGood || (RAINY(code) && (h.precipitation_probability?.[i] ?? 0) >= 60) ? 'warn' : 'good';
    return { t, wind, gust, code, tone, pop: h.precipitation_probability?.[i] ?? 0 };
  });
  const banners = [];
  const gustT = crossTime(w, 'wind_gusts_10m', lim.gMax, now, end), windT = crossTime(w, 'wind_speed_10m', lim.max, now, end);
  const blowT = [gustT, windT].filter(x => x != null).sort((a, b) => a - b)[0];
  if (blowT != null) {
    const g = Math.round(at('wind_gusts_10m', blowT + 15 * 6e4)), nowGust = at('wind_gusts_10m', now) > lim.gMax;
    banners.push({ tone: 'bad', icon: '💨', text: nowGust ? `Gusts ${g} mph now: past what's safe for ${lim.a}. ${lim.off} now.` : `Gusts ${g} mph by ${shortTime(round5(blowT))}. ${lim.off}${id === 'shore' ? ' and secure your gear' : ''}.` });
  }
  const storm = steps.find(s => THUNDER(s.code)), stormAt = storm && Math.max(now, Date.parse(h.time[hourIndex(w, storm.t)]));
  if (storm) banners.unshift({ tone: 'bad', icon: '⛈️', text: stormAt <= now + 15 * 6e4 ? 'Thunderstorms forecast now: get off the water and away from the shore. Not under a lone tree.' : `Thunderstorms forecast by ${shortTime(round5(stormAt))}. Off the water by ${shortTime(round5(stormAt - 30 * 6e4))}.` });
  const rainNow = RAINY(h.weather_code?.[hourIndex(w, now)]) && (h.precipitation_probability?.[hourIndex(w, now)] ?? 0) >= 50;
  const rain = !rainNow && steps.find(s => RAINY(s.code) && s.pop >= 60);
  if (rain && !storm) banners.push({ tone: 'warn', icon: '🌧️', text: `${WEATHER_CODES[rain.code]} by ${shortTime(round5(rain.t))} (${rain.pop}%). Rain gear on${id === 'shore' ? '' : ' before you get wet'}.` });
  for (const a of alerts) if (!seen.has(alertKey(a))) banners.unshift({ tone: a.severity === 'Severe' || a.severity === 'Extreme' ? 'bad' : 'warn', icon: '⚠️', text: `New warning: ${a.event}${a.ends ? ` until ${new Date(a.ends).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : ''}.` });
  return { lim, steps, banners };
}
export const alertKey = a => a.id ?? `${a.event}|${a.ends}|${a.headline}`;

// ---------- Trip-day weather card ----------
// Dawn and the coldest hour tonight, the warmest hour, rain, air quality (smoke), water temperature and last light,
// as short lines. `extra`: { aqi (day max US AQI), water: { f, from }, dusk (ms), walkOut (min), alerts }.
export function dayCard(w, date, lake, id = craftId(), extra = {}) {
  const d = dayHours(w, date);
  if (!d) return [];
  const h = w.hourly, lines = [], lim = limits(id, lake);
  const between = (a, b) => h.time.map((t, i) => [Date.parse(t), i]).filter(([t]) => t >= a && t < b).map(([, i]) => i);
  const dayStart = Date.parse(`${date}T00:00`), next = addDays(dayStart, 1).getTime();
  const pre = between(dayStart + 3 * 36e5, d.rise + 36e5), night = between(Date.parse(`${date}T18:00`), next + 8 * 36e5), day = between(d.rise, d.set);
  const minOf = ix => ix.length ? Math.min(...ix.map(i => h.temperature_2m[i])) : null, maxOf = ix => ix.length ? Math.max(...ix.map(i => h.temperature_2m[i])) : null;
  const dawn = minOf(pre), hi = maxOf(day), low = minOf(night), feels = day.length ? Math.min(...day.map(i => h.apparent_temperature?.[i] ?? h.temperature_2m[i])) : null;
  const deg = v => `${Math.round(v)}°F`;
  if (dawn != null) lines.push({ icon: dawn <= 32 ? '🥶' : '🌅', tone: dawn <= 32 ? 'warn' : '', text: `Dawn ${deg(dawn)}, high ${deg(hi ?? dawn)}${feels != null && hi != null && feels < hi - 8 ? `, feels like ${deg(feels)} in the wind` : ''}${dawn <= 32 ? ': ice on the ramp, guides and boat floor' : ''}` });
  if (low != null) lines.push({ icon: '⛺', tone: low <= 32 ? 'warn' : '', text: `Low ${deg(low)} tonight${low <= 20 ? ': a winter bag and a dry layer' : low <= 32 ? ': below freezing at camp' : ''}` });
  const wet = day.filter(i => (h.precipitation_probability?.[i] ?? 0) >= 40 && RAINY(h.weather_code?.[i]));
  if (wet.length) {
    const p = Math.max(...wet.map(i => h.precipitation_probability[i])), snow = wet.some(i => h.weather_code[i] >= 71 && h.weather_code[i] <= 86 && !(h.weather_code[i] >= 80 && h.weather_code[i] <= 82));
    lines.push({ icon: snow ? '🌨️' : '🌧️', tone: p >= 70 ? 'warn' : '', text: `${snow ? 'Snow' : 'Rain'} ${p}% ${Date.parse(h.time[wet[0]]) > d.rise + 2 * 36e5 ? `from ${hr(Date.parse(h.time[wet[0]]))}` : 'in the morning'}: pack rain gear` });
  }
  const storm = stormTiming(w, date, d);
  if (storm && !storm.past) lines.push({ icon: '⛈️', tone: 'bad', text: storm.text + (storm.hail ? ', with hail' : '') });
  const gusty = day.map(i => h.wind_gusts_10m[i]);
  if (gusty.length && Math.max(...gusty) > lim.gGood && !storm) lines.push({ icon: '💨', tone: Math.max(...gusty) > lim.gMax ? 'bad' : 'warn', text: `Gusts to ${Math.round(Math.max(...gusty))} mph around ${hr(Date.parse(h.time[day[gusty.indexOf(Math.max(...gusty))]]))}` });
  if (extra.aqi != null) {
    const a = extra.aqi, [word, tone] = a > 200 ? ['very unhealthy', 'bad'] : a > 150 ? ['unhealthy', 'bad'] : a > 100 ? ['unhealthy for sensitive groups', 'warn'] : a > 50 ? ['moderate', ''] : ['good', ''];
    lines.push({ icon: a > 100 ? '😷' : '🌬️', tone, text: `${a > 100 ? 'Smoke: ' : 'Air '}AQI ${Math.round(a)}, ${word}${a > 150 ? '. Bring an N95 and take it easy on the walk in' : ''}` });
  }
  if (extra.water?.f != null) {
    const f = extra.water.f, cold = f < 60 && id !== 'shore';
    lines.push({ icon: '🌡️', tone: cold ? (f < 50 ? 'bad' : 'warn') : '', text: `Water ${Math.round(f)}°F${cold ? `: wear the PFD, ${f < 50 ? 'a fall takes your breath and your grip in minutes' : 'cold-water shock is real under 60°'}` : f < 50 && id === 'shore' ? ': waders and a wading belt' : ''}`, note: extra.water.from });
  }
  if (extra.dusk) {
    const out = (extra.walkOut ?? 0) + 10;
    lines.push({ icon: '🌇', tone: '', text: `Last light ${shortTime(extra.dusk)}, ${extra.walkOut ? `start walking out by ${shortTime(round5(extra.dusk - out * 6e4))}` : `${id === 'shore' ? 'pack up' : 'off the water'} by ${shortTime(round5(extra.dusk - (lim.setup + 5) * 6e4))}`}` });
  }
  return lines;
}

// ---------- Air quality (smoke) ----------
// Open-Meteo's air quality forecast: hourly US AQI for 5 days. Saved like the forecast, so it shows with no signal.
const AQ_CACHE = 'tb-forecast';
const aqUrl = (lat, lon) => new URL(`__aq/${(+lat).toFixed(3)},${(+lon).toFixed(3)}.json`, location.href).href;
const aqMem = new Map();
export function airQuality(lat, lon) {
  const key = `${(+lat).toFixed(3)},${(+lon).toFixed(3)}`, hit = aqMem.get(key);
  if (hit && Date.now() - hit.at < 60 * 60e3) return hit.p;
  const p = (async () => {
    try {
      if (navigator.onLine === false) throw new Error('offline');
      const u = new URL('https://air-quality-api.open-meteo.com/v1/air-quality');
      u.search = new URLSearchParams({ latitude: (+lat).toFixed(3), longitude: (+lon).toFixed(3), hourly: 'us_aqi', timezone: 'auto', forecast_days: 5 });
      const r = await fetch(u, { signal: AbortSignal.timeout(15e3) });
      if (!r.ok) throw new Error('Air quality unavailable');
      const j = await r.json();
      const out = { time: j.hourly.time, aqi: j.hourly.us_aqi, savedAt: new Date().toISOString() };
      try { await (await caches.open(AQ_CACHE)).put(aqUrl(lat, lon), new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json' } })); } catch {}
      return out;
    } catch (e) {
      aqMem.delete(key);
      try { const r = await (await caches.open(AQ_CACHE)).match(aqUrl(lat, lon)); const s = r && await r.json(); if (s && Date.now() - Date.parse(s.savedAt) < KEEP_DAYS * 864e5) return { ...s, saved: true }; } catch {}
      throw e;
    }
  })();
  aqMem.set(key, { at: Date.now(), p });
  return p;
}
// The day's worst hour between 5 am and 10 pm (smoke often settles in overnight and lifts by midday; you're out early).
export const dayAqi = (aq, date) => { const v = aq?.time.map((t, i) => [t, aq.aqi[i]]).filter(([t, a]) => t.startsWith(date) && a != null && +t.slice(11, 13) >= 5 && +t.slice(11, 13) <= 22).map(x => x[1]); return v?.length ? Math.max(...v) : null; };

// ---------- River rising ----------
// The gauge's last three hours (USGS instantaneous values): change over the last hour in stage (ft), or in flow
// when the gauge has no stage. Rising fast is a reason to get out of the river channel.
export async function riverRise(siteId) {
  const r = await fetch(`https://waterservices.usgs.gov/nwis/iv/?format=json&sites=${encodeURIComponent(siteId)}&parameterCd=00065,00060&period=PT3H`, { signal: AbortSignal.timeout(15e3) });
  if (!r.ok) throw new Error('USGS unavailable');
  const series = Object.fromEntries((await r.json()).value.timeSeries.map(ts => [ts.variable.variableCode[0].value,
    (ts.values[0]?.value ?? []).filter(v => v.value !== '-999999').map(v => [Date.parse(v.dateTime), +v.value])]));
  return riseFrom(series['00065'], series['00060']);
}
// Pure part, for tests: [[ms, value]] series, oldest first.
export function riseFrom(stage, flow) {
  const hourAgo = s => {
    if (!s || s.length < 2) return null;
    const [t1, v1] = s.at(-1), base = [...s].reverse().find(([t]) => t1 - t >= 45 * 6e4);
    if (!base) return null;
    return { t: t1, now: v1, d: (v1 - base[1]) * 36e5 / (t1 - base[0]) };
  };
  const st = hourAgo(stage), fl = hourAgo(flow);
  if (st) {
    const d = st.d, [label, tone] = d >= 0.5 ? ['rising fast', 'bad'] : d >= 0.15 ? ['rising', 'warn'] : d <= -0.15 ? ['dropping', 'ok'] : ['steady', 'good'];
    return { t: st.t, label, tone, fast: d >= 0.5, text: `${Math.abs(d) < 0.05 ? 'No change' : d > 0 ? `Up ${d.toFixed(1)} ft` : `Down ${(-d).toFixed(1)} ft`} in the last hour: ${label}` };
  }
  if (fl && fl.now > 0) {
    const pct = fl.d / (fl.now - fl.d) * 100, [label, tone] = pct >= 25 ? ['rising fast', 'bad'] : pct >= 8 ? ['rising', 'warn'] : pct <= -8 ? ['dropping', 'ok'] : ['steady', 'good'];
    return { t: fl.t, label, tone, fast: pct >= 25, text: `Flow ${Math.abs(pct) < 2 ? 'unchanged' : `${pct > 0 ? 'up' : 'down'} ${Math.round(Math.abs(pct))}%`} in the last hour: ${label}` };
  }
  return null;
}
