// Regulation warnings on the catch form: closed season, release only, size and bag limits for the water, species and date.
// Shown above Save as you fill in the form; they never block saving.
import * as CA from '../states/ca.js';
import { forLake } from '../states/index.js';
import { db } from '../db.js';
import { esc } from '../ui.js';
import { fromLen } from '../units.js';
import { isRiver } from '../states/common.js';
import { lookalikesFor, lookalikeHtml } from '../lookalikes.js';

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
  let warnings = [], look = '';
  if (lake) look = lookalikeHtml(lookalikesFor(species, { stateCode: forLake(lake)?.code, river: isRiver(lake), length: form.length.value === '' ? null : fromLen(+form.length.value) }));
  // California's regulations only: other states' waters get no warnings rather than the wrong ones.
  if (lake && forLake(lake) === CA) {
    const when = form.time.value ? new Date(form.time.value) : new Date();
    const group = CA.regGroup(species);
    const kept = group ? (await db.all('catches')).filter(c => c.id !== editingId && c.lakeId === lake.id && !c.released
      && CA.regGroup(c.species) === group && sameDay(new Date(c.time), when)).length : 0;
    const length = form.length.value === '' ? null : fromLen(+form.length.value);
    warnings = await CA.catchWarnings(lake, { species, length, time: when, kept, released: form.released.checked }).catch(() => []);
  }
  if (run !== latest) return; // a newer keystroke already redrew it
  // Keep an open "Not sure?" tip open while you type the length.
  const open = new Set([...box.querySelectorAll('.lookalike details[open] summary b')].map(b => b.textContent));
  box.innerHTML = look + (warnings.length ? `<div class="banner hab-caution small"><b>⚠️ Check the regs</b>${warnings.map(w => `<div>${esc(w)}</div>`).join('')}
    <a href="#" data-regs>See this water’s rules ›</a> <span class="muted">Posted signs and the CDFW booklet have the final word.</span></div>` : '');
  box.querySelectorAll('.lookalike details').forEach(d => { if (open.has(d.querySelector('summary b')?.textContent)) d.open = true; });
  box.querySelector('[data-regs]')?.addEventListener('click', e => { e.preventDefault(); import('./lake.js').then(m => m.openLake(lake.id, 'safety')); });
}
