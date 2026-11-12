import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankRows } from '../../map-results-core.js';

const ref = { lat: 39.33, lon: -120.18 };
const pin = (name, dLat, extra = {}) => ({ key: name, name, lat: 39.33 + dLat, lon: -120.18, ...extra });

test('nearest first, with the distance in km', () => {
  const { rows, total } = rankRows([pin('Far', 0.5), pin('Near', 0.01), pin('Mid', 0.1)], ref);
  assert.deepEqual(rows.map(r => r.e.name), ['Near', 'Mid', 'Far']);
  assert.equal(total, 3);
  assert.ok(Math.abs(rows[1].km - 11.12) < 0.1);
});
test('waters at the same distance go by name', () => {
  assert.deepEqual(rankRows([pin('Zeta', 0.1), pin('Alpha', 0.1)], ref).rows.map(r => r.e.name), ['Alpha', 'Zeta']);
});
test('the limit cuts the rows and the total still counts every water', () => {
  const pins = Array.from({ length: 250 }, (_, i) => pin(`W${i}`, i / 1000));
  const d = rankRows(pins, ref);
  assert.equal(d.rows.length, 100); assert.equal(d.total, 250); assert.equal(d.rows[99].e.name, 'W99');
  assert.equal(rankRows(pins, ref, { limit: 5 }).rows.length, 5);
});
test('no place to measure from: by name, no distance', () => {
  const { rows } = rankRows([pin('B', 0.5), pin('A', 0.9)], null);
  assert.deepEqual(rows.map(r => [r.e.name, r.km]), [['A', null], ['B', null]]);
});
test('best bet first: higher scores lead, nearest among equals, waters with no score last', () => {
  const score = e => ({ Near: 4, Mid: 8, Far: 8, None: null })[e.name];
  const { rows } = rankRows([pin('None', 0.001), pin('Near', 0.01), pin('Far', 0.5), pin('Mid', 0.1)], ref, { sort: 'bet', score });
  assert.deepEqual(rows.map(r => [r.e.name, r.score]), [['Mid', 8], ['Far', 8], ['Near', 4], ['None', null]]);
});
test('a score is carried on the row even when sorting by distance', () => {
  assert.deepEqual(rankRows([pin('A', 0.1)], ref, { score: () => 6 }).rows[0].score, 6);
});
