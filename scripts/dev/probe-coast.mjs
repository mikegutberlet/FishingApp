// Dev probe for the ocean features: which public sources answer, with what fields, and whether browsers may read
// them (CORS). The sandbox can't reach them; Actions can. Writes nothing.
const O = 'https://mikegutberlet.github.io';
async function probe(label, url, { show = 600, json = true } = {}) {
  try {
    const t = Date.now();
    const r = await fetch(url, { headers: { Origin: O, 'User-Agent': 'Mozilla/5.0 TackleBox-probe', Accept: json ? 'application/geo+json, application/json' : '*/*' } });
    const txt = await r.text();
    console.log(`\n### ${label} ${r.status} ${Date.now() - t}ms ACAO=${r.headers.get('access-control-allow-origin')} type=${r.headers.get('content-type')} len=${txt.length}\n${url}\n${txt.slice(0, show)}`);
    return json ? JSON.parse(txt) : txt;
  } catch (e) { console.log(`\n### ${label} FAILED ${e.message} ${e.cause?.code ?? ''}\n${url}`); return null; }
}
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, '');
const now = new Date();
await probe('CO-OPS stations tidepredictions', 'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=tidepredictions', { show: 800 }).then(j => {
  const s = (j?.stations ?? []).filter(x => ['CA', 'OR'].includes(x.state));
  console.log('CA/OR tide stations', s.length, 'keys', Object.keys(s[0] ?? {}).join(','));
  console.log(JSON.stringify(s.slice(0, 3)));
  console.log('types', JSON.stringify(s.reduce((m, x) => (m[x.type] = (m[x.type] ?? 0) + 1, m), {})));
});
await probe('CO-OPS currentpredictions stations', 'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=currentpredictions', { show: 300 }).then(j => {
  const s = (j?.stations ?? []).filter(x => x.lat > 32 && x.lat < 46.5 && x.lng < -116);
  console.log('CA/OR current stations', s.length, JSON.stringify(s.slice(0, 2)));
});
await probe('CO-OPS hilo SF 9414290', `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions&application=TackleBox&station=9414290&begin_date=${ymd(now)}&range=72&datum=MLLW&interval=hilo&units=english&time_zone=lst_ldt&format=json`);
await probe('CO-OPS hourly subordinate 9413450 Monterey?', `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions&application=TackleBox&station=9413450&begin_date=${ymd(now)}&range=24&datum=MLLW&interval=h&units=english&time_zone=lst_ldt&format=json`, { show: 300 });
await probe('CO-OPS subordinate hilo 9410580 Newport Beach', `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions&application=TackleBox&station=9410580&begin_date=${ymd(now)}&range=48&datum=MLLW&interval=hilo&units=english&time_zone=lst_ldt&format=json`, { show: 400 });
await probe('CO-OPS subordinate hourly 9410580', `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions&application=TackleBox&station=9410580&begin_date=${ymd(now)}&range=24&datum=MLLW&interval=h&units=english&time_zone=lst_ldt&format=json`, { show: 300 });
await probe('CO-OPS water temp 9414290', `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=water_temperature&application=TackleBox&station=9414290&date=latest&units=english&time_zone=lst_ldt&format=json`, { show: 300 });
await probe('CO-OPS currents SFB1203', `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=currents_predictions&application=TackleBox&station=SFB1203&begin_date=${ymd(now)}&range=24&interval=MAX_SLACK&units=english&time_zone=lst_ldt&format=json`, { show: 500 });
// NWS marine
for (const [n, lat, lon] of [['Santa Monica Pier', 34.0083, -118.4988], ['Pacifica Pier', 37.6325, -122.4966], ['Newport OR jetty', 44.6168, -124.0700], ['Berkeley pier (bay)', 37.8637, -122.3255]]) {
  const z = await probe(`NWS marine zone ${n}`, `https://api.weather.gov/zones?type=marine&point=${lat},${lon}`, { show: 300 });
  const id = z?.features?.[0]?.properties?.id;
  console.log('zone ids', JSON.stringify(z?.features?.map(f => [f.properties.id, f.properties.name, f.properties.type])));
  const c = await probe(`NWS coastal zone ${n}`, `https://api.weather.gov/zones?type=coastal&point=${lat},${lon}`, { show: 200 });
  console.log('coastal ids', JSON.stringify(c?.features?.map(f => [f.properties.id, f.properties.name])));
  const zid = id ?? c?.features?.[0]?.properties?.id;
  if (zid) {
    await probe(`NWS zone forecast ${zid}`, `https://api.weather.gov/zones/forecast/${zid}/forecast`, { show: 1200 });
    await probe(`NWS zone forecast marine type ${zid}`, `https://api.weather.gov/zones/marine/${zid}/forecast`, { show: 600 });
  }
  const a = await probe(`NWS alerts point ${n}`, `https://api.weather.gov/alerts/active?point=${lat},${lon}`, { show: 200 });
  console.log('alerts', JSON.stringify(a?.features?.map(f => [f.properties.event, f.properties.headline])));
  await probe(`Open-Meteo marine ${n}`, `https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lon}&hourly=wave_height,wave_period,wave_direction,swell_wave_height,swell_wave_period,swell_wave_direction,sea_surface_temperature,ocean_current_velocity,ocean_current_direction&daily=wave_height_max&timezone=auto&forecast_days=3&length_unit=imperial`, { show: 700 });
}
// CWF products (text) by office
for (const off of ['MTR', 'LOX', 'PQR']) {
  const l = await probe(`NWS CWF list ${off}`, `https://api.weather.gov/products/types/CWF/locations/${off}`, { show: 300 });
  const id = l?.['@graph']?.[0]?.id;
  if (id) await probe(`NWS CWF ${off}`, `https://api.weather.gov/products/${id}`, { show: 2500 });
}
await probe('NWS marine text tgftp', 'https://tgftp.nws.noaa.gov/data/forecasts/marine/coastal/pz/pzz545.txt', { json: false, show: 800 });
// MPAs: find the layers
for (const q of ['California Marine Protected Areas ds582', 'Oregon marine reserves', 'MPA Inventory NOAA', 'Oregon Marine Reserves boundaries']) {
  const j = await probe(`ArcGIS search ${q}`, `https://www.arcgis.com/sharing/rest/search?f=json&num=12&q=${encodeURIComponent(q + ' type:"Feature Service"')}`, { show: 0 });
  for (const r of j?.results ?? []) console.log(`  ${r.title} | ${r.owner} | ${r.url}`);
}
const ca = await probe('CDFW ds582 guess', 'https://services2.arcgis.com/Uq9r85Potqm3MfRV/arcgis/rest/services/biosds582_fpu/FeatureServer/0?f=json', { show: 1500 });
// Pages to cite
for (const u of ['https://wildlife.ca.gov/Fishing/Ocean/Regulations/Groundfish-Summary', 'https://wildlife.ca.gov/Conservation/Marine/MPAs', 'https://wildlife.ca.gov/Fishing/Ocean/Regulations', 'https://wildlife.ca.gov/Licensing/Fishing',
  'https://wildlife.ca.gov/Fishing/Ocean/Piers', 'https://myodfw.com/fishing/marine-zone', 'https://myodfw.com/articles/recreational-bottomfish-fishing', 'https://oregonmarinereserves.com/', 'https://www.dfw.state.or.us/mrp/finfish/bottomfish/',
  'https://www.dfw.state.or.us/resources/fishing/docs/Ocean_Bottomfish.pdf', 'https://tidesandcurrents.noaa.gov/noaatidepredictions.html?id=9414290', 'https://forecast.weather.gov/shmrn.php?mz=pzz545', 'https://marine.weather.gov/MapClick.php?lat=37.63&lon=-122.5']) {
  const t = await probe(`PAGE ${u}`, u, { json: false, show: 0 });
  if (t) { const title = t.match(/<title[^>]*>([^<]*)/i)?.[1]; console.log('  title:', title?.trim()); }
}
const gs = await probe('Groundfish summary text', 'https://wildlife.ca.gov/Fishing/Ocean/Regulations/Groundfish-Summary', { json: false, show: 0 });
if (gs) console.log(gs.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').slice(0, 9000));
// Overpass: piers along the coast, one band
const oq = `[out:json][timeout:120];way["natural"="coastline"](37.4,-123.2,38.0,-122.0)->.c;(nwr["man_made"="pier"]["name"](around.c:300);nwr["man_made"~"breakwater|groyne"]["name"](around.c:300);nwr["leisure"="fishing"](around.c:300);nwr["natural"="beach"]["name"](around.c:300);nwr["sport"="surfing"](37.4,-123.2,38.0,-122.0););out center tags;`;
const ov = await probe('Overpass SF band', 'https://overpass-api.de/api/interpreter', { show: 0 }).catch(() => null);
try {
  const r = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: 'data=' + encodeURIComponent(oq), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'TackleBox-probe' } });
  const j = await r.json();
  const k = {};
  for (const e of j.elements) { const t = e.tags.man_made ?? e.tags.leisure ?? e.tags.natural ?? e.tags.sport; k[t] = (k[t] ?? 0) + 1; }
  console.log('\n### Overpass SF band', r.status, j.elements.length, JSON.stringify(k));
  for (const e of j.elements.filter(e => e.tags.man_made === 'pier').slice(0, 40)) console.log('  pier', e.tags.name, JSON.stringify(Object.fromEntries(Object.entries(e.tags).filter(([x]) => /access|fishing|operator|owner|ownership|fee|opening/.test(x)))));
} catch (e) { console.log('Overpass failed', e.message); }
