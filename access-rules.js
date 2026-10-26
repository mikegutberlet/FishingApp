// Getting to a water: what the public road, trail and land records say about reaching it, each fact with the
// record it came from. Pure functions over the normalised features access-lookup.js gathers, so they can be tested
// without a network. Every feature is { kind, name, lat?, geom, tags, source: { label, url } }:
//   kind 'road' | 'trail' | 'gate', geom = [[lat, lon], ...] (one path), tags = the normalised access facts.

// Shortest distance in km from a point to a polyline, flat-earth (fine for a few km).
export function distKmToLine(lat, lon, geom) {
  const kx = 111.32 * Math.cos(lat * Math.PI / 180), ky = 110.57;
  let best = Infinity;
  for (let i = 0; i < geom.length; i++) {
    const [alat, alon] = geom[i];
    if (i === 0 || geom.length === 1) best = Math.min(best, Math.hypot((alon - lon) * kx, (alat - lat) * ky));
    if (i === 0) continue;
    const [blat, blon] = geom[i - 1];
    const ax = (alon - lon) * kx, ay = (alat - lat) * ky, bx = (blon - lon) * kx, by = (blat - lat) * ky;
    const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

// How far the shoreline is likely to be from the water's map point: a lake's radius from its acres (lakes are seldom
// round, so a little under), a river's point sits on the river.
export const shoreKm = lake => lake.kind === 'river' || lake.lengthKm ? 0 : Math.sqrt((Number(lake.acres) || 20) * 0.004047 / Math.PI) * 0.9;

// The radius worth looking in: the shoreline plus 2 km of approach, at most 5 km. A spot picked on the shore of a
// big lake is checked 2 km around.
export const searchKm = lake => Math.min(5, shoreKm(lake) + 2);
// A lake this big has roads at some shores and none at others, so one point in its middle says nothing: check a spot.
export const isBig = lake => shoreKm(lake) > 3;

const MI = 0.621371;
export const fmtMi = km => km < 0.08 ? 'under 0.1 mi' : `${(km * MI).toFixed(km * MI < 1 ? 1 : km * MI < 10 ? 1 : 0)} mi`;

// ---------- Vehicle classes ----------
// Each road's tags: { car, highClearance, atv, motorcycle, bike, foot } as 'yes' | 'no' | 'seasonal' | null (unknown),
// plus surface, maint, dates { car, atv, motorcycle }, closed (true when the record says no public motor use), streetLegalOnly.

// Which vehicle can reach a road segment, in order from easiest. null when the record says nothing about it.
export function roadClass(t) {
  if (t.closed) return 'closed';
  if (t.car === 'yes' || t.car === 'seasonal') return t.surface === 'paved' ? 'paved' : t.surface ? 'car' : 'road';
  if (t.highClearance === 'yes' || t.highClearance === 'seasonal') return 'highClearance';
  if (t.car === 'no' && (t.atv || t.motorcycle)) return 'ohvOnly';
  if (t.car === null && t.highClearance === null) return t.surface === 'paved' ? 'paved' : t.surface === 'rough' ? 'highClearance' : 'unknown';
  return 'closed';
}

export const CLASS_TEXT = {
  paved: { icon: '🚗', label: 'Paved road', text: 'Any car.' },
  road: { icon: '🚗', label: 'Road open to cars', text: 'Surface not recorded: could be paved or dirt.' },
  car: { icon: '🚙', label: 'Dirt or gravel road, passenger cars OK', text: 'Graded for passenger cars; expect dust and washboard.' },
  highClearance: { icon: '🛻', label: 'High-clearance vehicle', text: 'Not maintained for passenger cars: truck, SUV or 4WD.' },
  ohvOnly: { icon: '🏍️', label: 'OHV route only', text: 'Open to ATVs or motorcycles, not to full-size vehicles.' },
  unknown: { icon: '🛣️', label: 'Road, surface unknown', text: 'The map records don’t say what it takes to drive it.' },
  closed: { icon: '🚫', label: 'Closed to public motor vehicles', text: 'Gated, private or decommissioned.' },
};
const ORDER = ['paved', 'road', 'car', 'highClearance', 'ohvOnly', 'unknown', 'closed'];

// ---------- The summary ----------
// What it takes to reach this water: the easiest vehicle that gets within reach of the shore, how far you then
// walk, and what the trails and routes nearby allow. `features` are the normalised records (each with `paths`, a
// list of polylines, or a point), `at` is the point checked and `shore` how far the shoreline likely is from it.
export function summarize(at, shore, features, { land = null } = {}) {
  const near = f => f.paths?.length ? Math.min(...f.paths.map(p => distKmToLine(at.lat, at.lon, p))) : f.lat != null ? distKmToLine(at.lat, at.lon, [[f.lat, f.lon]]) : Infinity;
  const withDist = features.map(f => ({ ...f, distKm: near(f) }))
    .map(f => ({ ...f, shoreKm: Math.max(0, f.distKm - shore) })).sort((a, b) => a.shoreKm - b.shoreKm);
  const roads = withDist.filter(f => f.kind === 'road').map(f => ({ ...f, cls: roadClass(f.tags) }));
  const trails = withDist.filter(f => f.kind === 'trail');
  const gates = withDist.filter(f => f.kind === 'gate');
  // The closest road a car can take, else the closest any motor vehicle can, counting a road as "at the water" when
  // it comes within 400 m of the likely shoreline (a parking spot, a short path down the bank).
  const AT = 0.4;
  const drivable = roads.filter(r => !['closed', 'unknown'].includes(r.cls));
  const byClass = cls => drivable.filter(r => r.cls === cls);
  let vehicle = null;
  for (const cls of ['paved', 'road', 'car', 'highClearance', 'ohvOnly']) {
    // At the water, an agency record (with its open dates and maintenance level) beats the OpenStreetMap line.
    const at = byClass(cls).filter(r => r.shoreKm <= AT).sort((a, b) => (a.source.label === 'OpenStreetMap') - (b.source.label === 'OpenStreetMap'))[0];
    if (at) { vehicle = { cls, road: at, hikeKm: 0 }; break; }
  }
  // Nothing drives to the shore: the easiest road that gets anywhere near, and the walk from it.
  if (!vehicle && drivable.length) {
    const easiest = ORDER.map(byClass).find(l => l.length);
    const nearest = drivable[0];
    // Prefer the easiest class unless a rougher road gets a lot closer (saves over a mile of walking).
    const pick = easiest[0].shoreKm - nearest.shoreKm > 1.6 ? nearest : easiest[0];
    vehicle = { cls: pick.cls, road: pick, hikeKm: pick.shoreKm };
  }
  const unknownOnly = !vehicle && roads.some(r => r.cls === 'unknown');
  const nearestUnknown = unknownOnly ? roads.find(r => r.cls === 'unknown') : null;

  const allows = key => trails.filter(t => t.tags[key] === 'yes' || t.tags[key] === 'seasonal');
  const forbids = key => trails.filter(t => t.tags[key] === 'no');
  const ohvRoads = roads.filter(r => r.cls !== 'closed' && (r.tags.atv === 'yes' || r.tags.atv === 'seasonal' || r.tags.motorcycle === 'yes' || r.tags.motorcycle === 'seasonal'));
  const streetLegalOnly = roads.filter(r => r.tags.streetLegalOnly && r.shoreKm <= 2);
  const seasonal = [...roads, ...trails].filter(f => f.tags.dates && Object.values(f.tags.dates).some(Boolean) && f.shoreKm <= 2);
  const lockedGates = gates.filter(g => g.tags.locked);

  return {
    at, shoreKm: shore, vehicle, nearestUnknown,
    hikeTrails: allows('foot').slice(0, 6), bikeTrails: allows('bike').slice(0, 6), noBikeTrails: forbids('bike').slice(0, 3),
    motoTrails: [...allows('motorcycle'), ...allows('atv')].filter((t, i, a) => a.indexOf(t) === i).slice(0, 6),
    ohvRoads: ohvRoads.slice(0, 6), streetLegalOnly: streetLegalOnly.slice(0, 4), seasonal: seasonal.slice(0, 6), lockedGates: lockedGates.slice(0, 4),
    roads: roads.slice(0, 40), trails: trails.slice(0, 40), land,
  };
}

// ---------- Land manager → what that usually means for an angler ----------
// PAD-US manager codes (Mang_Name). Hints are general: the linked record and the agency's own page have the specifics.
export const MANAGERS = {
  USFS: { name: 'U.S. Forest Service', hint: 'National Forest land. Dispersed access is usually free; developed trailheads, day-use sites and campgrounds may need a recreation pass or fee. Motor vehicles stay on routes shown on the forest’s Motor Vehicle Use Map.' },
  BLM: { name: 'Bureau of Land Management', hint: 'Public land, generally open and free to reach, with camping allowed up to 14 days. Motor vehicles stay on designated routes where travel management applies.' },
  NPS: { name: 'National Park Service', hint: 'Park land: an entrance fee or pass is likely, and the park may have its own fishing rules and hours on top of the state’s.' },
  FWS: { name: 'U.S. Fish & Wildlife Service', hint: 'A national wildlife refuge: fishing is allowed only where and when the refuge says, often with its own seasons and hours.' },
  USBR: { name: 'Bureau of Reclamation', hint: 'A Reclamation reservoir: access points are usually run by a partner (a county, state park or concession), often with day-use fees.' },
  USACE: { name: 'Army Corps of Engineers', hint: 'A Corps project: ramps and day-use areas may charge fees; some areas close for dam operations.' },
  SPR: { name: 'State park', hint: 'A state park or recreation area: expect a day-use fee and set hours; fishing follows state rules.' },
  SFW: { name: 'State fish & wildlife agency', hint: 'A wildlife area or fishing access site run by the state fish and wildlife agency; some need a lands pass and have seasonal closures.' },
  SDNR: { name: 'State natural resources agency', hint: 'State land; check the agency’s access rules.' },
  SLB: { name: 'State trust land', hint: 'State trust land: a recreation permit may be required to enter.' },
  SDOL: { name: 'State land', hint: 'State land; check the agency’s access rules.' },
  CNTY: { name: 'County', hint: 'A county park or reservoir: day-use fees and hours are common.' },
  REG: { name: 'Regional agency', hint: 'A regional park or water district: day-use fees, hours and boating rules are common.' },
  CITY: { name: 'City', hint: 'A city park or reservoir: hours and local rules apply.' },
  RWD: { name: 'Water district', hint: 'A water district reservoir: access may be limited to set areas and hours, sometimes with a permit.' },
  BIA: { name: 'Tribal land', hint: 'Tribal land: fishing usually needs a tribal permit in place of (or as well as) the state licence, bought from the tribe.' },
  TRIB: { name: 'Tribal land', hint: 'Tribal land: fishing usually needs a tribal permit in place of (or as well as) the state licence, bought from the tribe.' },
  DOD: { name: 'Department of Defense', hint: 'Military land: access is restricted or by permit only.' },
  NGO: { name: 'Conservation organisation', hint: 'Private conservation land: access depends on the owner’s rules.' },
  PVT: { name: 'Private', hint: 'Private land: you need the owner’s permission unless a public easement or road reaches the water.' },
};
export const PUB_ACCESS = { OA: 'open to the public', RA: 'restricted access (permit, season or area limits)', XA: 'closed to the public', UK: 'public access not recorded' };

// PAD-US designation types (Des_Tp) an angler is likely to meet.
export const DESIGNATIONS = {
  NF: 'National Forest', NP: 'National Park', NM: 'National Monument', NRA: 'National Recreation Area', NWR: 'National Wildlife Refuge', NCA: 'National Conservation Area',
  WA: 'Wilderness', WSA: 'Wilderness Study Area', IRA: 'Inventoried Roadless Area', WSR: 'Wild and Scenic River', PUB: 'Public land', REC: 'Recreation area', RMA: 'Recreation management area',
  SP: 'State park', SREC: 'State recreation area', SW: 'State wilderness', SWA: 'State wildlife area', SCA: 'State conservation area', SDA: 'State resource management area', SRMA: 'State resource management area', SOTH: 'State land',
  LP: 'Local park', LREC: 'Local recreation area', LCA: 'Local conservation area', LOTH: 'Local land', ACC: 'Access area', FOTH: 'Federal land', TRIBL: 'Tribal land', MIL: 'Military land', PROC: 'Proclamation boundary',
};
// A wilderness designation means no motor vehicles and no bicycles (Wilderness Act, 16 U.S.C. 1133(c)).
export const WILDERNESS_URL = 'https://www.law.cornell.edu/uscode/text/16/1133';
export const isWilderness = p => p?.designation === 'WA';
