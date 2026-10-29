import { test, before, after } from 'node:test'; import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process'; import { promisify } from 'node:util'; import http from 'node:http'; import os from 'node:os'; import path from 'node:path';
const exec = promisify(execFile);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
let dir, server, port, requests = 0, jsonTimes = 0;
before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'tb-maps-'));
  await mkdir(path.join(dir, 'maps'), { recursive: true });
  // one small region; at zoom 6 it is the single tile 6/10/24, which the fake USGS does not have
  await writeFile(path.join(dir, 'maps', 'regions.json'), JSON.stringify({ regions: [{ id: 'test', name: 'Test', bounds: [-118.9, 37.5, -118.8, 37.6], zMin: 6, zMax: 11 }] }));
  server = http.createServer((req, res) => {
    requests++;
    if (req.url === '/tile/6/24/10') { res.statusCode = 404; return res.end(); }   // {z}/{y}/{x}
    if (req.url === '/tile/7/49/21' && jsonTimes-- > 0) { res.setHeader('content-type', 'application/json'); return res.end('{"error":{"code":500}}'); } // ArcGIS "200 with an error body"
    res.setHeader('content-type', 'image/png'); res.end(PNG);
  });
  await new Promise(r => server.listen(0, r)); port = server.address().port;
});
after(async () => { server.close(); await rm(dir, { recursive: true }); });
const env = extra => ({ ...process.env, CORPUS_DIR: dir, MAPS_TILE_URL: `http://127.0.0.1:${port}/tile/{z}/{y}/{x}`, MAPS_CONCURRENCY: '2', ...extra });
const run = e => exec('node', ['scripts/build-maps.mjs'], { env: e });
const index = async () => JSON.parse(await readFile(path.join(dir, 'maps', 'test', 'index.json'), 'utf8'));

test('fills a region, records a missing tile, and a second run fetches nothing', async () => {
  const { stdout } = await run(env({ MAPS_MINUTES: '0' }));
  assert.match(stdout, /region "Test": \d+\/\d+ tiles \(1 not available\), .* complete/);
  const idx = await index();
  assert.equal(idx.complete, true); assert.equal(idx.missing, 1); assert.equal(idx.have + idx.missing, idx.tiles);
  assert.ok(idx.bytes >= idx.have * PNG.length, 'bytes come from the files on disk');
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'maps', 'test', 'missing.json'), 'utf8')), ['6/10/24']);
  const top = JSON.parse(await readFile(path.join(dir, 'maps', 'index.json'), 'utf8'));
  assert.equal(top.regions[0].id, 'test'); assert.equal(top.regions[0].have, idx.have); assert.ok(top.builtAt);
  const png = await readFile(path.join(dir, 'maps', 'test', '7', '21', '49.png')); assert.deepEqual(png, PNG);
  const before = requests; await run(env({ MAPS_MINUTES: '0' })); assert.equal(requests, before);   // nothing re-fetched, not even the 404
});

test('stops at the budget and resumes next run', async () => {
  await rm(path.join(dir, 'maps', 'test'), { recursive: true, force: true });
  const { stdout } = await run(env({ MAPS_MINUTES: '0.00001' }));   // under a millisecond: a handful of tiles at most
  assert.match(stdout, /budget reached, continues next run/);
  const partial = await index(); assert.equal(partial.complete, false); assert.ok(partial.have < partial.tiles);
  await run(env({ MAPS_MINUTES: '0' }));
  assert.equal((await index()).complete, true);
});

test('a 200 that is not an image is a failure, not a tile', async () => {
  await rm(path.join(dir, 'maps', 'test'), { recursive: true, force: true });
  jsonTimes = 2; // both attempts of the first run
  const { stdout } = await run(env({ MAPS_MINUTES: '0' }));
  assert.match(stdout, /1 failed, retried next run/);
  await assert.rejects(readFile(path.join(dir, 'maps', 'test', '7', '21', '49.png')), 'the JSON body must not be saved as a tile');
  assert.equal((await index()).complete, false);
  await run(env({ MAPS_MINUTES: '0' }));
  assert.deepEqual(await readFile(path.join(dir, 'maps', 'test', '7', '21', '49.png')), PNG); assert.equal((await index()).complete, true);
});

test('a budget that is not a number is refused', async () => {
  for (const bad of ['60m', '-5']) await assert.rejects(run(env({ MAPS_MINUTES: bad })), e => e.code === 1 && /MAPS_MINUTES/.test(e.stderr), bad);
});

test('a bad regions file is reported and exits 1', async () => {
  const bad = await mkdtemp(path.join(os.tmpdir(), 'tb-maps-bad-')); await mkdir(path.join(bad, 'maps'));
  await writeFile(path.join(bad, 'maps', 'regions.json'), '{ not json');
  await assert.rejects(run(env({ CORPUS_DIR: bad, MAPS_MINUTES: '0' })), e => e.code === 1 && /regions\.json/.test(e.stderr));
  await rm(bad, { recursive: true });
});
