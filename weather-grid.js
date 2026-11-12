// Forecasts for the weather filter ("good weather on Saturday for my kayak"), shared by the "Where should I go?"
// list and the map. A forecast is asked for per square of a tenth of a degree (weather-grid-core.js), only for
// squares that hold a water passing every other filter, nearest first and no more than 300 a pass. Each is kept for
// three hours and saved on the phone, so a saved copy answers when there is no signal. The only thing sent is the
// squares' centers, to Open-Meteo (the service the app's forecasts already come from).
import { cellOf, gradeOf, pickCells, readMulti } from './weather-grid-core.js';
import { safeHours, craftId } from './boat-weather.js';
import { localKey, addDays } from './forecast.js';
import { fmtTemp } from './units.js';

const KEEP = 3 * 36e5, BATCH = 50, SINGLES = 12, SAVED_FOR = 48 * 36e5;
const mem = new Map(); // square id -> { at, w }
const fresh = id => { const m = mem.get(id); return m && Date.now() - m.at < KEEP ? m.w : null; };
const haveCells = () => { for (const id of [...mem.keys()]) if (!fresh(id)) mem.delete(id); return new Set(mem.keys()); };

// The forecast service is free and shared with the rest of the app's forecasts, and counts every square as a request:
// no more than 1,500 squares are asked for in any hour (kept on the phone, so reopening the app doesn't start over).
const HOURLY = 1500, ASKED = 'tackle-box-wx-asked';
const askedLately = () => { try { return (JSON.parse(localStorage.getItem(ASKED)) ?? []).filter(([t]) => Date.now() - t < 36e5); } catch { return []; } };
const room = () => Math.max(0, HOURLY - askedLately().reduce((n, [, k]) => n + k, 0));
const spend = n => { try { localStorage.setItem(ASKED, JSON.stringify([...askedLately(), [Date.now(), n]])); } catch {} };

// ---------- Asking ----------
// Several places in one request: Open-Meteo takes comma-separated lists and answers with a list in the same order.
async function ask(cells) {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.search = new URLSearchParams({
    latitude: cells.map(c => c.lat.toFixed(1)).join(','), longitude: cells.map(c => c.lon.toFixed(1)).join(','), timezone: 'auto',
    temperature_unit: 'fahrenheit', wind_speed_unit: 'mph', precipitation_unit: 'inch', forecast_days: 8,
    hourly: 'temperature_2m,precipitation_probability,weather_code,wind_speed_10m,wind_gusts_10m',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_probability_max',
  });
  try {
    const r = await Promise.race([fetch(url), new Promise((_, no) => setTimeout(() => no(new Error('Weather timed out')), 15e3))]);
    return r.ok ? readMulti(await r.json(), cells.length) : null;
  } catch { return null; }
}

// Saved copies have a cache of their own (sw.js keeps it across app updates). A copy is good for two days; older
// ones are cleared out the first time something is saved after the app opens.
const SAVED = 'tb-wx-grid';
const savedUrl = id => new URL(`__grid/${id}.json`, location.href).href;
let pruned = false;
async function save(id, w) {
  try {
    const c = await caches.open(SAVED);
    await c.put(savedUrl(id), new Response(JSON.stringify({ savedAt: new Date().toISOString(), w }), { headers: { 'Content-Type': 'application/json' } }));
    if (pruned) return;
    pruned = true;
    for (const r of await c.keys()) { const s = await (await c.match(r))?.json().catch(() => null); if (!s || Date.now() - Date.parse(s.savedAt) > SAVED_FOR) await c.delete(r); }
  } catch { /* no Cache API (private mode): the forecast just isn't kept */ }
}
async function saved(id) {
  try {
    const s = await (await (await caches.open(SAVED)).match(savedUrl(id)))?.json();
    return s?.w && Date.now() - Date.parse(s.savedAt) < SAVED_FOR ? { ...s.w, saved: true } : null;
  } catch { return null; }
}

