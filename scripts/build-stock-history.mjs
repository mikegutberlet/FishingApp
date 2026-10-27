// Builds data/<st>/stock-history.json: years of stocking per water, from the agencies' annual reports and archived
// copies of their stocking schedules, merged with the current schedule the daily jobs keep in plants.json.
//
//   Oregon      ODFW Fish Propagation Annual Reports, 2006 on (PDF; number of fish by waterbody and species)
//   Nevada      NDOW stocking report pages saved by the Internet Archive, 2003–2021 (date, water, number, size, species)
//   California  CDFW plant schedule pages saved by the Internet Archive, 2007 on (week, water, species; CDFW never
//               publishes trout counts), and CDFW's salmon and steelhead hatchery release spreadsheets, 2001 on (counts)
//
// Parsed records are kept in data/<st>/stock-archive.json with the list of copies already read, so a run only fetches
// copies and reports it hasn't seen. Usage: node scripts/build-stock-history.mjs <ca|nv|or>
// Set STOCK_RAW=<dir> to read saved page text from a folder instead of the network (dev; see scripts/dev/).
import { execSync } from 'node:child_process';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { nameKey } from '../name-key.js';
import { parseOdfwReport, parseOdfwReportCentered, WATERSHEDS } from './stock-history/odfw-reports.mjs';
import { parseNdowPage } from './stock-history/ndow-archive.mjs';
import { parseRegionPage, parseNrmPage } from './stock-history/cdfw-archive.mjs';

const st = (process.argv[2] ?? '').toLowerCase();
if (!['ca', 'nv', 'or'].includes(st)) { console.error('Usage: node scripts/build-stock-history.mjs <ca|nv|or>'); process.exit(2); }
const DIR = new URL(`../data/${st}/`, import.meta.url);
const RAW = process.env.STOCK_RAW;
const UA = { 'User-Agent': 'Mozilla/5.0 (TackleBox-fishing-app; github.com/mikegutberlet/FishingApp)' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJson = async (name, fallback) => { try { return JSON.parse(await readFile(new URL(name, DIR), 'utf8')); } catch { return fallback; } };
const writeJson = (name, data) => writeFile(new URL(name, DIR), JSON.stringify(data) + '\n');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const savedOn = ts => `${MONTHS[+ts.slice(4, 6) - 1]} ${+ts.slice(6, 8)}, ${ts.slice(0, 4)}`;
const isoTs = ts => `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;

async function get(url) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(120000) });
      if (r.ok) return r;
      if (r.status === 404) return null;
      console.log(`  ${r.status} ${url}`);
    } catch (e) { console.log(`  ${e.message} ${url}`); }
    await sleep(4000 * (i + 1));
  }
  return null;
}
// Page text with table rows on their own line and cells separated by " | ", which the parsers read.
export const tableText = h => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<\/(tr|p|div|h\d|li)>|<br\s*\/?>/gi, '\n').replace(/<\/t[dh]>/gi, ' | ').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/&ndash;/g, '–').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
const pdfText = async url => {
  const r = await get(url); if (!r) return null;
  await writeFile('/tmp/stock-report.pdf', Buffer.from(await r.arrayBuffer()));
  return execSync('pdftotext -layout /tmp/stock-report.pdf -', { maxBuffer: 1e9 }).toString();
};

// ---------- Internet Archive copies ----------
// Every distinct copy (by content digest) of the pages under `prefix` that `keep` accepts, as {id, ts, url, text}.
async function* archived(prefix, keep, rawDir) {
  if (RAW) {
    for (const f of (await readdir(`${RAW}/${st}/${rawDir}`)).sort()) {
      const text = gunzipSync(await readFile(`${RAW}/${st}/${rawDir}/${f}`)).toString();
      const src = text.match(/^SOURCE (\S+)/)?.[1] ?? '';
      const [, ts, url] = src.match(/\/web\/(\d{14})id_\/(.+)$/) ?? [];
      if (ts) yield { id: `${ts} ${url}`, ts, url, text };
    }
    return;
  }
  const r = await get(`https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(prefix)}&output=json&fl=timestamp,original,digest&filter=statuscode:200&collapse=digest`);
  if (!r) throw new Error(`Internet Archive index unavailable for ${prefix}`);
  const seenDigest = new Set();
  for (const [ts, url, digest] of (await r.json()).slice(1)) {
    if (!keep(url) || seenDigest.has(digest)) continue;
    seenDigest.add(digest);
    const id = `${ts} ${url}`;
    if (archive.seen.has(id)) continue;
    const page = await get(`https://web.archive.org/web/${ts}id_/${url}`);
    await sleep(400);
    if (page) yield { id, ts, url, text: tableText(await page.text()) };
  }
}

