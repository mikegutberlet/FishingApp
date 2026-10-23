// Fetchers for the conditions and forecasting features. Free public sources, no keys.
// Like data-sources.js, each call carries only the coordinates (or gauge id) of the water being looked at.
import { fetchWeather } from './data-sources.js';

// Local calendar days (the forecast's days), never UTC dates: localKey() -> '2026-10-24'.
export const localKey = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const addDays = (t, n) => { const d = new Date(t); d.setDate(d.getDate() + n); return d; }; // calendar days, safe across DST
// Index of a local day in w.daily (today is 1 for a forecast fetched today, since past_days=1).
export const dayIndex = (w, t = Date.now()) => { const i = w.daily.time.indexOf(localKey(t)); return i < 0 ? 1 : i; };

// One forecast per water per 20 minutes (never across midnight), so Today, the planner and the lake page share a request.
// A request that stalls on weak signal gives up after 20 s, so the next screen can try again.
const wxCache = new Map();
export function weatherFor(lat, lon) {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`, hit = wxCache.get(key);
  if (hit && Date.now() - hit.at < 20 * 60e3 && localKey(hit.at) === localKey()) return hit.p;
  const p = Promise.race([fetchWeather(lat, lon), new Promise((_, reject) => setTimeout(() => reject(new Error('Weather timed out')), 20e3))]);
  const entry = { at: Date.now(), p };
  wxCache.set(key, entry);
  p.catch(() => { if (wxCache.get(key) === entry) wxCache.delete(key); });
  return p;
}

// CDEC lake-level change over `days` days, by date (readings can skip days). Null when the record is too short,
// or when the gauge's last reading is more than maxAgeDays old (a stopped feed is not a current trend).
export function levelChange(e, days, maxAgeDays = Infinity) {
  if (!e?.length) return null;
  const [lastDay, last] = e.at(-1), lastT = Date.parse(lastDay + 'T12:00');
  if (Date.now() - lastT > maxAgeDays * 864e5) return null;
  const cutoff = localKey(addDays(lastT, -days));
  const base = [...e].reverse().find(([d]) => d <= cutoff);
  return base ? last - base[1] : null;
}

// Index into w.hourly for the hour containing `t` (ms).
export const hourIndex = (w, t) => {
  const i = w.hourly.time.findIndex(x => Date.parse(x) > t);
  return i < 0 ? w.hourly.time.length - 1 : Math.max(0, i - 1);
};

// National Weather Service alerts in effect at a point (US only).
export async function fetchAlerts(lat, lon) {
  const r = await fetch(`https://api.weather.gov/alerts/active?point=${lat.toFixed(4)},${lon.toFixed(4)}`, { headers: { Accept: 'application/geo+json' } });
  if (!r.ok) throw new Error('NWS alerts unavailable');
  const seen = new Set(), key = a => a.id ?? `${a.event}|${a.ends ?? a.expires}|${a.headline}`;
  return (await r.json()).features.map(f => ({ id: f.id, ...f.properties }))
    .filter(a => a.status === 'Actual' && !seen.has(key(a)) && seen.add(key(a)))
    .map(a => ({ event: a.event, headline: a.headline, severity: a.severity, description: a.description, instruction: a.instruction, ends: a.ends ?? a.expires, sender: a.senderName }));
}

const SEVERITY = { Extreme: 3, Severe: 2, Moderate: 1 };
export const alertLevel = a => SEVERITY[a.severity] ?? 0;

// RainViewer radar frames: the last 2 hours in 10-minute steps. Free tier serves zoom 0–7 in one colour scheme.
export async function fetchRadarFrames() {
  const r = await fetch('https://api.rainviewer.com/public/weather-maps.json');
  if (!r.ok) throw new Error('Radar unavailable');
  const j = await r.json();
  return (j.radar?.past ?? []).map(f => ({ time: f.time * 1000, url: `${j.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png` }));
}

// Daily flow statistics for a USGS gauge on today's date: percentiles over the gauge's whole record.
// The stat service only speaks RDB (tab-separated, # comments, then a header row and a field-width row).
export async function fetchFlowStats(siteId, date = new Date()) {
  const r = await fetch(`https://waterservices.usgs.gov/nwis/stat/?format=rdb&sites=${encodeURIComponent(siteId)}&statReportType=daily&statTypeCd=all&parameterCd=00060`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('USGS statistics unavailable');
  const lines = (await r.text()).split('\n').filter(l => l && !l.startsWith('#'));
  if (lines.length < 3) return null;
  const head = lines[0].split('\t');
  const rows = lines.slice(2).map(l => Object.fromEntries(l.split('\t').map((v, i) => [head[i], v])))
    .filter(x => +x.month_nu === date.getMonth() + 1 && +x.day_nu === date.getDate());
  const row = rows.sort((a, b) => +b.count_nu - +a.count_nu)[0];
  if (!row) return null;
  const n = k => row[k] === '' || row[k] == null ? null : +row[k];
  return { years: n('count_nu'), from: row.begin_yr, to: row.end_yr, mean: n('mean_va'), min: n('min_va'), max: n('max_va'),
    p10: n('p10_va'), p25: n('p25_va'), p50: n('p50_va'), p75: n('p75_va'), p90: n('p90_va') };
}

// Where today's flow sits against the record for this date, with a plain fishing read for rivers.
export function flowRating(cfs, s) {
  if (!s?.p50) return null;
  const pct = Math.round(cfs / s.p50 * 100);
  const [label, tone, tip] =
    s.p90 != null && cfs > s.p90 * 1.5 || pct > 400 ? ['Blown out', 'bad', 'Far above normal: fast, muddy and unsafe to wade. Try a lake or a tailwater.']
    : s.p90 != null && cfs > s.p90 ? ['High', 'warn', 'Well above normal: fish slower edges, eddies and inside bends; wading is risky.']
    : s.p75 != null && cfs > s.p75 ? ['Fishable, up', 'ok', 'A bit above normal: often good, with some colour in the water and active fish.']
    : s.p25 != null && cfs >= s.p25 ? ['Normal, fishable', 'good', 'Typical flow for this date.']
    : s.p10 != null && cfs >= s.p10 ? ['Low', 'ok', 'Below normal: clear water and spooky fish; go light and fish riffles and deeper runs.']
    : ['Very low', 'warn', 'Far below normal: warm water stresses trout; fish early and land fish quickly.'];
  return { pct, label, tone, tip };
}
