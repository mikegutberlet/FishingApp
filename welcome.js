// First run and friends: a short welcome (what Tackle Box is, what stays on the phone, how to put it on the home
// screen), the install help and the "Invite a friend" card in Settings, and the app shortcuts (#go=log).
// An invite link is the app's address plus #hi=<name>; the part after # never reaches the website.
import { db } from './db.js';
import { $, esc, status, showView, onShow } from './ui.js';

const SEEN = 'tackle-box-welcome';
const NAME_KEY = 'tackle-box-crew-name'; // the same name crew.js puts on what you share
export const APP_URL = location.origin + location.pathname;

const ua = navigator.userAgent;
export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
export const isIos = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = /Android/.test(ua);
// Links opened from Instagram, Facebook, the Google app and the like land in that app's own browser, which can't install.
const inAppBrowser = /FBAN|FBAV|Instagram|Line\/|Snapchat|LinkedInApp|GSA\//.test(ua);
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  del: k => { try { localStorage.removeItem(k); } catch {} } };

// ---------- Install ----------
// Chrome, Edge and Samsung Internet on Android offer a real Install button; keep the offer for our own button.
let installEvent = null;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvent = e; refreshInstall(); });
addEventListener('appinstalled', () => { installEvent = null; status('Tackle Box is on your home screen'); refreshInstall(); });

export function installSteps() {
  if (isStandalone()) return '<p>✅ Tackle Box is on this phone\'s home screen. Open it from the icon, not the browser, so your data stays in one place.</p>';
  if (inAppBrowser) return `<p>You opened this inside another app, which can't install it. Tap that app's <b>⋯</b> or <b>⋮</b> menu and choose
    <b>Open in ${isIos ? 'Safari' : 'Chrome'}</b> (or <i>Open in browser</i>), then come back here.</p>`;
  if (isIos) return `<ol class="wl-steps">
      <li>Tap the <b>Share</b> button <span class="wl-key">${shareGlyph}</span>. In Safari it's in the bottom bar, or under <b>⋯</b>; in Chrome it's at the top right.</li>
      <li>Scroll down and tap <b>Add to Home Screen</b>, then <b>Add</b>.</li>
      <li>Open <b>Tackle Box</b> from the new icon on your home screen.</li></ol>
    <p class="small wl-note">On iPhone the home-screen app keeps its own data, apart from Safari, and Safari can clear a site's data after a week unused.
      So add it first, and from then on log catches in the home-screen app.</p>`;
  if (isAndroid) return `${installEvent ? '<button class="primary wl-install">Install Tackle Box</button>' : ''}
    <ol class="wl-steps">${installEvent ? '<li>Or by hand:' : '<li>'} in <b>Chrome</b> tap <b>⋮</b> (top right), then <b>Install app</b> or <b>Add to Home screen</b>.</li>
      <li>Samsung Internet: <b>☰</b> → <b>Add page to</b> → <b>Home screen</b>. Firefox: <b>⋮</b> → <b>Install</b>.</li>
      <li>Open <b>Tackle Box</b> from the new icon.</li></ol>`;
  return `${installEvent ? '<button class="primary wl-install">Install on this computer</button>' : ''}
    <p>Tackle Box is made for your phone. Scan this with the phone's camera to open it there, then add it to the home screen.</p>
    <div class="qr wl-qr" data-qr="${esc(APP_URL)}"></div>
    <p class="small muted">iPhone: Safari → Share → Add to Home Screen. Android: Chrome → ⋮ → Install app.</p>`;
}
const shareGlyph = '<svg class="ic" aria-hidden="true"><use href="#i-share"/></svg>';

// Fill in the install steps (and any QR code or Install button) inside an element.
async function fillInstall(el) {
  el.innerHTML = installSteps();
  el.querySelector('.wl-install')?.addEventListener('click', async () => {
    if (!installEvent) return;
    installEvent.prompt();
    const { outcome } = await installEvent.userChoice.catch(() => ({}));
    if (outcome === 'accepted') installEvent = null;
    fillInstall(el);
  });
  for (const q of el.querySelectorAll('[data-qr]')) q.innerHTML = await qrSvg(q.dataset.qr).catch(() => '');
}
function refreshInstall() { document.querySelectorAll('.wl-install-box').forEach(fillInstall); }

// ---------- QR codes (vendor/qrcode, also used by crew.js) ----------
let qrLoaded;
const loadQr = () => qrLoaded ??= new Promise((res, rej) => {
  if (globalThis.qrcode) return res();
  const s = document.createElement('script'); s.src = 'vendor/qrcode/qrcode.js'; s.onload = res; s.onerror = rej; document.head.append(s);
});
export async function qrSvg(text) {
  await loadQr();
  const qr = qrcode(0, 'M'); qr.addData(text, 'Byte'); qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
}

