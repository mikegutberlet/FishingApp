// Weather for catches logged after the fact (photo backfill, a catch typed in the next day, one saved offline).
// Open-Meteo's free archive gives the hour-by-hour weather at the water for any past day; only the water's
// coordinates and the date are sent. The result has the same shape as the live snapshot on the catch form.
import { db } from './db.js';
import { WEATHER_CODES } from './data-sources.js';

const days = new Map(); // "lat,lon,start,end" -> hourly series, so a day of catches on one water is one request

const ymd = ms => new Date(ms).toISOString().slice(0, 10);

async function hourly(lat, lon, startMs, endMs) {
  // The last ~3 months come from the forecast service (the archive trails by about 5 days); older days from the archive.
  const recent = Date.now() - startMs < 85 * 86400e3;
  const url = new URL(recent ? 'https://api.open-meteo.com/v1/forecast' : 'https://archive-api.open-meteo.com/v1/archive');
  url.search = new URLSearchParams({
    latitude: lat.toFixed(3), longitude: lon.toFixed(3), timezone: 'GMT', start_date: ymd(startMs), end_date: ymd(endMs),
    temperature_unit: 'fahrenheit', wind_speed_unit: 'mph',
    hourly: 'temperature_2m,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,weather_code,cloud_cover',
  });
  const key = url.search;
  if (!days.has(key)) days.set(key, fetch(url, { signal: AbortSignal.timeout?.(10e3) }).then(r => { if (!r.ok) throw new Error('Weather archive unavailable'); return r.json(); }));
  try { return await days.get(key); } catch (e) { days.delete(key); throw e; }
}

// Conditions at lat/lon at a past time, or null when there's no data (offline, the future, before 1940).
export async function pastConditions(lat, lon, iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t) || t > Date.now() || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  try {
    // From 3 hours before, for the pressure trend.
    const h = (await hourly(lat, lon, t - 3 * 3600e3, t)).hourly;
    const i = h.time.map(s => Date.parse(s + 'Z')).findLastIndex(x => x <= t);
    if (i < 0 || h.temperature_2m[i] == null || h.pressure_msl[i] == null) return null;
    const delta = i >= 3 && h.pressure_msl[i - 3] != null ? h.pressure_msl[i] - h.pressure_msl[i - 3] : null;
    return { airTemp: h.temperature_2m[i], wind: h.wind_speed_10m[i], windDir: h.wind_direction_10m[i], gusts: h.wind_gusts_10m[i],
      pressureInHg: +(h.pressure_msl[i] * 0.02953).toFixed(2), pressureTrend: delta == null ? undefined : delta > 1 ? 'Rising' : delta < -1 ? 'Falling' : 'Steady',
      sky: WEATHER_CODES[h.weather_code[i]], cloud: h.cloud_cover[i], source: 'archive' };
  } catch { return null; }
}

// Past catches with no weather saved, oldest first.
export async function catchesWithoutWeather() {
  return (await db.all('catches')).filter(c => !c.conditions && Date.parse(c.time) < Date.now() - 3600e3).sort((a, b) => a.time.localeCompare(b.time));
}

// Fills in the weather for every past catch that has none (or just `ids`), at its water's coordinates. Returns how many were filled.
let running = Promise.resolve();
export function fillMissingWeather(onProgress = () => {}, ids = null) {
  // One run at a time, so two runs don't look up the same catches.
  return running = running.catch(() => {}).then(async () => {
    const todo = (await catchesWithoutWeather()).filter(c => !ids || ids.includes(c.id));
    const lakes = Object.fromEntries((await db.all('lakes')).map(l => [l.id, l]));
    let filled = 0;
    for (const [n, c] of todo.entries()) {
      onProgress(n, todo.length);
      const lake = lakes[c.lakeId];
      const cond = lake && await pastConditions(lake.lat, lake.lon, c.time);
      if (!cond) continue;
      // Re-read: the catch may have been edited (or deleted) while this ran.
      const now = await db.get('catches', c.id);
      if (now && !now.conditions && now.time === c.time && now.lakeId === c.lakeId) { await db.put('catches', { ...now, conditions: cond }, { touch: false }); filled++; }
    }
    return filled;
  });
}
