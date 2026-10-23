// Backups: plain or password-encrypted, saved where you choose (a folder on a computer, or iCloud Drive / Google Drive
// through the phone's share sheet), with an optional reminder. The app never uploads them anywhere itself.
import { db, exportAll } from './db.js';
import { encryptJson, decryptJson } from './crypto.js';
import { $, esc, status, onShow } from './ui.js';

const KEY = 'tackle-box-backup';
export const backupPrefs = () => { try { return { every: 30, last: null, ...JSON.parse(localStorage.getItem(KEY)) }; } catch { return { every: 30, last: null }; } };
const setPrefs = p => localStorage.setItem(KEY, JSON.stringify({ ...backupPrefs(), ...p }));

// Save a file the best way this device allows: a save dialog (desktop Chrome/Edge), the share sheet (phones:
// "Save to Files" picks iCloud Drive, Android offers Drive), or a plain download.
export async function saveFile(file, { title = file.name, text = '', share = true } = {}) {
  if (window.showSaveFilePicker && !/Android|iPhone|iPad/.test(navigator.userAgent)) {
    try {
      const h = await showSaveFilePicker({ suggestedName: file.name, types: [{ description: title, accept: { [file.type]: [file.name.match(/\.\w+$/)[0]] } }] });
      const w = await h.createWritable(); await w.write(file); await w.close();
      return true;
    } catch (e) { if (e.name === 'AbortError') return false; }
  }
  if (share && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title, text }); return true; }
    catch (e) { if (e.name === 'AbortError') return false; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = file.name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60e3);
  return true;
}

const stamp = () => new Date().toISOString().slice(0, 10);

export async function backup({ password = null } = {}) {
  status('Preparing backup…');
  const data = await exportAll();
  const body = password ? { app: 'tackle-box', kind: 'backup', exportedAt: data.exportedAt, encrypted: await encryptJson(data, password) } : data;
  const file = new File([JSON.stringify(body)], `tackle-box-backup-${stamp()}${password ? '-encrypted' : ''}.json`, { type: 'application/json' });
  const saved = await saveFile(file, { title: 'Tackle Box backup', text: 'Tackle Box backup' });
  if (saved) { setPrefs({ last: new Date().toISOString() }); status('Backup saved'); renderBackupCard(); }
  return saved;
}

// Turns an encrypted file back into the plain backup or pack it holds (asks for the password). Plain files pass through.
export async function openFile(data) {
  if (!data.encrypted) return data;
  for (let tries = 0; tries < 3; tries++) {
    const pw = prompt(tries ? 'Wrong password. Try again:' : 'This file is encrypted. Password:');
    if (pw == null) throw new Error('Import cancelled');
    try { return await decryptJson(data.encrypted, pw); } catch (e) { if (tries === 2) throw e; }
  }
}

export function askNewPassword(what = 'backup') {
  const pw = prompt(`Choose a password for this ${what} (at least 8 characters).\n\nWrite it down: without it the file cannot be opened, by you or anyone else.`);
  if (pw == null) return null;
  if (pw.length < 8) { alert('Use at least 8 characters.'); return null; }
  if (prompt('Type the password again:') !== pw) { alert("The passwords didn't match."); return null; }
  return pw;
}

export const daysSinceBackup = () => { const l = backupPrefs().last; return l ? Math.floor((Date.now() - Date.parse(l)) / 864e5) : null; };

// Due when reminders are on, there is something worth saving, and the last backup is older than the interval.
export async function backupDue() {
  const { every } = backupPrefs();
  if (!every) return false;
  const d = daysSinceBackup();
  if (d != null && d < every) return false;
  return (await db.all('catches')).length + (await db.all('notes')).length > 0;
}

export function renderBackupCard() {
  const el = $('#backup-card');
  if (!el) return;
  const { every } = backupPrefs(), d = daysSinceBackup();
  el.innerHTML = `<h3>🔐 Encrypted backup</h3>
    <p class="small">Locks the whole backup (catches, spots, photos, depth maps) with a password before it leaves the app.
      On a phone, pick <b>Save to Files → iCloud Drive</b> or <b>Drive</b> in the share sheet; on a computer, choose any folder.</p>
    <button id="btn-export-enc" class="primary">🔐 Encrypted backup</button>
    <div class="row small" style="margin-top:10px"><span style="flex:1">${d == null ? 'No backup made on this device yet.' : `Last backup ${d === 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`}.`}</span>
      <label class="form" style="margin:0;flex:0 0 auto">Remind me <select id="backup-every" style="display:inline-block;width:auto">
        ${[[0, 'never'], [7, 'weekly'], [14, 'every 2 weeks'], [30, 'monthly']].map(([v, l]) => `<option value="${v}" ${v === every ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label></div>`;
  $('#btn-export-enc').onclick = () => { const pw = askNewPassword(); if (pw) backup({ password: pw }).catch(e => alert(e.message)); };
  $('#backup-every').onchange = e => { setPrefs({ every: +e.target.value }); status('Saved'); };
}

onShow('settings', renderBackupCard);
