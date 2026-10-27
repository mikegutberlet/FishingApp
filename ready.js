// Ready for no signal: one button that saves, for one or several waters, everything a trip needs once the bars are
// gone: the forecast (kept with its age, see forecast.js), weather alerts, Getting there with the walk in, snow and
// fires, Camping, and the offline map pack (satellite + USGS topo, along the walk in and your GPX routes, plus the
// state's regs, stocking and depth data). Each part is the same lookup the water's page makes; nothing new is sent.
import { db } from './db.js';
import { $, esc, status, showView } from './ui.js';
import { weatherFor, fetchAlerts } from './forecast.js';
import { lookupAccess } from './access-lookup.js';
import { isBig } from './access-rules.js';
import { lookupNow } from './access-now.js';
import { lookupCamping } from './camping.js';
import { lakeBounds, packPlan, runPack, readPackFor, packLines, wantTopo, setWantTopo } from './offline.js';
import { activeTrip } from './views/trips.js';
import { lookupSupplies } from './supplies.js';
import { roadsNear } from './roads.js';
import { backupCardHtml, wireBackupCard } from './backup-prompt.js';
import { bookletHtml, wireBooklets, isSaved, BOOKLET_HELP } from './regs-booklet.js';
import { forLake } from './states/index.js';

const READY_KEY = 'tackle-box-ready'; // { [lake id]: { at: ISO, failed: [part names] } }, this phone only
const readyLog = () => { try { return JSON.parse(localStorage.getItem(READY_KEY)) ?? {}; } catch { return {}; } };
const logReady = (id, entry) => { try { localStorage.setItem(READY_KEY, JSON.stringify({ ...readyLog(), [id]: entry })); } catch {} };
const ago = iso => { const m = Math.round((Date.now() - Date.parse(iso)) / 60e3); return m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };

// Everything but the map for one water. Returns the parts saved and the parts that couldn't be (no signal, service down).
export async function saveInfo(lake, { signal, onStep = () => {} } = {}) {
  const saved = [], failed = [], skipped = [];
  const part = async (name, fn) => {
    if (signal?.aborted) return;
    onStep(`${lake.name}: ${name}…`);
    try { (await fn()) === false ? failed.push(name) : saved.push(name); } catch (e) { console.warn(`ready ${name}:`, e.message); failed.push(name); }
  };
  await part('forecast', async () => !(await weatherFor(lake.lat, lake.lon)).saved);
  await part('weather alerts', async () => !(await fetchAlerts(lake.lat, lake.lon)).savedAt);
  // A big lake's roads depend on which shore you go to, so Getting there needs a spot picked on its tab first.
  if (isBig(lake)) skipped.push('Getting there (pick a spot on its tab with signal)');
  else await part('Getting there', async () => (await lookupAccess(lake)).failed.length < 6);
  await part('snow and fires', async () => (await lookupNow(+lake.lat, +lake.lon, { elevFt: lake.elevationFt ?? null })).failed.length < 3);
  await part('Camping', async () => (await lookupCamping(lake)).failed.length < 6);
  await part('gas, ice and bait', async () => !(await lookupSupplies(lake, { force: true })).stale);
  // Caltrans roads (California and waters within reach of it). They change by the hour; the saved copy shows its age.
  if (+lake.lat < 43) await part('roads in', async () => !(await roadsNear(lake)).stale);
  return { saved, failed, skipped };
}

// The map pack for one water at the whole-lake area, with topo when wanted and it fits (else satellite alone).
async function saveMap(lake, { topo, signal, onProgress }) {
  const existing = await readPackFor(lake);
  const [bounds, lines] = await Promise.all([lakeBounds(lake), topo ? packLines(lake).catch(() => []) : []]);
  let pl = await packPlan(lake, { bounds, layers: topo ? ['Satellite', 'Topo'] : ['Satellite'], lines, existing });
  if (pl.tooBig && topo) pl = await packPlan(lake, { bounds, layers: ['Satellite'], lines: [], existing });
  if (pl.tooBig) return { tooBig: true };
  return runPack(lake, pl, { existing, signal, onProgress });
}

