// Know your water: today's water temperature and clarity, the high-lake ice-off estimate and the lake's year by month.
// Everything is worked out on the phone from what the app already has (the water's size, depth, elevation and
// latitude, the saved forecast, your catches, scans and temperature profiles). The only request is one Open-Meteo
// call for the last 30 days of air temperature at the water, which carries just its coordinates.
import { db } from './db.js';
import { localKey, addDays } from './forecast.js';
import { isRiver } from './states/common.js';

const C = f => (f - 32) * 5 / 9, F = c => c * 9 / 5 + 32;
const doyOf = t => { const d = new Date(t); return Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(d.getFullYear(), 0, 0)) / 864e5); };
const dateOfDoy = (year, doy) => new Date(year, 0, doy, 12);
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLabel = d => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

// ---------- Air temperature, last 30 days ----------
// Kept for the day in localStorage, so a water you looked at this morning still has it with no signal.
const airKey = (lat, lon) => `tb-air30:${(+lat).toFixed(2)},${(+lon).toFixed(2)}`;
export async function airMeans(lat, lon) {
  try { const s = JSON.parse(localStorage.getItem(airKey(lat, lon))); if (s?.day === localKey()) return s; } catch {}
  try {
    if (navigator.onLine === false) throw new Error('offline');
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.search = new URLSearchParams({ latitude: (+lat).toFixed(2), longitude: (+lon).toFixed(2), timezone: 'auto', temperature_unit: 'fahrenheit', past_days: 30, forecast_days: 1, daily: 'temperature_2m_mean' });
    const r = await fetch(url, { signal: AbortSignal.timeout?.(12e3) });
    if (!r.ok) throw new Error('Weather unavailable');
    const t = (await r.json()).daily?.temperature_2m_mean?.filter(Number.isFinite) ?? [];
    if (t.length < 10) throw new Error('Too few days');
    const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
    const out = { day: localKey(), m30: mean(t), m7: mean(t.slice(-7)) };
    try { localStorage.setItem(airKey(lat, lon), JSON.stringify(out)); } catch {}
    return out;
  } catch {
    try { const s = JSON.parse(localStorage.getItem(airKey(lat, lon))); if (s && Date.now() - Date.parse(s.day) < 10 * 864e5) return { ...s, old: true }; } catch {}
    return null;
  }
}

// ---------- Water temperature now ----------
// Your own reading from the last 5 days wins (a catch, a profile's top reading, a Deeper scan). Otherwise an estimate
// from air temperature: surface water follows the air with a lag of a few weeks, so it uses mostly the 30-day mean
// (a rule of thumb; lakes lag more in spring, rivers less). With no air data it falls back to the forecast's days.
export async function waterTempNow(lake, w = null, data = null) {
  const since = Date.now() - 5 * 864e5;
  const { catches = await db.byLake('catches', lake.id ?? '-'), profiles = await db.byLake('tempProfiles', lake.id ?? '-'), sets = await db.byLake('depthSets', lake.id ?? '-') } = data ?? {};
  const mine = [
    ...catches.filter(c => Number.isFinite(+c.waterTemp) && c.waterTemp !== null && c.waterTemp !== '' && Date.parse(c.time) > since).map(c => ({ t: Date.parse(c.time), f: +c.waterTemp, from: 'your catch' })),
    ...profiles.filter(p => Date.parse(`${p.date}T12:00`) > since && p.readings?.length).map(p => ({ t: Date.parse(`${p.date}T12:00`), f: +[...p.readings].sort((a, b) => a[0] - b[0])[0][1], from: 'your profile' })),
    ...sets.filter(s => s.scanDate && Date.parse(`${s.scanDate}T12:00`) > since && s.temps?.length).map(s => ({ t: Date.parse(`${s.scanDate}T12:00`), f: s.temps.reduce((a, x) => a + +x[2], 0) / s.temps.length, from: 'your scan' })),
  ].filter(x => Number.isFinite(x.f) && x.f > 30 && x.f < 100).sort((a, b) => b.t - a.t);
  if (mine[0]) return { f: Math.round(mine[0].f), measured: true, from: `${mine[0].from}, ${dayLabel(new Date(mine[0].t))}` };
  let air = await airMeans(lake.lat, lake.lon), basis = 'the last 30 days of air temperature';
  if (!air && w?.daily?.temperature_2m_max) {
    const d = w.daily.temperature_2m_max.slice(0, 4).map((hi, i) => (hi + w.daily.temperature_2m_min[i]) / 2).filter(Number.isFinite);
    if (d.length) { const m = d.reduce((a, b) => a + b, 0) / d.length; air = { m30: m, m7: m }; basis = 'the forecast (no 30-day record on the phone)'; }
  }
  if (!air) return null;
  const a = C(0.7 * air.m30 + 0.3 * air.m7);
  const river = isRiver(lake);
  const c = Math.min(river ? 24 : 29, Math.max(0.5, (river ? 3 : 4) + 0.8 * a));
  return { f: Math.round(F(c)), measured: false, from: `estimate from ${basis}` };
}

