// The fish each agency's own lists name for a water, for the finder, the map's fish filter and the "What's in here"
// list on a water's Stocking tab. Runs monthly (.github/workflows/build-species.yml); the sources change slowly.
//
//   node scripts/build-species.mjs [ca] [nv] [or]        (no state: all three)
//   data/<st>/species.json  { updatedAt, sources: [{ label, url }], fish: { "<key>": [[name, how, source, note], …] } }
//     key     n:<id in lakes.json> or s:<id in waters.json> (the app's pool key without the state)
//   data/or/lakes-extra.json  { updatedAt, source, lakes: [{ id, name, type, lat, lon, acres: null }] }: the lakes
//     Oregon's maps name that lakes.json (the national list's named lakes) doesn't. The app reads them with the
//     lake list (states/common.js), so they are waters like any other, keyed n:<id>.
//     name    the app's name for the fish (species.js) when it is one it knows, else the agency's name
//     how     "plan"   the state plans to stock it this year      (California's provisional stocking document)
//             "lives"  the state lists it as living in the water  (Nevada's fishable waters, Oregon's distribution maps)
//             "caught" an angler's catch is on the state's books  (Nevada's record-fish book)
//     source  index into sources
//     note    a few words of fact: size class and months, wild or hatchery, the record weight and year
//
// Sources, all public agency data read as facts:
//   CA  CDFW Provisional Stocking Document for Trout and Inland Salmon (a PDF, read with pdftotext from poppler-utils),
//       tied to the app's stocked waters through the water ids in CDFW's planting-schedule layer (BIOS ds2897)
//   NV  NDOW "Fishable Waters" map layers (fish codes per lake and stream) and the record-fish table kept in
//       scripts/species/nv-record-fish.json (from NDOW's Trophy Fish Book; refreshed by hand when a new edition is out)
//   OR  ODFW Fish Habitat Distribution, the lake layers (one per species, with wild or hatchery origin)
//
// A record is tied to a water by name and place: the same name within a few km, or (where the record has no map
// point) a name that is one place in the state. A state whose source fails keeps its old file.

import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { nameKey } from '../name-key.js';
import { speciesName, isCatchAll } from '../species.js';
import { haversineKm } from '../data-sources.js';
import { lakeNames, lakePlaces, lakesLike } from './ca-lake-names.mjs';
import { STATES, inOutline } from './states.mjs';

const run = promisify(execFile);
const DATA = new URL('../data/', import.meta.url);
const UA = { 'User-Agent': process.env.SPECIES_UA || 'TackleBox-fishing-app (personal, github.com/mikegutberlet/FishingApp)', Accept: '*/*' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJson = async url => JSON.parse(await readFile(url, 'utf8'));

export async function get(url, { type = 'json', tries = 3, timeout = 120000 } = {}) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeout) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      if (type === 'buffer') return Buffer.from(await r.arrayBuffer());
      const j = await r.json();
      if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 160));
      return j;
    } catch (e) {
      if (i >= tries) throw new Error(`${url.slice(0, 120)}: ${e.message}`);
      await sleep(2000 * i);
    }
  }
}

// Every row of an ArcGIS layer: its attributes plus a point on it (the middle of its outline's box, or of its line).
async function arcRows(url, { where = '1=1', fields = '*', step = 500 } = {}) {
  const out = [];
  for (let off = 0; off < 100000;) {
    const q = new URLSearchParams({ where, outFields: fields, returnGeometry: 'true', outSR: '4326', geometryPrecision: '4', maxAllowableOffset: '0.002', f: 'json', resultOffset: off, resultRecordCount: step });
    const j = await get(`${url}/query?${q}`);
    for (const f of j.features ?? []) out.push({ ...f.attributes, ...pointOf(f.geometry) });
    if (!j.features?.length || !j.exceededTransferLimit) break;
    off += j.features.length;
  }
  return out;
}
export function pointOf(g) {
  if (g?.x != null) return { lat: +g.y.toFixed(5), lon: +g.x.toFixed(5) };
  // A stream: the middle vertex of its longest line, so the point is on the water.
  if (g?.paths?.length) { const p = [...g.paths].sort((a, b) => b.length - a.length)[0], [x, y] = p[Math.floor(p.length / 2)]; return { lat: +y.toFixed(5), lon: +x.toFixed(5) }; }
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const ring of g?.rings ?? []) for (const [x, y] of ring) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  return x0 === Infinity ? { lat: null, lon: null } : { lat: +((y0 + y1) / 2).toFixed(5), lon: +((x0 + x1) / 2).toFixed(5) };
}

