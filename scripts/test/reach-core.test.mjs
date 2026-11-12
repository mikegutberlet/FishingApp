import test from 'node:test';
import assert from 'node:assert/strict';
import { REACH, reachKind, reachText, reachShort } from '../../reach-core.js';

test('reachKind: a road at the shore is a drive, up to a mile a short walk, beyond a hike', () => {
  assert.deepEqual(['d', 'r', 0.8, 1.6, 3.2, 4.8, 8, 9].map(reachKind), ['drive', 'drive', 'walk', 'walk', 'hike', 'hike', 'hike', 'hike']);
  assert.deepEqual([undefined, null, '', 'x', 0, -1, NaN].map(reachKind), Array(7).fill(null));
  assert.deepEqual(Object.keys(REACH), ['drive', 'walk', 'hike']);
});

test('reachText and reachShort: one sentence and one short label for every value, nothing for junk', () => {
  assert.equal(reachText('d'), 'Drive-up: a road reaches the shore');
  assert.equal(reachText('r'), 'Drive-up on a dirt track: a car may not make it');
  assert.equal(reachText(0.8), 'Short walk: a road comes within about half a mile');
  assert.equal(reachText(1.6), 'Short walk: a road comes within about a mile');
  assert.equal(reachText(3.2), 'Hike-in: the nearest road is 1 to 2 miles away');
  assert.equal(reachText(4.8), 'Hike-in: the nearest road is 2 to 3 miles away');
  assert.equal(reachText(8), 'Hike-in: the nearest road is 3 to 5 miles away');
  assert.equal(reachText(9), 'Hike-in: the nearest road is more than 5 miles away');
  assert.deepEqual(['d', 'r', 0.8, 1.6, 3.2, 4.8, 8, 9].map(reachShort), ['Drive-up', 'Drive-up, dirt track', 'Short walk, half a mile', 'Short walk, a mile', 'Hike-in, 1 to 2 miles', 'Hike-in, 2 to 3 miles', 'Hike-in, 3 to 5 miles', 'Hike-in, over 5 miles']);
  assert.equal(reachKind('3.2'), null, 'a band written as text is junk, not a drive');
  for (const v of [undefined, null, 'x', 2, 0, '3.2', '9']) { assert.equal(reachText(v), null); assert.equal(reachShort(v), null); }
});