// ---------- Clarity now ----------
// Your newest clarity note from the last 10 days, else the Secchi depth on the water's Info (Edit), else the typical
// clarity of a well-studied lake for this month, else unknown (the game plan then gives colors for both).
const CLARITY = ['Clear', 'Stained', 'Murky', 'Muddy'];
export const secchiToClarity = ft => ft >= 10 ? 'Clear' : ft >= 4 ? 'Stained' : ft >= 2 ? 'Murky' : 'Muddy';
export function clarityNow(lake, catches = [], t = Date.now()) {
  const recent = catches.filter(c => CLARITY.includes(c.clarity) && t - Date.parse(c.time) < 10 * 864e5 && Date.parse(c.time) <= t).sort((a, b) => b.time.localeCompare(a.time))[0];
  if (recent) return { clarity: recent.clarity, from: `your note, ${dayLabel(new Date(recent.time))}` };
  if (+lake.clarity > 0) return { clarity: secchiToClarity(+lake.clarity), from: `${lake.clarity} ft Secchi on Info` };
  const known = studiedLake(lake)?.months?.[new Date(t).getMonth()];
  if (known?.secchiFt) return { clarity: secchiToClarity(known.secchiFt), from: `typical for ${MONTHS[new Date(t).getMonth()]} here` };
  return { clarity: null, from: 'unknown' };
}

// ---------- High-lake ice-off ----------
// An "equivalent elevation": every degree of latitude north of 37.5° counts like ~300 ft of climb (about the same drop
// in mean temperature). Ice cover is worth estimating above ~6,000 ft at that latitude.
export const eqElevation = lake => (+lake.elevationFt || 0) + ((+lake.lat || 37.5) - 37.5) * 300;
export const ICE_FROM_FT = 6000;
// Ice-off day of year from equivalent elevation, fitted to typical Eastern Sierra dates: ~7,000 ft mid April,
// ~8,900 ft late May, ~9,600 ft early June, ~10,100 ft around June 20, ~11,000 ft early July. Ice-on comes
// earlier the higher you go: ~Dec 1 at 7,000 ft, late October at 10,000 ft.
const modelIceOff = e => 105 + 21 * (e - 7000) / 1000;
const modelIceOn = e => 335 - 12 * (e - 7000) / 1000;

