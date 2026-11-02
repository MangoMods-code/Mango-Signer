// Small QR code maker (byte mode, error correction level M, versions 1–10, up to 213 bytes).
// Returns an SVG string. No outside libraries needed.

// [data codewords per block, number of blocks] groups and EC codewords per block, for level M.
const VERSIONS = [
  null,
  { ec: 10, groups: [[16, 1]], align: [] },
  { ec: 16, groups: [[28, 1]], align: [6, 18] },
  { ec: 26, groups: [[44, 1]], align: [6, 22] },
  { ec: 18, groups: [[32, 2]], align: [6, 26] },
  { ec: 24, groups: [[43, 2]], align: [6, 30] },
  { ec: 16, groups: [[27, 4]], align: [6, 34] },
  { ec: 18, groups: [[31, 4]], align: [6, 22, 38] },
  { ec: 22, groups: [[38, 2], [39, 2]], align: [6, 24, 42] },
  { ec: 22, groups: [[36, 3], [37, 2]], align: [6, 26, 46] },
  { ec: 26, groups: [[43, 4], [44, 1]], align: [6, 28, 50] },
];

// Galois field math for Reed–Solomon error correction.
const EXP = new Array(512);
const LOG = new Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= mul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}
function rsRemainder(data, degree) {
  const gen = rsGenerator(degree);
  const res = new Array(degree).fill(0);
  for (const d of data) {
    const factor = d ^ res.shift();
    res.push(0);
    for (let i = 0; i < degree; i++) res[i] ^= mul(gen[i + 1], factor);
  }
  return res;
}

function dataCapacity(v) {
  return VERSIONS[v].groups.reduce((n, [size, count]) => n + size * count, 0);
}

function encodeData(bytes, v) {
  const bits = [];
  const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(0b0100, 4); // byte mode
  put(bytes.length, v < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const capBits = dataCapacity(v) * 8;
  put(0, Math.min(4, capBits - bits.length));
  while (bits.length % 8) bits.push(0);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0; out.length < dataCapacity(v); pad++) out.push(pad % 2 ? 0x11 : 0xec);
  return out;
}

function interleave(data, v) {
  const { ec, groups } = VERSIONS[v];
  const blocks = [];
  let pos = 0;
  for (const [size, count] of groups) {
    for (let i = 0; i < count; i++) {
      const d = data.slice(pos, pos + size);
      pos += size;
      blocks.push({ d, e: rsRemainder(d, ec) });
    }
  }
  const out = [];
  const maxD = Math.max(...blocks.map((b) => b.d.length));
  for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
  for (let i = 0; i < ec; i++) for (const b of blocks) out.push(b.e[i]);
  return out;
}

function bch(value, gen, genBits) {
  let v = value << (genBits - 1);
  while (v.toString(2).length >= genBits) v ^= gen << (v.toString(2).length - genBits);
  return v;
}

function buildMatrix(v, codewords, mask) {
  const size = 17 + v * 4;
  const m = Array.from({ length: size }, () => new Array(size).fill(null));
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (r, c, val) => { m[r][c] = val; fixed[r][c] = true; };

  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r, cc = c0 + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const on = r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        set(rr, cc, on);
      }
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
  for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const al = VERSIONS[v].align;
  const last = al.length - 1;
  al.forEach((r, i) => {
    al.forEach((c, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return; // finder corners
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
    });
  });
  set(size - 8, 8, true); // dark module

  // Reserve format and version areas.
  for (let i = 0; i < 9; i++) { if (!fixed[8][i]) set(8, i, false); if (!fixed[i][8]) set(i, 8, false); }
  for (let i = 0; i < 8; i++) { set(8, size - 1 - i, false); set(size - 1 - i, 8, false); }
  if (v >= 7) {
    const info = (v << 12) | bch(v, 0x1f25, 13);
    for (let i = 0; i < 18; i++) {
      const bit = ((info >> i) & 1) === 1;
      const a = Math.floor(i / 3), b = (i % 3) + size - 11;
      set(a, b, bit); set(b, a, bit);
    }
  }

  // Place data in the zigzag pattern.
  const bits = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1);
  let bi = 0;
  let up = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let k = 0; k < size; k++) {
      const r = up ? size - 1 - k : k;
      for (let c = col; c > col - 2; c--) {
        if (fixed[r][c]) continue;
        let bit = bi < bits.length ? bits[bi++] === 1 : false;
        const masks = [
          (r + c) % 2 === 0, r % 2 === 0, c % 3 === 0, (r + c) % 3 === 0,
          (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, ((r * c) % 2) + ((r * c) % 3) === 0,
          (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
        ];
        if (masks[mask]) bit = !bit;
        m[r][c] = bit;
      }
    }
    up = !up;
  }

  // Format info: level M = 00.
  const fmt = (((0b00 << 3) | mask) << 10 | bch((0b00 << 3) | mask, 0x537, 11)) ^ 0x5412;
  const fbit = (i) => ((fmt >> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) m[i][8] = fbit(i);
  m[7][8] = fbit(6); m[8][8] = fbit(7); m[8][7] = fbit(8);
  for (let i = 9; i < 15; i++) m[8][14 - i] = fbit(i);
  for (let i = 0; i < 8; i++) m[8][size - 1 - i] = fbit(i);
  for (let i = 8; i < 15; i++) m[size - 15 + i][8] = fbit(i);
  return m;
}

function penalty(m) {
  const n = m.length;
  let p = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      let run = 1;
      for (let j = 1; j < n; j++) {
        const a = pass ? m[j][i] : m[i][j], b = pass ? m[j - 1][i] : m[i][j - 1];
        if (a === b) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1;
      }
    }
  }
  for (let i = 0; i < n - 1; i++) for (let j = 0; j < n - 1; j++) {
    const c = m[i][j];
    if (c === m[i + 1][j] && c === m[i][j + 1] && c === m[i + 1][j + 1]) p += 3;
  }
  const pat = [true, false, true, true, true, false, true, false, false, false, false];
  const rev = [...pat].reverse();
  for (let i = 0; i < n; i++) for (let j = 0; j <= n - 11; j++) {
    for (const pt of [pat, rev]) {
      if (pt.every((x, k) => m[i][j + k] === x)) p += 40;
      if (pt.every((x, k) => m[j + k][i] === x)) p += 40;
    }
  }
  const dark = m.flat().filter(Boolean).length;
  p += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
  return p;
}

function qrMatrix(text) {
  const bytes = [...Buffer.from(String(text), 'utf8')];
  let v = 1;
  while (v <= 10 && dataCapacity(v) < bytes.length + (v < 10 ? 2 : 3)) v++;
  if (v > 10) throw new Error('Text is too long for a QR code');
  const codewords = interleave(encodeData(bytes, v), v);
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const m = buildMatrix(v, codewords, mask);
    const score = penalty(m);
    if (!best || score < best.score) best = { m, score };
  }
  return best.m;
}

function qrSvg(text, { margin = 4 } = {}) {
  const m = qrMatrix(text);
  const n = m.length + margin * 2;
  let d = '';
  m.forEach((row, r) => row.forEach((on, c) => { if (on) d += `M${c + margin} ${r + margin}h1v1h-1z`; }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

module.exports = { qrSvg, qrMatrix };
