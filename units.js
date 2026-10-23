// Display units, a per-device preference. Records are always stored in inches, pounds and feet;
// these helpers convert for display and convert form input back.
const KEY = 'tackle-box-units';
const DEFAULTS = { depth: 'ft', length: 'in', weight: 'lb' };
const FACTOR = { m: 0.3048, cm: 2.54, kg: 0.45359237 }; // per ft, in, lb

export const units = () => { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY)) }; } catch { return { ...DEFAULTS }; } };
export const setUnits = u => localStorage.setItem(KEY, JSON.stringify({ ...units(), ...u }));

const round = (v, d) => +v.toFixed(d);
// Stored value → display number in the chosen unit.
export const toLen = v => v == null ? null : units().length === 'cm' ? round(v * FACTOR.cm, 1) : v;
export const toWt = v => v == null ? null : units().weight === 'kg' ? round(v * FACTOR.kg, 2) : v;
export const toDepth = v => v == null ? null : units().depth === 'm' ? round(v * FACTOR.m, 1) : v;
// Form input in the chosen unit → stored value.
export const fromLen = v => v == null ? null : units().length === 'cm' ? round(v / FACTOR.cm, 2) : v;
export const fromWt = v => v == null ? null : units().weight === 'kg' ? round(v / FACTOR.kg, 2) : v;
export const fromDepth = v => v == null ? null : units().depth === 'm' ? round(v / FACTOR.m, 1) : v;
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
