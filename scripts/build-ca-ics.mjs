// Writes one calendar feed per CDFW stocked water, data/ca/ics/<stockId>.ics, from data/ca/plants.json.
// Runs nightly after the plant schedule updates (see .github/workflows/update-safety.yml). Calendar apps that
// subscribe fetch the file from GitHub Pages, so plant alerts work without any server knowing who subscribed.
// Output is deterministic (no "now" timestamps), so a feed only changes when its plants do.

import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';

const OUT = new URL('../data/ca/', import.meta.url);
const ICS = new URL('ics/', OUT);
const readJson = async name => JSON.parse(await readFile(new URL(name, OUT), 'utf8'));

const esc = s => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
// RFC 5545: lines longer than 75 octets are folded with CRLF + space.
function fold(line) {
  const bytes = Buffer.from(line);
  if (bytes.length <= 75) return line;
  const parts = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(bytes.length, start + (start ? 74 : 75));
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--; // don't split a UTF-8 character
    parts.push(bytes.subarray(start, end).toString());
    start = end;
  }
  return parts.join('\r\n ');
}
const ymd = iso => iso.replaceAll('-', '');
const dayAfter = iso => new Date(Date.parse(iso) + 864e5).toISOString().slice(0, 10);
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');

export function calendar(water, plants) {
  const name = water.name ?? `CDFW water #${water.id}`;
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Tackle Box//CDFW plants//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(`Fish plants: ${name}`)}`, `X-WR-CALDESC:${esc(`CDFW fish planting schedule for ${name}. Plants are subject to change.`)}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT12H', 'X-PUBLISHED-TTL:PT12H'];
  for (const p of plants) {
    lines.push('BEGIN:VEVENT', `UID:${p.week}-${water.id}-${slug(p.species)}@tackle-box`, `DTSTAMP:${ymd(p.week)}T000000Z`,
      `DTSTART;VALUE=DATE:${ymd(p.week)}`, `DTEND;VALUE=DATE:${ymd(dayAfter(p.weekEnd ?? p.week))}`, 'TRANSP:TRANSPARENT',
      `SUMMARY:${esc(`🐟 ${p.species} plant: ${name}`)}`,
      `DESCRIPTION:${esc(`CDFW plans to plant ${p.species} at ${name}${p.counties ? ` (${p.counties} County)` : ''} the week of ${p.week}. Plants are subject to change.`)}`,
      `URL:https://apps.wildlife.ca.gov/fishing/?stockid=${water.id}`,
      ...(water.lat ? [`GEO:${water.lat};${water.lon}`] : []),
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(`${p.species} plant this week at ${name}`)}`, 'TRIGGER:-PT12H', 'END:VALARM',
      'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

const [{ waters }, { plants }] = await Promise.all([readJson('waters.json'), readJson('plants.json')]);
// The last year of plants plus everything scheduled, so a new subscriber sees the pattern as well as what's next.
const since = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
const byId = new Map();
for (const p of plants) if (p.stockId && p.week >= since) (byId.get(p.stockId) ?? byId.set(p.stockId, []).get(p.stockId)).push(p);
const all = new Map(waters.map(w => [w.id, w]));
for (const [id, ps] of byId) if (!all.has(id)) all.set(id, { id, name: ps[0].water });

await mkdir(ICS, { recursive: true });
const keep = new Set();
for (const w of all.values()) {
  const file = `${w.id}.ics`;
  keep.add(file);
  await writeFile(new URL(file, ICS), calendar(w, (byId.get(w.id) ?? []).sort((a, b) => a.week.localeCompare(b.week))));
}
let removed = 0;
for (const f of await readdir(ICS)) if (f.endsWith('.ics') && !keep.has(f)) { await unlink(new URL(f, ICS)); removed++; }
console.log(`ics: ${keep.size} feeds, ${[...byId.values()].reduce((n, p) => n + p.length, 0)} plants since ${since}, ${removed} stale feeds removed`);
