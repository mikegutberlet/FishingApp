// Ocean rules for California and Oregon, kept by hand: who needs a license where, California's groundfish
// management areas, Oregon's marine reserves, and the pages that hold this year's seasons and depth limits.
// Seasons and depth limits change every year (sometimes mid-season), so the app never states them itself: it names
// your area and opens the agency's current summary. Area lines and license rules change rarely; check them each year.

export const CA_LINKS = {
  groundfish: ['CDFW groundfish summary (seasons, depths, limits by area)', 'https://wildlife.ca.gov/Fishing/Ocean/Regulations/Groundfish-Summary'],
  ocean: ['CDFW ocean sport fishing regulations', 'https://wildlife.ca.gov/Fishing/Ocean/Regulations'],
  mpas: ['CDFW Marine Protected Areas', 'https://wildlife.ca.gov/Conservation/Marine/MPAs'],
  license: ['CDFW fishing licenses', 'https://wildlife.ca.gov/Licensing/Fishing'],
};
export const CA_HOTLINE = '(831) 649-2801'; // CDFW recreational groundfish hotline, recorded and updated with in-season changes
export const OR_LINKS = {
  ocean: ['ODFW Marine Zone (ocean seasons and limits)', 'https://myodfw.com/fishing/marine-zone'],
  reserves: ['Oregon Marine Reserves', 'https://oregonmarinereserves.com/'],
  license: ['ODFW licenses', 'https://myodfw.com/licenses-and-tags'],
};

// California groundfish management areas, north to south (degrees north; the area runs from `north` down to `south`).
export const CA_AREAS = [
  { name: 'Northern', north: 42, south: 40 + 10 / 60, from: 'the Oregon border', to: 'Cape Mendocino (40°10′ N)' },
  { name: 'Mendocino', north: 40 + 10 / 60, south: 38 + 57.5 / 60, from: 'Cape Mendocino (40°10′ N)', to: 'Point Arena (38°57.5′ N)' },
  { name: 'San Francisco', north: 38 + 57.5 / 60, south: 37 + 11 / 60, from: 'Point Arena (38°57.5′ N)', to: 'Pigeon Point (37°11′ N)' },
  { name: 'Central', north: 37 + 11 / 60, south: 34 + 27 / 60, from: 'Pigeon Point (37°11′ N)', to: 'Point Conception (34°27′ N)' },
  { name: 'Southern', north: 34 + 27 / 60, south: 32.5, from: 'Point Conception (34°27′ N)', to: 'the Mexican border' },
];
export const caArea = lat => CA_AREAS.find(a => lat < a.north + 1e-9 && lat >= a.south) ?? (lat >= 42 ? CA_AREAS[0] : CA_AREAS.at(-1));

// The Ocean Enhancement Validation is needed for ocean fishing south of Point Arguello (34°34.6′ N).
const ARGUELLO = 34 + 34.6 / 60;

// kind: 'pier' | 'jetty' | 'beach' | 'surf' | 'harbor' | 'spot' (coast.js). Returns [{ icon, title, text, tone }].
export function licenseFacts(spot, state) {
  const out = [];
  if (state === 'CA') {
    if (spot.kind === 'pier') out.push({ icon: '🎣', tone: 'good', title: 'No license needed on a public pier',
      text: 'In California nobody needs a fishing license to fish from a public pier in ocean or bay waters (a publicly owned pier open to everyone). Size, bag limits and seasons still apply, and you may use no more than two rods and lines (or two nets or traps) at a time. A private or members-only pier does not count, and neither do jetties, breakwaters, rocks or the beach.' });
    else out.push({ icon: '🪪', tone: '', title: 'California license needed (16 and over)',
      text: `From ${spot.kind === 'jetty' ? 'a jetty or breakwater' : spot.kind === 'harbor' ? 'a harbor shore or boat' : 'the beach, rocks or a boat'} you need a California sport fishing license if you are 16 or older. Only public piers are exempt. The two Free Fishing Days each year are the exception.` });
    if (spot.lat < ARGUELLO && spot.kind !== 'pier') out.push({ icon: '🌊', tone: '', title: 'Ocean Enhancement Validation',
      text: 'South of Point Arguello you also need the Ocean Enhancement Validation on your annual license to fish in ocean waters (not needed with a one- or two-day license).' });
  } else if (state === 'OR') {
    out.push({ icon: '🪪', tone: '', title: 'Oregon license needed, piers too',
      text: 'Oregon has no public pier exemption: anyone 12 or older needs an angling license to fish in the ocean and bays, piers and jetties included. Crabbing and clamming take a shellfish license. Salmon, steelhead, sturgeon and halibut also need the Combined Angling Tag. Free Fishing Weekends are the exception.' });
  }
  return out;
}

