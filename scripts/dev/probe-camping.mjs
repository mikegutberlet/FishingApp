// Dev probe: which camping and facility sources answer a browser (CORS) and what fields they carry, and which agency
// pages the Camping tab links to are live. The sandbox can't reach them; Actions can. Writes nothing.
const ORIGIN = 'https://mikegutberlet.github.io';
const H = { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', Origin: ORIGIN, Referer: ORIGIN + '/FishingApp/', Accept: 'text/html,application/json;q=0.9,*/*;q=0.8' };
async function get(label, url, init = {}) {
  const t = Date.now();
  try {
    const r = await fetch(url, { ...init, headers: { ...H, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(30000) });
    const txt = await r.text();
    console.log(`\n### ${label} ${r.status} ${Date.now() - t}ms ACAO=${r.headers.get('access-control-allow-origin')} final=${r.url.slice(0, 140)}`);
    try { return JSON.parse(txt); } catch { return txt; }
  } catch (e) { console.log(`\n### ${label} FAILED ${e.message} ${e.cause?.code ?? ''}`); return null; }
}
for (const u of [
  'https://www.preventwildfireca.org/Campfire-Permit/', 'https://www.readyforwildfire.org/permits/', 'https://www.readyforwildfire.org/prevent-wildfire/campfire-permit/',
  'https://www.fire.ca.gov/what-we-do/fire-prevention/campfire-permits', 'https://www.fs.usda.gov/visit/know-before-you-go', 'https://www.fs.usda.gov/visit/camping',
  'https://www.fs.usda.gov/recreation/camping', 'https://www.fs.usda.gov/r05/recreation/camping', 'https://www.fs.usda.gov/visit/maps/motor-vehicle-use-maps', 'https://www.fs.usda.gov/visit/maps',
  'https://www.fs.usda.gov/visit/know-before-you-go/dispersed-camping-guidelines', 'https://www.fs.usda.gov/visit/dispersed-camping',
  'https://www.ecfr.gov/current/title-36/chapter-II/part-261/subpart-A/section-261.10', 'https://www.ecfr.gov/current/title-36/chapter-II/part-261/subpart-B/section-261.58',
  'https://www.ecfr.gov/current/title-43/subtitle-B/chapter-II/subchapter-H/part-8360/subpart-8365/section-8365.1-2', 'https://lnt.org/why/7-principles/',
  'https://www.blm.gov/programs/public-safety-and-fire/fire-and-aviation/fire-restrictions', 'https://www.blm.gov/programs/public-safety-and-fire/fire-and-aviation',
  'https://www.blm.gov/programs/recreation/camping/dispersed-camping', 'https://www.reservecalifornia.com/Web/', 'https://www.parks.ca.gov/?page_id=1083',
  'https://www.fs.usda.gov/r05/eldorado/alerts', 'https://www.recreation.gov/camping/gateways/1063', 'https://www.fs.usda.gov/r05/eldorado/maps-publications',
]) {
  const r = await get(`LINK ${u}`, u);
  if (typeof r === 'string') console.log((r.match(/<title>([^<]*)/i)?.[1] ?? '').trim().slice(0, 120));
}
// Forest Service camping-related recreation areas near Caples Lake, with what each says.
const FS = 'https://apps.fs.usda.gov/arcx/rest/services/EDW';
const j = await get('RecOpp camping near Caples', `${FS}/EDW_RecreationOpportunities_01/MapServer/0/query?geometry=-120.20,38.58,-119.88,38.84&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&where=${encodeURIComponent("markeractivitygroup in ('Camping & Cabins','OHV Riding & Camping','Horse Riding & Camping')")}&outFields=recareaname,markeractivity,openstatus,feedescription,reservation_info,open_season_start,open_season_end,recareaid,recareaurl&returnGeometry=false&f=json`);
for (const f of j?.features ?? []) console.log(JSON.stringify(f.attributes));
const k = await get('InfraRec camping subtypes (R4,R5,R6)', `${FS}/EDW_InfraRecreationSites_01/MapServer/0/query?where=${encodeURIComponent("region in ('04','05','06')")}&outFields=site_subtype&returnDistinctValues=true&returnGeometry=false&f=json`);
console.log(JSON.stringify(k?.features?.map(f => f.attributes.site_subtype)));
for (const fld of ['water_availability', 'restroom_availability', 'www_reservable', 'development_scale']) {
  const v = await get(`InfraRec distinct ${fld}`, `${FS}/EDW_InfraRecreationSites_01/MapServer/0/query?where=${encodeURIComponent("region in ('04','05','06') and site_subtype in ('CAMPGROUND','CAMPING AREA','GROUP CAMPGROUND')")}&outFields=${fld}&returnDistinctValues=true&returnGeometry=false&f=json`);
  console.log(JSON.stringify(v?.features?.map(f => f.attributes[fld])), v?.error ? JSON.stringify(v.error) : '');
}
const c = await get('CA SP campground types', 'https://services2.arcgis.com/AhxrK3F6WM8ECvDi/arcgis/rest/services/Campgrounds/FeatureServer/0/query?where=1%3D1&outFields=TYPE,SUBTYPE&returnDistinctValues=true&returnGeometry=false&f=json');
console.log(JSON.stringify(c?.features?.map(f => `${f.attributes.TYPE}/${f.attributes.SUBTYPE}`)));
const p = await get('CA SP park entry points fields', 'https://services2.arcgis.com/AhxrK3F6WM8ECvDi/arcgis/rest/services/ParkEntryPoints/FeatureServer/0?f=json');
console.log(JSON.stringify(p?.fields?.map(f => f.name)));
