// Temporary: logs what the safety-data sources look like from a GitHub runner. Removed before merge.
const UA = { 'User-Agent': 'TackleBox-fishing-app (personal, github.com/mikegutberlet/FishingApp)' };
const strip = s => s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
async function get(url, init) {
  try {
    const r = await fetch(url, { ...init, headers: { ...UA, ...init?.headers }, signal: AbortSignal.timeout(90000) });
    const body = await r.text();
    console.log(`\n=== ${r.status} ${url} (${body.length} bytes, ${r.headers.get('content-type')})`);
    return body;
  } catch (e) { console.log(`\n=== FAIL ${url}: ${e.message}`); return ''; }
}
const around = (s, re, n = 1500) => { const i = s.search(re); return i < 0 ? '(not found)' : s.slice(Math.max(0, i - 200), i + n); };

// Regulations
for (const sec of ['7.50', '5.00', '7.00', '1.05']) {
  const h = await get(`https://www.law.cornell.edu/regulations/california/14-CCR-${sec}`);
  console.log(around(h, sec === '7.50' ? /Alameda|Abbott|Almanor/ : /Black Bass|District|bass/i, 4000));
}
let h = await get('https://www.eregulations.com/california/fishing/freshwater');
console.log([...new Set([...h.matchAll(/href="([^"]*freshwater[^"]*)"/gi)].map(m => m[1]))].slice(0, 80).join('\n'));
h = await get('https://wildlife.ca.gov/Regulations');
console.log([...h.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([^<]{3,120})<\/a>/gi)].filter(m => /fresh|inland|sport|regulat|pdf|FileHandler/i.test(m[0])).map(m => `${m[1]} | ${m[2].trim()}`).slice(0, 60).join('\n'));
h = await get('https://wildlife.ca.gov/Fishing/Inland');
console.log([...h.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([^<]{3,120})<\/a>/gi)].filter(m => /regulat|special|FileHandler/i.test(m[0])).map(m => `${m[1]} | ${m[2].trim()}`).slice(0, 40).join('\n'));

// CKAN: HABs and fish advisories
for (const q of ['harmful algal blooms', 'fish advisory', 'fish consumption']) {
  const j = await get(`https://data.ca.gov/api/3/action/package_search?q=${encodeURIComponent(q)}&rows=8`);
  try {
    for (const p of JSON.parse(j).result.results) {
      console.log(`PKG ${p.name} | ${p.title} | ${p.organization?.name}`);
      for (const r of p.resources) console.log(`   RES ${r.id} | ${r.name} | ${r.format} | ds=${r.datastore_active} | ${r.url} | ${r.last_modified}`);
    }
  } catch (e) { console.log('parse fail', j.slice(0, 300)); }
}
// ArcGIS Online item search
for (const q of ['OEHHA fish advisories', 'freshwater harmful algal bloom California', 'HAB incident reports California water boards']) {
  const j = await get(`https://www.arcgis.com/sharing/rest/search?f=json&num=10&q=${encodeURIComponent(q)}`);
  try { for (const r of JSON.parse(j).results) console.log(`AGO ${r.type} | ${r.title} | ${r.owner} | ${r.url ?? ''} | ${r.id}`); } catch { console.log(j.slice(0, 300)); }
}
// OEHHA advisory pages
h = await get('https://oehha.ca.gov/fish/advisories');
const advLinks = [...new Set([...h.matchAll(/href="(\/fish\/advisories\/[^"#?]+)"/g)].map(m => m[1]))];
console.log(`${advLinks.length} advisory links`, advLinks.slice(0, 40).join('\n'));
console.log(around(strip(h), /advisor/i, 2500));
h = await get('https://oehha.ca.gov/fish/advisories?page=1');
console.log([...new Set([...h.matchAll(/href="(\/fish\/advisories\/[^"#?]+)"/g)].map(m => m[1]))].length, 'links on page 1');
if (advLinks[5]) { h = await get(`https://oehha.ca.gov${advLinks[5]}`); console.log(around(strip(h), /servings|Women|Children/i, 4000)); console.log(around(h, /lat|geofield|leaflet|coordinates/i, 600)); }
h = await get('https://oehha.ca.gov/fish/advisories/lake-berryessa');
console.log(around(strip(h), /servings|Women|Children/i, 4000));
console.log(around(h, /<table/i, 3000));

// Overpass
const ov = await get('https://overpass-api.de/api/interpreter', { method: 'POST', body: new URLSearchParams({ data: '[out:json][timeout:120];area["ISO3166-2"="US-CA"]->.ca;(nwr["leisure"="slipway"](area.ca););out count;' }) });
console.log(ov.slice(0, 600));
