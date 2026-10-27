// Hand-kept rules for the before-you-go checklist: which license a water takes, boat inspections, passes and bear
// canisters. Each list names specific waters or land units on purpose (no blanket warnings): add a water here when you
// learn its rule, with the source. Rules change; every line tells you to check, and the agency has the final word.

// Waters on a state line where another state's license is good too. Matched by name and the water's state.
export const SHARED_WATERS = [
  { re: /^(lake\s+)?topaz\b/i, states: ['CA', 'NV'], also: ['CA', 'NV'], text: 'Topaz Lake sits on the state line: a California or a Nevada license is good anywhere on it.' },
  { re: /\btahoe\b/i, states: ['CA', 'NV'], also: ['CA', 'NV'], text: 'Lake Tahoe: from a boat, a California or a Nevada license works anywhere on the lake. From shore you need the license of the state you stand in.' },
  { re: /^(lake\s+)?(mead|mohave)\b|\bcolorado river\b/i, states: ['NV'], text: 'Lake Mead, Lake Mohave and the Colorado River: a Nevada license, or an Arizona license with Nevada’s special use stamp for these waters (and the other way round on the Arizona side).' },
  { re: /\bcolumbia river\b/i, states: ['OR'], also: ['OR', 'WA'], text: 'On the Columbia where it is the Oregon–Washington line, an Oregon or a Washington license is good (not in tributaries or sloughs off the main river).' },
  { re: /\bsnake river\b|^brownlee|^oxbow|hells canyon/i, states: ['OR'], also: ['OR', 'ID'], text: 'On the Snake where it is the Oregon–Idaho line (and Brownlee, Oxbow and Hells Canyon reservoirs), an Oregon or an Idaho license is good. Not in tributaries.' },
];

// Who needs a license, and the add-ons each state sells.
export const LICENSE = {
  CA: { age: 16, buy: 'https://wildlife.ca.gov/Licensing/Fishing', extras: [
    { when: 'always', text: 'Fishing two rods? You need a Second Rod Validation.' },
    { when: 'river', text: 'Steelhead (any water they can reach from the ocean): carry a Steelhead Report Card.' },
    { when: 'sturgeon', text: 'Sturgeon: carry a Sturgeon Report Card.' }] },
  NV: { age: 12, buy: 'https://ndowlicensing.com/', extras: [] },
  OR: { age: 12, buy: 'https://myodfw.com/', extras: [
    { when: 'always', text: 'Salmon, steelhead, sturgeon or halibut: you also need a Combined Angling Tag.' },
    { when: 'always', text: 'Fishing two rods (where allowed)? You need a Two-Rod Validation.' }] },
};

// Boats: each state's rule, plus waters that inspect every boat or carry quagga mussels.
export const BOAT_STATE = {
  CA: 'California-registered boats need a current Quagga and Zebra Mussel Fee sticker. Arrive clean, drained and dry: inspection stations on the highways stop boats coming from other states.',
  NV: 'Nevada-registered boats, motorized or not, must show a current Nevada AIS decal (not needed on California-registered boats at Topaz Lake or Lake Tahoe). Clean, drain and dry between waters.',
  OR: 'Every boat must stop at an open aquatic invasive species inspection station. Paddle craft 10 ft and longer need a Waterway Access Permit; motorboats have theirs with the registration.',
};
export const BOAT_WATERS = [
  { re: /\btahoe\b/i, text: 'Lake Tahoe: motorized boats must be inspected (and decontaminated if needed) at a Tahoe inspection station before launching. Paddle craft: self-inspect, clean, drain and dry.' },
  { re: /^donner\b|\bdonner lake\b/i, text: 'Donner Lake: motorized boats need an invasive species inspection before launching.' },
  { re: /\bcasitas\b/i, text: 'Lake Casitas inspects every boat and can require a waiting period for one used on other waters. Call ahead.' },
  { re: /\bcachuma\b/i, text: 'Lake Cachuma inspects boats at the gate for mussels; one used elsewhere may need a waiting period. Call ahead.' },
  { re: /\b(nacimiento|san antonio)\b/i, text: 'Lakes Nacimiento and San Antonio inspect and tag boats for mussels. Call ahead.' },
  { re: /^lopez\b/i, text: 'Lopez Lake inspects boats for mussels before launch.' },
  { re: /\b(camanche|pardee)\b/i, text: 'Camanche and Pardee (EBMUD) inspect boats for mussels; launching may need a certificate. Call ahead.' },
  { re: /^(lake\s+)?(mead|mohave|havasu)\b|\bcolorado river\b/i, text: 'Quagga mussels live here. Clean, drain and dry before you leave; inspection stations will check the boat on the way home.' },
];

// Passes. Per water first, then by the land unit around it (from the Camping tab's land lookup).
export const PASS_WATERS = [
  { re: /^jenks\b/i, text: 'Jenks Lake (San Bernardino NF): an Adventure Pass is needed to park at the day-use area.' },
  { re: /\bfulmor\b/i, text: 'Lake Fulmor (San Bernardino NF): display an Adventure Pass to park.' },
  { re: /^crystal lake\b/i, text: 'Crystal Lake (Angeles NF): an Adventure Pass is needed to park in the recreation area.' },
  { re: /\b(west|east) fork san gabriel\b/i, text: 'San Gabriel River forks (Angeles NF): an Adventure Pass is needed at the signed parking areas.' },
];
export const PASS_UNITS = [
  { re: /\b(angeles|san bernardino|cleveland|los padres) national forest\b/i, text: unit => `${unit}: an Adventure Pass (or an America the Beautiful pass) is needed at the forest’s signed day-use and parking sites. Not everywhere: look for the sign.` },
  { re: /\b(mt\.? hood|mount hood|willamette|deschutes|umpqua|siuslaw|rogue river|fremont|winema|malheur|umatilla|wallowa|ochoco) national forest\b/i, text: unit => `${unit}: many trailheads and day-use sites need a Northwest Forest Pass (or an America the Beautiful pass). Look for the sign.` },
];

// Bear canisters for a night out, by the land unit around the water.
export const BEAR_UNITS = [
  { re: /\b(yosemite|sequoia|kings canyon)\b/i, level: 'required', text: unit => `${unit}: a hard-sided bear canister is required for overnight trips in the wilderness, and food goes in the bear box at campgrounds.` },
  { re: /\b(ansel adams|john muir|golden trout) wilderness\b/i, level: 'required', text: unit => `${unit}: bear canisters are required for overnight trips in much of it (Inyo National Forest’s food storage order). Check the zone you camp in.` },
  { re: /\b(desolation|hoover|emigrant|dinkey lakes|kaiser|mokelumne|carson-iceberg|south sierra|domeland|granite chief|mount rose) wilderness\b/i, level: 'recommended', text: unit => `${unit}: carry a bear canister for overnight trips (required in parts of the Sierra, and bears here know about food hung in trees).` },
];
export const BEAR_DEFAULT = 'Camping in bear country: keep food, coolers and scented things locked in your vehicle or a bear box, never in the tent.';
