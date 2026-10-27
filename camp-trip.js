// Camp trips: several days fished from one base camp. A row in the `campTrips` store holds the dates, the camp, the
// waters within reach and the drive time to each (typed by you, or a labelled estimate: no routing service ever sees
// where you camp). From those, this module works out on the device:
//   the plan: a suggested water for each dawn and dusk, with the reasons (wind and rain from each water's forecast,
//     saved or live, bite windows, light, recent plants, your drive, and what you caught there earlier in the trip);
//     past the forecast's last day it is light and bite windows only
//   open sites for all the trip's nights at the reservable campgrounds around camp (Recreation.gov), what's new
//     since you last looked, and the day bookings open
//   the trip-long log: every session and catch of the trip, and "what worked yesterday"
//   the camp card: drinking water, fires and food storage for the camp, from the Camping lookups already on the phone
// Calendar alarms are .ics files made here; your calendar app imports them and this app never sees them again.
import { db } from './db.js';
import { haversineKm } from './data-sources.js';
import { weatherFor, localKey, addDays } from './forecast.js';
import { solunar, shortTime } from './solunar.js';
import { forLake, stockIdOf, stateAt } from './states/index.js';
import { cached as campingCached, weekendAvailability } from './camping.js';
import { dispersedSummary, FIRE } from './camping-rules.js';

const H = 3600e3;
export const PARTS = { dawn: 'Dawn', dusk: 'Dusk' };

// ---------- Days and nights ----------
export const dayKeys = trip => {
  const out = [];
  for (let d = trip.start; d && d <= (trip.end ?? trip.start) && out.length < 31; d = localKey(addDays(Date.parse(d + 'T12:00'), 1))) out.push(d);
  return out;
};
// The nights you sleep at camp: every day but the last (a one-day trip is that one night).
export const tripNights = trip => { const d = dayKeys(trip); return d.length > 1 ? d.slice(0, -1) : d; };
// The sessions to plan: you arrive for the first evening and leave after the last morning.
export function sessionsOf(trip) {
  const days = dayKeys(trip);
  return days.flatMap((day, i) => (days.length === 1 ? ['dawn', 'dusk'] : i === 0 ? ['dusk'] : i === days.length - 1 ? ['dawn'] : ['dawn', 'dusk']).map(part => ({ day, part })));
}
export const tripSpan = trip => [Date.parse(trip.start + 'T00:00'), Date.parse((trip.end ?? trip.start) + 'T23:59:59')];
// Which day of the trip it is now: 1-based, 0 before it starts, null after it's over.
export function tripDay(trip, t = Date.now()) {
  const [a, b] = tripSpan(trip);
  if (t > b) return null;
  if (t < a) return 0;
  return dayKeys(trip).indexOf(localKey(t)) + 1;
}

// ---------- Sun ----------
// Sunrise, sunset and civil twilight (first and last usable light) for the local day containing t, at a spot.
// The standard low-precision solar position (good to a minute or two), computed on the device.
const rad = Math.PI / 180, J1970 = 2440588, J2000 = 2451545, OBLIQ = rad * 23.4397, J0 = 0.0009;
const fromJulian = j => (j + 0.5 - J1970) * 864e5;
export function sunTimes(t, lat, lon) {
  const noonLocal = new Date(t); noonLocal.setHours(12, 0, 0, 0);
  const lw = -lon * rad, phi = lat * rad, d = noonLocal.getTime() / 864e5 - 0.5 + J1970 - J2000;
  const n = Math.round(d - J0 - lw / (2 * Math.PI));
  const ds = J0 + lw / (2 * Math.PI) + n;
  const M = rad * (357.5291 + 0.98560028 * ds);
  const L = M + rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)) + rad * 102.9372 + Math.PI;
  const dec = Math.asin(Math.sin(OBLIQ) * Math.sin(L));
  const transit = a => J2000 + a + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
  const noon = transit(ds);
  const at = h => {
    const w = Math.acos((Math.sin(h * rad) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec)));
    const set = transit(J0 + (w + lw) / (2 * Math.PI) + n);
    return [fromJulian(noon - (set - noon)), fromJulian(set)];
  };
  const [sunrise, sunset] = at(-0.833), [dawn, dusk] = at(-6);
  return { noon: fromJulian(noon), sunrise, sunset, dawn, dusk };
}

