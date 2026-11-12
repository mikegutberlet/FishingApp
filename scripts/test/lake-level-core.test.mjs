import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trendOf, levelText } from '../../lake-level-core.js';

test('trend from a week of elevation, at the half foot edges', () => {
  assert.equal(trendOf({ ft: 0.5 }), 'rising'); assert.equal(trendOf({ ft: 0.49 }), 'steady'); assert.equal(trendOf({ ft: 0 }), 'steady');
  assert.equal(trendOf({ ft: -0.49 }), 'steady'); assert.equal(trendOf({ ft: -0.5 }), 'falling'); assert.equal(trendOf({ ft: 12 }), 'rising');
});
test('a gauge with storage only: one percent either way', () => {
  assert.equal(trendOf({ ft: null, pct: 1 }), 'rising'); assert.equal(trendOf({ pct: 0.99 }), 'steady'); assert.equal(trendOf({ pct: -1 }), 'falling');
});
test('elevation wins over storage, and nothing known is no trend', () => {
  assert.equal(trendOf({ ft: 0.1, pct: 5 }), 'steady');
  assert.equal(trendOf({ ft: null, pct: null }), null); assert.equal(trendOf({}), null); assert.equal(trendOf({ ft: NaN }), null);
});
test('the line a card shows', () => {
  assert.equal(levelText({ trend: 'rising', ft: 1.23, gauge: 'SHASTA' }), 'Lake level rising: +1.2 ft in a week (gauge: SHASTA)');
  assert.equal(levelText({ trend: 'falling', ft: -3, gauge: 'Lake Abert' }), 'Lake level falling: -3.0 ft in a week (gauge: Lake Abert)');
  assert.equal(levelText({ trend: 'steady', ft: 0.1, gauge: 'X' }), 'Lake level steady (gauge: X)');
  assert.equal(levelText({ trend: 'falling', ft: null, pct: -3.4, gauge: 'X' }), 'Lake level falling: 3% less water in a week (gauge: X)');
  assert.equal(levelText({ trend: 'rising', pct: 2, gauge: 'X' }), 'Lake level rising: 2% more water in a week (gauge: X)');
});
