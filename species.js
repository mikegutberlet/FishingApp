// Fish names, one list for the whole app: the catch form, the finder's fish filter, the stocking and history cards,
// stats and the archive catalogue all name a fish by its entry here. The states write the same fish many ways
// ("RB", "Raibow Trout", "Cuttbow", "Legal trout", "Winter Steelhead"); their records are kept exactly as written and
// read through speciesName() / speciesLabel() when shown. A catch logged as plain "Trout" stays that way until you
// pick the kind on its form.
//
// of: the wider name it also counts as ("Lahontan cutthroat trout" is a "Cutthroat trout", which is a "Trout"), so a
// catch-all name offers its kinds and the finder's "Cutthroat" matches every cutthroat.
// states: where it's caught or stocked (CA, NV, OR); the kinds offered on the catch form are the water's state's.
// re: tested against the cleaned, lowercase name, narrowest names first ("Eagle Lake trout" before "Rainbow trout"
// before "Trout"), else in list order; the first match wins.
export const SPECIES = [
  // Trout, char and their hybrids
  { name: 'Rainbow trout', of: 'Trout', states: 'CA NV OR', re: /rainbow|kamloops?|^rbt?$/ },
  { name: 'Steelhead', of: 'Trout', states: 'CA OR', re: /steelhead/ },
  { name: 'Brown trout', of: 'Trout', states: 'CA NV OR', re: /\bbrown\b(?!.*bullhead)|loch leven|^bn$/ },
  { name: 'Brook trout', of: 'Trout', states: 'CA NV OR', re: /\bbrook\b|^bk$|^ebt$/ },
  { name: 'Cutthroat trout', of: 'Trout', states: 'CA NV OR', re: /cutthroat|^ct$/ },
  { name: 'Golden trout', of: 'Trout', states: 'CA', re: /golden trout|^golden$/ },
  { name: 'Cutbow trout', of: 'Trout', states: 'NV', re: /cutbow/ },
  { name: 'Tiger trout', of: 'Trout', states: 'NV OR', re: /tiger(?! musk)|^tt$/ },
  { name: 'Lake trout', of: 'Trout', states: 'CA NV OR', re: /lake trout|mackinaw|laker/ },
  { name: 'Splake', of: 'Trout', states: '', re: /splake/ },
  { name: 'Bull trout', of: 'Trout', states: 'NV OR', re: /bull trout/ },
  { name: 'Dolly Varden', of: 'Trout', states: '', re: /dolly varden/ },
  { name: 'Trout', re: /trout|^(legal|trophy|brood|fingerling|catchable)s?$/ },
  // Subspecies and strains
  { name: 'Eagle Lake trout', of: 'Rainbow trout', states: 'CA', re: /eagle lake/ },
  { name: 'Redband trout', of: 'Rainbow trout', states: 'CA NV OR', re: /redband|mccloud/ },
  { name: 'Kern River rainbow trout', of: 'Rainbow trout', states: 'CA', re: /kern river rainbow/ },
  { name: 'Lahontan cutthroat trout', of: 'Cutthroat trout', states: 'CA NV OR', re: /lahontan(?! (redside|speckled|tui))|pilot peak|^lct$/ },
  { name: 'Paiute cutthroat trout', of: 'Cutthroat trout', states: 'CA', re: /paiute/ },
  { name: 'Coastal cutthroat trout', of: 'Cutthroat trout', states: 'CA OR', re: /coast(al)? cutthroat|sea[- ]run cutthroat/ },
  { name: 'Westslope cutthroat trout', of: 'Cutthroat trout', states: 'OR', re: /westslope/ },
  { name: 'Yellowstone cutthroat trout', of: 'Cutthroat trout', states: 'NV', re: /yellowstone/ },
  { name: 'Bonneville cutthroat trout', of: 'Cutthroat trout', states: 'NV', re: /bonneville/ },
  { name: 'Colorado River cutthroat trout', of: 'Cutthroat trout', states: '', re: /colorado river cutthroat/ },
  { name: 'Greenback cutthroat trout', of: 'Cutthroat trout', states: '', re: /greenback/ },
  { name: 'Little Kern golden trout', of: 'Golden trout', states: 'CA', re: /little kern/ },
  { name: 'Arctic grayling', states: 'CA NV OR', re: /grayling/ },
  { name: 'Mountain whitefish', states: 'CA NV OR', re: /mountain whitefish|^whitefish$/ },
  { name: 'Lake whitefish', states: 'NV', re: /lake whitefish/ },
  // Salmon
  { name: 'Kokanee', of: 'Salmon', states: 'CA NV OR', re: /kokanee/ },
  { name: 'Chinook salmon', of: 'Salmon', states: 'CA NV OR', re: /chinook|king salmon/ },
  { name: 'Coho salmon', of: 'Salmon', states: 'CA OR', re: /coho|silver salmon/ },
  { name: 'Sockeye salmon', of: 'Salmon', states: 'OR', re: /sockeye/ },
  { name: 'Chum salmon', of: 'Salmon', states: 'OR', re: /\bchum\b/ },
  { name: 'Pink salmon', of: 'Salmon', states: 'OR', re: /pink salmon/ },
  { name: 'Atlantic salmon', of: 'Salmon', states: '', re: /atlantic salmon/ },
  { name: 'Salmon', re: /salmon/ },
  // Bass
  { name: 'Largemouth bass', of: 'Black bass', states: 'CA NV OR', re: /largemouth|bigmouth bass/ },
  { name: 'Smallmouth bass', of: 'Black bass', states: 'CA NV OR', re: /smallmouth/ },
  { name: 'Spotted bass', of: 'Black bass', states: 'CA', re: /spotted bass/ },
  { name: 'Black bass', re: /^(black )?bass$/ },
  { name: 'Wiper', states: 'NV', re: /wiper|hybrid striped/ },
  { name: 'Striped bass', states: 'CA NV OR', re: /striped bass|striper/ },
  { name: 'White bass', states: 'NV', re: /^white bass/ },
  // Panfish
  { name: 'Bluegill', of: 'Sunfish', states: 'CA NV OR', re: /bluegill/ },
  { name: 'Redear sunfish', of: 'Sunfish', states: 'CA NV OR', re: /redear/ },
  { name: 'Green sunfish', of: 'Sunfish', states: 'CA NV OR', re: /green sunfish/ },
  { name: 'Pumpkinseed', of: 'Sunfish', states: 'CA OR', re: /pumpkinseed/ },
  { name: 'Warmouth', of: 'Sunfish', states: 'CA OR', re: /warmouth/ },
  { name: 'Sunfish', re: /sunfish/ },
  { name: 'Black crappie', of: 'Crappie', states: 'CA NV OR', re: /black crappie/ },
  { name: 'White crappie', of: 'Crappie', states: 'CA NV OR', re: /white crappie/ },
  { name: 'Crappie', re: /crappie/ },
  { name: 'Yellow perch', states: 'CA NV OR', re: /yellow perch|perch,? yellow|^perch$/ },
  { name: 'Sacramento perch', states: 'CA NV', re: /sacramento perch/ },
  // Pike, walleye
  { name: 'Walleye', states: 'NV OR', re: /walleye/ },
  { name: 'Northern pike', states: 'CA', re: /northern pike|^pike$/ },
  { name: 'Tiger muskie', states: 'NV', re: /tiger musk/ },
  { name: 'Muskellunge', states: '', re: /muskellunge|musk(ie|y)/ },
  // Catfish
  { name: 'Channel catfish', of: 'Catfish', states: 'CA NV OR', re: /channel cat/ },
  { name: 'Blue catfish', of: 'Catfish', states: 'CA', re: /blue cat/ },
  { name: 'Flathead catfish', of: 'Catfish', states: 'CA', re: /flathead/ },
  { name: 'White catfish', of: 'Catfish', states: 'CA OR', re: /white cat/ },
  { name: 'Brown bullhead', of: 'Catfish', states: 'CA NV OR', re: /brown bullhead/ },
  { name: 'Black bullhead', of: 'Catfish', states: 'CA NV OR', re: /black bullhead/ },
  { name: 'Yellow bullhead', of: 'Catfish', states: 'OR', re: /yellow bullhead/ },
  { name: 'Catfish', re: /catfish|bullhead/ },
  // Others
  { name: 'White sturgeon', of: 'Sturgeon', states: 'CA OR', re: /white sturgeon/ },
  { name: 'Green sturgeon', of: 'Sturgeon', states: 'CA OR', re: /green sturgeon/ },
  { name: 'Sturgeon', re: /sturgeon/ },
  { name: 'American shad', states: 'CA OR', re: /american shad|^shad$/ },
  { name: 'Common carp', states: 'CA NV OR', re: /^(common )?carp$/ },
];
export const SPECIES_NAMES = SPECIES.map(s => s.name);
// A few to start from before you've logged anything (the catch form's chips, trip mode's Catch buttons).
export const STARTER_SPECIES = ['Rainbow trout', 'Brown trout', 'Largemouth bass', 'Smallmouth bass', 'Striped bass', 'Channel catfish', 'Bluegill', 'Kokanee'];
const byName = new Map(SPECIES.map(s => [s.name.toLowerCase(), s]));

