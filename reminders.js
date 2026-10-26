// In-app reminders shown under the header when the app opens: backup overdue, license or report card due soon.
// "Later" snoozes a reminder on this device. Nothing is scheduled outside the app (use the 📅 calendar file for that).
import { esc, showView } from './ui.js';
import { backupDue, daysSinceBackup, backup } from './backup.js';
import { licensesDue, dueText } from './license.js';

const SNOOZE = 'tackle-box-snooze';
const snoozes = () => { try { return JSON.parse(localStorage.getItem(SNOOZE)) ?? {}; } catch { return {}; } };
const snooze = (key, days) => localStorage.setItem(SNOOZE, JSON.stringify({ ...snoozes(), [key]: Date.now() + days * 864e5 }));

export async function checkReminders() {
  const s = snoozes(), items = [];
  if (!(s.backup > Date.now()) && await backupDue()) {
    const d = daysSinceBackup();
    items.push({ key: 'backup', days: 3, cls: '', text: d == null ? "You haven't backed up yet. If this phone is lost, so are your catches." : `Last backup was ${d} days ago.`, action: 'Back up now', run: () => backup() });
  }
  for (const x of await licensesDue()) {
    const key = `lic-${x.r.id}-${x.r.date}`;
    if (!(s[key] > Date.now())) items.push({ key, days: x.days < 0 ? 1 : 3, cls: x.days < 0 ? 'bad' : '', text: dueText(x), action: 'Open', run: () => { showView('settings'); document.getElementById('license-card')?.scrollIntoView(); } });
  }
  document.querySelector('#reminders')?.remove();
  if (!items.length) return;
  const el = document.createElement('div');
  el.id = 'reminders';
  el.innerHTML = items.map((it, i) => `<div class="reminder ${it.cls}"><span>${it.key === 'backup' ? '💾' : '🪪'} ${esc(it.text)}</span>
    <button data-go="${i}">${esc(it.action)}</button><button data-later="${i}" class="muted">Later</button></div>`).join('');
  document.body.append(el);
  const done = (i, row) => { snooze(items[i].key, items[i].days); row.remove(); if (!el.children.length) el.remove(); };
  el.querySelectorAll('[data-go]').forEach(b => b.onclick = () => { const i = +b.dataset.go; items[i].run(); done(i, b.parentElement); });
  el.querySelectorAll('[data-later]').forEach(b => b.onclick = () => done(+b.dataset.later, b.parentElement));
}
