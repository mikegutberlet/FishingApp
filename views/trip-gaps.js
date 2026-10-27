// Getting there, the trip gaps: can I launch at today's level, what's on the roads in (chains, closures, winter
// passes), where to top off gas, ice and bait before the last stretch, and the state's regs booklet for the glovebox.
import { db } from '../db.js';
import { forLake, reservoirFor } from '../states/index.js';
import { esc, fmtDate, status } from '../ui.js';
import { latestLevel, levelRate, rampStatus, rampsFor, STATUS_PAGES, STATE_PAGES } from '../ramps.js';
import { roadsNear, CHAIN_LEVELS, CHAIN_INFO_URL, STATE_ROADS, chainSeason } from '../roads.js';
import { lookupSupplies, cachedSupplies, KINDS } from '../supplies.js';
import { bookletHtml, wireBooklets, BOOKLET_HELP } from '../regs-booklet.js';
import { haversineKm } from '../data-sources.js';

const MI = 0.621371;
const mi = km => km < 1.6 ? `${(km * MI).toFixed(1)} mi` : `${Math.round(km * MI)} mi`;
const ago = iso => { const m = Math.round((Date.now() - Date.parse(iso)) / 60e3); return m < 2 ? 'just now' : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };
const ft = n => `${Math.abs(n) < 10 ? Math.abs(n).toFixed(1) : Math.round(Math.abs(n))} ft`;

export async function renderTripGaps(lake, el) {
  if (!el) return;
  el.innerHTML = `<div class="card tg-card" id="tg-ramps"></div><div class="card tg-card" id="tg-roads"></div><div class="card tg-card" id="tg-supplies"></div><div class="card tg-card" id="tg-regs"></div>`;
  await Promise.all([rampsCard(lake, el.querySelector('#tg-ramps')), roadsCard(lake, el.querySelector('#tg-roads')), suppliesCard(lake, el.querySelector('#tg-supplies')), regsCard(lake, el.querySelector('#tg-regs'))]);
}

// ---------- Ramps at today's level ----------
export async function rampsCard(lake, el) {
  const res = await reservoirFor(lake).catch(() => null);
  if (!el.isConnected) return;
  const lvl = latestLevel(res?.elevation);
  if (!lvl) { el.remove(); return; } // no level gauge: nothing to compare a ramp with
  const rate = levelRate(res.elevation);
  const { table, ramps } = rampsFor(lake, res.id);
  const page = STATUS_PAGES[String(res.id).toUpperCase()] ?? table?.url;
  const rows = ramps.map(r => ({ r, s: rampStatus(r, lvl.ft, rate) }));
  const when = d => d == null ? '' : d < 14 ? `${d} day${d === 1 ? '' : 's'}` : `${Math.round(d / 7)} weeks`;
  const line = ({ r, s }) => `<li class="${s.usable ? 'tg-ok' : 'tg-no'}"><b>${s.usable ? '✅' : '⛔'} ${esc(r.name)}</b>${r.mine ? ' <span class="muted small">(yours)</span>' : ''}<br>
    <span class="small">${s.usable
      ? `${r.stages.length > 1 ? `${esc(s.stage)}${s.spare != null ? ', ' : ''}` : ''}${s.spare != null ? `${ft(s.spare)} above its floor (${s.floor.toLocaleString()} ft)` : ''}${s.daysLeft != null ? ` · at this drop, about ${when(s.daysLeft)} until it closes` : ''}`
      : s.why === 'low' ? `${ft(s.short)} too low: usable from ${s.at.toLocaleString()} ft${s.days != null ? ` · at this rise, about ${when(s.days)}` : ''}`
      : `${esc(s.stage)} opens when the lake drops to ${s.at.toLocaleString()} ft (${ft(s.short)} to go${s.days != null ? `, about ${when(s.days)} at this drop` : ''})`}</span></li>`;
  el.innerHTML = `<h3>🚤 Ramps at today's level</h3>
    <p class="small"><b>${lvl.ft.toLocaleString(undefined, { maximumFractionDigits: 1 })} ft</b> on ${fmtDate(lvl.date)} at ${esc(res.name)}${rate != null ? ` · ${rate > 0.05 ? 'rising' : rate < -0.05 ? 'dropping' : 'steady'}${Math.abs(rate) > 0.05 ? ` ${ft(rate * 7)} a week` : ''}` : ''}</p>
    ${rows.length ? `<ul class="tg-list">${rows.map(line).join('')}</ul>` : '<p class="muted small">No ramp levels for this water yet. Add one from the sign at the ramp or the agency\'s ramp page, and the app checks it against the level every day.</p>'}
    ${table ? `<p class="muted small">Ramp levels: <a href="${table.url}" target="_blank" rel="noopener">${esc(table.by)}</a>, checked ${fmtDate(table.checked)}. Agencies close ramps for other reasons too (staffing, mussel checks).${table.note ? ` ${esc(table.note)}` : ''}</p>` : ''}
    ${page && !table ? `<p class="small"><a href="${page}" target="_blank" rel="noopener">Ramp status from the agency</a></p>` : ''}
    ${stateRampPage(lake)}
    ${lake.unsaved ? '<p class="muted small">Save this water to add your own ramps\' levels.</p>' : '<button class="small" id="tg-ramp-add">➕ Add a ramp\'s usable level</button><div id="tg-ramp-form"></div>'}`;
  el.querySelector('#tg-ramp-add')?.addEventListener('click', () => rampForm(lake, el, lvl));
  // Yours can be removed.
  const mine = ramps.filter(r => r.mine);
  if (mine.length) el.querySelector('.tg-list')?.insertAdjacentHTML('afterend', `<p class="small muted">Yours: ${mine.map(r => `${esc(r.name)} <a href="#" data-ramp-rm="${esc(r.name)}">remove</a>`).join(' · ')}</p>`);
  el.querySelectorAll('[data-ramp-rm]').forEach(a => a.onclick = async e => { e.preventDefault(); await saveRampLevels(lake, (lake.rampLevels ?? []).filter(r => r.name !== a.dataset.rampRm)); rampsCard(lake, el); });
}

