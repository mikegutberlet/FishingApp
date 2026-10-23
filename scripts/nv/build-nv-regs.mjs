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

// Names a regulation row covers: "Hobart Reservoir and tributaries and Franktown Creek downstream from ..." →
// ["Hobart Reservoir", "Franktown Creek"]; "Washoe County Community Fishing Ponds: Battle Born Pond, ..." → each pond.
const WATERISH = /\b(lake|lakes|reservoir|pond|ponds|river|creek|slough|wash|marsh|canal|springs?|refuge|management area|park|dam)\b/i;
function aliases(area) {
  const out = new Set();
  const [head, list] = area.replace(/\s+in [\w ]+ Count(y|ies)$/i, '').split(/:\s*/, 2);
  // "Little and Big Washoe Lakes" → Little Washoe Lake, Big Washoe Lake, Washoe Lake
  const both = head.match(/^(\w+) and (\w+) (.+?) (Lake|Reservoir|Pond)s$/i);
  if (both) [`${both[1]} ${both[3]} ${both[4]}`, `${both[2]} ${both[3]} ${both[4]}`, `${both[3]} ${both[4]}`].forEach(x => out.add(x));
  // "Muddy (Moapa) River systems" → Muddy River, Moapa River
  const text = (list ?? head).replace(/(\w+) \((\w+)\) (River|Creek|Lake|Reservoir)/g, '$1 $3, $2 $3').replace(/\s+systems?\b/gi, '');
  const pieces = text.replace(/[()]/g, ',').split(/,|;|\s+and\s+|\s+including\s+|\s+&\s+|\//i);
  let prev = null;
  for (let p of pieces) {
    p = p.replace(/\b(its |all )?(inlet|outlet|tributary|tributaries)( and outlet)?( streams?)?\b.*$/i, '')
      .replace(/\s+(downstream|upstream|above|below|from|within|in that|except|up to)\b.*$/i, '').replace(/^(the|both|all waters (in|of))\s+/i, '').trim();
    // "Willow Creek Pond and Reservoir" → Willow Creek Reservoir
    if (/^(Lake|Reservoir|Pond)s?$/i.test(p) && prev) p = prev.replace(/\s+\S+$/, ` ${p}`);
    if (p.length > 2 && WATERISH.test(p)) { out.add(p); if (/\bDam (Reservoir|Lake)\b/.test(p)) out.add(p.replace(/\bDam /, '')); prev = p; }
  }
  // "Mason Valley Wildlife Management Area Hinkson Slough": the part after the area name is its own water too.
  const sub = head.match(/(?:Wildlife Management Area|National Wildlife Refuge)\s+(.+)$/i)?.[1];
  if (sub && !list) sub.split(/,|\s+and\s+/).map(x => x.trim()).filter(x => x.length > 2).forEach(x => out.add(x));
  return [...out];
}

// Walks a region page's tables in order: the special-regulations table (county rows, water rows, notes under each
// water) and the health-advisory table (area, species, advice).
function regionTables(region, secs) {
  const waters = [], advisories = [], closed = [];
  let mode = null, county = null, last = null, lastAdv = null;
  for (const row of secs.flatMap(s => s.rows)) {
    const [a, b, c] = row;
    if (row.length === 1 && /Special Regulations$/i.test(a)) { mode = 'special'; continue; }
    if (row.length === 1 && /^Health Advisory$/i.test(a)) { mode = 'health'; continue; }
    if (/^(Topic|Area)$/i.test(a)) { if (a === 'Topic') mode = 'changes'; continue; }
    if (mode === 'special') {
      if (row.length === 1 || !b) {
        if (/^[A-Z][A-Za-z ]+ County( \(Continued\))?$|^Carson City( \(Continued\))?$/.test(a)) { county = a.replace(/ \(Continued\)$/, '').replace(/ County$/, ''); last = null; continue; }
        if (/CLOSED WATERS\s*:/i.test(a)) { closed.push({ county, text: a.replace(/^.*?CLOSED WATERS\s*:\s*/i, '') }); continue; }
        if (last) last.notes.push(a);
        continue;
      }
      last = { name: a, aliases: aliases(a), region, county, season: b, limit: c ?? '', notes: [] };
      // "See Carson City." rows point at another county's entry for the same water.
      if (/^See\s+/i.test(b)) { const ref = waters.find(w => w.name === a); if (ref) last = { ...ref, county, notes: [...ref.notes] }; }
      waters.push(last);
    } else if (mode === 'health') {
      if (row.length === 1) continue; // "Western Region"
      if (row.length >= 3) { lastAdv = { area: a, names: aliases(a), region, fish: [[b, c]] }; advisories.push(lastAdv); }
      else if (lastAdv) lastAdv.fish.push([a, b]);
    }
  }
  // The first Lake Tahoe row only carries license notes; fold rows with no season into the next entry for that water.
  const merged = [];
  for (const w of waters) {
    const prev = merged.findLast(m => m.county === w.county && m.aliases[0] === w.aliases[0]);
    if (prev && !prev.season.replace(/^Special Regulations?:.*$/i, '')) { prev.notes.push(prev.season, ...w.notes); Object.assign(prev, { ...w, notes: prev.notes }); continue; }
    merged.push(w);
  }
  return { waters: merged, advisories, closed };
}

const SKIP = /^(Last Updated|All Regulations are applicable|NOTE: Changes)/i;
const statewideRules = (secs, url) => secs.filter(s => s.level === 2 && s.text.length && !/Protected Fish/i.test(s.title))
  .map(s => ({ title: s.title, text: s.text.filter(t => !SKIP.test(t)), url }));

// Some waters' health advisory sits only in a note under the water; turn the generic wording into an entry.
const AREAS = [[/Lahontan Valley/i, [39.47, -118.78, 25]], [/Carson River from Dayton/i, [39.3, -119.3, 30]]];

await mkdir(OUT, { recursive: true });

const pages = { statewide: 'general-statewide-regulations', western: 'western-region-regulations', southern: 'southern-region-regulations', eastern: 'eastern-region-regulations', stripers: 'new-striper-limit-on-lakes-mead-and-mohave', baitfish: 'fishing-with-bait-fish' };
const parsed = {};
for (const [k, path] of Object.entries(pages)) {
  try {
    const html = await page(path);
    const bl = blocks(html);
    parsed[k] = { url: `${BASE}/${path}`, sections: sections(bl) };
    report.pages[k] = { blocks: bl.length, outline: parsed[k].sections.map(s => `${'#'.repeat(s.level)} ${s.title} (${s.text.length}p ${s.rows.length}r)`).slice(0, 200) };
  } catch (e) { report.pages[k] = { error: e.message }; }
}

const regions = {}, waters = [], advisories = [], closed = [];
for (const [k, region] of [['western', 'Western'], ['southern', 'Southern'], ['eastern', 'Eastern']]) {
  const p = parsed[k];
  if (!p) continue;
  const t = regionTables(region, p.sections);
  waters.push(...t.waters); advisories.push(...t.advisories); closed.push(...t.closed.map(c => ({ ...c, region })));
  const general = p.sections.filter(s => /General Regulations|Daily Limits|Possession Limits|Artificial Lure|Tackle Restrictions|Bait Regulations/i.test(s.title))
    .map(s => ({ title: s.title, text: s.text.filter(x => !SKIP.test(x) && !/^Interstate Waters|^Lake Tahoe and Topaz Lake:/i.test(x)) })).filter(s => s.text.length);
  regions[region] = { url: p.url, general, intro: p.sections[0]?.text.filter(x => !SKIP.test(x)).slice(0, 3) ?? [] };
  report.pages[k].waters = t.waters.length; report.pages[k].advisories = t.advisories.length; report.pages[k].closed = t.closed.length;
}
for (const a of advisories) a.areas = AREAS.filter(([re]) => re.test(a.area)).map(([, x]) => x);
report.sampleWaters = waters.slice(0, 8);
report.advisories = advisories;

if (waters.length && parsed.statewide) {
  await writeFile(new URL('regs.json', OUT), JSON.stringify({
    updatedAt: new Date().toISOString(), source: 'Nevada Fishing Regulations (NDOW Commission Regulation), published on eRegulations', booklet: BASE,
    statewide: [...statewideRules(parsed.statewide.sections, parsed.statewide.url), ...(parsed.stripers ? [{ title: 'Striped bass, Lakes Mead and Mohave', text: parsed.stripers.sections[0].text.filter(x => !SKIP.test(x)).slice(0, 6), url: parsed.stripers.url }] : [])],
    regions, waters, closed,
  }) + '\n');
}
if (advisories.length) {
  await writeFile(new URL('advisories.json', OUT), JSON.stringify({
    updatedAt: new Date().toISOString(), source: 'Nevada Division of Public and Behavioral Health advisories, as listed in the Nevada Fishing Regulations',
    url: 'https://www.ndow.org/blog/mercury-in-fish/', advisories,
    statewide: 'Mercury builds up in older, bigger predatory fish (walleye, wipers, white bass, bass, pike). Keep smaller fish to eat, and eat fewer meals of the big ones, especially if you are pregnant or feeding kids.',
  }) + '\n');
}
await writeFile(new URL('regs-raw.json', OUT), JSON.stringify(parsed) + '\n');
report.finishedAt = new Date().toISOString();
await writeFile(new URL('regs-report.json', OUT), JSON.stringify(report, null, 1) + '\n');
console.log(JSON.stringify(Object.fromEntries(Object.entries(report.pages).map(([k, v]) => [k, v.error ?? { waters: v.waters, advisories: v.advisories, closed: v.closed }])), null, 1));
