// Camp trips: a multi-day trip from one base camp. The list of your camp trips and campsites, the trip editor, and
// each trip's page: the plan (a suggested water for every dawn and dusk), open sites for your nights, the log that
// spans the trip, the camp card (water, fire, food storage) and fish care and camp cooking. See camp-trip.js.
import { db } from '../db.js';
import { $, esc, fmtDate, status, showView, onShow, emptyState } from '../ui.js';
import { map, pickPoint } from '../map.js';
import { saveFile } from '../backup.js';
import { forecastAge, localKey, addDays } from '../forecast.js';
import { shortTime } from '../solunar.js';
import { haversineKm } from '../data-sources.js';
import { cached as campingCached } from '../camping.js';
import { KIND_TEXT } from '../camping-rules.js';
import { MANAGERS, fmtMi } from '../access-rules.js';
import { forestAlerts } from '../access-now.js';
import { directionsUrl } from './access.js';
import * as CT from '../camp-trip.js';
import { CARE, COOK, eatLine } from '../camp-cook.js';
import { myCampsites, crewCampsites, campsiteRow, wireCampsites, campsiteForm, refreshCampsiteLayer } from '../campsites.js';
import { openLake } from './lake.js';
import { startTripFlow, openTrip } from './trips.js';

const TABS = { plan: 'Plan', sites: 'Open sites', log: 'Trip log', card: 'Camp card', fish: 'Fish care' };
const link = (label, url) => `<a href="${esc(url)}" target="_blank" rel="noopener">${label} ↗</a>`;
const dayName = key => new Date(key + 'T12:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const plural = (n, w) => `${n} ${w}${n === 1 || w === 'fish' ? '' : 's'}`;
const ago = iso => { const m = Math.round((Date.now() - Date.parse(iso)) / 60e3); return m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };
let current = null; // { id, tab } of the trip page on screen

export function initCamp() { refreshCampsiteLayer(); }

// "Thu, Oct 29 – Sun, Nov 1 · 3 nights"
const datesText = t => { const n = CT.tripNights(t).length; return `${dayName(t.start)}${t.end && t.end !== t.start ? ` – ${dayName(t.end)}` : ''} · ${plural(n, 'night')}`; };
function whenText(t) {
  const d = CT.tripDay(t);
  if (d == null) return 'done';
  if (d >= 1) return `day ${d} of ${CT.dayKeys(t).length}`;
  const days = Math.round((Date.parse(t.start + 'T12:00') - Date.parse(localKey() + 'T12:00')) / 864e5);
  return days === 1 ? 'starts tomorrow' : `in ${days} days`;
}

// ---------- The list ----------
export async function renderCampHome() {
  current = null;
  showView('camp', { render: false });
  const el = $('#camp');
  const trips = (await db.all('campTrips')).sort((a, b) => a.start.localeCompare(b.start));
  const coming = trips.filter(t => CT.tripDay(t) != null), past = trips.filter(t => CT.tripDay(t) == null).reverse();
  const card = t => `<div class="card ct-trip" data-trip="${esc(t.id)}"><div class="ct-trip-head"><b>${esc(t.name || 'Camp trip')}</b><span class="chip ${CT.tripDay(t) >= 1 ? 'good' : 'ok'}">${whenText(t)}</span></div>
    <div class="small">${datesText(t)}</div><div class="muted small">⛺ ${esc(t.camp?.name || 'Camp not set')} · ${plural((t.lakeIds ?? []).length, 'water')}</div></div>`;
  el.innerHTML = `<button id="ct-back">‹ Today</button><h2 class="view-title">⛺ Camp trips</h2>
    <p class="muted small">A few days from one camp: a water for every dawn and dusk, open sites for your nights, one log for the whole trip, and the camp's water, fire and food rules saved for no signal.</p>
    <button id="ct-new" class="primary" style="width:100%">+ Plan a camp trip</button>
    <div class="row ct-acts"><button id="ct-crew">👥 Crew trips</button><button id="ct-where">🧭 Where should we camp?</button></div>
    <div style="margin-top:12px">${coming.length ? coming.map(card).join('') : trips.length ? '' : emptyState('⛺', 'No camp trips yet. Pick your dates and your camp, and the app lines up where to fish each morning and evening.')}</div>
    ${past.length ? `<details class="ct-past"><summary class="small muted">Past camp trips (${past.length})</summary>${past.map(card).join('')}</details>` : ''}
    <h2>🏕️ Your campsites</h2><div id="ct-sites"></div>`;
  $('#ct-back').onclick = () => showView('today');
  $('#ct-new').onclick = () => editTrip(null);
  $('#ct-crew').onclick = () => import('./crew-plan.js').then(m => m.openCrewHome());
  $('#ct-where').onclick = () => import('./crew-plan.js').then(m => m.openWhere());
  el.querySelectorAll('[data-trip]').forEach(c => c.onclick = () => openCampTrip(c.dataset.trip));
  drawCampsites($('#ct-sites'), { onDone: renderCampHome });
}

async function drawCampsites(box, { near = null, onDone, km = Infinity }) {
  const dist = s => near ? haversineKm(near.lat, near.lon, s.lat, s.lon) : null;
  const list = [...(await myCampsites()).map(s => ({ s, mine: true })), ...(await crewCampsites()).map(s => ({ s, mine: false }))]
    .map(x => ({ ...x, km: dist(x.s) })).filter(x => x.km == null || x.km <= km).sort((a, b) => (a.km ?? 0) - (b.km ?? 0) || (a.s.name ?? '').localeCompare(b.s.name ?? ''));
  box.innerHTML = `<div class="card">${list.length ? list.map(x => campsiteRow(x.s, { mine: x.mine, km: x.km, from: near ? 'camp' : null })).join('')
      : `<p class="small muted">${near ? 'None of your campsites are near this camp.' : 'Save the dispersed spots and sites you like: what fits, shade, wind and signal. They stay on your phone unless you share them.'}</p>`}
    <button id="ct-site-new" style="width:100%;margin-top:8px">+ Save a campsite</button></div>`;
  const edit = site => campsiteForm(box, site, { done: () => onDone(), reopen: draft => { showView('camp', { render: false }); edit(draft); } });
  box.querySelector('#ct-site-new').onclick = () => edit(null);
  wireCampsites(box, { onEdit: edit, onChange: () => onDone() });
}

// ---------- The editor ----------
// Next Thursday to Sunday, the usual long weekend.
function defaultDates() {
  const now = new Date(), thu = (4 - now.getDay() + 7) % 7 || 7;
  return [localKey(addDays(now, thu)), localKey(addDays(now, thu + 3))];
}

// Every camp the editor can offer: your campsites and friends', and the campgrounds in the Camping lookups on this phone.
async function campChoices() {
  const lakes = (await db.all('lakes')).sort((a, b) => a.name.localeCompare(b.name));
  const out = [...(await myCampsites()).map(s => ({ group: 'Your campsites', camp: { name: s.name || 'Campsite', lat: s.lat, lon: s.lon, campsiteId: s.id, kind: 'dispersed' } })),
    ...(await crewCampsites()).map(s => ({ group: 'Crew campsites', camp: { name: `${s.name || 'Campsite'} (${s.from})`, lat: s.lat, lon: s.lon, kind: 'dispersed' } }))];
  for (const l of lakes) {
    const d = await campingCached(l);
    for (const s of (d?.sites ?? []).slice(0, 25)) out.push({ group: `Near ${l.name}`, camp: { name: s.name, lat: s.lat, lon: s.lon, recgovId: s.recgovId ?? null, lakeId: l.id, kind: s.kind ?? null }, km: s.distKm });
    out.push({ group: `Near ${l.name}`, camp: { name: `At ${l.name}`, lat: l.lat, lon: l.lon, lakeId: l.id, kind: null } });
  }
  return out;
}

export async function newTripAt(camp) { return editTrip(null, { camp }); }

export async function editTrip(trip, { camp = null, draft = null } = {}) {
  current = null;
  showView('camp', { render: false });
  const el = $('#camp');
  const [s0, e0] = defaultDates();
  const t = draft ?? trip ?? { name: '', start: s0, end: e0, camp, lakeIds: null, drives: [], companions: '', notes: '' };
  const lakes = await db.all('lakes');
  const choices = await campChoices();
  const groups = [...new Set(choices.map(c => c.group))];
  el.innerHTML = `<button id="ct-cancel">‹ ${trip ? 'Back' : 'Camp trips'}</button><h2>${trip ? 'Edit camp trip' : 'Plan a camp trip'}</h2>
    <form class="card form" id="ct-form">
      <label>Name <input name="name" value="${esc(t.name)}" placeholder="Eastern Sierra long weekend"></label>
      <div class="row"><label>First day <input type="date" name="start" value="${esc(t.start)}" required></label><label>Last day <input type="date" name="end" value="${esc(t.end)}" required></label></div>
      <p class="muted small" id="ct-nights"></p>
      <div class="label"><b>Base camp</b></div>
      <p class="small" id="ct-camp"></p>
      ${choices.length ? `<label>Pick a camp <select name="campPick"><option value="">–</option>${groups.map(g => `<optgroup label="${esc(g)}">${choices.map((c, i) => c.group === g ? `<option value="${i}">${esc(c.camp.name)}${c.km != null ? ` · ${fmtMi(c.km)} from the water` : ''}</option>` : '').join('')}</optgroup>`).join('')}</select></label>` : ''}
      <div class="row"><button type="button" id="ct-here" style="flex:1">📍 I'm at camp</button><button type="button" id="ct-pick" style="flex:1">Pick on map</button></div>
      <p class="muted small">Campgrounds come from each saved water's Camping tab (open it once with signal). Where you camp stays on this phone: it is never sent anywhere.</p>
      <div class="label" style="margin-top:8px"><b>Waters to fish</b> <span class="muted small">and your drive from camp, in minutes</span></div>
      <div id="ct-waters"></div>
      <label>Who's coming <input name="companions" value="${esc(t.companions)}" placeholder="Names"></label>
      <label>Notes <textarea name="notes" rows="2">${esc(t.notes)}</textarea></label>
      <button class="primary">${trip ? 'Save' : 'Plan it'}</button>
      ${trip ? '<button type="button" id="ct-del" class="danger" style="width:100%;margin-top:8px">Delete camp trip</button>' : ''}
    </form>`;
  const form = $('#ct-form');
  let campNow = t.camp ? { ...t.camp } : null;
  const ticked = new Set(t.lakeIds ?? []);
  const typed = new Map((t.drives ?? []).map(d => [d.lakeId, d.min]));
  const nights = () => {
    const x = { start: form.start.value, end: form.end.value };
    $('#ct-nights').textContent = x.start && x.end && x.end >= x.start ? `${plural(CT.tripNights(x).length, 'night')} at camp: you fish the first evening, every dawn and dusk in between, and the last morning.` : 'The last day must be on or after the first.';
  };
  const collect = () => {
    for (const b of form.querySelectorAll('[name=lake]')) b.checked ? ticked.add(b.value) : ticked.delete(b.value);
    for (const i of form.querySelectorAll('[data-drive]')) { const v = i.value.trim(); v === '' ? typed.delete(i.dataset.drive) : typed.set(i.dataset.drive, Math.max(0, Math.round(+v))); }
    return { ...trip, name: form.name.value.trim(), start: form.start.value, end: form.end.value, camp: campNow, lakeIds: [...ticked].filter(id => lakes.some(l => l.id === id)),
      drives: [...typed].filter(([id, m]) => ticked.has(id) && Number.isFinite(m)).map(([lakeId, min]) => ({ lakeId, min })), companions: form.companions.value.trim(), notes: form.notes.value.trim() };
  };
  const drawWaters = () => {
    const near = Number.isFinite(campNow?.lat);
    const rows = lakes.map(l => ({ l, km: near ? haversineKm(campNow.lat, campNow.lon, l.lat, l.lon) : null })).sort((a, b) => (a.km ?? 0) - (b.km ?? 0) || a.l.name.localeCompare(b.l.name));
    // A new trip ticks the saved waters within about 25 miles of camp.
    if (t.lakeIds == null && !ticked.size && near) rows.filter(r => r.km <= 40).forEach(r => ticked.add(r.l.id));
    const est = l => CT.driveFor({ camp: campNow, drives: [] }, l);
    $('#ct-waters').innerHTML = rows.length ? rows.slice(0, 40).map(({ l, km }) => `<div class="ct-water"><label class="check"><input type="checkbox" name="lake" value="${esc(l.id)}" ${ticked.has(l.id) ? 'checked' : ''}>
        <span>${esc(l.name)}${l.favorite ? ' ★' : ''}${km != null ? ` <span class="muted small">${fmtMi(km)}</span>` : ''}</span></label>
        <input type="number" min="0" max="600" step="5" inputmode="numeric" data-drive="${esc(l.id)}" value="${typed.get(l.id) ?? ''}" placeholder="${est(l).min ?? 'min'}" aria-label="Drive minutes to ${esc(l.name)}"></div>`).join('')
      + `<p class="muted small">Blank drive times use a rough estimate from the distance (shown with ≈). Type the real one once you know it.</p>`
      : '<p class="small muted">Save the waters you want to fish first (tap one on the map, then Save).</p>';
  };
  const drawCamp = () => {
    $('#ct-camp').innerHTML = campNow ? `⛺ <b>${esc(campNow.name)}</b>${campNow.kind && KIND_TEXT[campNow.kind] ? ` <span class="muted">${esc(KIND_TEXT[campNow.kind])}</span>` : ''}` : '<span class="muted">Not set yet.</span>';
    drawWaters();
  };
  nights(); drawCamp();
  form.start.onchange = () => { if (form.end.value < form.start.value) form.end.value = form.start.value; nights(); };
  form.end.onchange = nights;
  form.campPick?.addEventListener('change', () => { const c = choices[+form.campPick.value]; if (!c || form.campPick.value === '') return; collect(); campNow = { ...c.camp }; if (!form.name.value.trim()) form.name.value = c.camp.name.replace(/^At /, ''); drawCamp(); });
  $('#ct-here').onclick = () => {
    $('#ct-camp').textContent = 'Finding you…';
    navigator.geolocation?.getCurrentPosition(p => { collect(); campNow = { name: campNow?.name && !campNow.lakeId ? campNow.name : 'My camp', lat: +p.coords.latitude.toFixed(5), lon: +p.coords.longitude.toFixed(5), kind: 'dispersed' }; drawCamp(); },
      () => { $('#ct-camp').textContent = 'No GPS fix: pick camp on the map instead.'; }, { enableHighAccuracy: true, timeout: 20e3, maximumAge: 60e3 });
  };
  $('#ct-pick').onclick = () => {
    const d = collect();
    showView('map'); status('Tap where you camp');
    if (Number.isFinite(campNow?.lat)) map.setView([campNow.lat, campNow.lon], 14);
    pickPoint(({ lat, lng }) => editTrip(trip, { draft: { ...d, camp: { name: campNow?.name && !campNow.lakeId ? campNow.name : 'My camp', lat: +lat.toFixed(5), lon: +lng.toFixed(5), kind: 'dispersed' } } }),
      () => editTrip(trip, { draft: d }));
  };
  $('#ct-cancel').onclick = () => trip ? openCampTrip(trip.id) : renderCampHome();
  $('#ct-del')?.addEventListener('click', async () => { if (!confirm('Delete this camp trip? Its fishing sessions and catches stay in your log.')) return; await db.del('campTrips', trip.id); renderCampHome(); });
  form.onsubmit = async e => {
    e.preventDefault();
    const row = collect();
    if (row.end < row.start) return alert('The last day must be on or after the first.');
    if (CT.dayKeys(row).length > 30) return alert('A camp trip can be up to 30 days.');
    if (!row.camp) return alert('Pick your base camp first.');
    if (!row.name) row.name = row.camp.name;
    const saved = await db.put('campTrips', row);
    openCampTrip(saved.id, 'plan');
  };
}

// ---------- A trip's page ----------
export async function openCampTrip(id, tab = current?.id === id ? current.tab : 'plan') {
  const t = await db.get('campTrips', id);
  if (!t) return renderCampHome();
  current = { id, tab };
  showView('camp', { render: false });
  const el = $('#camp');
  el.innerHTML = `<div class="lake-bar"><button id="ct-back" class="ghost">‹ Camp trips</button><button id="ct-edit">Edit</button></div>
    <h2>⛺ ${esc(t.name || 'Camp trip')} <small>${datesText(t)} · ${whenText(t)}</small></h2>
    <div class="small">Camp: <b>${esc(t.camp?.name ?? 'not set')}</b>${t.companions ? ` · with ${esc(t.companions)}` : ''}</div>
    <div class="row ct-acts"><button id="ct-ready" title="Save forecasts, maps and lookups for the trip's waters">📴 Ready for no signal</button><button id="ct-crew-plan">👥 Crew plan</button>${CT.tripDay(t) >= 1 ? '<button id="ct-session" class="primary">▶ Start a session</button>' : ''}</div>
    <div class="lake-tabs"><div class="tabs">${Object.entries(TABS).map(([k, l]) => `<button data-ct-tab="${k}" class="${k === tab ? 'active' : ''}">${l}</button>`).join('')}</div></div>
    <div id="ct-body"><p class="muted small">Loading…</p></div>`;
  $('#ct-back').onclick = renderCampHome;
  $('#ct-edit').onclick = () => editTrip(t);
  $('#ct-ready').onclick = () => import('../ready.js').then(m => m.readyDialog({ pick: t.lakeIds ?? [] }));
  $('#ct-session')?.addEventListener('click', () => startTripFlow());
  $('#ct-crew-plan').onclick = () => import('./crew-plan.js').then(m => m.planForCampTrip(t));
  el.querySelectorAll('[data-ct-tab]').forEach(b => b.onclick = () => openCampTrip(id, b.dataset.ctTab));
  const body = $('#ct-body');
  const draw = { plan: drawPlan, sites: drawSites, log: drawLog, card: drawCard, fish: drawFish }[tab] ?? drawPlan;
  try { await draw(t, body); } catch (e) { console.warn('camp trip:', e); body.innerHTML = `<div class="card small">Couldn't draw this part (${esc(e.message)}).</div>`; }
}
const stillOn = (t, tab) => current?.id === t.id && current?.tab === tab;

// ---------- Plan ----------
function workedCard(w, title) {
  if (!w) return '';
  const top = (list, n = 3) => list.slice(0, n).map(([k, c]) => `${esc(k)}${c > 1 ? ` ×${c}` : ''}`).join(', ');
  const part = { dawn: 'at dawn', dusk: 'at dusk', day: 'in the middle of the day', night: 'after dark' };
  const lines = w.fish ? [
    `<b>${plural(w.fish, 'fish')}</b>${w.kept ? ` (${w.kept} kept)` : ''}${w.waters.length ? `, best at <b>${esc(w.waters[0][0])}</b>${w.waters.length > 1 ? ` (${w.waters[0][1]} of ${w.fish})` : ''}` : ''}${w.parts.length ? `, mostly ${part[w.parts[0][0]]}` : ''}.`,
    w.lures.length && `Caught on: ${top(w.lures)}.`, w.techniques.length && `How: ${top(w.techniques)}.`,
    w.depth && `Depth ${w.depth[0] === w.depth[1] ? `${w.depth[0]} ft` : `${w.depth[0]}–${w.depth[1]} ft`}.`, w.species.length > 1 && `Species: ${top(w.species, 4)}.`,
  ] : [`No fish logged${w.fishedAt.length ? ` at ${esc(w.fishedAt.join(', '))}` : ''}${w.bites ? `, ${plural(w.bites, 'bite')}` : ''}. Worth trying a different water or time today.`];
  return `<div class="card ct-worked"><h3>${title}</h3>${lines.filter(Boolean).map(l => `<p class="small">${l}</p>`).join('')}</div>`;
}

async function drawPlan(t, body) {
  if (!(t.lakeIds ?? []).length) { body.innerHTML = `<div class="card small">Tick the waters you might fish from camp: <a href="#" id="ct-fix">edit the trip</a>.</div>`; $('#ct-fix').onclick = e => { e.preventDefault(); editTrip(t); }; return; }
  const today = localKey(), log = await CT.tripLog(t);
  const yesterday = localKey(addDays(Date.now(), -1));
  const worked = CT.tripDay(t) >= 2 ? workedCard(CT.workedOn(log, yesterday), '🌅 What worked yesterday') : '';
  body.innerHTML = `${worked}<div class="card muted small">Checking each water's forecast, bite windows and light…</div>`;
  const plan = await CT.planTrip(t);
  if (!stillOn(t, 'plan')) return;
  const saved = plan.weather.filter(x => x.w?.saved), missing = plan.weather.filter(x => !x.w);
  const lastWx = plan.lastWx;
  const session = s => {
    const p = s.pick;
    if (!p) return '';
    const others = s.rows.slice(1, 4);
    return `<div class="card ct-session ${p.to < Date.now() ? 'ct-done' : ''}"><div class="ct-session-head"><b>${s.part === 'dawn' ? '🌅' : '🌇'} ${CT.PARTS[s.part]}</b>
        <span class="muted small">${s.part === 'dawn' ? `first light ${shortTime(p.sun.dawn)} · sunrise ${shortTime(p.sun.sunrise)}` : `sunset ${shortTime(p.sun.sunset)} · last light ${shortTime(p.sun.dusk)}`}</span></div>
      <div class="ct-pick"><b>${esc(p.line)}</b></div>
      <div class="plan-head"><div class="chips" style="flex:1">${p.reasons.map(r => `<span class="chip ${r.tone}">${esc(r.text)}</span>`).join('')}</div>
        <div class="score"><b>${p.score.toFixed(1)}</b><div class="meter"><i style="width:${p.score * 10}%"></i></div></div></div>
      ${s.wx ? '' : `<p class="muted small">No forecast this far out yet: light and bite windows only.</p>`}
      ${others.length ? `<details><summary class="small muted">Other waters</summary>${others.map(o => `<div class="small ct-alt"><span>${esc(o.line)}</span><b>${o.score.toFixed(1)}</b></div>`).join('')}</details>` : ''}
      <div class="small"><a href="#" data-open-water="${esc(p.lake.id)}">${esc(p.lake.name)} page ›</a></div></div>`;
  };
  const days = [...new Set(plan.sessions.map(s => s.day))];
  const dayBlock = (d, i) => `<h3 class="ct-day">${dayName(d)}${d === today ? ' · today' : ''} <span class="muted small">day ${CT.dayKeys(t).indexOf(d) + 1}</span></h3>${plan.sessions.filter(s => s.day === d).map(session).join('')}`;
  const pastDays = days.filter(d => d < today), nextDays = days.filter(d => d >= today);
  body.innerHTML = `${worked}
    <p class="muted small">${[saved.length ? `📴 ${saved.map(x => `${esc(x.lake.name)}: ${forecastAge(x.w)}`).join(', ')}` : '', missing.length ? `No forecast for ${esc(missing.map(x => x.lake.name).join(', '))} (offline?).` : '',
      lastWx ? `Forecasts run to ${dayName(lastWx)}; days after that show light and bite windows only.` : ''].filter(Boolean).join(' ')}</p>
    ${nextDays.map(dayBlock).join('') || '<div class="card small">This trip is over. Its sessions are on the Trip log tab.</div>'}
    ${pastDays.length ? `<details><summary class="small muted">Earlier days</summary>${pastDays.map(dayBlock).join('')}</details>` : ''}
    ${nextDays.length ? `<div class="card"><h3>⏰ Alarms</h3><p class="small">Adds each session to your calendar at its suggested water, with an alarm when it's time to leave camp (your drive plus
      <select id="ct-lead"><option value="15">15</option><option value="30" selected>30</option><option value="45">45</option><option value="60">60</option></select> minutes to get going).
      Calendar alarms ring even with no signal. The forecast can change the pick, so make them again the night before.</p>
      <button id="ct-alarms" class="primary">📅 Add the plan to my calendar</button></div>` : ''}
    <p class="muted small">Each pick weighs the wind and rain at that water for those hours, bite windows (moon), light, recent plants, your drive and what you caught there earlier this trip. 5 is an ordinary session. Only each water's location is sent for its forecast; never the camp's.</p>`;
  body.querySelectorAll('[data-open-water]').forEach(a => a.onclick = e => { e.preventDefault(); openLake(a.dataset.openWater); });
  $('#ct-alarms')?.addEventListener('click', () => {
    const ev = CT.planAlarms(t, plan, { lead: +$('#ct-lead').value });
    if (!ev.length) return alert('No sessions left to add.');
    saveFile(CT.icsFile(ev, `${t.name || 'camp-trip'}-plan`), { title: `${t.name}: fishing plan` });
  });
}

