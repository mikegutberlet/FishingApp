// Catches tab: everything you've logged on this water, with your bests here.
import { db } from '../../db.js';
import { $ } from '../../ui.js';
import { renderCatchCards, logCatchAt } from '../log.js';
import { renderLakeBests } from '../bests.js';

export async function renderLakeCatches(lake, body) {
  const catches = (await db.byLake('catches', lake.id)).sort((a, b) => b.time.localeCompare(a.time));
  body.innerHTML = `<button class="primary" id="log-here">＋ Log a catch here</button><div id="lb" style="margin-top:12px"></div><div id="lc"></div>`;
  $('#log-here').onclick = () => logCatchAt(lake.id);
  renderLakeBests(catches, $('#lb'));
  renderCatchCards(catches, $('#lc'));
}
