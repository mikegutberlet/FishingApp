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

export function showView(name, { render = true } = {}) {
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  if (render) for (const fn of showHandlers[name] ?? []) fn();
}
