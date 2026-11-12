// The fish the agencies' own lists name for a water: reading data/<st>/species.json (scripts/build-species.mjs) and
// wording it for the "What's in here" list on the Stocking tab. No lookups here, so it runs in tests as it does in
// the app.
//   file  { sources: [{ label, url }], fish: { "<key>": [[name, how, source, note], …] } }
//   how   "plan" the state plans to stock it this year, "lives" the state lists it as living there,
//         "caught" a catch is on the state's record books

// A water's rows: its own key's and those of the waters it stands for (a lake and its stocked water), each fish once
// per way it is known. → [{ name, how, note, source }]
export function listedRows(file, keys) {
  const out = [];
  for (const key of new Set((keys ?? []).filter(Boolean))) for (const [name, how, src, note] of file?.fish?.[key] ?? []) {
    if (!out.some(r => r.name === name && r.how === how)) out.push({ name, how, note: note ?? '', source: file.sources?.[src] ?? null });
  }
  return out;
}

// What a row counts as among a water's fish (water-facts.js): a planned plant is stocking.
export const HOW_SOURCE = { plan: 'stocked', lives: 'lives', caught: 'caught' };

const ORDER = ['plan', 'lives', 'caught'];
const upper = s => s.charAt(0).toUpperCase() + s.slice(1);
const TAG = {
  plan: note => `Stocking planned${note ? `: ${note}` : ''}`,
  lives: note => `Lives here${note ? ` (${note})` : ''}`,
  caught: note => note ? upper(note) : 'Caught here',
};
// The list as lines, one per fish: stocked fish first, then fish that live there, then fish only on the record books.
// → { lines: [{ name, tags: ['Stocking planned: catchable, April to June', 'Lives here (introduced, wild)', 'Record 6 lb 12 oz, 1981'] }], sources: [{ label, url }] }
export function hereLines(rows) {
  const by = new Map();
  for (const r of rows ?? []) (by.get(r.name) ?? by.set(r.name, []).get(r.name)).push(r);
  const rank = list => Math.min(...list.map(r => ORDER.indexOf(r.how)).filter(i => i >= 0), ORDER.length);
  const lines = [...by].sort((a, b) => rank(a[1]) - rank(b[1])).map(([name, list]) => ({
    name, tags: ORDER.flatMap(how => list.filter(r => r.how === how).map(r => TAG[how](r.note))),
  })).filter(l => l.tags.length);
  const sources = [];
  for (const r of rows ?? []) if (r.source?.label && !sources.some(s => s.label === r.source.label)) sources.push(r.source);
  return { lines, sources };
}
