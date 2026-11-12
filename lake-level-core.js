// Is a lake rising, steady or falling? From the change its gauge saw over the last week. Kept free of the app so it
// can be tested on its own (lake-level.js reads the gauges).

// `ft`: change in the water's elevation over a week; `pct`: change in stored water, for a gauge that reports no
// elevation. Half a foot (or one percent) either way is steady. Neither known: no trend.
export function trendOf({ ft, pct } = {}) {
  const [v, edge] = Number.isFinite(ft) ? [ft, 0.5] : Number.isFinite(pct) ? [pct, 1] : [null];
  return v == null ? null : v >= edge ? 'rising' : v <= -edge ? 'falling' : 'steady';
}

// The line a card shows: "Lake level rising: +1.2 ft in a week (gauge: SHASTA)".
export function levelText({ trend, ft, pct, gauge }) {
  const by = trend === 'steady' ? '' : Number.isFinite(ft) ? `: ${ft > 0 ? '+' : ''}${ft.toFixed(1)} ft in a week` : `: ${Math.abs(Math.round(pct))}% ${pct > 0 ? 'more' : 'less'} water in a week`;
  return `Lake level ${trend}${by} (gauge: ${gauge})`;
}
