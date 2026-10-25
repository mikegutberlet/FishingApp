// Local-only storage. Everything lives in this browser's IndexedDB; nothing is sent to a server.
const DB_NAME = 'tackle-box';
// Stores and the indexes on each. To add a store or an index, add it here: the version is derived from
// this list (this set is version 1), so existing installs upgrade on their next open. Never rename or remove one.
const SCHEMA = {
  lakes: [],
  catches: ['lakeId'],
  notes: ['lakeId'],
  stocking: ['lakeId'],
  depthSets: ['lakeId'],
  trips: ['lakeId'],
  events: ['tripId'],
  tackle: [],
  waypoints: ['lakeId'],
  tempProfiles: ['lakeId'],
};
export const STORES = Object.keys(SCHEMA);
const DB_VERSION = STORES.reduce((n, name) => n + 1 + SCHEMA[name].length, 0) - 8;

let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, indexes] of Object.entries(SCHEMA)) {
        const store = db.objectStoreNames.contains(name) ? req.transaction.objectStore(name) : db.createObjectStore(name, { keyPath: 'id' });
        for (const index of indexes) if (!store.indexNames.contains(index)) store.createIndex(index, index);
      }
    };
    req.onsuccess = () => {
      // A newer version of the app opened in another tab and needs to upgrade: step aside and reload into it.
      req.result.onversionchange = () => { req.result.close(); location.reload(); };
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const result = fn(t.objectStore(store));
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : result);
    t.onerror = () => reject(t.error);
  }));
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const db = {
  all: store => tx(store, 'readonly', s => s.getAll()),
  get: (store, id) => tx(store, 'readonly', s => s.get(id)),
  // touch: false keeps the row's own updatedAt, for changes the app makes on its own (a backup merge goes by it).
  put: (store, obj, { touch = true } = {}) => {
    if (!obj.id) obj.id = uid();
    if (touch || !obj.updatedAt) obj.updatedAt = new Date().toISOString();
    return tx(store, 'readwrite', s => s.put(obj)).then(() => obj);
  },
  del: (store, id) => tx(store, 'readwrite', s => s.delete(id)),
  byLake: (store, lakeId) => tx(store, 'readonly', s => s.index('lakeId').getAll(lakeId)),
  clear: store => tx(store, 'readwrite', s => s.clear()),
};

// Backup: photos are Blobs, so encode them as data URLs for a portable JSON file.
const blobToDataUrl = blob => new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(blob); });
const dataUrlToBlob = url => fetch(url).then(r => r.blob());

export async function exportAll() {
  const out = { app: 'tackle-box', version: DB_VERSION, exportedAt: new Date().toISOString() };
  for (const name of STORES) {
    const rows = await db.all(name);
    for (const row of rows) {
      if (row.photo instanceof Blob) row.photo = await blobToDataUrl(row.photo);
      if (Array.isArray(row.photos)) row.photos = await Promise.all(row.photos.map(p => p instanceof Blob ? blobToDataUrl(p) : p));
    }
    out[name] = rows;
  }
  return out;
}

// A backup or a friend's shared lake is someone else's data until it's checked. The views put ids, numbers and dates
// into HTML as they are and escape only free text, so on import: ids must be plain tokens (else the row is skipped),
// numeric fields must be numbers, links must be http(s), photos must be images, and every other string loses the
// characters that could open a tag or close an attribute. Free text (names, notes, species, lures...) stays as typed.
const SAFE_ID = /^[\w.:-]{0,100}$/;
const FREE_TEXT = new Set(['name', 'notes', 'note', 'text', 'journal', 'species', 'lure', 'technique', 'companions', 'title', 'color', 'size', 'brand', 'from', 'description', 'county',
  'regs', 'access', 'number', 'stockName']);
const NUMERIC = new Set(['lat', 'lon', 'acres', 'elevationFt', 'maxDepth', 'maxDepthFt', 'lengthKm', 'km', 'length', 'weight', 'weightEst', 'depth',
  'waterTemp', 'airTemp', 'wind', 'windDir', 'gusts', 'cloud', 'pressureInHg', 'levelFt', 'count', 'inches', 'qty', 'rating', 'accuracy']);
const BAD = Symbol('unsafe id');
function clean(v, k = '') {
  if (k === 'id' || k.endsWith('Id')) return v == null || typeof v === 'number' || (typeof v === 'string' && SAFE_ID.test(v)) ? v : BAD;
  if (v == null || typeof v === 'boolean') return v;
  if (NUMERIC.has(k)) { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN; return Number.isFinite(n) ? n : undefined; }
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (FREE_TEXT.has(k)) return typeof v === 'string' ? v : undefined;
  if (typeof v === 'string') {
    if (k === 'photo' || k === 'photos') return /^data:image\/(?!svg)[\w.+-]+;base64,/.test(v) ? v : undefined;
    if (/url$/i.test(k)) return /^https?:\/\/[^\s<>"'`]*$/i.test(v) ? v : undefined;
    return v.replace(/[<>"'`]/g, '');
  }
  if (Array.isArray(v)) {
    const out = [];
    for (const x of v) { const c = clean(x, k === 'photos' ? k : ''); if (c === BAD) return BAD; if (c !== undefined) out.push(c); }
    return out;
  }
  if (typeof v === 'object') {
    const out = {};
    for (const [kk, x] of Object.entries(v)) { const c = clean(x, kk); if (c === BAD) return BAD; if (c !== undefined) out[kk] = c; }
    return out;
  }
}
// A lake also needs a place on the map: one without coordinates breaks the map for every lake.
// A trip's track is [lat, lon, ms] points: numbers written as text become numbers, a time that can't be read becomes
// null (the route still draws), and a point without a position is dropped.
const cleanTrack = track => (Array.isArray(track) ? track : []).filter(Array.isArray).map(([lat, lon, ms]) => {
  const time = new Date(typeof ms === 'string' && ms.trim() && isFinite(ms) ? +ms : ms ?? NaN).getTime();
  return [clean(lat, 'lat'), clean(lon, 'lon'), Number.isFinite(time) ? time : null];
}).filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
const cleanRow = (row, store) => {
  if (!row || typeof row !== 'object' || Array.isArray(row) || row.id == null || row.id === '') return null;
  const c = clean(row);
  if (c === BAD) return null;
  if (store === 'trips') c.track = cleanTrack(c.track);
  return store === 'lakes' && !(Number.isFinite(c.lat) && Number.isFinite(c.lon)) ? null : c;
};

// Returns how many rows were skipped as unsafe.
export async function importAll(data, { replace = false } = {}) {
  if (data.app !== 'tackle-box') throw new Error('Not a Tackle Box backup file');
  let skipped = 0;
  for (const name of STORES) {
    const rows = Array.isArray(data[name]) ? data[name] : [];
    data[name] = rows.map(r => cleanRow(r, name)).filter(Boolean);
    skipped += rows.length - data[name].length;
  }
  for (const name of STORES) {
    if (replace) await db.clear(name);
    for (const row of data[name]) {
      // Merging keeps whichever copy was edited last, so an old backup can't undo newer work on this device.
      if (!replace && (await db.get(name, row.id))?.updatedAt > (row.updatedAt ?? '')) continue;
      if (typeof row.photo === 'string' && row.photo.startsWith('data:')) row.photo = await dataUrlToBlob(row.photo);
      if (Array.isArray(row.photos)) row.photos = await Promise.all(row.photos.map(p => typeof p === 'string' && p.startsWith('data:') ? dataUrlToBlob(p) : p));
      await tx(name, 'readwrite', s => s.put(row));
    }
  }
  return skipped;
}
