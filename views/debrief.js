// After a trip: a quick debrief at the truck (what worked, a "next time" note that comes back the next time you fish
// this water), and a share card image of the day. The card shows only what you see on it: no map and no spots.
import { db } from '../db.js';
import { $, esc, fmtDate, status } from '../ui.js';
import { fmtLen, fmtDepth } from '../units.js';
import { saveFile } from '../backup.js';
import { tackleLabel } from './tackle.js';
import { speedSummary } from '../troll.js';
import { catchPhotos } from './log.js';

// What the trip's catches have in common, as starting chips for "What worked".
async function workedChips(catches) {
  const tackle = Object.fromEntries((await db.all('tackle')).map(t => [t.id, tackleLabel(t)]));
  const count = key => Object.entries(catches.reduce((m, c) => { const k = key(c); if (k) m[k] = (m[k] ?? 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]);
  const lures = count(c => tackle[c.tackleId] ?? c.lure).slice(0, 3).map(([k, n]) => `${k} (${n})`);
  const depths = catches.map(c => c.depth).filter(Number.isFinite).sort((a, b) => a - b);
  const hours = count(c => new Date(c.time).toLocaleTimeString(undefined, { hour: 'numeric' })).slice(0, 1).map(([k]) => `best around ${k}`);
  const speed = speedSummary(catches);
  return [...lures, depths.length ? `${fmtDepth(depths[0])}${depths.length > 1 && depths.at(-1) !== depths[0] ? `–${fmtDepth(depths.at(-1))}` : ''} deep` : null, ...hours, speed && `trolling ${speed}`].filter(Boolean);
}

// The newest "next time" note for a water, from a trip other than `exceptId`.
export async function lastNextTime(lakeId, exceptId = null) {
  const t = (await db.byLake('trips', lakeId)).filter(x => x.id !== exceptId && x.nextTime?.trim()).sort((a, b) => b.start.localeCompare(a.start))[0];
  return t ? { text: t.nextTime.trim(), date: t.start, tripId: t.id } : null;
}
export const nextTimeHtml = n => n ? `<div class="next-time small">📝 <b>Last time here (${fmtDate(n.date)}) you said:</b> ${esc(n.text)}</div>` : '';

let justSaved = null; // stays open after Save, so the share card is one tap away
export async function renderDebrief(el, t, lake, catches, events, onSaved) {
  const chips = await workedChips(catches);
  const lost = events.filter(e => e.kind === 'lure');
  const fresh = justSaved === t.id || (!t.debriefed && Date.now() - Date.parse(t.end) < 18 * 3600e3);
  el.innerHTML = `<details class="card debrief" ${fresh ? 'open' : ''}><summary><b>${t.debriefed ? '✓ Debrief' : '🛻 Debrief at the truck'}</b>
      <span class="muted small">${t.debriefed ? (t.nextTime ? `Next time: ${esc(t.nextTime.slice(0, 60))}${t.nextTime.length > 60 ? '…' : ''}` : 'saved') : 'two quick questions while it’s fresh'}</span></summary>
    <form class="form" id="debrief-form">
      <label>What worked <textarea name="worked" rows="2" placeholder="Lure, depth, spot, time…">${esc(t.worked ?? '')}</textarea></label>
      ${chips.length ? `<div class="pick-chips">${chips.map(c => `<button type="button" data-chip="${esc(c)}">+ ${esc(c)}</button>`).join('')}</div>` : ''}
      <label>Next time I’d… <textarea name="nextTime" rows="2" placeholder="Launch earlier, bring the 1/8 oz jigs, try the north cove…">${esc(t.nextTime ?? '')}</textarea></label>
      <p class="muted small">Shows up when you start a trip here again, and on the before-you-go checklist.${lost.length ? ` You lost ${lost.length} lure${lost.length > 1 ? 's' : ''} today: they're on the restock list (Journal → Tackle).` : ''}</p>
      <div class="row"><button class="primary">Save debrief</button><button type="button" id="share-card">📸 Share card</button></div>
    </form></details>`;
  const form = $('#debrief-form', el);
  el.querySelectorAll('[data-chip]').forEach(b => b.onclick = () => { form.worked.value = [form.worked.value.trim(), b.dataset.chip].filter(Boolean).join(', '); b.remove(); });
  form.onsubmit = async e => {
    e.preventDefault();
    const saved = await db.get('trips', t.id);
    if (!saved) return;
    const next = await db.put('trips', { ...saved, worked: form.worked.value.trim(), nextTime: form.nextTime.value.trim(), debriefed: true });
    status('Debrief saved');
    justSaved = t.id;
    onSaved?.(next);
  };
  $('#share-card', el).onclick = () => shareCardDialog(t, lake, catches);
}

// ---------- Share card ----------
const loadImg = blob => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(blob); });
function cover(ctx, img, x, y, w, h) {
  const s = Math.max(w / img.width, h / img.height), sw = w / s, sh = h / s;
  ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, y, w, h);
}
function fitText(ctx, text, max, size, weight = 700) {
  let s = size;
  do { ctx.font = `${weight} ${s}px system-ui, -apple-system, sans-serif`; s -= 2; } while (ctx.measureText(text).width > max && s > 20);
}

// A 1080×1350 picture of the day: the best photo, the water (unless hidden), the date and the fish.
export async function drawShareCard(t, lake, catches, { showWater = true } = {}) {
  const W = 1080, H = 1350, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#0f3b4c'); g.addColorStop(1, '#0a2530');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  const biggest = [...catches].filter(x => x.length).sort((a, b) => b.length - a.length)[0];
  const photo = [biggest, ...catches].map(x => x && catchPhotos(x)[0]).find(Boolean) ?? (t.photos ?? []).find(p => p instanceof Blob);
  const top = 760;
  if (photo) { try { cover(ctx, await loadImg(photo), 0, 0, W, top); } catch { /* unreadable photo: plain card */ } }
  else { ctx.fillStyle = '#145266'; ctx.fillRect(0, 0, W, top); ctx.font = '260px system-ui'; ctx.textAlign = 'center'; ctx.fillText('🎣', W / 2, top / 2 + 90); ctx.textAlign = 'left'; }
  const fade = ctx.createLinearGradient(0, top - 220, 0, top);
  fade.addColorStop(0, 'rgba(10,37,48,0)'); fade.addColorStop(1, 'rgba(10,37,48,1)');
  ctx.fillStyle = fade; ctx.fillRect(0, top - 220, W, 220);
  ctx.fillStyle = '#fff';
  fitText(ctx, showWater ? lake?.name ?? 'Fishing trip' : 'A day on the water', W - 120, 76);
  ctx.fillText(showWater ? lake?.name ?? 'Fishing trip' : 'A day on the water', 60, top + 40);
  ctx.font = '400 40px system-ui, -apple-system, sans-serif'; ctx.fillStyle = '#b9d6df';
  ctx.fillText(new Date(t.start).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }), 60, top + 110);
  const hours = (Date.parse(t.end) - Date.parse(t.start)) / 3600e3;
  const stats = [[String(catches.length), catches.length === 1 ? 'fish' : 'fish'], [hours >= 1 ? `${hours.toFixed(1)} h` : `${Math.round(hours * 60)} min`, 'on the water'], biggest ? [fmtLen(biggest.length), `biggest · ${biggest.species}`] : null].filter(Boolean);
  stats.forEach(([v, l], i) => {
    const x = 60 + i * 330;
    ctx.fillStyle = '#fff'; fitText(ctx, v, 300, 84); ctx.fillText(v, x, top + 250);
    ctx.fillStyle = '#b9d6df'; fitText(ctx, l, 300, 34, 400); ctx.fillText(l, x, top + 300);
  });
  const bySpecies = Object.entries(catches.reduce((m, x) => (m[x.species] = (m[x.species] ?? 0) + 1, m), {})).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s} ×${n}`).join(' · ');
  if (bySpecies) { ctx.fillStyle = '#fff'; fitText(ctx, bySpecies, W - 120, 40, 500); ctx.fillText(bySpecies, 60, top + 400); }
  ctx.fillStyle = '#6fa3b3'; ctx.font = '400 30px system-ui, -apple-system, sans-serif';
  ctx.fillText('🎣 Tackle Box', 60, H - 50);
  return new Promise(r => c.toBlob(r, 'image/png'));
}

async function shareCardDialog(t, lake, catches) {
  const dlg = document.createElement('dialog');
  dlg.className = 'share-card-dlg';
  dlg.innerHTML = `<form method="dialog"><h3>Share card</h3><img alt="Share card preview">
    <label class="check"><input type="checkbox" name="water" checked> Show the water’s name</label>
    <p class="muted small">Only what’s on the picture is shared: no map, no spot, no coordinates.</p>
    <div class="row"><button value="cancel">Close</button><button value="share" class="primary" id="card-go">Share or save</button></div></form>`;
  document.body.append(dlg);
  const img = dlg.querySelector('img');
  let blob = null;
  const draw = async () => { blob = await drawShareCard(t, lake, catches, { showWater: dlg.querySelector('[name=water]').checked }); if (img.src) URL.revokeObjectURL(img.src); img.src = URL.createObjectURL(blob); };
  dlg.querySelector('[name=water]').onchange = draw;
  dlg.querySelector('#card-go').onclick = async e => {
    e.preventDefault();
    if (!blob) return;
    const name = `${(dlg.querySelector('[name=water]').checked ? lake?.name ?? 'trip' : 'trip').replace(/\W+/g, '-')}-${t.start.slice(0, 10)}.png`;
    await saveFile(new File([blob], name, { type: 'image/png' }), { title: 'Fishing trip' });
  };
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
  await draw();
}
