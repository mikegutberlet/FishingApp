// Crew sharing: send chosen catches or a spot straight to a friend as a file or a QR code, optionally locked with a
// passphrase. Nothing goes through a server: a file travels however you send it (AirDrop, Messages, email), and a
// QR code carries everything in the link's #fragment, which browsers never send to the website.
// Friends' catches land in their own `crew` store, so they never mix into your stats or personal bests.
import { db, STORES } from './db.js';
import { encryptJson, decryptJson, packJson, unpackJson } from './crypto.js';
import { haversineKm } from './data-sources.js';
import { forLake, stockIdOf } from './states/index.js';
import { $, esc, fmtDate, status, showView, onShow } from './ui.js';
import { map, layersControl, refreshMap } from './map.js';
import { fmtLen } from './units.js';
import { saveFile, askNewPassword } from './backup.js';
import { shrinkPhoto, weightText } from './views/log.js';
import { ACCESS_FIELDS, CARRIERS, SIGNAL, VEHICLES, allAccessNotes } from './access-notes.js';
import { TRAILER, SHADE, WIND, myCampsites, refreshCampsiteLayer } from './campsites.js';
import { planItem } from './crew-plan.js';

const NAME_KEY = 'tackle-box-crew-name';
const QR_MAX = 2900;  // bytes a version-40 QR code holds at low error correction, less a little headroom
const CATCH_FIELDS = ['species', 'count', 'time', 'length', 'weight', 'weightEst', 'depth', 'waterTemp', 'lure', 'technique', 'clarity', 'released', 'moon', 'conditions'];

export const isCrewPack = d => d?.app === 'tackle-box' && d.kind === 'crew' && Array.isArray(d.lakes) && Array.isArray(d.items);

export function myName() {
  let n = localStorage.getItem(NAME_KEY);
  if (!n) {
    n = prompt('Your name, so friends know who this is from:')?.trim();
    if (!n) return null;
    localStorage.setItem(NAME_KEY, n);
  }
  return n;
}

const blobToDataUrl = blob => new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(blob); });

// Builds the pack. Catches lose their GPS spot unless `exact`; photos are redrawn, which drops all EXIF (camera, GPS, time).
// Access notes carry their gate code only if `gateCodes`.
async function buildPack({ catches = [], spots = [], access = [], campsites = [], plans = [] }, { exact = false, photos = true, notes = false, gateCodes = false } = {}) {
  const lakes = new Map((await db.all('lakes')).map(l => [l.id, l]));
  const lakeKeys = [], lakeIdx = id => {
    let i = lakeKeys.indexOf(id);
    if (i < 0) { lakeKeys.push(id); i = lakeKeys.length - 1; }
    return i;
  };
  const items = [];
  for (const c of catches) {
    const it = { kind: 'catch', id: c.id, lake: lakeIdx(c.lakeId) };
    for (const k of CATCH_FIELDS) if (c[k] != null && c[k] !== '') it[k] = c[k];
    if (notes && c.notes) it.notes = c.notes;
    if (exact && c.lat != null) { it.lat = c.lat; it.lon = c.lon; }
    if (photos && c.photo instanceof Blob) it.photo = await blobToDataUrl(await shrinkPhoto(c.photo, 1200));
    items.push(it);
  }
  // A spot saved with no water (Water: None) travels with a stand-in water at its own position.
  for (const s of spots) {
    if (!lakes.has(s.lakeId)) lakes.set(`spot:${s.id}`, { name: s.name || 'Shared spot', lat: s.lat, lon: s.lon });
    items.push({ kind: s.kind, id: s.id, lake: lakeIdx(lakes.has(s.lakeId) ? s.lakeId : `spot:${s.id}`), lat: s.lat, lon: s.lon, name: s.name, text: s.text, type: s.type });
  }
  for (const a of access) {
    if (!lakes.has(a.lakeId)) continue;
    const it = { kind: 'access', id: a.id, lake: lakeIdx(a.lakeId), lat: a.lat, lon: a.lon, signal: a.signal };
    for (const k of ACCESS_FIELDS) if (a[k] && (k !== 'gateCode' || gateCodes)) it[k] = a[k];
    if (photos && a.photo instanceof Blob) it.photo = await blobToDataUrl(await shrinkPhoto(a.photo, 1200));
    items.push(it);
  }
  // A campsite travels with the water it's near; one far from any of your waters goes on its own (lake -1).
  for (const c of campsites) {
    const it = { kind: 'campsite', id: c.id, lake: lakes.has(c.lakeId) ? lakeIdx(c.lakeId) : -1, lat: c.lat, lon: c.lon, name: c.name, text: c.text, trailer: c.trailer, shade: c.shade, wind: c.wind, signal: c.signal, checked: c.checked };
    items.push(it);
  }
  // A group plan (crew-plan.js) brings its waters along, so a friend's phone can add any it doesn't have.
  for (const p of plans) items.push(planItem(p, id => lakes.has(id) ? lakeIdx(id) : null));
  return {
    app: 'tackle-box', kind: 'crew', v: 1, from: myName(), sharedAt: new Date().toISOString(),
    // stockId is the water's id in its state's stocking data (CDFW stock id, NDOW water slug).
    lakes: lakeKeys.map(id => { const l = lakes.get(id) ?? {}; return { name: l.name, lat: l.lat, lon: l.lon, nhdId: l.nhdId, state: l.state ?? forLake(l)?.code, stockId: stockIdOf(l) ?? undefined, acres: l.acres }; }),
    items,
  };
}

