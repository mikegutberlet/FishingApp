import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AT, BANDS, pointsFor, roadKind, roadFrom, waterFrom, matcher, outlineOf, valueFor, finder, rampAt } from '../build-reach.mjs';

test('pointsFor: lakes by NHD id, stocked waters by their id, shore from acres, streams at the bank', () => {
  const pts = pointsFor(
    [{ id: '01654915', name: 'Donner Lake', acres: 834, lat: 39.32224, lon: -120.26319 }],
    [{ id: 13306, name: 'Donner Lake', lat: 39.32638, lon: -120.26527 }, { id: 7, name: 'Truckee River', lat: 39.3, lon: -120.2 }, { id: 8, name: 'Nowhere Pond', lat: null, lon: null }]);
  assert.deepEqual(pts.map(p => p.key), ['n:01654915', 's:13306', 's:7']);
  assert.ok(Math.abs(pts[0].shore - 0.829) < 0.01, `Donner's shore ${pts[0].shore}`);
  assert.equal(pts[2].shore, 0);
  assert.deepEqual(pts.map(p => p.stream), [false, false, true]);
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

// A box of water around (lat, lon): half-height and half-width in degrees, as one ring [[lat, lon], …].
const box = (lat, lon, dLat, dLon) => [[lat - dLat, lon - dLon], [lat - dLat, lon + dLon], [lat + dLat, lon + dLon], [lat + dLat, lon - dLon], [lat - dLat, lon - dLon]];
const feature = (rings, tags = { natural: 'water' }, type = 'Polygon') => JSON.stringify({ type: 'Feature', properties: tags,
  geometry: { type, coordinates: type === 'Polygon' ? rings.map(r => r.map(([lat, lon]) => [lon, lat])) : rings.map(poly => poly.map(r => r.map(([lat, lon]) => [lon, lat]))) } });

test('waterFrom: the outer rings of a lake, and nothing for a river, a canal or a line', () => {
  const a = box(39, -120, 0.01, 0.01), hole = box(39, -120, 0.001, 0.001), b = box(39.1, -120, 0.01, 0.01);
  assert.deepEqual(waterFrom(feature([a, hole])), [a]);
  assert.deepEqual(waterFrom(feature([[a, hole], [b]], { natural: 'water', water: 'reservoir' }, 'MultiPolygon')), [a, b]);
  assert.equal(waterFrom(feature([a], { natural: 'water', water: 'river' })), null);
  assert.equal(waterFrom(feature([a], { natural: 'water', water: 'canal' })), null);
  assert.equal(waterFrom(feature([a], { landuse: 'reservoir' }))?.length, 1);
  assert.equal(waterFrom(JSON.stringify({ type: 'Feature', properties: { natural: 'water' }, geometry: { type: 'LineString', coordinates: [[-120, 39], [-120.1, 39]] } })), null);
  assert.equal(waterFrom('{nope'), null);
});

test('matcher: a lake takes the shoreline drawn around its point, when the size fits', () => {
  // 0.01° × 0.01° at 39° N is about 1.11 km × 0.86 km, 237 acres.
  const pts = [
    { key: 'lake', lat: 39, lon: -120, acres: 250, stream: false },
    { key: 'pond', lat: 39.2, lon: -120, acres: 3, stream: false },        // sits inside a drawn reservoir fifty times its size
    { key: 'nosize', lat: 39.4, lon: -120, acres: null, stream: false },
    { key: 'creek', lat: 39.6, lon: -120, acres: null, stream: true },
    { key: 'dry', lat: 39.8, lon: -120, acres: 40, stream: false },        // nothing drawn here
    { key: 'two', lat: 40, lon: -120, acres: 240, stream: false },
  ];
  const m = matcher(pts);
  for (const [lat, dLat] of [[39, 0.005], [39.2, 0.005], [39.4, 0.005], [39.6, 0.005]]) m.offer([box(lat, -120, dLat, 0.005)]);
  m.offer([box(40, -120, 0.011, 0.011)]); // a wider water drawn around the lake, under five times its size
  m.offer([box(40, -120, 0.005, 0.005)]); // the lake itself
  const got = m.outlines();
  assert.deepEqual([...got.keys()].sort(), ['lake', 'nosize', 'two']);
  assert.ok(got.get('two').every(([lat]) => Math.abs(lat - 40) < 0.006), 'the shoreline nearest the lake\'s size wins');
  const big = matcher([{ key: 'x', lat: 39, lon: -120, acres: null, stream: false }]);
  big.offer([box(39, -120, 0.05, 0.05)]); // 5,900 acres around a water with no size on record
  assert.equal(big.outlines().size, 0);
});

test('outlineOf: shore points no more than 150 m apart, thinned for a very long shore', () => {
  const ring = box(39, -120, 0.005, 0.005), out = outlineOf(ring);
  assert.ok(out.length >= 26 && out.length <= 40, `${out.length} points around a 3.9 km shore`);
  assert.deepEqual(out[0], ring[0]);
  assert.ok(outlineOf(box(39, -120, 1, 1)).length <= 4000, 'a 390 km shore is thinned');
});

test('finder: a long reservoir with the road at the dam is a drive-up by its shoreline, a walk by its circle', () => {
  // 5.2 km long and 0.33 km wide; 425 acres, so the circle's shore is 0.59 km from the middle.
  const lake = { key: 'canyon', lat: 39, lon: -120, shore: 0.59, acres: 425 };
  const dam = [[39.0, -119.9690], [38.99, -119.9690]]; // a road past the east end, 2.7 km from the middle
  const circle = finder([lake]); circle.add('car', dam);
  assert.equal(circle.values().get('canyon'), 3.2);
  const shore = finder([{ ...lake, outline: outlineOf(box(39, -120, 0.0015, 0.03)) }]); shore.add('car', dam);
  assert.equal(shore.values().get('canyon'), 'd');
  assert.ok(shore.nearest('canyon').car < 0.1, JSON.stringify(shore.nearest('canyon')));
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
    ${way(15, [1, 2, 3, 4, 1], { natural: 'water', name: 'Test Pond' })}
    ${way(16, [1, 2, 4, 1], {})}
    <relation id="20" version="1" timestamp="2026-01-01T00:00:00Z"><member type="way" ref="16" role="outer"/><tag k="type" v="multipolygon"/><tag k="natural" v="water"/><tag k="water" v="reservoir"/></relation>
    ${way(14, [1, 4, 3, 1], { highway: 'service', junction: 'roundabout' })}</osm>`);
  execFileSync('bash', [new URL('../reach-roads.sh', import.meta.url).pathname, join(dir, 'in.osm'), join(dir, 'out.geojsonseq'), join(dir, 'water.geojsonseq')], { stdio: 'pipe' });
  const water = readFileSync(join(dir, 'water.geojsonseq'), 'utf8').split('\n').filter(l => l.trim());
  assert.equal(water.length, 2, 'the pond and the reservoir drawn as a relation, not the building');
  assert.deepEqual(water.map(l => waterFrom(l)?.[0].length).sort(), [4, 5]);
  const lines = readFileSync(join(dir, 'out.geojsonseq'), 'utf8').split('\n').filter(l => l.trim());
  const roads = lines.map(roadFrom);
  assert.equal(lines.length, 3, 'the path and the building are left out by the filter');
  assert.deepEqual(roads[0], { kind: 'car', coords: [[39, -120], [39.01, -120]] });
  assert.equal(roads[1], null, 'the track closed to motor vehicles is read and refused');
  assert.equal(roads[2]?.kind, 'car', 'a closed loop of road is still a road');
  assert.equal(roads[2].coords.length, 4);
});
