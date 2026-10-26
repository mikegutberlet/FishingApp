// Getting-there lookup for one water: roads, motorised routes, trails, gates and land manager around its point, read
// live from public services and kept on this device (Cache API, so it works again with no signal and isn't in your
// backup). Only the water's coordinates are sent. Each record keeps a link to the source entry it came from.
//
//   USFS Motor Vehicle Use Map (roads and motorised trails, with the vehicles and dates each is open to)
//   USFS National Forest System roads (maintenance level: passenger car or high clearance) and trails (managed uses)
//   BLM Ground Transportation Linear Features (public motorised roads, limited roads, motorised and non-motorised trails)
//   USGS PAD-US (who manages the land) via ArcGIS Online
//   OpenStreetMap via the Overpass API (every road and path, with surface and access tags where mappers added them)
//   Wikipedia (a short description of the water, when it has an article)
import { searchKm, shoreKm } from './access-rules.js';

const FS = 'https://apps.fs.usda.gov/arcx/rest/services/EDW';
const BLM = 'https://gis.blm.gov/arcgis/rest/services/transportation/BLM_Natl_GTLF_Public_Display/MapServer';
const PADUS = 'https://services.arcgis.com/v01gqwM5QqNysAAi/ArcGIS/rest/services/Manager_Name_PADUS/FeatureServer/0';
// The public Overpass server answers in 30–40 s or says it's at capacity (502); the mirrors timed out in testing.
const OVERPASS = 'https://overpass-api.de/api/interpreter';
const CACHE = 'tb-access'; // sw.js keeps this cache across app updates
export const MAX_AGE_DAYS = 90;
// A lookup where a service didn't answer is tried again the next day.
export const isFresh = c => !!c && Date.now() - Date.parse(c.fetchedAt) < (c.failed?.length ? 1 : MAX_AGE_DAYS) * 864e5;

// A lookup is for a water, at its own map point or at a spot on its shore you picked (big lakes, long rivers).
export const accessKey = (lake, spot = null) => (lake.nhdId ? `nhd-${lake.nhdId}` : String(lake.id)) + (spot ? `@${(+spot.lat).toFixed(3)},${(+spot.lon).toFixed(3)}` : '');
const cacheUrl = (lake, spot) => `${location.origin}/__access/${encodeURIComponent(accessKey(lake, spot))}.json`;

export async function cached(lake, spot = null) {
  try { const r = await (await caches.open(CACHE)).match(cacheUrl(lake, spot)); return r ? await r.json() : null; } catch { return null; }
}
async function store(lake, spot, data) {
  try { await (await caches.open(CACHE)).put(cacheUrl(lake, spot), new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })); } catch {}
}
export async function forget(lake, spot = null) {
  try { await (await caches.open(CACHE)).delete(cacheUrl(lake, spot)); } catch {}
}