// ---------- the archive of parsed records ----------
const archive = await readJson('stock-archive.json', { sources: [], seen: [], records: [] });
archive.seen = new Set(archive.seen);
const sourceIndex = new Map(archive.sources.map((s, i) => [s.url, i]));
const source = (label, url) => { if (!sourceIndex.has(url)) { sourceIndex.set(url, archive.sources.length); archive.sources.push({ label, url }); } return sourceIndex.get(url); };
// Records: [date (YYYY-MM-DD, or the week's Sunday, or YYYY for an annual report), water, county, species, fish, source,
// and for ODFW reports the releasing hatchery].
const add = (rows, src) => { for (const r of rows) archive.records.push([r.date, r.water, r.county ?? null, r.species, r.fish ?? null, src, ...(r.via ? [r.via] : [])]); };
let read = 0;

if (st === 'or') {
  // Report file names vary by year; Wayback's index of the folder lists them all.
  const r = RAW ? null : await get('https://web.archive.org/cdx/search/cdx?url=www.dfw.state.or.us/fish/hatchery/docs/*&output=json&fl=original&collapse=urlkey&filter=statuscode:200');
  const urls = r ? (await r.json()).slice(1).map(x => x[0]) : [];
  const byYear = {};
  for (const u of urls.filter(u => /propag/i.test(u) && /\.pdf$/i.test(u))) {
    const y = +u.match(/(20\d\d)/)?.[1];
    if (y >= 2006) (byYear[y] ??= new Set()).add(u.replace(/^http:/, 'https:').replace(/:80\//, '/').replace(/\/\/+fish/, '/fish').replace(/ /g, '%20'));
  }
  if (RAW) for (const f of await readdir(`${RAW}/or`)) { const y = +f.match(/^prop-(\d{4})/)?.[1]; if (y >= 2006) byYear[y] = new Set([`raw:${f}`]); }
  // Reports whose merged-cell layout the row parser misreads (2022, 2023) get a second pass that places each release
  // by the water that had the same species and hatchery in the other years' reports.
  const retry = [];
  const take = (y, url, rows, how) => {
    const src = source(`ODFW ${y} Fish Propagation Annual Report`, url);
    add(rows.map(x => ({ date: String(y), water: x.water, county: WATERSHEDS[x.shed]?.[1].join(', '), species: x.species, fish: x.fish, via: x.hatchery })), src);
    archive.seen.add(`odfw-report ${y} ${url}`); read++;
    console.log(`ODFW ${y} report: ${rows.length} rows, ${Math.round(rows.reduce((t, x) => t + x.fish, 0) / 1e5) / 10}M fish${how}`);
  };
  for (const [y, set] of Object.entries(byYear)) {
    if ([...archive.seen].some(id => id.startsWith(`odfw-report ${y} `))) continue;
    for (const u of set) {
      const text = u.startsWith('raw:') ? gunzipSync(await readFile(`${RAW}/or/${u.slice(4)}`)).toString() : await pdfText(u);
      if (!text) continue;
      const url = u.startsWith('raw:') ? text.match(/^SOURCE (\S+)/)[1] : u;
      // The report says how many fish the table adds up to; a parse that falls short of it is not used.
      const stated = +text.replace(/\s+/g, ' ').match(/Stocked by Watershed[^.]*?\. A total of ([\d.]+) million fish/i)?.[1] * 1e6 || null;
      const fits = rows => rows.length > 200 && (!stated || rows.reduce((t, x) => t + x.fish, 0) >= stated * 0.85);
      const rows = parseOdfwReport(text, +y);
      if (fits(rows)) take(y, url, rows, ` of ${stated / 1e6}M stated`);
      else retry.push({ y, url, text, stated, fits });
      break;
    }
  }
  const prior = new Map();
  for (const r of archive.records) if (r[6]) { const k = `${r[3]}|${String(r[6]).toLowerCase()}`; if (!prior.has(k)) prior.set(k, new Set()); prior.get(k).add(r[1]); }
  for (const { y, url, text, stated, fits } of retry) {
    const rows = parseOdfwReportCentered(text, +y, prior);
    if (fits(rows)) take(y, url, rows, ` of ${stated / 1e6}M stated (merged-cell layout)`);
    else console.log(`ODFW ${y} report: couldn't be read (${rows.length} rows); left out`);
  }
}

if (st === 'nv') {
  for (const [prefix, keep, dir] of [
    ['ndow.org/fish/stocking/*', u => /(east|west|south)\.shtm/i.test(u), 'old'],
    ['www.ndow.org/Fish/Stocking_Updates/*', u => /(Eastern|Western|Southern)_Nevada/i.test(u), 'upd'],
  ]) {
    for await (const c of archived(prefix, keep, dir)) {
      archive.seen.add(c.id);
      const rows = parseNdowPage(c.text, isoTs(c.ts));
      if (!rows.length) continue;
      const region = c.url.match(/(east|west|south)/i)?.[1] ?? '';
      const src = source(`NDOW ${region.toLowerCase()}ern Nevada stocking report, saved ${savedOn(c.ts)} (Internet Archive)`, `https://web.archive.org/web/${c.ts}/${c.url}`);
      // A water's year-to-date total (2017 pages) counts as a record of its own, dated the day the page was saved.
      add(rows, src);
      add(rows.filter(r => r.ytd).map(r => ({ date: isoTs(c.ts), water: r.water, county: r.county, species: 'YTD ' + r.species, fish: r.ytd })), src);
      read++;
    }
  }
}

if (st === 'ca') {
  for (const [prefix, keep, dir, parse] of [
    ['www.dfg.ca.gov/fish/Hatcheries/FishPlanting/*', u => /(northern|northcentral|baydelta|central|southcoast|southcoast_catfish|inlanddeserts)\.asp/i.test(u), 'region', parseRegionPage],
    ['nrm.dfg.ca.gov/FishPlants/*', u => /FishPlants\/?(Default\.aspx)?(\?.*time=All.*)?$/i.test(u) || /PublicPlantSearch$/i.test(u), 'nrm', (t) => parseNrmPage(t)],
  ]) {
    for await (const c of archived(prefix, keep, dir)) {
      archive.seen.add(c.id);
      const rows = parse(c.text, c.url);
      if (!rows.length) continue;
      const src = source(`CDFW plant schedule, saved ${savedOn(c.ts)} (Internet Archive)`, `https://web.archive.org/web/${c.ts}/${c.url}`);
      add(rows.map(r => ({ date: r.week, water: r.water, county: r.counties, species: r.species.replace(/^\w/, ch => ch.toUpperCase()), fish: null })), src);
      read++;
    }
  }
  // Salmon and steelhead releases: the 2001–2017 file is fixed; the current file (2018 on) is read every run.
  await anadromous();
}

async function anadromous() {
  const { default: XLSX } = await import('xlsx').catch(() => ({ default: null }));
  for (const [id, label] of [[156895, 'CDFW anadromous hatchery releases, 2001–2017'], [203214, 'CDFW anadromous hatchery releases, 2018 on']]) {
    const url = `https://nrm.dfg.ca.gov/FileHandler.ashx?DocumentID=${id}`;
    if (id === 156895 && archive.seen.has(url)) continue;
    let csv;
    if (RAW) csv = gunzipSync(await readFile(`${RAW}/ca/anadromous-${id}.csv.gz`)).toString();
    else {
      if (!XLSX) { console.log('xlsx not installed; skipping anadromous releases'); return; }
      const r = await get(url); if (!r) continue;
      const wb = XLSX.read(Buffer.from(await r.arrayBuffer()));
      csv = XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]]);
    }
    const rows = parseCsv(csv);
    const hdr = rows.findIndex(r => r.includes('NetNumberReleased') || r.includes('Released Fish No'));
    const h = rows[hdr], col = name => h.indexOf(name);
    const old = h.includes('NetNumberReleased');
    const out = [];
    for (const r of rows.slice(hdr + 1)) {
      const d = (r[col(old ? 'EvntDate' : 'Date')] ?? '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
      const fish = +String(r[col(old ? 'NetNumberReleased' : 'Released Fish No')] ?? '').replace(/[^\d]/g, '');
      if (!d || !fish) continue;
      const y = d[3].length === 2 ? 2000 + +d[3] : +d[3];
      const water = String(r[col(old ? 'ReleaseWater' : 'Water')] ?? '').split(',')[0].trim();
      // The old file names the stock ("SH-FR-00", "CHIN-…"), the new one the species.
      const stock = old ? String(r[col('StockCode')] ?? '') : '';
      const species = old ? (/^SH|STH/i.test(stock) ? 'Steelhead Trout' : /^CO/i.test(stock) ? 'Coho Salmon' : 'Chinook Salmon') : r[col('Species')];
      out.push({ date: `${y}-${d[1].padStart(2, '0')}-${d[2].padStart(2, '0')}`, water, county: r[col(old ? 'ReleaseCounty' : 'Release County')] || null, species, fish });
    }
    // The current file is re-read whole each run, so its earlier records are replaced, not added again.
    const src = source(label, url);
    archive.records = archive.records.filter(x => x[5] !== src);
    add(out, src);
    archive.seen.add(url);
    console.log(`${label}: ${out.length} releases`);
  }
}

