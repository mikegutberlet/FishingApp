// Personal bests and the species life list, overall and per water.
import { db } from '../db.js';
import { esc, fmtDate } from '../ui.js';
import { fmtLen } from '../units.js';
import { editCatch, weightText, weightEstimate } from './log.js';

// Per species: count, first catch, longest, heaviest (logged weight, else the length estimate).
export function bestsBySpecies(catches) {
  const by = new Map();
  for (const c of [...catches].sort((a, b) => a.time.localeCompare(b.time))) {
    const key = c.species?.trim();
    if (!key) continue;
    const s = by.get(key.toLowerCase()) ?? { species: key, count: 0, first: c, longest: null, heaviest: null };
    s.count++;
    if (c.length && (!s.longest || c.length > s.longest.length)) s.longest = c;
    const w = c.weight ?? weightEstimate(c);
    if (w && (!s.heaviest || w > (s.heaviest.weight ?? weightEstimate(s.heaviest)))) s.heaviest = c;
    by.set(key.toLowerCase(), s);
  }
  return [...by.values()].sort((a, b) => b.count - a.count || a.species.localeCompare(b.species));
}

const link = (c, text) => `<a href="#" data-catch="${c.id}">${text}</a>`;

function table(rows, lakeName, { first = true } = {}) {
  return `<table><tr><th>Species</th><th>Fish</th><th>Longest</th><th>Heaviest</th>${first ? '<th>First caught</th>' : ''}</tr>
    ${rows.map(s => `<tr><td>${esc(s.species)}</td><td>${s.count}</td><td>${s.longest ? link(s.longest, fmtLen(s.longest.length)) : '–'}</td>
      <td>${s.heaviest ? link(s.heaviest, weightText(s.heaviest)) : '–'}</td>${first ? `<td class="small">${fmtDate(s.first.time)}<div class="muted">${esc(lakeName[s.first.lakeId] ?? '')}</div></td>` : ''}</tr>`).join('')}</table>`;
}

const wire = el => el.querySelectorAll('[data-catch]').forEach(a => a.onclick = e => { e.preventDefault(); editCatch(a.dataset.catch); });

export async function renderBests(el) {
  const [catches, lakes] = await Promise.all([db.all('catches'), db.all('lakes')]);
  if (!catches.length) { el.innerHTML = '<div class="card muted">Your life list and personal bests fill in as you log catches.</div>'; return; }
  const lakeName = Object.fromEntries(lakes.map(l => [l.id, l.name]));
  const species = bestsBySpecies(catches);
  const waters = lakes.map(l => ({ l, rows: bestsBySpecies(catches.filter(c => c.lakeId === l.id)) })).filter(x => x.rows.length).sort((a, b) => b.rows.length - a.rows.length);
  el.innerHTML = `<div class="card"><h3>Life list: ${species.length} species</h3>${table(species, lakeName)}
      <p class="muted small">≈ is an estimate from length (standard-weight formulas for that species) when no weight was logged.</p></div>
    <h2>Bests by water</h2>
    ${waters.map(({ l, rows }) => `<div class="card"><h3>${esc(l.name)} · ${rows.length} species</h3>${table(rows, lakeName, { first: false })}</div>`).join('')}`;
  wire(el);
}

// A compact bests table for one water's Catches tab.
export function renderLakeBests(catches, el) {
  const rows = bestsBySpecies(catches);
  el.innerHTML = rows.length ? `<details class="card"><summary><b>Personal bests here</b> · ${rows.length} species</summary>${table(rows, {}, { first: false })}</details>` : '';
  wire(el);
}
