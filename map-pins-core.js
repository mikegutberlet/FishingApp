// The arithmetic behind the map's pins (map-pins.js), kept free of the map so it can be tested on its own:
// where a point falls in world pixels, which pins share a bubble at a zoom, and what color a pin gets.

// Web Mercator world pixels at a zoom (the whole world is 256 · 2^zoom wide), as Leaflet and the tile servers count.
export function project(lat, lon, zoom) {
  const size = 256 * 2 ** zoom, s = Math.sin(lat * Math.PI / 180);
  return { x: (lon + 180) / 360 * size, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size };
}

// Pins closer than a cell share a bubble: wide cells while zoomed out, and from zoom 12 only pins nearly on top of
// each other.
export const cellFor = zoom => zoom < 12 ? 60 : 18;

// Group pins by the world-pixel cell they fall in, so groups stay put while the map pans. A group sits at the middle
// of its pins; a group of one keeps its own point.
export function clusterPins(pins, zoom, cell = cellFor(zoom)) {
  const groups = new Map();
  for (const p of pins) {
    const { x, y } = project(p.lat, p.lon, zoom), key = `${Math.floor(x / cell)}:${Math.floor(y / cell)}`;
    const g = groups.get(key) ?? groups.set(key, { lat: 0, lon: 0, pins: [] }).get(key);
    g.pins.push(p); g.lat += p.lat; g.lon += p.lon;
  }
  return [...groups.values()].map(g => g.pins.length === 1 ? { lat: g.pins[0].lat, lon: g.pins[0].lon, pins: g.pins }
    : { lat: g.lat / g.pins.length, lon: g.lon / g.pins.length, pins: g.pins });
}

// Pins no zoom can pull apart (some agencies pin several creeks on one spot).
export const samePlace = pins => pins.every(p => Math.abs(p.lat - pins[0].lat) < 1e-4 && Math.abs(p.lon - pins[0].lon) < 1e-4);

// A pin's color from what the app knows: 'fresh' when planted in the last 30 days or a plant is coming (the finder's
// "stocked lately"), 'fish' when any fish is on record, else 'none'. `today` is a 'YYYY-MM-DD' day.
export function pinTone({ lastPlant = null, fish }, today = new Date().toISOString().slice(0, 10)) {
  const cutoff = new Date(Date.parse(today) - 30 * 864e5).toISOString().slice(0, 10);
  return lastPlant && lastPlant >= cutoff ? 'fresh' : fish?.size ? 'fish' : 'none';
}
