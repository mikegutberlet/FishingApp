import { test, before, after } from 'node:test'; import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, readdir, rm, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process'; import { promisify } from 'node:util'; import http from 'node:http'; import os from 'node:os'; import path from 'node:path';
const run = promisify(execFile), fx = new URL('./fixtures/', import.meta.url).pathname;
let dir, server, port, robots = 'User-agent: *\nAllow: /\n', fail = false;
const page = '<html><head><title>Report</title></head><body><article><p>Convict Lake fished well on Tuesday morning with the browns holding along the inlet drop-off and taking small olive leeches.</p><p>We left before the wind.</p></article></body></html>';
before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'tb-corpus-'));
  await mkdir(path.join(dir, 'library'), { recursive: true }); await mkdir(path.join(dir, 'ca'), { recursive: true });
  await copyFile(path.join(fx, 'two-pages.pdf'), path.join(dir, 'library', 'Guide.pdf'));
  await writeFile(path.join(dir, 'library', 'Guide.pdf.json'), JSON.stringify({ title: 'Fixture Guide', author: 'Test Author', states: ['ca'], pages: { '1': 'ca:Crowley Lake' } }));
  await writeFile(path.join(dir, 'ca', '18122.json'), JSON.stringify({ id: '18122', state: 'CA', name: 'Convict Lake', notes: [{ date: '2026-01-01', text: 'hand note', source: { title: 'me' } }], manual: {} }));
  server = http.createServer((req, res) => { if (fail) { res.statusCode = 503; return res.end(); } res.end(req.url === '/robots.txt' ? robots : page); });
  await new Promise(r => server.listen(0, r)); port = server.address().port;
  await writeFile(path.join(dir, 'urls.md'), `http://127.0.0.1:${port}/post\nhttp://127.0.0.1:${port}/tagged  ca:Convict Lake\n`);
});
after(async () => { server.close(); await rm(dir, { recursive: true }); });
const ingest = (...args) => run('node', ['scripts/ingest.mjs', ...args], { env: { ...process.env, CORPUS_DIR: dir, INGEST_DELAY_MS: '0' } });
const convict = async () => JSON.parse(await readFile(path.join(dir, 'ca', '18122.json'), 'utf8'));
test('files book and web passages on the right waters, keeps hand notes', async () => {
  const { stdout } = await ingest();
  assert.match(stdout, /book "Fixture Guide": \d+ passages/); assert.match(stdout, /web http:\/\/127\.0\.0\.1:\d+\/post: 1 passage/);
  const f = await convict();
  assert.equal(f.notes[0].text, 'hand note');
  const srcs = new Set(f.passages.map(p => p.src)); assert.ok(srcs.has('library/Guide.pdf') && srcs.has(`http://127.0.0.1:${port}/post`) && srcs.has(`http://127.0.0.1:${port}/tagged`));
  const book = f.passages.find(p => p.kind === 'book'); assert.equal(book.page, '1'); assert.equal(book.title, 'Fixture Guide'); assert.equal(book.author, 'Test Author'); assert.deepEqual(book.matched, ['Convict Lake']); assert.equal(book.how, 'name');
  assert.equal(f.passages.find(p => p.src.endsWith('/tagged')).how, 'tagged');
});
test('sidecar pages pin a range to one water and a stub file is created', async () => {
  const crowleyFile = (await readdir(path.join(dir, 'ca'))).find(n => n !== '18122.json');
  const c = JSON.parse(await readFile(path.join(dir, 'ca', crowleyFile), 'utf8'));
  assert.equal(c.name, 'Crowley Lake'); assert.equal(c.checkedAt, undefined); assert.ok(c.passages.some(p => p.how === 'pages' && p.page === '1'));
});
test('a second run changes nothing', async () => {
  const before = JSON.stringify(await convict()); await ingest(); assert.equal(JSON.stringify(await convict()), before);
});
test('a failed fetch keeps last run\'s passages and still exits 0', async () => {
  fail = true; const { stdout } = await ingest(); fail = false;
  assert.match(stdout, /fetch failed \(status 503\), kept 1 passage/);
  assert.ok((await convict()).passages.some(p => p.src.endsWith('/post')));
});
test('robots disallow removes a url\'s passages', async () => {
  robots = 'User-agent: *\nDisallow: /post\n'; await ingest(); robots = 'User-agent: *\nAllow: /\n';
  assert.ok(!(await convict()).passages.some(p => p.src.endsWith('/post')));
});
test('a removed book takes its passages with it', async () => {
  await unlink(path.join(dir, 'library', 'Guide.pdf')); await ingest();
  assert.ok(!(await convict()).passages.some(p => p.kind === 'book'));
});
test('--dry writes nothing and exits 1 without CORPUS_DIR', async () => {
  await copyFile(path.join(fx, 'two-pages.pdf'), path.join(dir, 'library', 'Guide.pdf'));
  const before = JSON.stringify(await convict()); const { stdout } = await ingest('--dry');
  assert.match(stdout, /ca:18122 {2}Fixture Guide {2}1 {2}Convict Lake/); assert.equal(JSON.stringify(await convict()), before);
  await assert.rejects(run('node', ['scripts/ingest.mjs'], { env: { ...process.env, CORPUS_DIR: '' } }), /usage/);
});
