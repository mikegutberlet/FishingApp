// Your own access notes on a water (what it really takes to get there, where to park, the gate, the best launch,
// what your phone gets there), and the ones friends shared. Yours are a row in the `notes` store with kind 'access',
// one per water, so they go in your backup and are deleted with the water; friends' arrive in a crew pack and live
// in the `crew` store, like their catches.
import { db } from './db.js';
import { esc, fmtDate, status, showView } from './ui.js';
import { map, pickPoint } from './map.js';
import { shrinkPhoto } from './views/log.js';

export const VEHICLES = { car: 'Any car', awd: 'AWD or SUV', highClearance: 'High clearance', '4wd': '4WD needed', ohv: 'ATV or dirt bike only', hike: 'Hike in only', boat: 'Boat in' };
export const CARRIERS = { att: 'AT&T', verizon: 'Verizon', tmobile: 'T-Mobile' };
export const SIGNAL = { none: 'No signal', sos: 'SOS only', text: 'Texts only', calls: 'Calls, slow data', data: 'Data works' };
export const ACCESS_FIELDS = ['vehicle', 'road', 'park', 'launch', 'gate', 'gateCode', 'signalNote', 'checked'];

export const myAccessNote = async lakeId => (await db.byLake('notes', lakeId)).find(n => n.kind === 'access') ?? null;
export const crewAccessNotes = async lakeId => (await db.byLake('crew', lakeId)).filter(r => r.kind === 'access');
// For the composer: every water's note of yours.
export const allAccessNotes = async () => (await db.all('notes')).filter(n => n.kind === 'access');

const signalText = sig => Object.entries(CARRIERS).filter(([k]) => sig?.[k]).map(([k, n]) => `${n}: ${SIGNAL[sig[k]] ?? sig[k]}`).join(' · ');
export const signalSummary = n => [signalText(n.signal), n.signalNote].filter(Boolean).join(' · ');

// One note, yours or a friend's, as a card.
export function noteCard(n, { mine = false } = {}) {
  const rows = [
    ['🚙', n.vehicle && VEHICLES[n.vehicle]], ['🛣️', n.road], ['🅿️', n.park], ['🛶', n.launch], ['🚧', n.gate],
    ['🔢', n.gateCode && (mine ? `Gate code: <a href="#" data-reveal="${esc(n.gateCode)}">tap to show</a>` : `Gate code: ${esc(n.gateCode)}`)],
    ['📶', signalSummary(n)],
  ].filter(([, v]) => v);
  return `<div class="card gt-note"><h3>${mine ? '📝 Your access notes' : `👥 From ${esc(n.from)}`}</h3>
    ${n.photo ? `<img class="gt-note-photo" src="${URL.createObjectURL(n.photo)}" alt="">` : ''}
    ${rows.map(([i, v]) => `<div class="small gt-note-row"><span>${i}</span><span>${i === '🔢' ? v : esc(v)}</span></div>`).join('')}
    <div class="muted small" style="margin-top:6px">${n.checked ? `Checked ${fmtDate(n.checked)}` : `Saved ${fmtDate(n.updatedAt ?? n.receivedAt)}`}${n.lat != null ? ` · <a href="#" data-park="${n.lat},${n.lon}">parking on the map</a>` : ''}
      ${mine ? ` · <a href="#" data-note-edit>edit</a> · <a href="#" data-note-share>share with your crew</a>` : ` · <a href="#" class="danger" data-crew-del="${esc(n.id)}">remove</a>`}</div></div>`;
}

export function wireNoteCards(el, { onEdit, onShare, onChange }) {
  el.querySelectorAll('[data-reveal]').forEach(a => a.onclick = e => { e.preventDefault(); a.replaceWith(document.createTextNode(a.dataset.reveal)); });
  el.querySelectorAll('[data-park]').forEach(a => a.onclick = e => {
    e.preventDefault();
    const [la, lo] = a.dataset.park.split(',').map(Number);
    showView('map'); map.setView([la, lo], 16); L.popup().setLatLng([la, lo]).setContent('Parking').openOn(map);
  });
  el.querySelector('[data-note-edit]')?.addEventListener('click', e => { e.preventDefault(); onEdit(); });
  el.querySelector('[data-note-share]')?.addEventListener('click', e => { e.preventDefault(); onShare(); });
  el.querySelectorAll('[data-crew-del]').forEach(a => a.onclick = async e => { e.preventDefault(); if (!confirm('Remove this shared note?')) return; await db.del('crew', a.dataset.crewDel); onChange(); });
}

