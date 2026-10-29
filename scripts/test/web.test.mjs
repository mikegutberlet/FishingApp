import { test } from 'node:test'; import assert from 'node:assert/strict';
import { parseUrls, robotsAllows, articleText } from '../ingest/web.mjs';
test('parseUrls reads one url per line with an optional water after two spaces', () => {
  const out = parseUrls('# header\nhttps://a.example/post  Convict Lake\nhttps://b.example/x\nnot a url\nhttps://a.example/post  Other\n');
  assert.deepEqual(out, [{ url: 'https://a.example/post', water: 'Convict Lake' }, { url: 'https://b.example/x' }]);
});
test('robotsAllows picks our group over * and longest prefix, allow on tie', () => {
  const r = 'User-agent: *\nDisallow: /\n\nUser-agent: TackleBoxArchive\nDisallow: /private/\nAllow: /private/ok\n';
  assert.equal(robotsAllows(r, '/blog/x'), true);
  assert.equal(robotsAllows(r, '/private/secret'), false);
  assert.equal(robotsAllows(r, '/private/ok'), true);
  assert.equal(robotsAllows('User-agent: *\nDisallow: /', '/blog/x'), false);
  assert.equal(robotsAllows('', '/anything'), true);
});
test('articleText prefers article, strips chrome and decodes entities', () => {
  const html = '<html><head><title>Convict &amp; Crowley</title><script>x()</script></head><body><nav><p>Menu item</p></nav><article><h1>Trip</h1><p>Convict Lake was <b>glassy</b> at dawn.</p><ul><li>Bring a 5-wt.</li></ul></article><footer><p>© site</p></footer></body></html>';
  assert.deepEqual(articleText(html), { title: 'Convict & Crowley', paragraphs: ['Trip', 'Convict Lake was glassy at dawn.', 'Bring a 5-wt.'] });
});
test('articleText copes with unclosed <p> tags', () => {
  const html = '<html><body><p>Unclosed first paragraph about Convict Lake<p>Second one<br>continues</body></html>';
  assert.deepEqual(articleText(html).paragraphs, ['Unclosed first paragraph about Convict Lake', 'Second one continues']);
});
