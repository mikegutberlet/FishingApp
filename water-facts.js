// What the app knows about every water, for the "Where should I go?" list (views/finder.js) and the map's pins
// (map-pins.js): the pool of waters (each state's lakes and stocked waters, plus your saved ones), and per water its
// stocking match, fish (and where that comes from), latest plant, access places and algae advisories.
// Everything comes from data already on the phone; facts per water are worked out once and kept for the session.
import { list as stateList, forLake } from './states/index.js';
import { groupOf, groupLabel } from './game-plan.js';
import { stockHistoryFor } from './stock-history.js';
import { speciesName, speciesLine, isCatchAll } from './species.js';

// NAS records of fish that didn't take or were removed don't mean the fish is there.
const GONE = /failed|extirpated|eradicated/i;
// "Brown bullhead" is a catfish, not a brown trout.
export const group = s => /bullhead/i.test(s ?? '') ? 'catfish' : groupOf(s);
export const isStream = n => /river|creek|fork|section/i.test(n ?? ''); // as views/lakes.js types a stocked water

// ---------- Every water, once per session ----------
// One state's lakes and located stocked waters. A list that came back empty (no signal before the data was cached)
// isn't kept, so the next ask tries again.
const pools = new Map();
export function statePool(S) {
  if (!pools.has(S.code)) pools.set(S.code, Promise.all([S.waters(), S.statewide()]).then(([stocked, sw]) => {
    const all = [
      ...sw.lakes.map(w => ({ key: `${S.code}:n:${w.id}`, S, w, name: w.name, type: w.type, lat: w.lat, lon: w.lon })),
      ...stocked.filter(w => w.lat != null).map(w => ({ key: `${S.code}:s:${w.id}`, S, stock: w, name: w.name, type: w.type ?? (isStream(w.name) ? 'River' : 'Lake'), lat: w.lat, lon: w.lon })),
    ];
    if (!all.length) pools.delete(S.code);
    return all;
  }, e => { pools.delete(S.code); throw e; }));
  return pools.get(S.code);
}
export const loadPool = () => Promise.all(stateList.map(statePool)).then(parts => parts.flat());

// Your saved waters stand in for the same water in the state lists, and carry your catches and species notes.
// A saved water that isn't in the lists (added by hand, or a river) gets an entry of its own.
export function withSaved(all, saved) {
  const savedFor = new Map(), extra = [];
  const keys = new Set(all.map(e => e.key));
  for (const l of saved) {
    const S = forLake(l);
    // A river saved from the state's list has an NHD id but isn't in the pool's lakes: try its stock id too.
    const key = S && [l.nhdId && `${S.code}:n:${l.nhdId}`, l[S.stockField] != null && `${S.code}:s:${l[S.stockField]}`].find(k => k && keys.has(k));
    if (key) savedFor.set(key, l);
    else if (S && l.lat != null) extra.push({ key: `mine:${l.id}`, S, w: l, name: l.name, type: l.type, lat: l.lat, lon: l.lon, saved: l });
  }
  return { entries: [...all.map(e => savedFor.has(e.key) ? { ...e, saved: savedFor.get(e.key) } : e), ...extra], savedFor };
}

// The state's stocked water for an entry: its own, the one saved on your lake, or the one that matches by name and place.
const stocks = new Map();
export function stockFor(e) {
  if (!stocks.has(e.key)) stocks.set(e.key, (async () => {
    const S = e.S, id = e.saved?.[S.stockField];
    return e.stock ?? (id != null ? (await S.waters()).find(w => String(w.id) === String(id)) : await S.matchStockedWater(e.w)) ?? null;
  })());
  return stocks.get(e.key);
}