// A sheet with a QR code, a line under it, and buttons to send or copy the link.
export async function showQrSheet(url, { title = 'Scan with the phone camera', text = '', shareText = '' } = {}) {
  const sheet = document.createElement('div');
  sheet.className = 'qr-sheet';
  sheet.innerHTML = `<div class="qr-sheet-card"><h3>${esc(title)}</h3><div class="qr">${await qrSvg(url)}</div>
    ${text ? `<p class="small">${text}</p>` : ''}
    <div class="row"><button class="wl-send" style="flex:1">Send link</button><button class="primary wl-done" style="flex:1">Done</button></div></div>`;
  document.body.append(sheet);
  sheet.querySelector('.wl-done').onclick = () => sheet.remove();
  sheet.onclick = e => { if (e.target === sheet) sheet.remove(); };
  sheet.querySelector('.wl-send').onclick = () => sendLink(url, { text: shareText });
}

// The phone's share sheet when it has one (Messages, WhatsApp, email…), else copy to the clipboard.
export async function sendLink(url, { title = 'Tackle Box', text = '' } = {}) {
  if (navigator.share) {
    try { await navigator.share({ title, text, url }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(text ? `${text} ${url}` : url); status('Link copied'); }
  catch { prompt('Copy this link:', url); }
}

// ---------- Invite a friend (Settings) ----------
const myName = () => store.get(NAME_KEY)?.trim() || '';
export const inviteUrl = () => APP_URL + (myName() ? `#hi=${encodeURIComponent(myName().slice(0, 40))}` : '');
const INVITE_TEXT = 'Tackle Box, my private fishing app: lake conditions, stocking, depth maps and a catch log. No account, and what you log stays on your phone. Open this on your phone and add it to your home screen:';

function renderInvite() {
  const el = $('#invite-card');
  if (!el) return;
  el.innerHTML = `<h3>📲 Invite a friend</h3>
    <p class="small">Send them the app's link, or let them scan the code with their phone camera. None of your data goes with it:
      each friend's catches, notes and spots stay on their own phone.${myName() ? ` The link says it's from <b>${esc(myName())}</b>.` : ''}</p>
    <div class="row"><button class="primary" id="wl-invite" style="flex:1">Send the link</button><button id="wl-invite-qr" style="flex:1">Show QR code</button></div>
    <label class="small wl-name">Your name on what you share <input id="wl-name" value="${esc(myName())}" placeholder="First name or nickname" maxlength="40" autocomplete="given-name"></label>
    <div class="row small wl-links"><button id="wl-open-link" style="flex:1">Open a link a friend sent</button></div>
    <p class="small"><a href="guide.html" target="_blank" rel="noopener">Getting started guide for friends</a> · <a href="#" id="wl-again">Show the welcome again</a></p>`;
  $('#wl-invite').onclick = () => sendLink(inviteUrl(), { text: INVITE_TEXT });
  $('#wl-invite-qr').onclick = () => showQrSheet(inviteUrl(), { title: 'Scan to get Tackle Box', shareText: INVITE_TEXT,
    text: 'Open it on the phone, then add it to the home screen. The guide in Settings walks them through it.' });
  $('#wl-name').onchange = e => { const v = e.target.value.trim().slice(0, 40); v ? store.set(NAME_KEY, v) : store.del(NAME_KEY); renderInvite(); };
  $('#wl-open-link').onclick = openPasted;
  $('#wl-again').onclick = e => { e.preventDefault(); openWelcome(); };
}

// A link pasted from Messages (on iPhone the home-screen app can't open links itself): a water or a crew share.
// Setting the hash hands it to whichever module reads that link.
function openPasted() {
  const t = prompt('Paste the link or code your friend sent:')?.trim();
  if (!t) return;
  const m = t.match(/#((?:water|crew)=[\w-]+)/) ?? (/^[zj][\w-]{20,}$/.test(t) ? [, `crew=${t}`] : null);
  if (!m) return alert("That doesn't look like a Tackle Box link. Copy the whole link from the message and try again.");
  if (location.hash === '#' + m[1]) location.hash = '';
  location.hash = m[1];
}

// ---------- The welcome ----------
const WELCOME_PAGES = invitedBy => [
  { key: 'hi', html: `<div class="wl-hero">🎣</div><h2>Welcome to Tackle Box</h2>
    ${invitedBy ? `<p><b>${esc(invitedBy)}</b> sent you this.</p>` : ''}
    <p>A private fishing app for California, Nevada, Oregon and the coast.</p>
    <ul class="wl-list"><li>🌤️ Weather, wind and river flows for any lake, river or pier</li><li>🐟 Stocking reports, plant history and regulations</li>
      <li>🗺️ Depth maps, and maps that work with no signal</li><li>📒 Your catch log, notes, photos and trips</li></ul>` },
  { key: 'privacy', html: `<div class="wl-hero">🔒</div><h2>Your fishing stays on your phone</h2>
    <ul class="wl-list">
      <li><b>No account, no sign-up.</b> Nothing you log is uploaded anywhere.</li>
      <li><b>Catches, photos, notes and spots</b> are saved only on this phone.${invitedBy ? ` ${esc(invitedBy)} can't see them either.` : ' Friends you share the app with can\'t see them.'}</li>
      <li><b>Weather, maps and stocking</b> are looked up by the water's location (or the map area you're viewing), never with your catches.
        The full list is in ⚙️ → <i>What leaves your device</i>.</li>
      <li><b>Sharing is only when you tap Share</b>: straight to a friend as a link, file or QR code.</li>
      <li><b>Back it up now and then</b> (⚙️ → Export backup), since there's no cloud copy. The app reminds you.</li></ul>` },
  { key: 'install', skip: isStandalone, html: `<div class="wl-hero">📲</div><h2>Put it on your home screen</h2>
    <p class="small">It opens full screen, works with no signal at the lake, and keeps your data safe from browser cleanup.</p>
    <div class="wl-install-box"></div>` },
  { key: 'name', html: `<div class="wl-hero">👋</div><h2>What should your crew call you?</h2>
    <p class="small">Optional. It goes only on catches, spots and plans you choose to share, so friends know who sent them.</p>
    <label class="wl-name">Your name <input id="wl-first-name" maxlength="40" placeholder="First name or nickname" autocomplete="given-name" value="${esc(myName())}"></label>
    <p class="small"><a href="guide.html" target="_blank" rel="noopener">Read the getting started guide</a></p>` },
];

export function openWelcome({ invitedBy = '' } = {}) {
  document.querySelector('.wl-sheet')?.remove();
  const pages = WELCOME_PAGES(invitedBy).filter(p => !p.skip?.());
  const sheet = document.createElement('div');
  sheet.className = 'wl-sheet';
  sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true'); sheet.setAttribute('aria-label', 'Welcome to Tackle Box');
  let i = 0;
  const finish = () => {
    const name = sheet.querySelector('#wl-first-name')?.value.trim().slice(0, 40);
    if (name) store.set(NAME_KEY, name);
    store.set(SEEN, new Date().toISOString());
    sheet.remove();
    renderInvite();
  };
  const draw = () => {
    const p = pages[i], last = i === pages.length - 1;
    sheet.innerHTML = `<div class="wl-card"><div class="wl-top"><span class="wl-dots">${pages.map((_, j) => `<i class="${j === i ? 'on' : ''}"></i>`).join('')}</span>
        ${last ? '' : '<button class="ghost wl-skip">Skip</button>'}</div>
      <div class="wl-body">${p.html}</div>
      <div class="row wl-nav">${i ? '<button class="wl-back" style="flex:1">Back</button>' : ''}<button class="primary wl-next" style="flex:2">${last ? 'Start fishing' : 'Next'}</button></div></div>`;
    sheet.querySelector('.wl-skip')?.addEventListener('click', finish);
    sheet.querySelector('.wl-back')?.addEventListener('click', () => { i--; draw(); });
    sheet.querySelector('.wl-next').onclick = () => { if (last) finish(); else { i++; draw(); } };
    sheet.querySelectorAll('.wl-install-box').forEach(fillInstall);
    sheet.querySelector('.wl-next').focus({ preventScroll: true });
  };
  draw();
  document.body.append(sheet);
}

// Show it once, to someone new: not to anyone who already has waters or catches (they were here before this existed).
async function maybeWelcome(invitedBy) {
  if (store.get(SEEN)) return;
  if (document.documentElement.classList.contains('locked')) return;
  const [lakes, catches] = await Promise.all([db.all('lakes'), db.all('catches')]).catch(() => [[], []]);
  if ((lakes.length || catches.length) && !invitedBy) return store.set(SEEN, 'had data');
  openWelcome({ invitedBy });
}

// ---------- Links: #hi=<name> (an invite) and #go=<view> (home-screen shortcuts) ----------
function readHash() {
  const h = location.hash;
  const hi = h.match(/^#hi=([^&]*)/), go = h.match(/^#go=(\w+)/);
  if (!hi && !go) return null;
  history.replaceState(null, '', location.pathname + location.search);
  if (go) {
    // On a cold start this runs while the app's modules are still loading: wait until app.js has shown Today and wired the SOS button.
    setTimeout(() => go[1] === 'sos' ? $('#btn-sos')?.click() : document.getElementById(`view-${go[1]}`) && showView(go[1]), 0);
    return null;
  }
  try { return decodeURIComponent(hi[1]).replace(/[<>]/g, '').trim().slice(0, 40); } catch { return ''; }
}

const openedShare = /^#(water|crew)=/.test(location.hash); // a friend's water or share: let it show; the welcome waits for the next start
const invitedBy = readHash();
addEventListener('hashchange', readHash);
if (!openedShare) setTimeout(() => maybeWelcome(invitedBy || ''), 300); // after app.js has drawn Today

// Settings: install steps, the invite card, and the "see the full list" link in the privacy summary.
onShow('settings', () => { document.querySelectorAll('#install-help').forEach(el => { el.classList.add('wl-install-box'); fillInstall(el); }); renderInvite(); });
document.addEventListener('click', e => {
  const a = e.target.closest?.('[data-scroll]');
  if (!a) return;
  e.preventDefault();
  document.getElementById(a.dataset.scroll)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
