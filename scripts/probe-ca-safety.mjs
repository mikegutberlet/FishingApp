// Temporary: logs what the safety-data sources look like from a GitHub runner. Removed before merge. Round 4.
const UA = { 'User-Agent': 'TackleBox-fishing-app (personal, github.com/mikegutberlet/FishingApp)' };
const text = s => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url, init) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, { ...init, headers: { ...UA, ...init?.headers }, signal: AbortSignal.timeout(200000) });
      const body = await r.text();
      console.log(`\n=== ${r.status} ${url} (${body.length} bytes)`);
      if (r.status === 503 || r.status === 429) { await sleep(20000 * (i + 1)); continue; }
      return body;
    } catch (e) { console.log(`\n=== FAIL ${url}: ${e.message}`); }
  }
  return '';
}

for (const layer of [0, 1, 11, 12, 13]) {
  const m = await get(`https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/${layer}?f=json`);
  try { const j = JSON.parse(m); console.log(layer, j.name, j.geometryType, (j.fields ?? []).map(f => f.name).join(',')); } catch { console.log(m.slice(0, 200)); }
}
console.log((await get(`https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1/query?where=STATE%3D'06'&outFields=NAME,STATE,COUNTY&returnGeometry=false&f=json`)).slice(0, 800));

const lii = async sec => { await sleep(5000); const h = await get(`https://www.law.cornell.edu/regulations/california/14-CCR-${sec}`); return h ? h.slice(h.indexOf('<h1')) : ''; };
for (const sec of ['5.70', '5.80', '5.81', '5.82', '5.85', '5.86', '5.87', '5.88', '5.89', '5.90', '5.91', '5.95', '7.40', '8.00', '2.00', '2.05', '2.08', '2.10', '2.30', '1.53']) {
  const body = await lii(sec);
  if (!body) continue;
  const t = text(body);
  console.log(t.slice(0, 1800));
  const rows = [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  console.log('rows', rows.length);
  for (const [, row] of rows.slice(0, sec === '7.40' ? 40 : 25)) console.log('ROW', [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m => text(m[1])).join(' | ').slice(0, 300));
}
const b = await lii('5.15');
for (const [, row] of [...b.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].slice(0, 40)) console.log('ROW', [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m => text(m[1])).join(' | ').slice(0, 300));
console.log(b.slice(b.indexOf('BODY OR'), b.indexOf('BODY OR') + 2500));
