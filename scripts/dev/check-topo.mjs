// Dev check: which topo tile services answer a browser on the app's origin (CORS), what they send, and how far they
// zoom. The sandbox can't reach them; Actions can. Writes nothing.
const ORIGIN = 'https://mikegutberlet.github.io';
const tile = (lat, lon, z) => { const n = 2 ** z, r = lat * Math.PI / 180; return { x: Math.floor((lon + 180) / 360 * n), y: Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n), z }; };
const SOURCES = {
  usgsTopo: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}',
  usgsImageryTopo: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryTopo/MapServer/tile/{z}/{y}/{x}',
  esriTopo: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
  esriTopoServices: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
  openTopo: 'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
  fsTopoTiles: 'https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_FSTopo_01/MapServer/tile/{z}/{y}/{x}',
};
const SPOTS = [['Winnemucca Lake CA', 38.6475, -119.9958], ['Anthony Lake OR', 44.962, -118.231], ['Wilson Res NV', 41.616, -116.408]];
for (const [name, url] of Object.entries(SOURCES)) {
  for (const [spot, lat, lon] of SPOTS) for (const z of [12, 14, 15, 16, 17]) {
    const t = tile(lat, lon, z), u = url.replace('{z}', z).replace('{x}', t.x).replace('{y}', t.y);
    try {
      const r = await fetch(u, { headers: { Origin: ORIGIN, Referer: ORIGIN + '/FishingApp/', 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) TackleBox-check' }, signal: AbortSignal.timeout(20000) });
      const b = await r.arrayBuffer();
      console.log(`${name} ${spot} z${z}: ${r.status} ${r.headers.get('content-type')} ${b.byteLength}B acao=${r.headers.get('access-control-allow-origin')} cache=${r.headers.get('cache-control')}`);
    } catch (e) { console.log(`${name} ${spot} z${z}: FAIL ${e.message} ${e.cause?.code ?? ''}`); }
  }
}
for (const svc of ['https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer?f=json', 'https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_FSTopo_01/MapServer?f=json']) {
  try { const j = await (await fetch(svc, { signal: AbortSignal.timeout(20000) })).json(); console.log(svc, 'tiled=', !!j.tileInfo, 'lods=', j.tileInfo?.lods?.map(l => l.level).join(','), 'copyright=', j.copyrightText, 'capabilities=', j.capabilities, 'maxExportTilesCount=', j.maxExportTilesCount, 'exportTilesAllowed=', j.exportTilesAllowed); }
  catch (e) { console.log(svc, 'FAIL', e.message); }
}
