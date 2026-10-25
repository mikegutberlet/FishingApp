// Regs & safety for Oregon waters: toxic algae advisories (OHA), ODFW regulations (the zone's limits and the
// exceptions listed for the water) and OHA advice on eating fish. Also the algae banner on the lake page.
import * as OR from '../../states/or.js';
import { forLake } from '../../states/index.js';
import { esc, fmtDate } from '../../ui.js';

const day = iso => iso ? fmtDate(iso + 'T12:00') : '';

// OHA's two levels: a recreational use health advisory (red) and a precaution (yellow).
export const OR_HAB = {
  warning: { label: 'Health advisory', icon: '⚠️', advice: 'Avoid swimming and water sports where you see scum, and keep pets and kids out. If you keep fish, throw away the fat, skin and organs, and rinse fillets in clean water. Don’t drink or cook with the water; boiling and camp filters don’t remove toxins.' },
  caution: { label: 'Precaution', icon: '⚠️', advice: 'A bloom is present or suspected. Stay out of discolored water or scum, and keep pets from drinking or swimming in it.' },
};

// Under the water's name on its page, when there is an algae advisory.
export async function renderOrBanner(lake, page) {
  if (forLake(lake) !== OR) return;
  const h2 = page.querySelector('h2');
  const top = (await OR.habFor(lake)).sort((a, b) => (b.level === 'warning') - (a.level === 'warning'))[0];
  if (!top || !h2?.isConnected) return;
  const l = OR_HAB[top.level];
  const el = document.createElement('div');
  h2.after(el);
  el.innerHTML = `<div class="banner hab-${top.level}"><b>${l.icon} Toxic algae: ${top.permanent ? 'permanent advisory' : l.label}</b> · ${esc(top.name)}${top.date ? `, issued ${day(top.date)}` : ''}
    <div class="small">${l.advice}</div><a href="#" class="small" data-safety-tab>Details ›</a></div>`;
  el.querySelector('[data-safety-tab]').onclick = e => { e.preventDefault(); document.querySelector('.tabs button[data-tab="safety"]')?.click(); };
}

