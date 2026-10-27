// A position in the formats rescuers use: decimal degrees, degrees minutes seconds, degrees and decimal minutes,
// UTM and USNG (the U.S. National Grid, the same grid as military MGRS). Computed on this device, so it works offline.

const hemi = (v, pos, neg) => v >= 0 ? pos : neg;

export const fmtDD = (lat, lon) => `${lat.toFixed(5)}, ${lon.toFixed(5)}`;

// 37° 35′ 38.4″ N. Seconds are rounded first, so 59.96″ becomes the next minute rather than "60.0″".
function dms(v) {
  let tenths = Math.round(Math.abs(v) * 36000);
  const d = Math.floor(tenths / 36000); tenths -= d * 36000;
  const m = Math.floor(tenths / 600); tenths -= m * 600;
  return `${d}° ${String(m).padStart(2, '0')}′ ${(tenths / 10).toFixed(1).padStart(4, '0')}″`;
}
export const fmtDMS = (lat, lon) => `${dms(lat)} ${hemi(lat, 'N', 'S')}, ${dms(lon)} ${hemi(lon, 'E', 'W')}`;

function ddm(v) {
  let thou = Math.round(Math.abs(v) * 60000);
  const d = Math.floor(thou / 60000); thou -= d * 60000;
  return `${d}° ${(thou / 1000).toFixed(3).padStart(6, '0')}′`;
}
export const fmtDDM = (lat, lon) => `${ddm(lat)} ${hemi(lat, 'N', 'S')}, ${ddm(lon)} ${hemi(lon, 'E', 'W')}`;

// ---------- UTM (WGS84, transverse Mercator by Krüger's series) ----------
const A = 6378137, F = 1 / 298.257223563, K0 = 0.9996;
const N_ = F / (2 - F), AA = A / (1 + N_) * (1 + N_ ** 2 / 4 + N_ ** 4 / 64);
const ALPHA = [N_ / 2 - 2 * N_ ** 2 / 3 + 5 * N_ ** 3 / 16, 13 * N_ ** 2 / 48 - 3 * N_ ** 3 / 5, 61 * N_ ** 3 / 240];
const BANDS = 'CDEFGHJKLMNPQRSTUVWXX';

export function toUtm(lat, lon) {
  if (lat < -80 || lat > 84) return null;
  const zone = Math.min(60, Math.floor((lon + 180) / 6) + 1);
  const lon0 = (zone - 1) * 6 - 180 + 3;
  const phi = lat * Math.PI / 180, lam = (lon - lon0) * Math.PI / 180;
  const e = Math.sqrt(F * (2 - F));
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - e * Math.atanh(e * Math.sin(phi)));
  const xi = Math.atan2(t, Math.cos(lam)), eta = Math.atanh(Math.sin(lam) / Math.sqrt(1 + t * t));
  let x = eta, y = xi;
  ALPHA.forEach((a, i) => { const j = 2 * (i + 1); x += a * Math.cos(j * xi) * Math.sinh(j * eta); y += a * Math.sin(j * xi) * Math.cosh(j * eta); });
  const easting = 500000 + K0 * AA * x, northing = K0 * AA * y + (lat < 0 ? 10000000 : 0);
  return { zone, band: BANDS[Math.floor((lat + 80) / 8)], easting, northing };
}

export function fmtUtm(lat, lon) {
  const u = toUtm(lat, lon);
  return u ? `${u.zone}${u.band} ${Math.floor(u.easting)}mE ${Math.floor(u.northing)}mN` : '';
}

// ---------- USNG / MGRS: zone and band, the 100 km square's two letters, then easting and northing within it ----------
const COLS = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ'];
const ROWS = 'ABCDEFGHJKLMNPQRSTUV';
// digits: 5 for 1 m, 4 for 10 m. Grid values are truncated, never rounded, as the standard says.
export function fmtUsng(lat, lon, digits = 5) {
  const u = toUtm(lat, lon);
  if (!u) return '';
  const col = COLS[(u.zone - 1) % 3][Math.floor(u.easting / 1e5) - 1];
  const row = ROWS[(Math.floor(u.northing / 1e5) + (u.zone % 2 ? 0 : 5)) % 20];
  const cut = v => String(Math.floor((v % 1e5) / 10 ** (5 - digits))).padStart(digits, '0');
  return `${u.zone}${u.band} ${col}${row} ${cut(u.easting)} ${cut(u.northing)}`;
}

// Every format at once, for the SOS card and the text you copy.
export const allFormats = (lat, lon) => [
  ['Lat, long', fmtDD(lat, lon)],
  ['Degrees, minutes, seconds', fmtDMS(lat, lon)],
  ['Degrees, decimal minutes', fmtDDM(lat, lon)],
  ['UTM (NAD83/WGS84)', fmtUtm(lat, lon)],
  ['USNG / MGRS', fmtUsng(lat, lon)],
];

// ---------- Direction and distance ----------
const rad = d => d * Math.PI / 180;
// Initial compass bearing from one point to another, 0–360°.
export function bearing(lat1, lon1, lat2, lon2) {
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
export const compass8 = deg => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];
