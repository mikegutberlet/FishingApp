// The archive: the copy of each stocked water's knowledge that the nightly corpus job keeps in your private folder
// (see docs/corpus/README.md), imported into this phone's own storage from its pack file (private-corpus.js). Nothing
// is fetched from the repo. When a live source doesn't answer, or you're offline with nothing kept on the phone yet,
// Getting there and Camping fill in from it and say so with its date.
import { forLake, stockIdOf } from './states/index.js';
import { db } from './db.js';
// No ui.js here: the nightly job imports this module in Node, where there is no document.

// The water's key in the archive, "ca/175", or null for a water with no stock id.
export const corpusKey = lake => {
  const S = forLake(lake), id = stockIdOf(lake);
  return S && id != null && id !== '' ? `${S.code.toLowerCase()}/${encodeURIComponent(String(id))}` : null;
};
// Your archive server (server/serve.mjs), when you've set one up: { url, key } in localStorage. A file fetched from it
// is kept in the phone's store too, so the water still has its archive offline. The imported pack feeds the same store.
export const SERVER = 'corpus-server';
export const serverConf = () => { try { const c = JSON.parse(localStorage.getItem(SERVER)); return c?.url && c?.key ? c : null; } catch { return null; } };
export const serverFetch = (path, ms = 8000) => { const c = serverConf(); if (!c) return Promise.reject(new Error('no server')); return fetch(`${c.url.replace(/\/+$/, '')}/${path}`, { headers: { Authorization: `Bearer ${c.key}` }, signal: AbortSignal.timeout(ms) }); };
let fresh = {}, freshFor = null;
export async function corpusFor(lake) {
  const key = corpusKey(lake);
  if (!key) return null;
  const conf = serverConf();
  if (conf) {
    // Once per session per water (per server): a water the job hasn't reached (404) is asked for again after 5 min,
    // a failure after 30 s; either way the phone's own copy (an earlier fetch, or the imported pack) stands in.
    const id = `${conf.url} ${conf.key}`;
    if (freshFor !== id) { fresh = {}; freshFor = id; }
    fresh[key] ??= serverFetch(`${key}.json`).then(async r => {
      if (r.status === 404) { setTimeout(() => delete fresh[key], 300e3); return undefined; }
      if (!r.ok) throw new Error(r.status);
      const f = await r.json(); await db.put('corpusPrivate', { ...f, id: key }, { touch: false }); return f;
    }).catch(() => { setTimeout(() => delete fresh[key], 30e3); return undefined; });
    const f = await fresh[key];
    if (f !== undefined) return f;
  }
  return (await db.get('corpusPrivate', key).catch(() => null)) ?? null;
}

// Which of the Getting there tab's source names an archived record belongs to (by the label its source carries).
const ACCESS_OF = label => /Motor Vehicle/.test(label) ? 'USFS MVUM' : /System roads/.test(label) ? 'USFS roads' : /System trails/.test(label) ? 'USFS trails' : /^BLM/.test(label) ? 'BLM routes' : /OpenStreetMap/.test(label) ? 'OpenStreetMap' : null;
const CAMP_OF = label => /INFRA/.test(label) ? 'Forest Service sites' : /recreation opportunities/.test(label) ? 'Forest Service pages' : /Recreation\.gov/.test(label) ? 'Recreation.gov' : /^BLM/.test(label) ? 'BLM sites' : /State Parks/.test(label) ? 'California State Parks' : /OpenStreetMap/.test(label) ? 'OpenStreetMap' : null;

// The archived Getting there lookup as the tab would have kept it, or null. Only for the water's own point (the
// archive has no picked spots). The tabs show it while nothing is kept on the phone and still run the live lookup.
export async function archiveAccess(lake) {
  const c = await corpusFor(lake);
  if (!c?.access) return null;
  const { summary, ...a } = c.access;
  return { ...a, spot: null, about: c.about ?? null, failed: [], pending: [], archive: { date: a.fetchedAt, all: true } };
}
export async function archiveCamping(lake) {
  const c = await corpusFor(lake);
  if (!c?.camping) return null;
  const { dispersed, ...a } = c.camping;
  return { ...a, lat: c.lat, lon: c.lon, failed: [], pending: [], archive: { date: a.fetchedAt, all: true } };
}

// Fill a live lookup's gaps from the archive: records from each source that didn't answer, the land and the
// description when they're missing. When nothing answered at all, the whole archived copy stands in.
export async function fillAccess(lake, data) {
  if (data.spot || !data.failed?.length) return data;
  const c = await corpusFor(lake), a = c?.access;
  if (!a) return data;
  if (data.failed.length >= 6) {
    Object.assign(data, { features: a.features, land: a.land, about: c.about ?? null, hike: a.hike ?? null, archive: { date: a.fetchedAt, all: true } });
    return data;
  }
  // A road already in from another source (the inventory's copy of a Forest Service road, by its number) isn't added again.
  const filled = [], have = new Set(data.features.map(f => f.source?.id)), refs = new Set(data.features.filter(f => f.kind === 'road' && f.ref).map(f => f.ref));
  for (const name of data.failed) {
    if (name === 'PAD-US') { if (!data.land && a.land) { data.land = a.land; filled.push(name); } continue; }
    if (name === 'Wikipedia') { if (!data.about && c.about) { data.about = c.about; filled.push(name); } continue; }
    const feats = a.features.filter(f => !have.has(f.source?.id) && !(f.kind === 'road' && f.ref && refs.has(f.ref)) && (f.sources ?? [f.source]).some(s => ACCESS_OF(s.label) === name));
    if (feats.length) { data.features.push(...feats); filled.push(name); }
  }
  if (filled.length) data.archive = { date: a.fetchedAt, sources: filled };
  return data;
}
export async function fillCamping(lake, data) {
  if (!data.failed?.length) return data;
  const c = await corpusFor(lake), a = c?.camping;
  if (!a) return data;
  if (data.failed.length >= 6) {
    Object.assign(data, { sites: a.sites, land: a.land, archive: { date: a.fetchedAt, all: true } });
    return data;
  }
  const filled = [], names = new Set(data.sites.map(s => s.name));
  for (const name of data.failed) {
    if (name === 'PAD-US') { if (!data.land && a.land) { data.land = a.land; filled.push(name); } continue; }
    const sites = a.sites.filter(s => !names.has(s.name) && (s.sources ?? []).some(x => CAMP_OF(x.label) === name));
    if (sites.length) { data.sites.push(...sites); data.sites.sort((x, y) => x.distKm - y.distKm); filled.push(name); }
  }
  if (filled.length) data.archive = { date: a.fetchedAt, sources: filled };
  return data;
}

// The line a tab adds under its sources when some of what it shows came from the archive.
export function archiveLine(data) {
  const ar = data.archive;
  if (!ar) return '';
  return ` <b>${ar.all ? 'Shown from the archive' : `Filled in from the archive for ${ar.sources.join(', ')}`}</b> (the copy kept in the app’s repo, fetched ${new Date(ar.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}; see Info → In the archive).`;
}
