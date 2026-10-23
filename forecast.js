// Fetchers for the conditions and forecasting features. Free public sources, no keys.
// Like data-sources.js, each call carries only the coordinates (or gauge id) of the water being looked at.
import { fetchWeather } from './data-sources.js';

// One forecast per water per 20 minutes, so Today, the planner and the lake page share a single request.
const wxCache = new Map();
export function weatherFor(lat, lon) {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`, hit = wxCache.get(key);
  if (hit && Date.now() - hit.at < 20 * 60e3) return hit.p;
  const p = fetchWeather(lat, lon);
  wxCache.set(key, { at: Date.now(), p });
  p.catch(() => wxCache.delete(key));
  return p;
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
  const seen = new Set();
  return (await r.json()).features.map(f => f.properties)
    .filter(a => a.status === 'Actual' && !seen.has(a.event + a.ends) && seen.add(a.event + a.ends))
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
