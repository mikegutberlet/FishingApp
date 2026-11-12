import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, clean, sizeOf, elevOf, isStreamType, kmBetween, quickPass, active, needsFacts, needsWeather, off } from '../../water-filter-core.js';

const P = over => ({ ...DEFAULTS, miles: 0, ...over });
const ctx = { from: { lat: 39.33, lon: -120.18 }, iced: () => false };
const lake = over => ({ lat: 39.33, lon: -120.18, type: 'Lake', acres: 100, elevationFt: 6000, saved: null, ...over });

test('size buckets at their edges', () => {
  assert.equal(sizeOf(9.9), 'pond'); assert.equal(sizeOf(10), 'small'); assert.equal(sizeOf(500), 'small'); assert.equal(sizeOf(500.1), 'big');
  assert.equal(sizeOf(null), null); assert.equal(sizeOf(undefined), null); assert.equal(sizeOf('x'), null); assert.equal(sizeOf(0), null);
});
test('elevation buckets at their edges, and below sea level is low', () => {
  assert.equal(elevOf(3999), 'low'); assert.equal(elevOf(4000), 'mid'); assert.equal(elevOf(7000), 'mid'); assert.equal(elevOf(7001), 'high');
  assert.equal(elevOf(-236), 'low'); assert.equal(elevOf(0), 'low'); assert.equal(elevOf(null), null); assert.equal(elevOf(undefined), null); assert.equal(elevOf(''), null);
});
test('stream types', () => { for (const t of ['River', 'Stream', 'Creek']) assert.ok(isStreamType(t)); for (const t of ['Lake', 'Reservoir', 'Pond', '', undefined]) assert.ok(!isStreamType(t)); });
test('kmBetween: one degree of latitude is about 111 km', () => assert.ok(Math.abs(kmBetween({ lat: 39, lon: -120 }, { lat: 40, lon: -120 }) - 111.2) < 0.5));
test('clean keeps known keys of the right type and defaults the rest', () => {
  const c = clean({ miles: '25', fish: 'trout', bogus: 1, stocked: true, size: ['pond'], from: 'me' });
  assert.deepEqual(c, { ...DEFAULTS, stocked: true, size: ['pond'], from: 'me' });
  assert.deepEqual(clean(null), DEFAULTS); assert.deepEqual(clean({ fish: ['trout'], miles: 50 }), { ...DEFAULTS, fish: ['trout'] });
  assert.notEqual(clean(null).fish, DEFAULTS.fish, 'a fresh copy, so callers can change it');
});
test('distance: inside and outside a 10 mile ring, skipped with no origin or Any', () => {
  const far = lake({ lat: 39.33 + 0.2 }); // about 22 km north
  assert.ok(quickPass(lake({ lat: 39.33 + 0.1 }), P({ miles: 10 }), ctx).ok);
  assert.ok(!quickPass(far, P({ miles: 10 }), ctx).ok);
  assert.ok(quickPass(far, P({ miles: 10 }), { ...ctx, from: null }).ok);
  assert.ok(quickPass(far, P({ miles: 0 }), ctx).ok);
});
test('lake or stream', () => {
  assert.ok(quickPass(lake(), P({ type: 'lake' }), ctx).ok); assert.ok(!quickPass(lake({ type: 'River' }), P({ type: 'lake' }), ctx).ok);
  assert.ok(quickPass(lake({ type: 'Stream' }), P({ type: 'stream' }), ctx).ok); assert.ok(!quickPass(lake({ type: 'Reservoir' }), P({ type: 'stream' }), ctx).ok);
});
test('size and elevation: any ticked bucket passes, a water with none on record is left out as unknown', () => {
  assert.ok(quickPass(lake({ acres: 5 }), P({ size: ['pond', 'big'] }), ctx).ok);
  assert.deepEqual(quickPass(lake({ acres: 100 }), P({ size: ['pond', 'big'] }), ctx), { ok: false });
  assert.deepEqual(quickPass(lake({ acres: null }), P({ size: ['pond'] }), ctx), { ok: false, unknown: 'size' });
  assert.ok(quickPass(lake({ elevationFt: 9000 }), P({ elev: ['high'] }), ctx).ok);
  assert.deepEqual(quickPass(lake({ elevationFt: undefined }), P({ elev: ['high'] }), ctx), { ok: false, unknown: 'elev' });
});
test('saved and ice-free', () => {
  assert.ok(!quickPass(lake(), P({ saved: true }), ctx).ok); assert.ok(quickPass(lake({ saved: { id: 'a' } }), P({ saved: true }), ctx).ok);
  assert.ok(!quickPass(lake(), P({ iceFree: true }), { ...ctx, iced: () => true }).ok); assert.ok(quickPass(lake(), P({ iceFree: true }), ctx).ok);
  assert.ok(quickPass(lake(), P(), { ...ctx, iced: () => true }).ok, 'ice only matters when the filter is on');
});
test('which filters are on, and whether they need the lookups', () => {
  assert.deepEqual(active(DEFAULTS), ['miles', 'noAlgae']);
  assert.deepEqual(active({ ...DEFAULTS, miles: 0, noAlgae: false }), []);
  assert.deepEqual(active({ ...DEFAULTS, fish: ['trout'], size: ['pond'], iceFree: true, type: 'lake' }), ['fish', 'miles', 'noAlgae', 'type', 'size', 'iceFree']);
  assert.ok(needsFacts(DEFAULTS)); assert.ok(!needsFacts({ ...DEFAULTS, noAlgae: false })); assert.ok(needsFacts({ ...DEFAULTS, noAlgae: false, fish: ['trout'] }));
});
test('switching one filter back to "everything"', () => {
  const all = { ...DEFAULTS, fish: ['trout'], access: ['ramp'], stocked: true, mine: true, saved: true, type: 'stream', size: ['pond'], elev: ['low'], iceFree: true };
  assert.deepEqual(active(all), ['fish', 'access', 'miles', 'stocked', 'mine', 'saved', 'noAlgae', 'type', 'size', 'elev', 'iceFree']);
  for (const k of active(all)) assert.deepEqual(active(clean({ ...all, ...off(k) })), active(all).filter(x => x !== k), k);
  assert.deepEqual(off('miles'), { miles: 0 }); assert.deepEqual(off('noAlgae'), { noAlgae: false });
});
test('lake level: a list of trends, known words only, needs the lookups, one chip', () => {
  assert.deepEqual(DEFAULTS.level, []);
  assert.deepEqual(clean({ level: ['rising', 'sideways', 'falling'] }).level, ['rising', 'falling']);
  assert.deepEqual(clean({ level: 'rising' }).level, []);
  const P = { ...DEFAULTS, miles: 0, noAlgae: false, elev: ['low'], iceFree: true, level: ['steady'] };
  assert.deepEqual(active(P), ['elev', 'level', 'iceFree']);
  assert.ok(needsFacts(P)); assert.deepEqual(off('level'), { level: [] });
});
test('best-bet score: a switch, not a filter; it needs the forecasts', () => {
  assert.equal(DEFAULTS.score, false); assert.equal(clean({ score: 'yes' }).score, false); assert.equal(clean({ score: true }).score, true);
  assert.ok(needsWeather({ ...DEFAULTS, score: true })); assert.ok(needsWeather({ ...DEFAULTS, wx: 'good' })); assert.ok(!needsWeather(DEFAULTS));
  assert.deepEqual(active({ ...DEFAULTS, miles: 0, noAlgae: false, score: true }), []);
});

test('drive-up or hike-in: a list of kinds, known words only, needs the lookups, chip after access', () => {
  assert.deepEqual(DEFAULTS.reach, []);
  assert.deepEqual(clean({ reach: ['hike', 'fly', 'drive'] }).reach, ['hike', 'drive']);
  assert.deepEqual(clean({ reach: 'hike' }).reach, []);
  assert.deepEqual(clean({}).reach, []);
  const P = { ...DEFAULTS, noAlgae: false, access: ['ramp'], reach: ['walk'] };
  assert.deepEqual(active(P), ['access', 'reach', 'miles']);
  assert.ok(needsFacts({ ...DEFAULTS, noAlgae: false, reach: ['walk'] })); assert.deepEqual(off('reach'), { reach: [] });
});
