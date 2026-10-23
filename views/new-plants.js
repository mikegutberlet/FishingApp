// "New since last visit": CDFW plants that showed up since you last opened a water's Stocking tab.
// The newest plant week you've seen is kept on the lake record (plantsSeen), so nothing leaves the device.
import { db } from '../db.js';
import * as CA from '../states/ca.js';

const FRESH_DAYS = 14; // before your first visit, plants from the last two weeks (or coming up) count as new

export const isNew = (lake, plant) => plant.week > (lake.plantsSeen ?? new Date(Date.now() - FRESH_DAYS * 864e5).toISOString().slice(0, 10));

export async function newPlants(lake) {
  if (!lake.cdfwStockId) return [];
  return (await CA.plantsFor(lake.cdfwStockId)).filter(p => isNew(lake, p));
}

// Called when the Stocking tab shows the CDFW plants. Re-reads the lake so a concurrent edit isn't overwritten.
export async function markPlantsSeen(lake, plants) {
  if (lake.unsaved || !lake.id) return;
  const latest = plants.reduce((max, p) => p.week > max ? p.week : max, new Date().toISOString().slice(0, 10));
  const fresh = await db.get('lakes', lake.id);
  if (fresh && fresh.plantsSeen !== latest) await db.put('lakes', { ...fresh, plantsSeen: latest });
}

// Fills the <span data-new-plants="<lake id>"> placeholders on the lake list.
export async function showNewPlantBadges(root, lakes) {
  for (const lake of lakes) {
    const el = root.querySelector(`[data-new-plants="${lake.id}"]`);
    const n = (await newPlants(lake)).length;
    if (el && n) el.innerHTML = `<span class="badge">${n} new plant${n > 1 ? 's' : ''}</span>`;
  }
}
