// Getting there tab: your and your crew's own access notes; snow and wildfires today; can you drive to this water,
// and in what; the walk in, with its climb and time; what the trails allow (foot, mountain bike, motorcycle, ATV);
// cell signal; who manages the land and what that means for passes and permits; a short description; and the ramps
// and facilities nearby. Every fact links to the public record it came from. See access-lookup.js and access-now.js.
import { forLake } from '../../states/index.js';
import { esc, fmtDate, showView } from '../../ui.js';
import { map, layersControl, pickPoint } from '../../map.js';
import { openLake, saveWater } from '../lake.js';
import { lookupAccess, cached, isFresh, withHike } from '../../access-lookup.js';
import { summarize, isBig, CLASS_TEXT, MANAGERS, PUB_ACCESS, DESIGNATIONS, WILDERNESS_URL, isWilderness, fmtMi, seasonStatus, snowAt, fmtMins, fmtFt } from '../../access-rules.js';
import { lookupNow, cachedNow, nowFresh, forestAlerts } from '../../access-now.js';
import { myAccessNote, crewAccessNotes, noteCard, noteForm, wireNoteCards, signalSummary, VEHICLES } from '../../access-notes.js';
import { openComposer } from '../../crew.js';
import { renderAccess, directionsUrl } from '../access.js';
import { renderRoutesCard, exportWalkIn } from '../../routes.js';

const SOURCES = ['USFS MVUM', 'USFS roads', 'USFS trails', 'BLM routes', 'PAD-US', 'OpenStreetMap', 'Wikipedia'];
const src = s => s?.url ? `<a class="gt-src" href="${esc(s.url)}" target="_blank" rel="noopener" title="${esc(s.label)}">source ↗</a>` : '';
// Every record a fact came from (a Forest Service road is in both the motor-vehicle map and the road inventory).
const srcs = f => (f.sources ?? [f.source]).map(x => x?.url ? `<a class="gt-src" href="${esc(x.url)}" target="_blank" rel="noopener" title="${esc(x.label)}">${f.sources?.length > 1 ? esc(SHORT[x.label.split(' ·')[0]] ?? 'source') : 'source'} ↗</a>` : '').join(' ');
const SHORT = { 'USFS Motor Vehicle Use Map': 'MVUM', 'USFS National Forest System roads': 'FS roads', 'USFS National Forest System trails': 'FS trails', 'BLM roads and trails (GTLF)': 'BLM', OpenStreetMap: 'OSM' };
// One entry per name: a trail or road is often several records (segments).
const uniq = list => list.filter((f, i) => !f.name || list.findIndex(g => g.name === f.name) === i);
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
// "open now, closes Nov 15 (20 days)" or "closed for the season until Jun 1", for a road's car dates (or any).
const seasonNow = f => {
  const d = f.tags.dates ?? {}, range = d.car ?? d.highClearance ?? d.motorcycle ?? d.atv;
  const st = seasonStatus(range);
  return !st ? '' : st.open ? `open now${st.days <= 45 ? `, closes ${st.closes} (in ${st.days} day${st.days === 1 ? '' : 's'})` : ` until ${st.closes}`}` : `closed for the season until ${st.opens}`;
};
const line = f => `<div class="acc gt-row"><span>${named(f)}${f.ref && f.name && !f.name.includes(f.ref) ? ` <span class="muted">${esc(f.ref)}</span>` : ''}${f.tags.designation ? `<br><span class="muted small">${esc(f.tags.designation)}</span>` : ''}${dates(f) ? `<br><span class="small gt-season">⏱ ${esc(dates(f))}${seasonNow(f) ? ` · ${seasonNow(f)}` : ''}</span>` : ''}</span>
  <span class="nowrap muted small">${dist(f)} · ${srcs(f)}</span></div>`;

// "Ramp, 2.1 mi NE" of the water's map point, for a ramp or pier with no name.
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const offset = (lake, p) => [(p.lon - lake.lon) * 111 * Math.cos(lake.lat * Math.PI / 180), (p.lat - lake.lat) * 111];
const kmFrom = (lake, p) => Math.hypot(...offset(lake, p));
function placeLabel(p, km, lake) {
  const [dx, dy] = offset(lake, p);
  const dir = COMPASS[Math.round(((Math.atan2(dx, dy) * 180 / Math.PI) + 360) % 360 / 45) % 8];
  return `${p.kind === 'pier' ? 'Pier' : 'Ramp'}, ${km < 0.3 ? 'near the map point' : `${fmtMi(km)} ${dir}`}`;
}

