// Ocean fishing data: piers, jetties and surf beaches as waters, tide predictions (NOAA CO-OPS), waves and swell
// (Open-Meteo Marine), the NWS marine forecast for the zone, and marine protected areas.
// Spots, MPAs and tide stations come from this app's site (data/coast/, built weekly by scripts/build-coast.mjs).
// Live calls carry only a tide station id or the spot's coordinates, and every answer is saved on the phone
// (Cache API `tb-forecast`, like the saved forecast) so tides, waves and the zone forecast work with no signal.
import { haversineKm } from './data-sources.js';
import { mpaKey } from './ocean-rules.js';
import { noSignal } from './ui.js';

export const COAST_KINDS = {
  pier: { label: 'Pier', icon: '🎣' },
  jetty: { label: 'Jetty / breakwater', icon: '🪨' },
  surf: { label: 'Surf beach', icon: '🌊' },
  beach: { label: 'Beach', icon: '🏖️' },
  harbor: { label: 'Harbor / bay', icon: '⚓' },
  spot: { label: 'Fishing spot', icon: '📍' },
};
export const isCoast = lake => lake?.kind === 'coast';

const cache = {};
const load = name => cache[name] ??= fetch(`data/coast/${name}.json`).then(r => r.ok ? r.json() : null).catch(() => null)
  .then(j => { if (!j) setTimeout(() => delete cache[name], 30e3); return j; });

// ---------- Spots ----------
// Each spot comes back as a water: kind 'coast', with its own kind (pier, jetty…) in coastKind.
let spotList = null;
export async function coastSpots() {
  const j = await load('spots');
  if (!j) return [];
  return spotList ??= (j.spots ?? []).map(s => ({ ...s, kind: 'coast', coastKind: s.kind, type: COAST_KINDS[s.kind]?.label ?? 'Coast' }));
}
export async function nearestSpots(lat, lon, maxKm = 5) {
  return (await coastSpots()).map(s => ({ ...s, distKm: haversineKm(lat, lon, s.lat, s.lon) })).filter(s => s.distKm <= maxKm).sort((a, b) => a.distKm - b.distKm);
}

// A lake-store record for a spot, not yet saved. Saved coast waters live with your lakes (kind 'coast'), so catches,
// notes, trips and offline packs work the same.
export function coastRecord(s) {
  return { unsaved: true, nhdId: String(s.id), kind: 'coast', coastKind: s.coastKind, name: s.name, type: COAST_KINDS[s.coastKind]?.label ?? 'Coast', state: s.state, lat: s.lat, lon: s.lon,
    ...(s.publicPier != null && { publicPier: s.publicPier }) };
}

// ---------- Saved answers (tb-forecast cache, pruned after 14 days by forecast.js) ----------
const SAVE = 'tb-forecast';
const saveUrl = key => new URL(`__${key}.json`, location.href).href;
async function save(key, data) {
  try { await (await caches.open(SAVE)).put(saveUrl(key), new Response(JSON.stringify({ savedAt: new Date().toISOString(), data }), { headers: { 'Content-Type': 'application/json' } })); } catch {}
}
async function saved(key) {
  try { const r = await (await caches.open(SAVE)).match(saveUrl(key)); return r ? await r.json() : null; } catch { return null; }
}
// Fetch live, save the answer, and fall back to the saved one (marked with savedAt) with no signal.
async function liveOrSaved(key, fetcher, { maxAgeMs = 14 * 864e5, timeout = 20e3 } = {}) {
  const have = await saved(key);
  try {
    if (navigator.onLine === false) throw new Error('offline');
    const data = await Promise.race([fetcher(), new Promise((_, no) => setTimeout(() => no(new Error('timed out')), have ? Math.min(timeout, 8e3) : timeout))]);
    save(key, data);
    return { data, savedAt: null };
  } catch (e) {
    if (have && Date.now() - Date.parse(have.savedAt) < maxAgeMs) return { data: have.data, savedAt: have.savedAt };
    throw e;
  }
}

