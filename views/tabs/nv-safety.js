// Regs & safety for Nevada waters: toxic algae advisories, NDOW regulations (special rules for the water, its
// region's limits, closed waters) and health advisories on eating fish. Also the algae banner on the lake page.
import * as NV from '../../states/nv.js';
import { forLake } from '../../states/index.js';
import { esc, fmtDate } from '../../ui.js';

const day = iso => iso ? fmtDate(iso + 'T12:00') : '';

// Nevada's three advisory levels (Office of State Epidemiology), mapped onto the app's banner colors.
export const NV_HAB = {
  danger: { label: 'HAB Danger', icon: '⛔', advice: 'Stay out of the water. Conditions are extremely unsafe for people and animals. Keep pets away and don’t eat fish from here.' },
  warning: { label: 'HAB Warning', icon: '⚠️', advice: 'Avoid contact with the water: no swimming, keep pets out. If you keep fish, throw away the guts and rinse fillets in clean water.' },
  caution: { label: 'HAB Watch', icon: '⚠️', advice: 'Hazardous conditions are possible. Use caution in the water, avoid algae and scum, and keep pets from drinking it.' },
};

// Under the water's name on its page, when there is an algae advisory.
export async function renderNvBanner(lake, page) {
  if (forLake(lake) !== NV) return;
  const h2 = page.querySelector('h2');
  const top = (await NV.habFor(lake)).sort((a, b) => ['caution', 'warning', 'danger'].indexOf(b.level) - ['caution', 'warning', 'danger'].indexOf(a.level))[0];
  if (!top || !h2?.isConnected) return;
  const l = NV_HAB[top.level];
  const el = document.createElement('div');
  h2.after(el);
  el.innerHTML = `<div class="banner hab-${top.level}"><b>${l.icon} Toxic algae: ${l.label}</b> · ${esc(top.name)}${top.date ? `, since ${day(top.date)}` : ''}
    <div class="small">${l.advice}</div><a href="#" class="small" data-safety-tab>Details ›</a></div>`;
  el.querySelector('[data-safety-tab]').onclick = e => { e.preventDefault(); document.querySelector('.tabs button[data-tab="safety"]')?.click(); };
}

