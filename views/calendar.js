// The Journal's calendar: a month at a time, each day shaded by how many fish you caught, with a mark for trips.
// Tap a day to list its trips, catches and notes underneath.
import { db } from '../db.js';
import { $, esc, fmtDate } from '../ui.js';
import { fmtLen } from '../units.js';
import { weightText } from './log.js';
import { openCatch } from './catch.js';
import { openTrip } from './trips.js';
import { openLake } from './lake.js';

let month = null; // first of the month shown, local time
let picked = null; // 'YYYY-MM-DD'

const two = n => String(n).padStart(2, '0');
const dayKey = iso => { const d = new Date(iso); return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`; };
const hm = iso => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

export async function renderCalendar(body) {
  const [catches, trips, notes, lakes] = await Promise.all([db.all('catches'), db.all('trips'), db.all('notes'), db.all('lakes')]);
  if (!body.isConnected) return;
  const lakeName = Object.fromEntries(lakes.map(l => [l.id, l.name]));
  const byDay = {};
  const add = (iso, k, x) => { if (typeof iso !== 'string') return; ((byDay[dayKey(iso)] ??= { c: [], t: [], n: [] })[k]).push(x); };
  for (const c of catches) add(c.time, 'c', c);
  for (const t of trips) add(t.start, 't', t);
  for (const n of notes) if (n.kind !== 'access' && typeof n.text === 'string') add(n.createdAt, 'n', n);
  // Start on the month of your newest catch or trip, else this month.
  if (!month) {
    const newest = Object.keys(byDay).sort().pop();
    const d = newest ? new Date(newest + 'T12:00') : new Date();
    month = new Date(d.getFullYear(), d.getMonth(), 1);
  }

  const draw = () => {
    const y = month.getFullYear(), m = month.getMonth();
    const days = new Date(y, m + 1, 0).getDate(), lead = new Date(y, m, 1).getDay();
    const keys = Array.from({ length: days }, (_, i) => `${y}-${two(m + 1)}-${two(i + 1)}`);
    const fish = keys.reduce((n, k) => n + (byDay[k]?.c.length ?? 0), 0), out = keys.filter(k => byDay[k]?.c.length || byDay[k]?.t.length).length;
    const top = Math.max(1, ...keys.map(k => byDay[k]?.c.length ?? 0));
    const today = dayKey(new Date().toISOString());
    const names = Array.from({ length: 7 }, (_, i) => new Date(2023, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'narrow' }));
    body.innerHTML = `<div class="cal-head"><button id="cal-prev" aria-label="Previous month">‹</button>
        <div><b>${month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</b>
          <div class="muted small">${fish} fish · ${out} day${out === 1 ? '' : 's'} out</div></div>
        <button id="cal-next" aria-label="Next month">›</button></div>
      <div class="card cal">${names.map(n => `<span class="cal-dow">${n}</span>`).join('')}${'<span></span>'.repeat(lead)}${keys.map((k, i) => {
        const d = byDay[k], n = d?.c.length ?? 0;
        // Shade: more fish, stronger color (a quarter of the way at one fish).
        const shade = n ? 0.25 + 0.75 * (n / top) : 0;
        return `<button class="cal-day${k === today ? ' today' : ''}${k === picked ? ' picked' : ''}${n ? ' fish' : ''}${shade > 0.6 ? ' hi' : ''}" data-day="${k}" style="--s:${shade.toFixed(2)}" ${d ? '' : 'aria-disabled="true"'}>
          <span>${i + 1}</span>${n ? `<b>${n}</b>` : ''}${d?.t.length ? '<i class="cal-trip" title="Trip"></i>' : d?.n.length ? '<i class="cal-note" title="Note"></i>' : ''}</button>`;
      }).join('')}</div>
      <div class="muted small cal-key">Number = fish caught · <i class="cal-trip"></i> trip · <i class="cal-note"></i> note</div>
      <div id="cal-list"></div>`;
    $('#cal-prev', body).onclick = () => { month = new Date(y, m - 1, 1); draw(); };
    $('#cal-next', body).onclick = () => { month = new Date(y, m + 1, 1); draw(); };
    body.querySelectorAll('[data-day]').forEach(b => b.onclick = () => { picked = picked === b.dataset.day ? null : b.dataset.day; draw(); });
    drawDay();
  };

  const drawDay = () => {
    const box = $('#cal-list', body), d = picked && byDay[picked];
    if (!picked || !picked.startsWith(`${month.getFullYear()}-${two(month.getMonth() + 1)}`)) { box.innerHTML = ''; return; }
    if (!d) { box.innerHTML = `<h2>${fmtDate(picked)}</h2><div class="card muted small">Nothing logged this day.</div>`; return; }
    const cs = [...d.c].sort((a, b) => a.time.localeCompare(b.time));
    box.innerHTML = `<h2>${fmtDate(picked)}</h2>
      ${d.t.map(t => `<div class="card tl-trip" data-trip="${esc(t.id)}"><b>🎣 ${esc(lakeName[t.lakeId] ?? 'Trip')}</b>
        <div class="muted small">${hm(t.start)}${t.end ? `–${hm(t.end)}` : ' · in progress'}${t.rating ? ` · ${'★'.repeat(t.rating)}` : ''}</div>
        ${t.journal ? `<div class="small tl-text">${esc(t.journal)}</div>` : ''}</div>`).join('')}
      ${cs.map(c => `<div class="tl-row" data-catch="${esc(c.id)}">🐟 <b>${esc(c.species)}</b> ${fmtLen(c.length)} ${weightText(c)} <span class="muted small">${esc(lakeName[c.lakeId] ?? '')} · ${hm(c.time)}${c.lure ? ` · ${esc(c.lure)}` : ''}</span>${c.photo ? ' <span class="ph-dot">📷</span>' : ''}</div>`).join('')}
      ${d.n.map(n => `<div class="tl-row" data-note="${esc(n.lakeId)}">📝 <span class="small">${esc(n.text.slice(0, 140))}${n.text.length > 140 ? '…' : ''}</span> <span class="muted small">${esc(lakeName[n.lakeId] ?? '')}</span></div>`).join('')}`;
    box.querySelectorAll('[data-trip]').forEach(e => e.onclick = () => openTrip(e.dataset.trip));
    box.querySelectorAll('[data-catch]').forEach(e => e.onclick = () => openCatch(e.dataset.catch, cs.map(c => c.id)));
    box.querySelectorAll('[data-note]').forEach(e => e.onclick = () => openLake(e.dataset.note, 'notes'));
  };
  draw();
}
