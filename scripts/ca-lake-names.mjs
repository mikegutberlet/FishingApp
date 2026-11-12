// Names for CDFW water ids, from the department's master list of lakes (the CA_Lakes_wm map layer: every lake's
// state water id, the name CDFW uses and the USGS name). The stocked-waters layer the app's list is built from
// carries no names, and the planting schedule only names a water it has listed lately, so a lake that wasn't on the
// schedule this year (Lake Oroville, Eagle Lake) would otherwise go nameless.
// Shared by scripts/update-ca-data.mjs (the list itself) and scripts/build-species.mjs (matching fish to waters).
export const LAKE_LIST = 'https://services2.arcgis.com/Uq9r85Potqm3MfRV/arcgis/rest/services/CA_Lakes_wm/FeatureServer/0';

// "Eagle Lake", from CDFW's own name, else the USGS one ("Lagoon, The" is passed over for CDFW's "Lake Elizabeth").
export function namesFrom(features) {
  const names = new Map();
  for (const f of features ?? []) {
    const a = f.attributes ?? f.properties ?? f, name = String(a.NAME ?? '').trim() || String(a.GNIS_NAME ?? '').trim();
    if (a.DFGWATERID != null && name && !names.has(a.DFGWATERID)) names.set(a.DFGWATERID, name.replace(/\s+/g, ' ').replace(/\bOf The\b/g, 'of the'));
  }
  return names;
}

// id → name for the ids asked for. getJson(url) fetches and parses; a failed page throws.
export async function lakeNames(ids, getJson) {
  const names = new Map(), list = [...new Set(ids.filter(id => Number.isInteger(+id)).map(Number))];
  for (let i = 0; i < list.length; i += 150) {
    const q = new URLSearchParams({ where: `DFGWATERID IN (${list.slice(i, i + 150).join(',')})`, outFields: 'DFGWATERID,NAME,GNIS_NAME', returnGeometry: 'false', f: 'json' });
    for (const [id, name] of namesFrom((await getJson(`${LAKE_LIST}/query?${q}`)).features)) names.set(id, name);
  }
  return names;
}

// Where the lake list puts lakes of these names: [{ name, county, lat, lon }], CDFW's name and the USGS one both tried.
export async function lakePlaces(names, getJson) {
  const out = [], list = [...new Set(names.map(n => String(n).trim()).filter(Boolean))], quote = n => `'${n.replace(/'/g, "''")}'`;
  for (let i = 0; i < list.length; i += 12) {
    const set = list.slice(i, i + 12).map(quote).join(',');
    const q = new URLSearchParams({ where: `NAME IN (${set}) OR GNIS_NAME IN (${set})`, outFields: 'NAME,GNIS_NAME,COUNTY,LAT_NAD83,LON_NAD83', returnGeometry: 'false', f: 'json' });
    for (const f of (await getJson(`${LAKE_LIST}/query?${q}`)).features ?? []) {
      const a = f.attributes;
      for (const name of new Set([a.NAME, a.GNIS_NAME].map(n => String(n ?? '').trim()).filter(Boolean))) out.push({ name, county: String(a.COUNTY ?? '').trim(), lat: a.LAT_NAD83, lon: a.LON_NAD83 });
    }
  }
  return out;
}
