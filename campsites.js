// Your own campsites: the dispersed spots and favourite sites you find, with what matters when you pull in with a
// trailer at dusk: does it fit, is there shade, is it out of the wind, what does your phone get there. Rows in the
// `campsites` store (in your backup, never sent anywhere); a site goes to a friend only when you tick it in
// Share with your crew. Friends' sites arrive in the `crew` store with kind 'campsite', like their catches.
import { db } from './db.js';
import { haversineKm } from './data-sources.js';
import { esc, fmtDate, status, showView } from './ui.js';
import { map, layersControl, pickPoint } from './map.js';
import { CARRIERS, SIGNAL } from './access-notes.js';
import { fmtMi } from './access-rules.js';

export const TRAILER = { tent: 'Tents only (walk or carry in)', van: 'Car, van or truck camper', small: 'Trailer up to about 20 ft', big: 'Big rigs fit (30 ft+)' };
export const SHADE = { none: 'No shade', some: 'Some shade', good: 'Good shade all day' };
export const WIND = { exposed: 'Exposed to wind', some: 'Some shelter', sheltered: 'Sheltered' };
export const CAMPSITE_FIELDS = ['name', 'text', 'trailer', 'shade', 'wind', 'signal', 'checked'];

export const myCampsites = () => db.all('campsites');
export const crewCampsites = async () => (await db.all('crew')).filter(r => r.kind === 'campsite');

// The saved water closest to a spot (within 50 km), so the site travels with a water when shared.
async function nearestLake(lat, lon) {
  return (await db.all('lakes')).map(l => ({ l, km: haversineKm(lat, lon, l.lat, l.lon) })).filter(x => x.km <= 50).sort((a, b) => a.km - b.km)[0]?.l ?? null;
}

const signalText = sig => Object.entries(CARRIERS).filter(([k]) => sig?.[k]).map(([k, n]) => `${n}: ${SIGNAL[sig[k]] ?? sig[k]}`).join(' · ');
export const campsiteFacts = s => [s.trailer && TRAILER[s.trailer], s.shade && SHADE[s.shade], s.wind && WIND[s.wind], signalText(s.signal) && `📶 ${signalText(s.signal)}`].filter(Boolean);

export function campsiteRow(s, { mine = true, from = null, km = null } = {}) {
  return `<div class="ct-site"><div class="ct-site-head"><b>🏕️ ${esc(s.name || 'Campsite')}</b>${mine ? '' : ` <span class="muted small">from ${esc(s.from)}</span>`}
      <span class="muted small nowrap">${km != null ? `${fmtMi(km)}${from ? ` from ${esc(from)}` : ''}` : ''}</span></div>
    ${campsiteFacts(s).length ? `<div class="small">${campsiteFacts(s).map(esc).join(' · ')}</div>` : ''}
    ${s.text ? `<div class="small muted">${esc(s.text)}</div>` : ''}
    <div class="small ct-site-links">${s.checked ? `Checked ${fmtDate(s.checked)} · ` : ''}<a href="#" data-cs-map="${s.lat},${s.lon}">Map</a>
      ${mine ? ` · <a href="#" data-cs-edit="${esc(s.id)}">edit</a> · <a href="#" data-cs-share="${esc(s.id)}">share with your crew</a>` : ` · <a href="#" class="danger" data-cs-forget="${esc(s.id)}">remove</a>`}</div></div>`;
}

// Wires the links campsiteRow draws. onChange redraws the list after an edit or removal.
export function wireCampsites(el, { onEdit, onChange }) {
  el.querySelectorAll('[data-cs-map]').forEach(a => a.onclick = e => { e.preventDefault(); const [lat, lon] = a.dataset.csMap.split(',').map(Number); showSite(lat, lon); });
  el.querySelectorAll('[data-cs-edit]').forEach(a => a.onclick = async e => { e.preventDefault(); onEdit(await db.get('campsites', a.dataset.csEdit)); });
  el.querySelectorAll('[data-cs-share]').forEach(a => a.onclick = e => { e.preventDefault(); import('./crew.js').then(m => { showView('settings', { render: false }); m.openComposer({ campsites: [a.dataset.csShare] }); }); });
  el.querySelectorAll('[data-cs-forget]').forEach(a => a.onclick = async e => { e.preventDefault(); if (!confirm('Remove this shared campsite?')) return; await db.del('crew', a.dataset.csForget); refreshCampsiteLayer(); onChange(); });
}

