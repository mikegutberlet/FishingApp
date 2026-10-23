// Info tab: basic facts and links for the water.
import * as CA from '../../states/ca.js';
import { esc } from '../../ui.js';
import { renderAccess } from '../access.js';

export function renderInfo(lake, body) {
  const field = (k, v) => v ? `<tr><th>${k}</th><td>${esc(v)}</td></tr>` : '';
  body.innerHTML = `<div class="card"><table>
    ${field('Type', lake.type)}${field('State', lake.state)}${field('County', lake.county)}${field('Acres', lake.acres?.toLocaleString?.() ?? lake.acres)}
    ${field('Length (mi)', lake.lengthKm && Math.round(lake.lengthKm * 0.621))}${field('Surface elevation (ft)', lake.elevationFt?.toLocaleString())}
    ${field('Max depth (ft)', lake.maxDepth)}${field('Average depth (ft)', lake.meanDepth)}${field('Clarity (ft)', lake.clarity)}${field('Species', lake.species)}
    ${field('Regulations', lake.regs)}${field('Access', lake.access)}${field('Coordinates', `${lake.lat.toFixed(5)}, ${lake.lon.toFixed(5)}`)}
  </table>${lake.infoUrl ? `<p><a href="${esc(lake.infoUrl)}" target="_blank" rel="noopener">State lake page ↗</a></p>` : ''}
  ${lake.cdfwStockId ? `<p><a href="${CA.waterUrl(lake.cdfwStockId)}" target="_blank" rel="noopener">CDFW fishing guide for this water ↗</a></p>` : ''}
  <p class="muted small">${lake.unsaved ? 'Names, size and elevation from the USGS National Hydrography Dataset.' : 'Tap Edit to fill in details from your state lake page.'}</p></div><div id="access"></div>`;
  renderAccess(lake, body.querySelector('#access'));
  if (!lake.county) CA.countyAt(lake.lat, lake.lon).then(c => c && body.querySelector('table')?.insertAdjacentHTML('afterbegin', field('County', c)));
}
