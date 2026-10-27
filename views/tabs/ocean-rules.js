// Ocean rules tab: license (no license on California public piers), the groundfish area and where this year's
// seasons live, and marine protected areas at or near the spot with a "no take here" warning.
import { mpasNear } from '../../coast.js';
import { licenseFacts, groundfishFacts, mpaType, CA_LINKS, OR_LINKS } from '../../ocean-rules.js';
import { esc } from '../../ui.js';

const link = ([label, url]) => `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(label)} ↗</a>`;
const spotOf = lake => ({ kind: lake.coastKind ?? 'spot', lat: lake.lat, lon: lake.lon });

export async function renderOceanRules(lake, body) {
  const state = lake.state === 'OR' || lake.lat >= 42 ? 'OR' : 'CA', spot = spotOf(lake);
  const lic = licenseFacts(spot, state), gf = groundfishFacts(spot, state);
  body.innerHTML = `<div id="oc-mpa"></div>
    <div class="card"><h3>License</h3>${lic.map(f => `<div class="oc-fact ${f.tone}"><span>${f.icon}</span><div><b>${esc(f.title)}</b><div class="small">${esc(f.text)}</div></div></div>`).join('')}
      <p class="small">${link(state === 'CA' ? CA_LINKS.license : OR_LINKS.license)}</p></div>
    ${gf ? `<div class="card"><h3>${esc(gf.area)}</h3><p class="muted small">${esc(gf.span)}</p><p class="small">${esc(gf.text)}</p><p class="small">${gf.links.map(link).join('<br>')}</p></div>` : ''}
    <div class="card"><h3>Marine protected areas</h3><p class="small">${state === 'CA' ? 'California has 124 marine protected areas. In a State Marine Reserve you may not fish or take anything; Conservation Areas allow only what each one lists.' : 'Oregon has five marine reserves (no fishing or take of any kind) and nearby protected areas that allow some fishing.'}
      Turn on <b>Marine protected areas</b> in the map’s layers to see the lines.</p><p class="small">${link(state === 'CA' ? CA_LINKS.mpas : OR_LINKS.reserves)}</p></div>
    <p class="muted small">Rules summarized by hand from ${state === 'CA' ? 'CDFW (Title 14 CCR)' : 'ODFW'}; seasons and depth limits change during the year, so the agency pages above have the final word, as do posted signs.</p>`;
  const box = body.querySelector('#oc-mpa');
  const near = await mpasNear(lake.lat, lake.lon, 2).catch(() => []);
  if (!body.isConnected) return;
  box.innerHTML = mpaBanner(near);
}

// The banner for areas at or near a point: red when inside a no-take area, amber for limited take or a no-take line close by.
export function mpaBanner(near) {
  if (!near.length) return `<div class="card"><p class="small oc-noalert">✅ No marine protected area within about a mile of this spot (CDFW / ODFW boundaries).</p></div>`;
  const rows = near.slice(0, 4).map(a => {
    const t = mpaType(a.key);
    const where = a.inside ? 'You’re inside' : `${(a.edgeKm * 0.621).toFixed(a.edgeKm < 1.6 ? 1 : 0)} mi away:`;
    return `<div class="banner ${a.inside && t.take === 'none' ? 'hab-danger' : t.take === 'none' || a.inside ? 'hab-warning' : 'hab-caution'} small">
      <b>${a.inside && t.take === 'none' ? '⛔ No take here. ' : ''}${esc(where)} ${esc(a.name)}</b><div>${esc(t.label)}. ${esc(t.note)}</div>
      ${a.url ? `<a href="${esc(a.url)}" target="_blank" rel="noopener">This area’s rules ↗</a>` : ''}</div>`;
  });
  return rows.join('') + `<p class="muted small">Boundaries are drawn from the agencies’ maps and are not for navigation; the regulations’ coordinates are the legal lines.</p>`;
}