// The form: where (your spot now, or a tap on the map), what fits, shade, wind, signal. `done` redraws whatever
// opened it; `reopen` brings you back after the map pick.
export function campsiteForm(el, site, { done, reopen }) {
  const s = site ?? { signal: {} };
  const opt = (m, v) => `<option value=""></option>${Object.entries(m).map(([k, l]) => `<option value="${k}" ${v === k ? 'selected' : ''}>${l}</option>`).join('')}`;
  el.innerHTML = `<form class="card form" id="cs-form"><h3>🏕️ ${site?.id ? 'Edit campsite' : 'Save a campsite'}</h3>
    <p class="muted small">Kept on this phone and in your backup. It goes to a friend only when you tick it in Share with your crew.</p>
    <label>Name <input name="name" value="${esc(s.name)}" placeholder="Pullout above the inlet" required></label>
    <p class="small" id="cs-where">${Number.isFinite(s.lat) ? `📍 ${(+s.lat).toFixed(5)}, ${(+s.lon).toFixed(5)}` : 'No spot yet: use where you are, or pick it on the map.'}</p>
    <div class="row"><button type="button" id="cs-here" style="flex:1">📍 I'm here</button><button type="button" id="cs-pick" style="flex:1">Pick on map</button></div>
    <label>What fits <select name="trailer">${opt(TRAILER, s.trailer)}</select></label>
    <div class="row"><label>Shade <select name="shade">${opt(SHADE, s.shade)}</select></label><label>Wind <select name="wind">${opt(WIND, s.wind)}</select></label></div>
    <div class="small"><b>Signal here</b></div>
    <div class="row">${Object.entries(CARRIERS).map(([k, n]) => `<label>${n} <select name="sig-${k}">${opt(SIGNAL, s.signal?.[k])}</select></label>`).join('')}</div>
    <label>Notes <textarea name="text" rows="2" placeholder="Flat spot for two tents, fire ring, 5 min walk to the inlet">${esc(s.text)}</textarea></label>
    <div class="row"><button class="primary" style="flex:1">Save</button><button type="button" id="cs-cancel" style="flex:1">Cancel</button></div>
    ${site?.id ? '<button type="button" id="cs-del" class="danger" style="width:100%;margin-top:8px">Delete campsite</button>' : ''}</form>`;
  const form = el.querySelector('#cs-form');
  const collect = () => ({ ...s, name: form.name.value.trim(), trailer: form.trailer.value || null, shade: form.shade.value || null, wind: form.wind.value || null, text: form.text.value.trim(),
    signal: Object.fromEntries(Object.keys(CARRIERS).map(k => [k, form[`sig-${k}`].value]).filter(([, v]) => v)) });
  const where = () => { el.querySelector('#cs-where').textContent = `📍 ${(+s.lat).toFixed(5)}, ${(+s.lon).toFixed(5)}`; };
  el.querySelector('#cs-here').onclick = () => {
    el.querySelector('#cs-where').textContent = 'Finding you…';
    navigator.geolocation?.getCurrentPosition(p => { s.lat = +p.coords.latitude.toFixed(6); s.lon = +p.coords.longitude.toFixed(6); where(); },
      () => { el.querySelector('#cs-where').textContent = 'No GPS fix: pick it on the map instead.'; }, { enableHighAccuracy: true, timeout: 20e3, maximumAge: 0 });
  };
  el.querySelector('#cs-pick').onclick = () => {
    const draft = collect();
    showView('map'); status('Tap where the campsite is');
    if (Number.isFinite(s.lat)) map.setView([s.lat, s.lon], 15);
    pickPoint(({ lat, lng }) => { reopen({ ...draft, lat: +lat.toFixed(6), lon: +lng.toFixed(6) }); }, () => reopen(draft));
  };
  el.querySelector('#cs-cancel').onclick = () => done();
  el.querySelector('#cs-del')?.addEventListener('click', async () => { if (!confirm('Delete this campsite?')) return; await db.del('campsites', site.id); refreshCampsiteLayer(); done(); });
  form.onsubmit = async e => {
    e.preventDefault();
    const row = collect();
    if (!Number.isFinite(row.lat)) return alert('Add the spot first: tap I’m here, or pick it on the map.');
    row.lakeId = (await nearestLake(row.lat, row.lon))?.id ?? null;
    row.checked = new Date().toISOString().slice(0, 10);
    const saved = await db.put('campsites', row);
    refreshCampsiteLayer(); status('Campsite saved');
    done(saved);
  };
}

// ---------- Map layer: your campsites and your crew's ----------
const layer = L.layerGroup();
let added = false;
export async function refreshCampsiteLayer() {
  if (!added) { added = true; layersControl.addOverlay(layer, 'Campsites'); }
  layer.clearLayers();
  for (const s of [...await myCampsites(), ...await crewCampsites()]) {
    if (!Number.isFinite(s.lat)) continue;
    L.marker([s.lat, s.lon], { icon: L.divIcon({ className: 'acc-icon', html: '🏕️', iconSize: [22, 22] }), keyboard: false }).addTo(layer)
      .bindPopup(`<b>${esc(s.name || 'Campsite')}</b>${s.from ? ` · from ${esc(s.from)}` : ''}<br>${campsiteFacts(s).map(esc).join('<br>')}${s.text ? `<br><i>${esc(s.text)}</i>` : ''}`);
  }
}
function showSite(lat, lon) {
  refreshCampsiteLayer().then(() => { layer.addTo(map); showView('map'); map.setView([lat, lon], 15); });
}