function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// One record per stocking: the same plant appears on many saved copies.
const dedupe = new Map();
for (const r of archive.records) {
  const k = `${r[0]}|${nameKey(r[1])}|${String(r[3]).toLowerCase()}|${r[4] ?? ''}|${r[6] ?? ''}`;
  if (!dedupe.has(k)) dedupe.set(k, r);
}
archive.records = [...dedupe.values()].sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
console.log(`${read} new copies/reports read; ${archive.records.length} records, ${archive.sources.length} sources`);
await writeJson('stock-archive.json', { updatedAt: new Date().toISOString(), note: 'Parsed stocking records for scripts/build-stock-history.mjs; not read by the app.', sources: archive.sources, seen: [...archive.seen].sort(), records: archive.records });

// ---------- the current schedule (plants.json) ----------
const AGENCY = { ca: ['CDFW fish planting schedule', 'https://nrm.dfg.ca.gov/FishPlants/'], nv: ['NDOW stocking reports', 'https://www.ndow.org/get-outside/fishing-stocking-reports/'], or: ['ODFW trout stocking schedule', 'https://myodfw.com/fishing/species/trout/stocking-schedule'] }[st];
const liveSrc = archive.sources.length;
const sources = [...archive.sources, { label: AGENCY[0], url: AGENCY[1] }];
const today = new Date().toISOString().slice(0, 10);
const live = ((await readJson('plants.json', { plants: [] })).plants).filter(p => p.weekEnd < today)
  .map(p => [p.week, p.water, p.counties, p.species, p.count ?? null, liveSrc, p.stockId]);