// Your ice notes (store iceLogs: { lakeId, date 'YYYY-MM-DD', state 'iced'|'partial'|'open' }) improve the model:
// for each spring you noted both ice and open water, the ice-off date is taken as halfway between the last ice and
// the first open note; the average gap between those dates and the model (this water counted three times, your
// other high waters once) shifts every estimate. A note from this spring overrides the estimate outright.
export function observedIceOff(logs, year) {
  const spring = logs.filter(l => l.date?.startsWith(`${year}-`) && +l.date.slice(5, 7) <= 8).sort((a, b) => a.date.localeCompare(b.date));
  const open = spring.find(l => l.state === 'open');
  if (!open) return null;
  const lastIce = spring.filter(l => l.state !== 'open' && l.date < open.date).at(-1);
  if (!lastIce) return null;
  const a = doyOf(Date.parse(lastIce.date + 'T12:00')), b = doyOf(Date.parse(open.date + 'T12:00'));
  return b - a <= 45 ? Math.round((a + b) / 2) : null; // notes weeks apart don't pin a date
}

export function iceOffset(lake, allLogs, lakes) {
  const shifts = [];
  for (const l of lakes) {
    if (eqElevation(l) < ICE_FROM_FT) continue;
    const logs = allLogs.filter(x => x.lakeId === l.id);
    for (const year of new Set(logs.map(x => x.date.slice(0, 4)))) {
      const obs = observedIceOff(logs, year);
      if (obs != null) for (let k = l.id === lake.id ? 3 : 1; k; k--) shifts.push(obs - modelIceOff(eqElevation(l)));
    }
  }
  return shifts.length ? { days: Math.round(shifts.reduce((a, b) => a + b, 0) / shifts.length), n: shifts.length } : null;
}

// The ice estimate for a water today, or null below the ice line (and for rivers, which run under ice and open water).
export function iceEstimate(lake, { logs = [], allLogs = logs, lakes = [lake], t = Date.now() } = {}) {
  const e = eqElevation(lake);
  if (isRiver(lake) || !+lake.elevationFt || e < ICE_FROM_FT) return null;
  const year = new Date(t).getFullYear(), today = doyOf(t);
  const off = iceOffset(lake, allLogs, lakes);
  // Big shallow-ish lakes hold ice a little longer than small ponds, which melt out first.
  const size = +lake.acres > 500 ? 5 : +lake.acres && +lake.acres < 20 ? -5 : 0;
  let iceOff = Math.round(modelIceOff(e) + size + (off?.days ?? 0)), iceOn = Math.round(modelIceOn(e) - size / 2);
  const mine = logs.filter(l => l.lakeId === lake.id).sort((a, b) => b.date.localeCompare(a.date));
  const thisYear = mine.filter(l => l.date.startsWith(`${year}-`));
  const seenOff = observedIceOff(mine, year);
  let basis = off ? `estimate, shifted ${off.days > 0 ? '+' : ''}${off.days} days by your ${off.n > 1 ? 'ice notes' : 'ice note'}` : 'estimate from elevation and latitude';
  if (seenOff != null) { iceOff = seenOff; basis = 'from your ice notes this spring'; }
  else {
    // Ice noted this spring after the estimate: it's later this year. Open water noted before it: earlier.
    const lastIce = thisYear.find(l => l.state !== 'open' && +l.date.slice(5, 7) <= 8);
    const firstOpen = [...thisYear].reverse().find(l => l.state === 'open' && +l.date.slice(5, 7) <= 8);
    if (lastIce && doyOf(Date.parse(lastIce.date + 'T12:00')) + 7 > iceOff) { iceOff = doyOf(Date.parse(lastIce.date + 'T12:00')) + (lastIce.state === 'partial' ? 7 : 14); basis = `pushed back by your ${lastIce.state === 'partial' ? 'ice-going-out' : 'ice'} note`; }
    if (firstOpen && doyOf(Date.parse(firstOpen.date + 'T12:00')) < iceOff) { iceOff = doyOf(Date.parse(firstOpen.date + 'T12:00')); basis = 'your open-water note this spring'; }
  }
  // Ice noted this fall: it has formed (the newest note, so open water noted after it wins).
  const fall = thisYear.find(l => +l.date.slice(5, 7) >= 9);
  const fallIce = fall && fall.state !== 'open' ? doyOf(Date.parse(fall.date + 'T12:00')) : null;
  if (fallIce != null) { iceOn = Math.min(iceOn, fallIce); basis = `your ice note on ${dayLabel(dateOfDoy(year, fallIce))}`; }
  const offDate = dateOfDoy(year, iceOff), onDate = dateOfDoy(year, iceOn);
  // Very large, deep lakes (Tahoe) hold too much heat to freeze over.
  if (+lake.acres > 5000 && +lake.maxDepth > 300) return { e, state: 'never', text: 'Rarely or never freezes over: too big and deep to lose its heat', basis: 'size and depth' };
  let state, text;
  if (today < iceOff - 10 || today >= iceOn + 10 || (fallIce != null && today >= fallIce)) { state = 'iced'; text = today >= iceOn ? `Likely iced over now; ice-off around ${dayLabel(dateOfDoy(year + 1, iceOff))}` : `Likely still iced; ice-off around ${dayLabel(offDate)}`; }
  else if (today < iceOff + 3) { state = 'going'; text = `Ice likely going out now (around ${dayLabel(offDate)}): shore ice, open water at inlets first`; }
  else if (today < iceOff + 21) { state = 'fresh'; text = `Ice likely off since about ${dayLabel(offDate)}: trout cruise the warming shallows`; }
  else if (today >= iceOn - 10) { state = 'freezing'; text = `Ice likely forming soon, around ${dayLabel(onDate)}`; }
  else { state = 'open'; text = `Ice-free; ice-off was around ${dayLabel(offDate)}, ice-on around ${dayLabel(onDate)}`; }
  return { e, state, text, basis, iceOff: offDate, iceOn: onDate, last: mine[0] ?? null };
}