// ---------- Drive times ----------
// Typed minutes win. Otherwise a rough guess from the straight line (roads wind about a third longer, ~25 mph on
// mountain roads), always shown as an estimate.
export function driveFor(trip, lake) {
  const typed = (trip.drives ?? []).find(d => d.lakeId === lake.id)?.min;
  if (Number.isFinite(typed)) return { min: typed, est: false };
  if (!trip.camp || !Number.isFinite(trip.camp.lat)) return { min: null, est: true };
  const km = haversineKm(trip.camp.lat, trip.camp.lon, lake.lat, lake.lon);
  return { min: km < 1 ? 0 : Math.max(5, Math.ceil(km * 1.35 / 40 * 60 / 5) * 5), est: true };
}
export const driveText = d => d.min == null ? '' : d.min === 0 ? 'at camp' : `${d.est ? '≈' : ''}${d.min} min${d.est ? ' (est.)' : ''}`;

// ---------- The plan ----------
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const hourLabel = t => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric' }).replace(/\s?([AP])M$/i, (_, a) => a.toLowerCase());

// One water for one session: a score (5 is ordinary), reason chips and the one-line summary.
export function rateSession(lake, part, day, { w = null, drive = { min: null }, plants = [], caught = 0 } = {}) {
  const noon = Date.parse(day + 'T12:00'), sun = sunTimes(noon, lake.lat, lake.lon);
  const from = part === 'dawn' ? sun.dawn : sun.sunset - 3 * H, to = part === 'dawn' ? sun.sunrise + 3 * H : sun.dusk;
  const light = part === 'dawn' ? sun.sunrise : sun.sunset;
  const sol = solunar(new Date(noon), lake.lat, lake.lon);
  // A bite window whose peak falls in the session (give or take half an hour), not one that just brushes its edge.
  const bite = sol.windows.filter(x => x.peak >= from - H / 2 && x.peak <= to + H / 2)
    .sort((a, b) => (b.type === 'major') - (a.type === 'major') || Math.abs(a.peak - light) - Math.abs(b.peak - light))[0] ?? null;
  const reasons = [], bits = [];
  let score = 5;
  const add = (pts, text, tone = pts > 0 ? 'good' : pts < 0 ? 'bad' : 'ok') => { score += pts; reasons.push({ text, tone }); };
  // The forecast for the session's hours, when it reaches that far.
  const hw = w?.hourly, idx = hw ? hw.time.map((x, i) => [Date.parse(x), i]).filter(([t]) => t >= from - H && t < to).map(([, i]) => i) : [];
  const wx = idx.length >= 2;
  if (wx) {
    const v = k => idx.map(i => hw[k]?.[i]).filter(Number.isFinite);
    const wind = mean(v('wind_speed_10m')), gust = Math.max(...v('wind_gusts_10m'), 0), pop = Math.max(...v('precipitation_probability'), 0);
    const codes = v('weather_code'), at = t => { const i = hw.time.findIndex(x => Date.parse(x) + H > t); return i < 0 ? null : hw.wind_speed_10m[i]; };
    if (part === 'dawn') {
      const calmAtLight = (at(light) ?? 99) < 5;
      const breeze = calmAtLight ? hw.time.findIndex((x, i) => Date.parse(x) > light && Date.parse(x) <= light + 6 * H && hw.wind_speed_10m[i] >= 8) : -1;
      if (calmAtLight) bits.push(breeze >= 0 ? `glassy until ${hourLabel(Date.parse(hw.time[breeze]))}` : 'calm all morning');
    } else {
      const atSet = at(light) ?? 99, before = at(light - 2 * H) ?? 0;
      if (atSet < 5) bits.push(before >= 8 ? `lays down by ${hourLabel(light)}` : 'calm at sunset');
    }
    if (wind <= 4) add(2, `Glassy, ${Math.round(wind)} mph`);
    else if (wind <= 8) add(1, `Light wind, ${Math.round(wind)} mph`);
    else if (wind <= 14) add(0, `Wind ${Math.round(wind)} mph`);
    else if (wind <= 20) add(-1.5, `Breezy, ${Math.round(wind)} mph`);
    else add(-3, `Windy, ${Math.round(wind)} mph`);
    if (!bits.length && wind > 8) bits.push(`wind ${Math.round(wind)} mph`);
    if (gust >= 25) add(-1, `Gusts ${Math.round(gust)}`);
    if (codes.some(c => c >= 95)) { add(-3, 'Thunderstorms'); bits.push('storms'); }
    else if (pop >= 60) { add(-1.5, `Rain likely (${pop}%)`); bits.push('rain likely'); }
    else if (pop >= 30) add(-0.5, `Chance of rain (${pop}%)`);
    const temps = v('temperature_2m');
    if (part === 'dawn' && temps.length && Math.min(...temps) <= 32) reasons.push({ text: `${Math.round(Math.min(...temps))}° at first light`, tone: 'ok' });
  }
  if (bite) {
    add(bite.type === 'major' ? 1.5 : 0.75, `${bite.type === 'major' ? 'Major' : 'Minor'} bite ${shortTime(bite.start)}–${shortTime(bite.end)}`);
    if (Math.abs(bite.peak - light) <= H) add(0.5, `Bite lines up with ${part === 'dawn' ? 'sunrise' : 'sunset'}`);
  }
  const lastPlant = plants.filter(p => p.week <= day).sort((a, b) => b.week.localeCompare(a.week))[0];
  if (lastPlant) {
    const ago = Math.round((noon - Date.parse((lastPlant.weekEnd ?? lastPlant.week) + 'T12:00')) / 864e5);
    if (ago <= 14) add(ago <= 7 ? 1.5 : 0.75, `${lastPlant.species ?? 'Fish'} planted ${ago <= 0 ? 'that week' : `${ago} day${ago === 1 ? '' : 's'} before`}`);
  }
  if (caught) add(Math.min(2, caught * 0.5), `You caught ${caught} here at ${part} this trip`);
  if (drive.min != null) {
    if (drive.min >= 20) add(-Math.min(3, drive.min / 30), `${driveText(drive)} from camp`);
    else reasons.push({ text: drive.min === 0 ? 'Right at camp' : `${driveText(drive)} from camp`, tone: 'good' });
  }
  const line = [lake.name, ...bits, drive.min != null && (drive.min === 0 ? 'at camp' : `${drive.min} min`), bite && `bite ${shortTime(bite.peak)}`].filter(Boolean).join(', ');
  return { lake, part, day, from, to, light, sun, bite, wx, score: Math.max(0, Math.min(10, score)), reasons, line };
}

