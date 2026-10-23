// One-off probe of Nevada sources from a GitHub runner (the dev sandbox can't reach them). Writes data/nv/logs/probe.json.
import { writeFile, mkdir } from 'node:fs/promises';
const OUT = new URL('../../data/nv/logs/', import.meta.url);
const BROWSER = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', Accept: 'text/html,application/json,*/*' };
const URLS = [
  'https://www.ndow.org/wp-json/wp/v2/waters?slug=topaz-lake',
  'https://www.ndow.org/wp-json/wp/v2/waters?per_page=100&_fields=id,slug,title,modified,location,waters_type',
  'https://www.ndow.org/wp-json/wp/v2/location',
  'https://www.ndow.org/wp-json/wp/v2/waters_type?per_page=100',
  'https://www.ndow.org/get-outside/rules-regulations/',
  'https://nevada-department-of-wildlife-data-hub-ndow.hub.arcgis.com/api/search/v1/collections/all/items?q=stocking&limit=20',
  'https://nevada-department-of-wildlife-data-hub-ndow.hub.arcgis.com/api/search/v1/collections/all/items?q=fish&limit=40',
  'https://data.usbr.gov/rise/api/location?search=Lake%20Mead&itemsPerPage=20',
  'https://data.usbr.gov/rise/api/location?search=Mohave&itemsPerPage=20',
  'https://data.usbr.gov/rise/api/location?stateId=NV&itemsPerPage=100',
  'https://waterservices.usgs.gov/nwis/dv/?format=json&sites=10288500,10297000&parameterCd=62614,62615,00062,72275,00054&period=P10D',
];
const out = {};
for (const u of URLS) {
  try {
    const r = await fetch(u, { headers: BROWSER, redirect: 'follow' });
    const text = await r.text();
    const links = [...new Set([...text.matchAll(/(?:href|src)=["']([^"']+)["']/g)].map(m => m[1]))]
      .filter(l => /fish|json|api|csv|xlsx|pdf|arcgis|regulat|advis|mercury|consum/i.test(l)).slice(0, 200);
    out[u] = { status: r.status, type: r.headers.get('content-type'), total: r.headers.get('x-wp-total'), pages: r.headers.get('x-wp-totalpages'), length: text.length, body: text.slice(0, 60000), links };
  } catch (e) { out[u] = { error: e.message }; }
}
await mkdir(OUT, { recursive: true });
await writeFile(new URL('probe.json', OUT), JSON.stringify(out, null, 1));
console.log(Object.entries(out).map(([u, v]) => `${v.status ?? v.error} ${v.length ?? ''} total=${v.total} ${u}`).join('\n'));