export async function renderOrSafety(lake, body) {
  document.querySelector('.tabs button.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  body.innerHTML = '<div class="card muted">Loading rules and advisories…</div>';
  const [hab, habData, regs, eat] = await Promise.all([OR.habFor(lake), OR.habAdvisories(), OR.regsFor(lake), OR.fishAdviceFor(lake)]);
  if (!body.isConnected) return;
  body.innerHTML = habCard(hab, habData, regs) + regsCard(regs) + eatCard(eat);
}

function habCard(hab, data, regs) {
  const portal = data?.portal ?? 'https://www.oregon.gov/oha/ph/healthyenvironments/recreation/harmfulalgaeblooms/pages/blue-greenalgaeadvisories.aspx';
  return `<div class="card"><h3>Toxic algae</h3>
    ${hab.length ? hab.map(a => { const l = OR_HAB[a.level]; return `<div class="banner hab-${a.level}"><b>${l.icon} ${esc(a.advisory)}</b> · ${esc(a.name)}${a.county ? ` <span class="small">(${esc(a.county)} County)</span>` : ''}${a.date ? `<div class="small">Issued ${day(a.date)}</div>` : ''}
        <div class="small">${l.advice}</div>${a.detail ? `<div class="small muted">${esc(a.detail)}</div>` : ''}</div>`; }).join('')
      : regs && !regs.inOregon ? '<p class="small">This water isn’t in an Oregon angling zone, so OHA’s list may not cover it: check the state it’s in.</p>'
      : data ? '<p class="small">✅ No active toxic algae advisory listed for this water.</p>' : ''}
    <p class="muted small">${data ? `Oregon Health Authority list, refreshed nightly (${fmtDate(data.updatedAt)}). ` : 'Algae advisories haven’t been downloaded yet. '}OHA only samples some waters: avoid scum and keep dogs out of discolored water anywhere. <a href="${esc(portal)}" target="_blank" rel="noopener">OHA advisories ↗</a></p></div>`;
}

const rules = lines => lines.map(t => t.startsWith('§ ') ? `<p class="small"><b>${esc(t.slice(2))}</b></p>` : `<p class="small">${esc(t)}</p>`).join('');
const ruleRow = w => `<div class="reg"><div><b>${esc(w.name)}</b> <span class="muted small">${esc(w.zone)} Zone</span></div>${rules(w.rules)}</div>`;

function regsCard(regs) {
  if (!regs) return `<div class="card"><h3>Fishing regulations</h3><p class="muted small">Regulations haven’t been downloaded yet. See the <a href="https://www.eregulations.com/oregon/fishing" target="_blank" rel="noopener">Oregon fishing regulations ↗</a>.</p></div>`;
  const z = regs.zoneRules;
  return `<div class="card"><h3>Fishing regulations</h3>
    ${regs.inLake ? `<p class="small">This part of the river is in ${esc(regs.inLake)}: follow ${esc(regs.inLake)}’s rules, and the zone’s lake limits where they differ from streams.</p>` : ''}
    ${regs.special.length ? `<p class="small">Exceptions to the ${esc(regs.zone ?? '')} Zone rules for this water:</p>${regs.special.map(ruleRow).join('')}`
      : !regs.inOregon && !regs.zoneRules ? '<p class="small">This water isn’t in an Oregon angling zone, so Oregon’s rules may not apply: check the state it’s in.</p>'
      : `<p class="small">No exceptions name this water, so the ${regs.zone ? `${esc(regs.zone)} Zone’s` : 'zone’s'} general limits below apply.</p>`}
    ${z ? `<h3 style="margin-top:10px">${esc(regs.zone)} Zone</h3>
      ${z.general.length ? `<table><tr><th class="small">Fish</th><th class="small">Bag limit</th><th class="small">Size and season</th></tr>${z.general.map(g => `<tr><td class="small">${esc(g.species)}</td><td class="small">${esc(g.bag)}</td><td class="small">${esc([g.size, g.season].filter(Boolean).join(' · '))}</td></tr>`).join('')}</table>` : ''}
      ${z.intro.map((s, i) => `<details${i === 0 ? ' open' : ''}><summary class="small"><b>${esc(s.title || 'Zone rules')}</b></summary>${rules(s.text)}</details>`).join('')}` : ''}
    ${regs.statewide.length ? `<h3 style="margin-top:10px">Statewide rules</h3>${regs.statewide.map(s => `<details><summary class="small"><b>${esc(s.title)}</b></summary>${rules(s.text)}</details>`).join('')}` : ''}
    <p class="muted small">${esc(regs.source)}, refreshed weekly (${fmtDate(regs.updatedAt)}); matched to this water by name${regs.zone ? ` and zone (${esc(regs.zone)})` : ''}, so read the wording. ODFW changes rules in season: check <a href="${esc(regs.updates)}" target="_blank" rel="noopener">regulation updates ↗</a>. The <a href="${esc(regs.booklet)}" target="_blank" rel="noopener">official regulations ↗</a> and posted signs are the final word.</p></div>`;
}

function eatCard(eat) {
  if (!eat) return `<div class="card"><h3>Eating your catch</h3><p class="muted small">Fish advisories haven’t been downloaded yet.</p></div>`;
  const meals = (n, f) => /^0$/.test(String(n).trim()) ? '<b class="dont">Don’t eat</b>'
    : f.link && !/\d/.test(n) ? `<a href="${esc(f.link)}" target="_blank" rel="noopener">See OHA guidance ↗</a>` : esc(n);
  return `<div class="card"><h3>Eating your catch</h3>
    ${eat.site.length ? eat.site.map(a => `<p class="small"><b>${esc(a.area)}</b></p><table><tr><th class="small">Fish</th><th class="small">Kids, pregnant or nursing</th><th class="small">Everyone else</th></tr>
      ${a.fish.map(f => `<tr><td class="small">${esc(f.fish)}<div class="muted small">${esc(f.contaminant)}</div></td><td class="small">${meals(f.vulnerable, f)}</td><td class="small">${meals(f.everyone, f)}</td></tr>`).join('')}</table><p class="muted small">Meals a month.</p>`).join('')
      : '<p class="small">No advisory names this water.</p>'}
    <p class="small">${esc(eat.statewide)}</p>${eat.meal ? `<p class="muted small">${esc(eat.meal)}</p>` : ''}
    <p class="muted small">Oregon Health Authority fish advisories, refreshed weekly. <a href="${esc(eat.url)}" target="_blank" rel="noopener">OHA fish advisories ↗</a></p></div>`;
}
