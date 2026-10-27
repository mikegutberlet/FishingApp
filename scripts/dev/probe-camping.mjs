// Dev probe: which camping and facility sources answer a browser (CORS) and what fields they carry.
// The sandbox can't reach them; Actions can. Writes nothing.
const ORIGIN = 'https://mikegutberlet.github.io';
const H = { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) TackleBox-probe', Origin: ORIGIN, Referer: ORIGIN + '/FishingApp/' };
async function get(label, url, init = {}) {
  const t = Date.now();
  try {
    const r = await fetch(url, { ...init, headers: { ...H, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(45000), redirect: init.redirect ?? 'follow' });
    const txt = await r.text();
    console.log(`\n### ${label} ${r.status} ${Date.now() - t}ms ACAO=${r.headers.get('access-control-allow-origin')} final=${r.url.slice(0, 120)}`);
    try { return JSON.parse(txt); } catch { return txt; }
  } catch (e) { console.log(`\n### ${label} FAILED ${e.message} ${e.cause?.code ?? ''}\n${url}`); return null; }
}
const nn = o => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v != null && v !== '' && v !== ' ').map(([k, v]) => [k, typeof v === 'string' ? v.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 160) : v]));
const env = (lat, lon, d) => `${lon - d},${lat - d},${lon + d},${lat + d}`;
const q = (base, lat, lon, d, extra = '') => `${base}/query?geometry=${env(lat, lon, d)}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=false&f=json${extra}`;
const W = { Caples: [38.709, -120.041], Rye: [40.47, -118.30], Wilson: [41.616, -116.408], Anthony: [44.962, -118.231], Shasta: [40.75, -122.32], Folsom: [38.72, -121.13], Detroit: [44.72, -122.18], Topaz: [38.68, -119.53], Crane: [42.79, -119.72] };
const show = (rows, n = 3) => { for (const f of (rows?.features ?? []).slice(0, n)) console.log(JSON.stringify(nn(f.attributes))); console.log(`(${rows?.features?.length ?? 'no'} rows${rows?.error ? ' ERROR ' + JSON.stringify(rows.error) : ''})`); };
const fields = async (label, url) => { const j = await get(label, `${url}?f=json`); console.log(j?.name, j?.geometryType, JSON.stringify(j?.fields?.map(f => f.name))); };

