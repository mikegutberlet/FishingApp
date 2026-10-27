// Someone knows where I am: leave a plan with someone at home (a ready-made text plus a calendar alarm that rings on
// their phone if you're late), check in with one tap, find your way back to the truck, and an SOS card that works
// with no signal. Everything is kept on this phone; nothing is sent unless you tap Send and pick who gets it.
import { db, uid } from '../db.js';
import { $, esc, status, showView, onShow } from '../ui.js';
import { haversineKm } from '../data-sources.js';
import { stateAt } from '../states/index.js';
import { pickPoint, map } from '../map.js';
import { units } from '../units.js';
import { fmtDD, allFormats, fmtUsng, bearing, compass8 } from '../coords.js';
import { sunTimes } from '../sun.js';
import { sendIcs } from '../ics.js';
import { helpAt, keepHelp, telHref } from '../help.js';
import { lastSignal, noteFix } from '../signal.js';
import { allAccessNotes, signalSummary } from '../access-notes.js';
import { fmtMins } from '../access-rules.js';

const PLAN = 'tackle-box-plan', PREFS = 'tackle-box-plan-prefs', TRUCK = 'tackle-box-truck';
const read = k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const write = (k, v) => v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v));
export const currentPlan = () => { const p = read(PLAN); return p?.status === 'out' ? p : null; };
const prefs = () => ({ grace: 60, remind: 60, ...read(PREFS) });
export const truckSpot = () => read(TRUCK);

