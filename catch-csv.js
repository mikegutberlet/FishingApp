// Your catch log as a spreadsheet (CSV) for Excel, Numbers or Google Sheets, made on this device.
// Sizes are in your display units. No photos; the spot is included because the file is yours.
import { db } from './db.js';
import { units, toLen, toWt, toDepth, toTemp } from './units.js';
import { compass } from './data-sources.js';
import { tackleLabel } from './views/tackle.js';
import { saveFile } from './backup.js';
import { weightEstimate } from './views/log.js';

// A cell, quoted when needed. Text starting with = + - @ is prefixed with ' so a spreadsheet doesn't run it as a formula.
const cell = v => {
  if (v == null || v === '') return '';
  let s = String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function catchesCsv(catches) {
  const [lakes, tackle] = await Promise.all([db.all('lakes'), db.all('tackle')]);
  const lakeName = Object.fromEntries(lakes.map(l => [l.id, l.name]));
  const lure = Object.fromEntries(tackle.map(t => [t.id, tackleLabel(t)]));
  const u = units();
  const head = ['Date', 'Time', 'Water', 'Species', `Length (${u.length})`, `Weight (${u.weight})`, `Estimated weight (${u.weight})`, 'Released',
    'Lure / bait', 'Technique', `Depth (${u.depth})`, `Water temp (°${u.temp})`, 'Clarity', 'Tags', 'Notes',
    `Air temp (°${u.temp})`, 'Wind (mph)', 'Wind from', 'Gusts (mph)', 'Pressure (inHg)', 'Pressure trend', 'Sky', 'Moon', 'Latitude', 'Longitude', 'On a trip'];
  const two = n => String(n).padStart(2, '0');
  const rows = [...catches].sort((a, b) => a.time.localeCompare(b.time)).map(c => {
    const d = new Date(c.time), k = c.conditions ?? {};
    return [`${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`, `${two(d.getHours())}:${two(d.getMinutes())}`, lakeName[c.lakeId] ?? '', c.species,
      toLen(c.length), toWt(c.weight), toWt(weightEstimate(c)), c.released ? 'yes' : 'no', c.lure || lure[c.tackleId] || '', c.technique, toDepth(c.depth), toTemp(c.waterTemp), c.clarity,
      (c.tags ?? []).join(', '), c.notes, k.airTemp != null ? Math.round(toTemp(k.airTemp)) : '', k.wind != null ? Math.round(k.wind) : '', k.windDir != null ? compass(k.windDir) : '',
      k.gusts != null ? Math.round(k.gusts) : '', k.pressureInHg, k.pressureTrend, k.sky, c.moon, c.lat, c.lon, c.tripId ? 'yes' : 'no'];
  });
  // A byte order mark so Excel reads accented names as UTF-8.
  return '﻿' + [head, ...rows].map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

export async function exportCatchesCsv(catches) {
  catches ??= await db.all('catches');
  if (!catches.length) return alert('No catches to export yet');
  const d = new Date();
  const name = `tackle-box-catches-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.csv`;
  const file = new File([await catchesCsv(catches)], name, { type: 'text/csv' });
  return saveFile(file, { title: 'Catch log' });
}
