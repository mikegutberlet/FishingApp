// A water's lake level trend for the map's card, the compare sheet and the "Lake level" filter: rising, steady or
// falling over the last week, from the gauge the lake's own page uses (states/index.js reservoirFor). The gauge
// readings are in the data already on the phone, so this works with no signal. Kept per water for the session.
import { reservoirFor } from './states/index.js';
import { levelChange } from './forecast.js';
import { isStreamType } from './water-filter-core.js';
import { trendOf, levelText } from './lake-level-core.js';

const kept = new Map();
// `e` is a pool entry (water-facts.js). null for a stream, a water with no gauge, or a gauge whose last reading is
// more than four days old (a stopped feed is not a trend).
export function levelFor(e) {
  const key = `${e.key}|${e.saved?.cdecStation ?? ''}`;
  if (!kept.has(key)) kept.set(key, (async () => {
    if (!e.S || isStreamType(e.type)) return null;
    const w = e.w ?? e.stock ?? {};
    const res = await reservoirFor({ name: e.name, lat: e.lat, lon: e.lon, acres: w.acres ?? e.saved?.acres ?? null, state: e.S.code, cdecStation: e.saved?.cdecStation });
    // The lake's own page shows the nearest gauge and lets you correct it. Here nobody is looking at the gauge's name
    // before the filter acts on it, so only a gauge named for the water (or the one you pinned) counts.
    if (!res || !(res.named || (e.saved?.cdecStation && String(res.id).toUpperCase() === String(e.saved.cdecStation).toUpperCase()))) return null;
    const ft = levelChange(res.elevation, 7, 4), stored = levelChange(res.storage, 7, 4);
    const pct = stored != null && res.storage.at(-1)[1] - stored > 0 ? stored / (res.storage.at(-1)[1] - stored) * 100 : null;
    const trend = trendOf({ ft, pct });
    if (!trend) return null;
    const l = { trend, ft, pct, gauge: res.name };
    return { ...l, text: levelText(l) };
  })().catch(() => null));
  return kept.get(key);
}