// What we know about one water: fish (and where that comes from), latest plant and access places. Algae advisories
// are slow to match in Oregon, so they're looked up only when asked (habFor).
const facts = new Map();
export function factsFor(e) {
  if (!facts.has(e.key)) facts.set(e.key, (async () => {
    const S = e.S, place = e.w ?? e.stock;
    const stock = await stockFor(e);
    const [hist, access] = await Promise.all([S.historyFor(place), S.accessFor?.(place)]);
    const fish = new Map(), add = (s, src) => addFish(fish, s, src);
    for (const p of stock?.plants ?? []) add(p.species, 'stocked');
    // Past years' reports name the kind more often than the current schedule does ("Rainbow Trout" vs "Legal trout").
    const past = stock ? await stockHistoryFor({ name: stock.name, state: S.code, [S.stockField]: stock.id, lat: stock.lat, lon: stock.lon, county: stock.county ?? stock.counties }) : null;
    for (const y of past?.years ?? []) for (const s of Object.keys(y.sp)) add(s, 'past');
    // historyFor lines read "Species (locality) · status".
    for (const h of hist.local) if (!GONE.test(h.text.split(' · ').at(-1))) add(h.text.split(/ \(| · /)[0], 'on record');
    return { stock, fish, lastPlant: stock?.lastPlant ?? null, access: access ? new Set(access.places.map(p => p.kind)) : null };
  })().catch(() => ({ fish: new Map(), access: null })));
  return facts.get(e.key);
}
// A fish goes in under its group ('trout') and, for trout and kokanee, also under the kind the record names
// ('k:Tiger trout'). Other fish stay by group, so a card's list stays short.
export function addFish(fish, s, src) {
  const g = group(s), kind = speciesName(s);
  const named = kind && !isCatchAll(kind) && (speciesLine(kind).includes('Trout') || /kokanee|sockeye/i.test(kind));
  for (const k of [g, named && `k:${kind}`]) if (k) (fish.get(k) ?? fish.set(k, new Set()).get(k)).add(src);
}
export const hasFish = (fish, want) => fish.has(want) || [...fish.keys()].some(k => k.startsWith('k:') && speciesLine(k.slice(2)).includes(want));
const habs = new Map();
export const habFor = e => habs.get(e.key) ?? habs.set(e.key, (e.S.habFor?.(e.w ?? e.stock) ?? Promise.resolve([])).then(a => a.length, () => 0)).get(e.key);

// A water's fish as lines for a card: each fish once, under the best evidence for it (your catches, then the current
// schedule, then past stocking reports, then a USGS record). A group shows by its kinds when the records name them
// ("Rainbow trout, Tiger trout"), else by its own name ("Trout").
const BY = { yours: "You've caught", stocked: 'Stocked', past: 'Stocked before', 'on record': 'On record' };
export function fishRows(fish) {
  const rows = {};
  const kinds = [...fish.keys()].filter(k => k.startsWith('k:'));
  for (const [g, all] of fish) {
    const named = new Set(g.startsWith('k:') ? [] : kinds.filter(k => group(k.slice(2)) === g).flatMap(k => [...fish.get(k)]));
    const src = [...all].filter(s => !named.has(s));
    if (src.length) (rows[Object.keys(BY).find(k => src.includes(k))] ??= []).push(g.startsWith('k:') ? g.slice(2) : groupLabel(g));
  }
  return Object.keys(BY).filter(k => rows[k]).map(k => ({ label: BY[k], names: rows[k] }));
}

// A stocked water that isn't one of the state's lakes, as an unsaved lake the lake page can open.
export function stockLake(e) {
  const S = e.S, w = e.stock;
  return { unsaved: true, name: w.name, type: e.type, state: S.code, county: w.county ?? w.counties, lat: w.lat, lon: w.lon, acres: w.acres ?? null,
    [S.stockField]: w.id, stockingUrl: S.waterUrl(w.id), infoUrl: S.waterUrl(w.id) };
}

// The pool entry for a water the map hands over: one of a state's lakes (kind 'lake'), a saved lake, or a stockLake.
// Rivers from the state lists aren't in the pool: null.
export async function entryFor(w) {
  const S = forLake(w);
  if (!S || w.kind === 'river' || w.kind === 'coast') return null;
  const all = await statePool(S);
  if (w.kind === 'lake') return all.find(e => e.key === `${S.code}:n:${w.id}`) ?? null;
  const { entries } = withSaved(all, w.id != null && !w.unsaved ? [w] : []);
  const stockKey = w[S.stockField] != null ? `${S.code}:s:${w[S.stockField]}` : null;
  return entries.find(e => e.saved === w) ?? (stockKey && entries.find(e => e.key === stockKey)) ?? null;
}
