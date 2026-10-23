// One-off probe of Nevada sources from a GitHub runner (the dev sandbox can't reach them). Writes data/nv/logs/probe.json.
import { writeFile, mkdir } from 'node:fs/promises';
const OUT = new URL('../../data/nv/logs/', import.meta.url);
const BROWSER = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', Accept: 'text/html,application/json,*/*' };
const URLS = [
  'https://www.ndow.org/wp-json/',
  'https://www.ndow.org/wp-json/wp/v2/types',
  'https://www.ndow.org/wp-json/wp/v2/waters?per_page=5',
  'https://www.ndow.org/wp-json/wp/v2/water?per_page=5',
  'https://www.ndow.org/sitemap_index.xml',
  'https://www.ndow.org/wp-sitemap.xml',
  'https://www.ndow.org/sitemap.xml',
  'https://www.ndow.org/get-outside/fishing-stocking-reports/',
  'https://www.ndow.org/get-outside/fishing-stocking-reports/database/',
  'https://www.ndow.org/waters/topaz-lake/',
  'https://www.ndow.org/waters/mitch-park-pond/',
  'https://www.ndow.org/get-outside/fishing/',
  'https://www.ndow.org/blog/fishing-report-09-01-2026/',
  'https://nvose.org/hot-topic-harmful-algal-blooms/',
  'https://services.arcgis.com/RyxlXSfFi87rAosq/ArcGIS/rest/services/NDOWFishableWaters/FeatureServer/1/query?where=1%3D1&outFields=*&returnGeometry=false&resultRecordCount=3&f=json',
  'https://services.arcgis.com/RyxlXSfFi87rAosq/ArcGIS/rest/services/NDOWFishableWaters/FeatureServer/1/query?where=1%3D1&returnCountOnly=true&f=json',
  'https://services.arcgis.com/RyxlXSfFi87rAosq/ArcGIS/rest/services/NDOWFishableWaters/FeatureServer/0/query?where=1%3D1&returnCountOnly=true&f=json',
  'https://services.arcgis.com/RyxlXSfFi87rAosq/ArcGIS/rest/services?f=json',
  'https://waterservices.usgs.gov/nwis/site/?format=rdb&stateCd=nv&parameterCd=62614,62615,00062,72275,00054,62616,62617&siteStatus=active&hasDataTypeCd=dv',
  'https://data.usbr.gov/rise/api/location?search=Mead&itemsPerPage=5',
  'https://data.usbr.gov/rise/api/catalog-item?search=Lake%20Mead%20Elevation&itemsPerPage=5',
  'https://www.law.cornell.edu/regulations/nevada/NAC-503-590',
];
const out = {};
for (const u of URLS) {
  try {
    const r = await fetch(u, { headers: BROWSER, redirect: 'follow' });
    const text = await r.text();
    const links = [...new Set([...text.matchAll(/(?:href|src)=["']([^"']+)["']/g)].map(m => m[1]))]
      .filter(l => /stock|water|json|api|csv|xlsx|pdf|arcgis|sheet|powerbi|regulat|sitemap|tableau|ajax|report/i.test(l)).slice(0, 150);
    out[u] = { status: r.status, type: r.headers.get('content-type'), finalUrl: r.url, length: text.length, head: text.slice(0, 2500), links };
    const i = text.search(/Stocking Updates|Stocked Species|Year to Date/i);
    if (i >= 0) out[u].stockingHtml = text.slice(Math.max(0, i - 500), i + 6000);
    const j = text.search(/HAB (Watch|Warning|Danger)/);
    if (j >= 0) out[u].habHtml = text.slice(Math.max(0, j - 1500), j + 6000);
  } catch (e) { out[u] = { error: e.message }; }
}
await mkdir(OUT, { recursive: true });
await writeFile(new URL('probe.json', OUT), JSON.stringify(out, null, 1));
console.log(Object.entries(out).map(([u, v]) => `${v.status ?? v.error} ${v.length ?? ''} ${u}`).join('\n'));
