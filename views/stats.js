// The Stats view: patterns across everything you've logged.
import { db } from '../db.js';
import { $, esc, onShow } from '../ui.js';

export async function renderStats() {
  const [catches, lakes] = await Promise.all([db.all('catches'), db.all('lakes')]);
  const el = $('#stats');
  if (!catches.length) { el.innerHTML = '<div class="card muted">Log some catches to see patterns.</div>'; return; }
  const count = (arr, key) => Object.entries(arr.reduce((m, c) => { const k = key(c); if (k != null && k !== '') m[k] = (m[k] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]);
  const bars = (title, rows) => { const max = Math.max(...rows.map(r => r[1])); return `<div class="card"><h3>${title}</h3><div class="bars">${rows.slice(0, 10).map(([k, v]) => `<div class="barrow"><span class="lbl">${esc(k)}</span><div class="fill" style="width:${v / max * 60}%"></div><span>${v}</span></div>`).join('')}</div></div>`; };
  const lakeName = Object.fromEntries(lakes.map(l => [l.id, l.name]));
  const biggest = [...catches].filter(c => c.length).sort((a, b) => b.length - a.length)[0];
  el.innerHTML = `<div class="card grid">
      <div class="stat"><b>${catches.length}</b><span>Fish logged</span></div>
      <div class="stat"><b>${new Set(catches.map(c => c.species)).size}</b><span>Species</span></div>
      <div class="stat"><b>${biggest ? biggest.length + '"' : '–'}</b><span>Longest${biggest ? ' · ' + esc(biggest.species) : ''}</span></div>
      <div class="stat"><b>${Math.round(catches.filter(c => c.released).length / catches.length * 100)}%</b><span>Released</span></div>
    </div>
    ${bars('By species', count(catches, c => c.species))}
    ${bars('By lake', count(catches, c => lakeName[c.lakeId]))}
    ${bars('Best lures', count(catches, c => c.lure))}
    ${bars('Hour of day', count(catches, c => new Date(c.time).getHours()).sort((a, b) => a[0] - b[0]).map(([h, v]) => [`${h}:00`, v]))}
    ${bars('Pressure trend', count(catches, c => c.conditions?.pressureTrend))}
    ${bars('Moon phase', count(catches, c => c.moon))}
    ${bars('Depth (ft)', count(catches, c => c.depth == null ? null : `${Math.floor(c.depth / 5) * 5}–${Math.floor(c.depth / 5) * 5 + 5}`))}`;
}

onShow('stats', renderStats);