// The whole plan: each session's waters ranked, best first. Forecasts are the same ones Today uses (live, or the copy
// saved on the phone with its age); a water's coordinates are all that's sent, never the camp's.
export async function planTrip(trip) {
  const lakes = (await Promise.all((trip.lakeIds ?? []).map(id => db.get('lakes', id)))).filter(Boolean);
  const [wx, plants, log] = await Promise.all([
    Promise.all(lakes.map(l => weatherFor(l.lat, l.lon).catch(() => null))),
    Promise.all(lakes.map(async l => { const id = stockIdOf(l); return id != null ? forLake(l)?.plantsFor(id).catch(() => []) ?? [] : []; })),
    tripLog(trip),
  ]);
  const sessions = sessionsOf(trip).map(({ day, part }) => {
    const rows = lakes.map((l, i) => rateSession(l, part, day, {
      w: wx[i], drive: driveFor(trip, l), plants: plants[i] ?? [],
      caught: log.catches.filter(c => c.lakeId === l.id && c.day < day && partOf(c.t, l) === part).reduce((n, c) => n + (c.count ?? 1), 0),
    })).sort((a, b) => b.score - a.score);
    return { day, part, rows, pick: rows[0] ?? null, wx: rows.some(r => r.wx) };
  });
  const lastWx = wx.filter(Boolean).map(w => w.daily?.time?.at(-1)).sort().at(-1) ?? null;
  return { lakes, sessions, weather: lakes.map((l, i) => ({ lake: l, w: wx[i] })), lastWx };
}