// ---------- Receiving ----------
// A pack is someone else's file, so only known fields of the expected types come in: never their ids
// (the lake gets a fresh id), and nothing that would link to your own trips or tackle.
const KINDS = ['catch', 'spot', 'waypoint', 'access', 'campsite'];
const num = v => v == null || v === '' || !isFinite(+v) ? undefined : +v;
const str = (v, n = 500) => v == null ? undefined : String(v).slice(0, n);
const token = v => v == null || v === '' ? undefined : String(v).replace(/[^\w.:-]/g, '').slice(0, 80) || undefined; // as db.js SAFE_ID (Oregon ids use dots)
function cleanLake(l) {
  const out = { name: str(l.name, 120) || 'Shared water', lat: num(l.lat), lon: num(l.lon), acres: num(l.acres), nhdId: token(l.nhdId), state: token(l.state)?.slice(0, 2).toUpperCase() };
  // The state's stock id goes in that state's own field (packs from before Nevada carry cdfwStockId).
  const S = forLake(out), id = token(l.stockId ?? l.cdfwStockId);
  if (S && id) out[S.stockField] = S.stockField === 'cdfwStockId' ? num(id) : id;
  out.state ??= S?.code;
  return out;
}
function cleanItem(it) {
  const out = { kind: it.kind, lat: num(it.lat), lon: num(it.lon) };
  for (const k of ['count', 'length', 'weight', 'weightEst', 'depth', 'waterTemp']) out[k] = num(it[k]);
  for (const k of ['species', 'lure', 'technique', 'clarity', 'moon', 'name', 'type']) out[k] = str(it[k], 120);
  for (const k of ['notes', 'text']) out[k] = str(it[k], 4000);
  out.time = it.time && !isNaN(Date.parse(it.time)) ? new Date(it.time).toISOString() : undefined;
  out.released = it.released == null ? undefined : !!it.released;
  if (it.kind === 'access') {
    for (const k of ['road', 'park', 'launch', 'gate', 'gateCode', 'signalNote']) out[k] = str(it[k], 300);
    out.vehicle = it.vehicle in VEHICLES ? it.vehicle : undefined;
    out.checked = /^\d{4}-\d\d-\d\d$/.test(it.checked ?? '') ? it.checked : undefined;
    out.signal = Object.fromEntries(Object.keys(CARRIERS).filter(k => it.signal?.[k] in SIGNAL).map(k => [k, it.signal[k]]));
  }
  if (it.kind === 'campsite') {
    out.trailer = it.trailer in TRAILER ? it.trailer : undefined;
    out.shade = it.shade in SHADE ? it.shade : undefined;
    out.wind = it.wind in WIND ? it.wind : undefined;
    out.checked = /^\d{4}-\d\d-\d\d$/.test(it.checked ?? '') ? it.checked : undefined;
    out.signal = Object.fromEntries(Object.keys(CARRIERS).filter(k => it.signal?.[k] in SIGNAL).map(k => [k, it.signal[k]]));
  }
  if (it.conditions && typeof it.conditions === 'object') {
    const c = it.conditions;
    out.conditions = { airTemp: num(c.airTemp), wind: num(c.wind), windDir: num(c.windDir), gusts: num(c.gusts), pressureInHg: num(c.pressureInHg), cloud: num(c.cloud), pressureTrend: str(c.pressureTrend, 20), sky: str(c.sky, 60) };
  }
  return out;
}
async function matchLake(l, mine) {
  const sid = stockIdOf(l);
  return mine.find(m => (sid != null && forLake(m) === forLake(l) && String(stockIdOf(m)) === String(sid)) || (l.nhdId && m.nhdId === l.nhdId))
    ?? mine.find(m => m.name?.toLowerCase() === l.name?.toLowerCase() && haversineKm(m.lat, m.lon, l.lat, l.lon) < 5)
    ?? mine.find(m => l.lat != null && haversineKm(m.lat, m.lon, l.lat, l.lon) < 0.5);
}

