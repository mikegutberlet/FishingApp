// One spelling for a water's name, so agency lists, archived pages and the map's names line up: abbreviations
// spelled out (LK, RES, CR, R, FK, N/S), "X River, North Fork" read as "North Fork X River", "Lake X" as "X Lake",
// a river's section number dropped ("McKenzie River 1", "Deschutes River - 5"), notes in parentheses dropped.
// Shared by the app (stock-history.js) and the data job (scripts/build-stock-history.mjs).
const DIR = { n: 'north', s: 'south', e: 'east', w: 'west', m: 'middle', mid: 'middle', mf: 'middle', north: 'north', south: 'south', east: 'east', west: 'west', middle: 'middle' };

export function nameKey(name) {
  let s = String(name ?? '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/&/g, ' and ').replace(/[.']/g, '').replace(/\s+/g, ' ').trim();
  s = s.replace(/\blk\b|\blks\b/g, 'lake').replace(/\bres\b|\brsvr\b|\bresv\b|\breservopir\b|\brservoir\b/g, 'reservoir').replace(/\bpd\b|\bpds\b/g, 'pond')
    .replace(/\bcr\b|\bck\b|\bcrk\b/g, 'creek').replace(/\br\b/g, 'river').replace(/\bfk\b/g, 'fork').replace(/\bmt\b/g, 'mount').replace(/\bst\b/g, 'saint')
    .replace(/\bsl\b/g, 'slough').replace(/\bnwr\b/g, 'national wildlife refuge');
  // "Klaskanine River, South Fork" / "Klaskanine R, S Fk" → "south fork klaskanine river".
  s = s.replace(/^(.+?),\s*(n|s|e|w|m|mid|north|south|east|west|middle)\s+fork\b(.*)$/, (m, a, d, rest) => `${DIR[d]} fork ${a}${rest}`);
  s = s.replace(/\b(n|s|e|w|m|mid)\s+fork\b/g, (m, d) => `${DIR[d]} fork`);
  s = s.replace(/^(.+?),\s*(upper|lower|north|south|east|west|middle)$/, '$2 $1');
  // "Carson River East Fork" → "east fork carson river"; "American River Lower" is the American River.
  s = s.replace(/^(.+?\b(?:river|creek))\s+(north|south|east|west|middle)\s+fork$/, '$2 fork $1').replace(/^(.+?\b(?:river|creek))\s+(upper|lower)$/, '$1');
  s = s.replace(/\b(river|creek|slough)\s*(-\s*)?\d+$/, '$1');
  s = s.replace(/^lake\s+(.+)$/, '$1 lake').replace(/\bthe\b/g, '');
  return s.replace(/[^a-z0-9]/g, '');
}
