// Weekly: Nevada fishing regulations and fish consumption advisories for the app.
//
//   data/nv/regs.json        statewide rules plus each region's general limits and the special regulations NDOW
//                            lists by water, from the official regulations on eRegulations (linked from ndow.org)
//   data/nv/advisories.json  health advisories on eating fish (mercury), found in the same pages
//
// Run by .github/workflows/nevada-weekly.yml. Only public data.

import { writeFile, mkdir, readFile } from 'node:fs/promises';

const OUT = new URL('../../data/nv/', import.meta.url);
const BASE = 'https://www.eregulations.com/nevada/fishing';
const BROWSER = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', Accept: 'text/html,*/*' };
const report = { startedAt: new Date().toISOString(), pages: {} };

async function page(path) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(`${BASE}/${path}`, { headers: BROWSER });
      if (!r.ok) throw new Error(`${r.status} ${path}`);
      return await r.text();
    } catch (e) {
      if (i >= 3) throw e;
      await new Promise(res => setTimeout(res, 4000 * i));
    }
  }
}

const ENTITIES = { amp: '&', nbsp: ' ', quot: '"', apos: "'", lt: '<', gt: '>', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', hellip: '…' };
const decode = s => String(s ?? '').replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENTITIES[e.toLowerCase()] ?? m);
const clean = s => decode(String(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// The article as a list of blocks in order: headings, paragraphs, list items and table rows.
function blocks(html) {
  const start = html.search(/<h1[\s>]/i);
  let body = html.slice(start < 0 ? 0 : start);
  const end = body.search(/<footer|class="[^"]*(related|pagination|share)[^"]*"/i);
  if (end > 0) body = body.slice(0, end);
  body = body.replace(/<(script|style|figure|figcaption|noscript)[\s\S]*?<\/\1>/gi, '');
  const out = [];
  for (const m of body.matchAll(/<(h[1-6]|p|li|tr)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const tag = m[1].toLowerCase();
    if (tag === 'tr') {
      const cells = [...m[2].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => clean(c[1]));
      if (cells.some(Boolean)) out.push({ tag, cells });
    } else {
      const t = clean(m[2]);
      // Bold lead-ins ("<strong>Topaz Lake</strong> – ...") often stand for a sub-heading.
      const lead = tag === 'p' ? clean(m[2].match(/^\s*<(?:strong|b)>([\s\S]*?)<\/(?:strong|b)>/i)?.[1] ?? '') : '';
      if (t) out.push({ tag, text: t, ...(lead && { lead }) });
    }
  }
  return out;
}

// Group blocks under the nearest heading: [{ title, level, text: [...], rows: [[...]] }].
function sections(bl) {
  const out = [];
  let cur = { title: '', level: 1, text: [], rows: [] };
  for (const b of bl) {
    if (/^h\d$/.test(b.tag)) { if (cur.title || cur.text.length || cur.rows.length) out.push(cur); cur = { title: b.text, level: +b.tag[1], text: [], rows: [] }; }
    else if (b.tag === 'tr') cur.rows.push(b.cells);
    else cur.text.push(b.text);
  }
  out.push(cur);
  return out;
}

await mkdir(OUT, { recursive: true });
const pages = { statewide: 'general-statewide-regulations', western: 'western-region-regulations', southern: 'southern-region-regulations', eastern: 'eastern-region-regulations', stripers: 'new-striper-limit-on-lakes-mead-and-mohave', baitfish: 'fishing-with-bait-fish' };
const parsed = {};
for (const [k, path] of Object.entries(pages)) {
  try {
    const html = await page(path);
    const bl = blocks(html);
    parsed[k] = { url: `${BASE}/${path}`, sections: sections(bl) };
    report.pages[k] = { blocks: bl.length, outline: parsed[k].sections.map(s => `${'#'.repeat(s.level)} ${s.title} (${s.text.length}p ${s.rows.length}r)`).slice(0, 200), sample: bl.slice(0, 60) };
  } catch (e) { report.pages[k] = { error: e.message }; }
}

await writeFile(new URL('regs-raw.json', OUT), JSON.stringify(parsed) + '\n');
report.finishedAt = new Date().toISOString();
await writeFile(new URL('regs-report.json', OUT), JSON.stringify(report, null, 1) + '\n');
console.log(JSON.stringify(Object.fromEntries(Object.entries(report.pages).map(([k, v]) => [k, v.error ?? v.outline?.slice(0, 80)])), null, 1));
