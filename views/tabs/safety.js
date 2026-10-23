// Regs & safety tab: toxic algae advisories, fishing regulations for this water, and advice on eating the fish.
// Also the algae banner shown at the top of every lake page.
import * as CA from '../../states/ca.js';
import { esc, fmtDate } from '../../ui.js';

const day = iso => fmtDate(iso + 'T12:00');

// What each Water Boards advisory level means for anglers (from the state's HAB posting guidance).
export const HAB_LEVELS = {
  danger: { label: 'Danger', icon: '⛔', advice: 'Stay out of the water and off the shoreline scum. Keep pets and kids away. Don’t eat fish from here.' },
  warning: { label: 'Warning', icon: '⚠️', advice: 'No swimming. Keep pets away from the water and scum. If you keep fish, throw away the guts and rinse fillets in clean water.' },
  caution: { label: 'Caution', icon: '⚠️', advice: 'Stay away from algae and scum. Keep pets from drinking the water. If you keep fish, throw away the guts and rinse fillets in clean water.' },
  awareness: { label: 'Bloom seen', icon: '🟢', advice: 'A bloom was reported but not tested. Avoid scum and discolored water; keep pets out.' },
  reported: { label: 'Under investigation', icon: 'ℹ️', advice: 'A bloom or illness was reported and is being checked. Avoid scum and keep pets out until it’s assessed.' },
};

// Goes right under the water's name on its page (page = the #lake-detail element).
export async function renderSafetyBanner(lake, page) {
  const h2 = page.querySelector('h2'); // before the await, so a page redrawn meanwhile doesn't get a second banner
  const hab = await CA.habFor(lake);
  const top = hab.find(a => ['danger', 'warning', 'caution'].includes(a.level));
  if (!top || !h2?.isConnected) return;
  const l = HAB_LEVELS[top.level];
  const el = document.createElement('div');
  h2.after(el);
  el.innerHTML = `<div class="banner hab-${top.level}"><b>${l.icon} Toxic algae ${l.label.toLowerCase()}</b> · ${esc((top.landmark || top.name).trim())}, updated ${day(top.date)}
    <div class="small">${l.advice}</div><a href="#" class="small" data-safety-tab>Details ›</a></div>`;
  el.querySelector('[data-safety-tab]').onclick = e => { e.preventDefault(); document.querySelector('.tabs button[data-tab="safety"]')?.click(); };
}

export async function renderSafety(lake, body) {
  body.innerHTML = `<div id="hab-card" class="card muted">Checking algae advisories…</div><div id="regs-card" class="card muted">Loading regulations…</div><div id="eat-card" class="card muted">Loading fish advisories…</div>`;
  const [hab, regs, eat, habData] = await Promise.all([CA.habFor(lake), CA.regsFor(lake), CA.fishAdviceFor(lake), CA.habAdvisories()]);
  if (!body.isConnected) return;
  body.querySelector('#hab-card').outerHTML = habCard(hab, habData);
  body.querySelector('#regs-card').outerHTML = regsCard(lake, regs);
  body.querySelector('#eat-card').outerHTML = eatCard(lake, eat);
}

function habCard(hab, data) {
  const portal = data?.portal ?? 'https://mywaterquality.ca.gov/habs/';
  if (!data) return `<div class="card"><h3>Toxic algae</h3><p class="muted small">Algae advisories haven't been downloaded yet. Check the <a href="${portal}" target="_blank" rel="noopener">California HABs portal ↗</a>.</p></div>`;
  return `<div class="card"><h3>Toxic algae</h3>
    ${hab.length ? hab.map(a => { const l = HAB_LEVELS[a.level]; return `<div class="banner hab-${a.level}"><b>${l.icon} ${esc(a.advisory === 'NA - refer to Report Details' ? l.label : a.advisory)}</b> · ${esc(a.name)}${a.landmark.trim() ? ` (${esc(a.landmark.trim())})` : ''}
        <div class="small">${l.advice}</div>
        <div class="small muted">${esc(a.detail)}${a.detail ? ' · ' : ''}updated ${day(a.date)}${a.distKm > 1 ? ` · ${a.distKm.toFixed(1)} km away` : ''}</div></div>`; }).join('')
      : '<p class="small">✅ No current toxic algae advisories reported on this water.</p>'}
    <p class="muted small">California Water Boards bloom reports, refreshed nightly (${fmtDate(data.updatedAt)}). Blooms can appear fast: avoid scum, and keep dogs out of discolored water. <a href="${portal}" target="_blank" rel="noopener">HABs portal ↗</a></p></div>`;
}

const partRow = (p, cols) => `<tr>${p.where ? `<td colspan="${cols.length}" class="small"><b>${esc(p.where)}</b></td></tr><tr>` : ''}${cols.map(c => `<td class="small">${c === 'season' && p.open != null ? (p.open ? '🟢 ' : '🔴 ') : ''}${esc(p[c])}</td>`).join('')}</tr>`;
const SEC_LABEL = { '7.50': 'Trout special regulations', '7.40': 'Hatchery trout, steelhead & salmon', '5.00': 'Black bass', '5.15': 'Catfish' };

