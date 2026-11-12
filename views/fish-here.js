// "What's in here": the fish the state's own lists name for a water, on its Stocking tab. Each fish says how it is
// known: the state plans to stock it this year (California's stocking document), the state lists it as living there
// (Nevada's fishable waters, Oregon's distribution maps), or a catch of it is on the state's record books (Nevada).
// The lists are built monthly into data/<st>/species.json (scripts/build-species.mjs); fish-here-core.js reads them.
import { forLake, stockIdOf } from '../states/index.js';
import { entryFor, factsFor, listedFor } from '../water-facts.js';
import { hereLines } from '../fish-here-core.js';
import { esc } from '../ui.js';

export async function renderFishHere(lake, el) {
  const S = forLake(lake);
  if (!el || !S) return;
  let rows = [];
  try {
    const e = await entryFor(lake);
    // A river from the state's list isn't one of the map's waters: look its own ids up.
    rows = e ? (await factsFor(e)).listed ?? [] : await listedFor(S, [stockIdOf(lake) != null && `s:${stockIdOf(lake)}`, lake.nhdId && `n:${lake.nhdId}`]);
  } catch { return; }
  const { lines, sources } = hereLines(rows);
  if (!el.isConnected || !lines.length) return;
  el.innerHTML = `<div class="card"><h3>🐟 What's in here</h3>
    <table>${lines.map(l => `<tr><td><b>${esc(l.name)}</b></td><td class="small">${l.tags.map(esc).join('<br>')}</td></tr>`).join('')}</table>
    <p class="muted small" style="margin-top:6px">From ${sources.map(s => s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)} ↗</a>` : esc(s.label)).join(' and ')}.
      A state's list can be years old, and a plan is not a promise: the plants themselves are below.</p></div>`;
}
