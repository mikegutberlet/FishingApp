// What's true at a water today, for the Getting there tab: snow on the ground and coming, and wildfires and
// prescribed burns nearby. Read live from public services when the tab opens and kept on this device for a few hours
// (Cache API `tb-access`, like the road lookup). Only the water's coordinates are sent.
//
//   NRCS SNOTEL (measured snow depth at the nearest mountain weather stations)
//   Open-Meteo (modelled snow depth and snowfall forecast at the water's elevation)
//   NIFC WFIGS current wildland fire incidents and perimeters (every agency's fires, including prescribed burns)
//   InciWeb (the public page for bigger incidents, when there is one)
import { haversineKm } from './data-sources.js';
import { distKmToLine } from './access-rules.js';

const CACHE = 'tb-access';
const MAX_AGE_H = 3;
const AWDB = 'https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1';
const WFIGS = 'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services';
const FIRE_KM = 50;   // fires within about 30 miles
const RX_KM = 25;     // prescribed burns within about 15 miles

const cacheUrl = key => `${location.origin}/__access-now/${encodeURIComponent(key)}.json`;
async function cacheGet(key) { try { const r = await (await caches.open(CACHE)).match(cacheUrl(key)); return r ? await r.json() : null; } catch { return null; } }
async function cachePut(key, data) { try { await (await caches.open(CACHE)).put(cacheUrl(key), new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })); } catch {} }
export const nowFresh = c => !!c && Date.now() - Date.parse(c.fetchedAt) < (c.failed?.length ? 0.5 : MAX_AGE_H) * 36e5;
export const cachedNow = (lat, lon) => cacheGet(`${(+lat).toFixed(3)},${(+lon).toFixed(3)}`);

// elevFt: the water's elevation when known (statewide waters carry it); else the elevation model's.
export async function lookupNow(lat, lon, { elevFt = null, force = false } = {}) {
  const key = `${(+lat).toFixed(3)},${(+lon).toFixed(3)}`;
  if (!force) { const c = await cacheGet(key); if (nowFresh(c)) return c; }
  const failed = [];
  const safe = (name, p) => p.catch(e => { console.warn(`access-now ${name}:`, e.message); failed.push(name); return null; });
  const [model, station, fires] = await Promise.all([
    safe('Open-Meteo', snowModel(lat, lon, elevFt)), safe('SNOTEL', snotel(lat, lon)), safe('Wildfire incidents', wildfires(lat, lon)),
  ]);
  const data = { fetchedAt: new Date().toISOString(), lat, lon, elevFt: elevFt ?? (model?.elevM != null ? Math.round(model.elevM * 3.28084) : null), model, station, fires, failed };
  if (failed.length < 3) await cachePut(key, data);
  return data;
}

// ---------- Snow ----------
async function snowModel(lat, lon, elevFt) {
  const q = new URLSearchParams({ latitude: lat.toFixed(4), longitude: lon.toFixed(4), timezone: 'auto', current: 'snow_depth,temperature_2m', daily: 'snowfall_sum,temperature_2m_max,temperature_2m_min', past_days: '7', forecast_days: '7' });
  if (elevFt) q.set('elevation', String(Math.round(elevFt / 3.28084)));
  const url = `https://api.open-meteo.com/v1/forecast?${q}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${r.status}`);
  const j = await r.json();
  const today = j.current?.time?.slice(0, 10);
  const days = (j.daily?.time ?? []).map((d, i) => ({ date: d, snowCm: j.daily.snowfall_sum[i] ?? 0, maxC: j.daily.temperature_2m_max[i], minC: j.daily.temperature_2m_min[i] }));
  return {
    depthIn: j.current?.snow_depth != null ? j.current.snow_depth * 39.37 : null, tempC: j.current?.temperature_2m ?? null, elevM: j.elevation ?? null,
    past: days.filter(d => d.date < today), next: days.filter(d => d.date >= today),
    source: { label: 'Open-Meteo weather model', url },
  };
}

// The SNOTEL stations in the three states, kept for a month (they rarely change).
async function stations() {
  const key = 'snotel-stations-v1', c = await cacheGet(key);
  if (c && Date.now() - Date.parse(c.fetchedAt) < 30 * 864e5) return c.list;
  const lists = await Promise.all(['CA', 'NV', 'OR'].map(async st => {
    const r = await fetch(`${AWDB}/stations?stationTriplets=*:${st}:SNTL&returnStationElements=false&activeOnly=true`, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`${r.status}`);
    return (await r.json()).map(s => ({ id: s.stationTriplet, num: s.stationId, name: s.name, lat: s.latitude, lon: s.longitude, elevFt: s.elevation }));
  }));
  const list = lists.flat();
  await cachePut(key, { fetchedAt: new Date().toISOString(), list });
  return list;
}

