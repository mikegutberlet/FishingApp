// Crew trips: the group plan, the crew's results and "where should we camp?". All worked out on the phone.
//   The group plan (store `crewPlans`): dates, camp and site, where and when to meet, who's coming, who brings what,
//     and which licenses each person needs for the plan's waters ("did everyone buy one?"). It travels inside a
//     normal crew share (file or QR, see crew.js) as an item of kind 'plan'. Everyone keeps their own copy; when a
//     copy comes back, each person's row and each gear line keeps whichever edit is newest, so friends can tick
//     "bought my license" or "I'll bring the stove" on their phone and send it back.
//   Crew results: your catches and the ones friends shared (the `crew` store), tallied per person, and what works
//     on a water for all of you together. Friends' catches still never go into your own stats.
//   Where should we camp: every camp the phone knows (the Camping lookups, your campsites and friends'), ranked by
//     the good waters within the distance you type, as the crow flies. No routing service sees anything.
import { db, uid } from './db.js';
import { haversineKm } from './data-sources.js';
import { forLake, stockIdOf } from './states/index.js';
import { localKey, addDays } from './forecast.js';
import { cached as campingCached } from './camping.js';
import { LICENSE, SHARED_WATERS } from './trip-rules.js';
import { partOf, icsFile } from './camp-trip.js';

export const NAME_KEY = 'tackle-box-crew-name'; // the name you share under (crew.js)
export const myName = () => localStorage.getItem(NAME_KEY) || '';
const stateOf = l => l?.state ?? forLake(l)?.code ?? 'CA';
const tally = (list, key) => Object.entries(list.reduce((m, x) => { const k = key(x); if (k) m[k] = (m[k] ?? 0) + (x.count ?? 1); return m; }, {})).sort((a, b) => b[1] - a[1]);
const nFish = list => list.reduce((s, c) => s + (c.count ?? 1), 0);

// ---------- The plan ----------
export const AGES = { adult: '16 or older', teen: '12 to 15', kid: 'Under 12' };
const AGE_YEARS = { adult: 99, teen: 12, kid: 0 }; // the age that counts for "needs a license from age N"
export const STATE_NAME = { CA: 'California', NV: 'Nevada', OR: 'Oregon', WA: 'Washington', ID: 'Idaho', AZ: 'Arizona' };
// Short-term licenses for friends visiting for a day or a weekend. All three states sell 1-day licenses online.
export const SHORT_TERM = {
  CA: 'California sells one-day and two-day licenses (and a ten-day one for nonresidents).',
  NV: 'Nevada sells a one-day license, with more days added on.',
  OR: 'Oregon sells daily licenses for one or more days.',
};
export const GEAR_IDEAS = ['Stove and fuel', 'Water filter', 'Cooler and ice', 'Bear canister', 'Firewood (bought near camp)', 'Camp kitchen and pots', 'Lantern', 'Tarp or shade', 'Landing net', 'First aid kit', 'Satellite messenger', 'Float tube or kayak', 'Bait', 'Fish cleaning kit'];

export const newPlan = (seed = {}) => {
  const me = myName(), at = new Date().toISOString();
  return { id: uid(), name: '', start: localKey(), end: localKey(), camp: null, site: '', meet: { text: '', time: '', lat: null, lon: null }, lakeIds: [], notes: '',
    members: me ? [{ key: uid(), name: me, age: 'adult', lic: {}, at }] : [], gear: [], owner: me, headAt: at, ...seed };
};
export const touch = row => { row.at = new Date().toISOString(); return row; };
export const live = list => (list ?? []).filter(x => !x.gone);

