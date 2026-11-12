// The filter checks that need no lookups: distance, lake or stream, size, elevation, saved and ice. The list
// ("Where should I go?") and the map's pins both run them through water-filter.js; kept free of the app so they can
// be tested on their own.

// The one set of filter settings (kept on this phone). Everything off except a 50 mile range and hiding algae waters.
export const DEFAULTS = { fish: [], access: [], miles: 50, stocked: false, mine: false, noAlgae: true, sort: 'near', from: 'auto', saved: false, type: '', size: [], elev: [], level: [], iceFree: false, wx: '', day: 0 };
// Saved settings from any version of the app: known keys of the right kind, defaults for the rest.
export function clean(raw) {
  const out = {};
  for (const [k, d] of Object.entries(DEFAULTS)) {
    const v = raw?.[k];
    out[k] = Array.isArray(d) ? (Array.isArray(v) ? v : [...d]) : typeof v === typeof d ? v : d;
  }
  // Weather: good, or good or fair, for a day up to a week ahead (days from today).
  if (!['good', 'fair'].includes(out.wx)) out.wx = '';
  if (!(Number.isInteger(out.day) && out.day >= 0 && out.day <= 7)) out.day = 0;
  out.level = out.level.filter(t => ['rising', 'steady', 'falling'].includes(t)); // lake level over the last week (lake-level.js)
  return out;
}

export const sizeOf = acres => !(+acres > 0) ? null : +acres < 10 ? 'pond' : +acres <= 500 ? 'small' : 'big';
export const elevOf = ft => ft == null || ft === '' || !Number.isFinite(+ft) ? null : +ft < 4000 ? 'low' : +ft <= 7000 ? 'mid' : 'high';
export const isStreamType = type => /river|creek|stream|slough|canal/i.test(type ?? '');
export function kmBetween(a, b) {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

// One water against the settings. `e` = { lat, lon, type, acres, elevationFt, saved }; `ctx.from` is where distance is
// measured from (null: not applied) and `ctx.iced(e)` says whether the water is likely iced over today.
// A water with no acres or elevation on record can't pass a size or elevation filter: `unknown` says which.
export function quickPass(e, P, ctx) {
  if (P.miles && ctx.from && kmBetween(ctx.from, e) > P.miles * 1.609344) return { ok: false };
  if (P.type && (P.type === 'stream') !== isStreamType(e.type)) return { ok: false };
  if (P.saved && !e.saved) return { ok: false };
  if (P.size.length) { const s = sizeOf(e.acres); if (!s) return { ok: false, unknown: 'size' }; if (!P.size.includes(s)) return { ok: false }; }
  if (P.elev.length) { const b = elevOf(e.elevationFt); if (!b) return { ok: false, unknown: 'elev' }; if (!P.elev.includes(b)) return { ok: false }; }
  if (P.iceFree && ctx.iced(e)) return { ok: false };
  return { ok: true };
}

// The filters that are narrowing things, in the order the chips show them, and whether any needs the per-water lookups.
const ON = { fish: P => P.fish.length, access: P => P.access.length, miles: P => P.miles, stocked: P => P.stocked, mine: P => P.mine, saved: P => P.saved,
  noAlgae: P => P.noAlgae, type: P => P.type, size: P => P.size.length, elev: P => P.elev.length, level: P => P.level.length, iceFree: P => P.iceFree, wx: P => P.wx };
export const active = P => Object.keys(ON).filter(k => ON[k](P));
export const needsFacts = P => !!(P.fish.length || P.access.length || P.stocked || P.mine || P.noAlgae || P.level.length);
export const needsWeather = P => !!P.wx;
// The change that switches one filter back to "show everything" (the map's removable chips).
export const off = key => ({ [key]: Array.isArray(DEFAULTS[key]) ? [] : key === 'miles' ? 0 : typeof DEFAULTS[key] === 'string' ? '' : false });
