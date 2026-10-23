// Temporary: logs what the safety-data sources look like from a GitHub runner. Removed before merge. Round 2.
const UA = { 'User-Agent': 'TackleBox-fishing-app (personal, github.com/mikegutberlet/FishingApp)' };
const strip = s => s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
async function get(url, init) {
  try {
    const r = await fetch(url, { ...init, headers: { ...UA, ...init?.headers }, signal: AbortSignal.timeout(200000) });
    const body = await r.text();
    console.log(`\n=== ${r.status} ${url} (${body.length} bytes, ${r.headers.get('content-type')})`);
    return body;
  } catch (e) { console.log(`\n=== FAIL ${url}: ${e.message}`); return ''; }
}

for (const id of ['c6a36b91-ad38-4611-8750-87ee99e497dd', '7805faef-ed21-43e9-a13e-4920a9440bb8', '55b9a341-04e1-4f4a-9839-6eb36e6cc8ed']) {
  const j = await get(`https://data.ca.gov/api/3/action/datastore_search?resource_id=${id}&limit=3&sort=_id%20desc`);
  try { const r = JSON.parse(j).result; console.log('total', r.total, 'fields', r.fields.map(f => `${f.id}:${f.type}`).join(', ')); for (const x of r.records) console.log(JSON.stringify(x)); } catch { console.log(j.slice(0, 500)); }
}
// Distinct values for advisory level fields in bloom reports (field names guessed from round 1 output below)
const sql = encodeURIComponent('SELECT * FROM "c6a36b91-ad38-4611-8750-87ee99e497dd" LIMIT 1');
console.log((await get(`https://data.ca.gov/api/3/action/datastore_search_sql?sql=${sql}`)).slice(0, 1500));

for (const layer of [0, 1, 2]) {
  const base = `https://gispublic.waterboards.ca.gov/arcgis/rest/services/WQMC/WQMC_Fish_Advisories/MapServer/${layer}`;
  const meta = await get(`${base}?f=json`);
  try { const m = JSON.parse(meta); console.log(m.name, m.geometryType, (m.fields ?? []).map(f => f.name).join(', ')); } catch { console.log(meta.slice(0, 300)); }
  console.log((await get(`${base}/query?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&resultRecordCount=2&f=json`)).slice(0, 2500));
  console.log((await get(`${base}/query?where=1%3D1&returnCountOnly=true&f=json`)).slice(0, 200));
}

// LII statewide sections
for (const sec of ['7.00', '5.00', '1.05', '7.50']) {
  const h = await get(`https://www.law.cornell.edu/regulations/california/14-CCR-${sec}`);
  const i = h.indexOf('<h1');
  console.log(strip(h.slice(i)).slice(0, sec === '7.50' ? 2500 : 7000));
  console.log('section links:', [...new Set([...h.matchAll(/href="\/regulations\/california\/14-CCR-([\d.]+)"/g)].map(m => m[1]))].join(' '));
  if (sec === '7.50') {
    console.log('rows', (h.match(/<tr/g) ?? []).length, 'tables', (h.match(/<table/g) ?? []).length);
    const t = strip(h); const k = t.indexOf('(b)'); console.log(t.slice(k - 300, k + 1200));
    const lakes = [...h.matchAll(/<td>\s*\((\d+(?:\.\d+)?)\)\s*([^<]{0,120})/g)].map(m => `${m[1]} ${m[2].replace(/\s+/g, ' ')}`);
    console.log(lakes.length, 'numbered entries'); console.log(lakes.join('\n'));
  }
}
let h = await get('https://www.law.cornell.edu/regulations/california/title-14/division-1/subdivision-1/chapter-4');
console.log([...new Set([...h.matchAll(/href="\/regulations\/california\/14-CCR-([\d.]+)"[^>]*>([^<]+)/g)].map(m => `${m[1]} ${m[2]}`))].join('\n'));

// Overpass: the real access query, counts only
const q = `[out:json][timeout:300];area["ISO3166-2"="US-CA"]->.ca;
(nwr["leisure"="slipway"](area.ca);)->.ramps;
(nwr["leisure"="fishing"](area.ca);nwr["man_made"="pier"]["fishing"~"yes|designated"](area.ca);)->.fish;
(nwr["tourism"="camp_site"](area.ca);)->.camp;
(nwr["leisure"="marina"](area.ca);nwr["amenity"="boat_rental"](area.ca);nwr["shop"="fishing"](area.ca);)->.other;
(nwr["amenity"="parking"](around.ramps:250);nwr["amenity"="parking"](around.fish:150);)->.park;
.ramps out count;.fish out count;.camp out count;.other out count;.park out count;`;
console.log((await get('https://overpass-api.de/api/interpreter', { method: 'POST', body: new URLSearchParams({ data: q }) })).slice(0, 3000));