function stateRampPage(lake) {
  const code = forLake(lake)?.code, p = STATE_PAGES[code];
  if (!p || (p.near && haversineKm(+lake.lat, +lake.lon, p.near[0], p.near[1]) > p.near[2])) return '';
  return `<p class="small"><a href="${p.url}" target="_blank" rel="noopener">${esc(p.name)}</a></p>`;
}

async function saveRampLevels(lake, list) {
  const fresh = (await db.get('lakes', lake.id)) ?? lake;
  fresh.rampLevels = lake.rampLevels = list;
  await db.put('lakes', fresh);
}

function rampForm(lake, card, lvl) {
  const box = card.querySelector('#tg-ramp-form');
  box.innerHTML = `<form class="form tg-form"><label>Ramp <input name="name" required placeholder="e.g. Main ramp" maxlength="60"></label>
    <label>Usable down to (lake level, ft above sea level) <input name="minFt" type="number" step="0.1" inputmode="decimal" required placeholder="${Math.round(lvl.ft - 10)}"></label>
    <p class="muted small">From the sign at the ramp or the agency's ramp page. The gauge reads ${lvl.ft.toLocaleString()} ft now.</p>
    <div class="row"><button class="primary">Save</button><button type="button" data-cancel>Cancel</button></div></form>`;
  const f = box.querySelector('form');
  f.querySelector('[data-cancel]').onclick = () => { box.innerHTML = ''; };
  f.onsubmit = async e => {
    e.preventDefault();
    const name = f.name.value.trim(), minFt = +f.minFt.value;
    if (!name || !Number.isFinite(minFt)) return;
    await saveRampLevels(lake, [...(lake.rampLevels ?? []).filter(r => r.name.toLowerCase() !== name.toLowerCase()), { name, minFt }]);
    status('Ramp saved');
    rampsCard(lake, card);
  };
  f.name.focus();
}

