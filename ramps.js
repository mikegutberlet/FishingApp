// Ramp usable at today's level: each ramp's lowest usable lake level next to the level the water's gauge read last.
// The levels come from the agency that runs the ramps (read off their ramp-status pages and dated here), or from you:
// any water with a level gauge can have its ramps' levels typed in once (Edit on the ramp card), from a sign at the
// ramp or the agency's page. Levels are feet above sea level, the same datum as the gauge (CDEC, USGS, Reclamation).

// Keyed by the gauge id the app's level feed uses for that water (CDEC station for California).
// stages: [label, top ft (null = full), floor ft (null = not known)], highest first; usable while any stage is.
export const RAMP_TABLE = {
  ORO: {
    water: 'Lake Oroville', checked: '2026-10-27', url: 'https://www.parks.ca.gov/?page_id=28411', by: 'California State Parks, Lake Oroville SRA launch ramp status',
    ramps: [
      { name: 'Bidwell Canyon', stages: [['Stage 1', 900, 740], ['Stage 2', 740, 705], ['Stage 3', 705, 665]] },
      { name: 'Spillway', stages: [['Stage 1', 900, 821], ['Stage 2', 821, 734], ['Stage 3', 734, 700]] },
      { name: 'Loafer Point', stages: [['Stage 1', 900, 804], ['Stage 2', 804, 680]] },
      { name: 'Lime Saddle', stages: [['Stage 1', 900, 707]] },
      { name: 'Enterprise', stages: [['Stage 1', 900, 842]] },
      { name: 'Foreman Creek (car-top)', stages: [['Stage 1', 900, 730]] },
      { name: 'Nelson Bar (car-top)', stages: [['Stage 1', 900, 854]] },
      { name: 'Stringtown (car-top)', stages: [['Stage 1', 900, 869]] },
      { name: 'Vinton Gulch (car-top)', stages: [['Stage 1', 900, 880]] },
    ],
  },
  FOL: {
    water: 'Folsom Lake', checked: '2026-10-27', url: 'https://www.parks.ca.gov/?page_id=31951', by: 'California State Parks, Folsom Lake SRA boat launch status',
    ramps: [
      // State Parks' Oct 20, 2026 notice: Stage 1 closed at 402 ft; the Low Water Ramp comes out of the water at
      // about 395 ft (its floor isn't given).
      { name: 'Granite Bay', stages: [['Stage 1', null, 402], ['Low Water Ramp', 395, null]] },
    ],
    note: 'Browns Ravine (Hobie Cove) stays open for bigger boats at low water. Folsom also needs a golden-mussel green seal or 30-day quarantine before you launch.',
  },
};

// Where each state's agencies post ramp status, for waters with no table and for checking before you tow.
export const STATUS_PAGES = {
  ORO: RAMP_TABLE.ORO.url,
  FOL: RAMP_TABLE.FOL.url,
  NML: 'https://www.usbr.gov/mp/ccao/newmelones/planning-visit/boating-fishing.html',
  BER: 'https://www.usbr.gov/mp/ccao/berryessa/boating.html',
};
export const STATE_PAGES = {
  OR: { name: 'Oregon State Marine Board: water levels', url: 'https://www.oregon.gov/osmb/boater-info/Pages/Water-Level-and-Chart-Information.aspx' },
  NV: { name: 'Lake Mead NRA: motorized boating and launch ramps', url: 'https://www.nps.gov/lake/planyourvisit/motorized-boating.htm', near: [36.1, -114.6, 120] },
};

// Latest reading of a gauge's elevation series: { ft, date } or null.
export function latestLevel(series) {
  const rows = (Array.isArray(series) ? series : []).filter(r => Array.isArray(r) && Number.isFinite(+r[1]));
  const r = rows.at(-1);
  return r ? { ft: +r[1], date: r[0] } : null;
}

