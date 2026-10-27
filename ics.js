// Calendar files (.ics) made on this device: a timed event with alarms that the phone's own calendar sounds, even
// with the app closed (iPhones give web apps no push or background timers). The file goes where you send it and
// this app never sees it again. Used by license reminders, the check-in plan's late alarm, and trip alarms.
import { saveFile } from './backup.js';

// Text values escape backslash, comma, semicolon and newlines; long lines fold at 74 octets (here: characters).
export const icsText = s => String(s ?? '').replace(/\\/g, '\\\\').replace(/[,;]/g, '\\$&').replace(/\r?\n/g, '\\n');
const fold = line => { const c = [...line]; if (c.length <= 74) return line; const out = []; for (let i = 0; i < c.length; i += 73) out.push(c.slice(i, i + 73).join('')); return out.join('\r\n '); };
const stamp = ms => new Date(ms).toISOString().replace(/[-:]|\.\d+/g, '');
const day = iso => iso.replace(/-/g, '');

// events: [{ uid, start, end, allDay, summary, description, location, url, alarms, sequence }]
//   start/end: ms or ISO for a timed event (written in UTC), 'YYYY-MM-DD' with allDay
//   alarms: minutes before the start that each alarm sounds (0 = at the start, negative = after it)
export function icsCalendar(events, name = 'Tackle Box') {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//Tackle Box//${name}//EN`, 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  for (const e of events) {
    const start = e.allDay ? `DTSTART;VALUE=DATE:${day(e.start)}` : `DTSTART:${stamp(typeof e.start === 'number' ? e.start : Date.parse(e.start))}`;
    const endMs = e.end ?? (e.allDay ? null : (typeof e.start === 'number' ? e.start : Date.parse(e.start)) + 30 * 6e4);
    const end = e.allDay ? `DTEND;VALUE=DATE:${day(e.end ?? new Date(Date.parse(e.start + 'T12:00') + 864e5).toISOString().slice(0, 10))}` : `DTEND:${stamp(typeof endMs === 'number' ? endMs : Date.parse(endMs))}`;
    lines.push('BEGIN:VEVENT', `UID:${e.uid}@tackle-box`, `DTSTAMP:${stamp(Date.now())}`, `SEQUENCE:${e.sequence ?? 0}`, start, end, `SUMMARY:${icsText(e.summary)}`);
    if (e.description) lines.push(`DESCRIPTION:${icsText(e.description)}`);
    if (e.location) lines.push(`LOCATION:${icsText(e.location)}`);
    if (e.url) lines.push(`URL:${e.url}`);
    for (const m of e.alarms ?? []) {
      const trig = m === 0 ? 'PT0M' : m > 0 ? (m % 1440 ? `-PT${m}M` : `-P${m / 1440}D`) : `PT${-m}M`;
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(e.summary)}`, `TRIGGER:${trig}`, 'END:VALARM');
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

export const icsFile = (fileName, events, name) => new File([icsCalendar(events, name)], fileName.replace(/[^\w.-]+/g, '-'), { type: 'text/calendar' });

// Opens the share sheet with the file (Messages, Mail, your calendar), or downloads it where sharing files isn't offered.
export const sendIcs = (fileName, events, { title = 'Calendar alarm', text = '' } = {}) => saveFile(icsFile(fileName, events), { title, text });
