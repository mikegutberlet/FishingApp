// Dev probe: can the public services the Access panel reads be reached, and do they answer browsers (CORS)?
// Runs in Actions (the sandbox can't reach them); logs status, Access-Control-Allow-Origin and a sample.
const UA = { 'User-Agent': 'TackleBox-fishing-app (personal, github.com/mikegutberlet/FishingApp)', Origin: 'https://mikegutberlet.github.io' };
const spots = { tahoeWest: [39.0968, -120.1324], winnemuccaLk: [38.672, -120.000], ryePatchNV: [40.47, -118.30], anthonyLkOR: [44.962, -118.231], wilsonResNV: [41.616, -116.408] };
const show = (s, n = 1500) => String(s).replace(/\s+/g, ' ').slice(0, n);

async function probe(label, url, init = {}) {
  const t = Date.now();
  try {
    const r = await fetch(url, { ...init, headers: { ...UA, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(60000) });
    const body = await r.text();
    console.log(`\n### ${label}\n${r.status} ${Date.now() - t}ms ACAO=${r.headers.get('access-control-allow-origin')} CT=${r.headers.get('content-type')}\n${show(body)}`);
    return body;
  } catch (e) { console.log(`\n### ${label}\nFAILED ${e.message}`); }
}

const env = ([lat, lon], d = 0.03) => `${lon - d},${lat - d},${lon + d},${lat + d}`;
const arc = (base, layer, geom, extra = '') => `${base}/${layer}/query?geometry=${geom}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true&outSR=4326&f=json${extra}`;
const FS = 'https://apps.fs.usda.gov/arcx/rest/services/EDW';
const BLM = 'https://gis.blm.gov/arcgis/rest/services';

for (const [name, p] of Object.entries(spots)) {
  console.log(`\n\n================ ${name} ${p}`);
  const q = `[out:json][timeout:30];(way[highway](around:1500,${p[0]},${p[1]});node[barrier=gate](around:1500,${p[0]},${p[1]});)->.a;(.a;>;);out tags geom 20;`;
  await probe('overpass POST', 'https://overpass-api.de/api/interpreter', { method: 'POST', body: new URLSearchParams({ data: `[out:json][timeout:30];way[highway](around:1500,${p[0]},${p[1]});out tags geom 12;` }) });
  await probe('MVUM roads', arc(FS + '/EDW_MVUM_01/MapServer', 1, env(p), '&resultRecordCount=5'));
  await probe('MVUM trails', arc(FS + '/EDW_MVUM_01/MapServer', 2, env(p), '&resultRecordCount=5'));
  await probe('NFS roads', arc(FS + '/EDW_RoadBasic_01/MapServer', 0, env(p), '&resultRecordCount=5'));
  await probe('NFS trails', arc(FS + '/EDW_TrailNFSPublish_01/MapServer', 0, env(p), '&resultRecordCount=5'));
  await probe('BLM roads 0', arc(BLM + '/transportation/BLM_Natl_GTLF_Public_Display/MapServer', 0, env(p, 0.08), '&resultRecordCount=5'));
  await probe('BLM roads 1 limited', arc(BLM + '/transportation/BLM_Natl_GTLF_Public_Display/MapServer', 1, env(p, 0.08), '&resultRecordCount=3'));
  await probe('BLM trails 7', arc(BLM + '/transportation/BLM_Natl_GTLF_Public_Display/MapServer', 7, env(p, 0.08), '&resultRecordCount=3'));
  await probe('BLM SMA point', `${BLM}/lands/BLM_Natl_SMA_LimitedScale/MapServer/1/query?geometry=${p[1]},${p[0]}&geometryType=esriGeometryPoint&inSR=4326&outFields=*&returnGeometry=false&f=json`);
  await probe('PAD-US point', `https://services.arcgis.com/v01gqwM5QqNysAAi/ArcGIS/rest/services/Manager_Name_PADUS/FeatureServer/0/query?geometry=${p[1]},${p[0]}&geometryType=esriGeometryPoint&inSR=4326&outFields=Mang_Name,Mang_Type,Unit_Nm,Loc_Nm,Des_Tp,Pub_Access,GIS_Acres,Own_Name,Loc_Mang&returnGeometry=false&f=json`);
  await probe('wiki geosearch', `https://en.wikipedia.org/w/api.php?action=query&list=geosearch&gscoord=${p[0]}|${p[1]}&gsradius=5000&gslimit=8&format=json&origin=*`);
}
await probe('wiki summary', 'https://en.wikipedia.org/api/rest_v1/page/summary/Rye_Patch_Reservoir');
await probe('overpass GET', 'https://overpass-api.de/api/interpreter?data=' + encodeURIComponent('[out:json][timeout:30];way[highway](around:800,40.47,-118.30);out tags geom 5;'));
await probe('overpass preflight OPTIONS', 'https://overpass-api.de/api/interpreter', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
