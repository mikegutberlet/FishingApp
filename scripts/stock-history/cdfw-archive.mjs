// CDFW's trout planting schedule as saved by the Internet Archive. CDFW publishes the week, water and species, never
// the number of fish. Three page generations:
//   2007–2013  dfg.ca.gov/fish/Hatcheries/FishPlanting/<Region>.asp: "For the Week of M/D/YYYY", then county and water
//              on alternate lines (trout; SouthCoast_Catfish.asp lists catfish)
//   2012–2024  nrm.dfg.ca.gov/FishPlants/: a table, Week of Plant | Counties | Water Name | Species (column order varies)
//   2024 on    nrm.dfg.ca.gov/FishPlants/PublicPlantSearch: Week of Plant (a date range) | Water Name | Counties | Species
import { cellTables } from './cells.mjs';

export const CA_COUNTIES = ['Alameda', 'Alpine', 'Amador', 'Butte', 'Calaveras', 'Colusa', 'Contra Costa', 'Del Norte', 'El Dorado', 'Fresno',
  'Glenn', 'Humboldt', 'Imperial', 'Inyo', 'Kern', 'Kings', 'Lake', 'Lassen', 'Los Angeles', 'Madera', 'Marin', 'Mariposa', 'Mendocino',
  'Merced', 'Modoc', 'Mono', 'Monterey', 'Napa', 'Nevada', 'Orange', 'Placer', 'Plumas', 'Riverside', 'Sacramento', 'San Benito',
  'San Bernardino', 'San Diego', 'San Francisco', 'San Joaquin', 'San Luis Obispo', 'San Mateo', 'Santa Barbara', 'Santa Clara',
  'Santa Cruz', 'Shasta', 'Sierra', 'Siskiyou', 'Solano', 'Sonoma', 'Stanislaus', 'Sutter', 'Tehama', 'Trinity', 'Tulare', 'Tuolumne',
  'Ventura', 'Yolo', 'Yuba'];
const COUNTY = new Map(CA_COUNTIES.map(c => [c.toLowerCase(), c]));
const iso = (m, d, y) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const usDate = s => { const m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? iso(m[1], m[2], m[3]) : null; };
const clean = s => s.replace(/\s+/g, ' ').trim();

export function parseRegionPage(text, url) {
  const species = /catfish/i.test(url) ? 'Catfish' : 'Trout';
  const rows = [];
  let week = null, county = null;
  for (const raw of text.split('\n')) {
    const line = clean(raw.replace(/\|/g, ' '));
    const w = line.match(/For the Week of (\d{1,2})\/(\d{1,2})\/(\d{4})/i);
    if (w) { week = iso(w[1], w[2], w[3]); county = null; continue; }
    if (!week || !line) continue;
    if (/^back to top|conditions of use|privacy policy/i.test(line)) { week = null; continue; }
    if (!county && COUNTY.has(line.toLowerCase())) { county = COUNTY.get(line.toLowerCase()); continue; }
    if (county) {
      // "northern Lake Merced": CDFW's own note on where in the water, kept out of the name.
      rows.push({ week, water: line.replace(/^(northern|southern|eastern|western|upper|lower) (?=Lake )/i, '').replace(/\s*\(?\s*Map( It)?\s*\)?\s*$/i, ''), counties: county, species });
      county = null;
    }
  }
  return rows;
}

const NRM_COLS = {
  // Matched at the end of a cell: the first header cell also carries the page text before the table.
  date: /(^|\s)week( of plant)?$/i, counties: /(^|\s)count(y|ies)$/i, water: /(^|\s)water( name)?$/i, species: /(^|\s)species$/i,
  map: /(^|\s)((see )?google map( location)?|map)$/i,
};
export function parseNrmPage(text) {
  return cellTables(text, NRM_COLS, { required: ['date', 'water', 'species'], dateOf: usDate })
    .map(r => ({ week: r.date, water: clean(r.water.replace(/View Water Body in Map/i, '').replace(/\s*\(?\s*Map( It)?\s*\)?\s*$/i, '')), counties: r.counties || null, species: clean(r.species) }))
    .filter(r => r.water && r.species && !/^map it$/i.test(r.water));
}