// The lookup. `spot` checks a point you picked instead of the water's own point (then the shore is taken to be right
// there). `force` refetches even when a fresh copy is on the device. Sources that fail are listed in `failed` so the
// page can say what it couldn't check, and what did answer is still kept. OpenStreetMap's server often takes 30–40 s,
// so `onPartial` gets everything else first, with `pending` naming what is still on its way.
export async function lookupAccess(lake, { spot = null, force = false, onPartial = null } = {}) {
  if (!force) {
    const c = await cached(lake, spot);
    if (isFresh(c)) return c;
  }
  const lat = +(spot?.lat ?? lake.lat), lon = +(spot?.lon ?? lake.lon), shore = spot ? 0 : shoreKm(lake), km = spot ? 2 : searchKm(lake);
  const dLat = km / 110.57, dLon = km / (111.32 * Math.cos(lat * Math.PI / 180));
  const bbox = [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
  const failed = [], features = [];
  const run = async (name, fn) => { try { const r = await fn(); if (r) features.push(...r); } catch (e) { console.warn(`access ${name}:`, e.message); failed.push(name); } };
  const osmDone = run('OpenStreetMap', () => osm(lat, lon, km));
  let osmFinished = false;
  osmDone.then(() => { osmFinished = true; });
  const [land, about] = await Promise.all([
    padus(lat, lon, shore).catch(e => { console.warn('access PAD-US:', e.message); failed.push('PAD-US'); return null; }),
    wikipedia(lake, km).catch(e => { console.warn('access Wikipedia:', e.message); failed.push('Wikipedia'); return null; }),
    run('USFS MVUM', () => mvum(bbox)),
    run('USFS roads', () => nfsRoads(bbox)),
    run('USFS trails', () => nfsTrails(bbox)),
    run('BLM routes', () => blm(bbox)),
  ]);
  const snapshot = pending => ({ fetchedAt: new Date().toISOString(), lat, lon, spot: spot ? { lat, lon, label: spot.label ?? null } : null, searchKm: km, shoreKm: shore,
    features: dedupe(features), land, about, failed: [...failed], pending });
  if (!osmFinished && onPartial) onPartial(snapshot(['OpenStreetMap']));
  await osmDone;
  const data = snapshot([]);
  // A lookup where nothing answered isn't worth keeping: offline, or every service down.
  if (failed.length < 6) await store(lake, spot, data);
  return data;
}

// ---------- ArcGIS REST ----------
const arcUrl = (layerUrl, bbox, outFields, extra = {}) => `${layerUrl}/query?` + new URLSearchParams({
  geometry: bbox.join(','), geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', outFields, returnGeometry: 'true', outSR: '4326',
  geometryPrecision: '5', maxAllowableOffset: '0.0001', resultRecordCount: '300', f: 'json', ...extra,
});
// The Forest Service's MVUM trail layer sometimes answers "Error performing query operation" (seen at Rye Patch and
// Caples Lake): ask once more without the simplified geometry, then give up on that layer.
async function arc(layerUrl, bbox, outFields, extra = {}) {
  for (const plain of [false, true]) {
    const r = await fetch(arcUrl(layerUrl, bbox, outFields, plain ? { geometryPrecision: '', maxAllowableOffset: '', ...extra } : extra), { signal: AbortSignal.timeout(25000) });
    if (!r.ok) throw new Error(`${r.status}`);
    const j = await r.json();
    if (!j.error) return j.features ?? [];
    if (plain) throw new Error(j.error.message ?? 'query error');
  }
}
// The record a fact came from, as a page anyone can open.
const arcRecord = (layerUrl, idField, id) => `${layerUrl}/query?where=${idField}%3D${id}&outFields=*&f=html`;
const paths = f => (f.geometry?.paths ?? []).map(p => p.map(([x, y]) => [+y.toFixed(5), +x.toFixed(5)])).filter(p => p.length > 1);

// USFS Motor Vehicle Use Map: which vehicles each road and motorised trail is open to, and when.
async function mvum(bbox) {
  const base = `${FS}/EDW_MVUM_01/MapServer`;
  const fields = 'objectid,id,name,symbol,mvum_symbol_name,seasonal,passengervehicle,passengervehicle_datesopen,highclearancevehicle,highclearancevehicle_datesopen,atv,atv_datesopen,motorcycle,motorcycle_datesopen,fourwd_gt50inches,forestname,districtname,surfacetype,operationalmaintlevel';
  const [roads, trails] = await Promise.all([arc(`${base}/1`, bbox, fields),
    arc(`${base}/2`, bbox, fields.replace(',surfacetype,operationalmaintlevel', '')).catch(e => { console.warn('access MVUM trails:', e.message); return []; })]);
  const norm = (f, kind, layer) => {
    const a = f.attributes, seasonal = /seasonal/i.test(a.seasonal ?? '') || /seasonal/i.test(a.mvum_symbol_name ?? '');
    const open = (v, d) => v == null ? 'no' : seasonal || (d && !/^01\/01-12\/31$/.test(d)) ? 'seasonal' : 'yes';
    const dates = {};
    for (const [k, d] of [['car', a.passengervehicle_datesopen], ['highClearance', a.highclearancevehicle_datesopen], ['atv', a.atv_datesopen], ['motorcycle', a.motorcycle_datesopen]]) if (d && !/^01\/01-12\/31$/.test(d)) dates[k] = d;
    const streetLegalOnly = /^(3|4)$/.test(String(a.symbol)) || /highway legal/i.test(a.mvum_symbol_name ?? '');
    // Passenger cars may be allowed on a road the Forest Service only keeps passable for high clearance.
    const lvl = parseInt(a.operationalmaintlevel) || null, rough = lvl != null && lvl <= 2;
    return {
      kind, name: title(a.name) || (a.id ? `${kind === 'road' ? 'Forest Road' : 'Trail'} ${a.id}` : null), ref: a.id, paths: paths(f),
      tags: {
        car: kind === 'road' && !rough ? open(a.passengervehicle, a.passengervehicle_datesopen) : 'no',
        highClearance: open(a.highclearancevehicle, a.highclearancevehicle_datesopen),
        atv: streetLegalOnly ? 'no' : open(a.atv, a.atv_datesopen), motorcycle: streetLegalOnly ? 'no' : open(a.motorcycle, a.motorcycle_datesopen),
        wide: open(a.fourwd_gt50inches), foot: null, bike: null, dates, streetLegalOnly, closed: false,
        surface: surfaceOf(a.surfacetype), maint: a.operationalmaintlevel ?? null, designation: [a.mvum_symbol_name, rough && a.passengervehicle ? 'cars allowed but not maintained for them' : null].filter(Boolean).join(' · ') || null, seasonal,
      },
      source: { label: `USFS Motor Vehicle Use Map${a.forestname ? ` · ${title(a.forestname)}` : ''}`, url: arcRecord(`${base}/${layer}`, 'objectid', a.objectid), id: `mvum-${a.objectid}` },
    };
  };
  return [...roads.map(f => norm(f, 'road', 1)), ...trails.map(f => norm(f, 'trail', 2))];
}

// USFS road inventory: maintenance level says what the road is kept passable for.
async function nfsRoads(bbox) {
  const layer = `${FS}/EDW_RoadBasic_01/MapServer/0`;
  const rows = await arc(layer, bbox, 'objectid,id,name,oper_maint_level,surface_type,symbol_name,openforuseto,route_status,jurisdiction,primary_maintainer');
  return rows.map(f => {
    const a = f.attributes, lvl = parseInt(a.oper_maint_level) || null;
    const admin = /admin|closed/i.test(a.openforuseto ?? '') || /decommission|closed|conver/i.test(a.route_status ?? '') || lvl === 1;
    return {
      kind: 'road', name: title(a.name) || (a.id ? `Forest Road ${a.id}` : null), ref: a.id, paths: paths(f),
      tags: {
        car: admin ? 'no' : lvl >= 3 ? 'yes' : lvl === 2 ? 'no' : null, highClearance: admin ? 'no' : lvl >= 2 ? 'yes' : null,
        atv: null, motorcycle: null, foot: null, bike: null, dates: {}, closed: admin, streetLegalOnly: /highway legal/i.test(a.openforuseto ?? ''),
        surface: surfaceOf(a.surface_type) ?? (/paved/i.test(a.symbol_name ?? '') ? 'paved' : /gravel|dirt/i.test(a.symbol_name ?? '') ? 'gravel' : null),
        maint: a.oper_maint_level ?? null, designation: a.symbol_name ?? null,
      },
      source: { label: 'USFS National Forest System roads', url: arcRecord(layer, 'objectid', a.objectid), id: `nfsr-${a.objectid}` },
    };
  });
}

// USFS trails: which uses each trail is managed for or accepts (a date range in the field), and which are restricted
// (prohibited) there. Trails in the basic data set say "N/A" for all of them: not recorded.
async function nfsTrails(bbox) {
  const layer = `${FS}/EDW_TrailNFSPublish_01/MapServer/0`;
  const USES = { foot: 'hiker_pedestrian', bike: 'bicycle', motorcycle: 'motorcycle', atv: 'atv', wide: 'fourwd' };
  // Asking for a field the layer doesn't have fails the whole query ("Failed to execute query"), so the list is exact.
  const fields = Object.values(USES).flatMap(u => [`${u}_managed`, `${u}_accpt_disc`, `${u}_restricted`]).join(',');
  const rows = await arc(layer, bbox, `objectid,trail_name,trail_no,trail_type,trail_class,trail_surface,terra_motorized,gis_miles,typical_trail_grade,${fields}`);
  const val = v => v != null && String(v).trim() && !/^n\/?a$/i.test(String(v).trim()) ? String(v).trim() : null;
  const allYear = d => /^01\/01-12\/31/.test(d);
  return rows.filter(f => !f.attributes.trail_type || /terra/i.test(f.attributes.trail_type)).map(f => {
    const a = f.attributes, tags = {}, dates = {};
    for (const [k, u] of Object.entries(USES)) {
      const ok = val(a[`${u}_managed`]) ?? val(a[`${u}_accpt_disc`]), no = val(a[`${u}_restricted`]);
      tags[k] = ok ? (allYear(ok) || !/\d\d\/\d\d/.test(ok) ? 'yes' : 'seasonal') : no ? 'no' : null;
      if (ok && tags[k] === 'seasonal') dates[k] = ok;
    }
    const motor = val(a.terra_motorized);
    if (/^n$/i.test(motor ?? '')) { tags.motorcycle ??= 'no'; tags.atv ??= 'no'; }
    return {
      kind: 'trail', name: title(a.trail_name) || (a.trail_no ? `Trail ${a.trail_no}` : null), ref: a.trail_no, paths: paths(f),
      tags: {
        ...tags, foot: tags.foot ?? 'yes', car: 'no', highClearance: 'no', dates, closed: false,
        trailClass: a.trail_class ?? null, surface: val(a.trail_surface), grade: val(a.typical_trail_grade), miles: a.gis_miles ?? null,
        designation: [a.trail_class && `class ${a.trail_class} trail`, val(a.typical_trail_grade) && `grade ${val(a.typical_trail_grade).replace(/^TG\d+ - /, '')}`].filter(Boolean).join(' · ') || null,
      },
      source: { label: 'USFS National Forest System trails', url: arcRecord(layer, 'objectid', a.objectid), id: `nfst-${a.objectid}` },
    };
  });
}

// BLM routes managed for public use. The layer says what the route is for; the attributes add surface, season and
// OHV designation (Open, Limited, Closed).
async function blm(bbox) {
  const LAYERS = { 0: 'road', 1: 'roadLimited', 2: 'trailMotor', 3: 'trailMotorLimited', 4: 'trailNonMotor', 5: 'trailNonMech' };
  const fields = 'OBJECTID,ROUTE_PRMRY_NM,PLAN_ASSET_CLASS,PLAN_OHV_ROUTE_DSGNTN,OHV_ROUTE_DSGNTN_LIM,OHV_DSGNTN_LIM_EXPLAIN,PLAN_MODE_TRNSPRT,PLAN_ALLOW_MODE_TRNSPRT,PLAN_SEASON_RSTRCT_CODE,PLAN_ACCESS_RSTRCT,OBSRVE_SRFCE_TYPE,OBSRVE_ROUTE_USE_CLASS,GIS_MILES';
  const all = await Promise.all(Object.keys(LAYERS).map(l => arc(`${BLM}/${l}`, bbox, fields).then(rows => rows.map(f => [l, f]))));
  return all.flat().map(([l, f]) => {
    const a = f.attributes, what = LAYERS[l], limited = /limited/i.test(a.PLAN_OHV_ROUTE_DSGNTN ?? '') || what.endsWith('Limited');
    const lim = [a.OHV_ROUTE_DSGNTN_LIM, a.OHV_DSGNTN_LIM_EXPLAIN].filter(Boolean).join(': ');
    const primitive = /primitive/i.test(a.PLAN_ASSET_CLASS ?? '');
    const season = a.PLAN_SEASON_RSTRCT_CODE && /yes|season/i.test(a.PLAN_SEASON_RSTRCT_CODE);
    const motor = what.startsWith('road') || what.startsWith('trailMotor');
    const v = ok => !ok ? 'no' : limited || season ? 'seasonal' : 'yes';
    const dates = lim ? { note: lim } : {};
    return {
      kind: what.startsWith('road') ? 'road' : 'trail', name: title(a.ROUTE_PRMRY_NM) || null, ref: null, paths: paths(f),
      tags: what.startsWith('road') ? {
        car: v(!primitive), highClearance: v(true), atv: v(true), motorcycle: v(true), foot: 'yes', bike: 'yes', dates, closed: /closed/i.test(a.PLAN_OHV_ROUTE_DSGNTN ?? ''),
        streetLegalOnly: false, surface: surfaceOf(a.OBSRVE_SRFCE_TYPE), maint: null, designation: `${primitive ? 'Primitive road' : 'Road'} · OHV ${a.PLAN_OHV_ROUTE_DSGNTN ?? 'designation not recorded'}`,
      } : {
        car: 'no', highClearance: 'no', atv: v(motor), motorcycle: v(motor), foot: 'yes', bike: what === 'trailNonMech' ? 'no' : 'yes', dates, closed: false,
        surface: a.OBSRVE_SRFCE_TYPE ?? null, miles: a.GIS_MILES ?? null, designation: { trailMotor: 'Motorised trail', trailMotorLimited: 'Motorised trail, limited', trailNonMotor: 'Non-motorised trail (hike, bike, horse)', trailNonMech: 'Non-mechanised trail (hike, horse)' }[what],
      },
      source: { label: 'BLM roads and trails (GTLF)', url: arcRecord(`${BLM}/${l}`, 'OBJECTID', a.OBJECTID), id: `blm-${l}-${a.OBJECTID}` },
    };
  });
}

// Who manages the land around the water (PAD-US). The shore and a little beyond; the manager with the most
// parcels first, others listed after.
async function padus(lat, lon, shore) {
  const km = shore + 0.3;
  const d = [km / (111.32 * Math.cos(lat * Math.PI / 180)), km / 110.57];
  const rows = await arc(PADUS, [lon - d[0], lat - d[1], lon + d[0], lat + d[1]], 'OBJECTID,Mang_Name,Mang_Type,Unit_Nm,Loc_Nm,Des_Tp,Pub_Access,GIS_Acres,Loc_Mang,Own_Name', { returnGeometry: 'false', resultRecordCount: '50' });
  if (!rows.length) return { parcels: [], updatedAt: new Date().toISOString() };
  const by = {};
  for (const { attributes: a } of rows) {
    const k = `${a.Mang_Name}|${a.Unit_Nm}`;
    by[k] ??= { manager: a.Mang_Name, type: a.Mang_Type, unit: a.Unit_Nm, local: a.Loc_Nm, designation: a.Des_Tp, access: a.Pub_Access, acres: 0, n: 0, localManager: a.Loc_Mang, owner: a.Own_Name, source: { label: 'USGS Protected Areas Database (PAD-US)', url: arcRecord(PADUS, 'OBJECTID', a.OBJECTID) } };
    by[k].n++; by[k].acres += a.GIS_Acres ?? 0;
  }
  return { parcels: Object.values(by).sort((x, y) => y.n - x.n || y.acres - x.acres).slice(0, 4) };
}

// ---------- OpenStreetMap ----------
const OSM_ROADS = /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|track|road|living_street)(_link)?$/;
const OSM_TRAILS = /^(path|footway|bridleway|cycleway|steps)$/;
async function osm(lat, lon, km) {
  const m = Math.round(km * 1000);
  const q = `[out:json][timeout:60];(way[highway~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|track|path|footway|bridleway|cycleway|road|living_street|steps)(_link)?$"][service!~"driveway|parking_aisle"](around:${m},${lat},${lon});node[barrier~"^(gate|lift_gate|swing_gate)$"](around:${m},${lat},${lon}););out tags geom 400;`;
  let last;
  for (const wait of [0, 4000, 12000]) {
    if (wait) await new Promise(r => setTimeout(r, wait));
    try {
      const r = await fetch(OVERPASS, { method: 'POST', body: new URLSearchParams({ data: q }), signal: AbortSignal.timeout(70000) });
      if (r.status === 429 || r.status >= 500) { last = new Error(`${r.status}: server busy`); continue; }
      if (!r.ok) throw new Error(`${r.status}`);
      const j = await r.json();
      if (j.remark && !j.elements?.length) throw new Error(j.remark);
      return (j.elements ?? []).map(osmFeature).filter(Boolean);
    } catch (e) {
      last = e;
      // Timed out, or the phone has no network: don't wait to try again. A dropped connection (the server is busy) is retried.
      if (e.name === 'TimeoutError' || e.name === 'AbortError' || globalThis.navigator?.onLine === false) break;
    }
  }
  throw last ?? new Error('Overpass unreachable');
}

