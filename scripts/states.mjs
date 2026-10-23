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

export const STATES = { nv: NV };

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
