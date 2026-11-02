// Minimal ZIP reader (central directory + stored/deflated entries, ZIP64 aware).
// Works on a local file or on a web link (using HTTP range requests), so app info
// can be read from a big .ipa without downloading the whole thing.
const fs = require('fs/promises');
const zlib = require('zlib');

// ----- sources of bytes -----
async function fileSource(filePath) {
  const fh = await fs.open(filePath, 'r');
  const { size } = await fh.stat();
  return {
    size,
    async read(position, length) {
      const buf = Buffer.alloc(length);
      let got = 0;
      while (got < length) {
        const { bytesRead } = await fh.read(buf, got, length - got, position + got);
        if (!bytesRead) break;
        got += bytesRead;
      }
      return buf.subarray(0, got);
    },
    close: () => fh.close(),
  };
}

// Reads parts of a file on the web. Needs a server that supports Range requests (GitHub, most CDNs do).
async function urlSource(url, { headers = {}, timeout = 30000 } = {}) {
  let finalUrl = url;
  let size = null;
  let calls = 0;
  const get = async (start, end) => {
    calls++;
    if (calls > 40) throw new Error('Too many requests while reading the app');
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      // Login headers (like a GitHub token) only go to the original link. After a redirect we read straight
      // from the short-lived download link, which must not get the token (and storage hosts reject it anyway).
      const authed = finalUrl === url && Object.keys(headers).length > 0;
      let r = await fetch(finalUrl, { headers: { ...(authed ? headers : {}), Range: `bytes=${start}-${end}` }, redirect: authed ? 'manual' : 'follow', signal: ctrl.signal });
      if (authed && r.status >= 300 && r.status < 400 && r.headers.get('location')) {
        r.body && r.body.cancel().catch(() => {});
        finalUrl = new URL(r.headers.get('location'), url).toString();
        r = await fetch(finalUrl, { headers: { Range: `bytes=${start}-${end}` }, redirect: 'follow', signal: ctrl.signal });
      }
      if (r.url && r.url !== finalUrl) finalUrl = r.url; // remember where redirects end up (saves time on the next read)
      if (r.status === 200) { r.body && r.body.cancel().catch(() => {}); throw Object.assign(new Error('This link does not support partial downloads'), { noRange: true }); }
      if (r.status !== 206) { r.body && r.body.cancel().catch(() => {}); throw new Error(`Couldn't read the app (HTTP ${r.status})`); }
      const total = (r.headers.get('content-range') || '').match(/\/(\d+)$/);
      if (total) size = Number(total[1]);
      return Buffer.from(await r.arrayBuffer());
    } finally { clearTimeout(t); }
  };
  // A 1-byte read tells us the file size and whether partial downloads work.
  await get(0, 0);
  if (!size) throw new Error("Couldn't tell how big the app is");
  return {
    size,
    get finalUrl() { return finalUrl; },
    get calls() { return calls; },
    read: async (position, length) => (length <= 0 ? Buffer.alloc(0) : get(position, Math.min(size - 1, position + length - 1))),
    close: async () => {},
  };
}

function u64(buf, off) {
  return Number(buf.readBigUInt64LE(off));
}

async function listEntriesFrom(src) {
  const { size } = src;
  const tailLen = Math.min(size, 65557);
  const tail = await src.read(size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid zip/ipa file');

  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);

  if (cdOffset === 0xffffffff || count === 0xffff || cdSize === 0xffffffff) {
    const locPos = eocd - 20;
    if (locPos >= 0 && tail.readUInt32LE(locPos) === 0x07064b50) {
      const z64Offset = u64(tail, locPos + 8);
      const rec = await src.read(z64Offset, 56);
      if (rec.readUInt32LE(0) === 0x06064b50) {
        count = u64(rec, 32);
        cdSize = u64(rec, 40);
        cdOffset = u64(rec, 48);
      }
    }
  }
  if (cdSize > 64 * 1024 * 1024) throw new Error('App table of contents is too large');

  // Reuse the tail if the central directory is already inside it.
  const tailStart = size - tailLen;
  const cd = cdOffset >= tailStart ? tail.subarray(cdOffset - tailStart, cdOffset - tailStart + cdSize) : await src.read(cdOffset, cdSize);
  const entries = [];
  let p = 0;
  for (let i = 0; i < count && p + 46 <= cd.length; i++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) break;
    const method = cd.readUInt16LE(p + 10);
    let compSize = cd.readUInt32LE(p + 20);
    let usize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    let localOffset = cd.readUInt32LE(p + 42);
    const name = cd.toString('utf8', p + 46, p + 46 + nameLen);

    let e = p + 46 + nameLen;
    const eEnd = e + extraLen;
    while (e + 4 <= eEnd) {
      const id = cd.readUInt16LE(e);
      const len = cd.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (usize === 0xffffffff) { usize = u64(cd, q); q += 8; }
        if (compSize === 0xffffffff) { compSize = u64(cd, q); q += 8; }
        if (localOffset === 0xffffffff) { localOffset = u64(cd, q); q += 8; }
      }
      e += 4 + len;
    }
    entries.push({ name, method, compSize, size: usize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function readEntryFrom(src, entry, maxSize = 64 * 1024 * 1024) {
  if (entry.size > maxSize) throw new Error(`Entry too large: ${entry.name}`);
  // Read the local header and the data in one go (the header's name/extra lengths are usually small).
  const guess = 30 + 512;
  const first = await src.read(entry.localOffset, guess + entry.compSize);
  if (first.readUInt32LE(0) !== 0x04034b50) throw new Error('Bad local header');
  const skip = 30 + first.readUInt16LE(26) + first.readUInt16LE(28);
  let data = first.subarray(skip, skip + entry.compSize);
  if (data.length < entry.compSize) data = await src.read(entry.localOffset + skip, entry.compSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) return zlib.inflateRawSync(data);
  throw new Error(`Unsupported compression method ${entry.method}`);
}

// Backwards-compatible helpers for local files.
async function listEntries(filePath) {
  const src = await fileSource(filePath);
  try { return await listEntriesFrom(src); } finally { await src.close(); }
}
async function readEntry(filePath, entry, maxSize) {
  const src = await fileSource(filePath);
  try { return await readEntryFrom(src, entry, maxSize); } finally { await src.close(); }
}

module.exports = { fileSource, urlSource, listEntriesFrom, readEntryFrom, listEntries, readEntry };
