// Refreshes the public California data the app reads from data/ca/.
// Runs nightly in GitHub Actions (see .github/workflows/update-data.yml) because these state sites
// don't allow browsers on other domains to fetch them directly. Only public data is involved.
//
//   data/ca/plants.json      CDFW fish planting schedule. The site only shows ~1 year back, so each
//                            run merges into the existing file and the history keeps growing.
//   data/ca/waters.json      CDFW stocked waters with a map point for each (joined by stock id).
//   data/ca/reservoirs.json  CDEC reservoir elevation/storage, last 30 days.
//
// Each section is independent: if a source is down, its file is left as it was.

import { readFile, writeFile, mkdir } from 'node:fs/promises';

const OUT = new URL('../data/ca/', import.meta.url);
const UA = { 'User-Agent': 'TackleBox-fishing-app (personal, github.com/mikegutberlet/FishingApp)' };

const readJson = async (name, fallback) => { try { return JSON.parse(await readFile(new URL(name, OUT), 'utf8')); } catch { return fallback; } };
const writeJson = (name, data) => writeFile(new URL(name, OUT), JSON.stringify(data, null, 0) + '\n');
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
const isoFromUs = s => { const [m, d, y] = s.split('/').map(Number); return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; };

async function get(url, init) {
  const r = await fetch(url, { ...init, headers: { ...UA, ...init?.headers } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r;
}

// ---------- CDFW planting schedule ----------
export function parsePlantTable(html) {
  const plants = [];
  for (const [, row] of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1]);
    if (cells.length < 4) continue;
    const week = text(cells[0]).match(/(\d{1,2}\/\d{1,2}\/\d{4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{4})/);
    if (!week) continue;
    const stockId = cells[1].match(/stockid=(\d+)/i)?.[1];
    plants.push({
      week: isoFromUs(week[1]), weekEnd: isoFromUs(week[2]),
      stockId: stockId ? +stockId : null,
      water: text(cells[1]).replace(/View Water Body in Map/i, '').trim(),
      counties: text(cells[2]), species: text(cells[3]),
    });
  }
  return plants;
}

async function updatePlants() {
  const html = await (await get('https://nrm.dfg.ca.gov/FishPlants/PublicPlantSearch')).text();
  const fresh = parsePlantTable(html);
  if (fresh.length < 20) throw new Error(`Only parsed ${fresh.length} plant rows; page layout may have changed`);
  const old = await readJson('plants.json', { plants: [] });
  // The fresh page is authoritative for its own date window (plants can be cancelled); keep older history.
  const windowStart = fresh.reduce((min, p) => p.week < min ? p.week : min, '9999');
  const key = p => `${p.week}|${p.stockId ?? p.water}|${p.species}`;
  const merged = new Map(old.plants.filter(p => p.week < windowStart).map(p => [key(p), p]));
  for (const p of fresh) merged.set(key(p), p);
  const plants = [...merged.values()].sort((a, b) => b.week.localeCompare(a.week) || a.water.localeCompare(b.water));
  await writeJson('plants.json', { updatedAt: new Date().toISOString(), source: 'https://nrm.dfg.ca.gov/FishPlants/', plants });
  console.log(`plants: ${fresh.length} on page, ${plants.length} total, back to ${plants.at(-1)?.week}`);
  return plants;
}

// ---------- CDFW stocked waters (polygons → one point each) ----------
// Point used for a water body: the polygon vertex nearest its bounding-box center, so it lands on water
// even for long, thin rivers where the box center can be on land.
function representativePoint(geometry) {
  const rings = geometry.type === 'Polygon' ? geometry.coordinates : geometry.coordinates.flat();
  const pts = rings.flat();
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of pts) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  let best = pts[0], bestD = Infinity;
  for (const p of pts) { const d = (p[0] - cx) ** 2 + (p[1] - cy) ** 2; if (d < bestD) { bestD = d; best = p; } }
  return { lat: +best[1].toFixed(5), lon: +best[0].toFixed(5) };
}