// The spot being checked for each water, while the app is open: the water's own point unless you picked one.
const spots = {};
const spotKey = lake => lake.nhdId ? `nhd-${lake.nhdId}` : String(lake.id);

export async function renderGettingThere(lake, body) {
  body.innerHTML = `<div id="gt-notes"></div><div id="gt-where"></div><div id="gt-now"></div><div id="gt"></div><div id="gt-more"></div><div id="gt-routes"></div><div id="gt-gaps"></div><div id="gt-access"></div>`;
  import('../trip-gaps.js').then(m => m.renderTripGaps(lake, body.querySelector('#gt-gaps'))).catch(e => console.warn('trip gaps:', e.message)); // ramps, roads, last gas
  const el = body.querySelector('#gt');
  const S = forLake(lake);
  // What the main card and the Today card share: your and your crew's notes, today's conditions, the route summary.
  const ctx = { mine: null, crew: [], now: null, s: null, lake };
  const notesEl = body.querySelector('#gt-notes'), nowEl = body.querySelector('#gt-now');
  const paintNotes = async () => {
    if (lake.unsaved) {
      notesEl.innerHTML = `<div class="card small muted">📝 Save this water to keep your own access notes on it (where to park, the gate, what your phone gets there) and share them with your crew. <a href="#" data-gt-save>Save it</a></div>`;
      notesEl.querySelector('[data-gt-save]').onclick = e => { e.preventDefault(); saveWater(lake, 'access'); };
      return;
    }
    [ctx.mine, ctx.crew] = await Promise.all([myAccessNote(lake.id), crewAccessNotes(lake.id)]);
    if (!notesEl.isConnected) return;
    notesEl.innerHTML = `${ctx.mine ? noteCard(ctx.mine, { mine: true }) : ''}${ctx.crew.map(n => noteCard(n)).join('')}
      ${ctx.mine ? '' : `<button class="small" data-note-new style="width:100%;margin-bottom:12px">📝 Add your own access notes${ctx.crew.length ? '' : ': where to park, the gate, cell signal'}</button>`}`;
    const edit = () => noteForm(notesEl, lake, ctx.mine, { done: async () => { await paintNotes(); repaint(); }, reopen: () => openLake(lake.id, 'access') });
    notesEl.querySelector('[data-note-new]')?.addEventListener('click', edit);
    wireNoteCards(notesEl, { onEdit: edit, onShare: () => openComposer({ access: [ctx.mine.id] }), onChange: async () => { await paintNotes(); repaint(); } });
  };
  let last = null;
  const repaint = () => { if (last && el.isConnected) draw(lake, last, el, ctx); };
  await paintNotes();
  const big = isBig(lake), river = lake.kind === 'river' || !!lake.lengthKm;
  // Ramps and launches we know of make good spots to check (California's OpenStreetMap list; a big lake's shore).
  // Nearest first; an unnamed one is told apart by where it sits ("Ramp, 2.1 mi NE").
  const ramps = S?.accessFor ? ((await S.accessFor(lake))?.places ?? []).filter(p => p.kind === 'ramp' || p.kind === 'pier')
    .map(p => { const km = kmFrom(lake, p); return { ...p, km, label: p.name || placeLabel(p, km, lake) }; }).sort((a, b) => a.km - b.km).slice(0, 8) : [];
  if (!body.isConnected) return;
  let spot = spots[spotKey(lake)] ?? null;
  if (big && !spot && ramps.length) spot = spots[spotKey(lake)] = { lat: ramps[0].lat, lon: ramps[0].lon, label: ramps[0].label };

  const where = body.querySelector('#gt-where');
  const chooser = () => {
    where.innerHTML = `<div class="card small gt-where"><b>Checking:</b> ${spot ? `${esc(spot.label || `${spot.lat.toFixed(4)}, ${spot.lon.toFixed(4)}`)} <a href="#" data-gt-spot="">(use the water’s point)</a>` : big ? 'nowhere yet' : river ? 'this stretch, at the water’s map point' : 'the water’s map point'}
      ${big || river ? `<div class="muted" style="margin-top:4px">${big ? 'A lake this size has roads on some shores and none on others, so pick where you’d go.' : 'A river is reached in many places: pick the stretch you mean.'}</div>` : ''}
      <div style="margin-top:6px">${ramps.map((r, i) => `<a href="#" data-gt-spot="${i}">${esc(r.label)}</a>`).join(' · ')}${ramps.length ? ' · ' : ''}<a href="#" data-gt-pick>Pick a spot on the map</a></div></div>`;
    where.querySelectorAll('[data-gt-spot]').forEach(a => a.onclick = e => {
      e.preventDefault();
      const r = ramps[a.dataset.gtSpot];
      spots[spotKey(lake)] = spot = r ? { lat: r.lat, lon: r.lon, label: r.label } : null;
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

  // Today: snow and wildfires, at the spot checked (or the water's point).
  const loadNow = async (force = false) => {
    if (big && !spot) { nowEl.innerHTML = ''; return; }
    const at = spot ?? lake, have = await cachedNow(at.lat, at.lon);
    ctx.refreshNow = () => loadNow(true);
    if (have) { ctx.now = have; paintNow(nowEl, ctx); }
    if (nowFresh(have) && !force) return;
    if (navigator.onLine === false) { if (!have) nowEl.innerHTML = ''; return; }
    try { ctx.now = await lookupNow(+at.lat, +at.lon, { elevFt: spot ? null : lake.elevationFt ?? null, force }); } catch (e) { console.warn('access now:', e.message); }
    if (nowEl.isConnected) paintNow(nowEl, ctx);
  };
  const load = async () => {
    loadNow();
    if (big && !spot) { el.innerHTML = `<div class="card"><h3>Getting there</h3><p class="muted small">Pick a ramp above or a spot on the map, and the roads, trails and land records around it are checked.</p></div>`; return; }
    const have = await cached(lake, spot);
    if (!el.isConnected) return;
    // A lookup saved before the walk-in profile existed gets one now.
    if (isFresh(have) && !('hike' in have) && navigator.onLine !== false) withHike(lake, spot, have).then(d => { if (el.isConnected) { last = d; draw(lake, d, el, ctx); } });
    if (!isFresh(have)) {
      el.innerHTML = `<div class="card"><h3>Getting there</h3><p class="muted small">${navigator.onLine === false ? 'You’re offline and this spot’s roads and trails haven’t been looked up yet. Open this tab once with signal and they’ll be kept on your phone.' : 'Looking up roads, motor-vehicle maps, trails and land records around this water…'}</p></div>`;
      if (navigator.onLine === false) { if (have) { last = have; draw(lake, have, el, ctx); } return; }
    }
    try {
      const data = await lookupAccess(lake, { spot, onPartial: d => { if (el.isConnected) { last = d; draw(lake, d, el, ctx); } } });
      if (!el.isConnected) return;
      last = data;
      draw(lake, data, el, ctx);
    } catch (e) {
      if (!el.isConnected) return;
      el.innerHTML = `<div class="card"><h3>Getting there</h3><p class="muted small">Couldn’t reach the road and trail services (${esc(e.message)}). Try again with better signal.</p>
        <button data-gt-refresh>Try again</button></div>`;
      el.querySelector('[data-gt-refresh]').onclick = load;
    }
  };
  renderAccess(lake, body.querySelector('#gt-access'));
  renderRoutesCard(lake, body.querySelector('#gt-routes'));
  await load();
}

function draw(lake, data, el, ctx) {
  const s = summarize({ lat: data.lat, lon: data.lon }, data.shoreKm, data.features, { land: data.land });
  ctx.s = s; ctx.data = data;
  if (ctx.now) paintNow(el.parentNode.querySelector('#gt-now'), ctx);
  const S = forLake(lake);
  const v = s.vehicle, hike = data.hike;
  const verdict = v ? CLASS_TEXT[v.cls] : s.nearestUnknown ? CLASS_TEXT.unknown : null;
  const walk = v && v.hikeKm > 0.08;
  const dead = !data.features.length && data.failed.length >= 5;
  const headline = dead ? 'Nothing could be checked right now: the road and land services didn’t answer. Try again with better signal.'
    : !v && !s.nearestUnknown ? `No road comes within ${fmtMi(data.searchKm)} of this water in the public records: a walk-in, boat-in or private water.`
    : v && !walk ? `${verdict.label}: drive to the water${v.road.tags.dates?.car ? ` (open ${esc(v.road.tags.dates.car)}; ${seasonNow(v.road)})` : ''}.`
    : v ? `${verdict.label} to within ${fmtMi(v.hikeKm)}, then on foot.`
    : `A road reaches the water (${fmtMi(s.nearestUnknown.shoreKm)}), but the records don’t say what it takes to drive it.`;

  const wild = (data.land?.parcels ?? []).find(isWilderness);
  const wildNote = wild ? ` The water is in the ${esc(wild.unit || 'a wilderness')}: no bikes or motor vehicles inside wilderness (<a href="${WILDERNESS_URL}" target="_blank" rel="noopener">Wilderness Act ↗</a>, ${srcs(wild)}).` : '';
  const chip = (icon, label, ok, note) => `<div class="gt-chip ${ok === true ? 'ok' : ok === false ? 'no' : ''}"><span>${icon}</span><div><b>${label}</b><div class="muted small">${note}</div></div></div>`;
  // Named routes first; unnamed ones are counted, not listed ("and 5 unnamed paths").
const list = items => {
  const named_ = uniq(items.filter(t => t.name)), unnamed = items.filter(t => !t.name).length;
  const out = named_.slice(0, 4).map(t => `${named(t)}${t.shoreKm > 0.08 ? ` <span class="muted">(${fmtMi(t.shoreKm)})</span>` : ''} ${srcs(t)}`);
  if (unnamed && out.length < 4) out.push(`${named_.length ? 'and ' : ''}${unnamed} unnamed ${items[0]?.kind === 'road' ? 'road' : 'path'}${unnamed > 1 ? 's' : ''}`);
  return out.join(', ');
};
  const chips = [
    chip(verdict?.icon ?? '🥾', v ? verdict.label : 'No drivable road found', v ? ['paved', 'road', 'car'].includes(v.cls) : null,
      v ? `${esc(v.road.name || 'unnamed road')}: ${verdict.text} ${v.road.tags.maint ? `Forest Service maintenance “${esc(v.road.tags.maint.toLowerCase())}”. ` : ''}${srcs(v.road)}` : s.nearestUnknown ? `${esc(s.nearestUnknown.name || 'A road')} reaches the water, type unknown. ${srcs(s.nearestUnknown)}` : 'Within the area checked.'),
    chip('🥾', walk ? (hike?.stats ? `Hike ${fmtMi(hike.km)}, ${fmtFt(hike.stats.upM)} up, about ${fmtMins(hike.stats.minIn)}` : `Hike about ${fmtMi(hike?.km ?? v.hikeKm)}`) : v ? 'No hike needed' : 'Hike-in', walk ? null : v ? true : null,
      walk && hike && !hike.crow ? `Along ${hike.trails.length ? list(hike.trails.map(t => ({ ...t, kind: 'trail', shoreKm: 0, sources: [t.source] }))) : 'mapped roads and paths'}; details below.`
      : s.hikeTrails.length ? `Trails nearby: ${list(s.hikeTrails)}` : walk ? 'No mapped trail from the road: expect cross-country or an unmapped use trail.' : v ? 'The road reaches the shore.' : 'No road or trail reaches the shore in the records checked.'),
    chip('🚵', wild ? 'No bikes in the wilderness' : s.bikeTrails.length ? 'Mountain bike OK on some trails' : s.noBikeTrails.length ? 'Bikes not allowed on nearby trails' : 'Bike access not recorded', wild ? false : s.bikeTrails.length ? true : s.noBikeTrails.length ? false : null,
      (s.bikeTrails.length ? `${wild ? 'Outside the wilderness boundary only: ' : ''}${list(s.bikeTrails)}` : s.noBikeTrails.length ? `No bikes: ${list(s.noBikeTrails)}` : 'A bike can use any road open to cars.') + wildNote
      + (s.trails.some(t => t.tags.pct) ? ' The Pacific Crest Trail is closed to bikes along its whole length.' : '')),
    chip('🏍️', s.motoTrails.length || s.ohvRoads.length ? 'Motorcycle / ATV routes nearby' : s.streetLegalOnly.length ? 'Street-legal vehicles only' : 'No OHV routes recorded', s.motoTrails.length || s.ohvRoads.length ? true : s.streetLegalOnly.length ? false : null,
      (s.motoTrails.length || s.ohvRoads.length ? `${uniq([...s.motoTrails, ...s.ohvRoads]).slice(0, 4).map(t => `${named(t)}${t.tags.atv === 'no' ? ' (motorcycles only)' : ''} ${srcs(t)}`).join(', ')}` : s.streetLegalOnly.length ? `${list(s.streetLegalOnly)}: no green-sticker OHVs on these roads.` : 'Dirt bikes and ATVs need a route designated for them; none is recorded around this water.') + (s.motoTrails.length || s.ohvRoads.length ? '' : wildNote)),
  ];
  chips.push(cellChip(ctx, s, chip));
  if (s.seasonal.length) chips.push(chip('⏱', 'Seasonal', null, uniq(s.seasonal).slice(0, 3).map(f => `${named(f)}: ${esc(dates(f))}${seasonNow(f) ? `, ${seasonNow(f)}` : ''} ${srcs(f)}`).join('<br>')));
  if (s.lockedGates.length) chips.push(chip('🔒', 'Locked or private gate on the way', false, s.lockedGates.map(g => `${named(g)}${g.tags.access ? ` (${esc(g.tags.access)})` : ''} ${fmtMi(g.shoreKm)} out ${src(g.source)}`).join('<br>')));

  const land = data.land?.parcels?.length ? data.land.parcels : null;
  const landHtml = land ? land.map((p, i) => {
    const m = MANAGERS[p.manager] ?? { name: p.localManager || p.manager || 'Unknown manager', hint: '' };
    return `<div class="${i ? 'small muted' : ''}" style="margin-top:${i ? 6 : 0}px"><b>${esc(m.name)}</b>${p.unit ? ` · ${esc(p.unit)}` : ''}${p.designation ? ` <span class="muted">(${esc(DESIGNATIONS[p.designation] ?? p.designation)})</span>` : ''}${p.access && PUB_ACCESS[p.access] ? ` · ${PUB_ACCESS[p.access]}` : ''} ${src(p.source)}
      ${!i && m.hint ? `<div class="small muted">${m.hint}</div>` : ''}${isWilderness(p) ? `<div class="small muted">Wilderness: on foot or horseback only. Some wildernesses need a permit even for day hikes or have quotas; check the forest’s page.</div>` : ''}</div>`;
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

  ${walk && hike ? hikeCard(hike) : ''}

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
    ctx.refreshNow?.();
    try { draw(lake, await lookupAccess(lake, { spot: data.spot, force: true, onPartial: d => el.isConnected && draw(lake, d, el, ctx) }), el, ctx); } catch (err) { el.querySelector('.gt-head').textContent = `Couldn’t refresh: ${err.message}`; }
  };
  // Permits and quotas, trailheads and parking, and the GPX of it all (views/tabs/access-more.js).
  if (dead) el.parentNode?.querySelector('#gt-more')?.replaceChildren(); // not the last spot's cards under "nothing could be checked"
  else import('./access-more.js').then(m => m.renderAccessMore(lake, data, s, el.parentNode?.querySelector('#gt-more'))).catch(e => console.warn('access more:', e.message));
  el.querySelectorAll('[data-gt-map]').forEach(b => b.addEventListener('click', e => { e.preventDefault(); showRoutes(lake, s, hike); }));
  el.querySelector('[data-gt-gpx]')?.addEventListener('click', e => { e.preventDefault(); exportWalkIn(lake, hike); });
}

// ---------- Cell signal ----------
// What you and your crew noted, then the nearest cell mast OpenStreetMap knows of (a rough hint: masts are mapped
// patchily, and terrain decides more than distance).
const CARRIER_MAPS = [['Verizon', 'https://www.verizon.com/coverage-map/'], ['AT&T', 'https://www.att.com/maps/wireless-coverage.html'], ['T-Mobile', 'https://www.t-mobile.com/coverage/coverage-map']];
function cellChip(ctx, s, chip) {
  const reports = [ctx.mine && { who: 'You', n: ctx.mine }, ...ctx.crew.map(n => ({ who: n.from, n }))].filter(r => r && signalSummary(r.n));
  const vals = reports.flatMap(r => Object.values(r.n.signal ?? {}));
  const ok = vals.includes('data') || vals.includes('calls') ? true : vals.length && vals.every(v => v === 'none' || v === 'sos') ? false : null;
  const mast = s.masts?.[0];
  const mastText = mast ? `Nearest mapped cell mast: ${fmtMi(mast.distKm)}${mast.tags.operator ? ` (${esc(mast.tags.operator)})` : ''} ${src(mast.source)}.` : s.masts ? 'No cell mast is mapped within 9 mi.' : '';
  const links = `Carrier maps: ${CARRIER_MAPS.map(([n, u]) => `<a href="${u}" target="_blank" rel="noopener">${n} ↗</a>`).join(' · ')}`;
  return chip('📶', reports.length ? 'Cell signal, from your notes' : 'Cell signal not noted yet', ok,
    `${reports.map(r => `<b>${esc(r.who)}</b>${r.n.checked ? ` (${esc(fmtDate(r.n.checked))})` : ''}: ${esc(signalSummary(r.n))}`).join('<br>')}${reports.length ? '<br>' : ''}
      ${mastText} ${ok === true ? '' : 'Save the offline map before you go if signal is doubtful.'} ${reports.length ? '' : 'Add what your phone gets in your access notes, and your crew’s show up here when they share theirs.'}<br>${links}`);
}

// ---------- The walk in ----------
// Distance, climb, time each way, where to start, and the elevation profile drawn as a small chart.
function hikeCard(h) {
  const st = h.stats;
  const prof = h.profile?.length > 1 ? profileSvg(h.profile) : '';
  return `<div class="card"><h3>🥾 The walk in</h3>
    <p class="small"><b>${fmtMi(h.km)}</b>${st ? ` · <b>${fmtFt(st.upM)} up</b>, ${fmtFt(st.downM)} down · about <b>${fmtMins(st.minIn)}</b> in, ${fmtMins(st.minOut)} back out` : ''}${st ? ` · ${fmtFt(st.minM)}–${fmtFt(st.maxM)}` : ''}</p>
    ${prof}
    <p class="small">${h.crow ? 'No mapped trail joins the road to the shore, so this is the straight line: expect cross-country walking or an unmapped use trail, and allow more time.' : `Start where ${h.start.road ? esc(h.start.road) : 'the road'} meets the way in${h.trails.length ? `, then ${h.trails.map(t => `${esc(t.name || 'an unnamed trail')}${t.source?.url ? ` ${src(t.source)}` : ''}`).join(', then ')}` : ''}.`}
      <a href="${directionsUrl(h.start.lat, h.start.lon)}" target="_blank" rel="noopener">Directions to the start ↗</a> · <a href="#" data-gt-map>Show on map</a> · <a href="#" data-gt-gpx>⬇ GPX for Gaia or CalTopo</a></p>
    <p class="muted small">Time by Naismith’s rule (3 mph, plus an hour for every 2,000 ft of climb); slower with a pack, kids or snow. ${h.elevationSource ? `Elevations from <a href="${h.elevationSource.url}" target="_blank" rel="noopener">${esc(h.elevationSource.label)} ↗</a>.` : h.profileFailed ? 'The elevation service didn’t answer, so the climb isn’t known.' : ''}</p></div>`;
}
function profileSvg(p) {
  const W = 320, H = 70, maxD = p.at(-1)[0] || 1, es = p.map(x => x[1]), lo = Math.min(...es), hi = Math.max(...es), span = Math.max(hi - lo, 15);
  const pt = ([d, e]) => `${(d / maxD * W).toFixed(1)},${(H - 4 - (e - lo) / span * (H - 14)).toFixed(1)}`;
  const line = p.map(pt).join(' ');
  return `<svg class="gt-profile" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Elevation profile from the road to the water">
    <polygon points="0,${H} ${line} ${W},${H}" class="fill"/><polyline points="${line}" class="line"/></svg>
    <div class="row small muted gt-profile-axis"><span>Road · ${fmtFt(es[0])}</span><span>Water · ${fmtFt(es.at(-1))}</span></div>`;
}

// ---------- Today: snow and wildfires ----------
function paintNow(el, ctx) {
  if (!el?.isConnected || !ctx.now) return;
  const now = ctx.now, snow = snowAt(now), s = ctx.s, v = s?.vehicle;
  if (now.failed?.length >= 3) {
    el.innerHTML = `<p class="small muted">Couldn’t check snow and wildfires just now (no signal, or the services didn’t answer). <a href="#" data-now-refresh>Try again</a></p>`;
    el.querySelector('[data-now-refresh]').onclick = e => { e.preventDefault(); ctx.refreshNow?.(); };
    return;
  }
  const dirt = v && !['paved', 'road'].includes(v.cls);
  const parts = [];
  if (snow?.level) {
    const where = snow.station ? `${esc(snow.station.name)} snow station (${snow.station.elevFt.toLocaleString()} ft, ${fmtMi(snow.station.distKm)} away) measured <b>${Math.round(snow.station.depthIn)} in</b> on the ground ${snow.station.date ? fmtDate(snow.station.date) : ''}${snow.station.weekAgoIn != null && Math.round(snow.station.weekAgoIn) !== Math.round(snow.station.depthIn) ? `, ${Math.round(snow.station.weekAgoIn)} in a week before` : ''} ${src(snow.station.source)}`
      : `The weather model puts <b>${Math.round(snow.depthIn)} in</b> of snow on the ground at ${now.elevFt ? `${now.elevFt.toLocaleString()} ft` : 'the water'} ${src(snow.model?.source)}`;
    const [icon, head] = { deep: ['❄️', 'Snowed in'], some: ['❄️', 'Some snow on the ground'], coming: ['🌨️', 'Snow in the forecast'], none: ['☀️', 'No snow on the ground'] }[snow.level];
    const say = {
      deep: `${dirt ? 'The dirt road and trails in are very likely blocked' : 'Trails and side roads are likely blocked; chains may be required on the highway'}. Check the road conditions links before you go.`,
      some: `${dirt ? 'The dirt road in may be muddy, icy or drifted: high clearance, 4WD and chains help.' : 'Paved roads may need chains; trails will have patchy snow.'}`,
      coming: `About ${Math.round(snow.next3In)} in expected by ${fmtDay(now.model?.next?.[2]?.date)}${dirt ? ': a dirt road in can turn impassable fast' : ''}.`,
      none: snow.weekIn >= 2 ? `About ${Math.round(snow.weekIn)} in of snow is forecast this week${snow.firstSnow ? `, starting ${fmtDay(snow.firstSnow.date)}` : ''}.` : 'None forecast this week either.',
    }[snow.level];
    // Low water with no snow: one quiet line.
    if (snow.level === 'none' && (now.elevFt ?? 0) < 4000 && snow.weekIn < 1) parts.push(`<p class="small muted">☀️ No snow at this elevation, none forecast.</p>`);
    else parts.push(`<div class="gt-chip ${snow.level === 'none' ? 'ok' : snow.level === 'coming' ? '' : 'no'}"><span>${icon}</span><div><b>${head}</b><div class="small">${say}</div><div class="muted small">${where}.${snow.station && snow.model?.next?.length && snow.weekIn >= 1 ? ` Forecast snowfall this week: ${Math.round(snow.weekIn)} in ${src(snow.model.source)}.` : ''}</div></div></div>`);
  }
  const fires = now.fires ?? [];
  const forest = (ctx.data?.land?.parcels ?? []).find(p => p.manager === 'USFS' && forestAlerts(p.unit));
  const alerts = forest && forestAlerts(forest.unit);
  if (fires.length) {
    const close = fires.filter(f => !f.rx && (f.inside || (f.distKm <= 16 && (f.contained ?? 0) < 100)));
    const fireLine = f => `<div class="small" style="margin-top:4px"><b>${esc(f.name)}${f.rx ? ' (prescribed burn)' : ''}</b>: ${f.inside ? '<b>the water is inside its perimeter</b>' : `${fmtMi(f.distKm)} away${f.perimeter ? ' (to its edge)' : ''}`}${f.acres ? ` · ${Math.round(f.acres).toLocaleString()} acres` : ''}${f.contained != null ? ` · ${f.contained}% contained` : ''}${f.updated ? ` · updated ${fmtDate(f.updated)}` : ''}
      ${f.inciweb ? `<a href="${esc(f.inciweb)}" target="_blank" rel="noopener">InciWeb ↗</a>` : ''} ${src(f.source)}</div>`;
    parts.push(`<div class="gt-chip ${close.length ? 'no' : ''}"><span>🔥</span><div><b>${close.some(f => f.inside) ? 'Fire at this water' : close.length ? 'Fire nearby' : fires.every(f => f.rx) ? 'Prescribed burn nearby' : fires.every(f => f.rx || f.contained >= 100) ? 'Contained fires nearby' : 'Fires in the area'}</b>
      ${fires.map(fireLine).join('')}
      <div class="muted small" style="margin-top:4px">Fires and their burn areas often close roads, trails and whole forest areas, sometimes for months after they’re out.${alerts ? ` <a href="${alerts}" target="_blank" rel="noopener">${esc(forest.unit)} closure orders ↗</a>` : ''}${forLake(ctx.lake)?.code === 'CA' ? `${alerts ? ' ·' : ''} <a href="https://www.fire.ca.gov/incidents" target="_blank" rel="noopener">CAL FIRE incidents ↗</a>` : ''}</div></div></div>`);
  } else if (now.fires) parts.push(`<p class="small muted">🔥 No active fire or prescribed burn reported within 30 miles${alerts ? ` · <a href="${alerts}" target="_blank" rel="noopener">${esc(forest.unit)} alerts and closures ↗</a>` : ''}.</p>`);
  el.innerHTML = `<div class="card"><h3>Today</h3><div class="gt-chips">${parts.join('')}</div>
    <p class="muted small" style="margin-top:8px">${now.failed?.length ? `<b>Didn’t answer: ${esc(now.failed.join(', '))}.</b> ` : ''}Snow from NRCS SNOTEL stations and the Open-Meteo model; fires from the national interagency fire feed (NIFC). Checked ${fmtDate(now.fetchedAt)} ${new Date(now.fetchedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} · <a href="#" data-now-refresh>refresh</a></p></div>`;
  el.querySelector('[data-now-refresh]').onclick = e => { e.preventDefault(); el.querySelector('[data-now-refresh]').textContent = 'checking…'; ctx.refreshNow?.(); };
}
const fmtDay = iso => iso ? new Date(iso + 'T12:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : 'the weekend';

const uses = t => [t.foot !== 'no' && 'hike', (t.bike === 'yes' || t.bike === 'seasonal') && 'bike', t.bike === 'no' && 'no bikes', (t.motorcycle === 'yes' || t.motorcycle === 'seasonal') && 'motorcycle', (t.atv === 'yes' || t.atv === 'seasonal') && 'ATV',
  (t.motorcycle === 'no' && t.atv === 'no') && 'no motor vehicles'].filter(Boolean).join(', ');

// ---------- Map ----------
const COLORS = { paved: '#2b6cb0', road: '#2b6cb0', car: '#b7791f', highClearance: '#c05621', ohvOnly: '#9b2c2c', unknown: '#718096', closed: '#4a5568' };
let routeLayer = null;
function showRoutes(lake, s, hike) {
  if (!routeLayer) { routeLayer = L.layerGroup(); layersControl.addOverlay(routeLayer, 'Roads & trails'); }
  routeLayer.clearLayers().addTo(map);
  const pop = f => `<b>${named(f)}</b><br>${esc([CLASS_TEXT[f.cls]?.label, f.cls ? null : uses(f.tags), f.tags.designation].filter(Boolean).join(' · '))}${dates(f) ? `<br>⏱ ${esc(dates(f))}` : ''}<br>${(f.sources ?? [f.source]).map(x => `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.label)} ↗</a>`).join('<br>')}`;
  for (const r of s.roads) for (const p of r.paths) L.polyline(p, { color: COLORS[r.cls] ?? COLORS.unknown, weight: r.cls === 'paved' ? 4 : 3, opacity: 0.85 }).bindPopup(pop(r)).addTo(routeLayer);
  for (const t of s.trails) for (const p of t.paths) L.polyline(p, { color: t.tags.motorcycle === 'yes' || t.tags.atv === 'yes' ? '#9b2c2c' : t.tags.bike === 'yes' ? '#2f855a' : '#6b46c1', weight: 2, dashArray: '6 5', opacity: 0.9 }).bindPopup(pop(t)).addTo(routeLayer);
  for (const g of s.lockedGates) L.circleMarker([g.lat, g.lon], { radius: 6, color: '#c53030', fillOpacity: 0.9 }).bindPopup(pop(g)).addTo(routeLayer);
  if (hike?.coords?.length) {
    L.polyline(hike.coords, { color: '#d69e2e', weight: 6, opacity: 0.9, dashArray: hike.crow ? '2 8' : null }).bindPopup(`<b>The walk in</b><br>${fmtMi(hike.km)}${hike.stats ? `, ${fmtFt(hike.stats.upM)} up, about ${fmtMins(hike.stats.minIn)}` : ''}${hike.crow ? '<br>Straight line: no mapped trail' : ''}`).addTo(routeLayer);
    L.circleMarker([hike.start.lat, hike.start.lon], { radius: 7, color: '#fff', weight: 2, fillColor: '#d69e2e', fillOpacity: 1 }).bindPopup(`<b>Start walking here</b>${hike.start.road ? `<br>${esc(hike.start.road)}` : ''}<br><a href="${directionsUrl(hike.start.lat, hike.start.lon)}" target="_blank" rel="noopener">Directions ↗</a>`).addTo(routeLayer);
  }
  showView('map');
  const b = L.latLngBounds([[s.at.lat, s.at.lon]]);
  for (const f of [...s.roads, ...s.trails]) for (const p of f.paths) for (const pt of p) b.extend(pt);
  map.fitBounds(b.pad(0.05), { maxZoom: 15 });
}