// ---------- Calendar alarms (.ics) ----------
const icsText = s => String(s ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, '\\$&');
const icsTime = t => new Date(t).toISOString().replace(/[-:]|\.\d+/g, '');
// Lines over 75 bytes are folded, as the format asks.
const fold = line => { const out = []; let s = line; while (s.length > 74) { out.push(s.slice(0, 74)); s = ' ' + s.slice(74); } out.push(s); return out.join('\r\n'); };
// events: [{ uid, start, end (ms), title, text, alarms: [minutes before start] }]
export function icsFile(events, name) {
  const stamp = icsTime(Date.now()), seq = Math.floor(Date.now() / 60e3) % 2e9;
  const body = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Tackle Box//Camp trip//EN', 'CALSCALE:GREGORIAN',
    ...events.flatMap(e => ['BEGIN:VEVENT', `UID:${e.uid}@tackle-box`, `SEQUENCE:${seq}`, `DTSTAMP:${stamp}`, `DTSTART:${icsTime(e.start)}`, `DTEND:${icsTime(e.end ?? e.start + 30 * 60e3)}`,
      `SUMMARY:${icsText(e.title)}`, ...(e.text ? [`DESCRIPTION:${icsText(e.text)}`] : []),
      ...(e.alarms ?? []).flatMap(m => ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(e.alarmText ?? e.title)}`, `TRIGGER:-PT${Math.max(0, Math.round(m))}M`, 'END:VALARM']),
      'END:VEVENT']),
    'END:VCALENDAR'].map(fold).join('\r\n');
  return new File([body], `${name.replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '') || 'camp-trip'}.ics`, { type: 'text/calendar' });
}

// Alarms for the plan: one event per session at its suggested water, starting at first light (dawn) or two hours
// before sunset (dusk), with an alarm when it's time to leave camp (the drive plus 30 minutes to get going).
export function planAlarms(trip, plan, { lead = 30 } = {}) {
  return plan.sessions.filter(s => s.pick && s.pick.to > Date.now()).map(s => {
    const p = s.pick, drive = driveFor(trip, p.lake).min ?? 0, start = p.part === 'dawn' ? p.sun.dawn : p.sun.sunset - 2 * H;
    return {
      uid: `camp-${trip.id}-${s.day}-${s.part}`, start, end: p.to, title: `🎣 ${PARTS[s.part]}: ${p.lake.name}`,
      alarmText: drive ? `Leave camp for ${p.lake.name} (${drive} min)` : `${PARTS[s.part]} at ${p.lake.name}`,
      text: `${p.line}.\n${p.reasons.map(r => r.text).join(' · ')}\nPlanned in Tackle Box; the forecast may change, so check the plan again.`,
      alarms: [drive + lead],
    };
  });
}

// ---------- The trip-long log ----------
// Which part of the day a time falls in at a water: dawn (first light to 3 h after sunrise), dusk (3 h before sunset
// to last light), or the day or night between.
export function partOf(t, lake) {
  const s = sunTimes(t, lake.lat, lake.lon);
  if (t >= s.dawn - H && t <= s.sunrise + 3 * H) return 'dawn';
  if (t >= s.sunset - 3 * H && t <= s.dusk + H) return 'dusk';
  return t > s.sunrise && t < s.sunset ? 'day' : 'night';
}
const nearCamp = (trip, lake) => (trip.lakeIds ?? []).includes(lake.id) || (Number.isFinite(trip.camp?.lat) && haversineKm(trip.camp.lat, trip.camp.lon, lake.lat, lake.lon) <= 80);

// Every session (trip mode or a journal entry) and catch on the trip's days at its waters or within 50 miles of camp.
export async function tripLog(trip) {
  const [a, b] = tripSpan(trip);
  const [lakes, trips, catches, events] = await Promise.all([db.all('lakes'), db.all('trips'), db.all('catches'), db.all('events')]);
  const lakeOf = new Map(lakes.map(l => [l.id, l]));
  const ok = lakeId => { const l = lakeOf.get(lakeId); return l && nearCamp(trip, l); };
  const sessions = trips.filter(t => { const s = Date.parse(t.start); return s >= a && s <= b && ok(t.lakeId); }).sort((x, y) => x.start.localeCompare(y.start));
  const ids = new Set(sessions.map(t => t.id));
  const fish = catches.map(c => ({ ...c, t: Date.parse(c.time) }))
    .filter(c => ids.has(c.tripId) || (!c.tripId && c.t >= a && c.t <= b && ok(c.lakeId)))
    .map(c => ({ ...c, day: localKey(c.t) })).sort((x, y) => x.t - y.t);
  const evs = events.filter(e => ids.has(e.tripId));
  return { sessions, catches: fish, events: evs, lakeOf };
}

// What worked on one day of the trip: the water, the time of day, the lures and depths that caught fish.
export function workedOn(log, day) {
  const fish = log.catches.filter(c => c.day === day);
  const sessions = log.sessions.filter(s => localKey(Date.parse(s.start)) === day);
  if (!fish.length && !sessions.length) return null;
  const tally = (list, key) => Object.entries(list.reduce((m, x) => { const k = key(x); if (k) m[k] = (m[k] ?? 0) + (x.count ?? 1); return m; }, {})).sort((a, b) => b[1] - a[1]);
  const lakeName = id => log.lakeOf.get(id)?.name ?? 'Unknown water';
  const n = fish.reduce((s, c) => s + (c.count ?? 1), 0);
  const depths = fish.map(c => c.depth).filter(Number.isFinite).sort((a, b) => a - b);
  return {
    day, fish: n, sessions: sessions.length,
    bites: log.events.filter(e => e.kind === 'bite' && localKey(Date.parse(e.time)) === day).length,
    waters: tally(fish, c => lakeName(c.lakeId)), parts: tally(fish, c => { const l = log.lakeOf.get(c.lakeId); return l ? partOf(c.t, l) : null; }),
    lures: tally(fish, c => c.lure?.trim()), techniques: tally(fish, c => c.technique?.trim()), species: tally(fish, c => c.species),
    depth: depths.length ? [depths[0], depths.at(-1)] : null, kept: fish.filter(c => c.released === false).reduce((s, c) => s + (c.count ?? 1), 0),
    fishedAt: [...new Set(sessions.map(s => lakeName(s.lakeId)))],
  };
}

// ---------- Open sites for the trip's nights ----------
// The reservable campgrounds around camp, from the Camping lookups on the phone for the trip's waters (Recreation.gov
// ids), nearest first, the camp's own campground at the top.
export async function campgroundsNear(trip, km = 40) {
  const lakes = (await Promise.all([...new Set([...(trip.lakeIds ?? []), trip.camp?.lakeId].filter(Boolean))].map(id => db.get('lakes', id)))).filter(Boolean);
  const seen = new Map();
  for (const l of lakes) {
    const d = await campingCached(l);
    for (const s of d?.sites ?? []) {
      if (!s.recgovId || seen.has(s.recgovId)) continue;
      const dist = Number.isFinite(trip.camp?.lat) ? haversineKm(trip.camp.lat, trip.camp.lon, s.lat, s.lon) : s.distKm;
      if (dist <= km) seen.set(s.recgovId, { recgovId: s.recgovId, name: s.name, lat: s.lat, lon: s.lon, distKm: dist, bookUrl: s.bookUrl, price: s.price, sites: s.sites, status: s.status, season: s.season, lakeId: l.id });
    }
  }
  if (trip.camp?.recgovId && !seen.has(trip.camp.recgovId)) seen.set(trip.camp.recgovId, { recgovId: trip.camp.recgovId, name: trip.camp.name, lat: trip.camp.lat, lon: trip.camp.lon, distKm: 0, bookUrl: `https://www.recreation.gov/camping/campgrounds/${trip.camp.recgovId}` });
  return [...seen.values()].sort((a, b) => (b.recgovId === trip.camp?.recgovId) - (a.recgovId === trip.camp?.recgovId) || a.distKm - b.distKm);
}

// Checks each campground for every night of the trip and keeps the answer on the trip, so the next check can say
// which sites are new. Only campground ids and months go to Recreation.gov.
export async function checkSites(trip, camps, { onEach = () => {} } = {}) {
  const nights = tripNights(trip), before = trip.sites?.nights?.join() === nights.join() ? trip.sites.camps ?? {} : {};
  const out = {};
  for (const c of camps) {
    try {
      const r = await weekendAvailability(c.recgovId, nights);
      const had = new Set((before[c.recgovId]?.open ?? []).map(s => s.id));
      const known = !!before[c.recgovId];
      out[c.recgovId] = { name: c.name, total: r.total, all: r.all, some: r.some, notReleased: r.notReleased, firstCome: r.firstCome, closed: r.closed, reserved: r.reserved,
        open: r.open.slice(0, 60), fresh: known ? r.open.filter(s => !had.has(s.id)).map(s => s.label).slice(0, 20) : [], gone: known ? [...had].filter(id => !r.open.some(s => s.id === id)).length : 0, checkedAt: r.checkedAt };
    } catch (e) { out[c.recgovId] = { name: c.name, error: String(e.message ?? e).slice(0, 80), checkedAt: new Date().toISOString() }; }
    onEach(c.recgovId, out[c.recgovId]);
  }
  const saved = (await db.get('campTrips', trip.id)) ?? trip;
  return db.put('campTrips', { ...saved, sites: { nights, checkedAt: new Date().toISOString(), camps: { ...before, ...out } } });
}

// When bookings open for the first night: most Recreation.gov campgrounds release sites 6 months ahead, at 10 am
// Eastern (7 am Pacific). Some use a shorter window or a lottery; the campground's page says which.
export function bookingOpens(firstNight) {
  const d = new Date(firstNight + 'T12:00');
  const day = new Date(d.getFullYear(), d.getMonth() - 6, d.getDate());
  if (day.getDate() !== d.getDate()) day.setDate(0); // Aug 31 -> Feb 28: the last day of that month
  return pacific(localKey(day), 7);
}
// ms for hh:00 Pacific time on a calendar day, whatever the phone's own time zone.
function pacific(dayKey, hh) {
  const [y, m, d] = dayKey.split('-').map(Number);
  for (const off of [7, 8]) {
    const t = Date.UTC(y, m - 1, d, hh + off);
    const h = +new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hourCycle: 'h23' }).format(t);
    if (h === hh) return t;
  }
  return Date.UTC(y, m - 1, d, hh + 8);
}