// ---------- Open sites ----------
function siteText(r) {
  if (!r) return '<span class="muted">Not checked yet.</span>';
  if (r.error) return `Couldn’t check (${esc(r.error)}).`;
  const fresh = r.fresh?.length ? `<div>🆕 <b>New since you last looked:</b> ${esc(r.fresh.join(', '))}</div>` : '';
  const gone = r.gone ? `<div class="muted">${plural(r.gone, 'site')} taken since you last looked.</div>` : '';
  if (!r.total) return 'Recreation.gov lists no sites for these nights.';
  if (r.all) return `✅ <b>${r.all} of ${r.total} sites</b> open every night${r.some > r.all ? ` (${r.some - r.all} more for some nights)` : ''}.${r.open?.length && r.all <= 12 ? ` <span class="muted">${esc(r.open.map(s => s.label).join(', '))}</span>` : ''}${fresh}${gone}`;
  if (r.some) return `🟡 No site is open every night; ${r.some} for some of them: you’d have to move.${fresh}${gone}`;
  if (r.notReleased) return '⏳ Not released for booking yet.';
  if (r.firstCome) return 'First-come, first-served these nights.';
  if (r.closed) return 'Closed those nights.';
  return `⛔ Full${r.reserved < r.total ? ' or not bookable' : ''} for these nights.${gone}`;
}