// The form. `done` runs after a save (or cancel) to redraw the tab; `reopen` brings you back here after picking the
// parking spot on the map.
export function noteForm(el, lake, note, { done, reopen }) {
  const n = note ?? { kind: 'access', lakeId: lake.id, signal: {} };
  const opt = (map_, v) => `<option value=""></option>${Object.entries(map_).map(([k, l]) => `<option value="${k}" ${v === k ? 'selected' : ''}>${l}</option>`).join('')}`;
  el.innerHTML = `<form class="card form" id="gt-note-form"><h3>📝 Your access notes</h3>
    <p class="muted small">What it actually takes to get here. Kept on your phone, and in your backup; you choose when to share it with your crew.</p>
    <label>What it takes <select name="vehicle">${opt(VEHICLES, n.vehicle)}</select></label>
    <label>The road <input name="road" value="${esc(n.road)}" placeholder="Washboard past the cattle guard, fine for the Subaru"></label>
    <label>Where to park <input name="park" value="${esc(n.park)}" placeholder="Second pullout past the bridge"></label>
    <label>Launch / where to fish from <input name="launch" value="${esc(n.launch)}" placeholder="Rocky point on the north shore"></label>
    <label>Gates <input name="gate" value="${esc(n.gate)}" placeholder="Forest gate closes Nov 15"></label>
    <label>Gate code <input name="gateCode" value="${esc(n.gateCode)}" autocomplete="off"><span class="muted small">Only shared if you tick it when sharing.</span></label>
    <div class="small"><b>Cell signal here</b></div>
    <div class="row">${Object.entries(CARRIERS).map(([k, l]) => `<label style="flex:1">${l} <select name="sig-${k}">${opt(SIGNAL, n.signal?.[k])}</select></label>`).join('')}</div>
    <label>Signal note <input name="signalNote" value="${esc(n.signalNote)}" placeholder="One bar on the dam, none at the inlet"></label>
    <label>Last checked <input name="checked" type="date" value="${esc(n.checked ?? new Date().toISOString().slice(0, 10))}"></label>
    <label>Photo (the turn-off, the gate, the parking) <input name="photo" type="file" accept="image/*"></label>
    ${n.photo ? '<label class="check"><input type="checkbox" name="dropPhoto"> Remove the photo</label>' : ''}
    <div class="row"><button type="button" id="gt-note-pin">📍 ${n.lat != null ? 'Move' : 'Mark'} the parking spot</button><span class="muted small">${n.lat != null ? `${(+n.lat).toFixed(5)}, ${(+n.lon).toFixed(5)}` : ''}</span></div>
    <div class="row" style="margin-top:8px"><button class="primary" style="flex:1">Save</button><button type="button" id="gt-note-cancel" style="flex:1">Cancel</button></div>
    ${note ? '<a href="#" class="small danger" id="gt-note-del">Delete these notes</a>' : ''}</form>`;
  const form = el.querySelector('form');
  const collect = async () => {
    const f = new FormData(form), out = { ...n, signal: {} };
    for (const k of ACCESS_FIELDS) out[k] = String(f.get(k) ?? '').trim() || null;
    for (const k of Object.keys(CARRIERS)) if (f.get(`sig-${k}`)) out.signal[k] = f.get(`sig-${k}`);
    const file = f.get('photo');
    if (file?.size) out.photo = await shrinkPhoto(file, 1600);
    else if (f.get('dropPhoto')) out.photo = null;
    out.createdAt ??= new Date().toISOString();
    return out;
  };
  form.onsubmit = async e => { e.preventDefault(); await db.put('notes', await collect()); status('Access notes saved'); done(); };
  el.querySelector('#gt-note-cancel').onclick = done;
  el.querySelector('#gt-note-del')?.addEventListener('click', async e => { e.preventDefault(); if (!confirm('Delete your access notes for this water?')) return; await db.del('notes', n.id); done(); });
  el.querySelector('#gt-note-pin').onclick = async () => {
    const saved = await db.put('notes', await collect()); // keep what's typed while you're on the map
    showView('map'); map.setView([lake.lat, lake.lon], 15); status('Tap where you park');
    pickPoint(async ({ lat, lng }) => { await db.put('notes', { ...saved, lat, lon: lng }); reopen(); });
  };
}
