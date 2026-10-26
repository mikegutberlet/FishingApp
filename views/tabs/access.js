// Getting there tab: can you drive to this water, and in what; how far you walk; what the trails allow (foot, mountain
// bike, motorcycle, ATV); who manages the land and what that means for passes and permits; a short description; and
// the ramps and facilities nearby. Every fact links to the public record it came from. See access-lookup.js.
import { forLake } from '../../states/index.js';
import { esc, fmtDate, showView } from '../../ui.js';
import { map, layersControl, pickPoint } from '../../map.js';
import { openLake } from '../lake.js';
import { lookupAccess, cached, MAX_AGE_DAYS } from '../../access-lookup.js';
import { summarize, isBig, CLASS_TEXT, MANAGERS, PUB_ACCESS, fmtMi } from '../../access-rules.js';
import { renderAccess, directionsUrl } from '../access.js';

const SOURCES = ['USFS MVUM', 'USFS roads', 'USFS trails', 'BLM routes', 'PAD-US', 'OpenStreetMap', 'Wikipedia'];
const src = s => s?.url ? `<a class="gt-src" href="${esc(s.url)}" target="_blank" rel="noopener" title="${esc(s.label)}">source ↗</a>` : '';
const named = f => esc(f.name || (f.kind === 'trail' ? 'Unnamed trail' : f.kind === 'gate' ? 'Gate' : 'Unnamed road'));
const dist = f => f.shoreKm <= 0.08 ? 'at the water' : `${fmtMi(f.shoreKm)} from the water`;
const WHO = { car: 'cars', highClearance: 'high clearance', atv: 'ATVs', motorcycle: 'motorcycles', foot: 'hiking', bike: 'bikes' };
// "open 06/01-11/15", or per vehicle when the dates differ.
const dates = f => {
  const d = f.tags.dates ?? {}, keys = Object.keys(d).filter(k => k !== 'note');
  const vals = [...new Set(keys.map(k => d[k]))];
  const part = vals.length === 1 ? `open ${vals[0]}` : vals.length ? keys.map(k => `${WHO[k] ?? k} ${d[k]}`).join('; ') : '';
  return [part, d.note].filter(Boolean).join(' · ');
};
const line = f => `<div class="acc gt-row"><span>${named(f)}${f.ref && f.name && !f.name.includes(f.ref) ? ` <span class="muted">${esc(f.ref)}</span>` : ''}${f.tags.designation ? `<br><span class="muted small">${esc(f.tags.designation)}</span>` : ''}${dates(f) ? `<br><span class="small gt-season">⏱ ${esc(dates(f))}</span>` : ''}</span>
  <span class="nowrap muted small">${dist(f)} · ${src(f.source)}</span></div>`;

// The spot being checked for each water, while the app is open: the water's own point unless you picked one.
const spots = {};
const spotKey = lake => lake.nhdId ? `nhd-${lake.nhdId}` : String(lake.id);

