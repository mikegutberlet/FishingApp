// Getting there, continued: permits and quotas, parking passes and boat inspections; trailheads, parking and toilets
// near the water; and the roads, trails and trailheads as one GPX file. Drawn under the main Getting there card once
// its road and land lookup is in (views/tabs/access.js). See access-more.js.
import { esc, fmtDate, showView } from '../../ui.js';
import { map } from '../../map.js';
import { forLake } from '../../states/index.js';
import { rulesFor, permitSeason, nearbyPoints, cachedPoints, accessGpxParts, pointsKm, trailheadKm, POINT_KIND, BOAT_SRC, TAHOE_SRC, PASS_SRC } from '../../access-more.js';
import { CLASS_TEXT, fmtMi } from '../../access-rules.js';
import { gpxFile, sendFile } from '../../routes.js';
import { showPoints } from '../../access-points.js';

const a = (s, text = 'source') => s?.url ? `<a ${text === 'source' ? 'class="gt-src" ' : ''}href="${esc(s.url)}" target="_blank" rel="noopener" title="${esc(s.label ?? '')}">${esc(text)} ↗</a>` : '';
const slots = new WeakMap();
// data, s: the road lookup and its summary, as the main card has them. Called again whenever that card redraws.
export function renderAccessMore(lake, data, s, el) {
  if (!el?.isConnected) return;
  const S = forLake(lake);
  const r = rulesFor(lake, { lat: data.lat, lon: data.lon, parcels: data.land?.parcels ?? [], state: S?.code ?? null });
  const km = pointsKm(data), trailKm = trailheadKm(data, s);
  let st = slots.get(el);
  if (!st || st.key !== `${data.lat},${data.lon},${trailKm}`) { st = { key: `${data.lat},${data.lon},${trailKm}`, points: null, error: null, loading: false }; slots.set(el, st); }
  const paint = () => {
    if (!el.isConnected) return;
    el.innerHTML = rulesCard(lake, r, S) + pointsCard(st, km, trailKm);
    wire(lake, data, s, el, st, km, trailKm, paint);
  };
  paint();
  if (st.points || st.loading) return;
  st.loading = true;
  (async () => {
    const have = await cachedPoints(data.lat, data.lon, km, trailKm);
    if (have) { st.points = have; paint(); if (!have.stale) { st.loading = false; return; } }
    if (navigator.onLine === false) { st.loading = false; if (!have) { st.error = 'offline'; paint(); } return; }
    try { st.points = await nearbyPoints(data.lat, data.lon, km, { trailKm }); st.error = st.points.error ?? null; }
    catch (e) { st.error = e.message; }
    st.loading = false; paint();
  })();
}

function rulesCard(lake, r, S) {
  const items = [];
  for (const p of r.permits) {
    const season = permitSeason(p);
    const when = season.allYear ? 'all year' : season.on ? `in season now (${season.from}–${season.to})` : `needed ${season.from}–${season.to}; not in season today`;
    const day = p.day === true ? 'Day hikes: permit needed' : p.day === 'some' ? 'Day hikes: permit at some trailheads' : 'Day hikes: no permit';
    items.push(`<div class="gt-chip ${season.on ? 'no' : ''}"><span>🎫</span><div><b>${esc(p.name)}: ${p.overnight ? 'overnight permit' : 'permit'}</b> <span class="muted small">${when}</span>
      <div class="small">${day} · Overnight: ${p.overnight ? 'permit needed' : 'no permit'}</div>
      <div class="small">${esc(p.text)}</div>
      <div class="small">${p.book.map(b => `<a href="${esc(b.url)}" target="_blank" rel="noopener">${esc(b.label)} ↗</a>`).join('<br>')}</div>
      <div class="muted small">${a(p.source, p.source.label)}${p.also ? ` · ${a(p.also, p.also.label)}` : ''}</div></div></div>`);
  }
  for (const t of r.passes) items.push(`<div class="gt-chip"><span>🅿️</span><div><b>Parking pass</b><div class="small">${esc(t)}</div>
    <div class="muted small">${a(PASS_SRC[/adventure pass/i.test(t) ? 'CA' : 'OR'], PASS_SRC[/adventure pass/i.test(t) ? 'CA' : 'OR'].label)}</div></div></div>`);
  if (r.boat && lake.kind !== 'ocean') {
    const src = /tahoe/i.test(lake.name ?? '') && r.boatHere ? TAHOE_SRC : BOAT_SRC[S?.code];
    items.push(`<div class="gt-chip"><span>🚤</span><div><b>${r.boatHere ? 'Boat inspection here' : 'Bringing a boat'}</b><div class="small">${esc(r.boat)}</div>${src ? `<div class="muted small">${a(src, src.label)}</div>` : ''}</div></div>`);
  }
  if (!items.length) return '';
  return `<div class="card gtm"><h3>Permits, passes & boats</h3><div class="gt-chips">${items.join('')}</div>
    <p class="muted small" style="margin-top:8px">${r.permits.length ? 'Permit rules matched on the wilderness or park at the shore (USGS PAD-US) and kept by hand from the agency pages linked; quotas and dates change, so book from the agency’s page. ' : ''}Rules change: the linked page is the word to go by.</p></div>`;
}

