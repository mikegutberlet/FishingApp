// Password encryption for backups and crew packs, all on device with WebCrypto: PBKDF2-SHA256 turns the password
// into an AES-256-GCM key. Without the password the file is unreadable, and nobody (not even this app) can recover it.
const ITER = 600000; // OWASP 2023 guidance for PBKDF2-SHA256
const enc = new TextEncoder(), dec = new TextDecoder();

export const randomBytes = n => crypto.getRandomValues(new Uint8Array(n));

// Base64 (and URL-safe base64) for byte arrays of any size.
export function toB64(bytes, url = false) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  const b = btoa(s);
  return url ? b.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : b;
}
export function fromB64(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// gzip where the browser can (all current ones); falls back to the raw bytes.
const canGzip = typeof CompressionStream === 'function';
const pipe = (bytes, stream) => new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer().then(b => new Uint8Array(b));
export const gzip = bytes => pipe(bytes, new CompressionStream('gzip'));
export const gunzip = bytes => pipe(bytes, new DecompressionStream('gzip'));

async function deriveKey(password, salt, iter) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// A password hash for checking a passcode (app lock). Returns { salt, iter, hash } as base64.
export async function hashSecret(secret, salt = randomBytes(16), iter = 200000) {
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, 256);
  return { salt: toB64(salt), iter, hash: toB64(new Uint8Array(bits)) };
}

// Encrypt any JSON value. The result is plain JSON, so it travels as a file, a link or a QR code.
export async function encryptJson(value, password, { iter = ITER } = {}) {
  let bytes = enc.encode(JSON.stringify(value));
  const gz = canGzip;
  if (gz) bytes = await gzip(bytes);
  const salt = randomBytes(16), iv = randomBytes(12);
  const key = await deriveKey(password, salt, iter);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  return { alg: 'AES-256-GCM', kdf: 'PBKDF2-SHA256', iter, gz, salt: toB64(salt), iv: toB64(iv), data: toB64(data) };
}

export async function decryptJson(box, password) {
  const key = await deriveKey(password, fromB64(box.salt), box.iter);
  let bytes;
  try { bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(box.iv) }, key, fromB64(box.data))); }
  catch { throw new Error('Wrong password, or the file is damaged'); }
  if (box.gz) bytes = await gunzip(bytes);
  return JSON.parse(dec.decode(bytes));
}

// Compact, unencrypted packing for short links and QR codes: gzip + URL-safe base64.
export async function packJson(value) {
  const bytes = enc.encode(JSON.stringify(value));
  return canGzip ? 'z' + toB64(await gzip(bytes), true) : 'j' + toB64(bytes, true);
}
export async function unpackJson(str) {
  const bytes = fromB64(str.slice(1));
  return JSON.parse(dec.decode(str[0] === 'z' ? await gunzip(bytes) : bytes));
}
