// Dev check: runs the app's own Getting there lookup (access-lookup.js + access-rules.js) against the live services
// for a few known waters and prints what the tab would say. The sandbox can't reach the services; Actions can.
globalThis.location = { origin: 'https://example.invalid' };
globalThis.caches = { open: async () => ({ match: async () => null, put: async () => {}, delete: async () => {} }) };
// Behave like a browser: send a browser-style User-Agent and log why a request failed.
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, init = {}) => {
  try { return await realFetch(u, { ...init, headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) TackleBox-check', Referer: 'https://mikegutberlet.github.io/FishingApp/', ...(init.headers ?? {}) } }); }
  catch (e) { console.warn(`fetch ${String(u).slice(0, 80)} failed: ${e.message} ${e.cause?.code ?? ''} ${e.cause?.message ?? ''}`); throw e; }
};
const { lookupAccess } = await import('../../access-lookup.js');
const { summarize, CLASS_TEXT, fmtMi, snowAt, fmtMins, fmtFt } = await import('../../access-rules.js');
const { lookupNow, FOREST_ALERTS } = await import('../../access-now.js');

const WATERS = [
  { name: 'Winnemucca Lake', lat: 38.672, lon: -120.0, acres: 60, elevationFt: 8960, note: 'Mokelumne Wilderness, hike-in from Woods Lake' },
  { name: 'Caples Lake', lat: 38.709, lon: -120.041, acres: 600, note: 'Hwy 88, paved' },
  { name: 'Anthony Lake', lat: 44.962, lon: -118.231, acres: 22, note: 'OR, paved forest road' },
  { name: 'Rye Patch Reservoir', lat: 40.47, lon: -118.30, acres: 11000, note: 'NV, BLM/USBR, state rec area' },
  { name: 'Wilson Reservoir', lat: 41.616, lon: -116.408, acres: 800, note: 'NV, BLM, dirt roads' },
  { name: 'Lake Tahoe (spot: Sand Harbor)', lat: 39.0968, lon: -120.0324, acres: 122975, spot: { lat: 39.1985, lon: -119.9306, label: 'Sand Harbor' } },
];
const line = f => `${f.name ?? '(unnamed)'} [${f.cls ?? ''}] ${f.shoreKm.toFixed(2)}km ${JSON.stringify(Object.fromEntries(Object.entries(f.tags).filter(([k, v]) => v != null && !(typeof v === 'object' && !Object.keys(v).length))))} <${f.source.url}>`;
for (const w of WATERS) {
  const t = Date.now();
  let partialAt = null;
  const d = await lookupAccess({ id: w.name, ...w, kind: 'lake' }, { spot: w.spot ?? null, force: true, onPartial: () => { partialAt = Date.now() - t; } });
  const s = summarize({ lat: d.lat, lon: d.lon }, d.shoreKm, d.features, { land: d.land });
  console.log(`\n================ ${w.name} (${w.note ?? ''}) ${Date.now() - t}ms, partial at ${partialAt}ms, failed=${JSON.stringify(d.failed)}`);
  console.log('features by source:', JSON.stringify(d.features.reduce((m, f) => (m[f.source.label.split(' ·')[0]] = (m[f.source.label.split(' ·')[0]] ?? 0) + 1, m), {})));
  console.log('VERDICT:', s.vehicle ? `${CLASS_TEXT[s.vehicle.cls].label} via ${s.vehicle.road.name} hike ${fmtMi(s.vehicle.hikeKm)} <${s.vehicle.road.source.url}>` : s.nearestUnknown ? `unknown road ${s.nearestUnknown.name}` : 'no road');
  console.log('hike:', s.hikeTrails.map(x => x.name).join(' | '));
  console.log('bike:', s.bikeTrails.map(x => `${x.name} <${x.source.url}>`).join(' | '), ' no-bike:', s.noBikeTrails.map(x => x.name).join(' | '));
  console.log('moto:', [...s.motoTrails, ...s.ohvRoads].map(x => x.name).join(' | '), ' streetLegalOnly:', s.streetLegalOnly.map(x => x.name).join(' | '));
  console.log('seasonal:', s.seasonal.map(x => `${x.name} ${JSON.stringify(x.tags.dates)}`).join(' | '));
  console.log('gates:', s.lockedGates.map(x => `${x.tags.access} ${x.source.url}`).join(' | '));
  console.log('land:', JSON.stringify(d.land?.parcels?.map(p => [p.manager, p.unit, p.designation, p.access])));
  console.log('about:', d.about ? `${d.about.title}: ${d.about.extract.slice(0, 160)}` : null);
  console.log('roads:'); for (const r of s.roads.slice(0, 8)) console.log('  ' + line(r));
  console.log('trails:'); for (const r of s.trails.slice(0, 6)) console.log('  ' + line(r));
  const h = d.hike;
  console.log('WALK:', h ? `${h.crow ? 'straight line' : 'route'} ${fmtMi(h.km)} from ${h.start.road} (${h.start.lat},${h.start.lon}) via ${h.trails.map(t => t.name).join(' > ')}${h.stats ? `; ${fmtFt(h.stats.upM)} up ${fmtFt(h.stats.downM)} down, ${fmtMins(h.stats.minIn)} in / ${fmtMins(h.stats.minOut)} out, ${fmtFt(h.stats.minM)}-${fmtFt(h.stats.maxM)}` : h.profileFailed ? '; elevation failed' : ''}` : 'none');
  if (h?.crow) {
    // Why no mapped way in: how close each trail near the shore comes to a road you can drive.
    const { distKmToLine } = await import('../../access-rules.js');
    const drivable = s.roads.filter(r => !['closed', 'unknown'].includes(r.cls) && !r.tags.noStop);
    for (const t of s.trails.filter(t => t.shoreKm < 0.3).slice(0, 8)) {
      const ends = t.paths.flatMap(p => [p[0], p.at(-1)]);
      const d = Math.min(...ends.flatMap(e => drivable.flatMap(r => r.paths.map(p => distKmToLine(e[0], e[1], p)))));
      const near = Math.min(...t.paths.flat().flatMap(e => s.trails.filter(o => o !== t).flatMap(o => o.paths.map(p => distKmToLine(e[0], e[1], p)))));
      console.log(`  trail ${t.name} ${t.source.label}: ${t.paths.length} paths, ${t.paths.flat().length} pts, end->drivable ${(d * 1000).toFixed(0)} m, nearest other trail ${(near * 1000).toFixed(0)} m`);
    }
  }
  console.log('masts:', s.masts.map(m => `${fmtMi(m.distKm)} ${m.tags.operator ?? '?'} <${m.source.url}>`).join(' | ') || 'none');
  const t2 = Date.now();
  const n = await lookupNow(d.lat, d.lon, { elevFt: w.spot ? null : w.elevationFt ?? null });
  const sn = snowAt(n);
  console.log(`TODAY (${Date.now() - t2}ms, failed=${JSON.stringify(n.failed)}): elev ${n.elevFt} ft; snow level ${sn?.level} depth ${sn?.depthIn?.toFixed(1)} in from ${sn?.station ? `${sn.station.name} ${sn.station.elevFt}ft ${sn.station.distKm.toFixed(1)}km <${sn.station.source.url}>` : 'model'}; next3 ${sn?.next3In?.toFixed(1)} in, week ${sn?.weekIn?.toFixed(1)} in; model depth ${n.model?.depthIn?.toFixed(1)}`);
  console.log('  stations:', (n.station ?? []).map(x => `${x.name} ${x.elevFt}ft ${x.distKm.toFixed(1)}km ${x.depthIn}in (${x.date}) wk ${x.weekAgoIn}`).join(' | '));
  console.log('  fires:', (n.fires ?? []).map(f => `${f.name}${f.rx ? ' RX' : ''} ${f.distKm.toFixed(1)}km ${f.inside ? 'INSIDE ' : ''}${Math.round(f.acres ?? 0)}ac ${f.contained}% upd ${f.updated?.slice(0, 10)} ${f.inciweb ?? ''} <${f.source.url}>`).join(' | ') || 'none');
}

// Each forest's alerts page the Today card links to: does it exist?
console.log('\n================ Forest alerts pages');
const tried = new Set();
for (const [k, u] of [...Object.entries(FOREST_ALERTS), ...['r06/crgnsa', 'r06/columbiagorge', 'r04/htnf', 'r04/humboldttoiyabe'].map(x => [x, `https://www.fs.usda.gov/${x}/alerts`])]) {
  if (tried.has(u)) continue;
  tried.add(u);
  const r = await fetch(u, { method: 'GET', redirect: 'follow' }).catch(e => ({ status: e.message }));
  console.log(`${r.status} ${k} ${u}${r.url && r.url !== u ? ` -> ${r.url}` : ''}`);
}