// The licenses the plan's waters call for: one line per set of choices ("California", or "California or Nevada" at
// Topaz Lake), with the waters that need it.
export function licenseNeeds(lakes) {
  const needs = new Map();
  for (const l of lakes) {
    const st = stateOf(l), shared = SHARED_WATERS.find(r => r.re.test(l.name ?? '') && r.states.includes(st));
    const options = [...new Set(shared?.also ?? [st])].sort();
    const k = options.join('|');
    if (!needs.has(k)) needs.set(k, { options, waters: [], notes: [] });
    needs.get(k).waters.push(l.name);
    if (shared && !needs.get(k).notes.includes(shared.text)) needs.get(k).notes.push(shared.text);
  }
  return [...needs.values()];
}
// What one person still needs: the lines where none of the choices is ticked and they're old enough to need one.
export function memberNeeds(m, needs) {
  const age = AGE_YEARS[m.age] ?? 99;
  const miss = needs.filter(n => !n.options.some(s => (LICENSE[s] && age < LICENSE[s].age) || m.lic?.[s]));
  // "California" covers "California or Nevada" too, so the wider line is left out.
  return miss.filter(n => !miss.some(o => o !== n && o.options.length < n.options.length && o.options.every(s => n.options.includes(s))));
}
export function licenseStatus(plan, needs) {
  const people = live(plan.members);
  const missing = people.map(m => ({ m, need: memberNeeds(m, needs) })).filter(x => x.need.length);
  return { people: people.length, ok: people.length - missing.length, missing };
}

// Two copies of one plan: the newer edit of the plan itself wins, and each person and gear line is merged on its
// own (a removed line stays removed unless someone edits it again later).
export function mergePlan(mine, theirs) {
  if (!mine) return theirs;
  const head = (theirs.headAt ?? '') > (mine.headAt ?? '') ? theirs : mine;
  const rows = (a = [], b = []) => {
    const m = new Map(a.map(x => [x.key, x]));
    for (const x of b) if (!m.has(x.key) || (x.at ?? '') > (m.get(x.key).at ?? '')) m.set(x.key, x);
    return [...m.values()];
  };
  return { ...mine, ...pick(head, HEAD), members: rows(mine.members, theirs.members), gear: rows(mine.gear, theirs.gear) };
}
const HEAD = ['name', 'start', 'end', 'camp', 'site', 'meet', 'lakeIds', 'notes', 'owner', 'headAt'];
const pick = (o, keys) => Object.fromEntries(keys.filter(k => k in o).map(k => [k, o[k]]));

// ---------- Sharing: the plan as a crew-share item ----------
// lakeIdx maps one of your lake ids to its place in the pack's lakes list. The camp travels with the plan, since the
// point is to tell the crew where to go; the sheet that shares it says so.
export function planItem(plan, lakeIdx) {
  return { kind: 'plan', id: plan.id, name: plan.name, start: plan.start, end: plan.end, site: plan.site, notes: plan.notes, owner: plan.owner, headAt: plan.headAt,
    camp: plan.camp && { name: plan.camp.name, lat: plan.camp.lat, lon: plan.camp.lon, recgovId: plan.camp.recgovId ?? undefined, kind: plan.camp.kind ?? undefined },
    meet: plan.meet, lakes: (plan.lakeIds ?? []).map(lakeIdx).filter(i => i != null),
    members: plan.members.map(m => ({ key: m.key, name: m.name, age: m.age, lic: m.lic, at: m.at, gone: m.gone || undefined })),
    gear: plan.gear.map(g => ({ key: g.key, item: g.item, who: g.who, at: g.at, gone: g.gone || undefined })) };
}