const FS = 'https://apps.fs.usda.gov/arcx/rest/services/EDW';
// MVUM: is there a dispersed camping marker?
for (const f of ['sbs_symbol_name', 'ta_symbol', 'mvum_symbol_name', 'system']) {
  const j = await get(`MVUM roads distinct ${f}`, `${FS}/EDW_MVUM_01/MapServer/1/query?where=1%3D1&outFields=${f}&returnDistinctValues=true&returnGeometry=false&f=json`);
  console.log(JSON.stringify(j?.features?.map(x => x.attributes[f])), j?.error ? JSON.stringify(j.error) : '');
}
// Recreation opportunities: activity values in R4/R5/R6 and dispersed camping entries.
{
  const j = await get('RecOpp distinct activity', `${FS}/EDW_RecreationOpportunities_01/MapServer/0/query?where=1%3D1&outFields=markeractivity,markeractivitygroup&returnDistinctValues=true&returnGeometry=false&f=json`);
  console.log(JSON.stringify(j?.features?.map(x => `${x.attributes.markeractivitygroup}/${x.attributes.markeractivity}`)));
  const d = await get('RecOpp dispersed in R5', `${FS}/EDW_RecreationOpportunities_01/MapServer/0/query?where=${encodeURIComponent("markeractivity like '%ispersed%' and (forestorgcode like '05%' or forestorgcode like '06%' or forestorgcode like '04%')")}&outFields=recareaname,forestname,markeractivity,recareaurl,restrictions,feedescription,openstatus,recareadescription&returnGeometry=false&resultRecordCount=6&f=json`);
  show(d, 6);
  const c = await get('RecOpp dispersed count', `${FS}/EDW_RecreationOpportunities_01/MapServer/0/query?where=${encodeURIComponent("markeractivity like '%ispersed%' and (forestorgcode like '05%' or forestorgcode like '06%' or forestorgcode like '04%')")}&returnCountOnly=true&f=json`);
  console.log(JSON.stringify(c));
}
for (const [n, [la, lo]] of Object.entries(W).filter(([n]) => ['Caples', 'Anthony', 'Shasta', 'Topaz'].includes(n))) {
  const j = await get(`InfraRec near ${n}`, q(`${FS}/EDW_InfraRecreationSites_01/MapServer/0`, la, lo, 0.12, '&resultRecordCount=200'));
  const rows = j?.features ?? [];
  console.log('subtypes:', JSON.stringify(rows.reduce((m, f) => (m[f.attributes.site_subtype] = (m[f.attributes.site_subtype] ?? 0) + 1, m), {})));
  const camps = rows.filter(f => /camp/i.test(f.attributes.site_subtype ?? ''));
  for (const f of camps.slice(0, 3)) console.log(JSON.stringify(nn(f.attributes)));
  // How many rows per site (one per unit?)
  console.log('distinct site_cn among camps:', new Set(camps.map(f => f.attributes.site_cn)).size, 'rows', camps.length, 'stacked', JSON.stringify(camps.slice(0, 8).map(f => f.attributes.stacked_recsite_count)));
}
// BLM recreation points
const BLMR = 'https://gis.blm.gov/arcgis/rest/services/recreation';
for (const l of [2, 3, 4, 23]) await fields(`BLM Recs_pts/${l}`, `${BLMR}/BLM_Natl_Recs_pts/MapServer/${l}`);
await fields('BLM Recreation/2 camping', `${BLMR}/BLM_Natl_Recreation/MapServer/2`);
await fields('BLM Recreation/1 RIDB sites', `${BLMR}/BLM_Natl_Recreation/MapServer/1`);
for (const n of ['Rye', 'Wilson', 'Topaz', 'Crane']) {
  const [la, lo] = W[n];
  show(await get(`BLM Recs_pts/23 near ${n}`, q(`${BLMR}/BLM_Natl_Recs_pts/MapServer/23`, la, lo, 0.2, '&resultRecordCount=50')), 6);
  show(await get(`BLM Recreation/2 near ${n}`, q(`${BLMR}/BLM_Natl_Recreation/MapServer/2`, la, lo, 0.2, '&resultRecordCount=20')), 3);
}
// State parks
await fields('CA State Parks Campgrounds/0', 'https://services2.arcgis.com/AhxrK3F6WM8ECvDi/arcgis/rest/services/Campgrounds/FeatureServer/0');
show(await get('CA SP Campgrounds near Folsom', q('https://services2.arcgis.com/AhxrK3F6WM8ECvDi/arcgis/rest/services/Campgrounds/FeatureServer/0', ...W.Folsom, 0.2)), 4);
await fields('OR State Park Status', 'https://gis.prd.state.or.us/arcgis/rest/services/Land_Ownership/LO_STATE_PARK_STATUS/FeatureServer/0');
show(await get('OR SP near Detroit', q('https://gis.prd.state.or.us/arcgis/rest/services/Land_Ownership/LO_STATE_PARK_STATUS/FeatureServer/0', ...W.Detroit, 0.2)), 3);
// Recreation.gov search (all agencies' reservable campgrounds)
for (const n of ['Caples', 'Rye', 'Anthony', 'Shasta', 'Detroit']) {
  const [la, lo] = W[n];
  const j = await get(`Rec.gov search ${n}`, `https://www.recreation.gov/api/search?lat=${la}&lng=${lo}&radius=20&size=30&fq=entity_type%3Acampground`);
  console.log('total', j?.total, 'keys', JSON.stringify(Object.keys(j?.results?.[0] ?? {})));
  for (const r of (j?.results ?? []).slice(0, 8)) console.log(JSON.stringify({ n: r.name, id: r.entity_id, org: r.org_name, par: r.parent_name, d: r.distance, sites: r.campsites_count, price: r.price_range, res: r.reservable, len: r.campsite_max_vehicle_length, eq: r.campsite_equipment_name, rt: r.campsite_reserve_type, notice: r.notices?.length, amen: r.amenities?.map?.(a => a.name ?? a), rating: r.average_rating, cell: r.aggregate_cell_coverage, avail: r.availability, open: r.facility_status ?? r.operational_status }));
}
{
  const j = await get('Rec.gov campground detail 232263', 'https://www.recreation.gov/api/camps/campgrounds/232263');
  const c = j?.campground ?? {};
  console.log('keys', JSON.stringify(Object.keys(c)));
  console.log(JSON.stringify({ amen: c.amenities, notices: c.notices?.slice?.(0, 2), status: c.facility_status ?? c.operational_status, desc: Object.keys(c.facility_description_map ?? {}), rules: c.facility_rules ? Object.keys(c.facility_rules) : null }).slice(0, 3000));
  const a = await get('Rec.gov availability 232263 Jul 2027', 'https://www.recreation.gov/api/camps/availability/campground/232263/month?start_date=2027-07-01T00%3A00%3A00.000Z');
  console.log('sites', Object.keys(a?.campsites ?? {}).length, 'values', JSON.stringify([...new Set(Object.values(a?.campsites ?? {}).flatMap(s => Object.values(s.availabilities ?? {})))]));
  const b = await get('Rec.gov availability 232263 Nov 2026', 'https://www.recreation.gov/api/camps/availability/campground/232263/month?start_date=2026-11-01T00%3A00%3A00.000Z');
  console.log('values', JSON.stringify([...new Set(Object.values(b?.campsites ?? {}).flatMap(s => Object.values(s.availabilities ?? {})))]));
}
// OSM: campsites around Rye Patch, all tags
{
  const j = await get('Overpass camps Rye', 'https://overpass-api.de/api/interpreter', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(`[out:json][timeout:40];nwr["tourism"~"^(camp_site|caravan_site|camp_pitch)$"](around:15000,${W.Rye[0]},${W.Rye[1]});out center tags 30;`) });
  for (const e of (j?.elements ?? [])) console.log(JSON.stringify(e.tags));
}
// Links the page would show
for (const u of ['https://www.readyforwildfire.org/permits/campfire-permit/', 'https://www.blm.gov/programs/recreation/camping', 'https://www.fs.usda.gov/visit/know-before-you-go/dispersed-camping', 'https://www.fs.usda.gov/visit/destinations/dispersed-camping', 'https://www.fs.usda.gov/recreation/dispersed-camping', 'https://www.oregon.gov/odf/fire/pages/restrictions.aspx', 'https://www.nevadafireinfo.org/', 'https://www.lnt.org/why/7-principles/', 'https://www.parks.ca.gov/?page_id=21805', 'https://www.reservecalifornia.com/', 'https://oregonstateparks.reserveamerica.com/', 'https://stateparks.oregon.gov/', 'https://parks.nv.gov/', 'https://www.recreation.gov/camping/campgrounds/232263', 'https://www.fs.usda.gov/r05/eldorado/recreation', 'https://firerestrictions.us/', 'https://www.blm.gov/programs/public-safety-and-fire/fire-and-aviation/regional-information/california/fire-restrictions', 'https://www.blm.gov/nevada/fire-restrictions', 'https://www.blm.gov/oregon-washington/fire-restrictions', 'https://www.ecfr.gov/current/title-36/chapter-II/part-261', 'https://www.ecfr.gov/current/title-43/subtitle-B/chapter-II/subchapter-H/part-8360/subpart-8365']) {
  const r = await get(`LINK ${u}`, u, { method: 'GET' });
  if (typeof r === 'string') console.log((r.match(/<title>([^<]*)/i)?.[1] ?? '').trim().slice(0, 120));
}
