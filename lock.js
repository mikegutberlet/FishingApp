// App lock: a passcode, and optionally Face ID / Touch ID / fingerprint (WebAuthn with this device's own
// authenticator), asked for when the app opens or comes back after a while. It keeps the app's screens from
// someone holding your unlocked phone. The data itself sits in the browser's storage; for files that leave the
// device, use the encrypted backup.
import { hashSecret, fromB64, toB64, randomBytes } from './crypto.js';
import { $, esc, status, onShow } from './ui.js';

const KEY = 'tackle-box-lock', FAIL_KEY = 'tackle-box-lock-fails';
const conf = () => { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } };
const save = c => c ? localStorage.setItem(KEY, JSON.stringify(c)) : localStorage.removeItem(KEY);
export const lockEnabled = () => !!conf()?.hash;

const bioAvailable = async () => !!(window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable?.().catch(() => false));
const bioLabel = () => /iPhone|iPad|Mac/.test(navigator.userAgent) ? 'Face ID / Touch ID' : 'fingerprint or face unlock';

// ---------- WebAuthn ----------
async function registerBio() {
  const cred = await navigator.credentials.create({ publicKey: {
    challenge: randomBytes(32), rp: { name: 'Tackle Box', id: location.hostname },
    user: { id: randomBytes(16), name: 'Tackle Box', displayName: 'Tackle Box app lock' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
    timeout: 60000, attestation: 'none',
  } });
  return toB64(new Uint8Array(cred.rawId));
}

// True only when the device checked the person (the UV flag in the authenticator data), not just that a key exists.
async function verifyBio(credId) {
  const a = await navigator.credentials.get({ publicKey: {
    challenge: randomBytes(32), rpId: location.hostname, userVerification: 'required', timeout: 60000,
    allowCredentials: [{ type: 'public-key', id: fromB64(credId), transports: ['internal'] }],
  } });
  return !!(new Uint8Array(a.response.authenticatorData)[32] & 0x04);
}

// ---------- The keypad sheet, used both to unlock and to set a passcode ----------
function keypad({ title, sub = '', bio = false, onCode, onBio, onForgot, cancel }) {
  document.querySelector('#lock')?.remove();
  // A modal <dialog> so it sits above any other open dialog (e.g. a waypoint sheet), which stays open underneath.
  const el = document.createElement('dialog');
  el.id = 'lock';
  el.innerHTML = `<div class="lock-box"><div class="lock-logo">🎣</div><h2>${esc(title)}</h2><p class="small muted lock-sub">${esc(sub)}</p>
    <div class="dots"></div>
    <div class="pad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button data-n="${n}">${n}</button>`).join('')}
      ${bio ? '<button data-bio title="Unlock with biometrics">👤</button>' : '<button data-ok>✓</button>'}<button data-n="0">0</button><button data-back>⌫</button></div>
    ${onForgot ? '<a href="#" class="small muted" data-forgot>Forgot passcode?</a>' : ''}${cancel ? '<button data-cancel style="margin-top:10px">Cancel</button>' : ''}</div>`;
  document.body.append(el);
  let closing = false;
  el.addEventListener('cancel', e => e.preventDefault()); // Esc / Android back can't dismiss it
  el.addEventListener('close', () => { if (!closing && el.isConnected) el.showModal(); });
  el.showModal();
  let code = '';
  const dots = el.querySelector('.dots');
  const draw = () => dots.innerHTML = Array.from({ length: Math.max(4, code.length) }, (_, i) => `<i class="${i < code.length ? 'on' : ''}"></i>`).join('');
  const api = {
    el, shake(msg) { el.querySelector('.lock-box').classList.remove('shake'); void el.offsetWidth; el.querySelector('.lock-box').classList.add('shake'); code = ''; draw(); if (msg) api.sub(msg); },
    sub: t => el.querySelector('.lock-sub').textContent = t, close: () => { closing = true; el.close(); el.remove(); }, code: () => code,
  };
  const press = k => {
    if (k === 'back') code = code.slice(0, -1);
    else if (k === 'ok') { if (code.length >= 4) onCode(code, api, true); return; }
    else if (code.length < 8) code += k;
    draw();
    onCode(code, api, false);
  };
  el.querySelectorAll('[data-n]').forEach(b => b.onclick = () => press(b.dataset.n));
  el.querySelector('[data-back]').onclick = () => press('back');
  el.querySelector('[data-ok]')?.addEventListener('click', () => press('ok'));
  el.querySelector('[data-bio]')?.addEventListener('click', () => onBio(api));
  el.querySelector('[data-forgot]')?.addEventListener('click', e => { e.preventDefault(); onForgot(api); });
  el.querySelector('[data-cancel]')?.addEventListener('click', () => { api.close(); cancel(); });
  const keys = e => { if (!document.body.contains(el)) return document.removeEventListener('keydown', keys); if (/^\d$/.test(e.key)) press(e.key); else if (e.key === 'Backspace') press('back'); else if (e.key === 'Enter') press('ok'); };
  document.addEventListener('keydown', keys);
  draw();
  return api;
}

// ---------- Locking ----------
let locked = false, hiddenAt = null;

const fails = () => { try { return JSON.parse(localStorage.getItem(FAIL_KEY)) ?? { n: 0, until: 0 }; } catch { return { n: 0, until: 0 }; } };

export function lock() {
  const c = conf();
  if (!c?.hash || locked) return;
  locked = true;
  document.documentElement.classList.add('locked');
  // Other dialogs (waypoint editor, offline download) are parked while locked: closed with data-parked set, so their
  // onclose can tell this apart from a real close and keep their state, then reopened on unlock. Left open under the
  // lock they could land above it, or be closed by repeated Back presses.
  const parked = [], park = d => { d.dataset.parked = ''; d.close(); parked.push(d); };
  document.querySelectorAll('dialog[open]:not(#lock)').forEach(park);
  let watch;
  const unlock = api => {
    locked = false; localStorage.removeItem(FAIL_KEY);
    document.documentElement.classList.remove('locked');
    watch?.disconnect();
    api.close();
    parked.forEach(d => { delete d.dataset.parked; if (d.isConnected && !d.open) d.showModal(); });
  };
  const tryBio = api => verifyBio(c.cred).then(ok => ok ? unlock(api) : api.sub('Not recognised. Enter your passcode.')).catch(() => api.sub('Enter your passcode.'));
  const pad = keypad({
    title: 'Tackle Box is locked', sub: c.cred ? `Use ${bioLabel()} or your passcode` : 'Enter your passcode', bio: !!c.cred,
    onCode: async (code, api) => {
      if (code.length !== c.len) return;
      const f = fails();
      if (Date.now() < f.until) return api.shake(`Too many tries. Wait ${Math.ceil((f.until - Date.now()) / 1000)} s.`);
      if ((await hashSecret(code, fromB64(c.salt), c.iter)).hash === c.hash) return unlock(api);
      f.n++; if (f.n >= 5) f.until = Date.now() + 30e3 * 2 ** (f.n - 5);
      localStorage.setItem(FAIL_KEY, JSON.stringify(f));
      api.shake(f.n >= 5 ? `Wrong passcode. Wait ${Math.round(30 * 2 ** (f.n - 5))} s before trying again.` : 'Wrong passcode');
    },
    onBio: tryBio,
    onForgot: () => {
      if (!confirm('Without the passcode the only way in is to erase Tackle Box on this device: every catch, note, photo and depth map.\n\nIf you have a backup file you can import it afterwards. Erase everything?')) return;
      if (prompt('Type ERASE to confirm') !== 'ERASE') return;
      save(null);
      const req = indexedDB.deleteDatabase('tackle-box');
      req.onsuccess = req.onerror = req.onblocked = () => location.reload();
    },
  });
  watch = new MutationObserver(ms => ms.forEach(({ target: d }) => { if (d !== pad.el && d.tagName === 'DIALOG' && d.open) park(d); }));
  watch.observe(document.body, { subtree: true, attributeFilter: ['open'] });
  if (c.cred) tryBio(pad); // iPhones may want a tap first; the 👤 key is there for that
}

// Lock again when the app comes back after `after` minutes in the background (0 = every time).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
  const c = conf();
  if (c?.hash && hiddenAt && Date.now() - hiddenAt >= (c.after ?? 1) * 60e3) lock();
  hiddenAt = null;
});

// ---------- Settings card ----------
function setPasscode(done) {
  let first = null;
  keypad({
    title: 'Choose a passcode', sub: '4 to 8 digits, then ✓', cancel: done,
    onCode: async (code, api, submit) => {
      if (!submit) return;
      if (!first) { first = code; api.shake(); api.sub('Enter it again, then ✓'); return; }
      if (code !== first) { first = null; return api.shake("They didn't match. Choose a passcode, then ✓"); }
      save({ ...conf(), ...await hashSecret(code), len: code.length, after: conf()?.after ?? 1 });
      api.close(); status('App lock on'); done();
    },
  });
}

export async function renderLockCard() {
  const el = $('#lock-card');
  if (!el) return;
  const c = conf(), bio = await bioAvailable();
  el.innerHTML = `<h3>🔒 App lock</h3>
    ${c?.hash ? `<p class="small">On. Tackle Box asks for your passcode${c.cred ? ` or ${bioLabel()}` : ''} when it opens.</p>
      <form class="form" id="lock-form">
        <label>Lock again after it's been in the background <select name="after">${[[0, 'immediately'], [1, '1 minute'], [5, '5 minutes'], [15, '15 minutes'], [60, '1 hour']].map(([v, l]) => `<option value="${v}" ${v === (c.after ?? 1) ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        ${bio ? `<label class="check"><input type="checkbox" name="bio" ${c.cred ? 'checked' : ''}> Unlock with ${bioLabel()}</label>` : ''}
      </form>
      <div class="row"><button id="lock-change" style="flex:1">Change passcode</button><button id="lock-off" class="danger" style="flex:1">Turn off</button></div>`
    : `<p class="small">Ask for a passcode${bio ? ` or ${bioLabel()}` : ''} whenever the app opens, so someone holding your phone can't browse your spots.</p>
      <button id="lock-on" class="primary">Set a passcode</button>`}
    <p class="muted small">Forgetting the passcode means erasing the app's data on this phone, so keep a backup.</p>`;
  $('#lock-on')?.addEventListener('click', () => setPasscode(renderLockCard));
  $('#lock-change')?.addEventListener('click', () => setPasscode(renderLockCard));
  $('#lock-off')?.addEventListener('click', () => { if (confirm('Turn off the app lock?')) { save(null); status('App lock off'); renderLockCard(); } });
  const form = $('#lock-form');
  if (form) form.onchange = async e => {
    const cur = conf();
    if (e.target.name === 'after') save({ ...cur, after: +e.target.value });
    if (e.target.name === 'bio') {
      if (!e.target.checked) save({ ...cur, cred: null });
      else try { save({ ...cur, cred: await registerBio() }); status(`${bioLabel()} on`); }
      catch (err) { e.target.checked = false; alert(`Couldn't set up ${bioLabel()}: ${err.message}`); }
    }
    renderLockCard();
  };
}

onShow('settings', renderLockCard);
lock(); // at startup, before anything else renders (index.html hides the screens while a lock is set)
