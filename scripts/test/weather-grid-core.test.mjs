import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cellOf, longestGood, gradeOf, wxPass, pickCells, readMulti } from '../../weather-grid-core.js';
import { DEFAULTS, clean, active, off, needsWeather } from '../../water-filter-core.js';

test('a square of a tenth of a degree, named by its center', () => {
  assert.deepEqual(cellOf(39.33, -120.18), { id: '39.3,-120.2', lat: 39.3, lon: -120.2 });
  assert.equal(cellOf(39.349, -120.151).id, '39.3,-120.2');
  assert.equal(cellOf(39.351, -120.149).id, '39.4,-120.1');
  assert.equal(cellOf(0.01, -0.01).id, '0.0,0.0'); // never "-0.0"
});
const run = s => [...s].map(c => ({ tone: c === 'g' ? 'good' : c === 'w' ? 'warn' : 'bad' }));
test('a day is graded by its longest run of good hours', () => {
  assert.equal(longestGood(run('ggwgggggb')), 5);
  assert.equal(gradeOf(run('gggggg')), 'good'); assert.equal(gradeOf(run('wggggggw')), 'good');
  assert.equal(gradeOf(run('gggggwggg')), 'fair'); assert.equal(gradeOf(run('gggbb')), 'fair');
  assert.equal(gradeOf(run('ggwggbgg')), 'poor'); assert.equal(gradeOf([]), 'poor');
  // late in the day there are fewer hours left to ask for: all of them good is a good rest of the day
  assert.equal(gradeOf(run('gggg')), 'good'); assert.equal(gradeOf(run('gg')), 'good'); assert.equal(gradeOf(run('ggb')), 'poor'); assert.equal(gradeOf(run('gggb')), 'fair');
});
test('what the filter keeps', () => {
  assert.ok(wxPass('good', 'good')); assert.ok(!wxPass('fair', 'good')); assert.ok(!wxPass('poor', 'good'));
  assert.ok(wxPass('fair', 'fair')); assert.ok(wxPass('good', 'fair')); assert.ok(!wxPass('poor', 'fair'));
  assert.ok(wxPass(null, 'good'), 'no forecast: kept'); assert.ok(wxPass('poor', ''), 'filter off: kept');
});
test('which squares to ask for: each once, nearest first, capped, skipping the ones in hand', () => {
  const pts = [{ lat: 40.02, lon: -120 }, { lat: 39.31, lon: -120.21 }, { lat: 39.33, lon: -120.18 }, { lat: 39.52, lon: -120.2 }];
  const all = pickCells(pts, { lat: 39.3, lon: -120.2 }, 10, new Set());
  assert.deepEqual(all.cells.map(c => c.id), ['39.3,-120.2', '39.5,-120.2', '40.0,-120.0']); assert.equal(all.beyond, 0);
  const capped = pickCells(pts, { lat: 39.3, lon: -120.2 }, 2, new Set());
  assert.deepEqual(capped.cells.map(c => c.id), ['39.3,-120.2', '39.5,-120.2']); assert.equal(capped.beyond, 1);
  assert.deepEqual(pickCells(pts, { lat: 39.3, lon: -120.2 }, 2, new Set(['39.3,-120.2'])).cells.map(c => c.id), ['39.5,-120.2', '40.0,-120.0']);
  assert.deepEqual(pickCells(pts, null, 10, new Set()).cells.map(c => c.id), ['40.0,-120.0', '39.3,-120.2', '39.5,-120.2'], 'no reference point: as given');
});
test("the service's answer for several places", () => {
  const w = { hourly: { time: ['2026-11-12T00:00'] }, daily: { time: ['2026-11-12'] } };
  assert.deepEqual(readMulti([w, w], 2), [w, w]);
  assert.deepEqual(readMulti(w, 1), [w]); assert.deepEqual(readMulti([w], 1), [w]);
  assert.equal(readMulti(w, 2), null, 'one forecast for two places'); assert.equal(readMulti([w], 2), null);
  assert.equal(readMulti([w, { error: true, reason: 'x' }], 2), null); assert.equal(readMulti(null, 1), null); assert.equal(readMulti({ error: true }, 1), null);
});
test('weather settings: defaults, clean-up, chips', () => {
  assert.equal(DEFAULTS.wx, ''); assert.equal(DEFAULTS.day, 0);
  assert.deepEqual([clean({ wx: 'good', day: 3 }).wx, clean({ wx: 'good', day: 3 }).day], ['good', 3]);
  assert.deepEqual([clean({ wx: 'sunny', day: 9 }).wx, clean({ wx: 'sunny', day: 9 }).day], ['', 0]);
  assert.equal(clean({ day: 2.5 }).day, 0); assert.equal(clean({ day: -1 }).day, 0); assert.equal(clean({ day: '3' }).day, 0);
  assert.equal(active({ ...DEFAULTS, wx: 'fair' }).at(-1), 'wx'); assert.ok(!active(DEFAULTS).includes('wx'));
  assert.deepEqual(off('wx'), { wx: '' }); assert.deepEqual(off('type'), { type: '' });
  assert.ok(needsWeather({ ...DEFAULTS, wx: 'good' })); assert.ok(!needsWeather(DEFAULTS));
});
