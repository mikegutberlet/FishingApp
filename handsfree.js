// Hands-free logging for wet or slimy hands: the whole screen becomes three big targets (Fish, Bite, Lost), the fish
// goes in as the species you picked once, and each tap can be undone for a few seconds. Where the browser can listen
// (Chrome on Android, Safari), a 🎤 button takes spoken words instead: "fish", "rainbow 14 inches", "bite", "lost one".
// Listening is off until you turn it on, and stops when you leave this screen.
import { esc } from './ui.js';

const SPECIES_KEY = 'tackle-box-hf-species';
const VOICE_OK_KEY = 'tackle-box-hf-voice-ok';
const Rec = () => window.SpeechRecognition || window.webkitSpeechRecognition;
export const canListen = () => !!Rec();

const NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50 };
// "twenty two" → 22, "14" → 14, "fourteen and a half" → 14.5.
function numberIn(words) {
  const m = words.match(/(\d+(?:\.\d+)?)/);
  if (m) return +m[1] + (/\d\s*(and a half|point five)/.test(words) ? 0.5 : 0);
  let n = null;
  for (const w of words.split(/[\s-]+/)) {
    const v = NUMBERS[w];
    if (v == null) { if (n != null && w !== 'and') break; continue; }
    n = n != null && n >= 20 && v < 10 ? n + v : v;
  }
  return n == null ? null : n + (/and a half/.test(words) ? 0.5 : 0);
}

// What a spoken phrase asks for: { kind: 'catch', species, length (inches) } | { kind: 'bite' } | { kind: 'lost' } |
// { kind: 'undo' } | null. species is matched against the names you pick from, by any word of four letters or more
// ("rainbow" finds "Rainbow trout"), longest name first.
export function parseSpoken(text, species = []) {
  const s = ` ${String(text).toLowerCase().replace(/[^a-z0-9. ]/g, ' ').replace(/\s+/g, ' ')} `;
  if (/\b(undo|scratch that|delete that|cancel that)\b/.test(s)) return { kind: 'undo' };
  if (/\blost (a |my |the )?(lure|jig|spoon|spinner|fly|plug|bait)\b/.test(s)) return null; // a lost lure needs its name: use the button
  if (/\b(lost (it|him|her|one|a fish|the fish|that one)|got off|came off|shook (it|him) off|spit (it|the hook))\b/.test(s)) return { kind: 'lost' };
  if (/\b(bite|hit|strike|nibble|tap|bump)\b/.test(s) && !/\b(fish on|caught|landed|got one|got him|netted)\b/.test(s)) return { kind: 'bite' };
  const named = [...species].sort((a, b) => b.length - a.length).find(sp => sp.toLowerCase().split(/\s+/).filter(w => w.length >= 4 && !/^(fish|trout|bass)$/.test(w)).some(w => s.includes(` ${w} `)))
    ?? species.find(sp => s.includes(` ${sp.toLowerCase()} `));
  const len = s.match(/\b([a-z0-9. -]+?)\s*(inch|inches|in|cm|centimeters?)\b/);
  let length = len ? numberIn(len[1].trim().split(' ').slice(-4).join(' ')) : null;
  if (length != null && /cm|centimeter/.test(len[2])) length = Math.round(length / 2.54 * 10) / 10;
  if (length != null && (length < 1 || length > 80)) length = null;
  if (named || length != null || /\b(fish|catch|caught|landed|got one|got him|netted|keeper|another one)\b/.test(s)) return { kind: 'catch', species: named ?? null, length };
  return null;
}