// What the groundfish rules mean for this spot. Shore and pier anglers are treated differently from boats in both states.
export function groundfishFacts(spot, state) {
  if (state === 'CA') {
    const a = caArea(spot.lat);
    return { area: `${a.name} Groundfish Management Area`, span: `${a.from} to ${a.to}`,
      text: `Rockfish, lingcod and other groundfish seasons and depth limits are set for each area and change during the year. ${spot.kind === 'pier' || spot.kind === 'jetty' || spot.kind === 'beach' || spot.kind === 'surf'
        ? 'Shore-based anglers (from piers, jetties and the beach) are generally not held to the boat depth limits; check the summary for current shore rules and any species closures.'
        : 'Boat anglers must stay inside the area’s depth limit while it applies.'} Call the CDFW groundfish hotline at ${CA_HOTLINE} before you go.`,
      links: [CA_LINKS.groundfish, CA_LINKS.ocean] };
  }
  if (state === 'OR') return { area: 'Oregon ocean (Marine Zone)', span: 'Oregon coast, ocean and bays',
    text: 'Bottomfish limits, the seasonal depth line for boats, and halibut, salmon and crab seasons are set by ODFW each year and change in season. Check the Marine Zone page before you go.',
    links: [OR_LINKS.ocean] };
  return null;
}

// Marine protected area designations, most restrictive first. `take`: 'none' = no fishing at all, 'some' = only what
// that area's own rules allow (check them), 'rec' = recreational take allowed with limits.
export const MPA_TYPES = {
  SMR: { label: 'State Marine Reserve', take: 'none', note: 'No take: no fishing or collecting of any kind.' },
  'No-Take SMCA': { label: 'No-Take State Marine Conservation Area', take: 'none', note: 'No take: no fishing (some permitted activities only).' },
  SMCA: { label: 'State Marine Conservation Area', take: 'some', note: 'Limited take: only the species and gear that this area allows. Check its rules before you fish.' },
  SMP: { label: 'State Marine Park', take: 'some', note: 'Limited take: no commercial take; recreational take only as this area allows.' },
  SMRMA: { label: 'State Marine Recreational Management Area', take: 'some', note: 'Limited take: check this area’s rules.' },
  SC: { label: 'Special Closure', take: 'some', note: 'Closed to entry or certain activities, often near seabird and marine mammal rookeries.' },
  'Marine Reserve': { label: 'Oregon Marine Reserve', take: 'none', note: 'No take: no fishing, crabbing or collecting of any kind.' },
  'Marine Protected Area': { label: 'Oregon Marine Protected Area', take: 'some', note: 'Limited take: some fishing allowed. Check this area’s rules.' },
  'Seabird Protection Area': { label: 'Oregon Seabird Protection Area', take: 'some', note: 'Fishing allowed, but stay off the rocks and away from nesting birds.' },
};
export const mpaType = t => MPA_TYPES[t] ?? { label: t || 'Protected area', take: 'some', note: 'Check this area’s rules before you fish.' };

// Free text the CA layer gives for a type (e.g. "SMCA (No-Take)", "State Marine Reserve") into a key above.
export function mpaKey(type, name = '') {
  const s = `${type} ${name}`;
  if (/no[- ]?take/i.test(s) && /SMCA|conservation/i.test(s)) return 'No-Take SMCA';
  if (/\bSMRMA\b|recreational management/i.test(s)) return 'SMRMA';
  if (/\bSMR\b|state marine reserve/i.test(s)) return 'SMR';
  if (/\bSMCA\b|conservation area/i.test(s)) return 'SMCA';
  if (/\bSMP\b|state marine park/i.test(s)) return 'SMP';
  if (/special closure/i.test(s)) return 'SC';
  if (/seabird/i.test(s)) return 'Seabird Protection Area';
  if (/marine reserve/i.test(s)) return 'Marine Reserve';
  if (/protected area/i.test(s)) return 'Marine Protected Area';
  return type;
}
