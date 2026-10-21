// Local-only storage. Everything lives in this browser's IndexedDB; nothing is sent to a server.
const DB_NAME = 'tackle-box';
const DB_VERSION = 1;
export const STORES = ['lakes', 'catches', 'notes', 'stocking', 'depthSets'];

let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (db.objectStoreNames.contains(name)) continue;
        const store = db.createObjectStore(name, { keyPath: 'id' });
        if (name !== 'lakes') store.createIndex('lakeId', 'lakeId');
      }
    };
    req.onsuccess = () => resolve(req.result);
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
  put: (store, obj) => {
    if (!obj.id) obj.id = uid();
    obj.updatedAt = new Date().toISOString();
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
    for (const row of rows) if (row.photo instanceof Blob) row.photo = await blobToDataUrl(row.photo);
    out[name] = rows;
  }
  return out;
}

export async function importAll(data, { replace = false } = {}) {
  if (data.app !== 'tackle-box') throw new Error('Not a Tackle Box backup file');
  for (const name of STORES) {
    if (replace) await db.clear(name);
    for (const row of data[name] || []) {
      if (typeof row.photo === 'string' && row.photo.startsWith('data:')) row.photo = await dataUrlToBlob(row.photo);
      await tx(name, 'readwrite', s => s.put(row));
    }
  }
}