// ---------- match names to the app's waters ----------
const [waters, lakes, rivers, counties] = await Promise.all([readJson('waters.json', { waters: [] }), readJson('lakes.json', { lakes: [] }), readJson('rivers.json', { rivers: [] }), readJson('counties.json', { counties: [] })]);
const insideRing = ([x, y], ring) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
const countyAt = (lat, lon) => counties.counties.find(k => lon >= k.bbox[0] && lon <= k.bbox[2] && lat >= k.bbox[1] && lat <= k.bbox[3]
  && k.polys.some(([outer, ...holes]) => insideRing([lon, lat], outer) && !holes.some(h => insideRing([lon, lat], h))))?.name ?? null;
const km = (a, b, c, d) => { const r = Math.PI / 180, x = (d - b) * r * Math.cos((a + c) / 2 * r), y = (c - a) * r; return 6371 * Math.hypot(x, y); };
const group = (list, f) => { const m = new Map(); for (const x of list) for (const k of new Set([f(x)].flat())) if (k) { if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; };
const stocked = group(waters.waters, w => [nameKey(w.name), w.raw && nameKey(w.raw)]);
const statewide = group([...lakes.lakes.map(l => ({ ...l, kind: 'lake' })), ...rivers.rivers.flatMap(r => (r.points ?? []).slice(0, 1).map(([lat, lon]) => ({ ...r, lat, lon, kind: 'river', pts: r.points })))], x => nameKey(x.name));
// A record's county field can be a list ("Amador, Calaveras", or an Oregon watershed's counties); zone and region
// labels ("Southwest Zone · Gold Beach", "Western region") aren't counties.
const countyList = c => String(c ?? '').split(/[,·]/).map(x => x.trim().toLowerCase()).filter(x => x && !/\b(zone|region)\b/.test(x));
const countyName = c => countyList(c)[0] ?? '';
// Agencies and the map disagree on "Reservoir" and "Lake" for the same water (Detroit Reservoir is Detroit Lake).
// Forks too: the map's "South Santiam River" is ODFW's "Santiam River, S Fork".
const variants = k => [k, k.endsWith('reservoir') ? k.replace(/reservoir$/, 'lake') : k.endsWith('lake') ? k.replace(/lake$/, 'reservoir') : null,
  /^(north|south|east|west|middle)fork/.test(k) ? k.replace(/^(north|south|east|west|middle)fork/, '$1') : null].filter(Boolean);
const lookup = (m, k) => { for (const v of variants(k)) if (m.has(v)) return m.get(v); return []; };
const cache = new Map();
// The stocked water (agency id) and statewide water (map id) a record's name means, if they can be told apart.
function match(name, county, stockId) {
  const key = nameKey(name), cl = countyList(county);
  const ck = `${key}|${cl}|${stockId ?? ''}`;
  if (cache.has(ck)) return cache.get(ck);
  let s = stockId != null ? waters.waters.find(w => String(w.id) === String(stockId)) : null;
  if (!s) {
    let c = lookup(stocked, key);
    if (c.length > 1 && cl.length) c = c.filter(w => countyList(w.county ?? w.counties).some(x => cl.includes(x)));
    s = c.length === 1 ? c[0] : null;
  }
  let n = lookup(statewide, key);
  const near = (x, p) => x.kind === 'river' ? Math.min(...x.pts.map(([a, b]) => km(a, b, p.lat, p.lon))) : km(x.lat, x.lon, p.lat, p.lon);
  if (s?.lat != null) n = n.filter(x => near(x, s) <= (x.kind === 'river' ? 8 : 5)).sort((a, b) => near(a, s) - near(b, s)).slice(0, 1);
  else if (n.length > 1 && cl.length && counties.counties.length) n = n.filter(x => (x.pts ?? [[x.lat, x.lon]]).some(([a, b]) => cl.includes((countyAt(a, b) ?? '').toLowerCase())));
  const nhd = n.length === 1 ? n[0] : null;
  const out = { key, stockId: s ? String(s.id) : null, nhd: nhd ? String(nhd.id) : null, lat: s?.lat ?? nhd?.lat ?? null, lon: s?.lon ?? nhd?.lon ?? null,
    ambiguous: !s && !nhd && lookup(statewide, key).length > 1 };
  cache.set(ck, out);
  return out;
}

// ---------- per water, per year ----------
const entries = new Map();
const yearOf = d => +d.slice(0, 4);
for (const [date, water, county, species, fish, src, stockId] of [...archive.records.map(r => r.slice(0, 6)), ...live]) {
  if (!water || /total/i.test(water)) continue;
  const m = match(water, county, stockId);
  const id = m.stockId ? `s:${m.stockId}` : m.nhd ? `n:${m.nhd}` : `k:${m.key}|${countyName(county)}`;
  const e = entries.get(id) ?? { ids: m.stockId ? [m.stockId] : [], nhd: m.nhd, names: new Map(), key: m.key, county: countyName(county) || null, lat: m.lat, lon: m.lon, ambiguous: m.ambiguous, recs: [] };
  e.names.set(water, (e.names.get(water) ?? 0) + 1);
  e.recs.push({ y: yearOf(date), date, species: String(species).replace(/^YTD /, ''), ytd: /^YTD /.test(species), fish, src, live: src === liveSrc, annual: date.length === 4 });
  entries.set(id, e);
}

const out = [];
for (const e of entries.values()) {
  const years = [];
  for (const [y, recs] of group(e.recs, r => String(r.y))) {
    // Oregon: the annual report is the year's actual count; the schedule only fills years without a report.
    // Nevada: archived pages and the current site overlap 2019–2021; the larger of the two is kept, and a water's
    // year-to-date total counts when it is more than the stockings seen.
    const annual = recs.filter(r => r.annual), liveR = recs.filter(r => r.live && !r.ytd), arch = recs.filter(r => !r.live && !r.annual && !r.ytd), ytd = recs.filter(r => r.ytd);
    const fishOf = rs => rs.some(r => r.fish != null) ? rs.reduce((a, r) => a + (r.fish ?? 0), 0) : null;
    let use;
    if (annual.length) use = annual;
    else if (st === 'ca') use = [...arch, ...liveR]; // week records from both, already deduplicated by name and week below
    else use = (fishOf(liveR) ?? -1) >= (fishOf(arch) ?? -1) ? liveR.length ? liveR : arch : arch;
    // The same week's plant from an archived copy and from plants.json counts once.
    const seen = new Set();
    use = use.filter(r => { const k = `${r.date}|${r.species.toLowerCase()}|${r.fish ?? ''}`; return !seen.has(k) && seen.add(k); });
    const sp = {};
    for (const r of use) { const c = sp[r.species] ??= [null, 0]; if (r.fish != null) c[0] = (c[0] ?? 0) + r.fish; c[1]++; }
    let fish = fishOf(use);
    const ytdMax = new Map(); for (const r of ytd) ytdMax.set(r.species, Math.max(ytdMax.get(r.species) ?? 0, r.fish ?? 0));
    const ytdTotal = [...ytdMax.values()].reduce((a, b) => a + b, 0);
    if (ytdTotal > (fish ?? 0)) fish = ytdTotal;
    const src = [...new Set(use.map(r => r.src).concat(ytd.map(r => r.src)))];
    // Up to three sources per year, the agency's own pages before archived copies.
    const ranked = src.sort((a, b) => (sources[a].url.includes('web.archive.org') - sources[b].url.includes('web.archive.org')) || a - b).slice(0, 3);
    years.push({ y: +y, fish, plants: annual.length ? null : use.length, sp, src: ranked });
  }
  years.sort((a, b) => b.y - a.y);
  // The name as the agency writes it most often, in title case where a page shouted it ("RUBY LAKE NWR").
  const tc = n => n === n.toUpperCase() ? n.toLowerCase().replace(/(?<!')\b[a-z]/g, c => c.toUpperCase()).replace(/\b(Nwr|Wma|Ii|Iii)\b/g, w => w.toUpperCase()) : n;
  const name = tc([...e.names].sort((a, b) => (b[0] !== b[0].toUpperCase()) - (a[0] !== a[0].toUpperCase()) || b[1] - a[1])[0][0]);
  out.push({ name, key: e.key, ids: e.ids.length ? e.ids : undefined, nhd: e.nhd ?? undefined, county: e.county ?? undefined, lat: e.lat ?? undefined, lon: e.lon ?? undefined, ambiguous: e.ambiguous || undefined, years });
}
out.sort((a, b) => a.name.localeCompare(b.name));
// Only the sources the output points to, renumbered.
const used = [...new Set(out.flatMap(w => w.years.flatMap(y => y.src)))].sort((a, b) => a - b);
const renum = new Map(used.map((s, i) => [s, i]));
for (const w of out) for (const y of w.years) y.src = y.src.map(s => renum.get(s));

const NOTE = {
  or: 'ODFW annual hatchery reports (actual fish released, 2006 on) and the current stocking schedule. Each fish counted once in the year it was released.',
  nv: 'Archived NDOW stocking reports (2003–2021) and NDOW\'s current reports. The archive missed some weeks, so older years can be short.',
  ca: 'Archived CDFW plant schedules (2007 on) and the current schedule. CDFW lists the week and species of each trout plant, not the number of fish; salmon and steelhead releases are counted.',
}[st];
await writeJson('stock-history.json', { updatedAt: new Date().toISOString(), note: NOTE, sources: used.map(i => sources[i]), waters: out });
const placed = out.filter(w => w.ids || w.nhd).length;
const span = out.flatMap(w => w.years.map(y => y.y));
console.log(`stock-history: ${out.length} waters (${placed} matched to a stocked or mapped water, ${out.filter(w => w.ambiguous).length} ambiguous names), ${Math.min(...span)}–${Math.max(...span)}`);
const unmatched = out.filter(w => !w.ids && !w.nhd).sort((a, b) => b.years.length - a.years.length).slice(0, 40).map(w => `${w.name}${w.county ? ` (${w.county})` : ''}: ${w.years.length} yrs`);
console.log('Most-recorded unmatched names:\n  ' + unmatched.join('\n  '));
