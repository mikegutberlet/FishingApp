// Info tab: basic facts and links for the water.
import { forLake, stockIdOf } from '../../states/index.js';
import { esc } from '../../ui.js';
import { renderStateInfo } from '../state-report.js';
import { renderArchiveCard } from '../corpus-card.js';

export function renderInfo(lake, body) {
  const S = forLake(lake), stockId = stockIdOf(lake);
  const field = (k, v) => v ? `<tr><th>${k}</th><td>${esc(v)}</td></tr>` : '';
  body.innerHTML = `<div class="card"><table>
    ${field('Type', lake.type)}${field('State', lake.state)}${field('County', lake.county)}${field('Acres', lake.acres?.toLocaleString?.() ?? lake.acres)}
    ${field('Length (mi)', lake.lengthKm && Math.round(lake.lengthKm * 0.621))}${field('Surface elevation (ft)', lake.elevationFt?.toLocaleString())}
    ${field('Max depth (ft)', lake.maxDepth)}${field('Average depth (ft)', lake.meanDepth)}${field('Clarity (ft)', lake.clarity)}${field('Species', lake.species)}
    ${field('Regulations', lake.regs)}${field('Access', lake.access)}${field('Coordinates', `${lake.lat.toFixed(5)}, ${lake.lon.toFixed(5)}`)}
  </table>${lake.infoUrl ? `<p><a href="${esc(lake.infoUrl)}" target="_blank" rel="noopener">State lake page ↗</a></p>` : ''}
  ${stockId ? `<p><a href="${esc(S.waterUrl(stockId))}" target="_blank" rel="noopener">${S.agency} page for this water ↗</a></p>` : ''}
  <p class="muted small">${lake.unsaved ? 'Names, size and elevation from the USGS National Hydrography Dataset.' : 'Tap Edit to fill in details from your state lake page.'}</p></div><div id="state-info"></div><div id="archive"></div>`;
  renderStateInfo(lake, body.querySelector('#state-info'));
  renderArchiveCard(lake, body.querySelector('#archive')).catch(e => console.warn('archive:', e.message));
  // California's countyAt gives a name; Nevada's gives { county, region }.
  if (!lake.county && S?.countyAt) S.countyAt(lake.lat, lake.lon).then(c => { const n = typeof c === 'string' ? c : c?.county; if (n) body.querySelector('table')?.insertAdjacentHTML('afterbegin', field('County', n)); });
}