// ---------- Roads in: chain controls, closures, winter passes ----------
export async function roadsCard(lake, el, { auto = chainSeason() } = {}) {
  const code = forLake(lake)?.code ?? 'CA';
  const links = [STATE_ROADS[code], ...(code === 'CA' ? [] : [STATE_ROADS.CA])].filter(Boolean)
    .map(s => `<a href="${s.url}" target="_blank" rel="noopener">${esc(s.name)}</a>${s.phone ? ` (call ${esc(s.phone)})` : ''}`).join(' · ');
  const more = STATE_ROADS[code]?.more;
  const head = `<h3>⛓️ Roads in: chains and closures</h3>`;
  const foot = `<p class="small">${links}${more ? ` · <a href="${more.url}" target="_blank" rel="noopener">${esc(more.name)}</a>` : ''}</p>
    <p class="muted small">Within about ${Math.round(100 * MI)} miles of the water, not your route: the app doesn't know where you start. ${code === 'CA' ? '' : `${esc(STATE_ROADS[code]?.name ?? '')}'s live feed needs a key or doesn't answer apps like this one, so it's a link; California's highways are shown live.`}</p>`;
  if (!auto) {
    el.innerHTML = `${head}<p class="small muted">Chain controls are mostly a winter thing. <a href="#" data-roads-go>Check the roads now</a></p>${foot}`;
    el.querySelector('[data-roads-go]').onclick = e => { e.preventDefault(); roadsCard(lake, el, { auto: true }); };
    return;
  }
  el.innerHTML = `${head}<p class="muted small">Checking Caltrans…</p>${foot}`;
  let r;
  try { r = await roadsNear(lake); } catch (e) { r = null; }
  if (!el.isConnected) return;
  if (!r) { el.querySelector('p').textContent = 'Couldn\'t reach Caltrans (no signal?). Use the links below.'; return; }
  const on = r.chains.filter(c => c.worst > 0);
  const chainHtml = !r.chains.length ? '<p class="small">No Caltrans chain-control points near this water.</p>'
    : on.length ? `<ul class="tg-list">${on.map(c => `<li class="tg-no"><b>⛓️ ${esc(c.route)}</b> <span class="small">${esc(CHAIN_LEVELS[`R-${c.worst}`]?.short ?? `R${c.worst}`)}</span><br>
        <span class="small">${c.points.filter(p => p.level > 0).slice(0, 3).map(p => `${esc(p.name)}${p.place ? ` (${esc(p.place)})` : ''}, ${mi(p.km)} away${p.since ? ` · since ${new Date(p.since).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''}`).join('<br>')}</span></li>`).join('')}</ul>`
    : `<p class="small">✅ No chain controls now on ${r.chains.slice(0, 6).map(c => esc(c.route)).join(', ')}${r.chains.length > 6 ? '…' : ''}.</p>`;
  const closures = r.closures.length ? `<p class="small"><b>Full closures</b> (on now or within 3 days):</p><ul class="tg-list">${r.closures.slice(0, 6).map(c => `<li class="small">🚧 <b>${esc(c.route)}</b> ${esc(c.from)}${c.to && c.to !== c.from ? ` to ${esc(c.to)}` : ''}, ${mi(c.km)} away<br>
      <span class="muted">${c.start ? new Date(c.start).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''}${c.indefinite ? ', until further notice' : c.end ? ` to ${new Date(c.end).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''}${c.work ? ` · ${esc(c.work)}` : ''}</span></li>`).join('')}</ul>` : '';
  const passes = r.passes.length ? `<p class="small"><b>Passes that close for winter</b> near here:</p><ul class="tg-list">${r.passes.map(p => `<li class="small">🏔️ <a href="${p.url}" target="_blank" rel="noopener">${esc(p.name)}</a>, ${mi(p.km)} away. ${esc(p.note)}</li>`).join('')}</ul>` : '';
  el.innerHTML = `${head}<p class="muted small">Caltrans, ${r.stale ? `saved ${ago(r.at)} (no signal now)` : `as of ${ago(r.at)}`}${r.failed.length ? ` · couldn't read ${esc(r.failed.join(', '))}` : ''}. <a href="${CHAIN_INFO_URL}" target="_blank" rel="noopener">What R1/R2/R3 mean</a></p>
    ${chainHtml}${closures}${passes}${foot}`;
}

// ---------- Last gas, ice and bait ----------
export async function suppliesCard(lake, el) {
  const paint = (d, { loading = false } = {}) => {
    const kinds = Object.entries(KINDS);
    el.innerHTML = `<h3>⛽ Last gas, ice and bait</h3>
      ${!d ? `<p class="muted small">${loading ? 'Looking on OpenStreetMap…' : 'Not looked up yet.'}</p>` : kinds.map(([k, m]) => {
        const list = d.places?.[k] ?? [];
        return `<p class="small"><b>${m.icon} ${esc(m.label)}</b>${list.length ? '' : ' <span class="muted">none on the map within 30 mi</span>'}</p>${list.length ? `<ul class="tg-list">${list.slice(0, 3).map(p => `<li class="small"><a href="${p.osm}" target="_blank" rel="noopener">${esc(p.name)}</a>${p.town ? `, ${esc(p.town)}` : ''} · ${mi(p.km)} ${p.dir} of the water${p.diesel ? ' · diesel' : ''}${p.hours ? `<br><span class="muted">${esc(p.hours)}</span>` : ''}${p.phone ? ` <a href="tel:${esc(p.phone.replace(/[^\d+]/g, ''))}">📞</a>` : ''}</li>`).join('')}</ul>` : ''}`;
      }).join('')}
      ${d ? `<p class="muted small">OpenStreetMap, ${d.stale ? `saved ${ago(d.at)} (no signal now)` : `looked up ${ago(d.at)}`}. Straight-line from the water, nearest first: the closest one on your way in is the last stop. Ice: most gas stations and stores carry it; the map rarely says. Hours change: call ahead in the off season.</p>` : ''}
      <button class="small" data-sup-go>${d ? '↻ Look again' : '🔎 Find gas, ice and bait'}</button>`;
    el.querySelector('[data-sup-go]').onclick = () => go(true);
  };
  const go = async (force = false) => {
    paint(null, { loading: true });
    try { paint(await lookupSupplies(lake, { force })); } catch { paint(null); el.querySelector('p').textContent = 'Couldn\'t reach OpenStreetMap (no signal?). Ready for no signal saves this ahead of time.'; }
  };
  const have = await cachedSupplies(lake).catch(() => null);
  if (!el.isConnected) return;
  if (have) paint(have); else go();
}

// ---------- Regs booklet ----------
export function regsCard(lake, el) {
  const code = forLake(lake)?.code;
  const codes = [...new Set([code, ...(lake.name && /topaz/i.test(lake.name) ? ['CA', 'NV'] : [])].filter(Boolean))];
  if (!codes.length) { el.remove(); return; }
  el.innerHTML = `<h3>📕 Regs booklet for no signal</h3>${codes.map(c => bookletHtml(c, esc)).join('')}<p class="muted small">${esc(BOOKLET_HELP)}</p>`;
  wireBooklets(el);
}
