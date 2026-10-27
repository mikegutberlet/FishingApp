// Marine tab (ocean waters): NWS advisories (small craft, gale, high surf, rip currents…), waves, swell and sea
// temperature (Open-Meteo Marine), wind in knots, and the NWS Coastal Waters Forecast for the spot's zone.
import { fetchAlerts, alertLevel, weatherFor, hourIndex, forecastAge } from '../../forecast.js';
import { marineFor, marineZoneNear, zoneForecast, zonePageUrl, isMarineEvent } from '../../coast.js';
import { compass } from '../../data-sources.js';
import { esc, arrow } from '../../ui.js';

const KT = 0.868976; // knots per mph
const when = iso => new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const cToF = c => c == null ? null : Math.round(c * 9 / 5 + 32);

export async function renderMarine(lake, body) {
  body.innerHTML = `<div id="oc-alerts"></div><div class="card" id="oc-waves">Loading waves and swell…</div><div class="card" id="oc-wind">Loading wind…</div><div class="card" id="oc-zone">Finding the marine forecast zone…</div>`;
  const $ = s => body.querySelector(s);
  fetchAlerts(lake.lat, lake.lon).then(list => {
    if (!body.isConnected) return;
    const sorted = [...list].sort((a, b) => isMarineEvent(b.event) - isMarineEvent(a.event) || alertLevel(b) - alertLevel(a));
    $('#oc-alerts').innerHTML = sorted.length ? sorted.map(a => `<details class="alert sev-${Math.max(alertLevel(a), isMarineEvent(a.event) ? 1 : 0)}"><summary>${isMarineEvent(a.event) ? '🌊' : '⚠️'} <b>${esc(a.event)}</b>${a.ends ? ` <span class="small">until ${esc(when(a.ends))}</span>` : ''}</summary>
      ${a.headline ? `<p class="small"><b>${esc(a.headline)}</b></p>` : ''}<p class="small">${esc(a.description).replace(/\n\n/g, '<br><br>')}</p>${a.instruction ? `<p class="small">${esc(a.instruction)}</p>` : ''}<p class="muted small">${esc(a.sender)} · National Weather Service</p></details>`).join('')
      + (list.savedAt ? `<p class="muted small">📴 Advisories as of ${esc(when(list.savedAt))}, saved on this phone.</p>` : '')
      : `<p class="muted small oc-noalert">✅ No marine or coastal advisories in effect here${list.savedAt ? ` (as of ${esc(when(list.savedAt))})` : ''}.</p>`;
  }).catch(() => {});

  marineFor(lake.lat, lake.lon).then(({ data: m, savedAt }) => { if (body.isConnected) $('#oc-waves').innerHTML = wavesHtml(m, savedAt); })
    .catch(e => { if (body.isConnected) $('#oc-waves').innerHTML = `<h3>Waves & swell</h3><p class="muted small">No wave forecast (${esc(e.message)}). Bays and harbors are often too sheltered for the wave model.</p>`; });

  weatherFor(lake.lat, lake.lon).then(w => {
    if (!body.isConnected) return;
    const i = hourIndex(w, Date.now()), hrs = w.hourly.time.slice(i, i + 12).map((t, k) => i + k);
    $('#oc-wind').innerHTML = `<h3>Wind (knots)</h3>${w.saved ? `<p class="saved-wx small">📴 Saved forecast, ${esc(forecastAge(w))}.</p>` : ''}
      <div class="hours">${hrs.map(k => `<div class="hour">${new Date(w.hourly.time[k]).toLocaleTimeString(undefined, { hour: 'numeric' })}<br><b>${arrow(w.hourly.wind_direction_10m[k])} ${Math.round(w.hourly.wind_speed_10m[k] * KT)}</b><br><span class="muted">g${Math.round(w.hourly.wind_gusts_10m[k] * KT)}</span></div>`).join('')}</div>
      <p class="muted small">Small Craft Advisories on this coast usually start around 20–33 kt sustained or steep seas. Fog: check the zone forecast below.</p>`;
  }).catch(() => { if (body.isConnected) $('#oc-wind').remove(); });

  try {
    const zone = await marineZoneNear(lake.lat, lake.lon);
    if (!body.isConnected) return;
    if (!zone) { $('#oc-zone').innerHTML = `<h3>Marine forecast</h3><p class="muted small">Couldn’t find this spot’s NWS marine zone.</p>`; return; }
    $('#oc-zone').innerHTML = `<h3>Marine forecast · ${esc(zone.id)}</h3><p class="small">${esc(zone.name)}</p><p class="muted small">Loading…</p>`;
    const { data: fc, savedAt } = await zoneForecast(zone.id, zone.office);
    if (!body.isConnected) return;
    $('#oc-zone').innerHTML = `<h3>Marine forecast · ${esc(zone.id)}</h3><p class="small">${esc(zone.name)}</p>
      ${savedAt ? `<p class="saved-wx small">📴 Saved forecast from ${esc(when(savedAt))}.</p>` : ''}
      ${fc.headlines.map(h => `<div class="banner hab-warning small"><b>${esc(h.charAt(0) + h.slice(1).toLowerCase())}</b></div>`).join('')}
      <table class="oc-zfc">${fc.periods.slice(0, 6).map(p => `<tr><th>${esc(p.name.charAt(0) + p.name.slice(1).toLowerCase())}</th><td class="small">${esc(p.text)}</td></tr>`).join('')}</table>
      ${fc.synopsis ? `<details><summary class="small">Synopsis</summary><p class="small">${esc(fc.synopsis)}</p></details>` : ''}
      <p class="muted small">NWS ${esc(fc.office)} Coastal Waters Forecast, issued ${esc(when(fc.issued))}. Wind in knots. <a href="${zonePageUrl(zone.id)}" target="_blank" rel="noopener">NWS page ↗</a></p>`;
  } catch (e) {
    if (body.isConnected) $('#oc-zone').innerHTML = `<h3>Marine forecast</h3><p class="muted small">Marine forecast unavailable (${esc(e.message)}).</p>`;
  }
}

