#!/usr/bin/env node
// Fish someone recorded near a water: museum specimens, agency surveys and iNaturalist observations, as GBIF
// (gbif.org) gathers them. For the "Seen nearby" lines of the "What's in here" list on a water's Stocking tab.
// A sighting near a water is weaker than a state's own list, so these rows are shown there and nowhere else: they
// never feed the finder or the map's fish filter.
//
//   node scripts/build-sightings.mjs [ca] [nv] [or] [--open-only]
//   → data/<st>/sightings.json  { updatedAt, credit, sources: [{ label, url, licence }], fish: { "<key>": [[name, "seen", source, latestYear, records], …] } }
//     key is the water's key in the app without its state, as in species.json: "n:<lakes.json id>" or "s:<waters.json id>"
//
// Credit and licences. Every row points at the collection it came from, and every collection carries its licence:
// CC0, CC BY, or CC BY-NC (free to use with credit, but not commercially; most iNaturalist observations). Only
// counts and years are kept, never an observer's name, photo or notes. To drop the non-commercial records later,
// run this with --open-only (or delete the files: the app works without them).
//
// A record counts for a water when it lies within the water's reach: a circle around its map point sized from the
// water's area (400 m for a pond, up to 10 km for the largest reservoirs). Records whose place is uncertain by more
// than a kilometre are left out; that includes every observation whose observer hid its location.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { haversineKm } from '../data-sources.js';
import { get } from './build-species.mjs';

const DATA = new URL('../data/', import.meta.url);
const API = 'https://api.gbif.org/v1';
const AREA = { ca: 'USA.5_1', nv: 'USA.29_1', or: 'USA.38_1' }; // the states in GBIF's administrative areas (GADM)
// Left out: the USGS Nonindigenous Aquatic Species database. The app reads it directly (the "On record" fish), with
// what became of each introduction; here a plant that failed in 1953 would read as a sighting.
const SKIP = new Set(['d6cc311c-c5ab-4f23-9a20-10514f9eb9c4']);
const CREDIT = 'GBIF.org occurrence records, each credited to the collection that published it';

// The fish looked for: scientific name → the app's name. Only fish on the app's own list.
export const FISH = [
  ['Oncorhynchus mykiss', 'Rainbow trout'], ['Oncorhynchus clarkii', 'Cutthroat trout'], ['Oncorhynchus aguabonita', 'Golden trout'],
  ['Salmo trutta', 'Brown trout'], ['Salvelinus fontinalis', 'Brook trout'], ['Salvelinus namaycush', 'Lake trout'], ['Salvelinus confluentus', 'Bull trout'],
  ['Oncorhynchus nerka', 'Kokanee'], ['Prosopium williamsoni', 'Mountain whitefish'], ['Thymallus arcticus', 'Arctic grayling'],
  ['Micropterus salmoides', 'Largemouth bass'], ['Micropterus nigricans', 'Largemouth bass'], ['Micropterus dolomieu', 'Smallmouth bass'],
  ['Micropterus punctulatus', 'Spotted bass'], ['Micropterus henshalli', 'Spotted bass'], ['Morone saxatilis', 'Striped bass'], ['Morone chrysops', 'White bass'],
  ['Lepomis macrochirus', 'Bluegill'], ['Lepomis cyanellus', 'Green sunfish'], ['Lepomis microlophus', 'Redear sunfish'], ['Lepomis gibbosus', 'Pumpkinseed'],
  ['Lepomis gulosus', 'Warmouth'], ['Pomoxis nigromaculatus', 'Black crappie'], ['Pomoxis annularis', 'White crappie'],
  ['Archoplites interruptus', 'Sacramento perch'], ['Perca flavescens', 'Yellow perch'], ['Sander vitreus', 'Walleye'],
  ['Ictalurus punctatus', 'Channel catfish'], ['Ictalurus furcatus', 'Blue catfish'], ['Ameiurus catus', 'White catfish'], ['Pylodictis olivaris', 'Flathead catfish'],
  ['Ameiurus nebulosus', 'Brown bullhead'], ['Ameiurus melas', 'Black bullhead'], ['Ameiurus natalis', 'Yellow bullhead'],
  ['Cyprinus carpio', 'Common carp'], ['Esox lucius', 'Northern pike'], ['Acipenser transmontanus', 'White sturgeon'], ['Alosa sapidissima', 'American shad'],
];

// ---------- Which waters a record is near ----------
// How far from a water's map point a sighting still counts, in metres: a bit past the shore of a round lake of its size.
export const radiusM = acres => Math.round(Math.min(Math.max(1.3 * Math.sqrt((acres || 0) * 4046.86 / Math.PI) + 250, 400), 10000));

