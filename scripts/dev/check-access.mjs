// Dev check: runs the app's own Getting there lookup (access-lookup.js + access-rules.js) against the live services
// for a few known waters and prints what the tab would say. The sandbox can't reach the services; Actions can.
globalThis.location = { origin: 'https://example.invalid' };
globalThis.caches = { open: async () => ({ match: async () => null, put: async () => {}, delete: async () => {} }) };
const { lookupAccess } = await import('../../access-lookup.js');
const { summarize, CLASS_TEXT, fmtMi } = await import('../../access-rules.js');

const WATERS = [
  { name: 'Winnemucca Lake', lat: 38.672, lon: -120.0, acres: 60, note: 'Mokelumne Wilderness, hike-in from Woods Lake' },
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
  console.log('bike:', s.bikeTrails.map(x => x.name).join(' | '), ' no-bike:', s.noBikeTrails.map(x => x.name).join(' | '));
  console.log('moto:', [...s.motoTrails, ...s.ohvRoads].map(x => x.name).join(' | '), ' streetLegalOnly:', s.streetLegalOnly.map(x => x.name).join(' | '));
  console.log('seasonal:', s.seasonal.map(x => `${x.name} ${JSON.stringify(x.tags.dates)}`).join(' | '));
  console.log('gates:', s.lockedGates.map(x => `${x.tags.access} ${x.source.url}`).join(' | '));
  console.log('land:', JSON.stringify(d.land?.parcels?.map(p => [p.manager, p.unit, p.designation, p.access])));
  console.log('about:', d.about ? `${d.about.title}: ${d.about.extract.slice(0, 160)}` : null);
  console.log('roads:'); for (const r of s.roads.slice(0, 15)) console.log('  ' + line(r));
  console.log('trails:'); for (const r of s.trails.slice(0, 12)) console.log('  ' + line(r));
}
