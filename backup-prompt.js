// Back up before a multi-day trip: a phone dropped in the lake on day two shouldn't take the season's log with it.
// Shows on Today from three days before a camp trip of two nights or more (or when Ready for no signal runs) while the
// last backup is older than the trip's lead-up, until you back up or say not this trip.
import { db } from './db.js';
import { daysSinceBackup, backupPrefs, backup, askNewPassword } from './backup.js';
import { esc, status } from './ui.js';

const SKIP_KEY = 'tackle-box-backup-skip'; // camp trip ids you said "not this trip" to
const LEAD_DAYS = 3;
const skipped = () => { try { return JSON.parse(localStorage.getItem(SKIP_KEY)) ?? []; } catch { return []; } };

const dayMs = d => Date.parse(d + 'T00:00');
const nights = t => Math.round((dayMs(t.end ?? t.start) - dayMs(t.start)) / 864e5);

// The camp trip that wants a backup now, or null. now is injectable for tests.
export async function tripNeedingBackup(now = Date.now()) {
  const trips = await db.all('campTrips').catch(() => []);
  const last = backupPrefs().last ? Date.parse(backupPrefs().last) : 0;
  return trips.filter(t => t.start && nights(t) >= 2 && !skipped().includes(t.id))
    .filter(t => { const s = dayMs(t.start), e = dayMs(t.end ?? t.start) + 864e5; return now >= s - LEAD_DAYS * 864e5 && now < e; })
    // A backup made in the lead-up (or during the trip) counts.
    .filter(t => last < dayMs(t.start) - LEAD_DAYS * 864e5)
    .sort((a, b) => a.start.localeCompare(b.start))[0] ?? null;
}

const ago = () => { const d = daysSinceBackup(); return d == null ? 'You haven\'t made a backup on this phone yet.' : `Your last backup was ${d === 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`}.`; };

export function backupCardHtml(trip) {
  return `<div class="tg-backup"><b>🔐 Back up before ${trip ? esc(trip.name || 'your camp trip') : 'you go'}</b>
    <p class="small">${ago()} Everything you log lives only on this phone, so save a copy before ${trip ? 'days' : 'time'} away from charging and signal.</p>
    <div class="row"><button class="primary" data-bk="enc">🔐 Encrypted backup</button><button data-bk="plain">Plain backup</button>${trip ? '<button data-bk="skip" class="ghost">Not this trip</button>' : ''}</div></div>`;
}

export function wireBackupCard(el, trip, done = () => {}) {
  el.querySelectorAll('[data-bk]').forEach(b => b.onclick = async e => {
    e.stopPropagation();
    if (b.dataset.bk === 'skip') {
      try { localStorage.setItem(SKIP_KEY, JSON.stringify([...skipped(), trip.id].slice(-20))); } catch {}
      status('OK, no backup reminder for this trip');
      return done();
    }
    const pw = b.dataset.bk === 'enc' ? askNewPassword() : null;
    if (b.dataset.bk === 'enc' && !pw) return;
    if (await backup({ password: pw }).catch(err => (alert(err.message), false))) done();
  });
}

// Today's slot: fills and shows el when a trip needs a backup.
export async function todayBackup(el) {
  if (!el) return;
  const trip = await tripNeedingBackup().catch(() => null);
  if (!trip) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.innerHTML = backupCardHtml(trip);
  el.classList.remove('hidden');
  wireBackupCard(el, trip, () => { el.classList.add('hidden'); el.innerHTML = ''; });
}
