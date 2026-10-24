// Per-state settings for the shared data jobs (scripts/build-state-*.mjs <st>). California's jobs predate these
// and keep their own scripts (build-ca-*.mjs).
import { outline as OR_OUTLINE } from '../states/or-outline.js';

const NV = {
  code: 'NV', name: 'Nevada',
  // Lake Mead and Lake Mohave sit on the Arizona line, so the outline takes in the river's east bank too.
  bbox: { xmin: -120.01, ymin: 34.99, xmax: -114.03, ymax: 42.01 },
  outline: [[-120.0, 42.0], [-114.04, 42.0], [-114.04, 36.2], [-114.0, 36.0], [-114.0, 35.0], [-114.63, 35.0], [-115.27, 35.512], [-115.919, 36.022], [-116.577, 36.528], [-117.244, 37.03], [-117.92, 37.529], [-118.605, 38.024], [-119.298, 38.514], [-120.0, 39.0]],
  // Early events NAS doesn't record against a specific water.
  narrative: [
    { year: '1873', text: 'The first fish are carried into Nevada by rail: eastern brook trout and other species released into streams near the Central Pacific line.', source: 'NDOW history' },
    { year: '1877', text: 'Nevada creates its first Fish Commission to restock waters emptied by mining, logging and irrigation diversions.', source: 'NDOW history' },
    { year: '1938', text: 'Lahontan cutthroat trout of Pyramid Lake, the largest cutthroat trout ever recorded, die out there after Derby Dam (1905) cuts off the Truckee River spawning run. Hatchery plants of other strains keep the lake fished until the original strain is rediscovered in Utah and returned in the 2000s.', source: 'USFWS Lahontan NFHC' },
    { year: '1969', text: 'Striped bass are first planted in Lake Mead; they become the lake\'s main sport fish.', source: 'NDOW' },
  ],
  bathymetryQueries: ['reservoir bathymetric Nevada', 'lake bathymetric Nevada', 'bathymetric survey Nevada', 'Lake Mead bathymetry', 'Lake Tahoe bathymetry', 'Pyramid Lake bathymetry', 'Walker Lake bathymetry', 'Lahontan Reservoir bathymetric', 'stage-storage Nevada', 'reservoir contours Nevada'],
};

const OR = {
  code: 'OR', name: 'Oregon',
  // The Columbia and the Snake make the north and east lines; the box takes in both rivers.
  bbox: { xmin: -124.75, ymin: 41.99, xmax: -116.45, ymax: 46.3 },
  riverScale: 'small',
  // Brownlee (Snake) and Lake Celilo (Columbia) are shared with Idaho and Washington, and their NHD point is on the
  // far half; a big water this close to the line stays in the state's list.
  borderReservoirs: true,
  outline: OR_OUTLINE, // traced from the Census county lines; shared with the app
  narrative: [
    { year: '1877', text: 'The first salmon hatchery in the Columbia basin opens on the Clackamas River.', source: 'ODFW history' },
    { year: '1975', text: 'The Oregon Fish Commission and the Oregon Game Commission merge into the Oregon Department of Fish and Wildlife.', source: 'ODFW' },
  ],
  bathymetryQueries: ['reservoir bathymetric Oregon', 'lake bathymetry Oregon', 'bathymetric survey Oregon', 'Detroit Lake bathymetry', 'Crater Lake bathymetry', 'Upper Klamath Lake bathymetry',
    'Lake Billy Chinook bathymetric', 'Willamette reservoirs bathymetry', 'Hills Creek Lake bathymetry', 'Cougar Reservoir bathymetry', 'reservoir contours Oregon'],
};

export const STATES = { nv: NV, or: OR };

export function stateArg() {
  const st = (process.argv[2] ?? '').toLowerCase();
  if (!STATES[st]) { console.error(`Usage: node ${process.argv[1]} <${Object.keys(STATES).join('|')}>`); process.exit(2); }
  return { st, ...STATES[st] };
}

export function inOutline([x, y], outline) {
  let inside = false;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const [xi, yi] = outline[i], [xj, yj] = outline[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Degrees from a point to the nearest edge of an outline (flat-earth, fine at a few km). Same as states/index.js.
export function edgeDeg([x, y], outline) {
  let best = Infinity;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const [ax, ay] = outline[j], [bx, by] = outline[i], dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return best;
}
