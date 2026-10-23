// Access & facilities near a water (Info tab): boat ramps, piers, parking, campgrounds, marinas, rentals, bait & tackle.
import * as CA from '../states/ca.js';
import { esc, fmtDate, showView } from '../ui.js';
import { map } from '../map.js';

export const ACCESS_KINDS = {
  ramp: { icon: '🚤', label: 'Boat ramps' }, pier: { icon: '🎣', label: 'Fishing piers & spots' }, marina: { icon: '⚓', label: 'Marinas' },
  rental: { icon: '🛶', label: 'Boat rentals' }, parking: { icon: '🅿️', label: 'Parking' }, camp: { icon: '⛺', label: 'Campgrounds' }, tackle: { icon: '🪱', label: 'Bait & tackle' },
};
export const directionsUrl = (lat, lon) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`;
const mi = km => `${(km * 0.621).toFixed(km < 1.6 ? 1 : 0)} mi`;

export async function renderAccess(lake, el) {
  const a = await CA.accessFor(lake);
  if (!el.isConnected) return;
  if (!a) { el.innerHTML = '<div class="card"><h3>Access & facilities</h3><p class="muted small">Ramp and facility data hasn’t been downloaded yet.</p></div>'; return; }
  const groups = Object.entries(ACCESS_KINDS).map(([kind, k]) => [k, a.places.filter(p => p.kind === kind)]).filter(([, list]) => list.length);
  const item = p => `<div class="acc"><span>${esc(p.name || `Unnamed ${ACCESS_KINDS[p.kind].label.replace(/s(?= |$)/, '').toLowerCase()}`)}${p.note ? ` <span class="muted">· ${esc(p.note)}</span>` : ''}</span>
    <span class="nowrap muted">${mi(p.distKm)} · <a href="#" data-acc-map="${p.lat},${p.lon}">Map</a> · <a href="${directionsUrl(p.lat, p.lon)}" target="_blank" rel="noopener">Directions ↗</a></span></div>`;
  el.innerHTML = `<div class="card"><h3>Access & facilities</h3>
    ${groups.length ? groups.map(([k, list]) => `<div class="small" style="margin-top:8px"><b>${k.icon} ${k.label}</b> <span class="muted">${list.length}</span></div>
      ${list.slice(0, 6).map(item).join('')}${list.length > 6 ? `<details><summary class="small muted">${list.length - 6} more</summary>${list.slice(6).map(item).join('')}</details>` : ''}`).join('')
      : '<p class="small muted">No ramps or facilities are mapped near this water in OpenStreetMap.</p>'}
    <p class="muted small">From OpenStreetMap contributors, refreshed monthly (${fmtDate(a.updatedAt)}). Distances are from the water’s map point. Check fees and hours before you go. Directions open Google Maps.</p></div>`;
  el.querySelectorAll('[data-acc-map]').forEach(b => b.onclick = e => {
    e.preventDefault();
    const [lat, lon] = b.dataset.accMap.split(',').map(Number);
    showView('map');
    map.setView([lat, lon], 16);
  });
}
