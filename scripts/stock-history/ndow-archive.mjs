// NDOW's stocking report pages as saved by the Internet Archive: 2003–2012 at ndow.org/fish/stocking/{east,west,south}.shtm
// (Stock Date | Body of Water | County | # Stocked | Size | Species) and 2013–2021 at
// ndow.org/Fish/Stocking_Updates/<Region>_Nevada/ (Water Body | County | Stocked | Size | Species | Date; 2017 pages
// drop Size and add Year to Date). Each saved copy lists the latest stockings, so together they rebuild most years.
import { cellTables } from './cells.mjs';

// Matched at the end of a cell: the first header cell also carries the page text before the table.
const COLS = {
  ytd: /^year to date$/i, // before date, which it would also match
  date: /(^|\s)(stock )?date$/i, water: /(^|\s)(body of water|water body)$/i, county: /(^|\s)county$/i,
  fish: /(^|\s)((# ?|number )?stocked)$/i, inches: /(^|\s)((approximate |average )?size( \(inches\))?)$/i, species: /(^|\s)species$/i,
};
const dateOf = s => {
  let m = s.match(/^(\d{4})-(\d\d)-(\d\d)$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!m || +m[1] > 12 || +m[2] > 31) return null;
  const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
  return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
};
const int = s => s ? +String(s).replace(/[^\d]/g, '') || null : null;

export function parseNdowPage(text, savedAt) {
  return cellTables(text, COLS, { required: ['date', 'water', 'species'], dateOf })
    // Nothing can be stocked after the page was saved (pages carry the odd two-digit-year typo).
    // A row the page itself garbled ("TOPAZ LAKE DO 9.5 RB") carries a size in the name.
    .filter(r => r.water && r.species && (!savedAt || r.date <= savedAt) && !/\d+\.\d/.test(r.water))
    .map(r => ({ date: r.date, water: r.water.replace(/\s*\*+$/, ''), county: r.county || null, fish: int(r.fish),
      inches: parseFloat(r.inches) || null, species: r.species, ytd: int(r.ytd) }));
}
