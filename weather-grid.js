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
const haveCells = () => new Set([...mem.keys()].filter(fresh));

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

// Saved copies live beside the app's other saved forecasts (forecast.js), which also clears out old ones.
const savedUrl = id => new URL(`__grid/${id}.json`, location.href).href;
async function save(id, w) {
  try { await (await caches.open('tb-forecast')).put(savedUrl(id), new Response(JSON.stringify({ savedAt: new Date().toISOString(), w }), { headers: { 'Content-Type': 'application/json' } })); } catch {}
}
async function saved(id) {
  try {
    const s = await (await (await caches.open('tb-forecast')).match(savedUrl(id)))?.json();
    return s?.w && Date.now() - Date.parse(s.savedAt) < SAVED_FOR ? { ...s.w, saved: true } : null;
  } catch { return null; }
}

// The forecast for each square: from memory, else the network, else the copy saved on the phone, else null.
export async function gridWeather(cells) {
  const out = new Map(), need = [];
  for (const c of cells) { const w = fresh(c.id); if (w) out.set(c.id, w); else need.push(c); }
  const keep = (c, w) => { mem.set(c.id, { at: Date.now(), w }); out.set(c.id, w); save(c.id, w); };
  if (need.length && navigator.onLine !== false) {
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
  await Promise.all(need.filter(c => !out.has(c.id)).map(async c => out.set(c.id, await saved(c.id))));
  return out;
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
  const di = w.daily.time.indexOf(date), hi = w.daily.temperature_2m_max?.[di], lo = w.daily.temperature_2m_min?.[di], pop = w.daily.precipitation_probability_max?.[di];
  return { grade: gradeOf(day.hours), saved: !!w.saved,
    line: [`${dayWord(P.day)}: ${day.summary}`, hi != null && lo != null && `${fmtTemp(hi, true)} / ${fmtTemp(lo, true)}`, pop >= 20 && `${pop}% rain`].filter(Boolean).join(' · ') };
}

// The weather stage of a filter pass. `items` (each with lat, lon, acres) already pass everything else; `ref` is where
// "nearest" is measured from. `grades` holds { grade, line } per item, or null when its square has no forecast; an item
// whose square is beyond this pass's cap isn't in it at all (`beyond` counts those). `unknown`: items without a
// forecast. `saved`: some grades come from a copy saved earlier. `asked`: how many squares this pass asked for, out of
// `cap` (a caller that makes several passes over one view shares one allowance between them).
export const CAP = 300;
export async function weatherStage(items, P, ref, { craft = craftId(), cap = CAP } = {}) {
  const { cells } = pickCells(items, ref, Math.max(0, cap), haveCells());
  const got = await gridWeather(cells);
  const grades = new Map();
  let unknown = 0, beyond = 0, anySaved = false;
  for (const it of items) {
    const id = cellOf(it.lat, it.lon).id, w = fresh(id) ?? got.get(id);
    if (w === undefined) { beyond++; continue; }
    const g = gradeWater(w, it, P, craft);
    if (!g) unknown++; else if (g.saved) anySaved = true;
    grades.set(it, g);
  }
  return { grades, unknown, beyond, saved: anySaved, asked: cells.length };
}

// The day's line for one water (a card on the map): its square's forecast, asked for if it isn't in hand.
export async function weatherLine(lake, P) {
  const c = cellOf(lake.lat, lake.lon);
  return gradeWater((await gridWeather([c])).get(c.id), lake, P)?.line ?? null;
}
