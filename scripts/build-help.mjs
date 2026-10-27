// Who to call from the water, for the SOS card: hospitals with an emergency room, county sheriff offices and
// ranger stations in California, Nevada and Oregon. Runs weekly (see .github/workflows/build-help.yml).
//
//   data/<st>/help.json {
//     er:       [{ name, lat, lon, phone, address, city, county, critical }]   CMS Hospital General Information,
//                 hospitals that report emergency services, placed with the Census geocoder (OpenStreetMap's
//                 hospital of the same name when the address doesn't match)
//     sheriffs: [{ county, name, phone, website, lat, lon, main }]   OpenStreetMap sheriff offices and substations, and
//                 each county's office from its state sheriffs' association (California State Sheriffs' Association
//                 directory, Oregon State Sheriffs' Association county pages), which fills in the phone OSM rarely has
//     rangers:  [{ name, operator, phone, website, hours, lat, lon }]   OpenStreetMap ranger stations
//   }
//
// A source that fails keeps the previous file's list for that part, so the card never loses its numbers to an outage.

import { readFile, writeFile, mkdir } from 'node:fs/promises';

const STATES = ['CA', 'NV', 'OR'];
const UA = { 'User-Agent': 'TackleBox-fishing-app (personal, github.com/mikegutberlet/FishingApp)' };
const MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
const CMS = 'https://data.cms.gov/provider-data/api/1/datastore/query/xubh-q36u/0';
const CENSUS = 'https://geocoding.geo.census.gov/geocoder/locations/addressbatch';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dirOf = st => new URL(`../data/${st.toLowerCase()}/`, import.meta.url);

async function getJson(url, opts = {}, tries = 3) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { ...opts, headers: { ...UA, ...opts.headers }, signal: AbortSignal.timeout(opts.timeout ?? 120000) });
      if (!r.ok) throw new Error(`${r.status} ${url.slice(0, 120)}`);
      return await r.json();
    } catch (e) { last = e; console.error(`attempt ${i}: ${e.message}`); await sleep(5000 * i); }
  }
  throw last;
}

// ---------- Counties (the files the state jobs already write) ----------
function inRing([x, y], ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}
const counties = {};
for (const st of STATES) counties[st] = JSON.parse(await readFile(new URL('counties.json', dirOf(st)), 'utf8')).counties;
const countyAt = (st, lat, lon) => counties[st].find(k => lon >= k.bbox[0] && lon <= k.bbox[2] && lat >= k.bbox[1] && lat <= k.bbox[3]
  && k.polys.some(([outer]) => inRing([lon, lat], outer)))?.name ?? null;
const stateOf = (lat, lon) => STATES.find(st => countyAt(st, lat, lon));

// ---------- Phone numbers: "(760) 932-7549", whatever way they were typed ----------
export function phone(s) {
  const first = String(s ?? '').split(/[;,]|\s+or\s+/)[0];
  const d = first.replace(/ext.*$/i, '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : null;
}
const title = s => String(s ?? '').toLowerCase().replace(/\b([a-z])/g, c => c.toUpperCase()).replace(/\b(Of|And|The|At|For)\b/g, w => w.toLowerCase()).replace(/^./, c => c.toUpperCase());
const normName = s => String(s ?? '').toLowerCase().replace(/&/g, 'and').replace(/\b(the|inc|llc|hospital|medical|center|centre|regional|memorial|health|healthcare|campus|of|and)\b|[^a-z0-9]/g, '');
const r5 = v => +(+v).toFixed(5);

// ---------- OpenStreetMap: sheriff offices, ranger stations, and hospitals (to place a hospital the geocoder misses) ----------
const QUERY = `[out:json][timeout:600];
(area["ISO3166-2"="US-CA"];area["ISO3166-2"="US-NV"];area["ISO3166-2"="US-OR"];)->.st;
(nwr["amenity"="police"]["name"~"sheriff",i](area.st);nwr["amenity"="police"]["operator"~"sheriff",i](area.st);
 nwr["amenity"="ranger_station"](area.st);
 nwr["amenity"="hospital"](area.st););
out center tags;`;

async function overpass() {
  let last;
  for (const url of MIRRORS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const r = await fetch(url, { method: 'POST', headers: UA, body: new URLSearchParams({ data: QUERY }), signal: AbortSignal.timeout(700000) });
        if (!r.ok) throw new Error(`${r.status} ${url}`);
        const j = await r.json();
        if (j.remark && !j.elements?.length) throw new Error(`${url}: ${j.remark}`);
        return j.elements;
      } catch (e) { last = e; console.error(`overpass attempt ${attempt} failed: ${e.message}`); await sleep(30000); }
    }
  }
  throw last;
}

