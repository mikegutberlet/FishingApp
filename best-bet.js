// A best-bet score from 1 to 10 for a water on the picked day, for the map's pins, the results drawer, the list and
// the compare sheet. It is the trip planner's own score (views/planner.js scoreDay: wind, rain, temperature, pressure
// trend, bite windows, recent plants, lake level), fed the forecast for the water's square (weather-grid.js), so the
// two never disagree about what makes a good day.
import { scoreDay } from './views/planner.js';
import { stockFor, entryFor } from './water-facts.js';
import { forecastFor, gradeWater, dateFor } from './weather-grid.js';

// `e` is a pool entry (water-facts.js), `w` its square's forecast. null when there is no forecast for that day, or it
// was saved before the score existed (no pressure or daily wind in it). `why`: the two things that moved the score most.
export async function betFor(e, w, date) {
  if (!w?.hourly?.pressure_msl || !w.daily?.wind_speed_10m_max) return null;
  const S = e.S, src = e.w ?? e.stock ?? {}, stock = S ? await stockFor(e).catch(() => null) : null;
  const lake = { name: e.name, lat: e.lat, lon: e.lon, acres: src.acres ?? e.saved?.acres ?? null, state: S?.code, cdecStation: e.saved?.cdecStation, ...(stock ? { [S.stockField]: stock.id } : {}) };
  const r = await scoreDay(lake, w, date).catch(() => null);
  if (!r || !Number.isFinite(r.score)) return null;
  return { score: Math.max(1, Math.round(r.score)), why: r.reasons.filter(x => x.tone !== 'ok').slice(0, 2).map(x => x.text.split(':')[0]).join(' · ') };
}
export const betText = b => `Best bet ${b.score} of 10${b.why ? `: ${b.why}` : ''}`;

// For one water's card or compare column: the picked day's weather line, and its score when scores are on.
export async function dayLines(lake, P) {
  const w = await forecastFor(lake);
  const e = P.score && w ? await entryFor(lake).catch(() => null) ?? { name: lake.name, lat: lake.lat, lon: lake.lon, S: null, w: lake } : null;
  return { line: gradeWater(w, lake, P)?.line ?? null, bet: e ? await betFor(e, w, dateFor(P)) : null };
}
