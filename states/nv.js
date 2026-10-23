// Nevada: NDOW stocking and fishing reports, USGS and Reclamation lake levels, read from the files the Nevada data
// jobs write to data/nv/ (scripts/nv/*.mjs and scripts/build-state-*.mjs).
import { stateData, isRiver } from './common.js';
import { haversineKm } from '../data-sources.js';

const d = stateData('nv', 'NV');

export const code = 'NV';
export const name = 'Nevada';
export const agency = 'NDOW';
export const stockField = 'ndowWaterId';
export const levelSource = 'USGS';
export const waterUrl = slug => `https://www.ndow.org/waters/${encodeURIComponent(slug)}/`;
export const scheduleUrl = 'https://www.ndow.org/get-outside/fishing-stocking-reports/';
// Lake Mead and Lake Mohave sit on the Arizona line, so the box takes in the river's east bank too.
export const bbox = [-120.01, 34.99, -114.03, 42.01];
export const outline = [[-120.0, 42.0], [-114.04, 42.0], [-114.04, 36.2], [-114.0, 36.0], [-114.0, 35.0], [-114.63, 35.0], [-115.27, 35.512], [-115.919, 36.022], [-116.577, 36.528], [-117.244, 37.03], [-117.92, 37.529], [-118.605, 38.024], [-119.298, 38.514], [-120.0, 39.0]];
export const plantsNote = 'NDOW reports each stocking with the number and average length of the fish. History grows each night from the NDOW water pages.';
export const searchBy = 'region';
export const searchHint = 'Pyramid, Truckee River, Wildhorse…';
export const stockedHint = 'Topaz, Sparks Marina, Wildhorse…';

export const { waters, plantsFor, dataDates, nearestWaters, nearestReservoir, statewide, history, matchStockedWater, historyFor, hydroFor, bathymetryFor, bathymetryUrl } = d;

// NDOW's page for a stocked water: latest fishing report and the "pertinent information" write-up.
export async function reportFor(lake) {
  const w = await d.load('waters');
  const id = lake.ndowWaterId ?? (await matchStockedWater(lake))?.id;
  return w?.waters.find(x => x.id === id) ?? null;
}

