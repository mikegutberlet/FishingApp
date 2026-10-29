// Finding water names in text (scripts/ingest.mjs). Pure: no I/O.
//   termsFor(name)                 the normalized terms one stocked-water name can appear as
//   buildIndex(waters, aliases)    one combined regex over every term, and which waters each term names
//   matchWaters(text, index, opts) the waters a passage names, flagged when a term names more than one
import { nameKey, resolveWater } from '../corpus-lib.mjs';

const TYPE_WORDS = new Set(['lake', 'lakes', 'creek', 'river', 'reservoir', 'res', 'pond', 'upper', 'lower', 'north', 'south', 'east', 'west', 'little', 'big', 'fork']);
const QUALIFIERS = new Set(['upper', 'lower', 'north', 'south', 'east', 'west', 'little', 'big']);
const real = t => t.split(' ').length >= 2 && t.split(' ').some(w => !TYPE_WORDS.has(w));

export function termsFor(name) {
  const out = [], add = t => { t = nameKey(t); if (t && real(t) && !out.includes(t)) out.push(t); };
  let main = String(name);
  // A parenthetical is an alternate name: "Trinity Lake (Clair Engle Lake)".
  const alts = [];
  main = main.replace(/\(([^)]*)\)/g, (_, alt) => { alts.push(alt); return ' '; });
  add(main);
  const [head, ...rest] = main.split(',').map(s => s.trim()).filter(Boolean);
  // A trailing qualifier reads either way: "Salmon Lake, Upper" / "Blue Lake Upper" → "Upper Salmon Lake".
  // The bare head is a term only when what follows the comma is a place ("Twin Lake Lower, Bridgeport"),
  // not a qualifier: "Salmon Lake" alone may be another water.
  const q = rest.length === 1 && QUALIFIERS.has(nameKey(rest[0])) ? rest[0] : null;
  if (q) add(`${q} ${head}`);
  else {
    if (rest.length) add(head);
    const hw = nameKey(head).split(' ');
    if (hw.length > 2 && QUALIFIERS.has(hw.at(-1))) add(`${hw.at(-1)} ${hw.slice(0, -1).join(' ')}`);
  }
  for (const alt of alts) for (const t of termsFor(alt)) add(t);
  for (const t of [...out]) if (/\breservoir\b/.test(t)) add(t.replace(/\breservoir\b/, 'res'));
  return out;
}

export function buildIndex(waters, aliases = {}) {
  const byTerm = new Map();
  const put = (term, st, w) => { const list = byTerm.get(term) ?? []; if (!list.some(x => x.st === st && x.id === String(w.id))) list.push({ st, id: String(w.id), name: w.name }); byTerm.set(term, list); };
  for (const [st, list] of Object.entries(waters)) for (const w of list) for (const t of termsFor(w.name)) put(t, st, w);
  for (const [alias, ref] of Object.entries(aliases)) {
    const term = nameKey(alias);
    if (ref === null) byTerm.delete(term);
    else if (term) { const [st, w] = resolveWater(ref, waters); put(term, st, w); }
  }
  const terms = [...byTerm.keys()].sort((a, b) => b.length - a.length);
  return { re: terms.length ? new RegExp(`\\b(?:${terms.join('|')})\\b`, 'g') : /$^/g, byTerm };
}

export function matchWaters(text, index, { states } = {}) {
  const hits = new Map();
  for (const m of nameKey(text).matchAll(index.re)) {
    const cands = (index.byTerm.get(m[0]) ?? []).filter(c => !states || states.includes(c.st));
    for (const c of cands) hits.set(`${c.st}:${c.id}`, { ...c, term: m[0], ambiguous: cands.length > 1 });
  }
  return [...hits.values()];
}