// ---------- Names ----------
const sentence = s => { const t = String(s).trim().replace(/\s+/g, ' ').toLowerCase(); return t.charAt(0).toUpperCase() + t.slice(1); };
// The states' own spellings that the list would read as something else.
const FIXES = [[/^(.+?),\s*(.+)$/, '$2 $1'], [/\(lake\)/i, ''], [/rainbow\s*x\s*cutthroat.*/i, 'Cutbow trout'], [/white\s*x\s*striped.*/i, 'Wiper'], [/^hybrid bass$/i, 'Wiper'],
  [/^(fall|spring) chinook$/i, 'Chinook salmon'], [/^(summer|winter) steelhead$/i, 'Steelhead'], [/^coho$/i, 'Coho salmon'], [/^sockeye$/i, 'Sockeye salmon'], [/^carp$/i, 'Common carp'], [/^bullhead catfish$/i, 'Bullhead'], [/whate crappie/i, 'White crappie']];
// A fish's name for the list: the app's own name for it ("Bass, Largemouth" → "Largemouth bass", "Mackinaw Trout" →
// "Lake trout"), or the agency's name where the app's would only be a catch-all ("Bullhead"). Null for a fish the
// app's list doesn't carry: the suckers, chubs, sculpins and minnows a distribution map also draws.
const NOT_LISTED = /pikeminnow|squawfish|sucker|sculpin|lamprey|minnow|peamouth|chiselmouth|dace\b|goby/i;
export function listName(raw) {
  let s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  for (const [re, to] of FIXES) s = s.replace(re, to).trim();
  const n = s && !NOT_LISTED.test(s) ? speciesName(s) : null;
  if (!n) return null;
  return isCatchAll(n) && n.toLowerCase() !== s.toLowerCase() ? sentence(s) : n;
}

// ---------- Tying a record to the app's waters ----------
const SMALL = /^(lake|lakes|reservoir|pond|ponds|creek|river|fork|the|upper|lower|big|little|north|south|east|west|middle|and|of)$/;
const words = s => new Set(String(s ?? '').toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(x => x.length > 2 && !SMALL.test(x)));
export const shareWord = (a, b) => { const A = words(a); return [...words(b)].some(x => A.has(x)); };

// Every lake and stocked water as a point to match against. Stocked waters with no map point are kept: a record
// can still reach them by name.
export function pointsFor(lakes, stocked) {
  const pt = (key, w) => {
    const county = String(w.county ?? w.counties ?? '').toLowerCase(), k = nameKey(w.name);
    // A water the state lists by reach or by county also answers to its plain name: "Lake Tahoe – Cave Rock",
    // "Humboldt River, Elko".
    const base = nameKey(String(w.name ?? '').split(/\s+[–—-]\s+/)[0].replace(/,\s*([a-z ]+)$/i, (m, c) => c.toLowerCase() === county ? '' : m));
    return { key, name: w.name ?? null, k, base: base && base !== k ? base : null, lat: w.lat ?? null, lon: w.lon ?? null, county, acres: w.acres ?? null };
  };
  return [...lakes.filter(w => w.lat != null).map(w => pt(`n:${w.id}`, w)), ...stocked.map(w => pt(`s:${w.id}`, w))];
}

