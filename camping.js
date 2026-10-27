// Camping lookup for one water: the campgrounds around it with their facilities, fees, seasons and how to book, the
// Forest Service's mapped dispersed camping areas, and who manages the land (which decides whether you can camp for
// free outside a campground). Read live from public services and kept on this device (Cache API `tb-access`, like the
// road lookup). Only the water's coordinates are sent. Each record keeps a link to the source entry it came from.
//
//   USFS recreation sites (INFRA): every campground, camping area and cabin, with water, toilets, fees and season
//   USFS recreation opportunities: the forest's page for each site and whether it is open now
//   Recreation.gov: reservable federal campgrounds (Forest Service, BLM, Corps, Reclamation), sites, prices, booking
//   BLM recreation sites: campgrounds and campsites on BLM land
//   California State Parks campgrounds
//   OpenStreetMap via the Overpass API (county, private and state park campgrounds the agencies don't list)
//   USGS PAD-US (who manages the land around the water)
import { haversineKm } from './data-sources.js';
import { shoreKm } from './access-rules.js';

const FS = 'https://apps.fs.usda.gov/arcx/rest/services/EDW';
const INFRA = `${FS}/EDW_InfraRecreationSites_01/MapServer/0`;
const RECOPP = `${FS}/EDW_RecreationOpportunities_01/MapServer/0`;
const BLM_PTS = 'https://gis.blm.gov/arcgis/rest/services/recreation/BLM_Natl_Recs_pts/MapServer/23';
const BLM_FAC = 'https://gis.blm.gov/arcgis/rest/services/recreation/BLM_Natl_Recreation/MapServer/2';
const CA_PARKS = 'https://services2.arcgis.com/AhxrK3F6WM8ECvDi/arcgis/rest/services/Campgrounds/FeatureServer/0';
const PADUS = 'https://services.arcgis.com/v01gqwM5QqNysAAi/ArcGIS/rest/services/Manager_Name_PADUS/FeatureServer/0';
const RECGOV = 'https://www.recreation.gov';
const OVERPASS = 'https://overpass-api.de/api/interpreter';
const CACHE = 'tb-access'; // sw.js keeps this cache across app updates
export const MAX_AGE_DAYS = 7; // open/closed status and alerts change through the season

// How far out to look: campgrounds within about 10 miles of the shore (a big lake's whole shoreline).
export const campKm = lake => Math.min(45, shoreKm(lake) + 16);
export const isFresh = c => !!c && Date.now() - Date.parse(c.fetchedAt) < (c.failed?.length ? 1 : MAX_AGE_DAYS) * 864e5;
const key = lake => lake.nhdId ? `nhd-${lake.nhdId}` : String(lake.id);
const cacheUrl = lake => `${location.origin}/__camping/${encodeURIComponent(key(lake))}.json`;
export async function cached(lake) {
  try { const r = await (await caches.open(CACHE)).match(cacheUrl(lake)); return r ? await r.json() : null; } catch { return null; }
}
async function store(lake, data) {
  try { await (await caches.open(CACHE)).put(cacheUrl(lake), new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })); } catch {}
}

export const SOURCES = ['Forest Service sites', 'Forest Service pages', 'Recreation.gov', 'BLM sites', 'California State Parks', 'OpenStreetMap', 'PAD-US'];