// Every located lake and stocked water with its reach. A stocked water with no size on file takes the size of the
// lake of the same name within 5 km.
export function reachOf(lakes, stocked) {
  const lower = w => String(w.name ?? '').toLowerCase();
  const sized = new Map();
  for (const w of lakes) if (w.acres && w.lat != null) (sized.get(lower(w)) ?? sized.set(lower(w), []).get(lower(w))).push(w);
  const borrowed = w => Math.max(0, ...(sized.get(lower(w)) ?? []).filter(l => haversineKm(w.lat, w.lon, l.lat, l.lon) < 5).map(l => l.acres));
  const pt = (key, w, acres) => ({ key, lat: w.lat, lon: w.lon, r: radiusM(acres) });
  return [...lakes.filter(w => w.lat != null).map(w => pt(`n:${w.id}`, w, w.acres)), ...stocked.filter(w => w.lat != null).map(w => pt(`s:${w.id}`, w, w.acres || borrowed(w)))];
}

export function licenceOf(raw) {
  const s = String(raw ?? '').toLowerCase().replace(/_/g, '-');
  return /by-nc/.test(s) ? 'CC BY-NC 4.0' : /zero|cc0/.test(s) ? 'CC0 1.0' : /licenses\/by\/|^cc-by-4/.test(s) ? 'CC BY 4.0' : null;
}

// records [{ name, lat, lon, year, dataset, licence, uncertainty? }] against points [{ key, lat, lon, r }]
// → { datasets: [dataset, …] (most records first), fish: { key: [[name, 'seen', dataset's place in datasets, latest year, records], …] } }
export function tally(records, points) {
  const CELL = 0.05, grid = new Map(), cell = (lat, lon) => `${Math.floor(lat / CELL)},${Math.floor((lon + 180) / CELL)}`;
  for (const p of points) {
    const dLat = p.r / 111000, dLon = dLat / Math.cos(p.lat * Math.PI / 180);
    for (let a = Math.floor((p.lat - dLat) / CELL); a <= Math.floor((p.lat + dLat) / CELL); a++) for (let b = Math.floor((p.lon - dLon + 180) / CELL); b <= Math.floor((p.lon + dLon + 180) / CELL); b++) {
      (grid.get(`${a},${b}`) ?? grid.set(`${a},${b}`, []).get(`${a},${b}`)).push(p);
    }
  }
  const by = new Map(), total = new Map(); // key → "name|dataset" → { name, dataset, last, n }
  for (const r of records) {
    if (!r.licence || !r.name || r.lat == null || r.lon == null || r.uncertainty > 1000) continue;
    for (const p of grid.get(cell(r.lat, r.lon)) ?? []) {
      if (haversineKm(r.lat, r.lon, p.lat, p.lon) * 1000 > p.r) continue;
      const rows = by.get(p.key) ?? by.set(p.key, new Map()).get(p.key), id = `${r.name}|${r.dataset}`;
      const row = rows.get(id) ?? rows.set(id, { name: r.name, dataset: r.dataset, last: null, n: 0 }).get(id);
      row.n++; if (r.year > (row.last ?? 0)) row.last = r.year;
      total.set(r.dataset, (total.get(r.dataset) ?? 0) + 1);
    }
  }
  // The same order whatever order the records came in, so a rebuild with nothing new changes nothing.
  const datasets = [...total].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(d => d[0]);
  const fish = {};
  for (const [key, rows] of by) {
    const list = [...rows.values()], of = name => list.reduce((n, r) => n + (r.name === name ? r.n : 0), 0);
    fish[key] = list.map(r => [r.name, 'seen', datasets.indexOf(r.dataset), r.last, r.n])
      .sort((a, b) => of(b[0]) - of(a[0]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0) || a[2] - b[2]);
  }
  return { datasets, fish };
}

// A file without the records licensed for non-commercial use only.
export function openOnly(file) {
  const keep = file.sources.map((s, i) => (s.licence === 'CC BY-NC 4.0' ? -1 : i)).filter(i => i >= 0);
  const fish = {};
  for (const [key, rows] of Object.entries(file.fish)) {
    const left = rows.filter(r => keep.includes(r[2])).map(r => [r[0], r[1], keep.indexOf(r[2]), ...r.slice(3)]);
    if (left.length) fish[key] = left;
  }
  return { ...file, sources: keep.map(i => file.sources[i]), fish };
}

// ---------- GBIF ----------
const readJson = async url => JSON.parse(await readFile(url, 'utf8'));

