import { test, before, after } from 'node:test'; import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process'; import net from 'node:net'; import os from 'node:os'; import path from 'node:path';
const KEY = '0123456789abcdef';
let dir, proc, port;
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'tb-serve-'));
  await mkdir(path.join(dir, 'maps', 'test', '6', '10'), { recursive: true });
  await writeFile(path.join(dir, 'maps', 'index.json'), JSON.stringify({ builtAt: 'x', regions: [{ id: 'test' }] }));
  await writeFile(path.join(dir, 'maps', 'test', 'index.json'), JSON.stringify({ id: 'test' }));
  await writeFile(path.join(dir, 'maps', 'test', 'missing.json'), '["6/10/24"]');
  await writeFile(path.join(dir, 'maps', 'test', '6', '10', '23.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  port = await freePort();
  proc = spawn('node', ['server/serve.mjs'], { env: { ...process.env, CORPUS_DIR: dir, CORPUS_TOKEN: KEY, BUILD_HOUR: '-1', PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => { proc.stdout.on('data', d => { if (/archive server on/.test(d)) resolve(); }); proc.on('exit', c => reject(new Error(`server exited ${c}`))); });
});
after(async () => { proc.kill(); await rm(dir, { recursive: true }); });
const get = (p, key = true) => fetch(`http://127.0.0.1:${port}${p}`, { headers: key ? { Authorization: `Bearer ${KEY}` } : {} });

test('serves region indexes and tiles with the key, nothing else', async () => {
  const top = await get('/maps/index.json'); assert.equal(top.status, 200); assert.match(top.headers.get('cache-control'), /no-store/);
  assert.equal((await get('/maps/test/index.json')).status, 200);
  const t = await get('/maps/test/6/10/23.png');
  assert.equal(t.status, 200); assert.equal(t.headers.get('content-type'), 'image/png'); assert.match(t.headers.get('cache-control'), /immutable/);
  assert.equal(Buffer.from(await t.arrayBuffer())[0], 0x89);
  assert.equal((await get('/maps/test/6/10/23.png', false)).status, 401);
  for (const bad of ['/maps/test/6/10/99.png', '/maps/../ca/index.json', '/maps/test/6/10/23.json', '/maps/test/a/b/c.png', '/maps/test/missing.json', '/maps/test/regions.json', '/maps/regions.json', '/maps/test/6/10.png', '/ca/6/10/23.png', '/maps/te$t/index.json'])
    assert.equal((await get(bad)).status, 404, bad);
});
