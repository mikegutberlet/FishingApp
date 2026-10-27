// Camping tab: the campgrounds around a water with their facilities, fees, seasons and how to book (and, for
// Recreation.gov ones, how many sites are open this weekend); whether you can camp for free outside a campground on
// the land around it, with the stay limits, fire permits and closure pages that go with it; and the Forest Service's
// mapped dispersed camping areas. Every fact links to the public record it came from. See camping.js.
import { forLake } from '../../states/index.js';
import { esc, fmtDate, showView } from '../../ui.js';
import { map, layersControl } from '../../map.js';
import { directionsUrl } from '../access.js';
import { lookupCamping, cached, isFresh, weekendAvailability, SOURCES } from '../../camping.js';
import { dispersedSummary, FIRE, KIND_TEXT, LNT_URL, BLM_STAY, FS_STAY } from '../../camping-rules.js';
import { MANAGERS, DESIGNATIONS, fmtMi } from '../../access-rules.js';
import { forestAlerts } from '../../access-now.js';

const src = s => s?.url ? `<a class="gt-src" href="${esc(s.url)}" target="_blank" rel="noopener" title="${esc(s.label)}">source ↗</a>` : '';
const SHORT = { 'USFS recreation sites (INFRA)': 'FS sites', 'USFS recreation opportunities': 'FS page', 'Recreation.gov': 'Rec.gov', 'BLM recreation sites': 'BLM', 'BLM camping facilities': 'BLM', 'California State Parks campgrounds': 'State Parks', OpenStreetMap: 'OSM' };
const srcs = s => s.sources.map(x => `<a class="gt-src" href="${esc(x.url)}" target="_blank" rel="noopener" title="${esc(x.label)}">${esc(SHORT[x.label] ?? 'source')} ↗</a>`).join(' ');
const link = (label, url) => `<a href="${esc(url)}" target="_blank" rel="noopener">${label} ↗</a>`;
const money = n => n % 1 ? `$${n.toFixed(2)}` : `$${n}`;
const price = p => p ? `${money(p.min)}${p.max > p.min ? `–${money(p.max)}` : ''}/${p.per === 'night' ? 'night' : esc(p.per)}` : '';
const STATUS = { open: ['open now', 'ok'], closed: ['closed now', 'no'] };
// The little facts on a campground's line: free or fee, water, toilets, showers, hookups.
const icons = s => [
  s.fee === 'no' ? '<span title="No fee">🆓</span>' : s.price || s.fee === 'yes' ? '<span title="Fee">💲</span>' : '',
  s.water === 'yes' ? '<span title="Drinking water">🚰</span>' : s.water === 'treat' ? '<span title="Treat your own water">💧</span>' : '',
  s.toilets && s.toilets !== 'no' ? `<span title="${s.toilets === 'flush' ? 'Flush toilets' : 'Vault toilets'}">🚻</span>` : '',
  s.showers ? '<span title="Showers">🚿</span>' : '', s.hookups ? '<span title="Hookups">🔌</span>' : '', s.dump ? '<span title="Dump station">🚐</span>' : '',
  s.reservable ? '<span title="Reservable">📅</span>' : '',
].join('');

// What's open this weekend, per campground, while the app is open.
const avail = {};
const FILTERS = { all: 'All', free: 'Free', reservable: 'Reservable', water: 'Drinking water', rv: 'RVs' };
const pass = (f, s) => f === 'free' ? s.fee === 'no' || s.kind === 'dispersed' : f === 'reservable' ? !!s.reservable : f === 'water' ? s.water === 'yes' : f === 'rv' ? s.kind === 'rv' || s.hookups || s.dump || (s.maxLength ?? 0) >= 25 || (s.equipment ?? []).some(e => /rv|trailer/i.test(e)) : true;

export async function renderCamping(lake, body) {
  body.innerHTML = `<div id="cp"></div>`;
  const el = body.querySelector('#cp');
  const ctx = { filter: 'all' };
  const have = await cached(lake);
  if (!el.isConnected) return;
  if (have) draw(lake, have, el, ctx);
  if (isFresh(have)) return;
  if (navigator.onLine === false) {
    if (!have) el.innerHTML = `<div class="card"><h3>Camping</h3><p class="muted small">You’re offline and camping around this water hasn’t been looked up yet. Open this tab once with signal and it’ll be kept on your phone.</p></div>`;
    return;
  }
  if (!have) el.innerHTML = `<div class="card"><h3>Camping</h3><p class="muted small">Looking up campgrounds, Forest Service and BLM sites, Recreation.gov and land records around this water…</p></div>`;
  try {
    const data = await lookupCamping(lake, { force: !!have, onPartial: d => el.isConnected && draw(lake, d, el, ctx) });
    if (el.isConnected) draw(lake, data, el, ctx);
  } catch (e) {
    if (!el.isConnected || have) return;
    el.innerHTML = `<div class="card"><h3>Camping</h3><p class="muted small">Couldn’t reach the campground services (${esc(e.message)}). Try again with better signal.</p><button data-cp-retry>Try again</button></div>`;
    el.querySelector('[data-cp-retry]').onclick = () => renderCamping(lake, body);
  }
}