// The lookup. OpenStreetMap's server often takes 30–40 s, so `onPartial` gets everything else first.
export async function lookupCamping(lake, { force = false, onPartial = null } = {}) {
  if (!force) {
    const c = await cached(lake);
    if (isFresh(c)) return c;
  }
  const lat = +lake.lat, lon = +lake.lon, shore = shoreKm(lake), km = campKm(lake);
  const dLat = km / 110.57, dLon = km / (111.32 * Math.cos(lat * Math.PI / 180));
  const bbox = [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
  const failed = [], found = {};
  const run = (name, p) => p.then(r => { found[name] = r; }, e => { console.warn(`camping ${name}:`, e.message); failed.push(name); });
  const osmDone = run('OpenStreetMap', osmCamps(lat, lon, km));
  let osmFinished = false;
  osmDone.then(() => { osmFinished = true; });
  await Promise.all([
    run('Forest Service sites', fsSites(bbox)), run('Forest Service pages', fsPages(bbox)), run('Recreation.gov', recgov(lat, lon, km)),
    run('BLM sites', blmSites(bbox)), run('California State Parks', caParks(bbox)), run('PAD-US', padus(lat, lon, shore)),
  ]);
  const snapshot = pending => {
    const sites = merge([found['Forest Service sites'], found['BLM sites'], found['California State Parks'], found['Recreation.gov'], found.OpenStreetMap].flatMap(x => x ?? []), found['Forest Service pages'] ?? [])
      .map(s => ({ ...s, distKm: Math.max(0, haversineKm(lat, lon, s.lat, s.lon) - shore) }))
      .filter(s => s.distKm <= km - shore + 1)
      .sort((a, b) => a.distKm - b.distKm);
    return { fetchedAt: new Date().toISOString(), lat, lon, searchKm: km, shoreKm: shore, sites, land: found['PAD-US'] ?? null, failed: [...failed], pending };
  };
  if (!osmFinished && onPartial) onPartial(snapshot(['OpenStreetMap']));
  await osmDone;
  const data = snapshot([]);
  if (failed.length < SOURCES.length - 1) await store(lake, data);
  return data;
}

// ---------- ArcGIS REST ----------
async function arc(layerUrl, bbox, outFields, extra = {}) {
  const u = `${layerUrl}/query?` + new URLSearchParams({ geometry: bbox.join(','), geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
    outFields, returnGeometry: 'true', outSR: '4326', resultRecordCount: '300', f: 'json', ...extra });
  const r = await fetch(u, { signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error(`${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message ?? 'query error');
  return j.features ?? [];
}
const arcRecord = (layerUrl, idField, id) => `${layerUrl}/query?where=${idField}%3D${id}&outFields=*&f=html`;
const pt = f => f.geometry && f.geometry.y != null ? [+f.geometry.y.toFixed(5), +f.geometry.x.toFixed(5)] : null;

// Plain text from an agency's HTML field, shortened.
export const plain = (s, n = 400) => {
  if (s == null) return null;
  const t = String(s).replace(/<br\s*\/?>|<\/p>|<\/li>/gi, '. ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, '’').replace(/&quot;/g, '"').replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ').replace(/(\.\s*){2,}/g, '. ').replace(/^[\s.]+/, '').trim();
  return !t || /^(n|none|null|n\/a)$/i.test(t) ? null : t.length > n ? `${t.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : t;
};
// "SILVER LAKE EAST- ELDORADO" → "Silver Lake East"; "KIRKWOOD LAKE CG" → "Kirkwood Lake Campground".
const title = s => {
  if (!s) return '';
  let t = String(s).trim().replace(/\s+/g, ' ').replace(/\s*\((CA|OR|NV)\)$/i, '').replace(/\s*-\s*(eldorado|willamette|stanislaus|tahoe|inyo|sierra|plumas|lassen|modoc|klamath|sequoia|deschutes|umpqua|ochoco|malheur|fremont|winema|umatilla)$/i, '');
  if (/^[A-Z0-9 .'’\-/&()#,]+$/.test(t)) t = t.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase()).replace(/\b(Cg|Usfs|Blm|Ohv|Rv|Nf)\b/g, m => m === 'Cg' ? 'Campground' : m.toUpperCase());
  return t.replace(/\bCg\b/g, 'Campground').replace(/\s*-\s*F$/, '').slice(0, 70);
};

// ---------- Forest Service ----------
// Every campground, camping area, group camp and rental cabin in the Forest Service's site inventory.
const FS_KIND = s => /GROUP/.test(s) ? 'group' : /CAMPING AREA/.test(s) ? 'dispersed' : /CABIN|LOOKOUT|YURT/.test(s) ? 'cabin' : /HORSE/.test(s) ? 'horse' : 'developed';
async function fsSites(bbox) {
  const fields = 'objectid,site_name,public_site_name,site_subtype,development_status,development_scale,total_capacity,fee_charged,fee_description,open_season,season_description,operational_hours,water_availability,restroom_availability,operated_by,usda_portal_url,rec1stop_url,nrrs_id,alerts_description,closure_reason,unit_closure_description,pack_in_out,restrictions,max_vehicle_length,www_reservable,recarea_description,directions,security_id,latitude,longitude';
  const rows = await arc(INFRA, bbox, fields, { where: "site_subtype in ('CAMPGROUND','GROUP CAMPGROUND','HORSE CAMP','CAMPING AREA','LOOKOUT/CABIN','DUMP STATION')" });
  // Dump stations aren't places to camp: they go on the campground next to them.
  const dumps = rows.filter(f => f.attributes.site_subtype === 'DUMP STATION').map(pt).filter(Boolean);
  return rows.filter(f => f.attributes.site_subtype !== 'DUMP STATION' && /^EXISTING/i.test(f.attributes.development_status ?? 'EXISTING')).map(f => {
    const a = f.attributes, at = pt(f) ?? [a.latitude, a.longitude];
    const kind = FS_KIND(a.site_subtype ?? ''), scale = parseInt(a.development_scale) || null;
    const recgovId = String(a.rec1stop_url ?? '').match(/campgrounds\/(\d+)/)?.[1] ?? (a.nrrs_id && /^\d+$/.test(a.nrrs_id) ? a.nrrs_id : null);
    return {
      name: title(a.public_site_name || a.site_name), lat: at[0], lon: at[1], kind: kind === 'developed' && scale && scale <= 2 ? 'primitive' : kind, scale,
      operator: a.operated_by && !/forest service/i.test(a.operated_by) ? `Forest Service · run by ${a.operated_by.toLowerCase()}` : 'Forest Service',
      sites: null, capacity: a.total_capacity || null,
      fee: a.fee_charged === 'Y' ? 'yes' : a.fee_charged === 'N' ? 'no' : null, feeText: plain(a.fee_description, 220),
      season: seasonText(a.open_season) ?? seasonText(a.season_description), hours: plain(a.operational_hours, 120),
      water: waterOf(a.water_availability), waterText: plain(a.water_availability, 120), toilets: toiletOf(a.restroom_availability), toiletText: plain(a.restroom_availability, 80),
      showers: /shower/i.test(`${a.water_availability} ${a.restroom_availability}`) || null, dump: /dump/i.test(a.water_availability ?? '') || dumps.some(([y, x]) => haversineKm(at[0], at[1], y, x) < 0.8) || null,
      packOut: a.pack_in_out === 'Y', maxLength: +a.max_vehicle_length || null, reservable: recgovId ? true : null, recgovId,
      alert: plain([a.closure_reason, a.unit_closure_description, a.alerts_description].filter(Boolean).join('. '), 300),
      about: plain(a.recarea_description, 300), directions: plain(a.directions, 200), restrictions: plain(a.restrictions, 300),
      infoUrl: a.usda_portal_url || null, recid: String(a.usda_portal_url ?? '').match(/recid=(\d+)/)?.[1] ?? null,
      sources: [{ label: 'USFS recreation sites (INFRA)', url: arcRecord(INFRA, 'objectid', a.objectid) }],
    };
  });
}
// Some season fields hold a spreadsheet date number ("44694") instead of words: those are dropped.
const seasonText = v => { const t = plain(v, 120); return t && !/^\d+(\.\d+)?$/.test(t) ? t : null; };
// The inventory's water and toilet fields are free text ("Handpump drinking water", "No potable water. Adjacent to
// a lake.", "Water system was damaged in the … Fire"): read them as yes, no or treat-it-yourself.
export function waterOf(s) {
  if (!s) return null;
  if (/treat|filter/i.test(s)) return 'treat';
  if (/^\s*(no\b|none|not\b)|not (available|for drinking|operational)|non.?potable|non.?functioning|boil|discontinued|damaged|unavailable|^water (is )?not/i.test(s)) return 'no';
  if (/yes|potable|drinking|hand ?pump|faucet|spigot|hydrant|pressuri[sz]ed|gravity|well water|^\s*water( available)?\.?\s*$/i.test(s)) return 'yes';
  return null;
}
export function toiletOf(s) {
  if (!s) return null;
  if (/^\s*no\b|no restroom/i.test(s)) return 'no';
  if (/non.?flush/i.test(s)) return 'vault';
  if (/flush/i.test(s)) return 'flush';
  if (/vault|pit|composting|chemical|portable|cxt/i.test(s)) return 'vault';
  return /yes|toilet|restroom/i.test(s) ? 'yes' : null;
}

// The forest's page for each camping site, and whether it says the site is open, closed or not cleared yet.
async function fsPages(bbox) {
  const rows = await arc(RECOPP, bbox, 'objectid,recareaname,recareaid,recareaurl,markeractivity,openstatus,feedescription,reservation_info,open_season_start,open_season_end,forestname,restrictions,accessibility', {
    where: "markeractivitygroup in ('Camping & Cabins','OHV Riding & Camping','Horse Riding & Camping')", returnGeometry: 'true' });
  return rows.map(f => {
    const a = f.attributes, at = pt(f);
    if (!at) return null;
    return {
      name: title(a.recareaname), lat: at[0], lon: at[1], recid: a.recareaid ? String(a.recareaid) : null, infoUrl: a.recareaurl ?? null,
      activity: a.markeractivity ?? null, status: /^(open|closed)$/i.test(a.openstatus ?? '') ? a.openstatus.toLowerCase() : null,
      feeText: plain(a.feedescription, 220), reservations: plain(String(a.reservation_info ?? '').replace(/<a [^>]*>[^<]*<\/a>/gi, 'Recreation.gov'), 220),
      recgovId: String(a.reservation_info ?? '').match(/recreation\.gov\/camping\/campgrounds\/(\d+)/)?.[1] ?? null, restrictions: plain(a.restrictions, 300), accessibility: plain(a.accessibility, 160),
      season: a.open_season_start && a.open_season_end && !/\d:\d\d/.test(a.open_season_start) ? `${a.open_season_start}–${a.open_season_end}` : null, forest: a.forestname ?? null,
      source: { label: 'USFS recreation opportunities', url: arcRecord(RECOPP, 'objectid', a.objectid) },
    };
  }).filter(Boolean);
}

// ---------- Recreation.gov ----------
// Reservable federal campgrounds near the water (its public search, which answers browsers). Distance is in miles.
async function recgov(lat, lon, km) {
  const q = new URLSearchParams({ lat: lat.toFixed(4), lng: lon.toFixed(4), radius: String(Math.ceil(km * 0.621)), size: '60', fq: 'entity_type:campground' });
  const r = await fetch(`${RECGOV}/api/search?${q}`, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`${r.status}`);
  const j = await r.json();
  return (j.results ?? []).filter(x => x.latitude && x.longitude).map(x => {
    const id = String(x.entity_id), p = x.price_range;
    const dispersed = /dispersed/i.test(x.name ?? '');
    return {
      name: title(x.name), lat: +(+x.latitude).toFixed(5), lon: +(+x.longitude).toFixed(5), kind: dispersed ? 'dispersed' : /group/i.test(x.name ?? '') ? 'group' : /cabin|lookout|guard station|yurt/i.test(x.name ?? '') ? 'cabin' : 'developed',
      operator: [x.org_name, x.parent_name].filter(Boolean).join(' · ') || null, sites: +x.campsites_count || null,
      price: p && p.amount_min != null ? { min: p.amount_min, max: p.amount_max, per: p.per_unit ?? 'night' } : null, fee: p?.amount_max > 0 ? 'yes' : null,
      reservable: x.reservable !== false, recgovId: id, maxLength: +x.campsite_max_vehicle_length || null, equipment: x.campsite_equipment_name ?? null,
      accessible: x.accessible_campsites_count > 0 || x.campsite_accessible === 1 ? true : null, rating: x.average_rating ? { stars: +x.average_rating.toFixed(1), n: x.number_of_ratings ?? null } : null,
      lottery: !!x.has_lottery,
      bookUrl: `${RECGOV}/camping/campgrounds/${id}`, about: plain(x.description, 300),
      sources: [{ label: 'Recreation.gov', url: `${RECGOV}/camping/campgrounds/${id}` }],
    };
  });
}

// Open sites at a reservable campground for the coming Friday and Saturday nights (or the dates given).
// Recreation.gov releases sites months ahead; "NYR" = not yet released.
export async function weekendAvailability(recgovId, nights = nextWeekend()) {
  const months = [...new Set(nights.map(d => `${d.slice(0, 7)}-01`))];
  const sites = {};
  for (const m of months) {
    const r = await fetch(`${RECGOV}/api/camps/availability/campground/${recgovId}/month?start_date=${m}T00%3A00%3A00.000Z`, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`${r.status}`);
    for (const [id, s] of Object.entries((await r.json()).campsites ?? {})) (sites[id] ??= { ...s, availabilities: {} }, Object.assign(sites[id].availabilities, s.availabilities ?? {}));
  }
  const list = Object.values(sites);
  const at = (s, d) => s.availabilities?.[`${d}T00:00:00Z`] ?? null;
  const all = list.filter(s => nights.every(d => at(s, d) === 'Available'));
  const some = list.filter(s => nights.some(d => at(s, d) === 'Available'));
  const notReleased = list.filter(s => nights.some(d => at(s, d) === 'NYR')).length;
  const firstCome = list.filter(s => nights.some(d => /not reservable|walk.?up|first/i.test(at(s, d) ?? ''))).length;
  const closed = !!list.length && list.every(s => nights.every(d => !at(s, d) || /closed/i.test(at(s, d))));
  // Booked up, as opposed to not bookable at all ("Not Available": off season, or held back by the managers).
  const reserved = list.filter(s => nights.some(d => /^reserved$/i.test(at(s, d) ?? ''))).length;
  const values = {};
  for (const s of list) for (const d of nights) { const v = at(s, d) ?? 'none'; values[v] = (values[v] ?? 0) + 1; }
  return { nights, total: list.length, all: all.length, some: some.length, notReleased, firstCome, closed, reserved, values, checkedAt: new Date().toISOString() };
}
// Friday and Saturday nights of this weekend (from Sunday on, the coming one); on a Saturday, just tonight.
export function nextWeekend(now = new Date()) {
  const iso = x => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  const day = (n) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + n);
  if (now.getDay() === 6) return [iso(day(0))];
  const fri = (5 - now.getDay() + 7) % 7;
  return [iso(day(fri)), iso(day(fri + 1))];
}

// ---------- BLM ----------
// Campgrounds and campsites on BLM land, and the toilets, water and ramps mapped next to them.
async function blmSites(bbox) {
  const [pts, fac] = await Promise.all([
    arc(BLM_PTS, bbox, 'OBJECTID,FET_SUBTYPE,FET_NAME,UNIT_NAME,WEB_LINK,DESCRIPTION,LAT,LONG', { returnGeometry: 'false' }),
    arc(BLM_FAC, bbox, 'OBJECTID,FacilityName,FacilityTypeDescription,BLMFacURL,FacilityReservationURL,FacilityUseFeeDescription,FacilityDescription,StayLimit,FacilityLatitude,FacilityLongitude,FacilityAdaAccess,Reservable', { returnGeometry: 'false' }).catch(() => []),
  ]);
  const camps = [], extras = [];
  for (const { attributes: a } of pts) {
    if (a.LAT == null || a.LONG == null) continue;
    const sub = a.FET_SUBTYPE ?? '';
    const rec = { lat: +(+a.LAT).toFixed(5), lon: +(+a.LONG).toFixed(5), sub, a };
    if (/campground|campsite|cabin/i.test(sub)) camps.push(rec); else if (/toilet|restroom|potable|water|boat ramp/i.test(sub)) extras.push(rec);
  }
  const out = camps.map(({ lat, lon, sub, a }) => {
    const near = extras.filter(e => haversineKm(lat, lon, e.lat, e.lon) < 0.6);
    return {
      name: title(a.FET_NAME) || `${a.UNIT_NAME ? title(a.UNIT_NAME) + ' ' : ''}${sub.toLowerCase()}`, lat, lon, kind: /primitive/i.test(sub) ? 'primitive' : /cabin/i.test(sub) ? 'cabin' : 'developed',
      operator: `BLM${a.UNIT_NAME ? ` · ${title(a.UNIT_NAME)}` : ''}`, infoUrl: a.WEB_LINK || null, about: plain(a.DESCRIPTION, 200),
      toilets: near.some(e => /toilet|restroom/i.test(e.sub)) ? 'yes' : null, water: near.some(e => /potable|water/i.test(e.sub)) ? 'yes' : null, ramp: near.some(e => /boat ramp/i.test(e.sub)) || null,
      sources: [{ label: 'BLM recreation sites', url: arcRecord(BLM_PTS, 'OBJECTID', a.OBJECTID) }],
    };
  });
  for (const { attributes: a } of fac) {
    if (a.FacilityLatitude == null) continue;
    out.push({
      name: title(a.FacilityName), lat: +(+a.FacilityLatitude).toFixed(5), lon: +(+a.FacilityLongitude).toFixed(5), kind: /cabin/i.test(a.FacilityTypeDescription ?? '') ? 'cabin' : 'developed',
      operator: 'BLM', infoUrl: a.BLMFacURL || null, bookUrl: a.FacilityReservationURL || null, reservable: /true|yes|1/i.test(String(a.Reservable ?? '')) || null,
      feeText: plain(a.FacilityUseFeeDescription, 220), stay: plain(a.StayLimit, 80), about: plain(a.FacilityDescription, 300), accessible: a.FacilityAdaAccess && !/^n/i.test(a.FacilityAdaAccess) ? true : null,
      sources: [{ label: 'BLM camping facilities', url: arcRecord(BLM_FAC, 'OBJECTID', a.OBJECTID) }],
    });
  }
  return out;
}

// ---------- California State Parks ----------
async function caParks(bbox) {
  if (bbox[1] > 42.1 || bbox[0] > -114) return []; // outside California
  const rows = await arc(CA_PARKS, bbox, 'FID,Campground,TYPE,SUBTYPE,DETAIL,UNITNBR,UNITNAME');
  return rows.map(f => {
    const a = f.attributes, at = pt(f);
    if (!at) return null;
    const type = a.TYPE ?? '', sub = a.SUBTYPE ?? '';
    return {
      name: title(a.Campground) || title(a.DETAIL) || 'State park campground', lat: at[0], lon: at[1],
      kind: /group/i.test(type) ? 'group' : /environmental|primitive|hike|bike/i.test(type) ? 'primitive' : /boat/i.test(type + sub) ? 'boat' : 'developed',
      operator: `California State Parks${a.UNITNAME ? ` · ${title(a.UNITNAME)}` : ''}`, hookups: /hookup/i.test(sub) || null, tentOnly: /tent only/i.test(sub) || null,
      walkIn: /walk-in/i.test(sub) || null, about: [type, sub && !/not defined/i.test(sub) ? sub : null].filter(Boolean).join(' · ') || null,
      reservable: null, bookUrl: 'https://www.reservecalifornia.com/', fee: 'yes',
      sources: [{ label: 'California State Parks campgrounds', url: arcRecord(CA_PARKS, 'FID', a.FID) }],
    };
  }).filter(Boolean);
}

// ---------- OpenStreetMap ----------
async function osmCamps(lat, lon, km) {
  const q = `[out:json][timeout:60];nwr["tourism"~"^(camp_site|caravan_site)$"](around:${Math.round(km * 1000)},${lat},${lon});out tags center 150;`;
  let last;
  for (const wait of [0, 4000, 12000]) {
    if (wait) await new Promise(r => setTimeout(r, wait));
    try {
      const r = await fetch(OVERPASS, { method: 'POST', body: new URLSearchParams({ data: q }), signal: AbortSignal.timeout(70000) });
      if (r.status === 429 || r.status >= 500) { last = new Error(`${r.status}: server busy`); continue; }
      if (!r.ok) throw new Error(`${r.status}`);
      const j = await r.json();
      if (j.remark && !j.elements?.length) throw new Error(j.remark);
      return (j.elements ?? []).map(osmCamp).filter(Boolean);
    } catch (e) {
      last = e;
      if (e.name === 'TimeoutError' || e.name === 'AbortError' || globalThis.navigator?.onLine === false) break;
    }
  }
  throw last ?? new Error('Overpass unreachable');
}
const yesNo = v => v == null ? null : /^(no|none)$/.test(v) ? 'no' : 'yes';
function osmCamp(e) {
  const t = e.tags ?? {}, c = e.center ?? e;
  if (c.lat == null) return null;
  // Scout, church and other organisation camps, and anything mapped as private, aren't open to the public.
  if (/^(private|no|members)$/.test(t.access ?? '') || /\b(scouts?|ymca|ywca|4-h|church|bible|christian|youth camp|girl scout|boy scout)\b/i.test(t.name ?? '')) return null;
  // A single pitch in the backcountry or an informal spot is a dispersed site; a named camp_site is a campground.
  const backcountry = t.backcountry === 'yes' || t.camp_site === 'basic' || t.informal === 'yes' || t.camp_type === 'wildcamping';
  return {
    name: title(t.name) || (backcountry ? 'Backcountry campsite' : t.tourism === 'caravan_site' ? 'Unnamed RV park' : 'Unnamed campground'), lat: +c.lat.toFixed(5), lon: +c.lon.toFixed(5), unnamed: !t.name,
    kind: t.tourism === 'caravan_site' ? 'rv' : t.group_only === 'yes' ? 'group' : backcountry ? 'primitive' : 'developed', operator: t.operator ?? null,
    fee: t.fee ? yesNo(t.fee) : null, feeText: t.charge ?? null, sites: +t.capacity || +t['capacity:pitches'] || null,
    water: t.drinking_water ? yesNo(t.drinking_water) : null, toilets: t.toilets ? (t['toilets:disposal'] === 'flush' ? 'flush' : /pitlatrine|chemical/.test(t['toilets:disposal'] ?? '') ? 'vault' : yesNo(t.toilets)) : null,
    showers: t.shower ? yesNo(t.shower) : null, dump: t.sanitary_dump_station ? yesNo(t.sanitary_dump_station) : null, hookups: t.power_supply ? yesNo(t.power_supply) === 'yes' || null : null,
    reservable: t.reservation ? /^(yes|required|recommended)$/.test(t.reservation) : null, firstCome: t.reservation === 'no' || null, season: t.opening_hours ?? null,
    infoUrl: t.website ?? t['contact:website'] ?? null, dogs: t.dog ?? null,
    sources: [{ label: 'OpenStreetMap', url: `https://www.openstreetmap.org/${e.type}/${e.id}` }],
  };
}

// ---------- Land ----------
// Who manages the land within about 2 miles of the shore: decides where free dispersed camping is allowed.
async function padus(lat, lon, shore) {
  const km = shore + 3;
  const d = [km / (111.32 * Math.cos(lat * Math.PI / 180)), km / 110.57];
  const rows = await arc(PADUS, [lon - d[0], lat - d[1], lon + d[0], lat + d[1]], 'OBJECTID,Mang_Name,Unit_Nm,Des_Tp,Pub_Access,GIS_Acres,Loc_Mang', { returnGeometry: 'false', resultRecordCount: '100' });
  const by = {};
  for (const { attributes: a } of rows) {
    if (a.Pub_Access === 'XA') continue;
    const k = `${a.Mang_Name}|${a.Unit_Nm}|${a.Des_Tp === 'WA' ? 'WA' : ''}`;
    by[k] ??= { manager: a.Mang_Name, unit: a.Unit_Nm, designation: a.Des_Tp, access: a.Pub_Access, localManager: a.Loc_Mang, acres: 0, n: 0, source: { label: 'USGS Protected Areas Database (PAD-US)', url: arcRecord(PADUS, 'OBJECTID', a.OBJECTID) } };
    by[k].n++; by[k].acres += a.GIS_Acres ?? 0;
  }
  return { parcels: Object.values(by).sort((x, y) => y.acres - x.acres).slice(0, 6) };
}

// ---------- Merging ----------
// The same campground is often in several lists (the Forest Service inventory, its web page, Recreation.gov and
// OpenStreetMap). Records with the same distinctive name within 3 km (one name inside the other: 600 m), or any two within 150 m,
// become one: agency facts first, then Recreation.gov's booking facts, then what OpenStreetMap mappers added.
const GENERIC = new Set(['campground', 'camp', 'cg', 'campsite', 'campsites', 'camping', 'area', 'site', 'sites', 'the', 'and', 'of', 'at', 'rv', 'park', 'family', 'lake', 'reservoir', 'river', 'creek', 'loop', 'unit', 'state', 'recreation', 'dispersed', 'in']);
const words = n => String(n ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 1 && !GENERIC.has(w));
function same(a, b) {
  const d = haversineKm(a.lat, a.lon, b.lat, b.lon);
  if (a.recgovId && b.recgovId) return a.recgovId === b.recgovId;
  if (a.recid && b.recid) return a.recid === b.recid;
  if (d < 0.15 && !(a.unnamed && b.unnamed)) return true;
  if (d > 3) return false;
  const wa = words(a.name), wb = words(b.name);
  if (!wa.length || !wb.length) return d < 0.3;
  const shared = wa.filter(w => wb.includes(w)).length;
  // The same distinctive name up to 3 km apart (agencies and mappers put the point at the gate, the office or the
  // middle of the loops); one name inside the other only close by, since "Silver Lake East" and "West", or a group
  // camp next to the family one, are different places.
  return shared === wa.length && shared === wb.length ? true : shared >= Math.min(wa.length, wb.length) && d <= 0.6;
}
const keep = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== ''));
function merge(records, pages) {
  const out = [];
  for (const r of records) {
    const prev = out.find(o => same(o, r));
    if (!prev) { out.push({ ...r, sources: [...r.sources] }); continue; }
    const { sources, name, lat, lon, ...rest } = r;
    // Keep the agency's name and point; fill the gaps from the later record.
    Object.assign(prev, { ...keep(rest), ...keep(Object.fromEntries(Object.entries(prev).filter(([k]) => k !== 'sources'))) });
    if (r.bookUrl && !prev.bookUrl) prev.bookUrl = r.bookUrl;
    if (/Recreation\.gov/.test(sources[0].label)) Object.assign(prev, keep({ price: r.price, sites: r.sites ?? prev.sites, rating: r.rating, recgovId: r.recgovId, bookUrl: r.bookUrl, reservable: r.reservable, equipment: r.equipment, maxLength: prev.maxLength ?? r.maxLength }));
    for (const s of sources) if (!prev.sources.some(x => x.url === s.url)) prev.sources.push(s);
  }
  // The forest's web page for each site: open or closed now, fees and reservations as the forest words them.
  for (const p of pages) {
    const s = out.find(o => (o.recid && o.recid === p.recid) || same(o, p));
    if (s) {
      Object.assign(s, keep({ status: p.status, recgovId: s.recgovId ?? p.recgovId, infoUrl: s.infoUrl ?? p.infoUrl, feeText: s.feeText ?? p.feeText, reservations: p.reservations, restrictions: s.restrictions ?? p.restrictions, season: p.season?.includes('–') || !s.season ? p.season : s.season, forest: p.forest, accessibility: p.accessibility }));
      if (!s.sources.some(x => x.url === p.source.url)) s.sources.push(p.source);
    } else if (/camp|cabin|rv/i.test(p.activity ?? '')) {
      out.push({ name: p.name, lat: p.lat, lon: p.lon, kind: /dispersed/i.test(p.activity) ? 'dispersed' : /cabin/i.test(p.activity) ? 'cabin' : /group/i.test(p.activity) ? 'group' : 'developed',
        operator: 'Forest Service', status: p.status, recgovId: p.recgovId, infoUrl: p.infoUrl, feeText: p.feeText, fee: /no fee|free/i.test(p.feeText ?? '') ? 'no' : null, reservations: p.reservations, restrictions: p.restrictions, season: p.season, forest: p.forest, recid: p.recid, sources: [p.source] });
    }
  }
  for (const s of out) {
    if (s.recgovId) { s.reservable ??= true; s.bookUrl ??= `${RECGOV}/camping/campgrounds/${s.recgovId}`; }
    if (/first.come/i.test(s.reservations ?? '')) s.firstCome = true;
    if (/^\W*(no|no reservations?)\W*$/i.test(s.reservations ?? '') && !s.recgovId) { s.firstCome = true; s.reservable = false; }
    if (s.fee == null && /no fee|free|no fees/i.test(s.feeText ?? '')) s.fee = 'no';
  }
  return out;
}
