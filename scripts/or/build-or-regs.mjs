// Weekly: Oregon fishing regulations, fish consumption advisories and angling zones for the app.
//
//   data/or/regs.json        each zone's general bag limits and seasons and the "exceptions" ODFW lists by water,
//                            plus the statewide rules, from the official Oregon Sport Fishing Regulations on eRegulations
//   data/or/advisories.json  Oregon Health Authority fish consumption advisories (mercury, PCBs) by water
//   data/or/zones.json       ODFW angling zone outlines, so the app knows which zone's rules apply to a water
//
// Run by .github/workflows/oregon-weekly.yml. Only public data.

import { writeFile, mkdir, readFile } from 'node:fs/promises';

const OUT = new URL('../../data/or/', import.meta.url);
const BASE = 'https://www.eregulations.com/oregon/fishing';
const BROWSER = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', Accept: 'text/html,application/json,*/*', 'Accept-Language': 'en-US,en;q=0.9' };
const report = { startedAt: new Date().toISOString(), pages: {} };

async function fetchText(url) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { headers: BROWSER, signal: AbortSignal.timeout(90000) });
      if (!r.ok) throw new Error(`${r.status} ${url}`);
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

// The article as blocks in order: headings, paragraphs, list items and table rows. Bold-only paragraphs are
// sub-headings (a reach of a river: "Above mainline railroad bridge").
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
      continue;
    }
    const t = clean(m[2]);
    if (!t) continue;
    const boldOnly = tag === 'p' && /^\s*<(strong|b)>[\s\S]*<\/\1>\s*$/i.test(m[2]) && t.length < 120;
    out.push({ tag: boldOnly ? 'sub' : tag, text: t });
  }
  return out;
}

// [{ title, level, text: [...], rows: [[...]] }], one per heading.
function sections(bl) {
  const out = [];
  let cur = { title: '', level: 1, text: [], rows: [] };
  for (const b of bl) {
    if (/^h\d$/.test(b.tag)) { if (cur.title || cur.text.length || cur.rows.length) out.push(cur); cur = { title: b.text, level: +b.tag[1], text: [], rows: [] }; }
    else if (b.tag === 'tr') cur.rows.push(b.cells);
    else if (b.tag === 'sub') cur.text.push(`§ ${b.text}`);
    else cur.text.push(b.text);
  }
  out.push(cur);
  return out;
}

// Names an exception heading covers: "Mill Creek and Tributaries (Wasco Co.)" → ["Mill Creek"] in Wasco County;
// "Hood River, Mainstem" → ["Hood River"]; "Davis and Wickiup Lakes" → Davis Lake, Wickiup Lake.
const WATERISH = /\b(lake|lakes|reservoir|reservoirs|pond|ponds|river|creek|slough|bay|canal|springs?|channel|marsh)\b/i;
function aliases(title) {
  const out = new Set();
  const t = title.replace(/\bIncludes?:/gi, ',').replace(/\s*\((?:[^)]*Co\.?|[^)]*County)\)/i, '').replace(/,\s*(mainstem|and tributaries|tributaries).*$/i, '').replace(/\s+and\s+(its\s+)?tributaries\b.*$/i, '');
  const both = t.match(/^(.+?) and (.+?) (Lake|Reservoir|Pond|Creek|River)s$/i);
  if (both) { out.add(`${both[1]} ${both[3]}`); out.add(`${both[2]} ${both[3]}`); }
  for (let p of t.split(/,|;|\s+and\s+|\s+&\s+|\//)) {
    p = p.replace(/^\s*(from|to|between|upstream|downstream)\b.*$/i, '').replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+(downstream|upstream|above|below|from|within|except|including|to)\b.*$/i, '').replace(/^(the|all)\s+/i, '').trim();
    if (p.length > 2 && WATERISH.test(p)) out.add(p);
  }
  // "Lake Billy Chinook" also goes by "Billy Chinook Lake" in some lists.
  for (const a of [...out]) { const m = a.match(/^Lake (.+)$/); if (m) out.add(`${m[1]} Lake`); }
  if (!out.size && t.length > 2) out.add(t.trim());
  return [...out];
}
const county = title => title.match(/\(([A-Z][a-z]+(?: [A-Z][a-z]+)?) Co(?:\.|unty)\)?/)?.[1] ?? null;

const SKIP = /^Last Updated:/i;

// A zone page: intro rules, the general regulations table, then "Exceptions to ... Zone Regulations" with one
// heading per water (rules as bullets, reaches as bold sub-headings).
function zonePage(zone, url, secs) {
  const general = [];
  let header = null;
  for (const row of secs.flatMap(s => s.rows)) {
    if (/^species$/i.test(row[0])) { header = row; continue; }
    if (header && row.length >= 2 && row[0]) general.push({ species: row[0], bag: row[1] ?? '', size: row[2] ?? '', season: row[3] ?? '' });
  }
  const exStart = secs.findIndex(s => /^exceptions/i.test(s.title));
  const intro = secs.slice(1, exStart < 0 ? secs.length : exStart).map(s => ({ title: s.title, text: s.text.filter(t => !SKIP.test(t)) })).filter(s => s.text.length);
  const waters = exStart < 0 ? [] : secs.slice(exStart + 1).filter(s => s.text.length && s.level >= 3)
    .map(s => ({ name: s.title, aliases: aliases(s.title), county: county(s.title), zone, rules: s.text }));
  return { url, general, intro, waters };
}

await mkdir(OUT, { recursive: true });

// ---------- Regulations ----------
const ZONES = { Northwest: 'northwest-zone', Southwest: 'southwest-zone', Willamette: 'willamette-zone', Central: 'central-zone', Northeast: 'northeast-zone', Southeast: 'southeast-zone', 'Snake River': 'snake-river-zone', 'Columbia River': 'columbia-river-zone' };
const zones = {}, waters = [];
let statewide = [];
try {
  const index = await fetchText(BASE);
  const links = [...new Set([...index.matchAll(/href="(?:https:\/\/www\.eregulations\.com)?\/oregon\/fishing\/([a-z0-9-]+)"/gi)].map(m => m[1]))];
  report.indexLinks = links;
  // Statewide pages: licensing, general rules, angling methods, definitions.
  const general = links.filter(l => /general|statewide|license|angling-methods|definitions|two-rod|hatchery|barbless/i.test(l) && !/zone/.test(l)).slice(0, 8);
  for (const path of general) {
    try {
      const secs = sections(blocks(await fetchText(`${BASE}/${path}`)));
      report.pages[path] = secs.map(s => `${'#'.repeat(s.level)} ${s.title} (${s.text.length}p ${s.rows.length}r)`).slice(0, 60);
      statewide.push(...secs.filter(s => s.level >= 2 && s.level <= 3).map(s => ({ title: s.title, text: s.text.filter(t => !SKIP.test(t)).slice(0, 20), url: `${BASE}/${path}` })).filter(s => s.text.length));
    } catch (e) { report.pages[path] = e.message; }
  }
} catch (e) { report.indexError = e.message; }
statewide = statewide.slice(0, 40);

for (const [zone, path] of Object.entries(ZONES)) {
  try {
    const url = `${BASE}/${path}`;
    const secs = sections(blocks(await fetchText(url)));
    const z = zonePage(zone, url, secs);
    zones[zone] = { url, general: z.general, intro: z.intro };
    waters.push(...z.waters);
    report.pages[path] = { general: z.general.length, waters: z.waters.length, outline: secs.map(s => `${'#'.repeat(s.level)} ${s.title} (${s.text.length}p ${s.rows.length}r)`).slice(0, 25), sample: z.waters.slice(0, 3) };
  } catch (e) { report.pages[path] = { error: e.message }; }
}
// A zone page that failed or came back without exceptions keeps last week's rules, so its waters aren't told
// that only the general limits apply.
let old = null;
try { old = JSON.parse(await readFile(new URL('regs.json', OUT), 'utf8')); } catch {}
for (const zone of Object.keys(ZONES)) {
  if (zones[zone]?.general.length && waters.some(w => w.zone === zone)) continue;
  report.kept = [...(report.kept ?? []), zone];
  if (old?.zones?.[zone]) { zones[zone] = old.zones[zone]; waters.push(...old.waters.filter(w => w.zone === zone)); }
}
if (!statewide.length && old?.statewide) statewide = old.statewide;
if (report.kept?.length) { report.regsError = `kept last week's rules for ${report.kept.join(', ')}`; process.exitCode = 1; }
if (waters.length) {
  await writeFile(new URL('regs.json', OUT), JSON.stringify({
    updatedAt: new Date().toISOString(), source: 'Oregon Sport Fishing Regulations (ODFW), published on eRegulations', booklet: BASE,
    updates: 'https://myodfw.com/fishing/regulation-updates', statewide, zones, waters,
  }) + '\n');
}

// ---------- Fish consumption advisories ----------
// OHA's table: zone, waterbody, contaminant, fish, meals a month for the vulnerable group and for everyone else.
try {
  const url = 'https://www.oregon.gov/oha/ph/healthyenvironments/recreation/fishconsumption/pages/fishadvisories.aspx';
  const html = await fetchText(url);
  const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(m => [...m[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => clean(c[1])));
  report.advisoryRows = rows;
  const advisories = [];
  let zone = '', last = null;
  // Link labels that sit in the waterbody cell.
  const LINKS = /\s*(Press release|Fact ?sheet|Technical report:?|Frequently asked questions|Information OHA used to warrant a statewide advisory|Meal guidance|Map)\b.*$/gi;
  let prev = { contaminant: '', fish: '' }, started = false;
  for (const r of rows) {
    if (/^zone$/i.test(r[0]) || /MEALS PER MONTH/.test(r.join(' '))) { if (started && /^zone$/i.test(r[0])) break; continue; }
    // A one-cell row is the note under the table; the shellfish tables after it are a different shape.
    if (r.length === 1) { if (started) break; continue; }
    started = true;
    // Cells span rows, so rows have 2 to 6 cells. Read from the right: meals a month (two numbers, or one merged
    // cell such as "Fillet only - 1 Whole body - 0"), then fish, contaminant, water and zone as far as they go.
    const two = r.length >= 3 && /^\d+$/.test(r.at(-1)) && /^\d+$/.test(r.at(-2));
    const meals = two ? r.slice(-2) : [r.at(-1), r.at(-1)];
    let rest = r.slice(0, two ? -2 : -1);
    const isZone = rest.length >= 4 && rest[0] === rest[0].toUpperCase() && /[A-Z]/.test(rest[0]);
    if (isZone) { zone = rest[0].replace(/\b([A-Z])([A-Z]+)\b/g, (m, a, b) => a + b.toLowerCase()); rest = rest.slice(1); }
    // One cell left: another fish for the same water, or another water sharing the row above's contaminant and fish.
    const one = rest.length === 1 && WATERISH.test(rest[0]);
    const [rawWater, contaminant, fish] = rest.length >= 3 ? rest : rest.length === 2 ? [last?.area ?? '', ...rest] : one ? [rest[0], prev.contaminant, prev.fish] : [last?.area ?? '', prev.contaminant, rest[0]];
    const [vulnerable, everyone] = meals;
    prev = { contaminant, fish };
    const water = rawWater.replace(LINKS, '').replace(/\s+,/g, ',').replace(/\s+/g, ' ').trim();
    if (!water || /coast/i.test(zone) && /clam/i.test(water)) continue;
    if (last && last.area === water) last.fish.push({ fish, contaminant, vulnerable, everyone });
    else { last = { zone, area: water, names: aliases(water.replace(/\s*Does not apply to:.*$/i, '')), fish: [{ fish, contaminant, vulnerable, everyone }] }; advisories.push(last); }
  }
  report.advisories = advisories.map(a => `${a.zone}: ${a.area} → ${a.names.join(' | ')} (${a.fish.length})`);
  if (advisories.length) {
    const bass = advisories.find(a => /statewide|all state/i.test(`${a.zone} ${a.area}`));
    await writeFile(new URL('advisories.json', OUT), JSON.stringify({
      updatedAt: new Date().toISOString(), source: 'Oregon Health Authority fish advisories', url,
      advisories: advisories.filter(a => a !== bass),
      statewide: bass ? `Statewide advisory for bass (mercury): ${bass.fish[0].vulnerable} meals a month for children, and people who are pregnant or nursing; ${bass.fish[0].everyone} for everyone else.` : 'Oregon has a statewide mercury advisory for bass.',
      meal: 'A meal is about the size and thickness of your hand, or 1 ounce of uncooked fish for every 20 pounds of body weight.',
    }) + '\n');
  }
} catch (e) { report.advisoryError = e.message; }

// ---------- Angling zones ----------
try {
  const params = new URLSearchParams({ where: '1=1', outFields: 'Zone', outSR: '4326', maxAllowableOffset: '0.005', geometryPrecision: '4', f: 'geojson' });
  const r = await fetch(`https://nrimp.dfw.state.or.us/arcgis/rest/services/ODFW_Regs/AnglingZones/MapServer/0/query?${params}`, { headers: BROWSER, signal: AbortSignal.timeout(90000) });
  if (!r.ok) throw new Error(`${r.status} angling zones`);
  const gj = await r.json();
  const out = (gj.features ?? []).map(f => {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    const pts = polys.flat(2);
    return { name: String(f.properties.Zone ?? f.properties.ZONE ?? '').replace(/\s*Zone$/i, ''), bbox: [Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1])), Math.max(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1]))], polys };
  }).filter(z => z.name);
  report.zones = out.map(z => `${z.name}: ${z.polys.length} parts`);
  if (out.length) await writeFile(new URL('zones.json', OUT), JSON.stringify({ updatedAt: new Date().toISOString(), source: 'ODFW angling zones (nrimp.dfw.state.or.us)', zones: out }) + '\n');
} catch (e) { report.zonesError = e.message; }

// ---------- Counties ----------
// So the app (and the nightly job) can tell which county a water is in: some exceptions name the county.
try {
  const params = new URLSearchParams({ where: "STATE='41'", outFields: 'BASENAME', outSR: '4326', maxAllowableOffset: '0.004', f: 'geojson' });
  const r = await fetch(`https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1/query?${params}`, { signal: AbortSignal.timeout(90000) });
  if (!r.ok) throw new Error(`${r.status} TIGERweb`);
  const r4 = n => +n.toFixed(4);
  const counties = (await r.json()).features.map(f => {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    const pts = polys.flat(2);
    return { name: f.properties.BASENAME, bbox: [Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1])), Math.max(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1]))].map(r4),
      polys: polys.map(poly => poly.map(ring => ring.map(([x, y]) => [r4(x), r4(y)]))) };
  });
  report.counties = counties.length;
  if (counties.length) await writeFile(new URL('counties.json', OUT), JSON.stringify({ updatedAt: new Date().toISOString(), source: 'US Census TIGERweb', counties }) + '\n');
} catch (e) { report.countiesError = e.message; }

report.finishedAt = new Date().toISOString();
await writeFile(new URL('regs-report.json', OUT), JSON.stringify(report, null, 1) + '\n');
console.log(JSON.stringify({ ...report, pages: Object.fromEntries(Object.entries(report.pages).map(([k, v]) => [k, v.error ?? (Array.isArray(v) ? v.length : { general: v.general, waters: v.waters })])) }, null, 1).slice(0, 8000));
