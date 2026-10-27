// Sunrise, sunset and the end of civil twilight for any spot and day, computed on this device (NOAA's solar
// equations), so "sunset in 40 min" works with no signal. Accurate to about a minute below 60° latitude.
const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;

// The UTC moment the sun is `alt` degrees from the horizon (−0.833 sunrise/sunset, −6 civil twilight) on the
// calendar day that holds `date` at that longitude. rising: morning or evening. null when it never gets there.
function crossing(date, lat, lon, alt, rising) {
  const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  // Local solar noon of that day, iterated twice so the sun's position is taken at the event itself.
  let t = day + (12 - lon / 15) * 36e5;
  for (let i = 0; i < 3; i++) {
    const jc = (t / 864e5 + 2440587.5 - 2451545) / 36525;
    const L0 = (280.46646 + jc * (36000.76983 + jc * 0.0003032)) % 360;
    const M = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);
    const e = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);
    const C = Math.sin(rad(M)) * (1.914602 - jc * (0.004817 + 0.000014 * jc)) + Math.sin(rad(2 * M)) * (0.019993 - 0.000101 * jc) + Math.sin(rad(3 * M)) * 0.000289;
    const omega = 125.04 - 1934.136 * jc;
    const lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(rad(omega));
    const eps = 23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60 + 0.00256 * Math.cos(rad(omega));
    const decl = Math.asin(Math.sin(rad(eps)) * Math.sin(rad(lambda)));
    const y = Math.tan(rad(eps / 2)) ** 2;
    const eqTime = 4 * deg(y * Math.sin(2 * rad(L0)) - 2 * e * Math.sin(rad(M)) + 4 * e * y * Math.sin(rad(M)) * Math.cos(2 * rad(L0))
      - 0.5 * y * y * Math.sin(4 * rad(L0)) - 1.25 * e * e * Math.sin(2 * rad(M)));
    const cosH = (Math.sin(rad(alt)) - Math.sin(rad(lat)) * Math.sin(decl)) / (Math.cos(rad(lat)) * Math.cos(decl));
    if (cosH < -1 || cosH > 1) return null;
    const H = deg(Math.acos(cosH));
    const noonMin = 720 - 4 * lon - eqTime;
    t = day + (noonMin + (rising ? -4 * H : 4 * H)) * 6e4;
  }
  return t;
}

// For the day at that spot (its solar day, so a phone still set to home's time zone gets the right evening):
// times in ms, or null in polar day or night.
export function sunTimes(date, lat, lon) {
  const solar = new Date(new Date(date).getTime() + lon / 15 * 36e5);
  return {
    sunrise: crossing(solar, lat, lon, -0.833, true),
    sunset: crossing(solar, lat, lon, -0.833, false),
    dusk: crossing(solar, lat, lon, -6, false),
  };
}
