// The rows of the map's results drawer: the waters that are showing, nearest first (or best bet first), cut to a
// length a phone can scroll. Kept free of the app so it can be tested on its own.
import { kmBetween } from './water-filter-core.js';

// `pins` have name, lat, lon; `ref` is where distance is measured from (null: none, rows go by name). `score(e)` gives
// a water's best-bet score or null. `total` counts every water, `rows` holds the first `limit`.
export function rankRows(pins, ref, { limit = 100, sort = 'near', score } = {}) {
  const all = pins.map(e => ({ e, km: ref ? kmBetween(ref, e) : null, ...(score ? { score: score(e) ?? null } : {}) }));
  const near = (a, b) => (a.km ?? 0) - (b.km ?? 0) || String(a.e.name).localeCompare(String(b.e.name));
  all.sort(sort === 'bet' && score ? (a, b) => (b.score ?? -1) - (a.score ?? -1) || near(a, b) : near);
  return { rows: all.slice(0, limit), total: all.length };
}
