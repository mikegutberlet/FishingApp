// A tiny on-device EXIF reader: when a photo was taken and where. Works on JPEG and on HEIC, which both carry
// an "Exif\0\0" block followed by a TIFF structure. Nothing is uploaded.
export async function readExif(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const start = findTiff(bytes);
  if (start < 0) return {};
  const v = new DataView(bytes.buffer, start);
  const le = v.getUint16(0) === 0x4949;
  const u16 = o => v.getUint16(o, le), u32 = o => v.getUint32(o, le);
  const ascii = (o, n) => String.fromCharCode(...new Uint8Array(bytes.buffer, start + o, n)).replace(/\0+$/, '');

  // Reads one IFD into { tag: value } (strings, numbers, or arrays of rationals).
  const ifd = off => {
    const out = {};
    if (!off || off + 2 > v.byteLength) return out;
    const n = u16(off);
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      if (e + 12 > v.byteLength) break;
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      const size = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 }[type] || 1;
      const at = size * count > 4 ? u32(e + 8) : e + 8;
      if (at + size * count > v.byteLength) continue;
      if (type === 2) out[tag] = ascii(at, count);
      else if (type === 3) out[tag] = u16(at);
      else if (type === 4) out[tag] = u32(at);
      else if (type === 5) out[tag] = Array.from({ length: count }, (_, k) => u32(at + k * 8) / (u32(at + k * 8 + 4) || 1));
    }
    return out;
  };

  const ifd0 = ifd(u32(4));
  const exif = ifd(ifd0[0x8769]);
  const gps = ifd(ifd0[0x8825]);
  const result = {};
  const stamp = exif[0x9003] || exif[0x9004] || ifd0[0x0132];
  const m = stamp?.match(/^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/);
  if (m) {
    const offset = exif[0x9011]; // "+HH:MM" on newer phones; otherwise the photo's clock is taken as this device's time zone
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
    const t = Date.parse(/^[+-]\d\d:\d\d$/.test(offset) ? iso + offset : iso);
    if (!isNaN(t)) result.time = new Date(t).toISOString();
  }
  const deg = a => Array.isArray(a) && a.length === 3 ? a[0] + a[1] / 60 + a[2] / 3600 : null;
  const lat = deg(gps[2]), lon = deg(gps[4]);
  if (lat != null && lon != null && (lat || lon)) {
    result.lat = gps[1] === 'S' ? -lat : lat;
    result.lon = gps[3] === 'W' ? -lon : lon;
  }
  return result;
}

// Offset of the TIFF header ("II*\0" or "MM\0*") that follows the first "Exif\0\0" marker, or -1.
function findTiff(b) {
  for (let i = 0; i < b.length - 10; i++) {
    if (b[i] === 0x45 && b[i + 1] === 0x78 && b[i + 2] === 0x69 && b[i + 3] === 0x66 && b[i + 4] === 0 && b[i + 5] === 0) {
      const t = i + 6;
      if ((b[t] === 0x49 && b[t + 1] === 0x49 && b[t + 2] === 0x2a) || (b[t] === 0x4d && b[t + 1] === 0x4d && b[t + 3] === 0x2a)) return t;
    }
  }
  return -1;
}
