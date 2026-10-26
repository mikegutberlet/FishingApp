// Your fishing license and report cards: expiry and reporting dates, reminders in the app, and an optional
// calendar file made on this device. Stored with your data (so it's in backups), never sent anywhere.
import { db } from './db.js';
import { $, esc, fmtDate, status, onShow } from './ui.js';
import { saveFile } from './backup.js';

// California defaults. A sport license runs 365 days from purchase; report cards are due by January 31 after the
// card year, even if you fished nothing (spiny lobster: April 30).
const KINDS = {
  license: { label: 'Sport fishing license', what: 'expires' },
  steelhead: { label: 'Steelhead report card', what: 'report due', due: y => `${y + 1}-01-31` },
  sturgeon: { label: 'Sturgeon report card', what: 'report due', due: y => `${y + 1}-01-31` },
  salmon: { label: 'North Coast salmon report card', what: 'report due', due: y => `${y + 1}-01-31` },
  lobster: { label: 'Spiny lobster report card', what: 'report due', due: y => `${y + 1}-04-30` },
  rod: { label: 'Second rod validation', what: 'expires' },
  other: { label: 'Other', what: 'due' },
};
const daysUntil = d => Math.round((Date.parse(d + 'T12:00') - Date.now()) / 864e5);
const label = r => r.name || KINDS[r.kind]?.label || 'License';

// Items expiring or due within 30 days, or past due (but not more than 60 days ago).
export async function licensesDue() {
  return (await db.all('licenses')).filter(r => r.date && !r.done).map(r => ({ r, days: daysUntil(r.date) })).filter(x => x.days <= 30 && x.days > -60).sort((a, b) => a.days - b.days);
}
export const dueText = ({ r, days }) => `${label(r)} ${KINDS[r.kind]?.what ?? 'due'} ${days < 0 ? `${-days} day${days < -1 ? 's' : ''} ago` : days === 0 ? 'today' : `in ${days} day${days > 1 ? 's' : ''}`}`;

// A calendar file with alerts two weeks and one day before. Your calendar app imports it; this app never sees it again.
function ics(r) {
  const d = r.date.replace(/-/g, ''), next = new Date(Date.parse(r.date + 'T12:00') + 864e5).toISOString().slice(0, 10).replace(/-/g, '');
  const text = `${label(r)} ${KINDS[r.kind]?.what ?? 'due'}`;
  const alarm = t => `BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:${text}\r\nTRIGGER:${t}\r\nEND:VALARM`;
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Tackle Box//License reminder//EN', 'BEGIN:VEVENT', `UID:${r.id}@tackle-box`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]|\.\d+/g, '')}`, `DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${next}`, `SUMMARY:${text.replace(/[,;]/g, '\\$&')}`,
    'DESCRIPTION:California report cards can be reported at wildlife.ca.gov/Licensing.', alarm('-P14D'), alarm('-P1D'), 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
}

export async function renderLicenseCard(edit = null) {
  const el = $('#license-card');
  if (!el) return;
  const rows = (await db.all('licenses')).sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
  const e = edit ?? {};
  el.innerHTML = `<h3>🪪 License and report cards</h3>
    ${rows.map(r => { const d = r.date && daysUntil(r.date); return `<div class="lic ${!r.done && d != null && d <= 30 ? (d < 0 ? 'bad' : 'warn') : ''}">
      <div style="flex:1"><b>${esc(label(r))}</b>${r.number ? ` <span class="muted small">#${esc(r.number)}</span>` : ''}
        <div class="small">${r.date ? `${KINDS[r.kind]?.what ?? 'due'} ${fmtDate(r.date + 'T12:00')}` : 'no date'}${r.done ? ' · ✓ done' : ''}</div></div>
      <div class="small lic-act"><a href="#" data-cal="${r.id}">📅</a> <a href="#" data-edit="${r.id}">edit</a>${KINDS[r.kind]?.due && !r.done ? ` <a href="#" data-done="${r.id}">reported</a>` : ''}</div></div>`; }).join('')
      || '<p class="small muted">Add your license and any report cards to get a reminder here before they expire or are due.</p>'}
    <form class="form" id="lic-form" style="margin-top:8px">
      <div class="row"><label>What <select name="kind">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}" ${e.kind === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select></label>
        <label>Date <input type="date" name="date" value="${esc(e.date)}"></label></div>
      <div class="row"><label>Number (optional) <input name="number" value="${esc(e.number)}" autocomplete="off"></label>
        <label>Name (optional) <input name="name" value="${esc(e.name)}"></label></div>
      <button class="primary">${edit ? 'Save' : 'Add'}</button>
      ${edit ? '<div class="row" style="margin-top:8px"><button type="button" id="lic-cancel" style="flex:1">Cancel</button><button type="button" id="lic-del" class="danger" style="flex:1">Delete</button></div>' : ''}
    </form>`;
  const form = $('#lic-form');
  // Report cards: fill in the due date for this year's card.
  form.kind.onchange = () => {
    const k = KINDS[form.kind.value];
    if (!k.due || form.date.value) return;
    // Last year's card while its deadline is still ahead, else this year's.
    let y = new Date().getFullYear();
    if (k.due(y - 1) >= new Date().toLocaleDateString('en-CA')) y--;
    form.date.value = k.due(y);
  };
  form.onsubmit = async ev => {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    await db.put('licenses', { ...edit, kind: f.kind, date: f.date || null, number: f.number.trim(), name: f.name.trim(), done: edit?.date === f.date ? edit?.done ?? false : false });
    status('Saved'); renderLicenseCard();
  };
  $('#lic-cancel')?.addEventListener('click', () => renderLicenseCard());
  $('#lic-del')?.addEventListener('click', async () => { if (confirm('Delete this?')) { await db.del('licenses', edit.id); renderLicenseCard(); } });
  el.querySelectorAll('[data-edit]').forEach(a => a.onclick = async ev => { ev.preventDefault(); renderLicenseCard(await db.get('licenses', a.dataset.edit)); });
  el.querySelectorAll('[data-done]').forEach(a => a.onclick = async ev => { ev.preventDefault(); const r = await db.get('licenses', a.dataset.done); await db.put('licenses', { ...r, done: true }); renderLicenseCard(); });
  el.querySelectorAll('[data-cal]').forEach(a => a.onclick = async ev => {
    ev.preventDefault();
    const r = rows.find(x => x.id === a.dataset.cal);
    if (!r.date) return alert('Add a date first.');
    saveFile(new File([ics(r)], `${label(r).replace(/\W+/g, '-')}.ics`, { type: 'text/calendar' }), { title: label(r) });
  });
}

onShow('settings', () => renderLicenseCard());
