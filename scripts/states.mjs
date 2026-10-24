// Per-state settings for the shared data jobs (scripts/build-state-*.mjs <st>). California's jobs predate these
// and keep their own scripts (build-ca-*.mjs).

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
  outline: [[-124.6, 42.0], [-117.03, 42.0], [-117.03, 44.3], [-116.9, 44.5], [-116.46, 45.6], [-116.92, 46.0], [-119.0, 46.0], [-119.3, 45.94],
    // Midstream down the Columbia, so Gorge towns (Hood River, Cascade Locks) are in and Washington's bank is out.
    [-119.9, 45.86], [-120.2, 45.75], [-120.74, 45.71], [-120.97, 45.655], [-121.18, 45.625], [-121.4, 45.705], [-121.52, 45.73], [-121.89, 45.685],
    [-121.95, 45.65], [-122.12, 45.59], [-122.39, 45.575], [-122.67, 45.625], [-122.76, 45.66], [-122.8, 45.9], [-123.1, 46.18], [-123.9, 46.27], [-124.2, 46.27], [-124.2, 45.0], [-124.6, 42.8]],
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
