// Who to call from where you are: the county (and its sheriff), the nearest ERs and ranger stations, from the
// weekly table the app's own site serves (scripts/build-help.mjs). A copy is kept in its own cache ("tb-help"),
// which app updates leave alone, so the SOS card has its numbers with no signal. Nothing about where you are is sent:
// the whole state's table is downloaded and searched on this device.
import { haversineKm } from './data-sources.js';
import { stateAt, STATES } from './states/index.js';

const CACHE = 'tb-help';
const mem = {};

// Network first (the table changes weekly), the kept copy when there's no signal.
async function getJson(path) {
  const url = new URL(path, location.href).href;
  try {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) throw new Error(r.status);
    const copy = r.clone();
    globalThis.caches?.open(CACHE).then(c => c.put(url, copy)).catch(() => {});
    return await r.json();
  } catch {
    const hit = await globalThis.caches?.match(url).catch(() => null); // this cache, or an offline lake pack's copy
    return hit?.ok ? hit.json().catch(() => null) : null; // sw.js also keeps a 404 it saw, so check
  }
}
const load = (code, name) => mem[`${code}/${name}`] ??= getJson(`data/${code.toLowerCase()}/${name}.json`).then(j => { if (!j) delete mem[`${code}/${name}`]; return j; });

// Fetch and keep the tables for these states now (when a plan is made, or the SOS page opens with signal).
export const keepHelp = codes => Promise.all([...new Set(codes)].filter(c => STATES[c]).flatMap(c => [load(c, 'help'), load(c, 'counties')]));
export const helpDate = async code => (await load(code, 'help'))?.updatedAt ?? null;

function inRing([x, y], ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}

export async function countyAt(code, lat, lon) {
  const c = await load(code, 'counties');
  return c?.counties.find(k => lon >= k.bbox[0] && lon <= k.bbox[2] && lat >= k.bbox[1] && lat <= k.bbox[3] && k.polys.some(([outer]) => inRing([lon, lat], outer)))?.name ?? null;
}

const nearest = (list, lat, lon, n) => (list ?? []).map(x => ({ ...x, km: haversineKm(lat, lon, x.lat, x.lon) })).sort((a, b) => a.km - b.km).slice(0, n);

// Everything the SOS card shows for a spot. The ER and ranger lists take in the next state over, since the closest
// hospital from the Nevada side of Tahoe, or from the Klamath, can be across the line.
export async function helpAt(lat, lon) {
  const S = stateAt(lat, lon);
  const codes = S ? [S.code, ...Object.keys(STATES).filter(c => c !== S.code)] : Object.keys(STATES);
  const tables = (await Promise.all(codes.map(c => load(c, 'help')))).map((t, i) => t && { ...t, code: codes[i] }).filter(Boolean);
  const county = S ? await countyAt(S.code, lat, lon) : null;
  const own = tables.find(t => t.code === S?.code);
  // The county's main office with a phone; else its closest office with a phone; else its closest office.
  const offices = nearest((own?.sheriffs ?? []).filter(s => s.county === county), lat, lon, 50);
  const sheriff = offices.find(s => s.main && s.phone) ?? offices.find(s => s.phone) ?? offices[0] ?? null;
  const substation = offices.find(s => s !== sheriff && s.km < (sheriff?.km ?? Infinity)) ?? null;
  const near = (key, n) => nearest(tables.flatMap(t => (t[key] ?? []).map(x => ({ ...x, state: t.code }))), lat, lon, n);
  return {
    state: S?.code ?? null, county, sheriff, substation,
    er: near('er', 3), rangers: near('rangers', 2),
    updatedAt: own?.updatedAt ?? tables[0]?.updatedAt ?? null,
    missing: !tables.length,
  };
}

export const telHref = phone => `tel:${String(phone).replace(/[^\d+]/g, '')}`;