// find(record, opts) → the keys of the waters a record { name, lat, lon, county } is about.
//   With a map point: waters of the same name within nameKm or in the record's county, and (nearKm) differently named waters that close
//   which share a telling word ("Wild Horse Reservoir" and "Wildhorse Res." don't, "Topaz Lake" and "Topaz Res." do).
//   A big lake answers to a kindred name from farther out: up to twice the radius of a round lake of its size
//   ("Billy Chinook Reservoir" is drawn 4 km from the app's point for Lake Billy Chinook).
//   on: when nothing of its name is near, the water the record's point lies on (within 300 m of its point, or
//   inside a round lake of its size), whatever that water is called: a renamed lake, or a name spelled another way.
//   Without one: waters of that name in the record's county, or, with no county either, a name that is one place
//   (every located water of that name within 10 km of the others).
export function matcher(points) {
  const byName = new Map();
  for (const p of points) for (const k of [p.k, p.base]) if (k) (byName.get(k) ?? byName.set(k, []).get(k)).push(p);
  const km = (p, r) => haversineKm(p.lat, p.lon, r.lat, r.lon);
  const inCounty = (p, county) => p.county.split(/,| and /).some(c => c.trim().replace(/ county$/, '') === county);
  const onePlace = list => { const at = list.filter(p => p.lat != null); return at.every(a => at.every(b => km(a, b) <= 10)); };
  const ownKm = p => Math.sqrt((p.acres ?? 0) * 0.0040469 / Math.PI); // the radius of a round lake of its size
  return function find(rec, { nameKm = 15, nearKm = 0, unique, on = false } = {}) {
    const k = nameKey(rec.name), same = (k && byName.get(k)) || [], county = String(rec.county ?? '').trim().toLowerCase().replace(/ county$/, '');
    if (rec.lat == null) {
      if (county) return same.filter(p => inCounty(p, county)).map(p => p.key);
      return onePlace(same) ? same.map(p => p.key) : [];
    }
    // Close by, or anywhere in the record's own county (a river's point can be far along it from the app's).
    const hits = same.filter(p => p.lat != null && (km(p, rec) <= nameKm || (county && inCounty(p, county) && km(p, rec) <= 150)));
    // A stocked water of that name with no map point: only when the name is one place in the app's lists, and the
    // caller hasn't said the source has several waters of that name (unique: false).
    const loose = unique === false ? [] : same.filter(p => p.lat == null && (hits.length || !same.some(q => q.lat != null)) && onePlace(same));
    const near = nearKm ? points.filter(p => p.lat != null && p.k !== k && p.base !== k && Math.abs(p.lat - rec.lat) < 0.2 && km(p, rec) <= Math.max(nearKm, 2 * ownKm(p)) && shareWord(p.name, rec.name)) : [];
    const found = [...new Set([...hits, ...loose, ...near].map(p => p.key))];
    if (found.length || !on) return found;
    const at = points.filter(p => p.lat != null && Math.abs(p.lat - rec.lat) < 0.2 && km(p, rec) <= Math.max(0.3, ownKm(p))).sort((a, b) => km(a, rec) - km(b, rec))[0];
    return at ? [at.key] : [];
  };
}

// fish: { key: [[name, how, source, note]] }, one row per fish and how it is known; a later note doesn't replace one.
// candidates [{ name, … }] from a lake list, searched by a word of a planned water's name → the ones that are that
// water under another form of its name: the same telling words once lake, reservoir, upper, lower, new and plurals
// are set aside ("Bowman Reservoir" is "Bowman Lake", "Bullards Bar Reservoir" is "New Bullards Bar Reservoir").
// "Little" and "Big" stay: Little Walker Lake isn't Walker Lake. None when the name is a stream's, or when the
// candidates left are different waters: other names, or one name in places more than 5 km apart.
export function kinOf(planName, candidates) {
  const tell = s => [...words(String(s).replace(/\bnew\b/gi, ' ')), ...(String(s).toLowerCase().match(/\b(little|big)\b/g) ?? [])].map(w => w.replace(/s$/, '')).sort().join(' ');
  if (FLOWING.test(planName) && !STILL.test(planName)) return [];
  const mine = tell(planName), kin = mine ? candidates.filter(c => tell(c.name) === mine) : [];
  const onePlace = kin.every(c => c.lat == null || kin[0].lat == null || haversineKm(c.lat, c.lon, kin[0].lat, kin[0].lon) <= 5);
  return new Set(kin.map(c => nameKey(c.name))).size === 1 && onePlace ? kin : [];
}