export async function importCrewPack(pack, { ask = true } = {}) {
  const n = k => pack.items.filter(i => k.includes(i.kind)).length;
  const fish = n(['catch']), spots = n(['spot', 'waypoint']);
  const notes = n(['access']), camps = n(['campsite']), plans = pack.items.filter(i => i.kind === 'plan');
  const summary = [plans.length && `the group plan${plans[0].name ? ` "${String(plans[0].name).slice(0, 80)}"` : ''}`, fish && `${fish} catch${fish > 1 ? 'es' : ''}`, spots && `${spots} spot${spots > 1 ? 's' : ''}`, notes && `access notes for ${notes} water${notes > 1 ? 's' : ''}`, camps && `${camps} campsite${camps > 1 ? 's' : ''}`].filter(Boolean).join(' and ');
  if (ask && !confirm(`${pack.from || 'A friend'} shared ${summary || 'nothing'}${pack.lakes.length ? ` on ${pack.lakes.map(l => l.name).join(', ')}` : ''}.\n\nAdd to your Crew list?`)) return false;
  const mine = await db.all('lakes');
  const ids = [], added = [];
  for (const l of pack.lakes.map(cleanLake)) {
    if (!Number.isFinite(l.lat) || !Number.isFinite(l.lon)) { ids.push(null); continue; } // its items are skipped below
    let m = await matchLake(l, mine);
    if (!m) { m = await db.put('lakes', { ...l, notes: `Shared by ${pack.from || 'a friend'}` }); mine.push(m); added.push(m.name); }
    ids.push(m.id);
  }
  const from = String(pack.from || 'Friend').slice(0, 60);
  for (const it of pack.items) {
    if (it.kind === 'plan') continue; // below
    const lakeId = ids[it.lake] ?? null;
    if (!KINDS.includes(it.kind) || (!lakeId && (it.kind !== 'campsite' || !Number.isFinite(num(it.lat)) || !Number.isFinite(num(it.lon))))) continue;
    // Same friend + same original id = same row, so getting a pack twice doesn't duplicate anything.
    await db.put('crew', { ...cleanItem(it), id: `crew-${from.toLowerCase().replace(/\W+/g, '')}-${String(it.id).replace(/[^\w-]/g, '').slice(0, 40)}`, lakeId, from, receivedAt: new Date().toISOString(),
      photo: typeof it.photo === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(it.photo) ? await (await fetch(it.photo)).blob() : null });
  }
  status(`Added ${summary} from ${from}${added.length ? ` · new water: ${added.join(', ')}` : ''}`);
  await refreshMap(); refreshCrewLayer(); refreshCampsiteLayer(); renderCrewCard();
  if (plans.length) await (await import('./views/crew-plan.js')).receivePlans(plans, ids, from);
  return true;
}

