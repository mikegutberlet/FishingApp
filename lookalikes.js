// "Not sure?" help for fish that look alike when the rules treat them differently: a protected fish next to one you
// may keep, a wild fish next to a hatchery one. Shown on the catch form and in trip mode, only in the states where the
// difference changes what you may do. The tips work offline; the links need signal.
import { esc } from './ui.js';

const wiki = page => `https://en.wikipedia.org/wiki/${page}`;
const PAIRS = [
  { id: 'bull', states: ['OR', 'NV'], match: /\b(bull|brook|dolly varden)\b/i, title: 'Bull trout or brook trout?',
    rule: 'Bull trout are protected: release them right away, unharmed. Brook trout can often be kept.',
    tip: 'No black, put it back: a brook trout has black on its dorsal (back) fin and wavy “worm” marks on its back. A bull trout has no black on the dorsal fin, and pale yellow, orange or red spots on an olive body.',
    links: [['Bull trout', wiki('Bull_trout')], ['Brook trout', wiki('Brook_trout')]] },
  { id: 'coho', states: ['OR', 'CA'], match: /\b(coho|silver salmon|chinook|king salmon)\b/i, title: 'Coho or Chinook?',
    rule: 'Wild coho must be released in most waters; Chinook often may be kept. The season and the fin clip decide.',
    tip: 'Look in its mouth: a Chinook (king) has black gums, a coho (silver) white or grey gums at the base of the teeth. A Chinook has spots on both halves of its tail, a coho only on the upper half.',
    links: [['Coho salmon', wiki('Coho_salmon')], ['Chinook salmon', wiki('Chinook_salmon')]] },
  { id: 'hatchery', states: ['OR', 'CA'], match: /\b(steelhead|salmon|chinook|coho)\b/i, title: 'Hatchery or wild?',
    rule: 'Where only hatchery fish may be kept, a fish with its adipose fin must go back.',
    tip: 'Hatchery steelhead and salmon have the adipose fin clipped: the small fleshy fin on the back between the dorsal fin and the tail is missing, with a healed scar. Fin there means wild.',
    links: [['Adipose fin', wiki('Adipose_fin')]] },
  { id: 'steelhead', states: ['OR', 'CA'], match: /\brainbow trout\b/i, river: true, minLength: 16, title: 'Rainbow or steelhead?',
    rule: 'In Oregon streams a rainbow over 16 inches counts as a steelhead. In California waters steelhead reach, a 16-inch rainbow is a steelhead too and needs a report card.',
    tip: 'Sea-run steelhead are chrome and slimmer, often with little red on the side when fresh from the ocean; resident rainbows are greener with a bold pink band. Size decides on paper.',
    links: [['Steelhead', wiki('Rainbow_trout#Steelhead')]] },
  { id: 'sturgeon', states: ['CA', 'OR'], match: /\bsturgeon\b/i, title: 'Green or white sturgeon?',
    rule: 'Green sturgeon are threatened: you may not keep or even remove one from the water. White sturgeon have a slot limit and a report card (California).',
    tip: 'A green sturgeon is olive-green with a stripe along each side and its barbels sit closer to the mouth than the tip of the snout. A white sturgeon is grey, with barbels closer to the snout tip.',
    links: [['Green sturgeon', wiki('Green_sturgeon')], ['White sturgeon', wiki('White_sturgeon')]] },
  { id: 'cutthroat', states: ['NV', 'OR', 'CA'], match: /\b(cutthroat|lahontan|cutbow)\b/i, nvMatch: /\brainbow\b/i, title: 'Cutthroat or rainbow?',
    rule: 'Cutthroat often have their own limits or are release-only (Lahontan cutthroat at Pyramid Lake have size rules; some Oregon streams release all cutthroat).',
    tip: 'A cutthroat has a red or orange slash under each side of the lower jaw and small teeth at the back of the tongue. A rainbow has no slash. Hybrids (cutbows) can show a faint one.',
    links: [['Cutthroat trout', wiki('Cutthroat_trout')], ['Rainbow trout', wiki('Rainbow_trout')]] },
  { id: 'wiper', states: ['NV'], match: /\b(wiper|hybrid|striped bass|striper|white bass)\b/i, title: 'Wiper, striper or white bass?',
    rule: 'Nevada waters often set a separate limit for wipers (white bass hybrids).',
    tip: 'A striped bass has solid, unbroken stripes and two tooth patches on the tongue. A wiper’s stripes are broken above the belly line and it is deeper-bodied. A white bass is small and deep with faint stripes and one tooth patch.',
    links: [['Hybrid striped bass', wiki('Hybrid_striped_bass')], ['Striped bass', wiki('Striped_bass')]] },
  { id: 'bass', states: ['CA', 'NV', 'OR'], match: /\b(largemouth|smallmouth|spotted) bass\b/i, title: 'Which black bass?',
    rule: 'Some waters set a different size or limit for one kind of bass.',
    tip: 'Largemouth: the jaw reaches past the back of the eye, and a dark side stripe. Smallmouth: bronze with vertical bars, jaw ends below the eye. Spotted: rows of dark spots under the stripe and a tooth patch on the tongue.',
    links: [['Largemouth', wiki('Largemouth_bass')], ['Smallmouth', wiki('Smallmouth_bass')], ['Spotted bass', wiki('Spotted_bass')]] },
];

// The pairs worth showing for this species on this water. stateCode: 'CA' | 'NV' | 'OR'; river: true for streams;
// length in inches (stored units) or null.
export function lookalikesFor(species, { stateCode = null, river = false, length = null } = {}) {
  const s = String(species ?? '');
  if (!s.trim() || !stateCode) return [];
  return PAIRS.filter(p => p.states.includes(stateCode) && (p.match.test(s) || (stateCode === 'NV' && p.nvMatch?.test(s)))
    && (!p.river || river) && (!p.minLength || (length != null && length >= p.minLength - 1)));
}

export const lookalikeHtml = pairs => pairs.length ? `<div class="lookalike">${pairs.map(p => `<details><summary>🔍 Not sure? <b>${esc(p.title)}</b></summary>
  <p class="small"><b>${esc(p.rule)}</b></p><p class="small">${esc(p.tip)}</p>
  <p class="small">${p.links.map(([t, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)} ↗</a>`).join(' · ')}</p></details>`).join('')}</div>` : '';