// Every wider name a fish counts as, itself first: "Lahontan cutthroat trout" → it, "Cutthroat trout", "Trout".
export function speciesLine(name) {
  const out = [];
  for (let s = byName.get(String(name ?? '').toLowerCase()); s && !out.includes(s.name); s = byName.get(s.of?.toLowerCase())) out.push(s.name);
  return out;
}
const MATCH_ORDER = [...SPECIES].sort((a, b) => speciesLine(b.name).length - speciesLine(a.name).length);

// The states' typos, and joined words, fixed before matching.
const clean = raw => ` ${String(raw ?? '').toLowerCase().replace(/[^a-z, -]/g, ' ')} `
  .replace(/\b(raibow|trainbow|rainbo)\b/g, 'rainbow').replace(/\bcut+h?ro(u|a|ua)?t\b/g, 'cutthroat')
  .replace(/\b(cut+bow|bow-?cut+)\b/g, 'cutbow').replace(/\bcati(fsh|fish)\b/g, 'catfish').replace(/\b(bleugill|blue gill)\b/g, 'bluegill')
  .replace(/\s+/g, ' ').trim();

// The list's name for a fish however a record writes it, or null when it isn't one we know ("Spring", "72t").
const memo = new Map();
export function speciesName(raw) {
  const s = clean(raw);
  if (!memo.has(s)) memo.set(s, s ? MATCH_ORDER.find(x => x.re.test(s))?.name ?? null : null);
  return memo.get(s);
}
// A catch's name for counting: the list's name when it is one we know, else the name as typed.
export const fishName = raw => speciesName(raw) ?? (String(raw ?? '').trim() || null);

