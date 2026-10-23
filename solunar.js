// Bite windows (solunar periods), computed on the device from the moon's position. No network.
// Major periods: 2 hours centred on moon transit (overhead) and underfoot. Minor periods: 1 hour centred on moonrise and moonset.
// Days run midnight to midnight in the device's time zone, like the forecast times.
import { moonPhase } from './data-sources.js';

const rad = Math.PI / 180, J2000 = Date.UTC(2000, 0, 1, 12), HOUR = 3600e3;
const H0 = 0.125 * rad; // moonrise/set altitude: parallax minus refraction and semi-diameter

// Low-precision lunar position (good to a few minutes for rise/transit times).
function moon(t, lat, lon) {
  const d = (t - J2000) / 864e5;
  const L = rad * (218.316 + 13.176396 * d), M = rad * (134.963 + 13.064993 * d), F = rad * (93.272 + 13.229350 * d);
  const D = rad * (297.850 + 12.190749 * d), Ms = rad * (357.529 + 0.98560028 * d); // elongation, sun's anomaly
  const l = L + rad * (6.289 * Math.sin(M) + 1.274 * Math.sin(2 * D - M) + 0.658 * Math.sin(2 * D) + 0.214 * Math.sin(2 * M) - 0.186 * Math.sin(Ms) - 0.114 * Math.sin(2 * F));
  const b = rad * (5.128 * Math.sin(F) + 0.281 * Math.sin(M + F) + 0.278 * Math.sin(M - F) + 0.173 * Math.sin(2 * D - F)), e = rad * 23.4397;
  const ra = Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l));
  const dec = Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l));
  const H = rad * (280.16 + 360.9856235 * d) + lon * rad - ra;
  const phi = lat * rad;
  return { H: Math.atan2(Math.sin(H), Math.cos(H)), alt: Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H)) };
}

const startOfDay = date => { const d = new Date(date); d.setHours(0, 0, 0, 0); return d.getTime(); };

// Moon events and bite windows for the local day containing `date`.
export function solunar(date, lat, lon) {
  const t0 = startOfDay(date), t1 = t0 + 24 * HOUR, step = 10 * 60e3;
  const events = [];
  let prev = moon(t0, lat, lon);
  for (let t = t0 + step; t <= t1; t += step) {
    const cur = moon(t, lat, lon);
    const at = (a, b) => t - step + step * a / (a - b); // linear crossing time
    if ((prev.alt - H0) * (cur.alt - H0) < 0) events.push({ kind: cur.alt > prev.alt ? 'rise' : 'set', t: at(prev.alt - H0, cur.alt - H0) });
    if (prev.H < 0 && cur.H >= 0 && cur.H - prev.H < Math.PI) events.push({ kind: 'transit', t: at(prev.H, cur.H) });
    if (prev.H > Math.PI / 2 && cur.H < -Math.PI / 2) events.push({ kind: 'underfoot', t: at(prev.H - Math.PI, cur.H + Math.PI) });
    prev = cur;
  }
  const win = (e, half, type) => ({ type, kind: e.kind, peak: e.t, start: e.t - half, end: e.t + half });
  const majors = events.filter(e => e.kind === 'transit' || e.kind === 'underfoot').map(e => win(e, HOUR, 'major'));
  const minors = events.filter(e => e.kind === 'rise' || e.kind === 'set').map(e => win(e, HOUR / 2, 'minor'));
  const windows = [...majors, ...minors].sort((a, b) => a.start - b.start);
  const find = k => events.find(e => e.kind === k)?.t ?? null;
  return { day: t0, windows, majors, minors, moonrise: find('rise'), moonset: find('set'), transit: find('transit'), underfoot: find('underfoot'), phase: moonPhase(new Date(t0 + 12 * HOUR)) };
}

// 0–4 rating for a day: strongest near new and full moon, and when a window lines up with sunrise or sunset.
export function dayRating(sol, sunrise, sunset) {
  const daysFromNewOrFull = Math.min(sol.phase.fraction, Math.abs(sol.phase.fraction - 0.5), 1 - sol.phase.fraction) * 29.53;
  let r = daysFromNewOrFull <= 1.5 ? 2 : daysFromNewOrFull <= 3.5 ? 1 : 0;
  const light = [sunrise, sunset].filter(Boolean).map(s => typeof s === 'number' ? s : Date.parse(s));
  r += Math.min(2, sol.windows.filter(w => light.some(s => w.start - HOUR <= s && s <= w.end + HOUR)).length);
  return Math.min(4, r);
}

export const stars = n => '★'.repeat(n) + '☆'.repeat(4 - n);

// The bite window (if any) overlapping [from, to): majors win over minors.
export function windowAt(sol, from, to = from + HOUR) {
  const hits = sol.windows.filter(w => w.start < to && w.end > from);
  return hits.find(w => w.type === 'major') ?? hits[0] ?? null;
}

// The current or next bite window from `now`, looking into tomorrow if today's are over.
export function nextWindow(lat, lon, now = Date.now()) {
  for (let d = 0; d < 2; d++) {
    const w = solunar(new Date(now + d * 24 * HOUR), lat, lon).windows.find(w => w.end > now);
    if (w) return w;
  }
  return null;
}

const KIND = { transit: 'moon overhead', underfoot: 'moon underfoot', rise: 'moonrise', set: 'moonset' };
export const windowLabel = w => `${w.type === 'major' ? 'Major' : 'Minor'} (${KIND[w.kind]})`;
export const shortTime = t => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).replace(/\s?([AP])M$/i, (_, a) => a.toLowerCase());
export const windowSpan = w => `${shortTime(w.start)}–${shortTime(w.end)}`;
