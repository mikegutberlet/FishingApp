// Contour maps from your own sonar scans. Every depth set for a lake is put on one grid (inverse-distance weighting
// over nearby soundings), traced into depth contours with marching squares, and drawn as labeled lines with an
// optional shaded fill. All on the device.
//
// Water level: a sounding is depth below the surface on the day of the scan. When a scan has the lake level for its
// date (from CDEC, or typed in), its depths are shifted to a common level, today's when the lake has a gauge, so
// scans from a full spring and a low fall line up.
import { db } from './db.js';
import * as CA from './states/ca.js';
import { $, esc, fmtDate, status, showView } from './ui.js';
import { map, depthLayer, depthColor } from './map.js';

const reservoirFor = lake => CA.nearestReservoir(lake.lat, lake.lon, lake.cdecStation, { name: lake.name, acres: lake.acres });

// Lake surface elevation (ft) on a date from the nearest CDEC gauge: the reading that day, or within 2 days.
export async function levelOn(lake, date) {
  const res = await reservoirFor(lake).catch(() => null);
  // first is null for gauges that report storage but no lake level (about 20 of them, e.g. Shaver Lake).
  if (!res?.elevation?.length || !date) return { station: res?.id ?? null, levelFt: null, first: res?.elevation?.[0]?.[0] ?? null };
  const t = Date.parse(date);
  let best = null;
  for (const [d, v] of res.elevation) { const off = Math.abs(Date.parse(d) - t); if (off <= 2 * 864e5 && (!best || off < best.off)) best = { off, v, d }; }
  return { station: res.id, levelFt: best?.v ?? null, date: best?.d ?? null, first: res.elevation[0][0] };
}

// Soundings from every scan, shifted to one water level. Only scans with a level can be shifted, so with none the
// map is drawn as scanned rather than claiming today's level.
export async function mergedSoundings(lake, sets) {
  const res = await reservoirFor(lake).catch(() => null);
  const today = res?.elevation?.at(-1);
  const dated = sets.filter(s => typeof s.levelFt === 'number').sort((a, b) => (b.scanDate ?? '').localeCompare(a.scanDate ?? ''));
  const ref = !dated.length ? null : today ? { levelFt: today[1], date: today[0], station: res.id } : { levelFt: dated[0].levelFt, date: dated[0].scanDate };
  const raw = [], steps = [];
  for (const [n, s] of sets.entries()) {
    const off = ref && typeof s.levelFt === 'number' ? ref.levelFt - s.levelFt : 0;
    for (const [lat, lon, d] of s.points) if (d > 0 && d + off > 0) raw.push([lat, lon, d + off, n]);
    steps.push(medianStep(s.points));
  }
  const points = dropStrays(raw, Math.max(1, 2 * Math.max(0, ...steps)));
  const kept = new Set(points.map(p => p[3]));
  const shifted = sets.filter((s, n) => kept.has(n) && ref && typeof s.levelFt === 'number' && ref.levelFt !== s.levelFt).length;
  return { points, ref, shifted, dropped: raw.length - points.length, unleveled: ref ? sets.length - dated.length : 0 };
}

const kmBetween = (a, b) => Math.hypot(a[0] - b[0], (a[1] - b[1]) * Math.cos(a[0] * Math.PI / 180)) * 111.2;
// Typical distance (km) between consecutive soundings of one scan, from up to ~2000 steps.
function medianStep(track) {
  const every = Math.max(1, Math.floor(track.length / 2000)), d = [];
  for (let i = every; i < track.length; i += every) { const a = track[i - every], b = track[i]; if (Number.isFinite(a?.[0] + a?.[1] + b?.[0] + b?.[1])) d.push(kmBetween(a, b) / every); }
  return d.length ? d.sort((x, y) => x - y)[d.length >> 1] : 0;
}

