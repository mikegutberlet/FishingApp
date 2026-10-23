// California inland sport fishing regulations, from Title 14 of the California Code of Regulations as published
// by Cornell's Legal Information Institute (law.cornell.edu, updated quarterly from the official code).
// Runs weekly (see .github/workflows/build-safety.yml).
//
//   data/ca/regs.json      { statewide: [{ sec, title, url, text: [paragraphs] }],
//                            waters: [{ sec, ref, name, aliases, counties, water: 'lake'|'stream'|null, tributariesOnly, scope, parts: [{ where, season, size, bag }] }] }
//   data/ca/counties.json  simplified county outlines (US Census TIGERweb), so the app can tell which county a water is in.
//
// Water-specific rules come from the special regulations tables: 7.50 (trout), 7.40 (hatchery trout, steelhead
// and salmon), 5.00(b) (black bass) and 5.15 (catfish). If the site is down, the old files are kept.

import { writeFile, mkdir } from 'node:fs/promises';

const OUT = new URL('../data/ca/', import.meta.url);
const UA = { 'User-Agent': 'TackleBox-fishing-app (personal, github.com/mikegutberlet/FishingApp)' };
const LII = sec => `https://www.law.cornell.edu/regulations/california/14-CCR-${sec}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
export const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&rsquo;/g, "'").replace(/\s+/g, ' ').trim();

// LII answers 503 when asked too quickly, so pages are fetched slowly with backoff.
async function page(sec) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    await sleep(attempt === 1 ? 4000 : 30000 * attempt);
    try {
      const r = await fetch(LII(sec), { headers: UA, signal: AbortSignal.timeout(60000) });
      if (r.ok) { const h = await r.text(); return h.slice(h.indexOf('<h1')); }
      if (r.status === 404) return null;
      console.error(`${sec}: ${r.status}`);
    } catch (e) { console.error(`${sec}: ${e.message}`); }
  }
  throw new Error(`Could not fetch section ${sec}`);
}

const titleOf = body => text(body.slice(0, body.indexOf('</h1>'))).replace(/^.*?§\s*[\d.]+\s*-\s*/, '');
// The regulation text: after the title, before LII's history notes. Split into one paragraph per subsection.
function paragraphs(body, { beforeTable = true } = {}) {
  let html = body.slice(body.indexOf('</h1>'));
  if (beforeTable && html.includes('<table')) html = html.slice(0, html.indexOf('<table'));
  const t = text(html).replace(/^State Regulations Compare\s*/, '').replace(/\s*Notes Cal\. Code Regs\.[\s\S]*$/, '');
  return t.split(/(?<=[.:;])\s(?=\((?:[a-z]|\d+)\)\s)/).map(s => s.trim()).filter(Boolean); // a new subsection, not "Sections 7.40 (b) and ..."
}
const rowsOf = body => [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(([, row]) => [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m => text(m[1])));

const COUNTIES = ['Alameda', 'Alpine', 'Amador', 'Butte', 'Calaveras', 'Colusa', 'Contra Costa', 'Del Norte', 'El Dorado', 'Fresno', 'Glenn', 'Humboldt', 'Imperial', 'Inyo', 'Kern',
  'Kings', 'Lake', 'Lassen', 'Los Angeles', 'Madera', 'Marin', 'Mariposa', 'Mendocino', 'Merced', 'Modoc', 'Mono', 'Monterey', 'Napa', 'Nevada', 'Orange', 'Placer', 'Plumas',
  'Riverside', 'Sacramento', 'San Benito', 'San Bernardino', 'San Diego', 'San Francisco', 'San Joaquin', 'San Luis Obispo', 'San Mateo', 'Santa Barbara', 'Santa Clara',
  'Santa Cruz', 'Shasta', 'Sierra', 'Siskiyou', 'Solano', 'Sonoma', 'Stanislaus', 'Sutter', 'Tehama', 'Trinity', 'Tulare', 'Tuolumne', 'Ventura', 'Yolo', 'Yuba'];

// "Isabella Lake (Lake Isabella, Kern Co.)." → name, aliases, counties, kind of water, and whether only tributaries are meant.
export function describe(raw) {
  const s = raw.replace(/^\(\d+(?:\.\d+)?\)\s*/, '').replace(/\s*\(?Also see.*$/i, '');
  const counties = [], aliases = [];
  for (const [, inside] of s.matchAll(/\(([^()]*)\)/g)) {
    const county = /\bCos?\b\.?/.test(inside);
    for (let tok of inside.split(/,|\band\b/)) {
      tok = tok.replace(/\bCos?\b\.?|\.$/g, '').trim();
      tok = tok.replace(/\.$/, '');
      if (county && COUNTIES.includes(tok)) counties.push(tok);
      else if (/\b(lake|reservoir)\b/i.test(tok) || (!county && tok)) aliases.push(tok);
    }
  }
  let name = s.replace(/\([^()]*\)/g, ' ').replace(/\s*Cos?\.\)|\s+/g, ' ').split(/\.\s|\s(?:from|above|below|upstream|downstream|within|between|except|excluding|including|in the|at the|arising)\s|,/)[0].trim().replace(/\.$/, '');
  const tributariesOnly = /\b(lake|reservoir)\s+tributaries\b/i.test(name);
  name = name.replace(/^Non-anadromous\s+tributaries\s+of\s+(the\s+)?/i, '').replace(/\s+(and\s+)?((all\s+)?(its|their)\s+|all\s+)?(tributary|tributaries)\b.*$/i, '').trim();
  const water = /\b(lake|lakes|reservoir|pond|pool|lagoon)\b/i.test(name) ? 'lake' : /\b(river|creek|stream|slough|canal|fork|channel|outfall|complex)\b/i.test(name) ? 'stream' : null;
  return { name, aliases: aliases.filter(a => a.length > 2), counties: [...new Set(counties)], water, tributariesOnly };
}

// Special regulations tables: a numbered row starts a water; following rows are its sections or extra seasons.
export function specialTable(sec, rows, cols) {
  const out = [];
  let cur = null, part = null;
  for (const cells of rows) {
    const [first = '', ...rest] = cells;
    if (/body of water|district\/water|area or body/i.test(first) || cells.every(c => !c)) continue;
    const vals = Object.fromEntries(cols.map((c, i) => [c, rest[i] ?? '']));
    const num = first.match(/^\((\d+(?:\.\d+)?)\)\s*(.*)$/);
    if (num) {
      if (/\[Repealed\]/i.test(num[2])) { cur = null; continue; }
      cur = { sec, ref: `(b)(${num[1]})`, ...describe(first), text: num[2], parts: [] };
      out.push(cur);
      part = null;
      if (cols.some(c => vals[c])) cur.parts.push(part = { where: '', ...vals });
    } else if (!cur) continue;
    else if (first) cur.parts.push(part = { where: first, ...vals });
    else if (part && !vals[cols[0]] && cols.slice(1).some(c => vals[c])) for (const c of cols.slice(1)) part[c] = [part[c], vals[c]].filter(Boolean).join(' '); // e.g. "Closed to the take of Chinook Salmon"
    else if (cols.some(c => vals[c])) cur.parts.push(part = { where: part?.where ?? '', ...vals, cont: true });
  }
  return out;
}

// 5.15 catfish: county (or district) headings, then one water per row with its bag limit. "All waters" rows apply area-wide.
export function catfishTable(rows) {
  const out = [];
  let county = null, district = false;
  for (const cells of rows) {
    const [num = '', what = '', bag = ''] = cells;
    if (/body or bodies/i.test(what) || !what) continue;
    const heading = what.match(/^([A-Z][\w .]+?) County:\s*(.*)$/);
    if (num) { county = heading?.[1] ?? null; district = !heading && /district/i.test(what); }
    if (!bag) continue;
    const name = (heading ? heading[2] : what).replace(/\.$/, '');
    const areaWide = !name || /^all waters|^also see/i.test(name);
    out.push({ sec: '5.15', ref: `(b)${num}`, name: areaWide ? '' : name, aliases: [], counties: county ? [county] : [], water: /lake|reservoir|pond/i.test(name) ? 'lake' : null,
      tributariesOnly: false, scope: district ? 'district' : areaWide ? 'county' : 'water', text: `${county ? `${county} County: ` : ''}${heading ? heading[2] || 'All waters' : what}`,
      parts: [{ where: '', species: 'Catfish', bag: `${bag} catfish` }] });
  }
  return out;
}

const STATEWIDE = [['5.85', 'all'], ['5.84', 'all'], ['5.00', 'all'], ['5.82', 'all'], ['5.15', 'all'], ['5.75', 'all'], ['5.80', 'all'], ['5.90', 'all'], ['5.91', 'all'],
  ['5.65', 'all'], ['5.95', 'all'], ['2.00', 'all'], ['2.10', 'stream'], ['7.00', 'stream']];

async function build() {
  const pages = {};
  for (const sec of new Set([...STATEWIDE.map(s => s[0]), '7.50', '7.40'])) pages[sec] = await page(sec);
  const statewide = STATEWIDE.filter(([sec]) => pages[sec]).map(([sec, applies]) => {
    let text = paragraphs(pages[sec]);
    if (sec === '7.00') text = text.slice(0, 2); // long anadromous district rules: show the gist and link out
    return { sec, title: titleOf(pages[sec]), applies, url: LII(sec), text };
  });
  const waters = [
    ...specialTable('7.50', rowsOf(pages['7.50']), ['season', 'bag']),
    ...specialTable('7.40', rowsOf(pages['7.40']), ['season', 'bag']),
    ...specialTable('5.00', rowsOf(pages['5.00']), ['season', 'size', 'bag']).map(w => {
      const area = w.text.match(/^([\w .]+?) (Co\.|District):/);
      const water = /all streams/i.test(w.text) && !/lakes/i.test(w.text) ? 'stream' : /all lakes/i.test(w.text) && !/streams/i.test(w.text) ? 'lake' : null;
      return { ...w, species: 'Black bass', ...(area && { scope: area[2] === 'Co.' ? 'county' : 'district', name: '', counties: area[2] === 'Co.' ? [area[1]] : [], water }) };
    }),
    ...catfishTable(rowsOf(pages['5.15'])),
  ].map(w => ({ scope: 'water', ...w }));
  const counts = Object.fromEntries(['7.50', '7.40', '5.00', '5.15'].map(s => [s, waters.filter(w => w.sec === s).length]));
  if (counts['7.50'] < 100 || counts['7.40'] < 50) throw new Error(`Only parsed ${JSON.stringify(counts)} special regulation waters; page layout may have changed`);
  return { statewide, waters, counts };
}

// County outlines, simplified to ~1 km, for point-in-county lookups in the app.
async function counties() {
  const q = new URLSearchParams({ where: "STATE='06'", outFields: 'BASENAME', returnGeometry: 'true', outSR: '4326', maxAllowableOffset: '0.01', geometryPrecision: '3', f: 'geojson' });
  const r = await fetch(`https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1/query?${q}`, { headers: UA, signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error(`${r.status} tigerweb`);
  const gj = await r.json();
  const list = gj.features.map(f => {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    const pts = polys.flat(2);
    return { name: f.properties.BASENAME, bbox: [Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1])), Math.max(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1]))], polys };
  });
  if (list.length !== 58) throw new Error(`Expected 58 California counties, got ${list.length}`);
  return list;
}

await mkdir(OUT, { recursive: true });
let failed = 0;
try {
  const { statewide, waters, counts } = await build();
  await writeFile(new URL('regs.json', OUT), JSON.stringify({ updatedAt: new Date().toISOString(), source: 'California Code of Regulations, Title 14 (via Cornell LII)', booklet: 'https://wildlife.ca.gov/Regulations', statewide, waters }) + '\n');
  console.log(`regs: ${statewide.length} statewide sections, waters ${JSON.stringify(counts)}`);
  for (const w of waters.filter(w => w.sec === '7.50').slice(0, 40)) console.log(`  ${w.ref} ${w.name} | ${w.aliases.join('/')} | ${w.counties.join(',')} | ${w.water} ${w.tributariesOnly ? 'tribs' : ''} | ${w.parts.length} parts`);
} catch (e) { failed++; console.error('regs failed:', e.message); }
try {
  const list = await counties();
  await writeFile(new URL('counties.json', OUT), JSON.stringify({ updatedAt: new Date().toISOString(), source: 'US Census TIGERweb', counties: list }) + '\n');
  console.log(`counties: ${list.length}`);
} catch (e) { failed++; console.error('counties failed:', e.message); }
if (failed === 2) process.exit(1);
