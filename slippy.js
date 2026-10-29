// Slippy-map tile math shared by the app (offline.js) and the archive's build-maps script.
// Boxes are plain objects { west, south, east, north } in degrees; tiles follow the OSM convention (y grows southward).

// Tile numbers covering a box at one zoom, clamped to 0..2^z-1.
export function tileRange(b, z) {
  const n = 2 ** z, clamp = v => Math.max(0, Math.min(n - 1, v));
  const x = lon => clamp(Math.floor((lon + 180) / 360 * n));
  const y = lat => { const r = lat * Math.PI / 180; return clamp(Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n)); };
  return { x0: x(b.west), x1: x(b.east), y0: y(b.north), y1: y(b.south) };
}

export const tilesAt = (b, z) => { const r = tileRange(b, z); return (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1); };

// Every tile of a box from zMin to zMax: zooms ascending, then x, then y.
export function* tileList(b, zMin, zMax) {
  for (let z = zMin; z <= zMax; z++) {
    const r = tileRange(b, z);
    for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) yield { z, x, y };
  }
}

// [west, south, east, north] (the states' bbox order) -> box object.
export const boundsOf = ([west, south, east, north]) => ({ west, south, east, north });
