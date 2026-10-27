// Dev probe: which camping and facility sources answer a browser (CORS) and what fields they carry.
// The sandbox can't reach them; Actions can. Writes nothing.
const ORIGIN = 'https://mikegutberlet.github.io';
const H = { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) TackleBox-probe', Origin: ORIGIN, Referer: ORIGIN + '/FishingApp/' };
async function probe(label, url, init = {}, show = 1500) {
  const t = Date.now();
  try {
    const r = await fetch(url, { ...init, headers: { ...H, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(45000) });
    const txt = await r.text();
    console.log(`\n### ${label} ${r.status} ${Date.now() - t}ms ACAO=${r.headers.get('access-control-allow-origin')} type=${r.headers.get('content-type')}\n${url}\n${txt.slice(0, show)}`);
    return txt;
  } catch (e) { console.log(`\n### ${label} FAILED ${e.message} ${e.cause?.code ?? ''}\n${url}`); }
}
async function preflight(label, url, hdrs) {
  try {
    const r = await fetch(url, { method: 'OPTIONS', headers: { ...H, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': hdrs } });
    console.log(`\n### PREFLIGHT ${label} ${r.status} ACAO=${r.headers.get('access-control-allow-origin')} ACAH=${r.headers.get('access-control-allow-headers')}`);
  } catch (e) { console.log(`PREFLIGHT ${label} failed ${e.message}`); }
}
const env = (lat, lon, d = 0.15) => `${lon - d},${lat - d},${lon + d},${lat + d}`;
const q = (base, lat, lon, d, extra = '') => `${base}/query?geometry=${env(lat, lon, d)}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true&outSR=4326&f=json${extra}`;
const CAPLES = [38.709, -120.041], RYE = [40.47, -118.30], ANTHONY = [44.962, -118.231], SHASTA = [40.75, -122.32];

const FS = 'https://apps.fs.usda.gov/arcx/rest/services/EDW';
for (const svc of ['EDW_MVUM_01', 'EDW_RecreationOpportunities_01', 'EDW_InfraRecreationSites_01', 'EDW_RecreationSiteInfra_01']) {
  const t = await probe(`FS ${svc} meta`, `${FS}/${svc}/MapServer?f=json`, {}, 400);
  try { const j = JSON.parse(t); console.log('layers:', JSON.stringify(j.layers?.map(l => [l.id, l.name]))); } catch {}
}
// Field lists for MVUM layers (dispersed camping corridors?) and rec layers.
for (const [svc, ids] of [['EDW_MVUM_01', [0, 1, 2, 3, 4, 5, 6]], ['EDW_RecreationOpportunities_01', [0, 1]], ['EDW_InfraRecreationSites_01', [0, 1]]]) {
  for (const id of ids) {
    const t = await probe(`FS ${svc}/${id} fields`, `${FS}/${svc}/MapServer/${id}?f=json`, {}, 0);
    try { const j = JSON.parse(t); console.log(id, j.name, j.geometryType, JSON.stringify(j.fields?.map(f => f.name))); } catch {}
  }
}
for (const [n, [la, lo]] of [['Caples', CAPLES], ['Anthony', ANTHONY], ['Shasta', SHASTA]]) {
  await probe(`FS RecOpp near ${n}`, q(`${FS}/EDW_RecreationOpportunities_01/MapServer/0`, la, lo, 0.1, '&resultRecordCount=4'), {}, 5000);
  await probe(`FS InfraRec near ${n}`, q(`${FS}/EDW_InfraRecreationSites_01/MapServer/0`, la, lo, 0.1, '&resultRecordCount=3'), {}, 3000);
}
// MVUM dispersed camping: roads with corridors, if any field.
await probe('MVUM roads Caples (fields)', q(`${FS}/EDW_MVUM_01/MapServer/1`, ...CAPLES, 0.05, '&resultRecordCount=2&returnGeometry=false'), {}, 2500);

// BLM recreation sites
const t = await probe('BLM services recreation folder', 'https://gis.blm.gov/arcgis/rest/services/recreation?f=json', {}, 3000);
await probe('BLM services root', 'https://gis.blm.gov/arcgis/rest/services?f=json', {}, 3000);
try {
  for (const s of JSON.parse(t).services ?? []) {
    const m = await probe(`BLM ${s.name}`, `https://gis.blm.gov/arcgis/rest/services/${s.name}/${s.type}?f=json`, {}, 300);
    try { const j = JSON.parse(m); console.log('layers:', JSON.stringify(j.layers?.map(l => [l.id, l.name]))); } catch {}
  }
} catch {}

// Recreation.gov
await probe('RIDB no key', `https://ridb.recreation.gov/api/v1/facilities?latitude=${CAPLES[0]}&longitude=${CAPLES[1]}&radius=10&limit=2`, {}, 600);
await preflight('RIDB apikey header', 'https://ridb.recreation.gov/api/v1/facilities?limit=1', 'apikey');
await probe('Rec.gov search geo', `https://www.recreation.gov/api/search/geo?lat=${CAPLES[0]}&lng=${CAPLES[1]}&radius=15&size=5&fq=entity_type%3Acampground`, {}, 4000);
await probe('Rec.gov search', `https://www.recreation.gov/api/search?q=&lat=${CAPLES[0]}&lng=${CAPLES[1]}&radius=15&size=5&fq=entity_type%3Acampground`, {}, 4000);
await probe('Rec.gov camp detail (Caples Lake 232245?)', 'https://www.recreation.gov/api/camps/campgrounds/232245', {}, 1500);
await probe('Rec.gov availability', `https://www.recreation.gov/api/camps/availability/campground/232245/month?start_date=2027-07-01T00%3A00%3A00.000Z`, {}, 800);

// ArcGIS Online search for state park / campground layers
for (const s of ['California State Parks campgrounds', 'Oregon State Parks campgrounds', 'Nevada State Parks', 'BLM recreation sites', 'dispersed camping', 'Forest Service campgrounds']) {
  const r = await probe(`AGOL search ${s}`, `https://www.arcgis.com/sharing/rest/search?q=${encodeURIComponent(s)}%20type%3A%22Feature%20Service%22&num=8&f=json`, {}, 0);
  try { console.log(JSON.stringify(JSON.parse(r).results.map(x => [x.title, x.owner, x.url, x.numViews]))); } catch {}
}
// OSM Overpass: campsites with tags
await probe('Overpass camps Caples', 'https://overpass-api.de/api/interpreter', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(`[out:json][timeout:40];nwr["tourism"~"camp_site|caravan_site"](around:12000,${CAPLES[0]},${CAPLES[1]});out center tags 10;`) }, 5000);
