// One-off probe of Nevada sources from a GitHub runner (the dev sandbox can't reach them). Writes data/nv/logs/probe.json.
import { writeFile, mkdir } from 'node:fs/promises';
const OUT = new URL('../../data/nv/logs/', import.meta.url);
const BROWSER = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', Accept: 'text/html,application/json,*/*' };
const URLS = [
  'https://www.fish.wildlifenv.com/waters/4007',
  'https://fish.wildlifenv.com/',
  'https://www.fish.wildlifenv.com/api/waters/4007',
  'https://www.fish.wildlifenv.com/api/waters',
  'https://data.usbr.gov/rise/api/catalog-record?locationId=3514&itemsPerPage=50',
  'https://data.usbr.gov/rise/api/catalog-record?locationId=3513&itemsPerPage=50',
  'https://www.ndow.org/get-outside/fishing/',
  'https://www.ndow.org/apply-buy/fishing/',
  'https://www.ndow.org/get-outside/plan-your-fishing-trip/',
  'https://www.ndow.org/get-outside/fishing-stocking-reports/',
];
const out = {};
for (const u of URLS) {
  try {
    const r = await fetch(u, { headers: BROWSER, redirect: 'follow' });
    const text = await r.text();
    const links = [...new Set([...text.matchAll(/(?:href|src)=["']([^"']+)["']/g)].map(m => m[1]))]
      .filter(l => /fish|json|api|csv|xlsx|pdf|arcgis|regulat|advis|mercury|consum|guide|seasons|water|map|geo|lat/i.test(l)).slice(0, 200);
    out[u] = { status: r.status, type: r.headers.get('content-type'), total: r.headers.get('x-wp-total'), pages: r.headers.get('x-wp-totalpages'), length: text.length, body: text.slice(0, 60000), links };
  } catch (e) { out[u] = { error: e.message }; }
}
await mkdir(OUT, { recursive: true });
await writeFile(new URL('probe.json', OUT), JSON.stringify(out, null, 1));
console.log(Object.entries(out).map(([u, v]) => `${v.status ?? v.error} ${v.length ?? ''} total=${v.total} ${u}`).join('\n'));
