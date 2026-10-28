// The Journal view: start a trip, a timeline of trips, catches and notes, personal bests, your tackle box,
// and adding old catches from photos.
import { db } from '../db.js';
import { $, esc, fmtDate, onShow, emptyState, fitTabs } from '../ui.js';
import { fmtLen } from '../units.js';
import { activeTrip, openTrip, startTripFlow, newEntry, closeStale } from './trips.js';
import { weightText } from './log.js';
import { openCatch } from './catch.js';
import { openLake } from './lake.js';
import { renderBests } from './bests.js';
import { renderTackle, tackleLabel } from './tackle.js';
import { renderBackfill } from './backfill.js';
import { renderStats } from './stats.js';
import { renderCalendar } from './calendar.js';
import { exportCatchesCsv } from '../catch-csv.js';
import { fishName } from '../species.js';

const SECTIONS = { timeline: 'Timeline', calendar: 'Calendar', stats: 'Stats', bests: 'Bests', tackle: 'Tackle box', photos: 'Photos' };
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
  fitTabs($('.tabs', el));
  const body = $('#j-body', el);
  if (section === 'timeline') return renderTimeline(body);
  if (section === 'calendar') return renderCalendar(body);
  if (section === 'stats') { body.innerHTML = '<div id="stats"></div>'; return renderStats(); }
  if (section === 'bests') return renderBests(body);
  if (section === 'tackle') return renderTackle(body);
  renderBackfill(body);
}

const dayKey = iso => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const hm = iso => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

// Search and filters: kept while the app is open. Species, kept/released and tags are about fish, so they show catches only.
const filt = { q: '', species: '', lakeId: '', kept: '', tag: '', from: '', to: '' };
const filtering = () => Object.values(filt).some(Boolean);
let filtersOpen = false;

