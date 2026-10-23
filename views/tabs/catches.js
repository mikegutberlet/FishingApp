// Catches tab: everything you've logged on this water.
import { db } from '../../db.js';
import { $, showView } from '../../ui.js';
import { renderCatchCards } from '../log.js';

export async function renderLakeCatches(lake, body) {
  const catches = (await db.byLake('catches', lake.id)).sort((a, b) => b.time.localeCompare(a.time));
  body.innerHTML = `<button class="primary" id="log-here">＋ Log a catch here</button><div id="lc" style="margin-top:12px"></div>`;
  $('#log-here').onclick = () => { showView('log'); $('#catch-form').lakeId.value = lake.id; };
  renderCatchCards(catches, $('#lc'));
}