// t: the running trip. log: { catch(species, length) → record, event(kind) → record, undo(record), species: [names] }.
export function openHandsFree(t, log) {
  const species = log.species.length ? log.species : ['Fish'];
  let current = species.includes(localStorage.getItem(SPECIES_KEY)) ? localStorage.getItem(SPECIES_KEY) : species[0];
  let last = null, lastTap = 0, rec = null, listening = false, undoTimer = null;
  const el = document.createElement('div');
  el.className = 'hf-screen';
  el.innerHTML = `<div class="hf-top"><button class="hf-done">✕ Done</button>${canListen() ? '<button class="hf-mic" aria-pressed="false">🎤 Listen</button>' : ''}</div>
    <div class="hf-species">${species.map(s => `<button data-sp="${esc(s)}" class="${s === current ? 'on' : ''}">${esc(s)}</button>`).join('')}</div>
    <button class="hf-fish">🐟<span>FISH</span><small class="hf-sp">${esc(current)}</small></button>
    <div class="hf-row"><button class="hf-bite">💥<span>Bite</span></button><button class="hf-lost">💨<span>Lost</span></button></div>
    <div class="hf-msg" role="status" aria-live="assertive"></div>`;
  document.body.append(el);
  document.body.classList.add('hf-open');
  const msg = el.querySelector('.hf-msg');
  const say = (html, undo = false) => {
    msg.innerHTML = html + (undo ? ' <button class="hf-undo">Undo</button>' : '');
    msg.querySelector('.hf-undo')?.addEventListener('click', doUndo);
    clearTimeout(undoTimer);
    undoTimer = setTimeout(() => { msg.innerHTML = listening ? '🎤 Listening…' : ''; last = null; }, 8000);
  };
  const doUndo = async () => { if (!last) return; const r = last; last = null; await log.undo(r); say('Undone.'); };
  // A wet thumb can land twice: taps less than 1.2 s apart count once.
  const once = fn => async () => { if (Date.now() - lastTap < 1200) return; lastTap = Date.now(); await fn(); };
  const fish = async (sp = current, length = null) => {
    last = await log.catch(sp, length);
    say(`🐟 <b>${esc(sp)}</b>${length ? ` ${length}"` : ''} logged`, true);
  };
  const event = async kind => { last = await log.event(kind); say(kind === 'bite' ? '💥 Bite logged' : '💨 Lost fish logged', true); };
  el.querySelector('.hf-fish').onclick = once(() => fish());
  el.querySelector('.hf-bite').onclick = once(() => event('bite'));
  el.querySelector('.hf-lost').onclick = once(() => event('lost'));
  el.querySelectorAll('[data-sp]').forEach(b => b.onclick = () => {
    current = b.dataset.sp;
    try { localStorage.setItem(SPECIES_KEY, current); } catch {}
    el.querySelectorAll('[data-sp]').forEach(x => x.classList.toggle('on', x === b));
    el.querySelector('.hf-sp').textContent = current;
  });

  const mic = el.querySelector('.hf-mic');
  const stop = () => { listening = false; try { rec?.abort(); } catch {} rec = null; if (mic) { mic.textContent = '🎤 Listen'; mic.setAttribute('aria-pressed', 'false'); mic.classList.remove('on'); } };
  const listen = () => {
    rec = new (Rec())();
    rec.lang = navigator.language || 'en-US';
    rec.continuous = true;
    rec.interimResults = false;
    try { if ('processLocally' in rec) rec.processLocally = true; } catch {} // on-device where the browser offers it
    rec.onresult = e => {
      const text = e.results[e.results.length - 1][0].transcript;
      const a = parseSpoken(text, species);
      if (!a) return say(`🎤 Heard “${esc(text)}”. Say “fish”, “bite” or “lost one”.`);
      if (a.kind === 'undo') return doUndo();
      if (a.kind === 'catch') return fish(a.species ?? current, a.length);
      return event(a.kind);
    };
    rec.onerror = e => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      say(e.error === 'not-allowed' || e.error === 'service-not-allowed' ? '🎤 The microphone or speech service isn\'t allowed here. The big buttons still work.'
        : e.error === 'network' ? '🎤 Listening needs signal on this phone. The big buttons still work.' : `🎤 Stopped listening (${esc(e.error)}).`);
      stop();
    };
    rec.onend = () => { if (listening && el.isConnected) try { rec.start(); } catch { stop(); } }; // phones stop after a pause: start again
    rec.start();
    listening = true;
    mic.textContent = '🎤 Listening'; mic.setAttribute('aria-pressed', 'true'); mic.classList.add('on');
    say('🎤 Listening… say “fish”, “rainbow 14 inches”, “bite” or “lost one”.');
  };
  if (mic) mic.onclick = () => {
    if (listening) return stop();
    if (!localStorage.getItem(VOICE_OK_KEY) && !confirm('Voice logging uses your phone\'s speech recognition. On most phones the sound of what you say goes to Google (Android) or Apple (iPhone) to be turned into words; nothing else from Tackle Box goes with it, and where your fish are stays on the phone.\n\nTurn on listening?')) return;
    try { localStorage.setItem(VOICE_OK_KEY, '1'); } catch {}
    try { listen(); } catch (e) { say(`🎤 Couldn't start listening: ${esc(e.message)}`); stop(); }
  };
  const close = () => { stop(); clearTimeout(undoTimer); el.remove(); document.body.classList.remove('hf-open'); document.removeEventListener('visibilitychange', onHide); log.done?.(); };
  const onHide = () => { if (document.hidden) stop(); };
  document.addEventListener('visibilitychange', onHide);
  el.querySelector('.hf-done').onclick = close;
  return close;
}
