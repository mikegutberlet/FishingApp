import { test } from 'node:test'; import assert from 'node:assert/strict';
import { nameKey, loadWaters, resolveWater, stubRecord } from '../corpus-lib.mjs';
const waters = await loadWaters();
test('nameKey folds case and punctuation', () => assert.equal(nameKey(' Twin Lake, Lower! '), 'twin lake lower'));
test('resolveWater finds by id and by exact name', () => {
  assert.equal(resolveWater('ca:18122', waters)[1].name, 'Convict Lake');
  assert.equal(String(resolveWater('ca:Convict Lake', waters)[1].id), '18122');
});
test('resolveWater rejects an ambiguous name with the candidates', () => assert.throws(() => resolveWater('ca:Silver Lake', waters), /matches 3 waters: ca:/));
test('resolveWater rejects a bad form and an unknown name', () => {
  assert.throws(() => resolveWater('convict', waters), /use st:id or st:Name/);
  assert.throws(() => resolveWater('ca:No Such Lake', waters), /try --find/);
});
test('stubRecord has the shape add-notes writes', () => assert.deepEqual(stubRecord('ca', { id: 1, name: 'X Lake' }), { id: '1', state: 'CA', name: 'X Lake', notes: [], manual: {} }));
