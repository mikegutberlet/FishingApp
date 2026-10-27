// What the land around a water means for camping, for the Camping tab: who lets you camp where, for how long, and
// the permits and fire rules that go with it. General rules only, each with a link to the regulation or agency page;
// the forest's or district's own orders and closures are the word to go by.
import { MANAGERS } from './access-rules.js';

export const BLM_STAY = { text: '14 days in any 28-day period, then move on', url: 'https://www.ecfr.gov/current/title-43/subtitle-B/chapter-II/subchapter-H/part-8360/subpart-8365/section-8365.1-2' };
export const FS_STAY = { text: 'usually 14 days (each forest’s order sets the exact limit)', url: 'https://www.ecfr.gov/current/title-36/chapter-II/part-261/subpart-B/section-261.58' };
export const LNT_URL = 'https://lnt.org/why/7-principles/';
export const CA_CAMPFIRE_PERMIT = 'https://www.preventwildfireca.org/Campfire-Permit/';

// Who manages the land, and whether you can camp for free outside a campground there.
//   yes: dispersed camping is generally allowed (unless an order or sign closes the spot)
//   wild: backpacking only (wilderness: no vehicles; some need a permit)
//   no: camp only in a campground
export function dispersedFor(parcel) {
  const m = parcel?.manager;
  if (parcel?.designation === 'WA') return { verdict: 'wild', text: 'Wilderness: camp anywhere you hike in to (no vehicles, no bikes), 200 ft from water. Some wildernesses need a free overnight permit or have quotas; check the forest page.' };
  if (m === 'USFS') return { verdict: 'yes', text: `National Forest land: free dispersed camping is generally allowed outside developed sites, unless the forest has closed the area. Stay limit ${FS_STAY.text}. Drive and park only where the forest’s Motor Vehicle Use Map allows.`, stay: FS_STAY };
  if (m === 'BLM') return { verdict: 'yes', text: `BLM land: free dispersed camping is generally allowed unless posted closed, for ${BLM_STAY.text}. Use existing campsites and stay on designated routes.`, stay: BLM_STAY };
  if (m === 'USBR') return { verdict: 'no', text: 'Bureau of Reclamation land: camping is usually limited to the campgrounds the partner agency runs; some reservoirs allow shoreline camping in marked areas.' };
  if (m === 'USACE') return { verdict: 'no', text: 'Army Corps of Engineers project: camp in its campgrounds; camping elsewhere on the project is not allowed unless posted.' };
  if (m === 'PVT' || m === 'NGO') return { verdict: 'no', text: 'Private land: no camping without the owner’s permission.' };
  if (['BIA', 'TRIB'].includes(m)) return { verdict: 'no', text: 'Tribal land: camping only with the tribe’s permission or in its campgrounds.' };
  if (['DOD'].includes(m)) return { verdict: 'no', text: 'Military land: no public camping.' };
  if (m) return { verdict: 'no', text: `${MANAGERS[m]?.name ?? 'This agency'}: camp only in its campgrounds.` };
  return { verdict: 'unknown', text: 'Land manager not recorded.' };
}

// The rough answer for the water: free camping right around it, nearby on public land, or campgrounds only.
export function dispersedSummary(parcels) {
  const rows = (parcels ?? []).map(p => ({ ...p, rule: dispersedFor(p) }));
  const yes = rows.filter(r => r.rule.verdict === 'yes'), wild = rows.filter(r => r.rule.verdict === 'wild');
  const level = yes.length ? 'yes' : wild.length ? 'wild' : rows.length ? 'no' : 'unknown';
  return { level, rows, yes, wild };
}

// Fire: California needs a campfire permit for any fire or stove outside a developed campground on federal and state
// responsibility land; every state adds seasonal restrictions on top.
export const FIRE = {
  CA: { text: 'A free California campfire permit is required for any campfire, barbecue or camp stove outside a developed campground.', links: [['Get a campfire permit', CA_CAMPFIRE_PERMIT]] },
  OR: { text: 'Oregon puts campfire bans in place every summer, often for stoves too; check before you light anything.', links: [['Oregon fire restrictions (ODF)', 'https://www.oregon.gov/odf/fire/pages/restrictions.aspx']] },
  NV: { text: 'Nevada’s land agencies put fire restrictions in place every summer; check before you light anything.', links: [['Nevada fire restrictions', 'https://www.nevadafireinfo.org/']] },
};

// Kind of camping a site offers, as one word for the list.
export const KIND_TEXT = { developed: 'Campground', primitive: 'Primitive campground', group: 'Group camp', rv: 'RV park', cabin: 'Cabins', dispersed: 'Dispersed area', boat: 'Boat-in camp', hike: 'Hike-in camp' };