export function wavesHtml(m, savedAt, now = Date.now()) {
  const h = m.hourly, i = Math.max(0, h.time.findIndex(t => Date.parse(t) > now) - 1);
  const v = (k, j = i) => h[k]?.[j];
  const days = m.daily?.time?.slice(0, 5) ?? [];
  const sst = cToF(v('sea_surface_temperature'));
  return `<h3>Waves & swell</h3>${savedAt ? `<p class="saved-wx small">📴 Saved forecast from ${esc(when(savedAt))}.</p>` : ''}
    <div class="grid">
      <div class="stat"><b>${v('wave_height')?.toFixed(1) ?? '–'} ft</b><span>Seas, ${v('wave_period') ? Math.round(v('wave_period')) + ' s' : ''}</span></div>
      <div class="stat"><b>${v('swell_wave_height') != null ? `${arrow(v('swell_wave_direction'))} ${v('swell_wave_height').toFixed(1)} ft` : '–'}</b><span>Swell${v('swell_wave_period') ? ` ${Math.round(v('swell_wave_period'))} s from ${compass(v('swell_wave_direction'))}` : ''}</span></div>
      ${sst != null ? `<div class="stat"><b>${sst}°F</b><span>Sea surface</span></div>` : ''}
    </div>
    ${days.length ? `<table class="days">${days.map((d, j) => `<tr><td>${new Date(d + 'T12:00').toLocaleDateString(undefined, { weekday: 'short' })}</td><td>Seas to ${m.daily.wave_height_max[j]?.toFixed(1) ?? '–'} ft</td><td>Swell to ${m.daily.swell_wave_height_max?.[j]?.toFixed(1) ?? '–'} ft${m.daily.swell_wave_period_max?.[j] ? ` @ ${Math.round(m.daily.swell_wave_period_max[j])} s` : ''}</td></tr>`).join('')}</table>` : ''}
    <p class="muted small">Open-Meteo Marine model for open water near this spot (not breaking surf height at the beach). Long-period swell (14 s and up) breaks bigger than it looks and sweeps jetties and rocks.</p>`;
}