function draw(lake, data, el, ctx) {
  const S = forLake(lake);
  const sites = data.sites ?? [];
  const camps = sites.filter(s => s.kind !== 'dispersed'), areas = sites.filter(s => s.kind === 'dispersed');
  const land = dispersedSummary(data.land?.parcels);
  const reservable = camps.filter(s => s.reservable), firstCome = camps.filter(s => s.firstCome || s.reservable === false);
  const fire = FIRE[S?.code];
  const radius = fmtMi(data.searchKm - data.shoreKm);
  const chip = (icon, label, ok, note) => `<div class="gt-chip ${ok === true ? 'ok' : ok === false ? 'no' : ''}"><span>${icon}</span><div><b>${label}</b><div class="muted small">${note}</div></div></div>`;
  const nearest = camps[0];
  const freeHead = { yes: 'Free dispersed camping nearby', wild: 'Backpack camping only (wilderness)', no: 'Campgrounds only', unknown: 'Free camping: land not known' }[land.level];
  const freeNote = land.level === 'yes' ? `${land.yes.map(r => `${esc(MANAGERS[r.manager]?.name ?? r.manager)}${r.unit ? ` (${esc(r.unit)})` : ''}`).join(', ')} land around the water. ${areas.length ? `${areas.length} mapped dispersed area${areas.length > 1 ? 's' : ''} nearby.` : ''} Details below.`
    : land.level === 'wild' ? `${esc(land.wild[0].unit ?? 'Wilderness')}: hike in and camp; no vehicles.` : land.level === 'no' ? 'The land around the water doesn’t allow camping outside campgrounds.' : data.failed.includes('PAD-US') ? 'Land records didn’t answer.' : 'No public land is recorded around the water.';

  const chips = [
    chip('⛺', camps.length ? `${camps.length} campground${camps.length > 1 ? 's' : ''} within ${radius}` : `No campground found within ${radius}`, camps.length ? true : null,
      nearest ? `Closest: <b>${esc(nearest.name)}</b>, ${nearest.distKm < 0.15 ? 'at the water' : `${fmtMi(nearest.distKm)} from the water`}${nearest.status ? ` (${STATUS[nearest.status][0]})` : ''}.` : 'Look at the dispersed camping below, or the booking links.'),
    chip('🏕️', freeHead, land.level === 'yes' ? true : land.level === 'no' ? false : null, freeNote),
    chip('📅', reservable.length ? `${reservable.length} reservable` : 'Nothing to reserve online', reservable.length ? true : null,
      `${reservable.length ? `On Recreation.gov${reservable.some(s => /State Parks/.test(s.operator ?? '')) ? ' or ReserveCalifornia' : ''}; popular ones fill up months ahead. ` : ''}${firstCome.length ? `${firstCome.length} first-come, first-served.` : ''}`),
  ];
  if (fire) chips.push(chip('🔥', 'Campfires', null, `${fire.text} ${fire.links.map(([l, u]) => link(l, u)).join(' · ')}`));

  const shown = camps.filter(s => pass(ctx.filter, s));
  const row = s => {
    const a = avail[s.recgovId];
    const facts = [
      [s.kind && KIND_TEXT[s.kind], s.operator && esc(s.operator)].filter(Boolean).join(' · '),
      s.status && `<span class="${STATUS[s.status][1] === 'ok' ? 'cp-ok' : 'cp-no'}">${STATUS[s.status][0]}</span>${s.season ? ` · season ${esc(s.season)}` : ''}`,
      !s.status && s.season && `Season: ${esc(s.season)}`,
      s.alert && `⚠️ ${esc(s.alert)}`,
      (s.sites || s.capacity) && `${s.sites ? `${s.sites} site${s.sites > 1 ? 's' : ''}` : `room for about ${s.capacity} people`}${s.maxLength ? ` · RVs and trailers up to ${s.maxLength} ft` : ''}`,
      !s.sites && !s.capacity && s.maxLength && `RVs and trailers up to ${s.maxLength} ft`,
      s.price ? `${price(s.price)}${s.feeText ? ` · ${esc(s.feeText)}` : ''}` : s.feeText ? esc(s.feeText) : s.fee === 'no' ? 'No fee' : '',
      [s.water && { yes: 'Drinking water', no: 'No drinking water', treat: 'No tap water: treat or filter your own' }[s.water], s.toilets && { flush: 'flush toilets', vault: 'vault toilets', yes: 'toilets', no: 'no toilets' }[s.toilets],
        s.showers && 'showers', s.hookups && 'hookups', s.dump && 'dump station nearby', s.ramp && 'boat ramp', s.accessible && 'accessible sites', s.tentOnly && 'tents only', s.walkIn && 'walk-in sites', s.packOut && 'pack it in, pack it out'].filter(Boolean).join(' · ').replace(/^./, c => c.toUpperCase()),
      s.reservable && s.firstCome ? 'Reservable, with some first-come sites' : s.reservable ? 'Reservable' : s.firstCome ? 'First-come, first-served' : '',
      s.reservations && !/^(no|no reservations?)\W*$/i.test(s.reservations) && `<span class="muted">${esc(s.reservations)}</span>`,
      s.stay && `Stay limit: ${esc(s.stay)}`,
      s.rating && `★ ${s.rating.stars}${s.rating.n ? ` (${s.rating.n} reviews on Recreation.gov)` : ''}`,
      s.restrictions && `<span class="muted">${esc(s.restrictions)}</span>`,
      s.about?.length > 30 && `<span class="muted">${esc(s.about)}</span>`,
    ].filter(Boolean);
    const links = [s.bookUrl && link(s.recgovId ? 'Book on Recreation.gov' : /reservecalifornia/.test(s.bookUrl) ? 'ReserveCalifornia' : 'Reserve', s.bookUrl), s.infoUrl && link(/fs\.usda/.test(s.infoUrl) ? 'Forest Service page' : /blm\.gov/.test(s.infoUrl) ? 'BLM page' : 'Website', s.infoUrl),
      link('Directions', directionsUrl(s.lat, s.lon)), `<a href="#" data-cp-map="${s.lat},${s.lon}">Map</a>`, srcs(s)].filter(Boolean);
    return `<details class="cp-site"><summary><span><b>${esc(s.name)}</b> <span class="cp-icons">${icons(s)}</span>${s.status === 'closed' ? ' <span class="muted small">closed now</span>' : ''}</span>
        <span class="nowrap muted small">${s.distKm < 0.15 ? 'at the water' : fmtMi(s.distKm)}</span></summary>
      <div class="small cp-body">${facts.map(f => `<div>${f}</div>`).join('')}
        ${s.recgovId ? `<div class="cp-avail" data-cp-avail="${esc(s.recgovId)}">${a ? availText(a) : '<a href="#" data-cp-check>Check open sites this weekend</a>'}</div>` : ''}
        <div class="cp-links">${links.join(' · ')}</div></div></details>`;
  };

  const parcels = land.rows.map((r, i) => `<div class="${i ? 'small' : ''}" style="margin-top:${i ? 8 : 0}px"><b>${esc(MANAGERS[r.manager]?.name ?? r.localManager ?? r.manager ?? 'Unknown')}</b>${r.unit ? ` · ${esc(r.unit)}` : ''}${r.designation && DESIGNATIONS[r.designation] ? ` <span class="muted">(${esc(DESIGNATIONS[r.designation])})</span>` : ''} ${src(r.source)}
    <div class="small ${r.rule.verdict === 'yes' ? '' : 'muted'}">${{ yes: '✅', wild: '🥾', no: '⛔', unknown: '❔' }[r.rule.verdict]} ${esc(r.rule.text)}${r.rule.stay ? ` ${link('Rule', r.rule.stay.url)}` : ''}${r.manager === 'USFS' && forestAlerts(r.unit) ? ` · ${link(`${esc(r.unit)} closures and fire orders`, forestAlerts(r.unit))}` : ''}</div></div>`).join('');
  const hasFs = land.rows.some(r => r.manager === 'USFS'), hasBlm = land.rows.some(r => r.manager === 'BLM');
  const tips = [
    land.level === 'yes' || land.level === 'wild' ? `Camp at least 200 ft from the lake or stream, on a site that’s already been used, and pack out everything (${link('Leave No Trace', LNT_URL)}).` : '',
    hasFs ? `On National Forest land, drive and park only where the forest’s Motor Vehicle Use Map allows: many forests let you pull off a marked road a set distance to camp (shown on the map), others only at designated spots. ${link('Forest Service maps', 'https://www.fs.usda.gov/visit/maps')} · ${link('Know before you go', 'https://www.fs.usda.gov/visit/know-before-you-go')}` : '',
    hasFs ? `Forest stay limits are set by each forest’s order (${link('36 CFR 261.58', FS_STAY.url)}); 14 days is typical.` : '',
    hasBlm ? `BLM: ${esc(BLM_STAY.text)} (${link('43 CFR 8365.1-2', BLM_STAY.url)}). ${link('BLM camping', 'https://www.blm.gov/programs/recreation/camping')}` : '',
    land.level === 'wild' ? 'Wilderness: many need a free overnight permit or have quotas, and some require bear canisters; check the forest page before you go.' : '',
    fire && land.level !== 'no' ? `Campfires: see the fire rules at the top of this tab, and check the forest’s or district’s current restrictions before you light anything.` : '',
  ].filter(Boolean);
  const areaRow = s => `<div class="acc gt-row"><span>${esc(s.name)}${s.fee === 'no' ? ' <span class="muted small">free</span>' : s.price ? ` <span class="muted small">${price(s.price)}</span>` : ''}${s.status ? ` <span class="muted small">· ${STATUS[s.status][0]}</span>` : ''}${s.reservable ? ' <span class="muted small">· reservable</span>' : ''}</span>
    <span class="nowrap muted small">${s.distKm < 0.15 ? 'at the water' : fmtMi(s.distKm)} · <a href="#" data-cp-map="${s.lat},${s.lon}">Map</a> · ${srcs(s)}</span></div>`;

  const book = [
    ['Search Recreation.gov', `https://www.recreation.gov/search?q=${encodeURIComponent(lake.name ?? '')}`],
    ...(S?.code === 'CA' ? [['ReserveCalifornia (state parks)', 'https://www.reservecalifornia.com/'], ['California State Parks', 'https://www.parks.ca.gov/?page_id=21805']]
      : S?.code === 'OR' ? [['Oregon State Parks reservations', 'https://oregonstateparks.reserveamerica.com/'], ['Oregon State Parks', 'https://stateparks.oregon.gov/']]
      : S?.code === 'NV' ? [['Nevada State Parks', 'https://parks.nv.gov/']] : []),
    ['Forest Service maps (MVUM)', 'https://www.fs.usda.gov/visit/maps'],
  ];

  el.innerHTML = `<div class="card gt"><h3>Camping</h3><div class="gt-chips">${chips.join('')}</div>
    ${sites.length ? `<button data-cp-showmap class="small" style="margin-top:8px">Show campgrounds on map</button>` : ''}
    ${data.pending?.length ? `<p class="small gt-season">⏳ Still waiting on OpenStreetMap (its server is slow, up to a minute): county, private and state park campgrounds may add to this.</p>` : ''}</div>

  <div class="card"><h3>⛺ Campgrounds</h3>
    ${camps.length ? `<div class="cp-filters">${Object.entries(FILTERS).map(([k, l]) => `<button class="small ${ctx.filter === k ? 'active' : ''}" data-cp-filter="${k}">${l}</button>`).join('')}</div>
      ${shown.length ? shown.slice(0, 15).map(row).join('') : '<p class="small muted">None of them match that.</p>'}
      ${shown.length > 15 ? `<details><summary class="small muted">${shown.length - 15} more</summary>${shown.slice(15).map(row).join('')}</details>` : ''}
      <p class="muted small">🆓 free · 💲 fee · 🚰 drinking water · 💧 treat your own · 🚻 toilets · 🚿 showers · 🔌 hookups · 🚐 dump station · 📅 reservable. Tap one for details. Distances are from the shore, as the crow flies.</p>`
    : `<p class="small muted">No campground is recorded within ${radius} of this water.</p>`}</div>

  <div class="card"><h3>🏕️ Dispersed camping</h3>
    ${parcels || `<p class="small muted">${data.failed.includes('PAD-US') ? 'The land records didn’t answer; try refreshing.' : 'No public land is recorded within about 2 miles of the shore, which usually means private land: camp in a campground.'}</p>`}
    ${areas.length ? `<div class="small" style="margin-top:10px"><b>Mapped dispersed camping areas</b> <span class="muted">${areas.length}</span></div>${areas.slice(0, 8).map(areaRow).join('')}` : ''}
    ${tips.length ? `<ul class="small cp-tips">${tips.map(t => `<li>${t}</li>`).join('')}</ul>` : ''}
    <p class="muted small">Land manager from the USGS Protected Areas Database within about 2 miles of the shore. These are the general rules: a closure order, fire restriction or sign on the ground overrides them.</p></div>

  <div class="card"><h3>Plan & book</h3><p class="small">${book.map(([l, u]) => link(l, u)).join('<br>')}</p>
    <p class="muted small">Looked up ${fmtDate(data.fetchedAt)} from ${SOURCES.filter(n => !data.failed.includes(n) && !data.pending?.includes(n)).join(', ')}.${data.failed.length ? ` <b>Didn’t answer: ${esc(data.failed.join(', '))}.</b>` : ''}
      Only the water’s location is sent. <a href="#" data-cp-refresh>refresh</a></p></div>`;

  el.querySelectorAll('[data-cp-filter]').forEach(b => b.onclick = () => { ctx.filter = b.dataset.cpFilter; draw(lake, data, el, ctx); });
  el.querySelectorAll('[data-cp-map]').forEach(a => a.onclick = e => { e.preventDefault(); const [lat, lon] = a.dataset.cpMap.split(',').map(Number); showCamps(data, [lat, lon]); });
  el.querySelector('[data-cp-showmap]')?.addEventListener('click', e => { e.preventDefault(); showCamps(data); });
  el.querySelectorAll('[data-cp-check]').forEach(a => a.onclick = async e => {
    e.preventDefault();
    const box = a.closest('[data-cp-avail]'), id = box.dataset.cpAvail;
    box.textContent = 'Checking Recreation.gov…';
    try { avail[id] = await weekendAvailability(id); box.innerHTML = availText(avail[id]); } catch (err) { box.textContent = `Couldn’t check (${err.message}).`; }
  });
  el.querySelector('[data-cp-refresh]').onclick = async e => {
    e.preventDefault();
    e.target.textContent = 'refreshing…';
    try { draw(lake, await lookupCamping(lake, { force: true, onPartial: d => el.isConnected && draw(lake, d, el, ctx) }), el, ctx); } catch (err) { e.target.textContent = `couldn’t refresh: ${err.message}`; }
  };
}