// The key GBIF files a fish under (the accepted name's, when ours is an older name for it). Null unless GBIF knows
// the name as a species: a name it can only place in a wider group comes back as that group.
export const taxonKeyOf = m => m?.matchType === 'EXACT' && m.rank === 'SPECIES' ? m.acceptedUsageKey ?? m.usageKey ?? null : null;
// How to ask for a fish: by GBIF's key, or, for a name GBIF hasn't filed yet (largemouth bass as Micropterus
// nigricans, which it keeps unsorted in the bass genus), by the name as the record gives it.
export const queryOf = (sci, match) => { const taxonKey = taxonKeyOf(match); return taxonKey ? { taxonKey } : { verbatimScientificName: sci }; };
async function queries() {
  const out = new Map(); // the query as text → [query, app name]
  for (const [sci, name] of FISH) {
    const q = queryOf(sci, await get(`${API}/species/match?kingdom=Animalia&strict=true&name=${encodeURIComponent(sci)}`));
    if (!out.has(JSON.stringify(q))) out.set(JSON.stringify(q), [q, name]);
  }
  return [...out.values()];
}

// Every located record of one fish in one state. GBIF answers slowly past the 10,000th row of one search (45 s a
// page), so a fish with more than that (striped bass in California's Delta surveys) is asked for by halves of the
// years instead; the few records with no year are then missed for that fish.
const DEEP = 9900;
async function recordsOf(area, which, name, seen, years = null) {
  const out = [];
  for (let offset = 0; offset < 100000;) {
    const q = new URLSearchParams({ gadmGid: area, ...which, hasCoordinate: 'true', hasGeospatialIssue: 'false', occurrenceStatus: 'PRESENT', ...(years ? { year: years.join(',') } : {}), limit: 300, offset });
    const j = await get(`${API}/occurrence/search?${q}`);
    const [from, to] = years ?? [1700, new Date().getUTCFullYear()];
    if (!offset && j.count > DEEP && from < to) {
      const mid = Math.floor((from + to) / 2);
      return [...await recordsOf(area, which, name, seen, [from, mid]), ...await recordsOf(area, which, name, seen, [mid + 1, to])];
    }
    for (const r of j.results ?? []) {
      if (seen.has(r.key) || SKIP.has(r.datasetKey) || /FOSSIL|LIVING/.test(r.basisOfRecord ?? '')) continue; // not fossils, not fish in a tank
      seen.add(r.key);
      out.push({ name, lat: r.decimalLatitude, lon: r.decimalLongitude, year: r.year ?? null, dataset: r.datasetKey, licence: licenceOf(r.license), uncertainty: r.coordinateUncertaintyInMeters });
    }
    if (j.endOfRecords || !j.results?.length) break;
    offset += j.results.length;
  }
  return out;
}

async function main(states, { open = false } = {}) {
  let failed = 0, asks;
  for (const st of states) {
    const dir = new URL(`${st}/`, DATA);
    try {
      asks ??= await queries();
      const [lakes, stocked, extra] = await Promise.all([readJson(new URL('lakes.json', dir)).then(j => j.lakes), readJson(new URL('waters.json', dir)).then(j => j.waters),
        readJson(new URL('lakes-extra.json', dir)).then(j => j.lakes, () => [])]); // lakes the state's fish maps add (build-species.mjs)
      const records = [], seen = new Set();
      for (const [which, name] of asks) {
        const t = Date.now(), got = await recordsOf(AREA[st], which, name, seen);
        records.push(...got);
        console.log(`${st}: ${name}: ${got.length} records, ${Math.round((Date.now() - t) / 1000)} s`);
      }
      const { datasets, fish } = tally(records, reachOf([...lakes, ...extra], stocked));
      if (!datasets.length) throw new Error('no record fell near a water');
      const sources = [];
      for (const d of datasets) {
        const info = await get(`${API}/dataset/${d}`);
        sources.push({ label: `${String(info.title).trim()}, via GBIF`, url: `https://www.gbif.org/dataset/${d}`, licence: licenceOf(info.license) });
      }
      const sorted = Object.fromEntries(Object.keys(fish).sort().map(k => [k, fish[k]]));
      let file = { updatedAt: new Date().toISOString(), credit: CREDIT, sources, fish: sorted };
      if (open) file = openOnly(file);
      await writeFile(new URL('sightings.json', dir), JSON.stringify(file) + '\n');
      const rows = Object.values(file.fish).flat(), nc = rows.filter(r => file.sources[r[2]].licence === 'CC BY-NC 4.0').length;
      console.log(`${st}: ${records.length} records in the state, ${Object.keys(file.fish).length} waters with a sighting, ${rows.length} rows from ${file.sources.length} collections (${nc} rows non-commercial${open ? ', left out' : ''})`);
    } catch (e) { failed++; console.log(`${st}: FAILED, old file kept: ${e.message}`); }
  }
  if (failed) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const states = process.argv.slice(2).filter(a => a in AREA);
  await main(states.length ? states : Object.keys(AREA), { open: process.argv.includes('--open-only') });
}
