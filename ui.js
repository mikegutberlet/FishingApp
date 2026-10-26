// Small helpers shared by every view, and navigation between the bottom-nav views.
export const $ = (sel, root = document) => root.querySelector(sel);
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// A date with no time (a plant week, '2026-10-25') means that calendar day, so read it as local noon, not UTC midnight.
export const fmtDate = iso => iso ? new Date(/^\d{4}-\d\d-\d\d$/.test(iso) ? iso + 'T12:00' : iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
export const fmtTime = iso => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric' });
export const status = msg => { $('#status').textContent = msg; if (msg) setTimeout(() => $('#status').textContent === msg && ($('#status').textContent = ''), 4000); };
export const arrow = deg => `<span class="arrow" style="transform:rotate(${deg + 180}deg)">↑</span>`;
export const M_TO_FT = 3.28084;

export const COMMON_SPECIES = ['Largemouth bass', 'Smallmouth bass', 'Walleye', 'Northern pike', 'Muskellunge', 'Bluegill', 'Black crappie', 'White crappie',
  'Yellow perch', 'Rainbow trout', 'Brown trout', 'Brook trout', 'Lake trout', 'Channel catfish', 'Flathead catfish', 'Striped bass', 'White bass', 'Carp', 'Salmon'];
export const localNow = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

// ---------- Navigation ----------
// Each view registers what to do when it is shown: onShow('stats', renderStats).
// render: false switches back to a view without redrawing it, e.g. returning to a half-filled form.
const showHandlers = {};
export const onShow = (name, fn) => (showHandlers[name] ??= []).push(fn);

// Buttons in empty states and elsewhere jump to a view with data-go="<view>".
document.addEventListener('click', e => { const go = e.target.closest?.('[data-go]'); if (go) { e.preventDefault(); showView(go.dataset.go); } });

// A friendly empty state: a big icon, a line of text, and optional buttons [label, view].
export const emptyState = (icon, text, ...actions) => `<div class="card empty"><div class="empty-icon">${icon}</div><p>${text}</p>${actions.length ? `<div class="empty-acts">${actions.map(([label, view], i) => `<button data-go="${view}" class="${i ? '' : 'primary'}">${label}</button>`).join('')}</div>` : ''}</div>`;

// A horizontal tab strip: center the active tab and fade the edge while more tabs are hidden to the right.
export function fitTabs(strip) {
  if (!strip) return;
  const a = strip.querySelector('.active');
  if (a) strip.scrollLeft = a.offsetLeft - (strip.clientWidth - a.offsetWidth) / 2;
  const edge = () => strip.classList.toggle('more', strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 4);
  strip.addEventListener('scroll', edge, { passive: true });
  edge();
}

export function showView(name, { render = true } = {}) {
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  document.getElementById('btn-settings')?.classList.toggle('active', name === 'settings');
  if (render) for (const fn of showHandlers[name] ?? []) fn();
}
