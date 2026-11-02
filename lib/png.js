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

// Decodes an 8-bit, non-interlaced PNG (normal or Apple "CgBI") to straight RGBA pixels.
// Returns { width, height, rgba, cgbi } or null if the format isn't supported.
function decodePng(buf) {
  if (!buf || buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) return null;
  let p = 8;
  let isCgBI = false;
  let ihdr = null;
  let plte = null;
  let trns = null;
  const idat = [];
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'CgBI') isCgBI = true;
    else if (type === 'IHDR') ihdr = data;
    else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (!ihdr || ihdr.length < 13 || !idat.length) return null;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  const interlace = ihdr[12];
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (bitDepth !== 8 || !channels || interlace !== 0) return null;
  if (!width || !height || width * height > 4096 * 4096) return null;
  if (colorType === 3 && !plte) return null;

  let raw;
  const z = Buffer.concat(idat);
  try {
    raw = isCgBI ? zlib.inflateRawSync(z) : zlib.inflateSync(z);
  } catch {
    try { raw = isCgBI ? zlib.inflateSync(z) : zlib.inflateRawSync(z); } catch { return null; }
  }

  const bpp = channels;
  const stride = width * bpp;
  if (raw.length < (stride + 1) * height) return null;
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x];
      const a = x >= bpp ? px[dst + x - bpp] : 0;
      const b = y > 0 ? px[dst + x - stride] : 0;
      const c = x >= bpp && y > 0 ? px[dst + x - stride - bpp] : 0;
      let r;
      switch (filter) {
        case 0: r = v; break;
        case 1: r = v + a; break;
        case 2: r = v + b; break;
        case 3: r = v + ((a + b) >> 1); break;
        case 4: r = v + paeth(a, b, c); break;
        default: return null;
      }
      px[dst + x] = r & 0xff;
    }
  }

  const n = width * height;
  const rgba = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (colorType === 6) {
      px.copy(rgba, o, o, o + 4);
    } else if (colorType === 2) {
      rgba[o] = px[i * 3]; rgba[o + 1] = px[i * 3 + 1]; rgba[o + 2] = px[i * 3 + 2]; rgba[o + 3] = 255;
    } else if (colorType === 0) {
      rgba[o] = rgba[o + 1] = rgba[o + 2] = px[i]; rgba[o + 3] = 255;
    } else if (colorType === 4) {
      rgba[o] = rgba[o + 1] = rgba[o + 2] = px[i * 2]; rgba[o + 3] = px[i * 2 + 1];
    } else {
      const k = px[i];
      rgba[o] = plte[k * 3] || 0; rgba[o + 1] = plte[k * 3 + 1] || 0; rgba[o + 2] = plte[k * 3 + 2] || 0;
      rgba[o + 3] = trns && k < trns.length ? trns[k] : 255;
    }
  }
  if (isCgBI && colorType === 6) {
    // BGRA (premultiplied) -> RGBA (straight)
    for (let i = 0; i < rgba.length; i += 4) {
      const bl = rgba[i], g = rgba[i + 1], rd = rgba[i + 2], al = rgba[i + 3];
      if (al > 0 && al < 255) {
        rgba[i] = Math.min(255, Math.round((rd * 255) / al));
        rgba[i + 1] = Math.min(255, Math.round((g * 255) / al));
        rgba[i + 2] = Math.min(255, Math.round((bl * 255) / al));
      } else {
        rgba[i] = rd;
        rgba[i + 2] = bl;
      }
    }
  }
  return { width, height, rgba, cgbi: isCgBI };
}

// Returns a browser-viewable PNG buffer, or null if it can't be converted.
function normalizePng(buf) {
  if (!buf || buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) return null;
  if (!buf.includes(Buffer.from('CgBI', 'latin1'))) return buf;
  const img = decodePng(buf);
  if (!img || !img.cgbi) return img ? buf : null;
  return encodeRGBA(img.width, img.height, img.rgba);
}

// Shrinks an image to fit max x max (area-averaged, alpha-weighted so edges don't go dark).
function resizeRGBA(width, height, rgba, max) {
  const scale = Math.min(1, max / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  if (w === width && h === height) return { width, height, rgba };
  const out = Buffer.alloc(w * h * 4);
  const fx = width / w;
  const fy = height / h;
  for (let y = 0; y < h; y++) {
    const y0 = y * fy, y1 = y0 + fy;
    for (let x = 0; x < w; x++) {
      const x0 = x * fx, x1 = x0 + fx;
      let r = 0, g = 0, b = 0, a = 0, wsum = 0;
      for (let sy = Math.floor(y0); sy < Math.min(height, Math.ceil(y1)); sy++) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
        for (let sx = Math.floor(x0); sx < Math.min(width, Math.ceil(x1)); sx++) {
          const wgt = wy * (Math.min(x1, sx + 1) - Math.max(x0, sx));
          const i = (sy * width + sx) * 4;
          const al = rgba[i + 3] * wgt;
          r += rgba[i] * al; g += rgba[i + 1] * al; b += rgba[i + 2] * al;
          a += al; wsum += wgt;
        }
      }
      const o = (y * w + x) * 4;
      if (a > 0) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); }
      out[o + 3] = wsum ? Math.round(a / wsum) : 0;
    }
  }
  return { width: w, height: h, rgba: out };
}

// Makes an icon small enough to keep around: at most `max` px wide and normal PNG (not CgBI).
// Leaves it alone if it's already small, or if it can't be read (returns the original).
function shrinkPng(buf, max = 180) {
  if (!buf) return buf;
  const img = decodePng(buf);
  if (!img) return buf;
  if (!img.cgbi && Math.max(img.width, img.height) <= max) return buf;
  const r = resizeRGBA(img.width, img.height, img.rgba, max);
  const out = encodeRGBA(r.width, r.height, r.rgba);
  return out.length < buf.length || img.cgbi ? out : buf;
}

// Reads a PNG's size from its header without decoding it.
function pngSize(buf) {
  if (!buf || buf.length < 24 || !buf.subarray(0, 8).equals(SIG)) return null;
  // CgBI files put their chunk before IHDR.
  let p = 8;
  for (let i = 0; i < 4 && p + 16 <= buf.length; i++) {
    const len = buf.readUInt32BE(p);
    if (buf.toString('latin1', p + 4, p + 8) === 'IHDR') return { width: buf.readUInt32BE(p + 8), height: buf.readUInt32BE(p + 12) };
    p += 12 + len;
  }
  return null;
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

module.exports = { normalizePng, decodePng, shrinkPng, pngSize, encodeRGBA, drawAppIcon };
