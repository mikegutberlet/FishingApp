import { test } from 'node:test'; import assert from 'node:assert/strict';
import { loadWaters } from '../corpus-lib.mjs';
import { termsFor, buildIndex, matchWaters } from '../ingest/match.mjs';
const waters = await loadWaters();
test('termsFor splits qualifiers and parentheticals', () => {
  assert.deepEqual(termsFor('Twin Lake Lower, Bridgeport'), ['twin lake lower bridgeport', 'twin lake lower', 'lower twin lake']);
  assert.deepEqual(termsFor('Blue Lake Upper'), ['blue lake upper', 'upper blue lake']);
  assert.deepEqual(termsFor('Trinity Lake (Clair Engle Lake)'), ['trinity lake', 'clair engle lake']);
  assert.deepEqual(termsFor('Salmon Lake, Upper'), ['salmon lake upper', 'upper salmon lake']);
  assert.ok(termsFor('Lake Spaulding Reservoir').includes('lake spaulding res'));
  assert.deepEqual(termsFor('Upper Lake'), []);        // only type words
});
test('a name inside a sentence matches once, by word boundary', () => {
  const idx = buildIndex(waters);
  const hits = matchWaters('We fished Convict Lake at dawn; Convict Lake was glassy. Convictville is not a lake.', idx);
  assert.deepEqual(hits.map(h => `${h.st}:${h.id}`), ['ca:18122']);
  assert.equal(hits[0].ambiguous, false);
});
test('ambiguous names file on every candidate and are flagged', () => {
  const hits = matchWaters('Silver Lake holds browns.', buildIndex(waters));
  assert.equal(hits.length, 3); assert.ok(hits.every(h => h.st === 'ca' && h.ambiguous));
});
test('a states filter settles a cross-state name', () => {
  const hits = matchWaters('Blue Lake is deep.', buildIndex(waters), { states: ['or'] });
  assert.ok(hits.length >= 1 && hits.every(h => h.st === 'or'));
});
test('aliases add a one-word term and null blocks a term', () => {
  const idx = buildIndex(waters, { Convict: 'ca:18122', 'Silver Lake': null });
  assert.deepEqual(matchWaters('Convict was slow.', idx).map(h => `${h.st}:${h.id}`), ['ca:18122']);
  assert.deepEqual(matchWaters('Silver Lake was slow.', idx), []);
});
