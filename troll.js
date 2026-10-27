// Troll and drift readout for trip mode: your speed and heading in big numbers from the GPS, and the speed saved on
// each fish you log while it's on. Everything is worked out on the phone from the fixes trip mode already gets.
import { compass, haversineKm } from './data-sources.js';
import { units } from './units.js';

const KEY = 'tb-troll';
const WINDOW_MS = 12e3; // speed and heading are smoothed over the last ~12 s of fixes
let fixes = []; // [{ lat, lon, t, speed (m/s) | null, heading | null }]
let listeners = new Set();

export const trollOn = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };
export const setTroll = on => { try { localStorage.setItem(KEY, on ? '1' : '0'); } catch {} };

// trips.js passes every GPS fix here.
export function feedFix(p) {
  const { latitude: lat, longitude: lon, accuracy, speed, heading } = p.coords;
  if (accuracy > 30) return; // too rough to tell 1.5 from 2.5 mph
  fixes.push({ lat, lon, t: p.timestamp, speed: Number.isFinite(speed) ? speed : null, heading: Number.isFinite(heading) ? heading : null });
  fixes = fixes.filter(f => p.timestamp - f.t <= WINDOW_MS * 2);
  for (const fn of listeners) fn(reading());
}
export const onReading = fn => { listeners.add(fn); return () => listeners.delete(fn); };
export const resetReadout = () => { fixes = []; };

const bearing = (a, b) => {
  const r = Math.PI / 180, y = Math.sin((b.lon - a.lon) * r) * Math.cos(b.lat * r);
  const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lon - a.lon) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
};

// Current speed (mph) and heading (degrees), or null when the GPS hasn't said enough yet.
export function reading(now = fixes.at(-1)?.t ?? Date.now()) {
  const recent = fixes.filter(f => now - f.t <= WINDOW_MS);
  if (!recent.length || now - recent.at(-1).t > 20e3) return null;
  const first = recent[0], last = recent.at(-1), secs = (last.t - first.t) / 1000;
  // Distance over the window is steadier than the chip's instant speed at trolling pace; use the chip's when the window is short.
  const viaTrack = secs >= 4 ? haversineKm(first.lat, first.lon, last.lat, last.lon) * 1000 / secs : null;
  const chip = recent.map(f => f.speed).filter(v => v != null);
  const ms = viaTrack ?? (chip.length ? chip.reduce((s, v) => s + v, 0) / chip.length : null);
  if (ms == null) return null;
  const mph = ms * 2.236936;
  const moved = haversineKm(first.lat, first.lon, last.lat, last.lon) * 1000;
  const heading = moved >= 5 ? bearing(first, last) : last.heading;
  return { mph: +mph.toFixed(1), heading: heading == null || mph < 0.3 ? null : Math.round(heading) };
}

// Speed in the units you use: km/h when you've picked metres, else mph.
export const fmtSpeed = mph => mph == null ? '–' : units().depth === 'm' ? `${(mph * 1.609344).toFixed(1)} km/h` : `${mph.toFixed(1)} mph`;
export const fmtHeading = deg => deg == null ? '' : `${compass(deg)} ${deg}°`;

// What to save on a catch or bite: the readout at that moment, only while it's switched on.
export function snapshot() {
  if (!trollOn()) return {};
  const r = reading();
  return r ? { trollMph: r.mph, heading: r.heading } : {};
}

// The big panel. Returns a function that stops updating it.
export function mountReadout(el) {
  const draw = r => {
    if (!el.isConnected) return stop();
    el.innerHTML = `<div class="troll-big"><b>${r ? fmtSpeed(r.mph).replace(/ (mph|km\/h)$/, '') : '–'}</b><span>${units().depth === 'm' ? 'km/h' : 'mph'}</span></div>
      <div class="troll-big"><b>${r?.heading != null ? compass(r.heading) : r ? '·' : '–'}</b><span>${r?.heading != null ? `${r.heading}°` : r ? (r.mph < 0.3 ? 'holding still' : 'heading') : 'waiting for GPS'}</span></div>
      <div class="troll-note small muted">${r ? (r.mph < 0.3 ? 'Still' : r.mph < 1 ? 'Drifting' : 'Trolling') + ': each fish and bite you log saves this speed.' : 'Needs a GPS fix within 30 m.'}</div>`;
  };
  const stop = onReading(draw);
  draw(reading());
  return stop;
}

// "Fish came at 1.6–2.1 mph" for the trip summary, from catches that saved a speed.
export function speedSummary(catches) {
  const v = catches.map(c => c.trollMph).filter(x => Number.isFinite(x) && x >= 0.3).sort((a, b) => a - b);
  if (!v.length) return '';
  return v.length === 1 || v[0] === v.at(-1) ? `at ${fmtSpeed(v[0])}` : `at ${fmtSpeed(v[0]).replace(/ \S+$/, '')}–${fmtSpeed(v.at(-1))}`;
}
