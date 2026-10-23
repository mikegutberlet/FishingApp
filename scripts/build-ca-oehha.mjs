// OEHHA fish consumption advisories ("how often can I eat what I catch here?"), from data.ca.gov.
// Runs weekly (see .github/workflows/build-safety.yml); OEHHA updates them a few times a year.
//
//   data/ca/oehha.json  { advisories: [{ name, county, url, lat, lon, year, fish: [[species, sensitive, general, contaminants]] }],
//                         statewide: [same shape, for waters without site-specific advice] }
//
// Servings are per week; 0 means do not eat. "sensitive" = women 18–49 and children 1–17, "general" = women 50+ and men 18+.

import { writeFile, mkdir } from 'node:fs/promises';

const OUT = new URL('../data/ca/', import.meta.url);
const UA = { 'User-Agent': 'TackleBox-fishing-app (personal, github.com/mikegutberlet/FishingApp)' };
const ADVISORIES = '7805faef-ed21-43e9-a13e-4920a9440bb8'; // Fish Consumption Advisories (name, county, link, lat/lon)
const SERVINGS = '55b9a341-04e1-4f4a-9839-6eb36e6cc8ed';   // Fish Consumption Advisory Serving Recommendations

async function sql(q) {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(`https://data.ca.gov/api/3/action/datastore_search_sql?sql=${encodeURIComponent(q)}`, { headers: UA, signal: AbortSignal.timeout(120000) });
      if (!r.ok) throw new Error(`${r.status} data.ca.gov`);
      return (await r.json()).result.records;
    } catch (e) { if (attempt >= 3) throw e; console.error(`retry: ${e.message}`); await new Promise(r => setTimeout(r, 20000)); }
  }
}

const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();
// "Bass, Black" → "Black Bass"; "Catfish Species" stays.
const species = s => clean(s).replace(/^([^,]+),\s*(.+)$/, '$2 $1');

const [ads, servings] = await Promise.all([
  sql(`SELECT "Advisory","County","Link","Latitude","Longitude" FROM "${ADVISORIES}"`),
  sql(`SELECT "Advisory","County","Species","Contaminant","SEN_serving","GEN_serving","Year" FROM "${SERVINGS}" WHERE "Advisory" IS NOT NULL`),
]);
if (ads.length < 50 || servings.length < 200) throw new Error(`Only ${ads.length} advisories / ${servings.length} servings; the dataset may have changed`);

const byName = new Map();
for (const s of servings) {
  const key = clean(s.Advisory).toLowerCase();
  if (!byName.has(key)) byName.set(key, { county: clean(s.County), year: 0, fish: [] });
  const a = byName.get(key);
  a.year = Math.max(a.year, s.Year ?? 0);
  a.fish.push([species(s.Species), s.SEN_serving, s.GEN_serving, clean(s.Contaminant)]);
}
const entry = (name, extra = {}) => {
  const s = byName.get(clean(name).toLowerCase());
  return { name: clean(name), county: clean(extra.county) || s?.county || '', url: extra.url ?? null, lat: extra.lat ?? null, lon: extra.lon ?? null, year: s?.year || null, fish: s?.fish ?? [] };
};

const advisories = ads.filter(a => a.Latitude && !/without site-specific|fish that migrate/i.test(a.Advisory))
  .map(a => entry(a.Advisory, { county: a.County, url: a.Link, lat: +(+a.Latitude).toFixed(5), lon: +(+a.Longitude).toFixed(5) }));
// Statewide advice for lakes, rivers and coast without their own advisory, plus fish that migrate (salmon, sturgeon, stripers).
const statewide = [...byName.keys()].filter(k => /without site-specific|statewide|fish that migrate/i.test(k))
  .map(k => entry(ads.find(a => clean(a.Advisory).toLowerCase() === k)?.Advisory ?? k, { url: ads.find(a => clean(a.Advisory).toLowerCase() === k)?.Link }));
const missing = advisories.filter(a => !a.fish.length).map(a => a.name);

await mkdir(OUT, { recursive: true });
await writeFile(new URL('oehha.json', OUT), JSON.stringify({ updatedAt: new Date().toISOString(), source: 'OEHHA fish consumption advisories (data.ca.gov)', url: 'https://oehha.ca.gov/fish/advisories', advisories, statewide }) + '\n');
console.log(`oehha: ${advisories.length} site advisories, ${statewide.length} statewide (${statewide.map(s => s.name).join('; ')}), ${missing.length} without serving rows: ${missing.slice(0, 20).join('; ')}`);
