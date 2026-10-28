import { test } from 'node:test'; import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'; import { execFile } from 'node:child_process'; import { promisify } from 'node:util'; import os from 'node:os'; import path from 'node:path';
const run = promisify(execFile);
test('docs-only build lists passages in the catalogue, the index and keeps them in the pack', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tb-build-')); await mkdir(path.join(dir, 'ca')); await mkdir(path.join(dir, 'library'));
  await writeFile(path.join(dir, 'library', 'Guide.pdf'), 'x'); await writeFile(path.join(dir, 'library', 'Guide.pdf.json'), '{}');
  const p = (src, page) => ({ src, kind: 'book', title: 'Guide', page, text: 'T'.repeat(90), matched: ['Convict Lake'], how: 'name', ingestedAt: '2026-10-29T08:00:00.000Z' });
  await writeFile(path.join(dir, 'ca', '18122.json'), JSON.stringify({ id: '18122', state: 'CA', name: 'Convict Lake', county: 'Mono', lat: 37.59, lon: -118.86, agency: { name: 'CDFW', url: 'https://wildlife.ca.gov' }, firstSeen: '2026-10-01', checkedAt: '2026-10-28T00:00:00.000Z', updatedAt: '2026-10-28T00:00:00.000Z', facts: {}, stocking: { recent: [] }, introductions: [], rules: {}, advisories: { algae: [], eating: [] }, sources: [], notes: [], excerpts: [], manual: {}, changes: [], passages: [p('library/Guide.pdf', '1'), p('library/Guide.pdf', '2'), p('https://x.example/a', '')] }));
  await run('node', ['scripts/build-corpus.mjs'], { env: { ...process.env, CORPUS_DIR: dir, CORPUS_DOCS_ONLY: '1' } });
  assert.match(await readFile(path.join(dir, 'docs', 'ca.md'), 'utf8'), /📚 \*\*From your library\*\*: 3 passages from 2 sources/);
  const index = JSON.parse(await readFile(path.join(dir, 'ca', 'index.json'), 'utf8'));
  assert.equal(index.waters[0].passages, 3);
  const pack = JSON.parse(await readFile(path.join(dir, 'tackle-box-private-corpus.json'), 'utf8'));
  assert.equal(pack.waters['ca/18122'].passages.length, 3); assert.deepEqual(pack.library, ['Guide.pdf']);
  await rm(dir, { recursive: true });
});
