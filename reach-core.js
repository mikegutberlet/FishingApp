// Drive-up or hike-in: what a value in data/<st>/reach.json (scripts/build-state-reach.mjs) means. "d" a road a car
// can take reaches the shore, "r" only a dirt track does; a number is the far edge, in km, of the band the nearest
// road is in, and 9 is farther than 8 km. Kept free of the app so it can be tested on its own.

export const REACH = { drive: 'Drive-up', walk: 'Short walk', hike: 'Hike-in' };
// [the sentence for a card or a row, the short label for a narrow column]
const WORDS = {
  d: ['Drive-up: a road reaches the shore', 'Drive-up'],
  r: ['Drive-up on a dirt track: a car may not make it', 'Drive-up, dirt track'],
  0.8: ['Short walk: a road comes within about half a mile', 'Short walk, half a mile'],
  1.6: ['Short walk: a road comes within about a mile', 'Short walk, a mile'],
  3.2: ['Hike-in: the nearest road is 1 to 2 miles away', 'Hike-in, 1 to 2 miles'],
  4.8: ['Hike-in: the nearest road is 2 to 3 miles away', 'Hike-in, 2 to 3 miles'],
  8: ['Hike-in: the nearest road is 3 to 5 miles away', 'Hike-in, 3 to 5 miles'],
  9: ['Hike-in: the nearest road is more than 5 miles away', 'Hike-in, over 5 miles'],
};
const words = v => (typeof v === 'string' || typeof v === 'number') && Object.hasOwn(WORDS, v) ? WORDS[v] : null;

export const reachKind = v => !words(v) ? null : typeof v === 'string' ? 'drive' : v <= 1.6 ? 'walk' : 'hike';
export const reachText = v => words(v)?.[0] ?? null;
export const reachShort = v => words(v)?.[1] ?? null;