// "Mono County Sheriff's Office", "Sheriff - Bridgeport Substation": the county is the one it sits in, unless the
// name says another (a county's office just across its line).
function sheriffOf(st, t, lat, lon) {
  const name = (t.name ?? t.operator ?? '').trim();
  const named = (t.operator ?? t.name ?? '').match(/^(.+?)\s+County\s+Sheriff/i)?.[1];
  const inside = countyAt(st, lat, lon);
  const county = named && counties[st].some(k => k.name.toLowerCase() === named.toLowerCase()) ? counties[st].find(k => k.name.toLowerCase() === named.toLowerCase()).name : inside;
  if (!county) return null;
  // The county's main office: its name is the office itself, not a substation, jail, patrol post or court.
  const main = /^[\w .'-]+ county sheriff'?s?'? (office|department)$/i.test(name) && !/sub|station|jail|detention|correction|court|annex|patrol|boating|coroner/i.test(name);
  return { county, name: name || `${county} County Sheriff`, phone: phone(t.phone ?? t['contact:phone']), website: t.website ?? t['contact:website'] ?? null, lat: r5(lat), lon: r5(lon), main };
}

// ---------- The sheriffs' associations' directories: { county: { phone, address } } ----------
const DEBUG = process.env.HELP_DEBUG === 'true';
const ENT = { amp: '&', nbsp: ' ', quot: '"', apos: "'", lt: '<', gt: '>', '#8217': "'", '#039': "'", '#8211': '-' };
const htmlText = html => html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|h\d|li|tr|td|span|a)>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&(#?\w+);/g, (m, e) => ENT[e] ?? (e[0] === '#' ? String.fromCharCode(+e.slice(1)) : m)).split(/\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
const PHONE_RE = /\(?\b\d{3}\)?[\s./-]*\d{3}[\s./-]+\d{4}\b/;
async function getText(url) {
  const r = await fetch(url, { headers: { ...UA, Accept: 'text/html' }, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}

// California: one page, each sheriff as name, "Sheriff", address line(s), phone, fax. The entries don't name their
// county, so the office's street address is placed with the Census geocoder and the county read from the map.
async function caDirectory() {
  const lines = htmlText(await getText('https://www.calsheriffs.org/sheriffs-directory/'));
  if (DEBUG) console.log('CA directory sample:', JSON.stringify(lines.slice(0, 120)));
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== 'Sheriff') continue;
    const addr = [];
    let ph = null;
    for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
      if (PHONE_RE.test(lines[j])) { if (!/fax/i.test(lines[j])) ph = phone(lines[j].match(PHONE_RE)[0]); break; }
      addr.push(lines[j]);
    }
    // A street address beats a P.O. box; "550 N Flower Santa Ana, CA 92703".
    const street = addr.filter(a => /,\s*CA\s+\d{5}/.test(a)).sort((x, y) => /^p\.?\s*o\.?\s*box/i.test(x) - /^p\.?\s*o\.?\s*box/i.test(y))[0];
    if (ph && street) entries.push({ facility_id: String(entries.length), address: street.replace(/,\s*CA\s+\d{5}(-\d{4})?\s*$/, ''), citytown: '', state: 'CA', zip_code: street.match(/(\d{5})(-\d{4})?\s*$/)?.[1] ?? '', phone: ph });
  }
  const placed = await geocode(entries);
  const out = {};
  for (const e of entries) {
    const at = placed.get(e.facility_id) ?? await geocodeOne(e);
    const county = at && countyAt('CA', at.lat, at.lon);
    if (county && !out[county]) out[county] = { phone: e.phone };
    else if (!county) console.error(`CA directory: couldn't place ${e.address} ${e.zip_code}`);
  }
  console.log(`CA directory: ${entries.length} sheriffs listed`);
  return out;
}

// Oregon: a page per county.
async function orDirectory() {
  const out = {};
  for (const k of counties.OR) {
    const slug = k.name.toLowerCase().replace(/\s+/g, '-');
    try {
      const lines = htmlText(await getText(`https://oregonsheriffs.org/sheriff/${slug}/`));
      if (DEBUG && k.name === 'Klamath') console.log('OR page sample:', JSON.stringify(lines.slice(0, 150)));
      // The association's own Salem number is on every page.
      const p = lines.map(l => l.match(PHONE_RE)?.[0]).filter(Boolean).map(phone).find(x => x && x !== '(503) 364-4204');
      if (p) out[k.name] = { phone: p };
    } catch (e) { console.error(`OR ${k.name}: ${e.message}`); }
    await sleep(500);
  }
  return out;
}

