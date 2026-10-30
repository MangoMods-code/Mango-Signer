// Property list parser (XML + binary) and a small XML writer.

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

function parseXml(text) {
  text = text
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[\s\S]*?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const tokens = [];
  const re = /<(\/?)([a-zA-Z]+)[^>]*?(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[4] !== undefined) tokens.push({ text: m[4] });
    else tokens.push({ close: m[1] === '/', name: m[2], self: m[3] === '/' });
  }
  let i = 0;

  const skipWs = () => { while (i < tokens.length && tokens[i].text !== undefined && !tokens[i].text.trim()) i++; };
  const readText = (name) => {
    let out = '';
    while (i < tokens.length && !(tokens[i].close && tokens[i].name === name)) {
      if (tokens[i].text !== undefined) out += tokens[i].text;
      i++;
    }
    i++; // closing tag
    return decodeEntities(out);
  };

  function value() {
    skipWs();
    const t = tokens[i++];
    if (!t || t.text !== undefined || t.close) throw new Error('Invalid plist XML');
    switch (t.name) {
      case 'plist': {
        const v = value();
        skipWs();
        return v;
      }
      case 'dict': {
        const obj = {};
        if (t.self) return obj;
        for (;;) {
          skipWs();
          const k = tokens[i];
          if (k.close && k.name === 'dict') { i++; return obj; }
          if (k.name !== 'key') throw new Error('Expected <key> in plist');
          i++;
          const key = k.self ? '' : readText('key');
          obj[key] = value();
        }
      }
      case 'array': {
        const arr = [];
        if (t.self) return arr;
        for (;;) {
          skipWs();
          const k = tokens[i];
          if (k.close && k.name === 'array') { i++; return arr; }
          arr.push(value());
        }
      }
      case 'string': return t.self ? '' : readText('string');
      case 'integer': return t.self ? 0 : Number(readText('integer').trim());
      case 'real': return t.self ? 0 : Number(readText('real').trim());
      case 'true': if (!t.self) readText('true'); return true;
      case 'false': if (!t.self) readText('false'); return false;
      case 'date': return new Date(readText('date').trim());
      case 'data': return t.self ? Buffer.alloc(0) : Buffer.from(readText('data').replace(/\s+/g, ''), 'base64');
      default: throw new Error(`Unknown plist tag <${t.name}>`);
    }
  }
  return value();
}

function parseBinary(buf) {
  const trailer = buf.subarray(buf.length - 32);
  const offsetSize = trailer.readUInt8(6);
  const refSize = trailer.readUInt8(7);
  const numObjects = Number(trailer.readBigUInt64BE(8));
  const topObject = Number(trailer.readBigUInt64BE(16));
  const tableOffset = Number(trailer.readBigUInt64BE(24));

  const readUInt = (off, n) => {
    let v = 0;
    for (let k = 0; k < n; k++) v = v * 256 + buf[off + k];
    return v;
  };
  const offsets = [];
  for (let k = 0; k < numObjects; k++) offsets.push(readUInt(tableOffset + k * offsetSize, offsetSize));

  const depthGuard = { n: 0 };
  function obj(ref) {
    if (++depthGuard.n > 1e6) throw new Error('plist too complex');
    const off = offsets[ref];
    const marker = buf[off];
    const type = marker >> 4;
    const info = marker & 0x0f;

    const lengthAndStart = () => {
      if (info !== 0x0f) return [info, off + 1];
      const intMarker = buf[off + 1];
      const n = 1 << (intMarker & 0x0f);
      return [readUInt(off + 2, n), off + 2 + n];
    };

    switch (type) {
      case 0x0:
        if (info === 0x8) return false;
        if (info === 0x9) return true;
        return null;
      case 0x1: {
        const n = 1 << info;
        if (n === 8) return Number(buf.readBigInt64BE(off + 1));
        return readUInt(off + 1, n);
      }
      case 0x2: return info === 2 ? buf.readFloatBE(off + 1) : buf.readDoubleBE(off + 1);
      case 0x3: return new Date((buf.readDoubleBE(off + 1) + 978307200) * 1000);
      case 0x4: { const [len, s] = lengthAndStart(); return Buffer.from(buf.subarray(s, s + len)); }
      case 0x5: { const [len, s] = lengthAndStart(); return buf.toString('latin1', s, s + len); }
      case 0x6: {
        const [len, s] = lengthAndStart();
        const b = Buffer.from(buf.subarray(s, s + len * 2));
        b.swap16();
        return b.toString('utf16le');
      }
      case 0x8: return { UID: readUInt(off + 1, info + 1) };
      case 0xa: {
        const [len, s] = lengthAndStart();
        const arr = [];
        for (let k = 0; k < len; k++) arr.push(obj(readUInt(s + k * refSize, refSize)));
        return arr;
      }
      case 0xd: {
        const [len, s] = lengthAndStart();
        const out = {};
        for (let k = 0; k < len; k++) {
          const key = obj(readUInt(s + k * refSize, refSize));
          out[String(key)] = obj(readUInt(s + (len + k) * refSize, refSize));
        }
        return out;
      }
      default:
        throw new Error(`Unsupported binary plist type 0x${type.toString(16)}`);
    }
  }
  return obj(topObject);
}

function parse(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(String(buf));
  if (buf.subarray(0, 8).toString('latin1') === 'bplist00') return parseBinary(buf);
  return parseXml(buf.toString('utf8'));
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function build(value) {
  const out = (v, ind) => {
    const pad = '\t'.repeat(ind);
    if (Array.isArray(v)) return `${pad}<array>\n${v.map((x) => out(x, ind + 1)).join('')}${pad}</array>\n`;
    if (typeof v === 'boolean') return `${pad}<${v}/>\n`;
    if (typeof v === 'number') return Number.isInteger(v) ? `${pad}<integer>${v}</integer>\n` : `${pad}<real>${v}</real>\n`;
    if (v && typeof v === 'object') {
      return `${pad}<dict>\n${Object.entries(v).map(([k, x]) => `${pad}\t<key>${esc(k)}</key>\n${out(x, ind + 1)}`).join('')}${pad}</dict>\n`;
    }
    return `${pad}<string>${esc(v)}</string>\n`;
  };
  return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n' + out(value, 0) + '</plist>\n';
}

module.exports = { parse, build };