// Measured snow depth at the nearest stations (up to 3 within 60 km), today and a week ago.
async function snotel(lat, lon) {
  const near = (await stations()).map(s => ({ ...s, distKm: haversineKm(lat, lon, s.lat, s.lon) })).filter(s => s.distKm <= 60).sort((a, b) => a.distKm - b.distKm).slice(0, 3);
  if (!near.length) return [];
  const day = d => d.toISOString().slice(0, 10);
  const r = await fetch(`${AWDB}/data?${new URLSearchParams({ stationTriplets: near.map(s => s.id).join(','), elements: 'SNWD', duration: 'DAILY', beginDate: day(new Date(Date.now() - 9 * 864e5)), endDate: day(new Date()) })}`, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`${r.status}`);
  const rows = await r.json();
  return near.map(s => {
    const vals = (rows.find(x => x.stationTriplet === s.id)?.data?.[0]?.values ?? []).filter(v => v.value != null);
    const last = vals.at(-1), week = vals.find(v => v.date >= day(new Date(Date.parse(last?.date ?? 0) - 7 * 864e5)));
    return { ...s, depthIn: last?.value ?? null, date: last?.date ?? null, weekAgoIn: week && week !== last ? week.value : null,
      source: { label: `NRCS SNOTEL ${s.name}`, url: `https://wcc.sc.egov.usda.gov/nwcc/site?sitenum=${s.num}` } };
  }).filter(s => s.depthIn != null);
}

// ---------- Wildfires ----------
async function arcJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message ?? 'query error');
  return j.features ?? [];
}
const box = (lat, lon, km) => { const dLat = km / 110.57, dLon = km / (111.32 * Math.cos(lat * Math.PI / 180)); return [lon - dLon, lat - dLat, lon + dLon, lat + dLat].map(n => n.toFixed(4)).join(','); };
const envelope = (lat, lon, km) => ({ geometry: box(lat, lon, km), geometryType: 'esriGeometryEnvelope', inSR: '4326', outSR: '4326', spatialRel: 'esriSpatialRelIntersects', f: 'json' });

// Point in polygon (rings of [lon, lat]), even-odd.
const inside = (lat, lon, rings) => rings.reduce((acc, ring) => {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) c = !c;
  }
  return acc !== c;
}, false);

async function wildfires(lat, lon) {
  const layer = `${WFIGS}/WFIGS_Incident_Locations_Current/FeatureServer/0`, perims = `${WFIGS}/WFIGS_Interagency_Perimeters_Current/FeatureServer/0`;
  const fields = 'OBJECTID,IrwinID,IncidentName,IncidentTypeCategory,IncidentSize,PercentContained,FireDiscoveryDateTime,ModifiedOnDateTime_dt,IncidentShortDescription,POOState,POOLandownerCategory,UniqueFireIdentifier,FireOutDateTime';
  const [points, polys] = await Promise.all([
    arcJson(`${layer}/query?${new URLSearchParams({ ...envelope(lat, lon, FIRE_KM), outFields: fields, returnGeometry: 'true', resultRecordCount: '50' })}`),
    arcJson(`${perims}/query?${new URLSearchParams({ ...envelope(lat, lon, FIRE_KM), outFields: 'OBJECTID,poly_IRWINID,poly_IncidentName,poly_GISAcres,poly_DateCurrent', returnGeometry: 'true', maxAllowableOffset: '0.002', geometryPrecision: '4', resultRecordCount: '30' })}`).catch(() => []),
  ]);
  const byId = new Map(polys.map(p => [p.attributes.poly_IRWINID, p]));
  const out = points.map(f => {
    const a = f.attributes, g = f.geometry ?? {};
    const rx = a.IncidentTypeCategory === 'RX';
    const poly = byId.get(a.IrwinID), rings = poly?.geometry?.rings ?? [];
    const isIn = rings.length && inside(lat, lon, rings);
    // Distance to the fire's edge when it has a mapped perimeter, else to its reported point.
    const distKm = isIn ? 0 : rings.length ? Math.min(...rings.map(r => distKmToLine(lat, lon, r.map(([x, y]) => [y, x])))) : haversineKm(lat, lon, g.y, g.x);
    return {
      name: a.IncidentName, rx, acres: poly?.attributes.poly_GISAcres ?? a.IncidentSize ?? null, contained: a.PercentContained, started: a.FireDiscoveryDateTime ? new Date(a.FireDiscoveryDateTime).toISOString() : null,
      updated: a.ModifiedOnDateTime_dt ? new Date(a.ModifiedOnDateTime_dt).toISOString() : null, where: a.IncidentShortDescription ?? null, state: a.POOState?.replace('US-', '') ?? null,
      land: a.POOLandownerCategory ?? null, distKm, inside: !!isIn, lat: g.y, lon: g.x, perimeter: !!rings.length,
      source: { label: 'NIFC wildland fire incidents (WFIGS)', url: `${layer}/query?where=OBJECTID%3D${a.OBJECTID}&outFields=*&f=html` },
    };
  }).filter(f => f.distKm <= (f.rx ? RX_KM : FIRE_KM)).sort((a, b) => a.distKm - b.distKm).slice(0, 8);
  // InciWeb has a page for the bigger ones: match by name.
  if (out.some(f => !f.rx && (f.acres ?? 0) >= 100)) {
    try {
      const r = await fetch('https://inciweb.wildfire.gov/incidents/rss.xml', { signal: AbortSignal.timeout(15000) });
      const xml = r.ok ? await r.text() : '';
      for (const item of xml.split('<item>').slice(1)) {
        const t = item.match(/<title>([^<]*)<\/title>/)?.[1]?.trim(), link = item.match(/<link>([^<]*)<\/link>/)?.[1]?.trim();
        if (!t || !link) continue;
        const f = out.find(f => !f.inciweb && t.toLowerCase().includes(String(f.name).toLowerCase().replace(/\s+fire$/, '')));
        if (f) f.inciweb = link.replace(/^http:/, 'https:');
      }
    } catch {}
  }
  return out;
}

