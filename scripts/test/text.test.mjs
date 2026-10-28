import { test } from 'node:test'; import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises'; import os from 'node:os'; import path from 'node:path';
import { paragraphs, needsOcr, extractFile } from '../ingest/text.mjs';
const fx = new URL('./fixtures/', import.meta.url);
test('paragraphs drops short lines and splits long ones at a sentence end', () => {
  const long = 'A'.repeat(900) + '. ' + 'B'.repeat(900) + '.';
  const out = paragraphs([{ page: '1', text: `Contents\n\nsee Convict Lake, p. 112\n\n${long}\n\nmoun-\ntain lake with a long enough description to be kept as a passage by the splitter here.` }]);
  assert.equal(out.length, 3);
  assert.ok(out[0].text.endsWith('A.') && out[0].text.length <= 1500 && out[1].text.startsWith('B'));
  assert.ok(out[2].text.startsWith('mountain lake'));
  assert.ok(out.every(p => p.page === '1'));
});
test('needsOcr is true when pages average under 40 characters', () => {
  assert.equal(needsOcr(['', ' \f', 'x']), true);
  assert.equal(needsOcr(['A'.repeat(500), 'B'.repeat(10)]), false);
});
test('extractFile reads a PDF text layer page by page and caches it', async () => {
  const cache = await mkdtemp(path.join(os.tmpdir(), 'tb-'));
  const r = await extractFile(new URL('two-pages.pdf', fx).pathname, cache);
  assert.equal(r.pages.length, 2); assert.match(r.pages[0].text, /Convict Lake/); assert.match(r.pages[1].text, /Crowley Lake/); assert.equal(r.ocr, false);
  assert.equal(r.title, 'Fixture Guide'); assert.equal(r.author, 'Test Author');
  const again = await extractFile(new URL('two-pages.pdf', fx).pathname, cache);
  assert.deepEqual(again, r); await rm(cache, { recursive: true });
});
test('extractFile reads an EPUB in spine order with chapter labels and metadata', async () => {
  const cache = await mkdtemp(path.join(os.tmpdir(), 'tb-'));
  const r = await extractFile(new URL('book.epub', fx).pathname, cache);
  assert.equal(r.title, 'Fixture Guide'); assert.equal(r.author, 'Test Author');
  assert.equal(r.pages[0].page, 'ch. 1 Mono County'); assert.match(r.pages[0].text, /Convict Lake/); assert.equal(r.pages[1].page, 'ch. 2 Inyo County');
  await rm(cache, { recursive: true });
});
