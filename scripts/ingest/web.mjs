// Links for scripts/ingest.mjs: the urls.md list, robots.txt, the article text out of a page, and a polite fetch.
export const UA = 'TackleBoxArchive/1.0 (+https://github.com/mikegutberlet/FishingApp)';
export const sleep = ms => new Promise(r => setTimeout(r, ms));

// urls.md: one URL per line; text after two or more spaces names the water the page is about.
export function parseUrls(md) {
  const out = [], seen = new Set();
  for (const line of String(md).split('\n')) {
    const m = line.trim().match(/^(https?:\/\/\S+)(?:\s{2,}(.+))?$/);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]); out.push(m[2] ? { url: m[1], water: m[2].trim() } : { url: m[1] });
  }
  return out;
}

// The most specific user-agent group (ours over *), longest matching rule wins, Allow wins a tie.
export function robotsAllows(robotsTxt, pathname, ua = 'TackleBoxArchive') {
  const groups = [], want = ua.toLowerCase();
  let cur = null;
  for (let line of String(robotsTxt ?? '').split('\n')) {
    line = line.replace(/#.*/, '').trim(); if (!line) continue;
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i); if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === 'user-agent') { if (!cur || cur.rules.length) { cur = { agents: [], rules: [] }; groups.push(cur); } cur.agents.push(val.toLowerCase()); }
    else if ((key === 'allow' || key === 'disallow') && cur) cur.rules.push({ allow: key === 'allow', path: val });
  }
  const group = groups.find(g => g.agents.some(a => a !== '*' && want.startsWith(a))) ?? groups.find(g => g.agents.includes('*'));
  if (!group) return true;
  let best = null;
  for (const r of group.rules) {
    if (!r.path) continue;
    const re = new RegExp('^' + r.path.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*').replace(/\\\$$/, '$'));
    if (re.test(pathname) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
  }
  return best ? best.allow : true;
}

// ---------- Article text ----------
const DROP = ['script', 'style', 'noscript', 'nav', 'header', 'footer', 'aside', 'form', 'svg'];
const decode = s => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));
const text = s => decode(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
export function articleText(html) {
  let h = String(html).replace(/<!--[\s\S]*?-->/g, '');
  const title = text(h.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '');
  for (const tag of DROP) { const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'); let prev; do { prev = h; h = h.replace(re, ' '); } while (h !== prev); }
  const pick = tag => h.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'i'))?.[1];
  const body = pick('article') ?? pick('main') ?? pick('body') ?? h;
  let paragraphs = [...body.matchAll(/<(p|li|h[1-6]|blockquote|td)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)].map(m => text(m[2])).filter(Boolean);
  // Older pages leave <p> unclosed (valid HTML): fall back to splitting on block tags.
  if (!paragraphs.length) paragraphs = body.replace(/<\/?(p|li|h[1-6]|blockquote|td|tr|div|section)\b[^>]*>/gi, '\n\n').split(/\n\s*\n/).map(text).filter(Boolean);
  return { title, paragraphs };
}

// ---------- Fetching ----------
export async function fetchPage(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*;q=0.5' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    return { status: r.status, html: r.ok ? await r.text() : undefined };
  } catch { return { status: 0 }; }
}
export async function fetchAllowed(url) {
  let u; try { u = new URL(url); } catch { return false; }
  const r = await fetchPage(`${u.origin}/robots.txt`);
  return r.status === 200 ? robotsAllows(r.html ?? '', u.pathname) : true;
}