// ---------- Tides (NOAA CO-OPS) ----------
const COOPS = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';
export async function tideStations() {
  const j = await load('tide-stations');
  if (j?.stations?.length) return j.stations;
  // Before the weekly job has run: NOAA's own station list, kept for the session.
  const r = await fetch('https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=tidepredictions');
  if (!r.ok) throw new Error('NOAA station list unavailable');
  return cache.liveStations ??= (await r.json()).stations.filter(s => ['CA', 'OR'].includes(s.state))
    .map(s => ({ id: s.id, name: s.name, lat: +s.lat, lon: +s.lng, ref: s.type === 'R' }));
}
export async function nearestTideStation(lat, lon) {
  const list = (await tideStations()).map(s => ({ ...s, distKm: haversineKm(lat, lon, s.lat, s.lon) })).sort((a, b) => a.distKm - b.distKm);
  return list[0] && list[0].distKm < 60 ? list[0] : null;
}
const ymd = d => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
export const tidePageUrl = id => `https://tidesandcurrents.noaa.gov/noaatidepredictions.html?id=${encodeURIComponent(id)}`;

// High and low tides from yesterday through 7 days ahead, in feet above MLLW: [{ t (ms), v, type: 'H' | 'L' }].
// Hourly predictions aren't published for every station, so the curve between is drawn from these (tideAt).
export async function tidesFor(stationId) {
  const start = new Date(); start.setDate(start.getDate() - 1);
  const url = `${COOPS}?product=predictions&application=TackleBox&station=${encodeURIComponent(stationId)}&begin_date=${ymd(start)}&range=216&datum=MLLW&interval=hilo&units=english&time_zone=lst_ldt&format=json`;
  return liveOrSaved(`tides/${stationId}`, async () => {
    const r = await fetch(url, { signal: AbortSignal.timeout(20e3) });
    if (!r.ok) throw new Error('NOAA tides unavailable');
    const j = await r.json();
    if (!j.predictions?.length) throw new Error(j.error?.message ?? 'No tide predictions for this station');
    // Times are station-local ("2026-10-27 05:12"); this coast is all Pacific time, as is the phone that uses them.
    return j.predictions.map(p => ({ t: Date.parse(p.t.replace(' ', 'T')), v: +p.v, type: p.type }));
  });
}

// Tide height at `t` from the highs and lows (cosine between turns), and whether it's rising.
export function tideAt(ev, t) {
  const i = ev.findIndex(e => e.t > t);
  if (i <= 0) return null;
  const a = ev[i - 1], b = ev[i], f = (t - a.t) / (b.t - a.t);
  return { v: a.v + (b.v - a.v) * (1 - Math.cos(Math.PI * f)) / 2, rising: b.v > a.v, next: b, prev: a };
}

// A plain read of tide movement for fishing: moving water around the change is usually best.
export function tideRead(ev, t = Date.now()) {
  const x = tideAt(ev, t);
  if (!x) return null;
  const toNext = (x.next.t - t) / 6e4, fromPrev = (t - x.prev.t) / 6e4, range = Math.abs(x.next.v - x.prev.v);
  const phase = toNext < 45 || fromPrev < 45 ? 'slack' : x.rising ? 'incoming' : 'outgoing';
  const text = phase === 'slack' ? 'Near the turn: slack water. Fish often bite best as the tide starts moving again.'
    : x.rising ? 'Incoming tide: fish push in over the flats, troughs and pier pilings as it floods.' : 'Outgoing tide: bait washes out of bays and channels; fish the mouths, holes and current seams.';
  return { ...x, phase, text, range, big: range >= 5 };
}

// ---------- Waves, swell and sea temperature (Open-Meteo Marine) ----------
export async function marineFor(lat, lon) {
  const k = `${(+lat).toFixed(3)},${(+lon).toFixed(3)}`;
  return liveOrSaved(`marine/${k}`, async () => {
    const r = await fetch(`https://marine-api.open-meteo.com/v1/marine?latitude=${(+lat).toFixed(3)}&longitude=${(+lon).toFixed(3)}&hourly=wave_height,wave_period,wave_direction,swell_wave_height,swell_wave_period,swell_wave_direction,sea_surface_temperature&daily=wave_height_max,swell_wave_height_max,swell_wave_period_max&timezone=auto&forecast_days=7&length_unit=imperial`, { signal: AbortSignal.timeout(20e3) });
    if (!r.ok) throw new Error('Marine forecast unavailable');
    const j = await r.json();
    if (!j.hourly?.time?.length || j.hourly.wave_height?.every(v => v == null)) throw new Error('No wave forecast this close to shore');
    return j;
  });
}