async function renderTimeline(body, limitDays = 30) {
  const [trips, catches, notes, lakes, tackle] = await Promise.all([db.all('trips'), db.all('catches'), db.all('notes'), db.all('lakes'), db.all('tackle')]);
  const lakeName = Object.fromEntries(lakes.map(l => [l.id, l.name]));
  const tackleName = Object.fromEntries(tackle.map(t => [t.id, tackleLabel(t)]));
  // An unfinished trip that isn't the one running (e.g. restored from a backup) is closed at its last activity.
  const active = await activeTrip();
  for (const t of trips) if (!t.end && t.start && t.id !== active?.id) Object.assign(t, await closeStale(t));
  if (!body.isConnected) return; // the Journal was drawn again meanwhile (e.g. a second tap on its tab)
  const inTrip = new Set(trips.map(t => t.id));
  const fishIn = t => catches.filter(c => c.tripId === t.id);
  const species = [...new Set(catches.map(c => fishName(c.species)).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const waters = lakes.filter(l => catches.some(c => c.lakeId === l.id) || trips.some(t => t.lakeId === l.id) || notes.some(n => n.lakeId === l.id)).sort((a, b) => a.name.localeCompare(b.name));
  const tags = [...new Set(catches.flatMap(c => c.tags ?? []))].sort((a, b) => a.localeCompare(b));
  const opt = (v, label, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
  body.innerHTML = `<button id="j-new" style="width:100%;margin-bottom:12px">＋ Journal entry for a past day</button>
    <div class="j-search"><input type="search" id="j-q" placeholder="Search fish, lures, notes, waters" value="${esc(filt.q)}" enterkeyhint="search">
      <button id="j-filt" aria-expanded="${filtersOpen}">Filters</button></div>
    <form class="card form j-filters ${filtersOpen ? '' : 'hidden'}" id="j-filters">
      <div class="row"><label>Species <select name="species">${opt('', 'Any')}${species.map(x => opt(x, x, filt.species)).join('')}</select></label>
        <label>Water <select name="lakeId">${opt('', 'Any')}${waters.map(l => opt(l.id, l.name, filt.lakeId)).join('')}</select></label></div>
      <div class="row"><label>Kept or released <select name="kept">${opt('', 'Either')}${opt('kept', 'Kept', filt.kept)}${opt('released', 'Released', filt.kept)}</select></label>
        ${tags.length ? `<label>Tag <select name="tag">${opt('', 'Any')}${tags.map(t => opt(t, t, filt.tag)).join('')}</select></label>` : ''}</div>
      <div class="row"><label>From <input type="date" name="from" value="${esc(filt.from)}"></label><label>To <input type="date" name="to" value="${esc(filt.to)}"></label></div>
    </form>
    <div id="j-list"></div>`;
  const list = $('#j-list', body);

  const words = () => filt.q.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (...fields) => { const text = fields.filter(Boolean).join(' ').toLowerCase(); return words().every(w => text.includes(w)); };
  const inDates = iso => (!filt.from || dayKey(iso) >= filt.from) && (!filt.to || dayKey(iso) <= filt.to);
  const fishOnly = () => filt.species || filt.kept || filt.tag;
  const catchOk = c => (!filt.species || fishName(c.species) === filt.species) && (!filt.lakeId || c.lakeId === filt.lakeId)
    && (!filt.kept || (filt.kept === 'released') === !!c.released) && (!filt.tag || (c.tags ?? []).includes(filt.tag)) && inDates(c.time)
    && hit(c.species, c.lure, c.technique, c.notes, c.clarity, lakeName[c.lakeId], tackleName[c.tackleId], ...(c.tags ?? []));
  const tripOk = t => (!filt.lakeId || t.lakeId === filt.lakeId) && inDates(t.start)
    && hit(lakeName[t.lakeId], t.journal, t.companions, ...fishIn(t).flatMap(c => [c.species, c.lure]));
  const noteOk = n => (!filt.lakeId || n.lakeId === filt.lakeId) && inDates(n.createdAt) && hit(n.text, lakeName[n.lakeId]);

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
    if (x.c) return `<div class="tl-row" data-catch="${esc(x.c.id)}">🐟 <b>${esc(x.c.species)}</b> ${fmtLen(x.c.length)} ${weightText(x.c)} <span class="muted small">${esc(lakeName[x.c.lakeId] ?? '')} · ${hm(x.c.time)}${x.c.tripId && inTrip.has(x.c.tripId) ? ' · trip' : ''}${x.c.lure ? ` · ${esc(x.c.lure)}` : ''}</span>${x.c.photo ? ' <span class="ph-dot">📷</span>' : ''}</div>`;
    return `<div class="tl-row" data-note="${esc(x.n.lakeId)}">📝 <span class="small">${esc(x.n.text.slice(0, 140))}${x.n.text.length > 140 ? '…' : ''}</span> <span class="muted small">${esc(lakeName[x.n.lakeId] ?? '')}</span></div>`;
  };

  const draw = (limit = limitDays) => {
    const on = filtering();
    // Unfiltered, a trip's catches are inside its card. Filtered, every matching catch is listed, trip or not.
    const items = on ? [
      ...catches.filter(catchOk).map(c => ({ time: c.time, c })),
      ...(fishOnly() ? [] : trips.filter(tripOk).map(t => ({ time: t.start, trip: t }))),
      ...(fishOnly() ? [] : notes.filter(n => n.kind !== 'access' && typeof n.text === 'string' && noteOk(n)).map(n => ({ time: n.createdAt, n }))),
    ] : [
      ...trips.map(t => ({ time: t.start, trip: t })),
      ...catches.filter(c => !inTrip.has(c.tripId)).map(c => ({ time: c.time, c })),
      ...notes.filter(n => n.kind !== 'access').map(n => ({ time: n.createdAt, n })),
    ];
    const sorted = items.filter(x => typeof x.time === 'string').sort((a, b) => b.time.localeCompare(a.time));
    const days = [...new Set(sorted.map(x => dayKey(x.time)))];
    const n = k => sorted.filter(x => x[k]).length;
    const plural = (k, one, many) => { const v = n(k); return v ? `${v} ${v === 1 ? one : many}` : ''; };
    list.innerHTML = (on ? `<div class="j-count small"><span>${[plural('c', 'catch', 'catches'), plural('trip', 'trip', 'trips'), plural('n', 'note', 'notes')].filter(Boolean).join(' · ') || 'Nothing matches'}</span>${n('c') ? '<a href="#" id="j-csv">Export</a>' : ''}<a href="#" id="j-clear">Clear</a></div>` : '')
      + (days.length ? days.slice(0, limit).map(d => `<h2>${fmtDate(d + 'T12:00')}</h2>${sorted.filter(x => dayKey(x.time) === d).map(card).join('')}`).join('')
        : on ? '' : emptyState('📓', 'Your trips, catches and notes show up here, newest first.', ['🐟 Log a catch', 'log']))
      + (days.length > limit ? '<button id="j-more" style="width:100%">Show older</button>' : '');
    $('#j-more', list)?.addEventListener('click', () => draw(limit + 30));
    $('#j-csv', list)?.addEventListener('click', e => { e.preventDefault(); exportCatchesCsv(sorted.filter(x => x.c).map(x => x.c)).catch(err => alert(err.message)); });
    $('#j-clear', list)?.addEventListener('click', e => {
      e.preventDefault();
      Object.keys(filt).forEach(k => filt[k] = '');
      $('#j-q', body).value = ''; $('#j-filters', body).reset();
      $('#j-filters', body).querySelectorAll('select').forEach(s => s.value = '');
      markFilters(); draw();
    });
    list.querySelectorAll('[data-trip]').forEach(e => e.onclick = () => openTrip(e.dataset.trip));
    const ids = sorted.filter(x => x.c).map(x => x.c.id);
    list.querySelectorAll('[data-catch]').forEach(e => e.onclick = () => openCatch(e.dataset.catch, ids));
    list.querySelectorAll('[data-note]').forEach(e => e.onclick = () => openLake(e.dataset.note, 'notes'));
  };
  const markFilters = () => {
    const n = ['species', 'lakeId', 'kept', 'tag', 'from', 'to'].filter(k => filt[k]).length;
    const b = $('#j-filt', body);
    b.textContent = n ? `Filters (${n})` : 'Filters';
    b.classList.toggle('on', !!n);
  };
  $('#j-new', body).onclick = newEntry;
  $('#j-q', body).oninput = e => { filt.q = e.target.value.trim(); draw(); };
  $('#j-filt', body).onclick = e => { filtersOpen = !filtersOpen; $('#j-filters', body).classList.toggle('hidden', !filtersOpen); e.target.setAttribute('aria-expanded', filtersOpen); };
  $('#j-filters', body).onsubmit = e => e.preventDefault();
  $('#j-filters', body).onchange = e => { if (e.target.name in filt) { filt[e.target.name] = e.target.value; markFilters(); draw(); } };
  markFilters();
  draw();
}

onShow('journal', () => renderJournal());