export async function renderNvSafety(lake, body) {
  document.querySelector('.tabs button.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  body.innerHTML = '<div class="card muted">Loading rules and advisories…</div>';
  const [hab, habData, regs, eat] = await Promise.all([NV.habFor(lake), NV.habAdvisories(), NV.regsFor(lake), NV.fishAdviceFor(lake)]);
  if (!body.isConnected) return;
  body.innerHTML = habCard(hab, habData) + regsCard(lake, regs) + eatCard(eat);
}

function habCard(hab, data) {
  const portal = data?.portal ?? 'https://nvose.org/hot-topic-harmful-algal-blooms/';
  return `<div class="card"><h3>Toxic algae</h3>
    ${hab.length ? hab.map(a => { const l = NV_HAB[a.level]; return `<div class="banner hab-${a.level}"><b>${l.icon} ${l.label}</b> · ${esc(a.name)}
        <div class="small">${l.advice}</div><div class="small muted">${esc(a.detail)}</div></div>`; }).join('')
      : data ? '<p class="small">✅ No active toxic algae advisory listed for this water.</p>' : ''}
    <p class="muted small">${data ? `Nevada Office of State Epidemiology list, refreshed nightly (${fmtDate(data.updatedAt)}). ` : 'Algae advisories haven’t been downloaded yet. '}Blooms can appear fast: avoid scum and keep dogs out of discolored water. <a href="${esc(portal)}" target="_blank" rel="noopener">Nevada HAB reports ↗</a></p></div>`;
}

const ruleRow = w => `<div class="reg"><div><b>${esc(w.name)}</b>${w.county ? ` <span class="muted small">${esc(w.county)}${/City$/.test(w.county) ? '' : ' County'}</span>` : ''}</div>
  <table><tr><th class="small">Season and hours</th><th class="small">Daily limit</th></tr><tr><td class="small">${esc(w.season)}</td><td class="small">${esc(w.limit)}</td></tr></table>
  ${w.notes.map(n => `<p class="small">${esc(n)}</p>`).join('')}</div>`;

function regsCard(lake, regs) {
  if (!regs) return `<div class="card"><h3>Fishing regulations</h3><p class="muted small">Regulations haven’t been downloaded yet. See the <a href="https://www.eregulations.com/nevada/fishing" target="_blank" rel="noopener">Nevada fishing regulations ↗</a>.</p></div>`;
  const where = regs.region ? `${regs.region} Region` : 'its region';
  return `<div class="card"><h3>Fishing regulations</h3>
    ${regs.special.length ? regs.special.map(ruleRow).join('') : `<p class="small">No special regulations name this water, so ${esc(where)}’s general seasons and limits below apply.</p>`}
    ${regs.regionRules ? `<h3 style="margin-top:10px">${esc(regs.region)} Region</h3>${regs.regionRules.general.map((s, i) => `<details${i < 2 ? ' open' : ''}><summary class="small"><b>${esc(s.title.replace(/^(Western|Southern|Eastern) Region /, ''))}</b></summary>${s.text.map(t => `<p class="small">${esc(t)}</p>`).join('')}</details>`).join('')}` : ''}
    ${regs.closed.length ? `<details><summary class="small"><b>Closed waters in ${esc(regs.county)}${/City$/.test(regs.county) ? '' : ' County'}</b></summary>${regs.closed.map(c => `<p class="small">${esc(c.text)}</p>`).join('')}</details>` : ''}
    <h3 style="margin-top:10px">Statewide rules</h3>
    ${regs.statewide.map(s => `<details><summary class="small"><b>${esc(s.title)}</b></summary>${s.text.map(t => `<p class="small">${esc(t)}</p>`).join('')}</details>`).join('')}
    <p class="muted small">${esc(regs.source)}, refreshed weekly (${fmtDate(regs.updatedAt)}); matched to this water by name${regs.county ? ` and county (${esc(regs.county)})` : ''}, so read the wording. The <a href="${esc(regs.booklet)}" target="_blank" rel="noopener">official regulations ↗</a> and posted signs are the final word.</p></div>`;
}

function eatCard(eat) {
  if (!eat) return `<div class="card"><h3>Eating your catch</h3><p class="muted small">Fish advisories haven’t been downloaded yet.</p></div>`;
  return `<div class="card"><h3>Eating your catch</h3>
    ${eat.site.length ? eat.site.map(a => `<p class="small"><b>${esc(a.area)}</b></p><table><tr><th class="small">Fish</th><th class="small">Advice</th></tr>
      ${a.fish.map(([sp, adv]) => `<tr><td class="small">${esc(sp)}</td><td class="small">${/no consumption/i.test(adv) ? '<b class="dont">Don’t eat</b>' : esc(adv)}</td></tr>`).join('')}</table>`).join('')
      : '<p class="small">No mercury advisory names this water.</p>'}
    <p class="small">${esc(eat.statewide)}</p>
    <p class="muted small">Nevada Division of Public and Behavioral Health advisories, as listed in the fishing regulations. <a href="${esc(eat.url)}" target="_blank" rel="noopener">Mercury in fish ↗</a></p></div>`;
}

// The tab for any water: Nevada's rules here; other states link to their own regulations until they have a tab.
export async function renderStateSafety(lake, body) {
  const S = forLake(lake);
  if (S === NV) return renderNvSafety(lake, body);
  body.innerHTML = `<div class="card"><h3>Fishing regulations</h3><p class="small">${S ? `See the <a href="${S.code === 'CA' ? 'https://wildlife.ca.gov/Regulations' : '#'}" target="_blank" rel="noopener">${esc(S.name)} fishing regulations ↗</a>.` : 'Check your state’s fishing regulations.'}</p></div>`;
}
