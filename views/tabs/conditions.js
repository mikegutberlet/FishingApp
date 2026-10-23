// Conditions tab: weather alerts, weather now, bite windows, 24 hours and 10 days, wind on the water,
// lake level (CDEC), USGS gauges with flow vs normal, and Windy.
import * as CA from '../../states/ca.js';
import { pressureTrend, fetchUsgsNearby, moonPhase, WEATHER_CODES, compass } from '../../data-sources.js';
import { weatherFor, fetchAlerts, alertLevel, fetchFlowStats, flowRating, hourIndex, dayIndex, localKey, levelChange } from '../../forecast.js';
import { solunar, dayRating, stars, windowAt, windowsAround, windowLabel, windowSpan, shortTime } from '../../solunar.js';
import { windOnWater, windText, windSvg } from '../../wind.js';
import { $, esc, fmtDate, fmtTime, arrow } from '../../ui.js';

export async function renderConditions(lake, body) {
  const moon = moonPhase();
  body.innerHTML = `<div id="alerts"></div><div class="card" id="wx">Loading weather…</div><div class="card hidden" id="bite"></div><div class="card hidden" id="windcard"></div>
    <div class="card hidden" id="res"></div><div class="card" id="water">Looking for USGS gauges…</div>
    <div class="card"><h3>Windy</h3>
      <iframe class="windy" loading="lazy" src="https://embed.windy.com/embed2.html?lat=${lake.lat}&lon=${lake.lon}&detailLat=${lake.lat}&detailLon=${lake.lon}&zoom=10&level=surface&overlay=wind&product=ecmwf&menu=&message=true&marker=true&calendar=now&pressure=true&type=map&location=coordinates&detail=true&metricWind=mph&metricTemp=%C2%B0F"></iframe>
      <p class="small"><a href="https://www.windy.com/${lake.lat.toFixed(3)}/${lake.lon.toFixed(3)}?${lake.lat.toFixed(3)},${lake.lon.toFixed(3)},11" target="_blank" rel="noopener">Open in Windy (uses your Premium login)</a>
      · <a href="https://myradar.com/" target="_blank" rel="noopener">Open MyRadar</a> · radar is also on the map (layers ▸ Rain radar)</p></div>`;
  fetchAlerts(lake.lat, lake.lon).then(alerts => {
    if (!body.isConnected || !alerts.length) return;
    $('#alerts').innerHTML = alerts.sort((a, b) => alertLevel(b) - alertLevel(a)).map(a => `<details class="alert sev-${alertLevel(a)}">
      <summary>⚠️ <b>${esc(a.event)}</b>${a.ends ? ` <span class="small">until ${esc(new Date(a.ends).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }))}</span>` : ''}</summary>
      ${a.headline ? `<p class="small"><b>${esc(a.headline)}</b></p>` : ''}<p class="small">${esc(a.description).replace(/\n\n/g, '<br><br>')}</p>
      ${a.instruction ? `<p class="small">${esc(a.instruction).replace(/\n\n/g, '<br><br>')}</p>` : ''}<p class="muted small">${esc(a.sender)} · National Weather Service</p></details>`).join('');
  }).catch(() => {}); // outside the US, or NWS down: no banner
  // Bite windows are computed on the device, so they show even with no signal.
  const now = Date.now();
  const sols = new Map(); // bite windows per local day
  const solFor = d => { const k = localKey(d); if (!sols.has(k)) sols.set(k, solunar(new Date(d), lake.lat, lake.lon)); return sols.get(k); };
  const around = windowsAround(now, lake.lat, lake.lon, solFor);
  const biteAt = t => windowAt(windowsAround(Date.parse(t), lake.lat, lake.lon, solFor), Date.parse(t));
  try {
    const w = await weatherFor(lake.lat, lake.lon);
    if (!body.isConnected) return; // user moved on before the forecast arrived
    const c = w.current, trend = pressureTrend(w), di = dayIndex(w, now), hi = hourIndex(w, now);
    const hours = w.hourly.time.slice(hi, hi + 24).map((t, k) => ({ t, i: hi + k }));
    $('#wx').innerHTML = `<h3>Now · ${WEATHER_CODES[c.weather_code] ?? ''}</h3>
      <div class="grid">
        <div class="stat"><b>${Math.round(c.temperature_2m)}°F</b><span>Feels ${Math.round(c.apparent_temperature)}°</span></div>
        <div class="stat"><b>${arrow(c.wind_direction_10m)} ${Math.round(c.wind_speed_10m)} mph</b><span>${compass(c.wind_direction_10m)}, gusts ${Math.round(c.wind_gusts_10m)}</span></div>
        <div class="stat"><b>${(c.pressure_msl * 0.02953).toFixed(2)}"</b><span>Pressure${trend ? ` · ${trend.label}` : ''}</span></div>
        <div class="stat"><b>${c.cloud_cover}%</b><span>Cloud cover</span></div>
        <div class="stat"><b>${moon.illumination}%</b><span>${moon.name}</span></div>
        <div class="stat"><b>☀ ${fmtTime(w.daily.sunrise[di])}</b><span>Sunset ${fmtTime(w.daily.sunset[di])}</span></div>
      </div>
      <h3 style="margin-top:12px">Next 24 hours</h3>
      <div class="hours">${hours.map(({ t, i }) => { const b = biteAt(t); return `<div class="hour${b ? ' ' + b.type : ''}">${fmtTime(t)}<br><b>${Math.round(w.hourly.temperature_2m[i])}°</b><br>${arrow(w.hourly.wind_direction_10m[i])} ${Math.round(w.hourly.wind_speed_10m[i])}<br><span class="muted">g${Math.round(w.hourly.wind_gusts_10m[i])}</span><br>${w.hourly.precipitation_probability[i] ?? 0}%💧${b ? `<div class="bite-tag">${b.type === 'major' ? '🐟 Major' : 'Minor'}</div>` : ''}</div>`; }).join('')}</div>
      <h3 style="margin-top:12px">10 days</h3>
      <table class="days">${w.daily.time.slice(di, di + 10).map((t, j) => {
        const i = di + j, sol = solFor(Date.parse(t + 'T12:00')), r = dayRating(sol, w.daily.sunrise[i], w.daily.sunset[i]);
        return `<tr><td>${new Date(t + 'T12:00').toLocaleDateString(undefined, { weekday: 'short' })}</td><td>${WEATHER_CODES[w.daily.weather_code[i]] ?? ''}</td><td>${Math.round(w.daily.temperature_2m_min[i])}–${Math.round(w.daily.temperature_2m_max[i])}°</td><td>${arrow(w.daily.wind_direction_10m_dominant[i])} ${Math.round(w.daily.wind_speed_10m_max[i])} (g${Math.round(w.daily.wind_gusts_10m_max[i])})</td><td>${w.daily.precipitation_probability_max[i] ?? 0}%</td></tr>
          <tr class="bite-row"><td colspan="5"><span class="stars" title="Solunar rating ${r} of 4">${stars(r)}</span> Major ${sol.majors.map(m => shortTime(m.peak)).join(', ') || '–'}${sol.minors.length ? ` · minor ${sol.minors.map(m => shortTime(m.peak)).join(', ')}` : ''}</td></tr>`;
      }).join('')}</table>
      <p class="muted small">Open-Meteo forecast · moon and bite windows computed on device · times are peak of each window</p>`;
    renderBite(solFor(now), around, now, w.daily.sunrise[di], w.daily.sunset[di]);
    const x = windOnWater(w);
    $('#windcard').innerHTML = `<h3>Wind on the water</h3><div class="wind-card">${windSvg(x)}<div class="small">${windText(x)}</div></div>`;
    $('#windcard').classList.remove('hidden');
  } catch (e) {
    if (!body.isConnected) return;
    $('#wx').textContent = `Weather: ${e.message} (offline?)`;
    renderBite(solFor(now), around, now);
  }
  CA.nearestReservoir(lake.lat, lake.lon, lake.cdecStation, { name: lake.name, acres: lake.acres }).then(r => {
    if (!r || !body.isConnected) return;
    const el = $('#res'), e = r.elevation, s = r.storage;
    const change = days => levelChange(e, days);
    const signed = v => v == null ? '–' : `${v > 0 ? '+' : ''}${v.toFixed(1)} ft`;
    el.innerHTML = `<h3>Lake level · ${esc(r.name)}</h3><div class="grid">
      ${e.length ? `<div class="stat"><b>${e.at(-1)[1].toLocaleString()} ft</b><span>Elevation ${fmtDate(e.at(-1)[0] + 'T12:00')}</span></div>
      <div class="stat"><b>${signed(change(7))}</b><span>Last 7 days</span></div><div class="stat"><b>${signed(change(30))}</b><span>Last 30 days</span></div>` : ''}
      ${s.length ? `<div class="stat"><b>${Math.round(s.at(-1)[1]).toLocaleString()}</b><span>Storage, acre-ft</span></div>` : ''}</div>
      <p class="muted small">CDEC station ${esc(r.id)} · ${r.distKm.toFixed(1)} km away${lake.cdecStation ? '' : ' · wrong lake? set the station under Edit'}</p>`;
    el.classList.remove('hidden');
  });
  try {
    let sites = await fetchUsgsNearby(lake.lat, lake.lon);
    if (!body.isConnected) return;
    if (lake.usgsSite) sites = sites.filter(s => s.id === lake.usgsSite).concat(sites.filter(s => s.id !== lake.usgsSite));
    sites = sites.slice(0, 3);
    $('#water').innerHTML = `<h3>Water (USGS)</h3>` + (sites.length ? sites.map(s => `<p><b>${esc(s.name)}</b> <span class="muted small">#${esc(s.id)} · ${s.distKm.toFixed(1)} km</span><br>
      ${s.readings.map(r => r.code === '00010' ? `Water temp: <b>${(r.value * 9 / 5 + 32).toFixed(1)}°F</b>` : `${esc(r.name.split(',')[0])}: <b>${r.value} ${esc(r.unit)}</b>`).join('<br>')}
      <span class="flow" data-site="${esc(s.id)}"></span>
      <br><span class="muted small">${fmtDate(s.readings[0].time)} ${fmtTime(s.readings[0].time)}</span></p>`).join('') : '<p class="muted">No active gauges nearby. Common for natural lakes; rivers and reservoirs usually have one.</p>');
    const river = lake.kind === 'river' || /river|creek|stream|fork/i.test(`${lake.type} ${lake.name}`);
    for (const s of sites) {
      const q = s.readings.find(r => r.code === '00060');
      if (!q) continue;
      fetchFlowStats(s.id).then(st => {
        const f = flowRating(q.value, st), el = body.querySelector(`.flow[data-site="${CSS.escape(s.id)}"]`);
        if (!f || !el) return;
        el.innerHTML = `<br>Flow: <b>${f.pct}% of normal</b> for ${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}${river ? ` <span class="chip ${f.tone}">${f.label}</span>` : ''}
          <br><span class="muted small">Median ${Math.round(st.p50).toLocaleString()} cfs, middle half ${Math.round(st.p25).toLocaleString()}–${Math.round(st.p75).toLocaleString()} cfs (${esc(st.from)}–${esc(st.to)}, ${st.years} yrs)</span>
          ${river ? `<br><span class="small">${f.tip}</span>` : ''}`;
      }).catch(() => {});
    }
  } catch (e) { if (body.isConnected) $('#water').textContent = `USGS: ${e.message}`; }
}

