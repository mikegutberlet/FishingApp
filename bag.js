// Bag and possession limits for a water, read from the regulations its state's data jobs save (data/<st>/regs.json),
// and how many fish you've kept against them. Used by the count bar in trip mode. Best effort: the parsed limits come
// with the line they were read from, and the regs page has the final word.
import { db } from './db.js';
import { forLake } from './states/index.js';
import { isRiver } from './states/common.js';
import { esc } from './ui.js';

// Species groups the limits are written in. Order matters: the first that matches a species wins.
const CATS = [
  ['Kokanee', /kokanee/i],
  ['Steelhead', /steelhead/i],
  ['Salmon', /salmon|chinook|coho|sockeye|\bking\b/i],
  ['Trout', /\btrout\b|mackinaw/i],
  ['Wiper', /wiper|hybrid/i],
  ['Striped bass', /striped bass|striper/i],
  ['White bass', /^white bass/i],
  ['Black bass', /\b(largemouth|smallmouth|spotted|redeye|black|bigmouth)\s+bass|^bass$/i],
  ['Catfish', /catfish|bullhead/i],
  ['Crappie', /crappie/i],
  ['Sunfish', /bluegill|sunfish|pumpkinseed|redear|warmouth/i],
  ['Yellow perch', /perch/i],
  ['Walleye', /walleye/i],
  ['Northern pike', /\bpike\b/i],
  ['Whitefish', /whitefish/i],
  ['Sturgeon', /sturgeon/i],
];
const WARM = new Set(['Wiper', 'Striped bass', 'White bass', 'Black bass', 'Catfish', 'Crappie', 'Sunfish', 'Yellow perch', 'Walleye', 'Northern pike']);
export const catOf = species => CATS.find(([, re]) => re.test(String(species ?? '').trim()))?.[0] ?? null;
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