// The lakes a state's maps name that the app has no water for, as waters to add: one per place (records of one name
// within 2 km; a second name for the same spot adds nothing), inside the state's outline, and not the creeks, springs
// and bays such maps also draw as lake shapes. A name the state has since retired isn't added either: that lake is
// on the national list under its new name.
// → [{ id: "<prefix>-<name>-<lat><lon>", name, type, lat, lon, acres: null }], sorted by id
const STILL = /\b(lakes?|reservoir|ponds?|pool|pit|helipond)\b/i, FLOWING = /\b(creek|river|springs?|slough|trib|bay|fork)\b/i, RETIRED = /\bsquaw\b/i;
export function extraLakes(records, outline, prefix) {
  const places = [];
  for (const r of records) {
    const name = String(r.name ?? '').replace(/\s+/g, ' ').trim(), k = nameKey(name);
    if (!k || r.lat == null || RETIRED.test(name) || (FLOWING.test(name) && !STILL.test(name))) continue;
    const place = places.find(p => p.k === k && haversineKm(p.pts[0].lat, p.pts[0].lon, r.lat, r.lon) <= 2);
    if (place) place.pts.push(r);
    else if (!places.some(p => haversineKm(p.pts[0].lat, p.pts[0].lon, r.lat, r.lon) <= 0.3)) places.push({ k, name, pts: [r] });
  }
  const mean = (pts, f) => +(pts.reduce((sum, p) => sum + p[f], 0) / pts.length).toFixed(5);
  return places.map(p => ({ k: p.k, name: p.name, lat: mean(p.pts, 'lat'), lon: mean(p.pts, 'lon') }))
    .filter(p => inOutline([p.lon, p.lat], outline))
    .map(p => ({ id: `${prefix}-${p.k}-${Math.round(p.lat * 100)}${Math.round(Math.abs(p.lon) * 100)}`.replace(/(\d{4})(\d{5})$/, '$1-$2'), name: p.name, type: /\bponds?\b|helipond|\bpit\b|\bpool\b/i.test(p.name) ? 'Pond' : /reservoir/i.test(p.name) ? 'Reservoir' : 'Lake', lat: p.lat, lon: p.lon, acres: null }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

function adder(fish) {
  return (keys, name, how, source, note = '') => {
    if (!name) return 0;
    for (const key of keys) { const rows = fish[key] ??= []; if (!rows.some(r => r[0] === name && r[1] === how)) rows.push(note ? [name, how, source, note] : [name, how, source]); }
    return keys.length;
  };
}

// ---------- Nevada ----------
const FISHABLE = 'https://services.arcgis.com/RyxlXSfFi87rAosq/ArcGIS/rest/services/NDOWFishableWaters/FeatureServer';
// NDOW publishes no key to its codes. These were worked out from the waters each appears on and checked against the
// record-fish book (walleye at every "WP" water, wiper at every "WI" water, and so on).
export const NV_CODES = { RB: 'Rainbow trout', BK: 'Brook trout', BN: 'Brown trout', CT: 'Cutthroat trout', TT: 'Tiger trout', BC: 'Cutbow trout', BT: 'Bull trout', MT: 'Lake trout', KS: 'Kokanee', W: 'Mountain whitefish',
  LMB: 'Largemouth bass', SMB: 'Smallmouth bass', SB: 'Spotted bass', STB: 'Striped bass', WB: 'White bass', WI: 'Wiper', CC: 'Channel catfish', WC: 'White catfish', BB: 'Bullhead', CR: 'Crappie', WCR: 'White crappie',
  BG: 'Bluegill', GS: 'Green sunfish', RS: 'Redear sunfish', PS: 'Pumpkinseed', YP: 'Yellow perch', SP: 'Sacramento perch', WP: 'Walleye', NP: 'Northern pike' };
// "Carson River - E.F.", "LITTLE HUMBOLDT RIVER, S.F." → "…, East Fork", as the app's list writes a fork.
const FORK = { N: 'North', S: 'South', E: 'East', W: 'West', M: 'Middle' };
export const nvName = name => String(name ?? '').trim().replace(/\s*[-,]\s*([NSEWM])\.?\s*F\.?$/i, (m, d) => `, ${FORK[d.toUpperCase()]} Fork`).replace(/\bRESEVOIR\b/i, 'Reservoir');
// A row's fish codes (FISH1 … FISH11, FISH4_), in the layer's order, each once.
export const nvCodes = row => [...new Set(Object.keys(row).filter(k => /^FISH\d+_?$/.test(k)).sort((a, b) => parseInt(a.slice(4)) - parseInt(b.slice(4))).map(k => String(row[k] ?? '').trim().toUpperCase()).filter(Boolean))];
export const recordNote = ([, lbs, oz, year]) => `record ${lbs ? `${lbs} lb ` : ''}${oz || !lbs ? `${oz} oz` : ''}`.trim() + (year ? `, ${year}` : '');

async function nevada(find) {
  const fish = {}, add = adder(fish), report = { unknownCodes: {}, unmatched: [] };
  const sources = [{ label: 'NDOW Fishable Waters map layers', url: FISHABLE }];
  let rows = 0, tied = 0;
  for (const [layer, opts] of [[1, { nameKm: 15, nearKm: 3 }], [0, { nameKm: 30 }]]) {
    const list = await arcRows(`${FISHABLE}/${layer}`);
    if (list.length < (layer ? 80 : 250)) throw new Error(`NDOW fishable waters layer ${layer}: only ${list.length} rows`);
    const times = new Map(); for (const r of list) times.set(nameKey(nvName(r.NAME)), (times.get(nameKey(nvName(r.NAME))) ?? 0) + 1);
    for (const r of list) {
      const keys = find({ name: nvName(r.NAME), lat: r.lat, lon: r.lon, county: r.COUNTY_NAM }, { ...opts, unique: times.get(nameKey(nvName(r.NAME))) === 1 });
      rows++; if (keys.length) tied++; else report.unmatched.push(String(r.NAME).trim());
      for (const c of nvCodes(r)) NV_CODES[c] ? add(keys, listName(NV_CODES[c]), 'lives', 0) : report.unknownCodes[c] = (report.unknownCodes[c] ?? 0) + 1;
    }
  }
  report.fishable = `${tied} of ${rows} NDOW rows tied to a water`;
  const book = await readJson(new URL('species/nv-record-fish.json', import.meta.url));
  sources.push({ label: book.label, url: book.url });
  let waters = 0;
  for (const [name, recs] of Object.entries(book.waters)) {
    const keys = find({ name: name.replace(/\bMtn\b/g, 'Mountain') });
    if (keys.length) waters++;
    for (const rec of recs) add(keys, listName(rec[0]), 'caught', 1, recordNote(rec));
  }
  report.records = `${waters} of ${Object.keys(book.waters).length} record-book waters tied to a water`;
  return { sources, fish, report };
}

// ---------- California ----------
const CDFW = 'https://services2.arcgis.com/Uq9r85Potqm3MfRV/arcgis/rest/services';
const PLAN_URL = 'https://nrm.dfg.ca.gov/FileHandler.ashx?DocumentID=74004&inline';
const unescape = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");

// The stocking document's table, from `pdftotext -bbox` (every word with its place on the page): one row per
// region line, cells joined from the words that sit in each column. Columns are found from the six widest empty
// strips down the page, since a long water name wraps inside its cell.
//   → { year, rows: [{ region, county, water, species, size, program, months }] }
export function parsePlan(bbox) {
  const rows = [];
  const year = +(unescape(bbox.replace(/<[^>]+>/g, ' ')).match(/(20\d\d)\s+Provisional\s+Stocking/)?.[1] ?? 0) || null;
  for (const page of bbox.split('<page ').slice(1)) {
    const ws = [...page.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*?)<\/word>/g)].map(m => ({ x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4], t: unescape(m[5]) }));
    const head = ws.find(w => w.t === 'REGION');
    if (!head) continue;
    const anchors = ws.filter(w => /^R[1-6]$/.test(w.t) && w.y0 > head.y0 + 5).sort((a, b) => a.y0 - b.y0);
    if (!anchors.length) continue;
    const body = ws.filter(w => w.y0 > head.y0 + 12 && !/^(\d+\|Page|\d+\||Page)$/.test(w.t));
    const cover = new Uint8Array(800);
    for (const w of body) for (let x = Math.floor(w.x0); x <= Math.floor(w.x1) && x < 800; x++) cover[x] = 1;
    const gaps = [];
    for (let x = 0; x < 800; x++) if (!cover[x]) { const s = x; while (x < 800 && !cover[x]) x++; gaps.push([s, x]); }
    const bounds = gaps.filter(([s, e]) => s > 60 && e < 760 && e - s >= 4).sort((a, b) => (b[1] - b[0]) - (a[1] - a[0])).slice(0, 6).map(([s, e]) => (s + e) / 2).sort((a, b) => a - b);
    if (bounds.length !== 6) continue;
    const cells = anchors.map(() => Array.from({ length: 7 }, () => []));
    for (const w of body) {
      const yc = (w.y0 + w.y1) / 2, xc = (w.x0 + w.x1) / 2;
      let a = 0; for (let i = 1; i < anchors.length; i++) if (Math.abs((anchors[i].y0 + anchors[i].y1) / 2 - yc) < Math.abs((anchors[a].y0 + anchors[a].y1) / 2 - yc)) a = i;
      cells[a][bounds.filter(b => xc > b).length].push(w);
    }
    for (const row of cells) {
      const r = row.map(c => c.sort((a, b) => Math.round(a.y0) - Math.round(b.y0) || a.x0 - b.x0).map(w => w.t).join(' ').replace(/\s*\d+\s*\|\s*(P\s*a\s*g\s*e)?\s*$/i, '').trim());
      if (!/^R[1-6]$/.test(r[0]) || !r[2] || !r[3]) continue;
      rows.push({ region: r[0], county: r[1], water: r[2], species: r[3], size: r[4].replace(/^Super- ?catchable$/i, 'Super-catchable'), program: r[5].split(' ').sort().join(' ') === 'Put Take and' ? 'Put and Take' : r[5], months: r[6] });
    }
  }
  return { year, rows };
}
// "Catchable, April-June" → "catchable, April to June"
export const planNote = r => [r.size.toLowerCase(), r.months.replace(/\s*&\s*/g, ' and ').replace(/-/g, ' to ')].filter(Boolean).join(', ');

