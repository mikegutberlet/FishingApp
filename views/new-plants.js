// "New since last visit": CDFW plants that showed up since you last opened a water's Stocking tab.
// The plants you've seen are kept on the lake record (plantsSeen, as "week|species" keys), so nothing leaves the device.
// Keys rather than a date, because CDFW often adds a plant to a week that has already started.
import { db } from '../db.js';
import * as CA from '../states/ca.js';

const FRESH_DAYS = 14; // only plants from the last two weeks (or coming up) can count as new
const KEEP_DAYS = 30; // seen keys go back further than that, so a plant you've seen never turns new again

const localDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysAgo = n => localDay(new Date(Date.now() - n * 864e5));
const keyOf = p => `${p.week}|${p.species}`;
const lastDay = p => p.weekEnd ?? p.week;

// plantsSeen used to be the newest week seen (a date string); those records still work until the next visit.
const seen = (lake, plant) => Array.isArray(lake.plantsSeen) ? lake.plantsSeen.includes(keyOf(plant)) : !!lake.plantsSeen && plant.week <= lake.plantsSeen;
export const isNew = (lake, plant) => lastDay(plant) >= daysAgo(FRESH_DAYS) && !seen(lake, plant);

export async function newPlants(lake) {
  if (!lake.cdfwStockId) return [];
  return (await CA.plantsFor(lake.cdfwStockId)).filter(p => isNew(lake, p));
}

// Called when the Stocking tab shows the CDFW plants. Updates the page's lake object too, so a later save from the same
// page (star, Edit) keeps it, and re-reads the stored lake so a concurrent edit isn't overwritten.
export async function markPlantsSeen(lake, plants) {
  if (lake.unsaved || !lake.id) return;
  const keys = plants.filter(p => lastDay(p) >= daysAgo(KEEP_DAYS)).map(keyOf).sort();
  lake.plantsSeen = keys;
  const fresh = await db.get('lakes', lake.id);
  if (fresh && JSON.stringify(fresh.plantsSeen) !== JSON.stringify(keys)) await db.put('lakes', { ...fresh, plantsSeen: keys });
}

// Fills the <span data-new-plants="<lake id>"> placeholders on the lake list.
export async function showNewPlantBadges(root, lakes) {
  for (const lake of lakes) {
    const el = root.querySelector(`[data-new-plants="${lake.id}"]`);
    const n = (await newPlants(lake)).length;
    if (el && n) el.innerHTML = `<span class="badge">${n} new plant${n > 1 ? 's' : ''}</span>`;
  }
}
