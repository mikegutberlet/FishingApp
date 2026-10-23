// Display units, a per-device preference. Records are always stored in inches, pounds and feet;
// these helpers convert for display and convert form input back.
const KEY = 'tackle-box-units';
const DEFAULTS = { depth: 'ft', length: 'in', weight: 'lb' };
export const units = () => { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY)) }; } catch { return { ...DEFAULTS }; } };
export const setUnits = u => localStorage.setItem(KEY, JSON.stringify({ ...units(), ...u }));

const PER = { length: 2.54, weight: 0.45359237, depth: 0.3048 }; // cm per in, kg per lb, m per ft
const METRIC = ['cm', 'kg', 'm'], DECIMALS = { length: 1, weight: 2, depth: 1 };
const round = (v, d) => +v.toFixed(d);
// A stored value as shown in a given unit (default: the current setting).
export const display = (kind, v, unit = units()[kind]) => v == null ? null : METRIC.includes(unit) ? round(v * PER[kind], DECIMALS[kind]) : v;
// Stored value → display number in the chosen unit.
export const toLen = v => display('length', v);
export const toWt = v => display('weight', v);
export const toDepth = v => display('depth', v);
// Form input in the chosen unit → stored value.
const stored = (kind, v) => v == null ? null : METRIC.includes(units()[kind]) ? round(v / PER[kind], kind === 'depth' ? 1 : 2) : v;
export const fromLen = v => stored('length', v);
export const fromWt = v => stored('weight', v);
export const fromDepth = v => stored('depth', v);
// A value typed in one unit, re-expressed in another (when the setting changes under a half-filled form).
export const reunit = (v, kind, from, to) => from === to ? v : round(METRIC.includes(to) ? v * PER[kind] : v / PER[kind], 2);
// Formatted strings: fmtLen(20) → 20" or 50.8 cm.
export const fmtLen = v => v == null ? '' : units().length === 'cm' ? `${toLen(v)} cm` : `${v}"`;
export const fmtWt = v => v == null ? '' : `${toWt(v)} ${units().weight}`;
export const fmtDepth = v => v == null ? '' : `${toDepth(v)} ${units().depth}`;

// The Units card in the Data view.
const form = document.getElementById('units-form');
if (form) {
  for (const [k, v] of Object.entries(units())) form[k].value = v;
  form.onchange = () => setUnits(Object.fromEntries(new FormData(form)));
}
