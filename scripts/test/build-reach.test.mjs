import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AT, BANDS, pointsFor, roadKind, roadFrom, valueFor, finder, rampAt } from '../build-reach.mjs';

test('pointsFor: lakes by NHD id, stocked waters by their id, shore from acres, streams at the bank', () => {
  const pts = pointsFor(
    [{ id: '01654915', name: 'Donner Lake', acres: 834, lat: 39.32224, lon: -120.26319 }],
    [{ id: 13306, name: 'Donner Lake', lat: 39.32638, lon: -120.26527 }, { id: 7, name: 'Truckee River', lat: 39.3, lon: -120.2 }, { id: 8, name: 'Nowhere Pond', lat: null, lon: null }]);
  assert.deepEqual(pts.map(p => p.key), ['n:01654915', 's:13306', 's:7']);
  assert.ok(Math.abs(pts[0].shore - 0.829) < 0.01, `Donner's shore ${pts[0].shore}`);
  assert.equal(pts[2].shore, 0);
  assert.ok(pts[1].shore > 0.1 && pts[1].shore < 0.2); // no acres on record: a 20 acre lake
});

test('roadKind: roads a car can take, dirt tracks, and what is no way in', () => {
  const kind = (highway, more = {}) => roadKind({ highway, ...more });
  assert.deepEqual(['trunk', 'primary', 'secondary_link', 'tertiary', 'unclassified', 'residential', 'living_street', 'service', 'road'].map(h => kind(h)), Array(9).fill('car'));
  assert.equal(kind('track'), 'track');
  assert.deepEqual(['motorway', 'motorway_link', 'footway', 'path', 'cycleway', 'steps', 'proposed', undefined].map(h => kind(h)), Array(8).fill(null));
  assert.equal(kind('residential', { access: 'private' }), null);
  assert.equal(kind('track', { motor_vehicle: 'no' }), null);
  assert.equal(kind('service', { vehicle: 'forestry' }), null);
  assert.equal(kind('track', { access: 'permissive' }), 'track');
  assert.equal(kind('unclassified', { access: 'yes', motor_vehicle: 'destination' }), 'car');
});

test('roadFrom: one line of the road file, with or without the record separator', () => {
  const line = JSON.stringify({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[-120.2, 39.1], [-120.21, 39.11]] }, properties: { highway: 'track', name: 'Spur' } });
  assert.deepEqual(roadFrom(line), { kind: 'track', coords: [[39.1, -120.2], [39.11, -120.21]] });
  assert.deepEqual(roadFrom('\x1e' + line), { kind: 'track', coords: [[39.1, -120.2], [39.11, -120.21]] });
  assert.equal(roadFrom(line.replace('"track"', '"path"')), null);
  assert.equal(roadFrom(line.replace('LineString', 'Point')), null);
  assert.equal(roadFrom(''), null);
  assert.equal(roadFrom('{not json'), null);
});

test('valueFor: a car road at the shore, a track at the shore, then the band of the nearest road of either kind', () => {
  const v = (car, track) => valueFor({ car: car ?? Infinity, track: track ?? Infinity });
  assert.equal(v(0.1), 'd'); assert.equal(v(AT), 'd'); assert.equal(v(0, 0), 'd');
  assert.equal(v(5, 0.3), 'r');
  assert.equal(v(0.41), 0.8); assert.equal(v(0.8), 0.8);
  assert.equal(v(undefined, 1.2), 1.6);
  assert.equal(v(3, 6), 3.2); assert.equal(v(4), 4.8); assert.equal(v(7.9), 8); assert.equal(v(8.01), 9);
  assert.equal(v(), 9);
  assert.deepEqual(BANDS, [0.8, 1.6, 3.2, 4.8, 8]);
});

