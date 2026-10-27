// Crew trips: the group plan page and editor, crew results, and "where should we camp?". See crew-plan.js.
import { db } from '../db.js';
import { $, esc, fmtDate, status, showView, onShow, emptyState } from '../ui.js';
import { map, pickPoint } from '../map.js';
import { saveFile } from '../backup.js';
import { localKey } from '../forecast.js';
import { fmtLen } from '../units.js';
import { fmtMi } from '../access-rules.js';
import { KIND_TEXT } from '../camping-rules.js';
import { lookupCamping } from '../camping.js';
import { LICENSE } from '../trip-rules.js';
import { directionsUrl } from './access.js';
import { openLake } from './lake.js';
import * as CP from '../crew-plan.js';

const link = (label, url) => `<a href="${esc(url)}" target="_blank" rel="noopener">${label} ↗</a>`;
const dayName = key => new Date(key + 'T12:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const dates = p => `${dayName(p.start)}${p.end && p.end !== p.start ? ` – ${dayName(p.end)}` : ''}`;
const plural = (n, w) => `${n} ${w}${n === 1 || w === 'fish' ? '' : 's'}`;
const states = opts => opts.map(s => CP.STATE_NAME[s] ?? s).join(' or ');
const top = (list, n = 3) => list.slice(0, n).map(([k, c]) => `${esc(k)}${c > 1 ? ` ×${c}` : ''}`).join(', ');
const MI_KEY = 'tackle-box-camp-miles';
let screen = null; // what's on the crew screen: ['home'] | ['plan', id] | ['where']

const lakesOf = async p => (await Promise.all((p.lakeIds ?? []).map(id => db.get('lakes', id)))).filter(Boolean);
const save = p => db.put('crewPlans', p);
function show(...s) { screen = s; showView('crewplan', { render: false }); window.scrollTo(0, 0); return $('#crewplan'); }

// ---------- Home: your crew plans ----------
export async function openCrewHome() {
  const el = show('home');
  const plans = (await db.all('crewPlans')).sort((a, b) => a.start.localeCompare(b.start));
  const today = localKey(), coming = plans.filter(p => (p.end ?? p.start) >= today), past = plans.filter(p => (p.end ?? p.start) < today).reverse();
  const card = p => `<div class="card cp-card" data-plan="${esc(p.id)}"><b>${esc(p.name || 'Crew trip')}</b><div class="small">${dates(p)} · ${plural(CP.live(p.members).length, 'person')}</div>
    <div class="muted small">${p.camp ? `⛺ ${esc(p.camp.name)}` : 'Camp not set'}${p.owner && p.owner !== CP.myName() ? ` · from ${esc(p.owner)}` : ''}</div></div>`;
  el.innerHTML = `<button id="cp-back">‹ Camp trips</button><h2 class="view-title">👥 Crew trips</h2>
    <p class="muted small">One plan for the whole crew: where you camp and meet, who brings what, and whether everyone has the right license. Send it by file or QR code; friends tick their part and send it back.</p>
    <div class="row cp-acts"><button id="cp-new" class="primary">+ New crew plan</button><button id="cp-where">🧭 Where should we camp?</button></div>
    ${coming.length ? coming.map(card).join('') : plans.length ? '' : emptyState('👥', 'No crew plans yet. Start one here, or from a camp trip’s page.')}
    ${past.length ? `<details><summary class="small muted">Past crew trips (${past.length})</summary>${past.map(card).join('')}</details>` : ''}`;
  $('#cp-back').onclick = () => import('./camp.js').then(m => m.renderCampHome());
  $('#cp-new').onclick = () => editPlan(CP.newPlan(), { fresh: true });
  $('#cp-where').onclick = () => openWhere();
  el.querySelectorAll('[data-plan]').forEach(c => c.onclick = () => openPlan(c.dataset.plan));
}

// From a camp trip's page: its crew plan, or a new one with the trip's dates, camp, waters and people.
export async function planForCampTrip(t) {
  const have = (await db.all('crewPlans')).find(p => p.campTripId === t.id);
  if (have) return openPlan(have.id);
  const p = CP.newPlan({ name: t.name, start: t.start, end: t.end ?? t.start, camp: t.camp && { ...t.camp }, lakeIds: [...(t.lakeIds ?? [])], campTripId: t.id });
  const at = new Date().toISOString();
  for (const n of (t.companions ?? '').split(/,|\band\b|&/).map(s => s.trim()).filter(Boolean))
    if (!p.members.some(m => m.name.toLowerCase() === n.toLowerCase())) p.members.push({ key: key(), name: n, age: 'adult', lic: {}, at });
  await save(p);
  openPlan(p.id);
}

// ---------- A plan ----------
export async function openPlan(id) {
  const p = await db.get('crewPlans', id);
  if (!p) return openCrewHome();
  const el = show('plan', id);
  const lakes = await lakesOf(p), needs = CP.licenseNeeds(lakes), lic = CP.licenseStatus(p, needs);
  const people = CP.live(p.members), gear = CP.live(p.gear), me = CP.myName().toLowerCase();
  const open = gear.filter(g => !g.who);
  const meet = p.meet ?? {};
  const meetWhen = meet.time ? new Date(meet.time).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  el.innerHTML = `<div class="lake-bar"><button id="cp-back" class="ghost">‹ Crew trips</button><button id="cp-edit">Edit</button></div>
    <h2>👥 ${esc(p.name || 'Crew trip')} <small>${dates(p)}</small></h2>
    <div class="row cp-chips">${needs.length ? `<span class="chip ${lic.ok === lic.people ? 'good' : 'bad'}">🪪 ${lic.ok} of ${lic.people} licensed</span>` : ''}
      ${gear.length ? `<span class="chip ${open.length ? 'ok' : 'good'}">🎒 ${open.length ? `${open.length} item${open.length > 1 ? 's' : ''} unclaimed` : 'all gear claimed'}</span>` : ''}</div>
    <div class="card"><h3>⛺ Camp</h3>${p.camp ? `<p class="small"><b>${esc(p.camp.name)}</b>${p.camp.kind && KIND_TEXT[p.camp.kind] ? ` <span class="muted">${esc(KIND_TEXT[p.camp.kind])}</span>` : ''}${p.site ? `<br>Site: <b>${esc(p.site)}</b>` : ''}</p>
        <p class="small">📍 ${p.camp.lat.toFixed(5)}, ${p.camp.lon.toFixed(5)} · ${link('Directions', directionsUrl(p.camp.lat, p.camp.lon))}${p.camp.recgovId ? ` · ${link('Recreation.gov', `https://www.recreation.gov/camping/campgrounds/${encodeURIComponent(p.camp.recgovId)}`)}` : ''}</p>`
      : `<p class="small muted">Not set yet. <a href="#" id="cp-where2">Where should we camp?</a></p>`}
      ${meet.text || meetWhen || Number.isFinite(meet.lat) ? `<h3>🤝 Meet up</h3><p class="small">${[meetWhen && `<b>${esc(meetWhen)}</b>`, meet.text && esc(meet.text)].filter(Boolean).join(' · ')}
        ${Number.isFinite(meet.lat) ? `<br>📍 ${meet.lat.toFixed(5)}, ${meet.lon.toFixed(5)} · ${link('Directions', directionsUrl(meet.lat, meet.lon))}` : ''}</p>` : ''}
      ${p.notes ? `<p class="small" style="white-space:pre-wrap">${esc(p.notes)}</p>` : ''}
      ${lakes.length ? `<p class="small">🎣 ${lakes.map(l => `<a href="#" data-lake="${esc(l.id)}">${esc(l.name)}</a>`).join(' · ')}</p>` : ''}</div>

    <div class="card"><h3>🪪 Who's coming and their licenses</h3>
      ${needs.length ? needs.map(n => `<p class="small">Fishing ${esc(n.waters.join(', '))} takes a <b>${esc(states(n.options))}</b> license.${n.notes.map(t => ` <span class="muted">${esc(t)}</span>`).join('')}</p>`).join('')
        : '<p class="small muted">Add the waters you’ll fish (Edit) to see which licenses everyone needs.</p>'}
      <div id="cp-people">${people.map(m => {
        const miss = CP.memberNeeds(m, needs), opts = [...new Set(needs.flatMap(n => n.options))];
        return `<div class="cp-person ${m.name.toLowerCase() === me ? 'cp-me' : ''}" data-m="${esc(m.key)}"><div class="cp-person-head"><b>${esc(m.name)}</b>
            <select data-age aria-label="Age of ${esc(m.name)}">${Object.entries(CP.AGES).map(([k, v]) => `<option value="${k}" ${m.age === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
          <div class="cp-lic">${opts.map(s => `<label class="check"><input type="checkbox" data-lic="${s}" ${m.lic?.[s] ? 'checked' : ''}> ${esc(CP.STATE_NAME[s] ?? s)}</label>`).join('')}
            <span class="small ${miss.length ? 'cp-bad' : 'cp-good'}">${!needs.length ? '' : miss.length ? `needs ${esc(miss.map(n => states(n.options)).join(' and '))}` : '✓ set'}</span></div>
          <a href="#" class="small danger" data-drop>remove</a></div>`; }).join('') || '<p class="small muted">Nobody yet.</p>'}</div>
      <form class="row cp-add" id="cp-add-person"><input name="name" placeholder="Add a name" required><button>Add</button></form>
      ${lic.missing.length && needs.length ? `<p class="small">${[...new Set(needs.flatMap(n => n.options))].filter(s => LICENSE[s]).map(s => `${link(`Buy ${CP.STATE_NAME[s]}`, LICENSE[s].buy)} <span class="muted">${esc(CP.SHORT_TERM[s] ?? '')} No license under ${LICENSE[s].age}.</span>`).join('<br>')}</p>` : ''}
      <p class="muted small">Tick a state once that person has bought (and saved) that license. Rules change: the agency has the final word.</p></div>

    <div class="card"><h3>🎒 Who brings what</h3>
      <div id="cp-gear">${gear.map(g => `<div class="cp-gear" data-g="${esc(g.key)}"><span class="cp-item">${esc(g.item)}</span>
        <select data-who aria-label="Who brings ${esc(g.item)}"><option value="">Nobody yet</option>${people.map(m => `<option ${g.who === m.name ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}${g.who && !people.some(m => m.name === g.who) ? `<option selected>${esc(g.who)}</option>` : ''}</select>
        <a href="#" class="danger small" data-drop-g aria-label="Remove ${esc(g.item)}">✕</a></div>`).join('') || '<p class="small muted">Nothing on the list yet.</p>'}</div>
      <form class="row cp-add" id="cp-add-gear"><input name="item" placeholder="Add an item" list="cp-gear-ideas" required><button>Add</button></form>
      <datalist id="cp-gear-ideas">${CP.GEAR_IDEAS.map(g => `<option value="${esc(g)}">`).join('')}</datalist></div>

    <div class="card"><h3>📤 Send to the crew</h3>
      <p class="small">Sends this plan (dates, camp and site, meet-up, people, gear and license ticks, and the waters) to a friend as a file or a QR code. That includes where you camp and meet, so send it only to the crew.
        When they send theirs back, each person’s line and each gear line keeps the newest change.</p>
      <div class="row"><button id="cp-file" class="primary" style="flex:1">Send as file</button><button id="cp-qr" style="flex:1">QR code</button></div>
      <button id="cp-cal" style="width:100%;margin-top:8px">📅 Meet-up and license check to my calendar</button>
      ${p.campTripId ? '<button id="cp-trip" style="width:100%;margin-top:8px">⛺ Open my camp trip</button>' : lakes.length && p.camp ? '<button id="cp-trip" style="width:100%;margin-top:8px">⛺ Make it my camp trip</button>' : ''}</div>

    <h2>🏆 Crew results</h2><div id="cp-results"><div class="card small muted">Counting…</div></div>
    <button id="cp-del" class="danger" style="width:100%;margin-top:12px">Delete this plan</button>`;

  $('#cp-back').onclick = openCrewHome;
  $('#cp-edit').onclick = () => editPlan(p);
  $('#cp-where2')?.addEventListener('click', e => { e.preventDefault(); openWhere({ plan: p.id }); });
  el.querySelectorAll('[data-lake]').forEach(a => a.onclick = e => { e.preventDefault(); openLake(a.dataset.lake); });
  const redraw = async () => { await save(p); openPlan(p.id); };
  const member = node => p.members.find(m => m.key === node.closest('[data-m]').dataset.m);
  el.querySelectorAll('[data-age]').forEach(s => s.onchange = () => { CP.touch(Object.assign(member(s), { age: s.value })); redraw(); });
  el.querySelectorAll('[data-lic]').forEach(b => b.onchange = () => { const m = member(b); m.lic = { ...m.lic, [b.dataset.lic]: b.checked }; if (!b.checked) delete m.lic[b.dataset.lic]; CP.touch(m); redraw(); });
  el.querySelectorAll('[data-drop]').forEach(a => a.onclick = e => { e.preventDefault(); const m = member(a); if (confirm(`Take ${m.name} off the plan?`)) { CP.touch(Object.assign(m, { gone: true })); redraw(); } });
  $('#cp-add-person').onsubmit = e => {
    e.preventDefault();
    const name = e.target.name.value.trim().slice(0, 60);
    if (!name) return;
    const back = p.members.find(m => m.gone && m.name.toLowerCase() === name.toLowerCase());
    if (back) CP.touch(Object.assign(back, { gone: undefined })); else p.members.push(CP.touch({ key: key(), name, age: 'adult', lic: {} }));
    redraw();
  };
  const item = node => p.gear.find(g => g.key === node.closest('[data-g]').dataset.g);
  el.querySelectorAll('[data-who]').forEach(s => s.onchange = () => { CP.touch(Object.assign(item(s), { who: s.value })); redraw(); });
  el.querySelectorAll('[data-drop-g]').forEach(a => a.onclick = e => { e.preventDefault(); CP.touch(Object.assign(item(a), { gone: true })); redraw(); });
  $('#cp-add-gear').onsubmit = e => {
    e.preventDefault();
    const it = e.target.item.value.trim().slice(0, 80);
    if (it) { p.gear.push(CP.touch({ key: key(), item: it, who: '' })); redraw(); }
  };
  const send = how => async () => {
    const crew = await import('../crew.js');
    if (!crew.myName()) return;
    const pack = await crew.planPack(p);
    crew.sendPack(pack, how).catch(e => alert(e.message));
  };
  $('#cp-file').onclick = send('file');
  $('#cp-qr').onclick = send('qr');
  $('#cp-cal').onclick = () => { const f = CP.planIcs(p, needs); f ? saveFile(f, { title: `${p.name}: crew` }) : alert('Add a meet-up time (Edit), or waters that need a license, first.'); };
  $('#cp-trip')?.addEventListener('click', () => toCampTrip(p));
  $('#cp-del').onclick = async () => { if (!confirm('Delete this plan from your phone? Friends keep their copies.')) return; await db.del('crewPlans', p.id); openCrewHome(); };
  drawResults(p, lakes, $('#cp-results'));
}
const key = () => Math.random().toString(36).slice(2, 12);

async function toCampTrip(p) {
  const { openCampTrip } = await import('./camp.js');
  if (p.campTripId && await db.get('campTrips', p.campTripId)) return openCampTrip(p.campTripId);
  const t = await db.put('campTrips', { name: p.name || p.camp.name, start: p.start, end: p.end, camp: { ...p.camp }, lakeIds: [...p.lakeIds], drives: [], companions: CP.live(p.members).map(m => m.name).filter(n => n !== CP.myName()).join(', '), notes: p.notes });
  p.campTripId = t.id; await save(p);
  openCampTrip(t.id, 'plan');
}

// The trip's results: everyone's fish at the plan's waters on its days, and what works on each water for all of you.
async function drawResults(p, lakes, box) {
  if (!lakes.length) { box.innerHTML = '<div class="card small muted">Add the waters you’ll fish to see the crew’s results.</div>'; return; }
  const fish = await CP.crewCatches(p.lakeIds, { from: p.start, to: p.end });
  const rows = CP.tallyByPerson(fish), started = localKey() >= p.start;
  const mine = fish.filter(c => c.mine);
  box.innerHTML = `<div class="card">${rows.length ? `<table class="cp-tally"><tr><th></th><th>Fish</th><th>Kept</th><th>Biggest</th></tr>${rows.map((r, i) => `<tr><td>${i === 0 && rows.length > 1 ? '🏆 ' : ''}<b>${esc(r.who)}</b><div class="muted small">${top(r.species, 2)}</div></td>
        <td>${r.fish}</td><td>${r.kept}</td><td class="small">${r.big ? `${fmtLen(r.big.length)} ${esc(r.big.species)}` : '–'}</td></tr>`).join('')}</table>`
      : `<p class="small muted">${started ? 'No fish logged on the trip yet.' : 'The trip hasn’t started.'} Your catches count on their own; friends’ show up once they share them with you.</p>`}
      ${mine.length ? `<button id="cp-send-fish" style="width:100%;margin-top:8px">📤 Send my ${plural(mine.length, 'catch')} from this trip</button>` : ''}
      <p class="muted small">Friends’ catches stay apart from your own stats and bests.</p></div>
    ${(await Promise.all(lakes.map(async l => worksCard(l, await CP.crewCatches([l.id]))))).join('')}`;
  $('#cp-send-fish')?.addEventListener('click', () => import('../crew.js').then(m => { showView('settings', { render: false }); m.openComposer({ catches: mine.map(c => c.id) }); }));
}

// "What works here for us": your fish and the crew's on one water, all time and this time of year.
export function worksCard(lake, fish, { title = `🎯 What works at ${esc(lake.name)} for us` } = {}) {
  const w = CP.whatWorks(fish);
  if (!w) return '';
  const part = { dawn: 'at dawn', dusk: 'at dusk', day: 'in the day', night: 'after dark' };
  const lines = s => [
    `<b>${plural(s.fish, 'fish')}</b> by ${esc(s.people.join(', '))}${s.parts.length ? `, most ${part[s.parts[0][0]]}` : ''}${s.months.length > 1 ? `; best months ${top(s.months, 3).replace(/ ×\d+/g, '')}` : ''}.`,
    s.lures.length && `Lures and baits: ${top(s.lures)}.`, s.techniques.length && `How: ${top(s.techniques)}.`,
    s.depth && `Depth: ${s.depth[0] === s.depth[1] ? `${s.depth[0]} ft` : `mostly ${s.depth[0]}–${s.depth[1]} ft`}.`, s.species.length && `Species: ${top(s.species, 4)}.`,
  ].filter(Boolean).map(l => `<p class="small">${l}</p>`).join('');
  return `<div class="card cp-works"><h3>${title}</h3>${w.season ? `<div class="cp-season"><div class="small"><b>This time of year</b> (a month either side of today)</div>${lines(w.season)}</div><div class="small muted">All year</div>` : ''}${lines(w.all)}</div>`;
}

// For the water's Crew tab.
export async function crewTabCards(lake) {
  const fish = await CP.crewCatches([lake.id]);
  if (!fish.some(c => !c.mine)) return '';
  const rows = CP.tallyByPerson(fish);
  return `<div class="card"><h3>🏆 Crew results here</h3>${rows.map(r => `<div class="small cp-row"><b>${esc(r.who)}</b> ${plural(r.fish, 'fish')}${r.big ? ` · biggest ${fmtLen(r.big.length)} ${esc(r.big.species)}` : ''}</div>`).join('')}</div>${worksCard(lake, fish)}`;
}

// ---------- Editor ----------
async function editPlan(p, { fresh = false, draft = null } = {}) {
  const el = show('plan', p.id);
  const d = draft ?? structuredClone(p);
  const lakes = (await db.all('lakes')).sort((a, b) => a.name.localeCompare(b.name));
  const { camps } = await CP.knownCamps();
  const near = Number.isFinite(d.camp?.lat) ? d.camp : null;
  const campList = camps.map((c, i) => ({ c, i, km: near ? CP_km(near, c) : null })).sort((a, b) => (a.km ?? 0) - (b.km ?? 0) || a.c.name.localeCompare(b.c.name)).slice(0, 150);
  el.innerHTML = `<button id="cp-cancel">‹ ${fresh ? 'Crew trips' : 'Back'}</button><h2>${fresh ? 'New crew plan' : 'Edit crew plan'}</h2>
    <form class="card form" id="cp-form">
      <label>Name <input name="name" value="${esc(d.name)}" placeholder="Opening weekend at Crowley"></label>
      <div class="row"><label>First day <input type="date" name="start" value="${esc(d.start)}" required></label><label>Last day <input type="date" name="end" value="${esc(d.end)}" required></label></div>
      <div class="label"><b>Camp</b></div><p class="small" id="cp-camp">${d.camp ? `⛺ <b>${esc(d.camp.name)}</b>` : '<span class="muted">Not set yet.</span>'}</p>
      ${campList.length ? `<label>Pick a camp <select name="camp"><option value="">–</option>${campList.map(x => `<option value="${x.i}">${esc(x.c.name)}${x.km != null ? ` · ${fmtMi(x.km)}` : ''}</option>`).join('')}</select></label>` : ''}
      <div class="row"><button type="button" id="cp-camp-map" style="flex:1">Pick camp on map</button>${d.camp ? '<button type="button" id="cp-camp-clear" style="flex:1">Clear</button>' : ''}</div>
      <label>Site or loop <input name="site" value="${esc(d.site)}" placeholder="Site 14, loop B"></label>
      <div class="label"><b>Meet up</b></div>
      <div class="row"><label>When <input type="datetime-local" name="meetTime" value="${esc(d.meet?.time)}"></label></div>
      <label>Where <input name="meetText" value="${esc(d.meet?.text)}" placeholder="Shell station in Lee Vining"></label>
      <p class="small" id="cp-meet">${Number.isFinite(d.meet?.lat) ? `📍 ${d.meet.lat.toFixed(5)}, ${d.meet.lon.toFixed(5)}` : ''}</p>
      <div class="row"><button type="button" id="cp-meet-map" style="flex:1">Pick meet-up on map</button>${Number.isFinite(d.meet?.lat) ? '<button type="button" id="cp-meet-clear" style="flex:1">Clear spot</button>' : ''}</div>
      <div class="label" style="margin-top:8px"><b>Waters</b></div>
      <div class="cp-waters">${lakes.map(l => `<label class="check"><input type="checkbox" name="lake" value="${esc(l.id)}" ${d.lakeIds.includes(l.id) ? 'checked' : ''}> ${esc(l.name)}${near ? ` <span class="muted small">${fmtMi(CP_km(near, l))}</span>` : ''}</label>`).join('') || '<p class="small muted">Save some waters first.</p>'}</div>
      <label>Notes <textarea name="notes" rows="2">${esc(d.notes)}</textarea></label>
      <button class="primary">Save</button></form>`;
  const form = $('#cp-form');
  const collect = () => ({ ...d, name: form.name.value.trim(), start: form.start.value, end: form.end.value, site: form.site.value.trim(), notes: form.notes.value.trim(),
    meet: { ...d.meet, time: form.meetTime.value, text: form.meetText.value.trim() }, lakeIds: [...form.querySelectorAll('[name=lake]:checked')].map(b => b.value) });
  form.start.onchange = () => { if (form.end.value < form.start.value) form.end.value = form.start.value; };
  form.camp?.addEventListener('change', () => { const c = camps[+form.camp.value]; if (!c || form.camp.value === '') return; const x = collect(); x.camp = { name: c.name, lat: c.lat, lon: c.lon, recgovId: c.recgovId ?? null, kind: c.kind ?? null }; if (!x.name) x.name = c.name; editPlan(p, { fresh, draft: x }); });
  const pickOn = (at, put) => () => {
    const x = collect();
    showView('map'); status('Tap the spot');
    if (Number.isFinite(at?.lat)) map.setView([at.lat, at.lon], 14);
    pickPoint(({ lat, lng }) => { put(x, +lat.toFixed(5), +lng.toFixed(5)); editPlan(p, { fresh, draft: x }); }, () => editPlan(p, { fresh, draft: x }));
  };
  $('#cp-camp-map').onclick = pickOn(d.camp, (x, lat, lon) => { x.camp = { name: x.camp?.name && !x.camp.recgovId ? x.camp.name : 'Our camp', lat, lon, kind: 'dispersed' }; });
  $('#cp-meet-map').onclick = pickOn(d.meet ?? d.camp, (x, lat, lon) => { x.meet = { ...x.meet, lat, lon }; });
  $('#cp-camp-clear')?.addEventListener('click', () => { const x = collect(); x.camp = null; editPlan(p, { fresh, draft: x }); });
  $('#cp-meet-clear')?.addEventListener('click', () => { const x = collect(); x.meet = { ...x.meet, lat: null, lon: null }; editPlan(p, { fresh, draft: x }); });
  $('#cp-cancel').onclick = () => fresh ? openCrewHome() : openPlan(p.id);
  form.onsubmit = async e => {
    e.preventDefault();
    const x = collect();
    if (x.end < x.start) return alert('The last day must be on or after the first.');
    if (!x.name) x.name = x.camp?.name ?? 'Crew trip';
    if (!x.members.length) { const crew = await import('../crew.js'); const me = crew.myName(); if (me) x.members.push(CP.touch({ key: key(), name: me, age: 'adult', lic: {} })); x.owner ||= me ?? ''; }
    x.headAt = new Date().toISOString();
    await save(x);
    openPlan(x.id);
  };
}
const CP_km = (a, b) => Math.hypot((a.lat - b.lat) * 111, (a.lon - b.lon) * 111 * Math.cos(a.lat * Math.PI / 180));

// ---------- Receiving a plan (from crew.js) ----------
export async function receivePlans(items, lakeIds, from) {
  let last = null;
  for (const it of items) {
    const theirs = CP.cleanPlan(it, lakeIds);
    if (!theirs) continue;
    const mine = await db.get('crewPlans', theirs.id);
    const row = CP.mergePlan(mine, theirs);
    if (!mine) row.from = String(from).slice(0, 60);
    await save(row);
    last = row.id;
  }
  if (last) openPlan(last);
}

// ---------- Where should we camp? ----------
export async function openWhere({ plan = null } = {}) {
  const el = show('where');
  let mi = 25;
  try { mi = +localStorage.getItem(MI_KEY) || 25; } catch {}
  el.innerHTML = `<button id="cp-back">‹ ${plan ? 'Crew plan' : 'Crew trips'}</button><h2 class="view-title">🧭 Where should we camp?</h2>
    <p class="muted small">Every camp this phone knows (the Camping tab of your saved waters, your campsites and the crew’s), ranked by the good waters within reach: recent and coming plants, the fish you and the crew have logged (more for this time of year) and your stars.</p>
    <form class="card form row" id="cp-mi"><label>Waters within <input type="number" name="mi" min="1" max="150" step="1" inputmode="numeric" value="${mi}"> miles</label><button class="primary">Rank</button></form>
    <p class="muted small">Straight-line miles, typed by you: no routing service sees where you’d camp. Mountain roads can take twice as long.</p>
    <div id="cp-areas"><div class="card small muted">Ranking…</div></div>`;
  $('#cp-back').onclick = () => plan ? openPlan(plan) : openCrewHome();
  $('#cp-mi').onsubmit = e => { e.preventDefault(); const v = Math.max(1, Math.min(150, +e.target.mi.value || 25)); try { localStorage.setItem(MI_KEY, v); } catch {} openWhere({ plan }); };
  const r = await CP.whereToCamp(mi * 1.609344);
  if (screen?.[0] !== 'where') return;
  const box = $('#cp-areas');
  box.innerHTML = `${r.areas.slice(0, 8).map((a, i) => `<div class="card cp-area"><h3>${i + 1}. Near ${esc(a.lake.name)} <span class="muted small">${plural(a.camps.length, 'camp')}</span></h3>
      <div class="small"><b>Waters in reach</b></div>${a.waters.slice(0, 5).map(w => `<div class="small cp-row"><a href="#" data-lake="${esc(w.lake.id)}">${esc(w.lake.name)}</a> <span class="muted">${fmtMi(w.km)}${w.reasons.length ? ` · ${esc(w.reasons.join(', '))}` : ''}</span></div>`).join('')}
      <div class="small" style="margin-top:6px"><b>Camps</b></div>${a.camps.slice(0, 4).map((c, j) => `<div class="small cp-row cp-camp-row"><span>⛺ ${esc(c.camp.name)} <span class="muted">${[c.camp.kind && KIND_TEXT[c.camp.kind], ...c.perks].filter(Boolean).map(esc).join(' · ')}</span></span>
        <span class="nowrap">${plan ? `<a href="#" data-use="${i}:${j}:plan">Use this</a>` : `<a href="#" data-use="${i}:${j}:crew">Crew plan</a> · <a href="#" data-use="${i}:${j}:camp">Camp trip</a>`}</span></div>`).join('')}</div>`).join('')
    || '<div class="card small">No camp this phone knows has a saved water within that distance. Try more miles, or look up camping for your waters below.</div>'}
    ${r.unchecked.length ? `<div class="card small">Camping not looked up yet for ${plural(r.unchecked.length, 'saved water')}${r.unchecked.length <= 6 ? ` (${esc(r.unchecked.map(l => l.name).join(', '))})` : ''}.
      <button id="cp-lookup" style="width:100%;margin-top:8px">Look up camping for ${r.unchecked.length > 10 ? 'the first 10' : 'them'} (needs signal)</button></div>` : ''}`;
  box.querySelectorAll('[data-lake]').forEach(a => a.onclick = e => { e.preventDefault(); openLake(a.dataset.lake); });
  box.querySelectorAll('[data-use]').forEach(a => a.onclick = async e => {
    e.preventDefault();
    const [i, j, how] = a.dataset.use.split(':'), area = r.areas[+i], c = area.camps[+j].camp;
    const camp = { name: c.name, lat: c.lat, lon: c.lon, recgovId: c.recgovId ?? null, kind: c.kind ?? null, lakeId: c.lakeId ?? null };
    const waters = area.camps[+j].reach.slice(0, 6).map(x => x.lake.id);
    if (plan) {
      const p = await db.get('crewPlans', plan);
      Object.assign(p, { camp, headAt: new Date().toISOString(), lakeIds: [...new Set([...(p.lakeIds ?? []), ...waters])] });
      await save(p); return openPlan(p.id);
    }
    if (how === 'crew') return editPlan(CP.newPlan({ name: c.name, camp, lakeIds: waters }), { fresh: true });
    (await import('./camp.js')).newTripAt(camp);
  });
  $('#cp-lookup')?.addEventListener('click', async e => {
    const b = e.target; b.disabled = true;
    let n = 0;
    for (const l of r.unchecked.slice(0, 10)) { b.textContent = `Looking up ${l.name} (${++n} of ${Math.min(10, r.unchecked.length)})…`; await lookupCamping(l).catch(() => null); }
    if (screen?.[0] === 'where') openWhere({ plan });
  });
}

onShow('crewplan', () => !screen || screen[0] === 'home' ? openCrewHome() : screen[0] === 'plan' ? openPlan(screen[1]) : openWhere());