// What a limit's noun ("hatchery trout", "warmwater game fish", "rainbow trout") counts.
function nounTest(noun) {
  const n = noun.toLowerCase().replace(/\b(hatchery|wild|adipose[- ]fin[- ]clipped|adult|legal[- ]sized?)\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (!n) return null;
  if (/warm\s*water game\s*fish/.test(n)) return { label: 'Warmwater game fish', test: s => WARM.has(catOf(s)) };
  if (/^(game\s*fish|fish)$/.test(n)) return { label: 'Game fish', test: s => !!catOf(s) };
  // One kind of trout ("1 lake trout per day") counts only that kind.
  if (/^(rainbow|brown|brook|lake|cutthroat|golden|bull|tiger) trout$/.test(n)) return { label: cap(n), test: s => String(s).toLowerCase().includes(n) };
  if (/^(sunfish and crappie|crappie and sunfish)/.test(n)) return { label: 'Sunfish and crappie', test: s => ['Sunfish', 'Crappie'].includes(catOf(s)) };
  const cat = catOf(n);
  return cat ? { label: cat, test: s => catOf(s) === cat } : null;
}

// "5 trout, 5 mountain whitefish and 15 warmwater game fish of which not more than 5 may be black bass" →
// Trout 5, Whitefish 5, Warmwater game fish 15, Black bass 5. The first limit named for a group wins, so a
// sub-limit later in the line ("only 1 bass over 15 inches") doesn't replace it.
export function parseLimitText(text) {
  const t = ` ${String(text ?? '').toLowerCase()} `.replace(/zero \((\d)\)/g, '$1').replace(/\b(twenty-five|twenty five)\b/g, '25').replace(/\bnot more than\s+/g, '')
    .replace(/(\d+)\s+may be\s+/g, '$1 ').replace(/\bcombined (?:daily )?bag limit of\s+/g, '');
  const out = [];
  for (const m of t.matchAll(/(?<![\d.$-])(\d+)\s+((?:[a-z]+[\s-]){0,4}?[a-z]+?)(?=\s*(?:,|;|\.|:|\(|\bor\b|\band\b(?! crappie| sunfish)|\bof which\b|\bper\b|\bexcept\b|\bin\b|\bover\b|\bunder\b|\bno\b|\bonly\b|\bmay\b|$))/g)) {
    const what = nounTest(m[2]);
    if (what && !out.some(o => o.label === what.label)) out.push({ ...what, daily: +m[1] });
  }
  if (!out.length && /catch[- ]and[- ]release only|\b0 fish\b/.test(t)) out.push({ ...nounTest('fish'), daily: 0 });
  return out;
}

// ---------- Each state's limits for a water ----------
// Each returns { limits: [{ label, test, daily, possession }], from: text shown under the bar }.
async function caLimits(lake, S) {
  const regs = await S.regsFor(lake);
  if (!regs?.county) return null;
  const limits = [], from = [];
  const add = (list, poss, note) => { for (const l of list) if (!limits.some(x => x.label === l.label)) limits.push({ ...l, possession: poss(l) }); if (list.length && note) from.push(note); };
  // Special regulations for this water: the rule in effect today for the whole water (a reach's rule can't be told apart).
  for (const w of regs.special.filter(w => !w.tributariesOnly)) {
    const whole = w.parts.filter(p => !p.where);
    const now = whole.find(p => p.open !== false) ?? whole[0];
    if (!now?.bag) continue;
    let list = parseLimitText(now.bag);
    // A bare number is the group the section is for ("5" under §5.00 is five black bass).
    if (!list.length && /^\s*\d+\s*$/.test(now.bag)) list = [{ ...nounTest(w.sec === '5.00' ? 'bass' : w.sec === '5.15' ? 'catfish' : 'trout'), daily: +now.bag }];
    add(list, l => l.daily, `§${w.sec}${w.ref ?? ''} ${w.name || ''}`.trim());
  }
  // Statewide: trout 5 a day, 10 in possession (§5.85); black bass 5 (§5.00); sunfish and crappie 25 combined (§5.82); sturgeon 1 (§5.80).
  add([{ ...nounTest('trout'), daily: 5 }], () => 10, 'statewide trout §5.85');
  add([{ ...nounTest('bass'), daily: 5 }, { ...nounTest('sunfish and crappie'), daily: 25 }, { ...nounTest('sturgeon'), daily: 1 }], l => l.daily, '§5.00, §5.82, §5.80');
  return { limits, from: `California: ${from.join('; ')}. Unless a rule says otherwise, only one daily bag may be possessed (trout: 10).` };
}

async function nvLimits(lake, S) {
  const regs = await S.regsFor(lake);
  if (!regs) return null;
  const special = regs.special.find(w => w.limit && parseLimitText(w.limit).length);
  if (special) return { limits: parseLimitText(special.limit).map(l => ({ ...l, possession: l.daily * 2 })), from: `NDOW special regulation for ${special.name}: “${special.limit}” Possession is twice the daily limit.` };
  const line = (regs.regionRules?.general ?? []).find(g => /daily limit/i.test(g.title))?.text?.find(t => /\d/.test(t));
  if (!line) return null;
  return { limits: parseLimitText(line).map(l => ({ ...l, possession: l.daily * 2 })), from: `NDOW ${regs.region} Region daily limits. Possession is twice the daily limit.${regs.special.length ? ' This water has special regulations too: check them.' : ''}` };
}

// "Lakes: 5 per day, 3 daily limits in possession. Streams: 2 per day" → the part for this kind of water.
const NUM = { one: 1, two: 2, three: 3, four: 4 };
function orRow(text, river) {
  const parts = String(text).split(/\b(Lakes(?:\/Reservoirs)?|Streams)\s*:/i);
  let seg = text;
  if (parts.length > 2) for (let i = 1; i < parts.length; i += 2) if (/stream/i.test(parts[i]) === river) seg = parts[i + 1];
  if (/catch[- ]and[- ]release only/i.test(seg)) return { daily: 0, mult: 1 };
  const day = seg.match(/(\d+)\s+per day/i);
  if (!day) return null;
  const mult = seg.match(/(\d+|one|two|three|four)\s+daily (?:catch |jack )?limits? in possession/i)?.[1];
  return { daily: +day[1], mult: mult ? NUM[mult.toLowerCase()] ?? +mult : 1 };
}
async function orLimits(lake, S) {
  const regs = await S.regsFor(lake);
  if (!regs?.zoneRules) return null;
  const river = isRiver(lake) && !regs.lakeRow;
  const limits = [], from = [];
  let mult = 3;
  // Exceptions for this water ("2 trout per day, 8 inch minimum length").
  for (const w of regs.special) {
    const lines = w.rules.filter(r => /^\d+\s+[a-z].*?per day/i.test(r));
    for (const r of lines) for (const l of parseLimitText(r)) if (!limits.some(x => x.label === l.label)) limits.push(l);
    if (lines.length) from.push(`exceptions for ${w.name}`);
  }
  for (const g of regs.zoneRules.general ?? []) {
    const row = orRow(g.bag, river);
    if (!row) continue;
    const what = g.species === 'Trout' ? nounTest('trout') : g.species === 'Bass' ? nounTest('bass') : g.species === 'Kokanee' ? nounTest('kokanee') : null;
    if (!what) continue;
    if (g.species === 'Trout') mult = row.mult;
    if (!limits.some(x => x.label === what.label)) limits.push({ ...what, daily: row.daily });
    if (!from.includes(`${regs.zone} Zone`)) from.push(`${regs.zone} Zone`);
  }
  return { limits: limits.map(l => ({ ...l, possession: l.daily * mult })), from: `ODFW ${from.join(', ')} (${river ? 'streams' : 'lakes'}). Possession: ${mult} daily limits.${regs.special.length ? ' Read this water’s exceptions on its Regs page.' : ''}` };
}

export async function limitsFor(lake) {
  const S = forLake(lake);
  try {
    return S?.code === 'CA' ? await caLimits(lake, S) : S?.code === 'NV' ? await nvLimits(lake, S) : S?.code === 'OR' ? await orLimits(lake, S) : null;
  } catch { return null; }
}

// ---------- How many you've kept ----------
// Daily limits are per day across every water. Possession counts what you kept over the last 3 days (a camp trip),
// since the last time you said you'd eaten or given them away.
const RESET_KEY = 'tb-possession-reset';
const POSSESSION_DAYS = 3;
const resetAt = () => { try { return localStorage.getItem(RESET_KEY) ?? ''; } catch { return ''; } };
const startOfDay = (t = Date.now()) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d; };

export async function keptCounts(limits, now = Date.now()) {
  const day = startOfDay(now).toISOString();
  const since = [new Date(startOfDay(now) - (POSSESSION_DAYS - 1) * 864e5).toISOString(), resetAt()].sort().at(-1);
  const kept = (await db.all('catches')).filter(c => c.released === false && c.time);
  // Catch times are local "YYYY-MM-DDTHH:MM" or ISO; compare as dates.
  const at = c => new Date(c.time).toISOString();
  return limits.map(l => ({ ...l, today: kept.filter(c => at(c) >= day && l.test(c.species)).length, held: kept.filter(c => at(c) >= since && l.test(c.species)).length }));
}

// The bar in trip mode. Limits with a fish kept show first; the rest are listed small.
export async function renderBagBar(el, lake) {
  if (!el || !lake) return;
  const found = await limitsFor(lake);
  if (!el.isConnected) return;
  if (!found?.limits.length) { el.innerHTML = ''; return; }
  const rows = await keptCounts(found.limits);
  const tone = r => r.today > r.daily || r.held > r.possession ? 'bad' : r.today === r.daily || r.held === r.possession ? 'warn' : '';
  const used = rows.filter(r => r.today || r.held), rest = rows.filter(r => !r.today && !r.held);
  el.innerHTML = `<div class="bag-bar">
    ${used.map(r => `<div class="bag-row ${tone(r)}"><b>${esc(r.label)}</b><span>${r.today} of ${r.daily} today</span>${r.possession !== r.daily || r.held !== r.today ? `<span class="muted">${r.held} of ${r.possession} held</span>` : ''}</div>`).join('')}
    <div class="small ${used.length ? 'muted' : ''}">${used.length ? '' : '🧺 Nothing kept yet. '}${rest.length ? `Limits here: ${rest.map(r => `${esc(r.label)} ${r.daily}`).join(' · ')}` : ''}</div>
    <details class="small muted"><summary>Where these come from</summary>${esc(found.from)} Counts fish you marked as kept (untick Released). Posted signs and the regulations have the final word.
      <a href="#" data-bag-reset>Ate or gave away what I had: reset what I hold</a></details></div>`;
  el.querySelector('[data-bag-reset]').onclick = e => {
    e.preventDefault();
    try { localStorage.setItem(RESET_KEY, new Date().toISOString()); } catch {}
    renderBagBar(el, lake);
  };
}