// Sonar tracks can start with a fix far from the water: 0,0, or the phone's last known spot repeated for every
// sounding until the GPS locks. One such clump would set the grid's extent and smear the whole map. So the soundings
// of all scans together are grouped into clumps (points closer than `link` km chain together; `link` grows with a
// sparse track's spacing so its points still chain), and a clump apart from the biggest one is dropped when it is
// tiny, or when it sits on a handful of spots the way a stuck fix does. A scan of another arm is spread out along its
// track, so it is kept. If that would drop more than 2 soundings and a few percent of them, nothing is dropped.
function dropStrays(points, link) {
  const ok = points.filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && (Math.abs(lat) > 1 || Math.abs(lon) > 1));
  if (ok.length < 2) return ok;
  const per = 111.2 / link, k = Math.cos(ok[0][0] * Math.PI / 180);
  const keyOf = ([lat, lon]) => `${Math.floor(lat * per)},${Math.floor(lon * per * k)}`;
  const parent = new Map();
  for (const p of ok) parent.set(keyOf(p), keyOf(p));
  const find = c => { while (parent.get(c) !== c) { parent.set(c, parent.get(parent.get(c))); c = parent.get(c); } return c; };
  for (const key of parent.keys()) {
    const [i, j] = key.split(',').map(Number);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      const nb = `${i + di},${j + dj}`;
      if (parent.has(nb)) { const a = find(key), b = find(nb); if (a !== b) parent.set(a, b); }
    }
  }
  const clump = ok.map(p => find(keyOf(p))), size = new Map(), spots = new Map();
  ok.forEach((p, i) => {
    size.set(clump[i], (size.get(clump[i]) ?? 0) + 1);
    const s = spots.get(clump[i]) ?? spots.set(clump[i], new Set()).get(clump[i]);
    if (s.size <= 3) s.add(`${p[0].toFixed(5)},${p[1].toFixed(5)}`);
  });
  if (size.size === 1) return ok;
  const main = [...size].sort((a, b) => b[1] - a[1])[0][0], tiny = Math.max(5, ok.length * 0.001);
  const stray = new Set([...size].filter(([c, n]) => c !== main && (n < tiny || spots.get(c).size <= 3)).map(([c]) => c));
  const n = [...stray].reduce((sum, c) => sum + size.get(c), 0);
  return n && n <= Math.max(2, ok.length * 0.05) ? ok.filter((_, i) => !stray.has(clump[i])) : ok;
}

// Soundings → regular grid. Each cell is the IDW average of the binned soundings within a few cells; cells with no
// sounding nearby stay empty (NaN), so the map never invents bottom you haven't scanned.
export function buildGrid(points) {
  let s = Infinity, n = -Infinity, w = Infinity, e = -Infinity;
  for (const [lat, lon] of points) { s = Math.min(s, lat); n = Math.max(n, lat); w = Math.min(w, lon); e = Math.max(e, lon); }
  const ky = 110540, kx = 111320 * Math.cos((s + n) / 2 * Math.PI / 180); // meters per degree
  const cell = Math.max(3, Math.max((e - w) * kx, (n - s) * ky) / 240);
  const nx = Math.ceil((e - w) * kx / cell) + 1, ny = Math.ceil((n - s) * ky / cell) + 1;
  const sum = new Float64Array(nx * ny), cnt = new Uint32Array(nx * ny);
  for (const [lat, lon, d] of points) {
    const k = Math.round((n - lat) * ky / cell) * nx + Math.round((lon - w) * kx / cell);
    sum[k] += d; cnt[k]++;
  }
  const R = Math.max(2, Math.min(6, Math.round(30 / cell)));
  const raw = new Float32Array(nx * ny).fill(NaN);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    let ws = 0, vs = 0, bins = 0;
    for (let dj = -R; dj <= R; dj++) {
      const jj = j + dj; if (jj < 0 || jj >= ny) continue;
      for (let di = -R; di <= R; di++) {
        const ii = i + di; if (ii < 0 || ii >= nx) continue;
        const k = jj * nx + ii; if (!cnt[k]) continue;
        const d2 = di * di + dj * dj; if (d2 > R * R) continue;
        const wt = 1 / (d2 + 0.5);
        ws += wt; vs += wt * sum[k] / cnt[k]; bins++;
      }
    }
    if (bins >= 2 || cnt[j * nx + i]) raw[j * nx + i] = vs / ws;
  }
  // One light smoothing pass so lines follow the bottom rather than the boat's track.
  const v = new Float32Array(nx * ny).fill(NaN);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (Number.isNaN(raw[j * nx + i])) continue;
    let t = 0, c = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
      const x = raw[jj * nx + ii]; if (!Number.isNaN(x)) { t += x; c++; }
    }
    v[j * nx + i] = t / c;
  }
  let max = 0;
  for (const x of v) if (x > max) max = x;
  // Row 0 is the north edge. toLatLng takes fractional grid coordinates.
  return { v, nx, ny, max, cell, north: n, west: w, toLatLng: (i, j) => [n - j * cell / ky, w + i * cell / kx],
    bounds: [[n - (ny - 0.5) * cell / ky, w - 0.5 * cell / kx], [n + 0.5 * cell / ky, w + (nx - 0.5) * cell / kx]] };
}