// ---------- CMS hospitals that report emergency services ----------
async function cmsHospitals(st) {
  const out = [];
  for (let offset = 0; ; offset += 500) {
    const q = new URLSearchParams({ limit: 500, offset, 'conditions[0][property]': 'state', 'conditions[0][value]': st, 'conditions[0][operator]': '=' });
    const j = await getJson(`${CMS}?${q}`);
    out.push(...j.results);
    if (j.results.length < 500) break;
  }
  return out.filter(h => /^y/i.test(h.emergency_services ?? ''));
}

// The Census batch geocoder takes a CSV of addresses and answers with a CSV of matches.
const csvCell = s => `"${String(s ?? '').replace(/"/g, '""')}"`;
function parseCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}
async function geocode(rows) {
  const found = new Map();
  for (let i = 0; i < rows.length; i += 1000) {
    const csv = rows.slice(i, i + 1000).map(h => [h.facility_id, h.address, h.citytown, h.state, h.zip_code].map(csvCell).join(',')).join('\n');
    const form = new FormData();
    form.append('addressFile', new Blob([csv], { type: 'text/csv' }), 'hospitals.csv');
    form.append('benchmark', 'Public_AR_Current');
    let text = null;
    for (let attempt = 1; attempt <= 3 && text == null; attempt++) {
      try {
        const r = await fetch(CENSUS, { method: 'POST', body: form, headers: UA, signal: AbortSignal.timeout(300000) });
        if (!r.ok) throw new Error(`census ${r.status}`);
        text = await r.text();
      } catch (e) { console.error(`geocoder attempt ${attempt}: ${e.message}`); await sleep(15000 * attempt); }
    }
    if (DEBUG) console.log('geocoder answer sample:', JSON.stringify((text ?? '').slice(0, 400)));
    for (const line of (text ?? '').split(/\r?\n/)) {
      const c = parseCsvLine(line);
      if (c[2] !== 'Match' || !c[5]) continue;
      const [lon, lat] = c[5].split(',').map(Number);
      if (Number.isFinite(lat) && Number.isFinite(lon)) found.set(c[0], { lat, lon });
    }
  }
  return found;
}
// One address at a time, for what the batch missed.
async function geocodeOne(h) {
  const q = new URLSearchParams({ address: [h.address, h.citytown, `${h.state} ${h.zip_code}`].filter(x => x.trim()).join(', '), benchmark: 'Public_AR_Current', format: 'json' });
  try {
    const j = await getJson(`https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?${q}`, { timeout: 30000 }, 2);
    const c = j.result?.addressMatches?.[0]?.coordinates;
    return c ? { lat: c.y, lon: c.x } : null;
  } catch { return null; }
}

// ---------- Build ----------
const now = new Date().toISOString();
const old = {};
for (const st of STATES) { try { old[st] = JSON.parse(await readFile(new URL('help.json', dirOf(st)), 'utf8')); } catch { old[st] = {}; } }
const out = Object.fromEntries(STATES.map(st => [st, { updatedAt: now, sources: {}, er: null, sheriffs: null, rangers: null }]));

let osm = null;
try { osm = await overpass(); } catch (e) { console.error(`OpenStreetMap failed, keeping last week's sheriffs and ranger stations: ${e.message}`); }
const osmHospitals = [];
if (osm) {
  const seen = new Set();
  for (const st of STATES) { out[st].sheriffs = []; out[st].rangers = []; }
  for (const el of osm) {
    const t = el.tags ?? {}, lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
    if (lat == null) continue;
    const st = stateOf(lat, lon);
    if (!st) continue;
    if (t.amenity === 'hospital') { osmHospitals.push({ st, name: t.name ?? '', lat, lon, city: t['addr:city'] ?? '' }); continue; }
    if (/^(private|no)$/.test(t.access ?? '')) continue;
    const key = `${t.amenity}|${lat.toFixed(3)}|${lon.toFixed(3)}`; // an office drawn as a node and a building: keep one
    if (seen.has(key)) continue;
    seen.add(key);
    if (t.amenity === 'police') {
      const s = sheriffOf(st, t, lat, lon);
      if (s) out[st].sheriffs.push(s);
    } else if (t.amenity === 'ranger_station') {
      out[st].rangers.push({ name: (t.name ?? 'Ranger station').slice(0, 90), operator: (t.operator ?? '').slice(0, 80) || null, phone: phone(t.phone ?? t['contact:phone']),
        website: t.website ?? t['contact:website'] ?? null, hours: (t.opening_hours ?? '').slice(0, 80) || null, lat: r5(lat), lon: r5(lon) });
    }
  }
  for (const st of STATES) {
    if (out[st].sheriffs.length < 5 || out[st].rangers.length < 5) {
      console.error(`${st}: only ${out[st].sheriffs.length} sheriff offices and ${out[st].rangers.length} ranger stations, keeping last week's`);
      out[st].sheriffs = out[st].rangers = null;
      continue;
    }
    out[st].sources.osm = 'OpenStreetMap contributors (ODbL), via Overpass API';
  }
}