export async function renderGettingThere(lake, body) {
  body.innerHTML = `<div id="gt-where"></div><div id="gt"></div><div id="gt-access"></div>`;
  const el = body.querySelector('#gt');
  const S = forLake(lake);
  const big = isBig(lake), river = lake.kind === 'river' || !!lake.lengthKm;
  // Ramps and launches we know of make good spots to check (California's OpenStreetMap list; a big lake's shore).
  const ramps = S?.accessFor ? ((await S.accessFor(lake))?.places ?? []).filter(p => p.kind === 'ramp' || p.kind === 'pier').slice(0, 8) : [];
  if (!body.isConnected) return;
  let spot = spots[spotKey(lake)] ?? null;
  if (big && !spot && ramps.length) spot = spots[spotKey(lake)] = { lat: ramps[0].lat, lon: ramps[0].lon, label: ramps[0].name || 'nearest ramp' };

  const where = body.querySelector('#gt-where');
  const chooser = () => {
    where.innerHTML = `<div class="card small gt-where"><b>Checking:</b> ${spot ? `${esc(spot.label || `${spot.lat.toFixed(4)}, ${spot.lon.toFixed(4)}`)} <a href="#" data-gt-spot="">(use the water’s point)</a>` : big ? 'nowhere yet' : river ? 'this stretch, at the water’s map point' : 'the water’s map point'}
      ${big || river ? `<div class="muted" style="margin-top:4px">${big ? 'A lake this size has roads on some shores and none on others, so pick where you’d go.' : 'A river is reached in many places: pick the stretch you mean.'}</div>` : ''}
      <div style="margin-top:6px">${ramps.map((r, i) => `<a href="#" data-gt-spot="${i}">${esc(r.name || `Unnamed ${r.kind}`)}</a>`).join(' · ')}${ramps.length ? ' · ' : ''}<a href="#" data-gt-pick>Pick a spot on the map</a></div></div>`;
    where.querySelectorAll('[data-gt-spot]').forEach(a => a.onclick = e => {
      e.preventDefault();
      const r = ramps[a.dataset.gtSpot];
      spots[spotKey(lake)] = spot = r ? { lat: r.lat, lon: r.lon, label: r.name || `Unnamed ${r.kind}` } : null;
      if (!spot) delete spots[spotKey(lake)];
      chooser(); load();
    });
    where.querySelector('[data-gt-pick]').onclick = e => {
      e.preventDefault();
      showView('map');
      map.setView([lake.lat, lake.lon], Math.max(map.getZoom(), big ? 11 : 13));
      pickPoint(({ lat, lng }) => { spots[spotKey(lake)] = { lat, lon: lng, label: `spot at ${lat.toFixed(4)}, ${lng.toFixed(4)}` }; openLake(lake.unsaved ? lake : lake.id, 'access'); });
    };
  };
  chooser();

  const load = async () => {
    if (big && !spot) { el.innerHTML = `<div class="card"><h3>Getting there</h3><p class="muted small">Pick a ramp above or a spot on the map, and the roads, trails and land records around it are checked.</p></div>`; return; }
    const have = await cached(lake, spot);
    if (!el.isConnected) return;
    if (!have || Date.now() - Date.parse(have.fetchedAt) > MAX_AGE_DAYS * 864e5) {
      el.innerHTML = `<div class="card"><h3>Getting there</h3><p class="muted small">${navigator.onLine === false ? 'You’re offline and this spot’s roads and trails haven’t been looked up yet. Open this tab once with signal and they’ll be kept on your phone.' : 'Looking up roads, motor-vehicle maps, trails and land records around this water…'}</p></div>`;
      if (navigator.onLine === false && !have) return;
    }
    try {
      const data = await lookupAccess(lake, { spot, onPartial: d => el.isConnected && draw(lake, d, el) });
      if (!el.isConnected) return;
      draw(lake, data, el);
    } catch (e) {
      if (!el.isConnected) return;
      el.innerHTML = `<div class="card"><h3>Getting there</h3><p class="muted small">Couldn’t reach the road and trail services (${esc(e.message)}). Try again with better signal.</p>
        <button data-gt-refresh>Try again</button></div>`;
      el.querySelector('[data-gt-refresh]').onclick = load;
    }
  };
  renderAccess(lake, body.querySelector('#gt-access'));
  await load();
}