async function california(find0, stocked, lakes) {
  const fish = {}, add = adder(fish), report = { unmatched: [] };
  // Stocked waters the app's list has no name for yet are named from CDFW's lake list, so the document can reach them.
  let find = find0;
  const blank = stocked.filter(w => !w.name);
  if (blank.length) try {
    const names = await lakeNames(blank.map(w => w.id), get);
    find = matcher(pointsFor(lakes, stocked.map(w => w.name ? w : { ...w, name: names.get(+w.id) ?? null })));
    report.named = `${blank.filter(w => names.has(+w.id)).length} of ${blank.length} nameless stocked waters named from CDFW's lake list`;
  } catch (e) { report.named = `lake list not read: ${e.message}`; }
  const dir = await mkdtemp(join(tmpdir(), 'plan-'));
  await writeFile(join(dir, 'plan.pdf'), await get(PLAN_URL, { type: 'buffer' }));
  await run('pdftotext', ['-bbox', join(dir, 'plan.pdf'), join(dir, 'plan.html')]);
  const { year, rows } = parsePlan(await readFile(join(dir, 'plan.html'), 'utf8'));
  if (rows.length < 300) throw new Error(`CDFW stocking document: only ${rows.length} rows read`);
  // The planting-schedule layer names each water as the document does and carries the state's water id.
  const ids = new Map(), has = new Set(stocked.map(w => String(w.id)));
  try {
    for (const d of await arcRows(`${CDFW}/biosds2897_fmu/FeatureServer/0`, { fields: 'WaterName,Counties,DfwWaterId,StockingWaterID', step: 1000 })) {
      const k = `${nameKey(d.WaterName)}|${String(d.Counties ?? '').toLowerCase()}`;
      for (const id of [d.StockingWaterID, d.DfwWaterId]) if (id != null && has.has(String(id))) (ids.get(k) ?? ids.set(k, new Set()).get(k)).add(`s:${id}`);
    }
  } catch (e) { report.scheduleIds = `not read: ${e.message}`; }
  const sources = [{ label: `CDFW ${year ?? ''} Provisional Stocking Document`.replace('  ', ' '), url: PLAN_URL }];
  const waters = new Map();
  for (const r of rows) {
    const keys = [...new Set([...(ids.get(`${nameKey(r.water)}|${r.county.toLowerCase()}`) ?? []), ...find({ name: r.water, county: r.county }).filter(k => k.startsWith('s:'))])];
    waters.set(`${r.county}|${r.water}`, (waters.get(`${r.county}|${r.water}`) ?? 0) + keys.length);
    add(keys, listName(r.species), 'plan', 0, planNote(r));
  }
  // A planned water that isn't one of the stocked waters (a backcountry lake stocked every other year) is looked up
  // in CDFW's lake list by name and county, and tied to the lake on the map there.
  const left = rows.filter(r => !waters.get(`${r.county}|${r.water}`));
  if (left.length) try {
    const places = await lakePlaces([...new Set(left.map(r => r.water))], get);
    let lakesTied = 0;
    for (const r of left) {
      const at = places.filter(p => nameKey(p.name) === nameKey(r.water) && p.county.toLowerCase() === r.county.toLowerCase());
      // CDFW's name for a lake is often not the map's: at CDFW's own point for it, the lake that point lies on is the one.
      const keys = [...new Set(at.flatMap(p => find({ name: r.water, lat: p.lat, lon: p.lon }, { nameKm: 2, on: true }).filter(k => k.startsWith('n:'))))];
      if (keys.length && !waters.get(`${r.county}|${r.water}`)) lakesTied++;
      waters.set(`${r.county}|${r.water}`, waters.get(`${r.county}|${r.water}`) + keys.length);
      add(keys, listName(r.species), 'plan', 0, planNote(r));
    }
    // Still nothing: the lake list may know the water under another form of its name. Its entry gives the state's
    // water id (a stocked water of the app's, often one the schedule doesn't name) and a point for the map's lake.
    let kinTied = 0;
    for (const [id] of [...waters].filter(([, n]) => !n)) {
      const [county, water] = [id.slice(0, id.indexOf('|')), id.slice(id.indexOf('|') + 1)];
      const word = [...words(water.replace(/\bnew\b/gi, ' '))].sort((a, b) => b.length - a.length)[0];
      const kin = word ? kinOf(water, await lakesLike(word, county, get)) : [];
      const keys = [...new Set(kin.flatMap(c => [...(has.has(String(c.id)) ? [`s:${c.id}`] : []), ...find({ name: c.name, lat: c.lat, lon: c.lon }, { nameKm: 2, on: true }).filter(k => k.startsWith('n:'))]))];
      if (!keys.length) continue;
      kinTied++; waters.set(id, keys.length);
      for (const r of rows) if (r.county === county && r.water === water) add(keys, listName(r.species), 'plan', 0, planNote(r));
    }
    report.lakes = `${lakesTied} more planned waters tied to a lake on the map through CDFW's lake list, ${kinTied} under another form of their name`;
  } catch (e) { report.lakes = `lake list not read: ${e.message}`; }
  report.unmatched = [...waters].filter(([, n]) => !n).map(([k]) => k.replace('|', ': '));
  report.plan = `${year}: ${rows.length} rows, ${waters.size} waters, ${waters.size - report.unmatched.length} tied to a stocked water`;
  return { sources, fish, report };
}