// What a record adds that the list's name doesn't say: the size class, the run or the strain.
const QUALS = [[/\blegal/, 'legal size'], [/trophy/, 'trophy'], [/brood/, 'brood'], [/fingerling/, 'fingerling'], [/catchable/, 'catchable'],
  [/\bspring\b/, 'spring run'], [/\bsummer\b/, 'summer run'], [/\bfall\b/, 'fall run'], [/\bwinter\b/, 'winter run'], [/kamloops?/, 'Kamloops'], [/pilot peak/, 'Pilot Peak']];
// A record's species as shown: "RB" → "Rainbow trout", "Winter Steelhead" → "Steelhead (winter run)", "Pilot Peak
// Cutthroat Trout" → "Lahontan cutthroat trout (Pilot Peak)". A name we don't know, or one that only fits a catch-all
// ("Legal trout", "Flat Bullhead"), is shown as written.
export function speciesLabel(raw) {
  const name = speciesName(raw);
  if (!name || (isCatchAll(name) && clean(raw) !== name.toLowerCase())) return String(raw ?? '').trim();
  const s = clean(raw), q = QUALS.filter(([re]) => re.test(s) && !re.test(name.toLowerCase())).map(([, t]) => t);
  return q.length ? `${name} (${q.join(', ')})` : name;
}

// The kinds a name can be narrowed to on the catch form, those of the water's state only when it's known.
export function kindsOf(name, stateCode = null) {
  const n = fishName(name)?.toLowerCase();
  return SPECIES.filter(s => s.of?.toLowerCase() === n && (stateCode ? s.states.includes(stateCode) : s.states)).map(s => s.name);
}
// A catch-all name a catch can be narrowed from: "Trout", "Salmon", "Black bass", "Catfish".
export const isCatchAll = name => { const s = byName.get(fishName(name)?.toLowerCase()); return !!s && !s.of && SPECIES.some(x => x.of === s.name); };
