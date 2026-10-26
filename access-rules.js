// Getting to a water: what the public road, trail and land records say about reaching it, each fact with the
// record it came from. Pure functions over the normalised features access-lookup.js gathers, so they can be tested
// without a network. Every feature is { kind, name, lat?, geom, tags, source: { label, url } }:
//   kind 'road' | 'trail' | 'gate' | 'mast' (a cell mast), geom = [[lat, lon], ...] (one path), tags = the normalised access facts.

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
export const shoreKm = lake => lake.kind === 'river' || lake.lengthKm ? 0 : Math.sqrt((Number(lake.acres) || 20) * 0.004047 / Math.PI) * 0.8;

// The radius worth looking in: the shoreline plus 2 km of approach, at most 5 km. A spot picked on the shore of a
// big lake is checked 2 km around.
export const searchKm = lake => Math.min(5, shoreKm(lake) + 2);
// A lake this big (about 4,000 acres and up) has roads at some shores and none at others, and a long reservoir's
// shore is nowhere near a circle, so one point in its middle says little: check a spot.
export const isBig = lake => shoreKm(lake) > 2;

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
  const masts = withDist.filter(f => f.kind === 'mast').sort((a, b) => a.distKm - b.distKm);
  // The closest road a car can take, else the closest any motor vehicle can, counting a road as "at the water" when
  // it comes within 400 m of the likely shoreline (a parking spot, a short path down the bank).
  const AT = 0.4;
  // A freeway passing by is no way in: you can't stop on it.
  const drivable = roads.filter(r => !['closed', 'unknown'].includes(r.cls) && !r.tags.noStop);
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

  // The Pacific Crest Trail is closed to bikes and motor vehicles along its whole length (Forest Service closure order).
  for (const t of trails) if (/pacific crest|\bpct\b/i.test(t.name ?? '')) Object.assign(t.tags, { bike: 'no', motorcycle: 'no', atv: 'no', pct: true });
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
    roads: roads.slice(0, 40), trails: trails.slice(0, 40), land, masts: masts.slice(0, 5),
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

// ---------- Season dates ----------
// A Motor Vehicle Use Map range such as "06/01-11/15" (or "12/01-03/31" across the new year) against a date: open
// or closed now, and the next change.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function seasonStatus(range, now = new Date()) {
  const m = String(range ?? '').match(/(\d\d)\/(\d\d)\s*-\s*(\d\d)\/(\d\d)/);
  if (!m) return null;
  const [a, b] = [[+m[1], +m[2]], [+m[3], +m[4]]];
  const on = (y, [mo, d]) => new Date(y, mo - 1, d);
  const y = now.getFullYear(), today = new Date(y, now.getMonth(), now.getDate());
  const wraps = a[0] * 100 + a[1] > b[0] * 100 + b[1];
  const open = wraps ? today >= on(y, a) || today <= on(y, b) : today >= on(y, a) && today <= on(y, b);
  // The next date it closes (the day after the range ends) or opens.
  const next = d => { const t = on(y, d); return t >= today ? t : on(y + 1, d); };
  const closes = next(b), opens = next(a);
  const label = ([mo, d]) => `${MONTHS[mo - 1]} ${d}`;
  return { open, closes: label(b), opens: label(a), days: Math.round(((open ? closes : opens) - today) / 864e5) };
}

