// The Data view: backup and restore, sharing a lake with friends, install help, storage use.
import { db, exportAll, importAll } from '../db.js';
import { $, status, onShow } from '../ui.js';
import { refreshMap } from '../map.js';

// ---------- Sharing with friends ----------
// A lake pack holds the lake, its depth maps and stocking notes. Catches and notes stay private unless included.
export async function shareLake(lake) {
  const includeNotes = confirm(`Share ${lake.name} with its depth maps.\n\nAlso include your notes, pinned spots and waypoints? (Catches are never included.)`);
  const pack = { app: 'tackle-box', version: 1, sharedAt: new Date().toISOString(), lakes: [{ ...lake, favorite: undefined }], // your star stays yours
    depthSets: await db.byLake('depthSets', lake.id), stocking: await db.byLake('stocking', lake.id),
    notes: includeNotes ? await db.byLake('notes', lake.id) : [], catches: [],
    waypoints: includeNotes ? await db.byLake('waypoints', lake.id) : [] };
  const file = new File([JSON.stringify(pack)], `${lake.name.replace(/[^\w-]+/g, '-')}.tacklebox.json`, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: lake.name, text: `${lake.name} for Tackle Box. Open the app, go to Data → Import.` }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = file.name; a.click();
}

// ---------- Backup ----------
$('#btn-export').onclick = async () => {
  const data = await exportAll();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  a.download = `tackle-box-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
};
$('#import-file').onchange = async e => {
  try {
    const data = JSON.parse(await e.target.files[0].text());
    const isPack = !data.exportedAt;
    const replace = !isPack && confirm('Replace everything on this device with the backup? (Cancel = merge)');
    const skipped = await importAll(data, { replace });
    await refreshMap();
    status((isPack ? `Added ${data.lakes.map(l => l.name).join(', ')}` : 'Backup imported') + (skipped ? ` (${skipped} damaged entries skipped)` : ''));
  } catch (err) { alert(err.message); }
};
function renderInstallHelp() {
  const ua = navigator.userAgent, standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  $('#install-help').innerHTML = standalone ? '✅ Installed on this device.'
    : /iPhone|iPad|iPod/.test(ua) ? 'iPhone: open this page in <b>Safari</b>, tap the <b>Share</b> button, then <b>Add to Home Screen</b>.'
    : /Android/.test(ua) ? 'Android: in <b>Chrome</b>, tap <b>⋮</b> then <b>Install app</b> (or <b>Add to Home screen</b>).'
    : 'On a phone, open this page and add it to your home screen. iPhone: Safari → Share → Add to Home Screen. Android: Chrome → ⋮ → Install app.';
}

async function renderStorageInfo() {
  renderInstallHelp();
  const counts = await Promise.all(['lakes', 'catches', 'notes', 'stocking', 'depthSets'].map(s => db.all(s).then(r => `${r.length} ${s === 'depthSets' ? 'depth maps' : s}`)));
  const est = await navigator.storage?.estimate?.();
  const persisted = await navigator.storage?.persisted?.();
  $('#storage-info').textContent = `${counts.join(' · ')}${est ? ` · ${(est.usage / 1e6).toFixed(1)} MB used` : ''}${persisted ? ' · protected from browser cleanup' : ''}`;
}

onShow('settings', renderStorageInfo);
