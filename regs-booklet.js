// Each state's printed fishing regulations booklet, as a fallback for when the app's own regs can't answer a question
// (and to show a warden). The agencies' PDFs don't allow other sites to keep a copy, so the app opens them and the
// phone saves them to Files (iPhone: Share → Save to Files; Android: it lands in Downloads); both open with no signal.
// The app remembers the year you said you saved, and asks again when a new year's booklet is out.
const KEY = 'tackle-box-booklets'; // { CA: 2026, ... } the regs year you saved, this phone only

export const BOOKLETS = {
  CA: { state: 'California', name: 'Freshwater Sport Fishing Regulations', url: 'https://wildlife.ca.gov/Regulations#fresh-regs', size: '', via: 'CDFW Regulations page: tap "Freshwater Sport Fishing Regulations Booklet (PDF)"', year: 'Mar 1' },
  NV: { state: 'Nevada', name: 'Nevada Fishing Guide and Regulations', url: 'https://www.eregulations.com/nevada/fishing/pdf', size: 'about 10 MB', via: 'NDOW, published through eRegulations', year: 'Mar 1' },
  OR: { state: 'Oregon', name: 'Oregon Sport Fishing Regulations', url: 'https://www.eregulations.com/oregon/fishing/pdf', size: 'about 44 MB: use Wi-Fi', via: 'ODFW, published through eRegulations', year: 'Jan 1' },
};

// Regs years: California's and Nevada's run March to February, Oregon's the calendar year.
export function regsYear(code, d = new Date()) {
  const y = d.getFullYear();
  return BOOKLETS[code]?.year === 'Mar 1' && d.getMonth() < 2 ? y - 1 : y;
}

const read = () => { try { return JSON.parse(localStorage.getItem(KEY)) ?? {}; } catch { return {}; } };
export const savedYear = code => read()[code] ?? null;
export const isSaved = (code, d = new Date()) => savedYear(code) === regsYear(code, d);
export function markSaved(code, on = true, d = new Date()) {
  const all = read();
  if (on) all[code] = regsYear(code, d); else delete all[code];
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch {}
}

// A line for one state: open the PDF, and tick it saved.
export function bookletHtml(code, esc) {
  const b = BOOKLETS[code];
  if (!b) return '';
  const y = regsYear(code), ok = isSaved(code);
  return `<div class="tg-booklet" data-booklet="${code}"><a href="${b.url}" target="_blank" rel="noopener">📕 ${esc(b.state)}: ${esc(b.name)}</a>
    <span class="muted small">${esc(b.via)}${b.size ? ` · ${esc(b.size)}` : ''}</span>
    <label class="check small"><input type="checkbox" data-booklet-saved="${code}" ${ok ? 'checked' : ''}> Saved ${y}${b.year === 'Mar 1' ? `–${String(y + 1).slice(2)}` : ''} booklet to my phone's Files</label></div>`;
}

export function wireBooklets(root) {
  root.querySelectorAll('[data-booklet-saved]').forEach(b => b.onchange = () => markSaved(b.dataset.bookletSaved, b.checked));
}

export const BOOKLET_HELP = 'Open it, then iPhone: Share → Save to Files. Android: it saves to Downloads (or ⋮ → Download). It opens from there with no signal.';
