// Dev check for access-more.js: the permit, pass and boat rules the Getting there tab would show for a few waters
// (using the app's own road and land lookup), the trailheads and parking near them, the fish seen on iNaturalist,
// whether those services answer a browser on the app's origin (CORS), and whether every linked agency page opens.
// The sandbox can't reach the services; Actions can. Writes nothing.
globalThis.location = { origin: 'https://example.invalid' };
globalThis.caches = { open: async () => ({ match: async () => null, put: async () => {}, delete: async () => {} }) };
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, init = {}) => {
  try { return await realFetch(u, { ...init, headers: { 'User-Agent': UA, Referer: 'https://mikegutberlet.github.io/FishingApp/', ...(init.headers ?? {}) } }); }
  catch (e) { console.warn(`fetch ${String(u).slice(0, 80)} failed: ${e.message} ${e.cause?.code ?? ''}`); throw e; }
};
const { lookupAccess } = await import('../../access-lookup.js');
const { summarize, CLASS_TEXT } = await import('../../access-rules.js');
const M = await import('../../access-more.js');

// CORS: does each live service let the app's page read it?
const ORIGIN = 'https://mikegutberlet.github.io';
for (const [name, url, init] of [
  ['iNaturalist species_counts', 'https://api.inaturalist.org/v1/observations/species_counts?lat=38.85&lng=-120.15&radius=3&iconic_taxa=Actinopterygii&quality_grade=research&per_page=3', {}],
  ['Overpass points', 'https://overpass-api.de/api/interpreter', { method: 'POST', body: new URLSearchParams({ data: M.pointsQuery('38.84,-120.17,38.87,-120.13') }) }],
]) {
  try {
    const r = await realFetch(url, { ...init, headers: { Origin: ORIGIN, 'User-Agent': UA }, signal: AbortSignal.timeout(60000) });
    console.log(`CORS ${name}: ${r.status} access-control-allow-origin=${r.headers.get('access-control-allow-origin')}`);
  } catch (e) { console.log(`CORS ${name}: failed ${e.message}`); }
}

const WATERS = [
  { name: 'Lake Aloha', lat: 38.853, lon: -120.153, acres: 600, state: 'CA', note: 'Desolation Wilderness' },
  { name: 'Lone Pine Lake', lat: 36.5645, lon: -118.2235, acres: 10, state: 'CA', note: 'Mt Whitney Zone' },
  { name: 'Thousand Island Lake', lat: 37.7213, lon: -119.1786, acres: 450, state: 'CA', note: 'Ansel Adams Wilderness' },
  { name: 'Green Lakes', lat: 44.107, lon: -121.733, acres: 85, state: 'OR', note: 'Three Sisters Wilderness' },
  { name: 'Jenks Lake', lat: 34.1645, lon: -116.8763, acres: 5, state: 'CA', note: 'Adventure Pass water' },
  { name: 'Donner Lake', lat: 39.3236, lon: -120.2669, acres: 843, state: 'CA', note: 'boat inspection' },
  { name: 'Wilson Reservoir', lat: 41.616, lon: -116.408, acres: 800, state: 'NV', note: 'NV, BLM' },
];
for (const w of WATERS) {
  const t = Date.now();
  console.log(`\n================ ${w.name} (${w.note})`);
  try {
    const d = await lookupAccess({ id: w.name, ...w, kind: 'lake' }, { force: true });
    const s = summarize({ lat: d.lat, lon: d.lon }, d.shoreKm, d.features, { land: d.land });
    console.log(`lookup ${Date.now() - t}ms failed=${JSON.stringify(d.failed)} land=${JSON.stringify(d.land?.parcels?.map(p => [p.manager, p.unit, p.designation]))}`);
    const r = M.rulesFor(w, { lat: d.lat, lon: d.lon, parcels: d.land?.parcels ?? [], state: w.state });
    console.log('PERMITS:', r.permits.map(p => `${p.name} [${p.id}] season=${JSON.stringify(M.permitSeason(p))}`).join(' | ') || 'none');
    console.log('PASSES:', r.passes.join(' | ') || 'none');
    console.log('BOAT:', r.boatHere ? 'here: ' : 'state: ', r.boat);
    const km = M.pointsKm(d), trailKm = M.trailheadKm(d, s);
    const t2 = Date.now();
    const pts = await M.nearbyPoints(d.lat, d.lon, km, { force: true, trailKm }).catch(e => ({ error: e.message, points: [] }));
    console.log(`POINTS (${Date.now() - t2}ms, ${km.toFixed(1)} km, trailheads ${trailKm.toFixed(1)} km, vehicle ${s.vehicle?.cls ?? 'none'}, hike ${d.hike?.km?.toFixed(1) ?? '-'} km${pts.error ? `, error ${pts.error}` : ''}): ${pts.points.length}`);
    for (const p of [...pts.points.filter(p => p.kind === 'trailhead').slice(0, 6), ...pts.points.filter(p => p.kind !== 'trailhead').slice(0, 4)]) console.log(`  ${p.kind} ${p.name ?? '-'} ${p.km}km [${p.facts.join('; ')}] <${p.source.url}>`);
    const g = M.accessGpxParts(w, s, d.hike, pts.points, CLASS_TEXT);
    console.log(`GPX: ${g.tracks.length} tracks, ${g.wpts.length} waypoints; first: ${g.tracks.slice(0, 3).map(x => `${x.name} (${x.points.length} pts)`).join(', ')}`);
  } catch (e) { console.log('lookup failed', e.message); }
  const fk = M.fishKm(w);
  const f = await M.fishSeen(w.lat, w.lon, fk, { force: true }).catch(e => ({ error: e.message }));
  console.log(`FISH (${fk} km): ${f.error ?? `${f.total} species: ${f.species.slice(0, 8).map(x => `${x.common ?? x.name} ${x.count}`).join(', ')}; recent ${f.recent.length}: ${f.recent.slice(0, 3).map(o => `${o.taxon?.common} ${o.date} ${o.photo ? 'photo' : ''} <${o.url}>`).join(' | ')}`}`);
}

// Every agency and booking page the cards link to.
const urls = new Set([...M.PERMITS.flatMap(p => [...p.book.map(b => b.url), p.source.url, p.also?.url]), ...Object.values(M.BOAT_SRC).map(x => x.url), M.TAHOE_SRC.url, ...Object.values(M.PASS_SRC).map(x => x.url)].filter(Boolean));
console.log('\n================ links');
for (const u of urls) {
  try { const r = await realFetch(u, { headers: { 'User-Agent': UA, Accept: 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(30000) }); const html = await r.text(); console.log(`${r.status} ${u}${r.url !== u ? ` -> ${r.url}` : ''} title="${(html.match(/<title[^>]*>([^<]*)/i)?.[1] ?? '').trim().slice(0, 90)}"`); }
  catch (e) { console.log(`ERR ${u} ${e.message}`); }
}
