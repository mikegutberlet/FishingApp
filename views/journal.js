// The Journal view: start a trip, a timeline of trips, catches and notes, personal bests, your tackle box,
// and adding old catches from photos.
import { db } from '../db.js';
import { $, esc, fmtDate, onShow } from '../ui.js';
import { fmtLen } from '../units.js';
import { activeTrip, openTrip, startTripFlow, newEntry, closeStale } from './trips.js';
import { editCatch, weightText } from './log.js';
import { openLake } from './lake.js';
import { renderBests } from './bests.js';
import { renderTackle } from './tackle.js';
import { renderBackfill } from './backfill.js';

const SECTIONS = { timeline: 'Timeline', bests: 'Bests', tackle: 'Tackle box', photos: 'Photos' };
let section = 'timeline';

export async function renderJournal(which = section) {
  section = which;
  const trip = await activeTrip();
  const el = $('#journal');
  el.innerHTML = `${trip ? '<button class="trip-cta live" id="j-trip">● Trip in progress: open trip mode</button>' : '<button class="trip-cta" id="j-trip">▶ Start a trip</button>'}
    <div class="tabs">${Object.entries(SECTIONS).map(([k, v]) => `<button data-sec="${k}" class="${k === section ? 'active' : ''}">${v}</button>`).join('')}</div>
    <div id="j-body"></div>`;
  $('#j-trip', el).onclick = () => trip ? openTrip(trip.id) : startTripFlow();
  el.querySelectorAll('[data-sec]').forEach(b => b.onclick = () => renderJournal(b.dataset.sec));
  const body = $('#j-body', el);
  if (section === 'timeline') return renderTimeline(body);
  if (section === 'bests') return renderBests(body);
  if (section === 'tackle') return renderTackle(body);
  renderBackfill(body);
}

const dayKey = iso => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const hm = iso => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

async function renderTimeline(body, limitDays = 30) {
  const [trips, catches, notes, lakes] = await Promise.all([db.all('trips'), db.all('catches'), db.all('notes'), db.all('lakes')]);
  const lakeName = Object.fromEntries(lakes.map(l => [l.id, l.name]));
  // An unfinished trip that isn't the one running (e.g. restored from a backup) is closed at its last activity.
  const active = await activeTrip();
  for (const t of trips) if (!t.end && t.start && t.id !== active?.id) Object.assign(t, await closeStale(t));
  if (!body.isConnected) return; // the Journal was drawn again meanwhile (e.g. a second tap on its tab)
  const inTrip = new Set(trips.map(t => t.id));
  const items = [
    ...trips.map(t => ({ time: t.start, trip: t })),
    ...catches.filter(c => !inTrip.has(c.tripId)).map(c => ({ time: c.time, c })),
    ...notes.filter(n => n.kind !== 'access').map(n => ({ time: n.createdAt, n })),
  ].filter(x => typeof x.time === 'string').sort((a, b) => b.time.localeCompare(a.time));
  const days = [...new Set(items.map(x => dayKey(x.time)))];
  const fishIn = t => catches.filter(c => c.tripId === t.id);
  const card = x => {
    if (x.trip) {
      const t = x.trip, fish = fishIn(t);
      const species = Object.entries(fish.reduce((m, c) => (m[c.species] = (m[c.species] || 0) + 1, m), {})).map(([s, n]) => `${esc(s)} ×${n}`).join(', ');
      return `<div class="card tl-trip" data-trip="${esc(t.id)}"><div class="row"><b style="flex:1">${t.end ? '🎣' : '●'} ${esc(lakeName[t.lakeId] ?? 'Trip')}</b>${t.rating ? `<span class="stars-ro">${'★'.repeat(t.rating)}</span>` : ''}</div>
        <div class="muted small">${hm(t.start)}${t.end ? `–${hm(t.end)}` : ' · in progress'} · ${fish.length} fish${t.companions ? ` · with ${esc(t.companions)}` : ''}</div>
        ${species ? `<div class="small">${species}</div>` : ''}
        ${t.journal ? `<div class="small tl-text">${esc(t.journal)}</div>` : ''}
        ${t.photos?.length ? `<div class="photos">${t.photos.slice(0, 4).map(p => `<span class="ph"><img src="${URL.createObjectURL(p)}" alt=""></span>`).join('')}</div>` : ''}</div>`;
    }
    if (x.c) return `<div class="tl-row" data-catch="${esc(x.c.id)}">🐟 <b>${esc(x.c.species)}</b> ${fmtLen(x.c.length)} ${weightText(x.c)} <span class="muted small">${esc(lakeName[x.c.lakeId] ?? '')} · ${hm(x.c.time)}</span></div>`;
    return `<div class="tl-row" data-note="${esc(x.n.lakeId)}">📝 <span class="small">${esc(x.n.text.slice(0, 140))}${x.n.text.length > 140 ? '…' : ''}</span> <span class="muted small">${esc(lakeName[x.n.lakeId] ?? '')}</span></div>`;
  };
  body.innerHTML = `<button id="j-new" style="width:100%;margin-bottom:12px">＋ Journal entry for a past day</button>`
    + (days.length ? days.slice(0, limitDays).map(d => `<h2>${fmtDate(d + 'T12:00')}</h2>${items.filter(x => dayKey(x.time) === d).map(card).join('')}`).join('')
      : '<div class="card muted">Your trips, catches and notes show up here, newest first.</div>')
    + (days.length > limitDays ? '<button id="j-more" style="width:100%">Show older</button>' : '');
  $('#j-new', body).onclick = newEntry;
  $('#j-more', body)?.addEventListener('click', () => renderTimeline(body, limitDays + 30));
  body.querySelectorAll('[data-trip]').forEach(e => e.onclick = () => openTrip(e.dataset.trip));
  body.querySelectorAll('[data-catch]').forEach(e => e.onclick = () => editCatch(e.dataset.catch));
  body.querySelectorAll('[data-note]').forEach(e => e.onclick = () => openLake(e.dataset.note, 'notes'));
}

onShow('journal', () => renderJournal());
