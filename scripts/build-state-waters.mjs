// Builds the statewide list of named lakes, reservoirs and rivers the map labels and lets you tap, for a state in
// scripts/states.mjs (same as build-ca-waters.mjs for California):  node scripts/build-state-waters.mjs nv
// Runs weekly in GitHub Actions; the sources change slowly.
//
//   data/<st>/lakes.json   every named lake/reservoir/pond >= ~2 acres from the USGS National Hydrography Dataset,
//                          with area, elevation and (where a survey exists) max/mean depth from LAGOS-US DEPTH
//   data/<st>/rivers.json  named rivers and long creeks, as label points spaced along each one
//   data/<st>/build-report.json  what each source returned, for debugging the job
//
// Only public data; nothing from anyone's phone is involved.

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { stateArg, inOutline, edgeDeg } from './states.mjs';

const STATE = stateArg();

const OUT = new URL(`../data/${STATE.st}/`, import.meta.url);
const UA = { 'User-Agent': 'TackleBox-fishing-app (personal, github.com/mikegutberlet/FishingApp)' };
// EDI's PASTA server refuses the plain app user agent, so those calls go out looking like a browser.
const BROWSER_UA = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', Accept: '*/*' };
const NHD = 'https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer';
const CA_BBOX = STATE.bbox;
const report = { startedAt: new Date().toISOString(), steps: {} };

const inCalifornia = pt => inOutline(pt, STATE.outline); // kept the California job's name to stay diffable with it
// A lake in the state, or a reservoir of 1,000 acres or more within about 2 km of a border river (borderReservoirs).
// The app's stateAt gives these the state too.
const lakeInState = (pt, acres) => inCalifornia(pt) || (!!STATE.borderReservoirs && acres >= 1000 && edgeDeg(pt, STATE.outline) < 0.02);

// NHD sometimes takes a query and never answers, which once held a run until the workflow was cancelled with nothing
// saved. So every request has a time limit (long enough for the big depth downloads), and once the job's time budget
// is spent no new NHD tile is started: that list fails and last week's file stays, leaving the workflow time to commit.
const DEADLINE = Date.now() + (+process.env.WATERS_MINUTES || 120) * 60e3;
const outOfTime = () => Date.now() > DEADLINE;
async function get(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, {
        headers: /lternet\.edu|edirepository\.org/.test(url) ? BROWSER_UA : UA,
        signal: AbortSignal.timeout(url.startsWith(NHD) ? 120e3 : 600e3),
      });
      if (!r.ok) throw new Error(`${r.status} ${url.slice(0, 200)}`);
      return r;
    } catch (e) {
      if (i >= tries) throw e;
      await new Promise(res => setTimeout(res, 2000 * i));
    }
  }
}
const getJson = async url => (await get(url)).json();

const round = n => +n.toFixed(5);
// NHD layers disagree on field-name case (GNIS_NAME vs gnis_name), so read properties case-insensitively.
const prop = (props, name) => { const k = Object.keys(props).find(k => k.toLowerCase() === name.toLowerCase()); return k === undefined ? undefined : props[k]; };
const distKm = (a, b) => {
  const toRad = d => d * Math.PI / 180;
  const h = Math.sin(toRad(b[1] - a[1]) / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(toRad(b[0] - a[0]) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};

// Point that sits on the water: polygon vertex closest to the ring's average point.
function lakePoint(geometry) {
  const ring = (geometry.type === 'Polygon' ? geometry.coordinates : geometry.coordinates.sort((a, b) => b[0].length - a[0].length)[0])[0];
  const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length, cy = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  // Prefer the true centroid when it falls inside the lake; otherwise snap to the closest shoreline vertex.
  if (pointInRing([cx, cy], ring)) return [cx, cy];
  return ring.reduce((best, p) => (p[0] - cx) ** 2 + (p[1] - cy) ** 2 < (best[0] - cx) ** 2 + (best[1] - cy) ** 2 ? p : best);
}
function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

async function layerIds() {
  const info = await getJson(`${NHD}/layers?f=json`);
  const layers = info.layers.map(l => ({ id: l.id, name: l.name }));
  report.steps.nhdLayers = layers;
  const find = re => layers.find(l => re.test(l.name))?.id;
  return {
    waterbody: find(/^Waterbody - Large Scale$/i) ?? 12,
    flowline: find(/^Flowline - Large Scale$/i) ?? 6,
    flowlineSmall: find(/^Flowline - Small Scale$/i) ?? 4,
  };
}

// Pages through an ArcGIS query, splitting the state into tiles so no single request is too heavy.
// The NHD server times out (502/504) on busy tiles, so a tile that keeps failing is split into quarters, down to
// about 2 miles across. A handful of tiles that still fail are skipped (listed in the report, and last week's waters
// in them are carried over) rather than losing the whole state; more than that throws, so the last good file stays.
const FAILED = [];
const inFailed = (layerId, lat, lon) => FAILED.some(t => t.layerId === layerId && lon >= t.x && lon <= t.x + t.size && lat >= t.y && lat <= t.y + t.size);
async function queryTiled(layerId, where, outFields, offset, tile = 1) {
  const features = [], failed = [];
  const queryTile = async (x, y, size) => {
    const envelope = JSON.stringify({ xmin: x, ymin: y, xmax: x + size, ymax: y + size, spatialReference: { wkid: 4326 } });
    const got = [];
    if (outOfTime()) throw new Error(`out of time (${report.steps.splitTiles ?? 0} tiles split, ${FAILED.length} skipped)`);
    // One line per tile in the log, so a slow night shows whether NHD answered slowly or the time limit cut it off.
    const t0 = Date.now(), tag = `tile ${layerId} ${round(x)},${round(y)} ${size}°`;
    try {
      for (let page = 0; ; page += 2000) {
        const params = new URLSearchParams({
          where, outFields, geometry: envelope, geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
          outSR: '4326', maxAllowableOffset: offset, geometryPrecision: '5', resultOffset: page, resultRecordCount: 2000, f: 'geojson',
        });
        const json = await getJson(`${NHD}/${layerId}/query?${params}`);
        if (json.error) throw new Error(JSON.stringify(json.error));
        got.push(...json.features);
        if (json.features.length < 2000) break;
      }
      console.log(`${tag}: ${got.length} features in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    } catch (e) {
      console.log(`${tag}: failed after ${((Date.now() - t0) / 1000).toFixed(1)} s (${(e.name === 'TimeoutError' ? 'time limit' : e.message).slice(0, 80)})`);
      if (outOfTime()) throw e;
      if (size <= 0.035) {
        failed.push({ layerId, x: round(x), y: round(y), size, error: e.message.slice(0, 80) });
        FAILED.push(failed.at(-1));
        report.steps.failedTiles = [...(report.steps.failedTiles ?? []), failed.at(-1)];
        if (failed.length > 6) throw e;
        return got;
      }
      report.steps.splitTiles = (report.steps.splitTiles ?? 0) + 1;
      const h = size / 2;
      for (const [dx, dy] of [[0, 0], [h, 0], [0, h], [h, h]]) got.push(...await queryTile(x + dx, y + dy, h));
    }
    return got;
  };
  for (let x = CA_BBOX.xmin; x < CA_BBOX.xmax; x += tile) {
    for (let y = CA_BBOX.ymin; y < CA_BBOX.ymax; y += tile) features.push(...await queryTile(x, y, tile));
  }
  return features;
}

async function buildLakes(ids) {
  // FTYPE 390 = Lake/Pond, 436 = Reservoir. AREASQKM 0.008 ≈ 2 acres.
  const feats = await queryTiled(ids.waterbody, "GNIS_NAME IS NOT NULL AND FTYPE IN (390,436) AND AREASQKM >= 0.008",
    'PERMANENT_IDENTIFIER,GNIS_ID,GNIS_NAME,AREASQKM,ELEVATION,FTYPE', '0.0005');
  report.steps.lakes = { features: feats.length };
  // One polygon per PERMANENT_IDENTIFIER (tiles overlap), then one lake per GNIS id (big lakes are split into arms).
  const polys = new Map();
  for (const f of feats) {
    if (!f.geometry) continue;
    const p = f.properties;
    const pid = prop(p, 'PERMANENT_IDENTIFIER');
    if (polys.has(pid)) continue;
    const pt = lakePoint(f.geometry);
    if (!lakeInState(pt, prop(p, 'AREASQKM') * 247.105)) continue;
    polys.set(pid, { pid, gnis: prop(p, 'GNIS_ID') || null, name: prop(p, 'GNIS_NAME'), ftype: prop(p, 'FTYPE'),
      acres: prop(p, 'AREASQKM') * 247.105, elev: prop(p, 'ELEVATION'), lat: round(pt[1]), lon: round(pt[0]) });
  }
  const byLake = new Map();
  for (const poly of polys.values()) {
    const key = poly.gnis ?? `p${poly.pid}`;
    const lake = byLake.get(key);
    if (!lake) byLake.set(key, { ...poly, parts: 1 });
    else {
      // Keep the largest part's point; add the rest of the area only when the parts are close together (same water).
      const near = Math.abs(lake.lat - poly.lat) < 0.3 && Math.abs(lake.lon - poly.lon) < 0.3;
      if (!near) { byLake.set(`${key}-${poly.pid}`, { ...poly, parts: 1 }); continue; }
      if (poly.acres > lake.acres) Object.assign(lake, { pid: poly.pid, lat: poly.lat, lon: poly.lon, elev: poly.elev, ftype: poly.ftype, acres: lake.acres + poly.acres, parts: lake.parts + 1 });
      else { lake.acres += poly.acres; lake.parts++; }
    }
  }
  const lakes = [...byLake.values()].map(l => ({
    id: l.gnis ?? `p${l.pid}`, gnis: l.gnis, name: l.name, type: l.ftype === 436 ? 'Reservoir' : 'Lake',
    acres: Math.round(l.acres), elevationFt: null, nhdElev: l.elev, lat: l.lat, lon: l.lon,
  })).sort((a, b) => b.acres - a.acres);
  await attachElevations(lakes);
  for (const l of lakes) delete l.nhdElev;
  report.steps.lakes.polygons = polys.size;
  report.steps.lakes.inState = lakes.length;
  return lakes;
}

// NHD's ELEVATION field mixes feet and meters with no flag, so check each against a terrain model
// (Open-Meteo's elevation API, 100 points per call) and keep whichever reading agrees with it.
async function attachElevations(lakes) {
  let fromDem = 0, kept = 0;
  const todo = lakes.filter(l => l.elevationFt == null);
  for (let pass = 0; pass < 2; pass++) {
    const pending = todo.filter(l => l.elevationFt == null);
    for (let i = 0; i < pending.length; i += 100) {
      const batch = pending.slice(i, i + 100);
      let dem = [];
      try {
        const url = `https://api.open-meteo.com/v1/elevation?latitude=${batch.map(l => l.lat).join(',')}&longitude=${batch.map(l => l.lon).join(',')}`;
        dem = (await (await get(url, 5)).json()).elevation ?? [];
      } catch (e) { report.steps.elevationError = e.message; }
      batch.forEach((l, j) => {
        const demFt = Number.isFinite(dem[j]) ? dem[j] * 3.28084 : null;
        const asM = l.nhdElev > 0 ? l.nhdElev * 3.28084 : null, asFt = l.nhdElev > 0 ? l.nhdElev : null;
        const close = v => v != null && demFt != null && Math.abs(v - demFt) <= Math.max(60, demFt * 0.08);
        if (close(asM)) { l.elevationFt = Math.round(asM); kept++; }
        else if (close(asFt)) { l.elevationFt = Math.round(asFt); kept++; }
        else if (demFt != null) { l.elevationFt = Math.round(demFt); fromDem++; }
      });
      await new Promise(res => setTimeout(res, 400));
    }
  }
  report.steps.elevations = { nhdKept: kept, fromDem, missing: lakes.filter(l => l.elevationFt == null).length };
}

// Rivers: merge every named flowline segment by GNIS id, then place label points every ~15 km along it.
// A state with dense streams (Oregon) reads the small-scale flowlines: the large-scale query times out on its
// tiles, and the small-scale layer still has every river and long creek a label needs.
const riverLayer = ids => STATE.riverScale === 'small' ? ids.flowlineSmall : ids.flowline ?? ids.flowlineSmall;
async function buildRivers(ids) {
  const layer = riverLayer(ids);
  const feats = await queryTiled(layer, "GNIS_NAME IS NOT NULL AND (GNIS_NAME LIKE '% River%' OR GNIS_NAME LIKE '% Creek%' OR GNIS_NAME LIKE '% Fork%' OR GNIS_NAME LIKE '% Slough%')",
    'GNIS_ID,GNIS_NAME,LENGTHKM', '0.002', 0.5);
  report.steps.rivers = { layer, segments: feats.length };
  const groups = new Map();
  for (const f of feats) {
    if (!f.geometry) continue;
    const name = prop(f.properties, 'GNIS_NAME'), gnis = prop(f.properties, 'GNIS_ID') || null, lengthKm = prop(f.properties, 'LENGTHKM');
    if (!name) continue;
    const key = gnis || name;
    const g = groups.get(key) ?? { name, gnis, km: 0, segs: new Map() };
    const lines = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;
    const segKey = JSON.stringify(lines[0][0]);
    if (g.segs.has(segKey)) continue; // duplicate from overlapping tiles
    g.segs.set(segKey, lines);
    g.km += lengthKm ?? 0;
    groups.set(key, g);
  }
  const rivers = [];
  for (const g of groups.values()) {
    const isRiver = / River\b/.test(g.name);
    if (!isRiver && g.km < 15) continue; // keep every river, and creeks/forks/sloughs 15 km or longer
    // Label points: walk all vertices, dropping one each time ~15 km of distance has accumulated.
    const points = [];
    let acc = 7.5, inside = 0;
    for (const lines of g.segs.values()) for (const line of lines) {
      for (let i = 1; i < line.length; i++) {
        const d = distKm(line[i - 1], line[i]), inState = inCalifornia(line[i]);
        acc += d;
        if (inState) inside += d;
        if (acc >= 15 && inState) { points.push([round(line[i][1]), round(line[i][0])]); acc = 0; }
      }
    }
    // A river of the next state that only reaches the line (the Klickitat and White Salmon at the Columbia, Idaho's
    // Salmon at the Snake) gets no label here: its taps would show this state's rules.
    if (inside < Math.min(3, g.km / 4)) continue;
    if (!points.length) {
      const mid = [...g.segs.values()][0][0];
      const p = mid[Math.floor(mid.length / 2)];
      if (!inCalifornia(p)) continue;
      points.push([round(p[1]), round(p[0])]);
    }
    rivers.push({ id: g.gnis || g.name, gnis: g.gnis, name: g.name, type: isRiver ? 'River' : /Slough/.test(g.name) ? 'Slough' : 'Creek', km: Math.round(g.km), points });
  }
  rivers.sort((a, b) => b.km - a.km);
  report.steps.rivers.named = groups.size;
  report.steps.rivers.kept = rivers.length;
  if (STATE.riverLakes) await tagLakes(rivers, ids);
  return rivers;
}
// A label in a lake (the Snake through Brownlee, the Owyhee through Lake Owyhee) keeps the lake's name as a third
// value, so the app gives it the lake's advisories. The named lakes and reservoirs of 50 acres or more are read with
// their outlines (the small-scale layers have few lake names) and each label is tested against them. If that query
// fails, the labels are only their rivers'.
async function tagLakes(rivers, ids) {
  let feats;
  try {
    feats = await queryTiled(ids.waterbody, "GNIS_NAME IS NOT NULL AND FTYPE IN (390,436) AND AREASQKM >= 0.2", 'GNIS_NAME', '0.0005');
  } catch (e) { report.steps.rivers.inLakesError = e.message.slice(0, 200); return; }
  const polys = [];
  for (const f of feats) {
    if (!f.geometry || !prop(f.properties, 'GNIS_NAME')) continue;
    const parts = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const [outer] of parts) {
      const xs = outer.map(p => p[0]), ys = outer.map(p => p[1]);
      polys.push({ name: prop(f.properties, 'GNIS_NAME'), ring: outer, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
    }
  }
  let tagged = 0;
  for (const r of rivers) r.points = r.points.map(([lat, lon]) => {
    const lake = polys.find(({ box: [x0, y0, x1, y1], ring }) => lon >= x0 && lon <= x1 && lat >= y0 && lat <= y1 && pointInRing([lon, lat], ring));
    if (lake) tagged++;
    return lake ? [lat, lon, lake.name] : [lat, lon];
  });
  report.steps.rivers.inLakes = { lakes: new Set(polys.map(p => p.name)).size, labels: tagged };
}

// LAGOS-US DEPTH (Stachelek et al.): observed max/mean depth for ~17,000 US lakes, published on EDI.
async function depthTable() {
  // LAGOS-US DEPTH v1.0 is EDI package edi.1043; the search below is the fallback if that id ever changes.
  let ids = ['edi.1043.1'];
  try {
    const rev = (await (await get('https://pasta.lternet.edu/package/eml/edi/1043?filter=newest')).text()).trim();
    if (/^\d+$/.test(rev)) ids = [`edi.1043.${rev}`];
  } catch (e) { report.steps.depthProbe = e.message; }
  try { return await depthFromPackage(ids[0]); } catch (e) { report.steps.depthPackageError = e.message; }
  const search = await getJson('https://pasta.lternet.edu/package/search/eml?defType=edismax&q=title:%22LAGOS-US%20DEPTH%22&fl=packageid,title,pubdate&rows=20&wt=json')
    .catch(async () => {
      // PASTA returns XML by default; fall back to parsing it.
      const xml = await (await get('https://pasta.lternet.edu/package/search/eml?defType=edismax&q=title:%22LAGOS-US%20DEPTH%22&fl=packageid,title,pubdate&rows=20')).text();
      return { xml };
    });
  const text = JSON.stringify(search);
  ids = [...new Set([...text.matchAll(/edi\.\d+\.\d+/g)].map(m => m[0]))].filter(id => id !== 'edi.1043.1');
  if (!ids.length) throw new Error('LAGOS-US DEPTH package not found');
  return await depthFromPackage(ids.sort((a, b) => +b.split('.')[2] - +a.split('.')[2])[0]);
}

// Wikidata records a maximum depth for a few hundred lakes in each state (from Wikipedia infoboxes).
// Used for lakes LAGOS doesn't cover, or for all of them when EDI is unreachable.
async function wikidataDepths() {
  const query = `SELECT ?item ?itemLabel ?loc ?depth ?unit WHERE {
  SERVICE wikibase:box { ?item wdt:P625 ?loc . bd:serviceParam wikibase:cornerSouthWest "Point(${CA_BBOX.xmin} ${CA_BBOX.ymin})"^^geo:wktLiteral . bd:serviceParam wikibase:cornerNorthEast "Point(${CA_BBOX.xmax} ${CA_BBOX.ymax})"^^geo:wktLiteral . }
  ?item p:P4511 ?st . ?st psv:P4511 ?v . ?v wikibase:quantityAmount ?depth ; wikibase:quantityUnit ?unit .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`;
  const r = await fetch(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(query)}`, { headers: { ...UA, Accept: 'application/sparql-results+json' } });
  if (!r.ok) throw new Error(`${r.status} wikidata`);
  const rows = [];
  for (const b of (await r.json()).results.bindings) {
    const m = b.loc.value.match(/Point\(([-\d.]+) ([-\d.]+)\)/);
    if (!m) continue;
    const unit = b.unit.value.split('/').pop();
    const toFt = unit === 'Q11573' ? 3.28084 : unit === 'Q3710' ? 1 : unit === 'Q174728' ? 0.0328084 : null; // metre, foot, centimetre
    if (!toFt) continue;
    const maxFt = Math.round(+b.depth.value * toFt);
    if (!(maxFt > 0) || maxFt > 2000) continue;
    rows.push({ lat: +m[2], lon: +m[1], maxFt, meanFt: null, name: b.itemLabel?.value ?? '' });
  }
  report.steps.wikidata = { rows: rows.length, sample: rows.slice(0, 5) };
  return rows;
}

async function depthFromPackage(packageId) {
  const [scope, id, rev] = packageId.split('.');
  report.steps.depth = { package: packageId };
  try { return await depthFromPasta(scope, id, rev); } catch (e) { report.steps.depth.pastaError = e.message; }
  // Fallback: the EDI portal serves the same package; entity ids come from its EML.
  const eml = await (await get(`https://portal.edirepository.org/nis/metadataviewer?packageid=${packageId}&contentType=application/xml`)).text();
  const urls = [...eml.matchAll(/<url[^>]*>\s*(https?:[^<\s]+)\s*<\/url>/g)].map(m => m[1]);
  report.steps.depth.portalUrls = urls.slice(0, 10);
  if (!urls.length) report.steps.depth.portalResponse = eml.replace(/\s+/g, ' ').slice(0, 300);
  for (const u of urls) {
    const ent = u.match(/\/data\/eml\/edi\/\d+\/\d+\/([0-9a-f]{32})/)?.[1];
    if (!ent) continue;
    const csv = await (await get(`https://portal.edirepository.org/nis/dataviewer?packageid=${packageId}&entityid=${ent}`)).text();
    const rows = parseDepthCsv(csv);
    if (rows) return rows;
  }
  throw new Error('No depth table found via portal');
}

async function depthFromPasta(scope, id, rev) {
  const entities = (await (await get(`https://pasta.lternet.edu/package/data/eml/${scope}/${id}/${rev}`)).text()).trim().split('\n');
  report.steps.depth.entities = [];
  for (const ent of entities) {
    const name = (await (await get(`https://pasta.lternet.edu/package/name/eml/${scope}/${id}/${rev}/${ent}`)).text()).trim();
    report.steps.depth.entities.push(name);
    if (!/depth/i.test(name) || /readme|meta|source/i.test(name)) continue;
    const csv = await (await get(`https://pasta.lternet.edu/package/data/eml/${scope}/${id}/${rev}/${ent}`)).text();
    const rows = parseDepthCsv(csv);
    if (rows) return rows;
  }
  throw new Error('No depth table in package');
}

// Returns the state's rows of a LAGOS depth CSV, or null if this isn't the depth table.
function parseDepthCsv(csv) {
  {
    const lines = csv.replace(/\r/g, '').split('\n').filter(Boolean);
    const header = splitCsv(lines[0]).map(h => h.toLowerCase());
    report.steps.depth.header = header;
    const col = (...names) => header.findIndex(h => names.some(n => h === n));
    const iLat = col('lake_lat_decdeg', 'lat', 'latitude'), iLon = col('lake_lon_decdeg', 'lon', 'longitude');
    const iMax = col('lake_maxdepth_m', 'maxdepth_m', 'max_depth_m'), iMean = col('lake_meandepth_m', 'meandepth_m', 'mean_depth_m');
    const iName = col('lake_namegnis', 'lake_namelagos', 'lake_name', 'name'), iState = col('lake_states', 'state', 'lake_state');
    if (iLat < 0 || iMax < 0) return null;
    const rows = [];
    for (const line of lines.slice(1)) {
      const c = splitCsv(line);
      const lat = +c[iLat], lon = +c[iLon], max = +c[iMax];
      if (!Number.isFinite(lat) || !Number.isFinite(max)) continue;
      if (iState >= 0 && c[iState] && !new RegExp(STATE.code).test(c[iState])) continue;
      if (iState < 0 && !inCalifornia([lon, lat])) continue;
      rows.push({ lat, lon, maxFt: Math.round(max * 3.28084), meanFt: iMean >= 0 && c[iMean] ? Math.round(+c[iMean] * 3.28084) : null, name: iName >= 0 ? c[iName] : '' });
    }
    report.steps.depth.stateRows = rows.length;
    return rows;
  }
}
function splitCsv(line) {
  const out = []; let cur = '', q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === ',' && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

// HydroLAKES estimates (monthly job) give a rough average depth to sanity-check crowd-sourced maxima against.
let HYDRO = [];
try { HYDRO = JSON.parse(await readFile(new URL('hydrolakes.json', OUT), 'utf8')).lakes; } catch {}
const plausibleMax = (lake, maxFt) => {
  const h = HYDRO.filter(x => Math.abs(x.lat - lake.lat) < 0.1 && Math.abs(x.lon - lake.lon) < 0.12 && x.acres / Math.max(lake.acres, 1) > 0.4 && x.acres / Math.max(lake.acres, 1) < 2.5)
    .sort((a, b) => distKm([a.lon, a.lat], [lake.lon, lake.lat]) - distKm([b.lon, b.lat], [lake.lon, lake.lat]))[0];
  return !h || (maxFt >= h.meanDepthFt * 0.8 && maxFt <= h.meanDepthFt * 8);
};

function attachDepths(lakes, depths, source) {
  let matched = 0; const unmatched = [];
  for (const d of depths) {
    let best = null, bestD = Infinity;
    for (const l of lakes) {
      if (Math.abs(l.lat - d.lat) > 0.25 || Math.abs(l.lon - d.lon) > 0.3) continue;
      const km = distKm([l.lon, l.lat], [d.lon, d.lat]);
      const sameName = d.name && l.name.toLowerCase() === d.name.toLowerCase();
      const score = sameName ? km / 3 : km;
      if (score < bestD) { bestD = score; best = l; }
    }
    // Big lakes' survey points can be far from our label point, so allow more distance for bigger lakes.
    if (best && !best.maxDepthFt && bestD <= Math.max(1, Math.sqrt(best.acres / 247) * 1.5) && (source !== 'Wikidata' || plausibleMax(best, d.maxFt))) {
      best.maxDepthFt = d.maxFt; if (d.meanFt) best.meanDepthFt = d.meanFt; best.depthSource = source; matched++;
    } else unmatched.push(`${d.name} ${d.lat},${d.lon} ${d.maxFt}ft${best ? ` nearest ${best.name} ${bestD.toFixed(1)}km` : ''}`);
  }
  report.steps.depth = { ...report.steps.depth, [`matched${source}`]: matched, [`unmatched${source}`]: unmatched.slice(0, 60) };
}

await mkdir(OUT, { recursive: true });
const save = (name, data) => writeFile(new URL(name, OUT), JSON.stringify(data) + '\n');
// The service's usual layer ids, for when its layer list doesn't answer.
let ids = { waterbody: 12, flowline: 6, flowlineSmall: 4 };
try { ids = await layerIds(); } catch (e) { report.steps.nhdLayersError = e.message; }

// A lake list from the last few days is kept as is, so a code push that re-runs the job only spends its time on the
// rivers (the lake build takes over an hour for Oregon). The weekly run always rebuilds.
// A reused list is still trimmed to the state's outline, in case the outline changed.
let lakes = null;
const readOldFile = name => readFile(new URL(name, OUT), 'utf8').then(JSON.parse).catch(() => null);
const recent = await readOldFile('lakes.json');
if (recent?.lakes?.length && Date.now() - Date.parse(recent.updatedAt) < 3 * 86400e3 && process.env.GITHUB_EVENT_NAME === 'push') {
  const kept = recent.lakes.filter(l => lakeInState([l.lon, l.lat], l.acres));
  report.steps.lakes = { reused: recent.updatedAt, inState: kept.length, outsideOutline: recent.lakes.length - kept.length };
  if (kept.length < recent.lakes.length) await save('lakes.json', { ...recent, lakes: kept });
} else try { lakes = await buildLakes(ids); } catch (e) { report.steps.lakesError = e.message; console.error('lakes:', e.message); }
// Last week's waters inside tiles that failed tonight, so a busy server doesn't drop them for a week.
function carryOver(list, old, layerId, points) {
  if (!old || !FAILED.some(t => t.layerId === layerId)) return 0;
  const have = new Set(list.map(x => String(x.id)));
  const back = old.filter(x => !have.has(String(x.id)) && points(x).some(([lat, lon]) => inFailed(layerId, lat, lon)));
  list.push(...back);
  return back.length;
}
if (lakes) {
  report.steps.lakes.carriedOver = carryOver(lakes, recent?.lakes, ids.waterbody, l => [[l.lat, l.lon]]);
  try { attachDepths(lakes, await depthTable(), 'LAGOS'); } catch (e) { report.steps.depthError = e.message; console.error('depth:', e.message); }
  try { attachDepths(lakes, await wikidataDepths(), 'Wikidata'); } catch (e) { report.steps.wikidataError = e.message; console.error('wikidata:', e.message); }
  report.steps.depth = { ...report.steps.depth, lakesWithDepth: lakes.filter(l => l.maxDepthFt).length };
  await save('lakes.json', { updatedAt: new Date().toISOString(), source: 'USGS National Hydrography Dataset; depths from LAGOS-US DEPTH and Wikidata', lakes });
}
try {
  const rivers = await buildRivers(ids);
  report.steps.rivers.carriedOver = carryOver(rivers, (await readOldFile('rivers.json'))?.rivers, riverLayer(ids), r => r.points);
  await save('rivers.json', { updatedAt: new Date().toISOString(), source: 'USGS National Hydrography Dataset', rivers });
} catch (e) { report.steps.riversError = e.message; console.error('rivers:', e.message); }

// Skipped tiles or a failed list show as a failed step (the workflow carries on and commits what it has).
if (FAILED.length || report.steps.lakesError || report.steps.riversError) process.exitCode = 1;
report.finishedAt = new Date().toISOString();
await writeFile(new URL('build-report.json', OUT), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2).slice(0, 4000));