// ---------- The camp card ----------
// Hand-kept food storage rules where they're stricter than "bear country, use the locker". Each links its source.
export const FOOD_RULES = [
  { re: /yosemite/i, text: 'Yosemite: everything with a scent (food, coolers, trash, toiletries) goes in the food locker at your site, day and night. Nothing scented stays in your car after dark. Backpackers carry a bear canister.', url: 'https://www.nps.gov/yose/planyourvisit/bears.htm' },
  { re: /sequoia|kings canyon/i, text: 'Sequoia and Kings Canyon: use the food locker at your site for anything with a scent, day and night. Canisters are required in much of the backcountry.', url: 'https://www.nps.gov/seki/planyourvisit/bears.htm' },
  { re: /inyo national forest|inyo nf/i, text: 'Inyo National Forest has a food storage order: food, trash and scented items go in a bear locker or a bear-resistant container, and canisters are required in many of its wilderness areas.', url: 'https://www.sierrawild.gov/bears' },
];
const BEAR_STATE = {
  CA: 'Black bears live in the Sierra, the Cascades and most of California’s forests, and campground bears break into cars and coolers.',
  OR: 'Black bears live in Oregon’s forests, from the Cascades to the Blue Mountains.',
  NV: 'Black bears live in the Carson Range and around Lake Tahoe, and wander east into western Nevada’s ranges.',
};
export const FOOD_HABITS = [
  'Use the bear locker if your site has one, and close and latch it every time.',
  'Never keep food, coolers, trash or anything with a scent (toothpaste, sunscreen, fish) in your tent.',
  'Clean fish well away from camp, and pack the guts out or dispose of them as the campground asks: never leave them on the bank by your site.',
  'Cook and eat away from where you sleep when you can; wash up right after.',
  'In the backcountry, carry a bear canister where they are required and store it 100 ft from your tent.',
];

