// Tackle box inventory: your lures, baits and gear, with how many fish each has caught.
// The catch form picks from it; catches keep the free-text `lure` as well, so older catches still count.
import { db } from '../db.js';
import { $, esc, status } from '../ui.js';
import { shrinkPhoto } from './log.js';

export const TACKLE_TYPES = ['Crankbait', 'Jerkbait', 'Spinnerbait', 'Spinner', 'Spoon', 'Jig', 'Soft plastic', 'Swimbait', 'Topwater', 'Fly', 'Live bait', 'Dough / paste bait', 'Rig', 'Rod', 'Reel', 'Line', 'Other'];
export const tackleLabel = t => [t.name, t.color, t.size].filter(Boolean).join(' ');

export async function renderTackle(el, edit = null) {
  const [tackle, catches] = await Promise.all([db.all('tackle'), db.all('catches')]);
  const fish = t => catches.filter(c => c.tackleId === t.id || (!c.tackleId && c.lure && c.lure.toLowerCase() === tackleLabel(t).toLowerCase())).length;
  const rows = tackle.map(t => ({ t, n: fish(t) })).sort((a, b) => b.n - a.n || tackleLabel(a.t).localeCompare(tackleLabel(b.t)));
  const e = edit ?? {};
  el.innerHTML = `<form class="card form" id="tackle-form"><h3>${edit ? 'Edit' : 'Add to your tackle box'}</h3>
      <label>Name <input name="name" required value="${esc(e.name)}" placeholder="Senko, Rapala Shad Rap, PowerBait…"></label>
      <div class="row"><label>Type <select name="type">${TACKLE_TYPES.map(x => `<option ${e.type === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
        <label>Color <input name="color" value="${esc(e.color)}" placeholder="green pumpkin"></label></div>
      <div class="row"><label>Size / weight <input name="size" value="${esc(e.size)}" placeholder='5", 1/4 oz'></label>
        <label>How many <input name="qty" type="number" min="0" inputmode="numeric" value="${esc(e.qty)}"></label></div>
      <label>Notes <input name="notes" value="${esc(e.notes)}"></label>
      <label>Photo <input name="photo" type="file" accept="image/*"></label>
      <button class="primary">${edit ? 'Save' : 'Add'}</button>${edit ? ' <button type="button" id="tackle-cancel" style="width:100%;margin-top:8px">Cancel</button>' : ''}
    </form>
    ${rows.length ? rows.map(({ t, n }) => `<div class="card catch">${t.photo ? `<img src="${URL.createObjectURL(t.photo)}" alt="">` : ''}<div style="flex:1">
      <b>${esc(tackleLabel(t))}</b> <span class="muted small">${esc(t.type)}${t.qty ? ` · ${esc(t.qty)} on hand` : ''}</span>
      <div class="small">${n ? `🐟 ${n} fish` : '<span class="muted">No fish yet</span>'}</div>
      ${t.notes ? `<div class="small muted">${esc(t.notes)}</div>` : ''}
      <a href="#" class="small" data-edit="${t.id}">edit</a> · <a href="#" class="small danger" data-del="${t.id}">delete</a></div></div>`).join('')
    : '<div class="card muted">Add the lures and baits you carry. When you log a catch, pick one and it counts toward that lure\'s fish.</div>'}`;
  const form = $('#tackle-form');
  form.onsubmit = async ev => {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    await db.put('tackle', { ...edit, name: f.name.trim(), type: f.type, color: f.color.trim(), size: f.size.trim(), qty: f.qty === '' ? null : +f.qty, notes: f.notes.trim(),
      photo: form.photo.files[0] ? await shrinkPhoto(form.photo.files[0], 800) : edit?.photo ?? null });
    status(edit ? 'Saved' : 'Added to your tackle box');
    renderTackle(el);
  };
  $('#tackle-cancel')?.addEventListener('click', () => renderTackle(el));
  el.querySelectorAll('[data-edit]').forEach(a => a.onclick = async ev => { ev.preventDefault(); await renderTackle(el, await db.get('tackle', a.dataset.edit)); el.closest('.view').scrollTop = 0; });
  el.querySelectorAll('[data-del]').forEach(a => a.onclick = async ev => {
    ev.preventDefault();
    if (!confirm('Remove this from your tackle box? Catches keep the lure name.')) return;
    await db.del('tackle', a.dataset.del);
    renderTackle(el);
  });
}