// ---------- Well-studied lakes ----------
// Hand-kept from the agencies' and universities' own monitoring reports, one row per month where they give one.
// Only what the reports say is here; months they don't cover fall back to the estimate.
export const STUDIED = [
  { name: 'Lake Tahoe', lat: 39.09, lon: -120.04, r: 25, source: 'https://tahoe.ucdavis.edu/stateofthelake', by: 'UC Davis Tahoe Environmental Research Center, State of the Lake (2020 data)',
    note: 'Annual average Secchi 63 ft; summer (Jun–Sep) 59 ft, winter about 64 ft. Too big and deep to freeze. Oxygen stays high at depth in most years.',
    months: Object.fromEntries([...Array(12).keys()].map(m => [m, { secchiFt: m >= 5 && m <= 8 ? 59 : 64 }])) },
  { name: 'Crater Lake', lat: 42.94, lon: -122.10, r: 8, source: 'https://www.nps.gov/crla/learn/nature/monitoringcraterlake.htm', by: 'National Park Service, Long-Term Limnological Monitoring report (2018)',
    note: 'Summer Secchi about 30 m (~100 ft). Stratifies from about June (earlier than it used to); the thermocline is usually less than 20 m (66 ft) deep. Mixes in fall and spring, with deep mixing in some winters.',
    months: { 5: { secchiFt: 98, strat: 'Stratifying' }, 6: { secchiFt: 98, strat: 'Stratified', thermo: 'under 66 ft' }, 7: { secchiFt: 98, strat: 'Stratified', thermo: 'under 66 ft' }, 8: { secchiFt: 98, strat: 'Stratified', thermo: 'under 66 ft' } } },
  { name: 'Clear Lake', state: 'CA', lat: 39.03, lon: -122.77, r: 15, source: 'https://ucanr.edu/sites/default/files/2011-11/132447.pdf', by: 'UC Davis Clear Lake water-quality report (1969–2008 data)',
    note: 'Shallow (about 40–60 ft at the deepest) and usually mixed top to bottom: summer layering from June to August is broken up most nights. April–October Secchi averaged about 7 ft since 1990 (3.6 ft before). The Upper Arm has had more low-oxygen spells since 2000.',
    months: Object.fromEntries([3, 4, 5, 6, 7, 8, 9].map(m => [m, { secchiFt: 7, strat: m >= 5 && m <= 7 ? 'Mixed most nights' : 'Mixed', thermo: m >= 5 && m <= 7 ? 'none lasting' : null }])) },
];
export function studiedLake(lake) {
  const km = (a, b, c, d) => Math.hypot((a - c) * 111, (b - d) * 111 * Math.cos(a * Math.PI / 180));
  return STUDIED.find(s => (s.state ? s.state === lake.state || !lake.state : true) && new RegExp(`^${s.name}$`, 'i').test((lake.name ?? '').trim()) && km(lake.lat, lake.lon, s.lat, s.lon) < s.r) ?? null;
}