const night = d => new Date(`${d}T12:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
function availText(a) {
  const when = a.nights.length > 1 ? `${night(a.nights[0])} and ${night(a.nights[1]).split(',')[0]} nights` : `${night(a.nights[0])} night`;
  if (!a.total) return `Recreation.gov lists no sites for ${when}.`;
  if (a.all) return `✅ <b>${a.all} of ${a.total} sites</b> open for ${when}${a.some > a.all ? ` (${a.some - a.all} more for one of the nights)` : ''}.`;
  if (a.some) return `🟡 No site is open for both nights; ${a.some} for one of them (${when}).`;
  if (a.notReleased) return `⏳ Sites for ${when} aren’t released for booking yet.`;
  if (a.firstCome) return `First-come, first-served for ${when}: no reservations.`;
  if (a.closed) return `Closed for ${when}.`;
  if (a.reserved === a.total) return `⛔ Full for ${when}.`;
  return `⛔ Nothing can be booked for ${when}${a.reserved ? ` (${a.reserved} of ${a.total} sites reserved; the rest aren’t bookable those nights)` : ': out of season or not offered those nights'}.`;
}

// ---------- Map ----------
const MAP_ICON = { dispersed: '🏕️', cabin: '🛖', rv: '🚐', group: '⛺', primitive: '⛺', developed: '⛺', boat: '⛺', horse: '⛺', hike: '⛺' };
let campLayer = null;
function showCamps(data, focus = null) {
  if (!campLayer) { campLayer = L.layerGroup(); layersControl.addOverlay(campLayer, 'Campgrounds'); }
  campLayer.clearLayers().addTo(map);
  for (const s of data.sites ?? []) {
    L.marker([s.lat, s.lon], { icon: L.divIcon({ className: 'acc-icon', html: MAP_ICON[s.kind] ?? '⛺', iconSize: [22, 22] }), keyboard: false })
      .bindPopup(`<b>${esc(s.name)}</b><br>${esc([KIND_TEXT[s.kind], s.operator].filter(Boolean).join(' · '))}${s.status ? `<br>${STATUS[s.status][0]}` : ''}${s.price ? `<br>${price(s.price)}` : s.fee === 'no' ? '<br>No fee' : ''} ${icons(s)}
        <br>${[s.bookUrl && link('Book', s.bookUrl), s.infoUrl && link('Info', s.infoUrl), link('Directions', directionsUrl(s.lat, s.lon))].filter(Boolean).join(' · ')}`)
      .addTo(campLayer);
  }
  showView('map');
  if (focus) map.setView(focus, 15);
  else {
    const b = L.latLngBounds([[data.lat, data.lon]]);
    for (const s of data.sites ?? []) b.extend([s.lat, s.lon]);
    map.fitBounds(b.pad(0.05), { maxZoom: 14 });
  }
}
