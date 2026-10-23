// Crew tab: catches and spots friends have shared with you on this water. Kept apart from your own log.
import { db } from '../../db.js';
import { esc, fmtDate } from '../../ui.js';
import { fmtLen, fmtWt, fmtDepth } from '../../units.js';
import { showCrewSpot, openComposer } from '../../crew.js';
import { openLake } from '../lake.js';

export async function renderCrew(lake, body) {
  const rows = (await db.byLake('crew', lake.id)).sort((a, b) => (b.time ?? b.receivedAt).localeCompare(a.time ?? a.receivedAt));
  body.innerHTML = `${rows.length ? rows.map(r => r.kind === 'catch'
      ? `<div class="card catch">${r.photo ? `<img src="${URL.createObjectURL(r.photo)}" alt="">` : ''}<div style="flex:1">
          <b>${esc(r.species)}</b> ${fmtLen(r.length)} ${r.weight ? fmtWt(r.weight) : r.weightEst ? '≈' + fmtWt(r.weightEst) : ''} <span class="muted small">from ${esc(r.from)}</span>
          <div class="muted small">${fmtDate(r.time)}${r.lat != null ? ` · <a href="#" data-spot="${esc(r.id)}">spot</a>` : ''}</div>
          <div class="small">${[r.lure, r.technique, r.depth != null && fmtDepth(r.depth), r.clarity && `${r.clarity} water`].filter(Boolean).map(esc).join(' · ')}</div>
          ${r.notes ? `<div class="small" style="white-space:pre-wrap">${esc(r.notes)}</div>` : ''}
          <a href="#" class="small danger" data-del="${r.id}">remove</a></div></div>`
      : `<div class="card"><b>📍 ${esc(r.name || r.type || 'Spot')}</b> <span class="muted small">from ${esc(r.from)} · <a href="#" data-spot="${r.id}">show on map</a> · <a href="#" class="danger" data-del="${r.id}">remove</a></span>
          ${r.text ? `<div class="small" style="white-space:pre-wrap">${esc(r.text)}</div>` : ''}</div>`).join('')
    : '<div class="card muted">Nothing from your crew here yet. When a friend shares catches or a spot with you, they show up on this tab.</div>'}
    <button id="crew-share-here" style="width:100%">👥 Share your catches or a spot from here</button>`;
  body.querySelectorAll('[data-spot]').forEach(a => a.onclick = e => { e.preventDefault(); showCrewSpot(rows.find(r => r.id === a.dataset.spot)); });
  body.querySelectorAll('[data-del]').forEach(a => a.onclick = async e => { e.preventDefault(); await db.del('crew', a.dataset.del); openLake(lake.id, 'crew'); });
  body.querySelector('#crew-share-here').onclick = () => openComposer();
}
