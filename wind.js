// Wind on the water: which bank the wind is blowing toward, drawn as a small compass card. No network.
import { compass } from './data-sources.js';
import { fmtTime } from './ui.js';
import { hourIndex } from './forecast.js';

const BANK = { N: 'north', NNE: 'north-northeast', NE: 'northeast', ENE: 'east-northeast', E: 'east', ESE: 'east-southeast', SE: 'southeast', SSE: 'south-southeast',
  S: 'south', SSW: 'south-southwest', SW: 'southwest', WSW: 'west-southwest', W: 'west', WNW: 'west-northwest', NW: 'northwest', NNW: 'north-northwest' };

// Wind direction is where it blows FROM; it piles water, warmth and bait onto the opposite (downwind) bank.
export const downwind = from => (from + 180) % 360;
export const bankName = deg => BANK[compass(deg)];
const angleDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

// Summary for a forecast at time t: speed, banks, and the next big shift in the coming 12 hours.
export function windOnWater(w, t = Date.now()) {
  const h = w.hourly, i = hourIndex(w, t);
  const speed = w.current?.wind_speed_10m ?? h.wind_speed_10m[i], from = w.current?.wind_direction_10m ?? h.wind_direction_10m[i];
  const gusts = w.current?.wind_gusts_10m ?? h.wind_gusts_10m[i];
  let shift = null;
  for (let j = i + 1; j < Math.min(h.time.length, i + 13); j++) {
    if (h.wind_speed_10m[j] >= 5 && (speed < 3 || angleDiff(h.wind_direction_10m[j], from) >= 60)) { shift = { time: h.time[j], from: h.wind_direction_10m[j], speed: h.wind_speed_10m[j] }; break; }
  }
  return { speed, gusts, from, to: downwind(from), calm: speed < 3, shift };
}

export function windText(x) {
  const lines = x.calm
    ? [`Calm (${Math.round(x.speed)} mph): no wind-blown bank right now. Glassy water favours topwater and finesse.`]
    : [`Wind from the ${compass(x.from)} at ${Math.round(x.speed)} mph (gusts ${Math.round(x.gusts)}) is pushing into the <b>${bankName(x.to)} bank</b>.`,
      `Wind-blown banks collect warm surface water, plankton and baitfish, and predators follow; the ${bankName(x.from)} bank stays calmer for launching and finesse fishing.`];
  if (x.speed >= 15) lines.push('Strong wind: whitecaps on big open water, so small boats and kayaks should stay in the lee.');
  if (x.shift) lines.push(`Turning ${compass(x.shift.from)} at ${Math.round(x.shift.speed)} mph around ${fmtTime(x.shift.time)}, which moves the action to the ${bankName(downwind(x.shift.from))} bank.`);
  return lines.map(l => `<p>${l}</p>`).join('');
}

// A lake seen from above: north up, the downwind shoreline highlighted, an arrow showing the wind across it.
export function windSvg(x, size = 120) {
  const c = size / 2, r = size * 0.34;
  const pt = (deg, rr) => [c + rr * Math.sin(deg * Math.PI / 180), c - rr * Math.cos(deg * Math.PI / 180)].map(v => +v.toFixed(1));
  const [ax, ay] = pt(x.to - 55, r), [bx, by] = pt(x.to + 55, r), [x1, y1] = pt(x.from, r * 0.75), [x2, y2] = pt(x.to, r * 0.6);
  const arc = x.calm ? '' : `<path d="M${ax},${ay} A${r},${r} 0 0 1 ${bx},${by}" fill="none" stroke="#f28c28" stroke-width="7" stroke-linecap="round"/>`;
  const arrow = x.calm ? '' : `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="currentColor" stroke-width="3" marker-end="url(#wh)"/>`;
  const label = (t, deg) => { const [px, py] = pt(deg, c - 7); return `<text x="${px}" y="${py + 4}" text-anchor="middle" font-size="11" fill="currentColor" opacity=".7">${t}</text>`; };
  return `<svg class="wind-svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="Wind toward the ${x.calm ? 'no' : bankName(x.to)} bank">
    <defs><marker id="wh" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="4" markerHeight="4" orient="auto"><path d="M0,0L10,5L0,10z" fill="currentColor"/></marker></defs>
    <circle cx="${c}" cy="${c}" r="${r}" fill="#5fb3d6" fill-opacity=".35" stroke="#5fb3d6" stroke-width="2"/>${arc}${arrow}
    ${label('N', 0)}${label('E', 90)}${label('S', 180)}${label('W', 270)}</svg>`;
}