function draw(lake, data, el) {
  const s = summarize({ lat: data.lat, lon: data.lon }, data.shoreKm, data.features, { land: data.land });
  const S = forLake(lake);
  const v = s.vehicle;
  const verdict = v ? CLASS_TEXT[v.cls] : s.nearestUnknown ? CLASS_TEXT.unknown : null;
  const walk = v && v.hikeKm > 0.08;
  const dead = !data.features.length && data.failed.length >= 5;
  const headline = dead ? 'Nothing could be checked right now: the road and land services didn’t answer. Try again with better signal.'
    : !v && !s.nearestUnknown ? `No road comes within ${fmtMi(data.searchKm)} of this water in the public records: a walk-in, boat-in or private water.`
    : v && !walk ? `${verdict.label}: drive to the water${v.road.tags.dates?.car ? ` (open ${v.road.tags.dates.car})` : ''}.`
    : v ? `${verdict.label} to within ${fmtMi(v.hikeKm)}, then on foot.`
    : `A road reaches the water (${fmtMi(s.nearestUnknown.shoreKm)}), but the records don’t say what it takes to drive it.`;

  const chip = (icon, label, ok, note) => `<div class="gt-chip ${ok === true ? 'ok' : ok === false ? 'no' : ''}"><span>${icon}</span><div><b>${label}</b><div class="muted small">${note}</div></div></div>`;
  const list = (items, how) => items.map(t => `${named(t)}${t.shoreKm > 0.08 ? ` <span class="muted">(${fmtMi(t.shoreKm)})</span>` : ''} ${src(t.source)}`).slice(0, 4).join(', ');
  const chips = [
    chip(verdict?.icon ?? '🥾', v ? verdict.label : 'No drivable road found', v ? ['paved', 'road', 'car'].includes(v.cls) : null,
      v ? `${esc(v.road.name || 'unnamed road')}: ${verdict.text} ${v.road.tags.maint ? `Forest Service maintenance “${esc(v.road.tags.maint.toLowerCase())}”. ` : ''}${src(v.road.source)}` : s.nearestUnknown ? `${esc(s.nearestUnknown.name || 'A road')} reaches the water, type unknown. ${src(s.nearestUnknown.source)}` : 'Within the area checked.'),
    chip('🥾', walk ? `Hike about ${fmtMi(v.hikeKm)}` : v ? 'No hike needed' : 'Hike-in', walk ? null : v ? true : null,
      s.hikeTrails.length ? `Trails nearby: ${list(s.hikeTrails)}` : walk ? 'No mapped trail from the road: expect cross-country or an unmapped use trail.' : v ? 'The road reaches the shore.' : 'No road or trail reaches the shore in the records checked.'),
    chip('🚵', s.bikeTrails.length ? 'Mountain bike OK on some trails' : s.noBikeTrails.length ? 'Bikes not allowed on nearby trails' : 'Bike access not recorded', s.bikeTrails.length ? true : s.noBikeTrails.length ? false : null,
      s.bikeTrails.length ? list(s.bikeTrails) : s.noBikeTrails.length ? `No bikes: ${list(s.noBikeTrails)}` : 'A bike can use any road open to cars.'),
    chip('🏍️', s.motoTrails.length || s.ohvRoads.length ? 'Motorcycle / ATV routes nearby' : s.streetLegalOnly.length ? 'Street-legal vehicles only' : 'No OHV routes recorded', s.motoTrails.length || s.ohvRoads.length ? true : s.streetLegalOnly.length ? false : null,
      s.motoTrails.length || s.ohvRoads.length ? `${[...s.motoTrails, ...s.ohvRoads].slice(0, 4).map(t => `${named(t)}${t.tags.atv === 'no' ? ' (motorcycles only)' : ''} ${src(t.source)}`).join(', ')}` : s.streetLegalOnly.length ? `${list(s.streetLegalOnly)}: no green-sticker OHVs on these roads.` : 'Dirt bikes and ATVs need a route designated for them; none is recorded around this water.'),
  ];
  if (s.seasonal.length) chips.push(chip('⏱', 'Seasonal', null, s.seasonal.slice(0, 3).map(f => `${named(f)}: ${esc(dates(f))} ${src(f.source)}`).join('<br>')));
  if (s.lockedGates.length) chips.push(chip('🔒', 'Locked or private gate on the way', false, s.lockedGates.map(g => `${named(g)}${g.tags.access ? ` (${esc(g.tags.access)})` : ''} ${fmtMi(g.shoreKm)} out ${src(g.source)}`).join('<br>')));

  const land = data.land?.parcels?.length ? data.land.parcels : null;
  const landHtml = land ? land.map((p, i) => {
    const m = MANAGERS[p.manager] ?? { name: p.localManager || p.manager || 'Unknown manager', hint: '' };
    return `<div class="${i ? 'small muted' : ''}" style="margin-top:${i ? 6 : 0}px"><b>${esc(m.name)}</b>${p.unit ? ` · ${esc(p.unit)}` : ''}${p.designation ? ` <span class="muted">(${esc(p.designation)})</span>` : ''}${p.access && PUB_ACCESS[p.access] ? ` · ${PUB_ACCESS[p.access]}` : ''} ${src(p.source)}
      ${!i && m.hint ? `<div class="small muted">${m.hint}</div>` : ''}</div>`;
  }).join('') : `<p class="muted small">${data.land ? 'No protected or public land is recorded at the shoreline, which usually means private land or a town: look for a public ramp, park or easement in the list below.' : 'Land records didn’t answer.'}</p>`;

  const links = [
    ['Directions (Google Maps)', directionsUrl(data.lat, data.lon)],
    ['Topo and trail map (CalTopo)', `https://caltopo.com/map.html#ll=${data.lat},${data.lon}&z=14&b=t`],
    ['Forest Service Interactive Visitor Map', 'https://www.fs.usda.gov/ivm/'],
    ['OpenStreetMap here', `https://www.openstreetmap.org/#map=15/${data.lat}/${data.lon}`],
    ['Campgrounds and permits (Recreation.gov)', `https://www.recreation.gov/search?q=${encodeURIComponent(lake.name ?? '')}`],
    ...(S?.code === 'CA' ? [['Road conditions (Caltrans QuickMap)', 'https://quickmap.dot.ca.gov/']] : S?.code === 'NV' ? [['Road conditions (NDOT)', 'https://www.nvroads.com/']] : S?.code === 'OR' ? [['Road conditions (ODOT TripCheck)', 'https://www.tripcheck.com/']] : []),
    ['Wildfire closures (InciWeb)', 'https://inciweb.wildfire.gov/'],
  ];

  el.innerHTML = `<div class="card gt"><h3>Getting there</h3>
    <p class="gt-head">${headline}</p>
    ${data.pending?.length ? `<p class="small gt-season">⏳ Still waiting on ${esc(data.pending.join(', '))} (its server is slow, up to a minute): dirt roads, tracks, paths and gates may add to this.</p>` : ''}
    ${dead ? '' : `<div class="gt-chips">${chips.join('')}</div>`}
    ${s.roads.length || s.trails.length ? `<button data-gt-map class="small">Show roads & trails on map</button> <span class="muted small">blue paved · tan dirt/gravel · orange high clearance · red OHV; dashed trails: green bikes OK, red motorised, purple on foot</span>` : ''}
    <p class="muted small" style="margin-top:8px">${dead ? '' : `Worked out from public road, trail and land records within ${fmtMi(data.searchKm)} of ${data.spot ? 'the spot you picked' : 'the water’s map point'}${data.shoreKm > 0.15 ? ` (shore about ${fmtMi(data.shoreKm)} from it)` : ''}: ${SOURCES.filter(n => !data.failed.includes(n)).join(', ')}.`}${data.failed.length ? ` <b>Didn’t answer: ${esc(data.failed.join(', '))}.</b>` : ''}
      Conditions change with weather, fire and snow: the linked records and the agency’s own page are the word to go by. Looked up ${fmtDate(data.fetchedAt)} · <a href="#" data-gt-refresh>${dead ? 'try again' : 'refresh'}</a></p></div>

  ${data.about ? `<div class="card"><h3>About ${esc(data.about.title)}</h3><p class="small">${esc(data.about.extract)}</p><p class="muted small">From <a href="${esc(data.about.url)}" target="_blank" rel="noopener">Wikipedia ↗</a> (CC BY-SA).</p></div>` : ''}

  <div class="card"><h3>Land & permits</h3>${landHtml}
    <p class="muted small">Land manager from the USGS Protected Areas Database at the shoreline. ${S ? `Fishing itself follows ${S.agency} rules (Regs & safety tab).` : ''}</p></div>

  ${s.roads.length || s.trails.length ? `<div class="card"><h3>Roads & trails nearby</h3>
    ${s.roads.length ? `<details open><summary class="small"><b>Roads</b> <span class="muted">${s.roads.length}</span></summary>${s.roads.slice(0, 12).map(r => line({ ...r, tags: { ...r.tags, designation: [CLASS_TEXT[r.cls]?.label, r.tags.designation].filter(Boolean).join(' · ') } })).join('')}${s.roads.length > 12 ? `<details><summary class="small muted">${s.roads.length - 12} more</summary>${s.roads.slice(12).map(line).join('')}</details>` : ''}</details>` : ''}
    ${s.trails.length ? `<details open><summary class="small"><b>Trails</b> <span class="muted">${s.trails.length}</span></summary>${s.trails.slice(0, 12).map(t => line({ ...t, tags: { ...t.tags, designation: [uses(t.tags), t.tags.designation].filter(Boolean).join(' · ') } })).join('')}${s.trails.length > 12 ? `<details><summary class="small muted">${s.trails.length - 12} more</summary>${s.trails.slice(12).map(line).join('')}</details>` : ''}</details>` : ''}
    <p class="muted small">Distances are to the water’s likely shoreline from each route’s nearest point, as the crow flies. “Source” opens the public record for that road or trail.</p></div>` : ''}

  <div class="card"><h3>Plan & read more</h3><p class="small">${links.map(([l, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener">${l} ↗</a>`).join('<br>')}</p>
    <p class="muted small">These open other sites with this water’s location or name, only when you tap them.</p></div>`;

  el.querySelector('[data-gt-refresh]').onclick = async e => {
    e.preventDefault();
    el.querySelector('.gt-head').textContent = 'Refreshing…';
    try { draw(lake, await lookupAccess(lake, { spot: data.spot, force: true, onPartial: d => el.isConnected && draw(lake, d, el) }), el); } catch (err) { el.querySelector('.gt-head').textContent = `Couldn’t refresh: ${err.message}`; }
  };
  el.querySelector('[data-gt-map]')?.addEventListener('click', () => showRoutes(lake, s));
}

const uses = t => [t.foot !== 'no' && 'hike', (t.bike === 'yes' || t.bike === 'seasonal') && 'bike', t.bike === 'no' && 'no bikes', (t.motorcycle === 'yes' || t.motorcycle === 'seasonal') && 'motorcycle', (t.atv === 'yes' || t.atv === 'seasonal') && 'ATV',
  (t.motorcycle === 'no' && t.atv === 'no') && 'no motor vehicles'].filter(Boolean).join(', ');

// ---------- Map ----------
const COLORS = { paved: '#2b6cb0', road: '#2b6cb0', car: '#b7791f', highClearance: '#c05621', ohvOnly: '#9b2c2c', unknown: '#718096', closed: '#4a5568' };
let routeLayer = null;
function showRoutes(lake, s) {
  if (!routeLayer) { routeLayer = L.layerGroup(); layersControl.addOverlay(routeLayer, 'Roads & trails'); }
  routeLayer.clearLayers().addTo(map);
  const pop = f => `<b>${named(f)}</b><br>${esc([CLASS_TEXT[f.cls]?.label, f.cls ? null : uses(f.tags), f.tags.designation].filter(Boolean).join(' · '))}${dates(f) ? `<br>⏱ ${esc(dates(f))}` : ''}<br><a href="${esc(f.source.url)}" target="_blank" rel="noopener">${esc(f.source.label)} ↗</a>`;
  for (const r of s.roads) for (const p of r.paths) L.polyline(p, { color: COLORS[r.cls] ?? COLORS.unknown, weight: r.cls === 'paved' ? 4 : 3, opacity: 0.85 }).bindPopup(pop(r)).addTo(routeLayer);
  for (const t of s.trails) for (const p of t.paths) L.polyline(p, { color: t.tags.motorcycle === 'yes' || t.tags.atv === 'yes' ? '#9b2c2c' : t.tags.bike === 'yes' ? '#2f855a' : '#6b46c1', weight: 2, dashArray: '6 5', opacity: 0.9 }).bindPopup(pop(t)).addTo(routeLayer);
  for (const g of s.lockedGates) L.circleMarker([g.lat, g.lon], { radius: 6, color: '#c53030', fillOpacity: 0.9 }).bindPopup(pop(g)).addTo(routeLayer);
  showView('map');
  const b = L.latLngBounds([[s.at.lat, s.at.lon]]);
  for (const f of [...s.roads, ...s.trails]) for (const p of f.paths) for (const pt of p) b.extend(pt);
  map.fitBounds(b.pad(0.05), { maxZoom: 15 });
}
