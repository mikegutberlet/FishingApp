// Conditions tab: weather now, 24 hours and 10 days, lake level (CDEC), USGS gauges and Windy.
import * as CA from '../../states/ca.js';
import { fetchWeather, pressureTrend, fetchUsgsNearby, moonPhase, WEATHER_CODES, compass } from '../../data-sources.js';
import { $, esc, fmtDate, fmtTime, arrow } from '../../ui.js';

export async function renderConditions(lake, body) {
  const moon = moonPhase();
  body.innerHTML = `<div class="card" id="wx">Loading weather…</div><div class="card hidden" id="res"></div><div class="card" id="water">Looking for USGS gauges…</div>
    <div class="card"><h3>Windy</h3>
      <iframe class="windy" loading="lazy" src="https://embed.windy.com/embed2.html?lat=${lake.lat}&lon=${lake.lon}&detailLat=${lake.lat}&detailLon=${lake.lon}&zoom=10&level=surface&overlay=wind&product=ecmwf&menu=&message=true&marker=true&calendar=now&pressure=true&type=map&location=coordinates&detail=true&metricWind=mph&metricTemp=%C2%B0F"></iframe>
      <p class="small"><a href="https://www.windy.com/${lake.lat.toFixed(3)}/${lake.lon.toFixed(3)}?${lake.lat.toFixed(3)},${lake.lon.toFixed(3)},11" target="_blank" rel="noopener">Open in Windy (uses your Premium login)</a>
      · <a href="https://myradar.com/" target="_blank" rel="noopener">Open MyRadar</a></p></div>`;
  try {
    const w = await fetchWeather(lake.lat, lake.lon);
    if (!body.isConnected) return; // user moved on before the forecast arrived
    const c = w.current, trend = pressureTrend(w);
    const now = Date.parse(c.time);
    const hours = w.hourly.time.map((t, i) => ({ t, i })).filter(({ t }) => Date.parse(t) >= now).slice(0, 24);
    $('#wx').innerHTML = `<h3>Now · ${WEATHER_CODES[c.weather_code] ?? ''}</h3>
      <div class="grid">
        <div class="stat"><b>${Math.round(c.temperature_2m)}°F</b><span>Feels ${Math.round(c.apparent_temperature)}°</span></div>
        <div class="stat"><b>${arrow(c.wind_direction_10m)} ${Math.round(c.wind_speed_10m)} mph</b><span>${compass(c.wind_direction_10m)}, gusts ${Math.round(c.wind_gusts_10m)}</span></div>
        <div class="stat"><b>${(c.pressure_msl * 0.02953).toFixed(2)}"</b><span>Pressure${trend ? ` · ${trend.label}` : ''}</span></div>
        <div class="stat"><b>${c.cloud_cover}%</b><span>Cloud cover</span></div>
        <div class="stat"><b>${moon.illumination}%</b><span>${moon.name}</span></div>
        <div class="stat"><b>☀ ${fmtTime(w.daily.sunrise[1])}</b><span>Sunset ${fmtTime(w.daily.sunset[1])}</span></div>
      </div>
      <h3 style="margin-top:12px">Next 24 hours</h3>
      <div class="hours">${hours.map(({ t, i }) => `<div class="hour">${fmtTime(t)}<br><b>${Math.round(w.hourly.temperature_2m[i])}°</b><br>${arrow(w.hourly.wind_direction_10m[i])} ${Math.round(w.hourly.wind_speed_10m[i])}<br><span class="muted">g${Math.round(w.hourly.wind_gusts_10m[i])}</span><br>${w.hourly.precipitation_probability[i] ?? 0}%💧</div>`).join('')}</div>
      <h3 style="margin-top:12px">10 days</h3>
      <table>${w.daily.time.slice(1).map((t, j) => { const i = j + 1; return `<tr><td>${new Date(t + 'T12:00').toLocaleDateString(undefined, { weekday: 'short' })}</td><td>${WEATHER_CODES[w.daily.weather_code[i]] ?? ''}</td><td>${Math.round(w.daily.temperature_2m_min[i])}–${Math.round(w.daily.temperature_2m_max[i])}°</td><td>${arrow(w.daily.wind_direction_10m_dominant[i])} ${Math.round(w.daily.wind_speed_10m_max[i])} (g${Math.round(w.daily.wind_gusts_10m_max[i])})</td><td>${w.daily.precipitation_probability_max[i] ?? 0}%</td></tr>`; }).join('')}</table>
      <p class="muted small">Open-Meteo forecast · moon phase computed on device</p>`;
  } catch (e) { if (body.isConnected) $('#wx').textContent = `Weather: ${e.message} (offline?)`; }
  CA.nearestReservoir(lake.lat, lake.lon, lake.cdecStation, { name: lake.name, acres: lake.acres }).then(r => {
    if (!r || !body.isConnected) return;
    const el = $('#res'), e = r.elevation, s = r.storage;
    const change = days => e.length > days ? (e.at(-1)[1] - e.at(-1 - days)[1]) : null;
    const signed = v => v == null ? '–' : `${v > 0 ? '+' : ''}${v.toFixed(1)} ft`;
    el.innerHTML = `<h3>Lake level · ${esc(r.name)}</h3><div class="grid">
      ${e.length ? `<div class="stat"><b>${e.at(-1)[1].toLocaleString()} ft</b><span>Elevation ${fmtDate(e.at(-1)[0] + 'T12:00')}</span></div>
      <div class="stat"><b>${signed(change(7))}</b><span>Last 7 days</span></div><div class="stat"><b>${signed(change(29))}</b><span>Last 30 days</span></div>` : ''}
      ${s.length ? `<div class="stat"><b>${Math.round(s.at(-1)[1]).toLocaleString()}</b><span>Storage, acre-ft</span></div>` : ''}</div>
      <p class="muted small">CDEC station ${esc(r.id)} · ${r.distKm.toFixed(1)} km away${lake.cdecStation ? '' : ' · wrong lake? set the station under Edit'}</p>`;
    el.classList.remove('hidden');
  });
  try {
    let sites = await fetchUsgsNearby(lake.lat, lake.lon);
    if (!body.isConnected) return;
    if (lake.usgsSite) sites = sites.filter(s => s.id === lake.usgsSite).concat(sites.filter(s => s.id !== lake.usgsSite));
    $('#water').innerHTML = `<h3>Water (USGS)</h3>` + (sites.length ? sites.slice(0, 3).map(s => `<p><b>${esc(s.name)}</b> <span class="muted small">#${s.id} · ${s.distKm.toFixed(1)} km</span><br>
      ${s.readings.map(r => r.code === '00010' ? `Water temp: <b>${(r.value * 9 / 5 + 32).toFixed(1)}°F</b>` : `${esc(r.name.split(',')[0])}: <b>${r.value} ${esc(r.unit)}</b>`).join('<br>')}
      <br><span class="muted small">${fmtDate(s.readings[0].time)} ${fmtTime(s.readings[0].time)}</span></p>`).join('') : '<p class="muted">No active gauges nearby. Common for natural lakes; rivers and reservoirs usually have one.</p>');
  } catch (e) { if (body.isConnected) $('#water').textContent = `USGS: ${e.message}`; }
}
