// Live check of the drive-up or hike-in job's questions (scripts/build-state-reach.mjs) on a few well-known waters:
// asks Overpass the same counts, prints how long each step took and what each water came out as. Writes nothing.
// The sandbox can't reach Overpass, so this runs in GitHub Actions (check-reach.yml).
import { readFile } from 'node:fs/promises';
import { pointsFor, ringQuery, countsFrom, survey } from '../build-state-reach.mjs';
import { reachKind, reachText } from '../../reach-core.js';

const WANT = { // what anyone who has been there would say
  ca: { 'Donner Lake': 'drive', 'Caples Lake': 'drive', 'Boca Reservoir': 'drive', 'Lake Aloha': 'hike', 'Thousand Island Lake': 'hike', 'Gilmore Lake': 'hike', 'Loch Leven Lakes': null, 'Independence Lake': null },
  nv: { 'Lahontan Reservoir': 'drive', 'Marlette Lake': null, 'Angel Lake': 'drive', 'Liberty Lake': 'hike' },
  or: { 'Wallowa Lake': 'drive', 'Odell Lake': 'drive', 'Green Lakes': 'hike', 'Waldo Lake': 'drive', 'Mirror Lake': null },
};
const UA = { 'User-Agent': 'TackleBox-fishing-app (personal, github.com/mikegutberlet/FishingApp)' };
let bad = 0;
for (const [st, want] of Object.entries(WANT)) {
  const lakes = JSON.parse(await readFile(new URL(`../../data/${st}/lakes.json`, import.meta.url), 'utf8')).lakes;
  // The biggest water of each name, plus forty more from the list so a request is the size the job sends.
  const named = Object.keys(want).map(n => lakes.filter(l => l.name === n).sort((a, b) => b.acres - a.acres)[0]).filter(Boolean);
  const points = pointsFor([...named, ...lakes.filter(l => !named.includes(l)).slice(100, 140)], []);
  const ask = async (pts, kind, km) => {
    const q = ringQuery(pts, kind, km), t = Date.now();
    const r = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', headers: UA, body: new URLSearchParams({ data: q }), signal: AbortSignal.timeout(280e3) });
    const text = await r.text();
    console.log(`${st}: ${kind} within ${km} km, ${pts.length} waters, ${q.length} chars: HTTP ${r.status}, ${text.length} bytes, ${((Date.now() - t) / 1000).toFixed(1)} s`);
    if (!r.ok) { console.log(text.slice(0, 600)); throw new Error(`HTTP ${r.status}`); }
    const json = JSON.parse(text);
    if (kind === 'car') console.log('  first element:', JSON.stringify(json.elements?.[0]), json.remark ? `remark: ${json.remark}` : '');
    await new Promise(res => setTimeout(res, 3000));
    return countsFrom(json, pts.length);
  };
  const got = await survey(points, ask);
  for (const p of points.slice(0, named.length)) {
    const v = got.get(p.key), ok = want[p.name] == null || reachKind(v) === want[p.name];
    if (!ok) bad++;
    console.log(`${ok ? 'ok  ' : 'BAD '} ${p.name} (${p.acres} ac): ${JSON.stringify(v)} ${reachText(v)}${want[p.name] ? ` (expected ${want[p.name]})` : ''}`);
  }
  const tally = {};
  for (const v of got.values()) tally[v] = (tally[v] ?? 0) + 1;
  console.log(`${st}: all ${points.length}:`, JSON.stringify(tally));
}
if (bad) { console.log(`${bad} water(s) came out wrong`); process.exit(1); }
