// Game plan: what to throw and where, for one water today. Led by what worked for you on days like this
// (insights.js), then a hand-kept guide per species for today's water temperature and clarity. All on the phone.
import { db } from './db.js';
import { forLake, stockIdOf } from './states/index.js';
import { weatherFor, localKey, addDays } from './forecast.js';
import { conditionsNow, analyze } from './insights.js';
import { isRiver } from './states/common.js';
import { waterTempNow, clarityNow, iceEstimate, allIceLogs } from './know-water.js';

// Species groups. `temps` = [too cold below, best from, best to, too warm above] in °F at the surface. Each band has
// where to look (depth in ft for lakes, the water type for rivers) and how to fish it. Rules of thumb that hold for
// most western waters; your own catches come first on the page whenever you have them.
const GROUPS = {
  trout: {
    match: /trout|rainbow|brown|brook|cutthroat|golden|tiger|steelhead|splake/i, label: 'Trout', temps: [42, 50, 63, 68],
    bands: {
      cold: { lake: [0, 15, 'Slow and near the bottom, or sunny shallows by midday'], river: 'Slow, deep pools and tailouts in the warmest hours', how: 'Bait on the bottom (dough bait, nightcrawler), small spoons and jigs fished slowly, nymphs dead-drifted deep' },
      cool: { lake: [0, 12, 'Cruising the shoreline, inlets and points'], river: 'Riffles, runs and seams; fish move up into faster water', how: 'Spinners and small spoons, floating bait off the bottom, woolly buggers and leeches stripped slowly' },
      best: { lake: [5, 25, 'Shallow at dawn and dusk, 15–25 ft and trolled flats in the middle of the day'], river: 'Riffles and pocket water; hatches at dawn and evening', how: 'Trolled spoons and dodger rigs, spinners, Power Bait or crawlers off the bottom, dries on a hatch, nymphs under an indicator' },
      warm: { lake: [25, 45, 'Deep, at or just under the thermocline, and around cold inlets'], river: 'Shaded, oxygenated riffles and cold springs only, early morning', how: 'Leadcore or downrigger trolling, crawlers deep, dawn only on top. Over 68°F stress kills released trout: quit by mid-morning' },
    },
    colors: { Clear: 'silver, rainbow trout pattern, olive, brown', Stained: 'gold, copper, firetiger, orange', Murky: 'chartreuse, orange, gold with flash', Muddy: 'black, chartreuse, big profile with flash' },
  },
  kokanee: {
    match: /kokanee|sockeye/i, label: 'Kokanee', temps: [40, 50, 56, 62],
    bands: {
      cold: { lake: [0, 25, 'Near the surface and in the top 25 ft'] }, cool: { lake: [10, 30, 'Top 30 ft'] },
      best: { lake: [20, 50, 'Where the water is 50–55°F: on the thermocline, often 30–50 ft'] }, warm: { lake: [40, 80, 'Deep, in or below the thermocline'] },
      how: 'Troll a dodger and a small hoochie, spinner or wedding ring tipped with white corn at 1.0–1.5 mph; mark the depth of the first fish and stay there',
    },
    colors: { Clear: 'pink, orange, UV', Stained: 'pink, red, chartreuse, glow', Murky: 'glow, chartreuse, bright pink', Muddy: 'glow, chartreuse' },
  },
  laker: {
    match: /lake trout|mackinaw|char\b/i, label: 'Lake trout', temps: [38, 46, 54, 60],
    bands: {
      cold: { lake: [10, 40, 'Shallower than usual, near drop-offs'] }, cool: { lake: [10, 40, 'Shallow after ice-off: points and drop-offs'] },
      best: { lake: [50, 100, 'Deep structure and bait schools'] }, warm: { lake: [70, 150, 'Deep, below the thermocline'] },
      how: 'Vertical tube jigs and spoons over marked fish, or troll big spoons and plugs slowly near the bottom',
    },
    colors: { Clear: 'white, silver, glow', Stained: 'white, chartreuse, glow', Murky: 'glow, chartreuse', Muddy: 'glow, chartreuse' },
  },
  largemouth: {
    match: /largemouth|black bass|^bass$/i, label: 'Largemouth bass', temps: [50, 62, 80, 86],
    bands: {
      cold: { lake: [12, 30, 'Deep, steep banks and channel edges near the spawning flats'], river: 'Deep, slow backwaters', how: 'Jigs, blade baits and drop shots crawled slowly; suspending jerkbaits paused long' },
      cool: { lake: [3, 12, 'Points and flats near spawning coves; beds once it passes about 62°F'], river: 'Backwater coves warming first', how: 'Jerkbaits, squarebill cranks, Texas-rigged creatures, wacky worms around beds' },
      best: { lake: [2, 15, 'Topwater shallow at dawn, then weed edges, docks and points 8–15 ft'], river: 'Wood, weed and shade lines', how: 'Topwater early, then swim jigs, spinnerbaits, Texas rigs and drop shots on the edges' },
      warm: { lake: [12, 25, 'Deep structure, shade and thick mats; shallow only at night and dawn'], river: 'Deep shade and current breaks', how: 'Frogs in the mats, deep cranks and big worms, or fish at night' },
    },
    colors: { Clear: 'green pumpkin, watermelon, shad white, natural', Stained: 'chartreuse and white, red craw, junebug', Murky: 'black and blue, chartreuse, loud rattles', Muddy: 'black and blue, solid dark, big vibration' },
  },
  smallmouth: {
    match: /smallmouth|spotted bass|redeye/i, label: 'Smallmouth and spotted bass', temps: [48, 60, 75, 82],
    bands: {
      cold: { lake: [20, 40, 'Deep rock and bluff ends'], river: 'Deep, slow pools', how: 'Blade baits, hair jigs and drop shots fished slowly' },
      cool: { lake: [5, 20, 'Rocky points, gravel flats and riprap'], river: 'Current breaks next to the deeper water', how: 'Jerkbaits, tubes, Ned rigs, small swimbaits' },
      best: { lake: [8, 25, 'Rock piles, ledges and points; topwater early'], river: 'Riffles into runs, boulders, eddy lines', how: 'Drop shots, tubes, Ned rigs, topwater and small cranks' },
      warm: { lake: [20, 35, 'Deeper rock, humps and the thermocline edge'], river: 'Shaded, faster riffles', how: 'Drop shot and football jigs deep; topwater only at first light' },
    },
    colors: { Clear: 'green pumpkin, smoke, natural shad', Stained: 'brown and orange craw, chartreuse', Murky: 'chartreuse, black', Muddy: 'black, chartreuse, rattles' },
  },
  striper: {
    match: /striped bass|striper|wiper|white bass/i, label: 'Striped bass', temps: [50, 58, 72, 78],
    bands: {
      cold: { lake: [20, 50, 'Deep, following shad in the creek channels'], river: 'Deep holes and slow water', how: 'Spoons and swimbaits jigged over bait balls, cut bait or live bait deep' },
      cool: { lake: [5, 25, 'Points and creek mouths chasing shad'], river: 'Current seams and tidal edges', how: 'Swimbaits, jerkbaits, trolled minnow plugs' },
      best: { lake: [5, 30, 'Boils at dawn and dusk; points and humps'], river: 'Current seams', how: 'Topwater on boils, swimbaits and spoons, trolled plugs, anchovy or shad as bait' },
      warm: { lake: [30, 60, 'Deep, in the coolest water with oxygen'], river: 'Deep, moving water', how: 'Spoons and live bait deep, or fish at night' },
    },
    colors: { Clear: 'shad white, silver, grey ghost', Stained: 'white, chartreuse', Murky: 'chartreuse, white', Muddy: 'chartreuse, black' },
  },
  crappie: {
    match: /crappie/i, label: 'Crappie', temps: [45, 58, 72, 80],
    bands: {
      cold: { lake: [15, 30, 'Suspended over deep brush and channels'] }, cool: { lake: [2, 10, 'Shallow brush, tules and docks for the spawn'] },
      best: { lake: [8, 20, 'Brush piles, docks and standing timber'] }, warm: { lake: [15, 25, 'Suspended, deeper brush and bridge pilings'] },
      how: 'Small tube or curly-tail jigs, minnows under a slip bobber, swum slowly at the depth they hold',
    },
    colors: { Clear: 'white, silver, smoke', Stained: 'chartreuse, pink and white', Murky: 'chartreuse, black and chartreuse', Muddy: 'black and chartreuse, glow' },
  },
  panfish: {
    match: /bluegill|sunfish|pumpkinseed|green sunfish|redear|perch|warmouth/i, label: 'Bluegill and perch', temps: [50, 64, 80, 86],
    bands: {
      cold: { lake: [12, 25, 'Deeper weed edges'] }, cool: { lake: [3, 10, 'Warm, shallow coves'] },
      best: { lake: [2, 12, 'Weed beds, docks and beds on sandy flats'] }, warm: { lake: [8, 18, 'Shade and deeper weed edges'] },
      how: 'Worm or mealworm under a small bobber, tiny jigs, small poppers on a fly rod',
    },
    colors: { Clear: 'natural, olive, brown', Stained: 'chartreuse, orange', Murky: 'chartreuse, red', Muddy: 'red, chartreuse, live bait' },
  },
  catfish: {
    match: /catfish|bullhead/i, label: 'Catfish', temps: [50, 70, 85, 92],
    bands: {
      cold: { lake: [15, 40, 'Deep holes and channels'], river: 'Deep holes', how: 'Cut bait and nightcrawlers soaked on the bottom' },
      cool: { lake: [5, 20, 'Warming coves, inlets after rain'], river: 'Below riffles, outside bends', how: 'Nightcrawlers, chicken liver, cut bait' },
      best: { lake: [3, 20, 'Flats and channel edges, shallow at night'], river: 'Holes below riffles, log jams', how: 'Chicken liver, cut bait, stink bait; best from dusk into the night' },
      warm: { lake: [5, 25, 'Shade, channels by day; flats at night'], river: 'Deep holes by day', how: 'Night fishing with cut bait and liver' },
    },
    colors: { Clear: 'scent matters more than color', Stained: 'scent matters more than color', Murky: 'scent matters more than color', Muddy: 'scent matters more than color' },
  },
  walleye: {
    match: /walleye|sauger/i, label: 'Walleye', temps: [45, 55, 70, 76],
    bands: {
      cold: { lake: [20, 40, 'Deep breaks near spawning gravel'], river: 'Deep, slow holes below dams', how: 'Blade baits and jigs with minnows, slow' },
      cool: { lake: [5, 20, 'Gravel points and wind-blown shores'], river: 'Current breaks, tailraces', how: 'Jig and minnow, jerkbaits at night' },
      best: { lake: [10, 30, 'Points, humps and weed edges; shallow at night'], river: 'Edges of current and rock', how: 'Bottom bouncers with crawler harnesses, trolled crankbaits' },
      warm: { lake: [20, 40, 'Deep humps and the thermocline edge'], river: 'Deep, fast water', how: 'Trolled cranks and harnesses deep, or night fishing' },
    },
    colors: { Clear: 'perch, shad, natural', Stained: 'firetiger, chartreuse, gold', Murky: 'chartreuse, orange, glow', Muddy: 'glow, chartreuse' },
  },
};
// Lake trout and kokanee are checked first, so "Lake trout" isn't read as trout.
const ORDER = ['laker', 'kokanee', ...Object.keys(GROUPS).filter(k => k !== 'laker' && k !== 'kokanee')];
export const groupOf = species => ORDER.find(k => GROUPS[k].match.test(species ?? '')) ?? null;
export const groupLabel = g => GROUPS[g]?.label ?? g;

