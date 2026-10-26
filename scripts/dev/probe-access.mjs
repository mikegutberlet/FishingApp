// Dev probe: can the public services the Access panel reads be reached, and do they answer browsers (CORS)?
// Runs in Actions (the sandbox can't reach them); logs status, Access-Control-Allow-Origin and a sample.
const UA = { 'User-Agent': 'TackleBox-fishing-app (personal, github.com/mikegutberlet/FishingApp)', Origin: 'https://mikegutberlet.github.io' };
const spots = { tahoeWest: [39.0968, -120.1324], winnemuccaLk: [38.672, -120.000], ryePatchNV: [40.47, -118.30], anthonyLkOR: [44.962, -118.231], wilsonResNV: [41.616, -116.408], caplesLk: [38.709, -120.041] };
const show = (s, n = 1500) => String(s).replace(/\s+/g, ' ').slice(0, n);

async function probe(label, url, init = {}, fmt = null) {
  const t = Date.now();
  try {
    const r = await fetch(url, { ...init, headers: { ...UA, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(60000) });
    const body = await r.text();
    let out = body;
    if (fmt && r.ok) { try { out = fmt(JSON.parse(body)); } catch (e) { out = 'parse: ' + e.message + ' ' + body.slice(0, 300); } }
    console.log(`\n### ${label}\n${r.status} ${Date.now() - t}ms bytes=${body.length} ACAO=${r.headers.get('access-control-allow-origin')} CT=${r.headers.get('content-type')}\n${show(out, 4000)}`);
    return body;
  } catch (e) { console.log(`\n### ${label}\nFAILED ${e.message}`); }
}
const attrs = j => `n=${j.features?.length} exceeded=${j.exceededTransferLimit} err=${JSON.stringify(j.error ?? null)} ` + JSON.stringify((j.features ?? []).slice(0, 3).map(f => Object.fromEntries(Object.entries(f.attributes).filter(([k, v]) => v != null && !/^(shape|st_length|globalid|original_globalid|objectid|rte_cn|bmp|emp)/i.test(k)))));
const osm = j => `n=${j.elements?.length} remark=${j.remark ?? ''} ` + JSON.stringify((j.elements ?? []).slice(0, 6).map(e => ({ id: e.id, type: e.type, n: e.geometry?.length, tags: e.tags })));

const env = ([lat, lon], d = 0.03) => `${lon - d},${lat - d},${lon + d},${lat + d}`;
const arc = (base, layer, geom, extra = '') => `${base}/${layer}/query?geometry=${geom}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true&outSR=4326&geometryPrecision=5&maxAllowableOffset=0.0001&resultRecordCount=300&f=json${extra}`;
const FS = 'https://apps.fs.usda.gov/arcx/rest/services/EDW';
const BLM = 'https://gis.blm.gov/arcgis/rest/services';
const MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];

for (const [name, p] of Object.entries(spots)) {
  console.log(`\n\n================ ${name} ${p}`);
  const q = `[out:json][timeout:25];(way[highway~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|track|path|footway|bridleway|cycleway|road)$"][service!~"driveway|parking_aisle"](around:2000,${p[0]},${p[1]});node[barrier~"^(gate|lift_gate|swing_gate)$"](around:2000,${p[0]},${p[1]}););out tags geom 300;`;
  for (const m of MIRRORS) await probe('overpass ' + new URL(m).host, m, { method: 'POST', body: new URLSearchParams({ data: q }) }, osm);
  await probe('MVUM roads', arc(FS + '/EDW_MVUM_01/MapServer', 1, env(p)), {}, attrs);
  await probe('MVUM trails', arc(FS + '/EDW_MVUM_01/MapServer', 2, env(p)), {}, attrs);
  await probe('NFS roads', arc(FS + '/EDW_RoadBasic_01/MapServer', 0, env(p)), {}, attrs);
  await probe('NFS trails', arc(FS + '/EDW_TrailNFSPublish_01/MapServer', 0, env(p)), {}, attrs);
  for (const l of [0, 1, 2, 3, 4, 5]) await probe('BLM layer ' + l, arc(BLM + '/transportation/BLM_Natl_GTLF_Public_Display/MapServer', l, env(p, 0.05)), {}, attrs);
  await probe('BLM SMA env', `${BLM}/lands/BLM_Natl_SMA_LimitedScale/MapServer/1/query?geometry=${env(p, 0.01)}&geometryType=esriGeometryEnvelope&inSR=4326&outFields=*&returnGeometry=false&f=json`, {}, attrs);
  await probe('PAD-US env', `https://services.arcgis.com/v01gqwM5QqNysAAi/ArcGIS/rest/services/Manager_Name_PADUS/FeatureServer/0/query?geometry=${env(p, 0.01)}&geometryType=esriGeometryEnvelope&inSR=4326&outFields=Mang_Name,Mang_Type,Unit_Nm,Loc_Nm,Des_Tp,Pub_Access,GIS_Acres,Loc_Mang,Own_Name&returnGeometry=false&f=json`, {}, attrs);
  await probe('wiki geosearch', `https://en.wikipedia.org/w/api.php?action=query&list=geosearch&gscoord=${p[0]}|${p[1]}&gsradius=5000&gslimit=10&format=json&origin=*`);
}
await probe('wiki summary', 'https://en.wikipedia.org/api/rest_v1/page/summary/Anthony_Lakes_(Oregon)');
await probe('arcgis record html', `${FS}/EDW_MVUM_01/MapServer/1/query?where=objectid%3D16531812&outFields=*&f=html`);
await probe('blm record html', `${BLM}/transportation/BLM_Natl_GTLF_Public_Display/MapServer/0/query?where=OBJECTID%3D1&outFields=*&f=html`);
await probe('padus record html', `https://services.arcgis.com/v01gqwM5QqNysAAi/ArcGIS/rest/services/Manager_Name_PADUS/FeatureServer/0/query?where=OBJECTID%3D1&outFields=*&f=html`);
