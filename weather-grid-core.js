// The weather filter's arithmetic, free of the app so it can be tested on its own: the squares forecasts are asked
// for, how a day is graded, which squares to ask for, and reading the service's answer for several places.

// Forecasts are asked for per square of a tenth of a degree (about 7 by 5 miles), named by its center, so one request
// covers every water in it and no request carries a water's exact spot.
const tenth = v => { const r = Math.round(v * 10) / 10; return r === 0 ? 0 : r; };
export function cellOf(lat, lon) {
  const a = tenth(lat), b = tenth(lon);
  return { id: `${a.toFixed(1)},${b.toFixed(1)}`, lat: a, lon: b };
}

// A day is as good as its longest run of hours rated good for your craft (boat-weather.js rateHour): six or more is
// a good day, three to five a fair one. Today only the daylight still left is rated, so late in the day fewer hours
// are asked for: all that's left being good is a good rest of the day.
export function longestGood(hours) {
  let best = 0, run = 0;
  for (const h of hours) { run = h.tone === 'good' ? run + 1 : 0; if (run > best) best = run; }
  return best;
}
export const gradeOf = hours => { const n = longestGood(hours), left = hours.length; return left && n >= Math.min(6, left) ? 'good' : left && n >= Math.min(3, left) ? 'fair' : 'poor'; };
// A water with no forecast (grade null) is kept: the filter hides what it knows to be poor.
export const wxPass = (grade, want) => !want || grade == null || grade === 'good' || (want === 'fair' && grade === 'fair');

// The squares to ask for: each square of `points` once, nearest `ref` first (as given when there's no reference
// point), leaving out the ones already in hand, and no more than `cap`. `beyond`: how many were cut by the cap.
export function pickCells(points, ref, cap, have) {
  const seen = new Map();
  for (const p of points) { const c = cellOf(p.lat, p.lon); if (!have.has(c.id) && !seen.has(c.id)) seen.set(c.id, c); }
  const all = [...seen.values()];
  if (ref) { const far = c => (c.lat - ref.lat) ** 2 + ((c.lon - ref.lon) * Math.cos(ref.lat * Math.PI / 180)) ** 2; all.sort((a, b) => far(a) - far(b)); }
  return { cells: all.slice(0, cap), beyond: Math.max(0, all.length - cap) };
}

// Open-Meteo answers several places with a list, one forecast per place in the order asked, and one place with a
// single forecast. Anything else (an error body, a short list) is null: the caller asks place by place instead.
export function readMulti(json, n) {
  const list = Array.isArray(json) ? json : n === 1 && json ? [json] : null;
  return list?.length === n && list.every(w => Array.isArray(w?.hourly?.time) && Array.isArray(w?.daily?.time)) ? list : null;
}
