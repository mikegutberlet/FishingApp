// The corpus: a durable copy of what the app knows about each stocked water, kept in the repo so the knowledge
// survives if a public service goes away. One file per water, <CORPUS_DIR>/<st>/<id>.json, built from the state
// data files the other jobs write (stocking, regulations, advisories, introductions, size and depth) and from the
// same live lookups the app runs on the phone (roads, trails, gates, the walk in, land manager, Wikipedia,
// campgrounds). Every fact keeps the link to the record it came from and the date it was fetched.
// Runs nightly on Goobs's Mac (docs/corpus/README.md) within a time budget, oldest files first, so the first full
// pass takes several nights and after that each water is refreshed about every CORPUS_REFRESH_DAYS days.
//
//   <CORPUS_DIR>/<st>/<id>.json {
//     id, state, name, lat, lon, county, kind, firstSeen, checkedAt, updatedAt,
//     agency:   { name, url, about, lastYearStocked }         the state agency's page and write-up for the water
//     facts:    { type, acres, elevationFt, maxDepthFt, meanDepthFt, depthSource, nhdId, hydro, surveys }
//     about:    { title, extract, url, fetchedAt }            Wikipedia
//     access:   { fetchedAt, searchKm, shoreKm, summary, features, land, hike, failed }   as access-lookup.js keeps it,
//               with paths thinned to 4 decimals and 30 points, and summary = the Getting there verdict
//     camping:  { fetchedAt, searchKm, sites, land, dispersed, failed }                  as camping.js keeps it
//     stocking: { recent: [{ year, species, plants, fish }], history: { years, sources }, note }
//     introductions: [{ year, text }]                        USGS NAS records at or naming the water
//     rules:    state-specific: the special regulations that name the water and where they came from
//     advisories: { algae: [...], eating: [...] }           what was in force when the file was built
//     sources:  [{ label, url, fetchedAt }]                  every source touched for this file
//     notes:    [{ date, by, text, source }]                 HAND-KEPT: the job never changes this list (scripts/add-notes.mjs)
//     excerpts: [{ text, source }]                           HAND-KEPT: passages from your own books, with the page
//     manual:   { ... }                                       HAND-KEPT: values here override the job's facts in the app
//     changes:  [{ date, text }]                             what the job saw change, newest first (last 50)
//   }
//   <CORPUS_DIR>/<st>/index.json  { updatedAt, count, waters: [{ id, name, county, lat, lon, checkedAt, verdict, camps, years, notes }] }
//   <CORPUS_DIR>/docs/<st>.md    the catalogue, one section per water, generated from the files
//   <CORPUS_DIR>/docs/CHANGELOG.md  one entry per run
//
// Env: CORPUS_DIR (required), CORPUS_MINUTES (time budget, default 300), CORPUS_MAX (waters per run), CORPUS_REFRESH_DAYS (default 120),
// CORPUS_ONLY (comma list of st:id to build, e.g. "ca:175,or:ALDER_LK"), CORPUS_DOCS_ONLY=1 (rebuild docs only),
// CORPUS_NO_LIVE=1 (skip the live lookups: rebuild the parts that come from the repo's own files).