// Marching squares for one depth: polylines in grid coordinates. Segments are joined through the cell edges they share.
export function trace(g, level) {
  const { v, nx, ny } = g;
  const links = new Map(), pts = new Map();
  const link = (a, b) => { (links.get(a) ?? links.set(a, []).get(a)).push(b); (links.get(b) ?? links.set(b, []).get(b)).push(a); };
  // Edge keys: h:i,j runs from corner (i,j) to (i+1,j); v:i,j from (i,j) to (i,j+1).
  const cross = (key, i1, j1, i2, j2) => {
    if (!pts.has(key)) { const a = v[j1 * nx + i1], b = v[j2 * nx + i2], t = (level - a) / (b - a); pts.set(key, [i1 + (i2 - i1) * t, j1 + (j2 - j1) * t]); }
    return key;
  };
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = v[j * nx + i], b = v[j * nx + i + 1], c = v[(j + 1) * nx + i + 1], d = v[(j + 1) * nx + i];
    if (Number.isNaN(a + b + c + d)) continue;
    const ia = a > level, ib = b > level, ic = c > level, id = d > level;
    const idx = ia | ib << 1 | ic << 2 | id << 3;
    if (idx === 0 || idx === 15) continue;
    const top = () => cross(`h${i},${j}`, i, j, i + 1, j), bottom = () => cross(`h${i},${j + 1}`, i, j + 1, i + 1, j + 1);
    const left = () => cross(`v${i},${j}`, i, j, i, j + 1), right = () => cross(`v${i + 1},${j}`, i + 1, j, i + 1, j + 1);
    const edges = [];
    if (ia !== ib) edges.push(top);
    if (ib !== ic) edges.push(right);
    if (ic !== id) edges.push(bottom);
    if (id !== ia) edges.push(left);
    if (edges.length === 2) { link(edges[0](), edges[1]()); continue; }
    // Saddle: cut off the corners that disagree with the cell's center.
    const center = (a + b + c + d) / 4 > level;
    if (ia !== center) link(top(), left());
    if (ib !== center) link(top(), right());
    if (ic !== center) link(right(), bottom());
    if (id !== center) link(bottom(), left());
  }
  const used = new Set(), seg = (p, q) => p < q ? p + '|' + q : q + '|' + p;
  const walk = start => {
    const line = [start];
    for (let cur = start; ;) {
      const next = links.get(cur).find(x => !used.has(seg(cur, x)));
      if (next === undefined) break;
      used.add(seg(cur, next)); line.push(next); cur = next;
      if (cur === start) break;
    }
    return line;
  };
  const lines = [];
  for (const [k, ns] of links) if (ns.length === 1) { const l = walk(k); if (l.length > 1) lines.push(l); }
  for (const [k] of links) { const l = walk(k); if (l.length > 1) lines.push(l); }
  return lines.map(l => l.map(k => pts.get(k)));
}

export const contourStep = max => max <= 15 ? 1 : max <= 40 ? 2 : max <= 100 ? 5 : max <= 250 ? 10 : 20;