function specialEntry(w) {
  const cols = w.sec === '5.00' ? ['season', 'size', 'bag'] : w.sec === '5.15' ? ['bag'] : ['season', 'bag'];
  return `<div class="reg"><div><b>${esc(SEC_LABEL[w.sec])}</b> <span class="muted small">§${w.sec}${esc(w.ref)}</span></div>
    <div class="small">${esc(w.text)}</div>
    ${w.parts.length ? `<table><tr>${cols.map(c => `<th class="small">${{ season: 'Open season', size: 'Size', bag: 'Daily bag' }[c]}</th>`).join('')}</tr>${w.parts.map(p => partRow(p, cols)).join('')}</table>` : ''}</div>`;
}

function regsCard(lake, regs) {
  if (!regs) return `<div class="card"><h3>Fishing regulations</h3><p class="muted small">Regulations haven't been downloaded yet. See the <a href="https://wildlife.ca.gov/Regulations" target="_blank" rel="noopener">CDFW regulations ↗</a>.</p></div>`;
  const own = regs.special.filter(w => !w.tributariesOnly && w.scope === 'water');
  const area = regs.special.filter(w => w.scope === 'county');
  const tribs = regs.special.filter(w => w.tributariesOnly);
  return `<div class="card"><h3>Fishing regulations</h3>
    ${own.length ? own.map(specialEntry).join('') : `<p class="small">No special regulations name this ${regs.kind === 'stream' ? 'stream' : 'lake'}, so the statewide rules below apply.${regs.kind === 'stream' ? ' Waters salmon and steelhead can reach (anadromous) also follow district rules.' : ''}</p>`}
    ${area.length ? `<h3 style="margin-top:10px">${esc(regs.county)} County rules</h3>${area.map(specialEntry).join('')}` : ''}
    ${tribs.length ? `<details><summary class="small">Streams flowing into this lake have their own rules</summary>${tribs.map(specialEntry).join('')}</details>` : ''}
    <h3 style="margin-top:10px">Statewide rules</h3>
    ${regs.statewide.map((s, i) => `<details${i === 0 ? ' open' : ''}><summary class="small"><b>${esc(s.title)}</b> <span class="muted">§${s.sec}</span></summary>${s.text.map(t => `<p class="small">${esc(t)}</p>`).join('')}<p class="small"><a href="${esc(s.url)}" target="_blank" rel="noopener">Full text ↗</a></p></details>`).join('')}
    <p class="muted small">🟢/🔴 = open or closed today. From California Code of Regulations Title 14, refreshed weekly (${fmtDate(regs.updatedAt)}); matched to this water by name${regs.county ? ` and county (${esc(regs.county)})` : ''}, so read the wording. The <a href="${esc(regs.booklet)}" target="_blank" rel="noopener">CDFW regulations ↗</a> and posted signs are the final word, and emergency closures aren't included.</p></div>`;
}

const servings = n => n === 0 ? '<b class="dont">Don’t eat</b>' : n == null ? '–' : `${n}/week`;
const fishTable = a => `<table><tr><th class="small">Fish</th><th class="small">Women 18–49, kids</th><th class="small">Everyone else</th></tr>
  ${a.fish.map(([sp, sen, gen, chem]) => `<tr><td class="small">${esc(sp)}${chem ? ` <span class="muted">(${esc(chem)})</span>` : ''}</td><td class="small">${servings(sen)}</td><td class="small">${servings(gen)}</td></tr>`).join('')}</table>`;

function eatCard(lake, eat) {
  if (!eat) return `<div class="card"><h3>Eating your catch</h3><p class="muted small">Fish advisories haven't been downloaded yet. See <a href="https://oehha.ca.gov/fish/advisories" target="_blank" rel="noopener">OEHHA ↗</a>.</p></div>`;
  const shown = eat.site.length ? eat.site : eat.statewide ? [eat.statewide] : [];
  return `<div class="card"><h3>Eating your catch</h3>
    ${eat.site.length ? '' : '<p class="small">No site-specific advisory for this water; the statewide advice applies.</p>'}
    ${shown.map(a => `<p class="small"><b>${esc(a.name)}</b>${a.year ? ` · ${a.year}` : ''}${a.url ? ` · <a href="${esc(a.url)}" target="_blank" rel="noopener">OEHHA ↗</a>` : ''}</p>${fishTable(a)}`).join('')}
    ${lake.kind === 'river' || /river|creek|stream/i.test(lake.type ?? '') ? eat.migrate ? `<details><summary class="small">Salmon, steelhead, sturgeon, stripers and shad (fish that migrate)</summary>${fishTable(eat.migrate)}</details>` : '' : ''}
    <p class="muted small">Servings per week of skinless fillet about the size of your hand (mercury, PCBs and other chemicals). From OEHHA via data.ca.gov, refreshed weekly.</p></div>`;
}