// Feet per day over the last `days` (negative = dropping), or null with too few readings.
export function levelRate(series, days = 14) {
  const rows = (Array.isArray(series) ? series : []).filter(r => Array.isArray(r) && Number.isFinite(+r[1]));
  if (rows.length < 4) return null;
  const last = rows.at(-1), lastT = Date.parse(last[0]);
  const first = rows.find(r => lastT - Date.parse(r[0]) <= days * 864e5) ?? rows[0];
  const span = (lastT - Date.parse(first[0])) / 864e5;
  return span >= 3 ? (+last[1] - +first[1]) / span : null;
}

// One ramp against the level. A ramp has stages, each usable while the lake is between its top and its floor (top
// null = up to full; floor null = no low limit known). Lake Oroville's Bidwell Canyon is Stage 1 from full to 740 ft,
// Stage 2 from 740 to 705...; Folsom's Granite Bay Low Water Ramp only comes out of the water once the lake drops to
// about 395 ft, so between that and Stage 1's 402 ft floor nothing launches there.
// Returns { name, usable, stage, floor, spare (ft above that floor), daysLeft (at the current drop, until the last
// stage closes) } when usable, else { usable: false, why: 'low' | 'gap' | 'high', stage, at (the level it opens at),
// short (ft to go), days (at the current rate, until it opens; null when the lake is moving the wrong way) }.
export function rampStatus(ramp, levelFt, ratePerDay = null) {
  const stages = (ramp.stages ?? []).map(([label, top, floor]) => ({ label, top: top == null ? Infinity : +top, floor: floor == null ? -Infinity : +floor }));
  const rate = Number.isFinite(ratePerDay) ? ratePerDay : 0;
  const now = stages.filter(x => levelFt <= x.top && levelFt >= x.floor).sort((a, b) => b.floor - a.floor)[0];
  const lowest = Math.min(...stages.map(x => x.floor));
  if (now) {
    // The usable range runs down through the stages that join on (no gap) to the floor you'd launch from last.
    let bottom = now.floor;
    for (let more = true; more;) { more = false; for (const x of stages) if (x.floor < bottom && x.top >= bottom) { bottom = x.floor; more = true; } }
    return { name: ramp.name, usable: true, stage: now.label, floor: Number.isFinite(now.floor) ? now.floor : null, spare: Number.isFinite(now.floor) ? levelFt - now.floor : null,
      daysLeft: rate < -0.02 && Number.isFinite(bottom) ? Math.floor((levelFt - bottom) / -rate) : null };
  }
  if (levelFt < lowest) return { name: ramp.name, usable: false, why: 'low', stage: stages.find(x => x.floor === lowest).label, at: lowest, short: lowest - levelFt, days: rate > 0.02 ? Math.ceil((lowest - levelFt) / rate) : null };
  // Above a stage that is still under water (and below the one above it): it opens as the lake drops.
  const below = stages.filter(x => x.top < levelFt).sort((a, b) => b.top - a.top)[0];
  if (below) return { name: ramp.name, usable: false, why: 'gap', stage: below.label, at: below.top, short: levelFt - below.top, days: rate < -0.02 ? Math.ceil((levelFt - below.top) / -rate) : null };
  const top = Math.max(...stages.map(x => x.top));
  return { name: ramp.name, usable: false, why: 'high', stage: stages[0].label, at: top, short: levelFt - top, days: rate < -0.02 ? Math.ceil((levelFt - top) / -rate) : null };
}

// The ramps for a water: the agency table for its gauge, plus any you typed in (yours win on the same name).
export function rampsFor(lake, gaugeId) {
  const t = gaugeId ? RAMP_TABLE[String(gaugeId).toUpperCase()] : null;
  const mine = (Array.isArray(lake.rampLevels) ? lake.rampLevels : []).filter(r => r?.name && Number.isFinite(+r.minFt))
    .map(r => ({ name: r.name, stages: [['Usable', null, +r.minFt]], mine: true }));
  const names = new Set(mine.map(r => r.name.toLowerCase()));
  return { table: t, ramps: [...mine, ...(t?.ramps ?? []).filter(r => !names.has(r.name.toLowerCase()))] };
}
