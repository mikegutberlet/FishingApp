// Free public data sources. None need an account or API key, and none receive your catch data:
// only the coordinates of the lake you are looking at are sent, to fetch conditions for it.

const F = 'fahrenheit', MPH = 'mph';

export async function fetchWeather(lat, lon) {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.search = new URLSearchParams({
    latitude: lat.toFixed(3), longitude: lon.toFixed(3), timezone: 'auto',
    temperature_unit: F, wind_speed_unit: MPH, precipitation_unit: 'inch', forecast_days: 11, past_days: 1,
    current: 'temperature_2m,apparent_temperature,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation',
    hourly: 'temperature_2m,apparent_temperature,cloud_cover,precipitation,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation_probability,weather_code',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant,precipitation_probability_max',
  });
  const r = await fetch(url);
  if (!r.ok) throw new Error('Weather unavailable');
  return r.json();
}

// Pressure trend over the last 3 hours, in hPa. Anglers watch falling pressure ahead of fronts.
export function pressureTrend(w) {
  const now = Date.parse(w.current.time);
  const times = w.hourly.time.map(Date.parse);
  let i = times.findIndex(t => t > now) - 1;
  if (i < 3) return null;
  const delta = w.hourly.pressure_msl[i] - w.hourly.pressure_msl[i - 3];
  return { delta, label: delta > 1 ? 'Rising' : delta < -1 ? 'Falling' : 'Steady' };
}

// USGS gauges near a point: streamflow (00060), gauge height (00065), water temp (00010).
// Works best for rivers and reservoirs; many natural lakes have no gauge.
export async function fetchUsgsNearby(lat, lon, radiusDeg = 0.2) {
  const bbox = [lon - radiusDeg, lat - radiusDeg, lon + radiusDeg, lat + radiusDeg].map(n => n.toFixed(4)).join(',');
  const url = `https://waterservices.usgs.gov/nwis/iv/?format=json&siteStatus=active&parameterCd=00060,00065,00010,62614&bBox=${bbox}`;
  const r = await fetch(url);
  if (r.status === 404) return [];
  if (!r.ok) throw new Error('USGS unavailable');
  const json = await r.json();
  const sites = new Map();
  for (const ts of json.value.timeSeries) {
    const info = ts.sourceInfo;
    const id = info.siteCode[0].value;
    const loc = info.geoLocation.geogLocation;
    const site = sites.get(id) || { id, name: info.siteName, lat: loc.latitude, lon: loc.longitude, readings: [] };
    const v = ts.values[0]?.value?.at(-1);
    if (v && v.value !== '-999999') {
      site.readings.push({ name: ts.variable.variableDescription, unit: ts.variable.unit.unitCode, value: Number(v.value), time: v.dateTime, code: ts.variable.variableCode[0].value });
    }
    sites.set(id, site);
  }
  return [...sites.values()]
    .filter(s => s.readings.length)
    .map(s => ({ ...s, distKm: haversineKm(lat, lon, s.lat, s.lon) }))
    .sort((a, b) => a.distKm - b.distKm);
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = d => d * Math.PI / 180, R = 6371;
  const a = Math.sin(toRad(lat2 - lat1) / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Moon phase computed locally (no network). 0 = new, 0.5 = full.
export function moonPhase(date = new Date()) {
  const synodic = 29.530588853;
  const knownNew = Date.UTC(2000, 0, 6, 18, 14);
  const p = (((date - knownNew) / 86400000) % synodic + synodic) % synodic / synodic;
  const names = ['New moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous', 'Full moon', 'Waning gibbous', 'Last quarter', 'Waning crescent'];
  return { fraction: p, name: names[Math.round(p * 8) % 8], illumination: Math.round((1 - Math.cos(2 * Math.PI * p)) / 2 * 100) };
}

export const WEATHER_CODES = {
  0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Freezing fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  66: 'Freezing rain', 67: 'Freezing rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Showers', 81: 'Showers', 82: 'Heavy showers', 85: 'Snow showers', 86: 'Snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm, hail', 99: 'Thunderstorm, hail',
};

export const compass = deg => ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(deg / 22.5) % 16];

// ---- File parsers for the user's own exports ----

export function parseCsv(text) {
  const lines = text.replace(/\r/g, '').split('\n').filter(l => l.trim());
  const delim = (lines[0].match(/;/g) || []).length > (lines[0].match(/,/g) || []).length ? ';' : ',';
  const split = l => l.split(delim).map(c => c.trim().replace(/^"|"$/g, ''));
  const header = split(lines[0]).map(h => h.toLowerCase());
  return { header, rows: lines.slice(1).map(split) };
}

// Depth points from a Deeper (or any sonar) CSV export. Looks for lat/lon/depth columns by name.
export function parseDepthCsv(text) {
  const { header, rows } = parseCsv(text);
  const find = (...names) => header.findIndex(h => names.some(n => h === n || h.startsWith(n)));
  const iLat = find('lat', 'latitude'), iLon = find('lon', 'lng', 'long', 'longitude'), iDepth = find('depth', 'z', 'water depth');
  if (iLat < 0 || iLon < 0 || iDepth < 0) throw new Error(`Couldn't find latitude, longitude and depth columns. Found: ${header.join(', ')}`);
  const unitHint = header[iDepth];
  const points = [];
  for (const r of rows) {
    const lat = +r[iLat], lon = +r[iLon], d = +r[iDepth];
    if (Number.isFinite(lat) && Number.isFinite(lon) && Number.isFinite(d)) points.push([lat, lon, Math.abs(d)]);
  }
  return { points, unitHint };
}

// Depth points from GPX or KML (waypoints/trackpoints with <ele> or depth extensions).
export function parseDepthXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const points = [];
  for (const pt of doc.querySelectorAll('trkpt, wpt, rtept')) {
    const depthEl = [...pt.getElementsByTagName('*')].find(e => /depth/i.test(e.localName)) || pt.querySelector('ele');
    if (depthEl) points.push([+pt.getAttribute('lat'), +pt.getAttribute('lon'), Math.abs(+depthEl.textContent)]);
  }
  for (const c of doc.getElementsByTagName('coordinates')) {
    for (const tuple of c.textContent.trim().split(/\s+/)) {
      const [lon, lat, z] = tuple.split(',').map(Number);
      if (Number.isFinite(z)) points.push([lat, lon, Math.abs(z)]);
    }
  }
  if (!points.length) throw new Error('No depth points found in file');
  return { points, unitHint: '' };
}

const toIsoDate = v => {
  if (/^\d{4}$/.test(v)) return `${v}-01-01`;
  const d = new Date(v);
  return isNaN(d) ? v : d.toISOString().slice(0, 10);
};

// Stocking history CSV: date/year, species, count, size columns (state DNR downloads vary; this is forgiving).
export function parseStockingCsv(text) {
  const { header, rows } = parseCsv(text);
  const find = (...names) => header.findIndex(h => names.some(n => h.includes(n)));
  const iDate = find('date', 'year'), iSpecies = find('species', 'fish'), iCount = find('number', 'count', 'quantity', 'qty'), iSize = find('size', 'length', 'age');
  if (iDate < 0 || iSpecies < 0) throw new Error(`Need at least date/year and species columns. Found: ${header.join(', ')}`);
  return rows.map(r => ({
    date: toIsoDate(r[iDate]),
    species: r[iSpecies], count: iCount >= 0 ? +String(r[iCount]).replace(/,/g, '') || null : null, size: iSize >= 0 ? r[iSize] : '',
  })).filter(r => r.species);
}