// ---------- Safety: toxic algae (nightly), regulations and fish consumption advisories (weekly) ----------
// Names in the regulations and on NDOW's pages are written several ways: "Walker River, East Fork",
// "East Walker River", "South Fork of the Humboldt River", "Mountain View Pond- LY", "Paradise Ponds". These words
// make those the same.
const regWords = s => String(s ?? '').toLowerCase().replace(/[’']/g, '').replace(/^(.+?),\s*(.+)$/, '$2 $1').replace(/\s*[–—-]\s+.*$/, '')
  .replace(/#\s*\d+/g, '').split(/[^a-z0-9]+/).filter(w => w && !/^(the|of|fork|park|community)$/.test(w)).map(w => w === 'ponds' ? 'pond' : w);
const WATER_WORD = /^(lake|reservoir|res|pond|river|creek|wash|slough)$/;
// Same water: same words, or one is the other plus a place ("Lake Tahoe – Cave Rock"), not plus another water word
// ("Cold Creek" is not "Cold Creek Reservoir") and not mid-word ("Big Wash" is not "Big Washoe Lake").
// Pass the lake as a and the rule or advisory as b. pondOk: "Martin Slough" is the rule's "Martin Slough Pond".
export function sameWater(a, b, { pondOk = false } = {}) {
  const x = regWords(a), y = regWords(b), xs = x.join(''), ys = y.join('');
  if (xs.length < 4 || ys.length < 4) return false;
  if (xs === ys) return true;
  // A rule for "Jarbidge River" covers its West Fork too (but an East Walker rule doesn't cover the Walker River).
  if (ys.length < xs.length && /(river|creek)$/.test(ys) && /^(north|south|east|west|middle)$/.test(x[0]) && x.slice(1).join('') === ys) return true;
  const [long, short] = xs.length > ys.length ? [x, ys] : [y, xs];
  if (!long.join('').startsWith(short)) return false;
  let n = 0, i = 0;
  while (n < short.length) n += long[i++].length;
  if (n !== short.length) return false;
  const rest = long.slice(i);
  if (pondOk && rest.length === 1 && rest[0] === 'pond') return true;
  return !WATER_WORD.test(rest[0]);
}
const reach = lake => /river|creek|stream/i.test(`${lake.kind} ${lake.type}`) ? 3 : Math.max(1.5, Math.sqrt((lake.acres ?? 50) / 247) * 1.5 + 0.5);

function inRing([x, y], ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}
// County and NDOW region (Western, Eastern, Southern) a point is in.
// A water on the state line (Lake Mohave, the Colorado) can sit just outside the county outlines, so try a few
// points ~4 km around it before giving up.
export async function countyAt(lat, lon) {
  const c = await d.load('counties');
  const at = ([y, x]) => c?.counties.find(k => x >= k.bbox[0] && x <= k.bbox[2] && y >= k.bbox[1] && y <= k.bbox[3] && k.polys.some(([outer]) => inRing([x, y], outer)));
  const r = 0.04;
  const hit = at([lat, lon]) ?? (inRing([lon, lat], outline) ? [[lat, lon + r], [lat, lon - r], [lat + r, lon], [lat - r, lon]].map(at).find(Boolean) : null);
  return hit ? { county: hit.name, region: hit.region } : null;
}

export async function habAdvisories() {
  return d.load('hab');
}

// Current toxic algae advisories on this water (Nevada Office of State Epidemiology list, matched by name and place).
export async function habFor(lake) {
  const h = await d.load('hab');
  return (h?.advisories ?? []).map(a => ({ ...a, distKm: a.lat != null ? haversineKm(lake.lat, lake.lon, a.lat, a.lon) : null }))
    // A name match counts within 60 km, or 25 km when the advisory names a town (several ponds share a name).
    // A town-placed advisory sits on the town, not the water, so it never matches by distance alone.
    .filter(a => sameWater(lake.name, a.name.split(/\s+(?:including|incl\.?)\s+|[(,]/i)[0]) ? a.distKm == null || a.distKm < (a.town ? 25 : 60) : !a.town && a.distKm != null && a.distKm <= reach(lake));
}

// Health advisories on eating fish caught here.
export async function fishAdviceFor(lake) {
  const f = await d.load('advisories');
  if (!f) return null;
  // An advisory with a mapped reach ("Carson River from Dayton to Lahontan Dam") applies only inside it; names only
  // place the ones without one.
  const site = f.advisories.filter(a => a.areas.length ? a.areas.some(([lat, lon, km]) => haversineKm(lake.lat, lake.lon, lat, lon) <= km) : a.names.some(n => sameWater(lake.name, n)));
  return { site, statewide: f.statewide, url: f.url, updatedAt: f.updatedAt };
}

// Waters on tribal land, where tribal rules and permits apply instead of NDOW's. Pyramid Lake's line comes from
// the regulations themselves (region intro); the rest are on reservations the booklet doesn't mention.
const TRIBAL = [
  { names: ['Summit Lake'], county: 'Humboldt', text: 'Summit Lake is on the Summit Lake Paiute Reservation. Contact the Summit Lake Paiute Tribe for regulations and permits.' },
  { names: ['Sheep Creek Reservoir', 'Mountain View Reservoir', 'Billy Shaw Reservoir'], county: 'Elko', text: 'This water is on the Duck Valley Indian Reservation. Contact the Shoshone-Paiute Tribes for regulations and permits.' },
];
function tribalFor(lake, r, county) {
  for (const t of TRIBAL) if ((!county || county === t.county) && t.names.some(n => sameWater(lake.name, n))) return t.text;
  for (const p of Object.values(r.regions)) {
    const sentences = (p.intro ?? []).join(' ').split(/(?<=\.)\s+/);
    for (const [i, sentence] of sentences.entries()) {
      const m = sentence.match(/^(.+?) is managed by (?:the )?.+Tribe/);
      if (m && sameWater(lake.name, m[1])) return /^Please contact/.test(sentences[i + 1] ?? '') ? `${sentence} ${sentences[i + 1]}` : sentence;
    }
  }
  return null;
}

// The rules for this water: special regulations that name it (in its county), its region's general limits,
// closed waters in its county (and whether one names this water), tribal management, and the statewide rules.
export async function regsFor(lake) {
  const r = await d.load('regs');
  if (!r) return null;
  const at = await countyAt(lake.lat, lake.lon);
  const ndow = lake.ndowWaterId ? await reportFor(lake) : null;
  // No county means the point isn't in Nevada: only rules that name no county could apply.
  const county = at?.county ?? ndow?.county ?? null, region = at?.region ?? ndow?.region ?? null;
  const names = w => [w.name, ...w.aliases];
  const opts = { pondOk: !isRiver(lake) };
  let special = r.waters.filter(w => (!w.county || w.county === county) && names(w).some(n => sameWater(lake.name, n, opts)));
  // The booklet sometimes files a water under the wrong county (Willow Creek Reservoir under Lander): an exact
  // name in the same region still counts.
  if (!special.length && region) special = r.waters.filter(w => w.region === region && names(w).some(n => regWords(n).join('') === regWords(lake.name).join('')));
  const closed = r.closed.filter(c => county && c.county === county);
  // A closed-waters clause that starts with this water's name: part of it is closed, or all of it when the clause
  // is just the name ("Smith Creek Reservoir.", "Crowley Creek in the Montana Mountains.", "on Franklin Lake WMA").
  const me = regWords(lake.name).join('');
  const closedHere = closed.flatMap(c => c.text.split(/(?<=\.)(?<!\b(?:Mt|St|No)\.)\s+(?=[A-Z])/).flatMap(t => t.split(/;\s*|,\s+and\s+/))
    .map(t => t.replace(/^(?:and\s+)?(?:in|on)\s+/i, '').trim()))
    .filter(t => sameWater(lake.name, t.split(/[,(]/)[0]))
    .map(text => ({ text, whole: regWords(text.replace(/\.$/, '').replace(/\s+(?:in the .+ (?:range|mountains)|wildlife management area|wma)$/i, '')).join('') === me }));
  return {
    county, region, special, regionRules: region ? r.regions[region] : null, closed, closedHere, tribal: tribalFor(lake, r, county),
    statewide: r.statewide, booklet: r.booklet, source: r.source, updatedAt: r.updatedAt,
  };
}
