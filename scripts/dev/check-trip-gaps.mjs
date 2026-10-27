// Probes the sources batch 8 (trip gaps) reads, from a GitHub runner, since Claude's sandbox can't reach them.
// Prints status, CORS header, size and short samples. Writes nothing.
const ORIGIN = 'https://mikegutberlet.github.io';
const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
async function get(url, { show = 600, grep = null, links = null, method = 'GET', body = null, headers = {} } = {}) {
  try {
    const r = await fetch(url, { method, body, headers: { Origin: ORIGIN, 'User-Agent': UA, ...headers }, redirect: 'follow', signal: AbortSignal.timeout(40e3) });
    const buf = Buffer.from(await r.arrayBuffer());
    const ct = r.headers.get('content-type') ?? '';
    console.log(`\n### ${url}\n${r.status} acao=${r.headers.get('access-control-allow-origin')} type=${ct} bytes=${buf.length} final=${r.url}`);
    if (/pdf/.test(ct)) return buf;
    const t = buf.toString('utf8');
    if (show) console.log(t.slice(0, show).replace(/\s+/g, ' '));
    if (grep) { const re = new RegExp(`.{0,160}(${grep}).{0,200}`, 'gi'); const hits = [...t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').matchAll(re)].slice(0, 25); for (const h of hits) console.log('  ~', h[0]); }
    if (links) { const re = /href="([^"]+)"[^>]*>([\s\S]{0,120}?)<\/a>/gi; const seen = new Set(); for (const m of t.matchAll(re)) { const s = `${m[1]} | ${m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()}`; if (new RegExp(links, 'i').test(s) && !seen.has(s)) { seen.add(s); console.log('  ->', s); } if (seen.size > 40) break; } }
    return t;
  } catch (e) { console.log(`\n### ${url}\nFAILED ${e.message}`); }
}
const part = process.argv[2] ?? 'all';
if (part === 'all' || part === 'roads') {
  for (const d of ['02', '03', '06', '08', '09', '10']) await get(`https://cwwp2.dot.ca.gov/data/d${+d}/cc/ccStatusD${d}.json`, { show: 900 });
  await get('https://cwwp2.dot.ca.gov/data/d3/lcs/lcsStatusD03.json', { show: 1500 });
  await get('https://cwwp2.dot.ca.gov/data/d9/lcs/lcsStatusD09.json', { show: 300, grep: 'Full|closure.{0,10}type|"typeOfClosure":"[^"]+"' });
  await get('https://roads.dot.ca.gov/roadscell.php?roadnumber=120', { show: 1500 });
  await get('https://roads.dot.ca.gov/roadscell.php?roadnumber=88', { show: 800 });
  await get('https://www.nvroads.com/', { show: 200, links: 'api|json|condition|winter' });
  await get('https://www.nvroads.com/List/GetData/Incidents?query=%7B%22start%22%3A0%2C%22length%22%3A5%7D', { show: 800 });
  await get('https://www.nvroads.com/List/GetData/WinterRoadConditions?query=%7B%22start%22%3A0%2C%22length%22%3A5%7D', { show: 800 });
  await get('https://www.nvroads.com/map/mapIcons/Incidents', { show: 600 });
  await get('https://www.tripcheck.com/', { show: 200, links: 'json|data|condition|pass' });
  await get('https://www.tripcheck.com/Scripts/map/data/INCD.js', { show: 600 });
  await get('https://www.tripcheck.com/Scripts/map/data/RW.js', { show: 600 });
  await get('https://www.tripcheck.com/Scripts/map/data/RdConditions.js', { show: 600 });
  await get('https://www.tripcheck.com/DynamicReports/Report/RoadConditions/0', { show: 800 });
}
if (part === 'all' || part === 'regs') {
  await get('https://wildlife.ca.gov/Regulations', { show: 0, links: 'pdf|DocumentID|freshwater|booklet' });
  await get('https://wildlife.ca.gov/Fishing/Inland', { show: 0, links: 'pdf|DocumentID|regulation' });
  await get('https://www.ndow.org/fish/fishing-regulations/', { show: 0, links: 'pdf|regulation|guide' });
  await get('https://www.ndow.org/regulations/', { show: 0, links: 'pdf|fish' });
  await get('https://myodfw.com/fishing/regulations', { show: 0, links: 'pdf|regulation' });
  await get('https://myodfw.com/regulations', { show: 0, links: 'pdf|regulation|fish' });
}
if (part === 'all' || part === 'ramps') {
  await get('https://www.parks.ca.gov/?page_id=500', { show: 0, grep: 'ramp.{0,80}(feet|ft|elev)|elevation', links: 'ramp|launch|lake level' });
  await get('https://www.parks.ca.gov/?page_id=462', { show: 0, grep: 'ramp.{0,80}(feet|ft|elev)|elevation', links: 'ramp|launch|lake level' });
  await get('https://www.usbr.gov/mp/ccao/newmelones/', { show: 0, links: 'ramp|launch|boat' });
  await get('https://www.nps.gov/lake/planyourvisit/launch-ramp-status.htm', { show: 0, grep: 'ramp.{0,120}(feet|ft|elev)|lake level|elevation' });
  await get('https://www.nps.gov/lake/planyourvisit/boating.htm', { show: 0, links: 'ramp|launch', grep: 'launch ramp.{0,100}(feet|ft)' });
  await get('https://www.nwp.usace.army.mil/Locations/Willamette-Valley/Detroit/', { show: 0, grep: 'ramp.{0,120}(feet|ft|elev)', links: 'ramp|boat|teacup|level' });
  await get('https://www.nwp.usace.army.mil/Missions/Water-Management/Willamette-Valley-Reservoirs/', { show: 0, links: 'ramp|boat' , grep: 'ramp'});
  await get('https://www.oregon.gov/osmb/boating-facilities/Pages/Willamette-Reservoirs.aspx', { show: 0, grep: 'ramp.{0,120}(feet|ft|elev)|usable' });
  await get('https://www.fs.usda.gov/stnf', { show: 0, links: 'ramp|launch|lake level' });
}
if (part === 'all' || part === 'osm') {
  const q = `[out:json][timeout:60];(nwr(around:40000,39.115,-120.031)["amenity"="fuel"];nwr(around:40000,39.115,-120.031)["shop"~"^(fishing|convenience|supermarket|general|outdoor|hunting)$"];nwr(around:40000,39.115,-120.031)["vending"~"ice"];nwr(around:5000,39.115,-120.031)["leisure"="slipway"];);out center tags 300;`;
  const t = await get('https://overpass-api.de/api/interpreter', { method: 'POST', body: 'data=' + encodeURIComponent(q), show: 0, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  try { const j = JSON.parse(t); const by = {}; for (const e of j.elements) { const k = e.tags.amenity || e.tags.shop || e.tags.leisure || e.tags.vending; by[k] = (by[k] ?? 0) + 1; } console.log(by); for (const e of j.elements.filter(e => /fishing|slipway/.test(e.tags.shop + e.tags.leisure)).slice(0, 10)) console.log(JSON.stringify(e.tags)); for (const e of j.elements.filter(e => e.tags.ice || e.tags.bait || e.tags['vending']).slice(0, 10)) console.log('ICE/BAIT', JSON.stringify(e.tags)); } catch (e) { console.log('parse', e.message); }
}