// ---------- Formatting ----------
const clock = ms => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const when = ms => sameDay(ms, Date.now()) ? clock(ms) : `${new Date(ms).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} ${clock(ms)}`;
const metric = () => units().depth === 'm';
const fmtDist = km => metric() ? (km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(km < 10 ? 1 : 0)} km`)
  : km * 0.621371 < 0.2 ? `${Math.round(km * 3280.84)} ft` : `${(km * 0.621371).toFixed(km * 0.621371 < 10 ? 1 : 0)} mi`;
const fmtElev = m => metric() ? `${Math.round(m)} m` : `${Math.round(m * 3.28084).toLocaleString()} ft`;
const mapLink = (lat, lon) => `https://maps.google.com/?q=${(+lat).toFixed(5)},${(+lon).toFixed(5)}`;
const localInput = ms => { const d = new Date(ms); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const smsHref = (phone, body) => `sms:${String(phone ?? '').replace(/[^\d+]/g, '')}?&body=${encodeURIComponent(body)}`;
const callBy = p => Date.parse(p.backBy) + (p.grace ?? 60) * 6e4;
const graceText = m => m < 60 ? `${m} minutes` : m === 60 ? 'an hour' : `${m / 60} hours`;

// ---------- The plan text and its alarm ----------
export function planText(p) {
  const sheriff = p.help?.sheriff;
  const lines = [
    `Fishing plan${p.myName ? ` from ${p.myName}` : ''}`,
    `Where: ${p.water}${p.county ? `, ${p.county} County` : ''}${p.state ? `, ${p.state}` : ''}${p.lat != null ? ` (${fmtDD(p.lat, p.lon)}) ${mapLink(p.lat, p.lon)}` : ''}`,
    p.who && `With: ${p.who}`,
    `Leaving: ${when(Date.parse(p.leave))}`,
    `Back by: ${when(Date.parse(p.backBy))}`,
    (p.vehicle || p.truckNote || p.truck) && `Vehicle: ${[p.vehicle, p.truckNote && `parked ${p.truckNote}`].filter(Boolean).join(', ')}${p.truck ? ` (${fmtDD(p.truck.lat, p.truck.lon)}) ${mapLink(p.truck.lat, p.truck.lon)}` : ''}`,
    p.signal && `Phone signal there: ${p.signal}`,
    p.notes && `Plans: ${p.notes}`,
    ' ',
    `If you haven't heard from me by ${when(callBy(p))}, call ${sheriff?.phone ? `the ${sheriff.county} County Sheriff at ${sheriff.phone}` : p.county ? `911 and ask for the ${p.county} County Sheriff` : '911'} and read them this message.`,
  ];
  return lines.filter(Boolean).map(l => l.trim()).join('\n');
}

const alarmEvents = p => [{
  uid: `plan-${p.id}`, sequence: p.seq ?? 0, start: callBy(p), end: callBy(p) + 30 * 6e4,
  summary: `Check on ${p.myName || 'your fishing partner'}: no word from ${p.water}?`,
  description: `${p.myName || 'They'} planned to be back by ${when(Date.parse(p.backBy))}. If you haven't heard, try calling first, then follow the plan below.\n\n${planText(p)}`,
  location: p.lat != null ? `${p.water} (${fmtDD(p.lat, p.lon)})` : p.water,
  alarms: [0, -30],
}];
const myEvents = p => [{
  uid: `plan-${p.id}-me`, sequence: p.seq ?? 0, start: Date.parse(p.backBy) - (p.remind ?? 60) * 6e4, end: Date.parse(p.backBy),
  summary: `Head back: ${p.myName ? `${p.myName}, ` : ''}you're due back by ${clock(Date.parse(p.backBy))}`,
  description: `Your plan with ${p.contactName || 'home'}: back by ${when(Date.parse(p.backBy))}; they start calling for help at ${when(callBy(p))}.`,
  alarms: [0],
}];
const sendAlarm = p => sendIcs(`Late-alarm-${p.water}.ics`, alarmEvents(p), { title: 'Late alarm', text: `If I'm not back from ${p.water}, this rings at ${when(callBy(p))}.` });
const sendMine = p => sendIcs(`Head-back-${p.water}.ics`, myEvents(p), { title: 'Head back alarm' });

// ---------- Check-in texts ----------
function checkText(p, kind, { spot = null, late = null } = {}) {
  const at = spot ? ` I'm at ${fmtDD(spot.lat, spot.lon)} ${mapLink(spot.lat, spot.lon)}` : '';
  if (kind === 'ok') return `All good at ${p.water}, ${clock(Date.now())}. Still back by ${when(Date.parse(p.backBy))}.${at}`;
  if (kind === 'back') return `I'm back from ${p.water}, ${clock(Date.now())}. All good. You can delete the late alarm.`;
  return `Running late at ${p.water}, all OK. New back-by: ${when(late)}. I'll check in again.${at} (Updated late alarm attached if I could send it.)`;
}

let spotForText = null;
async function hereNow(timeout = 8000) {
  return new Promise(res => navigator.geolocation ? navigator.geolocation.getCurrentPosition(
    p => res({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy, alt: p.coords.altitude, time: p.timestamp }),
    () => res(null), { enableHighAccuracy: true, timeout, maximumAge: 60e3 }) : res(null));
}

// ---------- The page ----------
let tab = 'plan';
export async function openWhere(which = 'plan', opts = {}) {
  tab = which;
  showView('where', { render: false });
  render(opts);
}
onShow('where', () => render());

async function render(opts = {}) {
  stopWatch();
  const el = $('#where');
  el.innerHTML = `<div class="wh-tabs" role="tablist">${[['plan', '📨 Plan & check in'], ['truck', '🚙 Truck'], ['sos', '🆘 SOS']].map(([k, l]) =>
    `<button role="tab" data-wh="${k}" class="${k === tab ? 'active' : ''}" aria-selected="${k === tab}">${l}</button>`).join('')}</div><div id="wh-body"></div>`;
  el.querySelectorAll('[data-wh]').forEach(b => b.onclick = () => { tab = b.dataset.wh; render(); });
  const body = $('#wh-body');
  if (tab === 'plan') return currentPlan() && !opts.edit ? renderActive(body) : renderPlanForm(body, opts);
  if (tab === 'truck') return renderTruck(body);
  return renderSos(body);
}

// ---------- Plan form ----------
async function renderPlanForm(body, { lakeId = null, edit = false } = {}) {
  const pr = prefs(), old = edit ? currentPlan() : null;
  const lakes = (await db.all('lakes')).sort((a, b) => a.name.localeCompare(b.name));
  const tripLake = (await db.get('trips', localStorage.getItem('tackle-box-active-trip') ?? ''))?.lakeId;
  const pick = old?.lakeId ?? lakeId ?? tripLake ?? lakes.find(l => l.favorite)?.id ?? (lakes.length === 1 ? lakes[0].id : '');
  const start = old ? Date.parse(old.leave) : Date.now();
  const back = old ? Date.parse(old.backBy) : (() => { const d = new Date(Date.now() + 8 * 36e5); d.setMinutes(0, 0, 0); return d.getTime(); })();
  const opt = (v, cur, label) => `<option value="${v}" ${+cur === v ? 'selected' : ''}>${label}</option>`;
  body.innerHTML = `<form class="card form" id="wh-plan">
    <h3>Leave a plan</h3>
    <p class="muted small">Someone at home gets where you're going, who's with you, where the truck is and when you'll be back,
      plus a calendar alarm that rings on their phone if you're late. You send it from your own Messages; this app keeps a copy on this phone only.</p>
    <label>Your name <input name="myName" value="${esc(old?.myName ?? pr.myName ?? '')}" autocomplete="given-name" placeholder="So they know who it's from"></label>
    <label>Where <select name="lakeId">${lakes.map(l => `<option value="${esc(l.id)}" ${l.id === pick ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}<option value="" ${pick ? '' : 'selected'}>Somewhere else…</option></select></label>
    <label id="wh-where-other" class="${pick ? 'hidden' : ''}">Place <input name="water" value="${esc(old && !old.lakeId ? old.water : '')}" placeholder="Upper Kern, above the bridge"></label>
    <label>Who's with you <input name="who" value="${esc(old?.who ?? '')}" placeholder="Just me / Dave and Sam"></label>
    <label>Vehicle <input name="vehicle" value="${esc(old?.vehicle ?? pr.vehicle ?? '')}" placeholder="White Tacoma, plate 8ABC123"></label>
    <label>Where you'll park <input name="truckNote" value="${esc(old?.truckNote ?? '')}" placeholder="Pullout past the bridge"></label>
    <label class="check"><input type="checkbox" name="withTruck" ${old?.truck || (!old && truckSpot()) ? 'checked' : ''}> <span>Add the truck's map spot <span class="muted small" id="wh-truck-src"></span></span></label>
    <div class="row"><label>Leaving <input type="datetime-local" name="leave" required value="${localInput(start)}"></label>
      <label>Back by <input type="datetime-local" name="backBy" required value="${localInput(back)}"></label></div>
    <label>Call for help if there's no word <select name="grace">${[30, 60, 120, 180].map(m => opt(m, old?.grace ?? pr.grace, `${graceText(m)} after that`)).join('')}</select></label>
    <div class="row"><label>Who at home <input name="contactName" value="${esc(old?.contactName ?? pr.contactName ?? '')}" placeholder="Name"></label>
      <label>Their mobile <input name="contactPhone" type="tel" value="${esc(old?.contactPhone ?? pr.contactPhone ?? '')}" placeholder="(555) 555-0100" autocomplete="off"></label></div>
    <label>Anything else <textarea name="notes" rows="2" placeholder="Hiking in from the north trailhead, back out the same way">${esc(old?.notes ?? '')}</textarea></label>
    <label>Remind me to head back <select name="remind">${[30, 60, 90, 120].map(m => opt(m, old?.remind ?? pr.remind, `${graceText(m)} before`)).join('')}</select></label>
    <button class="primary">${old ? 'Save changes' : 'Next: send it'}</button>
    ${old ? '<button type="button" id="wh-cancel" style="width:100%;margin-top:8px">Cancel</button>' : ''}
  </form>`;
  const form = $('#wh-plan');
  const truckSrc = async () => {
    const lake = lakes.find(l => l.id === form.lakeId.value);
    const parked = lake && (await allAccessNotes()).find(n => n.lakeId === lake.id && n.lat != null);
    const t = truckSpot();
    form.dataset.parkLat = parked?.lat ?? ''; form.dataset.parkLon = parked?.lon ?? '';
    $('#wh-truck-src').textContent = t ? `(marked ${when(t.time)})` : parked ? '(your parking spot from Getting there)' : '(mark it on the Truck tab)';
    form.withTruck.disabled = !t && !parked;
    if (!t && !parked) form.withTruck.checked = false;
    if (!form.dataset.touched && !old) form.withTruck.checked = !!(t || parked);
    if (!form.truckNote.value && lake) { const n = (await allAccessNotes()).find(x => x.lakeId === lake.id); if (n?.park) form.truckNote.value = n.park; }
  };
  form.withTruck.onchange = () => { form.dataset.touched = '1'; };
  form.lakeId.onchange = () => { $('#wh-where-other').classList.toggle('hidden', !!form.lakeId.value); truckSrc(); };
  truckSrc();
  $('#wh-cancel')?.addEventListener('click', () => render());
  form.onsubmit = async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    const leave = new Date(f.leave).getTime(), backBy = new Date(f.backBy).getTime();
    if (!(backBy > leave)) return alert('"Back by" has to be after you leave.');
    const lake = lakes.find(l => l.id === f.lakeId);
    if (!lake && !f.water.trim()) return alert('Say where you are going.');
    const t = truckSpot(), truck = !f.withTruck ? null : t ? { lat: t.lat, lon: t.lon } : form.dataset.parkLat ? { lat: +form.dataset.parkLat, lon: +form.dataset.parkLon } : null;
    const S = lake ? stateAt(lake.lat, lake.lon) : null;
    const notes = lake ? (await allAccessNotes()).find(n => n.lakeId === lake.id) : null;
    status('Looking up the county sheriff…');
    const help = lake ? await helpAt(lake.lat, lake.lon).catch(() => null) : null;
    if (S) keepHelp([S.code]);
    const plan = {
      id: old?.id ?? uid(), seq: old ? (old.seq ?? 0) + 1 : 0, status: 'out', createdAt: old?.createdAt ?? new Date().toISOString(),
      lakeId: lake?.id ?? null, water: lake?.name ?? f.water.trim(), lat: lake?.lat ?? null, lon: lake?.lon ?? null,
      state: S?.code ?? null, county: help?.county ?? null,
      help: help?.sheriff ? { sheriff: { county: help.county, name: help.sheriff.name, phone: help.sheriff.phone } } : null,
      signal: notes ? signalSummary(notes) || null : null,
      myName: f.myName.trim(), who: f.who.trim(), vehicle: f.vehicle.trim(), truckNote: f.truckNote.trim(), truck,
      leave: new Date(leave).toISOString(), backBy: new Date(backBy).toISOString(), grace: +f.grace, remind: +f.remind,
      contactName: f.contactName.trim(), contactPhone: f.contactPhone.trim(), notes: f.notes.trim(),
    };
    write(PLAN, plan);
    write(PREFS, { ...read(PREFS), myName: plan.myName, vehicle: plan.vehicle, contactName: plan.contactName, contactPhone: plan.contactPhone, grace: plan.grace, remind: plan.remind });
    status('');
    checkPlan();
    renderSend(body, plan, !!old);
  };
}

// ---------- After saving: send the text and the alarm ----------
function renderSend(body, p, changed = false) {
  const text = planText(p);
  body.innerHTML = `<div class="card wh-send"><h3>${changed ? 'Plan updated: send it again' : 'Send your plan'}</h3>
    <ol class="wh-steps">
      <li><b>Text the plan</b>${p.contactName ? ` to ${esc(p.contactName)}` : ''}.
        <div class="row"><a class="wh-btn primary" href="${esc(smsHref(p.contactPhone, text))}" id="wh-sms">📨 Messages</a><button type="button" id="wh-share">Other app…</button></div></li>
      <li><b>Send the late alarm.</b> A calendar file: they tap it to add it, and their phone rings at <b>${when(callBy(p))}</b>
        (${graceText(p.grace)} after you're due) with your plan and who to call. Send it in the same chat.
        <div class="row"><button type="button" class="primary" id="wh-alarm">⏰ Send the late alarm</button></div></li>
      <li><b>Your own alarm</b> (optional): your calendar reminds you to head back at ${clock(Date.parse(p.backBy) - p.remind * 6e4)}.
        <div class="row"><button type="button" id="wh-mine">📅 Add to my calendar</button></div></li>
    </ol>
    <details><summary class="small">What they'll get</summary><pre class="wh-pre">${esc(text)}</pre></details>
    <button type="button" id="wh-done" style="width:100%;margin-top:8px">Done</button></div>`;
  $('#wh-share').onclick = async () => {
    if (navigator.share) { try { await navigator.share({ text }); } catch { /* cancelled */ } }
    else { await navigator.clipboard?.writeText(text); status('Plan copied'); }
  };
  $('#wh-alarm').onclick = () => sendAlarm(p);
  $('#wh-mine').onclick = () => sendMine(p);
  $('#wh-done').onclick = () => render();
}

// ---------- A plan you're out on ----------
function renderActive(body) {
  const p = currentPlan(), now = Date.now(), due = Date.parse(p.backBy), call = callBy(p);
  const state = now > call ? 'bad' : now > due ? 'warn' : '';
  body.innerHTML = `<div class="card wh-active ${state}">
      <div class="wh-active-head"><b>Out at ${esc(p.water)}</b><span class="small">${p.contactName ? `${esc(p.contactName)} has your plan` : 'Plan saved'}</span></div>
      <div class="wh-due">${now > call ? `⚠️ ${esc(p.contactName || 'Home')}'s late alarm went off at ${when(call)}. Tell them you're OK.` : now > due ? `You're past your back-by time (${clock(due)}). Let ${esc(p.contactName || 'them')} know.` : `Back by <b>${when(due)}</b> · help is called at ${when(call)}`}</div>
      <label class="check small"><input type="checkbox" id="wh-spot"> Add my spot to the text</label>
      <div class="wh-checkin">
        <button type="button" class="primary" data-send="ok">✅ All good</button>
        <button type="button" data-send="back">🏁 I'm back</button>
      </div>
      <div class="small" style="margin-top:8px">Running late? Move your back-by time:
        <span class="wh-late">${[30, 60, 120].map(m => `<button type="button" data-late="${m}">+${m < 60 ? `${m} min` : `${m / 60} h`}</button>`).join('')}</span></div>
    </div>
    <div class="card small">
      <a href="#" id="wh-resend">Send the plan or alarm again</a> · <a href="#" id="wh-edit">Change the plan</a> · <a href="#" id="wh-end" class="danger">End without texting</a>
    </div>
    <details class="card"><summary class="small">Your plan</summary><pre class="wh-pre">${esc(planText(p))}</pre></details>`;
  const spot = async () => $('#wh-spot').checked ? (spotForText = await hereNow()) : null;
  const open = href => { location.href = href; };
  body.querySelectorAll('[data-send]').forEach(b => b.onclick = async () => {
    const kind = b.dataset.send;
    open(smsHref(p.contactPhone, checkText(p, kind, { spot: kind === 'ok' ? await spot() : null })));
    if (kind === 'back') { write(PLAN, { ...p, status: 'back', backAt: new Date().toISOString() }); checkPlan(); setTimeout(() => render(), 500); }
    else write(PLAN, { ...p, lastCheckIn: new Date().toISOString() });
  });
  body.querySelectorAll('[data-late]').forEach(b => b.onclick = async () => {
    const late = Math.max(Date.now(), Date.parse(p.backBy)) + +b.dataset.late * 6e4;
    const next = { ...p, backBy: new Date(late).toISOString(), seq: (p.seq ?? 0) + 1 };
    write(PLAN, next);
    checkPlan();
    open(smsHref(p.contactPhone, checkText(next, 'late', { late, spot: await spot() })));
    renderLate(body, next);
  });
  $('#wh-resend').onclick = e => { e.preventDefault(); renderSend(body, p); };
  $('#wh-edit').onclick = e => { e.preventDefault(); render({ edit: true }); };
  $('#wh-end').onclick = e => { e.preventDefault(); if (!confirm(`End this plan? ${p.contactName || 'Your contact'}'s late alarm still rings unless you tell them you're back.`)) return; write(PLAN, { ...p, status: 'back' }); checkPlan(); render(); };
}

// After "running late": the new alarm replaces the old one when they add it (same event, newer version).
function renderLate(body, p) {
  body.innerHTML = `<div class="card"><h3>New back-by: ${when(Date.parse(p.backBy))}</h3>
    <p class="small">Send ${esc(p.contactName || 'them')} the updated late alarm so it rings at ${when(callBy(p))} instead. Most calendars replace the old one when they add it;
      if theirs shows both, they can delete the earlier one.</p>
    <button type="button" class="primary" id="wh-alarm">⏰ Send the updated alarm</button>
    <button type="button" id="wh-done" style="width:100%;margin-top:8px">Done</button></div>`;
  $('#wh-alarm').onclick = () => sendAlarm(p);
  $('#wh-done').onclick = () => render();
}

// ---------- Banner when you're due back ----------
let bannerTimer = null;
export function checkPlan() {
  document.querySelector('#plan-banner')?.remove();
  clearTimeout(bannerTimer);
  const p = currentPlan();
  if (!p) return;
  const now = Date.now(), due = Date.parse(p.backBy), call = callBy(p);
  if (now < due - 15 * 6e4) { bannerTimer = setTimeout(checkPlan, Math.min(due - 15 * 6e4 - now, 36e5)); return; }
  const el = document.createElement('div');
  el.id = 'plan-banner';
  el.innerHTML = `<div class="reminder ${now > call ? 'bad' : ''}"><span>⏰ ${now > call ? `${esc(p.contactName || 'Home')}'s late alarm went off at ${clock(call)}. Tell them you're OK.`
    : now > due ? `You planned to be back from ${esc(p.water)} by ${clock(due)}.` : `Due back from ${esc(p.water)} at ${clock(due)}.`}</span>
    <button data-open>Check in</button></div>`;
  el.querySelector('[data-open]').onclick = () => openWhere('plan');
  document.body.append(el);
  bannerTimer = setTimeout(checkPlan, 60e3);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkPlan(); });

// ---------- Back to the truck ----------
let watchId = null, heading = null, lastFix = null, miniMap = null, compassOn = false;
const stopWatch = () => {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  removeEventListener('deviceorientationabsolute', onOrient); removeEventListener('deviceorientation', onOrient);
  compassOn = false; heading = null;
  miniMap?.remove(); miniMap = null;
};
// Leaving the page by any route stops the GPS and compass.
new MutationObserver(() => { if (!$('#view-where').classList.contains('active')) stopWatch(); }).observe($('#view-where'), { attributes: true, attributeFilter: ['class'] });

function onOrient(e) {
  // iPhone gives a compass heading; Android's absolute event gives alpha counter-clockwise from north.
  const h = e.webkitCompassHeading ?? (e.absolute || e.type === 'deviceorientationabsolute' ? (360 - e.alpha) % 360 : null);
  if (h == null || Number.isNaN(h)) return;
  heading = (h + (screen.orientation?.angle ?? 0)) % 360;
  drawArrow();
}
async function startCompass() {
  try { if (typeof DeviceOrientationEvent?.requestPermission === 'function' && await DeviceOrientationEvent.requestPermission() !== 'granted') return status('Compass permission was not given'); }
  catch { return status('Compass not available'); }
  compassOn = true;
  if ('ondeviceorientationabsolute' in window) addEventListener('deviceorientationabsolute', onOrient); else addEventListener('deviceorientation', onOrient);
  setTimeout(() => { if (compassOn && heading == null) status('No compass reading on this device'); }, 3000);
}

// Straight-line distance × 1.3 for trail bends, at Naismith's 5 km/h plus a minute for every 10 m of climb back up.
const walkMins = (km, climbM = 0) => Math.round(km * 1.3 / 5 * 60 + Math.max(0, climbM) / 10);

async function renderTruck(body) {
  const t = truckSpot();
  const parked = (await allAccessNotes()).filter(n => n.lat != null);
  const lakes = new Map((await db.all('lakes')).map(l => [l.id, l]));
  if (!t) {
    body.innerHTML = `<div class="card"><h3>Mark where you parked</h3>
      <p class="small muted">Then this page points the way back with distance, walking time and how long until sunset. It works with no signal; the spot stays on this phone.</p>
      <button type="button" class="primary wh-big" id="wh-mark">📍 The truck is here</button>
      <button type="button" id="wh-pick" style="width:100%;margin-top:8px">Pick it on the map</button>
      ${parked.length ? `<p class="small" style="margin-top:12px">Or use a parking spot from your access notes:</p>${parked.map(n => `<button type="button" class="wh-park" data-lat="${n.lat}" data-lon="${n.lon}" data-lake="${esc(n.lakeId)}">🅿️ ${esc(lakes.get(n.lakeId)?.name ?? 'Parking')}${n.park ? ` · ${esc(n.park)}` : ''}</button>`).join('')}` : ''}</div>`;
    $('#wh-mark').onclick = async () => {
      status('Getting your position…');
      const p = await hereNow(20000);
      if (!p) return status('No GPS fix. Try again in the open, or pick it on the map.');
      write(TRUCK, { lat: p.lat, lon: p.lon, alt: p.alt, time: Date.now() });
      status(`Truck marked (±${Math.round(p.accuracy)} m)`); render();
    };
    $('#wh-pick').onclick = () => pickTruck();
    body.querySelectorAll('.wh-park').forEach(b => b.onclick = () => { write(TRUCK, { lat: +b.dataset.lat, lon: +b.dataset.lon, time: Date.now(), lakeId: b.dataset.lake }); render(); });
    return;
  }
  body.innerHTML = `<div class="card wh-truck">
      <div class="wh-compass"><div class="wh-arrow" id="wh-arrow">➤</div><div class="wh-north" id="wh-north">N</div></div>
      <div class="wh-dist" id="wh-dist">Finding you…</div>
      <div class="small" id="wh-walk"></div>
      <div class="small" id="wh-sun"></div>
      <div class="muted small" id="wh-gps"></div>
      <button type="button" id="wh-compass" style="margin-top:8px">🧭 Point the way I'm facing</button>
    </div>
    <div id="wh-map" class="wh-map"></div>
    <div class="card small">Truck marked ${when(t.time)} at ${fmtDD(t.lat, t.lon)} ·
      <a href="#" id="wh-here">move it to here</a> · <a href="#" id="wh-pick">pick on the map</a> · <a href="#" id="wh-clear" class="danger">clear</a></div>
    <p class="muted small">The arrow is a straight line, not a trail: on a hike, follow the trail you came in on. The phone's compass is thrown off by metal
      and magnets (truck, rod case, phone case); hold it flat and away from them.</p>`;
  $('#wh-compass').onclick = () => startCompass();
  $('#wh-here').onclick = async e => { e.preventDefault(); const p = await hereNow(20000); if (!p) return status('No GPS fix'); write(TRUCK, { lat: p.lat, lon: p.lon, alt: p.alt, time: Date.now() }); render(); };
  $('#wh-pick').onclick = e => { e.preventDefault(); pickTruck(); };
  $('#wh-clear').onclick = e => { e.preventDefault(); if (confirm('Clear the truck spot?')) { write(TRUCK, null); render(); } };
  miniMap = L.map($('#wh-map'), { zoomControl: false, attributionControl: false });
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, crossOrigin: true }).addTo(miniMap);
  const truckMark = L.marker([t.lat, t.lon], { icon: L.divIcon({ className: 'wh-truck-pin', html: '🚙', iconSize: [28, 28] }) }).addTo(miniMap);
  const youMark = L.circleMarker([t.lat, t.lon], { radius: 7, color: '#fff', weight: 2, fillColor: '#1f78c8', fillOpacity: 1 });
  const line = L.polyline([], { color: '#f2d028', weight: 3, dashArray: '6 6' }).addTo(miniMap);
  miniMap.setView([t.lat, t.lon], 15);
  let framed = false;
  const onFix = p => {
    const { latitude: lat, longitude: lon, accuracy, altitude } = p.coords;
    lastFix = { lat, lon, accuracy, alt: altitude, time: p.timestamp };
    noteFix(lat, lon, accuracy);
    youMark.setLatLng([lat, lon]).addTo(miniMap);
    line.setLatLngs([[lat, lon], [t.lat, t.lon]]);
    if (!framed || !miniMap.getBounds().pad(-0.1).contains([lat, lon])) { framed = true; miniMap.fitBounds(L.latLngBounds([[lat, lon], [t.lat, t.lon]]).pad(0.3), { maxZoom: 17 }); }
    drawTruck(t);
  };
  if (navigator.geolocation) watchId = navigator.geolocation.watchPosition(onFix, err => { const g = $('#wh-gps'); if (g) g.textContent = err.code === 1 ? 'Location permission denied' : 'Waiting for GPS…'; },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
  truckMark.bindTooltip('Truck');
  drawTruck(t);
}

function pickTruck() {
  const t = truckSpot();
  showView('map');
  if (t) map.setView([t.lat, t.lon], 16);
  status('Tap where the truck is');
  pickPoint(({ lat, lng }) => { write(TRUCK, { lat, lon: lng, time: Date.now() }); openWhere('truck'); });
}

function drawArrow() {
  const t = truckSpot(), a = $('#wh-arrow');
  if (!a || !t || !lastFix) return;
  const b = bearing(lastFix.lat, lastFix.lon, t.lat, t.lon);
  const facing = compassOn && heading != null;
  // ➤ points right (east), so turn it back a quarter.
  a.style.transform = `rotate(${(facing ? b - heading : b) - 90}deg)`;
  const n = $('#wh-north');
  if (n) { n.style.transform = `rotate(${facing ? -heading : 0}deg)`; n.classList.toggle('hidden', !facing); }
}

function drawTruck(t) {
  const sunEl = $('#wh-sun');
  const at = lastFix ?? { lat: t.lat, lon: t.lon };
  // Sunset at your spot: the time to leave so you reach the truck while it's still light.
  const sun = sunTimes(new Date(), at.lat, at.lon), now = Date.now();
  if (!lastFix) {
    if (sunEl && sun.sunset) sunEl.textContent = `Sunset ${clock(sun.sunset)}`;
    return;
  }
  const km = haversineKm(lastFix.lat, lastFix.lon, t.lat, t.lon), b = bearing(lastFix.lat, lastFix.lon, t.lat, t.lon);
  const climb = lastFix.alt != null && t.alt != null ? t.alt - lastFix.alt : 0;
  const mins = walkMins(km, climb);
  $('#wh-dist').innerHTML = km < 0.03 ? 'You\'re at the truck' : `<b>${fmtDist(km)}</b> ${compass8(b)} <span class="muted small">(${Math.round(b)}°)</span>`;
  $('#wh-walk').textContent = km < 0.03 ? '' : `About ${fmtMins(mins)} walking${climb > 15 ? `, ${fmtElev(climb)} climb back up` : ''} (straight line × 1.3, 3 mph).`;
  $('#wh-gps').textContent = `GPS ±${Math.round(lastFix.accuracy)} m${lastFix.alt != null ? ` · elevation ${fmtElev(lastFix.alt)}` : ''}`;
  if (sunEl && sun.sunset) {
    const leaveBy = sun.sunset - mins * 6e4, left = Math.round((sun.sunset - now) / 6e4);
    sunEl.className = `small ${now > leaveBy && km >= 0.03 ? 'wh-warn' : ''}`;
    sunEl.textContent = now > sun.dusk ? `It's dark (sunset was ${clock(sun.sunset)}). Headlamp on.`
      : now > sun.sunset ? `Sunset was ${clock(sun.sunset)}; full dark by ${clock(sun.dusk)}.`
      : `Sunset ${clock(sun.sunset)}, in ${left < 60 ? `${left} min` : fmtMins(left)}.${km >= 0.03 ? ` ${now > leaveBy ? 'Leave now to walk out in daylight.' : `Leave by ${clock(leaveBy)} to walk out in daylight.`}` : ''}`;
  }
  drawArrow();
}

// ---------- SOS card ----------
async function renderSos(body) {
  const p = currentPlan(), t = truckSpot();
  body.innerHTML = `<div class="card wh-sos">
      <div class="wh-sos-calls"><a class="wh-btn wh-911" href="tel:911">📞 Call 911</a><a class="wh-btn wh-911-text" id="wh-text911" href="sms:911">💬 Text 911</a></div>
      <p class="small">Call if you can; text when a call won't go through or you can't talk (most of California, Nevada and Oregon take texts).
        No bars at all? iPhone 14 and later, and some newer Android phones, can reach 911 by satellite: call 911 and follow the prompts.</p>
    </div>
    <div class="card"><h3>Where I am</h3><div id="wh-pos" class="small">Getting a GPS fix…</div></div>
    <div class="card"><h3>Read this to the dispatcher</h3><pre class="wh-pre" id="wh-say">…</pre>
      <div class="row"><button type="button" id="wh-copy">Copy</button><button type="button" id="wh-share-sos">Share…</button></div>
      <p class="muted small">Copy it into a satellite message or a text if a call won't go through.</p></div>
    <div class="card" id="wh-help"><h3>Who to call</h3><p class="small muted">Looking up…</p></div>
    <div class="card" id="wh-signal"><h3>Signal</h3></div>`;
  let pos = null;
  const fill = async () => {
    const at = pos ?? (lastSignal() && { ...lastSignal(), stale: true }) ?? (p?.lat != null ? { lat: p.lat, lon: p.lon, plan: true } : null);
    const say = [];
    if (at) {
      $('#wh-pos').innerHTML = `${pos ? `GPS ±${Math.round(pos.accuracy)} m, ${clock(pos.time)}${pos.alt != null ? ` · elevation ${fmtElev(pos.alt)}` : ''}`
        : at.plan ? `<span class="wh-warn">No GPS fix yet: showing your plan's water (${esc(p.water)})</span>` : `<span class="wh-warn">No GPS fix yet: showing where you last had signal (${clock(at.time)})</span>`}
        <table class="wh-coords">${allFormats(at.lat, at.lon).map(([k, v]) => `<tr><th>${k}</th><td><b>${esc(v)}</b></td><td><button type="button" class="ghost" data-copy="${esc(v)}" aria-label="Copy">⧉</button></td></tr>`).join('')}</table>`;
      $('#wh-pos').querySelectorAll('[data-copy]').forEach(b => b.onclick = () => copy(b.dataset.copy));
    }
    const help = at ? await helpAt(at.lat, at.lon).catch(() => null) : null;
    if (at) {
      say.push(`My location: latitude ${at.lat.toFixed(5)}, longitude ${at.lon.toFixed(5)}${pos ? ` (GPS, ±${Math.round(pos.accuracy)} m)` : ' (approximate)'}.`);
      say.push(`USNG ${fmtUsng(at.lat, at.lon)}.`);
      if (pos?.alt != null) say.push(`Elevation ${fmtElev(pos.alt)}.`);
      if (help?.county) say.push(`${help.county} County, ${help.state}.`);
    }
    if (p) say.push(`I'm at ${p.water}${p.who ? `, with ${p.who}` : ''}.`);
    if (t) say.push(`Our vehicle${p?.vehicle ? ` (${p.vehicle})` : ''} is at ${fmtDD(t.lat, t.lon)}${at ? `, ${fmtDist(haversineKm(at.lat, at.lon, t.lat, t.lon))} ${compass8(bearing(at.lat, at.lon, t.lat, t.lon))} of me` : ''}.`);
    const sig = lastSignal();
    if (sig && at && pos && haversineKm(at.lat, at.lon, sig.lat, sig.lon) > 0.1) say.push(`I last had signal at ${clock(sig.time)}, ${fmtDist(haversineKm(at.lat, at.lon, sig.lat, sig.lon))} ${compass8(bearing(at.lat, at.lon, sig.lat, sig.lon))} of here.`);
    const sayText = ['Emergency. What happened: ', ...say].join('\n');
    $('#wh-say').textContent = sayText;
    $('#wh-text911').href = smsHref('911', sayText);
    $('#wh-copy').onclick = () => copy(sayText);
    $('#wh-share-sos').onclick = async () => { if (navigator.share) { try { await navigator.share({ text: sayText }); } catch { /* cancelled */ } } else copy(sayText); };
    renderHelp(help, at);
    renderSignal(at);
  };
  const g = navigator.geolocation;
  if (g) watchId = g.watchPosition(x => {
    const first = !pos;
    pos = { lat: x.coords.latitude, lon: x.coords.longitude, accuracy: x.coords.accuracy, alt: x.coords.altitude, time: x.timestamp };
    noteFix(pos.lat, pos.lon, pos.accuracy);
    // Redraw on the first fix and when the fix gets much better; small wobbles don't redo the lookups.
    if (first || x.coords.accuracy < (fill.acc ?? Infinity) / 2) { fill.acc = x.coords.accuracy; fill(); }
  }, err => { if (!pos) $('#wh-pos').innerHTML = `<span class="wh-warn">${err.code === 1 ? 'Location permission is off for this app: turn it on in Settings to show your position.' : 'No GPS fix yet. Step into the open.'}</span>`; },
  { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
  fill();
}

function copy(text) {
  (navigator.clipboard?.writeText(text) ?? Promise.reject()).then(() => status('Copied'), () => prompt('Copy this:', text));
}

function renderHelp(help, at) {
  const el = $('#wh-help');
  if (!el) return;
  if (!at) { el.innerHTML = '<h3>Who to call</h3><p class="small muted">Needs a position.</p>'; return; }
  if (!help || help.missing) { el.innerHTML = '<h3>Who to call</h3><p class="small">The sheriff, hospital and ranger list isn\'t on this phone yet: open this page once with signal (or leave a plan) and it\'s kept for next time. Call 911 meanwhile.</p>'; return; }
  const dir = x => `${fmtDist(x.km)} ${compass8(bearing(at.lat, at.lon, x.lat, x.lon))}`;
  const tel = ph => ph ? `<a href="${telHref(ph)}" class="wh-tel">${esc(ph)}</a>` : '<span class="muted">no number on file</span>';
  const s = help.sheriff;
  el.innerHTML = `<h3>Who to call</h3>
    ${help.county ? `<div class="wh-help-row"><span>⭐</span><div><b>${esc(help.county)} County Sheriff</b> (search and rescue in ${esc(help.state)} runs through the sheriff)<br>
      ${s ? `${esc(s.name)} · ${tel(s.phone)}${s.website ? ` · <a href="${esc(s.website)}" target="_blank" rel="noopener">site</a>` : ''}` : '<span class="muted">no office on file; 911 reaches them</span>'}
      ${help.substation?.phone ? `<br><span class="small">Closer: ${esc(help.substation.name)}, ${dir(help.substation)} · ${tel(help.substation.phone)}</span>` : ''}</div></div>` : ''}
    ${help.er.map(h => `<div class="wh-help-row"><span>🏥</span><div><b>${esc(h.name)}</b>${h.critical ? ' <span class="chip">small rural ER</span>' : ''} · ${dir(h)}<br>
      ${tel(h.phone)} · ${esc(h.address)}, ${esc(h.city)}${h.state !== help.state ? ` (${h.state})` : ''}</div></div>`).join('')}
    ${help.rangers.map(r => `<div class="wh-help-row"><span>🌲</span><div><b>${esc(r.name)}</b> · ${dir(r)}<br>${r.phone ? tel(r.phone) : '<span class="muted small">no number on file</span>'}${r.hours ? ` · <span class="small">${esc(r.hours)}</span>` : ''}</div></div>`).join('')}
    <p class="muted small">Distances are straight lines. ERs from CMS's hospital list; sheriff offices and ranger stations from OpenStreetMap, which can be out of date: in an emergency call 911 first.
      ${help.updatedAt ? `List updated ${new Date(help.updatedAt).toLocaleDateString()}.` : ''}</p>`;
}

async function renderSignal(at) {
  const el = $('#wh-signal');
  if (!el) return;
  const sig = lastSignal();
  const rows = [];
  if (sig) rows.push(`📶 This phone last had signal at <b>${when(sig.time)}</b>${at ? `, ${fmtDist(haversineKm(at.lat, at.lon, sig.lat, sig.lon))} ${compass8(bearing(at.lat, at.lon, sig.lat, sig.lon))} of here` : ''} (${fmtDD(sig.lat, sig.lon)}).`);
  else rows.push('<span class="muted">No signal spot recorded yet. It\'s noted while trip mode or the truck page is open.</span>');
  // What you and your crew noted about signal at the closest saved water.
  if (at) {
    const lakes = (await db.all('lakes')).map(l => ({ l, km: haversineKm(at.lat, at.lon, l.lat, l.lon) })).filter(x => x.km < 15).sort((a, b) => a.km - b.km);
    const near = lakes[0]?.l;
    if (near) {
      const notes = [...(await db.byLake('notes', near.id)).filter(n => n.kind === 'access'), ...(await db.byLake('crew', near.id)).filter(r => r.kind === 'access')]
        .map(n => [n.from ? `${n.from}` : 'You', signalSummary(n)]).filter(([, s]) => s);
      if (notes.length) rows.push(`At ${esc(near.name)}: ${notes.map(([who, s]) => `<b>${esc(who)}</b>: ${esc(s)}`).join(' · ')}`);
    }
  }
  el.innerHTML = `<h3>Signal</h3>${rows.map(r => `<p class="small">${r}</p>`).join('')}`;
}

// ---------- Today card ----------
export function renderWhereCard(el) {
  const p = currentPlan();
  el.innerHTML = p
    ? `<div class="card wh-today"><div><b>Out at ${esc(p.water)}</b><div class="small">Back by ${when(Date.parse(p.backBy))}${p.contactName ? ` · ${esc(p.contactName)} has your plan` : ''}</div></div>
        <button type="button" data-wh-open="plan">Check in</button></div>`
    : `<div class="wh-links"><button type="button" data-wh-open="plan">📨 Leave a plan</button><button type="button" data-wh-open="truck">🚙 Truck</button><button type="button" data-wh-open="sos">🆘 SOS</button></div>`;
  el.querySelectorAll('[data-wh-open]').forEach(b => b.onclick = () => openWhere(b.dataset.whOpen));
}

$('#btn-sos').onclick = () => openWhere('sos');
checkPlan();