// Today's bite windows, and which one is on now or next (including one that started before midnight).
// Without a forecast (offline) the rating leaves out the sunrise/sunset bonus.
function renderBite(sol, around, now, sunrise, sunset) {
  const r = dayRating(sol, sunrise, sunset);
  const next = around.find(x => x.end > now);
  const later = next && localKey(next.start) !== localKey(now) && next.start > now;
  const el = $('#bite');
  el.innerHTML = `<h3>Bite windows today <span class="stars" title="Solunar rating ${r} of 4">${stars(r)}</span></h3>
    ${next ? `<p>${next.start <= now ? '🐟 <b>On now</b>' : `Next: <b>${later ? 'tomorrow ' : ''}${shortTime(next.start)}</b>`}, ${windowLabel(next).toLowerCase()} until ${shortTime(next.end)}</p>` : ''}
    <table>${sol.windows.map(x => `<tr class="${x.end < now ? 'muted' : ''}"><td>${x.type === 'major' ? '🐟🐟' : '🐟'}</td><td>${windowSpan(x)}</td><td>${windowLabel(x)}</td></tr>`).join('')}</table>
    <p class="muted small">${esc(sol.phase.name)}${sol.moonrise ? ` · moonrise ${shortTime(sol.moonrise)}` : ''}${sol.moonset ? ` · moonset ${shortTime(sol.moonset)}` : ''}.
      Solunar theory: fish feed more around moon overhead/underfoot (major, 2 h) and moonrise/set (minor, 1 h); best near new and full moon and when a window meets sunrise or sunset.</p>`;
  el.classList.remove('hidden');
}
