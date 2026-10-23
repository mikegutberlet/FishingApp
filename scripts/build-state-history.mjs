// Builds data/<st>/history.json for a state in scripts/states.mjs (same as build-ca-history.mjs for California):
// when and where fish species were introduced or planted, as far back as records go, from the USGS
// Nonindigenous Aquatic Species (NAS) database.  node scripts/build-state-history.mjs nv
// NAS compiles historical introductions from Fish Commission reports, Fish and Game bulletins and surveys.
//
// Honest limits: native species stocked within their native range are not in NAS.

import { writeFile, mkdir } from 'node:fs/promises';
import { stateArg } from './states.mjs';

const STATE = stateArg();

const OUT = new URL(`../data/${STATE.st}/`, import.meta.url);
const UA = { 'User-Agent': 'TackleBox-fishing-app (personal, github.com/mikegutberlet/FishingApp)' };
const report = { startedAt: new Date().toISOString() };

const NARRATIVE = STATE.narrative;

async function getJson(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { headers: UA });
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return await r.json();
    } catch (e) {
      if (i >= tries) throw e;
      await new Promise(res => setTimeout(res, 2000 * i));
    }
  }
}

async function nasRecords() {
  const records = [];
  for (let offset = 0, page = 0; page < 500; page++) {
    const json = await getJson(`https://nas.er.usgs.gov/api/v2/occurrence/search?state=${STATE.code}&group=Fishes&offset=${offset}&limit=1000`);
    const rows = Array.isArray(json) ? json : json.results ?? json.data ?? [];
    if (page === 0) { report.total = json.count ?? json.total ?? null; report.sampleKeys = Object.keys(rows[0] ?? {}); report.sample = rows[0] ?? null; }
    if (!rows.length) break;
    records.push(...rows);
    offset += rows.length;
    // The API reports count per page (capped at 1000), so keep going while pages come back full.
    if (rows.length < 1000) break;
  }
  return records;
}

// NAS field names have shifted between API versions, so look them up by pattern.
const field = (r, ...patterns) => {
  for (const pat of patterns) { const k = Object.keys(r).find(k => pat.test(k)); if (k !== undefined && r[k] != null && r[k] !== '') return r[k]; }
  return undefined;
};

await mkdir(OUT, { recursive: true });
let records = [];
try { records = await nasRecords(); } catch (e) { report.error = e.message; console.error(e.message); }
report.fetched = records.length;

// Keep the earliest record of each species at each place (~1 km), which is what "history" means here.
const earliest = new Map();
for (const r of records) {
  const lat = +field(r, /^decimallatitude$/i, /latitude/i, /^lat$/i), lon = +field(r, /^decimallongitude$/i, /longitude/i, /^lon$/i), year = +field(r, /^year$/i, /year/i);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !year || year < 1800) continue;
  const name = field(r, /^commonname$/i, /common/i) || `${field(r, /^genus$/i) ?? ''} ${field(r, /^species$/i) ?? ''}`.trim();
  if (!name) continue;
  const locality = String(field(r, /^locality$/i, /locality|location|waterbody|drainage/i) ?? '');
  const status = String(field(r, /^status$/i) ?? '');
  const key = `${name}|${lat.toFixed(2)}|${lon.toFixed(2)}`;
  const prev = earliest.get(key);
  if (prev && prev[2] <= year) continue;
  earliest.set(key, [+lat.toFixed(4), +lon.toFixed(4), year, name, locality.slice(0, 120), status]);
}
const places = [...earliest.values()].sort((a, b) => a[2] - b[2]);

// First record in the state of each species, for the statewide timeline.
const firsts = new Map();
for (const p of places) if (!firsts.has(p[3])) firsts.set(p[3], p);
const statewide = [
  ...NARRATIVE,
  ...[...firsts.values()].filter(p => p[2] < 1960).map(p => ({ year: String(p[2]), text: `${p[3]}: first ${STATE.name} record${p[4] ? `, ${p[4]}` : ''}.`, source: 'USGS NAS' })),
].sort((a, b) => a.year.localeCompare(b.year));

report.places = places.length;
report.species = firsts.size;
if (places.length || !report.error) {
  await writeFile(new URL('history.json', OUT), JSON.stringify({
    updatedAt: new Date().toISOString(),
    note: `Introductions and plantings from the USGS Nonindigenous Aquatic Species database plus documented early events. Native fish stocked in their native range, such as Lahontan cutthroat trout plants, are not in these records; ${{ NV: 'NDOW stocking reports on the Stocking tab cover recent years', OR: 'ODFW stocking schedules on the Stocking tab cover recent years' }[STATE.code] ?? 'state stocking records cover recent years'}.`,
    statewide,
    fields: ['lat', 'lon', 'year', 'species', 'locality', 'status'],
    places,
    waters: [],
  }) + '\n');
}
await writeFile(new URL('history-report.json', OUT), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