export async function campCard(trip) {
  const camp = trip.camp ?? {};
  const lakes = (await Promise.all([...new Set([camp.lakeId, ...(trip.lakeIds ?? [])].filter(Boolean))].map(id => db.get('lakes', id)))).filter(Boolean);
  const data = (await Promise.all(lakes.map(async l => ({ lake: l, d: await campingCached(l) })))).filter(x => x.d);
  const here = Number.isFinite(camp.lat);
  const dist = s => here ? haversineKm(camp.lat, camp.lon, s.lat, s.lon) : s.distKm ?? 99;
  const sites = data.flatMap(x => x.d.sites ?? []);
  const site = camp.recgovId ? sites.find(s => s.recgovId === camp.recgovId) : camp.name ? sites.find(s => s.name === camp.name && dist(s) < 0.5) : null;
  const tap = sites.filter(s => s.water === 'yes' && s.kind !== 'dispersed' && s !== site).map(s => ({ s, km: dist(s) })).sort((a, b) => a.km - b.km)[0] ?? null;
  // The land around the water closest to camp (the Camping lookup asks about the land around each water).
  const nearest = data.map(x => ({ ...x, km: here ? haversineKm(camp.lat, camp.lon, x.lake.lat, x.lake.lon) : 0 })).sort((a, b) => a.km - b.km)[0] ?? null;
  const land = nearest ? dispersedSummary(nearest.d.land?.parcels) : null;
  const units = (land?.rows ?? []).map(r => r.unit ?? '').join(' ') + ' ' + (nearest?.lake.name ?? '') + ' ' + sites.filter(s => dist(s) < 15).map(s => s.forest ?? '').join(' ');
  const state = here ? stateAt(camp.lat, camp.lon)?.code : forLake(lakes[0] ?? {})?.code;
  return {
    camp, site, tap, land, landWater: nearest?.lake ?? null, landKm: nearest?.km ?? null, state, fire: FIRE[state] ?? null,
    food: FOOD_RULES.filter(r => r.re.test(units)), bear: BEAR_STATE[state] ?? BEAR_STATE.CA, lookedUp: data.map(x => x.d.fetchedAt).sort()[0] ?? null,
    developed: !!site && site.kind !== 'dispersed', missing: lakes.filter(l => !data.some(x => x.lake.id === l.id)),
  };
}

// Saved waters closest to a spot, for picking the trip's waters.
export async function watersNear(lat, lon, km = 80) {
  return (await db.all('lakes')).map(l => ({ l, km: haversineKm(lat, lon, l.lat, l.lon) })).filter(x => x.km <= km).sort((a, b) => a.km - b.km);
}