async function drawSites(t, body) {
  const nights = CT.tripNights(t), camps = await CT.campgroundsNear(t);
  const opens = CT.bookingOpens(nights[0]);
  const res = t.sites?.nights?.join() === nights.join() ? t.sites : null;
  const near = Number.isFinite(t.camp?.lat) ? t.camp : null;
  const lakes = (await Promise.all((t.lakeIds ?? []).map(id => db.get('lakes', id)))).filter(Boolean);
  body.innerHTML = `<div class="card"><h3>📅 Open sites for your nights</h3>
      <p class="small">${nights.map(dayName).join(', ')} (${plural(nights.length, 'night')}).</p>
      ${opens > Date.now() ? `<p class="small">⏳ Most Recreation.gov campgrounds open bookings 6 months ahead at 7 am Pacific: for your first night that’s <b>${new Date(opens).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</b>. Some use a shorter window or a lottery; the campground’s page says which.</p>
        <button id="ct-bookday">⏰ Booking-day reminder</button>` : ''}
      ${camps.length ? `<button id="ct-check" class="primary" style="width:100%;margin-top:8px">Check ${camps.length > 1 ? `all ${Math.min(camps.length, 12)}` : 'it'} on Recreation.gov</button>
        <p class="muted small">${res ? `Checked ${ago(res.checkedAt)}. ` : ''}Only each campground’s id goes to Recreation.gov.</p>` : ''}</div>
    ${camps.length ? camps.map(c => `<div class="card ct-camp" data-camp="${esc(c.recgovId)}"><div class="ct-site-head"><b>${esc(c.name)}</b><span class="muted small nowrap">${c.recgovId === t.camp?.recgovId ? 'your camp' : near ? fmtMi(c.distKm) : ''}</span></div>
        <div class="small" data-camp-res>${siteText(res?.camps?.[c.recgovId])}</div>
        <div class="small">${[c.status === 'closed' && 'closed now', c.season && `season ${esc(c.season)}`].filter(Boolean).join(' · ')} ${c.bookUrl ? link('Book', c.bookUrl) : ''}</div></div>`).join('')
      : `<div class="card small">No reservable campground near camp is in the Camping lookups on this phone. Open the Camping tab of the waters near camp once with signal:
        ${lakes.map(l => `<a href="#" data-open-camping="${esc(l.id)}">${esc(l.name)}</a>`).join(' · ') || 'add waters to the trip first'}.</div>`}
    <h3>🏕️ Your campsites near camp</h3><div id="ct-near-sites"></div>`;
  body.querySelectorAll('[data-open-camping]').forEach(a => a.onclick = e => { e.preventDefault(); openLake(a.dataset.openCamping, 'camping'); });
  $('#ct-bookday')?.addEventListener('click', () => {
    const name = t.camp?.recgovId ? t.camp.name : camps[0]?.name ?? 'camp';
    saveFile(CT.icsFile([{ uid: `camp-${t.id}-booking`, start: opens, end: opens + 30 * 60e3, title: `Book ${name} for ${dayName(nights[0])}`, text: `Bookings for ${dayName(nights[0])} usually open now on Recreation.gov.${camps[0]?.bookUrl ? `\n${camps[0].bookUrl}` : ''}`, alarms: [24 * 60, 15] }], `${t.name}-booking-day`), { title: 'Booking-day reminder' });
  });
  $('#ct-check')?.addEventListener('click', async e => {
    e.target.disabled = true; e.target.textContent = 'Checking…';
    await CT.checkSites(t, camps.slice(0, 12), { onEach: (id, r) => { const box = body.querySelector(`[data-camp="${CSS.escape(id)}"] [data-camp-res]`); if (box) box.innerHTML = siteText(r); } });
    if (stillOn(t, 'sites')) openCampTrip(t.id, 'sites');
  });
  drawCampsites($('#ct-near-sites'), { near: near ?? lakes[0], km: 40, onDone: () => openCampTrip(t.id, 'sites') });
}

// ---------- Trip log ----------
async function drawLog(t, body) {
  const log = await CT.tripLog(t);
  const fish = log.catches.reduce((n, c) => n + (c.count ?? 1), 0);
  const days = CT.dayKeys(t);
  const name = id => log.lakeOf.get(id)?.name ?? 'Unknown water';
  const time = iso => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const today = localKey();
  body.innerHTML = `<div class="card grid"><div class="stat"><b>${fish}</b><span>Fish</span></div><div class="stat"><b>${log.sessions.length}</b><span>Sessions</span></div>
      <div class="stat"><b>${log.events.filter(e => e.kind === 'bite').length}</b><span>Bites</span></div><div class="stat"><b>${log.catches.filter(c => c.released === false).reduce((n, c) => n + (c.count ?? 1), 0)}</b><span>Kept</span></div></div>
    ${days.filter(d => d <= today).reverse().map(d => {
      const w = CT.workedOn(log, d), ses = log.sessions.filter(s => localKey(Date.parse(s.start)) === d);
      const loose = log.catches.filter(c => c.day === d && !c.tripId);
      return `<h3 class="ct-day">${dayName(d)} <span class="muted small">day ${days.indexOf(d) + 1}</span></h3>
        ${w ? workedCard(w, d === today ? 'Today so far' : 'What worked') : '<p class="small muted">Nothing logged.</p>'}
        ${ses.map(s => { const n = log.catches.filter(c => c.tripId === s.id).reduce((k, c) => k + (c.count ?? 1), 0); return `<div class="card small ct-sess" data-session="${esc(s.id)}"><b>${esc(name(s.lakeId))}</b>
          <span class="muted">${time(s.start)}${s.end ? `–${time(s.end)}` : ' · fishing now'}</span> · ${plural(n, 'fish')} ›</div>`; }).join('')}
        ${loose.length ? `<div class="card small">${loose.map(c => `🐟 ${esc(c.species)} <span class="muted">${esc(name(c.lakeId))} · ${time(c.time)}</span>`).join('<br>')}</div>` : ''}`;
    }).join('') || '<div class="card small muted">The trip hasn’t started yet. Sessions you fish in trip mode (and catches you log) at the trip’s waters show up here, day by day.</div>'}
    <p class="muted small">Sessions in trip mode and catches logged on the trip’s days, at its waters or within 50 miles of camp.</p>`;
  body.querySelectorAll('[data-session]').forEach(c => c.onclick = () => openTrip(c.dataset.session));
}

// ---------- Camp card ----------
async function drawCard(t, body) {
  const c = await CT.campCard(t);
  const s = c.site, camp = c.camp;
  const tapLine = s?.water === 'yes' ? '🚰 <b>Tap water at camp.</b> Taps are often shut off outside the season, so bring some anyway.'
    : `${s?.water === 'treat' ? '💧 <b>No tap water at camp: treat or filter your own.</b>' : s?.water === 'no' ? '🚱 <b>No drinking water at camp.</b>' : '💧 <b>No tap water recorded at camp.</b>'}
      ${c.tap ? ` Nearest tap: <b>${esc(c.tap.s.name)}</b>, ${fmtMi(c.tap.km)} away (if it’s in season).` : ' No campground with tap water is recorded nearby: bring enough, or filter and treat.'}`;
  const land = c.land?.rows ?? [];
  const fs = land.find(r => r.manager === 'USFS');
  const fireLines = [
    c.developed ? 'Campfires only in the campground’s fire rings or grills, and only when no fire restriction is in effect.' : 'Outside a developed campground, fire rules are stricter: many summers ban campfires (and sometimes stoves) entirely.',
    c.fire ? `${esc(c.fire.text)} ${c.fire.links.map(([l, u]) => link(l, u)).join(' · ')}` : '',
    fs && forestAlerts(fs.unit) ? link(`${esc(fs.unit)}: fire orders and closures`, forestAlerts(fs.unit)) : '',
    'Drown, stir and feel: a fire is out when the ashes are cold to the touch.',
  ].filter(Boolean);
  body.innerHTML = `<div class="card ct-cardcard"><h3>⛺ ${esc(camp.name ?? 'Camp')}</h3>
      <div class="small">${[camp.kind && KIND_TEXT[camp.kind], s?.operator].filter(Boolean).map(esc).join(' · ')}</div>
      ${Number.isFinite(camp.lat) ? `<div class="small">📍 ${camp.lat.toFixed(5)}, ${camp.lon.toFixed(5)} · ${link('Directions', directionsUrl(camp.lat, camp.lon))}</div>` : ''}
      ${s ? `<div class="small">${[s.toilets && { flush: '🚻 Flush toilets', vault: '🚻 Vault toilets', yes: '🚻 Toilets', no: 'No toilets' }[s.toilets], s.fee === 'no' ? 'No fee' : s.feeText ? esc(s.feeText) : '', s.stay && `Stay limit: ${esc(s.stay)}`, s.season && `Season: ${esc(s.season)}`, s.status === 'closed' && '⚠️ Closed now'].filter(Boolean).join(' · ')}</div>
        ${s.alert ? `<div class="small">⚠️ ${esc(s.alert)}</div>` : ''}` : ''}</div>
    <div class="card"><h3>🚰 Drinking water</h3><p class="small">${tapLine}</p>
      <p class="muted small">Lake and stream water needs treating: a filter rated for protozoa and bacteria, or a rolling boil for 1 minute (3 minutes above 6,500 ft).</p></div>
    <div class="card"><h3>🔥 Fire</h3>${fireLines.map(l => `<p class="small">${l}</p>`).join('')}</div>
    <div class="card"><h3>🐻 Food storage</h3>${c.food.map(r => `<p class="small"><b>${esc(r.text)}</b> ${link('Rules', r.url)}</p>`).join('')}
      <p class="small">${esc(c.bear)}</p><ul class="small">${CT.FOOD_HABITS.map(h => `<li>${esc(h)}</li>`).join('')}</ul></div>
    ${land.length ? `<div class="card"><h3>🏕️ The land around ${esc(c.landWater?.name ?? 'the water')}</h3>${land.slice(0, 3).map(r => `<p class="small"><b>${esc(MANAGERS[r.manager]?.name ?? r.manager ?? 'Unknown')}</b>${r.unit ? ` · ${esc(r.unit)}` : ''}<br>${esc(r.rule.text)}</p>`).join('')}</div>` : ''}
    <p class="muted small">${c.lookedUp ? `From the Camping lookups saved on this phone (${fmtDate(c.lookedUp)}), so it works with no signal.` : 'Open the Camping tab of the waters near camp once with signal and this card fills in.'}
      ${c.missing.length ? ` Not looked up yet: ${c.missing.map(l => `<a href="#" data-open-camping="${esc(l.id)}">${esc(l.name)}</a>`).join(', ')}.` : ''} A posted sign or a forest order always wins.</p>`;
  body.querySelectorAll('[data-open-camping]').forEach(a => a.onclick = e => { e.preventDefault(); openLake(a.dataset.openCamping, 'camping'); });
}

// ---------- Fish care and cooking ----------
async function drawFish(t, body) {
  const log = await CT.tripLog(t);
  const kept = log.catches.filter(c => c.released === false);
  const species = Object.entries(kept.reduce((m, c) => (m[c.species] = (m[c.species] ?? 0) + (c.count ?? 1), m), {})).sort((a, b) => b[1] - a[1]);
  const lakes = (await Promise.all((t.lakeIds ?? []).map(id => db.get('lakes', id)))).filter(Boolean);
  const section = (x, open) => `<details class="card ct-care" ${open ? 'open' : ''}><summary><b>${x.icon} ${esc(x.title)}</b>${x.for ? ` <span class="muted small">${esc(x.for)}</span>` : ''}</summary><ol class="small">${x.steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol></details>`;
  body.innerHTML = `${species.length ? `<div class="card small">🧊 In the cooler this trip: <b>${species.map(([s, n]) => `${esc(s)} ×${n}`).join(', ')}</b>. Eat the oldest first.</div>` : ''}
    <div class="card" id="ct-eat"><h3>🍽️ How often to eat fish from these waters</h3><p class="small muted">Checking the advisories saved with the app…</p></div>
    <h3>Fish care</h3>${CARE.map((x, i) => section(x, i === 0)).join('')}
    <h3>Camp cooking</h3>${COOK.map(x => section(x, false)).join('')}`;
  const lines = await Promise.all(lakes.map(async l => ({ l, e: await eatLine(l, species.map(([s]) => s)).catch(() => null) })));
  if (!stillOn(t, 'fish')) return;
  const serv = n => n === 0 ? 'don’t eat' : n == null ? '–' : `${n}/week`;
  $('#ct-eat').innerHTML = `<h3>🍽️ How often to eat fish from these waters</h3>${lines.map(({ l, e }) => `<p class="small"><b>${esc(l.name)}</b>: ${e ? `${e.site ? `site advisory${e.name ? ` (${esc(e.name)})` : ''}` : 'no site advisory; the statewide advice applies'}${e.match.length ? `<br>${e.match.map(r => `${esc(r[0])}: ${serv(r[1])} for women 18–49 and kids, ${serv(r[2])} for everyone else`).join('<br>')}` : ''}` : 'advice not downloaded yet'}
      · <a href="#" data-eat="${esc(l.id)}">Regs & safety tab</a></p>`).join('') || '<p class="small muted">Add waters to the trip to see their advice.</p>'}
    <p class="muted small">Servings per week of a hand-sized skinless fillet, from the state’s health agency. The water’s Regs & safety tab has the full table.</p>`;
  body.querySelectorAll('[data-eat]').forEach(a => a.onclick = e => { e.preventDefault(); openLake(a.dataset.eat, 'safety'); });
}

// ---------- Today: the trip you're on, or the next one ----------
export async function todayCamp(el) {
  if (!el) return;
  const trips = (await db.all('campTrips')).filter(t => { const d = CT.tripDay(t); return d >= 1 || (d === 0 && Date.parse(t.start + 'T00:00') - Date.now() < 10 * 864e5); }).sort((a, b) => a.start.localeCompare(b.start));
  const t = trips[0];
  if (!t) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.innerHTML = `<div class="ct-today"><b>⛺ ${esc(t.name || 'Camp trip')}</b> <span class="muted small">${whenText(t)}</span><div class="small" data-next>…</div><div class="small muted" data-worked></div></div>`;
  el.onclick = () => openCampTrip(t.id, 'plan');
  const plan = await CT.planTrip(t).catch(() => null);
  const next = plan?.sessions.find(s => s.pick && s.pick.to > Date.now());
  const when = s => s.day === localKey() ? (s.part === 'dawn' ? 'This morning' : 'This evening') : s.day === localKey(addDays(Date.now(), 1)) ? `Tomorrow ${s.part}` : `${dayName(s.day).split(',')[0]} ${s.part}`;
  el.querySelector('[data-next]').textContent = next ? `${when(next)}: ${next.pick.line}` : 'Plan the waters on the trip page.';
  if (CT.tripDay(t) >= 2 && plan) {
    const w = CT.workedOn(await CT.tripLog(t), localKey(addDays(Date.now(), -1)));
    if (w?.fish) el.querySelector('[data-worked]').textContent = `Yesterday: ${plural(w.fish, 'fish')}${w.waters[0] ? `, best at ${w.waters[0][0]}` : ''}${w.lures[0] ? ` on ${w.lures[0][0]}` : ''}.`;
  }
}

onShow('camp', () => current ? openCampTrip(current.id) : renderCampHome());