const NO = /^(no|private|permit|customers|delivery|agricultural|forestry|military|discouraged)$/;
const UNPAVED = /^(unpaved|gravel|fine_gravel|dirt|earth|ground|grass|sand|compacted|pebblestone|mud|rock|woodchips|snow|ice|salt|clay|shells|chipseal)$/;
const PAVED = /^(paved|asphalt|concrete|concrete:.*|paving_stones|sett|cobblestone|metal|wood|brick)$/;
function osmFeature(e) {
  const t = e.tags ?? {}, url = `https://www.openstreetmap.org/${e.type}/${e.id}`;
  const src = { label: 'OpenStreetMap', url, id: `osm-${e.type}-${e.id}` };
  if (e.type === 'node') {
    return { kind: 'gate', name: title(t.name) || 'Gate', lat: e.lat, lon: e.lon, paths: [], tags: { locked: t.locked === 'yes' || NO.test(t.access ?? '') || NO.test(t.motor_vehicle ?? ''), access: t.access ?? t.motor_vehicle ?? null, note: t.note ?? t.description ?? null }, source: src };
  }
  const geom = (e.geometry ?? []).map(p => [+p.lat.toFixed(5), +p.lon.toFixed(5)]);
  if (geom.length < 2) return null;
  const hw = t.highway ?? '';
  const name = title(t.name) || (t.ref ? `${/^track|path/.test(hw) ? 'Route' : 'Road'} ${t.ref}` : null);
  const motorAccess = t.motor_vehicle ?? t.vehicle ?? t.access ?? null;
  const dates = t.seasonal && t.seasonal !== 'no' ? { note: `seasonal${t.seasonal === 'yes' ? '' : `: ${t.seasonal}`}` } : {};
  if (OSM_ROADS.test(hw)) {
    const closed = NO.test(motorAccess ?? '') || t.disused === 'yes' || t.abandoned === 'yes';
    // Only highways are taken as paved when no surface is tagged: a rural street from the Census import is often dirt.
    const paved = PAVED.test(t.surface ?? '') || (!t.surface && /^(motorway|trunk|primary|secondary|tertiary)/.test(hw));
    const grade = parseInt((t.tracktype ?? '').replace('grade', '')) || null;
    // A track is a dirt road; grade3–5, a rough smoothness or 4wd_only says a car won't make it. One with no surface
    // or grade tagged is left unknown rather than guessed.
    const rough = t['4wd_only'] === 'yes' || /^(bad|very_bad|horrible|very_horrible|impassable)$/.test(t.smoothness ?? '') || grade >= 3;
    const bare = hw === 'track' && !grade && !t.surface && !t.smoothness;
    const car = closed || rough ? 'no' : bare ? null : 'yes';
    const ohv = v => v == null ? null : NO.test(v) ? 'no' : 'yes';
    return {
      kind: 'road', name, ref: t.ref ?? null, paths: [geom],
      tags: {
        car, highClearance: closed ? 'no' : bare ? null : 'yes', atv: closed ? 'no' : ohv(t.atv), motorcycle: closed ? 'no' : ohv(t.motorcycle), foot: t.foot === 'no' ? 'no' : 'yes', bike: t.bicycle === 'no' ? 'no' : 'yes',
        dates, closed, streetLegalOnly: false, surface: paved ? 'paved' : rough ? 'rough' : t.surface || grade ? 'gravel' : null, maint: null, noStop: /^motorway/.test(hw),
        designation: [hwName(hw), t.surface, t.tracktype, t.smoothness && `smoothness ${t.smoothness}`, t['4wd_only'] === 'yes' && '4WD only', motorAccess && motorAccess !== 'yes' && `access ${motorAccess}`, t.toll === 'yes' && 'toll'].filter(Boolean).join(' · '),
      },
      source: src,
    };
  }
  if (OSM_TRAILS.test(hw)) {
    const yes = v => v == null ? null : /^(yes|designated|permissive|official)$/.test(v) ? 'yes' : NO.test(v) ? 'no' : null;
    const motor = NO.test(motorAccess ?? '') ? 'no' : null;
    return {
      kind: 'trail', name, ref: t.ref ?? null, paths: [geom],
      tags: {
        foot: t.foot === 'no' ? 'no' : 'yes', bike: hw === 'cycleway' ? 'yes' : hw === 'steps' ? 'no' : yes(t.bicycle) ?? (t['mtb:scale'] != null ? 'yes' : null),
        motorcycle: yes(t.motorcycle) ?? motor, atv: yes(t.atv) ?? motor, car: 'no', highClearance: 'no', dates, closed: false,
        surface: t.surface ?? null, sac: t.sac_scale ?? null, mtb: t['mtb:scale'] ?? null,
        designation: [hwName(hw), t.surface, t.sac_scale && t.sac_scale.replace(/_/g, ' '), t['mtb:scale'] != null && `mtb scale ${t['mtb:scale']}`, t.informal === 'yes' && 'informal'].filter(Boolean).join(' · '),
      },
      source: src,
    };
  }
  return null;
}
const hwName = hw => ({ motorway: 'Freeway', trunk: 'Highway', primary: 'Main road', secondary: 'Main road', tertiary: 'Local road', unclassified: 'Minor road', residential: 'Street', service: 'Service road', track: 'Track', road: 'Road', living_street: 'Street', path: 'Path', footway: 'Footpath', bridleway: 'Bridle path', cycleway: 'Cycle path', steps: 'Steps' }[hw.replace('_link', '')] ?? hw);