for (const st of STATES) {
  try {
    const rows = await cmsHospitals(st);
    const placed = await geocode(rows);
    const er = [];
    let byOsm = 0, byOne = 0, missed = [];
    for (const h of rows) {
      let at = placed.get(h.facility_id);
      if (!at && (at = await geocodeOne(h))) byOne++;
      if (!at) {
        // OpenStreetMap's hospital with the same name in the same city.
        const n = normName(h.facility_name), city = String(h.citytown ?? '').toLowerCase();
        const hit = osmHospitals.find(o => o.st === st && n.length >= 4 && normName(o.name) === n && (!o.city || o.city.toLowerCase() === city));
        if (hit) { at = hit; byOsm++; }
      }
      if (!at || stateOf(at.lat, at.lon) !== st) { missed.push(h.facility_name); continue; }
      er.push({ name: title(h.facility_name), lat: r5(at.lat), lon: r5(at.lon), phone: phone(h.telephone_number), address: title(h.address), city: title(h.citytown),
        county: countyAt(st, at.lat, at.lon), critical: /critical access/i.test(h.hospital_type ?? '') });
    }
    console.log(`${st}: ${rows.length} hospitals with emergency services, ${er.length} placed (${byOne} one by one, ${byOsm} by OpenStreetMap name), ${missed.length} not placed${missed.length ? `: ${missed.slice(0, 15).join('; ')}` : ''}`);
    if (er.length < rows.length * 0.8 || er.length < 10) throw new Error(`only ${er.length} of ${rows.length} placed`);
    out[st].er = er.sort((a, b) => a.lat - b.lat);
    out[st].sources.er = 'CMS Hospital General Information (data.cms.gov, dataset xubh-q36u); placed with the U.S. Census Geocoder';
  } catch (e) { console.error(`${st} hospitals failed, keeping last week's: ${e.message}`); }
}

// Each county's office from its association, so every county has a number even where OpenStreetMap has none.
const directories = { CA: caDirectory, OR: orDirectory };
for (const [st, fn] of Object.entries(directories)) {
  if (!out[st].sheriffs) continue;
  try {
    const dir = await fn();
    const n = Object.keys(dir).length;
    console.log(`${st}: sheriffs' association directory has a phone for ${n} of ${counties[st].length} counties`);
    if (n < counties[st].length / 2) throw new Error('too few, page layout changed?');
    for (const [county, d] of Object.entries(dir)) {
      const k = counties[st].find(c => c.name === county);
      const osmMain = out[st].sheriffs.find(s => s.county === county && s.main);
      // Placed at the OSM main office when there is one, else the middle of the county (it's only for "nearest").
      out[st].sheriffs.push({ county, name: `${county} County Sheriff's Office`, phone: d.phone, website: null,
        lat: osmMain?.lat ?? r5((k.bbox[1] + k.bbox[3]) / 2), lon: osmMain?.lon ?? r5((k.bbox[0] + k.bbox[2]) / 2), main: true, directory: true });
      if (osmMain) osmMain.main = false;
    }
    out[st].sources.directory = st === 'CA' ? "California State Sheriffs' Association directory (calsheriffs.org)" : "Oregon State Sheriffs' Association (oregonsheriffs.org)";
  } catch (e) { console.error(`${st} sheriffs' directory failed: ${e.message}`); }
}

for (const st of STATES) {
  const o = out[st], prev = old[st];
  for (const k of ['er', 'sheriffs', 'rangers']) {
    if (o[k] != null) continue;
    o[k] = prev[k] ?? [];
    for (const src of k === 'er' ? ['er'] : ['osm', 'directory']) if (prev.sources?.[src]) o.sources[src] = prev.sources[src];
  }
  o.sheriffs.sort((a, b) => a.county.localeCompare(b.county) || b.main - a.main || a.name.localeCompare(b.name));
  o.rangers.sort((a, b) => a.lat - b.lat);
  const withPhone = new Set(o.sheriffs.filter(s => s.phone).map(s => s.county));
  const none = counties[st].map(k => k.name).filter(c => !withPhone.has(c));
  console.log(`${st}: ${o.er.length} ERs, ${o.sheriffs.length} sheriff offices (${withPhone.size} of ${counties[st].length} counties with a phone${none.length ? `; none for ${none.join(', ')}` : ''}), ${o.rangers.length} ranger stations (${o.rangers.filter(r => r.phone).length} with a phone)`);
  await mkdir(dirOf(st), { recursive: true });
  await writeFile(new URL('help.json', dirOf(st)), JSON.stringify(o) + '\n');
}