// ---------- NWS marine zone and its forecast ----------
// The coastal waters zone a spot sits in (PZZ…), from NWS's zone list.
export async function marineZone(lat, lon) {
  const key = `mzone/${(+lat).toFixed(2)},${(+lon).toFixed(2)}`;
  const { data } = await liveOrSaved(key, async () => {
    for (const type of ['marine', 'coastal']) {
      const r = await fetch(`https://api.weather.gov/zones?type=${type}&point=${(+lat).toFixed(4)},${(+lon).toFixed(4)}`, { headers: { Accept: 'application/geo+json' }, signal: AbortSignal.timeout(15e3) });
      if (!r.ok) continue;
      const f = (await r.json()).features?.[0]?.properties;
      if (f?.id) return { id: f.id, name: f.name, office: f.cwa?.[0] ?? null };
    }
    return null;
  }, { maxAgeMs: 365 * 864e5 });
  return data;
}
// A spot on a pier or the beach often sits on land, so its zone is looked up a little offshore (west, then around) when the point itself has none.
// With no signal it gives up at the first try (and throws), rather than waiting out nine lookups and blaming the zone list.
export async function marineZoneNear(lat, lon) {
  for (const [dy, dx] of [[0, 0], [0, -0.03], [-0.025, -0.025], [0.025, -0.025], [-0.03, 0], [0.03, 0], [0, -0.08], [-0.06, -0.06], [0.06, -0.06]]) {
    const z = await marineZone(lat + dy, lon + dx).catch(e => { if (noSignal(e)) throw e; return null; });
    if (z) return z;
  }
  return null;
}
export const zonePageUrl = id => `https://forecast.weather.gov/shmrn.php?mz=${encodeURIComponent(id.toLowerCase())}`;

// The NWS office that writes each zone's Coastal Waters Forecast, by the zone number's first digit (Pacific coast).
const CWF_OFFICE = { 2: 'PQR', 3: 'MFR', 4: 'EKA', 5: 'MTR', 6: 'LOX', 7: 'SGX' };

// Zones a UGC line names: "PZZ530-531-271615-" or "PZZ655>673-" → ['PZZ530', 'PZZ531'].
export function ugcZones(line) {
  const out = [];
  let prefix = null;
  for (const tok of line.trim().split('-')) {
    if (/^\d{6}$/.test(tok)) break;
    const m = tok.match(/^([A-Z]{3})?(\d{3})(?:>(\d{3}))?$/);
    if (!m) continue;
    prefix = m[1] ?? prefix;
    if (!prefix) continue;
    for (let n = +m[2]; n <= +(m[3] ?? m[2]); n++) out.push(prefix + String(n).padStart(3, '0'));
  }
  return out;
}

// One zone's part of a Coastal Waters Forecast product: { headlines, synopsis, periods: [{ name, text }] }.
export function parseCwf(text, zone) {
  const blocks = text.split(/\n\$\$\s*\n?/);
  // The synopsis block: a ".Synopsis for …..." header that may wrap over lines, a blank line, then the text.
  const syn = blocks.find(b => /^\.synopsis/im.test(b));
  const synopsis = syn ? syn.slice(syn.search(/^\.synopsis/im)).split(/\n\s*\n/).slice(1).join(' ').replace(/\s+/g, ' ').trim() || null : null;
  for (const b of blocks) {
    const lines = b.trim().split('\n');
    const i = lines.findIndex(l => /^[A-Z]{3}\d{3}[->]/.test(l));
    if (i < 0 || !ugcZones(lines[i]).includes(zone)) continue;
    const body = lines.slice(i + 1).join('\n');
    const headlines = [...body.matchAll(/^\.\.\.([^.][\s\S]*?)\.\.\.$/gm)].map(m => m[1].replace(/\s+/g, ' ').trim());
    const periods = [...body.matchAll(/^\.([A-Z][A-Z .]+?)\.\.\.([\s\S]*?)(?=^\.[A-Z][A-Z .]+?\.\.\.|(?![\s\S]))/gm)]
      .map(m => ({ name: m[1].trim(), text: m[2].replace(/\s+/g, ' ').trim() }));
    if (periods.length) return { headlines, synopsis, periods };
  }
  return null;
}

