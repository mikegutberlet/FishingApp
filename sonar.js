// The extra columns in sonar exports that the depth parsers in data-sources.js skip: when each sounding was taken,
// and water temperature. A Deeper floats, so its temperature is the surface temperature where it was.
import { parseCsv } from './data-sources.js';

const num = v => v == null || String(v).trim() === '' ? NaN : +v; // a blank cell is no reading, not 0
const toF = (v, celsius) => celsius ? v * 9 / 5 + 32 : v;
const toTime = v => {
  if (v == null || v === '') return NaN;
  if (/^\d{9,13}(\.\d+)?$/.test(v)) return +v > 1e11 ? +v : +v * 1000; // epoch ms or seconds
  return Date.parse(v);
};
// Celsius unless the header says Fahrenheit; water in °F never reads below 32, water in °C rarely above 32.
const isCelsius = (header, values) => /\(c\)|°c|celsius|_c$/.test(header) ? true : /\(f\)|°f|fahrenheit|_f$/.test(header) ? false
  : values.sort((a, b) => a - b)[values.length >> 1] <= 32;

// { times: ms per sounding (may be empty), temps: [[lat, lon, tempF, ms]] } from a CSV or GPX/KML export.
export function sonarExtras(text, isXml) {
  const rows = [];
  let celsius = true;
  if (isXml) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    for (const pt of doc.querySelectorAll('trkpt, wpt, rtept')) {
      const all = [...pt.getElementsByTagName('*')];
      const temp = all.find(e => /^wtemp$|water.?temp/i.test(e.localName)) ?? all.find(e => /temp/i.test(e.localName) && !/^atemp$/i.test(e.localName));
      rows.push([num(pt.getAttribute('lat')), num(pt.getAttribute('lon')), temp ? num(temp.textContent) : NaN, toTime(pt.querySelector('time')?.textContent)]);
    }
    celsius = isCelsius('', rows.map(r => r[2]).filter(Number.isFinite));
  } else {
    const { header, rows: lines } = parseCsv(text);
    const find = (...names) => header.findIndex(h => names.some(n => h === n || h.startsWith(n)));
    const iLat = find('lat', 'latitude'), iLon = find('lon', 'lng', 'long', 'longitude');
    const iTemp = header.findIndex(h => /temp/.test(h) && !/air/.test(h));
    const iTime = header.findIndex(h => /timestamp|datetime|^time|^date|utc/.test(h));
    const iClock = header.findIndex((h, i) => i !== iTime && /^time/.test(h)); // separate date and time columns
    // Date and time in separate columns: join ISO dates with T, which every browser parses (iOS Safari rejects a space).
    const when = r => iClock < 0 ? r[iTime] : `${r[iTime]}${/^\d{4}-\d\d-\d\d$/.test(r[iTime]) ? 'T' : ' '}${r[iClock]}`;
    for (const r of lines) rows.push([num(r[iLat]), num(r[iLon]), iTemp >= 0 ? num(r[iTemp]) : NaN, iTime >= 0 ? toTime(when(r)) : NaN]);
    if (iTemp >= 0) celsius = isCelsius(header[iTemp], rows.map(r => r[2]).filter(Number.isFinite));
  }
  const times = rows.map(r => r[3]).filter(Number.isFinite);
  let temps = rows.filter(r => Number.isFinite(r[0]) && Number.isFinite(r[1]) && Number.isFinite(r[2]) && r[2] > -5 && r[2] < 110).map(([lat, lon, t, ms]) => [lat, lon, +toF(t, celsius).toFixed(1), ms]);
  // Keep at most ~3000 readings: plenty for the log and the map, and backups stay small.
  if (temps.length > 3000) { const step = temps.length / 3000; temps = Array.from({ length: 3000 }, (_, i) => temps[Math.floor(i * step)]); }
  return { times, temps };
}

// The local date (YYYY-MM-DD) the scan was taken, from its timestamps.
export function scanDateOf(times) {
  if (!times.length) return null;
  const d = new Date(times.slice().sort((a, b) => a - b)[times.length >> 1]);
  return isNaN(d) || d.getFullYear() < 2010 ? null : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