import { readFile, writeFile, mkdir, readdir, unlink, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = new URL('../', import.meta.url);
const rootPath = p => path.join(ROOT.pathname, p);
// Everything the job writes goes to the private archive folder, outside this public repo (CORPUS_DIR, e.g. a NAS
// folder synced to Google Drive): <dir>/<st>/<id>.json, <dir>/<st>/index.json, <dir>/docs/ catalogue and changelog,
// and <dir>/tackle-box-private-corpus.json, the pack the app imports (⚙️ gear → Import; private-corpus.js).
const OUT = process.env.CORPUS_DIR ? path.resolve(process.env.CORPUS_DIR) : null;
if (!OUT) { console.error('CORPUS_DIR=<private archive folder> is required: the corpus is not kept in the repo.'); process.exit(1); }
const outPath = p => path.join(OUT, p);
const DATA = '.', DOCS = 'docs';
const STATES = ['CA', 'NV', 'OR'];
const MINUTES = +(process.env.CORPUS_MINUTES || 300);
const MAX = process.env.CORPUS_MAX ? +process.env.CORPUS_MAX : Infinity;
const REFRESH_DAYS = +(process.env.CORPUS_REFRESH_DAYS || 120);
const ONLY = process.env.CORPUS_ONLY ? process.env.CORPUS_ONLY.split(',').map(s => s.trim().toLowerCase()) : null;
const DOCS_ONLY = process.env.CORPUS_DOCS_ONLY === '1';
const NO_LIVE = process.env.CORPUS_NO_LIVE === '1';
const REPO = 'https://github.com/mikegutberlet/FishingApp';
const started = Date.now();
const today = new Date().toISOString().slice(0, 10);

// ---------- Behave like the app in a browser ----------
// The app's modules read data/<st>/*.json with relative fetches and keep lookups in the Cache API: here the data
// files come from disk, the cache is a no-op, and live requests go out with a browser-style User-Agent.
globalThis.location = { origin: 'https://mikegutberlet.github.io', href: 'https://mikegutberlet.github.io/FishingApp/' };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.caches = { open: async () => ({ match: async () => null, put: async () => {}, delete: async () => {} }) };
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, init = {}) => {
  const url = String(u);
  // The job never reads the corpus itself: a source that fails stays failed here instead of being filled from the water's own old file.
  if (/^data\/corpus\//.test(url)) return new Response('', { status: 404 });
  if (/^data\//.test(url)) {
    try { return new Response(await readFile(rootPath(url)), { status: 200, headers: { 'Content-Type': 'application/json' } }); } catch { return new Response('', { status: 404 }); }
  }
  try {
    return await realFetch(url, { ...init, headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) TackleBox-corpus (github.com/mikegutberlet/FishingApp)', Referer: location.href, Origin: location.origin, ...(init.headers ?? {}) } });
  } catch (e) { throw new Error(`${e.message}${e.cause?.code ? ` (${e.cause.code})` : ''}`); }
};
// The app logs each source that fails; keep those lines short here.
const warn = console.warn;
console.warn = (...a) => warn(`  ${a.join(' ')}`.slice(0, 200));

const { STATES: MODULES } = await import('../states/index.js');
const { nameKey } = await import('../name-key.js');
const { stockHistoryFor } = await import('../stock-history.js');
const { lookupAccess } = await import('../access-lookup.js');
const { summarize, CLASS_TEXT, MANAGERS, isWilderness, fmtMi } = await import('../access-rules.js');
const { lookupCamping } = await import('../camping.js');
const { dispersedSummary } = await import('../camping-rules.js');
const { haversineKm } = await import('../data-sources.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const minutesLeft = () => MINUTES - (Date.now() - started) / 60000;
const fileOf = (st, id) => `${DATA}/${st.toLowerCase()}/${encodeURIComponent(String(id))}.json`;
async function readJson(p) { try { return JSON.parse(await readFile(outPath(p), 'utf8')); } catch { return null; } }
// Water files are written compact (road geometry pretty-printed is three times the size); the small index stays readable.
// Written whole then renamed into place, so the archive server never hands out a half-written file.
async function writeJson(p, v, pretty = false) { await mkdir(path.dirname(outPath(p)), { recursive: true }); await writeFile(outPath(p) + '.tmp', JSON.stringify(v, null, pretty ? 1 : 0) + '\n'); await rename(outPath(p) + '.tmp', outPath(p)); }
const round = (n, d = 4) => n == null ? null : +(+n).toFixed(d);

// ---------- Which water, and what the app would know about it ----------
// A stocked water (the agency's list) placed on the map's water of the same name when there is one, so the record
// carries the USGS size, elevation and depth, as views/lake.js does when you open it.
const isRiverish = w => /river|creek|stream|slough|canal|fork/i.test(`${w.kind ?? ''} ${w.type ?? ''} ${w.name ?? ''}`) && !/\b(lake|reservoir|pond)\b/i.test(w.name ?? '');
async function lakeRecord(S, w) {
  const { lakes, riverLabels } = await S.statewide();
  const key = nameKey(w.name), river = isRiverish(w);
  const near = (list, km) => list.map(x => ({ x, km: haversineKm(w.lat, w.lon, x.lat, x.lon) })).filter(p => p.km <= km).sort((a, b) => a.km - b.km);
  let hit = null;
  if (!river) {
    const close = near(lakes, 3);
    hit = close.find(p => nameKey(p.x.name) === key)?.x ?? close.find(p => p.km <= 0.4)?.x ?? null;
  } else {
    hit = near(riverLabels, 5).find(p => nameKey(p.x.name) === key)?.x ?? null;
  }
  const lake = {
    id: `corpus-${S.code}-${w.id}`, name: w.name, state: S.code, lat: w.lat, lon: w.lon, kind: hit?.kind ?? (river ? 'river' : 'lake'),
    type: hit?.type ?? w.type ?? null, acres: hit?.acres ?? w.acres ?? null, elevationFt: hit?.elevationFt ?? null,
    maxDepth: hit?.maxDepthFt ?? null, meanDepth: hit?.meanDepthFt ?? null, depthSource: hit?.depthSource ?? null,
    lengthKm: hit?.km ?? null, nhdId: hit ? String(hit.id) : null, county: w.county ?? null, [S.stockField]: w.id,
  };
  // Match from the map water's point when it is the same water, so the lookups centre on the lake, not the plant site.
  if (hit && !river && haversineKm(w.lat, w.lon, hit.lat, hit.lon) <= 3) { lake.lat = hit.lat; lake.lon = hit.lon; }
  return lake;
}

// Keep a feature's shape but not every vertex: 4 decimals (~10 m) and at most 20 points per path.
function thinPaths(paths, max = 20) {
  const seen = new Set();
  return (paths ?? []).map(p => {
    const step = Math.max(1, Math.ceil(p.length / max));
    const out = p.filter((_, i) => i % step === 0);
    if (out.at(-1) !== p.at(-1)) out.push(p.at(-1));
    return out.map(([a, b]) => [round(a), round(b)]);
  }).filter(p => { const k = JSON.stringify(p); return !seen.has(k) && seen.add(k); }); // the same line from two sources, once
}
const compactFeature = f => ({ kind: f.kind, name: f.name ?? null, ref: f.ref ?? null, ...(f.lat != null && { lat: round(f.lat, 5), lon: round(f.lon, 5) }), paths: thinPaths(f.paths),
  tags: Object.fromEntries(Object.entries(f.tags ?? {}).filter(([, v]) => v !== false && !(v && typeof v === 'object' && !Object.keys(v).length))), // null stays: roadClass reads it as "not recorded"
  source: f.source, ...(f.sources?.length > 1 && { sources: f.sources }) });

// The records worth keeping: the tab shows the 40 nearest roads and trails, so the archive keeps the 60 nearest of
// each (a big lake's lookup can return 400 records of a town's streets), and every gate and cell mast.
function keepFeatures(data) {
  const s = summarize({ lat: data.lat, lon: data.lon }, data.shoreKm, data.features, { land: data.land });
  const near = new Map([...s.roads, ...s.trails].map(f => [f.source.id, f.shoreKm]));
  const byKind = kind => data.features.filter(f => f.kind === kind).sort((a, b) => (near.get(a.source.id) ?? Infinity) - (near.get(b.source.id) ?? Infinity));
  return [...byKind('road').slice(0, 60), ...byKind('trail').slice(0, 60), ...data.features.filter(f => f.kind !== 'road' && f.kind !== 'trail')];
}

// The Getting there verdict, in the words the tab uses, so the catalogue can show it without recomputing.
function accessSummary(data) {
  const s = summarize({ lat: data.lat, lon: data.lon }, data.shoreKm, data.features, { land: data.land });
  const v = s.vehicle;
  const verdict = v ? CLASS_TEXT[v.cls].label : s.nearestUnknown ? CLASS_TEXT.unknown.label : data.features.length ? 'No road within reach: walk-in, boat-in or private' : null;
  const wild = (data.land?.parcels ?? []).find(isWilderness);
  return {
    verdict, road: v?.road?.name ?? s.nearestUnknown?.name ?? null, hikeMi: v && v.hikeKm > 0.08 ? fmtMi(v.hikeKm) : null, cls: v?.cls ?? null,
    land: [...new Set((data.land?.parcels ?? []).map(p => MANAGERS[p.manager]?.name ?? p.manager))], wilderness: wild?.unit ?? null,
    trails: { hike: s.hikeTrails.length, bike: s.bikeTrails.length, moto: s.motoTrails.length + s.ohvRoads.length }, gates: s.lockedGates.length, seasonal: s.seasonal.length,
    roads: s.roads.length, trailsTotal: s.trails.length,
  };
}

const compactSite = s => Object.fromEntries(Object.entries(s).filter(([k, v]) => v != null && k !== 'pending').map(([k, v]) => [k, typeof v === 'string' && v.length > 300 ? `${v.slice(0, 299)}…` : v]));

// What the agency says about the water (NDOW's "pertinent information", ODFW's blurb) and its page.
function agencyFor(S, w) {
  return { name: S.agency, url: S.waterUrl(w.id), about: w.about ?? w.info ?? null, lastYearStocked: w.lastYearStocked ?? null, ...(w.region && { region: w.region }), ...(w.zone && { zone: w.zone }) };
}

// Plants on the current schedule, added up by year and species.
async function recentPlants(S, id) {
  const by = {};
  for (const p of await S.plantsFor(id)) {
    const year = String(p.week).slice(0, 4), k = `${year}|${p.species}`;
    by[k] ??= { year: +year, species: p.species, plants: 0, fish: null };
    by[k].plants++;
    if (p.count != null) by[k].fish = (by[k].fish ?? 0) + p.count;
  }
  return Object.values(by).sort((a, b) => b.year - a.year || a.species.localeCompare(b.species));
}

// The rules that name this water, in the state's own shape, trimmed to what a reader needs.
async function rulesFor(S, lake) {
  const r = await S.regsFor?.(lake).catch(e => { console.warn(`regs ${lake.name}:`, e.message); return null; });
  if (!r) return null;
  const out = { source: r.source ?? null, booklet: r.booklet ?? null, updatedAt: r.updatedAt ?? null };
  if (S.code === 'CA') Object.assign(out, { county: r.county ?? null, special: (r.special ?? []).map(w => ({ sec: w.sec, ref: w.ref, name: w.name, text: w.text, parts: w.parts })) });
  if (S.code === 'NV') Object.assign(out, { county: r.county, region: r.region, special: r.special ?? [], closedHere: r.closedHere ?? [], tribal: r.tribal ?? null });
  if (S.code === 'OR') Object.assign(out, { zone: r.zone ?? null, special: (r.special ?? []).map(w => ({ name: w.name, zone: w.zone, rules: w.rules })) });
  return out;
}

async function advisoriesFor(S, lake) {
  const algae = await S.habFor?.(lake).catch(() => []) ?? [];
  const eat = await S.fishAdviceFor?.(lake).catch(() => null);
  return {
    algae: algae.map(a => ({ name: a.name, level: a.level, advisory: a.advisory, date: a.date, detail: a.detail ?? null })),
    eating: (eat?.site ?? []).map(a => ({ name: a.name ?? a.area, url: a.url ?? eat.url, fish: a.fish })),
    eatingSource: eat?.url ?? null,
  };
}

// ---------- Build one water ----------
async function buildWater(S, w, prev, { live }) {
  const lake = await lakeRecord(S, w);
  const now = new Date().toISOString();
  const sources = new Map();
  // One entry per source (the records themselves keep their own links); a forest's MVUM counts as one source.
  const cite = (label, url, fetchedAt = now) => { const k = String(label ?? url).split(' · ')[0]; if (url && label && !sources.has(k)) sources.set(k, { label: k, url, fetchedAt }); };
  const [hydro, surveys, recent, history, intro, rules, advisories] = await Promise.all([
    S.hydroFor(lake).catch(() => null), S.bathymetryFor(lake).catch(() => []), recentPlants(S, w.id), stockHistoryFor(lake).catch(() => null),
    S.historyFor(lake).catch(() => null), rulesFor(S, lake), advisoriesFor(S, lake),
  ]);
  const dates = await S.dataDates().catch(() => ({}));
  cite(`${S.agency} stocking schedule`, S.scheduleUrl, dates.plants);
  cite(`${S.agency} page for the water`, S.waterUrl(w.id));
  if (lake.nhdId) cite('USGS National Hydrography Dataset (data/' + S.code.toLowerCase() + '/lakes.json, rivers.json)', 'https://www.usgs.gov/national-hydrography/national-hydrography-dataset');
  if (hydro) cite('HydroLAKES v1.0 (modelled depth and volume)', 'https://www.hydrosheds.org/products/hydrolakes');
  if (history) for (const y of history.years) for (const s of y.src) cite(s.label, s.url, history.updatedAt);
  if (intro?.local?.length) cite('USGS Nonindigenous Aquatic Species database', 'https://nas.er.usgs.gov/');
  if (rules?.source) cite(`${S.name} fishing regulations`, rules.booklet ?? rules.source, rules.updatedAt);
  for (const a of advisories.eating) cite('Fish consumption advisory', a.url);

  // Live lookups: the roads, trails, land and Wikipedia summary, and the campgrounds, as the phone would get them.
  let access = prev?.access ?? null, camping = prev?.camping ?? null, about = prev?.about ?? null;
  if (live) {
    const t = Date.now();
    const a = await lookupAccess(lake, { force: true }).catch(e => { console.warn(`access ${lake.name}:`, e.message); return null; });
    if (a && a.failed.length < 6) {
      access = { fetchedAt: a.fetchedAt, lat: round(a.lat, 5), lon: round(a.lon, 5), searchKm: round(a.searchKm, 2), shoreKm: round(a.shoreKm, 2), summary: accessSummary(a),
        features: keepFeatures(a).map(compactFeature), land: a.land, hike: a.hike ? { ...a.hike, coords: thinPaths([a.hike.coords ?? []])[0] ?? [], profile: undefined } : null, failed: a.failed };
      if (a.about) about = { ...a.about, fetchedAt: a.fetchedAt };
      else if (!a.failed.includes('Wikipedia')) about = null;
    } else if (a) console.warn(`access ${lake.name}: nothing answered (${a.failed.join(', ')}), keeping the previous copy`);
    const c = await lookupCamping(lake, { force: true }).catch(e => { console.warn(`camping ${lake.name}:`, e.message); return null; });
    if (c && c.failed.length < 6) {
      const d = dispersedSummary(c.land?.parcels);
      camping = { fetchedAt: c.fetchedAt, searchKm: round(c.searchKm, 2), shoreKm: round(c.shoreKm, 2), sites: c.sites.map(compactSite), land: c.land, dispersed: d.level, failed: c.failed };
    } else if (c) console.warn(`camping ${lake.name}: nothing answered, keeping the previous copy`);
    console.log(`  live ${((Date.now() - t) / 1000).toFixed(0)}s: ${access ? `${access.features.length} road/trail records, ${access.summary.verdict ?? 'no verdict'}` : 'no access'}; ${camping ? `${camping.sites.length} campgrounds` : 'no camping'}`);
  }
  for (const f of access?.features ?? []) for (const s of f.sources ?? [f.source]) cite(s.label, s.url, access.fetchedAt);
  for (const p of access?.land?.parcels ?? []) cite(p.source?.label, p.source?.url, access.fetchedAt);
  if (access?.hike?.elevationSource) cite(access.hike.elevationSource.label, access.hike.elevationSource.url, access.fetchedAt);
  if (about?.url) cite('Wikipedia', about.url, about.fetchedAt);
  for (const s of camping?.sites ?? []) for (const x of s.sources ?? []) cite(x.label, x.url, camping.fetchedAt);
  for (const sv of surveys) cite(`Depth survey: ${sv.label ?? sv.id}`, sv.url ?? `${REPO}/blob/main/data/${S.code.toLowerCase()}/bathymetry/${sv.id}.geojson`);

  const file = {
    id: String(w.id), state: S.code, name: w.name, lat: round(lake.lat, 5), lon: round(lake.lon, 5), county: lake.county ?? w.county ?? (typeof w.counties === 'string' ? w.counties : null), kind: lake.kind,
    firstSeen: prev?.firstSeen ?? today, checkedAt: now, updatedAt: prev?.updatedAt ?? now,
    agency: agencyFor(S, w),
    facts: { type: lake.type, acres: lake.acres, elevationFt: lake.elevationFt, maxDepthFt: lake.maxDepth, meanDepthFt: lake.meanDepth, depthSource: lake.depthSource, lengthKm: lake.lengthKm, nhdId: lake.nhdId,
      hydro: hydro ? { acres: hydro.acres, meanDepthFt: hydro.meanDepthFt ?? hydro.depthFt ?? null, volumeAcreFt: hydro.volumeAcreFt ?? null, shoreKm: hydro.shoreKm ?? null, source: 'HydroLAKES estimate' } : null,
      surveys: surveys.map(s => ({ id: s.id, label: s.label ?? null, year: s.year ?? null, url: s.url ?? null })) },
    about, access, camping,
    stocking: { recent, history: history ? { names: history.names, years: history.years.map(y => ({ y: y.y, fish: y.fish, plants: y.plants, sp: y.sp, src: y.src.map(s => s.url) })) } : null, note: S.plantsNote ?? null },
    introductions: (intro?.local ?? []).map(x => ({ year: x.year, text: x.text })),
    rules, advisories,
    sources: [...sources.values()],
    notes: prev?.notes ?? [], excerpts: prev?.excerpts ?? [], manual: prev?.manual ?? {},
    changes: prev?.changes ?? [],
  };
  return file;
}

// ---------- What changed (for the changelog and the file's own list) ----------
const yearsSpan = f => { const ys = (f.stocking?.history?.years ?? []).map(y => y.y); return ys.length ? `${Math.min(...ys)}–${Math.max(...ys)} (${ys.length} years)` : f.stocking?.recent?.length ? `${f.stocking.recent.at(-1).year}–${f.stocking.recent[0].year}` : null; };
function diffFiles(prev, next) {
  const out = [];
  if (!prev) return ['added to the corpus'];
  const p = prev.access?.summary, n = next.access?.summary;
  if (p && n && (p.verdict !== n.verdict || p.road !== n.road)) out.push(`getting there: ${p.verdict ?? '?'}${p.road ? ` via ${p.road}` : ''} → ${n.verdict ?? '?'}${n.road ? ` via ${n.road}` : ''}`);
  if (!p && n) out.push(`getting there recorded: ${n.verdict ?? 'no verdict'}${n.road ? ` via ${n.road}` : ''}`);
  const pc = prev.camping?.sites?.length, nc = next.camping?.sites?.length;
  if (pc != null && nc != null && pc !== nc) out.push(`campgrounds nearby: ${pc} → ${nc}`);
  if (pc == null && nc != null) out.push(`campgrounds recorded: ${nc}`);
  const ps = yearsSpan(prev), ns = yearsSpan(next);
  if (ps !== ns && ns) out.push(`stocking history: ${ps ?? 'none'} → ${ns}`);
  const pr = (prev.rules?.special ?? []).length, nr = (next.rules?.special ?? []).length;
  if (pr !== nr) out.push(`special regulations: ${pr} → ${nr}`);
  const pa = (prev.advisories?.algae ?? []).map(a => a.level).join(','), na = (next.advisories?.algae ?? []).map(a => a.level).join(',');
  if (pa !== na) out.push(`algae advisory: ${pa || 'none'} → ${na || 'none'}`);
  if ((prev.about?.title ?? null) !== (next.about?.title ?? null)) out.push(`Wikipedia article: ${prev.about?.title ?? 'none'} → ${next.about?.title ?? 'none'}`);
  const pl = (prev.access?.land?.parcels ?? []).map(x => x.manager).sort().join(','), nl = (next.access?.land?.parcels ?? []).map(x => x.manager).sort().join(',');
  if (prev.access && next.access && pl !== nl) out.push(`land manager: ${pl || 'none'} → ${nl || 'none'}`);
  return out;
}
// The same file apart from the dates the job stamps on it?
const stable = f => JSON.stringify({ ...f, checkedAt: null, updatedAt: null, sources: f.sources.map(s => s.url), access: f.access && { ...f.access, fetchedAt: null, features: f.access.features.length, land: f.access.land?.parcels?.map(p => p.manager) },
  camping: f.camping && { ...f.camping, fetchedAt: null, sites: f.camping.sites.map(s => s.name) }, about: f.about && { ...f.about, fetchedAt: null }, changes: null });

// ---------- Docs ----------
const slug = f => `${f.name} ${f.id}`.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');
const num = n => n == null ? null : (+n).toLocaleString('en-US');
const link = (t, u) => u ? `[${t}](${u})` : t;
// Where a hand note came from: the book and page, or the web page and the day it was read.
const noteSource = s => [s.url ? link(s.title ?? new URL(s.url).hostname, s.url) : s.title && `*${s.title}*`, s.author, s.page && `p. ${s.page}`, s.read && s.url && `read ${s.read}`].filter(Boolean).join(', ');
function waterSection(S, f) {
  const a = f.access?.summary, lines = [];
  lines.push(`### ${f.name} (${f.id})`);
  lines.push(`${f.county ? `${f.county} · ` : ''}${f.kind === 'river' ? 'river' : f.facts.type?.toLowerCase() ?? 'lake'}${f.facts.acres ? ` · ${num(f.facts.acres)} acres` : ''}${f.facts.elevationFt != null ? ` · ${num(f.facts.elevationFt)} ft` : ''}${f.facts.maxDepthFt ? ` · max depth ${num(f.facts.maxDepthFt)} ft (${f.facts.depthSource ?? 'USGS'})` : f.facts.hydro?.meanDepthFt ? ` · mean depth ≈${num(Math.round(f.facts.hydro.meanDepthFt))} ft (HydroLAKES estimate)` : ''} · ${f.lat}, ${f.lon} · ${link(`${f.agency.name} page`, f.agency.url)} · [JSON](../../${fileOf(S.code, f.id)})`);
  if (f.about?.extract) lines.push(`\n> ${f.about.extract.replace(/\s+/g, ' ').slice(0, 600)}${f.about.extract.length > 600 ? '…' : ''} — ${link('Wikipedia', f.about.url)}, ${f.about.fetchedAt?.slice(0, 10)}`);
  else if (f.agency.about) lines.push(`\n> ${String(f.agency.about).replace(/\s+/g, ' ').slice(0, 600)} — ${f.agency.name}`);
  if (a) {
    const bits = [a.verdict ?? 'no verdict', a.road ? `via ${a.road}` : null, a.hikeMi ? `then ${a.hikeMi} on foot` : null, a.land.length ? `land: ${a.land.join(', ')}` : null, a.wilderness ? `wilderness: ${a.wilderness}` : null,
      a.gates ? `${a.gates} locked gate${a.gates > 1 ? 's' : ''}` : null, a.seasonal ? `${a.seasonal} seasonal road${a.seasonal > 1 ? 's' : ''}/trails` : null, `${a.roads} roads and ${a.trailsTotal} trails recorded`].filter(Boolean);
    lines.push(`- **Getting there** (${f.access.fetchedAt.slice(0, 10)}): ${bits.join(' · ')}${f.access.failed?.length ? ` · didn't answer: ${f.access.failed.join(', ')}` : ''}`);
    if (f.access.hike) lines.push(`- **Walk in**: ${f.access.hike.crow ? 'about ' : ''}${fmtMi(f.access.hike.km)} from ${f.access.hike.start?.road ?? 'the road'}${f.access.hike.trails?.length ? ` via ${f.access.hike.trails.map(t => t.name).filter(Boolean).join(', ')}` : ''}${f.access.hike.stats ? `, ${Math.round(f.access.hike.stats.upM * 3.28)} ft up` : ''}`);
  }
  if (f.camping) {
    const top = f.camping.sites.slice(0, 5).map(s => `${s.name}${s.distKm != null ? ` (${fmtMi(s.distKm)})` : ''}`);
    lines.push(`- **Camping** (${f.camping.fetchedAt.slice(0, 10)}): ${f.camping.sites.length} campground${f.camping.sites.length === 1 ? '' : 's'} within ${fmtMi(f.camping.searchKm)}${top.length ? `: ${top.join(', ')}${f.camping.sites.length > 5 ? '…' : ''}` : ''} · dispersed camping: ${{ yes: 'generally allowed on the public land around it', wild: 'backpack only (wilderness)', no: 'not outside campgrounds', unknown: 'no public land recorded' }[f.camping.dispersed] ?? f.camping.dispersed}`);
  }
  const span = yearsSpan(f);
  if (span || f.stocking.recent.length) {
    const sp = [...new Set([...f.stocking.recent.map(r => r.species), ...Object.keys((f.stocking.history?.years ?? []).reduce((m, y) => Object.assign(m, y.sp), {}))])];
    lines.push(`- **Stocking**: ${span ? `records ${span}` : 'current schedule only'}${sp.length ? ` · ${sp.slice(0, 6).join(', ')}` : ''}${f.agency.lastYearStocked ? ` · last stocked ${f.agency.lastYearStocked}` : ''}${f.stocking.history ? ` · ${new Set(f.stocking.history.years.flatMap(y => y.src)).size} source documents` : ''}`);
  }
  if (f.introductions.length) lines.push(`- **Introductions** (USGS NAS): ${f.introductions.slice(0, 6).map(i => `${i.year} ${i.text}`).join('; ')}${f.introductions.length > 6 ? `; +${f.introductions.length - 6} more` : ''}`);
  const special = f.rules?.special ?? [];
  if (special.length || f.rules?.closedHere?.length || f.rules?.tribal) {
    const texts = special.map(w => w.text ?? (w.rules ? `${w.name}: ${w.rules.join(' ')}` : [w.name, w.season, w.limit].filter(Boolean).join(': ')));
    lines.push(`- **Rules that name it**: ${texts.map(t => t.replace(/\s+/g, ' ').slice(0, 220)).join(' · ')}${f.rules.closedHere?.length ? ` · closed: ${f.rules.closedHere.map(c => c.text).join(' ')}` : ''}${f.rules.tribal ? ` · ${f.rules.tribal}` : ''} (${link('booklet', f.rules.booklet ?? f.rules.source)})`);
  }
  if (f.advisories.algae.length) lines.push(`- **Toxic algae** (${f.checkedAt.slice(0, 10)}): ${f.advisories.algae.map(a => `${a.advisory ?? a.level}${a.date ? ` since ${a.date}` : ''}`).join('; ')}`);
  if (f.advisories.eating.length) lines.push(`- **Eating the fish**: ${f.advisories.eating.map(a => link(a.name, a.url)).join('; ')}`);
  for (const n of f.notes) lines.push(`- 📝 **Note** (${n.date}${n.by ? `, ${n.by}` : ''}): ${n.text}${n.source ? ` (${noteSource(n.source)})` : ''}`);
  for (const x of f.excerpts ?? []) lines.push(`- 📖 **From your books**: “${x.text}”${x.source ? ` (${noteSource(x.source)})` : ''}`);
  lines.push(`- ${f.sources.length} sources · first seen ${f.firstSeen} · last checked ${f.checkedAt.slice(0, 10)}`);
  return lines.join('\n');
}

async function writeDocs(S, files) {
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name));
  const withAccess = sorted.filter(f => f.access).length, withCamp = sorted.filter(f => f.camping).length, withHist = sorted.filter(f => f.stocking.history).length, withNotes = sorted.filter(f => f.notes.length).length;
  const byCounty = {};
  for (const f of sorted) (byCounty[f.county ?? 'Unplaced'] ??= []).push(f);
  const counties = Object.keys(byCounty).sort();
  // GitHub stops rendering Markdown past about half a megabyte, so the sections go in pages of ~250 KB by county
  // (one page when they fit), and the state page holds the summary and the contents.
  const st = S.code.toLowerCase(), pages = [[]];
  let size = 0;
  const sections = Object.fromEntries(counties.map(c => [c, byCounty[c].map(f => waterSection(S, f) + '\n').join('\n')]));
  for (const c of counties) { if (size + sections[c].length > 250000 && pages.at(-1).length) { pages.push([]); size = 0; } pages.at(-1).push(c); size += sections[c].length; }
  const pageOf = c => pages.length === 1 ? '' : `${st}-${pages.findIndex(pg => pg.includes(c)) + 1}.md`;
  const head = `Generated by \`scripts/build-corpus.mjs\` from \`${st}/\`; do not edit by hand (put notes in a water's JSON file under \`notes\`, and they show up here on the next run). See the [README](README.md) for how the corpus is built and kept.`;
  const md = [`# ${S.name} waters: the corpus`, '', `Every ${S.agency} stocked water with a map point, with what Tackle Box knows about it. ${head}`, '',
    `**${sorted.length} waters** · getting there recorded for ${withAccess} · camping for ${withCamp} · multi-year stocking history for ${withHist} · hand notes on ${withNotes} · last run ${today}`, '',
    '## Contents', '', ...counties.map(c => `- **${pages.length === 1 ? c : `[${c}](${pageOf(c)}#${c.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-')})`}**: ${byCounty[c].map(f => `[${f.name}](${pageOf(c)}#${slug(f)})`).join(' · ')}`), '',
    ...(pages.length === 1 ? counties.flatMap(c => [`## ${c}`, '', sections[c]]) : [`The waters are on ${pages.length} pages: ${pages.map((pg, i) => `[${pg[0]} – ${pg.at(-1)}](${st}-${i + 1}.md)`).join(' · ')}.`]),
  ].join('\n');
  await mkdir(outPath(DOCS), { recursive: true });
  await writeFile(outPath(`${DOCS}/${st}.md`), md);
  const stale = (await readdir(outPath(DOCS))).filter(n => new RegExp(`^${st}-\\d+\\.md$`).test(n));
  for (const n of stale) await writeFile(outPath(`${DOCS}/${n}`), ''); // rewritten below or left empty to be removed
  if (pages.length > 1) for (const [i, pg] of pages.entries()) {
    await writeFile(outPath(`${DOCS}/${st}-${i + 1}.md`), [`# ${S.name} waters: ${pg[0]} – ${pg.at(-1)}`, '', `Part ${i + 1} of ${pages.length} of the [${S.name} catalogue](${st}.md). ${head}`, '', ...pg.flatMap(c => [`## ${c}`, '', sections[c]])].join('\n'));
  }
  for (const n of stale) if (!(await readFile(outPath(`${DOCS}/${n}`), 'utf8')).length) await unlink(outPath(`${DOCS}/${n}`));
}

async function appendChangelog(runs) {
  const p = `${DOCS}/CHANGELOG.md`;
  let old = existsSync(outPath(p)) ? await readFile(outPath(p), 'utf8') : '# Corpus changelog\n\nOne entry per run of `scripts/build-corpus.mjs`, newest first: how many waters were checked and what changed. A water\'s own `changes` list in its JSON file has the same lines.\n';
  const total = runs.reduce((n, r) => n + r.checked, 0);
  if (!runs.some(r => r.added || r.changed)) return; // a run that only confirmed what was there isn't news
  const lines = [`## ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC`, '',
    `Checked ${total} water${total === 1 ? '' : 's'} in ${((Date.now() - started) / 60000).toFixed(0)} min: ${runs.map(r => `${r.state} ${r.checked} (${r.added} new, ${r.changed} changed, ${r.kept} unchanged${r.live ? '' : ', no live lookups'})`).join(' · ')}.`, ''];
  for (const r of runs) for (const [name, ch] of r.changes) lines.push(`- ${r.state} ${name}: ${ch.join('; ')}`);
  const [head, ...rest] = old.split(/\n(?=## )/);
  await writeFile(outPath(p), [head.trimEnd(), '', lines.join('\n'), '', ...rest].join('\n').replace(/\n{3,}/g, '\n\n'));
}

// ---------- Main ----------
const runs = [];
for (const code of STATES) {
  const S = MODULES[code], dir = `${DATA}/${code.toLowerCase()}`;
  const waters = (await S.waters()).filter(w => w.lat != null && w.lon != null && w.name);
  const index = await readJson(`${dir}/index.json`) ?? { waters: [] };
  const checked = new Map(index.waters.map(x => [String(x.id), x.checkedAt]));
  // Oldest first: never checked, then the longest ago. Within a budget, each night moves the frontier along.
  let todo = waters.filter(w => !ONLY || ONLY.includes(`${code.toLowerCase()}:${String(w.id).toLowerCase()}`))
    .sort((a, b) => (Date.parse(checked.get(String(a.id)) ?? 0) || 0) - (Date.parse(checked.get(String(b.id)) ?? 0) || 0));
  if (!ONLY && !DOCS_ONLY) todo = todo.filter(w => Date.now() - (Date.parse(checked.get(String(w.id)) ?? 0) || 0) > REFRESH_DAYS * 864e5);
  const run = { state: code, checked: 0, added: 0, changed: 0, kept: 0, changes: [], live: !NO_LIVE };
  console.log(`\n${S.name}: ${waters.length} stocked waters with a point, ${todo.length} due${DOCS_ONLY ? ' (docs only)' : ''}`);
  if (!DOCS_ONLY) {
    for (const w of todo) {
      if (runs.reduce((n, r) => n + r.checked, 0) + run.checked >= MAX) break;
      if (minutesLeft() < (NO_LIVE ? 0.2 : 3)) { console.log(`time budget spent (${MINUTES} min); ${todo.length - run.checked} left for the next run`); break; }
      // A file the job hasn't built yet holds only hand notes (scripts/add-notes.mjs): build it as new and keep them.
      const file = fileOf(code, w.id), raw = await readJson(file), prev = raw?.checkedAt ? raw : null;
      console.log(`${code} ${w.name} (${w.id})${prev ? `, last ${prev.checkedAt.slice(0, 10)}` : ', new'}`);
      let next;
      try { next = await buildWater(S, w, raw, { live: !NO_LIVE }); } catch (e) { console.warn(`  failed: ${e.stack ?? e.message}`); continue; }
      const ch = diffFiles(prev, next);
      if (ch.length) { next.changes = [...ch.map(text => ({ date: today, text })), ...(prev?.changes ?? [])].slice(0, 50); next.updatedAt = next.checkedAt; run.changes.push([w.name, ch]); }
      else if (prev && stable(prev) === stable(next)) { next.updatedAt = prev.updatedAt; }
      else next.updatedAt = next.checkedAt;
      // An unchanged file isn't rewritten (the visit is noted in the index), so the repo's history grows only with real changes.
      if (!prev || ch.length || next.updatedAt === next.checkedAt) await writeJson(file, next);
      run.checked++;
      if (!prev) run.added++; else if (ch.length) run.changed++; else run.kept++;
      checked.set(String(w.id), next.checkedAt);
      // Be a polite client of the public services between waters.
      if (!NO_LIVE) await sleep(1500);
    }
  }
  runs.push(run);
  // The index and the catalogue cover every file in the folder, not just this run's.
  const files = [];
  if (existsSync(outPath(dir))) for (const name of await readdir(outPath(dir))) if (name.endsWith('.json') && name !== 'index.json') { const f = await readJson(`${dir}/${name}`); if (f?.checkedAt) files.push(f); }
  const byId = new Map(waters.map(w => [String(w.id), w]));
  await writeJson(`${dir}/index.json`, {
    updatedAt: new Date().toISOString(), count: files.length, stocked: waters.length,
    waters: files.sort((a, b) => a.name.localeCompare(b.name)).map(f => ({ id: f.id, name: f.name, county: f.county, lat: f.lat, lon: f.lon, checkedAt: checked.get(f.id) ?? f.checkedAt, updatedAt: f.updatedAt,
      verdict: f.access?.summary?.verdict ?? null, camps: f.camping?.sites?.length ?? null, years: yearsSpan(f), notes: f.notes.length, dropped: !byId.has(f.id) || undefined })),
  }, true);
  await writeDocs(S, files.map(f => ({ ...f, checkedAt: checked.get(f.id) ?? f.checkedAt })));
  console.log(`${code}: ${run.checked} checked (${run.added} new, ${run.changed} changed, ${run.kept} unchanged); ${files.length} files in the corpus`);
}
await appendChangelog(runs);
// The pack the app imports: every water's file, keyed st/id, plus the books in <dir>/library by file name.
{
  const waters = {};
  for (const code of STATES) { const st = code.toLowerCase(); if (!existsSync(outPath(st))) continue; for (const name of await readdir(outPath(st))) if (name.endsWith('.json') && name !== 'index.json') { const f = await readJson(`${st}/${name}`); if (f) waters[`${st}/${name.slice(0, -5)}`] = f; } }
  const library = existsSync(outPath('library')) ? (await readdir(outPath('library'))).filter(n => !n.startsWith('.')).sort() : [];
  await writeJson('tackle-box-private-corpus.json', { app: 'tackle-box', kind: 'private-corpus', builtAt: new Date().toISOString(), waters, library });
  console.log(`pack: ${Object.keys(waters).length} waters, ${library.length} books → ${outPath('tackle-box-private-corpus.json')}`);
}
console.log(`\ndone in ${((Date.now() - started) / 60000).toFixed(1)} min`);