function pointsCard(st, km, trailKm) {
  const pts = st.points?.points ?? [];
  const main = pts.filter(p => p.kind === 'trailhead' || p.kind === 'parking');
  const extra = pts.filter(p => p.kind === 'toilets' || p.kind === 'water');
  const row = p => `<div class="acc gt-row"><span>${POINT_KIND[p.kind].icon} ${esc(p.name || POINT_KIND[p.kind].label)}${p.name ? ` <span class="muted small">${POINT_KIND[p.kind].label.toLowerCase()}</span>` : ''}${p.facts.length ? `<br><span class="muted small">${esc(p.facts.join(' · '))}</span>` : ''}</span>
    <span class="nowrap muted small">${fmtMi(p.km)} · <a href="https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lon}" target="_blank" rel="noopener">go ↗</a> ${a(p.source)}</span></div>`;
  // No road reaches near the water: trailheads are looked for farther out than the rest.
  const within = trailKm > km ? `Trailheads within ${fmtMi(trailKm)} (no road you can drive comes near this water), the rest within ${fmtMi(km)}` : `Within ${fmtMi(km)}`;
  const body = st.points ? (main.length || extra.length
      ? `${main.slice(0, 8).map(row).join('')}${main.length > 8 ? `<details><summary class="small muted">${main.length - 8} more</summary>${main.slice(8).map(row).join('')}</details>` : ''}
        ${extra.length ? `<p class="small" style="margin-top:6px">${extra.filter(p => p.kind === 'toilets').length ? `🚻 Toilets: ${extra.filter(p => p.kind === 'toilets').slice(0, 3).map(p => `${fmtMi(p.km)} ${a(p.source)}`).join(', ')}` : ''}${extra.some(p => p.kind === 'water') ? `${extra.some(p => p.kind === 'toilets') ? '<br>' : ''}🚰 Drinking water: ${extra.filter(p => p.kind === 'water').slice(0, 3).map(p => `${fmtMi(p.km)} ${a(p.source)}`).join(', ')}` : ''}</p>` : ''}`
      : `<p class="muted small">No trailhead, car park or toilet is mapped in OpenStreetMap (${within.replace(/^W/, 'w')}). Pullouts often aren’t mapped: your crew’s access notes are the better guide.</p>`)
    : st.error ? `<p class="muted small">${st.error === 'offline' ? 'You’re offline: open this tab once with signal and the trailheads are kept on your phone.' : `OpenStreetMap didn’t answer (${esc(st.error)}).`} <a href="#" data-pt-retry>Try again</a></p>`
    : '<p class="muted small">Looking up trailheads and parking (OpenStreetMap can take up to a minute)…</p>';
  return `<div class="card gtm"><h3>Trailheads & parking</h3>${body}
    <div class="row" style="margin-top:8px;flex-wrap:wrap;gap:6px">${main.length ? '<button class="small" data-pt-map>Show on map</button>' : ''}<button class="small" data-pt-gpx>⬇ Roads, trails & trailheads (GPX)</button></div>
    <p class="muted small" style="margin-top:6px">${within}, from OpenStreetMap (volunteer-mapped: fees and hours are as mappers last saw them). “Go” opens directions in Google Maps. The GPX holds every road and trail on this tab, the walk in, trailheads, parking and gates, for Gaia GPS, CalTopo or onX with no signal.${st.points?.fetchedAt ? ` Looked up ${fmtDate(st.points.fetchedAt)}.` : ''}</p></div>`;
}

function wire(lake, data, s, el, st, km, trailKm, paint) {
  el.querySelector('[data-pt-retry]')?.addEventListener('click', async e => {
    e.preventDefault(); st.error = null; st.loading = true; paint();
    try { st.points = await nearbyPoints(data.lat, data.lon, km, { force: true, trailKm }); } catch (err) { st.error = err.message; }
    st.loading = false; paint();
  });
  el.querySelector('[data-pt-map]')?.addEventListener('click', () => {
    showPoints(st.points.points);
    showView('map');
    map.setView([data.lat, data.lon], trailKm > km ? 12 : 13);
  });
  el.querySelector('[data-pt-gpx]')?.addEventListener('click', () => {
    const parts = accessGpxParts(lake, s, data.hike, st.points?.points ?? [], CLASS_TEXT);
    const safe = String(lake.name || 'water').replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '');
    sendFile(gpxFile(`Getting to ${lake.name}`, parts), `${safe}-roads-trails.gpx`);
  });
}
