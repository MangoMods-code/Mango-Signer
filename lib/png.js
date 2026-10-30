// PNG helpers: convert Apple "CgBI" crushed PNGs to normal PNGs, encode RGBA images,
// and draw the Mango Signer app icon.
const zlib = require('zlib');

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let crcTable;
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodeRGBA(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// Returns a browser-viewable PNG buffer, or null if it can't be converted.
function normalizePng(buf) {
  if (!buf || buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) return null;
  let p = 8;
  let isCgBI = false;
  let ihdr = null;
  const idat = [];
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'CgBI') isCgBI = true;
    else if (type === 'IHDR') ihdr = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (!isCgBI) return buf;
  if (!ihdr) return null;

  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  const interlace = ihdr[12];
  if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) return null;
  if (width * height > 4096 * 4096) return null;

  let raw;
  try {
    raw = zlib.inflateRawSync(Buffer.concat(idat));
  } catch {
    try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch { return null; }
  }

  const bpp = 4;
  const stride = width * bpp;
  if (raw.length < (stride + 1) * height) return null;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x];
      const a = x >= bpp ? out[dst + x - bpp] : 0;
      const b = y > 0 ? out[dst + x - stride] : 0;
      const c = x >= bpp && y > 0 ? out[dst + x - stride - bpp] : 0;
      let r;
      switch (filter) {
        case 0: r = v; break;
        case 1: r = v + a; break;
        case 2: r = v + b; break;
        case 3: r = v + ((a + b) >> 1); break;
        case 4: r = v + paeth(a, b, c); break;
        default: return null;
      }
      out[dst + x] = r & 0xff;
    }
  }
  // BGRA (premultiplied) -> RGBA (straight)
  for (let i = 0; i < out.length; i += 4) {
    const bl = out[i], g = out[i + 1], rd = out[i + 2], al = out[i + 3];
    if (al > 0 && al < 255) {
      out[i] = Math.min(255, Math.round((rd * 255) / al));
      out[i + 1] = Math.min(255, Math.round((g * 255) / al));
      out[i + 2] = Math.min(255, Math.round((bl * 255) / al));
    } else {
      out[i] = rd;
      out[i + 2] = bl;
    }
  }
  return encodeRGBA(width, height, out);
}

// Draws the Mango Signer icon (a mango with a leaf on a warm gradient).
function drawAppIcon(size = 180) {
  const ss = 3; // supersampling
  const rgba = Buffer.alloc(size * size * 4);
  const mix = (a, b, t) => a + (b - a) * t;
  const inEllipse = (x, y, cx, cy, rx, ry, rot) => {
    const c = Math.cos(rot), s = Math.sin(rot);
    const dx = x - cx, dy = y - cy;
    const u = (dx * c + dy * s) / rx, v = (-dx * s + dy * c) / ry;
    return u * u + v * v <= 1;
  };
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let R = 0, G = 0, B = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) / size;
          const y = (py + (sy + 0.5) / ss) / size;
          // background: deep plum to near-black
          let r = mix(42, 18, y), g = mix(20, 12, y), b = mix(48, 26, y);
          // mango body
          if (inEllipse(x, y, 0.5, 0.56, 0.3, 0.255, -0.55)) {
            const t = Math.min(1, Math.max(0, (x - 0.25) * 1.4 + (0.85 - y) * 0.6));
            r = mix(255, 255, t); g = mix(122, 205, t); b = mix(28, 64, t);
            // highlight
            if (inEllipse(x, y, 0.4, 0.45, 0.07, 0.04, -0.55)) { r = 255; g = 240; b = 190; }
          }
          // leaf
          if (inEllipse(x, y, 0.69, 0.25, 0.12, 0.045, -0.6)) { r = 92; g = 196; b = 92; }
          R += r; G += g; B += b;
        }
      }
      const n = ss * ss;
      const i = (py * size + px) * 4;
      rgba[i] = Math.round(R / n);
      rgba[i + 1] = Math.round(G / n);
      rgba[i + 2] = Math.round(B / n);
      rgba[i + 3] = 255;
    }
  }
  return encodeRGBA(size, size, rgba);
}

module.exports = { normalizePng, encodeRGBA, drawAppIcon };
