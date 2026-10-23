// Regulation warnings on the catch form: closed season, release only, size and bag limits for the water, species and date.
// Shown above Save as you fill in the form; they never block saving.
import * as CA from '../states/ca.js';
import { db } from '../db.js';
import { esc } from '../ui.js';
import { fromLen } from '../units.js';

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
let latest = 0;

// form = the #catch-form element; editingId = the catch being edited, so it doesn't count against its own bag limit.
export async function showCatchWarnings(form, editingId) {
  let box = form.querySelector('.catch-warn');
  if (!box) {
    box = document.createElement('div');
    box.className = 'catch-warn';
    box.setAttribute('role', 'status');
    form.querySelector('button[type="submit"]').before(box);
  }
  const run = ++latest;
  const species = form.species.value.trim();
  const lake = form.lakeId.value && species ? await db.get('lakes', form.lakeId.value) : null;
  let warnings = [];
  if (lake) {
    const when = form.time.value ? new Date(form.time.value) : new Date();
    const group = CA.regGroup(species);
    const kept = group ? (await db.all('catches')).filter(c => c.id !== editingId && c.lakeId === lake.id && !c.released
      && CA.regGroup(c.species) === group && sameDay(new Date(c.time), when)).length : 0;
    const length = form.length.value === '' ? null : fromLen(+form.length.value);
    warnings = await CA.catchWarnings(lake, { species, length, time: when, kept, released: form.released.checked }).catch(() => []);
  }
  if (run !== latest) return; // a newer keystroke already redrew it
  box.innerHTML = warnings.length ? `<div class="banner hab-caution small"><b>⚠️ Check the regs</b>${warnings.map(w => `<div>${esc(w)}</div>`).join('')}
    <a href="#" data-regs>See this water’s rules ›</a> <span class="muted">Posted signs and the CDFW booklet have the final word.</span></div>` : '';
  box.querySelector('[data-regs]')?.addEventListener('click', e => { e.preventDefault(); import('./lake.js').then(m => m.openLake(lake.id, 'safety')); });
}
