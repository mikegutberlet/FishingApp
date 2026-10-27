// ODFW Fish Propagation Annual Reports (2006 on): the "Numbers and Pounds of Fish Stocked by Watershed" table lists
// every release by waterbody, species and hatchery with the number and pounds stocked. Read from `pdftotext -layout`
// text, whose column positions shift from year to year, so columns are found from each page's header line.
// Names wrap onto the next line in some years ("CAPE MEARES" / "LK", "SPRING" / "CHINOOK"), sometimes on a line that
// carries the next release's numbers, so wrapped pieces are joined by what an unfinished name looks like.
// (2003–2005 reports only total each watershed, so they are not used.)

const titleCase = s => s.toLowerCase().replace(/(?<!')\b[a-z]/g, c => c.toUpperCase()).replace(/\bLk\b/g, 'Lake').replace(/\bMc([a-z])/g, (m, c) => 'Mc' + c.toUpperCase());
const NUM = /^[\d,]+$/;
const pieces = line => [...line.matchAll(/\S+(?: \S+)*/g)].map(m => ({ s: m[0], at: m.index }));
// A water name is finished when it ends in a water word, a fork, a number or a parenthesis.
const WATER_END = /(\b(cr|creek|r|river|lk|lake|lakes|res|reservoir|pd|pond|ponds|slough|bay|fk|fork|channel|pit|pits|canal|springs?|marsh|hatchery|wma|park|lagoon|estuary|ditch|outlet|inlet|arm|basin|dam|pool|hole|net pens?)|\)|\d)$/i;
const TYPE_ONLY = /^(cr|creek|r|river|lk|lake|lakes|res|reservoir|pd|pond|slough|fk|fork|n fk|s fk)$/i;
const SPECIES_END = /(steel?head|trout|chinook|salmon|coho|chum|bass|kokanee|crappie|bluegill|catfish|perch|sturgeon|grayling|sunfish|carp|walleye|cutthroat|sockeye|pikeminnow|shad|lamprey|char)$/i;
const SPECIES_TAIL = /^(steel?head|trout|chinook|salmon|bass|crappie|catfish|perch|sunfish)$/i;

// The 18 watersheds the tables are grouped by, numbered as in the reports, with the counties each reaches into
// (generously): a report names the water but not its county, and there are many Clear Lakes.
export const WATERSHEDS = [null,
  ['North Coast', ['Clatsop', 'Columbia', 'Tillamook', 'Washington', 'Yamhill', 'Multnomah']],
  ['Willamette', ['Lane', 'Linn', 'Benton', 'Marion', 'Polk', 'Yamhill', 'Washington', 'Clackamas', 'Multnomah', 'Douglas']],
  ['Clackamas/Sandy', ['Clackamas', 'Multnomah', 'Hood River']],
  ['Hood', ['Hood River', 'Wasco', 'Multnomah']],
  ['Deschutes', ['Deschutes', 'Jefferson', 'Crook', 'Wasco', 'Klamath', 'Sherman', 'Lake']],
  ['John Day', ['Grant', 'Wheeler', 'Gilliam', 'Sherman', 'Morrow', 'Wasco', 'Umatilla']],
  ['Umatilla', ['Umatilla', 'Morrow', 'Union']],
  ['Grande Ronde', ['Union', 'Wallowa', 'Umatilla']],
  ['Powder', ['Baker', 'Union', 'Wallowa']],
  ['Malheur', ['Malheur', 'Harney', 'Grant', 'Baker']],
  ['Owyhee', ['Malheur']],
  ['Malheur Lake', ['Harney', 'Grant']],
  ['Goose & Summer Lakes', ['Lake', 'Harney']],
  ['Klamath', ['Klamath', 'Lake', 'Jackson']],
  ['Rogue', ['Jackson', 'Josephine', 'Curry', 'Klamath', 'Douglas']],
  ['Umpqua', ['Douglas', 'Lane', 'Coos']],
  ['South Coast', ['Coos', 'Curry', 'Douglas']],
  ['Mid Coast', ['Lincoln', 'Lane', 'Benton', 'Douglas', 'Coos', 'Tillamook', 'Polk', 'Yamhill']],
];
const SHED_NAME = new RegExp(`^\\s*(${WATERSHEDS.slice(1).map(w => w[0].split(/[ /&]/)[0]).join('|')})\\b`, 'i');

export function parseOdfwReport(text, year) {
  const rows = [];
  let inTable = false, cols = null, cur = null, resident = false, prefix = '', lastLine = -9, shed = null;
  const lines = text.split('\n');
  lines.forEach((raw, n) => {
    // Older years print the 10-digit waterbody code one space before the name.
    const line = raw.replace(/\b(\d{8,12}) (?=[A-Za-z])/g, '$1  ');
    if (/^\s*Table\s+\d+[.\s–-]+Numbers? and Pounds of Fish Stocked by Watershed/i.test(line) && !/\.{4}/.test(line)) { inTable = true; return; }
    if (!inTable) return;
    if (/^\s*Table\s+\d+/i.test(line) && !/by Watershed/i.test(line)) { inTable = false; return; }
    if (/RESIDENT FISH/i.test(line)) resident = true;
    if (/ANADROMOUS FISH/i.test(line)) resident = false;
    const wb = line.search(/waterbody name|waterbody(?!\s+code)\b(?=.*species)/i), sp = line.search(/\bspecies\b/i);
    if (wb >= 0 && sp > wb) { cols = { wb, sp }; cur = null; return; }
    if (!cols) return;
    // The watershed starts a group: "  1  North Coast" (2006), "1 - NORTH" (2024), or just "North Coast" (2012).
    const lead = line.slice(0, Math.max(0, cols.wb - 2));
    const num = lead.match(/^\s*(\d{1,2})\s*-?\s*([A-Za-z]|$)/);
    if (num && +num[1] >= 1 && +num[1] <= 18) shed = +num[1];
    else if (SHED_NAME.test(lead)) {
      const w = lead.trim().toLowerCase();
      // The longest name that fits: "Malheur Lake" before "Malheur".
      const fits = WATERSHEDS.map((x, i) => x && (w.startsWith(x[0].toLowerCase()) || w.startsWith(x[0].toLowerCase().split(/[ /&]/)[0] + ' ') || w === x[0].toLowerCase().split(/[ /&]/)[0]) ? [i, x[0].length] : null).filter(Boolean);
      if (fits.length) shed = fits.sort((a, b) => b[1] - a[1])[0][0];
    }
    // Watershed and statewide totals end a water: the rows under "Species Totals" are not releases.
    if (/total/i.test(line)) { cur = null; prefix = ''; return; }
    const ps = pieces(line);
    if (!ps.length) return;
    const nums = []; for (let i = ps.length - 1; i >= 0 && NUM.test(ps[i].s); i--) nums.unshift(ps[i]);
    let wbPiece = ps.find(p => p.at >= cols.wb - 6 && p.at < cols.sp - 3 && !NUM.test(p.s))?.s;
    let spPiece = ps.find(p => p.at >= cols.sp - 3 && p.at < cols.sp + 14 && !NUM.test(p.s))?.s;
    const next = n === lastLine + 1 && cur;
    if (wbPiece && next && (/^\(/.test(wbPiece) || TYPE_ONLY.test(wbPiece) || /\b(below|above|at|of|near|and|to|&)$|[-,/]$/i.test(cur.water.name) || (nums.length < 2 && !WATER_END.test(cur.water.name)))) { cur.water.name += ' ' + wbPiece; wbPiece = null; }
    if (spPiece && cur && !SPECIES_END.test(cur.species.name) && (SPECIES_TAIL.test(spPiece) || nums.length < 2)) { cur.species.name += ' ' + spPiece; spPiece = null; }
    if (nums.length < 2) {
      if (spPiece) prefix = spPiece + ' ';
      if (wbPiece || spPiece) lastLine = n;
      return;
    }
    const water = wbPiece ? { name: wbPiece } : cur?.water;
    const species = spPiece ? { name: prefix + spPiece } : cur?.species;
    const hatchery = ps.filter(p => p.at > (cols.sp + 14) && !NUM.test(p.s)).map(p => p.s).slice(-1)[0] ?? null;
    prefix = '';
    if (!water || !species) return;
    cur = { y: year, shed, water, species, hatchery, fish: +nums.at(-2).s.replace(/,/g, ''), pounds: +nums.at(-1).s.replace(/,/g, ''), resident };
    rows.push(cur);
    lastLine = n;
  });
  return rows.map(r => ({ ...r, water: titleCase(r.water.name.replace(/\s+/g, ' ').trim()), species: titleCase(r.species.name.replace(/\s+/g, ' ').trim()).replace('Steehead', 'Steelhead') }));
}

// 2022 and 2023 print the table with merged cells: a water's name (and a species spanning rows) sits on the middle
// line of its group, so it can be above, beside or below its numbers. Each release goes to the nearby water name that
// had the same species and hatchery in other years' reports (`prior`), else to the nearest name.
export function parseOdfwReportCentered(text, year, prior = new Map()) {
  const items = [];
  let inTable = false, cols = null, shed = null, block = 0;
  text.split('\n').forEach((line, n) => {
    if (/^\s*Table\s+\d+[.\s–-]+Numbers? and Pounds of Fish Stocked by Watershed/i.test(line) && !/\.{4}|\s\d{1,3}\s*$/.test(line)) { inTable = true; block++; return; }
    if (!inTable) return;
    if (/^\s*Table\s+\d+/i.test(line) && !/by Watershed/i.test(line)) { inTable = false; return; }
    const wb = line.search(/waterbody/i), sp = line.search(/\bspecies\b/i), stock = line.search(/\bstock\b/i);
    if (wb >= 0 && sp > wb && stock > sp) { cols = { wb, sp, stock }; block++; return; }
    if (!cols) return;
    if (/total/i.test(line)) { block++; return; }
    const num = line.slice(0, Math.max(0, cols.wb - 2)).match(/^\s*(\d{1,2})\s*-/);
    if (num && +num[1] >= 1 && +num[1] <= 18) shed = +num[1];
    const ps = pieces(line);
    const nums = []; for (let i = ps.length - 1; i >= 0 && NUM.test(ps[i].s); i--) nums.unshift(ps[i]);
    const wbP = ps.find(p => p.at >= cols.wb - 10 && p.at < cols.sp - 6 && !NUM.test(p.s) && !/^\d{1,2}\s*-/.test(p.s))?.s;
    const spP = ps.find(p => p.at >= cols.sp - 12 && p.at < cols.stock - 2 && !NUM.test(p.s))?.s;
    const after = ps.filter(p => p.at >= cols.stock - 2 && !NUM.test(p.s));
    if (nums.length >= 2) items.push({ n, block, shed, kind: 'data', wb: wbP, sp: spP, stock: after[0]?.s, hatchery: after.slice(1).map(p => p.s).join(' ') || after[0]?.s,
      fish: +nums.at(-2).s.replace(/,/g, ''), pounds: +nums.at(-1).s.replace(/,/g, '') });
    else {
      if (wbP) items.push({ n, block, shed, kind: 'water', s: wbP });
      if (spP) items.push({ n, block, shed, kind: 'species', s: spP });
    }
  });
  // Water names that wrap ("BLIND SLOUGH" / "(COLUMBIA R-1)") are joined first.
  const names = [];
  for (const it of items) {
    const name = it.kind === 'water' ? it.s : it.kind === 'data' && it.wb ? it.wb : null;
    if (!name) continue;
    const last = names.at(-1);
    if (last && last.block === it.block && it.n - last.n === 1 && (/^\(/.test(name) || TYPE_ONLY.test(name))) { last.s += ' ' + name; continue; }
    names.push({ n: it.n, block: it.block, s: name });
  }
  const speciesLines = items.filter(i => i.kind === 'species');
  const rows = [];
  for (const d of items.filter(i => i.kind === 'data')) {
    // Species: on the line, completed by a word on the line below ("SPRING" / "CHINOOK"), or a label above.
    let species = d.sp;
    const near = speciesLines.filter(s => s.block === d.block && Math.abs(s.n - d.n) <= 2 && !s.used);
    if (species && !SPECIES_END.test(species)) { const tail = near.find(s => s.n === d.n + 1); if (tail) { species += ' ' + tail.s; tail.used = true; } }
    if (!species) {
      // A two-line species centred on its row: "WINTER" above, "STEELHEAD" below.
      const a = near.find(s => s.n === d.n - 1), b = near.find(s => s.n === d.n + 1);
      const pick = a && SPECIES_END.test(a.s) ? [a] : a && b ? [a, b] : b && SPECIES_END.test(b.s) ? [b] : a ? [a] : [];
      if (pick.length) { species = pick.map(s => s.s).join(' '); pick.forEach(s => s.used = true); }
    }
    if (!species) species = rows.at(-1)?.block === d.block ? rows.at(-1).species : null;
    if (!species) continue;
    species = titleCase(species.replace(/\s+/g, ' '));
    const cands = names.filter(w => w.block === d.block && Math.abs(w.n - d.n) <= 5);
    const known = prior.get(`${species}|${String(d.hatchery).toLowerCase()}`);
    const score = w => (w.n === d.n ? 3 : 0) - Math.abs(w.n - d.n) + (known?.has(titleCase(w.s)) ? 10 : 0);
    const water = cands.sort((a, b) => score(b) - score(a))[0];
    if (!water) continue;
    rows.push({ y: year, shed: d.shed, water: titleCase(water.s.replace(/\s+/g, ' ')), species: species.replace('Steehead', 'Steelhead'), fish: d.fish, pounds: d.pounds, hatchery: d.hatchery, block: d.block, resident: false });
  }
  return rows.map(({ block, ...r }) => r);
}
