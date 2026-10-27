// Runs the app's own trip-gap lookups (roads.js, supplies.js) against the live sources from a runner, for a few waters.
// Prints what a phone would show. Writes nothing.
import { roadsNear } from '../../roads.js';
import { lookupSupplies } from '../../supplies.js';
const WATERS = [
  { name: 'Lake Oroville', lat: 39.55, lon: -121.43 },
  { name: 'Lake Tahoe (South)', lat: 38.95, lon: -120.0 },
  { name: 'Convict Lake', lat: 37.59, lon: -118.85 },
  { name: 'Pyramid Lake NV', lat: 40.0, lon: -119.55 },
  { name: 'Detroit Lake OR', lat: 44.71, lon: -122.18 },
];
for (const w of WATERS) {
  console.log(`\n=== ${w.name}`);
  try {
    const r = await roadsNear(w);
    console.log(`roads: ${r.chains.length} routes with chain points, ${r.chains.filter(c => c.worst).length} with controls on; ${r.closures.length} full closures; passes ${r.passes.map(p => p.name).join(', ') || 'none'}; failed ${r.failed.join(', ') || 'none'}`);
    for (const c of r.chains.slice(0, 5)) console.log(`  ${c.route} worst R${c.worst} nearest ${c.km.toFixed(0)} km: ${c.points.slice(0, 2).map(p => `${p.name} [${p.code}] ${p.text.slice(0, 60)}`).join(' | ')}`);
    for (const c of r.closures.slice(0, 5)) console.log(`  CLOSED ${c.route} ${c.from} -> ${c.to} ${c.km.toFixed(0)} km ${c.start} .. ${c.end ?? 'indef'} ${c.work} ${c.duration}`);
  } catch (e) { console.log('roads FAILED', e.message); }
  try {
    const s = await lookupSupplies(w);
    for (const [k, list] of Object.entries(s.places)) console.log(`  ${k}: ${list.slice(0, 3).map(p => `${p.name} (${p.town}) ${p.km.toFixed(1)} km ${p.dir}`).join('; ') || 'none'}`);
  } catch (e) { console.log('supplies FAILED', e.message); }
  await new Promise(r => setTimeout(r, 3000));
}