export function band(group, f) {
  const [cold, lo, hi] = GROUPS[group].temps;
  if (f == null) return null;
  return f < cold ? 'cold' : f < lo ? 'cool' : f <= hi ? 'best' : 'warm';
}

// The species worth planning for at a water: yours first (what you've caught there), then fish planted in the last
// two months, then the species on its Info, then trout for a mountain water we know nothing about.
export async function speciesFor(lake, catches) {
  const n = new Map();
  for (const c of catches) { const g = groupOf(c.species); if (g) n.set(g, (n.get(g) ?? 0) + 10 * (+c.count || 1)); }
  const stockId = stockIdOf(lake);
  if (stockId) try {
    const since = localKey(addDays(Date.now(), -60)), soon = localKey(addDays(Date.now(), 14));
    for (const p of await forLake(lake).plantsFor(stockId)) if (p.week >= since && p.week <= soon) { const g = groupOf(p.species); if (g) n.set(g, (n.get(g) ?? 0) + 5); }
  } catch {}
  for (const s of String(lake.species ?? '').split(/[,;/]+/)) { const g = groupOf(s.trim()); if (g) n.set(g, (n.get(g) ?? 0) + 3); }
  if (!n.size && (+lake.elevationFt > 3000 || isRiver(lake))) n.set('trout', 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g);
}