// ---------- Wikipedia ----------
// The article about this water, if there is one within reach whose title shares the water's name.
async function wikipedia(lake, km) {
  const words = String(lake.name ?? '').toLowerCase().replace(/\b(lake|reservoir|river|creek|pond|the|of|res|lk|north|south|east|west|upper|lower|fork)\b|[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2);
  if (!words.length) return null;
  const r = await fetch(`https://en.wikipedia.org/w/api.php?${new URLSearchParams({ action: 'query', list: 'geosearch', gscoord: `${lake.lat}|${lake.lon}`, gsradius: String(Math.min(10000, Math.round(km * 1000) + 3000)), gslimit: '20', format: 'json', origin: '*' })}`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${r.status}`);
  const hits = (await r.json()).query?.geosearch ?? [];
  const hit = hits.find(h => { const t = h.title.toLowerCase(); return words.every(w => t.includes(w)) && /lake|reservoir|river|creek|pond|lagoon|slough|bay|dam/.test(t) || (words.every(w => t.includes(w)) && h.dist < 1500); })
    ?? hits.find(h => words.every(w => h.title.toLowerCase().includes(w)));
  if (!hit) return null;
  const s = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(hit.title.replace(/ /g, '_'))}`, { signal: AbortSignal.timeout(15000) });
  if (!s.ok) throw new Error(`${s.status}`);
  const j = await s.json();
  if (!j.extract) return null;
  return { title: j.title, extract: j.extract, url: j.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(hit.title.replace(/ /g, '_'))}`, distKm: hit.dist / 1000 };
}

// ---------- helpers ----------
const title = s => s ? String(s).trim().replace(/\s+/g, ' ').replace(/^(.*)$/, x => /^[A-Z0-9 .'’\-/&()#]+$/.test(x) ? x.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase()).replace(/\b(Nfsr|Nf|Usfs|Blm|Ohv|Atv|Nw|Sw|Ne|Se)\b/g, m => m.toUpperCase()) : x).slice(0, 60) : '';
function surfaceOf(s) {
  if (!s) return null;
  if (/^(AC|P|PCC|BST)\b|paved|asphalt|concrete|chip/i.test(s)) return 'paved';
  if (/^(AGG|IMP|CSOIL)\b|gravel|aggregate|improved|compacted/i.test(s)) return 'gravel';
  if (/^NAT\b|native|dirt|earth|soil/i.test(s)) return 'dirt';
  return null;
}
// A Forest Service road is in both the Motor Vehicle Use Map (who may drive it, when) and the road inventory
// (maintenance level, surface). Records with the same road number become one, keeping both sources and every
// segment; the MVUM's answer wins where both have one. Other sources are kept as they are (OpenStreetMap's line for
// the same road adds its own surface and gate facts); only exact repeats are dropped.
function dedupe(features) {
  const seen = new Set(), byRef = new Map(), out = [];
  for (const f of features) {
    if (seen.has(f.source.id)) continue;
    seen.add(f.source.id);
    const usfs = /^(mvum|nfsr)-/.test(f.source.id) && f.kind === 'road' && f.ref;
    const prev = usfs && byRef.get(f.ref);
    if (!prev) { out.push({ ...f, sources: [f.source] }); if (usfs) byRef.set(f.ref, out[out.length - 1]); continue; }
    const mv = f.source.id.startsWith('mvum-') ? f : null;
    const keep = v => Object.fromEntries(Object.entries(v).filter(([, x]) => x != null && !(typeof x === 'object' && !Object.keys(x).length)));
    prev.tags = mv ? { ...prev.tags, ...keep(f.tags) } : { ...f.tags, ...keep(prev.tags), maint: prev.tags.maint ?? f.tags.maint, surface: prev.tags.surface ?? f.tags.surface };
    if (mv) { prev.source = f.source; prev.name = f.name ?? prev.name; }
    prev.tags.designation = [...new Set([prev.tags.designation, f.tags.designation].filter(Boolean).flatMap(d => d.split(' · ')))].join(' · ');
    if (!prev.sources.some(x => x.label === f.source.label)) prev.sources.push(f.source);
    prev.paths = [...prev.paths, ...f.paths];
  }
  return out;
}