async function updateWaters(plants) {
  const base = 'https://services2.arcgis.com/Uq9r85Potqm3MfRV/arcgis/rest/services/biosds778_fpu/FeatureServer/0/query';
  const features = [];
  for (let offset = 0; ; offset += 1000) {
    const params = new URLSearchParams({ where: '1=1', outFields: 'StockingWaterID,DFGWATERID,Counties,last_yr_stkd', outSR: '4326',
      maxAllowableOffset: '0.0005', resultOffset: offset, resultRecordCount: 1000, f: 'geojson' });
    const page = await (await get(`${base}?${params}`)).json();
    features.push(...page.features);
    if (page.features.length < 1000 && !page.properties?.exceededTransferLimit) break;
  }
  const names = new Map();
  for (const p of plants) if (p.stockId && !names.has(p.stockId)) names.set(p.stockId, p.water); // plants are newest first
  const waters = features.filter(f => f.geometry).map(f => ({
    id: f.properties.StockingWaterID, name: names.get(f.properties.StockingWaterID) ?? null,
    counties: f.properties.Counties, lastYearStocked: f.properties.last_yr_stkd, ...representativePoint(f.geometry),
  }));
  const named = waters.filter(w => w.name).length;
  const unmatched = [...names.keys()].filter(id => !waters.some(w => w.id === id)).length;
  await writeJson('waters.json', { updatedAt: new Date().toISOString(), source: 'CDFW BIOS ds778 Recent Stocked Waters', waters });
  console.log(`waters: ${waters.length} polygons, ${named} named from the schedule, ${unmatched} schedule waters without a polygon`);
}

// ---------- CDEC reservoirs ----------
// Station list comes from CDEC's station search for active stations with daily reservoir elevation (sensor 6).
async function updateReservoirs() {
  const search = new URLSearchParams({ sensor_chk: 'on', sensor: '6', dur_chk: 'on', dur: 'D', active_chk: 'on', active: 'Y', display: 'sta' });
  const html = await (await get(`https://cdec.water.ca.gov/dynamicapp/staSearch?${search}`)).text();
  const stations = [];
  for (const [, row] of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => text(m[1]));
    const id = cells.find(c => /^[A-Z0-9]{3}$/.test(c));
    const nums = cells.map(Number);
    const lat = nums.find(n => n > 32 && n < 42.1), lon = nums.find(n => n < -114 && n > -124.5);
    if (id && lat && lon) stations.push({ id, name: cells[cells.indexOf(id) + 1], lat, lon });
  }
  if (stations.length < 20) throw new Error(`Only parsed ${stations.length} CDEC stations`);
  const end = new Date(), start = new Date(Date.now() - 30 * 864e5);
  const day = d => d.toISOString().slice(0, 10);
  const series = new Map();
  for (let i = 0; i < stations.length; i += 40) {
    const ids = stations.slice(i, i + 40).map(s => s.id).join(',');
    const url = `https://cdec.water.ca.gov/dynamicapp/req/JSONDataServlet?Stations=${ids}&SensorNums=6,15&dur_code=D&Start=${day(start)}&End=${day(end)}`;
    for (const r of await (await get(url)).json()) {
      if (r.value == null || r.value < -9000) continue;
      // CDEC's JSON names the sensor field inconsistently (SENSOR_NUM / sensorNum) and dates look like "2026-9-21 00:00".
      const sensor = Number(r.SENSOR_NUM ?? r.sensorNum ?? r.sensor_num);
      const isElevation = sensor === 6 || /ele|feet/i.test(`${r.sensorType} ${r.units}`);
      const [y, m, d] = String(r.date ?? r.obsDate).trim().split(/[ T]/)[0].split('-');
      const s = series.get(r.stationId) ?? { elevation: [], storage: [] };
      (isElevation ? s.elevation : s.storage).push([`${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`, r.value]);
      series.set(r.stationId, s);
    }
  }
  for (const s of series.values()) for (const k of ['elevation', 'storage']) s[k].sort((a, b) => a[0].localeCompare(b[0]));
  const reservoirs = stations.filter(s => series.has(s.id)).map(s => ({ ...s, ...series.get(s.id) }));
  await writeJson('reservoirs.json', { updatedAt: new Date().toISOString(), source: 'https://cdec.water.ca.gov', units: { elevation: 'ft', storage: 'acre-ft' }, reservoirs });
  console.log(`reservoirs: ${stations.length} stations listed, ${reservoirs.length} with recent data, ${reservoirs.filter(r => r.elevation.length).length} with elevation`);
}

await mkdir(OUT, { recursive: true });
let failed = 0;
let plants = (await readJson('plants.json', { plants: [] })).plants;
try { plants = await updatePlants(); } catch (e) { failed++; console.error('plants failed:', e.message); }
try { await updateWaters(plants); } catch (e) { failed++; console.error('waters failed:', e.message); }
try { await updateReservoirs(); } catch (e) { failed++; console.error('reservoirs failed:', e.message); }
if (failed === 3) process.exit(1);
