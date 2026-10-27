// Dev probe for the ocean features: NWS marine zone details and offshore lookups. Writes nothing.
const O = 'https://mikegutberlet.github.io';
const get = async u => { const r = await fetch(u, { headers: { Origin: O, Accept: 'application/geo+json', 'User-Agent': 'TackleBox-probe' } }); return [r.status, r.headers.get('access-control-allow-origin'), await r.json().catch(() => null)]; };
for (const [n, lat, lon] of [['Santa Monica Pier', 34.0083, -118.4988], ['Pacifica Pier', 37.6325, -122.4966], ['Newport OR', 44.6168, -124.07], ['Crescent City', 41.745, -124.19], ['Oceanside', 33.193, -117.386], ['Monterey wharf', 36.603, -121.889]]) {
  for (const [dx, dy] of [[0, 0], [-0.03, 0], [-0.03, -0.03], [0, -0.03], [-0.08, 0], [-0.06, -0.06]]) {
    const [s, , j] = await get(`https://api.weather.gov/zones?type=marine&point=${(lat + dy).toFixed(4)},${(lon + dx).toFixed(4)}`);
    const p = j?.features?.[0]?.properties;
    console.log(n, dx, dy, s, p ? JSON.stringify({ id: p.id, name: p.name, type: p.type, cwa: p.cwa, offices: p.forecastOffices, keys: Object.keys(p) }) : 'none');
    if (p) break;
  }
}
const [s, a, j] = await get('https://api.weather.gov/zones/forecast/PZZ545/forecast');
console.log('zone forecast props', s, a, JSON.stringify(j?.properties)?.slice(0, 1500));
