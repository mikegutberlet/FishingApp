import test from 'node:test';
import assert from 'node:assert/strict';
import { AT, BANDS, pointsFor, ringQuery, countsFrom, survey, asker, rampAt } from '../build-state-reach.mjs';

const count = n => ({ type: 'count', id: 0, tags: { nodes: '0', ways: String(n), relations: '0', total: String(n) } });

test('pointsFor: lakes by NHD id, stocked waters by their id, shore from acres, streams at the bank', () => {
  const pts = pointsFor(
    [{ id: '01654915', name: 'Donner Lake', acres: 834, lat: 39.32224, lon: -120.26319 }],
    [{ id: 13306, name: 'Donner Lake', lat: 39.32638, lon: -120.26527 }, { id: 7, name: 'Truckee River', lat: 39.3, lon: -120.2 }, { id: 8, name: 'Nowhere Pond', lat: null, lon: null }]);
  assert.deepEqual(pts.map(p => p.key), ['n:01654915', 's:13306', 's:7']);
  assert.ok(Math.abs(pts[0].shore - 0.829) < 0.01, `Donner's shore ${pts[0].shore}`);
  assert.equal(pts[2].shore, 0);
  assert.ok(pts[1].shore > 0.1 && pts[1].shore < 0.2); // no acres on record: a 20 acre lake
});

test('ringQuery: one count per water, radius is the shore plus the ring, motorways never count', () => {
  const pts = [{ key: 'n:1', lat: 39.1, lon: -120.2, shore: 0.6 }, { key: 'n:2', lat: 40, lon: -121, shore: 0 }];
  const q = ringQuery(pts, 'car', AT);
  assert.match(q, /^\[out:json\]\[timeout:\d+\];/);
  assert.equal(q.match(/out count;/g).length, 2);
  assert.ok(q.includes('way(around:1000,39.1,-120.2)') && q.includes('way(around:400,40,-121)'), q);
  assert.ok(!/motorway/.test(q) && /residential/.test(q) && !/\btrack\b/.test(q), q);
  assert.match(q, /\["motor_vehicle"!~"\^\(no\|private/);
  const t = ringQuery(pts, 'track', AT), a = ringQuery(pts, 'any', 1.6);
  assert.ok(/\["highway"="track"\]/.test(t) && !/residential/.test(t), t);
  assert.ok(/track/.test(a) && /residential/.test(a) && a.includes('way(around:2200,39.1,-120.2)'), a);
});

test('countsFrom: the ways in each count, and a short answer is an error, not zeros', () => {
  assert.deepEqual(countsFrom({ elements: [count(3), count(0)] }, 2), [3, 0]);
  assert.throws(() => countsFrom({ elements: [count(3)], remark: 'runtime error: Query timed out' }, 2), /1 of 2/);
  assert.throws(() => countsFrom({}, 1), /0 of 1/);
});

test('survey: drive-up, dirt track, each band, beyond; later passes ask only for waters still open', async () => {
  // What each water has: the nearest car road and the nearest track, in km from its shore.
  const near = { drive: { car: 0.1 }, track: { car: 5, track: 0.3 }, half: { car: 0.7 }, mile: { track: 1.2 }, two: { car: 3 }, three: { car: 4 }, five: { car: 7.9 }, far: {}, lost: { car: 0.1 } };
  const pts = Object.keys(near).map(key => ({ key, lat: 1, lon: 1, shore: 0 }));
  const asked = [];
  const ask = async (points, kind, km) => {
    asked.push([kind, km, points.map(p => p.key).join()]);
    return points.map(p => p.key === 'lost' ? null : +(kind !== 'track' && near[p.key].car <= km || kind !== 'car' && near[p.key].track <= km));
  };
  const got = await survey(pts, ask);
  assert.deepEqual(Object.fromEntries(got), { drive: 'd', track: 'r', half: 0.8, mile: 1.6, two: 3.2, three: 4.8, five: 8, far: 9 });
  assert.deepEqual(asked[0], ['car', AT, pts.map(p => p.key).join()]);
  assert.ok(asked.slice(1).every(a => !a[2].split(',').includes('drive') && !a[2].split(',').includes('lost')), 'settled and unanswered waters are not asked again');
  assert.deepEqual(asked.filter(a => a[1] > 1.6).map(a => a[2]), ['two,three,five,far', 'three,five,far', 'five,far']);
  assert.deepEqual(BANDS, [0.8, 1.6, 3.2, 4.8, 8]);
});

test('asker: batches, halves a batch that fails, and gives up on what never answers', async () => {
  const pts = Array.from({ length: 50 }, (_, i) => ({ key: `n:${i}`, lat: 39 + i / 100, lon: -120, shore: 0 }));
  const sizes = [];
  // The service chokes on any request that includes water 7.
  const fetchJson = async q => {
    const n = q.match(/out count;/g).length;
    sizes.push(n);
    if (q.includes('way(around:400,39.07,-120)')) throw new Error('504');
    return { elements: Array.from({ length: n }, () => count(1)) };
  };
  const got = await asker(fetchJson, { size: 40, least: 5, pause: 0 })(pts, 'car', AT);
  assert.equal(got.length, 50);
  assert.equal(got.filter(v => v === null).length, 5, 'only the smallest batch around the bad water is lost');
  assert.equal(got[7], null);
  assert.equal(got[49], 1);
  assert.deepEqual(sizes.slice(0, 4), [40, 20, 10, 5]);
});

test('rampAt: a ramp or marina on a big water makes it drive-up even when the road is past the circle', () => {
  const access = { places: [[39.40, -120.10, 'ramp', 'Dam ramp', ''], [39.40, -120.30, 'camp', 'Far camp', '']] };
  const big = { lat: 39.40, lon: -120.125, shore: 0.9, acres: 700 }; // the ramp is 2.1 km from its middle
  assert.equal(rampAt(access, big), true);
  assert.equal(rampAt(access, { ...big, lon: -120.14 }), false, '3.4 km away is another water');
  assert.equal(rampAt(access, { ...big, acres: 20, shore: 0.13 }), false, 'a pond beside a reservoir is not the reservoir');
  assert.equal(rampAt({ places: [[39.40, -120.11, 'camp', '', '']] }, big), false, 'a campground is not a way to the water');
  assert.equal(rampAt(null, big), false);
});