// ---------- The year by month ----------
// For every water: ice (from the estimate above), when it layers and turns over, how deep the summer thermocline sits
// and where oxygen runs short. Rules of thumb from lake size, depth, elevation and clarity, then replaced month by
// month by what you've measured (temperature profiles, water temps and clarity on catches) and the studied-lake rows.
export function monthProfile(lake, { profiles = [], catches = [], ice = null } = {}) {
  const e = eqElevation(lake), depth = +lake.maxDepth || null, acres = +lake.acres || null, river = isRiver(lake);
  const studied = studiedLake(lake);
  const productive = +lake.clarity > 0 ? +lake.clarity < 6 : e < 3000 && (!depth || depth < 60); // low, warm and shallow lakes grow more algae
  // Low-elevation lakes layer from about April to October and mix all winter; each 1,500 ft higher starts ~2 weeks
  // later and ends ~2 weeks sooner. Ice months come from the ice estimate.
  const shift = Math.max(0, (e - 3000) / 1500) * 0.5;
  const stratStart = 3.5 + shift, stratEnd = 9.5 - shift; // month index, 0 = Jan
  const iceOffM = ice?.iceOff ? ice.iceOff.getMonth() + ice.iceOff.getDate() / 31 : null, iceOnM = ice?.iceOn ? ice.iceOn.getMonth() + ice.iceOn.getDate() / 31 : null;
  // Summer thermocline top: ~10–15 ft in a pond, ~15–25 ft in a mid-size lake, ~25–40 ft in a big one, sinking through the summer.
  const tTop = !acres ? 15 : acres < 100 ? 10 : acres < 2000 ? 15 : 25;
  const out = [];
  for (let m = 0; m < 12; m++) {
    const mid = m + 0.5, row = { m, strat: null, thermo: null, oxygen: null, clarity: null, mine: {} };
    const iced = ice && ice.state !== 'never' && iceOffM != null && (mid < iceOffM || mid > iceOnM);
    if (river) { row.strat = 'Flowing: mixed'; row.oxygen = 'Fine where it riffles; low in warm, slow pools in late summer'; }
    else if (iced) { row.strat = 'Iced'; row.oxygen = productive ? 'Can run low under long ice near the bottom' : null; }
    else if (depth && depth < 15) { row.strat = 'Mixed (shallow)'; row.oxygen = productive ? 'Can drop at dawn after hot, calm nights' : null; }
    else if (mid < stratStart - 0.5 || mid > stratEnd + 1.5) row.strat = 'Mixed';
    else if (mid < stratStart + 0.5) row.strat = 'Layering starts';
    else if (mid <= stratEnd) {
      row.strat = 'Layered';
      const late = (mid - stratStart) / Math.max(1, stratEnd - stratStart);
      const top = Math.round(tTop + late * 10), bottom = top + (acres > 2000 ? 20 : 12);
      row.thermo = depth && depth < top + 5 ? 'none lasting' : `about ${top}–${bottom} ft`;
      if (productive) row.oxygen = late > 0.4 ? `Low below about ${top + 5} ft: fish above the thermocline` : 'Fine for now; drops below the thermocline as summer goes on';
    } else row.strat = 'Turnover: mixing';
    if (!row.oxygen && row.strat === 'Turnover: mixing') row.oxygen = 'Stirred top to bottom; fishing can be off for a few days';
    if (!river && !iced && !productive && row.strat === 'Layered') row.oxygen = 'Usually fine deep in a clear lake';
    row.clarity = !river && (iced ? null : mid >= Math.max(stratStart - 0.5, iceOffM ?? 0) && mid < (iceOffM ?? stratStart) + 1.5 && e > 4000) ? 'Snowmelt can stain it' : null;
    const s = studied?.months?.[m];
    if (s) { if (s.secchiFt) row.clarity = `${s.secchiFt} ft Secchi`; if (s.strat) row.strat = s.strat; if (s.thermo !== undefined && s.thermo !== null) row.thermo = s.thermo; else if (s.thermo === null) row.thermo = null; row.studied = true; }
    out.push(row);
  }
  // Yours, by month across years.
  const thermoOf = readings => {
    const r = [...readings].sort((a, b) => a[0] - b[0]);
    let best = null;
    for (let i = 0; i < r.length - 1; i++) { const d = r[i + 1][0] - r[i][0], rate = d > 0 ? (r[i][1] - r[i + 1][1]) / d : 0; if (rate >= 0.55 && (!best || rate > best.rate)) best = { top: r[i][0], bottom: r[i + 1][0], rate }; }
    return best;
  };
  for (const p of profiles) {
    const m = +String(p.date).slice(5, 7) - 1;
    if (!(m >= 0 && m < 12) || !p.readings?.length) continue;
    const t = thermoOf(p.readings), rec = out[m].mine;
    (rec.thermo ??= []).push(t ? `${t.top}–${t.bottom} ft` : 'mixed');
    (rec.surface ??= []).push(+[...p.readings].sort((a, b) => a[0] - b[0])[0][1]);
  }
  for (const c of catches) {
    const m = new Date(c.time).getMonth();
    if (!(m >= 0)) continue;
    const rec = out[m].mine;
    if (Number.isFinite(+c.waterTemp) && c.waterTemp !== null && c.waterTemp !== '') (rec.surface ??= []).push(+c.waterTemp);
    if (CLARITY.includes(c.clarity)) (rec.clarity ??= []).push(c.clarity);
    (rec.depths ??= []).push(...(Number.isFinite(+c.depth) && c.depth !== null && c.depth !== '' ? [+c.depth] : []));
    rec.fish = (rec.fish ?? 0) + (+c.count || 1);
  }
  for (const r of out) {
    const x = r.mine, mode = a => a?.length ? [...a.reduce((m, v) => m.set(v, (m.get(v) ?? 0) + 1), new Map())].sort((a, b) => b[1] - a[1])[0][0] : null;
    r.yours = {
      surface: x.surface?.length ? `${Math.round(Math.min(...x.surface))}${x.surface.length > 1 && Math.max(...x.surface) - Math.min(...x.surface) >= 1 ? `–${Math.round(Math.max(...x.surface))}` : ''}°F` : null,
      thermo: mode(x.thermo), clarity: mode(x.clarity), fish: x.fish ?? 0,
      depth: x.depths?.length ? (() => { const d = [...x.depths].sort((a, b) => a - b); const a = d[Math.floor(d.length * 0.25)], b = d[Math.floor(d.length * 0.75)]; return a === b ? `${a} ft` : `${a}–${b} ft`; })() : null,
    };
  }
  return { rows: out, studied, productive, e };
}

// What the Ice notes card offers.
export const ICE_STATES = { iced: ['🧊', 'Iced over'], partial: ['🌗', 'Ice going out'], open: ['🌊', 'Open water'] };
export const iceLogsFor = lakeId => db.byLake('iceLogs', lakeId);
export const allIceLogs = () => db.all('iceLogs');
export const logIce = (lakeId, state, date = localKey()) => db.put('iceLogs', { lakeId, state, date });
export const thisMonth = () => new Date().getMonth();
export { addDays };