// ---------- Oregon ----------
const FHD = 'https://nrimp.dfw.state.or.us/arcgis/rest/services/FHD/OregonFishHabitatDistribution2/MapServer';
// NativeNonLocal: an Oregon fish that was brought to this water.
const ORIGIN = { NativeLocal: 'native', NativeNonLocal: 'introduced', NonNative: 'introduced' };
const PRODUCTION = { Natural: 'wild', Hatchery: 'hatchery', Mixed: 'wild and hatchery' };
// A lake row's few words of fact: "introduced, hatchery". Null for a fish that is only there in the past.
export function fhdNote(r) {
  if (r.fhdUseTy === 'Historical') return null;
  return [ORIGIN[r.fhdOrig], PRODUCTION[r.fhdProd]].filter(Boolean).join(', ');
}
// Lakes Oregon has renamed that the distribution maps still carry under the old name.
const FHD_NAMES = { 'Squaw Lakes': 'Acorn Woman Lakes' };
async function oregon(find0, stocked, lakes) {
  const fish = {}, add = adder(fish), report = { unmatched: [], layers: 0 };
  const layers = ((await get(`${FHD}?f=json`)).layers ?? []).filter(l => !l.subLayerIds && /lake/i.test(l.name));
  const recs = [];
  for (const l of layers) {
    let list;
    try { list = await arcRows(`${FHD}/${l.id}`, { fields: 'fhdStNm,fhdSpNm,fhdOrig,fhdProd,fhdUseTy' }); } catch (e) { (report.failed ??= []).push(`${l.name}: ${e.message.slice(-80)}`); continue; }
    report.layers++;
    for (const r of list) {
      const note = fhdNote(r), name = listName(l.name);
      if (note != null && r.fhdStNm) recs.push({ rec: { name: FHD_NAMES[String(r.fhdStNm).trim()] ?? r.fhdStNm, lat: r.lat, lon: r.lon }, name, note });
    }
  }
  if (report.layers < 30 || recs.length < 1000) throw new Error(`ODFW distribution: ${report.layers} layers, ${recs.length} rows`);
  // A lake the state maps that the app has no water for becomes a water of the app (data/or/lakes-extra.json), and
  // takes its fish like the others.
  const how = { nameKm: 15, nearKm: 2.5, on: true };
  const extra = extraLakes(recs.filter(x => !find0(x.rec, how).length).map(x => x.rec), STATES.or.outline, 'odfw');
  const find = extra.length ? matcher(pointsFor([...lakes, ...extra], stocked)) : find0;
  let tied = 0;
  for (const { rec, name, note } of recs) {
    const keys = find(rec, how);
    if (keys.length) tied++; else report.unmatched.push(String(rec.name).trim());
    add(keys, name, 'lives', 0, note);
  }
  report.unmatched = [...new Set(report.unmatched)].sort();
  const added = extra.filter(l => fish[`n:${l.id}`]); // an added lake with no fish the app's list carries would be an empty pin
  report.distribution = `${tied} of ${recs.length} lake rows tied to a water; ${added.length} lakes added that the national list doesn't name; ${report.unmatched.length} names left out (creeks and springs drawn as lakes, waters across the state line)`;
  return { sources: [{ label: 'ODFW Fish Habitat Distribution (lakes)', url: 'https://nrimp.dfw.state.or.us/nrimp/default.aspx?pn=fishdistdata' }], fish, report, extra: added };
}