const skyOf = w => { const c = w?.current; if (!c) return null; return c.cloud_cover >= 70 || c.weather_code >= 3 ? 'cloudy' : 'bright'; };

// The plan: { temp, clarity, ice, yours: what worked on days like this, picks: [{ group, label, band, where, how, colors }] }.
export async function gamePlan(lake, { w, withYours = true } = {}) {
  const [catches, profiles, sets, logs, lakes] = await Promise.all([db.byLake('catches', lake.id ?? '-'), db.byLake('tempProfiles', lake.id ?? '-'), db.byLake('depthSets', lake.id ?? '-'), allIceLogs(), db.all('lakes')]);
  if (w === undefined) w = await weatherFor(lake.lat, lake.lon).catch(() => null);
  const temp = await waterTempNow(lake, w, { catches, profiles, sets });
  const clarity = clarityNow(lake, catches);
  const ice = iceEstimate(lake, { logs: logs.filter(l => l.lakeId === lake.id), allLogs: logs, lakes });
  const river = isRiver(lake), sky = skyOf(w);
  const groups = (await speciesFor(lake, catches)).slice(0, 3);
  const picks = groups.map(g => {
    const G = GROUPS[g], b = band(g, temp?.f) ?? 'best', B = G.bands[b], how = B.how ?? G.bands.how;
    let where;
    if (river) where = B.river ?? 'Seams, eddies and deeper runs';
    else { const [a, z, text] = B.lake; const max = +lake.maxDepth || Infinity; where = `${text} (${Math.min(a, max)}–${Math.min(z, max)} ft)`; }
    const colorText = clarity.clarity ? G.colors[clarity.clarity] : `clear water: ${G.colors.Clear}; stained: ${G.colors.Stained}`;
    const light = sky === 'cloudy' ? 'Low light: darker or brighter colors and more flash, fish can roam shallower' : sky === 'bright' ? 'Bright sun: natural colors, lighter line, fish tighter to shade and depth' : '';
    return { group: g, label: G.label, band: b, bandText: { cold: 'cold water', cool: 'cool, warming water', best: 'prime water temperature', warm: 'warm water' }[b], where, how, colors: colorText, light };
  });
  let yours = null;
  if (withYours) {
    const all = await db.all('catches');
    if (all.length) {
      const ref = await conditionsNow(lake);
      const here = all.filter(c => c.lakeId === lake.id);
      const a = analyze(here.length >= 4 ? here : all, ref, { tackle: await db.all('tackle'), minScore: 0.55 });
      if (a.rows.length >= 2) yours = { n: a.rows.length, days: a.days.length, here: here.length >= 4, lures: a.lures, depths: a.depths, species: a.species, hours: a.hours };
    }
  }
  return { temp, clarity, ice, picks, yours, sky, river };
}

