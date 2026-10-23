// Current toxic algae (harmful algal bloom) advisories in California, from the Water Boards' FHAB bloom reports
// on data.ca.gov (the data behind the California HABs portal). Runs nightly (see .github/workflows/update-safety.yml).
//
//   data/ca/hab.json  { advisories: [{ id, name, county, level, advisory, date, detail, pts: [[lat, lon]] }] }
//
// One entry per open case: the latest report decides the level. Cases with no activity for a year are dropped.
// If data.ca.gov is down, the old file is kept.

import { writeFile, mkdir } from 'node:fs/promises';

const OUT = new URL('../data/ca/', import.meta.url);
const UA = { 'User-Agent': 'TackleBox-fishing-app (personal, github.com/mikegutberlet/FishingApp)' };
const RESOURCE = 'c6a36b91-ad38-4611-8750-87ee99e497dd'; // "FHAB Bloom Reports" in the surface-water-freshwater-harmful-algal-blooms dataset
export const PORTAL = 'https://mywaterquality.ca.gov/habs/where/freshwater_events.html';

// Water Boards advisory names → the app's levels, most severe first. "None" means tested below the posting triggers.
export function levelOf(advisory, detail) {
  const a = advisory ?? '';
  if (/danger/i.test(a)) return 'danger';
  if (/warning|alert sign/i.test(a)) return 'warning';
  if (/caution/i.test(a)) return 'caution';
  if (/awareness|visual/i.test(a)) return 'awareness';
  if (/^none$/i.test(a.trim())) return null;
  if (/no cyano|below posting|no exceedance/i.test(detail ?? '')) return null;
  return 'reported'; // "NA - refer to Report Details" or blank: reported, not yet assessed
}

const today = new Date().toISOString().slice(0, 10);
// Some rows carry typos like 2555-07-09; ignore dates in the future.
const valid = d => d && d.slice(0, 10) <= today ? d.slice(0, 10) : null;

async function sql(q) {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(`https://data.ca.gov/api/3/action/datastore_search_sql?sql=${encodeURIComponent(q)}`, { headers: UA, signal: AbortSignal.timeout(120000) });
      if (!r.ok) throw new Error(`${r.status} data.ca.gov`);
      return (await r.json()).result.records;
    } catch (e) { if (attempt >= 3) throw e; console.error(`retry: ${e.message}`); await new Promise(r => setTimeout(r, 20000)); }
  }
}

const cols = ['Bloom_Report_ID', 'Case_ID', 'Water_Body_Name', 'Official_Water_Body_Name', 'Case_Water_Body_Name', 'Landmark', 'County', 'Bloom_Latitude', 'Bloom_Longitude',
  'Observation_Date', 'Advisory_Recommended', 'Advisory_Date', 'AdvisoryStartDate', 'AdvisoryEndDate', 'AdvisoryDetail', 'Advisory_Detail_Description', 'Case_Status'];
const rows = await sql(`SELECT ${cols.map(c => `"${c}"`).join(',')} FROM "${RESOURCE}" WHERE "Case_Status" IS NULL OR "Case_Status" <> 'Closed'`);
if (rows.length < 50) throw new Error(`Only ${rows.length} open bloom reports; the dataset may have changed`);

const yearAgo = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
const cases = new Map();
for (const r of rows) {
  const date = valid(r.Advisory_Date) ?? valid(r.AdvisoryStartDate) ?? valid(r.Observation_Date);
  if (!date || date < yearAgo) continue;
  const key = r.Case_ID ?? `r${r.Bloom_Report_ID}`;
  const c = cases.get(key) ?? { reports: [] };
  c.reports.push({ ...r, date });
  cases.set(key, c);
}

const advisories = [];
for (const [id, c] of cases) {
  c.reports.sort((a, b) => b.date.localeCompare(a.date) || b.Bloom_Report_ID - a.Bloom_Report_ID);
  const r = c.reports[0];
  if (r.AdvisoryEndDate && valid(r.AdvisoryEndDate) && r.AdvisoryEndDate.slice(0, 10) < today) continue;
  const level = levelOf(r.Advisory_Recommended, `${r.AdvisoryDetail ?? ''} ${r.Advisory_Detail_Description ?? ''}`);
  if (!level) continue;
  const pts = [...new Map(c.reports.filter(x => x.Bloom_Latitude && x.Bloom_Longitude)
    .map(x => [+(+x.Bloom_Latitude).toFixed(4), +(+x.Bloom_Longitude).toFixed(4)]).map(p => [p.join(), p])).values()].slice(0, 12);
  if (!pts.length) continue;
  advisories.push({
    id: String(id), name: (r.Official_Water_Body_Name || r.Water_Body_Name || r.Case_Water_Body_Name || '').trim(), alt: (r.Case_Water_Body_Name ?? '').trim(),
    landmark: r.Landmark ?? '', county: r.County ?? '', level, advisory: r.Advisory_Recommended ?? 'Not yet assessed', date: r.date,
    observed: valid(r.Observation_Date), detail: r.AdvisoryDetail ?? '', description: (r.Advisory_Detail_Description ?? '').slice(0, 400), status: r.Case_Status ?? '', pts,
  });
}
const order = ['danger', 'warning', 'caution', 'awareness', 'reported'];
advisories.sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level) || b.date.localeCompare(a.date));
await mkdir(OUT, { recursive: true });
await writeFile(new URL('hab.json', OUT), JSON.stringify({ updatedAt: new Date().toISOString(), source: 'California Water Boards FHAB bloom reports (data.ca.gov)', portal: PORTAL, advisories }) + '\n');
const counts = Object.fromEntries(order.map(l => [l, advisories.filter(a => a.level === l).length]));
console.log(`hab: ${rows.length} open reports, ${cases.size} active cases in the last year, ${advisories.length} advisories`, JSON.stringify(counts));
