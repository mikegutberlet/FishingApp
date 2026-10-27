// The archive: the copy of each stocked water's knowledge that the nightly corpus job keeps in the repo
// (data/corpus/<st>/<id>.json, see docs/corpus/README.md). When a live source doesn't answer, or you're offline
// with nothing kept on the phone yet, Getting there and Camping fill in from it and say so with its date.
import { forLake, stockIdOf } from './states/index.js';
import { db } from './db.js';
// No ui.js here: the nightly job imports this module in Node, where there is no document.

const files = {};
export const corpusUrl = lake => {
  const S = forLake(lake), id = stockIdOf(lake);
  return S && id != null && id !== '' ? `data/corpus/${S.code.toLowerCase()}/${encodeURIComponent(String(id))}.json` : null;
};
// A missing file (a water the job hasn't reached yet, or offline before it was ever seen) is asked for again after 30 s.
// Your private archive (private-corpus.js), imported into this phone's own storage, is laid over the repo's copy:
// its notes and book excerpts never leave the phone.
export async function corpusFor(lake) {
  const url = corpusUrl(lake);
  if (!url) return null;
  const pub = await (files[url] ??= fetch(url).then(r => r.ok ? r.json() : null).catch(() => null).then(f => { if (!f) setTimeout(() => delete files[url], 30e3); return f; }));
  const priv = await db.get('corpusPrivate', url.slice('data/corpus/'.length, -'.json'.length)).catch(() => null);
  if (!priv) return pub;
  const seen = new Set((priv.notes ?? []).map(n => n.text));
  return { ...pub, ...priv, notes: [...(priv.notes ?? []), ...(pub?.notes ?? []).filter(n => !seen.has(n.text))], manual: { ...pub?.manual, ...priv.manual }, private: true };
}
// The state's catalogue page (docs/corpus/<st>.md): its contents list links to every water's section.
export const catalogueUrl = f => `https://github.com/mikegutberlet/FishingApp/blob/main/docs/corpus/${f.state.toLowerCase()}.md`;

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