// ---------- Forest Service alerts (closure orders and fire restrictions) ----------
// Each forest's Alerts page lists its current closure orders. Keyed by the name PAD-US and the Motor Vehicle Use Map
// use for the forest.
const R5 = 'https://www.fs.usda.gov/r05', R6 = 'https://www.fs.usda.gov/r06', R4 = 'https://www.fs.usda.gov/r04';
export const FOREST_ALERTS = {
  'angeles': `${R5}/angeles/alerts`, 'cleveland': `${R5}/cleveland/alerts`, 'eldorado': `${R5}/eldorado/alerts`, 'inyo': `${R5}/inyo/alerts`,
  'klamath': `${R5}/klamath/alerts`, 'lassen': `${R5}/lassen/alerts`, 'los padres': `${R5}/lospadres/alerts`, 'mendocino': `${R5}/mendocino/alerts`,
  'modoc': `${R5}/modoc/alerts`, 'plumas': `${R5}/plumas/alerts`, 'san bernardino': `${R5}/sanbernardino/alerts`, 'sequoia': `${R5}/sequoia/alerts`,
  'shasta-trinity': `${R5}/shasta-trinity/alerts`, 'sierra': `${R5}/sierra/alerts`, 'six rivers': `${R5}/sixrivers/alerts`, 'stanislaus': `${R5}/stanislaus/alerts`,
  'tahoe': `${R5}/tahoe/alerts`, 'lake tahoe basin': `${R5}/ltbmu/alerts`,
  'deschutes': `${R6}/deschutes/alerts`, 'fremont-winema': `${R6}/fremont-winema/alerts`, 'malheur': `${R6}/malheur/alerts`, 'mt. hood': `${R6}/mthood/alerts`,
  'mount hood': `${R6}/mthood/alerts`, 'ochoco': `${R6}/ochoco/alerts`, 'rogue river-siskiyou': `${R6}/rogue-siskiyou/alerts`, 'siuslaw': `${R6}/siuslaw/alerts`,
  'umatilla': `${R6}/umatilla/alerts`, 'umpqua': `${R6}/umpqua/alerts`, 'wallowa-whitman': `${R6}/wallowa-whitman/alerts`, 'willamette': `${R6}/willamette/alerts`,
  'columbia river gorge': `${R6}/crgnsa/alerts`, 'humboldt-toiyabe': `${R4}/htnf/alerts`,
};
export function forestAlerts(name) {
  const n = String(name ?? '').toLowerCase();
  const k = Object.keys(FOREST_ALERTS).sort((a, b) => b.length - a.length).find(k => n.includes(k));
  return k ? FOREST_ALERTS[k] : null;
}