// One short line for a Today card: "🎯 Trout 5–25 ft · spoons and spinners · gold, copper · water ≈52°F".
export function planLine(p) {
  if (p.ice && (p.ice.state === 'iced' || p.ice.state === 'freezing')) return `🧊 ${p.ice.text}`;
  const top = p.picks[0];
  if (!top) return '';
  const depth = top.where.match(/\(([^)]+)\)$/)?.[1] ?? top.where.split(/[,;:]/)[0];
  // Your own best lure only when it came from this water and this species leads there too.
  const lure = p.yours?.here && groupOf(p.yours.species?.[0]?.k) === top.group && p.yours.lures?.[0]?.k || top.how.split(/[,;.]/)[0];
  return `🎯 ${top.label}: ${depth} · ${lure}${p.temp ? ` · water ${p.temp.measured ? '' : '≈'}${p.temp.f}°F` : ''}`;
}

// Today: one game-plan line under each favorite water's card ([data-plan-for] slots).
export function fillPlanLines(root, lakes) {
  for (const slot of root.querySelectorAll('[data-plan-for]')) {
    const lake = lakes.find(l => l.id === slot.dataset.planFor);
    if (lake) gamePlan(lake, { withYours: true }).then(p => { if (slot.isConnected) slot.textContent = planLine(p); }).catch(() => {});
  }
}