// ---------- The walk in ----------
// The likely walk from where you park to the shore: the shortest way along mapped trails and walkable roads from a
// road you can drive (the class the verdict picked, or easier) to the likely shoreline. Lines from different sources
// rarely share points, so vertices within 25 m of each other are joined. Null when nothing connects; then the walk
// is cross-country and only its straight line is known.
export function hikeRoute(s) {
  const v = s.vehicle;
  if (!v || v.hikeKm <= 0.08) return null;
  const at = s.at, kx = 111.32 * Math.cos(at.lat * Math.PI / 180), ky = 110.57;
  const xy = ([la, lo]) => [(lo - at.lon) * kx, (la - at.lat) * ky];
  const rank = c => ORDER.indexOf(c);
  const pts = [], adj = [], cell = new Map();
  const CELL = 0.025, key = (x, y) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
  const add = (p, feature) => {
    const [x, y] = xy(p), i = pts.length;
    pts.push({ p, x, y, f: feature }); adj.push([]);
    const k = key(x, y);
    (cell.get(k) ?? cell.set(k, []).get(k)).push(i);
    return i;
  };
  const link = (i, j) => { const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y); adj[i].push([j, d]); adj[j].push([i, d]); };
  const walkable = [...s.roads.filter(r => !r.tags.noStop && r.tags.foot !== 'no'), ...s.trails.filter(t => t.tags.foot !== 'no')];
  const drive = f => f.kind === 'road' && !['closed', 'unknown'].includes(f.cls) && rank(f.cls) <= rank(v.cls);
  const start = new Map(), ends = [];
  for (const f of walkable) {
    for (const path of f.paths ?? []) {
      let prev = null;
      for (const p of path) {
        const i = add(p, f);
        if (drive(f)) start.set(i, 0);
        if (prev != null) link(prev, i);
        prev = i;
      }
      if (f.kind === 'trail') ends.push(prev - path.length + 1, prev);
    }
  }
  // A trail that ends beside a road, between the road's mapped points, starts there too.
  const drivePaths = walkable.filter(drive).flatMap(f => f.paths ?? []);
  for (const i of ends) {
    const d = Math.min(...drivePaths.map(p => distKmToLine(pts[i].p[0], pts[i].p[1], p)));
    if (d <= 0.03 && !start.has(i)) start.set(i, d);
  }
  // Join nearby vertices of different lines (a trail ending at a road, a USFS line beside the OSM one).
  for (let i = 0; i < pts.length; i++) {
    const cx = Math.floor(pts[i].x / CELL), cy = Math.floor(pts[i].y / CELL);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const j of cell.get(`${cx + dx},${cy + dy}`) ?? []) {
      if (j > i && pts[j].f !== pts[i].f && Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) <= CELL) link(i, j);
    }
  }
  // Dijkstra from every drivable vertex at once; the first vertex reached on the shoreline ends it.
  const reach = Math.max(s.shoreKm, 0) + 0.06;
  const dist = new Float64Array(pts.length).fill(Infinity), prev = new Int32Array(pts.length).fill(-1), done = new Uint8Array(pts.length);
  const heap = [];
  const push = (d, i) => { heap.push([d, i]); let k = heap.length - 1; while (k) { const pk = (k - 1) >> 1; if (heap[pk][0] <= heap[k][0]) break; [heap[pk], heap[k]] = [heap[k], heap[pk]]; k = pk; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } } return top; };
  for (const [i, d] of start) { dist[i] = d; push(d, i); }
  let end = -1;
  while (heap.length) {
    const [d, i] = pop();
    if (done[i]) continue;
    done[i] = 1;
    if (Math.hypot(pts[i].x, pts[i].y) <= reach && !drive(pts[i].f)) { end = i; break; }
    // Past three times the straight-line walk plus 3 km, it isn't the way anyone goes.
    if (d > v.hikeKm * 3 + 3) break;
    for (const [j, w] of adj[i]) if (!done[j] && d + w < dist[j]) { dist[j] = d + w; prev[j] = i; push(d + w, j); }
  }
  if (end < 0) return null;
  const chain = [];
  for (let i = end; i >= 0; i = prev[i]) chain.push(i);
  chain.reverse();
  const coords = chain.map(i => pts[i].p);
  const features = chain.map(i => pts[i].f).filter((f, k, a) => f !== a[k - 1] && f.kind === 'trail');
  const first = pts[chain[0]], [la, lo] = first.p;
  const road = drive(first.f) ? first.f : walkable.filter(drive).sort((a, b) => Math.min(...a.paths.map(p => distKmToLine(la, lo, p))) - Math.min(...b.paths.map(p => distKmToLine(la, lo, p))))[0];
  return { coords, km: dist[end], start: { lat: la, lon: lo, road }, trails: [...new Set(features)] };
}

