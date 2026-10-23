// Notes tab: your notes on this water, optionally pinned to a spot.
import { db } from '../../db.js';
import { $, esc, fmtDate, status, showView } from '../../ui.js';
import { map, pickPoint } from '../../map.js';
import { openLake } from '../lake.js';

export async function renderNotes(lake, body) {
  const notes = (await db.byLake('notes', lake.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  body.innerHTML = `<form class="card form" id="note-form"><label>New note <textarea name="text" rows="4" required placeholder="Weed edge on the north bay held fish at 12 ft…"></textarea></label>
    <div class="row"><button type="button" id="note-pin">📍 Pin to a spot</button><span id="note-loc" class="muted small"></span></div>
    <button class="primary" style="margin-top:8px">Save note</button></form>
    ${notes.map(n => `<div class="card"><div class="muted small">${fmtDate(n.createdAt)}${n.lat ? ` · <a href="#" data-goto="${n.lat},${n.lon}">spot</a>` : ''} · <a href="#" data-del="${n.id}">delete</a></div><div style="white-space:pre-wrap">${esc(n.text)}</div></div>`).join('')}`;
  let loc = null;
  $('#note-pin').onclick = () => {
    showView('map'); map.setView([lake.lat, lake.lon], 14); status('Tap the spot');
    pickPoint(({ lat, lng }) => { loc = { lat, lon: lng }; showView('lakes', { render: false }); $('#note-loc').textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`; });
  };
  $('#note-form').onsubmit = async e => {
    e.preventDefault();
    await db.put('notes', { lakeId: lake.id, text: e.target.text.value, createdAt: new Date().toISOString(), ...loc });
    openLake(lake.id, 'notes');
  };
  body.querySelectorAll('[data-del]').forEach(a => a.onclick = async e => { e.preventDefault(); await db.del('notes', a.dataset.del); openLake(lake.id, 'notes'); });
  body.querySelectorAll('[data-goto]').forEach(a => a.onclick = e => { e.preventDefault(); const [la, lo] = a.dataset.goto.split(','); showView('map'); map.setView([+la, +lo], 17); L.popup().setLatLng([+la, +lo]).setContent('Note spot').openOn(map); });
}
