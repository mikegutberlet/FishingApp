// Lost lures: one tap in trip mode logs a snag or break-off (and takes one off what you have on hand), and the
// restock list in your tackle box gathers what you've lost and what has run out.
import { db } from './db.js';
import { $, esc, status } from './ui.js';
import { tackleLabel } from './views/tackle.js';

// Lures you're most likely to have tied on: the ones on this trip's catches, then your most used.
async function likely(t) {
  const [tackle, catches] = await Promise.all([db.all('tackle'), db.all('catches')]);
  const lures = tackle.filter(x => !/^(rod|reel|line)$/i.test(x.type ?? ''));
  const uses = id => catches.filter(c => c.tackleId === id).length + catches.filter(c => c.tackleId === id && c.tripId === t.id).length * 100;
  return lures.sort((a, b) => uses(b.id) - uses(a.id) || tackleLabel(a).localeCompare(tackleLabel(b))).slice(0, 8);
}

// The sheet under the quick buttons. done() redraws the trip page.
export async function lostLureSheet(t, sheet, pos, done) {
  const list = await likely(t);
  sheet.innerHTML = `<div class="card"><h3>🪝 Which lure did you lose?</h3>
    ${list.length ? `<div class="species-grid">${list.map(x => `<button data-lure="${esc(x.id)}">${esc(tackleLabel(x))}${x.qty != null ? `<small> · ${esc(x.qty)} left</small>` : ''}</button>`).join('')}</div>` : '<p class="small muted">Add lures to your tackle box (Journal → Tackle) to pick them here.</p>'}
    <form class="row" id="lure-other" style="margin-top:8px"><input name="lure" list="lure-list" placeholder="Other lure" style="flex:1;padding:12px;font:inherit"><button>Log</button></form>
    <button id="lure-cancel" style="width:100%;margin-top:8px">Cancel</button></div>`;
  const log = async (tackleId, lure) => {
    const item = tackleId && await db.get('tackle', tackleId);
    const ev = await db.put('events', { tripId: t.id, lakeId: t.lakeId, kind: 'lure', time: new Date().toISOString(), tackleId: item?.id ?? null, lure: item ? tackleLabel(item) : lure, restocked: false, ...pos });
    // One fewer on hand; Undo on the trip page gives it back.
    if (item && Number.isFinite(item.qty) && item.qty > 0) await db.put('tackle', { ...item, qty: item.qty - 1 });
    status(`Lost ${ev.lure}: added to your restock list`);
    done();
  };
  sheet.querySelectorAll('[data-lure]').forEach(b => b.onclick = () => log(b.dataset.lure));
  $('#lure-other', sheet).onsubmit = e => { e.preventDefault(); const v = e.target.lure.value.trim(); if (v) log(null, v); };
  $('#lure-cancel', sheet).onclick = () => { sheet.innerHTML = ''; };
  sheet.scrollIntoView({ block: 'nearest' });
}

// Undo from the trip log: the lure goes back in the box.
export async function undoLostLure(ev) {
  await db.del('events', ev.id);
  const item = ev.tackleId && await db.get('tackle', ev.tackleId);
  if (item && Number.isFinite(item.qty)) await db.put('tackle', { ...item, qty: item.qty + 1 });
}

// What to buy: lost lures not yet restocked (grouped), and tackle with none left.
export async function restockList() {
  const [events, tackle] = await Promise.all([db.all('events'), db.all('tackle')]);
  const byKey = new Map();
  for (const e of events.filter(e => e.kind === 'lure' && !e.restocked)) {
    const item = tackle.find(x => x.id === e.tackleId);
    const key = item ? `t:${item.id}` : `n:${String(e.lure ?? '').toLowerCase()}`;
    const row = byKey.get(key) ?? { key, label: item ? tackleLabel(item) : e.lure || 'Lure', item, lost: 0, events: [], last: e.time };
    row.lost++; row.events.push(e); if (e.time > row.last) row.last = e.time;
    byKey.set(key, row);
  }
  for (const item of tackle.filter(x => x.qty === 0 && !/^(rod|reel)$/i.test(x.type ?? ''))) {
    if (!byKey.has(`t:${item.id}`)) byKey.set(`t:${item.id}`, { key: `t:${item.id}`, label: tackleLabel(item), item, lost: 0, events: [], last: '' });
  }
  return [...byKey.values()].sort((a, b) => b.lost - a.lost || b.last.localeCompare(a.last));
}

export async function renderRestock(el) {
  const rows = await restockList();
  if (!el.isConnected) return;
  if (!rows.length) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="card restock"><h3>🛒 Restock list</h3>
    ${rows.map(r => `<div class="restock-row"><div style="flex:1"><b>${esc(r.label)}</b><div class="small muted">${r.lost ? `lost ${r.lost}` : ''}${r.lost && r.item?.qty === 0 ? ' · ' : ''}${r.item?.qty === 0 ? 'none left' : r.item?.qty != null ? ` · ${esc(r.item.qty)} left` : ''}</div></div>
      <form class="row" data-restock="${esc(r.key)}"><input name="n" type="number" min="0" step="1" inputmode="numeric" value="${Math.max(1, r.lost)}" aria-label="How many you bought" style="width:4.5em"><button>Bought</button></form></div>`).join('')}
    <button id="restock-copy" style="width:100%;margin-top:8px">Copy the list</button></div>`;
  el.querySelectorAll('[data-restock]').forEach(f => f.onsubmit = async e => {
    e.preventDefault();
    const r = rows.find(x => x.key === f.dataset.restock), n = Math.max(0, Math.round(+f.n.value || 0));
    for (const ev of r.events) await db.put('events', { ...ev, restocked: true });
    if (r.item) { const item = await db.get('tackle', r.item.id); if (item) await db.put('tackle', { ...item, qty: (Number.isFinite(item.qty) ? item.qty : 0) + n }); }
    status(`${r.label}: restocked`);
    el.dispatchEvent(new CustomEvent('restocked', { bubbles: true }));
  });
  $('#restock-copy', el).onclick = async () => {
    const text = `Tackle to restock:\n${rows.map(r => `- ${r.label}${r.lost > 1 ? ` ×${r.lost}` : ''}`).join('\n')}`;
    try { await navigator.clipboard.writeText(text); status('Restock list copied'); } catch { prompt('Copy the list:', text); }
  };
}