// A friend's plan is their file: only known fields of the right types come in.
const num = v => v == null || v === '' || !isFinite(+v) ? null : +v;
const str = (v, n = 200) => v == null ? '' : String(v).slice(0, n);
const tok = v => String(v ?? '').replace(/[^\w.:-]/g, '').slice(0, 60);
const day = v => /^\d{4}-\d\d-\d\d$/.test(v ?? '') ? v : null;
const iso = v => v && !isNaN(Date.parse(v)) ? new Date(v).toISOString() : '';
const STATES = Object.keys(STATE_NAME);
export function cleanPlan(it, lakeIds) {
  const id = tok(it.id);
  if (!id) return null;
  const start = day(it.start) ?? localKey(), end = day(it.end) && day(it.end) >= start ? day(it.end) : start;
  const c = it.camp, lat = num(c?.lat), lon = num(c?.lon), m = it.meet ?? {};
  return {
    id, name: str(it.name, 120), start, end, site: str(it.site), notes: str(it.notes, 2000), owner: str(it.owner, 60), headAt: iso(it.headAt),
    camp: c && Number.isFinite(lat) && Number.isFinite(lon) ? { name: str(c.name, 120) || 'Camp', lat, lon, recgovId: tok(c.recgovId) || null, kind: tok(c.kind) || null } : null,
    meet: { text: str(m.text, 300), time: /^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(m.time ?? '') ? m.time : '', lat: num(m.lat), lon: num(m.lon) },
    lakeIds: [...new Set((Array.isArray(it.lakes) ? it.lakes : []).map(i => lakeIds[i]).filter(Boolean))],
    members: (Array.isArray(it.members) ? it.members : []).slice(0, 40).filter(x => tok(x?.key)).map(x => ({ key: tok(x.key), name: str(x.name, 60) || 'Friend', age: x.age in AGES ? x.age : 'adult',
      lic: Object.fromEntries(STATES.filter(s => x.lic?.[s] === true).map(s => [s, true])), at: iso(x.at), ...(x.gone ? { gone: true } : {}) })),
    gear: (Array.isArray(it.gear) ? it.gear : []).slice(0, 100).filter(x => tok(x?.key)).map(x => ({ key: tok(x.key), item: str(x.item, 80), who: str(x.who, 60), at: iso(x.at), ...(x.gone ? { gone: true } : {}) })),
  };
}

// The calendar: the meet-up (with an alarm an hour before) and a license check three days out.
export function planIcs(plan, needs) {
  const ev = [];
  if (plan.meet?.time) {
    const t = Date.parse(plan.meet.time);
    ev.push({ uid: `crew-${plan.id}-meet`, start: t, end: t + 30 * 60e3, title: `Meet the crew: ${plan.meet.text || plan.camp?.name || plan.name}`,
      text: [plan.meet.text, Number.isFinite(plan.meet.lat) && `${plan.meet.lat.toFixed(5)}, ${plan.meet.lon.toFixed(5)}`, plan.camp && `Camp: ${plan.camp.name}${plan.site ? `, ${plan.site}` : ''}`].filter(Boolean).join('\n'), alarms: [60, 15] });
  }
  if (needs.length) {
    const t = Date.parse(localKey(addDays(Date.parse(plan.start + 'T12:00'), -3)) + 'T18:00');
    if (t > Date.now()) ev.push({ uid: `crew-${plan.id}-licenses`, start: t, title: `Licenses for ${plan.name || 'the trip'}?`,
      text: `Everyone needs: ${needs.map(n => n.options.map(s => STATE_NAME[s] ?? s).join(' or ')).join('; ')}.\n${needs.flatMap(n => n.options).filter((s, i, a) => a.indexOf(s) === i && LICENSE[s]).map(s => `${STATE_NAME[s]}: ${LICENSE[s].buy}`).join('\n')}`, alarms: [0] });
  }
  return ev.length ? icsFile(ev, `${plan.name || 'crew-trip'}-crew`) : null;
}

// ---------- Crew results ----------
// Your catches and your crew's on some waters, optionally between two days. Each fish carries who caught it.
export async function crewCatches(lakeIds, { from = null, to = null } = {}) {
  const ids = new Set(lakeIds), me = myName() || 'You';
  const [mine, crew, lakes] = await Promise.all([db.all('catches'), db.all('crew'), db.all('lakes')]);
  const lakeOf = new Map(lakes.map(l => [l.id, l]));
  const inSpan = c => { const d = c.time ? localKey(Date.parse(c.time)) : null; return d && (!from || d >= from) && (!to || d <= to); };
  return [...mine.filter(c => ids.has(c.lakeId)).map(c => ({ ...c, who: me, mine: true })), ...crew.filter(r => r.kind === 'catch' && ids.has(r.lakeId)).map(r => ({ ...r, who: r.from, mine: false }))]
    .filter(c => !from && !to || inSpan(c)).map(c => ({ ...c, t: Date.parse(c.time), lake: lakeOf.get(c.lakeId) }));
}