// A path's length in km, and points spaced evenly along it (at most n), for an elevation profile.
export function samplePath(coords, n = 80) {
  const seg = [0];
  for (let i = 1; i < coords.length; i++) seg.push(seg[i - 1] + distKmToLine(coords[i - 1][0], coords[i - 1][1], [coords[i]]));
  const total = seg.at(-1);
  if (!total) return { km: 0, points: [coords[0]], at: [0] };
  const k = Math.max(2, Math.min(n, Math.ceil(total / 0.03) + 1)), points = [], at = [];
  for (let s = 0, j = 1; s < k; s++) {
    const d = total * s / (k - 1);
    while (j < seg.length - 1 && seg[j] < d) j++;
    const t = seg[j] > seg[j - 1] ? (d - seg[j - 1]) / (seg[j] - seg[j - 1]) : 0;
    points.push([+(coords[j - 1][0] + t * (coords[j][0] - coords[j - 1][0])).toFixed(5), +(coords[j - 1][1] + t * (coords[j][1] - coords[j - 1][1])).toFixed(5)]);
    at.push(d);
  }
  return { km: total, points, at };
}

// Climb and drop along a profile (metres), ignoring wiggles under 3 m that come from the elevation model, and the
// time it takes by Naismith's rule: 5 km an hour plus an hour for every 600 m of climb. Both ways, since the walk
// out climbs what the walk in dropped.
export function hikeStats(km, elev) {
  let up = 0, down = 0, ref = elev[0];
  for (const e of elev.slice(1)) {
    if (e - ref >= 3) { up += e - ref; ref = e; } else if (ref - e >= 3) { down += ref - e; ref = e; }
  }
  const mins = climb => Math.round(km / 5 * 60 + climb / 10);
  return { km, upM: up, downM: down, minIn: mins(up), minOut: mins(down), minM: Math.min(...elev), maxM: Math.max(...elev) };
}
export const fmtMins = m => m < 60 ? `${Math.max(5, Math.round(m / 5) * 5)} min` : `${Math.floor(m / 60)} h${m % 60 >= 8 ? ` ${Math.round(m % 60 / 5) * 5} min` : ''}`;
export const fmtFt = m => `${Math.round(m * 3.28084 / 10) * 10 > 0 ? (Math.round(m * 3.28084 / 10) * 10).toLocaleString() : 0} ft`;
// With no mapped way in, the straight line from the closest point of the road you'd park on to the shore.
export function crowLine(s) {
  const v = s.vehicle;
  if (!v || v.hikeKm <= 0.08) return null;
  const at = s.at, kx = 111.32 * Math.cos(at.lat * Math.PI / 180), ky = 110.57;
  let best = null;
  for (const p of v.road.paths ?? []) for (const q of p) {
    const d = Math.hypot((q[1] - at.lon) * kx, (q[0] - at.lat) * ky);
    if (!best || d < best.d) best = { q, d };
  }
  if (!best || !best.d) return null;
  const f = Math.max(0, best.d - s.shoreKm) / best.d;
  const shore = [best.q[0] + (at.lat - best.q[0]) * f, best.q[1] + (at.lon - best.q[1]) * f];
  return { coords: [best.q, shore], km: Math.max(0, best.d - s.shoreKm), start: { lat: best.q[0], lon: best.q[1], road: v.road }, trails: [], crow: true };
}

// ---------- Snow ----------
// Snow at the water from the station most like it (near, and at a similar elevation: 1,000 ft counts like 3 km), or
// from the weather model when no station is that close. Measured beats modelled.
export function snowAt(now) {
  if (!now) return null;
  const elev = now.elevFt;
  const score = s => s.distKm + (elev != null ? Math.abs(s.elevFt - elev) / 300 : 0);
  const station = (now.station ?? []).filter(s => s.distKm <= 40 && (elev == null || Math.abs(s.elevFt - elev) <= 2000)).sort((a, b) => score(a) - score(b))[0] ?? null;
  const depthIn = station ? station.depthIn : now.model?.depthIn ?? null;
  const next3 = (now.model?.next ?? []).slice(0, 3).reduce((n, d) => n + (d.snowCm ?? 0), 0) / 2.54;
  const week = (now.model?.next ?? []).reduce((n, d) => n + (d.snowCm ?? 0), 0) / 2.54;
  const firstSnow = (now.model?.next ?? []).find(d => d.snowCm >= 2.5);
  const level = depthIn == null ? null : depthIn >= 12 ? 'deep' : depthIn >= 2 ? 'some' : next3 >= 2 ? 'coming' : 'none';
  return { level, depthIn, station, next3In: next3, weekIn: week, firstSnow, model: now.model };
}
