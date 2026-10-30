// Minimal ZIP reader (central directory + stored/deflated entries, ZIP64 aware).
// Used to read Info.plist and icons out of .ipa files without loading the whole file.
const fs = require('fs/promises');
const zlib = require('zlib');

async function readAt(fh, position, length) {
  const buf = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await fh.read(buf, read, length - read, position + read);
    if (bytesRead === 0) break;
    read += bytesRead;
  }
  return buf.subarray(0, read);
}

function u64(buf, off) {
  return Number(buf.readBigUInt64LE(off));
}

async function listEntries(filePath) {
  const fh = await fs.open(filePath, 'r');
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 65557);
    const tail = await readAt(fh, size - tailLen, tailLen);
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
        const rec = await readAt(fh, z64Offset, 56);
        if (rec.readUInt32LE(0) === 0x06064b50) {
          count = u64(rec, 32);
          cdSize = u64(rec, 40);
          cdOffset = u64(rec, 48);
        }
      }
    }

    const cd = await readAt(fh, cdOffset, cdSize);
    const entries = [];
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const method = cd.readUInt16LE(p + 10);
      let compSize = cd.readUInt32LE(p + 20);
      let size = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let localOffset = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);

      // ZIP64 extended info
      let e = p + 46 + nameLen;
      const eEnd = e + extraLen;
      while (e + 4 <= eEnd) {
        const id = cd.readUInt16LE(e);
        const len = cd.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (size === 0xffffffff) { size = u64(cd, q); q += 8; }
          if (compSize === 0xffffffff) { compSize = u64(cd, q); q += 8; }
          if (localOffset === 0xffffffff) { localOffset = u64(cd, q); q += 8; }
        }
        e += 4 + len;
      }
      entries.push({ name, method, compSize, size, localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    await fh.close();
  }
}

async function readEntry(filePath, entry, maxSize = 64 * 1024 * 1024) {
  if (entry.size > maxSize) throw new Error(`Entry too large: ${entry.name}`);
  const fh = await fs.open(filePath, 'r');
  try {
    const lh = await readAt(fh, entry.localOffset, 30);
    if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('Bad local header');
    const dataStart = entry.localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
    const data = await readAt(fh, dataStart, entry.compSize);
    if (entry.method === 0) return data;
    if (entry.method === 8) return zlib.inflateRawSync(data);
    throw new Error(`Unsupported compression method ${entry.method}`);
  } finally {
    await fh.close();
  }
}

module.exports = { listEntries, readEntry };
