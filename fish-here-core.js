// The fish on record for a water: reading data/<st>/species.json (the agencies' own lists, scripts/build-species.mjs)
// and data/<st>/sightings.json (other people's sighting records near it, scripts/build-sightings.mjs), and wording
// them for the "What's in here" list on the Stocking tab. No lookups here, so it runs in tests as it does in the app.
//   file  { sources: [{ label, url, licence? }], fish: { "<key>": [[name, how, source, note, count?], …] } }
//   how   "plan" the state plans to stock it this year, "lives" the state lists it as living there,
//         "caught" a catch is on the state's record books, "seen" someone recorded one near the water
//         (note is the latest year, count the number of records)

// A water's rows: its own key's and those of the waters it stands for (a lake and its stocked water), each fish once
// per way it is known (sightings: once per collection). → [{ name, how, note, source, n? }]
export function listedRows(file, keys) {
  const out = [];
  for (const key of new Set((keys ?? []).filter(Boolean))) for (const [name, how, src, note, n] of file?.fish?.[key] ?? []) {
    const source = file.sources?.[src] ?? null;
    if (out.some(r => r.name === name && r.how === how && (how !== 'seen' || r.source === source))) continue;
    out.push({ name, how, note: note ?? '', source, ...(n != null ? { n } : {}) });
  }
  return out;
}

// What a row counts as among a water's fish (water-facts.js): a planned plant is stocking. A sighting near a water
// isn't a fish to plan a trip on, so "seen" rows are listed but never feed the finder or the map's filters.
export const HOW_SOURCE = { plan: 'stocked', lives: 'lives', caught: 'caught' };

const ORDER = ['plan', 'lives', 'caught', 'seen'];
const upper = s => s.charAt(0).toUpperCase() + s.slice(1);
const TAG = {
  plan: note => `Stocking planned${note ? `: ${note}` : ''}`,
  lives: note => `Lives here${note ? ` (${note})` : ''}`,
  caught: note => note ? upper(note) : 'Caught here',
};
// Every collection's sightings of one fish as one tag: "Seen nearby (7 records, latest 2024)".
function seenTag(list) {
  const n = list.reduce((sum, r) => sum + (r.n ?? 1), 0), last = Math.max(0, ...list.map(r => +r.note || 0));
  return `Seen nearby (${n} record${n === 1 ? '' : 's'}${last ? `, latest ${last}` : ''})`;
}
// The list as lines, one per fish: stocked fish first, then fish that live there, then fish only on the record books,
// then fish someone only saw nearby.
// → { lines: [{ name, tags: ['Stocking planned: catchable, April to June', 'Lives here (introduced, wild)', 'Record 6 lb 12 oz, 1981'] }], sources: [{ label, url }] }
export function hereLines(rows) {
  const by = new Map();
  for (const r of rows ?? []) (by.get(r.name) ?? by.set(r.name, []).get(r.name)).push(r);
  const rank = list => Math.min(...list.map(r => ORDER.indexOf(r.how)).filter(i => i >= 0), ORDER.length);
  const lines = [...by].sort((a, b) => rank(a[1]) - rank(b[1])).map(([name, list]) => ({
    name, tags: ORDER.flatMap(how => { const of = list.filter(r => r.how === how); return how === 'seen' ? (of.length ? [seenTag(of)] : []) : of.map(r => TAG[how](r.note)); }),
  })).filter(l => l.tags.length);
  const sources = [];
  for (const r of rows ?? []) if (r.source?.label && !sources.some(s => s.label === r.source.label)) sources.push(r.source);
  return { lines, sources };
}