// Shaded depth as an image the size of the grid; the browser smooths it when scaled up.
function fillImage(g) {
  const c = document.createElement('canvas');
  c.width = g.nx; c.height = g.ny;
  const ctx = c.getContext('2d'), img = ctx.createImageData(g.nx, g.ny);
  for (let k = 0; k < g.v.length; k++) {
    if (Number.isNaN(g.v[k])) continue;
    const [r, gr, b] = depthColor(g.v[k], g.max).match(/\d+/g).map(Number);
    img.data.set([r, gr, b, 200], k * 4);
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL();
}

let fillOn = true;
export async function showContours(lake) {
  const sets = await db.byLake('depthSets', lake.id);
  if (!sets.length) return status('Import a scan first');
  status('Building contours…');
  await new Promise(r => setTimeout(r, 30));
  const { points, ref, shifted, unleveled, dropped } = await mergedSoundings(lake, sets);
  if (points.length < 20) return status('Not enough soundings for contours');
  const g = buildGrid(points);
  const step = contourStep(g.max);
  depthLayer.clearLayers();
  const fill = L.imageOverlay(fillImage(g), g.bounds, { opacity: 0.75, interactive: false, className: 'depth-fill' });
  if (fillOn) fill.addTo(depthLayer);
  const labels = [], gap = Math.max(g.nx, g.ny) / 9;
  for (let level = step; level < g.max; level += step) {
    const major = level % (step * 5) === 0;
    for (const line of trace(g, level)) {
      if (line.length < 4) continue; // specks from single soundings
      const ll = line.map(([i, j]) => g.toLatLng(i, j));
      L.polyline(ll, { color: depthColor(level, g.max), weight: major ? 2.4 : 1.3, opacity: 0.95, smoothFactor: 0.5 })
        .bindTooltip(`${level} ft`, { sticky: true }).addTo(depthLayer);
      // One label per longer line, at the first spot along it that's clear of the labels already placed.
      if (line.length < 16) continue;
      const spot = [0.5, 0.3, 0.7, 0.15, 0.85, 0.05, 0.95].map(f => Math.floor(f * (line.length - 1))).find(k => labels.every(l => Math.hypot(l.ij[0] - line[k][0], l.ij[1] - line[k][1]) > gap));
      if (spot !== undefined) labels.push({ at: ll[spot], ij: line[spot], level });
    }
  }
  for (const { at, level } of labels) L.marker(at, { icon: L.divIcon({ className: 'clabel', html: `<span>${level}</span>`, iconSize: null }), interactive: false, keyboard: false }).addTo(depthLayer);
  const legend = $('#depth-legend');
  const grad = [0, .25, .5, .75, 1].map(t => depthColor(t * g.max, g.max)).join(',');
  const datum = ref?.station ? `Depths at today's level, ${Math.round(ref.levelFt).toLocaleString()} ft (CDEC ${esc(ref.station)})` : ref ? (ref.date ? `Depths at the level of ${fmtDate(`${ref.date}T12:00`)}` : `Depths at a lake level of ${Math.round(ref.levelFt).toLocaleString()} ft`) : 'Depths as scanned (no lake level for these scans)';
  legend.innerHTML = `<b>${esc(lake.name)}: your scans</b><div class="bar" style="background:linear-gradient(90deg,${grad})"></div>0 ft <span style="float:right">${Math.round(g.max)} ft</span>
    <div class="muted" style="font-size:11px">Every ${step} ft · ${sets.length} scan${sets.length > 1 ? 's' : ''}, ${points.length.toLocaleString()} soundings<br>${datum}${shifted ? `, ${shifted} shifted` : ''}${unleveled ? ` · ${unleveled} without a level` : ''}${dropped ? `<br>${dropped.toLocaleString()} stray GPS points ignored` : ''}</div>
    <label style="font-size:12px"><input type="checkbox" id="depth-fill" ${fillOn ? 'checked' : ''}> Shading</label> · <a href="#" id="hide-depth">Hide</a>`;
  legend.classList.remove('hidden');
  $('#depth-fill').onchange = e => { fillOn = e.target.checked; fillOn ? fill.addTo(depthLayer) : depthLayer.removeLayer(fill); };
  $('#hide-depth').onclick = e => { e.preventDefault(); depthLayer.clearLayers(); legend.classList.add('hidden'); };
  if (!map.hasLayer(depthLayer)) depthLayer.addTo(map);
  status('');
  showView('map');
  map.fitBounds(g.bounds);
}