// ---------- Main ----------
const BUILD = { ca: california, nv: nevada, or: oregon };
async function main(states) {
  let failed = 0;
  for (const st of states) {
    const dir = new URL(`${st}/`, DATA);
    try {
      const [lakes, stocked] = await Promise.all([readJson(new URL('lakes.json', dir)).then(j => j.lakes), readJson(new URL('waters.json', dir)).then(j => j.waters)]);
      const { sources, fish, report, extra } = await BUILD[st](matcher(pointsFor(lakes, stocked)), stocked, lakes);
      const keys = Object.keys(fish).sort(), sorted = Object.fromEntries(keys.map(k => [k, fish[k]]));
      if (!keys.length) throw new Error('no water got a fish');
      await writeFile(new URL('species.json', dir), JSON.stringify({ updatedAt: new Date().toISOString(), sources, fish: sorted }) + '\n');
      if (extra) await writeFile(new URL('lakes-extra.json', dir), JSON.stringify({ updatedAt: new Date().toISOString(), source: sources[0].label, lakes: extra }) + '\n');
      const { unmatched, ...rest } = report;
      console.log(`${st}: ${keys.length} waters, ${keys.reduce((n, k) => n + fish[k].length, 0)} fish rows`, JSON.stringify(rest));
      if (unmatched?.length) console.log(`${st}: not in the app's lists (${unmatched.length}): ${unmatched.slice(0, 400).join('; ')}`);
    } catch (e) { failed++; console.log(`${st}: FAILED, old file kept: ${e.message}`); }
  }
  if (failed) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const states = process.argv.slice(2).filter(a => a in BUILD);
  await main(states.length ? states : Object.keys(BUILD));
}