// Per person: fish, kept, the biggest one and the top species, most fish first.
export function tallyByPerson(fish) {
  const by = Object.entries(fish.reduce((m, c) => ((m[c.who] ??= []).push(c), m), {}));
  return by.map(([who, list]) => {
    const big = list.filter(c => Number.isFinite(c.length)).sort((a, b) => b.length - a.length)[0] ?? null;
    return { who, mine: list[0].mine, fish: nFish(list), kept: nFish(list.filter(c => c.released === false)), big, species: tally(list, c => c.species).slice(0, 2) };
  }).sort((a, b) => b.fish - a.fish || (b.big?.length ?? 0) - (a.big?.length ?? 0));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// What works on a water for all of you together, and this time of year (within about a month either side of today).
export function whatWorks(fish, now = Date.now()) {
  if (!fish.length) return null;
  const doy = t => { const d = new Date(t); return (Date.UTC(2001, d.getMonth(), d.getDate()) - Date.UTC(2001, 0, 1)) / 864e5; };
  const near = c => { const x = Math.abs(doy(c.t) - doy(now)); return Math.min(x, 365 - x) <= 31; };
  const sum = list => {
    const depths = list.map(c => c.depth).filter(Number.isFinite).sort((a, b) => a - b);
    const q = p => depths[Math.min(depths.length - 1, Math.floor(p * depths.length))];
    return {
      fish: nFish(list), people: [...new Set(list.map(c => c.who))], species: tally(list, c => c.species), lures: tally(list, c => c.lure?.trim()), techniques: tally(list, c => c.technique?.trim()),
      parts: tally(list.filter(c => c.lake && Number.isFinite(c.t)), c => partOf(c.t, c.lake)), months: tally(list.filter(c => Number.isFinite(c.t)), c => MONTHS[new Date(c.t).getMonth()]),
      depth: depths.length >= 2 ? [q(0.2), q(0.8)] : depths.length ? [depths[0], depths[0]] : null,
    };
  };
  const season = fish.filter(c => Number.isFinite(c.t) && near(c));
  return { all: sum(fish), season: nFish(season) >= 3 ? sum(season) : null };
}

// ---------- Where should we camp? ----------
// A saved water's pull: recent plants, fish you and the crew have caught there (more for this time of year), your star.
async function waterValue(l, fish, now) {
  const reasons = [];
  let v = 1;
  const id = stockIdOf(l);
  const plants = id != null ? await forLake(l)?.plantsFor(id).catch(() => []) ?? [] : [];
  const today = localKey(now), last = plants.filter(p => p.week <= today).sort((a, b) => b.week.localeCompare(a.week))[0];
  if (last) {
    const ago = Math.round((now - Date.parse((last.weekEnd ?? last.week) + 'T12:00')) / 864e5);
    if (ago <= 21) { v += ago <= 7 ? 3 : 2; reasons.push(`${last.species ?? 'Fish'} planted ${ago <= 0 ? 'this week' : `${ago} days ago`}`); }
  }
  const soon = plants.find(p => p.week > today && p.week <= localKey(addDays(now, 14)));
  if (soon) { v += 1; reasons.push(`plant scheduled week of ${soon.week.slice(5)}`); }
  const here = fish.filter(c => c.lakeId === l.id);
  if (here.length) {
    const n = nFish(here), people = new Set(here.map(c => c.who)).size;
    v += Math.min(3, Math.log2(1 + n));
    reasons.push(`${n} fish logged${people > 1 ? ` by ${people} of you` : ''}`);
    const w = whatWorks(here, now);
    if (w?.season) { v += Math.min(2, w.season.fish * 0.3); reasons.push(`${w.season.fish} this time of year`); }
  }
  if (l.favorite) { v += 1; reasons.push('★ starred'); }
  return { lake: l, value: v, reasons };
}

// Every camp the phone knows: campgrounds and dispersed areas in each saved water's Camping lookup, your campsites
// and the crew's. One spot listed twice (within 200 m, or the same name) counts once.
export async function knownCamps() {
  const lakes = await db.all('lakes');
  const out = [];
  const add = c => { if (Number.isFinite(c.lat) && Number.isFinite(c.lon) && !out.some(o => haversineKm(o.lat, o.lon, c.lat, c.lon) < 0.2 || (o.name && o.name === c.name && haversineKm(o.lat, o.lon, c.lat, c.lon) < 3))) out.push(c); };
  for (const s of await db.all('campsites')) add({ name: s.name || 'Your campsite', lat: s.lat, lon: s.lon, kind: 'dispersed', source: 'yours', facts: s });
  for (const s of (await db.all('crew')).filter(r => r.kind === 'campsite')) add({ name: s.name || 'Campsite', lat: s.lat, lon: s.lon, kind: 'dispersed', source: `from ${s.from}`, facts: s });
  const unchecked = [];
  for (const l of lakes) {
    const d = await campingCached(l);
    if (!d) { unchecked.push(l); continue; }
    for (const s of d.sites ?? []) add({ name: s.name, lat: s.lat, lon: s.lon, kind: s.kind ?? null, recgovId: s.recgovId ?? null, water: s.water ?? null, toilets: s.toilets ?? null, status: s.status ?? null, fee: s.fee ?? null, bookUrl: s.bookUrl ?? null, source: 'Camping lookup', lakeId: l.id });
  }
  return { camps: out, lakes, unchecked };
}

// Camps ranked by the waters within `km` (straight line), grouped into areas by the best water in reach.
export async function whereToCamp(km, { now = Date.now() } = {}) {
  const { camps, lakes, unchecked } = await knownCamps();
  const fish = await crewCatches(lakes.map(l => l.id));
  const values = new Map();
  for (const l of lakes) values.set(l.id, await waterValue(l, fish, now));
  const ranked = camps.map(c => {
    const reach = lakes.map(l => ({ ...values.get(l.id), km: haversineKm(c.lat, c.lon, l.lat, l.lon) })).filter(x => x.km <= km)
      .map(x => ({ ...x, score: x.value * (1 - 0.5 * x.km / km) })).sort((a, b) => b.score - a.score);
    const perks = [];
    let score = reach.slice(0, 4).reduce((s, x) => s + x.score, 0);
    if (c.water === 'yes') { score += 0.5; perks.push('tap water'); }
    if (c.toilets && c.toilets !== 'no') { score += 0.25; perks.push('toilets'); }
    if (c.source !== 'Camping lookup') { score += 0.5; perks.push(c.source === 'yours' ? 'your spot' : `spot ${c.source}`); }
    if (c.status === 'closed') { score -= 3; perks.push('closed now'); }
    return { camp: c, reach, score, perks };
  }).filter(r => r.reach.length).sort((a, b) => b.score - a.score);
  const areas = new Map();
  for (const r of ranked) {
    const k = r.reach[0].lake.id;
    if (!areas.has(k)) areas.set(k, { lake: r.reach[0].lake, camps: [], waters: new Map() });
    const a = areas.get(k);
    a.camps.push(r);
    for (const x of r.reach) if (!a.waters.has(x.lake.id) || a.waters.get(x.lake.id).km > x.km) a.waters.set(x.lake.id, x);
  }
  const list = [...areas.values()].map(a => ({ ...a, score: a.camps[0].score, waters: [...a.waters.values()].sort((x, y) => y.score - x.score) })).sort((a, b) => b.score - a.score);
  return { areas: list, unchecked, camps: camps.length };
}