// An opened share link: #crew=<packed>. Unpack, ask for the passphrase if it has one, then import.
async function openLink(code) {
  let data = await unpackJson(code);
  if (data.alg) {
    for (let tries = 0; ; tries++) {
      const pw = prompt(tries ? 'Wrong passphrase. Try again:' : 'This share is protected. Passphrase from your friend:');
      if (pw == null) return;
      try { data = await decryptJson(data, pw); break; } catch (e) { if (tries === 2) throw e; }
    }
  }
  if (!isCrewPack(data)) throw new Error('Not a Tackle Box share');
  return importCrewPack(data);
}
const codeFrom = text => (text.match(/#crew=([\w-]+)/)?.[1] ?? text.trim()).replace(/[^\w-]/g, '');

export async function checkShareLink() {
  const m = location.hash.match(/^#crew=([\w-]+)/);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  // On iPhone the home-screen app keeps its data apart from Safari, and the camera opens links in Safari.
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (!standalone && /iPhone|iPad/.test(navigator.userAgent) && !confirm('Add this share here in Safari?\n\nIf you use Tackle Box from your home screen, tap Cancel to copy the code, then in the app go to the ⚙️ gear → Share with your crew → Paste a code.')) {
    try { await navigator.clipboard.writeText(m[1]); alert('Code copied. Open Tackle Box from your home screen, then the ⚙️ gear → Share with your crew → Paste a code.'); }
    catch { prompt('Copy this code:', m[1]); }
    return;
  }
  openLink(m[1]).catch(e => alert(e.message));
}

// ---------- Sending ----------
export const planPack = plan => buildPack({ plans: [plan] });
export async function sendPack(pack, how) {
  const pw = confirm('Protect it with a passphrase?\n\nRecommended for a file. Tell your friend the passphrase in person or another way.') ? askNewPassword('share') : null;
  const body = pw ? { app: 'tackle-box', kind: 'crew-encrypted', encrypted: await encryptJson(pack, pw) } : pack;
  if (how === 'qr') {
    const code = await packJson(pw ? body.encrypted : pack);
    const url = `${location.origin}${location.pathname}#crew=${code}`;
    if (url.length > QR_MAX) return alert(`That's too much for a QR code (${Math.round(url.length / 1000)} KB). Send it as a file, or pick fewer catches.`);
    return showQr(url, pack);
  }
  const file = new File([JSON.stringify(body)], `${(pack.from || 'crew').replace(/[^\w-]+/g, '-')}-share-${new Date().toISOString().slice(0, 10)}.tacklebox.json`, { type: 'application/json' });
  await saveFile(file, { title: 'Tackle Box share', text: `From ${pack.from}: open Tackle Box, the ⚙️ gear → Import, and pick this file.` });
}

let qrLoaded;
const loadQr = () => qrLoaded ??= new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'vendor/qrcode/qrcode.js'; s.onload = res; s.onerror = rej; document.head.append(s); });

async function showQr(url, pack) {
  await loadQr();
  const qr = qrcode(0, 'L'); qr.addData(url, 'Byte'); qr.make();
  const sheet = document.createElement('div');
  sheet.className = 'qr-sheet';
  sheet.innerHTML = `<div class="qr-sheet-card"><h3>Scan with your friend's phone camera</h3>
    <div class="qr">${qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true })}</div>
    <p class="small">${esc(pack.items.length)} item${pack.items.length > 1 ? 's' : ''} from ${esc(pack.from)}. The whole share is inside the code; no server sees it.
      Friends with the app on their home screen: in Tackle Box tap <b>the ⚙️ gear → Share with your crew → Scan</b>${'BarcodeDetector' in window ? '' : ' (Android), or open the link and copy the code'}.</p>
    <div class="row"><button id="qr-copy" style="flex:1">${navigator.share ? 'Send link' : 'Copy link'}</button><button id="qr-close" class="primary" style="flex:1">Done</button></div></div>`;
  document.body.append(sheet);
  sheet.querySelector('#qr-close').onclick = () => sheet.remove();
  // Not together? Text the link instead: everything is still in the part after #.
  sheet.querySelector('#qr-copy').onclick = () => (navigator.share ? navigator.share({ title: 'Tackle Box share', url }).catch(e => { if (e.name !== 'AbortError') throw e; })
    : navigator.clipboard.writeText(url).then(() => status('Link copied'))).catch(() => prompt('Copy this link:', url));
}

// Scan a friend's QR code in the app (Android Chrome and others with BarcodeDetector).
async function scanQr() {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  const sheet = document.createElement('div');
  sheet.className = 'qr-sheet';
  sheet.innerHTML = `<div class="qr-sheet-card"><h3>Point at the QR code</h3><video playsinline muted class="qr-video"></video><button class="primary" id="scan-stop">Cancel</button></div>`;
  document.body.append(sheet);
  const video = sheet.querySelector('video'); video.srcObject = stream; await video.play();
  const detector = new BarcodeDetector({ formats: ['qr_code'] });
  let done = false;
  const stop = () => { done = true; stream.getTracks().forEach(t => t.stop()); sheet.remove(); };
  sheet.querySelector('#scan-stop').onclick = stop;
  while (!done) {
    const [hit] = await detector.detect(video).catch(() => []);
    if (hit?.rawValue?.includes('#crew=')) { stop(); return openLink(codeFrom(hit.rawValue)); }
    await new Promise(r => setTimeout(r, 250));
  }
}

// ---------- The composer: pick what to share ----------
export async function openComposer(preselect = {}) {
  showView('settings', { render: false });
  const [catches, notes, lakes, access, campsites] = await Promise.all([db.all('catches'), db.all('notes'), db.all('lakes'), allAccessNotes(), myCampsites()]);
  const waypoints = STORES.includes('waypoints') ? await db.all('waypoints') : [];
  const lakeName = Object.fromEntries(lakes.map(l => [l.id, l.name]));
  const spots = [...notes.filter(n => n.lat != null && n.kind !== 'access').map(n => ({ ...n, kind: 'spot', label: n.text.slice(0, 60) })),
    ...waypoints.map(w => ({ ...w, kind: 'waypoint', label: `${w.kind ? w.kind + ': ' : ''}${w.name || ''}`, type: w.kind, text: w.note }))];
  catches.sort((a, b) => b.time.localeCompare(a.time));
  const sel = new Set([...(preselect.catches ?? []), ...(preselect.spots ?? []), ...(preselect.access ?? []), ...(preselect.campsites ?? [])]);
  const only = preselect.spots || preselect.access || preselect.campsites;
  const el = $('#crew-card');
  el.innerHTML = `<h3>Share with your crew</h3>
    <p class="small muted">Tick what to send. Your other catches, notes and spots stay on this phone.</p>
    ${catches.length ? `<details class="pick" ${only ? '' : 'open'}><summary><b>Catches</b></summary>${catches.slice(0, 200).map(c => `<label class="check pick-row"><input type="checkbox" value="${c.id}" data-k="c" ${sel.has(c.id) ? 'checked' : ''}>
      <span><b>${esc(c.species)}</b> ${fmtLen(c.length)} ${weightText(c)} <span class="muted small">${esc(lakeName[c.lakeId] ?? '')} · ${fmtDate(c.time)}${c.photo ? ' · 📷' : ''}</span></span></label>`).join('')}</details>` : ''}
    ${spots.length ? `<details class="pick" ${preselect.spots || !catches.length ? 'open' : ''}><summary><b>Spots</b></summary>${spots.map(s => `<label class="check pick-row"><input type="checkbox" value="${s.id}" data-k="s" ${sel.has(s.id) ? 'checked' : ''}>
      <span>📍 ${esc(s.label)} <span class="muted small">${esc(lakeName[s.lakeId] ?? '')}</span></span></label>`).join('')}</details>` : ''}
    ${access.length ? `<details class="pick" ${preselect.access || !catches.length ? 'open' : ''}><summary><b>Access notes</b></summary>${access.filter(a => lakeName[a.lakeId]).map(a => `<label class="check pick-row"><input type="checkbox" value="${a.id}" data-k="a" ${sel.has(a.id) ? 'checked' : ''}>
      <span>🚙 ${esc(lakeName[a.lakeId])} <span class="muted small">${esc([VEHICLES[a.vehicle], a.park].filter(Boolean).join(' · '))}${a.photo ? ' · 📷' : ''}</span></span></label>`).join('')}</details>` : ''}
    ${campsites.length ? `<details class="pick" ${preselect.campsites ? 'open' : ''}><summary><b>Campsites</b></summary>${campsites.map(c => `<label class="check pick-row"><input type="checkbox" value="${c.id}" data-k="cs" ${sel.has(c.id) ? 'checked' : ''}>
      <span>🏕️ ${esc(c.name || 'Campsite')} <span class="muted small">${esc(lakeName[c.lakeId] ?? '')}</span></span></label>`).join('')}</details>` : ''}
    <form class="form" id="crew-opts" style="margin-top:8px">
      <label class="check"><input type="checkbox" name="exact"> Include where each fish was caught (GPS spot)</label>
      <label class="check"><input type="checkbox" name="photos" checked> Include photos (camera and location data removed)</label>
      <label class="check"><input type="checkbox" name="notes"> Include my notes on those catches</label>
      ${access.length ? '<label class="check"><input type="checkbox" name="gateCodes"> Include gate codes in access notes</label>' : ''}
    </form>
    <div class="row"><button id="crew-file" class="primary" style="flex:1">Send as file</button><button id="crew-qr" style="flex:1">QR code</button></div>
    <button id="crew-cancel" style="width:100%;margin-top:8px">Cancel</button>`;
  const picked = () => {
    const ids = k => [...el.querySelectorAll(`input[data-k="${k}"]:checked`)].map(i => i.value);
    return { catches: catches.filter(c => ids('c').includes(c.id)), spots: spots.filter(s => ids('s').includes(s.id)), access: access.filter(a => ids('a').includes(a.id)), campsites: campsites.filter(c => ids('cs').includes(c.id)) };
  };
  const go = how => async () => {
    const p = picked();
    if (!p.catches.length && !p.spots.length && !p.access.length && !p.campsites.length) return alert('Tick at least one catch, spot, access note or campsite.');
    const o = Object.fromEntries(['exact', 'photos', 'notes', 'gateCodes'].map(k => [k, !!$('#crew-opts')[k]?.checked]));
    if (how === 'qr') o.photos = false; // photos never fit in a QR code
    const pack = await buildPack(p, o);
    if (!pack.from) return;
    sendPack(pack, how).then(renderCrewCard, e => alert(e.message));
  };
  $('#crew-file').onclick = go('file');
  $('#crew-qr').onclick = go('qr');
  $('#crew-cancel').onclick = renderCrewCard;
  el.scrollIntoView({ block: 'start' });
}

export async function renderCrewCard() {
  const el = $('#crew-card');
  if (!el) return;
  const crew = await db.all('crew');
  const byFriend = Object.entries(crew.reduce((m, r) => ((m[r.from] ??= []).push(r), m), {}));
  el.innerHTML = `<h3>👥 Share with your crew</h3>
    <p class="small">Send chosen catches or a spot to a friend: as a file (AirDrop, Messages, email) or a QR code they scan.
      Shared photos have their location stripped, and catches leave out the exact spot unless you tick it.</p>
    <button id="crew-new" class="primary">Choose what to share</button>
    <div class="row" style="margin-top:8px">${'BarcodeDetector' in window ? '<button id="crew-scan" style="flex:1">📷 Scan</button>' : ''}<button id="crew-paste" style="flex:1">Paste a code</button></div>
    ${byFriend.length ? `<h3 style="margin-top:12px">From your crew</h3>${byFriend.map(([f, rows]) => `<div class="row small crew-row"><span style="flex:1"><b>${esc(f)}</b> · ${rows.filter(r => r.kind === 'catch').length} catches, ${rows.filter(r => r.kind === 'spot' || r.kind === 'waypoint').length} spots${rows.some(r => r.kind === 'access') ? `, ${rows.filter(r => r.kind === 'access').length} access notes` : ''}${rows.some(r => r.kind === 'campsite') ? `, ${rows.filter(r => r.kind === 'campsite').length} campsites` : ''}</span>
      <a href="#" class="danger" data-forget="${esc(f)}">remove</a></div>`).join('')}<p class="muted small">Friends' catches show on each water's <b>Crew</b> tab and the <b>Crew</b> map layer, never in your own stats.</p>` : ''}`;
  $('#crew-new').onclick = () => openComposer();
  $('#crew-scan')?.addEventListener('click', () => scanQr().catch(e => alert(e.message)));
  $('#crew-paste').onclick = () => { const t = prompt('Paste the code or link your friend sent:'); if (t) openLink(codeFrom(t)).catch(e => alert(e.message.includes('atob') || e instanceof SyntaxError ? "That code didn't work. Check it was copied in full." : e.message)); };
  el.querySelectorAll('[data-forget]').forEach(a => a.onclick = async e => {
    e.preventDefault();
    if (!confirm(`Remove everything ${a.dataset.forget} shared with you?`)) return;
    for (const r of crew.filter(r => r.from === a.dataset.forget)) await db.del('crew', r.id);
    refreshCrewLayer(); refreshCampsiteLayer(); renderCrewCard();
  });
}

onShow('settings', renderCrewCard);

// ---------- Map layer of friends' spots and catches that came with a GPS spot ----------
// Called once from app.js (not at load time: map.js and this module import each other).
const crewLayer = L.layerGroup();
export function initCrew() {
  layersControl.addOverlay(crewLayer, 'Crew');
  refreshCrewLayer();
  checkShareLink();
  addEventListener('hashchange', checkShareLink); // a link opened while the app is already open
}
export async function refreshCrewLayer() {
  crewLayer.clearLayers();
  for (const r of await db.all('crew')) {
    if (r.lat == null || r.kind === 'campsite') continue; // campsites have their own layer (campsites.js)
    L.circleMarker([r.lat, r.lon], { radius: 6, color: '#fff', weight: 2, fillColor: r.kind === 'catch' ? '#9b5de5' : '#00a6a6', fillOpacity: 1 }).addTo(crewLayer)
      .bindPopup(`<b>${esc(r.kind === 'catch' ? r.species : r.kind === 'access' ? 'Parking' : r.name || 'Spot')}</b> · from ${esc(r.from)}${r.time ? '<br>' + fmtDate(r.time) : ''}${r.text ? '<br>' + esc(r.text) : ''}`);
  }
}
export const showCrewSpot = r => { showView('map'); map.setView([r.lat, r.lon], 16); crewLayer.addTo(map); L.popup().setLatLng([r.lat, r.lon]).setContent(`${esc(r.name || r.species || 'Spot')} · from ${esc(r.from)}`).openOn(map); };