test('finder: the nearest road of each kind from the shore, whichever way its points fall', () => {
  // 0.01° of latitude is 1.11 km; at 39° N 0.01° of longitude is 0.86 km.
  const pts = [{ key: 'pond', lat: 39, lon: -120, shore: 0.1 }, { key: 'big', lat: 39.5, lon: -120, shore: 2 }, { key: 'far', lat: 41, lon: -120, shore: 0.1 }];
  const f = finder(pts);
  f.add('car', [[39.02, -120.3], [39.02, -119.7]]);       // a long straight road 2.2 km north of the pond: no point of it is near
  f.add('track', [[39.004, -120.001], [39.004, -120.0]]); // a track 0.44 km from the pond's middle
  f.add('car', [[39.5, -120.03], [39.6, -120.03]]);       // 2.6 km from the big lake's middle, 0.6 km from its shore
  f.add('car', [[45, -120], [45.1, -120]]);               // nowhere near anything
  const got = Object.fromEntries(f.values());
  assert.equal(got.pond, 'r', 'the track is 0.34 km from the shore; the road is 2.1 km');
  assert.equal(got.big, 0.8);
  assert.equal(got.far, 9);
  const near = f.nearest('pond');
  assert.ok(Math.abs(near.car - 2.12) < 0.05 && Math.abs(near.track - 0.34) < 0.03, JSON.stringify(near));
});

test('rampAt: a ramp or marina on a big water makes it drive-up even when the road is past the circle', () => {
  const access = { places: [[39.40, -120.10, 'ramp', 'Dam ramp', ''], [39.40, -120.30, 'camp', 'Far camp', '']] };
  const big = { lat: 39.40, lon: -120.125, shore: 0.9, acres: 700 }; // the ramp is 2.1 km from its middle
  assert.equal(rampAt(access, big), true);
  assert.equal(rampAt(access, { ...big, lon: -120.14 }), false, '3.4 km away is another water');
  assert.equal(rampAt(access, { ...big, acres: 20, shore: 0.13 }), false, 'a pond beside a reservoir is not the reservoir');
  assert.equal(rampAt({ places: [[39.40, -120.11, 'camp', '', '']] }, big), false, 'a campground is not a way to the water');
  assert.equal(rampAt(null, big), false);
  assert.equal(rampAt({ updatedAt: 'x' }, big), false, 'a file with no places');
});

// The whole road step as the workflow runs it (scripts/reach-roads.sh), on a hand-made extract. Needs osmium-tool.
test('reach-roads.sh: roads and tracks come out one per line with their tags; paths and buildings do not', { skip: spawnSync('osmium', ['--version']).status !== 0 && 'osmium-tool is not installed' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'reach-'));
  const node = (id, lat, lon) => `<node id="${id}" version="1" timestamp="2026-01-01T00:00:00Z" lat="${lat}" lon="${lon}"/>`;
  const way = (id, refs, tags) => `<way id="${id}" version="1" timestamp="2026-01-01T00:00:00Z">${refs.map(r => `<nd ref="${r}"/>`).join('')}${Object.entries(tags).map(([k, v]) => `<tag k="${k}" v="${v}"/>`).join('')}</way>`;
  writeFileSync(join(dir, 'in.osm'), `<?xml version="1.0" encoding="UTF-8"?><osm version="0.6" generator="test">
    ${[node(1, 39, -120), node(2, 39.01, -120), node(3, 39.02, -120), node(4, 39.02, -120.01)].join('')}
    ${way(10, [1, 2], { highway: 'residential', name: 'Lake Road' })}
    ${way(11, [2, 3], { highway: 'track', motor_vehicle: 'no' })}
    ${way(12, [3, 4], { highway: 'path' })}
    ${way(13, [1, 2, 3, 4, 1], { building: 'yes' })}
    ${way(14, [1, 4, 3, 1], { highway: 'service', junction: 'roundabout' })}</osm>`);
  execFileSync('bash', [new URL('../reach-roads.sh', import.meta.url).pathname, join(dir, 'in.osm'), join(dir, 'out.geojsonseq')], { stdio: 'pipe' });
  const lines = readFileSync(join(dir, 'out.geojsonseq'), 'utf8').split('\n').filter(l => l.trim());
  const roads = lines.map(roadFrom);
  assert.equal(lines.length, 3, 'the path and the building are left out by the filter');
  assert.deepEqual(roads[0], { kind: 'car', coords: [[39, -120], [39.01, -120]] });
  assert.equal(roads[1], null, 'the track closed to motor vehicles is read and refused');
  assert.equal(roads[2]?.kind, 'car', 'a closed loop of road is still a road');
  assert.equal(roads[2].coords.length, 4);
});
