import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, clusterPins, cellFor, samePlace, pinTone } from '../../map-pins-core.js';

test('project matches the slippy formula', () => {
  // Convict Lake 37.5909,-118.8596 at z12 is tile x=695, y=1585 (as scripts/test/slippy.test.mjs)
  const p = project(37.5909, -118.8596, 12);
  assert.equal(Math.floor(p.x / 256), 695); assert.equal(Math.floor(p.y / 256), 1585);
});
test('far-apart pins stay apart, close pins group', () => {
  const pins = [{ lat: 39.0, lon: -120.0 }, { lat: 39.001, lon: -120.001 }, { lat: 41.0, lon: -122.0 }];
  const g = clusterPins(pins, 8);
  assert.equal(g.length, 2); assert.equal(g.find(x => x.pins.length === 2).pins.length, 2);
  assert.equal(clusterPins(pins, 16).length, 3);
});
test('a group of one keeps its own point', () => {
  const [g] = clusterPins([{ lat: 39.5, lon: -120.5 }], 6);
  assert.equal(g.lat, 39.5); assert.equal(g.lon, -120.5);
});
test('a bigger group sits at the middle of its pins', () => {
  const [g] = clusterPins([{ lat: 39.0, lon: -120.0 }, { lat: 39.002, lon: -120.002 }], 6);
  assert.ok(Math.abs(g.lat - 39.001) < 1e-9); assert.ok(Math.abs(g.lon + 120.001) < 1e-9);
});
test('every pin lands in exactly one group', () => {
  const pins = Array.from({ length: 500 }, (_, i) => ({ lat: 36 + (i % 50) * 0.1, lon: -122 + Math.floor(i / 50) * 0.3 }));
  for (const z of [5, 8, 11, 12, 15]) assert.equal(clusterPins(pins, z).reduce((n, g) => n + g.pins.length, 0), 500);
});
test('the cell is wide when zoomed out and tight from zoom 12', () => { assert.equal(cellFor(11), 60); assert.equal(cellFor(12), 18); });
test('pins on one coordinate group at every zoom and read as one place', () => {
  const pins = [{ lat: 40.1, lon: -115.5 }, { lat: 40.1, lon: -115.5 }];
  const g = clusterPins(pins, 18);
  assert.equal(g.length, 1); assert.ok(samePlace(g[0].pins));
  assert.ok(!samePlace([{ lat: 40.1, lon: -115.5 }, { lat: 40.2, lon: -115.5 }]));
});
test('tone: a plant in the last 30 days or coming is fresh, any fish is fish, else none', () => {
  const t = '2026-11-12';
  assert.equal(pinTone({ lastPlant: '2026-10-20', fish: new Map() }, t), 'fresh');
  assert.equal(pinTone({ lastPlant: '2026-10-13', fish: new Map() }, t), 'fresh');
  assert.equal(pinTone({ lastPlant: '2026-11-20', fish: new Map() }, t), 'fresh');
  assert.equal(pinTone({ lastPlant: '2026-10-12', fish: new Map([['trout', new Set(['stocked'])]]) }, t), 'fish');
  assert.equal(pinTone({ lastPlant: null, fish: new Map() }, t), 'none');
  assert.equal(pinTone({ fish: new Map() }, t), 'none');
});
