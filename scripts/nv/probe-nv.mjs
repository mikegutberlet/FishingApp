// One-off probe of Nevada sources from a GitHub runner (the dev sandbox can't reach them). Writes data/nv/logs/probe.json.
import { writeFile, mkdir } from 'node:fs/promises';
const OUT = new URL('../../data/nv/logs/', import.meta.url);
const BROWSER = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', Accept: 'text/html,application/json,*/*' };
const URLS = [
  'https://www.fish.wildlifenv.com/assets/index.60d03b8c.js',
  'https://data.usbr.gov/rise/api/location/3514',
  'https://data.usbr.gov/rise/api/location/3513',
  'https://www.eregulations.com/nevada/fishing',
  'https://www.eregulations.com/nevada/fishing/general-statewide-regulations/',
];
const out = {};
const bundle = t => [...new Set(t.match(/https?:\/\/[^"'`\s)]+/g) ?? [])].join('\n') + '\n----\n' + [...t.matchAll(/.{0,200}(?:api\/|fetch\(|latitude|\/waters)[^\n]{0,200}/g)].slice(0, 60).map(m => m[0]).join('\n');
for (const u of URLS) {
  try {
    const r = await fetch(u, { headers: BROWSER, redirect: 'follow' });
    const text = await r.text();
    const links = [...new Set([...text.matchAll(/(?:href|src)=["']([^"']+)["']/g)].map(m => m[1]))]
      .filter(l => /fish|json|api|csv|xlsx|pdf|arcgis|regulat|advis|mercury|consum|guide|seasons|water|map|geo|lat/i.test(l)).slice(0, 200);
    out[u] = { status: r.status, type: r.headers.get('content-type'), total: r.headers.get('x-wp-total'), pages: r.headers.get('x-wp-totalpages'), length: text.length, body: /index\.[0-9a-f]+\.js/.test(u) ? bundle(text) : text.slice(0, 200000), links };
  } catch (e) { out[u] = { error: e.message }; }
}
await mkdir(OUT, { recursive: true });
await writeFile(new URL('probe.json', OUT), JSON.stringify(out, null, 1));
console.log(Object.entries(out).map(([u, v]) => `${v.status ?? v.error} ${v.length ?? ''} total=${v.total} ${u}`).join('\n'));
