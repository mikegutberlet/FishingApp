// Dev check: runs the app's own Camping lookup (camping.js + camping-rules.js) against the live services for a few
// known waters and prints what the tab would say. The sandbox can't reach the services; Actions can.
globalThis.location = { origin: 'https://example.invalid' };
globalThis.caches = { open: async () => ({ match: async () => null, put: async () => {}, delete: async () => {} }) };
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, init = {}) => {
  try { return await realFetch(u, { ...init, headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) TackleBox-check', Referer: 'https://mikegutberlet.github.io/FishingApp/', Origin: 'https://mikegutberlet.github.io', ...(init.headers ?? {}) } }); }
  catch (e) { console.warn(`fetch ${String(u).slice(0, 80)} failed: ${e.message} ${e.cause?.code ?? ''}`); throw e; }
};
const { lookupCamping, weekendAvailability, nextWeekend } = await import('../../camping.js');
const { dispersedSummary } = await import('../../camping-rules.js');

const WATERS = [
  { name: 'Caples Lake', lat: 38.709, lon: -120.041, acres: 600, note: 'CA, Eldorado NF, Hwy 88' },
  { name: 'Anthony Lake', lat: 44.962, lon: -118.231, acres: 22, note: 'OR, Wallowa-Whitman NF' },
  { name: 'Rye Patch Reservoir', lat: 40.47, lon: -118.30, acres: 11000, note: 'NV, state rec area + BLM' },
  { name: 'Wilson Reservoir', lat: 41.616, lon: -116.408, acres: 800, note: 'NV, BLM' },
  { name: 'Folsom Lake', lat: 38.72, lon: -121.13, acres: 11450, note: 'CA, state rec area' },
  { name: 'Detroit Lake', lat: 44.72, lon: -122.18, acres: 3580, note: 'OR, Willamette NF + state park' },
  { name: 'Shasta Lake', lat: 40.75, lon: -122.32, acres: 29740, note: 'CA, big, boat-in camps' },
];
// Probe: why Recreation.gov's search returns nothing near some waters, and which ids the forest inventory carries.
const RG = 'https://www.recreation.gov/api/search';
for (const [label, q] of [
  ['caples as app', 'lat=38.7090&lng=-120.0410&radius=11&size=60&fq=entity_type:campground'],
  ['caples no fq', 'lat=38.7090&lng=-120.0410&radius=11&size=60'],
  ['caples q=silver lake', 'q=silver%20lake&size=10'],
  ['caples fq+exact', 'lat=38.7090&lng=-120.0410&radius=11&size=60&fq=entity_type:campground&exact=false'],
  ['shasta as app', 'lat=40.7500&lng=-122.3200&radius=14&size=60&fq=entity_type:campground'],
]) {
  try {
    const r = await fetch(`${RG}?${q}`); const j = await r.json();
    console.log(`PROBE ${label}: ${r.status} total=${j.total ?? j.size} n=${j.results?.length}`, JSON.stringify((j.results ?? []).slice(0, 12).map(x => [x.name, x.entity_id, x.entity_type, x.latitude, x.longitude, x.reservable])));
    if (label === 'caples q=silver lake') console.log('PROBE keys', Object.keys(j), JSON.stringify(j.results?.[0] ?? {}).slice(0, 1500));
  } catch (e) { console.log(`PROBE ${label} failed ${e.message}`); }
}
try {
  const u = 'https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_InfraRecreationSites_01/MapServer/0/query?' + new URLSearchParams({ where: "site_name like '%BAILEY COVE%' or site_name like '%SILVER LAKE%' or site_name like '%CAPLES%'", outFields: 'site_name,site_subtype,rec1stop_url,nrrs_id,operated_by,latitude,longitude', returnGeometry: 'false', f: 'json' });
  const j = await (await fetch(u)).json();
  console.log('PROBE INFRA', JSON.stringify(j.features?.map(f => f.attributes)));
} catch (e) { console.log('PROBE INFRA failed', e.message); }

console.log('next weekend:', nextWeekend());
for (const w of WATERS) {
  const t = Date.now();
  let partialAt = null;
  const d = await lookupCamping({ id: w.name, ...w, kind: 'lake' }, { force: true, onPartial: () => { partialAt = Date.now() - t; } });
  const land = dispersedSummary(d.land?.parcels);
  console.log(`\n================ ${w.name} (${w.note}) ${Date.now() - t}ms, partial at ${partialAt}ms, failed=${JSON.stringify(d.failed)}, search ${d.searchKm.toFixed(1)} km`);
  const bySrc = {};
  for (const s of d.sites) for (const x of s.sources) bySrc[x.label] = (bySrc[x.label] ?? 0) + 1;
  console.log('sites', d.sites.length, 'by source', JSON.stringify(bySrc), 'kinds', JSON.stringify(d.sites.reduce((m, s) => (m[s.kind] = (m[s.kind] ?? 0) + 1, m), {})));
  console.log('LAND:', land.level, JSON.stringify(land.rows.map(r => [r.manager, r.unit, r.designation, r.rule.verdict])));
  for (const s of d.sites.slice(0, 14)) {
    console.log(`  ${s.distKm.toFixed(1)}km ${s.name} [${s.kind}] ${s.operator ?? ''} status=${s.status ?? ''} season=${s.season ?? ''} sites=${s.sites ?? ''} cap=${s.capacity ?? ''} fee=${s.fee ?? ''} price=${s.price ? `${s.price.min}-${s.price.max}` : ''} feeText=${(s.feeText ?? '').slice(0, 60)}`);
    console.log(`      water=${s.water ?? ''}(${(s.waterText ?? '').slice(0, 40)}) toilets=${s.toilets ?? ''} showers=${s.showers ?? ''} dump=${s.dump ?? ''} hookups=${s.hookups ?? ''} res=${s.reservable ?? ''} firstCome=${s.firstCome ?? ''} recgov=${s.recgovId ?? ''} len=${s.maxLength ?? ''} alert=${(s.alert ?? '').slice(0, 60)} resv=${(s.reservations ?? '').slice(0, 60)}`);
    console.log(`      ${s.sources.map(x => x.label).join(' + ')} info=${s.infoUrl ?? ''} book=${s.bookUrl ?? ''}`);
  }
  if (w.name === "Caples Lake") console.log(`DATA ${w.name} ${JSON.stringify(d)}`);
  const r = d.sites.find(s => s.recgovId);
  if (r) {
    try { console.log('AVAILABILITY', r.name, JSON.stringify(await weekendAvailability(r.recgovId))); } catch (e) { console.log('AVAILABILITY failed', e.message); }
    try { console.log('AVAILABILITY Jul 3-4 2027', r.name, JSON.stringify(await weekendAvailability(r.recgovId, ['2027-07-02', '2027-07-03']))); } catch (e) { console.log('AVAILABILITY failed', e.message); }
  }
}