// The forecast for each square: from memory, else the network, else the copy saved on the phone, else null.
const asking = new Map(); // square id -> the request it is already part of, so two screens never ask for it twice
export async function gridWeather(cells) {
  const out = new Map(), need = [], wait = [];
  for (const c of cells) { const w = fresh(c.id); if (w) out.set(c.id, w); else if (asking.has(c.id)) wait.push(c); else need.push(c); }
  const keep = (c, w) => { mem.set(c.id, { at: Date.now(), w }); out.set(c.id, w); save(c.id, w); };
  const job = network(need, keep);
  for (const c of need) asking.set(c.id, job);
  await Promise.all([job, ...wait.map(c => asking.get(c.id))]).finally(() => { for (const c of need) asking.delete(c.id); });
  for (const c of wait) { const w = fresh(c.id); if (w) out.set(c.id, w); }
  await Promise.all([...need, ...wait].filter(c => !out.has(c.id)).map(async c => out.set(c.id, await saved(c.id))));
  return out;
}
async function network(need, keep) {
  if (need.length && navigator.onLine !== false) {
    spend(need.length);
    const parts = [];
    for (let i = 0; i < need.length; i += BATCH) parts.push(need.slice(i, i + BATCH));
    const batch = async part => { const ws = await ask(part); ws?.forEach((w, k) => keep(part[k], w)); return !!ws; };
    // The nearest squares first, on their own; when that works the rest are asked for together.
    if (await batch(parts[0])) await Promise.all(parts.slice(1).map(batch));
    else {
      // No usable answer for several places at once. If one place alone works, the service is there but won't take
      // a list: ask place by place for the nearest dozen. If not, there's no signal: stop asking.
      const first = (await ask([need[0]]))?.[0];
      if (first) {
        keep(need[0], first);
        const rest = need.slice(1, SINGLES);
        for (let k = 0; k < rest.length; k += 4) await Promise.all(rest.slice(k, k + 4).map(async c => { const w = (await ask([c]))?.[0]; if (w) keep(c, w); }));
      }
    }
  }
}

// ---------- A water's day ----------
export const dateFor = P => localKey(addDays(Date.now(), P.day));
const dayWord = n => n ? addDays(Date.now(), n).toLocaleDateString(undefined, { weekday: 'short' }) : 'Today';
export const dayLabel = n => n ? `${dayWord(n)} ${addDays(Date.now(), n).getDate()}` : 'Today';

// A water's grade for the picked day and craft, and the line a row or card shows: "Sat: Kayak: good till 11, off by 1
// · 62°F / 38°F · 40% rain". null when the forecast doesn't cover that day. `e` needs `acres` (big water, lower limits).
export function gradeWater(w, e, P, craft = craftId()) {
  const date = dateFor(P), day = w && safeHours(w, date, e, craft);
  if (!day) return null;
  if (!day.hours.length) return { grade: null, over: true, line: 'Today: daylight is over' }; // nothing left to rate: not a reason to hide it
  const di = w.daily.time.indexOf(date), hi = w.daily.temperature_2m_max?.[di], lo = w.daily.temperature_2m_min?.[di], pop = w.daily.precipitation_probability_max?.[di];
  return { grade: gradeOf(day.hours), saved: !!w.saved,
    line: [`${dayWord(P.day)}: ${day.summary}`, hi != null && lo != null && `${fmtTemp(hi, true)} / ${fmtTemp(lo, true)}`, pop >= 20 && `${pop}% rain`].filter(Boolean).join(' · ') };
}

// The weather stage of a filter pass. `items` (each with lat, lon, acres) already pass everything else; `ref` is where
// "nearest" is measured from. `grades` holds { grade, line } per item, or null when its square has no forecast; an item
// whose square is beyond this pass's cap isn't in it at all (`beyond` counts those). `unknown`: items without a
// forecast. `saved`: some grades come from a copy saved earlier. `over`: today's daylight is over, so nothing was rated.
// `asked`: how many squares this pass asked for, out of `cap` (a caller that makes several passes over one view shares
// one allowance between them). `limited`: the hour's allowance cut it short.
export const CAP = 300;
export async function weatherStage(items, P, ref, { craft = craftId(), cap = CAP } = {}) {
  const left = room(), want = Math.max(0, cap);
  const { cells, beyond: cut } = pickCells(items, ref, Math.min(want, left), haveCells());
  const limited = cut > 0 && left < want;
  const got = await gridWeather(cells);
  const grades = new Map();
  let unknown = 0, beyond = 0, over = 0, anySaved = false;
  for (const it of items) {
    const id = cellOf(it.lat, it.lon).id, w = fresh(id) ?? got.get(id);
    if (w === undefined) { beyond++; continue; }
    const g = gradeWater(w, it, P, craft);
    if (!g) unknown++; else if (g.over) over++; else if (g.saved) anySaved = true;
    grades.set(it, g);
  }
  return { grades, unknown, beyond, over, saved: anySaved, asked: cells.length, limited };
}

// What to tell the person about a pass, as sentences: `where` ends the note about the cap ("Zoom in, or shorten the distance").
export const weatherNotes = ({ unknown = 0, beyond = 0, over = 0, saved = false, limited = false }, where) => [
  over && 'Daylight is over for today, so weather isn\'t applied. Pick another day',
  unknown && `No forecast for ${unknown.toLocaleString()} water${unknown === 1 ? '' : 's'}, so weather isn't applied to them`,
  limited ? 'That\'s all the forecasts the app asks for in an hour. The rest are checked later' : beyond && `Weather is checked for the nearest ${CAP} areas. ${where}`,
  saved && 'Using forecasts saved earlier'].filter(Boolean);

// The day's line for one water (a card on the map): its square's forecast, asked for if it isn't in hand.
export async function weatherLine(lake, P) {
  const c = cellOf(lake.lat, lake.lon);
  return gradeWater((await gridWeather([c])).get(c.id), lake, P)?.line ?? null;
}