// pick: ids of the waters to tick (a camp trip's waters); otherwise your favorites and the running trip's water.
export async function readyDialog({ pick = null } = {}) {
  const lakes = (await db.all('lakes')).sort((a, b) => (b.favorite ?? false) - (a.favorite ?? false) || a.name.localeCompare(b.name));
  if (!lakes.length) return alert('Save the waters you\'re heading to first: tap one on the map, then Save.');
  const trip = await activeTrip().catch(() => null), log = readyLog();
  const packs = new Map(await Promise.all(lakes.map(async l => [l.id, await readPackFor(l).catch(() => null)])));
  const pre = new Set(pick?.filter(id => lakes.some(l => l.id === id)) ?? lakes.filter(l => l.favorite || l.id === trip?.lakeId).map(l => l.id));
  if (!pre.size && lakes.length === 1) pre.add(lakes[0].id);
  const dlg = document.createElement('dialog');
  dlg.className = 'sheet';
  dlg.innerHTML = `<form class="form" method="dialog"><h3>📴 Ready for no signal</h3>
    <p class="muted small">Do this at home on Wi-Fi. For each water you tick, the phone keeps the forecast (it shows how old it is), weather alerts, Getting there with the walk in, snow and fires, Camping, the roads in, the last gas, ice and bait, and the map with the state's regs, stocking and depth data.</p>
    <div class="rdy-list">${lakes.map(l => { const r = log[l.id], p = packs.get(l.id); return `<label class="check rdy-row"><input type="checkbox" name="lake" value="${esc(l.id)}" ${pre.has(l.id) ? 'checked' : ''}>
      <span><b>${esc(l.name)}</b>${l.favorite ? ' ★' : ''}<br><span class="muted small">${r ? `Ready ${ago(r.at)}${r.failed?.length ? ` · missed ${esc(r.failed.join(', '))}` : ''}` : 'Not made ready yet'}${p ? ` · map ${(p.bytes / 1e6).toFixed(0)} MB${p.complete ? '' : ', partial'}` : ''}</span></span></label>`; }).join('')}</div>
    <label class="check"><input type="checkbox" name="map" checked> Maps (satellite, regs, stocking and depth data)</label>
    <label class="check"><input type="checkbox" name="topo" ${wantTopo() ? 'checked' : ''}> Topo too: contours, trails and forest roads, along the walk in and your routes</label>
    <p id="rdy-msg" class="small"></p>
    <progress id="rdy-progress" max="1" value="0" class="hidden"></progress>
    <div class="row"><button value="cancel" id="rdy-cancel">Cancel</button><button class="primary" id="rdy-go" value="go">Get ready</button></div></form>`;
  document.body.append(dlg);
  const form = dlg.querySelector('form'), msg = $('#rdy-msg', dlg);
  const picked = () => [...form.querySelectorAll('[name=lake]:checked')].map(b => lakes.find(l => l.id === b.value));
  let asked = 0;
  const estimate = async () => {
    const n = ++asked, list = picked();
    $('#rdy-go', dlg).disabled = !list.length;
    form.topo.disabled = !form.map.checked;
    if (!list.length) { msg.textContent = 'Tick the waters you\'re heading to.'; return; }
    if (!form.map.checked) { msg.textContent = `${list.length} water${list.length > 1 ? 's' : ''}: forecast and lookups only, a few seconds each.`; return; }
    msg.textContent = 'Working out the size…';
    let mb = 0;
    for (const l of list) {
      const [bounds, lines] = await Promise.all([lakeBounds(l), form.topo.checked ? packLines(l).catch(() => []) : []]);
      const pl = await packPlan(l, { bounds, layers: form.topo.checked ? ['Satellite', 'Topo'] : ['Satellite'], lines, existing: packs.get(l.id) });
      mb += pl.p.mb + pl.routeTiles * 20 / 1024;
      if (n !== asked) return;
    }
    msg.textContent = `${list.length} water${list.length > 1 ? 's' : ''}, up to about ${Math.max(1, Math.round(mb))} MB of maps (tiles already saved aren't downloaded again).`;
  };
  form.onchange = e => { if (e.target.name === 'topo') setWantTopo(form.topo.checked); estimate(); };
  estimate();
  const abort = new AbortController();
  dlg.onclose = () => { if ('parked' in dlg.dataset) return; abort.abort(); dlg.remove(); }; // parked = app lock: keep going
  $('#rdy-go', dlg).onclick = async e => {
    e.preventDefault();
    const list = picked(), maps = form.map.checked, topo = maps && form.topo.checked;
    form.querySelectorAll('input, #rdy-go').forEach(el => el.disabled = true);
    $('#rdy-cancel', dlg).textContent = 'Stop';
    const bar = $('#rdy-progress', dlg);
    bar.classList.remove('hidden');
    const results = [];
    for (const [i, l] of list.entries()) {
      if (abort.signal.aborted) break;
      const step = t => { msg.textContent = `(${i + 1} of ${list.length}) ${t}`; };
      const info = await saveInfo(l, { signal: abort.signal, onStep: step });
      let map = null;
      if (maps && !abort.signal.aborted) {
        step(`${l.name}: map…`);
        map = await saveMap(l, { topo, signal: abort.signal, onProgress: (n, total) => { bar.value = (i + n / total) / list.length; step(`${l.name}: map ${n.toLocaleString()} of ${total.toLocaleString()}`); } });
        if (map.tooBig) info.failed.push('map (too big: save part of it from the water\'s ⬇ Offline button)');
        else if (map.missing) info.failed.push(`${map.missing} map tiles`);
      }
      bar.value = (i + 1) / list.length;
      if (!abort.signal.aborted) logReady(l.id, { at: new Date().toISOString(), failed: info.failed });
      results.push({ lake: l, info, map });
    }
    msg.innerHTML = (abort.signal.aborted ? '<b>Stopped.</b> What finished is saved.<br>' : '<b>Ready.</b> ')
      + results.map(r => `${r.info.failed.length ? '⚠️' : '✅'} <b>${esc(r.lake.name)}</b>${r.map && !r.map.tooBig ? ` · map ${(r.map.bytes / 1e6).toFixed(0)} MB` : ''}${r.info.failed.length ? `<br><span class="muted">Not saved: ${esc(r.info.failed.join(', '))}. Try again with better signal.</span>` : ''}${r.info.skipped.length ? `<br><span class="muted">${esc(r.info.skipped.join(', '))}</span>` : ''}`).join('<br>');
    for (const r of results) { const row = form.querySelector(`[name=lake][value="${CSS.escape(r.lake.id)}"]`)?.closest('.rdy-row')?.querySelector('.muted'); if (row && !abort.signal.aborted) row.textContent = r.info.failed.length ? `Ready just now · missed ${r.info.failed.join(', ')}` : 'Ready just now'; }
    // Before days away: a backup, and the regs booklets for the states you're heading to.
    const codes = [...new Set(results.map(r => forLake(r.lake)?.code).filter(Boolean))].filter(c => !isSaved(c));
    const extra = document.createElement('div');
    extra.className = 'rdy-extra';
    extra.innerHTML = `${backupCardHtml(null)}${codes.length ? `<div class="tg-booklets"><b>📕 Regs booklet</b>${codes.map(c => bookletHtml(c, esc)).join('')}<p class="muted small">${esc(BOOKLET_HELP)}</p></div>` : ''}`;
    msg.after(extra);
    wireBackupCard(extra, null, () => extra.querySelector('.tg-backup')?.remove());
    wireBooklets(extra);
    $('#rdy-cancel', dlg).textContent = 'Done';
    status(abort.signal.aborted ? 'Stopped; what finished is saved' : 'Ready for no signal');
  };
  dlg.showModal();
}
