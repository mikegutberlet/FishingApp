import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { tileRange, tilesAt, tileList, boundsOf } from '../../slippy.js';

test('tileRange matches the slippy formula at a known point', () => {
  // Convict Lake 37.5909,-118.8596 at z12 is tile x=695, y=1585 (OSM slippy convention)
  const r = tileRange({ west: -118.8596, south: 37.5909, east: -118.8596, north: 37.5909 }, 12);
  assert.deepEqual(r, { x0: 695, x1: 695, y0: 1585, y1: 1585 });
  assert.deepEqual(tileRange({ west: -180, south: -85.0511, east: 180, north: 85.0511 }, 0), { x0: 0, x1: 0, y0: 0, y1: 0 });
});

test('tileList walks zooms ascending and counts like tilesAt', () => {
  const b = boundsOf([-118.9, 37.5, -118.8, 37.6]);
  const list = [...tileList(b, 10, 12)];
  assert.equal(list.length, tilesAt(b, 10) + tilesAt(b, 11) + tilesAt(b, 12));
  assert.equal(list[0].z, 10);
  assert.equal(list.at(-1).z, 12);
  assert.ok(list.every(t => Number.isInteger(t.x) && Number.isInteger(t.y)));
});

test('default regions are well formed', async () => {
  const { regions } = JSON.parse(await readFile(new URL('../../data/maps/regions.json', import.meta.url), 'utf8'));
  assert.deepEqual(regions.map(r => r.id), ['eastern-sierra', 'ca', 'nv', 'or']);
  for (const r of regions) {
    assert.match(r.id, /^[\w-]+$/);
    assert.equal(r.bounds.length, 4);
    assert.ok(r.bounds[0] < r.bounds[2] && r.bounds[1] < r.bounds[3], r.id);
    assert.ok(6 <= r.zMin && r.zMin <= r.zMax && r.zMax <= 16, r.id);
  }
  const es = regions[0];
  let n = 0;
  for (let z = es.zMin; z <= es.zMax; z++) n += tilesAt(boundsOf(es.bounds), z);
  assert.ok(n < 25000, `Eastern Sierra is ${n} tiles; keep it under 25k`);
});
