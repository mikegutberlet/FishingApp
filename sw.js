// Caches the app shell so it opens with no signal on the water. Your data is in IndexedDB, not here.
const CACHE = 'tackle-box-v7';
// One file per line. Add new files here and bump CACHE.
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'forecast.css',
  'manifest.json',
  'icon.svg',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'vendor/leaflet/leaflet.css',
  'vendor/leaflet/leaflet.js',
  'app.js',
  'ui.js',
  'map.js',
  'db.js',
  'data-sources.js',
  'forecast.js',
  'solunar.js',
  'wind.js',
  'wind-layer.js',
  'radar.js',
  'states/ca.js',
  'units.js',
  'weight.js',
  'exif.js',
  'views/lake.js',
  'views/lakes.js',
  'views/log.js',
  'views/settings.js',
  'views/stats.js',
  'views/trips.js',
  'views/journal.js',
  'views/bests.js',
  'views/tackle.js',
  'views/backfill.js',
  'views/today.js',
  'views/planner.js',
  'views/tabs/catches.js',
  'views/tabs/conditions.js',
  'views/tabs/depth.js',
  'views/tabs/history.js',
  'views/tabs/info.js',
  'views/tabs/notes.js',
  'views/tabs/stocking.js',
];

self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
// Drop old app-shell caches, but keep the map tiles you've already viewed.
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== 'tiles').map(k => caches.delete(k)))).then(() => self.clients.claim())));

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  const isTile = /tile\.openstreetmap\.org|arcgisonline\.com/.test(url.host);
  const isShell = url.origin === location.origin;
  if (isTile) {
    // Map tiles: cache what you've viewed so lakes you've looked at work offline.
    e.respondWith(caches.open('tiles').then(async c => (await c.match(e.request)) || fetch(e.request).then(r => { if (r.ok || r.type === 'opaque') c.put(e.request, r.clone()); return r; })));
  } else if (isShell) {
    // Network first so updates land, cache as fallback for offline.
    e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request)));
  }
  // Weather/USGS calls go straight to the network.
});