// The zone's latest Coastal Waters Forecast from NWS.
// Read from the office's latest product, which also carries the advisory headlines; if the zone isn't in it, NWS's
// per-zone periods instead (a bigger answer, since it comes with the zone's outline).
export async function zoneForecast(id, office = null) {
  office ??= CWF_OFFICE[String(id).match(/^PZZ(\d)/)?.[1]];
  return liveOrSaved(`mzfc/${id}`, async () => {
    const h = { headers: { Accept: 'application/ld+json' }, signal: AbortSignal.timeout(15e3) };
    if (office) try {
      const list = await (await fetch(`https://api.weather.gov/products/types/CWF/locations/${office}`, h)).json();
      const latest = list['@graph']?.[0];
      const p = latest && await (await fetch(`https://api.weather.gov/products/${encodeURIComponent(latest.id)}`, h)).json();
      const fc = p && parseCwf(p.productText ?? '', id);
      if (fc) return { ...fc, issued: p.issuanceTime, office };
    } catch {}
    const r = await fetch(`https://api.weather.gov/zones/forecast/${encodeURIComponent(id)}/forecast`, { headers: { Accept: 'application/geo+json' }, signal: AbortSignal.timeout(20e3) });
    const p = r.ok ? (await r.json()).properties : null;
    if (!p?.periods?.length) throw new Error('Marine forecast unavailable');
    return { headlines: [], synopsis: null, periods: p.periods.map(x => ({ name: x.name.toUpperCase(), text: x.detailedForecast })), issued: p.updated, office: office ?? 'NWS' };
  }, { maxAgeMs: 3 * 864e5 });
}

// NWS events that matter on the water, worst first.
export const MARINE_EVENTS = ['Hurricane Force Wind Warning', 'Storm Warning', 'Gale Warning', 'Hazardous Seas Warning', 'Special Marine Warning', 'Tsunami Warning', 'Tsunami Advisory',
  'High Surf Warning', 'Small Craft Advisory', 'Hazardous Seas Watch', 'Gale Watch', 'High Surf Advisory', 'Beach Hazards Statement', 'Rip Current Statement', 'Coastal Flood Advisory', 'Dense Fog Advisory', 'Marine Weather Statement'];
export const isMarineEvent = e => MARINE_EVENTS.includes(e) || /marine|seas|surf|rip current|craft|gale|tsunami|coastal/i.test(e);

// ---------- Marine protected areas ----------
export async function mpas() {
  const j = await load('mpas');
  return (j?.areas ?? []).map(a => ({ ...a, key: mpaKey(a.type, a.name) }));
}
function inRing([x, y], ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}
// Areas are [outer, hole, hole…] lists of polygons; a point is inside when it's in an outer ring and none of its holes.
const inArea = (p, a) => a.polys.some(rings => inRing(p, rings[0]) && !rings.slice(1).some(h => inRing(p, h)));
export async function mpaAt(lat, lon) {
  const p = [lon, lat];
  return (await mpas()).filter(a => lon >= a.bbox[0] && lon <= a.bbox[2] && lat >= a.bbox[1] && lat <= a.bbox[3] && inArea(p, a));
}
// Distance (km) from a point to the nearest edge of each area within maxKm, nearest first.
export async function mpasNear(lat, lon, maxKm = 3) {
  const kx = 111.32 * Math.cos(lat * Math.PI / 180), ky = 110.57, pad = maxKm / ky * 1.5;
  const out = [];
  for (const a of await mpas()) {
    if (lon < a.bbox[0] - pad * 1.5 || lon > a.bbox[2] + pad * 1.5 || lat < a.bbox[1] - pad || lat > a.bbox[3] + pad) continue;
    let best = Infinity;
    for (const rings of a.polys) for (const ring of rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const ax = (ring[j][0] - lon) * kx, ay = (ring[j][1] - lat) * ky, bx = (ring[i][0] - lon) * kx, by = (ring[i][1] - lat) * ky;
      const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
    const inside = inArea([lon, lat], a);
    if (inside || best <= maxKm) out.push({ ...a, inside, edgeKm: best });
  }
  return out.sort((a, b) => (b.inside - a.inside) || a.edgeKm - b.edgeKm);
}
